"""Reporting tools for the report-edit agent (block-based schema).

These tools let the LLM read, mutate and validate a template's
``definitions.yaml`` through the same native-tool-calling path used by
the data-analysis agent.

Schema model (block-based, see ``data/reporting/SCHEMA.md``)
────────────────────────────────────────────────────────────
The unit of work is the **block** — every ``<element data-block="<name>">``
region of the template HTML.  A block carries:

* ``id``         — snake_case, matches the ``data-block`` attribute.
* ``kind``       — ``scalar`` | ``section`` | ``condition`` | ``narrative``
                   | ``chart_array`` | ``mixed`` | ``empty``.
* ``goal``       — short prompt explaining what the block is for.
* ``tokens``     — declared inner DSL scalars (matched against scanner).
* ``mapping``    — optional ``TOKEN -> column_alias`` overrides.
* either ``sql:`` (CTE-shaped DuckDB query — promoted on persist to a file under
  ``sql/fragment_library/`` so YAML keeps ``cte_ref`` only) or ``cte_ref:`` (same library)
  — exactly one logical SQL source per leaf/sub-CTE.
* ``ctes:`` (mixed only) — list of leaf-kind sub-CTEs.

Key design decisions
────────────────────
* The agent's runner injects ``template_id`` (and ``parquet_paths`` for
  ``preview_block``) into the shared context up-front, so the LLM never
  needs to pass them explicitly — that avoids accidental cross-template
  edits.
* Every mutation goes through :func:`validate_block` BEFORE being
  persisted, so a malformed CTE never reaches disk.
* YAML writes call :class:`DefinitionPersistNode` so each edit appends
  an entry to ``definitions.history.jsonl`` and bumps ``version:``.
  ``apply_template_html_patch`` writes ``report-template.html`` directly
  (no YAML version bump).
* ``preview_block`` runs the block's CTE in DuckDB and returns at most
  five rows so the LLM can self-check before persisting.

Tool catalogue
──────────────
* ``list_blocks(filter?)``       — overview of every block (id, kind,
                                    status, goal preview).
* ``get_block(block_id)``        — full YAML payload of one block.
* ``get_block_html(block_id)``   — raw HTML excerpt of the tagged
                                    element from the template (so the
                                    LLM grounds its draft in the real
                                    structure).
* ``propose_block_definition(...)`` — *dry run* validation of an
                                    LLM-drafted block; never persists.
* ``set_block_definition(block_id, …)`` — atomic write after validation.
* ``set_subblock_definition(block_id, sub_block_id, …)`` — patch ONE sub-CTE
                                    of a ``kind=mixed`` block (rounding /
                                    formatting / per-cell SQL fixes) without
                                    resending the whole ``ctes:`` list.
* ``preview_block(block_id, parameters)`` — execute the block's SQL with
                                    sample params; return up to 5 rows.
* ``delete_block(block_id)``     — mark a block deprecated (preserves
                                    history; never erases SQL).
* ``rescan_template()``          — re-parse the HTML and append
                                    skeleton entries for any newly
                                    tagged ``data-block`` divs.
* ``set_template_parameters(parameters)`` — merge top-level
                                    ``parameters:`` in ``definitions.yaml``
                                    (defaults for ``$param`` binding; use when
                                    the user names literals like a client or year).
* ``apply_template_html_patch(old_text, new_text)`` — replace **one**
                                    unique substring in
                                    ``report-template.html``.  Updating
                                    ``definitions.yaml`` alone never
                                    changes layout or adds DOM regions.
* ``apply_report_css_patch(old_text, new_text)`` — same as HTML patch but for
                                    ``report.css`` (styles inlined at render preview).
* ``set_template_parameters(parameters)`` — upsert top-level ``parameters:``
                                    in ``definitions.yaml`` (``id``, ``type``,
                                    ``default``, ``description``).  Use when the
                                    user gives render-time literals (client name,
                                    year, …) that must persist and flow into
                                    ``$param`` SQL binding.
"""

from __future__ import annotations

import logging
import os
import tempfile
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from llm.base_llm import ToolResult
from nodes.reporting.block_materialize import (
    materialize_block_inline_sql,
    materialize_mixed_sub_inline_sql,
)
from nodes.reporting.definition_persist_node import DefinitionPersistNode
from nodes.reporting.sql_batch_node import _defaults_from_definition_parameters
from nodes.reporting.parquet_resolver import (
    derive_implicit_params,
    discover_parquet_files,
    ensure_ca_view_registered,
    pick_default_paths,
    register_source_view,
)
from nodes.reporting.sql_helpers import (
    BlockValidationReport,
    bind_params_case_insensitive,
    default_insurance_merge_library_dirs,
    expand_includes,
    field_param_names,
    validate_block,
)
from nodes.reporting.template_scan_node import scan_template
from services.tool_registry import Tool, ToolRegistry


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DEFAULT_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"
_DEFAULT_LIBRARY        = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY  = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"
_DEFAULT_PARQUET_DIR    = _PROJECT_ROOT / "data" / "parquet"


# ── Helpers ────────────────────────────────────────────────────────────────


def _template_dir(ctx: Dict[str, Any]) -> Path:
    template_id = ctx.get("template_id")
    if not template_id:
        raise RuntimeError(
            "reporting tool invoked without 'template_id' in context"
        )
    troot = Path(ctx.get("templates_root") or _DEFAULT_TEMPLATES_ROOT)
    return troot / template_id


def _load_definitions(ctx: Dict[str, Any]) -> Dict[str, Any]:
    p = _template_dir(ctx) / "definitions.yaml"
    if not p.is_file():
        raise FileNotFoundError(
            f"definitions.yaml not found for template "
            f"{ctx.get('template_id')!r} (run /bootstrap or /edit-agent first)"
        )
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    if not isinstance(data, dict):
        raise ValueError(f"{p}: not a YAML mapping")
    if "blocks" not in data or not isinstance(data["blocks"], list):
        raise ValueError(
            f"{p}: missing 'blocks' list (per-field schema is no longer "
            f"supported — re-bootstrap the template)"
        )
    return data


def _merge_template_parameters(
    existing: List[Any],
    updates: List[Any],
) -> List[Dict[str, Any]]:
    """Upsert ``parameters`` entries by ``id`` (case-insensitive), preserve order."""
    by_lower: Dict[str, Dict[str, Any]] = {}
    order: List[str] = []
    for p in existing or []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not pid:
            continue
        key = str(pid).lower()
        if key not in by_lower:
            order.append(key)
            by_lower[key] = dict(p)
    for p in updates or []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not pid:
            continue
        key = str(pid).lower()
        if key not in by_lower:
            order.append(key)
            by_lower[key] = {}
        merged = {**by_lower[key], **p}
        merged["id"] = str(p["id"]).strip()
        by_lower[key] = merged
    return [by_lower[k] for k in order]


