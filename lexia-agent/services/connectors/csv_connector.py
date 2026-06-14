"""
CSV Connector for multi-source data architecture.

Simple file-based connector for CSV data sources with configurable parsing options.
When columns_class is configured, applies DTO-based type conversion so parquet
output matches the schema (float columns as float, NaN → 0).
"""

import logging
import importlib
from pathlib import Path
from typing import Dict, Any, List, Optional
import pandas as pd

from services.connectors.base_connector import BaseConnector, RefreshPolicy

logger = logging.getLogger(__name__)


def _apply_dto_types(df: pd.DataFrame, columns_classes) -> pd.DataFrame:
    """
    Apply DTO column types to DataFrame. Float/integer columns are converted
    to numeric; NaN values are replaced with 0.
    """
    df = df.copy()
    for col_def in columns_classes.columns:
        name = col_def.column_name
        if name not in df.columns:
            continue
        col_type = (col_def.type or "").lower()
        if col_type in ("float", "integer"):
            # Handle French decimal format (comma) if still present
            ser = df[name]
            if ser.dtype == object or ser.dtype.name == "string":
                ser = ser.astype(str).str.replace(",", ".", regex=False)
            df[name] = pd.to_numeric(ser, errors="coerce").fillna(0)
            if col_type == "integer":
                df[name] = df[name].astype("int64")
    return df


