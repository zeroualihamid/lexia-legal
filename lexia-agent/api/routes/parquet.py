"""
Data Management API Routes

Provides endpoints for managing data sources:
- List all sources
- Manual refresh trigger
- Cache invalidation
- Status monitoring
"""

from fastapi import APIRouter, BackgroundTasks, HTTPException, Request, Query, UploadFile, File, Form
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel
from typing import Optional, List, Dict, Any
import asyncio
import logging
import threading
import uuid
import time
import os
import gc
from pathlib import Path
import pandas as pd
import json
import yaml
import re
import csv
from dotenv import dotenv_values, set_key

from services.connector_manager import ConnectorManager
from services.refresh_scheduler import RefreshScheduler
from services.parquet_datasource_map import (
    build_parquet_config_map as _build_parquet_config_map,
    parquet_file_is_enabled,
)
from config import get_settings
from llm.llm_factory import get_llm

logger = logging.getLogger(__name__)

# Create router with /data prefix
parquet_router = APIRouter(prefix="/parquet", tags=["Parquet Management"])


class RefreshRequest(BaseModel):
    """Request model for manual refresh."""
    incremental: bool = False
    force: bool = True


class RefreshResponse(BaseModel):
    """Response model for refresh operations."""
    success: bool
    source_id: str
    message: str
    row_count: Optional[int] = None
    column_count: Optional[int] = None


class SourceTableInfo(BaseModel):
    """Lightweight table descriptor exposed by list_sources."""
    table_id: str
    table_name: Optional[str] = None
    enabled: bool = True
    description: Optional[str] = None
    has_cache: bool = False


class SourceStatus(BaseModel):
    """Response model for source status."""
    source_id: str
    source_type: str
    description: str
    refresh_policy: str
    enabled: bool = True
    last_refresh: Optional[str] = None
    last_refresh_status: str
    row_count: int
    column_count: int
    cache_size_mb: Optional[float] = None
    next_refresh_seconds: Optional[float] = None
    tables: Optional[List[SourceTableInfo]] = None
    download_in_progress: bool = False


class MinIOObjectItem(BaseModel):
    """Object metadata returned by the MinIO browser endpoint."""
    object_key: str
    size: int = 0
    last_modified: Optional[str] = None
    etag: Optional[str] = None
    is_dir: bool = False


class MinIOObjectsResponse(BaseModel):
    source_id: str
    bucket: str
    endpoint: str
    prefix: str = ""
    recursive: bool = True
    count: int
    total_size: int
    objects: List[MinIOObjectItem]


class MinIOObjectMutationResponse(BaseModel):
    success: bool
    source_id: str
    bucket: str
    endpoint: str
    object_key: str
    size: Optional[int] = None
    deleted: bool = False
    message: str


class SourceEnabledPatchRequest(BaseModel):
    enabled: bool


class SQLForeignKeyPayload(BaseModel):
    local_column: str
    ref_table_id: str
    ref_column: str
    ref_source_id: Optional[str] = None
    description: Optional[str] = None
    enabled: bool = True


class SQLTableUpsertPayload(BaseModel):
    table_id: str
    table_name: Optional[str] = None
    query: Optional[str] = None
    columns_class: Optional[str] = None
    incremental_column: Optional[str] = None
    enabled: bool = True
    description: str = ""
    cache_file: Optional[str] = None
    embeddings_file: Optional[str] = None
    foreign_keys: List[SQLForeignKeyPayload] = []


class SQLTableUpsertRequest(BaseModel):
    source_id: str
    table: SQLTableUpsertPayload


class SupabaseSourceCreateRequest(BaseModel):
    source_id: str
    host: str
    port: int = 5432
    database: str
    username: str
    password: str
    db_schema: str = "public"
    description: str = ""
    enabled: bool = True
    refresh_policy: str = "manual"


class OracleConnectorSettingsPayload(BaseModel):
    user: str
    password: str
    host: str
    port: int = 1521
    service_name: str
    enabled: bool = True
    description: str = ""
    source_id: Optional[str] = None


class ColumnSchemaSaveItem(BaseModel):
    column_name: str
    description: str = ""
    type: str = "string"
    is_categorical: bool = False


class ColumnSchemaSaveRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    columns: List[ColumnSchemaSaveItem]


class ColumnSuggestionInput(BaseModel):
    column_name: str
    type: str = "string"
    sample_values: List[str] = []
    current_description: Optional[str] = None
    is_categorical: Optional[bool] = None


class ColumnSuggestionRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    source_description: Optional[str] = None
    columns: List[ColumnSuggestionInput]


class FileDescriptionUpdateRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    description: str


class FileDescriptionGenerateRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None


class CategoricalDistinctRequest(BaseModel):
    source_id: str
    categorical_columns: List[str]
    table_id: Optional[str] = None


class DefinitionItem(BaseModel):
    distinct_value: str
    definitions: List[str]


class SaveDefinitionsRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    column_name: str
    items: List[DefinitionItem]


class RefineDefinitionsRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    column_name: str
    reference_text: str
    items: List[DefinitionItem]


class RefineDefinitionChange(BaseModel):
    distinct_value: str
    action: str  # "add" | "update" | "delete"
    old_definitions: List[str] = []
    new_definitions: List[str] = []


# In-memory job registry for async categorical-distinct runs
_CATEGORICAL_JOBS: Dict[str, Dict[str, Any]] = {}

# In-memory job registry for embedding-agent runs (SSE-capable)
_EMBEDDING_JOBS: Dict[str, Dict[str, Any]] = {}


def _get_connector_manager(request: Request) -> ConnectorManager:
    """Get ConnectorManager from app state."""
    connector_manager = getattr(request.app.state, "connector_manager", None)
    if connector_manager is None:
        raise HTTPException(
            status_code=503,
            detail="ConnectorManager not initialized"
        )
    return connector_manager


def _get_refresh_scheduler(request: Request) -> Optional[RefreshScheduler]:
    """Get RefreshScheduler from app state (may be None)."""
    return getattr(request.app.state, "refresh_scheduler", None)


def _get_parquet_total_rows(path: Path) -> int:
    """Get total row count from parquet metadata without loading full file.

    Checks (in order):
    1. The final parquet file metadata
    2. Part-file checkpoints (.parts/ directory) for in-progress downloads
    3. Live ``_download_jobs`` dict for the running row count
    """
    import pyarrow.parquet as pq

    # 1. Try the final file
    try:
        pf = pq.ParquetFile(path)
        if pf.metadata and pf.metadata.num_rows > 0:
            return pf.metadata.num_rows
    except Exception:
        pass

    # 2. Sum rows from part-file checkpoints
    parts_dir = path.parent / f"{path.stem}.parts"
    if parts_dir.exists():
        total = 0
        for part in sorted(parts_dir.glob("part_*.parquet")):
            try:
                pf = pq.ParquetFile(part)
                total += pf.metadata.num_rows
            except Exception:
                continue
        if total > 0:
            return total

    # 3. Live download job row count
    fname = path.name
    for _jid, _job in _download_jobs.items():
        if _job.get("row_count") and fname.startswith(f"{_job['source_id']}_{_job['table_id']}"):
            return _job["row_count"]

    return 0


def _read_parquet_head(
    path: Path,
    limit: int,
    offset: int = 0,
    columns: Optional[List[str]] = None,
) -> pd.DataFrame:
    """Read a slice from parquet using PyArrow row-level slicing.

    Never loads the full file into memory — reads only the row-groups
    that overlap with [offset, offset+limit) and then slices.  When
    *columns* is provided, only those columns are read (columnar I/O).
    """
    try:
        import pyarrow.parquet as pq

        pf = pq.ParquetFile(path)
        total = pf.metadata.num_rows if pf.metadata else 0
        if offset >= total:
            schema = pf.schema_arrow
            col_names = columns or schema.names
            return pd.DataFrame({col: pd.Series(dtype="object") for col in col_names})

        end = min(offset + limit, total)

        rg_offset = 0
        rg_indices = []
        for i in range(pf.metadata.num_row_groups):
            rg_rows = pf.metadata.row_group(i).num_rows
            rg_end = rg_offset + rg_rows
            if rg_end > offset and rg_offset < end:
                rg_indices.append(i)
            rg_offset = rg_end
            if rg_offset >= end:
                break

        if not rg_indices:
            schema = pf.schema_arrow
            col_names = columns or schema.names
            return pd.DataFrame({col: pd.Series(dtype="object") for col in col_names})

        first_rg_global_offset = 0
        for i in range(rg_indices[0]):
            first_rg_global_offset += pf.metadata.row_group(i).num_rows

        import pyarrow as pa
        tables = [pf.read_row_group(i, columns=columns) for i in rg_indices]
        combined = pa.concat_tables(tables)

        local_start = offset - first_rg_global_offset
        local_end = local_start + (end - offset)
        sliced = combined.slice(local_start, local_end - local_start)
        return sliced.to_pandas()
    except Exception:
        return pd.DataFrame()


def _df_to_json_safe(df: pd.DataFrame) -> List[Dict[str, Any]]:
    """Convert DataFrame to list of dicts, replacing NaN/inf with None for JSON compliance."""
    import numpy as np
    # Replace NaN and inf values with None
    df_clean = df.replace([np.nan, np.inf, -np.inf], None)
    return df_clean.to_dict(orient="records")


def _load_embeddings_parquet(
    path: Path,
    include_vectors: bool = False,
) -> List[Dict[str, Any]]:
    """Load embeddings parquet with selective column reading.

    By default skips ``embedded_values`` (the heaviest column — float vectors)
    to keep the response fast.  Pass *include_vectors=True* when the caller
    actually needs them.
    """
    import pyarrow.parquet as pq

    pf = pq.ParquetFile(path)
    all_cols = [f.name for f in pf.schema_arrow]

    read_cols = [c for c in all_cols if include_vectors or c != "embedded_values"]
    df = pd.read_parquet(path, columns=read_cols, engine="pyarrow")

    def _safe_json(x):
        if not isinstance(x, str) or not x.strip():
            return x
        try:
            return json.loads(x)
        except (json.JSONDecodeError, ValueError):
            return x

    json_cols = ["distinct_values", "distinct_value", "definition_values"]
    if include_vectors:
        json_cols.append("embedded_values")
    for col in json_cols:
        if col in df.columns:
            df[col] = df[col].apply(_safe_json)
    return _df_to_json_safe(df)


def _emb_vector_summary(raw) -> tuple:
    """Return (vector_count, vector_dim) from a parquet embedded_values cell."""
    if not raw:
        return 0, 0
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, json.JSONDecodeError):
            return 0, 0
    if isinstance(raw, list):
        count = len(raw)
        dim = len(raw[0]) if count and isinstance(raw[0], list) else 0
        return count, dim
    return 0, 0


def _len_embedding_vectors_cell(raw: Any) -> int:
    """Return number of embedding vectors stored in one parquet cell (JSON list of vectors)."""
    if raw is None or raw == "":
        return 0
    if isinstance(raw, str):
        try:
            parsed = json.loads(raw)
        except (json.JSONDecodeError, ValueError, TypeError):
            return 0
    elif isinstance(raw, list):
        parsed = raw
    else:
        return 0
    if not isinstance(parsed, list) or len(parsed) == 0:
        return 0
    first = parsed[0]
    # List of vectors: [[float, ...], ...]
    if isinstance(first, list) and (len(first) == 0 or isinstance(first[0], (int, float))):
        return len(parsed)
    # Single flat vector as list of floats
    if isinstance(first, (int, float)):
        return 1
    return len(parsed)


def _count_embedding_vectors_per_column(path: Path) -> Dict[str, int]:
    """Sum vector counts from embedded_values per column_name (reads only two columns)."""
    import pyarrow.parquet as pq

    try:
        pf = pq.ParquetFile(path)
        names = [f.name for f in pf.schema_arrow]
    except Exception as exc:
        logger.warning("Parquet open failed for vector counts %s: %s", path, exc)
        return {}
    if "embedded_values" not in names or "column_name" not in names:
        return {}
    try:
        table = pq.read_table(path, columns=["column_name", "embedded_values"])
    except Exception as exc:
        logger.warning("Could not read embedding vector counts from %s: %s", path, exc)
        return {}
    counts: Dict[str, int] = {}
    for i in range(table.num_rows):
        cname = table["column_name"][i].as_py()
        if cname is None:
            continue
        raw = table["embedded_values"][i].as_py()
        nv = _len_embedding_vectors_cell(raw)
        key = str(cname)
        counts[key] = counts.get(key, 0) + nv
    return counts


def _reembed_rows(
    model,
    rows: list,
    indices: list[int],
) -> int:
    """Re-embed specific rows in-place.

    For each row at the given index, builds texts = [distinct_value] + definitions,
    encodes them, and writes the result back into rows[i]["embedded_values"].
    Returns the number of rows actually re-embedded.
    """
    import numpy as np

    texts_to_encode: list[str] = []
    row_text_ranges: list[tuple[int, int, int]] = []

    for idx in indices:
        row = rows[idx]
        dv = str(row.get("distinct_value") or "")
        raw_defs = row.get("definition_values", "[]")
        try:
            defs = json.loads(raw_defs) if isinstance(raw_defs, str) else []
        except (json.JSONDecodeError, TypeError):
            defs = []
        if not isinstance(defs, list):
            defs = []

        texts_for_row = [dv] + [str(d) for d in defs if d]
        start = len(texts_to_encode)
        texts_to_encode.extend(texts_for_row)
        end = len(texts_to_encode)
        row_text_ranges.append((idx, start, end))

    if not texts_to_encode:
        return 0

    all_vecs = model.encode(texts_to_encode, normalize_embeddings=True, show_progress_bar=False)
    if isinstance(all_vecs, np.ndarray):
        all_vecs = all_vecs.tolist()

    for idx, start, end in row_text_ranges:
        rows[idx]["embedded_values"] = json.dumps(all_vecs[start:end])

    logger.info("Re-embedded %d rows (%d texts)", len(indices), len(texts_to_encode))
    return len(indices)


def _resolve_source_cache_path(
    connector_manager: ConnectorManager,
    source_id: str,
    table_id: Optional[str],
    cache_type: str,
) -> Path:
    """Resolve the cache path for a source, honouring custom cache_file /
    embeddings_file from datasources.yaml before falling back to the
    generic CacheManager naming convention."""
    cfg_settings = get_settings()
    src_cfg = next((s for s in cfg_settings.data_sources if s.source_id == source_id), None)

    custom_path_str: Optional[str] = None
    if src_cfg:
        if table_id and src_cfg.tables:
            tbl = next((t for t in src_cfg.tables if t.table_id == table_id), None)
            if tbl:
                custom_path_str = tbl.embeddings_file if cache_type == "embeddings" else tbl.cache_file
        else:
            custom_path_str = src_cfg.embeddings_file if cache_type == "embeddings" else src_cfg.cache_file

    if custom_path_str:
        p = Path(custom_path_str)
        if p.is_absolute():
            return p
        project_root = Path(__file__).resolve().parents[2]
        cache_dir = project_root / "data" / "parquet"
        if (cache_dir / p.name).exists():
            return cache_dir / p.name
        full = project_root / p
        if full.exists():
            return full
        return cache_dir / p.name

    return connector_manager.cache_manager.get_cache_path(source_id, table_id, cache_type)


def _project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _load_columns_class_types(columns_class_ref: Optional[str]) -> Dict[str, str]:
    """Return ``{sanitized_column_name: dto_type}`` for a columns_class ref."""
    if not columns_class_ref:
        return {}

    import importlib
    import sys

    ref = columns_class_ref
    if ":" in ref:
        module_path, fn_name = ref.split(":", 1)
    else:
        module_path, fn_name = ref, "get_columns_descriptions"

    data_dir = str(_project_root() / "data")
    if data_dir not in sys.path:
        sys.path.insert(0, data_dir)

    try:
        mod = importlib.import_module(module_path)
        columns_classes = getattr(mod, fn_name)()
    except Exception as exc:
        logger.warning("Could not load DTO types from %s: %s", columns_class_ref, exc)
        return {}

    return {
        str(col.column_name): str(col.type).lower()
        for col in getattr(columns_classes, "columns", [])
        if getattr(col, "column_name", None)
    }


def _sanitize_qvd_columns_for_parquet(columns: List[Any]) -> List[str]:
    """Sanitize QVD column names once, matching generated DTO names."""
    from nodes.dataloader.qvd_field_description_node import _sanitize_column_name

    seen: Dict[str, int] = {}
    out: List[str] = []
    for idx, col in enumerate(columns):
        name = _sanitize_column_name(str(col)) or f"column_{idx + 1}"
        count = seen.get(name, 0)
        seen[name] = count + 1
        out.append(name if count == 0 else f"{name}_{count + 1}")
    return out


def _safe_str_value(value: Any):
    if value is None or pd.isna(value):
        return pd.NA
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _coerce_qvd_chunk_for_parquet(
    df: pd.DataFrame,
    *,
    dto_types: Dict[str, str],
) -> pd.DataFrame:
    """Make each QVD chunk match a stable parquet schema.

    ``pyqvd`` can infer different pandas/Arrow types per chunk for the same
    column. Coerce by DTO type where available, and use strings for unknown
    columns so later chunks cannot invalidate the writer schema.
    """
    out = df.copy()
    out.columns = _sanitize_qvd_columns_for_parquet(list(out.columns))

    truthy = {"1", "true", "yes", "y", "on", "oui", "vrai"}
    falsy = {"0", "false", "no", "n", "off", "non", "faux"}

    for col in out.columns:
        dtype = dto_types.get(col, "string")
        series = out[col]

        if dtype == "integer":
            out[col] = pd.to_numeric(series, errors="coerce").astype("Int64")
        elif dtype == "float":
            out[col] = pd.to_numeric(series, errors="coerce").astype("float64")
        elif dtype == "boolean":
            normalized = series.map(
                lambda v: (
                    pd.NA
                    if v is None or pd.isna(v)
                    else str(v).strip().lower()
                )
            )
            out[col] = normalized.map(
                lambda v: True if v in truthy else (False if v in falsy else pd.NA)
            ).astype("boolean")
        elif dtype in {"date", "datetime"}:
            out[col] = pd.to_datetime(series, errors="coerce")
        else:
            out[col] = series.map(_safe_str_value).astype("string")

    return out


def _arrow_schema_for_qvd_chunk(df: pd.DataFrame, dto_types: Dict[str, str]):
    import pyarrow as pa

    fields = []
    for col in df.columns:
        dtype = dto_types.get(col, "string")
        if dtype == "integer":
            arrow_type = pa.int64()
        elif dtype == "float":
            arrow_type = pa.float64()
        elif dtype == "boolean":
            arrow_type = pa.bool_()
        elif dtype in {"date", "datetime"}:
            arrow_type = pa.timestamp("ns")
        else:
            arrow_type = pa.large_string()
        fields.append(pa.field(str(col), arrow_type))
    return pa.schema(fields)


def _normalise_object_columns_to_string(df: pd.DataFrame) -> pd.DataFrame:
    """Promote pandas ``object``-dtype columns to nullable ``StringDtype``.

    pyqvd represents Qlik *dual* columns (a value that has both a numeric
    and a string facet, e.g. status codes stored as ``"1"`` *and* ``1``) as
    ``object`` in chunks that contain mixed cells, but as the underlying
    numeric dtype (``int64``/``float64``) in chunks that happen to be
    homogeneous. Letting Arrow infer types per chunk then causes
    ``pyarrow.lib.ArrowTypeError: Expected a string or bytes dtype, got
    int64`` mid-stream — the writer is locked to the chunk-1 schema but a
    later chunk hands it an incompatible dtype.

    Coercing every ``object`` column to ``StringDtype`` upfront gives a
    deterministic ``pa.large_string()`` Arrow type for those columns across
    *every* chunk while leaving pyqvd's properly-typed numeric/datetime
    columns untouched (no zero-copy regression, fully vectorised).
    """
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].astype("string")
    return df


def _conform_chunk_to_arrow_schema(df: pd.DataFrame, schema: "pa.Schema") -> pd.DataFrame:
    """Cast each column of ``df`` to a pandas dtype compatible with the
    Arrow schema captured from the first chunk.

    This is the second half of the *dual column* fix: even after
    :func:`_normalise_object_columns_to_string` stabilises chunk #1, pyqvd
    may still hand chunk #2 a different dtype for the same column. We
    catch that here with vectorised casts (no per-cell Python) so
    ``pa.Table.from_pandas(df, schema=schema)`` never sees an incompatible
    pair and never blows up mid-conversion.
    """
    import pyarrow as pa

    for field in schema:
        name = field.name
        if name not in df.columns:
            continue
        col = df[name]
        t = field.type
        if pa.types.is_string(t) or pa.types.is_large_string(t):
            if col.dtype.name != "string":
                df[name] = col.astype("string")
        elif pa.types.is_integer(t):
            if not pd.api.types.is_integer_dtype(col):
                df[name] = pd.to_numeric(col, errors="coerce").astype("Int64")
        elif pa.types.is_floating(t):
            if not pd.api.types.is_float_dtype(col):
                df[name] = pd.to_numeric(col, errors="coerce").astype("float64")
        elif pa.types.is_boolean(t):
            if col.dtype.name not in ("bool", "boolean"):
                df[name] = col.astype("boolean")
        elif pa.types.is_timestamp(t):
            if not pd.api.types.is_datetime64_any_dtype(col):
                df[name] = pd.to_datetime(col, errors="coerce")
    return df


_ORACLE_ENV_SOURCE_ID = "oracle_env"
_ORACLE_ENV_KEYS = {
    "user": "ORACLE_USER",
    "password": "ORACLE_PASSWORD",
    "host": "ORACLE_HOST",
    "port": "ORACLE_PORT",
    "service_name": "ORACLE_SERVICE_NAME",
}

_CONNECTOR_PROVIDERS: Dict[str, Dict[str, Any]] = {
    "oracle": {
        "label": "Oracle",
        "source_type": "oracle",
        "default_source_id": "oracle_env",
        "fields": [
            {"key": "user",         "env": "ORACLE_USER",         "label": "User",         "secret": False, "default": ""},
            {"key": "password",     "env": "ORACLE_PASSWORD",     "label": "Password",     "secret": True,  "default": ""},
            {"key": "host",         "env": "ORACLE_HOST",         "label": "Host",         "secret": False, "default": ""},
            {"key": "port",         "env": "ORACLE_PORT",         "label": "Port",         "secret": False, "default": "1521"},
            {"key": "service_name", "env": "ORACLE_SERVICE_NAME", "label": "Service Name", "secret": False, "default": ""},
        ],
    },
    "sqlserver": {
        "label": "SQL Server",
        "source_type": "sqlserver",
        "default_source_id": "sqlserver_env",
        "fields": [
            {"key": "host",     "env": "SQL_SERVER_HOST",     "label": "Host",     "secret": False, "default": ""},
            {"key": "port",     "env": "SQL_SERVER_PORT",     "label": "Port",     "secret": False, "default": "1433"},
            {"key": "user",     "env": "SQL_SERVER_USER",     "label": "User",     "secret": False, "default": ""},
            {"key": "password", "env": "SQL_SERVER_PASSWORD", "label": "Password", "secret": True,  "default": ""},
            {"key": "database", "env": "SQL_SERVER_DATABASE", "label": "Database", "secret": False, "default": ""},
        ],
    },
    "supabase": {
        "label": "Supabase",
        "source_type": "supabase",
        "default_source_id": "supabase_env",
        "fields": [
            {"key": "url",              "env": "SUPABASE_URL",              "label": "Project URL",      "secret": False, "default": ""},
            {"key": "anon_key",         "env": "SUPABASE_ANON_KEY",         "label": "Anon Key",         "secret": True,  "default": ""},
            {"key": "service_role_key", "env": "SUPABASE_SERVICE_ROLE_KEY", "label": "Service Role Key", "secret": True,  "default": ""},
            {"key": "project_id",       "env": "SUPABASE_PROJECT_ID",       "label": "Project ID",       "secret": False, "default": ""},
            {"key": "jwt_secret",       "env": "JWT_SECRET",                "label": "JWT Secret",       "secret": True,  "default": ""},
        ],
    },
    "minio": {
        "label": "MinIO",
        "source_type": "minio",
        "default_source_id": "minio_env",
        "fields": [
            {"key": "host",       "env": "MINIO_HOST",       "label": "Host (base URL, no scheme)", "secret": False, "default": ""},
            {"key": "port",       "env": "MINIO_PORT",       "label": "Port",                       "secret": False, "default": "9000"},
            {"key": "access_key", "env": "MINIO_ACCESS_KEY", "label": "Access Key (login)",         "secret": True,  "default": ""},
            {"key": "secret_key", "env": "MINIO_SECRET_KEY", "label": "Secret Key (password)",      "secret": True,  "default": ""},
            {"key": "bucket",     "env": "MINIO_BUCKET",     "label": "Bucket",                     "secret": False, "default": ""},
            {"key": "secure",     "env": "MINIO_SECURE",     "label": "HTTPS (true/false)",         "secret": False, "default": "false"},
        ],
    },
    "mongodb": {
        "label": "MongoDB",
        "source_type": "mongodb",
        "default_source_id": "mongodb_env",
        "fields": [
            {"key": "uri",        "env": "MONGODB_URI",      "label": "Connection URI", "secret": True,  "default": ""},
            {"key": "host",       "env": "MONGODB_HOST",     "label": "Host",           "secret": False, "default": ""},
            {"key": "port",       "env": "MONGODB_PORT",     "label": "Port",           "secret": False, "default": "27017"},
            {"key": "user",       "env": "MONGODB_USER",     "label": "User",           "secret": False, "default": ""},
            {"key": "password",   "env": "MONGODB_PASSWORD", "label": "Password",       "secret": True,  "default": ""},
            {"key": "database",   "env": "MONGODB_DATABASE", "label": "Database",       "secret": False, "default": ""},
        ],
    },
    "neo4j": {
        "label": "Neo4j",
        "source_type": "neo4j",
        "default_source_id": "neo4j_env",
        "fields": [
            {"key": "uri",      "env": "NEO4J_URI",      "label": "URI (bolt://...)", "secret": False, "default": ""},
            {"key": "user",     "env": "NEO4J_USER",     "label": "User",             "secret": False, "default": "neo4j"},
            {"key": "password", "env": "NEO4J_PASSWORD", "label": "Password",         "secret": True,  "default": ""},
            {"key": "database", "env": "NEO4J_DATABASE", "label": "Database",         "secret": False, "default": "neo4j"},
        ],
    },
}