def _persist(
    ctx: Dict[str, Any],
    definitions: Dict[str, Any],
    *,
    note: str,
) -> Dict[str, Any]:
    """Persist *definitions* via :class:`DefinitionPersistNode`.

    Uses ``persist_mode='replace'`` because the agent's caller has
    already loaded the current YAML, mutated the relevant block and
    expects its update to win.  The bootstrap-style merge logic (which
    preserves any block whose ``status: live``) would otherwise
    silently swallow agent edits.
    """
    shared: Dict[str, Any] = {
        "report_definitions": definitions,
        "template_id":        ctx.get("template_id"),
        "templates_root":     ctx.get("templates_root"),
        "draft_reports":      [],
        "persist_mode":       "replace",
        "agent_note":         note,
    }
    DefinitionPersistNode().run(shared)
    return shared.get("persist_summary") or {}


def _accounting_dir(ctx: Dict[str, Any]) -> Optional[Path]:
    raw = ctx.get("accounting_library_dir")
    if raw:
        return Path(raw)
    return _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None


def _block_library_dir(ctx: Dict[str, Any]) -> Optional[Path]:
    raw = ctx.get("block_library_dir")
    if raw:
        return Path(raw)
    return _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None


def _short_sql_preview(sql: str, max_chars: int = 120) -> str:
    s = " ".join((sql or "").split())
    return (s[: max_chars - 1] + "…") if len(s) > max_chars else s


def _scan_template_html(ctx: Dict[str, Any]):
    """Re-scan the template HTML on demand (cheap pure parser)."""
    html_path = _template_dir(ctx) / "report-template.html"
    if not html_path.is_file():
        raise FileNotFoundError(f"template HTML not found: {html_path}")
    return scan_template(html_path.read_text(encoding="utf-8"))


_TEMPLATE_HTML_MAX_BYTES = 8 * 1024 * 1024   # 8 MiB cap for read/write
_PATCH_SNIPPET_MAX = 512 * 1024              # per old/new argument
_PATCH_SNIPPET_MIN = 8                     # avoid accidental 1-char replaces


