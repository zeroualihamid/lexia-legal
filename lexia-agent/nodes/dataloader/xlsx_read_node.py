# nodes/dataloader/xlsx_read_node.py

"""
XLSX Read Node
~~~~~~~~~~~~~~
Reads an Excel workbook (``.xlsx``, ``.xlsm``, ``.xls``, ``.ods``) and stores the
resulting DataFrame(s) in shared state.

Inputs (via shared state):
- ``xlsx_path``         (str | Path):     Path to the source workbook.
- ``xlsx_sheet_name``   (str | int | list | None, optional):
                                          Sheet selector forwarded to ``pd.read_excel``.
                                          Default: ``0`` (first sheet).
                                          ``None`` or a ``list`` returns multiple sheets.
- ``xlsx_header``       (int | list | None, optional):
                                          Row(s) to use as the column header
                                          (default ``0``).
- ``xlsx_skiprows``     (int | list, optional):
                                          Rows to skip at the top of the sheet.
- ``xlsx_usecols``      (str | list, optional):
                                          Subset of columns to load (e.g. ``"A:D"``).
- ``xlsx_dtype``        (dict, optional): Column-name → dtype mapping.
- ``xlsx_engine``       (str, optional):  Pandas excel engine override.
                                          Auto-detected from the file suffix when omitted.
- ``xlsx_read_kwargs``  (dict, optional): Extra kwargs forwarded to ``pd.read_excel``.

Outputs (via shared state):
- ``xlsx_dataframe``   (pd.DataFrame):    The loaded sheet (single-sheet mode).
- ``xlsx_dataframes``  (dict[str, pd.DataFrame]):
                                          One entry per sheet (multi-sheet mode).
- ``xlsx_sheet_names`` (list[str]):       Names of the sheets that were loaded.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import pandas as pd

from monitoring.logger import get_logger
from nodes.base_node import BaseNode

logger = get_logger(__name__)


_ENGINE_BY_SUFFIX = {
    ".xlsx": "openpyxl",
    ".xlsm": "openpyxl",
    ".xltx": "openpyxl",
    ".xltm": "openpyxl",
    ".xls": "xlrd",
    ".ods": "odf",
}


def _sanitize_column_name(name: Any) -> str:
    """Sanitise a column label for downstream Python / SQL compatibility."""
    if name is None:
        return ""
    text = str(name)
    if not text:
        return text
    text = text.replace("'", "_").replace("\u2019", "_").replace('"', "_")
    text = text.replace(" ", "_")
    text = unicodedata.normalize("NFKD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = re.sub(r"[^a-zA-Z0-9_]", "", text)
    text = re.sub(r"_+", "_", text)
    return text.strip("_") or str(name)


def _resolve_engine(path: Path, override: Optional[str]) -> Optional[str]:
    """Pick an explicit engine when the suffix maps to a known one."""
    if override:
        return override
    return _ENGINE_BY_SUFFIX.get(path.suffix.lower())


def _sanitize_columns(df: pd.DataFrame) -> pd.DataFrame:
    """Return *df* with deduplicated, sanitised column names."""
    new_cols: List[str] = []
    seen: Dict[str, int] = {}
    for col in df.columns:
        clean = _sanitize_column_name(col)
        if clean in seen:
            seen[clean] += 1
            clean = f"{clean}_{seen[clean]}"
        else:
            seen[clean] = 0
        new_cols.append(clean)
    df.columns = new_cols
    return df


def read_xlsx_to_dataframes(
    path: Path,
    *,
    sheet_name: Union[str, int, List, None] = 0,
    header: Union[int, List[int], None] = 0,
    skiprows: Union[int, List[int], None] = None,
    usecols: Union[str, List, None] = None,
    dtype: Optional[Dict[str, Any]] = None,
    engine: Optional[str] = None,
    extra_kwargs: Optional[Dict[str, Any]] = None,
) -> Dict[str, pd.DataFrame]:
    """Read an Excel workbook and always return a ``{sheet_name: DataFrame}`` dict.

    This wrapper normalises the polymorphic return type of ``pd.read_excel``
    (DataFrame for a single sheet, dict for ``None``/``list``) so downstream
    code can iterate uniformly.
    """
    kwargs: Dict[str, Any] = {
        "sheet_name": sheet_name,
        "header": header,
    }
    if skiprows is not None:
        kwargs["skiprows"] = skiprows
    if usecols is not None:
        kwargs["usecols"] = usecols
    if dtype is not None:
        kwargs["dtype"] = dtype

    resolved_engine = _resolve_engine(path, engine)
    if resolved_engine is not None:
        kwargs["engine"] = resolved_engine

    if extra_kwargs:
        kwargs.update(extra_kwargs)

    raw = pd.read_excel(str(path), **kwargs)

    if isinstance(raw, dict):
        sheets = {str(k): v for k, v in raw.items()}
    else:
        if isinstance(sheet_name, int):
            try:
                file = pd.ExcelFile(str(path), engine=resolved_engine)
                resolved_name = file.sheet_names[sheet_name]
            except Exception:
                resolved_name = f"sheet_{sheet_name}"
        else:
            resolved_name = str(sheet_name) if sheet_name is not None else "sheet_0"
        sheets = {resolved_name: raw}

    return {name: _sanitize_columns(df) for name, df in sheets.items()}


class XLSXReadNode(BaseNode):
    """Read an Excel workbook and store the result in shared state."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "XLSXRead")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        xlsx_path = shared.get("xlsx_path")
        if not xlsx_path:
            raise ValueError("XLSXReadNode requires 'xlsx_path' in shared state")
        path = Path(xlsx_path)
        if not path.is_file():
            raise FileNotFoundError(f"Excel file not found: {path}")
        return {
            "path": path,
            "sheet_name": shared.get("xlsx_sheet_name", 0),
            "header": shared.get("xlsx_header", 0),
            "skiprows": shared.get("xlsx_skiprows"),
            "usecols": shared.get("xlsx_usecols"),
            "dtype": shared.get("xlsx_dtype"),
            "engine": shared.get("xlsx_engine"),
            "extra_kwargs": shared.get("xlsx_read_kwargs"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, pd.DataFrame]:
        path: Path = prep_result["path"]
        sheets = read_xlsx_to_dataframes(
            path,
            sheet_name=prep_result["sheet_name"],
            header=prep_result["header"],
            skiprows=prep_result["skiprows"],
            usecols=prep_result["usecols"],
            dtype=prep_result["dtype"],
            engine=prep_result["engine"],
            extra_kwargs=prep_result["extra_kwargs"],
        )
        for name, df in sheets.items():
            logger.info(
                f"Read XLSX sheet '{name}' from {path.name} "
                f"({len(df):,} rows, {len(df.columns)} cols)"
            )
        return sheets

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Any,
        exec_result: Dict[str, pd.DataFrame],
    ) -> str:
        shared["xlsx_dataframes"] = exec_result
        shared["xlsx_sheet_names"] = list(exec_result.keys())

        if len(exec_result) == 1:
            shared["xlsx_dataframe"] = next(iter(exec_result.values()))
        else:
            shared.pop("xlsx_dataframe", None)

        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    import sys

    test_path = sys.argv[1] if len(sys.argv) > 1 else "data/sample.xlsx"
    node = XLSXReadNode()
    shared: Dict[str, Any] = {"xlsx_path": test_path}
    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)
    for sheet_name, df in shared["xlsx_dataframes"].items():
        print(
            f"Sheet '{sheet_name}': {len(df):,} rows, "
            f"cols={list(df.columns)[:6]}{'…' if len(df.columns) > 6 else ''}"
        )
