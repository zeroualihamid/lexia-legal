"""ReportSqlBatchNode — execute every validated **block** SQL via DuckDB.

The render pipeline's unit of work is the **block** — each
``<element data-block="<id>">`` of the template carries either inline
``sql:`` or a ``cte_ref:`` pointing to the reusable block-CTE library
at ``data/reporting/sql/fragment_library/``.  ``mixed`` blocks fan out to a list
of leaf sub-CTEs in ``ctes:``.

This node opens **one** DuckDB connection per render, registers each
``sources:`` entry from the definitions as a virtual view, then iterates
through ``shared['validated_blocks']`` running each block's CTE-shaped
SQL with bound parameters.

Routing rules per block ``kind``
────────────────────────────────
* ``scalar``      — 1 row, columns aliased per token (lowercased or via
                    ``mapping:``).  For each token ``T`` declared in the
                    block, ``render_scalars[T] = row[mapping.get(T, T.lower())]``.
* ``section``     — N rows, columns aliased as the inner_tokens of the
                    block's BEGIN: section.  The block's matching
                    ``BlockDescriptor.inner_sections[0]`` resolves the
                    section name.  Each row is converted back to upper
                    case (or via inverse mapping) and pushed into
                    ``render_sections[section_name]``.
* ``condition``   — 1 row, 1 boolean column.  The matching
                    ``BlockDescriptor.inner_conditions[0]`` resolves the
                    flag name.  ``_condition_results[flag] = bool(row[col0])``.
* ``chart_array`` — N rows, 1 ``value`` column.  Stored under
                    ``render_chart_arrays[<chart_name>]`` resolved from
                    the descriptor's ``inner_chart_arrays[0]``.
* ``narrative``   — 1 row, columns = ``grounding_fields:``.  Stored
                    under ``_narrative_inputs[<NARRATIVE:slot>]`` so
                    :class:`NarrativeGenerationNode` can narrate it.
* ``mixed``       — fan out to ``ctes:``; each sub-CTE has its own
                    ``kind``.  By convention, sub-CTE ``id`` equals the
                    structural marker name (section / flag / chart /
                    NARRATIVE:slot or just any id for additional
                    scalars).
* ``empty``       — skipped (no SQL).

Outputs (shared state)
* ``render_scalars[token]      = value``      — for ``kind=scalar``
* ``render_sections[section]   = list[dict]`` — for ``kind=section``
* ``render_chart_arrays[name]  = list``       — for ``kind=chart_array``
* ``_condition_results[flag]   = bool``       — for ``kind=condition``
* ``_narrative_inputs[slot]    = dict``       — for ``kind=narrative``
* ``render_empty_blocks[id]    = value``      — for executable ``kind=empty``
* ``render_data_block_scalars[id] = (token, value)`` — for ``kind=scalar``,
  primary token per block so the renderer can inject into ``data-block``
  when the HTML has no ``{{TOKEN}}`` inside that region.
* ``block_run_reports``        = list[BlockRunReport] — per-block timings.

Inputs (shared state)
* ``validated_blocks``        — list of block dicts (load_definitions).
* ``report_definitions``      — full definitions YAML (sources, params).
* ``template_scan``           — :class:`ScanResult` from
                                 :class:`TemplateScanNode` — needed to
                                 resolve structural marker names.
* ``report_parameters``       — runtime parameter values, dict.
* ``parquet_paths``           — dict[``source_name`` -> filesystem path].
* ``accounting_library_dir``  — ``{{include: <atom>}}`` resolution.
* ``block_library_dir``       — ``cte_ref:`` resolution (and an extra
                                 ``{{include}}`` lookup root).

Optional shared keys
* ``duckdb_memory_limit`` / ``duckdb_temp_directory`` /
  ``duckdb_max_temp_size`` — same knobs as :class:`DuckDBQueryNode`.
"""

from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple

import pandas as pd