def _atomic_write_text(path: Path, text: str) -> None:
    """Write *text* to *path* atomically (temp in same dir → replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _format_validation_errors(rep: BlockValidationReport) -> str:
    return "\n  - " + "\n  - ".join(rep.errors)


# ── list_blocks ────────────────────────────────────────────────────────────


def _handle_list_blocks(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    flt = (args.get("filter") or "").strip().lower()
    rows: List[str] = []
    for b in defs.get("blocks") or []:
        kind = b.get("kind", "?")
        bid = b.get("id", "?")
        status = b.get("status", "?")
        deprecated = " (deprecated)" if b.get("deprecated") else ""
        backing = "cte_ref=" + str(b.get("cte_ref")) if b.get("cte_ref") else (
            "ctes=" + str(len(b.get("ctes") or [])) if (b.get("kind") == "mixed")
            else ("sql" if (b.get("sql") or "").strip() else "—")
        )
        goal = (b.get("goal") or "").strip().replace("\n", " ")[:80]
        line = (
            f"{bid:<32}  kind={kind:<11}  status={status:<10}{deprecated}  "
            f"[{backing}]  {goal}"
        )
        if flt and flt not in line.lower():
            continue
        rows.append(line)

    header = (
        f"# {len(rows)} block(s) in {ctx.get('template_id')!r} "
        f"(v{defs.get('version', '?')})"
    )
    return ToolResult(
        tool_use_id="",
        content="\n".join([header] + rows) if rows else f"{header}\n(no matches)",
    )


list_blocks_tool = Tool(
    name="list_blocks",
    description=(
        "List every block (tagged ``data-block`` div) defined for the "
        "current report template.  Pass an optional case-insensitive "
        "filter substring matched against id / kind / goal."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "filter": {
                "type": "string",
                "description": "Optional substring filter.",
            },
        },
    },
    handler=_handle_list_blocks,
    category="read-only",
)


# ── get_block ──────────────────────────────────────────────────────────────


def _handle_get_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    block_id = (args.get("block_id") or "").strip()
    if not block_id:
        return ToolResult(tool_use_id="", content="block_id is required", is_error=True)
    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    for b in defs.get("blocks") or []:
        if b.get("id") == block_id:
            payload = yaml.safe_dump(
                b, allow_unicode=True, sort_keys=False, width=100,
            )
            header_lines: List[str] = []
            if b.get("kind") == "mixed":
                ctes = b.get("ctes") or []
                if ctes:
                    sub_lines = []
                    for sub in ctes:
                        sid = sub.get("id") or "?"
                        skind = sub.get("kind") or "?"
                        stoks = sub.get("tokens") or []
                        sub_lines.append(
                            f"  - id={sid!r}  kind={skind}  tokens={list(stoks)}"
                        )
                    header_lines.append(
                        f"# Mixed block — {len(ctes)} sub-CTE(s). "
                        "Edit one sub-CTE without rewriting the whole block via "
                        "`set_subblock_definition(block_id, sub_block_id, sql=…)`."
                    )
                    header_lines.extend(sub_lines)
                    header_lines.append("")
            content = ("\n".join(header_lines) + payload) if header_lines else payload
            return ToolResult(tool_use_id="", content=content)
    return ToolResult(
        tool_use_id="",
        content=f"block {block_id!r} not found",
        is_error=True,
    )


get_block_tool = Tool(
    name="get_block",
    description=(
        "Return the full YAML payload of one block (id, kind, goal, "
        "tokens, mapping, status, sql or cte_ref, ctes if mixed)."
    ),
    input_schema={
        "type":       "object",
        "properties": {"block_id": {"type": "string"}},
        "required":   ["block_id"],
    },
    handler=_handle_get_block,
    category="read-only",
)


# ── get_block_html ─────────────────────────────────────────────────────────


def _handle_get_block_html(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    block_id = (args.get("block_id") or "").strip()
    if not block_id:
        return ToolResult(tool_use_id="", content="block_id is required", is_error=True)
    try:
        scan = _scan_template_html(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"scan error: {exc}", is_error=True)

    for b in scan.blocks:
        if b.name == block_id:
            tokens = ", ".join(b.inner_scalars) or "—"
            return ToolResult(
                tool_use_id="",
                content=(
                    f"# block {block_id!r}\n"
                    f"element: {b.element}  kind: {b.kind}  line: {b.line}\n"
                    f"inner scalars:    [{tokens}]\n"
                    f"inner sections:   {b.inner_sections or '—'}\n"
                    f"inner conditions: {b.inner_conditions or '—'}\n"
                    f"inner narratives: {b.inner_narratives or '—'}\n"
                    f"inner chart_arrays: {b.inner_chart_arrays or '—'}\n\n"
                    f"```html\n{b.html_excerpt}\n```"
                ),
            )
    return ToolResult(
        tool_use_id="",
        content=(
            f"block {block_id!r} not found in template HTML "
            f"(no matching <... data-block=...> element)"
        ),
        is_error=True,
    )


get_block_html_tool = Tool(
    name="get_block_html",
    description=(
        "Return the raw HTML excerpt of the tagged ``data-block`` "
        "element matching ``block_id``, plus its inferred kind and the "
        "inner DSL inventory.  Use this BEFORE drafting a block so the "
        "SQL projection actually matches the markup."
    ),
    input_schema={
        "type":       "object",
        "properties": {"block_id": {"type": "string"}},
        "required":   ["block_id"],
    },
    handler=_handle_get_block_html,
    category="read-only",
)


# ── propose_block_definition (dry-run validation) ──────────────────────────


_BLOCK_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "block_id":         {"type": "string"},
        "kind":             {
            "type": "string",
            "enum": [
                "scalar", "section", "condition", "narrative",
                "chart_array", "mixed",
            ],
        },
        "goal":             {"type": "string"},
        "tokens":           {"type": "array", "items": {"type": "string"}},
        "mapping":          {
            "type": "object",
            "additionalProperties": {"type": "string"},
        },
        "grounding_fields": {"type": "array", "items": {"type": "string"}},
        "sql":              {"type": "string"},
        "cte_ref":          {"type": "string"},
        "ctes":             {
            "type": "array",
            "description": "Mixed blocks only — list of leaf sub-CTEs.",
            "items": {"type": "object"},
        },
        "depends_on":       {"type": "array", "items": {"type": "string"}},
    },
    "required": ["block_id", "kind"],
}


def _build_block_from_args(args: Dict[str, Any]) -> Dict[str, Any]:
    """Coerce loosely-typed tool args into a canonical block dict."""
    bd: Dict[str, Any] = {
        "id":     args.get("block_id"),
        "kind":   args.get("kind"),
    }
    for k in (
        "goal", "tokens", "mapping", "grounding_fields",
        "sql", "cte_ref", "ctes", "depends_on",
    ):
        if k in args and args[k] is not None:
            bd[k] = args[k]
    if "sql" in bd and isinstance(bd["sql"], str):
        bd["sql"] = bd["sql"].strip()
    return bd


def _needs_inline_sql_materialization(bd: Dict[str, Any]) -> bool:
    """True if the block carries non-empty inline sql (leaf or mixed sub-CTE)."""
    if (bd.get("sql") or "").strip():
        return True
    if (bd.get("kind") or "").strip() == "mixed":
        for s in bd.get("ctes") or []:
            if isinstance(s, dict) and (s.get("sql") or "").strip():
                return True
    return False


def _handle_propose_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    bd = _build_block_from_args(args)
    if not bd.get("id") or not bd.get("kind"):
        return ToolResult(
            tool_use_id="",
            content="block_id and kind are required",
            is_error=True,
        )

    rep = validate_block(
        bd,
        library_dir       = _accounting_dir(ctx),
        block_library_dir = _block_library_dir(ctx),
        merge_library_dirs= default_insurance_merge_library_dirs() or None,
    )
    parsed = rep.parsed
    aliases = parsed.final_aliases if parsed else []
    params  = parsed.referenced_params if parsed else []
    if rep.ok:
        warning_block = ""
        if rep.warnings:
            warning_block = "\nwarnings:\n  - " + "\n  - ".join(rep.warnings)
        return ToolResult(
            tool_use_id="",
            content=(
                f"OK ({bd['id']!r} would validate).\n"
                f"params bound: {params}\n"
                f"projection:   {aliases}\n"
                f"sub-CTEs:     {[s.block_id for s in rep.sub_reports]}\n"
                f"sql preview:  {_short_sql_preview(bd.get('sql') or '(via cte_ref)')}"
                f"{warning_block}"
            ),
        )
    return ToolResult(
        tool_use_id="",
        content=(
            f"INVALID ({bd['id']!r}). Errors:{_format_validation_errors(rep)}\n\n"
            f"Fix the SQL and call propose_block_definition again before "
            f"set_block_definition."
        ),
        is_error=True,
    )


propose_block_tool = Tool(
    name="propose_block_definition",
    description=(
        "Validate a draft block WITHOUT persisting it.  Use BEFORE "
        "calling set_block_definition to ensure the CTE is well-formed "
        "and the projection contract for the block's kind is respected."
    ),
    input_schema=_BLOCK_INPUT_SCHEMA,
    handler=_handle_propose_block,
    category="read-only",
)


# ── set_block_definition (validate + atomic write) ─────────────────────────


def _handle_set_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    bd = _build_block_from_args(args)
    if not bd.get("id") or not bd.get("kind"):
        return ToolResult(
            tool_use_id="",
            content="block_id and kind are required",
            is_error=True,
        )

    bdir = _block_library_dir(ctx)
    tid = str(ctx.get("template_id") or "template").strip()
    if _needs_inline_sql_materialization(bd):
        if bdir is None or not bdir.is_dir():
            return ToolResult(
                tool_use_id="",
                content=(
                    "Inline sql requires the block library "
                    "(data/reporting/sql/fragment_library/). Configure block_library_dir "
                    "in context."
                ),
                is_error=True,
            )
        bd = materialize_block_inline_sql(
            bd,
            block_library_dir=bdir,
            template_id=tid,
            overwrite=True,
        )

    rep = validate_block(
        bd,
        library_dir       = _accounting_dir(ctx),
        block_library_dir = _block_library_dir(ctx),
        merge_library_dirs= default_insurance_merge_library_dirs() or None,
    )
    if not rep.ok:
        return ToolResult(
            tool_use_id="",
            content=(
                f"VALIDATION FAILED for {bd['id']!r} — refusing to persist."
                f"{_format_validation_errors(rep)}"
            ),
            is_error=True,
        )
    bd["status"] = "live"  # human-promoted via the edit-agent

    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    blocks = list(defs.get("blocks") or [])
    replaced = False
    for i, existing in enumerate(blocks):
        if existing.get("id") == bd["id"]:
            merged = dict(existing)
            merged.update(bd)
            # Validation just succeeded — drop any stale draft noise that
            # was carried over from a previous failed bootstrap/edit so
            # validate_blocks_node doesn't keep flagging the block.
            merged.pop("draft_errors", None)
            merged.pop("draft_warnings", None)
            blocks[i] = merged
            replaced = True
            break
    if not replaced:
        blocks.append(bd)
    defs["blocks"] = blocks

    try:
        summary = _persist(ctx, defs, note=f"agent.set_block {bd['id']}")
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"persist error: {exc}", is_error=True)

    parsed = rep.parsed
    aliases = parsed.final_aliases if parsed else []
    params  = parsed.referenced_params if parsed else []
    action = "updated" if replaced else "created"
    return ToolResult(
        tool_use_id="",
        content=(
            f"{action} {bd['id']!r} (v{summary.get('version', '?')}).\n"
            f"projection: {aliases}\n"
            f"params:     {params}\n"
            f"file:       {summary.get('definitions_path')}"
        ),
    )


set_block_tool = Tool(
    name="set_block_definition",
    description=(
        "Validate AND persist a block (creates it if missing, updates "
        "otherwise).  The persist step bumps version: and appends an "
        "entry to definitions.history.jsonl.  Persist is REFUSED if the "
        "CTE doesn't validate — call propose_block_definition first."
    ),
    input_schema=_BLOCK_INPUT_SCHEMA,
    handler=_handle_set_block,
    category="write",
)


# ── set_subblock_definition (mixed-block sub-CTE edit) ─────────────────────


_SUBBLOCK_INPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "block_id":         {"type": "string"},
        "sub_block_id":     {"type": "string"},
        "kind":             {
            "type": "string",
            "enum": [
                "scalar", "section", "condition", "narrative", "chart_array",
            ],
        },
        "tokens":           {"type": "array", "items": {"type": "string"}},
        "mapping":          {
            "type": "object",
            "additionalProperties": {"type": "string"},
        },
        "grounding_fields": {"type": "array", "items": {"type": "string"}},
        "sql":              {"type": "string"},
        "cte_ref":          {"type": "string"},
    },
    "required": ["block_id", "sub_block_id"],
}


def _handle_set_subblock(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Patch one entry of a mixed block's ``ctes:`` list (atomic write).

    Use case: rounding/formatting one ``AMOUNT`` cell in ``monthly_table``
    without resending all 8 sub-CTEs.  Only the fields supplied are
    overwritten on the targeted sub-CTE; everything else (parent block
    metadata, sibling sub-CTEs) is preserved verbatim.
    """
    block_id     = (args.get("block_id")     or "").strip()
    sub_block_id = (args.get("sub_block_id") or "").strip()
    if not block_id or not sub_block_id:
        return ToolResult(
            tool_use_id="",
            content="block_id and sub_block_id are required",
            is_error=True,
        )

    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    blocks = list(defs.get("blocks") or [])
    parent_idx = next(
        (i for i, b in enumerate(blocks) if b.get("id") == block_id),
        None,
    )
    if parent_idx is None:
        return ToolResult(
            tool_use_id="",
            content=f"block {block_id!r} not found in definitions",
            is_error=True,
        )

    parent = dict(blocks[parent_idx])
    if parent.get("kind") != "mixed":
        return ToolResult(
            tool_use_id="",
            content=(
                f"block {block_id!r} kind={parent.get('kind')!r} is not 'mixed'.  "
                "Use set_block_definition to update non-mixed blocks."
            ),
            is_error=True,
        )

    ctes = list(parent.get("ctes") or [])
    sub_idx = next(
        (i for i, c in enumerate(ctes) if c.get("id") == sub_block_id),
        None,
    )
    if sub_idx is None:
        ids = [c.get("id") for c in ctes]
        return ToolResult(
            tool_use_id="",
            content=(
                f"sub_block_id {sub_block_id!r} not found under {block_id!r} "
                f"(known sub-CTEs: {ids})"
            ),
            is_error=True,
        )

    target = dict(ctes[sub_idx])
    has_sql_arg     = "sql"     in args and args["sql"]     is not None
    has_cte_ref_arg = "cte_ref" in args and args["cte_ref"] is not None
    if has_sql_arg and has_cte_ref_arg:
        return ToolResult(
            tool_use_id="",
            content="set exactly one of sql or cte_ref on the sub-CTE",
            is_error=True,
        )

    for k in ("kind", "tokens", "mapping", "grounding_fields"):
        if k in args and args[k] is not None:
            target[k] = args[k]
    if has_sql_arg:
        target["sql"] = str(args["sql"]).strip()
        target.pop("cte_ref", None)
    if has_cte_ref_arg:
        target["cte_ref"] = args["cte_ref"]
        target.pop("sql", None)
    target["id"] = sub_block_id

    bdir_sub = _block_library_dir(ctx)
    tid_sub = str(ctx.get("template_id") or "template").strip()
    if (target.get("sql") or "").strip():
        if bdir_sub is None or not bdir_sub.is_dir():
            return ToolResult(
                tool_use_id="",
                content=(
                    "Inline sql requires the block library "
                    "(data/reporting/sql/fragment_library/). Configure block_library_dir "
                    "in context."
                ),
                is_error=True,
            )
        target = materialize_mixed_sub_inline_sql(
            target,
            parent_block_id=block_id,
            block_library_dir=bdir_sub,
            template_id=tid_sub,
            overwrite=True,
        )

    ctes[sub_idx] = target
    parent["ctes"] = ctes

    rep = validate_block(
        parent,
        library_dir       = _accounting_dir(ctx),
        block_library_dir = _block_library_dir(ctx),
        merge_library_dirs= default_insurance_merge_library_dirs() or None,
    )
    if not rep.ok:
        return ToolResult(
            tool_use_id="",
            content=(
                f"VALIDATION FAILED for {block_id!r}.{sub_block_id!r} — refusing to persist."
                f"{_format_validation_errors(rep)}"
            ),
            is_error=True,
        )
    parent["status"] = "live"
    parent.pop("draft_errors", None)
    parent.pop("draft_warnings", None)
    blocks[parent_idx] = parent
    defs["blocks"] = blocks

    try:
        summary = _persist(
            ctx, defs, note=f"agent.set_subblock {block_id}.{sub_block_id}",
        )
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"persist error: {exc}", is_error=True)

    sub_report = next(
        (sr for sr in rep.sub_reports if sr.block_id == f"{block_id}.{sub_block_id}"),
        None,
    )
    aliases = sub_report.parsed.final_aliases if (sub_report and sub_report.parsed) else []
    params  = sub_report.parsed.referenced_params if (sub_report and sub_report.parsed) else []
    return ToolResult(
        tool_use_id="",
        content=(
            f"updated sub-CTE {block_id!r}.{sub_block_id!r} "
            f"(v{summary.get('version', '?')}).\n"
            f"projection: {aliases}\n"
            f"params:     {params}\n"
            f"file:       {summary.get('definitions_path')}"
        ),
    )