class CSVConnector(BaseConnector):
    """
    Connector for CSV (Comma-Separated Values) files.

    Features:
    - Configurable delimiter, encoding, and date columns
    - Automatic type inference
    - Support for compressed files (.gz, .zip)
    - Memory-efficient chunked reading for large files

    CSV files are typically static, so only manual refresh is supported.
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize CSV connector.

        Args:
            config: Configuration dictionary with keys:
                - source_id: Unique identifier
                - type: "csv"
                - path: Path to CSV file
                - delimiter: Column delimiter / sep (default: ",")
                - decimal: Decimal separator for numeric columns (default: ".")
                - encoding: File encoding (default: "utf-8")
                - date_columns: List of columns to parse as dates (optional)
                - chunk_size: Chunk size for reading large files (optional)
                - description: Optional description
        """
        super().__init__(config)

        # CSV-specific configuration
        raw_path = Path(config.get("path", ""))
        if raw_path.is_absolute():
            self.csv_path = raw_path
        else:
            # Resolve relative paths from project root for stability across cwd
            project_root = Path(__file__).resolve().parents[2]
            self.csv_path = project_root / raw_path
        self.delimiter = config.get("delimiter", ",")
        self.decimal = config.get("decimal", ".")
        self.encoding = config.get("encoding", "utf-8")
        self.date_columns = config.get("date_columns", [])
        self.chunk_size = config.get("chunk_size")
        self.columns_class_path = config.get("columns_class")

        # Warn if CSV file missing (data may still be available from parquet cache)
        if not self.csv_path or not self.csv_path.exists():
            logger.warning(
                f"CSV file not found: {self.csv_path} — "
                f"connector will rely on parquet cache; fetch_data() will fail if cache is also missing."
            )

        # CSV files only support manual refresh
        if self.refresh_policy != RefreshPolicy.MANUAL:
            logger.warning(
                f"CSV connector '{self.source_id}' only supports manual refresh. "
                f"Ignoring configured policy: {self.refresh_policy.value}"
            )
            self.refresh_policy = RefreshPolicy.MANUAL
            self.metadata.refresh_policy = RefreshPolicy.MANUAL

        logger.info(
            f"CSVConnector initialized: source_id='{self.source_id}', "
            f"path='{self.csv_path}', sep='{self.delimiter}', decimal='{self.decimal}', encoding='{self.encoding}'"
        )

    def fetch_data(
        self, incremental: bool = False, table_id: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Fetch data from CSV file.

        Args:
            incremental: Ignored (CSV files don't support incremental updates)
            table_id: Ignored (CSV is a single-table source); accepted for a
                uniform connector interface so ``ConnectorManager.refresh_source``
                can call every connector the same way.

        Returns:
            DataFrame with data from CSV file, including _source_id column

        Raises:
            FileNotFoundError: If CSV file doesn't exist
            Exception: If reading CSV file fails
        """
        try:
            logger.info(f"Reading CSV file: {self.csv_path}")

            # Prepare read_csv parameters
            read_params = {
                "filepath_or_buffer": self.csv_path,
                "sep": self.delimiter,
                "decimal": self.decimal,
                "encoding": self.encoding,
                "low_memory": False,  # Ensure consistent dtypes
            }

            # Add date parsing if specified
            if self.date_columns:
                read_params["parse_dates"] = self.date_columns
                logger.debug(f"Parsing date columns: {self.date_columns}")

            # Read CSV file
            if self.chunk_size:
                # Chunked reading for large files
                logger.info(f"Reading CSV in chunks of {self.chunk_size} rows")
                chunks = []
                for chunk in pd.read_csv(**read_params, chunksize=self.chunk_size):
                    chunks.append(chunk)
                df = pd.concat(chunks, ignore_index=True)
                logger.info(f"Read {len(chunks)} chunks, total {len(df)} rows")
            else:
                # Read entire file at once
                df = pd.read_csv(**read_params)

            # Apply DTO-based type conversion so parquet matches schema (float/int, NaN→0)
            if self.columns_class_path:
                try:
                    columns_classes = self.get_columns_classes()
                    df = _apply_dto_types(df, columns_classes)
                    logger.debug(f"Applied DTO types for '{self.source_id}'")
                except Exception as e:
                    logger.warning(f"Could not apply DTO types for '{self.source_id}': {e}")

            # Add source identifier column
            df['_source_id'] = self.source_id

            # Update metadata
            self.update_metadata(df, status="success")

            logger.info(
                f"Successfully read CSV '{self.source_id}': "
                f"{len(df)} rows, {len(df.columns)} columns"
            )

            return df

        except FileNotFoundError as e:
            error_msg = f"CSV file not found: {self.csv_path}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise

        except Exception as e:
            error_msg = f"Failed to read CSV file '{self.csv_path}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e

    def get_schema(self) -> Dict[str, str]:
        """
        Get schema information for the CSV file.

        Returns:
            Dictionary mapping column names to data types
        """
        try:
            # Read just the first few rows to infer schema
            df_sample = pd.read_csv(
                self.csv_path,
                sep=self.delimiter,
                decimal=self.decimal,
                encoding=self.encoding,
                nrows=100,
                low_memory=False
            )

            # Build schema dictionary
            schema = {}
            for col in df_sample.columns:
                dtype = str(df_sample[col].dtype)
                # Map pandas dtypes to readable types
                if 'int' in dtype:
                    schema[col] = 'integer'
                elif 'float' in dtype:
                    schema[col] = 'float'
                elif 'datetime' in dtype:
                    schema[col] = 'datetime'
                elif 'bool' in dtype:
                    schema[col] = 'boolean'
                elif 'object' in dtype:
                    schema[col] = 'string'
                else:
                    schema[col] = dtype

            # Add _source_id column
            schema['_source_id'] = 'string'

            return schema

        except Exception as e:
            logger.error(f"Failed to get schema for CSV '{self.source_id}': {str(e)}")
            return {}

    def validate_connection(self) -> bool:
        """
        Validate that the CSV file is accessible and readable.

        Returns:
            True if file exists and is readable
        """
        try:
            # Check if file exists
            if not self.csv_path.exists():
                logger.error(f"CSV file does not exist: {self.csv_path}")
                return False

            # Try to read first line to validate format
            with open(self.csv_path, 'r', encoding=self.encoding) as f:
                first_line = f.readline()
                if not first_line:
                    logger.error(f"CSV file is empty: {self.csv_path}")
                    return False

                # Count columns in header
                num_columns = len(first_line.split(self.delimiter))
                logger.info(
                    f"CSV validation successful: {self.csv_path} "
                    f"({num_columns} columns, {self.csv_path.stat().st_size / (1024*1024):.2f} MB)"
                )

            return True

        except Exception as e:
            logger.error(f"CSV validation failed for '{self.source_id}': {str(e)}")
            return False

    def supports_incremental(self) -> bool:
        """
        CSV files are static and don't support incremental updates.

        Returns:
            False
        """
        return False

    def get_csv_info(self) -> Dict[str, Any]:
        """
        Get detailed information about the CSV file.

        Returns:
            Dictionary with file information
        """
        try:
            stat = self.csv_path.stat()

            # Try to count rows (fast approximation)
            try:
                with open(self.csv_path, 'r', encoding=self.encoding) as f:
                    row_count = sum(1 for _ in f) - 1  # Subtract header
            except Exception:
                row_count = None

            return {
                "source_id": self.source_id,
                "path": str(self.csv_path),
                "size_bytes": stat.st_size,
                "size_mb": round(stat.st_size / (1024 * 1024), 2),
                "modified": stat.st_mtime,
                "delimiter": self.delimiter,
                "decimal": self.decimal,
                "encoding": self.encoding,
                "date_columns": self.date_columns,
                "estimated_rows": row_count,
            }

        except Exception as e:
            logger.error(f"Failed to get CSV info: {str(e)}")
            return {"source_id": self.source_id, "error": str(e)}

    def get_columns_classes(self):
        """
        Load ColumnsClasses for this CSV source.

        Returns:
            ColumnsClasses object for the source

        Raises:
            ValueError: If columns_class not configured
            ImportError: If columns_class module cannot be loaded
        """
        if not self.columns_class_path:
            raise ValueError(
                f"CSV source '{self.source_id}' does not have 'columns_class' configured"
            )

        # Parse module:function path
        # Example: "qclick.classes.charges:get_charges_columns_descriptions"
        try:
            module_path, function_name = self.columns_class_path.split(':')
            module = importlib.import_module(module_path)
            get_columns_func = getattr(module, function_name)
            return get_columns_func()

        except ValueError:
            raise ValueError(
                f"Invalid columns_class format: '{self.columns_class_path}'. "
                "Expected 'module.path:function_name'"
            )
        except ImportError as e:
            raise ImportError(
                f"Could not import columns_class module for CSV '{self.source_id}': {e}"
            )
        except AttributeError as e:
            raise ImportError(
                f"Function not found in columns_class for CSV '{self.source_id}': {e}"
            )

    def __repr__(self) -> str:
        return (
            f"CSVConnector(source_id='{self.source_id}', "
            f"path='{self.csv_path}', delimiter='{self.delimiter}')"
        )
