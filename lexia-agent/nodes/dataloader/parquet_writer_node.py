"""
ParquetWriterNode — Single point of parquet file creation.

All parquet writes in the codebase should route through this node.
Accepts a DataFrame and an output filename via shared state, handles
mixed-type column sanitisation, and writes with Snappy compression.

Inputs (via shared state):
- ``parquet_write_requests``: list of dicts, each with:
    - ``df``       (pd.DataFrame): DataFrame to persist.
    - ``filename`` (str | Path):   Target file path.

Outputs (via shared state):
- ``parquet_write_results``: list of dicts with ``filename``, ``rows``, ``columns``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


def sanitise_for_parquet(df: pd.DataFrame, *, large_threshold: int = 100_000) -> pd.DataFrame:
    """Return a copy of *df* with object columns converted for parquet safety.

    Mixed-type object columns (bytes, ints mixed with strings, etc.) cause
    pyarrow to fail.  This helper converts them to strings.
    """
    is_large = len(df) > large_threshold

    # Decide which object columns need string conversion, then materialise ONLY
    # those (as Arrow-backed StringDtype, vectorised). The previous version did a
    # deep df.copy() plus a per-cell `.apply(str)` over every object column —
    # for a wide multi-million-row frame that allocated ~hundreds of millions of
    # fresh Python str objects (breaking string interning) and a full duplicate,
    # spiking RAM past the container limit. astype("string") is vectorised and
    # Arrow-backed (~3-5× less memory, no per-cell Python calls), and we avoid
    # the deep copy by only replacing the converted columns on a shallow copy.
    converted: dict = {}
    for col in df.columns:
        if df[col].dtype != "object":
            continue
        non_null = df[col].dropna()
        if len(non_null) == 0:
            continue

        if is_large:
            should_convert = True
        else:
            try:
                pd.to_numeric(non_null, errors="raise")
                should_convert = False
            except (ValueError, TypeError):
                sample_size = min(1000, len(non_null))
                sample = non_null.iloc[:: max(1, len(non_null) // sample_size)].head(sample_size)
                types = {type(v).__name__ for v in sample}
                problematic = {"bytes", "float", "int", "float64", "int64"}
                should_convert = len(types) > 1 or bool(types & problematic)

        if should_convert:
            converted[col] = df[col].astype("string")

    if not converted:
        return df

    out = df.copy(deep=False)
    for col, series in converted.items():
        out[col] = series
    return out


def _safe_to_str(x):
    if x is None or pd.isna(x):
        return pd.NA
    if isinstance(x, bytes):
        return x.decode("utf-8", errors="replace")
    return str(x)


def write_parquet(df: pd.DataFrame, path: Path | str) -> Path:
    """Sanitise *df* and write it as a Snappy-compressed parquet file.

    This is the **single** low-level function all parquet creation goes through.
    Writes to a temp file first and atomically renames to prevent corruption.
    """
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_suffix(".parquet.tmp")
    clean = sanitise_for_parquet(df)
    clean.to_parquet(tmp_path, engine="pyarrow", compression="snappy", index=False)
    tmp_path.rename(path)
    logger.info(
        f"Wrote parquet: {path} ({len(df):,} rows, {len(df.columns)} cols)"
    )
    return path


class ParquetWriterNode(BaseNode):
    """PocketFlow node that writes one or more DataFrames to parquet files."""

    def prep(self, shared: Dict[str, Any]) -> List[Dict[str, Any]]:
        self.log_entry(shared)
        requests = shared.get("parquet_write_requests")
        if not requests:
            raise ValueError("ParquetWriterNode requires 'parquet_write_requests' in shared state")
        return requests

    def exec(self, prep_result: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        results: List[Dict[str, Any]] = []
        for req in prep_result:
            df: pd.DataFrame = req["df"]
            filename = req["filename"]

            if not isinstance(df, pd.DataFrame):
                raise TypeError(f"Expected DataFrame, got {type(df).__name__} for {filename}")
            if df.empty:
                self.logger.warning(f"Skipping empty DataFrame for {filename}")
                continue

            out_path = write_parquet(df, filename)
            results.append({
                "filename": str(out_path),
                "rows": len(df),
                "columns": len(df.columns),
            })
        return results

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: List[Dict[str, Any]]) -> str:
        shared["parquet_write_results"] = exec_result
        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    node = ParquetWriterNode()
    shared = {"parquet_write_requests": [{"df": pd.read_csv("data/arriver.csv"), "filename": "data/arriver.parquet"}]}
    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)