set_subblock_tool = Tool(
    name="set_subblock_definition",
    description=(
        "Patch ONE sub-CTE inside a mixed block's ``ctes:`` list — far "
        "safer than resending the whole block via set_block_definition.  "
        "Use this for rounding/formatting/SQL fixes that touch a single "
        "scalar/section/condition entry of a mixed block (e.g. one "
        "``AMOUNT`` cell in ``monthly_table``).  Pass only the fields you "
        "want to change (typically just ``sql:``); the rest of the parent "
        "block and sibling sub-CTEs are preserved.  Validation re-runs "
        "the whole parent before persisting."
    ),
    input_schema=_SUBBLOCK_INPUT_SCHEMA,
    handler=_handle_set_subblock,
    category="write",
)


# ── preview_block (execute SQL with sample params) ─────────────────────────


def _resolve_block_sql(
    block: Dict[str, Any], block_library_dir: Optional[Path],
    fragment_lookup=None,
) -> str:
    """Return the SQL string to execute for a block.

    Non-empty inline ``sql:`` wins; then ``cte_ref:`` resolves from the
    report's pickle CTE graph (``fragment_lookup``).
    """
    sql_inline = (block.get("sql") or "").strip()
    if sql_inline:
        return sql_inline
    cte_ref = block.get("cte_ref")
    if cte_ref:
        found = fragment_lookup(cte_ref) if fragment_lookup else None
        if found is not None:
            return found
        raise RuntimeError(
            f"cte_ref={cte_ref!r} not found in the report CTE graph "
            f"(data/cte_graphs/); reports read SQL from the pickle graph only"
        )
    raise RuntimeError(
        f"block {block.get('id')!r} has neither non-empty sql nor cte_ref"
    )


