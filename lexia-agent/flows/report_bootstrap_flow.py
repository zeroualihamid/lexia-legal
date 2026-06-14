"""report_bootstrap_flow — one-shot drafting of ``definitions.yaml`` (block schema).

Pipeline (every step emits SSE events through ``emit(step, …)``):

    resolve     — locate the template + load any existing definitions.yaml
    scan        — TemplateScanNode parses HTML DSL into ScanResult
    draft       — BlockDraftNode is invoked once per block discovered by the
                  scanner; results are aggregated into ``report_definitions``
    validate    — BlockValidateNode enforces the per-kind contract
    persist     — DefinitionPersistNode atomically writes the YAML and
                  appends an audit log entry

Triggered by:
    POST /reporting/templates/{template_id}/bootstrap

Mirrors the ``run_embedding_agent`` event surface so the frontend
``EmbeddingPipelinePopup`` SSE pattern can be reused without changes:

    {ts, step, message, **kw}

Where ``step`` is one of:

    resolve | scan | draft_start |
    block_draft | block_draft_ok | block_draft_failed | block_draft_skipped |
    draft_done | validate | persist | done | failed
"""

from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

from nodes.reporting.block_draft_node import BlockDraftNode, BlockDraftReport
from nodes.reporting.block_dto_selector_node import BlockDtoSelectorNode
from nodes.reporting.block_validate_node import BlockValidateNode
from nodes.reporting.definition_persist_node import DefinitionPersistNode
from nodes.reporting.dto_source_generator import generate_all_dto_sources
from nodes.reporting.template_scan_node import TemplateScanNode


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"
_DEFAULT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"


EmitFn = Callable[..., None]


# ── Public flow factory ────────────────────────────────────────────────────


def create_report_bootstrap_flow():
    """Return a sentinel describing the bootstrap pipeline.

    The pipeline can no longer be assembled as a static PocketFlow because
    drafting is now a per-block operation (one ``BlockDraftNode`` invocation
    per discovered block).  ``run_report_bootstrap`` orchestrates these
    invocations directly; this helper exists only so the public API in
    :mod:`flows` keeps its previous shape.
    """
    return {
        "name":        "report_bootstrap_flow",
        "kind":        "manual_orchestration",
        "description": (
            "TemplateScanNode → (BlockDraftNode per block) → "
            "BlockValidateNode → DefinitionPersistNode"
        ),
        "entrypoint":  "run_report_bootstrap",
    }


# ── Public runner ──────────────────────────────────────────────────────────


