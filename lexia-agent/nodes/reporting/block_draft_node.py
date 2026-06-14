"""BlockDraftNode — LLM-based draft of a single block in ``definitions.yaml``.

Replaces the legacy per-field :class:`DefinitionDraftNode`.  The unit of
work is a **block** — every ``<element data-block="<name>">…</element>``
region of the template.  Each block carries:

* a goal (``goal``) — short prompt set by the user/UI;
* the inferred ``kind`` (scalar/section/condition/narrative/chart_array
  /mixed/empty) from the scanner;
* the inner DSL inventory (``inner_scalars`` etc.);
* the raw HTML excerpt of the tagged element;
* either inline ``sql:`` (CTE-shaped) OR ``cte_ref:`` (reusable from
  ``data/reporting/sql/fragment_library/``).

Architecture
────────────
The node is *callable for a single block id* — it does NOT iterate a
whole template by itself.  This keeps the flow predictable: callers
choose which block to (re-)draft, the SSE timeline is one event per
attempt, and the YAML is mutated only once.

Inputs (``shared``)
* ``template_id``                — required.
* ``template_scan``              — :class:`ScanResult` (or its dict
                                    form via scan_template_node).
* ``block_id``                   — required block to draft.
* ``block_goal``                 — optional override for the prompt
                                    (defaults to the existing block's
                                    ``goal`` field, or empty string).
* ``existing_block``             — optional dict — if the block already
                                    exists with a non-empty ``sql:`` /
                                    ``cte_ref:`` and the caller does
                                    NOT pass ``force_redraft=True``,
                                    the node short-circuits.
* ``force_redraft``              — bool (default False).
* ``accounting_library_dir``     — optional path.
* ``block_library_dir``          — optional path.
* ``parquet_cache_dir``          — used to build the schema context.

Outputs
* ``drafted_block``              — full block dict, ``status`` set to
                                    ``validated`` on success or
                                    ``invalid`` on failure.
* ``draft_report``               — :class:`BlockDraftReport`.
"""

from __future__ import annotations

import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import yaml

from nodes.base_node import BaseNode
from nodes.reporting.sql_helpers import (
    BlockValidationReport,
    default_insurance_merge_library_dirs,
    validate_block,
)
from nodes.reporting.template_scan_node import (
    BlockDescriptor,
    ScanResult,
)


logger = logging.getLogger(__name__)


# Optional "emit" callback signature — same shape as the embedding-agent flow.
EmitFn = Callable[..., None]


# ── Per-block draft report ─────────────────────────────────────────────────


@dataclass
class BlockDraftReport:
    """Per-block outcome of the drafting attempt loop."""
    block_id:    str
    kind:        str
    ok:          bool                              = False
    attempts:    int                               = 0
    duration_ms: float                             = 0.0
    error:       Optional[str]                     = None
    raw_response: Optional[str]                    = None
    validation:  Optional[BlockValidationReport]   = None
    skipped:     bool                              = False


# ── System prompt ──────────────────────────────────────────────────────────


