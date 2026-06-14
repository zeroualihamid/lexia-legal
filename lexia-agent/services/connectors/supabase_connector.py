"""
Supabase/PostgreSQL connector for multi-source data architecture.

Uses direct PostgreSQL access for schema introspection and table/query fetching.
"""

import importlib
import logging
from typing import Dict, List, Any, Optional

import pandas as pd

try:
    import psycopg2
except ImportError:
    psycopg2 = None

from services.connectors.base_connector import BaseConnector

logger = logging.getLogger(__name__)


class SupabaseConnector(BaseConnector):
    """
    Connector for Supabase Postgres databases.

    Supports:
    - multiple tables per source
    - custom queries
    - per-table DTO metadata
    - schema introspection from information_schema
    """

    def __init__(self, config: Dict[str, Any]):
        super().__init__(config)

        if psycopg2 is None:
            raise ImportError(
                "psycopg2 is required for Supabase connector. "
                "Install with: pip install psycopg2-binary"
            )

        self.host = config.get("host")
        self.port = config.get("port", 5432)
        self.database = config.get("database")
        self.username = config.get("username")
        self.password = config.get("password")
        self.db_schema = config.get("db_schema", "public")
        self.sslmode = config.get("sslmode", "require")
        self.tables = config.get("tables", [])

        if not all([self.host, self.database, self.username, self.password]):
            raise ValueError(
                f"Supabase connector '{self.source_id}' requires: "
                "host, database, username, password"
            )

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

        self.last_refresh_timestamps: Dict[str, Optional[pd.Timestamp]] = {}
        self._connection = None

        logger.info(
            f"SupabaseConnector initialized: {self.source_id} "
            f"({self.host}:{self.port}/{self.database}, schema={self.db_schema}, {len(self.tables)} tables)"
        )

    def _get_connection(self):
        try:
            if self._connection is not None:
                try:
                    cursor = self._connection.cursor()
                    cursor.execute("SELECT 1")
                    cursor.close()
                    return self._connection
                except Exception:
                    try:
                        self._connection.close()
                    except Exception:
                        pass
                    self._connection = None

            self._connection = psycopg2.connect(
                host=self.host,
                port=self.port,
                dbname=self.database,
                user=self.username,
                password=self.password,
                sslmode=self.sslmode,
            )
            return self._connection
        except Exception as e:
            error_msg = f"Failed to connect to Supabase '{self.source_id}': {str(e)}"
            logger.error(error_msg)
            raise ConnectionError(error_msg) from e

    def _close_connection(self):
        if self._connection is not None:
            try:
                self._connection.close()
            except Exception as e:
                logger.warning(f"Error closing connection for '{self.source_id}': {str(e)}")
            finally:
                self._connection = None

    def fetch_data(self, incremental: bool = False, table_id: Optional[str] = None) -> Dict[str, pd.DataFrame]:
        try:
            connection = self._get_connection()
            dataframes = {}

            for table_config in self.tables:
                if not table_config.get("enabled", True):
                    continue
                tid = table_config.get("table_id", table_config.get("table_name"))
                if table_id and tid != table_id:
                    continue
                df = self._fetch_table(connection, table_config, incremental)
                if df is None or df.empty:
                    continue
                table_id = table_config.get("table_id", table_config.get("table_name"))
                df["_source_id"] = self.source_id
                dataframes[table_id] = df

            if not dataframes:
                logger.warning(f"No data fetched for source '{self.source_id}'")
                return {}

            self.update_metadata(status="success")
            return dataframes
        except Exception as e:
            error_msg = f"Failed to fetch data from Supabase '{self.source_id}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e

    # ------------------------------------------------------------------
    # Dialect-specific overrides
    # ------------------------------------------------------------------

    def _date_filter_clause(self, date_column: str, months: int) -> str:
        return f'"{date_column}" >= NOW() - INTERVAL \'{months} months\''

    def _wrap_limit(self, sql: str, limit: int) -> str:
        return f"SELECT * FROM ({sql}) _sub LIMIT {limit}"

    # ------------------------------------------------------------------

    def _fetch_table(
        self,
        connection,
        table_config: Dict[str, Any],
        incremental: bool = False,
    ) -> Optional[pd.DataFrame]:
        table_name = table_config.get("table_name")
        query = table_config.get("query")
        incremental_column = table_config.get("incremental_column")
        table_id = table_config.get("table_id", table_name)

        if query:
            sql = query
        elif table_name:
            sql = f'SELECT * FROM "{self.db_schema}"."{table_name}"'
        else:
            raise ValueError(f"No table_name or query configured for table '{table_id}'")

        params = None
        if incremental and incremental_column and self.last_refresh_timestamps.get(table_id) is not None:
            if "where" in sql.lower():
                sql += f' AND "{incremental_column}" > %(last_ts)s'
            else:
                sql += f' WHERE "{incremental_column}" > %(last_ts)s'
            params = {"last_ts": self.last_refresh_timestamps[table_id]}

        # Rolling window filter (cache_window)
        if not incremental:
            cache_window = table_config.get("cache_window")
            if cache_window:
                date_col = cache_window.get("date_column") if isinstance(cache_window, dict) else getattr(cache_window, "date_column", None)
                months = cache_window.get("months", 12) if isinstance(cache_window, dict) else getattr(cache_window, "months", 12)
                if date_col:
                    clause = self._date_filter_clause(date_col, months)
                    if "where" in sql.lower():
                        sql += f" AND {clause}"
                    else:
                        sql += f" WHERE {clause}"
                    logger.info("Applying cache_window filter for '%s': %s", table_id, clause)

        df = pd.read_sql_query(sql, connection, params=params)

        if not df.empty and incremental_column and incremental_column in df.columns:
            max_timestamp = df[incremental_column].max()
            if pd.notna(max_timestamp):
                self.last_refresh_timestamps[table_id] = pd.Timestamp(max_timestamp)

        return df

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

    def introspect_table_schema(self, table_name: str) -> List[Dict[str, str]]:
        connection = self._get_connection()
        query = """
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema = %s AND table_name = %s
            ORDER BY ordinal_position
        """
        cursor = connection.cursor()
        cursor.execute(query, (self.db_schema, table_name))
        rows = cursor.fetchall()
        cursor.close()

        if not rows:
            return []

        mapped: List[Dict[str, str]] = []
        for row in rows:
            col_name, pg_type = row[0], str(row[1]).lower()
            if pg_type in ("smallint", "integer", "bigint"):
                col_type = "integer"
            elif pg_type in ("numeric", "decimal", "real", "double precision"):
                col_type = "float"
            elif pg_type in ("timestamp without time zone", "timestamp with time zone"):
                col_type = "datetime"
            elif pg_type == "date":
                col_type = "date"
            elif pg_type == "boolean":
                col_type = "boolean"
            else:
                col_type = "string"
            mapped.append({"column_name": str(col_name), "type": col_type})
        return mapped

    def validate_connection(self) -> bool:
        try:
            connection = self._get_connection()
            cursor = connection.cursor()
            cursor.execute("SELECT 1")
            cursor.close()
            return True
        except Exception as e:
            logger.error(f"Supabase validation failed for '{self.source_id}': {e}")
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
            logger.error(f"Failed to load columns classes for '{table_id}': {str(e)}")
            raise ImportError(f"Cannot load columns_class '{columns_class_path}': {str(e)}")

    def __repr__(self) -> str:
        return (
            f"SupabaseConnector(source_id='{self.source_id}', "
            f"host='{self.host}', database='{self.database}', schema='{self.db_schema}')"
        )