def run_report_bootstrap(
    template_id: str,
    *,
    templates_root: Optional[Path] = None,
    library_dir: Optional[Path] = None,
    block_library_dir: Optional[Path] = None,
    parquet_cache_dir: Optional[str] = None,
    max_retries: int = 2,
    job: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run the bootstrap pipeline for a single template.

    Args:
        template_id: folder name under ``templates_root``.
        templates_root: optional override (defaults to
            ``data/reporting/templates``).
        library_dir: optional override for the accounting CTE library
            (defaults to ``data/reporting/sql/accounting``).
        block_library_dir: optional override for the reusable block CTE
            library (defaults to ``data/reporting/sql/fragment_library``).
        parquet_cache_dir: forwarded to the schema-context builder.
        max_retries: per-block retry budget passed to ``BlockDraftNode``.
        job: mutable job dict shared with the API layer for live SSE.

    Returns:
        Dict with ``success``, ``template_id``, ``definitions_path``,
        ``persist_summary``, ``draft_errors``, ``validation_summary``,
        ``duration_ms``, and ``error`` (None on success).
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
        logger.info("[ReportBootstrap] %s — %s", step, message)
        if job is not None:
            job["last_event"] = evt
            job["events"] = events

    result: Dict[str, Any] = {
        "success":             False,
        "template_id":         template_id,
        "definitions_path":    None,
        "persist_summary":     None,
        "draft_errors":        [],
        "validation_summary":  None,
        "duration_ms":         0,
        "error":               None,
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

    library_dir = library_dir or (
        _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    )
    block_library_dir = block_library_dir or (
        _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    )

    shared: Dict[str, Any] = {
        "template_id":            template_id,
        "template_path":          str(template_path),
        "templates_root":         str(troot),
        "accounting_library_dir": str(library_dir) if library_dir else None,
        "block_library_dir":      str(block_library_dir) if block_library_dir else None,
    }
    if parquet_cache_dir:
        shared["parquet_cache_dir"] = parquet_cache_dir

    # Pre-load any existing definitions.yaml so we can preserve human-edited
    # blocks (status: live) and pass per-block ``existing_block`` payloads to
    # ``BlockDraftNode`` (which short-circuits when valid SQL is already in
    # place — see ``_block_has_executable_sql``).
    existing_defs: Dict[str, Any] = {}
    existing_path = template_dir / "definitions.yaml"
    if existing_path.is_file():
        try:
            import yaml as _yaml
            existing_defs = _yaml.safe_load(
                existing_path.read_text(encoding="utf-8")
            ) or {}
            emit(
                "resolve",
                f"Found existing definitions.yaml v{existing_defs.get('version', '?')}",
                version=existing_defs.get("version"),
            )
        except Exception as e:  # noqa: BLE001 - best-effort read
            emit("warning", f"could not read existing definitions: {e}")

    existing_blocks_by_id: Dict[str, Dict[str, Any]] = {
        b["id"]: b
        for b in (existing_defs.get("blocks") or [])
        if isinstance(b, dict) and b.get("id")
    }

    # ── 1. Scan the template ──────────────────────────────────────────────
    try:
        emit("scan", "Scanning template DSL…")
        TemplateScanNode().run(shared)
    except Exception as e:
        emit("failed", f"Template scan failed: {type(e).__name__}: {e}")
        result["error"] = f"{type(e).__name__}: {e}"
        result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return result

    scan = shared.get("template_scan")
    if scan is None:
        msg = "Template scan returned no result"
        emit("failed", msg)
        result["error"] = msg
        return result
    # BlockDraftNode reads ``template_scan_obj`` (the raw ScanResult) — keep
    # the same value under both keys so this and the edit-agent flow agree.
    shared["template_scan_obj"] = scan

    blocks = list(scan.blocks)
    emit(
        "scan",
        f"Scan complete: {len(blocks)} blocks, "
        f"{len(scan.orphans)} orphan marker(s)",
        blocks=len(blocks),
        orphans=len(scan.orphans),
        orphan_markers=[
            {"kind": o.kind, "name": o.name, "line": o.line}
            for o in scan.orphans
        ],
    )
    if scan.orphans:
        emit(
            "warning",
            f"{len(scan.orphans)} DSL marker(s) lack a data-block ancestor — "
            "wrap them in <… data-block='…'> before drafting can cover them.",
        )

    # ── 1b. Refresh dto_<stem>.sql source CTEs ───────────────────────────
    # Every drafted block must read from a single dto_<stem> source so the
    # depends_on chain stays explicit. Idempotent: existing files aren't
    # rewritten unless --overwrite was passed by the operator.
    parquet_dir = Path(parquet_cache_dir or _PROJECT_ROOT / "data" / "parquet")
    if block_library_dir is not None:
        try:
            dto_written = generate_all_dto_sources(
                parquet_dir=parquet_dir,
                block_library_dir=Path(block_library_dir),
                overwrite=False,
            )
            emit(
                "dto_sources",
                f"DTO source CTEs ready ({len(dto_written)} new)",
                count=len(dto_written),
                names=dto_written,
            )
        except Exception as exc:  # noqa: BLE001 - never crash bootstrap on this
            emit("warning", f"dto source generation failed: {exc}")
            logger.warning("dto source generation failed", exc_info=True)

    # ── 2. Draft every block ──────────────────────────────────────────────
    drafted_blocks: List[Dict[str, Any]] = []
    draft_reports: List[BlockDraftReport] = []
    draft_errors:  List[Dict[str, Any]]   = []

    emit("draft_start", f"Drafting {len(blocks)} block(s)…", total=len(blocks))

    draft_node = BlockDraftNode(max_retries=max_retries, emit=emit)
    selector_node = BlockDtoSelectorNode()

    for idx, descriptor in enumerate(blocks, 1):
        block_id = descriptor.name
        existing_block = existing_blocks_by_id.get(block_id)

        # Per-iteration shared keys consumed by BlockDraftNode.prep().
        shared["block_id"]       = block_id
        shared["existing_block"] = existing_block
        shared.pop("drafted_block", None)
        shared.pop("draft_report", None)
        shared.pop("block_dto", None)
        shared.pop("block_dto_report", None)
        shared["force_redraft"]  = False

        # 2a. Pick the DTO source CTE this block must read from. The
        # selector emits a per-block diagnostic event so the playground
        # can show which dto_<stem> the agent landed on.
        try:
            selector_node.run(shared)
            sel = shared.get("block_dto")
            if sel:
                emit(
                    "block_dto",
                    f"[{idx}/{len(blocks)}] {block_id} → {sel['dto_cte']} "
                    f"({sel.get('source')}, score={sel.get('score'):.2f})",
                    block_id=block_id,
                    dto_cte=sel.get("dto_cte"),
                    dto_stem=sel.get("stem"),
                    source=sel.get("source"),
                    score=sel.get("score"),
                )
            else:
                emit(
                    "warning",
                    f"[{idx}/{len(blocks)}] {block_id} — no DTO selected; "
                    "block will draft without TARGET DTO constraint",
                    block_id=block_id,
                )
        except Exception as exc:  # noqa: BLE001 - selector must not break bootstrap
            emit(
                "warning",
                f"[{idx}/{len(blocks)}] {block_id} — DTO selector failed: {exc}",
                block_id=block_id, error=str(exc),
            )

        try:
            draft_node.run(shared)
        except Exception as e:  # noqa: BLE001 - we collect, never crash
            err = f"{type(e).__name__}: {e}"
            emit(
                "block_draft_failed",
                f"[{idx}/{len(blocks)}] {block_id} — crashed: {err}",
                block_id=block_id, kind=descriptor.kind, error=err,
            )
            draft_errors.append({"block_id": block_id, "error": err})
            drafted_blocks.append({
                "id":     block_id,
                "kind":   descriptor.kind,
                "tokens": list(descriptor.inner_scalars),
                "status": "invalid",
                "draft_errors": [err],
            })
            continue

        block_payload = shared.get("drafted_block") or {}
        report = shared.get("draft_report")
        if isinstance(report, BlockDraftReport):
            draft_reports.append(report)
            if not report.ok:
                draft_errors.append({
                    "block_id": block_id,
                    "error": report.error or "draft failed",
                })

        # Always include the block (even invalid ones) so the validator and
        # the persist step see the full inventory.
        drafted_blocks.append(block_payload or {
            "id":     block_id,
            "kind":   descriptor.kind,
            "tokens": list(descriptor.inner_scalars),
            "status": "invalid",
            "draft_errors": ["no draft produced"],
        })

    emit(
        "draft_done",
        f"Drafting finished: {sum(1 for r in draft_reports if r.ok)} OK, "
        f"{sum(1 for r in draft_reports if not r.ok)} failed",
        ok=sum(1 for r in draft_reports if r.ok),
        failed=sum(1 for r in draft_reports if not r.ok),
        skipped=sum(1 for r in draft_reports if r.skipped),
    )

    # ── 2b. Materialize inline SQL → fragment_library/<ref>.sql ─────────────────
    # The persisted definitions.yaml must never carry inline ``sql:`` (per
    # SCHEMA invariant — see report_edit_agent_flow rule 1). Drafting
    # produces inline SQL; this step writes each block's SQL to the
    # block-CTE library and replaces ``sql:`` with ``cte_ref:`` on the
    # in-memory block dicts so DefinitionPersistNode writes the canonical
    # shape.
    if block_library_dir is not None:
        from nodes.reporting.block_materialize import materialize_all_blocks
        try:
            drafted_blocks = materialize_all_blocks(
                drafted_blocks,
                block_library_dir=Path(block_library_dir),
                template_id=template_id,
                overwrite=True,
            )
            files_written = sum(
                1 for b in drafted_blocks
                if isinstance(b, dict) and (b.get("cte_ref") or b.get("ctes"))
            )
            emit(
                "materialize",
                f"Materialized {files_written} block CTE file(s) under "
                f"{block_library_dir}",
                files_written=files_written,
                block_library_dir=str(block_library_dir),
            )
        except Exception as e:  # noqa: BLE001 - keep going so the YAML still persists
            emit(
                "warning",
                f"materialization failed: {type(e).__name__}: {e} — "
                "definitions.yaml will retain inline sql for affected blocks",
            )
            logger.warning("bootstrap materialization failed: %s", e, exc_info=True)
    else:
        emit(
            "warning",
            "block_library_dir is not configured — drafted blocks keep "
            "inline sql in definitions.yaml (no CTE files will be written)",
        )

    # ── 3. Stage the in-memory definitions for validation + persist ───────
    parameters = list(existing_defs.get("parameters") or [])
    sources    = list(existing_defs.get("sources") or [])
    metadata   = dict(existing_defs.get("metadata") or {})

    shared["report_definitions"] = {
        "template_id": template_id,
        "version":     int(existing_defs.get("version") or 0),
        "parameters":  parameters,
        "sources":     sources,
        "blocks":      drafted_blocks,
        "metadata":    metadata,
    }
    shared["draft_reports"] = draft_reports

    # ── 4. Validate every block ────────────────────────────────────────────
    try:
        BlockValidateNode(strict=False).run(shared)
    except Exception as e:
        emit("failed", f"Block validation crashed: {type(e).__name__}: {e}")
        result["error"] = f"{type(e).__name__}: {e}"
        result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return result

    val_summary = shared.get("block_validation_summary") or {}
    emit(
        "validate",
        (f"Validation: {val_summary.get('valid', 0)} valid, "
         f"{val_summary.get('invalid', 0)} invalid"),
        **{k: v for k, v in val_summary.items() if k != "reports"},
    )

    # ── 5. Persist ─────────────────────────────────────────────────────────
    try:
        DefinitionPersistNode(templates_root=troot).run(shared)
    except Exception as e:
        emit("failed", f"Persist crashed: {type(e).__name__}: {e}")
        result["error"] = f"{type(e).__name__}: {e}"
        result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return result

    summary = shared.get("persist_summary") or {}
    emit(
        "persist",
        (f"Persisted v{summary.get('version', '?')} to "
         f"{summary.get('definitions_path', '?')}"),
        **summary,
    )

    elapsed = round((time.perf_counter() - t0) * 1000.0, 1)
    emit(
        "done",
        f"Bootstrap complete in {elapsed/1000:.1f}s — "
        f"{summary.get('blocks_total', 0)} block(s), "
        f"{val_summary.get('invalid', 0)} invalid",
        elapsed_ms=elapsed,
    )

    success = (
        not draft_errors
        and val_summary.get("invalid", 0) == 0
    )
    result.update({
        "success":             success,
        "definitions_path":    summary.get("definitions_path"),
        "persist_summary":     summary,
        "draft_errors":        draft_errors,
        "validation_summary":  val_summary,
        "duration_ms":         elapsed,
    })
    return result