_SYSTEM_PROMPT = """\
You are an expert in French accounting and DuckDB SQL.  Your job is to
draft a single **block** of a reporting template.  A block is one
``<element data-block="<id>">…</element>`` region of the template HTML.
Every non-mixed block must use EITHER ``sql:`` (for validation drafts only —
persisted YAML stores ``cte_ref`` only) OR ``cte_ref: <name>`` pointing to
``data/reporting/sql/fragment_library/<name>.sql``.

# HARD RULES (the validator will reject your draft if any are violated)

1. Output exactly ONE YAML document inside a single ```yaml … ``` fence.
2. Top-level keys ONLY: id, kind, goal, tokens, mapping (optional),
   grounding_fields (narrative only), depends_on, sql, cte_ref, ctes,
   status.
3. ``id`` MUST equal the block id given to you. ``kind`` MUST equal the
   kind given to you (do not reclassify the block).
4. Set EXACTLY ONE of ``sql:`` or ``cte_ref:`` for non-mixed kinds.
   Mixed blocks set neither at top level and fill ``ctes:`` instead with a list of
   leaf sub-CTEs (each sub uses ``sql:`` or ``cte_ref:``).
   **Prefer** ``cte_ref: rapport_v1__<block_id>`` (adjust prefix to the template id)
   so the query lives in ``sql/fragment_library/``.  Inline ``sql:`` remains valid for
   ``propose_block_definition`` / LLM drafts — operators persist via tools that
   write the ``.sql`` file and drop inline SQL from YAML.
5. Inline ``sql:`` MUST start with ``WITH <name> AS ( … )`` and end with
   a single ``SELECT … FROM <last_cte>``.  No bare SELECT, no DDL/DML.
6. Final projection contract per kind:
     - scalar:      1 row, columns aliased as the lowercased token names
                    (or via ``mapping:`` overrides — every key in mapping
                    MUST appear in ``tokens:``)
     - condition:   1 row, 1 boolean column aliased as the flag name
     - chart_array: N rows, 1 column aliased AS value
     - section:     N rows, columns aliased EXACTLY as the inner_tokens
                    of the BEGIN/END:section (or via ``mapping:``)
     - narrative:   1 row, columns aliased EXACTLY as ``grounding_fields:``
7. Compose the shared accounting library FIRST.  Use
   ``{{include: <name>}}`` for any building block listed in the
   ``# Accounting CTE library`` section below.  Only invent NEW CTEs
   when no library entry fits.
8. Use DuckDB-style named parameters: ``$period``, ``$prior_period``, …
   Do NOT redeclare them — the block runner binds whatever ``$param``
   you reference.
9. **DTO source contract** — when the section ``# TARGET DTO`` is
   present below, your CTE MUST read its base data via
   ``FROM dto_<stem>`` (or ``JOIN dto_<stem>``) and nothing else.
   Do NOT reference parquet paths directly. Do NOT pick a different
   ``dto_*`` source. Set ``depends_on: [dto_<stem>]`` so the renderer
   can stitch the chain.  When TARGET DTO is absent, fall back to the
   accounting library and the schema context below.

{target_dto_section}# Accounting CTE library
{library_index}

# Block-CTE library (referenceable via `cte_ref:`)
{block_library_index}

# Available data sources (DuckDB views you can `FROM`)
{schema_context}

# Examples (persisted shape — query lives in sql/fragment_library only)

```yaml
id: pnl_score_card_global
kind: scalar
goal: |
  Carte principale de fiabilité globale.  Renvoie le score global,
  le niveau et son libellé pour la période courante.
tokens: [SCORE_GLOBAL, SCORE_LEVEL, SCORE_LEVEL_LABEL]
mapping:
  SCORE_LEVEL: level_class
cte_ref: rapport_v1__pnl_score_card_global
```

Pair with ``data/reporting/sql/fragment_library/rapport_v1__pnl_score_card_global.sql``.  For
``propose_block_definition`` you may still output a full ``sql: |`` block instead
of ``cte_ref``; persisting via tools rewrites the file and drops inline SQL.
"""


_USER_PROMPT_TEMPLATE = """\
Draft the block definition described below.

# Block
- id:    {block_id}
- kind:  {kind}
- goal:  {goal}
- inner_scalars:    {inner_scalars}
- inner_sections:   {inner_sections}
- inner_conditions: {inner_conditions}
- inner_narratives: {inner_narratives}
- inner_chart_arrays: {inner_chart_arrays}

# HTML excerpt of the tagged element
```html
{html_excerpt}
```

{retry_block}

Respond with ONE YAML document inside a single ```yaml … ``` fence.
"""


_RETRY_BLOCK_TEMPLATE = """\
# Previous attempt failed validation
Errors:
{errors}

Please fix ALL the errors above and respond again.
"""


# ── Helpers ────────────────────────────────────────────────────────────────


def _read_text(path: Path) -> str:
    if path.is_file():
        try:
            return path.read_text(encoding="utf-8")
        except Exception as e:
            logger.warning("could not read %s: %s", path, e)
    return ""


def _extract_yaml_block(raw: str) -> str:
    """Pull the YAML out of a ```yaml … ``` fence; tolerate plain ```."""
    if not raw:
        return ""
    m = re.search(r"```yaml\s*\n(.*?)```", raw, re.DOTALL | re.IGNORECASE)
    if m:
        return m.group(1).strip()
    m = re.search(r"```\s*\n(.*?)```", raw, re.DOTALL)
    if m:
        return m.group(1).strip()
    return raw.strip()


def _block_descriptor(scan: ScanResult, block_id: str) -> BlockDescriptor:
    for b in scan.blocks:
        if b.name == block_id:
            return b
    raise LookupError(
        f"block_id={block_id!r} is not present in the scanned template "
        f"(no <element data-block={block_id!r}> found). Update the HTML "
        f"or run rescan_template."
    )


