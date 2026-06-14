"""
MinIO (S3-compatible) connector for multi-source data architecture.

Each "table" maps to an object key inside a single bucket. Supported object
formats are parquet and csv (auto-detected from the key suffix). The connector
streams the object body into pandas — there's no SQL dialect, so the SQL helpers
inherited from BaseConnector are not used.
"""

from __future__ import annotations

import io
import logging
from typing import Any, BinaryIO, Dict, List, Optional

import pandas as pd

try:
    from minio import Minio
    from minio.error import S3Error
except ImportError:
    Minio = None  # type: ignore[assignment]
    S3Error = Exception  # type: ignore[assignment, misc]

from services.connectors.base_connector import BaseConnector

logger = logging.getLogger(__name__)


def _coerce_bool(value: Any, default: bool = False) -> bool:
    """Accept booleans, ints, and the usual stringy truth values."""
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    return str(value).strip().lower() in {"1", "true", "yes", "on", "y", "t"}


class MinIOConnector(BaseConnector):
    """
    Connector for MinIO / any S3-compatible object store.

    Required config:
        host:       endpoint host (no scheme), e.g. "minio.example.com"
        access_key: access key id
        secret_key: secret access key
        bucket:     bucket name
    Optional:
        port:       port number, default 9000
        secure:     bool, default False (use True for HTTPS)
        endpoint:   pre-composed "host:port" — overrides host/port if set
        tables:     list of table configs (table_id, object_key, format)
    """

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)

        if Minio is None:
            raise ImportError(
                "minio is required for MinIO connector. "
                "Install with: pip install minio"
            )

        self.host = config.get("host")
        self.port = config.get("port") or 9000
        self.access_key = config.get("access_key")
        self.secret_key = config.get("secret_key")
        self.bucket = config.get("bucket")
        self.secure = _coerce_bool(config.get("secure"), default=False)

        endpoint_override = config.get("endpoint")
        if endpoint_override:
            # Strip any scheme the user may have pasted in.
            endpoint = str(endpoint_override).strip()
            for prefix in ("https://", "http://"):
                if endpoint.lower().startswith(prefix):
                    endpoint = endpoint[len(prefix):]
                    break
            self.endpoint = endpoint.rstrip("/")
        else:
            if not self.host:
                raise ValueError(
                    f"MinIO connector '{self.source_id}' requires: host (or endpoint)"
                )
            self.endpoint = f"{self.host}:{int(self.port)}"

        if not all([self.access_key, self.secret_key, self.bucket]):
            raise ValueError(
                f"MinIO connector '{self.source_id}' requires: "
                "access_key, secret_key, bucket"
            )

        self.tables = config.get("tables") or []
        # Allow the simple "one bucket, one object" form used by other connectors
        if not self.tables:
            simple_object = config.get("object_key") or config.get("table")
            if simple_object:
                self.tables = [{
                    "table_id": self.source_id,
                    "object_key": simple_object,
                    "format": config.get("format"),
                    "enabled": True,
                    "description": self.metadata.description,
                    "columns_class": None,
                }]

        self._client: Optional[Minio] = None

        logger.info(
            "MinIOConnector initialized: %s (%s, bucket=%s, secure=%s, %s tables)",
            self.source_id, self.endpoint, self.bucket, self.secure, len(self.tables),
        )

    # ------------------------------------------------------------------
    # Connection
    # ------------------------------------------------------------------

    def _get_connection(self) -> "Minio":
        if self._client is None:
            self._client = Minio(
                self.endpoint,
                access_key=self.access_key,
                secret_key=self.secret_key,
                secure=self.secure,
            )
        return self._client

    def _ensure_bucket_exists(self, client: "Minio") -> None:
        """Create the configured bucket on first use when it is missing."""
        if not client.bucket_exists(self.bucket):
            client.make_bucket(self.bucket)
            logger.info(
                "Created MinIO bucket '%s' for source '%s'",
                self.bucket,
                self.source_id,
            )

    def validate_connection(self) -> bool:
        """Reachability check: confirm the bucket exists with the given creds."""
        try:
            client = self._get_connection()
            self._ensure_bucket_exists(client)
            return True
        except Exception as exc:
            logger.error(
                "MinIO connection validation failed for '%s' (endpoint=%s, bucket=%s): %s",
                self.source_id, self.endpoint, self.bucket, exc,
            )
            return False

    # ------------------------------------------------------------------
    # Data fetch
    # ------------------------------------------------------------------

    def fetch_data(
        self,
        incremental: bool = False,
        table_id: Optional[str] = None,
    ) -> Dict[str, pd.DataFrame]:
        client = self._get_connection()
        dataframes: Dict[str, pd.DataFrame] = {}

        for table_config in self.tables:
            if not table_config.get("enabled", True):
                continue
            tid = table_config.get("table_id") or table_config.get("object_key")
            if table_id and tid != table_id:
                continue

            object_key = table_config.get("object_key") or table_config.get("table_name")
            if not object_key:
                logger.warning(
                    "Skipping MinIO table '%s' on '%s' — no object_key configured",
                    tid, self.source_id,
                )
                continue

            try:
                df = self._download_object(client, object_key, table_config.get("format"))
                if df is None or df.empty:
                    logger.info("MinIO object '%s' produced no rows", object_key)
                    continue
                df["_source_id"] = self.source_id
                dataframes[tid] = df
            except Exception as exc:
                logger.error(
                    "Error fetching MinIO object '%s' from '%s': %s",
                    object_key, self.source_id, exc, exc_info=True,
                )

        if not dataframes:
            logger.warning("No MinIO data fetched for source '%s'", self.source_id)
            self.update_metadata(status="success")
            return {}

        self.update_metadata(status="success")
        return dataframes

    def _download_object(
        self,
        client: "Minio",
        object_key: str,
        fmt: Optional[str],
    ) -> pd.DataFrame:
        """Download *object_key* from the bucket and parse into a DataFrame."""
        response = client.get_object(self.bucket, object_key)
        try:
            data = response.read()
        finally:
            response.close()
            response.release_conn()

        chosen_fmt = (fmt or "").lower().strip() or self._detect_format(object_key)
        buffer = io.BytesIO(data)
        if chosen_fmt == "parquet":
            return pd.read_parquet(buffer)
        if chosen_fmt == "csv":
            return pd.read_csv(buffer)
        if chosen_fmt in {"json", "ndjson"}:
            return pd.read_json(buffer, lines=(chosen_fmt == "ndjson"))
        raise ValueError(
            f"Unsupported MinIO object format for key '{object_key}' "
            f"(detected={chosen_fmt!r}). Supported: parquet, csv, json, ndjson."
        )

    @staticmethod
    def _detect_format(object_key: str) -> str:
        lower = object_key.lower()
        if lower.endswith(".parquet"):
            return "parquet"
        if lower.endswith(".csv"):
            return "csv"
        if lower.endswith(".ndjson") or lower.endswith(".jsonl"):
            return "ndjson"
        if lower.endswith(".json"):
            return "json"
        return ""

    # ------------------------------------------------------------------
    # Schema / introspection
    # ------------------------------------------------------------------

    def get_schema(self) -> Dict[str, str]:
        first_table = next((t for t in self.tables if t.get("enabled", True)), None)
        if not first_table:
            return {}
        try:
            df = self._download_object(
                self._get_connection(),
                first_table.get("object_key") or first_table.get("table_name"),
                first_table.get("format"),
            )
        except Exception as exc:
            logger.warning(
                "Could not introspect MinIO schema for '%s': %s",
                self.source_id, exc,
            )
            return {}
        return {col: str(df[col].dtype) for col in df.columns}

    def list_objects(self, prefix: str = "", recursive: bool = True) -> List[str]:
        """Convenience helper: list keys in the configured bucket."""
        client = self._get_connection()
        self._ensure_bucket_exists(client)
        return [obj.object_name for obj in client.list_objects(
            self.bucket, prefix=prefix, recursive=recursive,
        )]

    def list_objects_info(
        self,
        prefix: str = "",
        recursive: bool = True,
    ) -> List[Dict[str, Any]]:
        """List objects with lightweight metadata for UI browsing."""
        client = self._get_connection()
        objects: List[Dict[str, Any]] = []
        for obj in client.list_objects(
            self.bucket,
            prefix=prefix,
            recursive=recursive,
        ):
            last_modified = getattr(obj, "last_modified", None)
            objects.append({
                "object_key": obj.object_name,
                "size": int(getattr(obj, "size", 0) or 0),
                "last_modified": last_modified.isoformat() if last_modified else None,
                "etag": getattr(obj, "etag", None),
                "is_dir": bool(getattr(obj, "is_dir", False)),
            })
        return objects

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    def put_object(
        self,
        object_key: str,
        data: bytes,
        *,
        content_type: str = "application/octet-stream",
    ) -> Dict[str, Any]:
        """Upload raw bytes to the configured bucket under *object_key*.

        Used by ``services.minio_storage`` for archiving uploaded QVD/XLSX
        files alongside the local disk cache.
        """
        client = self._get_connection()
        self._ensure_bucket_exists(client)
        buffer = io.BytesIO(data)
        client.put_object(
            self.bucket,
            object_key,
            buffer,
            length=len(data),
            content_type=content_type,
        )
        return {
            "bucket": self.bucket,
            "object_key": object_key,
            "size": len(data),
            "endpoint": self.endpoint,
        }

    def upload_file(
        self,
        local_path: str,
        object_key: str,
        *,
        content_type: str = "application/octet-stream",
    ) -> Dict[str, Any]:
        """Stream a local file into the bucket. Avoids loading large QVDs in RAM."""
        client = self._get_connection()
        self._ensure_bucket_exists(client)
        client.fput_object(
            self.bucket,
            object_key,
            local_path,
            content_type=content_type,
        )
        import os as _os
        size = _os.path.getsize(local_path)
        return {
            "bucket": self.bucket,
            "object_key": object_key,
            "size": size,
            "endpoint": self.endpoint,
            "local_path": local_path,
        }

    def upload_stream(
        self,
        object_key: str,
        data: BinaryIO,
        length: int,
        *,
        content_type: str = "application/octet-stream",
    ) -> Dict[str, Any]:
        """Stream an already-open file-like object into the bucket."""
        client = self._get_connection()
        client.put_object(
            self.bucket,
            object_key,
            data,
            length=length,
            content_type=content_type,
        )
        return {
            "bucket": self.bucket,
            "object_key": object_key,
            "size": length,
            "endpoint": self.endpoint,
        }

    # ------------------------------------------------------------------
    # Delete
    # ------------------------------------------------------------------

    def remove_object(
        self,
        object_key: str,
        *,
        version_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Remove a single object from the configured bucket.

        S3/MinIO ``DeleteObject`` is idempotent: removing a missing key
        returns success, so callers don't need to pre-check existence.
        Errors (auth, network) propagate to the caller.
        """
        client = self._get_connection()
        client.remove_object(self.bucket, object_key, version_id=version_id)
        return {
            "bucket": self.bucket,
            "object_key": object_key,
            "version_id": version_id,
            "endpoint": self.endpoint,
        }

    def delete_object(self, object_key: str) -> Dict[str, Any]:
        """Delete one object key from the configured bucket.

        Thin alias over :meth:`remove_object` kept for the MinIO
        object-manager routes that expect a ``deleted`` flag on the
        response payload (instead of ``version_id``).
        """
        result = self.remove_object(object_key)
        return {
            "bucket": result["bucket"],
            "object_key": result["object_key"],
            "endpoint": result["endpoint"],
            "deleted": True,
        }

    def supports_incremental(self) -> bool:
        return False

    def __repr__(self) -> str:
        return (
            f"MinIOConnector(source_id='{self.source_id}', "
            f"endpoint='{self.endpoint}', bucket='{self.bucket}', "
            f"secure={self.secure}, tables={len(self.tables)})"
        )
