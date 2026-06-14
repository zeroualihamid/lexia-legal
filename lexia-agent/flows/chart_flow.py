"""
Chart Flow — Analyze SQL results for chart potential and execute chart query.

Pipeline:

    ┌────────────┐     ┌──────────────────┐
    │ ChartSQL   │──▶  │ ChartExecution   │──▶ done  (chart_data in shared)
    │ (LLM)      │     │ (DuckDB)         │
    └────────────┘     └──────────────────┘
                             │ skip (not chartable / no SQL)
                             ▼
                           done  (chart_data = None)

Orchestrates:
  1. ``ChartSQLNode`` — uses LLM to decide if results are chartable and generates
     a visualisation-optimised SQL query.
  2. ``ChartExecutionNode`` — executes that SQL via DuckDB and reshapes the result
     into a frontend-ready chart payload (labels, datasets, chart_type, title).

Shared-state contract (caller must provide):
──────────────────────────────────────────────
  Required:
      sql_queries        (list[dict]) — query descriptors with label, sql

  Optional:
      sql_results        (list[dict]) — execution results (columns, rows, label)
      query              (str)        — original user question (for context)
      parquet_cache_dir  (str)        — override parquet directory
      stream_callback    (callable)   — streaming callback (event_type, message, data)

  Outputs (after flow completes):
      chartable          (bool)       — whether a chart was generated
      chart_type         (str|None)   — bar / line / pie / area
      chart_label        (str|None)   — human-readable chart title
      chart_reason       (str|None)   — LLM explanation
      chart_sql_query    (str|None)   — the chart SQL query
      chart_data         (dict|None)  — structured chart payload:
          {
            "chart_type":  str,
            "title":       str,
            "labels":      list[str],
            "datasets":    [{"label": str, "data": list[float]}],
            "sql":         str,
            "row_count":   int,
            "duration_ms": float
          }
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional

from pocketflow import Flow

from nodes.graphics.chart_sql_node import ChartSQLNode
from nodes.graphics.chart_execution_node import ChartExecutionNode
from skill_registry import load_skill_definitions, build_selected_skills_context
from monitoring.logger import get_logger

logger = get_logger(__name__)


def _emit(shared: Dict[str, Any], event_type: str, message: str, data: Any = None) -> None:
    """Fire the stream_callback if one is registered."""
    cb = shared.get("stream_callback")
    if cb:
        cb(event_type, message, data)


def create_chart_flow() -> Flow:
    """Assemble the ChartSQL → ChartExecution pipeline.

    Returns:
        A PocketFlow Flow starting at ChartSQLNode.
    """
    chart_sql = ChartSQLNode()
    chart_exec = ChartExecutionNode()

    chart_sql >> chart_exec

    return Flow(start=chart_sql)


def run_chart_flow(
    sql_queries: List[Dict[str, Any]],
    *,
    sql_results: Optional[List[Dict[str, Any]]] = None,
    query: Optional[str] = None,
    parquet_cache_dir: Optional[str] = None,
    stream_callback: Optional[Callable] = None,
) -> Dict[str, Any]:
    """Run the chart flow end-to-end.

    Args:
        sql_queries: Query descriptors (must contain at least ``sql`` key each).
        sql_results: Optional execution results from SQLExecutionNode.
        query: Optional user question for LLM context.
        parquet_cache_dir: Override for parquet file directory.
        stream_callback: Optional ``(event_type, message, data)`` callback.

    Returns:
        The shared-state dict after the flow completes.
    """
    flow = create_chart_flow()

    skills = load_skill_definitions()
    skills_context = build_selected_skills_context(skills, include_full_content=False) if skills else ""

    shared: Dict[str, Any] = {
        "sql_queries": sql_queries,
        "skills_context": skills_context,
    }
    if sql_results is not None:
        shared["sql_results"] = sql_results
    if query is not None:
        shared["query"] = query
    if parquet_cache_dir is not None:
        shared["parquet_cache_dir"] = parquet_cache_dir
    if stream_callback is not None:
        shared["stream_callback"] = stream_callback

    _emit(shared, "thinking", "Analyse des résultats pour la visualisation…")

    logger.info("Starting chart flow")
    flow.run(shared)

    chartable = shared.get("chartable", False)
    if chartable and shared.get("chart_data"):
        _emit(shared, "chart_ready", "Graphique prêt", shared["chart_data"])
        logger.info(
            "Chart flow complete — chartable=%s, type=%s, rows=%d",
            True,
            shared.get("chart_type"),
            shared["chart_data"].get("row_count", 0),
        )
    else:
        _emit(shared, "thinking", "Pas de graphique pertinent pour ces données.")
        logger.info("Chart flow complete — not chartable (reason: %s)", shared.get("chart_reason"))

    return shared


# ─── standalone test ──────────────────────────────────────────────────

if __name__ == "__main__":
    from nodes.thinking.sql_execution_node import SQLExecutionNode

    def _print_event(event_type: str, message: str, data: Any = None) -> None:
        print(f"  [{event_type}] {message}")
        if data and isinstance(data, dict):
            print(f"    → {list(data.keys())}")

    exec_node = SQLExecutionNode()

    test_shared: Dict[str, Any] = {
        "sql_queries": [
            {
                "label": "Évolution des arrivées par année",
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

    exec_node.run(test_shared)

    result = run_chart_flow(
        sql_queries=test_shared["sql_queries"],
        sql_results=test_shared.get("sql_results"),
        query="Quelle est l'évolution des arrivées sur les 5 dernières années ?",
        stream_callback=_print_event,
    )

    print("\n" + "=" * 60)
    print("chartable  :", result.get("chartable"))
    print("chart_type :", result.get("chart_type"))
    print("chart_label:", result.get("chart_label"))
    print("chart_reason:", result.get("chart_reason"))

    chart_data = result.get("chart_data")
    if chart_data:
        print("\nchart_data:")
        print(f"  title     : {chart_data['title']}")
        print(f"  labels    : {chart_data['labels']}")
        for ds in chart_data["datasets"]:
            print(f"  dataset '{ds['label']}': {ds['data']}")
        print(f"  row_count : {chart_data['row_count']}")
        print(f"  duration  : {chart_data['duration_ms']}ms")
    else:
        print("\nNo chart_data (not chartable).")
