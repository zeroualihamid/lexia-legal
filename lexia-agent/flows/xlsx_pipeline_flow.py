"""
XLSX Pipeline Flow — Read XLSX, persist as Parquet, query via DuckDB.

Pipeline:
    XLSXRead → ParquetBridge → ParquetWriter → QueryBridge → DuckDBQuery
                                                   ↑
                                            (skip if no queries)

When the workbook contains multiple sheets, one parquet file is written per
sheet (using the configured ``parquet_output`` path as a base) and DuckDB
registers them all as a single ``src`` view via ``read_parquet([...])``.

Shared-state contract (caller must provide):
──────────────────────────────────────────────
  Required:
    xlsx_path                (str | Path)            – source workbook
    parquet_output           (str | Path)            – target parquet path
                                                       (used as a directory or
                                                        prefix for multi-sheet)

  Optional (forwarded to XLSXReadNode):
    xlsx_sheet_name          (str | int | list | None, default 0)
    xlsx_header              (int | list | None,       default 0)
    xlsx_skiprows            (int | list)
    xlsx_usecols             (str | list)
    xlsx_dtype               (dict)
    xlsx_engine              (str)
    xlsx_read_kwargs         (dict)

  Optional (forwarded to DuckDBQueryNode):
    duckdb_queries           (list[dict])  – query descriptors
    duckdb_memory_limit      (str)         – e.g. "1GB" (default "512MB")
    duckdb_temp_directory    (str)
    duckdb_max_temp_size     (str)
    duckdb_threads           (int)

Outputs written back to shared:
    xlsx_dataframe / xlsx_dataframes  – raw DataFrame(s) from the workbook
    xlsx_sheet_names                  – list of loaded sheet names
    parquet_write_results             – [{filename, rows, columns}, …]
    duckdb_results                    – list of query results (when provided)
"""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional

from pocketflow import Flow, Node as PFNode

from monitoring.logger import get_logger
from nodes.dataloader.duckdb_query_node import DuckDBQueryNode
from nodes.dataloader.parquet_writer_node import ParquetWriterNode
from nodes.dataloader.xlsx_read_node import XLSXReadNode

logger = get_logger(__name__)


def _slugify_sheet(name: str) -> str:
    """Convert a sheet name into an ASCII filename-safe slug."""
    decomposed = unicodedata.normalize("NFKD", name)
    ascii_only = "".join(ch for ch in decomposed if unicodedata.category(ch) != "Mn")
    slug_chars = []
    for ch in ascii_only:
        if ch.isascii() and (ch.isalnum() or ch in ("_", "-")):
            slug_chars.append(ch)
        else:
            slug_chars.append("_")
    slug = "".join(slug_chars).strip("_")
    while "__" in slug:
        slug = slug.replace("__", "_")
    return slug.lower() or "sheet"


def _resolve_parquet_targets(
    base_output: Path, sheet_names: List[str]
) -> Dict[str, Path]:
    """Compute one output parquet path per sheet.

    For a single-sheet workbook the user-provided path is honoured verbatim.
    For multi-sheet workbooks the path is treated as a prefix; ``foo.parquet``
    becomes ``foo__sheet1.parquet``, ``foo__sheet2.parquet``, …
    """
    base_output = Path(base_output)
    if len(sheet_names) == 1:
        return {sheet_names[0]: base_output}

    parent = base_output.parent
    stem = base_output.stem
    suffix = base_output.suffix or ".parquet"
    return {
        name: parent / f"{stem}__{_slugify_sheet(name)}{suffix}"
        for name in sheet_names
    }


class _ParquetBridgeNode(PFNode):
    """Adapt XLSXReadNode output → ParquetWriterNode input.

    Builds one ``parquet_write_requests`` entry per loaded sheet and stores
    the resolved per-sheet parquet paths in ``shared["xlsx_parquet_paths"]``.
    """

    def prep(self, shared):
        sheets = shared.get("xlsx_dataframes")
        if not sheets:
            single = shared.get("xlsx_dataframe")
            if single is None:
                raise ValueError(
                    "_ParquetBridgeNode requires 'xlsx_dataframes' or "
                    "'xlsx_dataframe' in shared state"
                )
            sheets = {"sheet_0": single}

        parquet_output = shared.get("parquet_output")
        if not parquet_output:
            raise ValueError(
                "_ParquetBridgeNode requires 'parquet_output' in shared state"
            )

        return sheets, Path(parquet_output)

    def post(self, shared, prep_res, exec_res):
        sheets, base_output = prep_res
        targets = _resolve_parquet_targets(base_output, list(sheets.keys()))

        requests = [
            {"df": sheets[name], "filename": str(targets[name])}
            for name in sheets
        ]
        shared["parquet_write_requests"] = requests
        shared["xlsx_parquet_paths"] = {n: str(p) for n, p in targets.items()}
        return "default"


