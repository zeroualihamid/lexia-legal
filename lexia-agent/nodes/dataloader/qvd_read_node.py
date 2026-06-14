# nodes/dataloader/qvd_read_node.py

"""
QVD Read Node
~~~~~~~~~~~~~
Reads a QVD file and stores the resulting DataFrame in shared state.

Inputs (via shared state):
- ``qvd_path`` (str or Path): Path to the source QVD file.
- ``qvd_chunk_size`` (optional, int): Chunk size for large files (default: 100000).

Outputs (via shared state):
- ``qvd_dataframe``: The resulting pandas DataFrame.
"""

from __future__ import annotations

import unicodedata
import re
from pathlib import Path
from typing import Any, Dict, Optional

import pandas as pd

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


def _sanitize_column_name(name: str) -> str:
    """Sanitize column names for Python compatibility (spaces → underscores, etc.)."""
    if not name:
        return name
    sanitized = name.replace("'", "_").replace("'", "_").replace('"', "_")
    sanitized = sanitized.replace(" ", "_")
    sanitized = unicodedata.normalize("NFKD", sanitized)
    sanitized = "".join(ch for ch in sanitized if unicodedata.category(ch) != "Mn")
    sanitized = re.sub(r"[^a-zA-Z0-9_]", "", sanitized)
    sanitized = re.sub(r"_+", "_", sanitized)
    return sanitized.strip("_") or name


def _read_qvd_to_dataframe(path: Path, chunk_size: int | None = None) -> pd.DataFrame:
    """Read a QVD file into a DataFrame using pyqvd."""
    from pyqvd import QvdTable

    table = QvdTable.from_qvd(str(path))
    return table.to_pandas()


class QVDReadNode(BaseNode):
    """Read a QVD file and store the resulting DataFrame in shared state."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "QVDRead")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        qvd_path = shared.get("qvd_path")
        if not qvd_path:
            raise ValueError("QVDReadNode requires 'qvd_path' in shared state")
        qvd_path = Path(qvd_path)
        if not qvd_path.is_file():
            raise FileNotFoundError(f"QVD file not found: {qvd_path}")
        return {
            "qvd_path": qvd_path,
            "chunk_size": shared.get("qvd_chunk_size"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> pd.DataFrame:
        qvd_path: Path = prep_result["qvd_path"]
        chunk_size = prep_result.get("chunk_size")

        df = _read_qvd_to_dataframe(qvd_path, chunk_size=chunk_size)

        column_mapping = {col: _sanitize_column_name(col) for col in df.columns}
        df = df.rename(columns=column_mapping)

        logger.info(f"Read QVD: {qvd_path.name} ({len(df):,} rows, {len(df.columns)} cols)")
        return df

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: pd.DataFrame) -> str:
        shared["qvd_dataframe"] = exec_result
        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    node = QVDReadNode()
    shared = {"qvd_path": "data/raw/arriver.qvd"}
    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)
    print(f"Rows: {len(shared['qvd_dataframe'])}, Cols: {list(shared['qvd_dataframe'].columns)[:5]}...")
