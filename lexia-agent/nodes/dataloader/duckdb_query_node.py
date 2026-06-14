"""
DuckDBQueryNode — Process large Parquet files on disk without memory overload.

DuckDB reads Parquet column metadata and row-groups lazily, only materialising
the columns / rows that satisfy the query predicate.  When the configured
memory budget is exceeded it spills intermediate results to a temporary
directory on disk (similar to TiDB Regions or Spark shuffle-spill).

Inputs (via shared state):
- ``duckdb_queries``: list of query descriptors, each a dict with:
    - ``sql``       (str):  SQL query.  Use ``read_parquet('{path}')`` or a
                            registered table name as the source.
    - ``parquet``   (str | Path | list[str]):  Parquet file path(s) to register
                            as the virtual table ``src``.  Optional if the SQL
                            already contains ``read_parquet(…)``.
    - ``alias``     (str):  Virtual table alias (default ``"src"``).
    - ``params``    (list): Positional bind parameters for the SQL (optional).
    - ``fetch``     (str):  ``"df"`` → pandas DataFrame (default),
                            ``"arrow"`` → pyarrow Table,
                            ``"raw"`` → list of tuples.

Optional shared-state configuration:
- ``duckdb_memory_limit``       (str):  e.g. ``"512MB"``, ``"2GB"``.  Default ``"512MB"``.
- ``duckdb_temp_directory``     (str):  Temp dir for spill files.  Default ``"data/.duckdb_tmp"``.
- ``duckdb_max_temp_size``      (str):  Spill cap.  Default ``"10GB"``.
- ``duckdb_threads``            (int):  Worker threads.  Default: DuckDB auto.

Outputs (via shared state):
- ``duckdb_results``: list of result objects (DataFrame / Table / list), one per query.
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import duckdb
import pandas as pd

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_MEMORY_LIMIT = "512MB"
_DEFAULT_TEMP_DIR = "data/.duckdb_tmp"
_DEFAULT_MAX_TEMP_SIZE = "10GB"


def _coerce_paths(raw: Union[str, Path, List[str], List[Path], None]) -> Optional[List[str]]:
    if raw is None:
        return None
    if isinstance(raw, (str, Path)):
        return [str(raw)]
    return [str(p) for p in raw]


def open_connection(
    *,
    memory_limit: str = _DEFAULT_MEMORY_LIMIT,
    temp_directory: str = _DEFAULT_TEMP_DIR,
    max_temp_size: str = _DEFAULT_MAX_TEMP_SIZE,
    threads: Optional[int] = None,
) -> duckdb.DuckDBPyConnection:
    """Open a DuckDB connection configured for out-of-core processing."""
    temp_dir = Path(temp_directory)
    temp_dir.mkdir(parents=True, exist_ok=True)

    conn = duckdb.connect(database=":memory:", config={
        "memory_limit": memory_limit,
        "temp_directory": str(temp_dir),
        "max_temp_directory_size": max_temp_size,
        "preserve_insertion_order": "false",
    })
    if threads is not None:
        conn.execute(f"SET threads TO {int(threads)}")

    logger.info(
        f"DuckDB connection opened  memory_limit={memory_limit}  "
        f"temp={temp_dir}  max_temp={max_temp_size}"
    )
    return conn


def execute_query(
    conn: duckdb.DuckDBPyConnection,
    sql: str,
    *,
    parquet_paths: Optional[List[str]] = None,
    alias: str = "src",
    params: Optional[list] = None,
    fetch: str = "df",
) -> Any:
    """Run *sql* against the connection, optionally registering parquet files.

    Parameters
    ----------
    conn : DuckDB connection
    sql : SQL statement – may reference ``read_parquet(…)`` or the *alias*.
    parquet_paths : If given, creates a view *alias* pointing to these files.
    alias : Name of the virtual table backed by *parquet_paths*.
    params : Positional bind parameters (``$1``, ``$2``, …).
    fetch : ``"df"`` (pandas), ``"arrow"`` (pyarrow), ``"raw"`` (tuples).
    """
    if parquet_paths:
        glob = ", ".join(f"'{p}'" for p in parquet_paths)
        view_sql = f"CREATE OR REPLACE VIEW {alias} AS SELECT * FROM read_parquet([{glob}])"
        conn.execute(view_sql)
        logger.info(f"Registered view '{alias}' → {parquet_paths}")

    relation = conn.execute(sql, params or [])

    if fetch == "arrow":
        return relation.fetch_arrow_table()
    if fetch == "raw":
        return relation.fetchall()
    df = relation.fetchdf()
    df = df.convert_dtypes()
    for col in df.columns:
        if df[col].dtype == "object":
            df[col] = df[col].where(df[col].notna(), pd.NA)
    return df


class DuckDBQueryNode(BaseNode):
    """PocketFlow node that executes SQL on large Parquet files via DuckDB.

    The node opens one connection per ``run``, executes every query descriptor
    found in ``shared["duckdb_queries"]``, collects the results, and closes the
    connection.  Temporary spill files are cleaned up automatically.
    """

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "DuckDBQuery")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        queries = shared.get("duckdb_queries")
        if not queries:
            raise ValueError("DuckDBQueryNode requires 'duckdb_queries' in shared state")

        return {
            "queries": queries,
            "memory_limit": shared.get("duckdb_memory_limit", _DEFAULT_MEMORY_LIMIT),
            "temp_directory": shared.get("duckdb_temp_directory", _DEFAULT_TEMP_DIR),
            "max_temp_size": shared.get("duckdb_max_temp_size", _DEFAULT_MAX_TEMP_SIZE),
            "threads": shared.get("duckdb_threads"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[Any]:
        queries: List[Dict[str, Any]] = prep_result["queries"]
        conn = open_connection(
            memory_limit=prep_result["memory_limit"],
            temp_directory=prep_result["temp_directory"],
            max_temp_size=prep_result["max_temp_size"],
            threads=prep_result.get("threads"),
        )

        results: List[Any] = []
        try:
            for idx, q in enumerate(queries):
                sql: str = q["sql"]
                parquet_paths = _coerce_paths(q.get("parquet"))
                alias = q.get("alias", "src")
                params = q.get("params")
                fetch = q.get("fetch", "df")

                logger.info(f"[{idx+1}/{len(queries)}] Executing: {sql[:120]}…")
                result = execute_query(
                    conn, sql,
                    parquet_paths=parquet_paths,
                    alias=alias,
                    params=params,
                    fetch=fetch,
                )
                if hasattr(result, "__len__"):
                    logger.info(f"  → {len(result):,} rows returned")
                results.append(result)
        finally:
            conn.close()
            temp_dir = Path(prep_result["temp_directory"])
            if temp_dir.exists():
                shutil.rmtree(temp_dir, ignore_errors=True)
                logger.info(f"Cleaned up temp directory: {temp_dir}")

        return results

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: List[Any]) -> str:
        shared["duckdb_results"] = exec_result
        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    test_path = Path("data/parquet/apf.parquet")
    node = DuckDBQueryNode()
    shared = {
        "duckdb_queries": [
            {
                "parquet": str(test_path),
                "sql": """WITH params AS (
  SELECT MAX(Annee) AS max_annee
  FROM read_parquet('data/parquet/arriver.parquet')
),
yearly AS (
  SELECT
    a.Destination,
    a.Annee,
    SUM(a.TotalNuitees) AS nuitees_year,
    p.max_annee
  FROM read_parquet('data/parquet/arriver.parquet') a
  CROSS JOIN params p
  WHERE a.Annee BETWEEN p.max_annee - 4 AND p.max_annee
  GROUP BY a.Destination, a.Annee, p.max_annee
),
agg AS (
  SELECT
    Destination,
    MAX(CASE WHEN Annee = max_annee THEN nuitees_year END) AS latest_nuitees,
    MAX(CASE WHEN Annee = max_annee - 4 THEN nuitees_year END) AS earliest_nuitees,
    CASE
      WHEN MAX(CASE WHEN Annee = max_annee - 4 THEN nuitees_year END) = 0 THEN NULL
      ELSE (MAX(CASE WHEN Annee = max_annee THEN nuitees_year END) -
            MAX(CASE WHEN Annee = max_annee - 4 THEN nuitees_year END))
           / NULLIF(MAX(CASE WHEN Annee = max_annee - 4 THEN nuitees_year END), 0)
    END AS growth_rate
  FROM yearly
  GROUP BY Destination
)
SELECT
  Destination,
  ROUND(earliest_nuitees, 0) AS earliest_nuitees,
  ROUND(latest_nuitees, 0) AS latest_nuitees,
  ROUND(growth_rate * 100, 2) AS growth_percent
FROM agg
WHERE growth_rate IS NOT NULL
ORDER BY growth_rate DESC
LIMIT 10;""" },
        ],
        "duckdb_memory_limit": "256MB",
    }
    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    print("Query 1 (top nationalities):")
    print(shared["duckdb_results"])
   