from nodes.base_node import BaseNode
from nodes.dataloader.duckdb_query_node import (
    _DEFAULT_MAX_TEMP_SIZE,
    _DEFAULT_MEMORY_LIMIT,
    _DEFAULT_TEMP_DIR,
    open_connection,
)
from nodes.reporting.sql_helpers import (
    default_insurance_merge_library_dirs,
    expand_includes,
    field_param_names,
)
from nodes.reporting.template_scan_node import (
    BlockDescriptor,
    ScanResult,
)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_PARQUET_DIR = _PROJECT_ROOT / "data" / "parquet"


# ── Per-run report ──────────────────────────────────────────────────────────


@dataclass
class BlockRunReport:
    """Outcome of executing one block (or one sub-CTE inside a mixed block)."""
    block_id:    str
    kind:        str
    ok:          bool                  = False
    duration_ms: float                 = 0.0
    row_count:   int                   = 0
    error:       Optional[str]         = None
    bound_params: List[str]            = field(default_factory=list)
    parent_block_id: Optional[str]     = None  # set for mixed sub-CTEs
    target:      Optional[str]         = None  # section / flag / chart name etc.


# ── Helpers ────────────────────────────────────────────────────────────────


def _coerce_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if value is None:
        return False
    if isinstance(value, (int, float)):
        return bool(value)
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "1", "y", "t")
    return bool(value)


def _coerce_chart_array(rows: List[tuple]) -> List[Any]:
    """For ``kind=chart_array`` we project a single ``value`` column over N
    rows; ``rows`` is the list of one-tuples returned by DuckDB.  We unwrap
    the tuple so the renderer gets a flat ``list[Any]``.
    """
    out: List[Any] = []
    for r in rows:
        if isinstance(r, (list, tuple)) and len(r) == 1:
            out.append(r[0])
        else:
            out.append(r)
    return out


def _df_to_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    if df.empty:
        return []
    cleaned = df.where(df.notna(), None)
    return cleaned.to_dict(orient="records")


def _bind_params(
    parameters: Dict[str, Any],
    referenced: List[str],
) -> Dict[str, Any]:
    """Build the keyword-args dict DuckDB expects for ``$name`` parameters."""
    out: Dict[str, Any] = {}
    for name in referenced:
        out[name] = parameters.get(name)
    return out


def _alias_for_token(token: str, mapping: Optional[Dict[str, str]]) -> str:
    """Resolve a DSL token name to the lowercased SQL column alias.

    The validator enforces this exact same convention so the runner's
    column lookup matches the validation contract: ``mapping`` overrides
    win, otherwise the alias is the lowercased token name.
    """
    if mapping and token in mapping:
        return mapping[token]
    return token.lower()


def _inverse_mapping(
    tokens: Sequence[str],
    mapping: Optional[Dict[str, str]],
) -> Dict[str, str]:
    """Build ``{column_alias -> token_name}`` for back-conversion in sections."""
    out: Dict[str, str] = {}
    for t in tokens:
        out[_alias_for_token(t, mapping)] = t
    return out


def _row_keys_to_tokens(
    row: Dict[str, Any],
    tokens: Sequence[str],
    mapping: Optional[Dict[str, str]],
) -> Dict[str, Any]:
    """Convert a row's column-aliased keys back to their DSL token names.

    Unknown columns are surfaced verbatim (capitalised) — they cannot
    feed the renderer but they help debugging.
    """
    inv = _inverse_mapping(tokens, mapping)
    converted: Dict[str, Any] = {}
    for k, v in row.items():
        target = inv.get(k)
        if target is None:
            converted[k.upper()] = v  # fallback: best-effort to match {{TOKEN}} casing
        else:
            converted[target] = v
    return converted


def _defaults_from_definition_parameters(defs: Dict[str, Any]) -> Dict[str, Any]:
    """Turn ``definitions.yaml`` top-level ``parameters[*].default`` into the merge pool.

    Keys are lowercased ``id`` values so they align with
    :func:`~nodes.reporting.sql_helpers.bind_params_case_insensitive` and UI JSON.
    """
    out: Dict[str, Any] = {}
    for p in defs.get("parameters") or []:
        if not isinstance(p, dict):
            continue
        pid = p.get("id")
        if not pid:
            continue
        if "default" not in p:
            continue
        d = p.get("default")
        if d is None:
            continue
        out[str(pid).lower()] = d
    return out


