"""
Oracle Database Connector for multi-source data architecture.

Supports Oracle tables, views, and custom SQL queries with the same multi-table
shape used by the SQL Server and Supabase connectors.
"""

import importlib
import logging
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

try:
    import oracledb

    if not getattr(oracledb, "_thick_mode_initialised", False):
        import logging as _logging
        import os as _os
        _boot_logger = _logging.getLogger(__name__)
        _ic_dir = _os.environ.get("ORACLE_CLIENT_LIB_DIR")
        _candidates = [
            _ic_dir,
            "/opt/oracle/instantclient",
            _os.path.expanduser("~/instantclient"),
            "/usr/local/lib",
        ]
        _last_exc: Optional[Exception] = None
        for _path in _candidates:
            if _path and _os.path.isdir(_path):
                try:
                    oracledb.init_oracle_client(lib_dir=_path)
                    oracledb._thick_mode_initialised = True
                    _boot_logger.info(
                        "Oracle Instant Client initialised in THICK mode from %s", _path
                    )
                    break
                except Exception as _exc:
                    _last_exc = _exc
                    continue
        if not getattr(oracledb, "_thick_mode_initialised", False):
            try:
                oracledb.init_oracle_client()
                oracledb._thick_mode_initialised = True
                _boot_logger.info(
                    "Oracle Instant Client initialised in THICK mode via system loader"
                )
            except Exception as _exc:
                _last_exc = _exc
                _boot_logger.warning(
                    "Oracle Instant Client NOT found — staying in THIN mode. "
                    "Legacy password verifiers (DPY-3015) will fail. "
                    "Last error: %s",
                    _last_exc,
                )
except ImportError:
    oracledb = None

from services.connectors.base_connector import BaseConnector

logger = logging.getLogger(__name__)


