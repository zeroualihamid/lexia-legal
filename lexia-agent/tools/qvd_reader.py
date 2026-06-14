"""
QVD Reader adapter backed by the ``pyqvd`` library.

Provides the ``QVDReader`` interface expected by
``services.connectors.qvd_connector.QVDConnector``.
"""

import gc
import logging
from pathlib import Path
from typing import Any, Dict, Optional

import pandas as pd
from pyqvd import QvdTable

logger = logging.getLogger(__name__)


class QVDReader:
    """Read QlikView Data (QVD) files and return pandas DataFrames."""

    def __init__(self, data_directory: str):
        self.data_directory = Path(data_directory)
        self._cache: Dict[str, pd.DataFrame] = {}

    def read_qvd(
        self,
        filename: str,
        use_cache: bool = True,
        chunk_size: Optional[int] = None,
    ) -> pd.DataFrame:
        if use_cache and filename in self._cache:
            return self._cache[filename].copy()

        path = self.data_directory / filename
        if not path.exists():
            raise FileNotFoundError(f"QVD file not found: {path}")

        logger.info("Reading QVD file: %s (chunk_size=%s)", path, chunk_size)

        if chunk_size:
            # Build the frame chunk-by-chunk while keeping peak RAM bounded.
            # pyqvd streams the index table per chunk (the symbol table is
            # small), but holding 100+ full *object*-dtype chunks in a list
            # before a single concat is what blew memory past the container
            # limit on large QVDs (e.g. 8.4M rows × 108 cols / 568MB). We
            # convert wide object (Qlik string/"dual") columns to memory-compact
            # `category` dtype per chunk and free each pyqvd chunk immediately;
            # this holds the build phase to ~1.6GB instead of 20GB+. Numeric
            # columns are left untouched.
            frames = []
            for chunk in QvdTable.from_qvd(path, chunk_size=chunk_size):
                cdf = chunk.to_pandas()
                if cdf.empty:
                    continue
                for col in cdf.columns:
                    if cdf[col].dtype == object:
                        cdf[col] = cdf[col].astype("category")
                frames.append(cdf)
                del chunk
            if not frames:
                df = pd.DataFrame()
            else:
                df = pd.concat(frames, ignore_index=True)
            del frames
            gc.collect()
            # Restore plain object dtype for any column that stayed categorical
            # so downstream dtype expectations are identical to a non-chunked
            # read (category was only a transient memory optimisation).
            for col in df.columns:
                if str(df[col].dtype) == "category":
                    df[col] = df[col].astype(object)
        else:
            tbl = QvdTable.from_qvd(path)
            df = tbl.to_pandas()

        if use_cache:
            self._cache[filename] = df

        logger.info("Read %d rows, %d columns from %s", len(df), len(df.columns), filename)
        return df

    def get_file_info(self, filename: str) -> Dict[str, Any]:
        path = self.data_directory / filename
        if not path.exists():
            raise FileNotFoundError(f"QVD file not found: {path}")

        size_bytes = path.stat().st_size
        tbl = QvdTable.from_qvd(path, chunk_size=1)
        first_chunk = next(iter(tbl), None)
        num_columns = len(first_chunk.columns) if first_chunk else 0

        return {
            "filename": filename,
            "path": str(path),
            "file_size_mb": round(size_bytes / (1024 * 1024), 2),
            "num_columns": num_columns,
        }