def _report_fragment_lookup(ctx: Dict[str, Any]):
    """``name -> rawSql`` lookup backed by the report template's pickle graph."""
    try:
        from services.cte_graph.report_graph import (
            load_report_graph,
            load_report_index,
            make_fragment_lookup,
        )

        template_dir = _template_dir(ctx)
        index = load_report_index(template_dir) or {}
        gid = index.get("cte_graph")
        graph = load_report_graph(str(gid)) if gid else None
        return make_fragment_lookup(graph)
    except Exception:  # pragma: no cover - defensive
        return lambda _name: None


def _handle_preview_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    block_id = (args.get("block_id") or "").strip()
    if not block_id:
        return ToolResult(tool_use_id="", content="block_id is required", is_error=True)
    parameters = args.get("parameters") or {}
    parquet_paths = args.get("parquet_paths") or ctx.get("parquet_paths") or {}
    if not isinstance(parquet_paths, dict):
        return ToolResult(
            tool_use_id="",
            content="parquet_paths must be an object {source_name: path}",
            is_error=True,
        )

    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    bd = next(
        (b for b in (defs.get("blocks") or []) if b.get("id") == block_id),
        None,
    )
    if bd is None:
        return ToolResult(
            tool_use_id="",
            content=f"block {block_id!r} not found",
            is_error=True,
        )
    preview_sub_id: Optional[str] = None
    exec_bd = bd
    if bd.get("kind") == "mixed":
        sub_raw = str(args.get("sub_block_id") or "").strip()
        if not sub_raw:
            ctes = bd.get("ctes") or []
            ids = [
                str(c.get("id"))
                for c in ctes
                if isinstance(c, dict) and c.get("id")
            ]
            return ToolResult(
                tool_use_id="",
                content=(
                    "mixed block preview requires sub_block_id "
                    f"(one of: {', '.join(ids) or 'no ctes'})"
                ),
                is_error=True,
            )
        ctes = bd.get("ctes") or []
        sub = next(
            (
                c for c in ctes
                if isinstance(c, dict) and str(c.get("id") or "") == sub_raw
            ),
            None,
        )
        if sub is None:
            return ToolResult(
                tool_use_id="",
                content=f"mixed sub-CTE {sub_raw!r} not found under {block_id!r}",
                is_error=True,
            )
        sk = (sub.get("kind") or "").strip()
        if sk == "mixed":
            return ToolResult(
                tool_use_id="",
                content="nested mixed sub-CTE preview is not supported",
                is_error=True,
            )
        if sk == "empty":
            return ToolResult(
                tool_use_id="",
                content=f"sub-CTE {sub_raw!r} is empty",
                is_error=True,
            )
        exec_bd = sub
        preview_sub_id = sub_raw

    accounting = _accounting_dir(ctx)
    blocks_lib = _block_library_dir(ctx)
    extra_libs = [blocks_lib] if blocks_lib else []
    fragment_lookup = _report_fragment_lookup(ctx)
    try:
        sql = _resolve_block_sql(exec_bd, blocks_lib, fragment_lookup)
        expanded = expand_includes(
            sql,
            accounting,
            extra_library_dirs=extra_libs,
            merge_library_dirs=default_insurance_merge_library_dirs() or None,
            fragment_lookup=fragment_lookup,
        )
    except Exception as exc:
        return ToolResult(
            tool_use_id="",
            content=f"include resolution failed: {exc}",
            is_error=True,
        )
    refs = field_param_names(expanded)
    rp_raw = dict(parameters) if isinstance(parameters, dict) else {}
    file_defaults = _defaults_from_definition_parameters(defs)
    merged_rp = {**file_defaults, **rp_raw}
    # Auto-derive ``$prior_period`` / ``$year`` from a single ``$period``
    # so the agent only needs to supply the canonical reporting window.
    enriched_params = derive_implicit_params(refs, merged_rp)
    bound = bind_params_case_insensitive(refs, enriched_params)

    # Resolve parquet paths: explicit override → ctx default → auto-discovery.
    declared_sources = list(defs.get("sources") or [])
    parquet_dir = Path(ctx.get("parquet_dir") or _DEFAULT_PARQUET_DIR)
    auto_paths: Dict[str, str] = {}
    if declared_sources:
        try:
            discovered = discover_parquet_files(parquet_dir)
            auto_paths = pick_default_paths(declared_sources, discovered)
        except Exception as exc:
            logger.warning("parquet auto-discovery failed: %s", exc)

    effective_paths: Dict[str, str] = dict(auto_paths)
    effective_paths.update(parquet_paths or {})
    resolved_paths: Dict[str, str] = {}

    try:
        from nodes.dataloader.duckdb_query_node import open_connection
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
                path = effective_paths.get(name) or effective_paths.get(source_id)
                if not path:
                    continue
                register_source_view(conn, name, path)
                resolved_paths[name] = path
            ca_path = ensure_ca_view_registered(
                conn,
                parquet_dir=parquet_dir,
                parquet_paths=effective_paths,
                expanded_sql=expanded,
            )
            if ca_path:
                resolved_paths["ca_view"] = ca_path
            relation = conn.execute(expanded, bound) if bound else conn.execute(expanded)
            cols = [d[0] for d in relation.description]
            rows = relation.fetchmany(5)
        finally:
            conn.close()
    except Exception as exc:
        return ToolResult(
            tool_use_id="",
            content=f"SQL execution failed: {type(exc).__name__}: {exc}",
            is_error=True,
        )

    lines = [
        f"# preview {block_id!r} ({bd.get('kind')})",
        f"params bound: {sorted(refs)}",
        f"columns:      {cols}",
        f"first {len(rows)} row(s):",
    ]
    if resolved_paths:
        lines.insert(
            1,
            f"sources used: {resolved_paths}",
        )
    for r in rows:
        lines.append("  | ".join(str(v) for v in r))
    return ToolResult(tool_use_id="", content="\n".join(lines))