class OracleConnector(BaseConnector):
    """
    Connector for Oracle databases.

    Supports:
    - multiple tables/views per source
    - custom queries
    - per-table incremental configuration
    - schema introspection via ALL_TAB_COLUMNS
    """

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)
        self._connection = None

        if oracledb is None:
            raise ImportError(
                "oracledb is required for Oracle connector. "
                "Install with: pip install oracledb"
            )

        self.host = config.get("host")
        self.port = config.get("port", 1521)
        self.service_name = config.get("service_name")
        self.username = config.get("username")
        self.password = config.get("password")

        if not all([self.host, self.service_name, self.username, self.password]):
            raise ValueError(
                f"Oracle connector '{self.source_id}' requires: "
                "host, service_name, username, password"
            )

        self.tables = config.get("tables", [])
        if not self.tables:
            simple_table = config.get("table")
            simple_query = config.get("query")
            simple_incremental = config.get("incremental_column")
            if simple_table or simple_query:
                self.tables = [{
                    "table_id": self.source_id,
                    "table_name": simple_table,
                    "query": simple_query,
                    "incremental_column": simple_incremental,
                    "enabled": True,
                    "description": self.metadata.description,
                    "columns_class": None,
                }]

        self.dsn = oracledb.makedsn(
            self.host,
            self.port,
            service_name=self.service_name,
        )
        self.last_refresh_timestamps: Dict[str, Optional[pd.Timestamp]] = {}
        self._conn_lock = threading.Lock()
        self._refresh_lock = threading.Lock()
        self._refreshing = False

        logger.info(
            "OracleConnector initialized: %s (%s:%s/%s, %s tables)",
            self.source_id,
            self.host,
            self.port,
            self.service_name,
            len(self.tables),
        )

    def _get_connection(self):
        with self._conn_lock:
            try:
                if self._connection is not None:
                    try:
                        self._connection.call_timeout = 5000
                        cursor = self._connection.cursor()
                        cursor.execute("SELECT 1 FROM DUAL")
                        cursor.close()
                        self._connection.call_timeout = 0
                        return self._connection
                    except Exception:
                        logger.info("Oracle connection lost for '%s', reconnecting...", self.source_id)
                        try:
                            self._connection.close()
                        except Exception:
                            pass
                        self._connection = None

                logger.info("Connecting to Oracle: %s:%s/%s", self.host, self.port, self.service_name)
                self._connection = oracledb.connect(
                    user=self.username,
                    password=self.password,
                    dsn=self.dsn,
                    tcp_connect_timeout=15,
                )
                return self._connection
            except Exception as e:
                error_msg = f"Failed to connect to Oracle '{self.source_id}': {str(e)}"
                logger.error(error_msg)
                raise ConnectionError(error_msg) from e

    def _close_connection(self):
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception as e:
                logger.warning("Error closing connection for '%s': %s", self.source_id, str(e))
            finally:
                self._connection = None

    def _open_fresh_connection(self, retries: int = 3, backoff: float = 5.0):
        """Open a brand-new Oracle connection with retry + backoff."""
        import time as _time
        self._close_connection()
        last_err = None
        for attempt in range(1, retries + 1):
            try:
                logger.info(
                    "Opening fresh Oracle connection (attempt %d/%d): %s:%s/%s",
                    attempt, retries, self.host, self.port, self.service_name,
                )
                return oracledb.connect(
                    user=self.username,
                    password=self.password,
                    dsn=self.dsn,
                    tcp_connect_timeout=60,
                )
            except Exception as exc:
                last_err = exc
                logger.warning(
                    "Oracle connect attempt %d/%d failed: %s", attempt, retries, exc,
                )
                if attempt < retries:
                    wait = backoff * attempt
                    logger.info("Waiting %.0fs before retry…", wait)
                    _time.sleep(wait)
        raise ConnectionError(
            f"Failed to connect to Oracle '{self.source_id}' after {retries} attempts: {last_err}"
        ) from last_err

    def fetch_data(
        self,
        incremental: bool = False,
        table_id: Optional[str] = None,
    ) -> Dict[str, pd.DataFrame]:
        if not self._refresh_lock.acquire(blocking=False):
            logger.warning(
                "Skipping fetch for '%s' — a refresh is already in progress",
                self.source_id,
            )
            return {}
        self._refreshing = True
        connection = None
        try:
            connection = self._open_fresh_connection()
            dataframes: Dict[str, pd.DataFrame] = {}
            total_rows_written = 0

            for table_config in self.tables:
                if not table_config.get("enabled", True):
                    continue
                tid = table_config.get("table_id", table_config.get("table_name"))
                if table_id and tid != table_id:
                    continue

                try:
                    # Stream directly to parquet — constant memory usage
                    base_dir = Path("data/parquet")
                    dest = base_dir / f"{self.source_id}_{tid}.parquet"
                    row_count = self._stream_table_to_parquet(
                        connection, table_config, dest, incremental,
                    )
                    if row_count == 0:
                        continue

                    # Write .meta.json sidecar
                    self._write_stream_meta(dest, tid, row_count, table_config)
                    total_rows_written += row_count

                    # Return an empty DataFrame with correct schema so
                    # the connector manager skips re-writing the file
                    # (save_dict skips empty frames) but still counts
                    # the table as present.
                    schema = pq.read_schema(str(dest))
                    schema_df = schema.empty_table().to_pandas()
                    dataframes[tid] = schema_df
                except Exception as exc:
                    logger.error(
                        "Error fetching Oracle table '%s' from '%s': %s",
                        table_config.get("table_id"),
                        self.source_id,
                        exc,
                        exc_info=True,
                    )

            if total_rows_written == 0:
                logger.warning("No Oracle data fetched for source '%s'", self.source_id)
                self.update_metadata(status="success")
                return {}

            self.metadata.row_count = total_rows_written
            self.update_metadata(status="success")
            return dataframes
        except Exception as e:
            error_msg = f"Failed to fetch data from Oracle '{self.source_id}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e
        finally:
            if connection is not None:
                try:
                    connection.close()
                except Exception:
                    pass
            self._connection = None
            self._refreshing = False
            self._refresh_lock.release()

    @staticmethod
    def _write_stream_meta(
        parquet_path: Path,
        table_id: str,
        row_count: int,
        table_config: Dict[str, Any],
    ) -> None:
        """Write a .meta.json sidecar after streaming to parquet."""
        import json
        from datetime import datetime, timezone

        pf = pq.read_metadata(str(parquet_path))
        meta: Dict[str, Any] = {
            "source_id": parquet_path.stem.rsplit(f"_{table_id}", 1)[0]
            if f"_{table_id}" in parquet_path.stem
            else parquet_path.stem,
            "table_id": table_id,
            "row_count": row_count,
            "column_count": pf.num_columns,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        tc = table_config or {}
        if tc.get("query"):
            meta["db_table_ref"] = tc["query"].strip()
        elif tc.get("table_name"):
            meta["db_table_ref"] = tc["table_name"]
        meta_path = parquet_path.with_suffix(".meta.json")
        meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2))
        logger.info("Wrote stream meta: %s (%d rows)", meta_path, row_count)

    # ------------------------------------------------------------------
    # Dialect-specific overrides
    # ------------------------------------------------------------------

    def _date_filter_clause(self, date_column: str, months: int) -> str:
        return f"{date_column} >= ADD_MONTHS(SYSDATE, -{months})"

    def _wrap_limit(self, sql: str, limit: int) -> str:
        return f"SELECT * FROM ({sql}) WHERE ROWNUM <= {limit}"

    # ------------------------------------------------------------------

    @staticmethod
    def _oracle_output_type_handler(cursor, metadata):
        """Convert Oracle DATE / TIMESTAMP columns to strings so corrupt
        values (e.g. day-of-month = 31 for a 30-day month) don't crash
        ``pd.read_sql``."""
        if metadata.type_code in (
            oracledb.DB_TYPE_DATE,
            oracledb.DB_TYPE_TIMESTAMP,
            oracledb.DB_TYPE_TIMESTAMP_LTZ,
            oracledb.DB_TYPE_TIMESTAMP_TZ,
        ):
            return cursor.var(
                oracledb.DB_TYPE_VARCHAR, arraysize=cursor.arraysize
            )

    def _build_sql(
        self,
        table_config: Dict[str, Any],
        incremental: bool = False,
    ) -> Tuple[str, Optional[dict]]:
        """Build the SQL query and bind params from *table_config*."""
        table_name = table_config.get("table_name")
        query = table_config.get("query")
        incremental_column = table_config.get("incremental_column")
        table_id = table_config.get("table_id", table_name)

        if query:
            sql = query
        elif table_name:
            sql = f"SELECT * FROM {table_name}"
        else:
            raise ValueError(f"No table_name or query configured for table '{table_id}'")

        params = None
        if incremental and incremental_column and self.last_refresh_timestamps.get(table_id) is not None:
            if "where" in sql.lower():
                sql += f" AND {incremental_column} > :last_ts"
            else:
                sql += f" WHERE {incremental_column} > :last_ts"
            params = {"last_ts": self.last_refresh_timestamps[table_id]}

        # Rolling window filter (cache_window)
        cache_window = table_config.get("cache_window")
        if cache_window and not incremental:
            date_col = cache_window.get("date_column") if isinstance(cache_window, dict) else getattr(cache_window, "date_column", None)
            months = cache_window.get("months", 12) if isinstance(cache_window, dict) else getattr(cache_window, "months", 12)
            if date_col:
                clause = self._date_filter_clause(date_col, months)
                if "where" in sql.lower():
                    sql += f" AND {clause}"
                else:
                    sql += f" WHERE {clause}"
                logger.info(
                    "Applying cache_window filter for '%s': %s",
                    table_id, clause,
                )

        return sql, params

    def _fetch_table(
        self,
        connection,
        table_config: Dict[str, Any],
        incremental: bool = False,
    ) -> Optional[pd.DataFrame]:
        table_id = table_config.get("table_id", table_config.get("table_name"))
        sql, params = self._build_sql(table_config, incremental)

        prev_handler = connection.outputtypehandler
        connection.outputtypehandler = self._oracle_output_type_handler
        try:
            logger.info("Fetching table '%s': %s", table_id, sql[:200])
            cursor = connection.cursor()
            batch_size = 50_000
            cursor.arraysize = batch_size
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(sql)
            columns = [col[0] for col in cursor.description]

            chunks: list[pd.DataFrame] = []
            total_fetched = 0
            while True:
                batch = cursor.fetchmany(batch_size)
                if not batch:
                    break
                chunks.append(pd.DataFrame(batch, columns=columns))
                total_fetched += len(batch)
                logger.info(
                    "Fetched %d rows so far for table '%s'",
                    total_fetched, table_id,
                )
            cursor.close()

            if chunks:
                df = pd.concat(chunks, ignore_index=True)
            else:
                df = pd.DataFrame(columns=columns)
            logger.info("Fetched %d total rows for table '%s'", len(df), table_id)
        finally:
            connection.outputtypehandler = prev_handler

        incremental_column = table_config.get("incremental_column")
        if not df.empty and incremental_column and incremental_column in df.columns:
            try:
                max_timestamp = pd.to_datetime(df[incremental_column], errors="coerce").max()
                if pd.notna(max_timestamp):
                    self.last_refresh_timestamps[table_id] = pd.Timestamp(max_timestamp)
            except Exception:
                pass

        return df

    # ------------------------------------------------------------------
    # Streaming parquet writer — constant-memory download for huge tables
    # ------------------------------------------------------------------

    def _stream_table_to_parquet(
        self,
        connection,
        table_config: Dict[str, Any],
        dest_path: Path,
        incremental: bool = False,
    ) -> int:
        """Fetch rows in batches and write them directly to a parquet file.

        Returns the total number of rows written.  Memory usage stays
        proportional to *batch_size* regardless of total table size.
        """
        from nodes.dataloader.parquet_writer_node import sanitise_for_parquet

        table_id = table_config.get("table_id", table_config.get("table_name"))
        sql, params = self._build_sql(table_config, incremental)

        prev_handler = connection.outputtypehandler
        connection.outputtypehandler = self._oracle_output_type_handler
        try:
            logger.info("Streaming table '%s' → %s : %s", table_id, dest_path, sql[:200])
            cursor = connection.cursor()
            batch_size = 50_000
            cursor.arraysize = batch_size
            if params:
                cursor.execute(sql, params)
            else:
                cursor.execute(sql)
            columns = [col[0] for col in cursor.description]

            dest_path.parent.mkdir(parents=True, exist_ok=True)
            writer: Optional[pq.ParquetWriter] = None
            total_rows = 0

            try:
                while True:
                    rows = cursor.fetchmany(batch_size)
                    if not rows:
                        break
                    chunk_df = pd.DataFrame(rows, columns=columns)
                    chunk_df["_source_id"] = self.source_id
                    chunk_df = sanitise_for_parquet(chunk_df)
                    table = pa.Table.from_pandas(chunk_df, preserve_index=False)

                    if writer is None:
                        writer = pq.ParquetWriter(
                            str(dest_path),
                            table.schema,
                            compression="snappy",
                        )
                    writer.write_table(table)
                    total_rows += len(rows)
                    logger.info(
                        "Streamed %d rows so far for table '%s'",
                        total_rows, table_id,
                    )
            finally:
                if writer is not None:
                    writer.close()

            cursor.close()
            logger.info(
                "Finished streaming %d rows for table '%s' → %s",
                total_rows, table_id, dest_path,
            )
            return total_rows
        finally:
            connection.outputtypehandler = prev_handler

    def fetch_table_head(self, table_id: str, limit: int = 100) -> pd.DataFrame:
        """Override base to use the safe output type handler for Oracle dates."""
        table_config = self._find_table_config(table_id)
        if table_config is None:
            raise ValueError(f"Table '{table_id}' not found in connector '{self.source_id}'")
        query = table_config.get("query")
        table_name = table_config.get("table_name")
        if query:
            base_sql = query
        elif table_name:
            base_sql = f"SELECT * FROM {table_name}"
        else:
            raise ValueError(f"No query or table_name for table '{table_id}'")
        limited_sql = self._wrap_limit(base_sql, limit)
        connection = self._get_connection()
        prev_handler = connection.outputtypehandler
        connection.outputtypehandler = self._oracle_output_type_handler
        try:
            cursor = connection.cursor()
            cursor.arraysize = max(limit, 100)
            cursor.execute(limited_sql)
            columns = [col[0] for col in cursor.description]
            rows = cursor.fetchall()
            cursor.close()
            return pd.DataFrame(rows, columns=columns)
        finally:
            connection.outputtypehandler = prev_handler

    def get_schema(self) -> Dict[str, str]:
        if not self.tables:
            return {}
        first_table = next((t for t in self.tables if t.get("enabled", True)), None)
        if not first_table or not first_table.get("table_name"):
            return {}
        return {
            col["column_name"]: col["type"]
            for col in self.introspect_table_schema(first_table["table_name"])
        }

    def _split_owner_and_object_name(self, table_name: str) -> Tuple[Optional[str], str]:
        raw = (table_name or "").strip().strip('"')
        if "." not in raw:
            return None, raw.upper()
        owner, object_name = raw.split(".", 1)
        return owner.strip('"').upper(), object_name.strip('"').upper()

    def introspect_table_schema(self, table_name: str) -> List[Dict[str, str]]:
        connection = self._get_connection()
        owner, object_name = self._split_owner_and_object_name(table_name)

        if owner:
            query = """
                SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
                FROM ALL_TAB_COLUMNS
                WHERE OWNER = :owner AND TABLE_NAME = :table_name
                ORDER BY COLUMN_ID
            """
            params = {"owner": owner, "table_name": object_name}
        else:
            query = """
                SELECT COLUMN_NAME, DATA_TYPE, DATA_LENGTH
                FROM ALL_TAB_COLUMNS
                WHERE TABLE_NAME = :table_name
                ORDER BY COLUMN_ID
            """
            params = {"table_name": object_name}

        cursor = connection.cursor()
        cursor.execute(query, params)
        rows = cursor.fetchall()
        cursor.close()

        if not rows:
            return []

        mapped: List[Dict[str, str]] = []
        for row in rows:
            col_name, oracle_type, data_length = row[0], str(row[1]).upper(), row[2]
            if oracle_type in ("NUMBER", "INTEGER", "INT", "SMALLINT"):
                col_type = "integer"
            elif oracle_type in ("FLOAT", "DOUBLE PRECISION", "REAL", "BINARY_FLOAT", "BINARY_DOUBLE"):
                col_type = "float"
            elif oracle_type in ("DATE", "TIMESTAMP", "TIMESTAMP WITH TIME ZONE", "TIMESTAMP WITH LOCAL TIME ZONE"):
                col_type = "datetime"
            elif oracle_type == "CHAR" and data_length == 1:
                col_type = "string"
            else:
                col_type = "string"
            mapped.append({"column_name": str(col_name), "type": col_type})
        return mapped

    def validate_connection(self) -> bool:
        try:
            connection = self._get_connection()
            cursor = connection.cursor()
            cursor.execute("SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1")
            cursor.fetchone()
            cursor.close()
            return True
        except Exception as e:
            logger.error("Oracle connection validation failed for '%s': %s", self.source_id, str(e))
            return False

    def supports_incremental(self) -> bool:
        return any(
            table.get("incremental_column") is not None
            for table in self.tables
            if table.get("enabled", True)
        )

    def get_columns_classes(self, table_id: str):
        table_config = next((t for t in self.tables if t.get("table_id") == table_id), None)
        if not table_config:
            raise ValueError(f"Table '{table_id}' not found in connector '{self.source_id}'")

        columns_class_path = table_config.get("columns_class")
        if not columns_class_path:
            raise ValueError(f"Table '{table_id}' does not have 'columns_class' configured")

        try:
            module_path, function_name = columns_class_path.split(":")
            module = importlib.import_module(module_path)
            module = importlib.reload(module)
            function = getattr(module, function_name)
            return function()
        except Exception as e:
            logger.error("Failed to load columns classes for '%s': %s", table_id, str(e))
            raise ImportError(
                f"Cannot load columns_class '{columns_class_path}': {str(e)}"
            ) from e

    def get_oracle_info(self) -> Dict[str, Any]:
        try:
            connection = self._get_connection()
            cursor = connection.cursor()
            cursor.execute("SELECT BANNER FROM V$VERSION WHERE ROWNUM = 1")
            version = cursor.fetchone()[0]
            cursor.close()

            enabled_tables = [
                table
                for table in self.tables
                if table.get("enabled", True)
            ]

            return {
                "source_id": self.source_id,
                "host": self.host,
                "port": self.port,
                "service_name": self.service_name,
                "version": version,
                "tables": [
                    {
                        "table_id": table.get("table_id"),
                        "table_name": table.get("table_name"),
                        "query": table.get("query"),
                        "enabled": table.get("enabled", True),
                    }
                    for table in enabled_tables
                ],
            }
        except Exception as e:
            logger.error("Failed to get Oracle info for '%s': %s", self.source_id, str(e))
            return {"source_id": self.source_id, "error": str(e)}

    def __del__(self):
        self._close_connection()

    def __repr__(self) -> str:
        return (
            f"OracleConnector(source_id='{self.source_id}', "
            f"host='{self.host}', service_name='{self.service_name}', "
            f"tables={len(self.tables)})"
        )
