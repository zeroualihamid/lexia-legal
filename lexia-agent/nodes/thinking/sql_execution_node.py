"""
SQLExecutionNode — Execute DuckDB SQL queries and return structured results.

Reads ``sql_queries`` from shared state (as produced by ``SQLGenerationNode``),
opens a DuckDB connection, executes each query, and writes the results back.

This node is designed to sit right after ``SQLGenerationNode`` in a flow:
    SQLGenerationNode >> SQLExecutionNode

Shared-state contract:
──────────────────────────────────────────────
  Required inputs:
      sql_queries        (list[dict]) — query descriptors with at least ``sql`` key.
                                        Optional: ``parquet``, ``alias``, ``params``,
                                        ``fetch``, ``label``.

  Optional inputs:
      duckdb_memory_limit     (str)  — e.g. "512MB" (default)
      duckdb_temp_directory   (str)  — spill dir  (default "data/.duckdb_tmp")
      duckdb_max_temp_size    (str)  — spill cap  (default "10GB")
      duckdb_threads          (int)  — worker threads
      sql_max_rows            (int)  — cap rows per query result (default 500)

  Outputs:
      sql_results            (list[dict]) — one per query:
                               { label, sql, columns, rows, row_count, truncated, error? }
      sql_results_summary    (str) — human-readable summary of all results
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb
import pandas as pd

from nodes.base_node import BaseNode
from nodes.dataloader.duckdb_query_node import open_connection, _coerce_paths
from nodes.thinking.live_sql_execution_node import execute_live_sql
from monitoring.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_MAX_ROWS = 500


class SQLExecutionNode(BaseNode):
    """Execute SQL queries via DuckDB and return structured results.

    Parameters:
        max_rows: Maximum number of rows to return per query (prevents OOM on large results).
    """

    def __init__(self, name: Optional[str] = None, max_rows: int = _DEFAULT_MAX_ROWS):
        super().__init__(name or "SQLExecution")
        self._max_rows = max_rows

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        queries = shared.get("sql_queries")
        if not queries:
            raise ValueError("SQLExecutionNode requires 'sql_queries' in shared state")

        max_rows = shared.get("sql_max_rows", self._max_rows)

        return {
            "queries": queries,
            "max_rows": max_rows,
            "memory_limit": shared.get("duckdb_memory_limit", "512MB"),
            "temp_directory": shared.get("duckdb_temp_directory", "data/.duckdb_tmp"),
            "max_temp_size": shared.get("duckdb_max_temp_size", "10GB"),
            "threads": shared.get("duckdb_threads"),
            "connector_manager": shared.get("connector_manager"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        queries = prep_result["queries"]
        max_rows = prep_result["max_rows"]
        connector_manager = prep_result.get("connector_manager")

        # Separate DuckDB and live SQL queries
        live_queries = [(i, q) for i, q in enumerate(queries) if q.get("target") == "live_sql"]
        duck_queries = [(i, q) for i, q in enumerate(queries) if q.get("target") != "live_sql"]

        ordered_results: Dict[int, Dict[str, Any]] = {}

        # Execute live SQL queries first (no DuckDB connection needed)
        for idx, q in live_queries:
            result = execute_live_sql(q, connector_manager=connector_manager, max_rows=max_rows)
            ordered_results[idx] = result

        # If no DuckDB queries, skip opening a connection
        if not duck_queries:
            return [ordered_results[i] for i in sorted(ordered_results)]

        conn = open_connection(
            memory_limit=prep_result["memory_limit"],
            temp_directory=prep_result["temp_directory"],
            max_temp_size=prep_result["max_temp_size"],
            threads=prep_result.get("threads"),
        )

        results: List[Dict[str, Any]] = []
        try:
            for idx, q in duck_queries:
                sql: str = q.get("sql", "")
                label: str = q.get("label", f"Query {idx + 1}")
                parquet_paths = _coerce_paths(q.get("parquet"))
                alias = q.get("alias", "src")
                params = q.get("params")

                if not sql.strip():
                    results.append({
                        "label": label,
                        "sql": sql,
                        "columns": [],
                        "rows": [],
                        "row_count": 0,
                        "truncated": False,
                        "error": "Empty SQL query",
                    })
                    continue

                start = time.time()
                self.logger.info("[%d/%d] Executing: %s", idx + 1, len(queries), label)

                try:
                    if parquet_paths:
                        glob_str = ", ".join(f"'{p}'" for p in parquet_paths)
                        view_sql = f"CREATE OR REPLACE VIEW {alias} AS SELECT * FROM read_parquet([{glob_str}])"
                        conn.execute(view_sql)

                    relation = conn.execute(sql, params or [])
                    df: pd.DataFrame = relation.fetchdf()

                    total_rows = len(df)
                    truncated = total_rows > max_rows
                    if truncated:
                        df = df.head(max_rows)

                    columns = list(df.columns)
                    rows = [
                        [
                            None if pd.isna(v) else
                            float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else
                            str(v) if not isinstance(v, (str, int, float, bool, type(None))) else
                            v
                            for v in row
                        ]
                        for row in df.itertuples(index=False, name=None)
                    ]

                    duration_ms = round((time.time() - start) * 1000, 1)
                    self.logger.info(
                        "  → %s: %d rows (%s) in %.1fms",
                        label, total_rows,
                        "truncated" if truncated else "complete",
                        duration_ms,
                    )

                    results.append({
                        "label": label,
                        "sql": sql,
                        "columns": columns,
                        "rows": rows,
                        "row_count": total_rows,
                        "truncated": truncated,
                        "duration_ms": duration_ms,
                    })

                except Exception as exc:
                    duration_ms = round((time.time() - start) * 1000, 1)
                    error_msg = str(exc)
                    self.logger.error("  → %s FAILED (%.1fms): %s", label, duration_ms, error_msg)
                    results.append({
                        "label": label,
                        "sql": sql,
                        "columns": [],
                        "rows": [],
                        "row_count": 0,
                        "truncated": False,
                        "error": error_msg,
                        "duration_ms": duration_ms,
                    })

        finally:
            conn.close()
            temp_dir = Path(prep_result["temp_directory"])
            if temp_dir.exists():
                shutil.rmtree(temp_dir, ignore_errors=True)

        for idx, r in zip([i for i, _ in duck_queries], results):
            ordered_results[idx] = r

        return [ordered_results[i] for i in sorted(ordered_results)]

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: List[Dict[str, Any]],
    ) -> str:
        shared["sql_results"] = exec_result
        shared["sql_results_summary"] = _build_summary(exec_result)

        has_errors = any(r.get("error") for r in exec_result)
        all_empty = all(r.get("row_count", 0) == 0 for r in exec_result)

        if has_errors and all_empty:
            self.log_exit("error")
            return "error"

        self.log_exit("default")
        return "default"


def _build_summary(results: List[Dict[str, Any]]) -> str:
    """Build a human-readable summary of query results."""
    if not results:
        return "No queries executed."

    parts: List[str] = []
    for r in results:
        label = r.get("label", "Query")
        if r.get("error"):
            parts.append(f"- **{label}**: ERROR — {r['error']}")
            continue

        row_count = r.get("row_count", 0)
        columns = r.get("columns", [])
        truncated = r.get("truncated", False)
        duration = r.get("duration_ms", 0)

        trunc_note = f" (showing first {len(r.get('rows', []))})" if truncated else ""
        parts.append(
            f"- **{label}**: {row_count} rows × {len(columns)} columns{trunc_note} [{duration}ms]"
        )

    return "\n".join(parts)


if __name__ == "__main__":
    node = SQLExecutionNode()
    shared: Dict[str, Any] = {
        "sql_queries": [
            {
                "label": "Top 5 destinations by nuitees 2024",
                "sql": """
                    SELECT Destination, ROUND(SUM(TotalNuitees), 0) AS total_nuitees
                    FROM read_parquet('data/parquet/arriver.parquet')
                    WHERE Annee = 2024
                    GROUP BY Destination
                    ORDER BY total_nuitees DESC
                    LIMIT 5
                """,
            },
            {
                "label": "Total nuitees per year",
                "sql": """
                    SELECT Annee, ROUND(SUM(TotalNuitees), 0) AS total_nuitees
                    FROM read_parquet('data/parquet/arriver.parquet')
                    GROUP BY Annee
                    ORDER BY Annee
                """,
            },
        ],
    }

    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    print("=== Summary ===")
    print(shared["sql_results_summary"])
    print()

    for r in shared["sql_results"]:
        print(f"--- {r['label']} ---")
        if r.get("error"):
            print(f"  ERROR: {r['error']}")
        else:
            print(f"  Columns: {r['columns']}")
            for row in r["rows"][:5]:
                print(f"  {row}")
            if r["row_count"] > 5:
                print(f"  ... ({r['row_count']} total rows)")
        print()