class _QueryBridgeNode(PFNode):
    """Inject parquet paths into DuckDB query descriptors.

    Any query missing a ``parquet`` key is bound to **all** parquet files
    written by the previous step, so the DuckDB ``src`` view automatically
    spans every sheet of the workbook.

    Returns ``"skip"`` when no ``duckdb_queries`` were provided.
    """

    def prep(self, shared):
        return shared.get("duckdb_queries"), shared.get("parquet_write_results")

    def post(self, shared, prep_res, exec_res):
        queries, write_results = prep_res

        if not queries:
            return "skip"

        parquet_paths = [r["filename"] for r in (write_results or [])]

        for q in queries:
            if "parquet" not in q and parquet_paths:
                q["parquet"] = parquet_paths if len(parquet_paths) > 1 else parquet_paths[0]

        shared["duckdb_queries"] = queries
        return "default"


class _FlowEndNode(PFNode):
    """No-op terminal node to silence PocketFlow 'action not found' warnings."""
    pass


def create_xlsx_pipeline_flow() -> Flow:
    """Assemble the XLSX → Parquet → DuckDB pipeline.

    Returns:
        A PocketFlow ``Flow`` starting at the XLSXReadNode.
    """
    xlsx_read = XLSXReadNode()
    parquet_bridge = _ParquetBridgeNode()
    parquet_writer = ParquetWriterNode()
    query_bridge = _QueryBridgeNode()
    duckdb_query = DuckDBQueryNode()
    flow_end = _FlowEndNode()

    xlsx_read >> parquet_bridge >> parquet_writer >> query_bridge >> duckdb_query >> flow_end

    query_bridge - "skip" >> flow_end

    return Flow(start=xlsx_read)


def run_xlsx_pipeline(
    xlsx_path: str,
    parquet_output: str,
    *,
    sheet_name: Any = 0,
    queries: Optional[list] = None,
    memory_limit: str = "512MB",
    read_kwargs: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Convenience runner for the XLSX → Parquet → DuckDB pipeline.

    Args:
        xlsx_path: Path to the source ``.xlsx`` / ``.xls`` / ``.ods`` workbook.
        parquet_output: Destination parquet path (or prefix for multi-sheet
            workbooks, see module docstring).
        sheet_name: Sheet selector forwarded to ``pd.read_excel``. Pass ``None``
            or a list to materialise multiple sheets.
        queries: Optional list of DuckDB query descriptors.
        memory_limit: DuckDB memory budget.
        read_kwargs: Extra keyword arguments forwarded to ``pd.read_excel``.

    Returns:
        The shared-state dict after the flow completes.
    """
    flow = create_xlsx_pipeline_flow()

    shared: Dict[str, Any] = {
        "xlsx_path": xlsx_path,
        "xlsx_sheet_name": sheet_name,
        "parquet_output": parquet_output,
        "duckdb_memory_limit": memory_limit,
    }
    if read_kwargs:
        shared["xlsx_read_kwargs"] = read_kwargs
    if queries:
        shared["duckdb_queries"] = queries

    logger.info(f"Starting XLSX pipeline: {xlsx_path} → {parquet_output}")
    flow.run(shared)
    logger.info("XLSX pipeline complete")

    return shared


if __name__ == "__main__":
    import sys

    src = sys.argv[1] if len(sys.argv) > 1 else "data/sample.xlsx"
    dst = sys.argv[2] if len(sys.argv) > 2 else "data/sample.parquet"

    queries = [
        {"sql": "SELECT COUNT(*) AS total_rows FROM src"},
        {"sql": "SELECT * FROM src LIMIT 5"},
    ]

    result = run_xlsx_pipeline(
        xlsx_path=src,
        parquet_output=dst,
        sheet_name=0,
        queries=queries,
    )

    print(f"\nLoaded sheets: {result.get('xlsx_sheet_names')}")
    print(f"Parquet write: {result['parquet_write_results']}")
    for i, r in enumerate(result.get("duckdb_results", [])):
        print(f"\nQuery {i + 1}:\n{r}")