def _yaml_to_block(parsed: Any, kind: str, block_id: str) -> Dict[str, Any]:
    """Normalise parser output into the canonical block dict shape."""
    if not isinstance(parsed, dict):
        raise ValueError(
            f"draft for {block_id!r} is not a YAML mapping (got "
            f"{type(parsed).__name__})"
        )
    bd = dict(parsed)
    bd["id"] = block_id
    bd["kind"] = kind
    if "sql" in bd and isinstance(bd["sql"], str):
        bd["sql"] = bd["sql"].strip()
    return bd


def _build_library_index(library_dir: Optional[Path]) -> str:
    if library_dir is None:
        return "(no accounting CTE library configured)"
    index_yaml = library_dir / "index.yaml"
    if not index_yaml.is_file():
        return "(library directory has no index.yaml)"
    try:
        data = yaml.safe_load(index_yaml.read_text(encoding="utf-8")) or {}
        entries = data.get("ctes") or []
        lines = ["Available `{include: …}` building blocks:"]
        for e in entries:
            params = ", ".join(e.get("params") or []) or "no params"
            lines.append(
                f"  - {e['name']:<24}  ({params}) — "
                f"{e.get('description', '').strip()}"
            )
        return "\n".join(lines)
    except Exception as e:
        logger.warning("failed to read accounting CTE library index: %s", e)
        return f"(could not read {index_yaml}: {e})"


def _build_block_library_index(block_library_dir: Optional[Path]) -> str:
    if block_library_dir is None or not block_library_dir.is_dir():
        return "(no block-CTE library configured)"
    index_yaml = block_library_dir / "index.yaml"
    if not index_yaml.is_file():
        return (
            f"(block library at {block_library_dir} has no index.yaml — "
            "no reusable block CTE available)"
        )
    try:
        data = yaml.safe_load(index_yaml.read_text(encoding="utf-8")) or {}
        entries = data.get("ctes") or []
        if not entries:
            return "(block library is empty — define cte_ref candidates first)"
        lines = ["Reference any of these via `cte_ref: <name>`:"]
        for e in entries:
            projects = e.get("projects") or []
            depends = e.get("depends_on") or []
            lines.append(
                f"  - {e['name']:<24} kind={e.get('kind','?'):<10} "
                f"projects={projects} depends_on={depends} — "
                f"{(e.get('description') or '').strip()}"
            )
        return "\n".join(lines)
    except Exception as e:
        logger.warning("failed to read block CTE library index: %s", e)
        return f"(could not read {index_yaml}: {e})"


def _build_formulas(library_dir: Optional[Path]) -> str:
    if library_dir is None:
        return "(no formula reference card configured)"
    formulas = library_dir / "FORMULAS.md"
    text = _read_text(formulas)
    if not text:
        return "(no FORMULAS.md found)"
    # Trim to the first ~80 lines to keep the prompt size reasonable.
    return "\n".join(text.splitlines()[:80])


def _build_schema_context(shared: Dict[str, Any]) -> str:
    """Reuse the same compact-schema builder used by SQLGenerationNode."""
    try:
        from config.settings import settings as pydantic_settings
        from nodes.thinking.sql_generation_node import _build_schema_context as f
        parquet_dir = Path(
            shared.get("parquet_cache_dir")
            or str(pydantic_settings.parquet_cache_dir)
        )
        return f(parquet_dir)
    except Exception as e:
        logger.warning("schema context unavailable: %s", e)
        return "(schema context unavailable)"


def _build_target_dto_section(block_dto: Optional[Dict[str, Any]]) -> str:
    """Build the ``# TARGET DTO`` block injected into the system prompt.

    Returns ``""`` when no DTO was selected — the LLM falls back to
    the generic schema context. When a DTO is selected, the section
    enumerates the columns and pins ``FROM dto_<stem>``.
    """
    if not isinstance(block_dto, dict) or not block_dto.get("dto_cte"):
        return ""
    cols = block_dto.get("columns") or []
    col_lines: List[str] = []
    for c in cols[:80]:
        name = c.get("column_name") or "?"
        ctype = c.get("type") or "string"
        cat = " [categorical]" if c.get("is_categorical") else ""
        desc = (c.get("description") or "").replace("\n", " ").strip()
        if len(desc) > 200:
            desc = desc[:197] + "…"
        col_lines.append(f"  - `{name}` : {ctype}{cat} — {desc}")
    cols_block = "\n".join(col_lines) if col_lines else "  (no columns documented)"
    return (
        "# TARGET DTO (mandatory FROM clause)\n"
        f"This block MUST read from `{block_dto['dto_cte']}` and only that.\n"
        f"Source: `{block_dto.get('parquet_path', '?')}` "
        f"(stem `{block_dto.get('stem', '?')}`).\n"
        f"Columns available on `{block_dto['dto_cte']}`:\n{cols_block}\n\n"
        f"Set `depends_on: [{block_dto['dto_cte']}]` so the renderer can "
        f"stitch the upstream parquet read.\n\n"
    )


