"""report_render_flow — execute every block CTE and produce the final HTML.

Pipeline (each step is independently observable via ``emit(step, …)``)

    scan         TemplateScanNode        — parse the HTML DSL
    load         LoadDefinitionsNode     — read definitions.yaml (blocks: [])
    sql_batch    ReportSqlBatchNode      — run every block's CTE; route
                                           results to render_scalars /
                                           render_sections /
                                           render_chart_arrays /
                                           _condition_results /
                                           _narrative_inputs
    conditions   EvaluateConditionsNode  — fold ``kind=condition`` rows
                                           into ``render_flags``
    narratives   NarrativeGenerationNode — LLM over CTE-grounded evidence
                                           (one ``kind=narrative`` block
                                           per ``NARRATIVE:slot``)
    render       TemplateRenderNode      — produce final HTML

Triggered by:
    POST /reporting/templates/{template_id}/render

The flow is **stateless** — each call constructs new node instances.
That makes it trivial to inject test doubles (mocked LLM client, fake
parquet paths) per render.

SSE event surface
─────────────────
Identical shape to ``run_report_bootstrap`` so the existing
``EmbeddingPipelinePopup`` SSE reader can be pointed at this flow with
no protocol change.

    {ts, step, message, **kw}

Where ``step`` is one of:

    resolve | scan | load | sql_batch | conditions |
    narrative_start | narrative_ok | narrative_fallback |
    narrative_failed | render | done | failed
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from nodes.reporting.evaluate_conditions_node import EvaluateConditionsNode
from nodes.reporting.load_definitions_node import LoadDefinitionsNode
from nodes.reporting.narrative_generation_node import NarrativeGenerationNode
from nodes.reporting.sql_batch_node import ReportSqlBatchNode
from nodes.reporting.template_render_node import TemplateRenderNode
from nodes.reporting.template_scan_node import TemplateScanNode

from pocketflow import Flow


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"
_DEFAULT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"
_DEFAULT_PARQUET_DIR = _PROJECT_ROOT / "data" / "parquet"


def _inline_template_assets(template_dir: Path, html: str) -> str:
    """Inline local ``<link rel="stylesheet" href="…">`` files into the HTML.

    Required because the API returns the rendered HTML as a self-contained
    string (typically embedded into an ``<iframe srcDoc=…>``).  In that
    context, relative paths like ``href="report.css"`` resolve against the
    *parent* document's origin and load nothing — the page would render
    completely unstyled.

    For every ``<link rel="stylesheet" href="<relative>">`` whose href is
    a relative file living next to the template, we replace the tag with
    a ``<style>…</style>`` block containing the file contents.  External
    URLs (``http://``, ``https://``, ``//…``) and missing files are left
    intact.
    """
    import re as _re

    if not html:
        return html

    pattern = _re.compile(
        r'<link\b[^>]*\brel\s*=\s*"stylesheet"[^>]*\bhref\s*=\s*"([^"]+)"[^>]*/?>',
        _re.IGNORECASE,
    )

    def _repl(match: "_re.Match[str]") -> str:
        href = match.group(1).strip()
        if not href or href.startswith(("http://", "https://", "//", "data:")):
            return match.group(0)
        # Strip query/fragment for filesystem lookup.
        rel = href.split("?", 1)[0].split("#", 1)[0]
        candidate = (template_dir / rel).resolve()
        try:
            template_dir_resolved = template_dir.resolve()
            candidate.relative_to(template_dir_resolved)
        except (OSError, ValueError):
            return match.group(0)
        if not candidate.is_file():
            return match.group(0)
        try:
            css_text = candidate.read_text(encoding="utf-8")
        except Exception as exc:
            logger.warning("inline css: cannot read %s: %s", candidate, exc)
            return match.group(0)
        return (
            f'<style data-inlined-from="{rel}">\n'
            f'{css_text}\n'
            f'</style>'
        )

    return pattern.sub(_repl, html)


def _autopick_parquet_paths(
    template_dir: Path,
    parameters: Dict[str, Any],
    explicit: Dict[str, str],
) -> Dict[str, str]:
    """Auto-pick ``{source: path}`` for any source the caller didn't supply.

    Reads ``definitions.yaml`` to know which sources the template declares,
    then asks ``parquet_resolver`` to pick a parquet file for each.  When
    ``parameters['period']`` is set, the picker prefers a parquet whose
    date-suffix window overlaps the requested period — so a 2025 render
    binds to ``grand_livre_2025_…`` rather than the 2026 file.
    """
    from nodes.reporting.parquet_resolver import (
        discover_parquet_files,
        pick_default_paths,
    )

    try:
        import yaml as _yaml
        defs_path = template_dir / "definitions.yaml"
        if not defs_path.is_file():
            return dict(explicit or {})
        defs = _yaml.safe_load(defs_path.read_text(encoding="utf-8")) or {}
        sources = defs.get("sources") or []
    except Exception as exc:
        logger.warning("auto-pick: cannot read definitions.yaml: %s", exc)
        return dict(explicit or {})

    if not _DEFAULT_PARQUET_DIR.is_dir():
        return dict(explicit or {})

    discovered = discover_parquet_files(_DEFAULT_PARQUET_DIR)
    period = None
    for k, v in (parameters or {}).items():
        if str(k).lower() == "period" and v:
            period = str(v)
            break

    out: Dict[str, str] = {}
    try:
        out.update(pick_default_paths(sources, discovered, period=period) or {})
    except Exception as exc:
        logger.warning("pick_default_paths failed: %s", exc)
    out.update({k: v for k, v in (explicit or {}).items() if v})
    return out


EmitFn = Callable[..., None]


# ── Flow factory ───────────────────────────────────────────────────────────


def create_report_render_flow(emit: Optional[EmitFn] = None) -> Flow:
    """Build the six-node render pipeline."""
    scan = TemplateScanNode()
    load = LoadDefinitionsNode()
    batch = ReportSqlBatchNode()
    conds = EvaluateConditionsNode()
    narr = NarrativeGenerationNode(emit=emit)
    render = TemplateRenderNode()

    scan >> load >> batch >> conds >> narr >> render
    return Flow(start=scan)


# ── Public runner ──────────────────────────────────────────────────────────


def run_report_render(
    template_id: str,
    *,
    parameters: Optional[Dict[str, Any]] = None,
    parquet_paths: Optional[Dict[str, str]] = None,
    templates_root: Optional[Path] = None,
    library_dir: Optional[Path] = None,
    block_library_dir: Optional[Path] = None,
    pre_supplied_narratives: Optional[Dict[str, str]] = None,
    job: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Render a template end-to-end and return ``{html, missing, ...}``.

    Args:
        template_id: folder name under ``templates_root``.
        parameters: runtime ``$param`` values (``period``, ``CLIENT_NAME`` …).
        parquet_paths: dict[``source_name`` -> filesystem path] used by
            :class:`ReportSqlBatchNode` to register DuckDB views.
        templates_root: optional override.
        library_dir: optional override for the accounting CTE library
            (``{{include: <name>}}`` resolution).
        block_library_dir: optional override for the reusable block CTE
            library (resolves ``cte_ref:`` entries on blocks).
        pre_supplied_narratives: optional dict of ``slot -> html`` to
            inject (skips LLM for those slots — useful for re-renders
            and unit tests).
        job: mutable job dict shared with the API layer for live SSE.
    """
    t0 = time.perf_counter()
    events: List[Dict[str, Any]] = job["events"] if job else []

    def emit(step: str, message: str, **kw):
        evt = {
            "ts":      datetime.now(timezone.utc).isoformat(),
            "step":    step,
            "message": message,
            **kw,
        }
        events.append(evt)
        logger.info("[ReportRender] %s — %s", step, message)
        if job is not None:
            job["last_event"] = evt
            job["events"] = events

    result: Dict[str, Any] = {
        "success":      False,
        "template_id":  template_id,
        "html":         None,
        "missing":      [],
        "duration_ms":  0,
        "error":        None,
    }

    troot = templates_root or _TEMPLATES_ROOT
    template_dir = troot / template_id
    template_path = template_dir / "report-template.html"

    emit("resolve", f"Resolving template {template_id!r}…",
         template_id=template_id, template_dir=str(template_dir))

    if not template_path.is_file():
        msg = f"Template not found: {template_path}"
        emit("failed", msg)
        result["error"] = msg
        return result
    if not (template_dir / "definitions.yaml").is_file():
        msg = (
            f"definitions.yaml not found for {template_id!r} — "
            f"run the bootstrap flow first"
        )
        emit("failed", msg)
        result["error"] = msg
        return result

    library_dir = library_dir or (
        _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    )
    block_library_dir = block_library_dir or (
        _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    )

    # ── pkl-only data contract: index.yaml → ledger parquet + pickle CTE graph
    report_graph = None
    explicit_parquet = dict(parquet_paths or {})
    try:
        from services.cte_graph.report_graph import (
            load_report_graph,
            load_report_index,
            resolve_report_parquet,
        )

        report_index = load_report_index(template_dir)
        if report_index:
            gid = report_index.get("cte_graph")
            if gid:
                report_graph = load_report_graph(str(gid))
                if report_graph is None:
                    emit("resolve", f"index.yaml graph {gid!r} not found in data/cte_graphs")
            ledger = resolve_report_parquet(report_index)
            src_view = report_index.get("source_view")
            if ledger and src_view and not explicit_parquet.get(src_view):
                explicit_parquet[str(src_view)] = str(ledger)
                emit(
                    "resolve",
                    f"Bound ledger from index.yaml: {Path(str(ledger)).name} → view {src_view}",
                )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("report index.yaml resolution failed: %s", exc)

    resolved_parquet_paths = _autopick_parquet_paths(
        template_dir,
        parameters or {},
        explicit_parquet,
    )
    if resolved_parquet_paths != (parquet_paths or {}):
        emit(
            "resolve",
            f"Auto-picked parquet paths for {len(resolved_parquet_paths)} source(s)",
            parquet_paths={k: Path(v).name for k, v in resolved_parquet_paths.items()},
        )

    shared: Dict[str, Any] = {
        "template_id":            template_id,
        "template_path":          str(template_path),
        "templates_root":         str(troot),
        "accounting_library_dir": str(library_dir) if library_dir else None,
        "block_library_dir":      str(block_library_dir) if block_library_dir else None,
        "report_parameters":      dict(parameters or {}),
        "parquet_paths":          resolved_parquet_paths,
        "report_cte_graph":       report_graph,
    }
    if pre_supplied_narratives:
        shared["render_narratives"] = dict(pre_supplied_narratives)

    flow = create_report_render_flow(emit=emit)

    try:
        emit("scan", "Scanning template DSL…")
        flow.run(shared)
    except Exception as e:
        logger.exception("Render pipeline crashed")
        emit("failed", f"Render pipeline crashed: {type(e).__name__}: {e}")
        result["error"] = f"{type(e).__name__}: {e}"
        result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return result

    sql_summary = shared.get("sql_run_summary") or {}
    narr_summary = shared.get("narrative_run_summary") or {}
    rendered_html = shared.get("rendered_html") or ""
    missing = shared.get("rendered_missing") or []

    rendered_html = _inline_template_assets(template_dir, rendered_html)
    sql_errors = [
        {
            "block_id": r.get("block_id") or r.get("field_id"),
            "kind":     r.get("kind"),
            "target":   r.get("target"),
            "error":    r.get("error"),
        }
        for r in sql_summary.get("reports", [])
        if not r.get("ok")
    ]

    emit(
        "sql_batch",
        f"SQL batch: {sql_summary.get('ok', 0)}/{sql_summary.get('total', 0)} "
        f"OK ({sql_summary.get('failed', 0)} failed)",
        **{k: v for k, v in sql_summary.items() if k != "reports"},
    )
    emit(
        "conditions",
        f"Resolved {len(shared.get('render_flags') or {})} render flag(s)",
        flags=list((shared.get("render_flags") or {}).keys()),
        unmatched=shared.get("render_flags_unmatched") or [],
    )
    emit(
        "narratives",
        f"Narratives: {narr_summary.get('ok', 0)} ok, "
        f"{narr_summary.get('fallback', 0)} fallback, "
        f"{narr_summary.get('failed', 0)} failed "
        f"(of {narr_summary.get('total', 0)})",
        **{k: v for k, v in narr_summary.items() if k != "reports"},
    )
    emit(
        "render",
        f"Rendered HTML: {len(rendered_html)} chars, {len(missing)} missing token(s)",
        missing=missing[:20],
    )

    elapsed = round((time.perf_counter() - t0) * 1000.0, 1)
    emit(
        "done",
        f"Render complete in {elapsed/1000:.1f}s",
        elapsed_ms=elapsed,
    )

    emit(
        "inline_css",
        f"Inlined template assets into final HTML ({len(rendered_html)} chars)",
    )

    result.update({
        "success":             True,
        "html":                rendered_html,
        "missing":             missing,
        "sql_errors":          sql_errors,
        "sql_summary":         {
            k: v for k, v in sql_summary.items() if k != "reports"
        },
        "narrative_summary":   {
            k: v for k, v in narr_summary.items() if k != "reports"
        },
        "render_flags":        shared.get("render_flags") or {},
        "duration_ms":         elapsed,
    })
    return result
