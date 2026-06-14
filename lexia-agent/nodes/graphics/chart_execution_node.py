"""
ChartExecutionNode — Execute the chart SQL query and return chart-ready data.

Takes the chart SQL query produced by ``ChartSQLNode``, executes it via DuckDB,
and reshapes the result into a structured payload ready for frontend chart rendering.

Shared-state contract:
──────────────────────────────────────────────
  Required inputs:
      chart_sql_query     (str)  — DuckDB SQL query optimised for a chart
      chart_type          (str)  — "bar" | "line" | "pie" | "area"
      chart_label         (str)  — human-readable chart title

  Optional inputs:
      chartable           (bool) — if False the node is a no-op (default True)
      duckdb_memory_limit (str)  — e.g. "512MB" (default)
      duckdb_temp_directory (str) — spill dir  (default "data/.duckdb_tmp")
      duckdb_max_temp_size  (str) — spill cap  (default "10GB")
      duckdb_threads      (int)  — worker threads

  Outputs:
      chart_data (dict | None) — structured chart payload:
          {
            "chart_type":  str,          # bar / line / pie / area
            "title":       str,          # human-readable title
            "labels":      list[str],    # X-axis / category labels
            "datasets": [                # one or more series
              {
                "label": str,            # series name
                "data":  list[float|int] # numeric values
              }
            ],
            "sql":         str,          # the executed SQL (for debug)
            "row_count":   int,
            "duration_ms": float
          }
"""

from __future__ import annotations

import shutil
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb
import pandas as pd

from nodes.base_node import BaseNode
from nodes.dataloader.duckdb_query_node import open_connection
from monitoring.logger import get_logger

logger = get_logger(__name__)


class ChartExecutionNode(BaseNode):
    """Execute a chart SQL query and reshape the result for chart rendering."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ChartExecution")

    # ── prep ───────────────────────────────────────────────────────────
    def prep(self, shared: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        self.log_entry(shared)

        if not shared.get("chartable", True):
            self.logger.info("chartable=False — nothing to execute")
            return None

        chart_sql = shared.get("chart_sql_query")
        if not chart_sql or not chart_sql.strip():
            self.logger.info("No chart_sql_query in shared state — skipping")
            return None

        return {
            "sql": chart_sql.strip(),
            "chart_type": shared.get("chart_type", "bar"),
            "chart_label": shared.get("chart_label", "Graphique"),
            "memory_limit": shared.get("duckdb_memory_limit", "512MB"),
            "temp_directory": shared.get("duckdb_temp_directory", "data/.duckdb_tmp"),
            "max_temp_size": shared.get("duckdb_max_temp_size", "10GB"),
            "threads": shared.get("duckdb_threads"),
        }

    # ── exec ───────────────────────────────────────────────────────────
    def exec(self, prep_result: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if prep_result is None:
            return None

        sql = prep_result["sql"]
        chart_type = prep_result["chart_type"]
        chart_label = prep_result["chart_label"]

        conn = open_connection(
            memory_limit=prep_result["memory_limit"],
            temp_directory=prep_result["temp_directory"],
            max_temp_size=prep_result["max_temp_size"],
            threads=prep_result.get("threads"),
        )

        start = time.time()
        try:
            df: pd.DataFrame = conn.execute(sql).fetchdf()
        finally:
            conn.close()
            temp_dir = Path(prep_result["temp_directory"])
            if temp_dir.exists():
                shutil.rmtree(temp_dir, ignore_errors=True)

        duration_ms = round((time.time() - start) * 1000, 1)
        self.logger.info("Chart query returned %d rows in %.1fms", len(df), duration_ms)

        if df.empty:
            return {
                "chart_type": chart_type,
                "title": chart_label,
                "labels": [],
                "datasets": [],
                "sql": sql,
                "row_count": 0,
                "duration_ms": duration_ms,
            }

        return _reshape_for_chart(df, chart_type, chart_label, sql, duration_ms)

    # ── post ───────────────────────────────────────────────────────────
    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Optional[Dict[str, Any]],
        exec_result: Optional[Dict[str, Any]],
    ) -> str:
        shared["chart_data"] = exec_result
        action = "default" if exec_result else "skip"
        self.log_exit(action)
        return action


# ─── helpers ───────────────────────────────────────────────────────────

def _safe_num(val: Any) -> Optional[float]:
    """Coerce a value to a JSON-safe number (or None)."""
    if val is None or (isinstance(val, float) and (pd.isna(val) or val != val)):
        return None
    try:
        return float(val)
    except (TypeError, ValueError):
        return None


def _reshape_for_chart(
    df: pd.DataFrame,
    chart_type: str,
    chart_label: str,
    sql: str,
    duration_ms: float,
) -> Dict[str, Any]:
    """Turn a DataFrame into a chart-ready payload.

    Strategy
    --------
    * First column  → labels  (X-axis / categories).
    * Remaining numeric columns → one dataset each.
    * Non-numeric columns after the first are silently dropped.
    """
    columns = list(df.columns)
    label_col = columns[0]
    labels = [str(v) for v in df[label_col]]

    datasets: List[Dict[str, Any]] = []
    for col in columns[1:]:
        if not pd.api.types.is_numeric_dtype(df[col]):
            continue
        datasets.append({
            "label": col,
            "data": [_safe_num(v) for v in df[col]],
        })

    if not datasets:
        datasets.append({
            "label": label_col,
            "data": [_safe_num(v) for v in df[label_col]],
        })
        labels = [f"Ligne {i + 1}" for i in range(len(df))]

    return {
        "chart_type": chart_type,
        "title": chart_label,
        "labels": labels,
        "datasets": datasets,
        "sql": sql,
        "row_count": len(df),
        "duration_ms": duration_ms,
    }


# ─── standalone test ──────────────────────────────────────────────────

if __name__ == "__main__":
    from nodes.graphics.chart_sql_node import ChartSQLNode
    from nodes.thinking.sql_execution_node import SQLExecutionNode

    chart_sql_node = ChartSQLNode()
    exec_sql_node = SQLExecutionNode()
    chart_exec_node = ChartExecutionNode()

    shared: Dict[str, Any] = {
        "query": "Quelle est l'évolution des arrivées sur les 5 dernières années ?",
        "sql_queries": [
            {
                "label": "Évolution des arrivées",
                "sql": """
                    SELECT Annee, ROUND(SUM(TotalArrivees), 0) AS total
                    FROM read_parquet('data/parquet/arriver.parquet')
                    WHERE Annee >= 2020
                    GROUP BY Annee
                    ORDER BY Annee
                """,
            },
        ],
    }

    exec_sql_node.run(shared)
    chart_sql_node.run(shared)

    print("=== ChartSQLNode output ===")
    print("  chartable :", shared.get("chartable"))
    print("  chart_type:", shared.get("chart_type"))
    print("  chart_label:", shared.get("chart_label"))
    print("  chart_sql  :", (shared.get("chart_sql_query") or "")[:120], "...")

    chart_exec_node.run(shared)

    chart_data = shared.get("chart_data")
    if chart_data:
        print("\n=== ChartExecutionNode output ===")
        print(f"  title      : {chart_data['title']}")
        print(f"  chart_type : {chart_data['chart_type']}")
        print(f"  labels     : {chart_data['labels']}")
        for ds in chart_data["datasets"]:
            print(f"  dataset '{ds['label']}': {ds['data']}")
        print(f"  row_count  : {chart_data['row_count']}")
        print(f"  duration   : {chart_data['duration_ms']}ms")
    else:
        print("\nNo chart_data produced (not chartable or no SQL).")
