"""Reporting API — bootstrap, definitions CRUD, render, edit-agent.

Endpoints (all under ``/reporting``):

    GET    /templates                                — list available template ids
    GET    /templates/{template_id}/tokens           — preview parsed DSL tokens + tagged blocks
    GET    /templates/{template_id}/definitions      — read current definitions.yaml
    POST   /templates/{template_id}/seed-definitions   — create definitions.yaml with
                                                        skeleton blocks only (scan HTML, no LLM)
    POST   /templates/{template_id}/bootstrap        — kick off bootstrap (SSE job)
    GET    /templates/bootstrap/{job_id}/events      — SSE stream of bootstrap events
    GET    /templates/bootstrap/{job_id}/status      — poll job status
    POST   /templates/{template_id}/render           — execute block CTEs + render HTML
    GET    /templates/render/{job_id}/events         — SSE stream of render events
    GET    /templates/render/{job_id}/status         — poll render job status
    POST   /templates/{template_id}/blocks/{block_id} — redefine a single block
                                                       (validate + atomic write)
    POST   /templates/{template_id}/edit-agent       — start a chat session with
                                                       the report-edit agent
    GET    /templates/edit-agent/{job_id}/events     — SSE stream of agent events
    GET    /templates/edit-agent/{job_id}/status     — poll edit-agent status
    PUT    /templates/{template_id}/template-html    — replace ``report-template.html``
                                                       (atomic write)
    PUT    /templates/{template_id}/report-css       — replace ``report.css`` next to the template
                                                       (atomic write; creates file if absent)

The render and edit-agent endpoints are async by design (long-running
LLM loops) and emit events identical in shape to the bootstrap and
``EmbeddingPipelinePopup`` SSE streams so the same frontend popup can
be reused.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import time
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"


reporting_router = APIRouter(prefix="/reporting", tags=["Reporting"])


# ── In-memory job registries (one per kind, mirroring parquet.py) ──────────


_BOOTSTRAP_JOBS:  Dict[str, Dict[str, Any]] = {}
_RENDER_JOBS:     Dict[str, Dict[str, Any]] = {}
_EDIT_AGENT_JOBS: Dict[str, Dict[str, Any]] = {}


# ── Pydantic schemas ───────────────────────────────────────────────────────


class TemplateInfo(BaseModel):
    template_id:        str
    has_template_html:  bool
    has_definitions:    bool
    blocks_count:       int = 0
    version:            int = 0


class CreateTemplateRequest(BaseModel):
    template_id: str
    report_title: Optional[str] = None


class CreateTemplateResponse(BaseModel):
    template_id: str
    template_dir: str
    has_template_html: bool = True
    has_report_css: bool = True


class DeleteTemplateResponse(BaseModel):
    template_id: str
    deleted: bool = True


class SeedDefinitionsResponse(BaseModel):
    """Result of non-LLM ``definitions.yaml`` initialisation (skeleton blocks only)."""

    template_id:        str
    version:            int
    blocks_count:       int
    definitions_path:   str


class BootstrapRequest(BaseModel):
    parquet_cache_dir: Optional[str] = None


class BootstrapStartedResponse(BaseModel):
    job_id:      str
    template_id: str
    message:     str


class JobStatusResponse(BaseModel):
    job_id:        str
    status:        str
    started_at:    Optional[float] = None
    finished_at:   Optional[float] = None
    error:         Optional[str]   = None
    result:        Optional[Dict[str, Any]] = None
    last_event:    Optional[Dict[str, Any]] = None


class RenderRequest(BaseModel):
    """POST body of ``/reporting/templates/{template_id}/render``."""
    parameters:        Dict[str, Any]      = {}
    parquet_paths:     Dict[str, str]      = {}
    pre_supplied_narratives: Dict[str, str] = {}
    async_mode:        bool                = False  # if True, return job_id


class RenderResponse(BaseModel):
    """Synchronous render response."""
    template_id:        str
    success:            bool
    html:               Optional[str] = None
    missing:            List[str]     = []
    sql_errors:         List[Dict[str, Any]] = []
    sql_summary:        Dict[str, Any] = {}
    narrative_summary:  Dict[str, Any] = {}
    render_flags:       Dict[str, bool] = {}
    duration_ms:        float          = 0
    error:              Optional[str] = None


class RenderJobStartedResponse(BaseModel):
    job_id:      str
    template_id: str
    message:     str


class EditAgentRequest(BaseModel):
    """POST body of ``/reporting/templates/{template_id}/edit-agent``."""
    query:                   str
    session_id:              Optional[str]              = None
    max_iterations:          int                        = 10
    parquet_paths:           Dict[str, str]             = {}
    parquet_cache_dir:       Optional[str]              = None
    initial_messages:        Optional[List[Dict[str, Any]]] = None


class TemplateHtmlBody(BaseModel):
    """PUT body for replacing ``report-template.html``."""
    html: str


class TemplateHtmlSavedResponse(BaseModel):
    ok:          bool   = True
    template_id: str
    bytes_written: int = 0


class ReportCssBody(BaseModel):
    """PUT body for replacing ``report.css`` beside ``report-template.html``."""

    css: str


class ReportCssSavedResponse(BaseModel):
    ok:          bool   = True
    template_id: str
    bytes_written: int = 0


class TemplateParameterDefinition(BaseModel):
    id: str
    type: Optional[str] = None
    default: Optional[Any] = None
    description: Optional[str] = None


class TemplateParametersBody(BaseModel):
    parameters: List[TemplateParameterDefinition] = []


class TemplateParametersSavedResponse(BaseModel):
    template_id: str
    version: int = 0
    parameters: List[Dict[str, Any]] = []


class EditAgentJobStartedResponse(BaseModel):
    job_id:      str
    template_id: str
    message:     str


class BlockUpsertRequest(BaseModel):
    """POST body of ``/reporting/templates/{template_id}/blocks/{block_id}``.

    Mirrors the agent tool ``set_block_definition`` so frontends can
    redefine a single block without going through the LLM (e.g. a
    "save inline edit" UX).  Body validation goes through
    :func:`sql_helpers.validate_block`; the write is atomic and bumps
    ``definitions.yaml``'s ``version:``.
    """
    kind:             str
    goal:             Optional[str]                = None
    tokens:           Optional[List[str]]          = None
    mapping:          Optional[Dict[str, str]]     = None
    grounding_fields: Optional[List[str]]          = None
    sql:              Optional[str]                = None
    cte_ref:          Optional[str]                = None
    ctes:             Optional[List[Dict[str, Any]]] = None
    depends_on:       Optional[List[str]]          = None
    style:            Optional[str]                = None
    fallback_text:    Optional[str]                = None


class BlockUpsertResponse(BaseModel):
    template_id:      str
    block_id:         str
    action:           str                          # "created" | "updated"
    version:          int                          = 0
    final_aliases:    List[str]                    = []
    referenced_params: List[str]                   = []
    warnings:         List[str]                    = []


class SaveCteRequest(BaseModel):
    """POST body for prompt-driven CTE generation on one block."""
    goal: str
    max_retries: int = 2


class SaveCteResponse(BaseModel):
    template_id: str
    block_id: str
    action: str
    version: int = 0
    duration_ms: float = 0
    block: Dict[str, Any] = {}
    validation_summary: Dict[str, Any] = {}
    cte_sql_path: Optional[str] = None
    cte_graph_id: Optional[str] = None
    cte_graph_stats: Optional[Dict[str, Any]] = None
    cte_graph_error: Optional[str] = None


class BlockPreviewRequest(BaseModel):
    """POST body of ``/reporting/templates/{template_id}/blocks/{block_id}/preview``.

    Mirrors the agent tool ``preview_block`` so the frontend can run a
    block's CTE on demand (e.g. after a user clicks the block in the
    definitions pane) and inspect the projected rows BEFORE persisting
    or rendering.

    All fields are optional:
      * ``parameters``    — values bound to ``$param`` placeholders in
                              the SQL (e.g. ``{"period": "2024-01"}``).
      * ``parquet_paths`` — ``{source_name -> filesystem path}`` to
                              register as DuckDB views.  Defaults to an
                              empty mapping (some CTEs are pure constants).
      * ``limit``          — max rows to return (capped to ``200``).
      * ``sub_block_id``   — for ``kind=mixed`` only: the ``id`` of one
                              entry in ``ctes:`` to execute (scalar /
                              section / condition / … — same rules as a
                              leaf block).
    """
    parameters:    Dict[str, Any] = {}
    parquet_paths: Dict[str, str] = {}
    limit:         int            = 5
    sub_block_id:  Optional[str] = None


class BlockPreviewResponse(BaseModel):
    template_id:       str
    block_id:          str
    sub_block_id:      Optional[str]           = None
    kind:              str
    sql:               str
    expanded_sql:      str
    columns:           List[str]               = []
    rows:              List[List[Any]]         = []
    row_count:         int                     = 0
    truncated:         bool                    = False
    referenced_params: List[str]               = []
    bound_params:      Dict[str, Any]          = {}
    duration_ms:       float                   = 0
    warnings:          List[str]               = []
    # Tells the UI which ``{source: parquet}`` mapping the backend
    # actually used (handy when the backend auto-discovered defaults
    # because the request body didn't supply ``parquet_paths``).
    resolved_parquet_paths: Dict[str, str]     = {}


class BlockSqlSourceResponse(BaseModel):
    template_id: str
    block_id: str
    sub_block_id: Optional[str] = None
    kind: str
    source_mode: str
    cte_ref: Optional[str] = None
    source_path: Optional[str] = None
    sql: str
    expanded_sql: str


class GenerateInsuranceProductionCteRequest(BaseModel):
    """Optional anchor CTE from ``insurance_production/index.yaml``."""
    leaf_cte: Optional[str] = None


class GenerateInsuranceProductionCteResponse(BaseModel):
    template_id: str
    block_id: str
    leaf_cte: str
    depends_ordered: List[str]
    generated_sql: str
    expanded_sql: str
    validation_ok: bool = True
    validation_errors: List[str] = []


class ParquetFileEntry(BaseModel):
    """One discovered parquet file under ``data/parquet/``."""
    filename:        str
    path:            str
    size_bytes:      int            = 0
    columns:         List[str]      = []
    is_embeddings:   bool           = False
    kind:            str            = "unknown"   # ``ledger`` / ``balance`` / ``unknown``
    matches_sources: List[str]      = []
    label:           str            = ""


class ParquetFileListResponse(BaseModel):
    parquet_dir:    str
    files:          List[ParquetFileEntry] = []
    default_paths:  Dict[str, str]         = {}  # ``{source_name → path}``


# ── Helpers ────────────────────────────────────────────────────────────────


def _template_dir(template_id: str) -> Path:
    safe = template_id.strip().replace("..", "").replace("/", "")
    if not safe or safe != template_id:
        raise HTTPException(status_code=400, detail=f"invalid template_id: {template_id!r}")
    return _TEMPLATES_ROOT / safe


def _default_report_html(report_title: str) -> str:
    safe_title = (report_title or "Nouveau rapport").strip() or "Nouveau rapport"
    return f"""<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>{safe_title}</title>
  <link rel="stylesheet" href="report.css" />
