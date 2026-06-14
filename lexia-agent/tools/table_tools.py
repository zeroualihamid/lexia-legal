"""
Table inspection tools — list_tables and describe_table.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)


# ── list_tables ──────────────────────────────────────────────────────────────

def _handle_list_tables(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """List all available data sources and their tables."""
    from config import get_settings

    settings = get_settings()
    lines = []
    for src in settings.data_sources:
        if not src.enabled:
            continue
        header = f"Source: {src.source_id} ({src.type})"
        desc = getattr(src, "description", "") or ""
        if desc:
            header += f" — {desc}"
        lines.append(header)

        tables = getattr(src, "tables", None) or []
        if tables:
            for tbl in tables:
                if not getattr(tbl, "enabled", True):
                    continue
                tbl_desc = getattr(tbl, "description", "") or ""
                cache = getattr(tbl, "cache_file", "") or f"{src.source_id}_{tbl.table_id}.parquet"
                lines.append(f"  - {tbl.table_id}: {tbl_desc} (cache: {cache})")
        else:
            cache = getattr(src, "cache_file", "") or f"{src.source_id}.parquet"
            lines.append(f"  (single table, cache: {cache})")

    if not lines:
        return ToolResult(tool_use_id="", content="No data sources configured.")
    return ToolResult(tool_use_id="", content="\n".join(lines))


list_tables_tool = Tool(
    name="list_tables",
    description="List all available data sources and tables with their descriptions and cache file names.",
    input_schema={
        "type": "object",
        "properties": {},
    },
    handler=_handle_list_tables,
    category="read-only",
)


# ── describe_table ───────────────────────────────────────────────────────────

def _handle_describe_table(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Describe columns and schema for a specific table."""
    table_name = args.get("table_name", "").strip()
    if not table_name:
        return ToolResult(tool_use_id="", content="table_name is required.", is_error=True)

    # Try DTO cache first — contains rich column descriptions from DTO modules
    try:
        from flows.dto_cache_flow import get_cached_dto, get_cache_metadata

        dto_entry = get_cached_dto(table_name)
        if dto_entry:
            columns_classes = dto_entry.get("columns_classes")
            file_desc = dto_entry.get("file_description", "")
            meta = get_cache_metadata(table_name)

            lines = [f"## Table: {table_name}"]
            if file_desc:
                lines.append(f"Description: {file_desc}")
            if meta:
                rows = meta.get("row_count")
                if rows:
                    lines.append(f"Rows: {rows:,}")
                date_col = meta.get("date_column")
                if date_col:
                    min_d = meta.get("min_date", "?")
                    max_d = meta.get("max_date", "?")
                    lines.append(f"Date range: {date_col} from {min_d} to {max_d}")

            if columns_classes:
                cols = columns_classes.columns
                lines.append(f"\nColumns ({len(cols)}):")
                cat_cols = []
                for col in cols:
                    cat_tag = " [CAT]" if col.is_categorical else ""
                    line = f"  - {col.column_name} ({col.type}{cat_tag})"
                    if col.description:
                        line += f": {col.description}"
                    lines.append(line)
                    if col.is_categorical:
                        cat_cols.append(col.column_name)

                if cat_cols:
                    lines.append(f"\nCategorical columns — use semantic_search to find exact values,")
                    lines.append(f"then filter with `=` (NEVER LIKE/ILIKE): {', '.join(cat_cols)}")

            return ToolResult(tool_use_id="", content="\n".join(lines))
    except Exception:
        pass

    # Fallback: read parquet metadata
    try:
        import pyarrow.parquet as pq
        from pathlib import Path
        from config import get_settings

        settings = get_settings()
        cache_dir = Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")

        # Try exact match, then fuzzy
        candidates = list(cache_dir.glob(f"{table_name}*.parquet"))
        if not candidates:
            candidates = list(cache_dir.glob("*.parquet"))
            candidates = [c for c in candidates if table_name.lower() in c.stem.lower()]

        if not candidates:
            return ToolResult(tool_use_id="", content=f"No parquet file found for '{table_name}'.", is_error=True)

        pf = pq.ParquetFile(candidates[0])
        schema = pf.schema_arrow
        lines = [
            f"Table: {candidates[0].stem}",
            f"Rows: {pf.metadata.num_rows:,}",
            f"Columns ({pf.metadata.num_columns}):",
        ]
        for i in range(len(schema)):
            f = schema.field(i)
            lines.append(f"  - {f.name} ({f.type})")
        return ToolResult(tool_use_id="", content="\n".join(lines))

    except Exception as exc:
        return ToolResult(tool_use_id="", content=f"Error describing '{table_name}': {exc}", is_error=True)


describe_table_tool = Tool(
    name="describe_table",
    description=(
        "Describe the schema (columns, types, descriptions) for a specific data table. "
        "Provide the table name or parquet file stem."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "table_name": {
                "type": "string",
                "description": "Name of the table or parquet file stem (e.g., 'oracle_env_ca_view').",
            },
        },
        "required": ["table_name"],
    },
    handler=_handle_describe_table,
    category="read-only",
)