def _index_blocks_by_id(scan: ScanResult) -> Dict[str, BlockDescriptor]:
    return {b.name: b for b in scan.blocks}


def _collect_all_param_refs(
    blocks: List[Dict[str, Any]],
    library_dir: Optional[Path],
    block_library_dir: Optional[Path],
    fragment_lookup: Optional[Callable[[str], Optional[str]]] = None,
) -> List[str]:
    """Union all ``$param`` names referenced across blocks (expanded includes).

    Used to auto-fill ``$prior_period`` / ``$year`` via
    :func:`~nodes.reporting.parquet_resolver.derive_implicit_params`, mirroring
    the reporting API preview route.
    """
    from nodes.reporting.sql_helpers import expand_includes, field_param_names

    extra_libs = [block_library_dir] if block_library_dir else []
    seen: set = set()
    out: List[str] = []

    def add_sql(sql_raw: str) -> None:
        frag = (sql_raw or "").strip()
        if not frag:
            return
        try:
            expanded = expand_includes(
                frag, library_dir,
                extra_library_dirs=extra_libs,
                merge_library_dirs=default_insurance_merge_library_dirs() or None,
                fragment_lookup=fragment_lookup,
            )
        except Exception:
            return
        for name in field_param_names(expanded):
            if name not in seen:
                seen.add(name)
                out.append(name)

    def walk(block: Dict[str, Any]) -> None:
        if not isinstance(block, dict):
            return
        kind = (block.get("kind") or "").strip()
        if kind == "mixed":
            for sub in block.get("ctes") or []:
                if isinstance(sub, dict):
                    walk(sub)
            return
        add_sql(_resolve_block_sql(block, block_library_dir, fragment_lookup))

    for b in blocks:
        walk(b)
    return out


def _resolve_block_sql(
    block: Dict[str, Any],
    block_library_dir: Optional[Path],
    fragment_lookup: Optional[Callable[[str], Optional[str]]] = None,
) -> str:
    """Return the raw SQL string for *block*.

    Resolution order: non-empty inline ``sql:`` wins; then ``cte_ref:`` is
    resolved from the report's pickle CTE graph (``fragment_lookup``); then,
    only as a legacy fallback, from a ``.sql`` file under *block_library_dir*.
    """
    sql_inline = (block.get("sql") or "").strip()
    if sql_inline:
        return sql_inline
    cte_ref = block.get("cte_ref")
    if cte_ref:
        if fragment_lookup is not None:
            found = fragment_lookup(cte_ref)
            if found is not None:
                return found
        if block_library_dir is not None and block_library_dir.is_dir():
            path = block_library_dir / f"{cte_ref}.sql"
            if path.is_file():
                return path.read_text(encoding="utf-8")
        raise RuntimeError(
            f"block {block.get('id')!r} cte_ref={cte_ref!r} not found in the "
            f"report CTE graph (and no legacy fragment file)"
        )
    return ""


# ── PocketFlow node ─────────────────────────────────────────────────────────