preview_block_tool = Tool(
    name="preview_block",
    description=(
        "Execute the block's CTE against the registered parquet sources "
        "with the supplied parameters.  Returns up to 5 rows so the "
        "agent can sanity-check the projection BEFORE set_block_definition.  "
        "For kind=mixed pass sub_block_id (one ctes[].id)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "block_id":      {"type": "string"},
            "parameters":    {
                "type":        "object",
                "description": "Map of $param values to bind.",
                "additionalProperties": True,
            },
            "parquet_paths": {
                "type":        "object",
                "description": (
                    "Optional override of {source_name: parquet_path}; "
                    "defaults to ctx['parquet_paths']."
                ),
                "additionalProperties": {"type": "string"},
            },
            "sub_block_id": {
                "type":        "string",
                "description": (
                    "For kind=mixed: id of one ctes[] entry to execute."
                ),
            },
        },
        "required": ["block_id"],
    },
    handler=_handle_preview_block,
    category="read-only",
)


# ── delete_block ───────────────────────────────────────────────────────────


def _handle_delete_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    block_id = (args.get("block_id") or "").strip()
    if not block_id:
        return ToolResult(tool_use_id="", content="block_id is required", is_error=True)

    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    found = False
    for b in defs.get("blocks") or []:
        if b.get("id") == block_id:
            b["deprecated"] = True
            b["status"] = "deprecated"
            found = True
            break
    if not found:
        return ToolResult(
            tool_use_id="",
            content=f"block {block_id!r} not found",
            is_error=True,
        )

    try:
        summary = _persist(ctx, defs, note=f"agent.deprecate {block_id}")
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"persist error: {exc}", is_error=True)

    return ToolResult(
        tool_use_id="",
        content=(
            f"deprecated {block_id!r} (v{summary.get('version', '?')}). "
            f"SQL preserved for history; the renderer will skip it."
        ),
    )


delete_block_tool = Tool(
    name="delete_block",
    description=(
        "Mark a block as deprecated.  The SQL is preserved on disk for "
        "audit history; the renderer will skip it.  Tip: removing the "
        "``data-block`` attribute from the HTML achieves the same on "
        "the next rescan."
    ),
    input_schema={
        "type":       "object",
        "properties": {"block_id": {"type": "string"}},
        "required":   ["block_id"],
    },
    handler=_handle_delete_block,
    category="write",
)


# ── rescan_template (re-parse HTML; append skeleton blocks) ────────────────


def _handle_rescan_template(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    template_id = ctx.get("template_id")
    if not template_id:
        return ToolResult(
            tool_use_id="", content="no template in context", is_error=True,
        )
    try:
        scan = _scan_template_html(ctx)
    except Exception as exc:
        return ToolResult(
            tool_use_id="",
            content=f"rescan failed: {type(exc).__name__}: {exc}",
            is_error=True,
        )
    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)

    by_id = {b.get("id"): b for b in defs.get("blocks") or []}
    scan_ids = {b.name for b in scan.blocks}

    added: List[str] = []
    for b in scan.blocks:
        if b.name in by_id:
            continue
        skeleton = {
            "id":     b.name,
            "goal":   "",
            "kind":   b.kind,
            "tokens": list(b.inner_scalars),
            "status": "draft",
            "sql":    "",
        }
        defs.setdefault("blocks", []).append(skeleton)
        added.append(b.name)

    deprecated: List[str] = []
    for bid, blk in by_id.items():
        if bid not in scan_ids and not blk.get("deprecated"):
            blk["deprecated"] = True
            blk["status"] = "deprecated"
            deprecated.append(bid or "?")

    if not added and not deprecated and not scan.orphans:
        return ToolResult(
            tool_use_id="",
            content=(
                f"rescan: no changes (template still has {len(scan_ids)} "
                f"tagged blocks, no orphans)."
            ),
        )

    try:
        summary = _persist(ctx, defs, note="agent.rescan_template")
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"persist error: {exc}", is_error=True)

    orphan_lines = [
        f"  ⚠ orphan {o.kind}:{o.name} (line {o.line})"
        for o in scan.orphans[:10]
    ]
    return ToolResult(
        tool_use_id="",
        content=(
            f"rescan complete (v{summary.get('version', '?')}).\n"
            f"  blocks total:      {summary.get('blocks_total', '?')}\n"
            f"  blocks added:      {len(added)} ({', '.join(added) or '—'})\n"
            f"  blocks deprecated: {len(deprecated)} ({', '.join(deprecated) or '—'})\n"
            f"  orphan markers:    {len(scan.orphans)}"
            + ("\n" + "\n".join(orphan_lines) if orphan_lines else "")
        ),
    )


rescan_template_tool = Tool(
    name="rescan_template",
    description=(
        "Re-parse the template HTML and reconcile ``definitions.yaml`` "
        "with the current ``data-block`` markers.  New tags become "
        "skeleton blocks ready for drafting; removed tags are flipped "
        "to ``deprecated: true``.  Existing block definitions are "
        "preserved verbatim — never overwritten."
    ),
    input_schema={"type": "object", "properties": {}},
    handler=_handle_rescan_template,
    category="write",
)


# ── apply_template_html_patch (atomic substring replace in HTML) ─────────


