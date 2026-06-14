"""
QVD Pipeline Flow — Read QVD, persist as Parquet, query via DuckDB.

Pipeline:
    QVDRead → ParquetBridge → ParquetWriter → QueryBridge → DuckDBQuery
                                                   ↑
                                            (optional: skip if
                                             no queries provided)

The bridge nodes translate shared-state keys between the three core
data-loader nodes so each node stays decoupled and reusable on its own.

Shared-state contract (caller must provide):
──────────────────────────────────────────────
  Required:
    qvd_path          (str | Path)  – source QVD file
    parquet_output     (str | Path)  – target parquet path

  Optional:
    duckdb_queries     (list[dict])  – query descriptors (see DuckDBQueryNode)
    duckdb_memory_limit (str)        – e.g. "1GB" (default "512MB")
    duckdb_temp_directory (str)      – spill dir  (default "data/.duckdb_tmp")
    duckdb_max_temp_size  (str)      – spill cap  (default "10GB")
    duckdb_threads     (int)         – worker threads

Outputs written back to shared:
    qvd_dataframe            – raw DataFrame from QVD
    parquet_write_results    – [{filename, rows, columns}]
    duckdb_results           – list of query results (when queries provided)
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

from pocketflow import Flow, Node as PFNode

from nodes.dataloader.qvd_read_node import QVDReadNode
from nodes.dataloader.parquet_writer_node import ParquetWriterNode
from nodes.dataloader.duckdb_query_node import DuckDBQueryNode

from monitoring.logger import get_logger

logger = get_logger(__name__)


class _ParquetBridgeNode(PFNode):
    """Adapts QVDReadNode output → ParquetWriterNode input."""

    def prep(self, shared):
        return shared["qvd_dataframe"], shared["parquet_output"]

    def post(self, shared, prep_res, exec_res):
        df, output_path = prep_res
        shared["parquet_write_requests"] = [
            {"df": df, "filename": str(output_path)},
        ]
        return "default"


class _QueryBridgeNode(PFNode):
    """Injects the parquet path written by ParquetWriterNode into any DuckDB
    query descriptor that does not already specify its own ``parquet`` key.

    If no ``duckdb_queries`` are present in shared state the flow ends
    (returns ``"skip"``).
    """

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


def create_qvd_pipeline_flow() -> Flow:
    """Assemble the QVD → Parquet → DuckDB pipeline.

    Returns:
        A PocketFlow ``Flow`` starting at the QVDReadNode.
    """
    qvd_read = QVDReadNode()
    parquet_bridge = _ParquetBridgeNode()
    parquet_writer = ParquetWriterNode()
    query_bridge = _QueryBridgeNode()
    duckdb_query = DuckDBQueryNode()
    flow_end = _FlowEndNode()

    qvd_read >> parquet_bridge >> parquet_writer >> query_bridge >> duckdb_query >> flow_end

    query_bridge - "skip" >> flow_end

    return Flow(start=qvd_read)


def run_qvd_pipeline(
    qvd_path: str,
    parquet_output: str,
    *,
    queries: Optional[list] = None,
    memory_limit: str = "512MB",
) -> Dict[str, Any]:
    """Convenience runner for the full QVD pipeline.

    Args:
        qvd_path: Path to the source ``.qvd`` file.
        parquet_output: Destination parquet file path.
        queries: Optional list of DuckDB query descriptors.
        memory_limit: DuckDB memory budget (default ``"512MB"``).

    Returns:
        The shared-state dict after the flow completes, containing at minimum
        ``qvd_dataframe``, ``parquet_write_results``, and (when queries were
        provided) ``duckdb_results``.
    """
    flow = create_qvd_pipeline_flow()

    shared: Dict[str, Any] = {
        "qvd_path": qvd_path,
        "parquet_output": parquet_output,
        "duckdb_memory_limit": memory_limit,
    }
    if queries:
        shared["duckdb_queries"] = queries

    logger.info(f"Starting QVD pipeline: {qvd_path} → {parquet_output}")
    flow.run(shared)
    logger.info("QVD pipeline complete")

    return shared


if __name__ == "__main__":
    import yaml

    with open("data/apf_fields.yaml") as f:
        fields = yaml.safe_load(f)
    variation_sql = fields.get("query_variation_fr_de_vs_autres", "")

    queries = [
        {"sql": "SELECT COUNT(*) AS total_rows FROM src"},
        {"sql": "SELECT * FROM src WHERE Mois IS NOT NULL LIMIT 5"},
        {"sql": "SELECT SUM(Total_Arrivees) AS total_arrivees FROM src WHERE Nationalite = 'France'"},
    ]
    if variation_sql:
        queries.append({"sql": variation_sql})

    result = run_qvd_pipeline(
        qvd_path="data/apf.qvd",
        parquet_output="data/apf.parquet",
        queries=queries,
    )

    print(f"\nParquet write: {result['parquet_write_results']}")
    for i, r in enumerate(result.get("duckdb_results", [])):
        print(f"\nQuery {i + 1}:\n{r}")