</head>
<body>
  <main class="report-shell">
    <section class="report-cover">
      <div class="cover-eyebrow" data-block="cover_client">{{{{CLIENT_NAME}}}}</div>
      <h1 class="cover-title" data-block="cover_title">{{{{REPORT_TITLE}}}}</h1>
      <p class="cover-subtitle" data-block="cover_period">{{{{PERIOD_LABEL}}}}</p>
    </section>

    <section class="report-section">
      <div class="section-kicker">Synthèse</div>
      <div class="kpi-grid">
        <article class="kpi-card" data-block="summary_kpi_1">
          <span class="kpi-label">{{{{KPI_1_LABEL}}}}</span>
          <strong class="kpi-value">{{{{KPI_1_VALUE}}}}</strong>
          <span class="kpi-note">{{{{KPI_1_NOTE}}}}</span>
        </article>
        <article class="kpi-card" data-block="summary_kpi_2">
          <span class="kpi-label">{{{{KPI_2_LABEL}}}}</span>
          <strong class="kpi-value">{{{{KPI_2_VALUE}}}}</strong>
          <span class="kpi-note">{{{{KPI_2_NOTE}}}}</span>
        </article>
        <article class="kpi-card" data-block="summary_kpi_3">
          <span class="kpi-label">{{{{KPI_3_LABEL}}}}</span>
          <strong class="kpi-value">{{{{KPI_3_VALUE}}}}</strong>
          <span class="kpi-note">{{{{KPI_3_NOTE}}}}</span>
        </article>
      </div>
    </section>

    <section class="report-section" data-block="insight_body">
      <div class="section-kicker">Analyse</div>
      <h2>Commentaires et enseignements</h2>
      <p>{{{{INSIGHT_BODY}}}}</p>
    </section>

    <section class="report-section">
      <div class="section-kicker">Tableau</div>
      <div class="table-shell" data-block="detail_table">
        <table class="report-table">
          <thead>
            <tr>
              <th>{{{{COL_1_LABEL}}}}</th>
              <th>{{{{COL_2_LABEL}}}}</th>
              <th>{{{{COL_3_LABEL}}}}</th>
            </tr>
          </thead>
          <tbody>
            <!-- BEGIN:detail_rows -->
            <tr>
              <td>{{{{COL_1_VALUE}}}}</td>
              <td>{{{{COL_2_VALUE}}}}</td>
              <td>{{{{COL_3_VALUE}}}}</td>
            </tr>
            <!-- END:detail_rows -->
          </tbody>
        </table>
      </div>
    </section>
  </main>
</body>
</html>
"""


def _default_report_css() -> str:
    return """\
:root {
  --bg: #f7f4ec;
  --paper: #fffdf8;
  --ink: #252525;
  --muted: #746f67;
  --line: #e7e1d6;
  --accent: #0d7377;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  font-family: "Inter", "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top, rgba(13,115,119,0.08), transparent 28%),
    var(--bg);
}

.report-shell {
  width: min(980px, calc(100% - 64px));
  margin: 40px auto 72px;
  padding: 40px;
  border: 1px solid var(--line);
  border-radius: 32px;
  background: var(--paper);
  box-shadow: 0 24px 70px rgba(15, 23, 42, 0.08);
}

.report-cover,
.report-section {
  border: 1px solid var(--line);
  border-radius: 28px;
  padding: 28px;
  background: white;
}

.report-section + .report-section,
.report-cover + .report-section {
  margin-top: 24px;
}

.cover-eyebrow,
.section-kicker {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.cover-title {
  margin: 0;
  font-size: clamp(2.2rem, 5vw, 4rem);
  line-height: 0.95;
  letter-spacing: -0.05em;
}

.cover-subtitle {
  margin: 16px 0 0;
  color: var(--muted);
  font-size: 1rem;
}

.kpi-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 16px;
}