class ReportSqlBatchNode(BaseNode):
    """Execute every validated block's SQL and route results to render buckets."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ReportSqlBatch")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        blocks = shared.get("validated_blocks")
        if blocks is None:
            raise ValueError(
                "ReportSqlBatchNode requires 'validated_blocks' in shared "
                "state (run LoadDefinitionsNode or BlockValidateNode first)"
            )
        scan = shared.get("template_scan")
        if scan is None:
            raise ValueError(
                "ReportSqlBatchNode requires 'template_scan' in shared state "
                "(run TemplateScanNode first) so block ids can be resolved "
                "to their inner DSL marker names"
            )

        defs = shared.get("report_definitions") or {}
        sources = defs.get("sources") or []
        rp_raw = shared.get("report_parameters") or {}
        file_defaults = _defaults_from_definition_parameters(defs)
        merged_rp = {**file_defaults, **dict(rp_raw)}
        parquet_paths = shared.get("parquet_paths") or {}
        library_dir_raw = shared.get("accounting_library_dir")
        library_dir: Optional[Path] = (
            Path(library_dir_raw) if library_dir_raw else None
        )
        block_library_dir_raw = shared.get("block_library_dir")
        block_library_dir: Optional[Path] = (
            Path(block_library_dir_raw) if block_library_dir_raw else None
        )

        from nodes.reporting.parquet_resolver import derive_implicit_params
        from services.cte_graph.report_graph import make_fragment_lookup

        fragment_lookup = make_fragment_lookup(shared.get("report_cte_graph"))

        all_refs = _collect_all_param_refs(
            blocks, library_dir, block_library_dir, fragment_lookup,
        )
        parameters = derive_implicit_params(all_refs, merged_rp)

        return {
            "blocks":            blocks,
            "block_descriptors": _index_blocks_by_id(scan),
            "sources":           sources,
            "parameters":        parameters,
            "parquet_paths":     parquet_paths,
            "library_dir":       library_dir,
            "block_library_dir": block_library_dir,
            "fragment_lookup":   fragment_lookup,
            "memory_limit":      shared.get("duckdb_memory_limit",   _DEFAULT_MEMORY_LIMIT),
            "temp_directory":    shared.get("duckdb_temp_directory", _DEFAULT_TEMP_DIR),
            "max_temp_size":     shared.get("duckdb_max_temp_size",  _DEFAULT_MAX_TEMP_SIZE),
            "threads":           shared.get("duckdb_threads"),
        }

    def _register_views(
        self, conn, sources: List[Dict[str, Any]], parquet_paths: Dict[str, str],
    ) -> Dict[str, List[str]]:
        """Register one DuckDB view per declared source.

        Uses :func:`nodes.reporting.parquet_resolver.register_source_view`
        so the resulting view exposes both the original (French) parquet
        columns and the canonical English aliases the accounting CTE
        library (``base_ledger``, …) expects (``account_code``, ``date``,
        ``debit``, ``credit``, ``balance``).
        """
        from nodes.reporting.parquet_resolver import (
            ensure_ca_view_registered,
            register_source_view,
        )

        registered: List[str] = []
        missing:    List[str] = []
        malformed:  List[str] = []

        for src in sources:
            name = src.get("name")
            source_id = src.get("source_id")
            if not name or not source_id:
                self.logger.warning(
                    "skipping malformed source entry: %r (need name + source_id)",
                    src,
                )
                malformed.append(json.dumps(src, default=str))
                continue
            path = parquet_paths.get(name) or parquet_paths.get(source_id)
            if not path:
                self.logger.warning(
                    "no parquet path supplied for source %r (source_id=%s)",
                    name, source_id,
                )
                missing.append(name)
                continue
            try:
                register_source_view(conn, name, path)
            except Exception as exc:
                self.logger.warning(
                    "register_source_view(%s, %s) failed (%s); falling "
                    "back to raw SELECT *",
                    name, path, exc,
                )
                conn.execute(
                    f"CREATE OR REPLACE VIEW {name} AS "
                    f"SELECT * FROM read_parquet('{path}')"
                )
            registered.append(name)

        ca_path = ensure_ca_view_registered(
            conn,
            parquet_dir=_DEFAULT_PARQUET_DIR,
            parquet_paths=parquet_paths,
            expanded_sql=None,
        )
        if ca_path and "ca_view" not in registered:
            registered.append("ca_view")

        return {"registered": registered, "missing": missing, "malformed": malformed}

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        blocks:            List[Dict[str, Any]]     = prep_result["blocks"]
        descriptors:       Dict[str, BlockDescriptor] = prep_result["block_descriptors"]
        sources:           List[Dict[str, Any]]     = prep_result["sources"]
        parameters:        Dict[str, Any]           = dict(
            prep_result["parameters"],
        )
        parquet_paths:     Dict[str, str]           = prep_result["parquet_paths"]
        library_dir:       Optional[Path]           = prep_result["library_dir"]
        block_library_dir: Optional[Path]           = prep_result["block_library_dir"]
        self._fragment_lookup = prep_result.get("fragment_lookup")

        scalars:      Dict[str, Any]                  = {}
        sections:     Dict[str, List[Dict[str, Any]]] = {}
        chart_arrays: Dict[str, List[Any]]            = {}
        conditions:   Dict[str, bool]                 = {}
        narratives:   Dict[str, Dict[str, Any]]       = {}
        empty_blocks: Dict[str, Any]                  = {}
        # Per data-block id: (token_name, raw_value) for HTML injection when the
        # template has no {{TOKEN}} inside that block (see template_render_node).
        data_block_scalars: Dict[str, Tuple[str, Any]] = {}
        reports:      List[BlockRunReport]            = []

        conn = open_connection(
            memory_limit  = prep_result["memory_limit"],
            temp_directory= prep_result["temp_directory"],
            max_temp_size = prep_result["max_temp_size"],
            threads       = prep_result.get("threads"),
        )
        source_report: Dict[str, List[str]] = {
            "registered": [], "missing": [], "malformed": [],
        }
        try:
            source_report = self._register_views(conn, sources, parquet_paths)

            for block in blocks:
                bid = block.get("id") or "<unknown>"
                kind = (block.get("kind") or "").strip()

                if kind == "mixed":
                    self._run_mixed(
                        block, descriptors, conn, parameters,
                        library_dir, block_library_dir,
                        scalars, sections, chart_arrays, conditions, narratives,
                        empty_blocks, data_block_scalars,
                        reports,
                    )
                    continue

                rep = self._run_leaf(
                    block         = block,
                    descriptor    = descriptors.get(bid),
                    parent_block_id = None,
                    conn          = conn,
                    parameters    = parameters,
                    library_dir   = library_dir,
                    block_library_dir = block_library_dir,
                    scalars       = scalars,
                    sections      = sections,
                    chart_arrays  = chart_arrays,
                    conditions    = conditions,
                    narratives    = narratives,
                    empty_blocks  = empty_blocks,
                    data_block_scalars = data_block_scalars,
                )
                reports.append(rep)
        finally:
            conn.close()

        return {
            "render_scalars":      scalars,
            "render_sections":     sections,
            "render_chart_arrays": chart_arrays,
            "_condition_results":  conditions,
            "_narrative_inputs":   narratives,
            "render_empty_blocks": empty_blocks,
            "render_data_block_scalars": data_block_scalars,
            "block_run_reports":   reports,
            "source_report":       source_report,
            "enriched_parameters": parameters,
        }

    def _run_mixed(
        self,
        block: Dict[str, Any],
        descriptors: Dict[str, BlockDescriptor],
        conn,
        parameters: Dict[str, Any],
        library_dir: Optional[Path],
        block_library_dir: Optional[Path],
        scalars: Dict[str, Any],
        sections: Dict[str, List[Dict[str, Any]]],
        chart_arrays: Dict[str, List[Any]],
        conditions: Dict[str, bool],
        narratives: Dict[str, Dict[str, Any]],
        empty_blocks: Dict[str, Any],
        data_block_scalars: Dict[str, Tuple[str, Any]],
        reports: List[BlockRunReport],
    ) -> None:
        """Fan out a mixed block into independent sub-CTE executions."""
        parent_id = block.get("id") or "<unknown>"
        parent_descriptor = descriptors.get(parent_id)
        ctes = block.get("ctes") or []
        for sub in ctes:
            if not isinstance(sub, dict):
                continue
            # Resolve the structural target for each sub-kind by trusting
            # the parent block's BlockDescriptor.  When the parent has at
            # most one structural marker per kind (the validator enforces
            # this for non-mixed shapes), the sub's structural target is
            # unambiguous.  For mixed blocks with multiple structural
            # markers, callers must align ``sub.id`` with the structural
            # marker name — this is the published convention.
            rep = self._run_leaf(
                block         = sub,
                descriptor    = parent_descriptor,
                parent_block_id = parent_id,
                conn          = conn,
                parameters    = parameters,
                library_dir   = library_dir,
                block_library_dir = block_library_dir,
                scalars       = scalars,
                sections      = sections,
                chart_arrays  = chart_arrays,
                conditions    = conditions,
                narratives    = narratives,
                empty_blocks  = empty_blocks,
                data_block_scalars = data_block_scalars,
            )
            reports.append(rep)

    def _run_leaf(
        self,
        block: Dict[str, Any],
        descriptor: Optional[BlockDescriptor],
        parent_block_id: Optional[str],
        conn,
        parameters: Dict[str, Any],
        library_dir: Optional[Path],
        block_library_dir: Optional[Path],
        scalars: Dict[str, Any],
        sections: Dict[str, List[Dict[str, Any]]],
        chart_arrays: Dict[str, List[Any]],
        conditions: Dict[str, bool],
        narratives: Dict[str, Dict[str, Any]],
        empty_blocks: Dict[str, Any],
        data_block_scalars: Dict[str, Tuple[str, Any]],
    ) -> BlockRunReport:
        bid = block.get("id") or "<unknown>"
        kind = (block.get("kind") or "").strip()
        rep = BlockRunReport(
            block_id=bid, kind=kind, parent_block_id=parent_block_id,
        )
        t0 = time.perf_counter()
        try:
            fragment_lookup = getattr(self, "_fragment_lookup", None)
            sql_raw = _resolve_block_sql(block, block_library_dir, fragment_lookup)
            if not sql_raw:
                raise ValueError(
                    f"block {bid!r} has no executable SQL (sql/cte_ref empty)"
                )
            extra_libs = [block_library_dir] if block_library_dir else []
            expanded = expand_includes(
                sql_raw, library_dir,
                extra_library_dirs=extra_libs,
                merge_library_dirs=default_insurance_merge_library_dirs() or None,
                fragment_lookup=fragment_lookup,
            )
            refs = field_param_names(expanded)
            bound = _bind_params(parameters, refs)
            rep.bound_params = list(bound.keys())

            relation = (
                conn.execute(expanded, bound) if bound else conn.execute(expanded)
            )

            tokens = list(block.get("tokens") or [])
            mapping = block.get("mapping") or None

            if kind == "scalar":
                rows = relation.fetchall()
                rep.row_count = len(rows)
                rep.target = ",".join(tokens) or None
                if not rows:
                    self.logger.warning(
                        "scalar block %r returned 0 rows; tokens become None", bid,
                    )
                    for t in tokens:
                        scalars[t] = None
                    if tokens:
                        data_block_scalars[bid] = (tokens[0], None)
                else:
                    cols = [d[0] for d in relation.description]
                    row_dict = dict(zip(cols, rows[0]))
                    for t in tokens:
                        alias = _alias_for_token(t, mapping)
                        scalars[t] = row_dict.get(alias)
                    if tokens:
                        data_block_scalars[bid] = (tokens[0], scalars.get(tokens[0]))

            elif kind == "section":
                section_name = (
                    self._resolve_target(
                        descriptor, "inner_sections", bid, parent_block_id,
                        sub_id=block.get("id"),
                    )
                )
                rep.target = section_name
                df = relation.fetchdf()
                rep.row_count = len(df)
                records = _df_to_records(df)
                # Convert the column-aliased rows back to their DSL token
                # names so the renderer's ``with_row(row)`` push works
                # against ``{{TOKEN}}`` references.
                converted = [
                    _row_keys_to_tokens(r, tokens, mapping) for r in records
                ]
                sections[section_name] = converted

            elif kind == "condition":
                flag_name = (
                    self._resolve_target(
                        descriptor, "inner_conditions", bid, parent_block_id,
                        sub_id=block.get("id"),
                    )
                )
                rep.target = flag_name
                rows = relation.fetchall()
                rep.row_count = len(rows)
                conditions[flag_name] = (
                    _coerce_bool(rows[0][0]) if rows else False
                )

            elif kind == "chart_array":
                chart_name = (
                    self._resolve_target(
                        descriptor, "inner_chart_arrays", bid, parent_block_id,
                        sub_id=block.get("id"),
                    )
                )
                rep.target = chart_name
                rows = relation.fetchall()
                rep.row_count = len(rows)
                chart_arrays[chart_name] = _coerce_chart_array(rows)

            elif kind == "narrative":
                slot_name = (
                    self._resolve_target(
                        descriptor, "inner_narratives", bid, parent_block_id,
                        sub_id=block.get("id"),
                    )
                )
                rep.target = slot_name
                df = relation.fetchdf()
                rep.row_count = len(df)
                records = _df_to_records(df)
                narratives[f"NARRATIVE:{slot_name}"] = (
                    records[0] if records else {}
                )

            elif kind == "empty":
                rows = relation.fetchall()
                rep.row_count = len(rows)
                rep.target = bid
                if not rows:
                    empty_blocks[bid] = None
                else:
                    empty_blocks[bid] = rows[0][0]

            else:
                raise ValueError(f"unhandled kind {kind!r} for block {bid!r}")

            rep.ok = True
        except Exception as e:
            rep.ok = False
            rep.error = f"{type(e).__name__}: {e}"
            self.logger.error(
                "[%s] block SQL execution failed: %s", bid, rep.error,
            )
        finally:
            rep.duration_ms = (time.perf_counter() - t0) * 1000.0
        return rep

    def _resolve_target(
        self,
        descriptor: Optional[BlockDescriptor],
        attr_name: str,
        bid: str,
        parent_block_id: Optional[str],
        *,
        sub_id: Optional[str],
    ) -> str:
        """Resolve the structural marker name for a leaf block.

        Resolution order:

        1. For a sub-CTE inside a mixed block: prefer the sub's ``id`` —
           the published convention is ``sub.id == structural_marker_name``.
        2. Otherwise: read ``descriptor.<attr_name>[0]`` (the parent
           block has at most one structural marker of that kind).
        3. Otherwise: fall back to the block id (last-ditch — this lets
           the renderer surface the value under a clearly-wrong key
           rather than silently dropping it).
        """
        if parent_block_id is not None and sub_id:
            return sub_id
        if descriptor is not None:
            inner: List[str] = getattr(descriptor, attr_name, []) or []
            if inner:
                return inner[0]
        return bid

    def post(
        self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any],
    ) -> str:
        for key in (
            "render_scalars",
            "render_sections",
            "render_chart_arrays",
            "_condition_results",
            "_narrative_inputs",
            "render_empty_blocks",
            "render_data_block_scalars",
        ):
            existing = shared.get(key) or {}
            existing.update(exec_result[key])
            shared[key] = existing

        shared["block_run_reports"] = exec_result["block_run_reports"]

        # Backwards-compat aliases: a few downstream nodes (and tests)
        # still read ``sql_run_reports`` / ``sql_run_summary``.
        shared["sql_run_reports"] = exec_result["block_run_reports"]

        failed = [r for r in exec_result["block_run_reports"] if not r.ok]
        if failed:
            self.logger.warning(
                "%d/%d block SQL execution(s) failed: %s",
                len(failed),
                len(exec_result["block_run_reports"]),
                [r.block_id for r in failed][:10],
            )

        source_report = exec_result.get("source_report") or {
            "registered": [], "missing": [], "malformed": [],
        }
        shared["source_report"] = source_report

        shared["sql_run_summary"] = {
            "total":  len(exec_result["block_run_reports"]),
            "ok":     sum(1 for r in exec_result["block_run_reports"] if r.ok),
            "failed": len(failed),
            "reports": [asdict(r) for r in exec_result["block_run_reports"]],
            "sources_registered": source_report.get("registered", []),
            "sources_missing":    source_report.get("missing", []),
            "sources_malformed":  source_report.get("malformed", []),
        }

        enriched = exec_result.get("enriched_parameters")
        if enriched:
            base_rp = dict(shared.get("report_parameters") or {})
            base_rp.update(enriched)
            shared["report_parameters"] = base_rp
        if source_report.get("missing"):
            self.logger.warning(
                "%d source(s) declared in definitions.yaml have no parquet "
                "path supplied at render time: %s",
                len(source_report["missing"]),
                source_report["missing"],
            )

        self.log_exit("default")
        return "default"