def _handle_apply_template_html_patch(
    args: Dict[str, Any], ctx: Dict[str, Any],
) -> ToolResult:
    """Replace *exactly one* occurrence of ``old_text`` in ``report-template.html``."""
    old_text = args.get("old_text")
    new_text = args.get("new_text")
    if old_text is None or new_text is None:
        return ToolResult(
            tool_use_id="",
            content="old_text and new_text are required",
            is_error=True,
        )
    if not isinstance(old_text, str) or not isinstance(new_text, str):
        return ToolResult(
            tool_use_id="",
            content="old_text and new_text must be strings",
            is_error=True,
        )
    if len(old_text) < _PATCH_SNIPPET_MIN:
        return ToolResult(
            tool_use_id="",
            content=(
                f"old_text must be at least {_PATCH_SNIPPET_MIN} characters "
                "so the match is unambiguous — copy a longer unique span "
                "from get_block_html or the template file."
            ),
            is_error=True,
        )
    if len(old_text) > _PATCH_SNIPPET_MAX or len(new_text) > _PATCH_SNIPPET_MAX:
        return ToolResult(
            tool_use_id="",
            content="old_text / new_text exceed maximum length",
            is_error=True,
        )

    html_path = _template_dir(ctx) / "report-template.html"
    if not html_path.is_file():
        return ToolResult(
            tool_use_id="",
            content=f"template HTML not found: {html_path}",
            is_error=True,
        )
    try:
        raw = html_path.read_text(encoding="utf-8")
    except OSError as exc:
        return ToolResult(
            tool_use_id="",
            content=f"read failed: {exc}",
            is_error=True,
        )
    if len(raw.encode("utf-8")) > _TEMPLATE_HTML_MAX_BYTES:
        return ToolResult(
            tool_use_id="",
            content="template HTML file is too large to patch via this tool",
            is_error=True,
        )

    count = raw.count(old_text)
    if count == 0:
        return ToolResult(
            tool_use_id="",
            content=(
                "old_text was not found in report-template.html. "
                "Use get_block_html or re-read the file; check whitespace."
            ),
            is_error=True,
        )
    if count > 1:
        return ToolResult(
            tool_use_id="",
            content=(
                f"old_text matches {count} times; it must be unique. "
                "Include more surrounding HTML in old_text."
            ),
            is_error=True,
        )

    updated = raw.replace(old_text, new_text, 1)
    if len(updated.encode("utf-8")) > _TEMPLATE_HTML_MAX_BYTES:
        return ToolResult(
            tool_use_id="",
            content="patch would make the template file too large; aborting",
            is_error=True,
        )

    try:
        _atomic_write_text(html_path, updated)
    except OSError as exc:
        return ToolResult(
            tool_use_id="",
            content=f"write failed: {exc}",
            is_error=True,
        )

    return ToolResult(
        tool_use_id="",
        content=(
            f"Patched {html_path.name} (unique replace, "
            f"{len(raw)} → {len(updated)} chars). "
            "If you added or renamed data-block tags, call rescan_template next."
        ),
    )


apply_template_html_patch_tool = Tool(
    name="apply_template_html_patch",
    description=(
        "Edit ``report-template.html`` itself: replace **one** occurrence "
        "of ``old_text`` with ``new_text``.  Use this when the user asks "
        "for layout changes, new ``data-block=\"…\"`` regions, or moving "
        "tokens — ``set_block_definition`` only updates ``definitions.yaml`` "
        "and does **not** change the HTML the preview renders.  "
        "``old_text`` must appear exactly once (copy a unique multi-line "
        "snippet from ``get_block_html``).  After inserting new "
        "``data-block`` tags, call ``rescan_template`` then define those blocks."
    ),
    input_schema={
        "type":       "object",
        "properties": {
            "old_text": {
                "type":        "string",
                "description": "Substring that appears exactly once in report-template.html.",
            },
            "new_text": {
                "type":        "string",
                "description": "Replacement text (may differ in length).",
            },
        },
        "required":   ["old_text", "new_text"],
    },
    handler=_handle_apply_template_html_patch,
    category="write",
)


# ── apply_report_css_patch (substring replace in report.css) ───────────────


def _handle_apply_report_css_patch(
    args: Dict[str, Any], ctx: Dict[str, Any],
) -> ToolResult:
    """Replace *exactly one* occurrence of ``old_text`` in ``report.css``."""
    old_text = args.get("old_text")
    new_text = args.get("new_text")
    if old_text is None or new_text is None:
        return ToolResult(
            tool_use_id="",
            content="old_text and new_text are required",
            is_error=True,
        )
    if not isinstance(old_text, str) or not isinstance(new_text, str):
        return ToolResult(
            tool_use_id="",
            content="old_text and new_text must be strings",
            is_error=True,
        )
    if len(old_text) < _PATCH_SNIPPET_MIN:
        return ToolResult(
            tool_use_id="",
            content=(
                f"old_text must be at least {_PATCH_SNIPPET_MIN} characters "
                "so the match is unambiguous."
            ),
            is_error=True,
        )
    if len(old_text) > _PATCH_SNIPPET_MAX or len(new_text) > _PATCH_SNIPPET_MAX:
        return ToolResult(
            tool_use_id="",
            content="old_text / new_text exceed maximum length",
            is_error=True,
        )

    css_path = _template_dir(ctx) / "report.css"
    if not css_path.is_file():
        return ToolResult(
            tool_use_id="",
            content=(
                "report.css does not exist yet; create it via the API "
                "(PUT …/report-css) or add an empty file beside report-template.html."
            ),
            is_error=True,
        )
    try:
        raw = css_path.read_text(encoding="utf-8")
    except OSError as exc:
        return ToolResult(
            tool_use_id="",
            content=f"read failed: {exc}",
            is_error=True,
        )
    if len(raw.encode("utf-8")) > _TEMPLATE_HTML_MAX_BYTES:
        return ToolResult(
            tool_use_id="",
            content="report.css is too large to patch via this tool",
            is_error=True,
        )

    count = raw.count(old_text)
    if count == 0:
        return ToolResult(
            tool_use_id="",
            content=(
                "old_text was not found in report.css. "
                "Check whitespace and copy a longer unique span."
            ),
            is_error=True,
        )
    if count > 1:
        return ToolResult(
            tool_use_id="",
            content=(
                f"old_text matches {count} times; it must be unique. "
                "Include more surrounding CSS in old_text."
            ),
            is_error=True,
        )

    updated = raw.replace(old_text, new_text, 1)
    if len(updated.encode("utf-8")) > _TEMPLATE_HTML_MAX_BYTES:
        return ToolResult(
            tool_use_id="",
            content="patch would make report.css too large; aborting",
            is_error=True,
        )

    try:
        _atomic_write_text(css_path, updated)
    except OSError as exc:
        return ToolResult(
            tool_use_id="",
            content=f"write failed: {exc}",
            is_error=True,
        )

    return ToolResult(
        tool_use_id="",
        content=(
            f"Patched {css_path.name} (unique replace, "
            f"{len(raw)} → {len(updated)} chars)."
        ),
    )


# ── set_template_parameters (top-level render defaults) ─────────────────────


def _handle_set_template_parameters(
    args: Dict[str, Any], ctx: Dict[str, Any],
) -> ToolResult:
    """Merge ``parameters:`` in definitions.yaml (see SCHEMA.md)."""
    raw = args.get("parameters")
    if not isinstance(raw, list) or not raw:
        return ToolResult(
            tool_use_id="",
            content="parameters: a non-empty list of objects with at least id: is required",
            is_error=True,
        )
    for i, p in enumerate(raw):
        if not isinstance(p, dict) or not (p.get("id") or "").strip():
            return ToolResult(
                tool_use_id="",
                content=f"parameters[{i}]: each entry must be a dict with a non-empty id",
                is_error=True,
            )
    try:
        defs = _load_definitions(ctx)
    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"error: {exc}", is_error=True)
    merged = _merge_template_parameters(
        list(defs.get("parameters") or []),
        raw,
    )
    defs["parameters"] = merged
    try:
        summary = _persist(
            ctx, defs, note="agent.set_template_parameters",
        )
    except Exception as exc:
        return ToolResult(
            tool_use_id="",
            content=f"persist error: {exc}",
            is_error=True,
        )
    return ToolResult(
        tool_use_id="",
        content=(
            f"Updated template parameters (v{summary.get('version', '?')}).\n"
            f"ids: {[p.get('id') for p in merged]}\n"
            f"file: {summary.get('definitions_path')}"
        ),
    )