.kpi-card {
  border: 1px solid var(--line);
  border-radius: 22px;
  padding: 18px;
  background: linear-gradient(180deg, #ffffff, #fbfaf7);
}

.kpi-label,
.kpi-note {
  display: block;
  color: var(--muted);
}

.kpi-label {
  margin-bottom: 12px;
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
}

.kpi-value {
  display: block;
  font-size: 2rem;
  line-height: 1;
}

.kpi-note {
  margin-top: 12px;
  font-size: 0.9rem;
}

.table-shell {
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: 20px;
}

.report-table {
  width: 100%;
  border-collapse: collapse;
}

.report-table th,
.report-table td {
  padding: 14px 16px;
  border-bottom: 1px solid var(--line);
  text-align: left;
}

.report-table th {
  font-size: 0.75rem;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  background: #faf7f0;
}

@media (max-width: 900px) {
  .report-shell {
    width: min(100% - 24px, 980px);
    margin: 12px auto 32px;
    padding: 18px;
    border-radius: 24px;
  }

  .report-cover,
  .report-section {
    padding: 20px;
    border-radius: 22px;
  }

  .kpi-grid {
    grid-template-columns: 1fr;
  }
}
"""


def _list_templates() -> List[TemplateInfo]:
    if not _TEMPLATES_ROOT.is_dir():
        return []
    out: List[TemplateInfo] = []
    for d in sorted(_TEMPLATES_ROOT.iterdir()):
        if not d.is_dir():
            continue
        html = d / "report-template.html"
        defs = d / "definitions.yaml"
        info = TemplateInfo(
            template_id=d.name,
            has_template_html=html.is_file(),
            has_definitions=defs.is_file(),
        )
        if defs.is_file():
            try:
                parsed = yaml.safe_load(defs.read_text(encoding="utf-8")) or {}
                info.blocks_count = len(parsed.get("blocks") or [])
                info.version = int(parsed.get("version") or 0)
            except Exception as e:
                logger.warning("could not parse %s: %s", defs, e)
        out.append(info)
    return out


# ── GET /templates ─────────────────────────────────────────────────────────


@reporting_router.get("/templates")
async def list_templates() -> List[TemplateInfo]:
    """Return every template under ``data/reporting/templates/<id>/``."""
    return _list_templates()


@reporting_router.post(
    "/templates",
    response_model=CreateTemplateResponse,
    status_code=201,
)
async def create_template(body: CreateTemplateRequest) -> CreateTemplateResponse:
    """Create a new HTML report template directory with starter files."""
    template_id = (body.template_id or "").strip()
    if not template_id:
        raise HTTPException(400, "template_id is required")

    tdir = _template_dir(template_id)
    if tdir.exists():
        raise HTTPException(409, f"template already exists: {template_id}")

    try:
        tdir.mkdir(parents=True, exist_ok=False)
        (tdir / "report-template.html").write_text(
            _default_report_html(body.report_title or template_id),
            encoding="utf-8",
        )
        (tdir / "report.css").write_text(
            _default_report_css(),
            encoding="utf-8",
        )
    except Exception as exc:
        logger.error("template creation failed: %s", exc, exc_info=True)
        try:
            if tdir.exists():
                for child in tdir.iterdir():
                    child.unlink(missing_ok=True)
                tdir.rmdir()
        except Exception:
            logger.warning("rollback failed for template dir %s", tdir, exc_info=True)
        raise HTTPException(500, f"failed to create template: {exc}") from exc

    return CreateTemplateResponse(
        template_id=template_id,
        template_dir=str(tdir.resolve()),
        has_template_html=True,
        has_report_css=True,
    )


@reporting_router.delete(
    "/templates/{template_id}",
    response_model=DeleteTemplateResponse,
)
async def delete_template(template_id: str) -> DeleteTemplateResponse:
    """Delete one report template directory and all its files."""
    tdir = _template_dir(template_id)
    if not tdir.exists() or not tdir.is_dir():
        raise HTTPException(404, f"template not found: {template_id}")

    try:
        shutil.rmtree(tdir)
    except Exception as exc:
        logger.error("template deletion failed: %s", exc, exc_info=True)
        raise HTTPException(500, f"failed to delete template: {exc}") from exc

    return DeleteTemplateResponse(template_id=template_id)


# ── GET /templates/{template_id}/tokens ────────────────────────────────────


@reporting_router.get("/templates/{template_id}/tokens")
async def preview_template_tokens(template_id: str) -> Dict[str, Any]:
    """Run the scanner on the template and return its token inventory."""
    from nodes.reporting.template_scan_node import scan_template

    tdir = _template_dir(template_id)
    html_path = tdir / "report-template.html"
    if not html_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    try:
        html = html_path.read_text(encoding="utf-8")
        scan = scan_template(html)
    except Exception as e:
        raise HTTPException(400, f"Scan failed: {e}")

    # Sibling stylesheets / scripts referenced by the template via relative
    # ``<link rel="stylesheet" href="…">`` tags cannot be resolved by the
    # frontend's sandboxed ``srcDoc`` iframe.  We ship them alongside the
    # raw HTML so the visual preview can inline them and render the page
    # exactly as the report renderer would.
    _ASSET_MAX_BYTES = 2 * 1024 * 1024     # 2 MiB safety cap per asset
    assets: Dict[str, str] = {}
    for path in sorted(tdir.glob("*.css")):
        try:
            if path.is_file() and path.stat().st_size <= _ASSET_MAX_BYTES:
                assets[path.name] = path.read_text(encoding="utf-8")
        except OSError:
            continue

    return {
        "template_id":     template_id,
        "tokens":          scan.to_dict(),
        "all_field_ids":   scan.all_field_ids,
        # Frontend ``TemplatePreview`` re-tokenises the raw HTML so each
        # ``{{TOKEN}}`` / ``<!-- BEGIN:section -->`` / ``<!-- IF:flag -->`` /
        # ``<!-- NARRATIVE:name -->`` marker can be rendered as a
        # clickable badge that opens the edit-agent prompt for that id.
        "template_html":   html,
        # Map of ``filename → text content`` for sibling assets
        # (currently *.css).  The visual preview inlines any
        # ``<link rel="stylesheet" href="<filename>">`` whose href matches
        # a key here so the iframe renders the template with its real
        # corporate styling.
        "template_assets": assets,
    }


# ── GET /templates/{template_id}/definitions ───────────────────────────────


@reporting_router.get("/templates/{template_id}/definitions")
async def get_definitions(template_id: str) -> Dict[str, Any]:
    """Return the parsed ``definitions.yaml``."""
    tdir = _template_dir(template_id)
    defs = tdir / "definitions.yaml"
    if not defs.is_file():
        raise HTTPException(404, f"definitions.yaml not found for {template_id}")
    try:
        return yaml.safe_load(defs.read_text(encoding="utf-8")) or {}
    except Exception as e:
        raise HTTPException(400, f"Could not parse definitions.yaml: {e}")


@reporting_router.put(
    "/templates/{template_id}/parameters",
    response_model=TemplateParametersSavedResponse,
)
async def put_template_parameters(
    template_id: str,
    body: TemplateParametersBody,
) -> TemplateParametersSavedResponse:
    """Replace top-level ``parameters:`` in ``definitions.yaml``."""
    from nodes.reporting.definition_persist_node import DefinitionPersistNode

    defs = _load_template_definitions(template_id)
    defs["parameters"] = _normalise_template_parameters(body.parameters)

    shared: Dict[str, Any] = {
        "report_definitions": defs,
        "template_id":        template_id,
        "templates_root":     str(_TEMPLATES_ROOT),
        "draft_reports":      [],
        "persist_mode":       "replace",
        "agent_note":         "api.set_template_parameters",
    }
    try:
        DefinitionPersistNode().run(shared)
    except Exception as e:
        logger.error("put_template_parameters persist failed: %s", e, exc_info=True)
        raise HTTPException(500, f"persist failed: {type(e).__name__}: {e}")

    summary = shared.get("persist_summary") or {}
    return TemplateParametersSavedResponse(
        template_id=template_id,
        version=int(summary.get("version") or 0),
        parameters=list(defs.get("parameters") or []),
    )


@reporting_router.post(
    "/templates/{template_id}/seed-definitions",
    response_model=SeedDefinitionsResponse,
    summary="Create definitions.yaml skeleton (scan HTML only, no LLM)",
)
async def seed_definitions_skeleton(template_id: str) -> SeedDefinitionsResponse:
    """Write ``definitions.yaml`` with one **skeleton** row per ``data-block``.

    Does **not** invoke ``run_report_bootstrap`` — each block gets ``status:
    skeleton`` and empty ``sql:`` so the user or edit-agent can fill logic
    per block.
    """
    tdir = _template_dir(template_id)
    html_path = tdir / "report-template.html"
    defs_path = tdir / "definitions.yaml"
    if not html_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    if defs_path.is_file():
        raise HTTPException(
            409,
            f"definitions.yaml already exists for {template_id}; "
            "delete it first or use bootstrap / edit-agent.",
        )

    from nodes.reporting.definition_persist_node import DefinitionPersistNode
    from nodes.reporting.template_scan_node import scan_template

    try:
        html = html_path.read_text(encoding="utf-8")
        scan = scan_template(html)
    except Exception as e:
        raise HTTPException(400, f"Template scan failed: {e}") from e

    blocks: List[Dict[str, Any]] = []
    for b in scan.blocks:
        blocks.append(
            {
                "id":     b.name,
                "goal":   "",
                "kind":   b.kind,
                "tokens": list(b.inner_scalars),
                "status": "skeleton",
                "sql":    "",
            }
        )

    shared: Dict[str, Any] = {
        "template_id":       template_id,
        "templates_root":    str(_TEMPLATES_ROOT),
        "report_definitions": {
            "template_id": template_id,
            "version":     0,
            "parameters":  [],
            "sources":     [],
            "blocks":      blocks,
            "metadata":    {
                "seeded_by":            "seed-definitions",
                "skeleton_block_count": len(blocks),
            },
        },
        "persist_mode": "replace",
        "actor":        "seed",
        "agent_note":   "seed_definitions_skeleton",
    }
    try:
        node = DefinitionPersistNode(templates_root=_TEMPLATES_ROOT)
        node.run(shared)
    except Exception as e:
        logger.exception("seed_definitions_skeleton failed for %r", template_id)
        raise HTTPException(500, f"Failed to write definitions: {e}") from e

    summary = shared.get("persist_summary") or {}
    return SeedDefinitionsResponse(
        template_id=template_id,
        version=int(summary.get("version") or 0),
        blocks_count=int(summary.get("blocks_total") or 0),
        definitions_path=str(
            summary.get("definitions_path") or defs_path.resolve(),
        ),
    )


# ── PUT /templates/{template_id}/template-html ─────────────────────────────


@reporting_router.put(
    "/templates/{template_id}/template-html",
    response_model=TemplateHtmlSavedResponse,
)
async def put_template_html(
    template_id: str,
    body: TemplateHtmlBody,
) -> TemplateHtmlSavedResponse:
    """Replace ``report-template.html`` with the given UTF-8 text (atomic write)."""
    tdir = _template_dir(template_id)
    path = tdir / "report-template.html"
    if not path.is_file():
        raise HTTPException(
            404,
            f"report-template.html not found for template_id={template_id!r}",
        )
    text = body.html
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        logger.error("template-html write failed: %s", exc, exc_info=True)
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise HTTPException(500, f"failed to write template: {exc}") from exc

    raw = text.encode("utf-8")
    return TemplateHtmlSavedResponse(
        ok=True,
        template_id=template_id,
        bytes_written=len(raw),
    )


# ── PUT /templates/{template_id}/report-css ────────────────────────────────


@reporting_router.put(
    "/templates/{template_id}/report-css",
    response_model=ReportCssSavedResponse,
)
async def put_report_css(
    template_id: str,
    body: ReportCssBody,
) -> ReportCssSavedResponse:
    """Replace or create ``report.css`` in the template directory (atomic write)."""
    tdir = _template_dir(template_id)
    if not tdir.is_dir():
        raise HTTPException(
            404,
            f"template directory not found for template_id={template_id!r}",
        )
    path = tdir / "report.css"
    text = body.css
    _REPORT_CSS_MAX_BYTES = 8 * 1024 * 1024
    raw = text.encode("utf-8")
    if len(raw) > _REPORT_CSS_MAX_BYTES:
        raise HTTPException(400, "report.css body exceeds maximum size")
    tmp = path.with_name(path.name + ".tmp")
    try:
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)
    except OSError as exc:
        logger.error("report-css write failed: %s", exc, exc_info=True)
        if tmp.exists():
            try:
                tmp.unlink()
            except OSError:
                pass
        raise HTTPException(500, f"failed to write report.css: {exc}") from exc

    return ReportCssSavedResponse(
        ok=True,
        template_id=template_id,
        bytes_written=len(raw),
    )


# ── POST /templates/{template_id}/bootstrap ────────────────────────────────


@reporting_router.post(
    "/templates/{template_id}/bootstrap", status_code=202,
    response_model=BootstrapStartedResponse,
)
async def start_bootstrap(
    template_id: str,
    body: Optional[BootstrapRequest] = None,
) -> BootstrapStartedResponse:
    """Kick off the bootstrap pipeline as a background job.

    The job emits SSE events identical in shape to the embedding-agent
    pipeline, so the existing ``EmbeddingPipelinePopup`` component can be
    pointed at this endpoint with no protocol changes.
    """
    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")

    # If a bootstrap is already running for this template, return that job_id
    # so the client reconnects to it.
    for jid, existing in _BOOTSTRAP_JOBS.items():
        if existing["template_id"] == template_id and existing["status"] == "running":
            return BootstrapStartedResponse(
                job_id=jid,
                template_id=template_id,
                message="Bootstrap already running — reconnecting.",
            )

    job_id = f"bootstrap-{uuid.uuid4().hex[:12]}"
    job: Dict[str, Any] = {
        "status":      "running",
        "template_id": template_id,
        "started_at":  time.time(),
        "finished_at": None,
        "error":       None,
        "events":      [],
        "last_event":  None,
        "result":      None,
    }
    _BOOTSTRAP_JOBS[job_id] = job

    parquet_cache_dir = body.parquet_cache_dir if body else None

    def _run():
        try:
            from flows.report_bootstrap_flow import run_report_bootstrap
            result = run_report_bootstrap(
                template_id=template_id,
                parquet_cache_dir=parquet_cache_dir,
                job=job,
            )
            job["result"] = result
            if result.get("success"):
                job["status"] = "completed"
            else:
                job["status"] = "failed"
                job["error"] = (
                    result.get("error")
                    or "drafted with errors — see draft_errors / validation_summary"
                )
        except Exception as exc:
            logger.error("Report bootstrap failed: job=%s %s", job_id, exc, exc_info=True)
            job["status"] = "failed"
            job["error"] = str(exc)
        finally:
            job["finished_at"] = time.time()

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run)

    return BootstrapStartedResponse(
        job_id=job_id,
        template_id=template_id,
        message=(
            f"Bootstrap started. Stream events at "
            f"/reporting/templates/bootstrap/{job_id}/events"
        ),
    )


# ── GET /templates/bootstrap/{job_id}/events ───────────────────────────────


@reporting_router.get("/templates/bootstrap/{job_id}/events")
async def stream_bootstrap_events(job_id: str):
    """SSE endpoint streaming every ``emit(step, …)`` event from the flow."""
    job = _BOOTSTRAP_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")

    async def event_generator():
        last_idx = 0
        while True:
            events = job.get("events", [])
            while last_idx < len(events):
                evt = events[last_idx]
                last_idx += 1
                yield f"data: {json.dumps(evt, default=str)}\n\n"

            if job["status"] in ("completed", "failed"):
                summary = {
                    "step":    "summary",
                    "status":  job["status"],
                    "error":   job.get("error"),
                    "result":  job.get("result"),
                    "elapsed": round(
                        (job["finished_at"] or time.time()) - job["started_at"], 1
                    ),
                }
                yield f"data: {json.dumps(summary, default=str)}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── GET /templates/bootstrap/{job_id}/status ───────────────────────────────


@reporting_router.get(
    "/templates/bootstrap/{job_id}/status",
    response_model=JobStatusResponse,
)
async def get_bootstrap_status(job_id: str) -> JobStatusResponse:
    """Polling alternative to the SSE endpoint."""
    job = _BOOTSTRAP_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        started_at=job.get("started_at"),
        finished_at=job.get("finished_at"),
        error=job.get("error"),
        result=job.get("result"),
        last_event=job.get("last_event"),
    )


# ── POST /templates/{template_id}/render ───────────────────────────────────


@reporting_router.post(
    "/templates/{template_id}/render",
    response_model=None,
)
async def render_template(
    template_id: str,
    body: Optional[RenderRequest] = None,
):
    """Render a template by executing every block's CTE then filling the HTML.

    By default this is synchronous and returns the rendered HTML inline
    in :class:`RenderResponse`.  Pass ``async_mode: true`` to receive a
    ``job_id`` and stream events from
    ``/reporting/templates/render/{job_id}/events`` instead — useful for
    long-running renders with many narrative slots.
    """
    body = body or RenderRequest()
    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    defs_path = tdir / "definitions.yaml"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    if not defs_path.is_file():
        raise HTTPException(
            409,
            f"definitions.yaml missing for {template_id}; "
            f"run POST /reporting/templates/{template_id}/bootstrap first",
        )

    # ── Async mode ───────────────────────────────────────────────────────
    if body.async_mode:
        job_id = f"render-{uuid.uuid4().hex[:12]}"
        job: Dict[str, Any] = {
            "status":      "running",
            "template_id": template_id,
            "started_at":  time.time(),
            "finished_at": None,
            "error":       None,
            "events":      [],
            "last_event":  None,
            "result":      None,
        }
        _RENDER_JOBS[job_id] = job

        def _run():
            try:
                from flows.report_render_flow import run_report_render
                result = run_report_render(
                    template_id=template_id,
                    parameters=body.parameters,
                    parquet_paths=body.parquet_paths,
                    pre_supplied_narratives=body.pre_supplied_narratives,
                    job=job,
                )
                job["result"] = result
                job["status"] = "completed" if result.get("success") else "failed"
                if not result.get("success"):
                    job["error"] = result.get("error") or "render failed"
            except Exception as exc:
                logger.error(
                    "Report render failed: job=%s %s", job_id, exc, exc_info=True,
                )
                job["status"] = "failed"
                job["error"] = str(exc)
            finally:
                job["finished_at"] = time.time()

        loop = asyncio.get_event_loop()
        loop.run_in_executor(None, _run)

        return RenderJobStartedResponse(
            job_id=job_id,
            template_id=template_id,
            message=(
                f"Render started. Stream events at "
                f"/reporting/templates/render/{job_id}/events"
            ),
        )

    # ── Synchronous mode ─────────────────────────────────────────────────
    try:
        from flows.report_render_flow import run_report_render
        result = run_report_render(
            template_id=template_id,
            parameters=body.parameters,
            parquet_paths=body.parquet_paths,
            pre_supplied_narratives=body.pre_supplied_narratives,
        )
    except Exception as exc:
        logger.error("Synchronous render crashed: %s", exc, exc_info=True)
        raise HTTPException(500, f"Render crashed: {type(exc).__name__}: {exc}")

    return RenderResponse(
        template_id=template_id,
        success=result.get("success", False),
        html=result.get("html"),
        missing=result.get("missing") or [],
        sql_errors=result.get("sql_errors") or [],
        sql_summary=result.get("sql_summary") or {},
        narrative_summary=result.get("narrative_summary") or {},
        render_flags=result.get("render_flags") or {},
        duration_ms=result.get("duration_ms", 0),
        error=result.get("error"),
    )


# ── GET /templates/render/{job_id}/events ──────────────────────────────────


@reporting_router.get("/templates/render/{job_id}/events")
async def stream_render_events(job_id: str):
    """SSE endpoint streaming every ``emit(step, …)`` event from the render flow."""
    job = _RENDER_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")

    async def event_generator():
        last_idx = 0
        while True:
            events = job.get("events", [])
            while last_idx < len(events):
                evt = events[last_idx]
                last_idx += 1
                yield f"data: {json.dumps(evt, default=str)}\n\n"

            if job["status"] in ("completed", "failed"):
                summary = {
                    "step":    "summary",
                    "status":  job["status"],
                    "error":   job.get("error"),
                    "result":  job.get("result"),
                    "elapsed": round(
                        (job["finished_at"] or time.time()) - job["started_at"], 1
                    ),
                }
                yield f"data: {json.dumps(summary, default=str)}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── GET /templates/render/{job_id}/status ──────────────────────────────────


@reporting_router.get(
    "/templates/render/{job_id}/status",
    response_model=JobStatusResponse,
)
async def get_render_status(job_id: str) -> JobStatusResponse:
    """Polling alternative for an async render job."""
    job = _RENDER_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        started_at=job.get("started_at"),
        finished_at=job.get("finished_at"),
        error=job.get("error"),
        result=job.get("result"),
        last_event=job.get("last_event"),
    )


# ── POST /templates/{template_id}/blocks/{block_id} ────────────────────────


_DEFAULT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"
_INSURANCE_PRODUCTION_LIBRARY = (
    _PROJECT_ROOT / "data" / "reporting" / "sql" / "insurance_production"
)
_DEFAULT_PARQUET_DIR = _PROJECT_ROOT / "data" / "parquet"


# ── GET /reporting/parquet-files ──────────────────────────────────────────


@reporting_router.get(
    "/parquet-files",
    response_model=ParquetFileListResponse,
)
async def list_parquet_files(
    template_id: Optional[str] = None,
    include_embeddings: bool = False,
) -> ParquetFileListResponse:
    """List parquet files available under ``data/parquet/``.

    Drives the **"Source de données"** dropdown in the reporting UI:
    the user picks which file should back each ``definitions.sources[*]``
    entry when a block preview needs to register a view.

    Query parameters:
      * ``template_id``         — when provided, the response also
                                  includes a ``default_paths`` mapping
                                  pre-selecting the latest matching
                                  parquet for each declared source so
                                  the frontend can show a sensible
                                  initial selection.
      * ``include_embeddings``  — when ``true``, ``*_embeddings.parquet``
                                  files are included read-only (they
                                  cannot drive a CTE source but the UI
                                  may want to display them).
    """
    from nodes.reporting.parquet_resolver import (
        discover_parquet_files,
        pick_default_paths,
    )

    discovered = discover_parquet_files(
        _DEFAULT_PARQUET_DIR,
        include_embeddings=include_embeddings,
    )
    files_payload = [
        ParquetFileEntry(**entry.to_dict()) for entry in discovered
    ]

    default_paths: Dict[str, str] = {}
    if template_id:
        try:
            tdir = _template_dir(template_id)
        except HTTPException:
            tdir = None  # bad template id → just return the file list
        if tdir is not None:
            defs_path = tdir / "definitions.yaml"
            if defs_path.is_file():
                try:
                    defs = yaml.safe_load(defs_path.read_text(encoding="utf-8")) or {}
                    sources = defs.get("sources") or []
                    default_paths = pick_default_paths(sources, discovered)
                except Exception as exc:
                    logger.warning(
                        "could not derive default parquet paths for %s: %s",
                        template_id, exc,
                    )

    return ParquetFileListResponse(
        parquet_dir=str(_DEFAULT_PARQUET_DIR.resolve()),
        files=files_payload,
        default_paths=default_paths,
    )


@reporting_router.post(
    "/templates/{template_id}/blocks/{block_id}",
    response_model=BlockUpsertResponse,
)
async def upsert_block(
    template_id: str,
    block_id: str,
    body: BlockUpsertRequest,
) -> BlockUpsertResponse:
    """Validate and persist a single block definition (create or update).

    Frontend equivalent of the agent tool ``set_block_definition`` —
    used by the per-block edit UX so a user can save an inline edit
    without driving the LLM.  The persist step bumps ``version:`` and
    appends to ``definitions.history.jsonl``.
    """
    from nodes.reporting.definition_persist_node import DefinitionPersistNode
    from nodes.reporting.sql_helpers import validate_block, default_insurance_merge_library_dirs

    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    defs_path = tdir / "definitions.yaml"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    if not defs_path.is_file():
        raise HTTPException(
            409,
            f"definitions.yaml missing for {template_id}; "
            f"run POST /reporting/templates/{template_id}/bootstrap first",
        )
    bid = (block_id or "").strip()
    if not bid:
        raise HTTPException(400, "block_id is required")

    try:
        defs = yaml.safe_load(defs_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise HTTPException(400, f"Could not parse definitions.yaml: {e}")
    if not isinstance(defs, dict) or "blocks" not in defs:
        raise HTTPException(
            400,
            f"{defs_path}: missing 'blocks' list (per-field schema is no "
            f"longer supported — re-bootstrap)",
        )

    block_payload: Dict[str, Any] = {"id": bid, "kind": body.kind}
    for k in (
        "goal", "tokens", "mapping", "grounding_fields",
        "sql", "cte_ref", "ctes", "depends_on", "style", "fallback_text",
    ):
        v = getattr(body, k)
        if v is not None:
            block_payload[k] = v
    if isinstance(block_payload.get("sql"), str):
        block_payload["sql"] = block_payload["sql"].strip()

    blocks_prev = list(defs.get("blocks") or [])
    existing_block = next((b for b in blocks_prev if b.get("id") == bid), None)
    # Partial PATCH-style saves from the UI often omit sql / cte_ref; validate the
    # merged definition so an existing CTE is retained (422 otherwise).
    block_for_validate: Dict[str, Any] = (
        {**existing_block, **block_payload} if existing_block else dict(block_payload)
    )

    merge_ins = default_insurance_merge_library_dirs()
    rep = validate_block(
        block_for_validate,
        library_dir       = _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None,
        block_library_dir = _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None,
        merge_library_dirs= merge_ins or None,
    )
    if not rep.ok:
        raise HTTPException(
            422,
            {
                "message": f"validation failed for block {bid!r}",
                "errors":  rep.errors,
                "warnings": rep.warnings,
            },
        )

    block_payload["status"] = "live"
    blocks = blocks_prev
    action = "created"
    for i, existing in enumerate(blocks):
        if existing.get("id") == bid:
            merged = dict(existing)
            merged.update(block_payload)
            # Validation just succeeded — drop any stale draft noise that
            # was carried over from a previous failed bootstrap/edit so the
            # UI doesn't keep showing red badges on a green block.
            merged.pop("draft_errors", None)
            merged.pop("draft_warnings", None)
            blocks[i] = merged
            action = "updated"
            break
    else:
        blocks.append(block_payload)
    defs["blocks"] = blocks

    shared: Dict[str, Any] = {
        "report_definitions": defs,
        "template_id":        template_id,
        "templates_root":     str(_TEMPLATES_ROOT),
        "draft_reports":      [],
        "persist_mode":       "replace",
        "agent_note":         f"api.upsert_block {bid}",
    }
    try:
        DefinitionPersistNode().run(shared)
    except Exception as e:
        logger.error("upsert_block persist failed: %s", e, exc_info=True)
        raise HTTPException(500, f"persist failed: {type(e).__name__}: {e}")

    summary = shared.get("persist_summary") or {}
    parsed = rep.parsed
    return BlockUpsertResponse(
        template_id=template_id,
        block_id=bid,
        action=action,
        version=int(summary.get("version") or 0),
        final_aliases=parsed.final_aliases if parsed else [],
        referenced_params=parsed.referenced_params if parsed else [],
        warnings=rep.warnings,
    )


@reporting_router.post(
    "/templates/{template_id}/blocks/{block_id}/save-cte",
    response_model=SaveCteResponse,
)
async def save_block_cte_from_prompt(
    template_id: str,
    block_id: str,
    body: SaveCteRequest,
) -> SaveCteResponse:
    """Generate a block CTE from a user prompt, validate it, and persist it."""
    if not (body.goal or "").strip():
        raise HTTPException(400, "goal is required")

    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")

    loop = asyncio.get_running_loop()

    def _run_sync() -> Dict[str, Any]:
        from flows.report_cte_save_flow import run_report_cte_save

        return run_report_cte_save(
            template_id=template_id,
            block_id=block_id,
            prompt=body.goal,
            templates_root=_TEMPLATES_ROOT,
            max_retries=body.max_retries,
        )

    result = await loop.run_in_executor(None, _run_sync)
    if not result.get("success"):
        detail: Dict[str, Any] = {
            "message": result.get("error") or "save CTE failed",
        }
        if result.get("validation_summary"):
            detail["validation_summary"] = result["validation_summary"]
        raise HTTPException(422, detail=detail)

    persist_summary = result.get("persist_summary") or {}
    return SaveCteResponse(
        template_id=template_id,
        block_id=block_id,
        action=str(result.get("action") or "updated"),
        version=int(persist_summary.get("version") or 0),
        duration_ms=float(result.get("duration_ms") or 0),
        block=result.get("block") or {},
        validation_summary=result.get("validation_summary") or {},
        cte_sql_path=result.get("cte_sql_path"),
        cte_graph_id=result.get("cte_graph_id"),
        cte_graph_stats=result.get("cte_graph_stats"),
        cte_graph_error=result.get("cte_graph_error"),
    )


# ── POST /templates/{template_id}/blocks/{block_id}/preview ────────────────


_PREVIEW_ROW_LIMIT_CAP = 200


def _jsonable(value: Any) -> Any:
    """Coerce a DuckDB cell into a JSON-serialisable primitive.

    DuckDB returns native Python objects (``datetime.date``, ``Decimal``,
    ``UUID``, ``bytes`` …) which Pydantic / FastAPI would otherwise
    reject.  We stringify anything non-trivial and keep numerics intact
    so the frontend can right-align them.
    """
    import datetime
    from decimal import Decimal
    from uuid import UUID
    if value is None or isinstance(value, (bool, int, float, str)):
        return value
    if isinstance(value, Decimal):
        f = float(value)
        return f if f == f else str(value)  # NaN -> str
    if isinstance(value, (datetime.date, datetime.datetime, datetime.time)):
        return value.isoformat()
    if isinstance(value, datetime.timedelta):
        return value.total_seconds()
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)


def _load_template_definitions(template_id: str) -> Dict[str, Any]:
    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    defs_path = tdir / "definitions.yaml"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    if not defs_path.is_file():
        raise HTTPException(
            409,
            f"definitions.yaml missing for {template_id}; "
            f"run POST /reporting/templates/{template_id}/bootstrap first",
        )
    try:
        defs = yaml.safe_load(defs_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise HTTPException(400, f"Could not parse definitions.yaml: {e}")
    if not isinstance(defs, dict) or "blocks" not in defs:
        raise HTTPException(
            400,
            f"{defs_path}: missing 'blocks' list (per-field schema is no "
            f"longer supported — re-bootstrap)",
        )
    return defs


def _normalise_template_parameters(
    raw: List[TemplateParameterDefinition],
) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for i, entry in enumerate(raw or []):
        pid = (entry.id or "").strip()
        if not pid:
            raise HTTPException(400, f"parameters[{i}].id is required")
        key = pid.lower()
        if key in seen:
            raise HTTPException(400, f"duplicate parameter id: {pid!r}")
        seen.add(key)
        row: Dict[str, Any] = {"id": pid}
        ptype = (entry.type or "").strip()
        if ptype:
            row["type"] = ptype
        if entry.default is not None:
            row["default"] = entry.default
        desc = (entry.description or "").strip()
        if desc:
            row["description"] = desc
        out.append(row)
    return out


def _select_report_block(
    defs: Dict[str, Any],
    block_id: str,
) -> Dict[str, Any]:
    bid = (block_id or "").strip()
    if not bid:
        raise HTTPException(400, "block_id is required")
    block = next(
        (b for b in (defs.get("blocks") or []) if b.get("id") == bid),
        None,
    )
    if block is None:
        raise HTTPException(404, f"block {bid!r} not found")
    return block


def _select_executable_block(
    block: Dict[str, Any],
    sub_block_id: Optional[str] = None,
    *,
    for_preview: bool = False,
) -> tuple[Dict[str, Any], Optional[str]]:
    preview_sub_id: Optional[str] = None
    exec_block: Dict[str, Any] = block

    if (block.get("kind") or "") == "mixed":
        sub_raw = (sub_block_id or "").strip()
        if not sub_raw:
            ctes = block.get("ctes") or []
            ids = [
                str(c.get("id"))
                for c in ctes
                if isinstance(c, dict) and c.get("id")
            ]
            detail = (
                "mixed block preview requires sub_block_id in the JSON body "
                if for_preview
                else "mixed block source lookup requires sub_block_id "
            )
            raise HTTPException(
                422,
                f"{detail}(one of: {', '.join(ids) or 'no ctes defined'})",
            )
        ctes = block.get("ctes") or []
        sub = next(
            (
                c for c in ctes
                if isinstance(c, dict) and str(c.get("id") or "") == sub_raw
            ),
            None,
        )
        if sub is None:
            raise HTTPException(
                404,
                f"mixed sub-CTE {sub_raw!r} not found under block {block.get('id')!r}",
            )
        sk = (sub.get("kind") or "").strip()
        if sk == "mixed":
            raise HTTPException(
                422, "nested mixed sub-CTE preview is not supported",
            )
        if for_preview and sk == "empty":
            raise HTTPException(
                422, f"sub-CTE {sub_raw!r} is empty — nothing to execute",
            )
        exec_block = sub
        preview_sub_id = sub_raw

    return exec_block, preview_sub_id


def _report_fragment_lookup(template_id: str):
    """Return a ``name -> rawSql`` lookup backed by the report's pickle graph.

    Reads the template's ``index.yaml`` (``cte_graph`` id) and loads the
    pickle from ``data/cte_graphs/``. Returns a no-op lookup if absent.
    """
    try:
        from services.cte_graph.report_graph import (
            load_report_graph,
            load_report_index,
            make_fragment_lookup,
        )

        template_dir = _TEMPLATES_ROOT / template_id
        index = load_report_index(template_dir) or {}
        gid = index.get("cte_graph")
        graph = load_report_graph(str(gid)) if gid else None
        return make_fragment_lookup(graph)
    except Exception:  # pragma: no cover - defensive
        return lambda _name: None


def _resolve_block_sql_source(
    exec_block: Dict[str, Any],
    *,
    block_id: str,
    preview_sub_id: Optional[str] = None,
    fragment_lookup=None,
) -> tuple[str, Optional[str], Optional[str], str]:
    """Resolve executable SQL for a block.

    Non-empty inline ``sql:`` takes precedence over ``cte_ref:`` so edits in the
    agent / YAML are not shadowed by a stale reference. ``cte_ref:`` resolves
    from the report's pickle CTE graph (``fragment_lookup``).
    """
    sql_inline = (exec_block.get("sql") or "").strip()
    cte_ref = (exec_block.get("cte_ref") or "").strip() or None
    source_path: Optional[str] = None
    source_mode = "inline"

    if sql_inline:
        sql = sql_inline
        source_mode = "inline"
        source_path = None
        cte_ref = None
    elif cte_ref:
        found = fragment_lookup(cte_ref) if fragment_lookup else None
        if found is None:
            raise HTTPException(
                404,
                f"cte_ref={cte_ref!r} not found in the report CTE graph "
                f"(data/cte_graphs/); reports read SQL from the pickle graph only",
            )
        sql = found
        source_path = f"cte_graph::{cte_ref}"
        source_mode = "cte_ref"
    else:
        sql = ""
    if not sql:
        who = f"{block_id}/{preview_sub_id}" if preview_sub_id else block_id
        raise HTTPException(
            422,
            f"block {who!r} has neither sql: nor cte_ref: — "
            f"define it via the agent or the inline editor first",
        )
    return sql, cte_ref, source_path, source_mode


def _infer_insurance_leaf_cte(
    block_id: str,
    goal: str,
    explicit: Optional[str],
) -> str:
    if explicit and explicit.strip():
        return explicit.strip()
    bid = (block_id or "").lower()
    g = (goal or "").lower()
    if "croissance" in g or "yoy" in g:
        return "period_metrics"
    if (
        "kpi" in bid
        or "ca" in g
        or "chiffre" in g
        or "affaire" in g
        or "encaiss" in g
        or "prime" in g
    ):
        return "period_metrics"
    if "renouvel" in g or "rétention" in g:
        return "renewal_analysis"
    if "impay" in g:
        return "unpaid_quitances"
    if "intermédiaire" in g or "courtier" in g:
        return "intermediary_distribution"
    return "enriched_data"


def _insurance_production_dep_ordered(leaf: str) -> List[str]:
    from nodes.reporting.sql_helpers import (
        _closure_accounting_seeds,
        _topo_sort_deps,
    )

    idx = _INSURANCE_PRODUCTION_LIBRARY / "index.yaml"
    if not idx.is_file():
        return []
    doc = yaml.safe_load(idx.read_text(encoding="utf-8")) or {}
    deps_map: Dict[str, List[str]] = {}
    for row in doc.get("ctes") or []:
        if not isinstance(row, dict):
            continue
        name = row.get("name")
        if not isinstance(name, str):
            continue
        deps_map[name] = [
            d for d in (row.get("depends_on") or []) if isinstance(d, str)
        ]
    if leaf not in deps_map:
        return [leaf]
    closure = _closure_accounting_seeds({leaf}, deps_map)
    return _topo_sort_deps(closure, deps_map)


@reporting_router.post(
    "/templates/{template_id}/blocks/{block_id}/generate-insurance-production-cte",
    response_model=GenerateInsuranceProductionCteResponse,
)
async def generate_insurance_production_cte(
    template_id: str,
    block_id: str,
    body: GenerateInsuranceProductionCteRequest = GenerateInsuranceProductionCteRequest(),
) -> GenerateInsuranceProductionCteResponse:
    """Draft block SQL anchored on ``insurance_production`` with transitive CTE deps."""
    if not _INSURANCE_PRODUCTION_LIBRARY.is_dir():
        raise HTTPException(
            500,
            "insurance_production SQL library is missing on the server",
        )
    defs = _load_template_definitions(template_id)
    bid = (block_id or "").strip()
    block = _select_report_block(defs, bid)
    goal = (block.get("goal") or "") if isinstance(block, dict) else ""
    leaf = _infer_insurance_leaf_cte(bid, goal, body.leaf_cte)

    idx = _INSURANCE_PRODUCTION_LIBRARY / "index.yaml"
    if idx.is_file():
        doc = yaml.safe_load(idx.read_text(encoding="utf-8")) or {}
        names = {
            row.get("name")
            for row in (doc.get("ctes") or [])
            if isinstance(row, dict) and isinstance(row.get("name"), str)
        }
        if leaf not in names:
            raise HTTPException(
                422,
                f"leaf_cte {leaf!r} is not defined in insurance_production/index.yaml",
            )

    safe = re.sub(r"[^A-Za-z0-9_]", "_", bid or "block").strip("_") or "block_value"
    if leaf == "period_metrics":
        generated = (
            f"WITH {{{{include: period_metrics}}}}\n"
            f"SELECT ROUND(SUM(prime_nette_mois) / 1000000.0, 1) AS {safe}\n"
            f"FROM period_metrics\n"
            f"WHERE year = (SELECT MAX(year) FROM period_metrics)"
        )
    elif leaf == "enriched_data":
        generated = (
            f"WITH {{{{include: enriched_data}}}}\n"
            f"SELECT ROUND(SUM(PRIMNETT) / 1000000.0, 1) AS {safe}\n"
            f"FROM enriched_data"
        )
    else:
        generated = (
            f"WITH {{{{include: {leaf}}}}}\n"
            f"SELECT * FROM {leaf} LIMIT 200"
        )

    depends = _insurance_production_dep_ordered(leaf)

    from nodes.reporting.sql_helpers import default_insurance_merge_library_dirs, expand_includes

    accounting = _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    blocks_lib = _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    extra_libs = [blocks_lib] if blocks_lib else []
    merge_ins = default_insurance_merge_library_dirs()
    try:
        expanded = expand_includes(
            generated,
            accounting,
            extra_library_dirs=extra_libs,
            merge_library_dirs=merge_ins or None,
        )
    except Exception as exc:
        raise HTTPException(
            422,
            f"include expansion failed: {type(exc).__name__}: {exc}",
        )

    val_errors: List[str] = []
    val_ok = True
    try:
        from nodes.reporting.sql_helpers import validate_block

        probe = {
            "id": bid,
            "kind": (block.get("kind") or "empty").strip(),
            "tokens": block.get("tokens") or [],
            "mapping": block.get("mapping"),
            "grounding_fields": block.get("grounding_fields") or [],
            "sql": generated,
            "cte_ref": None,
        }
        rep = validate_block(
            probe,
            library_dir       = accounting,
            block_library_dir = (
                _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
            ),
            merge_library_dirs= merge_ins or None,
        )
        val_ok = rep.ok
        val_errors = list(rep.errors)
    except Exception as exc:
        val_ok = False
        val_errors = [f"{type(exc).__name__}: {exc}"]

    return GenerateInsuranceProductionCteResponse(
        template_id=template_id,
        block_id=bid,
        leaf_cte=leaf,
        depends_ordered=depends,
        generated_sql=generated,
        expanded_sql=expanded,
        validation_ok=val_ok,
        validation_errors=val_errors,
    )


@reporting_router.get(
    "/templates/{template_id}/blocks/{block_id}/sql-source",
    response_model=BlockSqlSourceResponse,
)
async def get_block_sql_source(
    template_id: str,
    block_id: str,
    sub_block_id: Optional[str] = None,
) -> BlockSqlSourceResponse:
    """Return the SQL source associated with one block without executing it."""
    defs = _load_template_definitions(template_id)
    block = _select_report_block(defs, block_id)
    exec_block, preview_sub_id = _select_executable_block(
        block,
        sub_block_id,
        for_preview=False,
    )
    fragment_lookup = _report_fragment_lookup(template_id)
    sql, cte_ref, source_path, source_mode = _resolve_block_sql_source(
        exec_block,
        block_id=block_id,
        preview_sub_id=preview_sub_id,
        fragment_lookup=fragment_lookup,
    )

    from nodes.reporting.sql_helpers import expand_includes, default_insurance_merge_library_dirs

    accounting = _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    blocks_lib = _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    extra_libs = [blocks_lib] if blocks_lib else []
    merge_ins = default_insurance_merge_library_dirs()
    try:
        expanded = expand_includes(
            sql,
            accounting,
            extra_library_dirs=extra_libs,
            merge_library_dirs=merge_ins or None,
            fragment_lookup=fragment_lookup,
        )
    except Exception as exc:
        raise HTTPException(
            422,
            f"include resolution failed: {type(exc).__name__}: {exc}",
        )

    return BlockSqlSourceResponse(
        template_id=template_id,
        block_id=block_id,
        sub_block_id=preview_sub_id,
        kind=exec_block.get("kind") or "",
        source_mode=source_mode,
        cte_ref=cte_ref,
        source_path=source_path,
        sql=sql,
        expanded_sql=expanded,
    )


@reporting_router.post(
    "/templates/{template_id}/blocks/{block_id}/preview",
    response_model=BlockPreviewResponse,
)
async def preview_block(
    template_id: str,
    block_id: str,
    body: Optional[BlockPreviewRequest] = None,
) -> BlockPreviewResponse:
    """Execute a block's CTE in DuckDB and return its projected rows.

    Frontend equivalent of the agent tool ``preview_block`` — used by
    the per-block UX so a user can click the block, inspect the SQL,
    and run it inline to see the projected rows BEFORE saving an edit
    or kicking off a full ``render``.

    The endpoint:
      1. Loads ``definitions.yaml`` and locates the block by id.
      2. For ``kind=mixed``, requires ``sub_block_id`` naming one
         ``ctes[]`` child; otherwise resolves the SQL from the block
         itself (inline ``sql:`` or ``cte_ref:`` from the block library),
         expands ``{{include: …}}`` references, binds any ``$param``
         placeholders and registers the supplied parquet views.
      3. Executes against DuckDB and returns up to ``limit`` rows.

    Returns ``422`` for SQL errors so the frontend can surface them as
    a soft validation message instead of a generic 500.
    """
    body = body or BlockPreviewRequest()
    defs = _load_template_definitions(template_id)
    bid = (block_id or "").strip()
    block = _select_report_block(defs, bid)
    exec_block, preview_sub_id = _select_executable_block(
        block,
        body.sub_block_id,
        for_preview=True,
    )
    fragment_lookup = _report_fragment_lookup(template_id)
    sql, _cte_ref, _source_path, _source_mode = _resolve_block_sql_source(
        exec_block,
        block_id=bid,
        preview_sub_id=preview_sub_id,
        fragment_lookup=fragment_lookup,
    )

    from nodes.reporting.sql_helpers import (
        bind_params_case_insensitive,
        default_insurance_merge_library_dirs,
        expand_includes,
        field_param_names,
    )
    from nodes.reporting.parquet_resolver import (
        derive_implicit_params,
        discover_parquet_files,
        ensure_ca_view_registered,
        pick_default_paths,
        register_source_view,
    )
    from nodes.reporting.sql_batch_node import _defaults_from_definition_parameters

    accounting = _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    blocks_lib = _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    extra_libs = [blocks_lib] if blocks_lib else []
    merge_ins = default_insurance_merge_library_dirs()
    try:
        expanded = expand_includes(
            sql,
            accounting,
            extra_library_dirs=extra_libs,
            merge_library_dirs=merge_ins or None,
            fragment_lookup=fragment_lookup,
        )
    except Exception as exc:
        raise HTTPException(
            422,
            f"include resolution failed: {type(exc).__name__}: {exc}",
        )

    refs = field_param_names(expanded)
    # Derive the implicit ``$prior_period`` / ``$year`` slots from the
    # single ``$period`` value the UI now exposes — this keeps existing
    # CTEs that still mention ``$prior_period`` working without forcing
    # the user to type the year-shifted date themselves.
    rp_raw = dict(body.parameters or {})
    file_defaults = _defaults_from_definition_parameters(defs)
    merged_params = {**file_defaults, **rp_raw}
    enriched_params = derive_implicit_params(refs, merged_params)
    bound = bind_params_case_insensitive(refs, enriched_params)
    missing_params = [n for n in refs if bound.get(n) is None]

    # ── Execute against DuckDB ──────────────────────────────────────────
    limit = max(1, min(int(body.limit or 5), _PREVIEW_ROW_LIMIT_CAP))
    declared_sources = list(defs.get("sources") or [])

    # Resolve parquet paths.  Priority:
    #   1. explicit ``body.parquet_paths`` (UI selection / agent override)
    #   2. auto-discovered defaults from ``data/parquet/``
    auto_paths: Dict[str, str] = {}
    if declared_sources:
        try:
            discovered = discover_parquet_files(_DEFAULT_PARQUET_DIR)
            auto_paths = pick_default_paths(declared_sources, discovered)
        except Exception as exc:
            logger.warning("parquet auto-discovery failed: %s", exc)
            auto_paths = {}

    parquet_paths: Dict[str, str] = dict(auto_paths)
    parquet_paths.update(body.parquet_paths or {})

    resolved_paths: Dict[str, str] = {}

    try:
        from nodes.dataloader.duckdb_query_node import open_connection
    except Exception as exc:
        raise HTTPException(500, f"DuckDB unavailable: {type(exc).__name__}: {exc}")

    t0 = time.perf_counter()
    try:
        conn = open_connection(
            memory_limit="512MB",
            temp_directory="data/.duckdb_tmp",
            max_temp_size="10GB",
        )
        try:
            for src in declared_sources:
                name = src.get("name")
                source_id = src.get("source_id")
                if not name:
                    continue
                path = parquet_paths.get(name) or parquet_paths.get(source_id)
                if not path:
                    continue
                register_source_view(conn, name, path)
                resolved_paths[name] = path
            ca_path = ensure_ca_view_registered(
                conn,
                parquet_dir=_DEFAULT_PARQUET_DIR,
                parquet_paths=parquet_paths,
                expanded_sql=expanded,
            )
            if ca_path:
                resolved_paths["ca_view"] = ca_path
            relation = (
                conn.execute(expanded, bound)
                if bound else conn.execute(expanded)
            )
            cols = [d[0] for d in relation.description]
            fetched = relation.fetchmany(limit + 1)
        finally:
            conn.close()
    except Exception as exc:
        # Surface SQL/runtime errors as 422 so the UI can render them
        # inline as a "fix your CTE" hint rather than a generic crash.
        hint = ""
        if missing_params:
            hint = (
                f" (note: {missing_params} resolved to NULL — supply "
                f"values via the 'parameters' field if your CTE expects them)"
            )
        if not resolved_paths and declared_sources:
            hint += (
                " (note: no parquet file resolved for any declared source — "
                "drop a *.parquet under data/parquet/ or pass parquet_paths "
                "explicitly to register a DuckDB view)"
            )
        raise HTTPException(
            422,
            f"SQL execution failed: {type(exc).__name__}: {exc}{hint}",
        )
    duration_ms = round((time.perf_counter() - t0) * 1000.0, 1)

    truncated = len(fetched) > limit
    rows = [[_jsonable(v) for v in r] for r in fetched[:limit]]
    warnings: List[str] = []
    if missing_params:
        warnings.append(
            f"unbound parameters bound to NULL: {', '.join(missing_params)}"
        )
    if declared_sources and not resolved_paths:
        warnings.append(
            "no parquet auto-resolved for declared sources — drop a "
            "matching file under data/parquet/ or pick one in the UI"
        )
    if truncated:
        warnings.append(
            f"output truncated to {limit} row(s); pass a larger 'limit' "
            f"(max {_PREVIEW_ROW_LIMIT_CAP}) to see more"
        )

    return BlockPreviewResponse(
        template_id=template_id,
        block_id=bid,
        sub_block_id=preview_sub_id,
        kind=exec_block.get("kind") or "",
        sql=sql,
        expanded_sql=expanded,
        columns=cols,
        rows=rows,
        row_count=len(rows),
        truncated=truncated,
        referenced_params=refs,
        bound_params={k: _jsonable(v) for k, v in bound.items()},
        duration_ms=duration_ms,
        warnings=warnings,
        resolved_parquet_paths=resolved_paths,
    )


# ── POST /templates/{template_id}/edit-agent ───────────────────────────────


@reporting_router.post(
    "/templates/{template_id}/edit-agent",
    status_code=202,
    response_model=EditAgentJobStartedResponse,
)
async def start_edit_agent(
    template_id: str,
    body: EditAgentRequest,
) -> EditAgentJobStartedResponse:
    """Start a report-edit-agent session bound to ``template_id``.

    The agent runs in a background thread and emits SSE events through
    the same ``last_event`` / ``events`` channel used by the bootstrap
    and render flows.  The agent's ``stream_callback(event, message,
    data)`` is bridged to the SSE shape ``{step, message, ...data}`` so
    the frontend popup that already speaks bootstrap-events can be
    reused unchanged.

    Tools available inside the agent (block-based catalogue):
        list_blocks • get_block • get_block_html •
        propose_block_definition • set_block_definition • set_subblock_definition •
        preview_block • delete_block • set_template_parameters •
        rescan_template •
        apply_template_html_patch • apply_report_css_patch
    """
    tdir = _template_dir(template_id)
    template_path = tdir / "report-template.html"
    defs_path = tdir / "definitions.yaml"
    if not template_path.is_file():
        raise HTTPException(404, f"Template not found: {template_id}")
    if not (body.query or "").strip():
        raise HTTPException(400, "query is required")

    # Step-by-step authoring: when no definitions.yaml exists yet, seed
    # an empty block-shaped stub so the agent's per-block tools have a
    # coherent target to merge into.  This is the chicken-and-egg
    # unblocker for the "list tagged data-block divs then define them
    # one-by-one via the agent" workflow.
    if not defs_path.is_file():
        stub = {
            "template_id": template_id,
            "version":     0,
            "parameters":  [],
            "sources":     [],
            "blocks":      [],
            "metadata":    {"seeded_by": "edit-agent-endpoint"},
        }
        defs_path.write_text(
            yaml.safe_dump(stub, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        logger.info(
            "Seeded empty definitions.yaml for %r at %s", template_id, defs_path,
        )

    job_id = f"edit-agent-{uuid.uuid4().hex[:12]}"
    session_id = body.session_id or job_id
    job: Dict[str, Any] = {
        "status":      "running",
        "template_id": template_id,
        "session_id":  session_id,
        "query":       body.query,
        "started_at":  time.time(),
        "finished_at": None,
        "error":       None,
        "events":      [],
        "last_event":  None,
        "result":      None,
    }
    _EDIT_AGENT_JOBS[job_id] = job

    def _stream_callback(event: str, message: str, data: Optional[Dict[str, Any]] = None):
        evt: Dict[str, Any] = {
            "step":    event,
            "message": message,
        }
        if data:
            evt.update(data)
        job["events"].append(evt)
        job["last_event"] = evt

    def _run():
        try:
            from flows.report_edit_agent_flow import run_report_edit_agent
            result = run_report_edit_agent(
                query=body.query,
                template_id=template_id,
                session_id=session_id,
                max_iterations=body.max_iterations,
                stream_callback=_stream_callback,
                parquet_paths=body.parquet_paths,
                parquet_cache_dir=body.parquet_cache_dir,
                initial_messages=body.initial_messages,
            )
            # Strip the non-serialisable shared state before persisting it.
            job["result"] = {
                "response":         result.get("response", ""),
                "iterations":       result.get("iterations", 0),
                "definitions_path": result.get("definitions_path"),
                "session_id":       session_id,
            }
            job["status"] = "completed"
        except Exception as exc:
            logger.error(
                "Report edit-agent crashed: job=%s %s", job_id, exc, exc_info=True,
            )
            job["status"] = "failed"
            job["error"] = f"{type(exc).__name__}: {exc}"
        finally:
            job["finished_at"] = time.time()

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run)

    return EditAgentJobStartedResponse(
        job_id=job_id,
        template_id=template_id,
        message=(
            f"Edit-agent started. Stream events at "
            f"/reporting/templates/edit-agent/{job_id}/events"
        ),
    )


# ── GET /templates/edit-agent/{job_id}/events ──────────────────────────────


@reporting_router.get("/templates/edit-agent/{job_id}/events")
async def stream_edit_agent_events(job_id: str):
    """SSE endpoint streaming agent events (thinking, tool_start, tool_result, …)."""
    job = _EDIT_AGENT_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")

    async def event_generator():
        last_idx = 0
        while True:
            events = job.get("events", [])
            while last_idx < len(events):
                evt = events[last_idx]
                last_idx += 1
                yield f"data: {json.dumps(evt, default=str)}\n\n"

            if job["status"] in ("completed", "failed"):
                summary = {
                    "step":    "summary",
                    "status":  job["status"],
                    "error":   job.get("error"),
                    "result":  job.get("result"),
                    "elapsed": round(
                        (job["finished_at"] or time.time()) - job["started_at"], 1
                    ),
                }
                yield f"data: {json.dumps(summary, default=str)}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control":     "no-cache",
            "Connection":        "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


# ── GET /templates/edit-agent/{job_id}/status ──────────────────────────────


@reporting_router.get(
    "/templates/edit-agent/{job_id}/status",
    response_model=JobStatusResponse,
)
async def get_edit_agent_status(job_id: str) -> JobStatusResponse:
    """Polling alternative for an in-flight edit-agent session."""
    job = _EDIT_AGENT_JOBS.get(job_id)
    if not job:
        raise HTTPException(404, f"Job not found: {job_id}")
    return JobStatusResponse(
        job_id=job_id,
        status=job["status"],
        started_at=job.get("started_at"),
        finished_at=job.get("finished_at"),
        error=job.get("error"),
        result=job.get("result"),
        last_event=job.get("last_event"),
    )