def _block_has_executable_sql(block: Optional[Dict[str, Any]]) -> bool:
    if not isinstance(block, dict):
        return False
    if (block.get("sql") or "").strip():
        return True
    if (block.get("cte_ref") or "").strip():
        return True
    if isinstance(block.get("ctes"), list) and block["ctes"]:
        return True
    return False


# ── The node ───────────────────────────────────────────────────────────────


class BlockDraftNode(BaseNode):
    """Draft a YAML block definition (with mandatory CTE) for ONE block id."""

    def __init__(
        self,
        name: Optional[str] = None,
        max_retries: int = 2,
        emit: Optional[EmitFn] = None,
    ):
        super().__init__(name or "BlockDraft")
        self._max_retries = max_retries
        self._emit = emit or (lambda *a, **k: None)

    # ── prep ─────────────────────────────────────────────────────────────

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        scan: Optional[ScanResult] = shared.get("template_scan_obj")
        if scan is None:
            raise ValueError(
                "BlockDraftNode requires 'template_scan_obj' (ScanResult) in "
                "shared state (run TemplateScanNode first)"
            )
        block_id = (shared.get("block_id") or "").strip()
        if not block_id:
            raise ValueError(
                "BlockDraftNode requires 'block_id' in shared state"
            )

        descriptor = _block_descriptor(scan, block_id)

        library_dir_raw = shared.get("accounting_library_dir")
        library_dir: Optional[Path] = (
            Path(library_dir_raw) if library_dir_raw else None
        )
        block_library_dir_raw = shared.get("block_library_dir")
        block_library_dir: Optional[Path] = (
            Path(block_library_dir_raw) if block_library_dir_raw else None
        )

        existing = shared.get("existing_block")
        if isinstance(existing, dict) and existing.get("id") != block_id:
            existing = None  # ignore mismatched payload

        return {
            "scan":                scan,
            "block_id":            block_id,
            "descriptor":          descriptor,
            "kind":                descriptor.kind,
            "goal":                (
                shared.get("block_goal")
                or (existing or {}).get("goal")
                or ""
            ),
            "existing":            existing,
            "force_redraft":       bool(shared.get("force_redraft")),
            "library_dir":         library_dir,
            "block_library_dir":   block_library_dir,
            "library_index":       _build_library_index(library_dir),
            "block_library_index": _build_block_library_index(block_library_dir),
            "formulas":            _build_formulas(library_dir),
            "schema_context":      _build_schema_context(shared),
            # When BlockDtoSelectorNode ran first, it leaves the chosen
            # DTO under shared['block_dto'] — see node module docstring.
            "block_dto":           shared.get("block_dto"),
        }

    # ── exec ─────────────────────────────────────────────────────────────

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        block_id  = prep_result["block_id"]
        kind      = prep_result["kind"]
        existing  = prep_result["existing"]
        force     = prep_result["force_redraft"]

        # Fast path: keep human-edited blocks intact.
        if not force and _block_has_executable_sql(existing):
            self._emit(
                "block_draft_skipped",
                f"{block_id} — preserved (already has SQL)",
                block_id=block_id, kind=kind,
            )
            rep = BlockDraftReport(
                block_id=block_id, kind=kind, ok=True,
                attempts=0, skipped=True,
            )
            return {"block": dict(existing or {}), "report": rep}

        return self._draft_one(block_id, kind, prep_result)

    # ── post ─────────────────────────────────────────────────────────────

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Any,
        exec_result: Dict[str, Any],
    ) -> str:
        shared["drafted_block"] = exec_result["block"]
        shared["draft_report"]  = exec_result["report"]
        action = "default" if exec_result["report"].ok else "invalid"
        self.log_exit(action)
        return action

    # ── private ──────────────────────────────────────────────────────────

    def _draft_one(
        self,
        block_id: str,
        kind: str,
        prep_result: Dict[str, Any],
    ) -> Dict[str, Any]:
        descriptor: BlockDescriptor = prep_result["descriptor"]
        rep = BlockDraftReport(block_id=block_id, kind=kind)
        t0 = time.perf_counter()

        retry_block = ""
        previous_errors: List[str] = []
        last_block: Dict[str, Any] = {}
        last_validation: Optional[BlockValidationReport] = None
        raw_last = ""

        for attempt in range(1, self._max_retries + 2):  # initial + retries
            rep.attempts = attempt
            self._emit(
                "block_draft",
                f"{block_id} — attempt {attempt}",
                block_id=block_id, kind=kind, attempt=attempt,
            )
            try:
                block_dto = prep_result.get("block_dto")
                target_dto_section = _build_target_dto_section(block_dto)
                # When a DTO is pinned, the generic schema dump is redundant
                # and tends to drag the LLM toward unrelated parquets.
                schema_context = (
                    "(constrained by TARGET DTO above)"
                    if target_dto_section
                    else prep_result["schema_context"]
                )
                raw = self._call_llm(
                    system_prompt=_SYSTEM_PROMPT.format(
                        target_dto_section  = target_dto_section,
                        library_index       = prep_result["library_index"],
                        block_library_index = prep_result["block_library_index"],
                        schema_context      = schema_context,
                    ),
                    user_prompt=_USER_PROMPT_TEMPLATE.format(
                        block_id            = block_id,
                        kind                = kind,
                        goal                = prep_result["goal"] or "(no goal set)",
                        inner_scalars       = descriptor.inner_scalars or "—",
                        inner_sections      = descriptor.inner_sections or "—",
                        inner_conditions    = descriptor.inner_conditions or "—",
                        inner_narratives    = descriptor.inner_narratives or "—",
                        inner_chart_arrays  = descriptor.inner_chart_arrays or "—",
                        html_excerpt        = (
                            descriptor.html_excerpt or "(no excerpt)"
                        ),
                        retry_block         = retry_block,
                    ),
                )
                raw_last = raw
                yaml_text = _extract_yaml_block(raw)
                parsed = yaml.safe_load(yaml_text) if yaml_text else None
                last_block = _yaml_to_block(parsed, kind, block_id)
                last_block.setdefault("goal",   prep_result["goal"])
                last_block.setdefault("tokens", list(descriptor.inner_scalars))
                # Pin depends_on to the chosen DTO source CTE — even if the
                # LLM forgot. Renderer relies on this to inline the parquet
                # read ahead of the block CTE.
                if isinstance(block_dto, dict) and block_dto.get("dto_cte"):
                    deps = list(last_block.get("depends_on") or [])
                    if block_dto["dto_cte"] not in deps:
                        deps.insert(0, block_dto["dto_cte"])
                    last_block["depends_on"] = deps

                merge_ins = default_insurance_merge_library_dirs()
                vrep = validate_block(
                    last_block,
                    library_dir       = prep_result["library_dir"],
                    block_library_dir = prep_result["block_library_dir"],
                    merge_library_dirs= merge_ins or None,
                )
                last_validation = vrep
                if vrep.ok:
                    last_block["status"] = "validated"
                    rep.ok = True
                    rep.error = None
                    break

                previous_errors = list(vrep.errors)
                retry_block = _RETRY_BLOCK_TEMPLATE.format(
                    errors="\n".join(f"  - {e}" for e in previous_errors),
                )
                rep.error = "; ".join(previous_errors)

            except Exception as e:
                rep.error = f"{type(e).__name__}: {e}"
                retry_block = _RETRY_BLOCK_TEMPLATE.format(
                    errors=f"  - {rep.error}",
                )

        rep.duration_ms = (time.perf_counter() - t0) * 1000.0
        rep.raw_response = raw_last
        rep.validation = last_validation

        if not rep.ok:
            last_block = last_block or {"id": block_id, "kind": kind}
            last_block["status"] = "invalid"
            last_block.setdefault("goal", prep_result["goal"])
            last_block.setdefault("tokens", list(descriptor.inner_scalars))
            last_block.setdefault("sql", "")
            last_block["draft_errors"] = previous_errors or [rep.error or ""]
            self._emit(
                "block_draft_failed",
                f"{block_id} — invalid after {rep.attempts} attempt(s): "
                f"{rep.error}",
                block_id=block_id, kind=kind,
            )
        else:
            self._emit(
                "block_draft_ok",
                f"{block_id} — OK ({rep.attempts} attempt(s), "
                f"{rep.duration_ms:.0f} ms)",
                block_id=block_id, kind=kind,
            )

        return {"block": last_block, "report": rep}

    def _call_llm(self, system_prompt: str, user_prompt: str) -> str:
        from config import get_settings
        from llm.llm_factory import get_llm
        sync_client, _ = get_llm()
        model = get_settings().llm.model
        response = sync_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
        )
        return response.choices[0].message.content or ""
