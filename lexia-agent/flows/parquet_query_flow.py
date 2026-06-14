"""
Parquet Query Flow — Query an existing Parquet file via DuckDB.

Pipeline:
    ParquetBridge → QueryBridge → DuckDBQuery → FlowEnd

Use when the parquet file already exists (no QVD read or parquet write).

Shared-state contract:
──────────────────────────────────────────────
  Required:
    parquet_path      (str | Path)  – path to existing parquet file

  Optional:
    duckdb_queries    (list[dict])  – query descriptors (see DuckDBQueryNode)
    duckdb_memory_limit, duckdb_temp_directory, duckdb_max_temp_size, duckdb_threads

Outputs:
    parquet_write_results  – [{filename}] (for compatibility with QueryBridge)
    duckdb_results         – list of query results
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from pocketflow import Flow, Node as PFNode

from nodes.dataloader.duckdb_query_node import DuckDBQueryNode

from monitoring.logger import get_logger

logger = get_logger(__name__)


class _ParquetBridgeNode(PFNode):
    """Creates parquet_write_results from an existing parquet path."""

    def prep(self, shared):
        path = shared.get("parquet_path")
        if not path:
            raise ValueError("ParquetQueryFlow requires 'parquet_path' in shared state")
        return Path(path)

    def post(self, shared, prep_res, exec_res):
        path = prep_res
        shared["parquet_write_results"] = [{"filename": str(path)}]
        return "default"


class _QueryBridgeNode(PFNode):
    """Injects parquet path into query descriptors. Skips if no queries."""

    def prep(self, shared):
        return shared.get("duckdb_queries"), shared.get("parquet_write_results")

    def post(self, shared, prep_res, exec_res):
        queries, write_results = prep_res
        if not queries:
            return "skip"
        parquet_path = write_results[0]["filename"] if write_results else None
        for q in queries:
            if "parquet" not in q and parquet_path:
                q["parquet"] = parquet_path
        shared["duckdb_queries"] = queries
        return "default"


class _FlowEndNode(PFNode):
    """No-op terminal node."""
    pass


def create_parquet_query_flow() -> Flow:
    """Assemble the Parquet → DuckDB query pipeline.

    Returns:
        Flow starting at ParquetBridge.
    """
    parquet_bridge = _ParquetBridgeNode()
    query_bridge = _QueryBridgeNode()
    duckdb_query = DuckDBQueryNode()
    flow_end = _FlowEndNode()

    parquet_bridge >> query_bridge >> duckdb_query >> flow_end
    query_bridge - "skip" >> flow_end

    return Flow(start=parquet_bridge)


def run_parquet_query(
    parquet_path: str,
    *,
    queries: Optional[list] = None,
    memory_limit: str = "512MB",
) -> Dict[str, Any]:
    """Run the parquet query flow.

    Args:
        parquet_path: Path to existing parquet file.
        queries: DuckDB query descriptors.
        memory_limit: DuckDB memory budget.

    Returns:
        Shared state with duckdb_results when queries provided.
    """
    flow = create_parquet_query_flow()
    shared: Dict[str, Any] = {
        "parquet_path": parquet_path,
        "duckdb_memory_limit": memory_limit,
    }
    if queries:
        shared["duckdb_queries"] = queries

    logger.info(f"Starting parquet query flow: {parquet_path}")
    flow.run(shared)
    logger.info("Parquet query flow complete")
    return shared


if __name__ == "__main__":
    result = run_parquet_query(
        parquet_path="data/apf.parquet",
        queries=[
            {"sql": "SELECT COUNT(*) AS total_rows FROM src"},
            {"sql": "SELECT * FROM src WHERE Mois IS NOT NULL LIMIT 5"},
            {"sql": "SELECT SUM(Total_Arrivees) AS total_arrivees FROM src WHERE Nationalite = 'France'"},
        ],
    )
    print(result)