set_template_parameters_tool = Tool(
    name="set_template_parameters",
    description=(
        "Upsert the top-level ``parameters:`` list in ``definitions.yaml`` "
        "(render-time inputs such as CLIENT_NAME, YEAR, PERIOD).  Merges by "
        "``id`` (case-insensitive).  When the user gives a literal (e.g. client "
        "name 'HACD'), persist it here with ``default:`` so it binds to ``$client_name`` "
        "in block SQL and survives re-renders.  Does not validate block CTEs."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "parameters": {
                "type": "array",
                "description": (
                    "Parameter objects; each must include id.  Optional: type, "
                    "default, description (per data/reporting/SCHEMA.md)."
                ),
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {
                            "type": "string",
                            "description": "Uppercase identifier, e.g. CLIENT_NAME",
                        },
                        "type": {
                            "type": "string",
                            "enum": ["string", "int", "float", "date"],
                        },
                        "default": {
                            "description": "Render-time default (string, number, or null).",
                        },
                        "description": {"type": "string"},
                    },
                    "required": ["id"],
                },
            },
        },
        "required": ["parameters"],
    },
    handler=_handle_set_template_parameters,
    category="write",
)


apply_report_css_patch_tool = Tool(
    name="apply_report_css_patch",
    description=(
        "Edit ``report.css`` (inlined into report HTML at render preview time): "
        "replace **one** occurrence of ``old_text`` with ``new_text``.  Use for "
        "typography, tables, `.detail-account`, chart layout, etc. when the user "
        "asks for styling changes that should not live in ``definitions.yaml``."
    ),
    input_schema={
        "type":       "object",
        "properties": {
            "old_text": {
                "type":        "string",
                "description": "Substring that appears exactly once in report.css.",
            },
            "new_text": {
                "type":        "string",
                "description": "Replacement CSS (may differ in length).",
            },
        },
        "required":   ["old_text", "new_text"],
    },
    handler=_handle_apply_report_css_patch,
    category="write",
)


# ── which_dto_for_block (read-only DTO selector wrapper) ───────────────────


def _handle_which_dto_for_block(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    block_id = (args.get("block_id") or "").strip()
    if not block_id:
        return ToolResult(tool_use_id="", content="block_id is required", is_error=True)

    scan = ctx.get("template_scan_obj")
    if scan is None:
        # Re-scan on demand so the tool also works in edit-agent sessions
        # that haven't materialised template_scan_obj yet.
        try:
            from pathlib import Path as _P
            from nodes.reporting.template_scan_node import scan_template
            tdir = _P(ctx.get("templates_root") or "data/reporting/templates")
            html_path = tdir / str(ctx.get("template_id") or "") / "report-template.html"
            if not html_path.is_file():
                return ToolResult(
                    tool_use_id="",
                    content=f"template HTML not found: {html_path}",
                    is_error=True,
                )
            scan = scan_template(html_path.read_text(encoding="utf-8"))
        except Exception as exc:
            return ToolResult(
                tool_use_id="",
                content=f"could not scan template: {exc}",
                is_error=True,
            )

    from nodes.reporting.block_dto_selector_node import BlockDtoSelectorNode

    shared = {
        "template_scan_obj": scan,
        "block_id": block_id,
        "block_goal": args.get("goal") or "",
        "existing_block": None,
    }
    try:
        BlockDtoSelectorNode().run(shared)
    except Exception as exc:
        return ToolResult(
            tool_use_id="",
            content=f"selector failed: {type(exc).__name__}: {exc}",
            is_error=True,
        )

    sel = shared.get("block_dto")
    report = shared.get("block_dto_report") or {}
    if not sel:
        cands = report.get("candidates") or []
        return ToolResult(
            tool_use_id="",
            content=(
                f"No DTO matched for {block_id!r}. "
                f"Top candidates: {cands}. "
                "If a parquet/DTO exists for this block, declare it in "
                "config/datasources.yaml and rerun bootstrap."
            ),
            is_error=False,
        )

    cols_preview = ", ".join(c.get("column_name", "?") for c in (sel.get("columns") or [])[:8])
    return ToolResult(
        tool_use_id="",
        content=(
            f"{block_id} → cte_ref source: `{sel['dto_cte']}` "
            f"(stem `{sel['stem']}`, score={sel.get('score'):.2f}, "
            f"selected via {sel.get('source')}).\n"
            f"FROM clause: `FROM {sel['dto_cte']}`\n"
            f"Columns (first 8): {cols_preview}\n"
            f"Persist with `depends_on: [{sel['dto_cte']}]`."
        ),
    )


which_dto_for_block_tool = Tool(
    name="which_dto_for_block",
    description=(
        "Read-only: identify which `dto_<stem>` source CTE a given "
        "`data-block` should read from. Returns the canonical FROM clause, "
        "available columns, and the depends_on entry to set when "
        "persisting via `set_block_definition`. Use this BEFORE drafting a "
        "block CTE whenever the source is not obvious."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "block_id": {"type": "string", "description": "The data-block id."},
            "goal":     {
                "type": "string",
                "description": "Optional human goal/note for the block "
                               "(boosts the selector's confidence).",
            },
        },
        "required": ["block_id"],
    },
    handler=_handle_which_dto_for_block,
    category="read-only",
)


# ── Registry assembly ──────────────────────────────────────────────────────


REPORTING_TOOLS: List[Tool] = [
    list_blocks_tool,
    get_block_tool,
    get_block_html_tool,
    propose_block_tool,
    set_block_tool,
    set_subblock_tool,
    preview_block_tool,
    delete_block_tool,
    which_dto_for_block_tool,
    rescan_template_tool,
    set_template_parameters_tool,
    apply_template_html_patch_tool,
    apply_report_css_patch_tool,
]


def build_reporting_registry() -> ToolRegistry:
    """Return a fresh :class:`ToolRegistry` with only the reporting tools.

    Kept ISOLATED from the global default registry so the data-analysis
    agent can never accidentally write to ``definitions.yaml`` (and vice
    versa).
    """
    reg = ToolRegistry()
    for t in REPORTING_TOOLS:
        reg.register(t)
    return reg
