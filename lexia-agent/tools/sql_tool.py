"""
sql_query tool — Execute SQL against parquet files via DuckDB.
"""

from __future__ import annotations

import logging
from typing import Any, Dict

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)


def _handle_sql_query(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Execute a SQL query against cached parquet files."""
    from nodes.dataloader.duckdb_query_node import open_connection, _coerce_paths
    from config import get_settings

    sql = args.get("sql", "").strip()
    if not sql:
        return ToolResult(tool_use_id="", content="No SQL provided.", is_error=True)

    parquet_file = args.get("parquet_file")
    max_rows = args.get("max_rows", 200)

    settings = get_settings()
    cache_dir = getattr(settings, "parquet_cache_dir", None) or "data/parquet"

    conn = open_connection(
        memory_limit="512MB",
        temp_directory="data/.duckdb_tmp",
        max_temp_size="10GB",
    )

    try:
        if parquet_file:
            paths = _coerce_paths(parquet_file)
            for p in paths:
                conn.execute(f"CREATE OR REPLACE VIEW src AS SELECT * FROM read_parquet('{p}')")
        else:
            # Auto-register all parquet files in cache dir
            from pathlib import Path

            cache = Path(cache_dir) if cache_dir else Path("data/parquet")
            for pf in cache.glob("*.parquet"):
                view_name = pf.stem
                conn.execute(
                    f"CREATE OR REPLACE VIEW \"{view_name}\" AS SELECT * FROM read_parquet('{pf}')"
                )

        result = conn.execute(sql)
        columns = [desc[0] for desc in result.description]
        rows = result.fetchmany(max_rows)
        total = len(rows)

        # Store structured results in shared state for chart generation
        row_dicts = [dict(zip(columns, row)) for row in rows]
        sql_entry = {"label": sql[:80], "sql": sql}
        result_entry = {
            "label": sql[:80],
            "columns": columns,
            "rows": row_dicts[:200],
            "row_count": total,
        }
        # Accumulate in context (shared state)
        ctx.setdefault("sql_queries", []).append(sql_entry)
        ctx.setdefault("sql_results", []).append(result_entry)

        # Format as readable text
        lines = [f"Columns: {', '.join(columns)}", f"Rows returned: {total}"]
        for row in rows[:50]:  # Cap text output
            lines.append(" | ".join(str(v) for v in row))
        if total > 50:
            lines.append(f"... ({total - 50} more rows)")

        return ToolResult(tool_use_id="", content="\n".join(lines))

    except Exception as exc:
        logger.warning("sql_query tool error: %s", exc)
        return ToolResult(tool_use_id="", content=f"SQL error: {exc}", is_error=True)
    finally:
        conn.close()


sql_query_tool = Tool(
    name="sql_query",
    description=(
        "Execute a SQL query against cached parquet data files using DuckDB. "
        "Each parquet file is available as a view named after the file stem "
        "(e.g., oracle_env_ca_view.parquet → view 'oracle_env_ca_view'). "
        "IMPORTANT: For categorical columns (marked [CAT]), ALWAYS use exact equality "
        "(WHERE col = 'value') with values from semantic_search or Pre-resolved Column Matches. "
        "NEVER use LIKE or ILIKE on categorical columns — values are exact strings, not patterns."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "sql": {
                "type": "string",
                "description": "The SQL query. Use exact = for categorical columns, never LIKE/ILIKE.",
            },
            "parquet_file": {
                "type": "string",
                "description": "Optional specific parquet file path. If omitted, all cached files are available.",
            },
            "max_rows": {
                "type": "integer",
                "description": "Maximum rows to return (default 200).",
                "default": 200,
            },
        },
        "required": ["sql"],
    },
    handler=_handle_sql_query,
    category="write",
)
