"""Thin write-path wrapper around the MinIO connector.

The MinIO connector itself is registered as a datasource (read-only fetch
path). For write operations like archiving an uploaded QVD or XLSX we
don't want to depend on whether the user has enabled the `minio_env`
datasource — we just want to talk to the running MinIO using the env
vars already plumbed through docker-compose.

This helper reads ``MINIO_*`` from the environment, builds a fresh
:class:`MinIOConnector` on demand, and exposes ``upload_qvd`` /
``upload_file`` / ``upload_bytes``.

Configuration (env vars, set in `deploy/docker-compose.yml`):

  - MINIO_HOST          (default "minio")
  - MINIO_PORT          (default "9000" — INTERNAL port, not host-mapped)
  - MINIO_ACCESS_KEY    (= MINIO_ROOT_USER)
  - MINIO_SECRET_KEY    (= MINIO_ROOT_PASSWORD)
  - MINIO_BUCKET        (default "brikz")
  - MINIO_SECURE        (default "false")
  - MINIO_QVD_PREFIX    (default "qvd/")
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any, Dict, Optional

from services.connectors.minio_connector import MinIOConnector

logger = logging.getLogger(__name__)


def _env_config() -> Dict[str, Any]:
    return {
        "source_id": "minio_storage",
        "type": "minio",
        "host":       os.environ.get("MINIO_HOST", "minio"),
        "port":       os.environ.get("MINIO_PORT", "9000"),
        "access_key": os.environ.get("MINIO_ACCESS_KEY") or os.environ.get("MINIO_ROOT_USER"),
        "secret_key": os.environ.get("MINIO_SECRET_KEY") or os.environ.get("MINIO_ROOT_PASSWORD"),
        "bucket":     os.environ.get("MINIO_BUCKET", "brikz"),
        "secure":     os.environ.get("MINIO_SECURE", "false"),
    }


def is_configured() -> bool:
    """True when MinIO credentials are available in the env."""
    cfg = _env_config()
    return bool(cfg["access_key"] and cfg["secret_key"] and cfg["bucket"])


def _get_connector() -> Optional[MinIOConnector]:
    """Build a connector from env. Returns None when unconfigured."""
    if not is_configured():
        return None
    try:
        return MinIOConnector(_env_config())
    except Exception as exc:
        logger.warning("MinIO storage unavailable (%s)", exc)
        return None


def qvd_prefix() -> str:
    """Key prefix under which uploaded QVDs are stored."""
    prefix = os.environ.get("MINIO_QVD_PREFIX", "qvd/")
    if not prefix.endswith("/"):
        prefix += "/"
    return prefix


# ── Public upload helpers ───────────────────────────────────────────────────


def upload_file(
    local_path: str,
    object_key: str,
    *,
    content_type: str = "application/octet-stream",
) -> Optional[Dict[str, Any]]:
    """Upload a local file to the configured MinIO bucket.

    Returns the result dict from :meth:`MinIOConnector.upload_file` on
    success, or None when MinIO is unavailable (so callers can degrade
    gracefully — the local copy is still on disk).
    """
    conn = _get_connector()
    if conn is None:
        logger.info("MinIO not configured; skipping upload of %s", local_path)
        return None
    try:
        result = conn.upload_file(local_path, object_key, content_type=content_type)
        logger.info(
            "MinIO upload: %s → s3://%s/%s (%d bytes)",
            local_path, result["bucket"], result["object_key"], result["size"],
        )
        return result
    except Exception as exc:
        logger.warning("MinIO upload failed for %s → %s: %s", local_path, object_key, exc)
        return None


def upload_qvd(
    local_path: str,
    *,
    original_filename: Optional[str] = None,
    source_id: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Archive an uploaded QVD file in MinIO.

    Key layout: ``<MINIO_QVD_PREFIX><source_id>/<original_filename>``
    (or ``<MINIO_QVD_PREFIX><original_filename>`` when ``source_id`` is None).

    The local copy is left in place so the QVD→Parquet pipeline can read it.
    Failures here are logged but never raise — MinIO archiving is a
    best-effort, additive operation.
    """
    name = original_filename or Path(local_path).name
    if source_id:
        object_key = f"{qvd_prefix()}{source_id}/{name}"
    else:
        object_key = f"{qvd_prefix()}{name}"
    return upload_file(local_path, object_key, content_type="application/octet-stream")


def upload_bytes(
    data: bytes,
    object_key: str,
    *,
    content_type: str = "application/octet-stream",
) -> Optional[Dict[str, Any]]:
    """Upload an in-memory blob (used for smaller artefacts)."""
    conn = _get_connector()
    if conn is None:
        return None
    try:
        return conn.put_object(object_key, data, content_type=content_type)
    except Exception as exc:
        logger.warning("MinIO put_object failed for %s: %s", object_key, exc)
        return None


# ── Public delete helpers ───────────────────────────────────────────────────


def parse_minio_url(url: str) -> Optional[Dict[str, str]]:
    """Parse a ``minio://<bucket>/<key>`` URL into its parts.

    Returns ``None`` if *url* isn't a ``minio://`` URL or lacks a key.
    """
    if not url or not isinstance(url, str):
        return None
    if not url.startswith("minio://"):
        return None
    without_scheme = url[len("minio://"):]
    bucket, _, key = without_scheme.partition("/")
    if not bucket or not key:
        return None
    return {"bucket": bucket, "key": key}


def delete_object(
    object_key: str,
    *,
    bucket: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Best-effort removal of a MinIO object.

    Returns the result dict from :meth:`MinIOConnector.remove_object` on
    success, or ``None`` when MinIO is unavailable or the call fails — so
    callers can degrade gracefully (deleting a config row should still
    succeed when MinIO is offline, with the orphan logged for cleanup).

    When *bucket* is given and differs from the env-configured bucket, a
    one-off connector is built against that bucket so we can target the
    actual archive location recorded in the source config.
    """
    if not object_key:
        return None

    cfg = _env_config()
    target_bucket = bucket or cfg["bucket"]

    if bucket and bucket != cfg["bucket"]:
        if not (cfg["access_key"] and cfg["secret_key"]):
            logger.info("MinIO not configured; skipping delete of %s/%s", bucket, object_key)
            return None
        scoped_cfg = {**cfg, "bucket": bucket}
        try:
            conn = MinIOConnector(scoped_cfg)
        except Exception as exc:
            logger.warning("MinIO storage unavailable for bucket %s (%s)", bucket, exc)
            return None
    else:
        conn = _get_connector()
        if conn is None:
            logger.info("MinIO not configured; skipping delete of %s/%s", target_bucket, object_key)
            return None

    try:
        result = conn.remove_object(object_key)
        logger.info("MinIO delete: s3://%s/%s", result["bucket"], result["object_key"])
        return result
    except Exception as exc:
        logger.warning("MinIO remove_object failed for %s/%s: %s", target_bucket, object_key, exc)
        return None


def delete_qvd(
    *,
    minio_key: Optional[str] = None,
    minio_bucket: Optional[str] = None,
    minio_url: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """Best-effort removal of an archived QVD object.

    Accepts either explicit ``minio_bucket``/``minio_key`` (as recorded on
    the source config) or a ``minio://<bucket>/<key>`` URL. Returns the
    delete result, or ``None`` when nothing was attempted/possible.
    """
    bucket = minio_bucket
    key = minio_key

    if (not key) and minio_url:
        parsed = parse_minio_url(minio_url)
        if parsed:
            bucket = bucket or parsed["bucket"]
            key = parsed["key"]

    if not key:
        return None
    return delete_object(key, bucket=bucket)
