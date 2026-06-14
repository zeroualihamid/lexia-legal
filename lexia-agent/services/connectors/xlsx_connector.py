"""
XLSX Connector for multi-source data architecture.

File-based connector for Excel data sources (.xlsx, .xls, .xlsm, .ods).
Reuses the same column-sanitisation logic as ``XLSXReadNode`` so refreshes
produce parquet output with the exact same schema as the initial pipeline run.

Multi-sheet workbooks load the first sheet by default. Pass ``sheet_name`` in
the source config to override (str, int, list, or ``None`` for "all sheets",
in which case sheets are concatenated row-wise with a ``_sheet_name`` column).
"""

import importlib
import logging
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import pandas as pd

from services.connectors.base_connector import BaseConnector, RefreshPolicy
from nodes.dataloader.xlsx_read_node import read_xlsx_to_dataframes

logger = logging.getLogger(__name__)


class XLSXConnector(BaseConnector):
    """
    Connector for Excel workbooks (``.xlsx`` / ``.xlsm`` / ``.xls`` / ``.ods``).

    Features:
    - Sheet selection via ``sheet_name`` config key (default: first sheet).
    - Header / skiprows / usecols / dtype overrides forwarded to ``pd.read_excel``.
    - Auto-detected pandas engine (openpyxl, xlrd, odf).
    - Column names are sanitised to be Python/SQL identifier-safe.
    - Multi-sheet load (``sheet_name=None`` or list) concatenates sheets and
      adds a ``_sheet_name`` column for traceability.

    Excel files are static, so only manual refresh is supported.
    """

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)

        raw_path = Path(config.get("path", ""))
        if raw_path.is_absolute():
            self.xlsx_path = raw_path
        else:
            project_root = Path(__file__).resolve().parents[2]
            self.xlsx_path = project_root / raw_path

        self.sheet_name: Union[str, int, List, None] = config.get("sheet_name", 0)
        self.header = config.get("header", 0)
        self.skiprows = config.get("skiprows")
        self.usecols = config.get("usecols")
        self.dtype = config.get("dtype")
        self.engine = config.get("engine")
        self.read_kwargs: Optional[Dict[str, Any]] = config.get("read_kwargs")
        self.columns_class_path = config.get("columns_class")

        if not self.xlsx_path or not self.xlsx_path.exists():
            logger.warning(
                f"Excel file not found: {self.xlsx_path} — "
                f"connector will rely on parquet cache; fetch_data() will fail "
                f"if the cache is also missing."
            )

        if self.refresh_policy != RefreshPolicy.MANUAL:
            logger.warning(
                f"XLSX connector '{self.source_id}' only supports manual refresh. "
                f"Ignoring configured policy: {self.refresh_policy.value}"
            )
            self.refresh_policy = RefreshPolicy.MANUAL
            self.metadata.refresh_policy = RefreshPolicy.MANUAL

        logger.info(
            f"XLSXConnector initialised: source_id='{self.source_id}', "
            f"path='{self.xlsx_path}', sheet_name='{self.sheet_name}'"
        )

    def fetch_data(
        self, incremental: bool = False, table_id: Optional[str] = None
    ) -> pd.DataFrame:
        """Read the workbook, concatenating multiple sheets when requested.

        ``table_id`` is ignored (XLSX is treated as a single concatenated
        source) but accepted so ``ConnectorManager.refresh_source`` can call
        every connector with the same signature.
        """
        try:
            logger.info(
                f"Reading Excel file: {self.xlsx_path} (sheet={self.sheet_name})"
            )

            sheets = read_xlsx_to_dataframes(
                self.xlsx_path,
                sheet_name=self.sheet_name,
                header=self.header,
                skiprows=self.skiprows,
                usecols=self.usecols,
                dtype=self.dtype,
                engine=self.engine,
                extra_kwargs=self.read_kwargs,
            )

            if not sheets:
                raise ValueError(f"No sheets read from workbook: {self.xlsx_path}")

            if len(sheets) == 1:
                df = next(iter(sheets.values()))
            else:
                tagged = []
                for name, sheet_df in sheets.items():
                    tagged_df = sheet_df.copy()
                    tagged_df["_sheet_name"] = name
                    tagged.append(tagged_df)
                df = pd.concat(tagged, ignore_index=True)

            df["_source_id"] = self.source_id

            self.update_metadata(df, status="success")

            logger.info(
                f"Successfully read XLSX '{self.source_id}': "
                f"{len(df)} rows, {len(df.columns)} columns "
                f"(sheets={list(sheets.keys())})"
            )

            return df

        except FileNotFoundError:
            error_msg = f"Excel file not found: {self.xlsx_path}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise

        except Exception as e:
            error_msg = f"Failed to read Excel file '{self.xlsx_path}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e

    def get_schema(self) -> Dict[str, str]:
        """Return a column → readable-type mapping for the configured sheet."""
        try:
            sheets = read_xlsx_to_dataframes(
                self.xlsx_path,
                sheet_name=self.sheet_name if not isinstance(self.sheet_name, list) else self.sheet_name[0],
                header=self.header,
                skiprows=self.skiprows,
                usecols=self.usecols,
                dtype=self.dtype,
                engine=self.engine,
                extra_kwargs={**(self.read_kwargs or {}), "nrows": 100},
            )

            sample = next(iter(sheets.values())) if sheets else pd.DataFrame()

            schema: Dict[str, str] = {}
            for col in sample.columns:
                dtype = str(sample[col].dtype)
                if "int" in dtype:
                    schema[col] = "integer"
                elif "float" in dtype:
                    schema[col] = "float"
                elif "datetime" in dtype:
                    schema[col] = "datetime"
                elif "bool" in dtype:
                    schema[col] = "boolean"
                elif "object" in dtype:
                    schema[col] = "string"
                else:
                    schema[col] = dtype
            schema["_source_id"] = "string"
            if isinstance(self.sheet_name, (list, type(None))):
                schema["_sheet_name"] = "string"
            return schema

        except Exception as e:
            logger.error(f"Failed to get schema for XLSX '{self.source_id}': {str(e)}")
            return {}

    def validate_connection(self) -> bool:
        """Validate that the workbook exists and at least one sheet is readable."""
        try:
            if not self.xlsx_path.exists():
                logger.error(f"Excel file does not exist: {self.xlsx_path}")
                return False

            file = pd.ExcelFile(str(self.xlsx_path), engine=self.engine)
            sheet_count = len(file.sheet_names)
            if sheet_count == 0:
                logger.error(f"Excel file has no sheets: {self.xlsx_path}")
                return False

            size_mb = self.xlsx_path.stat().st_size / (1024 * 1024)
            logger.info(
                f"XLSX validation successful: {self.xlsx_path} "
                f"({sheet_count} sheet(s), {size_mb:.2f} MB)"
            )
            return True

        except Exception as e:
            logger.error(f"XLSX validation failed for '{self.source_id}': {str(e)}")
            return False

    def supports_incremental(self) -> bool:
        return False

    def get_columns_classes(self):
        """Load ColumnsClasses for this XLSX source.

        Supports two formats (mirrors :class:`QVDConnector`):
        - ``module.path:function_name``  (explicit, preferred)
        - ``module.path``               (auto-resolves ``get_columns_descriptions``)
        """
        if not self.columns_class_path:
            raise ValueError(
                f"XLSX source '{self.source_id}' does not have 'columns_class' configured"
            )

        ref = self.columns_class_path
        if ":" in ref:
            module_path, function_name = ref.split(":", 1)
        else:
            module_path = ref
            function_name = "get_columns_descriptions"

        try:
            module = importlib.import_module(module_path)
            module = importlib.reload(module)
            get_columns_func = getattr(module, function_name)
            return get_columns_func()
        except ImportError as e:
            raise ImportError(
                f"Could not import columns_class module for XLSX '{self.source_id}': {e}"
            )
        except AttributeError as e:
            raise ImportError(
                f"Function '{function_name}' not found in columns_class for XLSX "
                f"'{self.source_id}': {e}"
            )

    def __repr__(self) -> str:
        return (
            f"XLSXConnector(source_id='{self.source_id}', "
            f"path='{self.xlsx_path}', sheet_name='{self.sheet_name}')"
        )