def _read_provider_env(provider_id: str) -> Dict[str, str]:
    provider = _CONNECTOR_PROVIDERS.get(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")
    env_values = dotenv_values(_env_file_path()) if _env_file_path().exists() else {}
    result: Dict[str, str] = {}
    for field in provider["fields"]:
        raw = env_values.get(field["env"])
        if raw is None:
            raw = os.getenv(field["env"], "")
        result[field["key"]] = _clean_env_value(raw)
    return result


def _write_provider_env(provider_id: str, values: Dict[str, str]) -> None:
    provider = _CONNECTOR_PROVIDERS.get(provider_id)
    if not provider:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")
    env_path = _env_file_path()
    env_path.touch(exist_ok=True)
    for field in provider["fields"]:
        val = values.get(field["key"], "")
        if val:
            set_key(str(env_path), field["env"], val, quote_mode="never")
            os.environ[field["env"]] = val


def _env_file_path() -> Path:
    return _project_root() / ".env"


def _clean_env_value(value: Optional[str]) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in {"'", '"'}:
        text = text[1:-1].strip()
    return text


def _read_oracle_env_settings() -> Dict[str, str]:
    env_values = dotenv_values(_env_file_path()) if _env_file_path().exists() else {}
    settings: Dict[str, str] = {}
    for field_name, env_key in _ORACLE_ENV_KEYS.items():
        raw = env_values.get(env_key)
        if raw is None:
            raw = os.getenv(env_key, "")
        settings[field_name] = _clean_env_value(raw)
    return settings


def _write_oracle_env_settings(payload: OracleConnectorSettingsPayload) -> None:
    env_path = _env_file_path()
    env_path.touch(exist_ok=True)
    values = {
        "ORACLE_USER": payload.user,
        "ORACLE_PASSWORD": payload.password,
        "ORACLE_HOST": payload.host,
        "ORACLE_PORT": str(payload.port),
        "ORACLE_SERVICE_NAME": payload.service_name,
    }
    for key, value in values.items():
        set_key(str(env_path), key, value, quote_mode="never")
        os.environ[key] = value


def _find_managed_oracle_source_config(source_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    config_data = _read_yaml_file(_config_yaml_path())
    data_sources = _ensure_data_sources_list(config_data)
    if source_id:
        return next((s for s in data_sources if s.get("source_id") == source_id), None)

    return (
        next((s for s in data_sources if s.get("source_id") == _ORACLE_ENV_SOURCE_ID), None)
        or next((s for s in data_sources if s.get("type") == "oracle"), None)
    )


def _resolved_parquet_cache_dir() -> Path:
    """Resolve the parquet cache directory.

    ``get_settings()`` returns the YAML-loaded ``Settings`` (from ``config.py``)
    which does **not** expose ``parquet_cache_dir``; that attribute lives on the
    Pydantic settings singleton (``config.settings.settings``). Read it from
    there with a fallback to the conventional ``data/parquet`` location, in
    line with the rest of the codebase (``tools/sql_tool.py``,
    ``api/routes/playground.py``, etc.).
    """
    try:
        from config import settings as _pyd_settings  # type: ignore

        raw = getattr(_pyd_settings, "parquet_cache_dir", None)
    except Exception:
        raw = None
    p = Path(raw) if raw else Path("data/parquet")
    return p if p.is_absolute() else (_project_root() / p)


def _unlink_config_file_path(candidate: str) -> List[str]:
    """Delete a file path from YAML config. Relative paths with subdirs resolve from project root."""
    if not candidate or not str(candidate).strip():
        return []
    raw = str(candidate).strip()
    p = Path(raw)
    if p.is_absolute():
        target = p
        try:
            if target.is_file():
                target.unlink()
                return [str(target)]
        except OSError:
            logger.warning("Could not delete file %s", target, exc_info=True)
        return []

    root = _project_root()
    if len(p.parts) > 1:
        target = root / p
        try:
            if target.is_file():
                target.unlink()
                return [str(target)]
        except OSError:
            logger.warning("Could not delete file %s", target, exc_info=True)
        return []

    name = p.name
    for folder in (_resolved_parquet_cache_dir(), root / "data" / "parquet", root / "data"):
        target = folder / name
        try:
            if target.is_file():
                target.unlink()
                return [str(target)]
        except OSError:
            logger.warning("Could not delete file %s", target, exc_info=True)
    return []


def _config_yaml_path() -> Path:
    # Runtime datasource config is now stored alongside schema metadata.
    return _project_root() / "config" / "datasources.yaml"


def _datasources_yaml_path() -> Path:
    return _project_root() / "config" / "datasources.yaml"


def _read_yaml_file(path: Path) -> Dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(f"YAML file not found: {path}")
    with open(path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def _write_yaml_file(path: Path, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        yaml.safe_dump(data, f, sort_keys=False, allow_unicode=True)


def _ensure_data_sources_list(config_data: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Guarantee config_data['data_sources'] is a list, never None."""
    ds = config_data.get("data_sources")
    if not isinstance(ds, list):
        config_data["data_sources"] = []
    return config_data["data_sources"]


def _detect_csv_delimiter(sample_text: str) -> str:
    candidates = [",", ";", "\t", "|"]
    try:
        dialect = csv.Sniffer().sniff(sample_text, delimiters="".join(candidates))
        return dialect.delimiter
    except Exception:
        lines = [line for line in sample_text.splitlines()[:5] if line.strip()]
        if not lines:
            return ","
        best = max(candidates, key=lambda sep: sum(line.count(sep) for line in lines))
        return best if any(line.count(best) for line in lines) else ","


def _ensure_unique_source_id(config_data: Dict[str, Any], base_source_id: str) -> str:
    existing_ids = {str(src.get("source_id")) for src in _ensure_data_sources_list(config_data)}
    if base_source_id not in existing_ids:
        return base_source_id

    index = 2
    while f"{base_source_id}_{index}" in existing_ids:
        index += 1
    return f"{base_source_id}_{index}"


def _extract_json_block(text: str) -> Any:
    if not text:
        raise ValueError("Empty LLM response")
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        match = re.search(r"(\{.*\}|\[.*\])", cleaned, flags=re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(1))


def _generate_column_description_suggestions(body: ColumnSuggestionRequest) -> List[Dict[str, Any]]:
    settings = get_settings()
    client, _ = get_llm()

    columns_payload = [
        {
            "column_name": col.column_name,
            "type": _normalize_column_type(col.type),
            "sample_values": [str(v) for v in (col.sample_values or [])[:4]],
            "current_description": col.current_description or "",
            "is_categorical": bool(col.is_categorical) if col.is_categorical is not None else None,
        }
        for col in body.columns
    ]

    system_prompt = (
        "You are a data catalog assistant for business datasets. "
        "Write concise, practical French descriptions for columns based on their name, type, and examples. "
        "Return strict JSON only."
    )
    user_prompt = (
        "Generate column metadata suggestions for this dataset.\n"
        f"source_id: {body.source_id}\n"
        f"table_id: {body.table_id or ''}\n"
        f"source_description: {body.source_description or ''}\n"
        "Return JSON with shape:\n"
        '{"columns":[{"column_name":"...","description":"...","is_categorical":true|false}]}\n'
        "Rules:\n"
        "- description in French\n"
        "- 1 short sentence per column\n"
        "- mention business meaning, unit or format when inferable\n"
        "- preserve ambiguity rather than inventing specifics\n"
        "- is_categorical true when values look like labels/codes/categories/statuses\n\n"
        f"columns={json.dumps(columns_payload, ensure_ascii=False)}"
    )

    response = client.chat.completions.create(
        model=settings.llm.model,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        stream=False,
    )

    content = response.choices[0].message.content if response.choices else ""
    payload = _extract_json_block(content or "")
    suggestions = payload.get("columns", []) if isinstance(payload, dict) else payload
    if not isinstance(suggestions, list):
        raise ValueError("Invalid LLM response format for column suggestions")

    normalized: List[Dict[str, Any]] = []
    for item in suggestions:
        if not isinstance(item, dict) or not item.get("column_name"):
            continue
        normalized.append({
            "column_name": str(item.get("column_name")),
            "description": str(item.get("description") or "").strip(),
            "is_categorical": bool(item.get("is_categorical", False)),
        })
    return normalized


def _is_sql_like_source_type(source_type: Optional[str]) -> bool:
    return source_type in {"sqlserver", "supabase", "oracle"}


def _slugify_identifier(text: str) -> str:
    slug = re.sub(r"[^a-zA-Z0-9]+", "_", (text or "").strip()).strip("_").lower()
    if not slug:
        slug = "sql_table"
    if slug[0].isdigit():
        slug = f"t_{slug}"
    return slug


def _normalize_column_type(value: Optional[str]) -> str:
    valid = {"string", "integer", "float", "boolean", "date", "datetime"}
    if not value:
        return "string"
    v = value.strip().lower()
    aliases = {
        "number": "float",
        "double": "float",
        "decimal": "float",
        "numeric": "float",
        "int": "integer",
        "bool": "boolean",
        "timestamp": "datetime",
    }
    v = aliases.get(v, v)
    return v if v in valid else "string"


def _pandas_dtype_to_column_type(dtype_value: Any) -> str:
    dtype = str(dtype_value).lower()
    if "int" in dtype:
        return "integer"
    if "float" in dtype or "double" in dtype or "decimal" in dtype:
        return "float"
    if "datetime" in dtype:
        return "datetime"
    if dtype == "date":
        return "date"
    if "bool" in dtype:
        return "boolean"
    return "string"


def _infer_categorical_default(col_name: str, col_type: str) -> bool:
    if col_type != "string":
        return False
    lowered = (col_name or "").lower()
    tokens = ("code", "status", "type", "categorie", "category", "ville", "client", "pays", "state")
    return any(t in lowered for t in tokens)


def _sql_table_schema_from_connector(request: Request, source_id: str, table_name: str) -> List[Dict[str, str]]:
    connector_manager = _get_connector_manager(request)
    connector = connector_manager.connectors.get(source_id)
    if connector is None:
        raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")
    if not _is_sql_like_source_type(getattr(connector, "source_type", None)):
        raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a SQL-like source")

    if hasattr(connector, "introspect_table_schema"):
        rows = connector.introspect_table_schema(table_name)
        if not rows:
            raise HTTPException(status_code=404, detail=f"No columns found for SQL table '{table_name}'")
        return rows

    try:
        connection = connector._get_connection()  # noqa: SLF001 - internal helper reused for admin scaffolding
        query = """
            SELECT COLUMN_NAME, DATA_TYPE
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION
        """
        cursor = connection.cursor()
        cursor.execute(query, (table_name,))
        rows = cursor.fetchall()
        cursor.close()
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Failed SQL schema introspection for '{source_id}.{table_name}': {e}")
        raise HTTPException(status_code=500, detail=f"SQL schema introspection failed: {e}")

    if not rows:
        raise HTTPException(status_code=404, detail=f"No columns found for SQL table '{table_name}'")

    mapped = []
    for row in rows:
        col_name, sql_type = row[0], str(row[1]).lower()
        if sql_type in ('int', 'bigint', 'smallint', 'tinyint'):
            col_type = 'integer'
        elif sql_type in ('float', 'real', 'decimal', 'numeric', 'money'):
            col_type = 'float'
        elif sql_type in ('datetime', 'datetime2', 'datetimeoffset', 'smalldatetime'):
            col_type = 'datetime'
        elif sql_type == 'date':
            col_type = 'date'
        elif sql_type == 'bit':
            col_type = 'boolean'
        else:
            col_type = 'string'
        mapped.append({"column_name": str(col_name), "type": col_type})
    return mapped


def _dto_module_path_for_table(table_id: str) -> str:
    return f"classes.dtos.{_slugify_identifier(table_id)}_dto"


def _dto_function_name_for_table(table_id: str) -> str:
    return f"get_{_slugify_identifier(table_id)}_columns_descriptions"


def _read_dto_file_description(file_path: Path) -> str:
    """Extract the existing get_file_description() return value from a DTO file.

    Gracefully handles any path that is not under ``/app/data`` (e.g. stale
    references from pre-release layouts) by returning an empty description
    instead of propagating a ``ValueError`` from ``Path.relative_to``.
    """
    if not file_path.exists():
        return ""
    import importlib, sys
    data_root = _project_root() / "data"
    data_dir = str(data_root)
    if data_dir not in sys.path:
        sys.path.insert(0, data_dir)
    try:
        rel = file_path.resolve().relative_to(data_root.resolve())
    except ValueError:
        # File lives outside /app/data — we cannot import it via the DTO
        # namespace; skip silently so the caller can still overwrite it.
        return ""
    module_name = str(rel.with_suffix("")).replace("/", ".").replace("\\", ".")
    try:
        mod = importlib.import_module(module_name)
        if hasattr(mod, "get_file_description"):
            return mod.get_file_description() or ""
    except Exception:
        pass
    return ""


def _resolve_description_for_source(source_cfg) -> str:
    """Resolve a file description from DTO get_file_description(), falling back to YAML."""
    columns_class = None
    if hasattr(source_cfg, "columns_class"):
        columns_class = source_cfg.columns_class
    elif isinstance(source_cfg, dict):
        columns_class = source_cfg.get("columns_class")
    if columns_class:
        cc = str(columns_class)
        module_path = cc.split(":", 1)[0] if ":" in cc else cc
        try:
            fp = _dto_file_path_from_module(module_path)
            desc = _read_dto_file_description(fp)
            if desc:
                return desc
        except Exception:
            pass
    fallback = ""
    if hasattr(source_cfg, "description"):
        fallback = source_cfg.description or ""
    elif isinstance(source_cfg, dict):
        fallback = source_cfg.get("description", "")
    return fallback


def _dto_file_path_from_module(module_path: str) -> Path:
    """Resolve a ``classes.dtos.<slug>_dto`` module to a writable Path.

    DTO files are runtime-mutable (the UI edits column descriptions), so they
    must live under ``/app/data/classes/dtos/`` — NOT under ``/app/classes/``
    which in release builds contains read-only compiled ``.so`` artefacts.
    """
    if module_path.startswith("data.classes.dtos."):
        module_path = module_path[len("data."):]
    if not module_path.startswith("classes.dtos."):
        raise HTTPException(status_code=400, detail="columns_class module must be under classes.dtos")
    rel = Path(*module_path.split(".")).with_suffix(".py")
    data_path = _project_root() / "data" / rel
    data_path.parent.mkdir(parents=True, exist_ok=True)
    return data_path


def _render_dto_file(
    module_table_name: str,
    function_name: str,
    columns: List[Dict[str, Any]],
    file_description: str = "",
) -> str:
    lines = [
        '"""',
        f"Column definitions for {module_table_name}.",
        '"""',
        "",
        "from classes.columns_classes import ColumnClass, ColumnsClasses",
        "",
        "",
        "def get_file_description() -> str:",
        '    """Return the file description and data content meaning."""',
        f"    return {file_description!r}",
        "",
        "",
        f"def {function_name}() -> ColumnsClasses:",
        '    """Auto-generated column definitions. Edit descriptions/categorical flags as needed."""',
        "    return ColumnsClasses(",
        "        columns=[",
    ]

    for col in columns:
        name = str(col.get("column_name", ""))
        description = str(col.get("description") or f"{name} - description à compléter")
        col_type = _normalize_column_type(col.get("type"))
        is_cat = bool(col.get("is_categorical", False))
        lines.extend([
            "            ColumnClass(",
            f"                column_name={name!r},",
            f"                description={description!r},",
            f"                type={col_type!r},",
            f"                is_categorical={is_cat},",
            "            ),",
        ])

    lines.extend([
        "        ]",
        "    )",
        "",
    ])
    return "\n".join(lines)


def _write_dto_for_table(
    table_id: str,
    table_name: str,
    columns: List[Dict[str, Any]],
    file_description: str = "",
) -> str:
    module_path = _dto_module_path_for_table(table_id)
    function_name = _dto_function_name_for_table(table_id)
    file_path = _dto_file_path_from_module(module_path)
    existing_desc = file_description or _read_dto_file_description(file_path)
    content = _render_dto_file(table_name or table_id, function_name, columns, file_description=existing_desc)
    file_path.write_text(content, encoding="utf-8")
    return f"{module_path}:{function_name}"


def _find_sql_table_config(source_id: str, table_id: str) -> Optional[Dict[str, Any]]:
    config_data = _read_yaml_file(_config_yaml_path())
    source_cfg = next((s for s in _ensure_data_sources_list(config_data) if s.get("source_id") == source_id), None)
    if not source_cfg:
        return None
    return next((t for t in (source_cfg.get("tables") or []) if t.get("table_id") == table_id), None)


def _find_source_config(source_id: str) -> Optional[Dict[str, Any]]:
    config_data = _read_yaml_file(_config_yaml_path())
    return next((s for s in _ensure_data_sources_list(config_data) if s.get("source_id") == source_id), None)


def _set_source_columns_class(source_id: str, columns_class_ref: str) -> Dict[str, Any]:
    path = _config_yaml_path()
    config_data = _read_yaml_file(path)
    source_cfg = next((s for s in _ensure_data_sources_list(config_data) if s.get("source_id") == source_id), None)
    if not source_cfg:
        raise HTTPException(status_code=404, detail=f"Source config not found: {source_id}")
    source_cfg["columns_class"] = columns_class_ref
    _write_yaml_file(path, config_data)

    _upsert_source_in_datasources_yaml(source_cfg)

    return source_cfg


def _upsert_source_in_datasources_yaml(source_cfg: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    source_id = source_cfg.get("source_id")
    if not source_id:
        return None

    path = _datasources_yaml_path()
    data = _read_yaml_file(path)
    sources = _ensure_data_sources_list(data)

    existing = next((s for s in sources if s.get("source_id") == source_id), None)

    if existing is not None:
        existing.update(source_cfg)
    else:
        sources.append(dict(source_cfg))

    data["data_sources"] = sources
    data.pop("datasources", None)
    _write_yaml_file(path, data)
    return source_cfg


def _upsert_oracle_source_in_config_yaml(payload: OracleConnectorSettingsPayload) -> Dict[str, Any]:
    path = _config_yaml_path()
    config_data = _read_yaml_file(path)
    data_sources = _ensure_data_sources_list(config_data)

    existing = _find_managed_oracle_source_config(payload.source_id)
    source_id = payload.source_id or (existing or {}).get("source_id") or _ORACLE_ENV_SOURCE_ID
    source_cfg = next((s for s in data_sources if s.get("source_id") == source_id), None)

    next_source = {
        "source_id": source_id,
        "type": "oracle",
        "enabled": bool(payload.enabled),
        "description": payload.description or (source_cfg or {}).get("description") or f"Oracle {payload.service_name}",
        "host": "${ORACLE_HOST}",
        "port": "${ORACLE_PORT}",
        "username": "${ORACLE_USER}",
        "password": "${ORACLE_PASSWORD}",
        "service_name": "${ORACLE_SERVICE_NAME}",
        "refresh_policy": (source_cfg or {}).get("refresh_policy") or "manual",
        "tables": (source_cfg or {}).get("tables") or [],
    }

    if source_cfg is None:
        data_sources.append(next_source)
    else:
        source_cfg.update(next_source)
        next_source = source_cfg

    config_data["data_sources"] = data_sources
    _write_yaml_file(path, config_data)
    _upsert_source_in_datasources_yaml(next_source)
    return next_source


def _sync_runtime_source_registration(request: Request, source_id: str) -> bool:
    connector_manager = getattr(request.app.state, "connector_manager", None)
    if connector_manager is None:
        return False

    if connector_manager.get_connector(source_id) is not None:
        connector_manager.unregister_connector(source_id)

    try:
        cfg_sources = get_settings(reload=True).data_sources
    except Exception:
        logger.warning("Settings reload failed while syncing source '%s'", source_id, exc_info=True)
        cfg_sources = []

    src = next((s for s in cfg_sources if s.source_id == source_id), None)
    if src is None or not src.enabled:
        return False

    from nodes.dataloader.connector_factory_node import _create_connector

    try:
        connector = _create_connector(src)
        if connector_manager.get_connector(source_id) is None:
            connector_manager.register_connector(connector)
        return True
    except Exception as exc:
        logger.warning("Could not register connector for '%s': %s", source_id, exc)
        return False


def _normalize_sql_table_payload(source_id: str, table: SQLTableUpsertPayload) -> Dict[str, Any]:
    table_id = table.table_id.strip()
    if not table_id:
        raise HTTPException(status_code=400, detail="table_id is required")
    if not (table.table_name or table.query):
        raise HTTPException(status_code=400, detail="Provide table_name or query")

    default_cache = f"{source_id}_{table_id}.parquet"
    default_embeddings = f"{source_id}_{table_id}_embeddings.parquet"

    payload = {
        "table_id": table_id,
        "table_name": table.table_name.strip() if table.table_name else None,
        "query": table.query.strip() if table.query else None,
        "columns_class": (table.columns_class.strip() if table.columns_class else None),
        "incremental_column": (table.incremental_column.strip() if table.incremental_column else None),
        "enabled": bool(table.enabled),
        "description": table.description or "",
        "cache_file": (table.cache_file.strip() if table.cache_file else default_cache),
        "embeddings_file": (table.embeddings_file.strip() if table.embeddings_file else default_embeddings),
        "foreign_keys": [
            {
                "local_column": fk.local_column,
                "ref_table_id": fk.ref_table_id,
                "ref_column": fk.ref_column,
                "ref_source_id": fk.ref_source_id,
                "description": fk.description,
                "enabled": bool(fk.enabled),
            }
            for fk in (table.foreign_keys or [])
        ],
    }

    return payload


def _upsert_sql_table_in_config_yaml(source_id: str, table_payload: Dict[str, Any]) -> Dict[str, Any]:
    path = _config_yaml_path()
    config_data = _read_yaml_file(path)
    data_sources = _ensure_data_sources_list(config_data)

    source_cfg = next((s for s in data_sources if s.get("source_id") == source_id), None)
    if not source_cfg:
        raise HTTPException(status_code=404, detail=f"SQL source not found in config/datasources.yaml: {source_id}")
    if not _is_sql_like_source_type(source_cfg.get("type")):
        raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a SQL-like source")

    tables = source_cfg.get("tables") or []
    existing_idx = next((i for i, t in enumerate(tables) if t.get("table_id") == table_payload["table_id"]), None)
    if existing_idx is None:
        tables.append(table_payload)
    else:
        # Preserve unknown fields if already present while updating requested fields
        tables[existing_idx] = {**tables[existing_idx], **table_payload}
    source_cfg["tables"] = tables

    _write_yaml_file(path, config_data)
    return source_cfg


def _upsert_sql_table_in_datasources_yaml(source_id: str, source_cfg: Dict[str, Any], table_payload: Dict[str, Any]) -> Dict[str, Any]:
    """No-op kept for signature compatibility. SQL tables are tracked under
    data_sources[].tables in config.yaml — no separate datasources mirror."""
    table_id = table_payload["table_id"]
    cache_file = table_payload.get("cache_file") or f"{source_id}_{table_id}.parquet"
    embeddings_file = table_payload.get("embeddings_file") or f"{source_id}_{table_id}_embeddings.parquet"

    ds_entry = {
        "source_id": table_id,
        "type": "parquet",
        "enabled": bool(source_cfg.get("enabled", True)) and bool(table_payload.get("enabled", True)),
        "path": f"data/{cache_file}" if not str(cache_file).startswith("data/") else cache_file,
        "embeddings_path": (f"data/{embeddings_file}" if embeddings_file and not str(embeddings_file).startswith("data/") else embeddings_file),
        "columns_class": table_payload.get("columns_class"),
        "description": table_payload.get("description", ""),
        "sql_source_id": source_id,
        "sql_table_name": table_payload.get("table_name"),
        "sql_table_id": table_id,
        "foreign_keys": table_payload.get("foreign_keys", []),
    }

    # Clean up legacy 'datasources' key if present
    path = _datasources_yaml_path()
    data = _read_yaml_file(path)
    if "datasources" in data:
        data.pop("datasources")
        _write_yaml_file(path, data)

    return ds_entry


def _delete_sql_table_from_config_yaml(source_id: str, table_id: str) -> Dict[str, Any]:
    path = _config_yaml_path()
    config_data = _read_yaml_file(path)
    data_sources = _ensure_data_sources_list(config_data)

    source_cfg = next((s for s in data_sources if s.get("source_id") == source_id), None)
    if not source_cfg:
        raise HTTPException(status_code=404, detail=f"SQL source not found in config/datasources.yaml: {source_id}")
    if not _is_sql_like_source_type(source_cfg.get("type")):
        raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a SQL-like source")

    tables = source_cfg.get("tables") or []
    next_tables = [t for t in tables if t.get("table_id") != table_id]
    if len(next_tables) == len(tables):
        raise HTTPException(status_code=404, detail=f"Table not found: {source_id}/{table_id}")

    source_cfg["tables"] = next_tables
    _write_yaml_file(path, config_data)
    return source_cfg


def _delete_sql_table_from_datasources_yaml(source_id: str, table_id: str) -> int:
    """Clean up legacy 'datasources' key if present. Returns removed count."""
    path = _datasources_yaml_path()
    data = _read_yaml_file(path)
    if "datasources" in data:
        datasources = data.pop("datasources")
        removed_count = len([
            ds for ds in datasources
            if ds.get("source_id") == table_id
            or (ds.get("sql_source_id") == source_id and ds.get("sql_table_id") == table_id)
        ])
        _write_yaml_file(path, data)
        return removed_count
    return 0


def _delete_cache_files_for_table(table_cfg: Dict[str, Any], source_id: str, table_id: str) -> List[str]:
    candidates = [
        table_cfg.get("cache_file") or f"{source_id}_{table_id}.parquet",
        table_cfg.get("embeddings_file") or f"{source_id}_{table_id}_embeddings.parquet",
    ]

    deleted: List[str] = []
    for candidate in candidates:
        if not candidate:
            continue
        deleted.extend(_unlink_config_file_path(str(candidate)))

    cache_file = table_cfg.get("cache_file")
    if cache_file:
        root = _project_root()
        deleted.extend(_delete_related_files(root, [Path(cache_file).stem]))

    return deleted


def _delete_source_from_config_yaml(source_id: str) -> Dict[str, Any]:
    path = _config_yaml_path()
    config_data = _read_yaml_file(path)
    data_sources = _ensure_data_sources_list(config_data)
    source_cfg = next((s for s in data_sources if s.get("source_id") == source_id), None)
    if not source_cfg:
        raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")

    config_data["data_sources"] = [s for s in data_sources if s.get("source_id") != source_id]
    _write_yaml_file(path, config_data)
    return source_cfg


def _delete_source_from_datasources_yaml(source_id: str) -> int:
    """Clean up legacy 'datasources' key if present. Returns removed count."""
    path = _datasources_yaml_path()
    data = _read_yaml_file(path)
    if "datasources" in data:
        datasources = data.pop("datasources")
        removed_count = len([ds for ds in datasources if ds.get("source_id") == source_id])
        _write_yaml_file(path, data)
        return removed_count
    return 0


def _delete_dto_file(columns_class: Optional[str]) -> Optional[str]:
    """Delete the DTO .py file referenced by a columns_class string. Returns deleted path or None."""
    if not columns_class:
        return None
    module_path = str(columns_class).split(":", 1)[0] if ":" in str(columns_class) else str(columns_class)
    try:
        file_path = _dto_file_path_from_module(module_path)
        if file_path.exists():
            file_path.unlink()
            return str(file_path)
    except Exception:
        pass
    return None


def _delete_minio_archive(source_cfg: Dict[str, Any]) -> Optional[str]:
    """Remove the MinIO-archived original for a source, if one is recorded.

    QVD sources store their bucket/key on the source config so the
    connector can rehydrate the file on demand. When the user deletes the
    source from the UI we want the archive gone too, otherwise MinIO
    accumulates orphaned objects. Best-effort: a missing/unreachable
    MinIO must not block the rest of the cleanup.
    """
    minio_key = source_cfg.get("minio_key")
    minio_bucket = source_cfg.get("minio_bucket")
    minio_url: Optional[str] = None

    path_val = source_cfg.get("path")
    if path_val and isinstance(path_val, str) and path_val.startswith("minio://"):
        minio_url = path_val

    if not minio_key and not minio_url:
        return None

    try:
        from services import minio_storage as _minio_storage
    except Exception:
        logger.warning("MinIO storage module unavailable; cannot delete archived QVD", exc_info=True)
        return None

    result = _minio_storage.delete_qvd(
        minio_key=minio_key,
        minio_bucket=minio_bucket,
        minio_url=minio_url,
    )
    if not result:
        return None
    return f"s3://{result.get('bucket')}/{result.get('object_key')}"


def _delete_source_files(source_cfg: Dict[str, Any]) -> List[str]:
    deleted: List[str] = []
    root = _project_root()

    for key in ("path", "cache_file", "embeddings_file"):
        candidate = source_cfg.get(key)
        if not candidate:
            continue
        # ``path`` is a ``minio://…`` URL for QVD sources — there's no local
        # file to unlink. The MinIO object is removed below via
        # ``_delete_minio_archive``.
        if key == "path" and isinstance(candidate, str) and candidate.startswith("minio://"):
            continue
        deleted.extend(_unlink_config_file_path(str(candidate)))

    minio_deleted = _delete_minio_archive(source_cfg)
    if minio_deleted:
        deleted.append(minio_deleted)

    dto_deleted = _delete_dto_file(source_cfg.get("columns_class"))
    if dto_deleted:
        deleted.append(dto_deleted)

    for tbl in source_cfg.get("tables") or []:
        if not isinstance(tbl, dict):
            continue
        for key in ("cache_file", "embeddings_file"):
            candidate = tbl.get(key)
            if candidate:
                deleted.extend(_unlink_config_file_path(str(candidate)))
        dto_del = _delete_dto_file(tbl.get("columns_class"))
        if dto_del:
            deleted.append(dto_del)

    stems = _collect_source_stems(source_cfg)
    deleted.extend(_delete_related_files(root, stems))

    return deleted


def _collect_source_stems(source_cfg: Dict[str, Any]) -> List[str]:
    """Derive all possible file stems for a source (used for glob cleanup)."""
    stems: List[str] = []

    sid = source_cfg.get("source_id")
    if sid:
        stems.append(str(sid))

    for key in ("path", "cache_file", "embeddings_file"):
        val = source_cfg.get(key)
        if val:
            stem = Path(val).stem
            stems.append(stem)
            for suffix in ("_distinct", "_embeddings", "_fields"):
                if stem.endswith(suffix):
                    stems.append(stem[: -len(suffix)])

    for tbl in source_cfg.get("tables") or []:
        if not isinstance(tbl, dict):
            continue
        tid = tbl.get("table_id")
        if tid and sid:
            stems.append(f"{sid}_{tid}")
        for key in ("cache_file", "embeddings_file"):
            val = tbl.get(key)
            if val:
                stem = Path(val).stem
                stems.append(stem)
                for suffix in ("_distinct", "_embeddings", "_fields"):
                    if stem.endswith(suffix):
                        stems.append(stem[: -len(suffix)])

    return list(dict.fromkeys(stems))


def _delete_related_files(root: Path, stems: List[str]) -> List[str]:
    """Delete _fields.yaml, _distinct.parquet, and raw source files matching any stem."""
    deleted: List[str] = []
    if not stems:
        return deleted

    search_dirs = [
        root / "data",
        root / "data" / "parquet",
        root / "data" / "raw",
    ]

    suffixes = [
        "_fields.yaml",
        "_distinct.parquet",
        "_embeddings.parquet",
    ]

    for stem in stems:
        for d in search_dirs:
            if not d.is_dir():
                continue
            for suffix in suffixes:
                target = d / f"{stem}{suffix}"
                try:
                    if target.is_file():
                        target.unlink()
                        deleted.append(str(target))
                        logger.info("Deleted related file: %s", target)
                except OSError:
                    logger.warning("Could not delete %s", target, exc_info=True)
            for ext in (".qvd", ".csv", ".parquet"):
                target = d / f"{stem}{ext}"
                try:
                    if target.is_file() and str(target) not in deleted:
                        target.unlink()
                        deleted.append(str(target))
                        logger.info("Deleted related file: %s", target)
                except OSError:
                    logger.warning("Could not delete %s", target, exc_info=True)

    return deleted


def _infer_cache_metadata(filename: str) -> Dict[str, Any]:
    """
    Infer cache metadata from a parquet filename when config isn't available.
    Ensures source_id/table_id/cache_type/enabled are never null.
    """
    stem = Path(filename).stem
    cache_type = "data"
    source_id = stem
    table_id = None

    if stem.endswith("_embeddings"):
        cache_type = "embeddings"
        stem = stem.replace("_embeddings", "")
        source_id = stem
    elif stem.endswith("_data"):
        cache_type = "data"
        stem = stem.replace("_data", "")
        source_id = stem

    # Handle per-table filenames: source_table (or source_table_data)
    if "_" in source_id:
        parts = source_id.split("_")
        if len(parts) >= 2:
            source_id = "_".join(parts[:-1])
            table_id = parts[-1]

    return {
        "source_id": source_id,
        "table_id": table_id,
        "cache_type": cache_type,
        "enabled": False,
    }


def _get_source_row_col_from_cache(
    connector_manager: ConnectorManager,
    src,
) -> tuple:
    """Read row/column counts from parquet metadata without loading the file.

    For multi-table sources (Oracle, SQL Server) the cache file lives at the
    *table* level, so we sum across all enabled tables.
    """
    try:
        import pyarrow.parquet as pq

        cm = connector_manager.cache_manager
        base = Path(cm.base_dir)

        # Multi-table source — sum row counts from each table's parquet file
        tables = getattr(src, "tables", None)
        if tables:
            total_rows = 0
            max_cols = 0
            for tbl in tables:
                if not getattr(tbl, "enabled", True):
                    continue
                cf = getattr(tbl, "cache_file", None) or f"{src.source_id}_{tbl.table_id}.parquet"
                cp = base / cf
                tbl_rows = 0
                # Try final file
                if cp.exists():
                    try:
                        pf = pq.ParquetFile(cp)
                        tbl_rows = pf.metadata.num_rows
                        max_cols = max(max_cols, pf.metadata.num_columns)
                    except Exception:
                        pass
                # Fallback: sum checkpoint part files
                if tbl_rows == 0:
                    parts_dir = base / f"{cp.stem}.parts"
                    if parts_dir.exists():
                        for part in sorted(parts_dir.glob("part_*.parquet")):
                            try:
                                ppf = pq.ParquetFile(part)
                                tbl_rows += ppf.metadata.num_rows
                                max_cols = max(max_cols, ppf.metadata.num_columns)
                            except Exception:
                                continue
                total_rows += tbl_rows
            if total_rows > 0:
                return total_rows, max_cols

        # Single-table / simple source
        cache_file = getattr(src, "cache_file", None)
        if cache_file:
            cp = Path(cache_file)
            if not cp.is_absolute():
                cp = base / cp.name
        else:
            cp = cm.get_cache_path(src.source_id)
        if cp.exists():
            pf = pq.ParquetFile(cp)
            return pf.metadata.num_rows, pf.metadata.num_columns
    except Exception as exc:
        logger.warning(
            "_get_source_row_col_from_cache failed for %s: %s",
            getattr(src, "source_id", "?"),
            exc,
        )
    # Fallback: check live download jobs for in-progress row count
    sid = getattr(src, "source_id", None)
    if sid:
        for _jid, _job in _download_jobs.items():
            if _job["source_id"] == sid and _job.get("row_count"):
                return _job["row_count"], 0
    return 0, 0


def _get_minio_connector(request: Request, source_id: str):
    """Resolve a MinIO connector from runtime state or datasource config."""
    connector_manager = _get_connector_manager(request)
    connector = connector_manager.get_connector(source_id)
    if connector is not None:
        if getattr(connector, "source_type", None) != "minio":
            raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a MinIO source")
        return connector

    cfg_settings = get_settings(reload=True)
    src = next((s for s in cfg_settings.data_sources if s.source_id == source_id), None)
    if src is None:
        raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")
    if src.type != "minio":
        raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a MinIO source")

    from nodes.dataloader.connector_factory_node import _create_connector

    return _create_connector(src)


def _normalize_minio_object_key(raw_key: Optional[str], fallback_name: Optional[str] = None) -> str:
    key = (raw_key or fallback_name or "").strip().replace("\\", "/").lstrip("/")
    if not key:
        raise HTTPException(status_code=400, detail="object_key is required")
    if key.endswith("/"):
        raise HTTPException(status_code=400, detail="object_key must point to a file, not a folder prefix")
    if "\x00" in key:
        raise HTTPException(status_code=400, detail="object_key contains invalid characters")
    if len(key) > 1024:
        raise HTTPException(status_code=400, detail="object_key is too long")
    if any(part == ".." for part in key.split("/")):
        raise HTTPException(status_code=400, detail="object_key cannot contain '..' path segments")
    return key


@parquet_router.get("/sources", response_model=List[SourceStatus])
async def list_sources(request: Request):
    """
    List all data sources from datasources.yaml (including ``enabled: false``).

    The authoritative list comes from the YAML config so that every
    source type (sqlserver, oracle, qvd, csv, supabase …) is returned even
    when the connector failed to register at startup.  Live metadata
    (row_count, cache_size, etc.) is enriched from the in-memory connector
    when available.
    """
    try:
        connector_manager = _get_connector_manager(request)
        refresh_scheduler = _get_refresh_scheduler(request)

        next_refresh_times = {}
        if refresh_scheduler:
            next_refresh_times = refresh_scheduler.get_next_run_times()

        cfg_settings = get_settings()
        cache_dir = connector_manager.cache_manager.base_dir
        sources = []
        for src in cfg_settings.data_sources:
            table_infos = None
            if src.tables:
                table_infos = []
                for tbl in src.tables:
                    cf = tbl.cache_file or f"{src.source_id}_{tbl.table_id}.parquet"
                    has_cache = (cache_dir / cf).exists() if cf else False
                    table_infos.append(SourceTableInfo(
                        table_id=tbl.table_id,
                        table_name=tbl.table_name,
                        enabled=tbl.enabled,
                        description=tbl.description or "",
                        has_cache=has_cache,
                    ))

            connector = connector_manager.connectors.get(src.source_id)
            if connector:
                cache_info = connector_manager.cache_manager.get_cache_info(
                    connector.source_id
                )
                row_count = connector.metadata.row_count
                col_count = connector.metadata.column_count

                if row_count == 0:
                    row_count, col_count = _get_source_row_col_from_cache(
                        connector_manager, src
                    )
                    if row_count > 0:
                        connector.metadata.row_count = row_count
                        connector.metadata.column_count = col_count

                # Check live download jobs for in-progress row count
                if row_count == 0:
                    for _jid, _job in _download_jobs.items():
                        if _job["source_id"] == src.source_id and _job.get("row_count"):
                            row_count = max(row_count, _job["row_count"])

                has_running_download = any(
                    j["source_id"] == src.source_id and j["status"] == "running"
                    for j in _download_jobs.values()
                )
                dto_desc = _resolve_description_for_source(src)
                source_status = SourceStatus(
                    source_id=connector.source_id,
                    source_type=connector.source_type,
                    description=dto_desc or connector.metadata.description,
                    refresh_policy=connector.metadata.refresh_policy.value,
                    enabled=bool(src.enabled),
                    last_refresh=connector.metadata.last_refresh.isoformat() if connector.metadata.last_refresh else None,
                    last_refresh_status=connector.metadata.last_refresh_status,
                    row_count=row_count,
                    column_count=col_count,
                    cache_size_mb=cache_info.get("size_mb") if cache_info else None,
                    next_refresh_seconds=next_refresh_times.get(connector.source_id),
                    tables=table_infos,
                    download_in_progress=has_running_download,
                )
            else:
                row_count, col_count = _get_source_row_col_from_cache(
                    connector_manager, src
                )
                has_running_download = any(
                    j["source_id"] == src.source_id and j["status"] == "running"
                    for j in _download_jobs.values()
                )
                dto_desc = _resolve_description_for_source(src)
                source_status = SourceStatus(
                    source_id=src.source_id,
                    source_type=src.type,
                    description=dto_desc,
                    refresh_policy=src.refresh_policy or "manual",
                    enabled=bool(src.enabled),
                    last_refresh=None,
                    last_refresh_status="disabled" if not src.enabled else "unknown",
                    row_count=row_count,
                    column_count=col_count,
                    cache_size_mb=None,
                    next_refresh_seconds=next_refresh_times.get(src.source_id),
                    tables=table_infos,
                    download_in_progress=has_running_download,
                )
            sources.append(source_status)

        logger.info(f"Listed {len(sources)} data sources")
        return sources

    except Exception as e:
        logger.error(f"Error listing sources: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


_MAX_PAGE_SIZE = 5000

@parquet_router.get("/heads")
async def get_parquet_heads(
    request: Request,
    limit: int = Query(5, ge=1, le=_MAX_PAGE_SIZE, description="Number of rows to return per parquet file"),
    offset: int = Query(0, ge=0, description="Row offset for pagination"),
    include_embeddings: bool = Query(False, description="Include embeddings parquet files"),
):
    """
    Return head rows for each parquet file in the cache directory.

    Only includes files whose ``source_id`` (and table, when applicable) is ``enabled: true``
    in ``datasources.yaml``.
    """
    try:
        connector_manager = _get_connector_manager(request)
        cache_dir = connector_manager.cache_manager.base_dir

        config_map = _build_parquet_config_map()
        results: List[Dict[str, Any]] = []
        for path in sorted(cache_dir.glob("*.parquet")):
            cfg = config_map.get(path.name)
            if not cfg:
                cfg = _infer_cache_metadata(path.name)
            effective_enabled = parquet_file_is_enabled(path.name, config_map)
            cfg = {**cfg, "enabled": effective_enabled}

            is_embeddings = cfg.get("cache_type") == "embeddings" or path.stem.endswith(("_embeddings", "_distinct"))
            if not include_embeddings and is_embeddings:
                continue

            if not effective_enabled:
                continue

            try:
                total_rows = _get_parquet_total_rows(path)
                df_head = _read_parquet_head(path, limit, offset)
                results.append(
                    {
                        "file": path.name,
                        "path": str(path),
                        "source_id": cfg.get("source_id"),
                        "table_id": cfg.get("table_id"),
                        "enabled": cfg.get("enabled"),
                        "cache_type": cfg.get("cache_type"),
                        "rows": _df_to_json_safe(df_head),
                        "columns": list(df_head.columns),
                        "row_count": int(df_head.shape[0]),
                        "column_count": int(df_head.shape[1]),
                        "total_rows": total_rows,
                    }
                )
            except Exception as e:
                results.append(
                    {
                        "file": path.name,
                        "path": str(path),
                        "source_id": cfg.get("source_id"),
                        "table_id": cfg.get("table_id"),
                        "error": str(e),
                        "total_rows": 0,
                        "rows": [],
                        "columns": [],
                        "row_count": 0,
                        "column_count": 0,
                    }
                )

        return {
            "cache_dir": str(cache_dir),
            "limit": limit,
            "offset": offset,
            "include_embeddings": include_embeddings,
            "enabled_only": True,
            "count": len(results),
            "files": results,
        }

    except Exception as e:
        logger.error(f"Error reading parquet heads: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/head")
async def get_parquet_head(
    request: Request,
    file: Optional[str] = Query(None, description="Parquet filename in cache dir (e.g. sql_bambinos_db.parquet)"),
    source_id: Optional[str] = Query(None, description="Source ID to resolve cache path"),
    table_id: Optional[str] = Query(None, description="Table ID for per-table cache (optional)"),
    cache_type: str = Query("data", description="Cache type: data or embeddings"),
    limit: int = Query(5, ge=1, le=_MAX_PAGE_SIZE, description="Number of rows to return"),
    offset: int = Query(0, ge=0, description="Row offset for pagination"),
    column_name: Optional[str] = Query(None, description="Filter embeddings rows by column_name"),
):
    """
    Return head rows for a single parquet file by filename or source_id.
    """
    try:
        if not file and not source_id:
            raise HTTPException(status_code=400, detail="Provide either 'file' or 'source_id'")

        connector_manager = _get_connector_manager(request)
        cache_dir = connector_manager.cache_manager.base_dir
        config_map = _build_parquet_config_map()

        if file:
            safe_name = Path(file).name
            if safe_name != file:
                raise HTTPException(status_code=400, detail="Invalid file name")
            path = cache_dir / safe_name
        else:
            if cache_type not in {"data", "embeddings"}:
                raise HTTPException(status_code=400, detail="cache_type must be 'data' or 'embeddings'")
            path = _resolve_source_cache_path(connector_manager, source_id, table_id, cache_type)

        if not path.exists():
            # For embeddings caches, treat "source registered but file missing"
            # as a normal empty state rather than 404 — this avoids spamming
            # the frontend / log with 404s for sources that haven't been
            # embedded yet (e.g. fresh XLSX uploads with our explicit
            # no-auto-embedding policy).
            if cache_type == "embeddings" and source_id:
                cfg_settings = get_settings()
                source_registered = (
                    connector_manager.get_connector(source_id) is not None
                    or any(s.source_id == source_id for s in cfg_settings.data_sources)
                )
                if source_registered:
                    return {
                        "file": path.name,
                        "path": str(path),
                        "source_id": source_id,
                        "table_id": table_id,
                        "cache_type": cache_type,
                        "enabled": True,
                        "rows": [],
                        "columns": [],
                        "row_count": 0,
                        "column_count": 0,
                        "total_rows": 0,
                        "offset": offset,
                        "embeddings_status": "not_generated",
                        "message": (
                            "Embeddings have not been generated for this source yet."
                        ),
                    }
            raise HTTPException(status_code=404, detail=f"Parquet not found: {path.name}")

        total_rows = _get_parquet_total_rows(path)

        # For embeddings parquet, skip the heavy embedded_values column —
        # it contains large float-vector JSON strings (multi-MB for 500
        # rows) that freeze the browser.  We compute lightweight
        # vector_count / vector_dim summaries instead.
        is_emb_file = (
            cache_type == "embeddings"
            or path.stem.endswith(("_embeddings", "_distinct"))
        )

        if is_emb_file:
            import pyarrow.parquet as pq

            pf = pq.ParquetFile(path)
            all_col_names = [f.name for f in pf.schema_arrow]
            has_emb_col = "embedded_values" in all_col_names
            light_cols = [c for c in all_col_names if c != "embedded_values"]

            if column_name and "column_name" in all_col_names:
                # Read the full column_name + light columns, filter, then
                # slice — so the caller always gets rows for the requested
                # column regardless of storage order.
                df_all_light = pd.read_parquet(path, columns=light_cols, engine="pyarrow")
                mask = df_all_light["column_name"] == column_name
                df_head = df_all_light.loc[mask].iloc[offset:offset + limit].reset_index(drop=True)

                if has_emb_col:
                    df_all_emb = pd.read_parquet(path, columns=["embedded_values"], engine="pyarrow")
                    df_emb_filtered = df_all_emb.loc[mask].iloc[offset:offset + limit].reset_index(drop=True)
                    summaries = df_emb_filtered["embedded_values"].apply(_emb_vector_summary)
                    df_head["vector_count"] = [s[0] for s in summaries]
                    df_head["vector_dim"] = [s[1] for s in summaries]
                else:
                    df_head["vector_count"] = 0
                    df_head["vector_dim"] = 0

                total_rows = int(mask.sum())
            else:
                df_head = _read_parquet_head(path, limit, offset, columns=light_cols if has_emb_col else None)

                if has_emb_col:
                    df_emb_only = _read_parquet_head(path, limit, offset, columns=["embedded_values"])
                    summaries = df_emb_only["embedded_values"].apply(_emb_vector_summary)
                    df_head["vector_count"] = [s[0] for s in summaries]
                    df_head["vector_dim"] = [s[1] for s in summaries]
                else:
                    df_head["vector_count"] = 0
                    df_head["vector_dim"] = 0
        else:
            df_head = _read_parquet_head(path, limit, offset)

        cfg = config_map.get(path.name)
        if not cfg:
            cfg = _infer_cache_metadata(path.name)
        effective_enabled = parquet_file_is_enabled(path.name, config_map)
        cfg = {**cfg, "enabled": effective_enabled}
        return {
            "file": path.name,
            "path": str(path),
            "source_id": cfg.get("source_id", source_id),
            "table_id": cfg.get("table_id", table_id),
            "cache_type": cfg.get("cache_type", cache_type),
            "enabled": cfg.get("enabled"),
            "rows": _df_to_json_safe(df_head),
            "columns": list(df_head.columns),
            "row_count": int(df_head.shape[0]),
            "column_count": int(df_head.shape[1]),
            "total_rows": total_rows,
            "offset": offset,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading parquet head: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


def _find_existing_parquet(
    connector_manager: ConnectorManager,
    source_id: str,
    table_id: Optional[str],
) -> list[str]:
    """Return a list of existing parquet filenames that would be overwritten by
    a refresh for the given source (and optional table)."""
    parquet_dir = _project_root() / "data" / "parquet"
    existing: list[str] = []
    if table_id:
        candidates = [f"{source_id}_{table_id}.parquet"]
    else:
        cfg = get_settings()
        src = next((s for s in cfg.data_sources if s.source_id == source_id), None)
        if src and src.tables:
            candidates = [
                f"{source_id}_{t.table_id}.parquet"
                for t in src.tables if t.enabled
            ]
        else:
            candidates = [f"{source_id}.parquet"]
    for fname in candidates:
        if (parquet_dir / fname).exists():
            existing.append(fname)
    return existing


@parquet_router.post("/refresh/{source_id}")
async def refresh_source(
    source_id: str,
    request: Request,
    incremental: bool = Query(False, description="Perform incremental refresh if supported"),
    force: bool = Query(True, description="Force refresh even if not needed per policy"),
    table_id: Optional[str] = Query(None, description="Download only this specific table"),
    confirm_overwrite: bool = Query(False, description="Must be true to overwrite existing parquet files"),
):
    """
    Manually trigger a refresh for a specific data source.

    When ``table_id`` is provided the heavy fetch runs in a background thread
    and a ``job_id`` is returned immediately so the frontend can poll
    ``GET /parquet/download/{job_id}`` for progress.

    If existing parquet files are found and ``confirm_overwrite`` is not set,
    returns a 409 response asking the user to confirm before overwriting.
    """
    try:
        connector_manager = _get_connector_manager(request)

        connector = connector_manager.get_connector(source_id)
        if connector is None:
            raise HTTPException(
                status_code=404,
                detail=f"Source not found: {source_id}"
            )

        # ── Guard: require explicit confirmation to overwrite existing parquet ──
        if not confirm_overwrite:
            existing_files = _find_existing_parquet(connector_manager, source_id, table_id)
            if existing_files:
                return JSONResponse(
                    status_code=409,
                    content={
                        "needs_confirmation": True,
                        "source_id": source_id,
                        "table_id": table_id,
                        "existing_files": existing_files,
                        "message": (
                            f"Les fichiers parquet suivants seront écrasés : "
                            f"{', '.join(existing_files)}. "
                            f"Confirmez-vous le rafraîchissement ?"
                        ),
                    },
                )

        # ── Single-table download → background job ──────────────────────
        if table_id:
            job_id = f"dl-{uuid.uuid4().hex[:12]}"
            _download_jobs[job_id] = {
                "status": "running",
                "source_id": source_id,
                "table_id": table_id,
                "started_at": time.time(),
                "finished_at": None,
                "row_count": None,
                "error": None,
            }

            def _bg_download():
                job = _download_jobs[job_id]
                try:
                    # Guard: refuse to start if a download is already running
                    if getattr(connector, "_refreshing", False):
                        job["status"] = "failed"
                        job["error"] = "A download is already in progress for this source."
                        return

                    logger.info(
                        "Background download started: source=%s table=%s job=%s",
                        source_id, table_id, job_id,
                    )
                    ok = connector_manager.refresh_source(
                        source_id,
                        incremental=incremental,
                        force=force,
                        table_id=table_id,
                        update_embeddings=False,
                    )
                    if ok:
                        job["status"] = "completed"
                        job["row_count"] = getattr(connector.metadata, "row_count", None)
                        logger.info("Background download completed: job=%s rows=%s", job_id, job["row_count"])
                    else:
                        job["status"] = "failed"
                        job["error"] = getattr(connector.metadata, "last_error", "unknown error")
                except Exception as exc:
                    logger.error("Background download failed: job=%s %s", job_id, exc, exc_info=True)
                    job["status"] = "failed"
                    job["error"] = str(exc)
                finally:
                    job["finished_at"] = time.time()

            loop = asyncio.get_event_loop()
            loop.run_in_executor(None, _bg_download)

            return {
                "success": True,
                "source_id": source_id,
                "table_id": table_id,
                "job_id": job_id,
                "message": f"Download started for table '{table_id}'. Poll /parquet/download/{job_id} for status.",
            }

        # ── Guard: refuse if a download is already running on this source ──
        for _jid, _job in _download_jobs.items():
            if _job["source_id"] == source_id and _job["status"] == "running":
                return RefreshResponse(
                    success=False,
                    source_id=source_id,
                    message=f"Impossible de rafraîchir '{source_id}' — téléchargement en cours (job {_jid}).",
                )

        # ── Full-source refresh (non-blocking via executor) ───────────────
        logger.info(
            f"Manual refresh triggered for '{source_id}' "
            f"(incremental={incremental}, force={force})"
        )

        loop = asyncio.get_event_loop()
        try:
            success = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: connector_manager.refresh_source(
                        source_id,
                        incremental=incremental,
                        force=force,
                    ),
                ),
                timeout=120.0,
            )
        except asyncio.TimeoutError:
            return RefreshResponse(
                success=False,
                source_id=source_id,
                message=f"Refresh timed out for '{source_id}' after 120s",
            )

        if success:
            return RefreshResponse(
                success=True,
                source_id=source_id,
                message=f"Successfully refreshed '{source_id}'",
                row_count=connector.metadata.row_count,
                column_count=connector.metadata.column_count,
            )
        else:
            message = f"Refresh failed for '{source_id}'"
            if connector.metadata.last_error:
                message += f": {connector.metadata.last_error}"
            return RefreshResponse(
                success=False,
                source_id=source_id,
                message=message,
            )

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error refreshing source '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/download/{job_id}")
async def get_download_status(job_id: str):
    """Poll the status of a background table-download job."""
    job = _download_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Download job not found: {job_id}")
    elapsed = None
    if job["started_at"]:
        end = job["finished_at"] or time.time()
        elapsed = round(end - job["started_at"], 1)
    return {
        "job_id": job_id,
        "status": job["status"],
        "source_id": job["source_id"],
        "table_id": job["table_id"],
        "row_count": job.get("row_count"),
        "error": job.get("error"),
        "elapsed_seconds": elapsed,
    }


@parquet_router.get("/status/{source_id}")
async def get_source_status(source_id: str, request: Request):
    """
    Get detailed status information for a specific source.

    Args:
        source_id: Identifier of the source

    Returns:
        Detailed status dictionary including connector metadata and cache info
    """
    try:
        connector_manager = _get_connector_manager(request)

        # Check if source exists
        connector = connector_manager.get_connector(source_id)
        if connector is None:
            raise HTTPException(
                status_code=404,
                detail=f"Source not found: {source_id}"
            )

        # Get full status from connector manager
        status = connector_manager.get_status(source_id)

        # Add scheduler info if available
        refresh_scheduler = _get_refresh_scheduler(request)
        if refresh_scheduler:
            next_run_times = refresh_scheduler.get_next_run_times()
            status["next_refresh_seconds"] = next_run_times.get(source_id)

        return status

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error getting status for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.delete("/cache/{source_id}")
async def invalidate_cache(
    source_id: str,
    request: Request,
    cache_type: Optional[str] = Query(None, description="Cache type: 'data', 'embeddings', or null for both")
):
    """
    Invalidate cache for a specific source.

    Args:
        source_id: Identifier of the source
        cache_type: Type of cache to invalidate ('data', 'embeddings', or null for both)

    Returns:
        Success message
    """
    try:
        connector_manager = _get_connector_manager(request)

        # Check if source exists
        connector = connector_manager.get_connector(source_id)
        if connector is None:
            raise HTTPException(
                status_code=404,
                detail=f"Source not found: {source_id}"
            )

        # Invalidate cache
        connector_manager.invalidate_cache(source_id, cache_type)

        message = f"Cache invalidated for '{source_id}'"
        if cache_type:
            message += f" (type: {cache_type})"

        logger.info(message)

        return {
            "success": True,
            "source_id": source_id,
            "message": message
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error invalidating cache for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/scheduler/status")
async def get_scheduler_status(request: Request):
    """
    Get refresh scheduler status.

    Returns:
        Scheduler status including registered sources and next run times
    """
    try:
        refresh_scheduler = _get_refresh_scheduler(request)

        if refresh_scheduler is None:
            return {
                "enabled": False,
                "message": "Refresh scheduler not initialized"
            }

        status = refresh_scheduler.get_status()
        status["enabled"] = True

        return status

    except Exception as e:
        logger.error(f"Error getting scheduler status: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/embeddings/stats")
async def get_embeddings_stats(
    request: Request,
    source_id: Optional[str] = Query(None, description="Specific source ID (null for all)")
):
    """
    Get embedding statistics for sources.

    Args:
        source_id: Specific source (None for all sources)

    Returns:
        Embedding statistics
    """
    try:
        connector_manager = _get_connector_manager(request)
        stats = connector_manager.get_embedding_stats(source_id)

        return stats

    except Exception as e:
        logger.error(f"Error getting embedding stats: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/embeddings/search")
async def search_embeddings(
    request: Request,
    query: str = Query(..., description="Search query text"),
    source_ids: Optional[List[str]] = Query(None, description="List of source IDs to search (null for all)"),
    column_name: Optional[str] = Query(None, description="Specific column name (null for all categorical columns)"),
    threshold: float = Query(0.6, description="Minimum similarity threshold (0-1)"),
    top_k: int = Query(10, description="Maximum results per source")
):
    """
    Search for similar values across multiple sources using embeddings.

    Args:
        query: Search query text
        source_ids: List of source IDs to search (None for all)
        column_name: Specific column name (None for all categorical columns)
        threshold: Minimum similarity threshold (0-1)
        top_k: Maximum number of results per source

    Returns:
        List of similar values with similarity scores
    """
    try:
        connector_manager = _get_connector_manager(request)

        results = connector_manager.search_values_across_sources(
            query=query,
            source_ids=source_ids,
            column_name=column_name,
            threshold=threshold,
            top_k=top_k
        )

        logger.info(
            f"Embedding search for '{query}' returned {len(results)} results"
        )

        return {
            "query": query,
            "threshold": threshold,
            "top_k": top_k,
            "total_results": len(results),
            "results": results
        }

    except Exception as e:
        logger.error(f"Error searching embeddings: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/embeddings/column-search")
async def column_embedding_search(
    request: Request,
    query: str = Query(..., description="Text to embed and compare"),
    source_id: str = Query(..., description="Source ID (used to locate the parquet file)"),
    column_name: str = Query(..., description="Column name to search within"),
    table_id: Optional[str] = Query(None, description="Table ID for multi-table sources"),
    threshold: float = Query(0.15, description="Minimum cosine similarity (0-1)"),
    top_k: int = Query(30, description="Max results to return"),
):
    """Embed the user query on-the-fly and compare against pre-computed
    embeddings stored in ``*_embeddings.parquet`` for a specific column.

    Returns results sorted by descending similarity with confidence scores.
    """
    import numpy as np

    model = getattr(request.app.state, "embedding_model", None)
    if model is None:
        raise HTTPException(status_code=503, detail="Embedding model not loaded yet")

    connector_manager = getattr(request.app.state, "connector_manager", None)
    if connector_manager is None:
        raise HTTPException(status_code=503, detail="Connector manager not available")

    try:
        cache_path = _resolve_source_cache_path(
            connector_manager, source_id, table_id, "embeddings"
        )
    except Exception:
        cache_path = None

    if cache_path is None or not cache_path.exists():
        raise HTTPException(status_code=404, detail=f"No embeddings parquet found for source={source_id}")

    try:
        df = pd.read_parquet(cache_path)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read embeddings parquet: {exc}")

    if "column_name" not in df.columns or "distinct_value" not in df.columns:
        raise HTTPException(
            status_code=500,
            detail=f"Unexpected parquet schema: {list(df.columns)}",
        )

    col_df = df[df["column_name"] == column_name]
    if col_df.empty:
        return {
            "query": query,
            "column_name": column_name,
            "total_results": 0,
            "results": [],
            "message": f"No embeddings found for column '{column_name}'",
        }

    query_vec = model.encode(query, normalize_embeddings=True)
    query_vec = np.asarray(query_vec, dtype=np.float32)

    results = []
    for _, row in col_df.iterrows():
        dv = row.get("distinct_value", "")
        raw_emb = row.get("embedded_values")
        raw_defs = row.get("definition_values")

        if not isinstance(raw_emb, str):
            continue
        try:
            emb_list = json.loads(raw_emb)
        except (json.JSONDecodeError, TypeError):
            continue

        try:
            defs = json.loads(raw_defs) if isinstance(raw_defs, str) else []
        except (json.JSONDecodeError, TypeError):
            defs = []

        if not isinstance(emb_list, list) or len(emb_list) == 0:
            continue

        # emb_list[0] = embedding of the distinct_value name
        # emb_list[1:] = embeddings of definition texts
        # Definitions carry richer semantic meaning, so we weight them higher
        NAME_WEIGHT = 0.3
        DEF_WEIGHT = 0.7

        all_sims = []
        for vec in emb_list:
            if not isinstance(vec, list) or len(vec) == 0:
                all_sims.append(-1.0)
                continue
            v = np.asarray(vec, dtype=np.float32)
            norm = np.linalg.norm(v)
            if norm > 0:
                v = v / norm
            all_sims.append(float(np.dot(query_vec, v)))

        name_sim = all_sims[0] if len(all_sims) > 0 else -1.0
        def_sims = [s for s in all_sims[1:] if s > -1.0]
        best_def_sim = max(def_sims) if def_sims else name_sim

        combined_sim = NAME_WEIGHT * name_sim + DEF_WEIGHT * best_def_sim

        if combined_sim >= threshold:
            results.append({
                "distinct_value": dv,
                "column_name": column_name,
                "similarity": round(combined_sim, 4),
                "name_similarity": round(name_sim, 4),
                "definition_similarity": round(best_def_sim, 4),
                "definitions": defs if isinstance(defs, list) else [],
                "source_id": source_id,
            })

    results.sort(key=lambda r: r["similarity"], reverse=True)
    results = results[:top_k]

    logger.info(
        "column-search '%s' on %s.%s → %d results (threshold=%.2f)",
        query, source_id, column_name, len(results), threshold,
    )

    return {
        "query": query,
        "column_name": column_name,
        "threshold": threshold,
        "total_results": len(results),
        "results": results,
    }


@parquet_router.get("/health")
async def data_health(request: Request):
    """
    Health check for data management system.

    Returns:
        Health status with counts and basic info
    """
    try:
        connector_manager = _get_connector_manager(request)
        refresh_scheduler = _get_refresh_scheduler(request)

        # Count sources by status
        total_sources = len(connector_manager.connectors)
        sources_ok = sum(
            1 for c in connector_manager.connectors.values()
            if c.metadata.last_refresh_status == "success"
        )
        sources_error = sum(
            1 for c in connector_manager.connectors.values()
            if c.metadata.last_refresh_status == "error"
        )

        # Count sources with embeddings
        sources_with_embeddings = len(connector_manager.embedding_manager.source_columns)

        return {
            "status": "healthy" if sources_error == 0 else "degraded",
            "total_sources": total_sources,
            "sources_ok": sources_ok,
            "sources_error": sources_error,
            "sources_with_embeddings": sources_with_embeddings,
            "scheduler_running": refresh_scheduler.running if refresh_scheduler else False,
            "scheduled_sources": len(refresh_scheduler.scheduled_jobs) if refresh_scheduler else 0,
        }

    except Exception as e:
        logger.error(f"Health check failed: {str(e)}")
        return {
            "status": "unhealthy",
            "error": str(e)
        }


@parquet_router.get("/columns/embeddings")
async def get_column_embeddings(
    request: Request,
    source_id: str = Query(..., description="Source ID for embeddings cache"),
    table_id: Optional[str] = Query(None, description="Table ID for per-table embeddings cache"),
    limit_values: int = Query(50, description="Max items per list field (distinct/embedded/definition)"),
    include_vectors: bool = Query(False, description="Include embedded_values vectors (heavy, skip by default)"),
):
    """
    Return ColumnClass values stored in embeddings parquet.
    """
    try:
        connector_manager = _get_connector_manager(request)
        cache_path = _resolve_source_cache_path(
            connector_manager, source_id, table_id, "embeddings"
        )

        if not cache_path.exists():
            # Distinguish "source unknown" (true 404) from "source registered
            # but embeddings not generated yet" (empty 200).  The latter is
            # the normal state for freshly uploaded XLSX/CSV sources where
            # the user must explicitly trigger embedding generation.
            cfg_settings = get_settings()
            source_registered = (
                connector_manager.get_connector(source_id) is not None
                or any(s.source_id == source_id for s in cfg_settings.data_sources)
            )
            if not source_registered:
                raise HTTPException(
                    status_code=404,
                    detail=f"Unknown source_id: {source_id}",
                )
            return {
                "source_id": source_id,
                "table_id": table_id,
                "file": cache_path.name,
                "path": str(cache_path),
                "limit_values": limit_values,
                "count": 0,
                "columns": [],
                "embeddings_status": "not_generated",
                "message": (
                    "Embeddings have not been generated for this source yet. "
                    "Trigger generation via the data sources panel."
                ),
            }

        rows = _load_embeddings_parquet(cache_path, include_vectors=include_vectors)

        # Aggregate per column_name so the frontend gets one entry per column
        # with distinct_values as a list.
        from collections import OrderedDict
        grouped: OrderedDict[str, dict] = OrderedDict()
        for row in rows:
            col_name = row.get("column_name", "")
            if col_name not in grouped:
                grouped[col_name] = {
                    "column_name": col_name,
                    "distinct_values": [],
                    "definition_values": [],
                }
                if include_vectors:
                    grouped[col_name]["embedded_values"] = []

            val = row.get("distinct_value") or row.get("distinct_values")
            if val is not None:
                if isinstance(val, list):
                    grouped[col_name]["distinct_values"].extend(val)
                else:
                    grouped[col_name]["distinct_values"].append(val)

            defn = row.get("definition_values")
            if defn is not None:
                if isinstance(defn, list):
                    grouped[col_name]["definition_values"].extend(defn)
                else:
                    grouped[col_name]["definition_values"].append(defn)

            if include_vectors:
                emb = row.get("embedded_values")
                if emb is not None:
                    if isinstance(emb, list):
                        grouped[col_name]["embedded_values"].extend(emb)
                    else:
                        grouped[col_name]["embedded_values"].append(emb)

        vector_counts = _count_embedding_vectors_per_column(cache_path)

        columns_out = []
        for col_data in grouped.values():
            if limit_values is not None:
                col_data["distinct_values"] = col_data["distinct_values"][:limit_values]
                col_data["definition_values"] = col_data["definition_values"][:limit_values]
                if include_vectors and "embedded_values" in col_data:
                    col_data["embedded_values"] = col_data["embedded_values"][:limit_values]
            ckey = col_data.get("column_name", "")
            # Total vectors in parquet (not affected by limit_values truncation)
            col_data["embedded_vectors_count"] = vector_counts.get(ckey, 0)
            columns_out.append(col_data)

        return {
            "source_id": source_id,
            "table_id": table_id,
            "file": cache_path.name,
            "path": str(cache_path),
            "limit_values": limit_values,
            "count": len(columns_out),
            "columns": columns_out,
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading embeddings parquet: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.put("/columns/definitions")
async def save_column_definitions(request: Request, body: SaveDefinitionsRequest):
    """
    Persist definition_values edits back into the embeddings parquet,
    then **re-embed** any rows whose definitions changed so that
    embedded_values stays in sync with definition_values.
    """
    try:
        connector_manager = _get_connector_manager(request)
        cache_path = _resolve_source_cache_path(
            connector_manager, body.source_id, body.table_id, "embeddings"
        )
        if not cache_path.exists():
            raise HTTPException(status_code=404, detail=f"Embeddings parquet not found: {cache_path.name}")

        df = pd.read_parquet(cache_path, engine="pyarrow")

        incoming = {item.distinct_value: item.definitions for item in body.items}
        col = body.column_name

        mask = df["column_name"] == col
        other_rows = df[~mask].copy()
        col_rows = df[mask].copy()

        old_defs_map: Dict[str, str] = {}
        for _, row in col_rows.iterrows():
            dv = str(row.get("distinct_value") or "")
            old_defs_map[dv] = row.get("definition_values", "")

        updated_rows = []
        seen_values = set()
        rows_needing_reembed: list[int] = []

        for _, row in col_rows.iterrows():
            dv = str(row.get("distinct_value") or "")
            if dv in incoming:
                row_dict = row.to_dict()
                new_defs_json = json.dumps(incoming[dv], ensure_ascii=False)
                defs_changed = new_defs_json != old_defs_map.get(dv, "")
                row_dict["definition_values"] = new_defs_json
                if defs_changed:
                    row_dict["embedded_values"] = None
                    rows_needing_reembed.append(len(updated_rows))
                updated_rows.append(row_dict)
                seen_values.add(dv)

        for dv, defs in incoming.items():
            if dv not in seen_values:
                updated_rows.append({
                    "column_name": col,
                    "distinct_value": dv,
                    "definition_values": json.dumps(defs, ensure_ascii=False),
                    "embedded_values": None,
                })
                rows_needing_reembed.append(len(updated_rows) - 1)

        reembedded_count = 0
        if rows_needing_reembed:
            model = getattr(request.app.state, "embedding_model", None)
            if model is not None:
                reembedded_count = _reembed_rows(model, updated_rows, rows_needing_reembed)
            else:
                logger.warning(
                    "Embedding model not loaded — definitions saved but embeddings NOT refreshed "
                    "for %d rows. Use POST /columns/embeddings/reembed to fix.",
                    len(rows_needing_reembed),
                )

        result_df = pd.concat([other_rows, pd.DataFrame(updated_rows)], ignore_index=True)
        from nodes.dataloader.parquet_writer_node import write_parquet
        write_parquet(result_df, cache_path)

        return {
            "success": True,
            "source_id": body.source_id,
            "table_id": body.table_id,
            "column_name": col,
            "updated_count": len(updated_rows),
            "reembedded_count": reembedded_count,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving column definitions: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


class ReembedRequest(BaseModel):
    source_id: str
    table_id: Optional[str] = None
    column_names: Optional[List[str]] = None


@parquet_router.post("/columns/embeddings/reembed")
async def reembed_column_definitions(request: Request, body: ReembedRequest):
    """
    Re-embed all rows (or only specified columns) so that embedded_values
    matches the current definition_values text.

    Use this to fix columns whose definitions were edited after the
    initial embedding generation.
    """
    import numpy as np

    model = getattr(request.app.state, "embedding_model", None)
    if model is None:
        raise HTTPException(status_code=503, detail="Embedding model not loaded yet")

    try:
        connector_manager = _get_connector_manager(request)
        cache_path = _resolve_source_cache_path(
            connector_manager, body.source_id, body.table_id, "embeddings"
        )
        if not cache_path.exists():
            raise HTTPException(status_code=404, detail=f"Embeddings parquet not found: {cache_path.name}")

        df = pd.read_parquet(cache_path, engine="pyarrow")

        if body.column_names:
            mask = df["column_name"].isin(body.column_names)
        else:
            mask = pd.Series(True, index=df.index)

        rows = df.to_dict("records")
        indices_to_reembed = [i for i, m in enumerate(mask) if m]

        if not indices_to_reembed:
            return {
                "success": True,
                "source_id": body.source_id,
                "table_id": body.table_id,
                "reembedded_count": 0,
                "message": "No matching rows found",
            }

        count = _reembed_rows(model, rows, indices_to_reembed)

        result_df = pd.DataFrame(rows)
        from nodes.dataloader.parquet_writer_node import write_parquet
        write_parquet(result_df, cache_path)

        cols_done = (
            body.column_names
            if body.column_names
            else sorted(df["column_name"].unique().tolist())
        )
        return {
            "success": True,
            "source_id": body.source_id,
            "table_id": body.table_id,
            "columns": cols_done,
            "reembedded_count": count,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error re-embedding definitions: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/columns/definitions/refine")
async def refine_column_definitions(body: RefineDefinitionsRequest):
    """
    Use the configured LLM to suggest definition changes based on a reference text.

    Returns a list of add / update / delete changes for the caller to review
    before applying.
    """
    try:
        settings = get_settings()
        client, _ = get_llm()

        current_yaml_lines = []
        for item in body.items:
            entry = {"value": item.distinct_value, "definitions": item.definitions}
            current_yaml_lines.append(yaml.dump([entry], allow_unicode=True, default_flow_style=False).strip())
        current_definitions_yaml = "\n".join(current_yaml_lines)

        from prompt_loader import render_template
        prompt = render_template(
            "dataloader", "refine_definitions",
            column_name=body.column_name,
            reference_text=body.reference_text,
            current_definitions_yaml=current_definitions_yaml,
        )

        response = client.chat.completions.create(
            model=settings.llm.model,
            messages=[{"role": "user", "content": prompt}],
            stream=False,
        )
        raw = response.choices[0].message.content or ""

        yaml_str = raw
        if "```yaml" in raw:
            yaml_str = raw.split("```yaml", 1)[1].split("```", 1)[0]
        elif "```" in raw:
            yaml_str = raw.split("```", 1)[1].split("```", 1)[0]

        parsed = yaml.safe_load(yaml_str)

        changes: List[Dict[str, Any]] = []
        if isinstance(parsed, list):
            for entry in parsed:
                if not isinstance(entry, dict):
                    continue
                value = str(entry.get("value", "")).strip()
                action = str(entry.get("action", "")).strip().lower()
                if not value or action not in ("add", "update", "delete"):
                    continue
                old_defs = entry.get("old_definitions") or []
                new_defs = entry.get("new_definitions") or []
                if isinstance(old_defs, str):
                    old_defs = [old_defs]
                if isinstance(new_defs, str):
                    new_defs = [new_defs]
                changes.append({
                    "distinct_value": value,
                    "action": action,
                    "old_definitions": [str(d) for d in old_defs if d],
                    "new_definitions": [str(d) for d in new_defs if d],
                })

        return {
            "source_id": body.source_id,
            "table_id": body.table_id,
            "column_name": body.column_name,
            "count": len(changes),
            "changes": changes,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error refining column definitions: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/sql/source-config/{source_id}")
async def get_sql_source_config(source_id: str):
    """
    Return SQL-like source config and table definitions from runtime datasource config.
    """
    try:
        config_data = _read_yaml_file(_config_yaml_path())
        data_sources = _ensure_data_sources_list(config_data)
        source_cfg = next((s for s in data_sources if s.get("source_id") == source_id), None)
        if source_cfg is None:
            raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")
        if not _is_sql_like_source_type(source_cfg.get("type")):
            raise HTTPException(status_code=400, detail=f"Source '{source_id}' is not a SQL-like source")

        return {
            "source_id": source_cfg.get("source_id"),
            "type": source_cfg.get("type"),
            "enabled": bool(source_cfg.get("enabled", True)),
            "description": _resolve_description_for_source(source_cfg),
            "tables": source_cfg.get("tables", []) or [],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading SQL source config for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/source-config/{source_id}")
async def get_source_config(source_id: str):
    """
    Return full runtime datasource config for a source, including CSV and SQL metadata.
    """
    try:
        source_cfg = _find_source_config(source_id)
        if source_cfg is None:
            raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")

        return {
            "source_id": source_cfg.get("source_id"),
            "type": source_cfg.get("type"),
            "enabled": bool(source_cfg.get("enabled", True)),
            "description": _resolve_description_for_source(source_cfg),
            "path": source_cfg.get("path"),
            "columns_class": source_cfg.get("columns_class"),
            "incremental_column": source_cfg.get("incremental_column"),
            "cache_file": source_cfg.get("cache_file"),
            "embeddings_file": source_cfg.get("embeddings_file"),
            "foreign_keys": source_cfg.get("foreign_keys", []) or [],
            "tables": source_cfg.get("tables", []) or [],
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading source config for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/minio/{source_id}/objects", response_model=MinIOObjectsResponse)
async def list_minio_objects(
    source_id: str,
    request: Request,
    prefix: str = Query("", description="Optional object key prefix"),
    recursive: bool = Query(True, description="List nested objects recursively"),
):
    """List stored objects for a configured MinIO datasource."""
    try:
        connector = _get_minio_connector(request, source_id)
        if not hasattr(connector, "list_objects_info"):
            raise HTTPException(status_code=400, detail=f"Source '{source_id}' cannot list objects")

        objects = connector.list_objects_info(prefix=prefix or "", recursive=recursive)
        total_size = sum(int(obj.get("size") or 0) for obj in objects)
        return {
            "source_id": connector.source_id,
            "bucket": connector.bucket,
            "endpoint": connector.endpoint,
            "prefix": prefix or "",
            "recursive": recursive,
            "count": len(objects),
            "total_size": total_size,
            "objects": objects,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error listing MinIO objects for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/minio/{source_id}/objects", response_model=MinIOObjectMutationResponse)
async def upload_minio_object(
    source_id: str,
    request: Request,
    file: UploadFile = File(...),
    object_key: Optional[str] = Form(None),
):
    """Upload a file into a configured MinIO datasource."""
    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="filename is required")

        connector = _get_minio_connector(request, source_id)
        if not hasattr(connector, "upload_stream"):
            raise HTTPException(status_code=400, detail=f"Source '{source_id}' cannot upload objects")

        fallback_name = Path(file.filename).name
        key = _normalize_minio_object_key(object_key, fallback_name)

        try:
            file.file.seek(0, os.SEEK_END)
            size = file.file.tell()
            file.file.seek(0)
        except Exception:
            raise HTTPException(status_code=400, detail="Could not determine uploaded file size")

        if size <= 0:
            raise HTTPException(status_code=400, detail="Uploaded file is empty")

        content_type = file.content_type or "application/octet-stream"
        result = connector.upload_stream(
            key,
            file.file,
            size,
            content_type=content_type,
        )
        return {
            "success": True,
            "source_id": connector.source_id,
            "bucket": result["bucket"],
            "endpoint": result["endpoint"],
            "object_key": result["object_key"],
            "size": result["size"],
            "deleted": False,
            "message": f"Uploaded '{key}' to MinIO",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading MinIO object for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        await file.close()


@parquet_router.delete("/minio/{source_id}/objects", response_model=MinIOObjectMutationResponse)
async def delete_minio_object(
    source_id: str,
    request: Request,
    object_key: str = Query(..., description="Exact object key to delete"),
):
    """Delete one object from a configured MinIO datasource."""
    try:
        connector = _get_minio_connector(request, source_id)
        if not hasattr(connector, "delete_object"):
            raise HTTPException(status_code=400, detail=f"Source '{source_id}' cannot delete objects")

        key = _normalize_minio_object_key(object_key)
        result = connector.delete_object(key)
        return {
            "success": True,
            "source_id": connector.source_id,
            "bucket": result["bucket"],
            "endpoint": result["endpoint"],
            "object_key": result["object_key"],
            "size": None,
            "deleted": True,
            "message": f"Deleted '{key}' from MinIO",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting MinIO object for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/oracle/settings")
async def get_oracle_settings(request: Request):
    """Read Oracle connector settings from brikz-agent/.env and managed datasource config."""
    try:
        env_settings = _read_oracle_env_settings()
        source_cfg = _find_managed_oracle_source_config()
        source_id = (source_cfg or {}).get("source_id") or _ORACLE_ENV_SOURCE_ID
        connector_manager = getattr(request.app.state, "connector_manager", None)
        connector = connector_manager.get_connector(source_id) if connector_manager is not None else None

        return {
            "source_id": source_id,
            "env_file": str(_env_file_path()),
            "description": (source_cfg or {}).get("description", ""),
            "enabled": bool((source_cfg or {}).get("enabled", True)),
            "source_exists": source_cfg is not None,
            "registered": connector is not None,
            "tables_count": len((source_cfg or {}).get("tables", []) or []),
            "values": env_settings,
        }
    except Exception as e:
        logger.error("Error reading Oracle settings: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.put("/oracle/settings")
async def put_oracle_settings(request: Request, body: OracleConnectorSettingsPayload):
    """Persist Oracle connector settings to brikz-agent/.env and ensure a datasource exists."""
    try:
        _write_oracle_env_settings(body)
        source_cfg = _upsert_oracle_source_in_config_yaml(body)
        registered = _sync_runtime_source_registration(request, source_cfg["source_id"])

        return {
            "success": True,
            "source_id": source_cfg["source_id"],
            "registered": registered,
            "enabled": bool(source_cfg.get("enabled", True)),
            "tables_count": len(source_cfg.get("tables", []) or []),
            "description": source_cfg.get("description", ""),
            "message": f"Oracle source '{source_cfg['source_id']}' saved",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error saving Oracle settings: %s", str(e))
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/connectors/providers")
async def list_connector_providers():
    """List all supported connector providers with their field schemas."""
    result = []
    for pid, prov in _CONNECTOR_PROVIDERS.items():
        result.append({
            "id": pid,
            "label": prov["label"],
            "source_type": prov["source_type"],
            "default_source_id": prov["default_source_id"],
            "fields": [
                {"key": f["key"], "label": f["label"], "secret": f["secret"], "default": f["default"]}
                for f in prov["fields"]
            ],
        })
    return result


@parquet_router.get("/connectors/{provider_id}/settings")
async def get_connector_settings(provider_id: str, request: Request):
    """Read connector settings from .env for a given provider."""
    try:
        provider = _CONNECTOR_PROVIDERS.get(provider_id)
        if not provider:
            raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")
        values = _read_provider_env(provider_id)
        config_data = _read_yaml_file(_config_yaml_path())
        data_sources = _ensure_data_sources_list(config_data)
        source_cfg = next(
            (s for s in data_sources if s.get("type") == provider["source_type"]),
            None,
        )
        source_id = (source_cfg or {}).get("source_id") or provider["default_source_id"]
        connector_manager = getattr(request.app.state, "connector_manager", None)
        connector = connector_manager.get_connector(source_id) if connector_manager else None

        has_values = any(v.strip() for v in values.values())
        return {
            "provider_id": provider_id,
            "label": provider["label"],
            "source_id": source_id,
            "env_file": str(_env_file_path()),
            "enabled": bool((source_cfg or {}).get("enabled", True)),
            "source_exists": source_cfg is not None,
            "registered": connector is not None,
            "configured": has_values,
            "tables_count": len((source_cfg or {}).get("tables", []) or []),
            "values": values,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error reading %s settings: %s", provider_id, str(e))
        raise HTTPException(status_code=500, detail=str(e))


class ConnectorSettingsUpdateRequest(BaseModel):
    values: Dict[str, str]
    enabled: bool = True
    description: str = ""
    source_id: Optional[str] = None


@parquet_router.put("/connectors/{provider_id}/settings")
async def put_connector_settings(provider_id: str, body: ConnectorSettingsUpdateRequest, request: Request):
    """Persist connector settings to .env and upsert the datasource config."""
    try:
        provider = _CONNECTOR_PROVIDERS.get(provider_id)
        if not provider:
            raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")

        _write_provider_env(provider_id, body.values)

        source_id = body.source_id or provider["default_source_id"]
        path = _config_yaml_path()
        config_data = _read_yaml_file(path)
        data_sources = _ensure_data_sources_list(config_data)
        source_cfg = next(
            (s for s in data_sources
             if s.get("source_id") == source_id or s.get("type") == provider["source_type"]),
            None,
        )

        env_refs = {}
        for f in provider["fields"]:
            env_refs[f["key"]] = "${" + f["env"] + "}"

        next_source = {
            "source_id": source_id,
            "type": provider["source_type"],
            "enabled": bool(body.enabled),
            "description": body.description or (source_cfg or {}).get("description", "") or f"{provider['label']} connection",
            "refresh_policy": (source_cfg or {}).get("refresh_policy") or "manual",
            "tables": (source_cfg or {}).get("tables") or [],
            **env_refs,
        }

        if source_cfg is None:
            data_sources.append(next_source)
        else:
            source_cfg.update(next_source)
            next_source = source_cfg

        config_data["data_sources"] = data_sources
        _write_yaml_file(path, config_data)
        _upsert_source_in_datasources_yaml(next_source)

        registered = _sync_runtime_source_registration(request, next_source["source_id"])

        return {
            "success": True,
            "provider_id": provider_id,
            "source_id": next_source["source_id"],
            "registered": registered,
            "enabled": bool(next_source.get("enabled", True)),
            "tables_count": len(next_source.get("tables", []) or []),
            "description": next_source.get("description", ""),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error saving %s settings: %s", provider_id, str(e))
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/csv/upload")
async def upload_csv_source(
    request: Request,
    file: UploadFile = File(...),
    source_id: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
):
    """
    Upload a CSV file into brikz-agent/data and register it as a new CSV source.

    The file is streamed to disk in 1 MB chunks to avoid loading the
    entire payload into memory at once.
    """
    _UPLOAD_CHUNK = 1024 * 1024  # 1 MB

    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="CSV filename is required")

        filename = Path(file.filename).name
        if Path(filename).suffix.lower() != ".csv":
            raise HTTPException(status_code=400, detail="Only .csv files are supported")

        config_data = _read_yaml_file(_config_yaml_path())
        base_source_id = _slugify_identifier(source_id or f"{Path(filename).stem}_csv")
        final_source_id = _ensure_unique_source_id(config_data, base_source_id)

        data_dir = _project_root() / "data"
        data_dir.mkdir(parents=True, exist_ok=True)

        target_name = f"{final_source_id}.csv"
        target_path = data_dir / target_name
        tmp_path = target_path.with_suffix(".csv.tmp")

        total_bytes = 0
        try:
            with open(tmp_path, "wb") as fp:
                while True:
                    chunk = await file.read(_UPLOAD_CHUNK)
                    if not chunk:
                        break
                    fp.write(chunk)
                    total_bytes += len(chunk)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

        if total_bytes == 0:
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Uploaded CSV is empty")

        tmp_path.rename(target_path)
        logger.info("CSV uploaded: %s (%s bytes)", target_name, f"{total_bytes:,}")

        with open(target_path, "rb") as fp:
            sample_bytes = fp.read(8192)
        sample_text = sample_bytes.decode("utf-8", errors="ignore")
        delimiter = _detect_csv_delimiter(sample_text)

        source_config = {
            "source_id": final_source_id,
            "type": "csv",
            "enabled": True,
            "path": f"data/{target_name}",
            "delimiter": delimiter,
            "encoding": "utf-8",
            "date_columns": [],
            "refresh_policy": "manual",
            "description": description or f"CSV import from {filename}",
            "cache_file": f"{final_source_id}_data.parquet",
            "embeddings_file": f"{final_source_id}_embeddings.parquet",
        }

        data_sources = _ensure_data_sources_list(config_data)
        data_sources.append(source_config)
        _write_yaml_file(_config_yaml_path(), config_data)
        _upsert_source_in_datasources_yaml(source_config)

        connector_manager = getattr(request.app.state, "connector_manager", None)
        refresh_ok = False
        refresh_message = "Source saved in config."
        if connector_manager is not None:
            from services.connectors.csv_connector import CSVConnector

            if connector_manager.get_connector(final_source_id) is None:
                connector_manager.register_connector(CSVConnector(source_config))
            refresh_ok = connector_manager.refresh_source(final_source_id, force=True)
            refresh_message = "Source saved and refreshed." if refresh_ok else "Source saved but refresh failed."

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after CSV upload", exc_info=True)

        return {
            "success": True,
            "source_id": final_source_id,
            "filename": target_name,
            "delimiter": delimiter,
            "refreshed": refresh_ok,
            "message": refresh_message,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading CSV source: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Table Download (background) ─────────────────────────────────────────

_download_jobs: Dict[str, Dict[str, Any]] = {}


@parquet_router.get("/download-agent/lookup/{source_id}/{table_id}")
async def lookup_download_agent(source_id: str, table_id: str):
    """Find the most recent download-agent job for a source/table pair.

    Returns the job if it is still running or finished recently,
    so the frontend can reconnect after closing and reopening the popup.
    """
    best = None
    for jid, job in _download_jobs.items():
        if job["source_id"] == source_id and job["table_id"] == table_id:
            if best is None or job["started_at"] > _download_jobs[best]["started_at"]:
                best = jid
    if best is None:
        return {"job_id": None}
    job = _download_jobs[best]
    elapsed = None
    if job["started_at"]:
        end = job["finished_at"] or time.time()
        elapsed = round(end - job["started_at"], 1)
    return {
        "job_id": best,
        "status": job["status"],
        "source_id": job["source_id"],
        "table_id": job["table_id"],
        "row_count": job.get("row_count"),
        "total_rows": job.get("total_rows"),
        "error": job.get("error"),
        "elapsed_seconds": elapsed,
        "events": job.get("events", []),
        "last_event": job.get("last_event"),
    }


@parquet_router.post("/download-agent/{source_id}/{table_id}")
async def start_download_agent(
    source_id: str,
    table_id: str,
    request: Request,
    incremental: bool = Query(False),
    resume: bool = Query(True, description="Resume from existing partial download"),
):
    """
    Launch the reasoning download agent for a specific table.

    When ``resume=true`` (default), the agent checks for an existing
    parquet file and continues from where it left off.
    """
    connector_manager = _get_connector_manager(request)
    connector = connector_manager.get_connector(source_id)
    if connector is None:
        source_cfg = _find_source_config(source_id)
        if source_cfg is not None:
            _sync_runtime_source_registration(request, source_id)
            connector = connector_manager.get_connector(source_id)
        if connector is None:
            if source_cfg is not None:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Source '{source_id}' is configured but its connector is not "
                        "registered. Check connector settings and required credentials."
                    ),
                )
            raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")

    # Prevent duplicate concurrent jobs for the same source/table
    for jid, existing in _download_jobs.items():
        if (existing["source_id"] == source_id
                and existing["table_id"] == table_id
                and existing["status"] == "running"):
            return {
                "job_id": jid,
                "source_id": source_id,
                "table_id": table_id,
                "message": "Download already running — reconnecting to existing job.",
                "reconnected": True,
            }

    job_id = f"da-{uuid.uuid4().hex[:12]}"
    job: Dict[str, Any] = {
        "status": "running",
        "source_id": source_id,
        "table_id": table_id,
        "started_at": time.time(),
        "finished_at": None,
        "row_count": None,
        "total_rows": None,
        "error": None,
        "events": [],
        "last_event": None,
    }
    _download_jobs[job_id] = job

    def _run_agent():
        try:
            from flows.download_flow import run_download_flow

            result = run_download_flow(
                connector_manager=connector_manager,
                source_id=source_id,
                table_id=table_id,
                incremental=incremental,
                resume=resume,
                job=job,
            )
            if result.get("success"):
                job["status"] = "completed"
                job["row_count"] = result.get("row_count")
            else:
                job["status"] = "failed"
                job["error"] = result.get("error", "unknown")
                job["row_count"] = result.get("row_count", 0)
        except Exception as exc:
            logger.error("Download agent failed: job=%s %s", job_id, exc, exc_info=True)
            job["status"] = "failed"
            job["error"] = str(exc)
        finally:
            job["finished_at"] = time.time()

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_agent)

    return {
        "job_id": job_id,
        "source_id": source_id,
        "table_id": table_id,
        "message": f"Download agent started. Stream events at /parquet/download-agent/{job_id}/events",
    }


@parquet_router.get("/download-agent/{job_id}/events")
async def stream_download_events(job_id: str):
    """
    SSE endpoint streaming reasoning steps and progress for a download job.

    Each event is a JSON object with ``step``, ``message``, and optional
    fields like ``rows_downloaded``, ``pct``, ``rate``, ``error``.
    """
    job = _download_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    async def event_generator():
        last_idx = 0
        while True:
            events = job.get("events", [])
            while last_idx < len(events):
                evt = events[last_idx]
                last_idx += 1
                yield f"data: {json.dumps(evt, default=str)}\n\n"

            if job["status"] in ("completed", "failed"):
                summary = {
                    "step": "summary",
                    "status": job["status"],
                    "row_count": job.get("row_count"),
                    "total_rows": job.get("total_rows"),
                    "error": job.get("error"),
                    "elapsed": round(
                        (job["finished_at"] or time.time()) - job["started_at"], 1
                    ),
                }
                yield f"data: {json.dumps(summary)}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@parquet_router.get("/download-agent/{job_id}/status")
async def get_download_agent_status(job_id: str):
    """Poll the status of a download agent job (non-SSE alternative)."""
    job = _download_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    elapsed = None
    if job["started_at"]:
        end = job["finished_at"] or time.time()
        elapsed = round(end - job["started_at"], 1)

    return {
        "job_id": job_id,
        "status": job["status"],
        "source_id": job["source_id"],
        "table_id": job["table_id"],
        "row_count": job.get("row_count"),
        "total_rows": job.get("total_rows"),
        "error": job.get("error"),
        "elapsed_seconds": elapsed,
        "events": job.get("events", []),
        "last_event": job.get("last_event"),
    }


# ── QVD Upload + Full Pipeline ──────────────────────────────────────────

_qvd_pipeline_jobs: Dict[str, Dict[str, Any]] = {}


@parquet_router.post("/qvd/upload")
async def upload_qvd_source(
    request: Request,
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    source_id: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
):
    """
    Upload a QVD file, archive it directly to MinIO, register it as a data
    source, and launch the lightweight QVD→Parquet pipeline in the background.

    The raw QVD never lands in ``data/raw/`` — it is streamed in 1 MB chunks
    to an OS tempfile, pushed to MinIO, then read back from the tempfile by
    the lightweight pipeline. The tempfile is unlinked as soon as the
    pipeline finishes. The Parquet artefact (the queryable cache) is the
    only QVD-derived file that lives on local disk long-term, under
    ``data/parquet/``.

    Returns immediately with a ``job_id`` that can be polled via
    ``GET /parquet/qvd/pipeline/{job_id}``.
    """
    import tempfile as _tempfile

    _UPLOAD_CHUNK = 1024 * 1024  # 1 MB

    try:
        if not file.filename:
            raise HTTPException(status_code=400, detail="QVD filename is required")

        filename = Path(file.filename).name
        is_gzipped = filename.lower().endswith(".qvd.gz")
        if not (filename.lower().endswith(".qvd") or is_gzipped):
            raise HTTPException(status_code=400, detail="Only .qvd or .qvd.gz files are supported")

        if is_gzipped:
            filename = filename[:-3]  # strip .gz → keep .qvd

        # Stream the upload into an OS tempfile (NOT data/raw/). The pipeline
        # reads the same tempfile and deletes it when done.
        tmp_fd, tmp_path_str = _tempfile.mkstemp(prefix="qvd_upload_", suffix=".qvd")
        tmp_path = Path(tmp_path_str)
        os.close(tmp_fd)

        total_bytes = 0
        try:
            if is_gzipped:
                import gzip as _gzip
                gz_fd, gz_tmp_str = _tempfile.mkstemp(prefix="qvd_upload_", suffix=".qvd.gz")
                gz_tmp = Path(gz_tmp_str)
                os.close(gz_fd)
                try:
                    with open(gz_tmp, "wb") as fp:
                        while True:
                            chunk = await file.read(_UPLOAD_CHUNK)
                            if not chunk:
                                break
                            fp.write(chunk)
                            total_bytes += len(chunk)
                    with _gzip.open(gz_tmp, "rb") as gz_in, open(tmp_path, "wb") as out:
                        while True:
                            block = gz_in.read(_UPLOAD_CHUNK)
                            if not block:
                                break
                            out.write(block)
                finally:
                    gz_tmp.unlink(missing_ok=True)
            else:
                with open(tmp_path, "wb") as fp:
                    while True:
                        chunk = await file.read(_UPLOAD_CHUNK)
                        if not chunk:
                            break
                        fp.write(chunk)
                        total_bytes += len(chunk)
        except Exception:
            tmp_path.unlink(missing_ok=True)
            raise

        if total_bytes == 0:
            tmp_path.unlink(missing_ok=True)
            raise HTTPException(status_code=400, detail="Uploaded QVD is empty")

        logger.info(
            "QVD uploaded to tempfile: %s (%s bytes, gzipped=%s)",
            filename, f"{total_bytes:,}", is_gzipped,
        )

        config_data = _read_yaml_file(_config_yaml_path())
        base_source_id = _slugify_identifier(source_id or f"{Path(filename).stem}_qvd")
        final_source_id = _ensure_unique_source_id(config_data, base_source_id)

        parquet_dir = _project_root() / "data" / "parquet"
        parquet_dir.mkdir(parents=True, exist_ok=True)

        parquet_stem = Path(filename).stem
        cache_file = f"data/parquet/{parquet_stem}.parquet"
        embeddings_file = f"data/parquet/{parquet_stem}_distinct.parquet"

        # Pre-compute MinIO key — matches what minio_storage.upload_qvd uses.
        from services import minio_storage as _minio_storage
        minio_bucket = os.environ.get("MINIO_BUCKET", "brikz")
        minio_key = f"{_minio_storage.qvd_prefix()}{final_source_id}/{filename}"

        source_config = {
            "source_id": final_source_id,
            "type": "qvd",
            "enabled": True,
            # MinIO is the source of truth. The QVD connector resolves this
            # by downloading to a tempfile on demand (no local data/raw/).
            "path": f"minio://{minio_bucket}/{minio_key}",
            "minio_bucket": minio_bucket,
            "minio_key": minio_key,
            "chunk_size": 100000,
            "refresh_policy": "manual",
            "columns_class": f"classes.dtos.{parquet_stem}_dto:get_columns_descriptions",
            "cache_file": cache_file,
            "embeddings_file": embeddings_file,
        }

        # Archive the raw QVD in MinIO (best-effort, non-blocking). Reads from
        # the tempfile written above. Once both this and the pipeline complete,
        # the tempfile is unlinked — the QVD never touches data/raw/.
        def _archive_to_minio(local_path: str, name: str, sid: str) -> bool:
            try:
                if not _minio_storage.is_configured():
                    logger.warning(
                        "MinIO not configured — QVD archive skipped for %s. "
                        "The source will be unusable until MinIO is reachable.",
                        name,
                    )
                    return False
                result = _minio_storage.upload_qvd(
                    local_path=local_path,
                    original_filename=name,
                    source_id=sid,
                )
                if result:
                    logger.info(
                        "QVD archived in MinIO: s3://%s/%s",
                        result["bucket"], result["object_key"],
                    )
                    return True
            except Exception:
                logger.warning("MinIO archive failed for %s", name, exc_info=True)
            return False

        data_sources = _ensure_data_sources_list(config_data)
        data_sources.append(source_config)
        _write_yaml_file(_config_yaml_path(), config_data)
        _upsert_source_in_datasources_yaml(source_config)

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after QVD upload", exc_info=True)

        job_id = str(uuid.uuid4())
        # Each step the UI renders has its own phase entry. The UI advances a
        # step as soon as its phase flips to "completed" — without waiting for
        # later phases. Concretely:
        #   - "upload"        is done the moment the HTTP request is parsed.
        #   - "archive_minio" is done after ~2s (MinIO put_object returns).
        #   - "schema_ready"  is done after ~20s (first pyqvd chunk reveals columns).
        #                     This unlocks the "Colonnes" step in the UI.
        #   - "conversion"    is done after ~6min for a 568MB QVD.
        #                     This unlocks the "Distinct"/"queryable" step.
        now = time.time()
        _qvd_pipeline_jobs[job_id] = {
            "status": "pending",
            "source_id": final_source_id,
            "filename": filename,
            "started_at": now,
            "finished_at": None,
            "error": None,
            "results": None,
            # Step-level state for the UI.
            "phases": {
                "upload": {
                    "status": "completed",
                    "started_at": now,
                    "finished_at": now,
                    "bytes": total_bytes,
                },
                "archive_minio": {
                    "status": "pending",
                    "started_at": None,
                    "finished_at": None,
                    "bucket": minio_bucket,
                    "key": minio_key,
                },
                "schema_ready": {
                    "status": "pending",
                    "started_at": None,
                    "finished_at": None,
                    "columns": [],
                },
                "conversion": {
                    "status": "pending",
                    "started_at": None,
                    "finished_at": None,
                    "rows_done": 0,
                    "chunks_done": 0,
                    "parquet_path": None,
                },
            },
            # Fine-grained progress for the active phase (UI shows "850k/4.2M lignes").
            "progress": {
                "phase": "pending",        # pending|archiving|reading|writing|finalizing|completed
                "rows_done": 0,
                "chunks_done": 0,
                "total_bytes": total_bytes,
                "phase_message": "En attente",
            },
        }

        connector_manager = getattr(request.app.state, "connector_manager", None)

        def _run_lightweight_pipeline():
            """Lightweight pipeline: QVD → Parquet + basic DTO (no LLM, no embeddings).

            Streams the QVD in chunks (default 200k rows) and writes parquet
            incrementally via :class:`pyarrow.parquet.ParquetWriter`. This:

              - Bounds peak RAM (no full DataFrame materialised at once),
              - Yields the GIL between chunks so the FastAPI event loop +
                other background tasks stay responsive,
              - Lets us report fine-grained progress (rows / chunks done) to
                the UI via ``job["progress"]``.

            Reads from the upload tempfile (never from data/raw/) and unlinks
            it when finished — regardless of success or failure. User then
            configures columns and triggers distinct/embeddings manually.
            """
            from pyqvd import QvdTable
            import pyarrow as pa
            import pyarrow.parquet as pq

            job = _qvd_pipeline_jobs[job_id]
            job["status"] = "running"
            progress = job["progress"]
            phases = job["phases"]

            phases["schema_ready"]["status"] = "running"
            phases["schema_ready"]["started_at"] = time.time()
            phases["conversion"]["status"] = "running"
            phases["conversion"]["started_at"] = phases["schema_ready"]["started_at"]

            # Small chunks keep peak RAM bounded: pyqvd streams the index table
            # from disk one chunk at a time (the symbol table is tiny), but each
            # chunk is materialised through pyqvd objects -> pandas -> Arrow,
            # which triples transiently. At 200k rows × 100+ wide string/"dual"
            # columns that peak blew past the 24GB container limit (OOM). At 20k
            # rows the whole conversion holds a flat ~0.6GB regardless of the
            # QVD's total row count (validated on an 8.4M-row / 579MB QVD).
            CHUNK_ROWS = 20_000
            parquet_out = _project_root() / cache_file
            parquet_out.parent.mkdir(parents=True, exist_ok=True)

            try:
                progress["phase"] = "reading"
                progress["phase_message"] = "Lecture du QVD en chunks…"
                logger.info("QVD pipeline [%s]: streaming %s in %d-row chunks",
                            job_id, tmp_path, CHUNK_ROWS)

                writer: Optional[pq.ParquetWriter] = None
                arrow_schema: Optional[pa.Schema] = None
                total_rows = 0
                total_chunks = 0
                columns: List[str] = []
                sanitised_cols: Optional[List[str]] = None
                dto_types = _load_columns_class_types(source_config.get("columns_class"))
                # On a brand-new upload the DTO file is generated *after* this
                # pipeline runs, so ``dto_types`` is empty here and the strict
                # per-column Python coercion in ``_coerce_qvd_chunk_for_parquet``
                # would force every column through ``series.map(_safe_str_value)``
                # (≈1–5 µs/cell × tens of millions of cells). Skip that path and
                # use the older vectorised ``sanitise_for_parquet`` + Arrow's
                # native schema inference instead. Restores the throughput the
                # pipeline had before commit f8affc7.
                use_strict_dto_coercion = bool(dto_types)
                if not use_strict_dto_coercion:
                    from nodes.dataloader.parquet_writer_node import sanitise_for_parquet

                # pyqvd returns an iterator of QvdTable chunks when chunk_size is set.
                chunks_iter = QvdTable.from_qvd(str(tmp_path), chunk_size=CHUNK_ROWS)

                try:
                    for chunk in chunks_iter:
                        df_chunk = chunk.to_pandas()
                        if df_chunk.empty:
                            continue

                        if use_strict_dto_coercion:
                            df_chunk = _coerce_qvd_chunk_for_parquet(df_chunk, dto_types=dto_types)
                        else:
                            # Sanitize column names once and reuse — pyqvd
                            # produces the same column list per chunk, so
                            # recomputing per chunk is wasted work.
                            if sanitised_cols is None:
                                sanitised_cols = _sanitize_qvd_columns_for_parquet(
                                    list(df_chunk.columns)
                                )
                            df_chunk.columns = sanitised_cols
                            # Cheap object-dtype-only sanitiser — leaves
                            # numeric/datetime columns untouched so Arrow
                            # ingests them via zero-copy from numpy buffers.
                            df_chunk = sanitise_for_parquet(df_chunk)
                            # Pin Qlik "dual" columns (object dtype) to
                            # pandas ``StringDtype`` BEFORE schema capture
                            # so subsequent chunks that come back as
                            # int64/float64 don't blow up the writer.
                            df_chunk = _normalise_object_columns_to_string(df_chunk)

                        if not columns:
                            columns = list(df_chunk.columns)
                            # As soon as the first chunk yields columns, the
                            # UI can unlock the "Colonnes" step — no need to
                            # wait for full conversion.
                            phases["schema_ready"]["columns"] = columns
                            phases["schema_ready"]["status"] = "completed"
                            phases["schema_ready"]["finished_at"] = time.time()
                            logger.info(
                                "QVD pipeline [%s]: schema ready (%d columns) — UI can advance to 'Colonnes'",
                                job_id, len(columns),
                            )
                        else:
                            # Preserve first-chunk column order and schema for
                            # every following chunk. Extra/missing columns are
                            # not expected, but reindexing makes the write path
                            # deterministic if a QVD chunk is sparse.
                            df_chunk = df_chunk.reindex(columns=columns)

                        if use_strict_dto_coercion:
                            if arrow_schema is None:
                                arrow_schema = _arrow_schema_for_qvd_chunk(df_chunk, dto_types)
                            arrow_table = pa.Table.from_pandas(
                                df_chunk,
                                schema=arrow_schema,
                                preserve_index=False,
                            )
                        else:
                            # No DTO yet → let Arrow infer types from pandas
                            # dtypes (zero-copy for numeric/datetime/string).
                            # Capture the inferred schema from chunk #1 and
                            # reuse it as the writer schema so all subsequent
                            # chunks land in the same parquet file. For
                            # chunks #2+, vectorise-coerce columns whose
                            # pyqvd-given dtype drifted away from chunk #1's
                            # type (Qlik dual columns). Without this guard a
                            # ``Z_Raw_*_Key`` column that came back as
                            # string in chunk #1 and int64 in chunk #2 would
                            # raise ``ArrowTypeError`` mid-stream and the
                            # parquet would be truncated to chunk #1's rows.
                            if arrow_schema is None:
                                arrow_table = pa.Table.from_pandas(
                                    df_chunk, preserve_index=False,
                                )
                                arrow_schema = arrow_table.schema
                            else:
                                df_chunk = _conform_chunk_to_arrow_schema(
                                    df_chunk, arrow_schema,
                                )
                                arrow_table = pa.Table.from_pandas(
                                    df_chunk,
                                    schema=arrow_schema,
                                    preserve_index=False,
                                )

                        if writer is None:
                            progress["phase"] = "writing"
                            progress["phase_message"] = "Écriture incrémentale Parquet…"
                            writer = pq.ParquetWriter(
                                str(parquet_out),
                                arrow_schema,
                                compression="snappy",
                            )
                        writer.write_table(arrow_table)

                        total_rows += len(df_chunk)
                        total_chunks += 1
                        progress["rows_done"] = total_rows
                        progress["chunks_done"] = total_chunks
                        progress["phase_message"] = (
                            f"Conversion en cours — {total_rows:,} lignes, "
                            f"{total_chunks} chunks"
                        )
                        # Mirror to the conversion phase for UI step display.
                        phases["conversion"]["rows_done"] = total_rows
                        phases["conversion"]["chunks_done"] = total_chunks

                        # Periodic log line so users tailing logs see progress.
                        if total_chunks % 5 == 0 or total_chunks == 1:
                            logger.info(
                                "QVD pipeline [%s]: %d chunks, %d rows written so far",
                                job_id, total_chunks, total_rows,
                            )

                        # Release this chunk's materialised objects (pyqvd chunk
                        # + pandas frame + Arrow table) before the next iteration
                        # so peak RAM stays flat across the whole file instead of
                        # growing/spiking with row count.
                        del df_chunk, arrow_table, chunk
                        if total_chunks % 25 == 0:
                            gc.collect()
                finally:
                    if writer is not None:
                        writer.close()

                if total_rows == 0:
                    raise RuntimeError("QVD produced 0 rows — the file may be empty or corrupt")

                progress["phase"] = "finalizing"
                progress["phase_message"] = "Génération DTO…"
                logger.info(
                    "QVD pipeline [%s]: wrote parquet %s (%d rows, %d cols)",
                    job_id, parquet_out, total_rows, len(columns),
                )

                try:
                    from nodes.dataloader.qvd_field_description_node import (
                        _sanitize_column_name,
                        _infer_type_and_categorical,
                        _generate_dto_python,
                    )

                    field_entries = []
                    for col in columns:
                        sanitized = _sanitize_column_name(str(col))
                        field_entries.append((sanitized, f"Description for {col}."))

                    dto_content = _generate_dto_python(
                        parquet_stem, field_entries, f"QVD source: {filename}"
                    )
                    dto_dir = _project_root() / "data" / "classes" / "dtos"
                    dto_dir.mkdir(parents=True, exist_ok=True)
                    dto_path = dto_dir / f"{parquet_stem}_dto.py"
                    dto_path.write_text(dto_content, encoding="utf-8")
                    logger.info("QVD pipeline [%s]: wrote DTO %s", job_id, dto_path)
                except Exception as dto_err:
                    logger.warning("QVD pipeline [%s]: DTO generation failed (non-fatal): %s", job_id, dto_err)

                job["status"] = "completed"
                progress["phase"] = "completed"
                progress["phase_message"] = "Terminé"
                phases["conversion"]["status"] = "completed"
                phases["conversion"]["finished_at"] = time.time()
                phases["conversion"]["parquet_path"] = str(parquet_out)
                # Belt-and-suspenders: if a fast/empty QVD never produced
                # columns the schema_ready phase wouldn't have flipped above.
                if phases["schema_ready"]["status"] != "completed":
                    phases["schema_ready"]["columns"] = columns
                    phases["schema_ready"]["status"] = "completed"
                    phases["schema_ready"]["finished_at"] = time.time()
                job["results"] = {
                    "parquet_path": str(parquet_out),
                    "row_count": total_rows,
                    "column_count": len(columns),
                    "columns": columns,
                    "chunks": total_chunks,
                    "next_steps": [
                        "configure_columns",
                        "generate_distinct",
                    ],
                }

                try:
                    get_settings(reload=True)
                except Exception:
                    pass

                if connector_manager is not None:
                    try:
                        from services.connectors.qvd_connector import QVDConnector
                        # Register only — do NOT refresh. The lightweight
                        # pipeline already wrote the parquet cache, so a
                        # forced refresh would re-download the QVD from
                        # MinIO and re-run pyqvd for no gain. The connector
                        # will pick up the parquet on first query.
                        if connector_manager.get_connector(final_source_id) is None:
                            connector_manager.register_connector(QVDConnector(source_config))
                    except Exception as reg_err:
                        logger.warning("Connector registration after QVD pipeline failed: %s", reg_err)

                try:
                    from flows.dto_cache_flow import run_dto_cache_flow
                    parquet_dir_str = str(_project_root() / "data" / "parquet")
                    run_dto_cache_flow(parquet_cache_dir=parquet_dir_str)
                except Exception as dto_err:
                    logger.warning("DTO cache refresh failed: %s", dto_err)

            except Exception as exc:
                logger.error("QVD pipeline failed for %s: %s", job_id, exc, exc_info=True)
                job["status"] = "failed"
                job["error"] = str(exc)
                progress["phase"] = "failed"
                progress["phase_message"] = f"Échec : {exc}"
                # Mark any phase still in progress as failed so the UI can
                # render an error indicator on the right step.
                for phase_name in ("schema_ready", "conversion"):
                    if phases[phase_name]["status"] in ("pending", "running"):
                        phases[phase_name]["status"] = "failed"
                        phases[phase_name]["finished_at"] = time.time()
            finally:
                job["finished_at"] = time.time()

        def _upload_then_pipeline_then_cleanup():
            """Run MinIO archive + parquet pipeline concurrently, then clean up.

            The two operations are independent reads of ``tmp_path`` so they
            can run in parallel: pyqvd opens its own file descriptor for the
            chunked parquet conversion, and the MinIO client streams the same
            file in a separate thread. Doing them sequentially used to add
            anywhere from a few seconds (local MinIO) to several minutes
            (remote MinIO) of dead time before chunk #1 even appeared.

            Failure semantics are preserved: if the MinIO archive fails the
            whole job is marked failed (the QVD source registers a
            ``minio://…`` path, so a missing archive would break refresh).
            The parquet artefact is then deleted to avoid leaving a
            half-registered source on disk.

            Each phase flips its own ``phases.<name>.status`` so the UI can
            advance independent steps as soon as their phase completes:
              - ``archive_minio`` flips to "completed" when MinIO returns
                (typically before conversion finishes; possibly after for
                slow uplinks).
              - ``schema_ready`` flips inside the pipeline after the first
                chunk (≈few s) — UI unlocks the "Colonnes" step then.
              - ``conversion`` flips at the end — UI unlocks queryability.
            """
            job = _qvd_pipeline_jobs[job_id]
            progress = job["progress"]
            phases = job["phases"]

            archive_state: Dict[str, Any] = {"ok": None, "error": None}

            def _archive_worker():
                # Worker runs concurrently with the parquet pipeline. We flip
                # ``phases["archive_minio"]`` here so the UI sees the archive
                # step complete as soon as MinIO returns — typically well
                # before the conversion finishes — instead of waiting for
                # ``archive_t.join`` in the parent thread.
                try:
                    ok = bool(
                        _archive_to_minio(str(tmp_path), filename, final_source_id)
                    )
                    archive_state["ok"] = ok
                except Exception as exc:
                    archive_state["ok"] = False
                    archive_state["error"] = str(exc)
                    logger.error(
                        "MinIO archive thread failed for %s: %s",
                        job_id, exc, exc_info=True,
                    )
                finally:
                    phases["archive_minio"]["finished_at"] = time.time()
                    phases["archive_minio"]["status"] = (
                        "completed" if archive_state["ok"] else "failed"
                    )

            phases["archive_minio"]["status"] = "running"
            phases["archive_minio"]["started_at"] = time.time()
            progress["phase"] = "archiving"
            progress["phase_message"] = "Archivage MinIO + lecture du QVD…"

            archive_t = threading.Thread(
                target=_archive_worker,
                daemon=True,
                name=f"qvd-archive-{job_id}",
            )
            archive_t.start()

            pipeline_exc: Optional[BaseException] = None
            try:
                _run_lightweight_pipeline()
            except BaseException as exc:  # noqa: BLE001 - re-raised below for visibility
                pipeline_exc = exc
            finally:
                # Wait for the archive thread (the worker has already flipped
                # its phase status). 10 min cap matches the worst case for a
                # ~1 GB upload over a slow uplink; we'd rather flag the archive
                # as failed than block the request thread indefinitely.
                archive_t.join(timeout=600)

                if archive_state["ok"] is not True:
                    err = (
                        archive_state["error"]
                        or "MinIO archive failed — see server logs"
                    )
                    logger.error(
                        "MinIO archive unsuccessful for %s: %s", job_id, err,
                    )
                    if job["status"] != "failed":
                        job["status"] = "failed"
                        job["error"] = (
                            f"MinIO archive failed — QVD upload aborted. {err}"
                        )
                        progress["phase"] = "failed"
                        progress["phase_message"] = "Échec de l'archivage MinIO"
                        for phase_name in ("schema_ready", "conversion"):
                            if phases[phase_name]["status"] in ("pending", "running"):
                                phases[phase_name]["status"] = "skipped"
                                phases[phase_name]["finished_at"] = time.time()
                        # Tear down the parquet so the registered minio:// source
                        # isn't backed by a local file that will silently drift
                        # from a missing archive on first refresh.
                        try:
                            (_project_root() / cache_file).unlink(missing_ok=True)
                        except Exception:
                            pass
                        job["finished_at"] = time.time()

                tmp_path.unlink(missing_ok=True)
                logger.info("QVD tempfile cleaned up: %s", tmp_path)

            if pipeline_exc is not None:
                # Re-raise so FastAPI's BackgroundTasks logs the traceback.
                # The job dict has already been marked failed by
                # ``_run_lightweight_pipeline``'s own except branch.
                raise pipeline_exc

        background_tasks.add_task(_upload_then_pipeline_then_cleanup)

        return {
            "success": True,
            "source_id": final_source_id,
            "filename": filename,
            "job_id": job_id,
            "minio": {"bucket": minio_bucket, "key": minio_key},
            # Initial step state — the UI can render all steps immediately,
            # then poll GET /parquet/qvd/pipeline/{job_id} to watch each
            # phase flip independently.
            "phases": _qvd_pipeline_jobs[job_id]["phases"],
            "message": "QVD uploaded. Archiving to MinIO + converting to Parquet in background.",
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error uploading QVD source: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/qvd/pipeline/{job_id}")
async def get_qvd_pipeline_status(job_id: str):
    """Poll the status of a QVD full-pipeline background job.

    Includes a ``progress`` block (``phase``, ``rows_done``, ``chunks_done``,
    ``phase_message``) so the UI can show real-time conversion progress
    instead of an opaque "Conversion en cours…".
    """
    job = _qvd_pipeline_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Pipeline job not found: {job_id}")

    elapsed = None
    if job["started_at"]:
        end = job["finished_at"] or time.time()
        elapsed = round(end - job["started_at"], 1)

    return {
        "job_id": job_id,
        "status": job["status"],
        "source_id": job["source_id"],
        "filename": job["filename"],
        "elapsed_seconds": elapsed,
        "error": job["error"],
        "results": job["results"],
        "progress": job.get("progress"),
        # Per-step state: each phase has its own status/started_at/finished_at.
        # UI advances steps independently as each phase flips to "completed":
        #   - upload         → instant (HTTP request parsed)
        #   - archive_minio  → ~2 s (MinIO put_object returned)
        #   - schema_ready   → ~20 s (first chunk → column list available)
        #   - conversion     → ~6 min for 568 MB (parquet writer closed)
        "phases": job.get("phases"),
    }


# ── XLSX Upload + Pipeline (single batch job for one or many files) ─────

_xlsx_pipeline_jobs: Dict[str, Dict[str, Any]] = {}

_XLSX_ALLOWED_SUFFIXES = {".xlsx", ".xlsm", ".xltx", ".xltm", ".xls", ".ods"}


@parquet_router.post("/xlsx/upload")
async def upload_xlsx_sources(
    request: Request,
    background_tasks: BackgroundTasks,
    files: List[UploadFile] = File(...),
    description: Optional[str] = Form(None),
):
    """
    Upload one or more Excel workbooks (``.xlsx`` / ``.xls`` / ``.ods`` / …),
    register each one as a data source, and run the XLSX → Parquet pipeline
    (``flows.xlsx_pipeline_flow.run_xlsx_pipeline``) in the background.

    All files share a single ``job_id`` so the frontend can poll a single
    endpoint to track per-file progress.

    .. note::
        **Embeddings are deliberately NOT auto-started** for XLSX uploads.
        The pipeline only converts XLSX → Parquet and registers the
        ``XLSXConnector`` so the source becomes visible in
        ``/parquet/sources`` immediately. The user must explicitly trigger
        embedding generation later (e.g. via ``/parquet/refresh/{source_id}``
        or the dedicated UI action) once they've configured a
        ``columns_class`` for the source.

    Returns immediately with a ``job_id`` polled via
    ``GET /parquet/xlsx/pipeline/{job_id}``.
    """
    _UPLOAD_CHUNK = 1024 * 1024  # 1 MB

    if not files:
        raise HTTPException(status_code=400, detail="At least one Excel file is required")

    raw_dir = _project_root() / "data" / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    parquet_dir = _project_root() / "data" / "parquet"
    parquet_dir.mkdir(parents=True, exist_ok=True)

    config_data = _read_yaml_file(_config_yaml_path())
    file_jobs: List[Dict[str, Any]] = []

    try:
        for upload in files:
            if not upload.filename:
                raise HTTPException(status_code=400, detail="Excel filename is required")

            filename = Path(upload.filename).name
            suffix = Path(filename).suffix.lower()
            if suffix not in _XLSX_ALLOWED_SUFFIXES:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Unsupported Excel extension '{suffix}'. "
                        f"Allowed: {sorted(_XLSX_ALLOWED_SUFFIXES)}"
                    ),
                )

            base_source_id = _slugify_identifier(f"{Path(filename).stem}_xlsx")
            final_source_id = _ensure_unique_source_id(config_data, base_source_id)

            target_path = raw_dir / f"{final_source_id}{suffix}"
            tmp_path = target_path.with_suffix(target_path.suffix + ".tmp")

            total_bytes = 0
            try:
                with open(tmp_path, "wb") as fp:
                    while True:
                        chunk = await upload.read(_UPLOAD_CHUNK)
                        if not chunk:
                            break
                        fp.write(chunk)
                        total_bytes += len(chunk)
            except Exception:
                tmp_path.unlink(missing_ok=True)
                raise

            if total_bytes == 0:
                tmp_path.unlink(missing_ok=True)
                raise HTTPException(
                    status_code=400,
                    detail=f"Uploaded Excel file '{filename}' is empty",
                )

            tmp_path.rename(target_path)
            logger.info(
                "XLSX uploaded: %s → %s (%s bytes)",
                filename,
                target_path.name,
                f"{total_bytes:,}",
            )

            parquet_stem = final_source_id
            cache_file = f"data/parquet/{parquet_stem}.parquet"

            source_config = {
                "source_id": final_source_id,
                "type": "xlsx",
                "enabled": True,
                "path": f"data/raw/{target_path.name}",
                "refresh_policy": "manual",
                "description": description or f"Excel import from {filename}",
                "cache_file": cache_file,
            }

            data_sources = _ensure_data_sources_list(config_data)
            data_sources.append(source_config)
            _upsert_source_in_datasources_yaml(source_config)

            file_jobs.append({
                "filename": filename,
                "source_id": final_source_id,
                "xlsx_path": str(target_path),
                "parquet_output": str(_project_root() / cache_file),
                "status": "pending",
                "error": None,
                "results": None,
            })

        _write_yaml_file(_config_yaml_path(), config_data)

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after XLSX upload", exc_info=True)

        job_id = str(uuid.uuid4())
        _xlsx_pipeline_jobs[job_id] = {
            "status": "pending",
            "started_at": time.time(),
            "finished_at": None,
            "error": None,
            "files": file_jobs,
        }

        # Snapshot the per-file source configs *before* we lose request scope —
        # the background task uses them to register connectors after the pipeline.
        source_configs_by_id: Dict[str, Dict[str, Any]] = {
            f["source_id"]: next(
                src for src in data_sources if src.get("source_id") == f["source_id"]
            )
            for f in file_jobs
        }
        connector_manager = getattr(request.app.state, "connector_manager", None)

        def _run_xlsx_batch_pipeline():
            from flows.xlsx_pipeline_flow import run_xlsx_pipeline

            job = _xlsx_pipeline_jobs[job_id]
            job["status"] = "running"
            try:
                for entry in job["files"]:
                    entry["status"] = "running"
                    try:
                        logger.info(
                            "XLSX pipeline [%s]: processing %s",
                            job_id,
                            entry["filename"],
                        )
                        shared = run_xlsx_pipeline(
                            xlsx_path=entry["xlsx_path"],
                            parquet_output=entry["parquet_output"],
                            sheet_name=0,
                        )
                        write_results = shared.get("parquet_write_results") or []
                        primary = write_results[0] if write_results else {}
                        entry["results"] = {
                            "parquet_path": primary.get("filename"),
                            "row_count": primary.get("rows"),
                            "column_count": primary.get("columns"),
                            "sheet_names": shared.get("xlsx_sheet_names") or [],
                            "next_steps": ["configure_columns", "generate_distinct"],
                        }
                        entry["status"] = "completed"
                        logger.info(
                            "XLSX pipeline [%s]: completed %s (%s rows)",
                            job_id,
                            entry["filename"],
                            primary.get("rows"),
                        )

                        # ── Generate DTO + columns_class ────────────────────────
                        # Build a Python DTO under data/classes/dtos/ from the
                        # freshly-written parquet's schema, mirroring the QVD
                        # pipeline.  The DTO is a prerequisite for the (later,
                        # user-triggered) embedding step — without a
                        # ``columns_class`` the EmbeddingNode short-circuits.
                        dto_columns_class: Optional[str] = None
                        try:
                            from nodes.dataloader.xlsx_field_description_node import (
                                generate_xlsx_dto,
                            )

                            primary_parquet = primary.get("filename") or entry["parquet_output"]
                            dto_info = generate_xlsx_dto(
                                primary_parquet,
                                source_id=entry["source_id"],
                            )
                            dto_columns_class = dto_info.get("columns_class")
                            if entry["results"] is not None:
                                entry["results"]["dto_path"] = dto_info.get("dto_path")
                                entry["results"]["columns_class"] = dto_columns_class
                            logger.info(
                                "XLSX pipeline [%s]: DTO generated for %s → %s",
                                job_id,
                                entry["source_id"],
                                dto_info.get("dto_path"),
                            )
                        except Exception as dto_exc:
                            logger.warning(
                                "XLSX pipeline [%s]: DTO generation failed for %s: %s",
                                job_id,
                                entry["source_id"],
                                dto_exc,
                                exc_info=True,
                            )

                        # ── Persist columns_class in datasources.yaml ───────────
                        # So the source carries its DTO reference across app
                        # restarts and is picked up by the EmbeddingNode the
                        # next time the user triggers a refresh.
                        if dto_columns_class:
                            try:
                                src_cfg = source_configs_by_id.get(entry["source_id"])
                                if src_cfg is not None:
                                    src_cfg["columns_class"] = dto_columns_class
                                    _upsert_source_in_datasources_yaml(src_cfg)
                            except Exception as upsert_exc:
                                logger.warning(
                                    "XLSX pipeline [%s]: could not persist "
                                    "columns_class for %s: %s",
                                    job_id,
                                    entry["source_id"],
                                    upsert_exc,
                                )

                        # ── Register the connector (NO embeddings) ──────────────
                        # Important policy: embeddings are NEVER auto-started for
                        # XLSX uploads. The user must explicitly trigger them via
                        # the UI / `/parquet/refresh/{source_id}` once they've
                        # configured a `columns_class` (DTO).
                        #
                        # We deliberately do NOT call
                        # ``connector_manager.refresh_source(...)`` here because
                        # its default ``update_embeddings=True`` would kick off
                        # SBERT encoding immediately. Instead we just register
                        # the connector and read parquet metadata from disk so
                        # the freshly uploaded source becomes visible in
                        # ``/parquet/sources`` without an app restart.
                        if connector_manager is not None:
                            try:
                                from services.connectors.xlsx_connector import (
                                    XLSXConnector,
                                )

                                src_cfg = source_configs_by_id.get(entry["source_id"])
                                if src_cfg and connector_manager.get_connector(
                                    entry["source_id"]
                                ) is None:
                                    connector = XLSXConnector(src_cfg)
                                    connector_manager.register_connector(connector)

                                    # Populate metadata from the parquet file we
                                    # just wrote — mirrors the startup logic in
                                    # main.py so /parquet/sources shows accurate
                                    # row/column counts straight away.
                                    parquet_path = Path(entry["parquet_output"])
                                    if parquet_path.exists():
                                        try:
                                            import pyarrow.parquet as pq

                                            pf = pq.ParquetFile(parquet_path)
                                            connector.metadata.row_count = (
                                                pf.metadata.num_rows
                                            )
                                            connector.metadata.column_count = (
                                                pf.metadata.num_columns
                                            )
                                            connector.metadata.last_refresh_status = (
                                                "success"
                                            )
                                        except Exception as meta_err:
                                            logger.debug(
                                                "Could not read parquet metadata for %s: %s",
                                                entry["source_id"],
                                                meta_err,
                                            )
                                    logger.info(
                                        "XLSX pipeline [%s]: registered connector '%s' "
                                        "(embeddings NOT started — user-triggered only)",
                                        job_id,
                                        entry["source_id"],
                                    )
                            except Exception as reg_err:
                                logger.warning(
                                    "Connector registration after XLSX pipeline "
                                    "failed for %s: %s",
                                    entry["source_id"],
                                    reg_err,
                                )

                    except Exception as exc:
                        logger.error(
                            "XLSX pipeline [%s]: failed for %s: %s",
                            job_id,
                            entry["filename"],
                            exc,
                            exc_info=True,
                        )
                        entry["status"] = "failed"
                        entry["error"] = str(exc)

                statuses = {f["status"] for f in job["files"]}
                if statuses == {"completed"}:
                    job["status"] = "completed"
                elif "completed" in statuses:
                    job["status"] = "partial"
                else:
                    job["status"] = "failed"
                    failed = [f for f in job["files"] if f["status"] == "failed"]
                    if failed:
                        job["error"] = failed[0].get("error")

                try:
                    get_settings(reload=True)
                except Exception:
                    pass

                try:
                    from flows.dto_cache_flow import run_dto_cache_flow
                    parquet_dir_str = str(_project_root() / "data" / "parquet")
                    run_dto_cache_flow(parquet_cache_dir=parquet_dir_str)
                except Exception as dto_err:
                    logger.warning("DTO cache refresh failed after XLSX batch: %s", dto_err)

            except Exception as exc:
                logger.error("XLSX batch pipeline crashed for %s: %s", job_id, exc, exc_info=True)
                job["status"] = "failed"
                job["error"] = str(exc)
            finally:
                job["finished_at"] = time.time()

        background_tasks.add_task(_run_xlsx_batch_pipeline)

        return {
            "success": True,
            "job_id": job_id,
            "file_count": len(file_jobs),
            "source_ids": [f["source_id"] for f in file_jobs],
            "filenames": [f["filename"] for f in file_jobs],
            "message": (
                f"{len(file_jobs)} Excel file(s) uploaded. "
                "XLSX → Parquet conversion running in the background "
                "(embeddings will NOT start until you trigger them manually)."
            ),
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error uploading XLSX sources: %s", str(e), exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/xlsx/pipeline/{job_id}")
async def get_xlsx_pipeline_status(job_id: str):
    """Poll the status of an XLSX batch-pipeline background job."""
    job = _xlsx_pipeline_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Pipeline job not found: {job_id}")

    elapsed = None
    if job["started_at"]:
        end = job["finished_at"] or time.time()
        elapsed = round(end - job["started_at"], 1)

    files_payload = [
        {
            "filename": f["filename"],
            "source_id": f["source_id"],
            "status": f["status"],
            "error": f.get("error"),
            "results": f.get("results"),
        }
        for f in job["files"]
    ]
    completed = sum(1 for f in job["files"] if f["status"] == "completed")
    failed = sum(1 for f in job["files"] if f["status"] == "failed")

    return {
        "job_id": job_id,
        "status": job["status"],
        "elapsed_seconds": elapsed,
        "error": job.get("error"),
        "total_files": len(job["files"]),
        "completed_files": completed,
        "failed_files": failed,
        "files": files_payload,
    }


@parquet_router.post("/supabase/sources")
async def create_supabase_source(request: Request, body: SupabaseSourceCreateRequest):
    """
    Register a new Supabase source in datasource config and connector manager.
    """
    try:
        config_data = _read_yaml_file(_config_yaml_path())
        existing = next((s for s in _ensure_data_sources_list(config_data) if s.get("source_id") == body.source_id), None)
        if existing is not None:
            raise HTTPException(status_code=400, detail=f"Source already exists: {body.source_id}")

        source_config = {
            "source_id": _slugify_identifier(body.source_id),
            "type": "supabase",
            "enabled": bool(body.enabled),
            "host": body.host.strip(),
            "port": int(body.port or 5432),
            "database": body.database.strip(),
            "username": body.username.strip(),
            "password": body.password,
            "db_schema": (body.db_schema or "public").strip(),
            "refresh_policy": body.refresh_policy,
            "description": body.description or "",
            "tables": [],
        }

        _ensure_data_sources_list(config_data).append(source_config)
        _write_yaml_file(_config_yaml_path(), config_data)
        _upsert_source_in_datasources_yaml(source_config)

        connector_manager = getattr(request.app.state, "connector_manager", None)
        validation_ok = False
        if connector_manager is not None:
            from services.connectors.supabase_connector import SupabaseConnector

            connector = SupabaseConnector(source_config)
            if connector_manager.get_connector(source_config["source_id"]) is None:
                connector_manager.register_connector(connector)
            validation_ok = connector.validate_connection()

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after Supabase source create", exc_info=True)

        return {
            "success": True,
            "source_id": source_config["source_id"],
            "validated": validation_ok,
            "message": f"Supabase source '{source_config['source_id']}' created",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error creating Supabase source: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.delete("/sources/{source_id}")
async def delete_source_config(request: Request, source_id: str, delete_files: bool = Query(True)):
    """
    Delete a source configuration. Intended for CSV/manual sources from the settings UI.
    """
    try:
        source_cfg = _find_source_config(source_id)
        if source_cfg is None:
            raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")
        if _is_sql_like_source_type(source_cfg.get("type")):
            raise HTTPException(status_code=400, detail="Use SQL table deletion for SQL-like tables/sources")

        deleted_files: List[str] = []
        if delete_files:
            deleted_files = _delete_source_files(source_cfg)
        else:
            dto_deleted = _delete_dto_file(source_cfg.get("columns_class"))
            if dto_deleted:
                deleted_files.append(dto_deleted)

        deleted_source = _delete_source_from_config_yaml(source_id)
        _delete_source_from_datasources_yaml(source_id)

        connector_manager = getattr(request.app.state, "connector_manager", None)
        if connector_manager is not None and connector_manager.get_connector(source_id) is not None:
            connector_manager.unregister_connector(source_id)

        try:
            from flows.dto_cache_flow import invalidate_cache as _inv_cache
            _inv_cache()
        except Exception:
            pass

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after source delete", exc_info=True)

        return {
            "success": True,
            "source_id": source_id,
            "source_type": deleted_source.get("type"),
            "deleted_files": deleted_files,
            "message": f"Source '{source_id}' deleted",
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting source config for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.patch("/sources/{source_id}")
async def patch_source_enabled(request: Request, source_id: str, body: SourceEnabledPatchRequest):
    """Set ``enabled`` for a source in datasources.yaml and sync ConnectorManager."""
    try:
        path = _config_yaml_path()
        config_data = _read_yaml_file(path)
        data_sources = _ensure_data_sources_list(config_data)
        idx = next((i for i, s in enumerate(data_sources) if s.get("source_id") == source_id), None)
        if idx is None:
            raise HTTPException(status_code=404, detail=f"Source not found: {source_id}")
        data_sources[idx]["enabled"] = body.enabled
        config_data["data_sources"] = data_sources
        _write_yaml_file(path, config_data)

        try:
            cfg_sources = get_settings(reload=True).data_sources
        except Exception:
            logger.warning("Settings reload failed after patch source enabled", exc_info=True)
            cfg_sources = []

        src = next((s for s in cfg_sources if s.source_id == source_id), None)
        connector_manager = getattr(request.app.state, "connector_manager", None)
        if connector_manager is not None:
            if not body.enabled:
                if connector_manager.get_connector(source_id) is not None:
                    connector_manager.unregister_connector(source_id)
            elif src is not None and src.enabled:
                from nodes.dataloader.connector_factory_node import _create_connector

                try:
                    connector = _create_connector(src)
                    if connector_manager.get_connector(source_id) is None:
                        connector_manager.register_connector(connector)
                except Exception as exc:
                    logger.warning(
                        "[patch_source_enabled] Could not register connector for '%s': %s",
                        source_id,
                        exc,
                    )

        return {"success": True, "source_id": source_id, "enabled": body.enabled}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error patching source enabled for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.put("/sql/tables")
async def upsert_sql_table_config(request: Request, body: SQLTableUpsertRequest):
    """
    Add or update a SQL Server table configuration in runtime datasource config and mirror metadata.
    """
    try:
        table_payload = _normalize_sql_table_payload(body.source_id, body.table)
        dto_generated = False
        dto_reused = False
        introspection_skipped_reason: Optional[str] = None

        # DTO resolution strategy (in order):
        #   1. Honour caller-provided columns_class (e.g. UI edit of an existing table).
        #   2. Reuse an existing DTO file at the canonical path — lets users
        #      save a previously-introspected table while the source DB is
        #      offline (e.g. VPN down), matching the behaviour seen on
        #      dev-as_2 where the DTO is committed alongside the YAML entry.
        #   3. Otherwise try live DB introspection. If the DB is unreachable,
        #      degrade gracefully: log a warning and save the table without
        #      a DTO so the user can introspect/refresh later instead of
        #      returning HTTP 500.
        if not table_payload.get("columns_class") and table_payload.get("table_name"):
            existing_dto_path: Optional[Path] = None
            existing_module_ref: Optional[str] = None
            try:
                module_path = _dto_module_path_for_table(table_payload["table_id"])
                candidate = _dto_file_path_from_module(module_path)
                if candidate.exists():
                    existing_dto_path = candidate
                    existing_module_ref = (
                        f"{module_path}:{_dto_function_name_for_table(table_payload['table_id'])}"
                    )
            except HTTPException:
                existing_dto_path = None

            if existing_dto_path is not None and existing_module_ref:
                table_payload["columns_class"] = existing_module_ref
                dto_reused = True
                logger.info(
                    "Reusing existing DTO for '%s.%s' at %s — skipping DB introspection",
                    body.source_id,
                    table_payload["table_id"],
                    existing_dto_path,
                )
            else:
                try:
                    schema_cols = _sql_table_schema_from_connector(
                        request, body.source_id, table_payload["table_name"]
                    )
                except HTTPException as http_exc:
                    # Connection / introspection errors surface as 500 from
                    # ``_sql_table_schema_from_connector``. 404/400 (source
                    # not found / not SQL-like) are real config errors and
                    # should still bubble up.
                    if http_exc.status_code == 500:
                        logger.warning(
                            "DB introspection unavailable for '%s.%s' — saving table "
                            "config without DTO scaffolding (detail: %s)",
                            body.source_id,
                            table_payload["table_id"],
                            http_exc.detail,
                        )
                        introspection_skipped_reason = str(http_exc.detail)
                        schema_cols = None
                    else:
                        raise
                if schema_cols:
                    scaffold_cols = [
                        {
                            "column_name": c["column_name"],
                            "description": f"{c['column_name']} - description à compléter",
                            "type": c["type"],
                            "is_categorical": _infer_categorical_default(c["column_name"], c["type"]),
                        }
                        for c in schema_cols
                    ]
                    table_payload["columns_class"] = _write_dto_for_table(
                        table_payload["table_id"],
                        table_payload.get("table_name") or table_payload["table_id"],
                        scaffold_cols,
                    )
                    dto_generated = True

        source_cfg = _upsert_sql_table_in_config_yaml(body.source_id, table_payload)
        datasource_entry = _upsert_sql_table_in_datasources_yaml(body.source_id, source_cfg, table_payload)

        # Best-effort in-memory connector update (avoids restart for table list visibility)
        connector_manager = getattr(request.app.state, "connector_manager", None)
        if connector_manager is not None:
            connector = connector_manager.connectors.get(body.source_id)
            if connector is not None and _is_sql_like_source_type(getattr(connector, "source_type", None)):
                tables = getattr(connector, "tables", []) or []
                idx = next((i for i, t in enumerate(tables) if t.get("table_id") == table_payload["table_id"]), None)
                if idx is None:
                    tables.append(table_payload)
                else:
                    tables[idx] = {**tables[idx], **table_payload}
                connector.tables = tables

        # Reload cached settings singleton for components that use get_settings()
        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after SQL table upsert", exc_info=True)

        return {
            "success": True,
            "message": f"SQL table '{table_payload['table_id']}' saved for source '{body.source_id}'",
            "source_id": body.source_id,
            "table": table_payload,
            "datasources_yaml_entry": datasource_entry,
            "dto_generated": dto_generated,
            "dto_reused": dto_reused,
            "introspection_skipped_reason": introspection_skipped_reason,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving SQL table config for '{body.source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.delete("/sql/tables")
async def delete_sql_table_config(
    request: Request,
    source_id: str = Query(...),
    table_id: str = Query(...),
    delete_files: bool = Query(False),
):
    """
    Delete a SQL table configuration from runtime config and mirrored datasource metadata.
    """
    try:
        table_cfg = _find_sql_table_config(source_id, table_id)
        if table_cfg is None:
            raise HTTPException(status_code=404, detail=f"Table not found: {source_id}/{table_id}")

        deleted_files: List[str] = []
        if delete_files:
            deleted_files = _delete_cache_files_for_table(table_cfg, source_id, table_id)

        dto_deleted = _delete_dto_file(table_cfg.get("columns_class"))
        if dto_deleted:
            deleted_files.append(dto_deleted)

        source_cfg = _delete_sql_table_from_config_yaml(source_id, table_id)
        removed_datasources = _delete_sql_table_from_datasources_yaml(source_id, table_id)

        connector_manager = getattr(request.app.state, "connector_manager", None)
        if connector_manager is not None:
            connector = connector_manager.connectors.get(source_id)
            if connector is not None and _is_sql_like_source_type(getattr(connector, "source_type", None)):
                tables = getattr(connector, "tables", []) or []
                connector.tables = [t for t in tables if t.get("table_id") != table_id]

        try:
            from flows.dto_cache_flow import invalidate_cache as _inv_cache
            _inv_cache()
        except Exception:
            pass

        try:
            get_settings(reload=True)
        except Exception:
            logger.warning("Settings reload failed after SQL table delete", exc_info=True)

        return {
            "success": True,
            "message": f"SQL table '{table_id}' deleted from source '{source_id}'",
            "source_id": source_id,
            "table_id": table_id,
            "remaining_tables": len(source_cfg.get("tables") or []),
            "removed_datasources": removed_datasources,
            "deleted_files": deleted_files,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error deleting SQL table config for '{source_id}/{table_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.put("/columns/schema")
async def save_column_schema(body: ColumnSchemaSaveRequest):
    """
    Persist column descriptions/types/is_categorical into the source/table DTO file.
    """
    try:
        if body.table_id:
            config_target = _find_sql_table_config(body.source_id, body.table_id)
            if config_target is None:
                raise HTTPException(status_code=404, detail=f"Table config not found: {body.source_id}/{body.table_id}")
        else:
            config_target = _find_source_config(body.source_id)
            if config_target is None:
                raise HTTPException(status_code=404, detail=f"Source config not found: {body.source_id}")

        rendered_columns = [
            {
                "column_name": item.column_name,
                "description": item.description or "",
                "type": _normalize_column_type(item.type),
                "is_categorical": bool(item.is_categorical),
            }
            for item in body.columns
        ]
        columns_class_ref = config_target.get("columns_class")
        if not columns_class_ref:
            if body.table_id:
                raise HTTPException(status_code=400, detail="No valid columns_class configured for this source/table")
            columns_class_ref = _write_dto_for_table(body.source_id, body.source_id, rendered_columns)
            config_target = _set_source_columns_class(body.source_id, columns_class_ref)

        columns_class_ref = str(columns_class_ref)
        if ":" not in columns_class_ref:
            columns_class_ref = f"{columns_class_ref}:get_columns_descriptions"

        module_path, function_name = columns_class_ref.split(":", 1)
        file_path = _dto_file_path_from_module(module_path)
        existing_desc = _read_dto_file_description(file_path)
        content = _render_dto_file(
            body.table_id or body.source_id,
            function_name,
            rendered_columns,
            file_description=existing_desc,
        )
        file_path.write_text(content, encoding="utf-8")

        # Defensive: purge any stale Cython-compiled siblings for this DTO.
        # Older release images baked the DTO as a .so into the app_data volume.
        # CPython's import machinery prefers .so over .py with the same stem,
        # so without this the UI edit would be silently ignored. We also drop
        # the cached module entry so subsequent import_module(...) + reload(...)
        # picks up the freshly written .py.
        stale_removed = 0
        try:
            for stale in file_path.parent.glob(f"{file_path.stem}.cpython-*.so"):
                try:
                    stale.unlink()
                    stale_removed += 1
                except OSError as rm_err:
                    logger.warning("Could not remove stale DTO .so %s: %s", stale, rm_err)
        except OSError as glob_err:
            logger.warning("Could not scan for stale DTO .so in %s: %s", file_path.parent, glob_err)

        import sys as _sys
        for cached in (module_path, f"data.{module_path}"):
            _sys.modules.pop(cached, None)

        return {
            "success": True,
            "source_id": body.source_id,
            "table_id": body.table_id,
            "columns_saved": len(rendered_columns),
            "columns_class": columns_class_ref,
            "dto_path": str(file_path),
            "stale_so_removed": stale_removed,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error saving column schema DTO for '{body.source_id}/{body.table_id}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/columns/suggest")
async def suggest_column_schema(body: ColumnSuggestionRequest):
    """
    Use the configured LLM to suggest business descriptions and categorical flags for columns.
    """
    try:
        suggestions = _generate_column_description_suggestions(body)
        return {
            "source_id": body.source_id,
            "table_id": body.table_id,
            "count": len(suggestions),
            "columns": suggestions,
        }
    except Exception as e:
        logger.error(f"Error generating column suggestions for '{body.source_id}/{body.table_id}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.put("/sources/description")
async def update_file_description(body: FileDescriptionUpdateRequest):
    """Update the get_file_description() in the DTO for a source/table."""
    try:
        if body.table_id:
            config_target = _find_sql_table_config(body.source_id, body.table_id)
        else:
            config_target = _find_source_config(body.source_id)
        if config_target is None:
            raise HTTPException(status_code=404, detail=f"Source config not found: {body.source_id}")

        columns_class_ref = config_target.get("columns_class")
        if not columns_class_ref:
            raise HTTPException(status_code=400, detail="No columns_class configured for this source")

        columns_class_ref = str(columns_class_ref)
        if ":" not in columns_class_ref:
            columns_class_ref = f"{columns_class_ref}:get_columns_descriptions"
        module_path, function_name = columns_class_ref.split(":", 1)
        file_path = _dto_file_path_from_module(module_path)

        if not file_path.exists():
            raise HTTPException(status_code=404, detail=f"DTO file not found: {file_path}")

        import importlib, sys
        data_dir = str(_project_root() / "data")
        if data_dir not in sys.path:
            sys.path.insert(0, data_dir)
        rel = file_path.relative_to(_project_root() / "data")
        mod_name = str(rel.with_suffix("")).replace("/", ".").replace("\\", ".")
        mod = importlib.import_module(mod_name)
        importlib.reload(mod)
        cols_fn = getattr(mod, function_name, None)
        if not cols_fn:
            raise HTTPException(status_code=400, detail=f"Function {function_name} not found in {mod_name}")
        cols_obj = cols_fn()
        rendered_columns = [
            {
                "column_name": c.column_name,
                "description": c.description or "",
                "type": c.type or "string",
                "is_categorical": bool(c.is_categorical),
            }
            for c in cols_obj.columns
        ]

        content = _render_dto_file(
            body.table_id or body.source_id,
            function_name,
            rendered_columns,
            file_description=body.description.strip(),
        )
        file_path.write_text(content, encoding="utf-8")
        importlib.reload(mod)

        from flows.dto_cache_flow import invalidate_cache
        invalidate_cache()

        return {
            "success": True,
            "source_id": body.source_id,
            "table_id": body.table_id,
            "description": body.description.strip(),
            "dto_path": str(file_path),
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating file description for '{body.source_id}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.post("/sources/description/generate")
async def generate_file_description(body: FileDescriptionGenerateRequest):
    """Use LLM to generate a file description based on the DTO columns."""
    try:
        if body.table_id:
            config_target = _find_sql_table_config(body.source_id, body.table_id)
        else:
            config_target = _find_source_config(body.source_id)
        if config_target is None:
            raise HTTPException(status_code=404, detail=f"Source config not found: {body.source_id}")

        columns_class_ref = config_target.get("columns_class")
        if not columns_class_ref:
            raise HTTPException(status_code=400, detail="No columns_class configured for this source")

        columns_class_ref = str(columns_class_ref)
        if ":" not in columns_class_ref:
            columns_class_ref = f"{columns_class_ref}:get_columns_descriptions"
        module_path, function_name = columns_class_ref.split(":", 1)
        file_path = _dto_file_path_from_module(module_path)

        import importlib, sys
        data_dir = str(_project_root() / "data")
        if data_dir not in sys.path:
            sys.path.insert(0, data_dir)
        rel = file_path.relative_to(_project_root() / "data")
        mod_name = str(rel.with_suffix("")).replace("/", ".").replace("\\", ".")
        mod = importlib.import_module(mod_name)
        importlib.reload(mod)
        cols_fn = getattr(mod, function_name, None)
        if not cols_fn:
            raise HTTPException(status_code=400, detail=f"Function {function_name} not found in {mod_name}")
        cols_obj = cols_fn()
        field_names = [c.column_name for c in cols_obj.columns]
        descriptions = {c.column_name: c.description for c in cols_obj.columns}

        stem = body.table_id or body.source_id
        from nodes.dataloader.qvd_field_description_node import get_file_description as _llm_gen_desc
        generated = _llm_gen_desc(stem, field_names, descriptions)

        return {
            "success": True,
            "source_id": body.source_id,
            "table_id": body.table_id,
            "description": generated,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error generating file description for '{body.source_id}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/sources/{source_id}/description")
async def get_file_description_endpoint(
    source_id: str,
    table_id: Optional[str] = Query(None, description="Table ID for per-table DTO"),
):
    """Read the file description from the DTO get_file_description()."""
    try:
        if table_id:
            config_target = _find_sql_table_config(source_id, table_id)
        else:
            config_target = _find_source_config(source_id)
        if config_target is None:
            raise HTTPException(status_code=404, detail=f"Source config not found: {source_id}")

        columns_class_ref = config_target.get("columns_class")
        if not columns_class_ref:
            return {"source_id": source_id, "table_id": table_id, "description": ""}

        columns_class_ref = str(columns_class_ref)
        if ":" in columns_class_ref:
            module_path = columns_class_ref.split(":", 1)[0]
        else:
            module_path = columns_class_ref
        file_path = _dto_file_path_from_module(module_path)
        desc = _read_dto_file_description(file_path)
        return {"source_id": source_id, "table_id": table_id, "description": desc}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading file description for '{source_id}': {e}")
        raise HTTPException(status_code=500, detail=str(e))


def _resolve_cache_path(connector_manager, source_id: str, table_id: Optional[str]) -> Optional[Path]:
    """Best-effort resolve the parquet cache path for a source/table."""
    source_cfg = _find_source_config(source_id) or {}
    cache_dir: Path = connector_manager.cache_manager.base_dir

    if table_id:
        table_cfg = _find_sql_table_config(source_id, table_id) or {}
        raw = table_cfg.get("cache_file")
        if raw:
            p = Path(raw)
            if p.is_absolute() and p.exists():
                return p
            if (cache_dir / p.name).exists():
                return cache_dir / p.name
            if p.exists():
                return p
        return connector_manager.cache_manager.get_cache_path(
            source_id, table_id, cache_type="data", cache_file=raw,
        )

    raw = source_cfg.get("cache_file")
    if raw:
        p = Path(raw)
        if p.is_absolute() and p.exists():
            return p
        if (cache_dir / p.name).exists():
            return cache_dir / p.name
        if p.exists():
            return p

    return connector_manager.cache_manager.get_cache_path(
        source_id, cache_type="data",
    )


def _sample_values_from_cache(
    connector_manager,
    source_id: str,
    table_id: Optional[str],
    column_names: list[str],
    max_samples: int = 6,
) -> dict[str, list]:
    """Read a small slice of the cached parquet and return unique sample values per column."""
    try:
        cache_path = _resolve_cache_path(connector_manager, source_id, table_id)
        if not cache_path or not cache_path.exists():
            return {}
        df = _read_parquet_head(cache_path, limit=50)
        result: dict[str, list] = {}
        for col in column_names:
            if col not in df.columns:
                result[col] = []
                continue
            unique = df[col].dropna().unique()
            result[col] = [
                str(v) for v in unique[:max_samples]
            ]
        return result
    except Exception as exc:
        logger.debug("Could not read sample values for %s/%s: %s", source_id, table_id, exc)
        return {}


@parquet_router.get("/columns/schema")
async def get_column_schema(
    request: Request,
    source_id: str = Query(..., description="Source ID"),
    table_id: Optional[str] = Query(None, description="Table ID for SQL multi-table sources"),
    include_samples: bool = Query(True, description="Include sample values from cached parquet"),
):
    """
    Return DTO-backed ColumnClass metadata (description/type/is_categorical) for a source/table.

    Priority:
    1. Connector.get_columns_classes(table_id) for SQL Server tables
    2. Connector.get_columns_classes() for source-level connectors
    3. Direct DTO import from ``columns_class`` in datasources.yaml
    4. ConnectorManager embedding cache (source-level) fallback
    5. Parquet cache schema inference fallback
    """
    try:
        connector_manager = _get_connector_manager(request)
        connector = connector_manager.connectors.get(source_id)

        columns_classes = None

        # 1/2. Connector-provided DTO metadata
        if connector is not None and hasattr(connector, "get_columns_classes"):
            try:
                if table_id:
                    columns_classes = connector.get_columns_classes(table_id)
                else:
                    columns_classes = connector.get_columns_classes()
            except TypeError:
                if table_id:
                    columns_classes = connector.get_columns_classes(table_id)
            except Exception as e:
                logger.warning(
                    f"Connector DTO schema lookup failed for source '{source_id}'"
                    f"{f' table {table_id}' if table_id else ''}: {e}"
                )

        # 3. Direct DTO import from datasources.yaml columns_class
        if columns_classes is None:
            source_cfg = _find_source_config(source_id)
            if source_cfg is None:
                source_cfg = {}
            columns_class_ref = source_cfg.get("columns_class", "")
            if columns_class_ref:
                try:
                    import importlib as _il
                    import sys as _sys
                    _data_dir = str(_project_root() / "data")
                    if _data_dir not in _sys.path:
                        _sys.path.insert(0, _data_dir)
                    if ":" in columns_class_ref:
                        mod_path, func_name = columns_class_ref.split(":", 1)
                    else:
                        mod_path = columns_class_ref
                        func_name = "get_columns_descriptions"
                    mod = _il.import_module(mod_path)
                    mod = _il.reload(mod)
                    columns_classes = getattr(mod, func_name)()
                except Exception as e:
                    logger.warning(
                        "Direct DTO import for '%s' (ref=%s) failed: %s",
                        source_id, columns_class_ref, e,
                    )

        # 4. Embeddings manager cache fallback
        if columns_classes is None and not table_id:
            columns_classes = connector_manager.get_columns_classes(source_id)

        # 5. Parquet cache schema inference fallback
        if columns_classes is None and not table_id:
            try:
                cache_path = _resolve_cache_path(connector_manager, source_id, table_id)
                if cache_path and cache_path.exists():
                    df = _read_parquet_head(cache_path, limit=100)
                    col_names = [str(c) for c in df.columns]
                    samples = (
                        _sample_values_from_cache(connector_manager, source_id, table_id, col_names)
                        if include_samples else {}
                    )
                    return {
                        "source_id": source_id,
                        "table_id": table_id,
                        "count": len(df.columns),
                        "columns": [
                            {
                                "column_name": str(col),
                                "description": "",
                                "type": _pandas_dtype_to_column_type(df[col].dtype),
                                "is_categorical": _infer_categorical_default(str(col), _pandas_dtype_to_column_type(df[col].dtype)),
                                "sample_values": samples.get(str(col), []),
                            }
                            for col in df.columns
                        ],
                    }
            except Exception as e:
                logger.warning(f"Cache schema fallback failed for source '{source_id}': {e}")

        if columns_classes is None:
            raise HTTPException(
                status_code=404,
                detail=f"No column schema found for source '{source_id}'"
                + (f" table '{table_id}'" if table_id else "")
            )

        col_names = [col.column_name for col in columns_classes.columns]
        samples = (
            _sample_values_from_cache(connector_manager, source_id, table_id, col_names)
            if include_samples else {}
        )

        return {
            "source_id": source_id,
            "table_id": table_id,
            "count": len(columns_classes.columns),
            "columns": [
                {
                    "column_name": col.column_name,
                    "description": col.description,
                    "type": col.type,
                    "is_categorical": col.is_categorical,
                    "sample_values": samples.get(col.column_name, []),
                }
                for col in columns_classes.columns
            ],
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error reading column schema for '{source_id}': {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))


# ── Categorical Distinct (async background job) ──────────────────────────────

def _run_categorical_job(
    job_id: str,
    source_id: str,
    categorical_columns: List[str],
    table_id: Optional[str] = None,
) -> None:
    """Synchronous worker executed via ``run_in_executor``."""
    from flows.categorical_distinct_flow import run_categorical_distinct

    job = _CATEGORICAL_JOBS[job_id]
    job["status"] = "running"
    job["updated_at"] = time.time()

    try:
        result = run_categorical_distinct(
            source_id, categorical_columns, table_id=table_id,
        )
        job.update(result)
        job["status"] = "success" if result.get("success") else "failed"
    except Exception as exc:
        job["status"] = "failed"
        job["error"] = str(exc)
    finally:
        job["updated_at"] = time.time()


@parquet_router.post("/columns/generate-distinct", status_code=202)
async def generate_categorical_distinct(body: CategoricalDistinctRequest):
    """Launch CategoricalDistinctNode in the background for the given columns.

    Returns immediately with a ``job_id``; poll ``GET /columns/generate-distinct/{job_id}``
    for progress.
    """
    if not body.categorical_columns:
        raise HTTPException(status_code=400, detail="No categorical columns provided")

    job_id = f"catdist-{uuid.uuid4().hex[:10]}"
    _CATEGORICAL_JOBS[job_id] = {
        "job_id": job_id,
        "source_id": body.source_id,
        "categorical_columns": body.categorical_columns,
        "status": "queued",
        "created_at": time.time(),
        "updated_at": time.time(),
        "success": None,
        "error": None,
        "distinct_parquet_path": None,
        "summary": None,
        "duration_ms": None,
    }

    loop = asyncio.get_event_loop()
    loop.run_in_executor(
        None,
        lambda: _run_categorical_job(
            job_id, body.source_id, body.categorical_columns,
            body.table_id,
        ),
    )

    return {"job_id": job_id, "status": "queued"}


@parquet_router.get("/columns/generate-distinct/{job_id}")
async def get_categorical_distinct_status(job_id: str):
    """Poll the status of a categorical-distinct background job."""
    job = _CATEGORICAL_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")
    return job


# ---------------------------------------------------------------------------
# Embedding Agent (SSE-capable embedding pipeline)
# ---------------------------------------------------------------------------

@parquet_router.get("/embedding-agent/lookup/{source_id}")
async def lookup_embedding_agent(
    source_id: str,
    table_id: Optional[str] = Query(None),
):
    """Find the most recent embedding-agent job for a source."""
    best = None
    for jid, j in _EMBEDDING_JOBS.items():
        if j["source_id"] != source_id:
            continue
        if table_id and j.get("table_id") != table_id:
            continue
        if best is None or j["started_at"] > best[1]["started_at"]:
            best = (jid, j)

    if not best:
        return {"job_id": None}

    jid, j = best
    elapsed = None
    if j.get("finished_at"):
        elapsed = round(j["finished_at"] - j["started_at"], 1)
    elif j["status"] == "running":
        elapsed = round(time.time() - j["started_at"], 1)

    return {
        "job_id": jid,
        "status": j["status"],
        "source_id": j["source_id"],
        "table_id": j.get("table_id"),
        "error": j.get("error"),
        "elapsed_seconds": elapsed,
        "events": j.get("events", []),
        "last_event": j.get("last_event"),
        "summary": j.get("summary"),
    }


@parquet_router.post("/embedding-agent/{source_id}", status_code=202)
async def start_embedding_agent(
    source_id: str,
    body: CategoricalDistinctRequest,
):
    """Launch the embedding agent pipeline with SSE event reporting.

    Returns immediately with a ``job_id``; stream events via
    ``GET /parquet/embedding-agent/{job_id}/events``.
    """
    if not body.categorical_columns:
        raise HTTPException(status_code=400, detail="No categorical columns provided")

    for jid, existing in _EMBEDDING_JOBS.items():
        if (existing["source_id"] == source_id
                and existing.get("table_id") == body.table_id
                and existing["status"] == "running"):
            return {
                "job_id": jid,
                "source_id": source_id,
                "table_id": body.table_id,
                "message": "Embedding agent already running — reconnecting.",
                "reconnected": True,
            }

    job_id = f"emb-{uuid.uuid4().hex[:12]}"
    job: Dict[str, Any] = {
        "status": "running",
        "source_id": source_id,
        "table_id": body.table_id,
        "categorical_columns": body.categorical_columns,
        "started_at": time.time(),
        "finished_at": None,
        "error": None,
        "events": [],
        "last_event": None,
        "summary": None,
    }
    _EMBEDDING_JOBS[job_id] = job

    def _run():
        try:
            from flows.embedding_agent_flow import run_embedding_agent
            result = run_embedding_agent(
                source_id=source_id,
                categorical_columns=body.categorical_columns,
                table_id=body.table_id,
                job=job,
            )
            if result.get("success"):
                job["status"] = "completed"
                job["summary"] = result.get("summary")
            else:
                job["status"] = "failed"
                job["error"] = result.get("error", "unknown")
        except Exception as exc:
            logger.error("Embedding agent failed: job=%s %s", job_id, exc, exc_info=True)
            job["status"] = "failed"
            job["error"] = str(exc)
        finally:
            job["finished_at"] = time.time()

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run)

    return {
        "job_id": job_id,
        "source_id": source_id,
        "table_id": body.table_id,
        "message": f"Embedding agent started. Stream events at /parquet/embedding-agent/{job_id}/events",
    }


@parquet_router.get("/embedding-agent/{job_id}/events")
async def stream_embedding_events(job_id: str):
    """SSE endpoint streaming reasoning steps for an embedding pipeline job."""
    job = _EMBEDDING_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    async def event_generator():
        last_idx = 0
        while True:
            events = job.get("events", [])
            while last_idx < len(events):
                evt = events[last_idx]
                last_idx += 1
                yield f"data: {json.dumps(evt, default=str)}\n\n"

            if job["status"] in ("completed", "failed"):
                summary = {
                    "step": "summary",
                    "status": job["status"],
                    "error": job.get("error"),
                    "summary": job.get("summary"),
                    "elapsed": round(
                        (job["finished_at"] or time.time()) - job["started_at"], 1
                    ),
                }
                yield f"data: {json.dumps(summary)}\n\n"
                return

            await asyncio.sleep(0.5)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@parquet_router.get("/embedding-agent/{job_id}/status")
async def get_embedding_agent_status(job_id: str):
    """Poll the status of an embedding agent job (non-SSE alternative)."""
    job = _EMBEDDING_JOBS.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job not found: {job_id}")

    elapsed = None
    if job.get("finished_at"):
        elapsed = round(job["finished_at"] - job["started_at"], 1)
    elif job["status"] == "running":
        elapsed = round(time.time() - job["started_at"], 1)

    return {
        "job_id": job_id,
        "status": job["status"],
        "source_id": job["source_id"],
        "table_id": job.get("table_id"),
        "error": job.get("error"),
        "elapsed_seconds": elapsed,
        "events": job.get("events", []),
        "last_event": job.get("last_event"),
        "summary": job.get("summary"),
    }


# ---------------------------------------------------------------------------
# Generic SQL head / preview  (Phase 1e)
# ---------------------------------------------------------------------------

@parquet_router.get("/sql/head")
async def get_sql_table_head(
    request: Request,
    source_id: str = Query(..., description="Data source ID (e.g. oracle_env)"),
    table_id: str = Query(..., description="Table ID (e.g. ca_view)"),
    limit: int = Query(100, ge=1, le=5000, description="Max rows to return"),
):
    """Return a live preview (head) from a SQL data source.

    Works for any SQL-like connector (Oracle, SQL Server, Supabase).
    Returns the same shape as ``/parquet/head`` so the frontend can treat
    both identically.
    """
    try:
        connector_manager = _get_connector_manager(request)
        connector = connector_manager.get_connector(source_id)
        if connector is None:
            raise HTTPException(status_code=404, detail=f"Connector not found: {source_id}")

        df = connector.fetch_table_head(table_id, limit=limit)
        return {
            "file": f"{source_id}_{table_id}_live_preview",
            "source_id": source_id,
            "table_id": table_id,
            "cache_type": "live_preview",
            "rows": _df_to_json_safe(df),
            "columns": list(df.columns),
            "row_count": len(df),
            "column_count": len(df.columns),
            "total_rows": len(df),
            "offset": 0,
        }
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error in sql/head for %s/%s: %s", source_id, table_id, e)
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Cache window configuration  (Phase 1f)
# ---------------------------------------------------------------------------

class CacheWindowBody(BaseModel):
    date_column: str
    months: int = 12


@parquet_router.put("/sources/{source_id}/tables/{table_id}/cache-window")
async def set_cache_window(
    source_id: str,
    table_id: str,
    body: CacheWindowBody,
):
    """Save ``cache_window`` for a SQL table in datasources.yaml."""
    ds_path = Path(__file__).resolve().parent.parent.parent / "config" / "datasources.yaml"
    if not ds_path.exists():
        raise HTTPException(status_code=404, detail="datasources.yaml not found")

    try:
        raw = yaml.safe_load(ds_path.read_text(encoding="utf-8")) or {}
        found = False
        for src in _ensure_data_sources_list(raw):
            if src.get("source_id") != source_id:
                continue
            for tbl in src.get("tables") or []:
                if tbl.get("table_id") == table_id:
                    tbl["cache_window"] = {
                        "date_column": body.date_column,
                        "months": body.months,
                    }
                    found = True
                    break
            break

        if not found:
            raise HTTPException(
                status_code=404,
                detail=f"Table {table_id} not found in source {source_id}",
            )

        ds_path.write_text(
            yaml.dump(raw, default_flow_style=False, allow_unicode=True, sort_keys=False),
            encoding="utf-8",
        )
        return {"status": "ok", "source_id": source_id, "table_id": table_id, "cache_window": body.dict()}
    except HTTPException:
        raise
    except Exception as e:
        logger.error("Error setting cache window: %s", e)
        raise HTTPException(status_code=500, detail=str(e))


@parquet_router.get("/sources/{source_id}/tables/{table_id}/cache-metadata")
async def get_cache_metadata_endpoint(
    request: Request,
    source_id: str,
    table_id: str,
):
    """Return the ``.meta.json`` content for a cached SQL table."""
    connector_manager = _get_connector_manager(request)
    cache_dir = connector_manager.cache_manager.base_dir

    stem = f"{source_id}_{table_id}"
    meta_path = cache_dir / f"{stem}.meta.json"
    if not meta_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"No cache metadata found for {source_id}/{table_id}",
        )

    try:
        return json.loads(meta_path.read_text())
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Semantic Query Cache Administration  (Phase 3c)
# ---------------------------------------------------------------------------

@parquet_router.delete("/query-cache")
async def clear_query_cache(
    source_id: Optional[str] = Query(None, description="Clear only entries for this source (omit to clear all)"),
):
    """Invalidate semantic query cache entries."""
    from services.query_cache import get_query_cache

    cache = get_query_cache()
    if cache is None:
        raise HTTPException(status_code=503, detail="Query cache not initialized")

    count = cache.invalidate(source_id=source_id)
    return {
        "status": "ok",
        "invalidated": count,
        "source_id": source_id,
    }


@parquet_router.get("/query-cache/stats")
async def query_cache_stats():
    """Return statistics about the semantic query cache."""
    from services.query_cache import get_query_cache

    cache = get_query_cache()
    if cache is None:
        return {"status": "not_initialized", "size": 0}

    return {
        "status": "ok",
        "size": cache.size,
        "threshold": cache._threshold,
        "ttl_hours": int(cache._ttl.total_seconds() // 3600),
    }
