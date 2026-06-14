"""
QVD Connector for multi-source data architecture.

Wraps the existing QVDReader functionality into the connector interface,
preserving all QVD-specific features (chunked reading, date coercion, etc.).
"""

import importlib
import logging
from pathlib import Path
from typing import Dict, Any, Optional
import pandas as pd

from services.connectors.base_connector import BaseConnector, RefreshPolicy

logger = logging.getLogger(__name__)


def _get_qvd_reader():
    """Lazy import to avoid requiring the legacy package when QVD sources are not used."""
    try:
        from tools.qvd_reader import QVDReader
        return QVDReader
    except ImportError as e:
        raise ImportError(
            "QVD support requires the 'qclick' package. "
            "Install it or disable QVD data sources in config."
        ) from e


class QVDConnector(BaseConnector):
    """
    Connector for QlikView Data (QVD) files.

    Wraps QVDReader to provide:
    - Chunked reading for large files
    - Date coercion (Unix timestamps, Excel dates, date strings)
    - Column name sanitization
    - Parquet caching via CacheManager

    QVD files are static, so only manual refresh is supported.
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize QVD connector.

        Args:
            config: Configuration dictionary with keys:
                - source_id: Unique identifier
                - type: "qvd"
                - path: Path to QVD file. Accepts either:
                        * a local filesystem path (legacy), or
                        * ``minio://<bucket>/<key>`` to lazily download from MinIO
                - minio_bucket, minio_key: optional explicit MinIO source (used
                        when ``path`` is a ``minio://`` URL or left empty).
                - chunk_size: Optional chunk size for reading (default: 100000)
                - description: Optional description
        """
        super().__init__(config)

        raw_path = str(config.get("path", "") or "")
        # Cap the read chunk size: large chunks (e.g. the legacy 100000 default)
        # of a wide QVD materialise huge per-chunk frames and can OOM the
        # container. 20k rows keeps the chunked read memory-bounded regardless
        # of what a source config requests.
        _requested_chunk = int(config.get("chunk_size") or 20000)
        self.chunk_size = max(1, min(_requested_chunk, 20000))

        # MinIO-backed source: lazy download on fetch_data().
        # No filesystem validation at init time — the file may not exist yet
        # (just been uploaded) or live solely in MinIO.
        self._minio_bucket = config.get("minio_bucket")
        self._minio_key = config.get("minio_key")

        if raw_path.startswith("minio://"):
            # minio://<bucket>/<key>
            without_scheme = raw_path[len("minio://"):]
            bucket, _, key = without_scheme.partition("/")
            self._minio_bucket = self._minio_bucket or bucket
            self._minio_key = self._minio_key or key
            self.qvd_path = None
        else:
            self.qvd_path = Path(raw_path) if raw_path else None

        # Only enforce local existence when this is purely a local-path source.
        if not self._minio_key:
            if not self.qvd_path or not self.qvd_path.exists():
                raise FileNotFoundError(f"QVD file not found: {self.qvd_path}")
            self.data_directory = self.qvd_path.parent
            self.filename = self.qvd_path.name
        else:
            # MinIO source — we'll materialise into a tempdir on demand.
            self.data_directory = None
            self.filename = Path(self._minio_key).name

        # Initialize QVDReader (lazy import). For MinIO sources the data
        # directory is set transiently inside fetch_data() because the
        # tempfile location is decided per-call.
        QVDReader = _get_qvd_reader()
        if self.data_directory is not None:
            self.reader = QVDReader(data_directory=str(self.data_directory))
        else:
            self.reader = None  # built per-fetch from the temp download dir

        # QVD files only support manual refresh
        if self.refresh_policy != RefreshPolicy.MANUAL:
            logger.warning(
                f"QVD connector '{self.source_id}' only supports manual refresh. "
                f"Ignoring configured policy: {self.refresh_policy.value}"
            )
            self.refresh_policy = RefreshPolicy.MANUAL
            self.metadata.refresh_policy = RefreshPolicy.MANUAL

        self.columns_class_path = config.get("columns_class", "")

        logger.info(
            f"QVDConnector initialized: source_id='{self.source_id}', "
            f"path='{self.qvd_path}', chunk_size={self.chunk_size}"
        )

    def fetch_data(
        self, incremental: bool = False, table_id: Optional[str] = None
    ) -> pd.DataFrame:
        """
        Fetch data from QVD file.

        Args:
            incremental: Ignored (QVD files don't support incremental updates)
            table_id: Ignored (QVD is a single-table source); accepted for a
                uniform connector interface so ``ConnectorManager.refresh_source``
                can call every connector the same way.

        Returns:
            DataFrame with data from QVD file, including _source_id column

        Raises:
            FileNotFoundError: If QVD file doesn't exist
            Exception: If reading QVD file fails
        """
        import tempfile

        tmpdir_ctx = None
        try:
            # If the QVD lives in MinIO, materialise it into a temporary
            # directory just for the duration of this fetch.
            if self._minio_key:
                tmpdir_ctx = tempfile.TemporaryDirectory(prefix="qvd_dl_")
                local_dir = Path(tmpdir_ctx.name)
                local_file = local_dir / self.filename
                self._download_from_minio(local_file)
                QVDReader = _get_qvd_reader()
                reader = QVDReader(data_directory=str(local_dir))
            else:
                reader = self.reader

            logger.info(f"Fetching data from QVD: {self.filename}")

            # Read QVD file using chunked reading
            df = reader.read_qvd(
                filename=self.filename,
                use_cache=False,  # We handle caching via CacheManager
                chunk_size=self.chunk_size
            )

            # Add source identifier column
            df['_source_id'] = self.source_id

            # Update metadata
            self.update_metadata(df, status="success")

            logger.info(
                f"Successfully fetched {len(df)} rows, {len(df.columns)} columns "
                f"from QVD '{self.source_id}'"
            )

            return df

        except FileNotFoundError as e:
            error_msg = f"QVD file not found: {self.filename}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise

        except Exception as e:
            error_msg = f"Failed to read QVD file '{self.filename}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e
        finally:
            if tmpdir_ctx is not None:
                tmpdir_ctx.cleanup()

    def _download_from_minio(self, target: Path) -> None:
        """Download the configured MinIO object into *target* (local Path).

        Imported lazily so ``minio`` stays an optional dependency for purely
        local QVD sources.
        """
        from services import minio_storage
        from services.connectors.minio_connector import MinIOConnector

        if not self._minio_bucket or not self._minio_key:
            raise RuntimeError(
                f"QVD source '{self.source_id}' has no MinIO key but tried to download"
            )

        cfg = {
            "source_id": f"{self.source_id}__download",
            "type": "minio",
            "host":       minio_storage._env_config()["host"],
            "port":       minio_storage._env_config()["port"],
            "access_key": minio_storage._env_config()["access_key"],
            "secret_key": minio_storage._env_config()["secret_key"],
            "bucket":     self._minio_bucket,
            "secure":     minio_storage._env_config()["secure"],
        }
        conn = MinIOConnector(cfg)
        client = conn._get_connection()
        logger.info(
            "Downloading QVD from MinIO: s3://%s/%s → %s",
            self._minio_bucket, self._minio_key, target,
        )
        target.parent.mkdir(parents=True, exist_ok=True)
        client.fget_object(self._minio_bucket, self._minio_key, str(target))

    def get_schema(self) -> Dict[str, str]:
        """
        Get schema information for the QVD file.

        Returns:
            Dictionary mapping column names to data types
        """
        try:
            # Read just enough data to get schema (use cached if available)
            df = self.reader.read_qvd(
                filename=self.filename,
                use_cache=True,
                chunk_size=self.chunk_size
            )

            # Build schema dictionary
            schema = {}
            for col in df.columns:
                dtype = str(df[col].dtype)
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
            logger.error(f"Failed to get schema for QVD '{self.source_id}': {str(e)}")
            return {}

    def validate_connection(self) -> bool:
        """
        Validate that the QVD file is accessible and readable.

        Returns:
            True if file exists and is readable
        """
        try:
            # Check if file exists
            if self.qvd_path is None or not self.qvd_path.exists():
                logger.error(f"QVD file does not exist: {self.qvd_path}")
                return False

            # Try to get file info without loading all data
            info = self.reader.get_file_info(self.filename)

            logger.info(
                f"QVD validation successful: {self.filename} "
                f"({info.get('num_columns', 0)} columns, "
                f"{info.get('file_size_mb', 0):.2f} MB)"
            )
            return True

        except Exception as e:
            logger.error(f"QVD validation failed for '{self.source_id}': {str(e)}")
            return False

    def supports_incremental(self) -> bool:
        """
        QVD files are static and don't support incremental updates.

        Returns:
            False
        """
        return False

    def get_qvd_info(self) -> Dict[str, Any]:
        """
        Get detailed information about the QVD file.

        Returns:
            Dictionary with file information
        """
        try:
            info = self.reader.get_file_info(self.filename)
            info['source_id'] = self.source_id
            info['chunk_size'] = self.chunk_size
            return info
        except Exception as e:
            logger.error(f"Failed to get QVD info: {str(e)}")
            return {"source_id": self.source_id, "error": str(e)}

    def get_columns_classes(self):
        """Load ColumnsClasses from the configured ``columns_class`` reference.

        Supports two formats:
        - ``module.path:function_name``  (explicit)
        - ``module.path``               (auto-resolves ``get_columns_descriptions``)
        """
        if not self.columns_class_path:
            raise ValueError(
                f"QVD source '{self.source_id}' does not have 'columns_class' configured"
            )

        ref = self.columns_class_path
        if ":" in ref:
            module_path, func_name = ref.split(":", 1)
        else:
            module_path = ref
            func_name = "get_columns_descriptions"

        try:
            mod = importlib.import_module(module_path)
            mod = importlib.reload(mod)
            func = getattr(mod, func_name)
            return func()
        except Exception as e:
            logger.error(
                "Failed to load columns_class for QVD '%s' from '%s': %s",
                self.source_id, ref, e,
            )
            raise ImportError(f"Cannot load columns_class '{ref}': {e}") from e

    def __repr__(self) -> str:
        return (
            f"QVDConnector(source_id='{self.source_id}', "
            f"path='{self.qvd_path}', chunk_size={self.chunk_size})"
        )
