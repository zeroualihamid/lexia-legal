"""
SQL Server Connector for multi-source data architecture.

Supports multiple tables per connector with individual column definitions,
incremental updates, and automatic refresh.
"""

import logging
import importlib
from pathlib import Path
from typing import Dict, List, Any, Optional
import pandas as pd

try:
    import pyodbc
except ImportError:
    pyodbc = None

from services.connectors.base_connector import BaseConnector, RefreshPolicy

logger = logging.getLogger(__name__)


class SQLServerConnector(BaseConnector):
    """
    Connector for Microsoft SQL Server databases.

    Features:
    - Multiple tables per connector instance
    - Per-table column definitions (Pydantic classes)
    - Incremental updates using timestamp column
    - Connection pooling
    - Schema introspection

    Each table can have:
    - Physical table name or custom query
    - Its own ColumnsClasses definition
    - Incremental update column (optional)
    - Enable/disable flag
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize SQL Server connector.

        Args:
            config: Configuration dictionary with keys:
                - source_id: Unique identifier
                - type: "sqlserver"
                - host: SQL Server hostname
                - port: SQL Server port (default: 1433)
                - database: Database name
                - username: SQL Server username
                - password: SQL Server password
                - tables: List of table configurations (optional)
                - table: Single table name (for simple use case)
                - query: Custom SQL query (for simple use case)
                - incremental_column: Column for incremental updates
                - refresh_policy: Refresh policy
                - refresh_interval_seconds: Interval for polling
        """
        super().__init__(config)

        if pyodbc is None:
            raise ImportError(
                "pyodbc is required for SQL Server connector. "
                "Install with: pip install pyodbc"
            )

        # SQL Server connection parameters
        self.host = config.get("host")
        self.port = config.get("port", 1433)
        self.database = config.get("database")
        self.username = config.get("username")
        self.password = config.get("password")

        # Validate required fields
        if not all([self.host, self.database, self.username, self.password]):
            raise ValueError(
                f"SQL Server connector '{self.source_id}' requires: "
                "host, database, username, password"
            )

        # Build connection string
        self.connection_string = (
            f"DRIVER={{ODBC Driver 17 for SQL Server}};"
            f"SERVER={self.host},{self.port};"
            f"DATABASE={self.database};"
            f"UID={self.username};"
            f"PWD={self.password};"
            "Encrypt=yes;"
            "TrustServerCertificate=yes;"
        )

        # Table configurations
        self.tables = config.get("tables", [])

        # If no tables specified, check for simple single-table config
        if not self.tables:
            simple_table = config.get("table")
            simple_query = config.get("query")
            simple_incremental = config.get("incremental_column")

            if simple_table or simple_query:
                # Create a single table config
                self.tables = [{
                    "table_id": self.source_id,
                    "table_name": simple_table,
                    "query": simple_query,
                    "incremental_column": simple_incremental,
                    "enabled": True,
                    "description": self.metadata.description,
                    "columns_class": None,  # Will need to be provided
                }]

        # Track last refresh timestamp per table for incremental updates
        self.last_refresh_timestamps: Dict[str, Optional[pd.Timestamp]] = {}

        # Connection object (lazy initialization)
        self._connection = None

        logger.info(
            f"SQLServerConnector initialized: {self.source_id} "
            f"({self.host}:{self.port}/{self.database}, {len(self.tables)} tables)"
        )

    def _get_connection(self):
        """
        Get or create SQL Server connection.

        Returns:
            pyodbc.Connection object

        Raises:
            ConnectionError: If unable to connect
        """
        try:
            # Test existing connection
            if self._connection is not None:
                try:
                    # Quick connectivity check
                    cursor = self._connection.cursor()
                    cursor.execute("SELECT 1")
                    cursor.close()
                    return self._connection
                except Exception:
                    # Connection dead, reconnect
                    logger.info(f"SQL Server connection lost for '{self.source_id}', reconnecting...")
                    try:
                        self._connection.close()
                    except Exception:
                        pass
                    self._connection = None

            # Create new connection
            logger.info(f"Connecting to SQL Server: {self.host}:{self.port}/{self.database}")
            self._connection = pyodbc.connect(self.connection_string, timeout=30)

            return self._connection

        except Exception as e:
            error_msg = f"Failed to connect to SQL Server '{self.source_id}': {str(e)}"
            logger.error(error_msg)
            raise ConnectionError(error_msg) from e

    def _close_connection(self):
        """Close SQL Server connection."""
        if self._connection is not None:
            try:
                self._connection.close()
                logger.debug(f"Closed SQL Server connection for '{self.source_id}'")
            except Exception as e:
                logger.warning(f"Error closing connection for '{self.source_id}': {str(e)}")
            finally:
                self._connection = None

    def fetch_data(self, incremental: bool = False, table_id: Optional[str] = None) -> Dict[str, pd.DataFrame]:
        """
        Fetch data from SQL Server.

        For multi-table connectors, fetches all enabled tables separately.

        Args:
            incremental: If True, attempt incremental update where supported
            table_id: If provided, only fetch this specific table

        Returns:
            Dictionary mapping table_id to DataFrame (e.g., {"commande_entete": df1, "commande_lignes": df2})

        Raises:
            ConnectionError: If unable to connect
            ValueError: If query fails
        """
        try:
            connection = self._get_connection()

            dataframes = {}

            # Fetch each enabled table
            for table_config in self.tables:
                if not table_config.get("enabled", True):
                    logger.info(f"Skipping disabled table: {table_config.get('table_id')}")
                    continue
                tid = table_config.get("table_id", table_config.get("table_name"))
                if table_id and tid != table_id:
                    continue

                try:
                    df = self._fetch_table(connection, table_config, incremental)
                    if df is not None and not df.empty:
                        table_id = table_config.get('table_id', table_config.get('table_name'))

                        # Add source identifier to each table
                        df['_source_id'] = self.source_id

                        dataframes[table_id] = df
                        logger.info(
                            f"Fetched table '{table_id}': "
                            f"{len(df)} rows, {len(df.columns)} columns"
                        )
                except Exception as e:
                    logger.error(
                        f"Error fetching table '{table_config.get('table_id')}': {str(e)}"
                    )
                    # Continue with other tables
                    continue

            if not dataframes:
                logger.warning(f"No data fetched for source '{self.source_id}'")
                return {}

            # Update metadata with summary
            total_rows = sum(len(df) for df in dataframes.values())
            self.update_metadata(status="success")

            logger.info(
                f"Successfully fetched '{self.source_id}': "
                f"{total_rows} total rows from {len(dataframes)} tables"
            )

            return dataframes

        except Exception as e:
            error_msg = f"Failed to fetch data from SQL Server '{self.source_id}': {str(e)}"
            logger.error(error_msg)
            self.update_metadata(status="error", error=error_msg)
            raise Exception(error_msg) from e

    # ------------------------------------------------------------------
    # Dialect-specific overrides
    # ------------------------------------------------------------------

    def _date_filter_clause(self, date_column: str, months: int) -> str:
        return f"{date_column} >= DATEADD(MONTH, -{months}, GETDATE())"

    def _wrap_limit(self, sql: str, limit: int) -> str:
        return f"SELECT TOP {limit} * FROM ({sql}) _sub"

    # ------------------------------------------------------------------

    def _fetch_table(
        self,
        connection,
        table_config: Dict[str, Any],
        incremental: bool = False
    ) -> Optional[pd.DataFrame]:
        table_id = table_config.get('table_id')
        table_name = table_config.get('table_name')
        custom_query = table_config.get('query')
        incremental_column = table_config.get('incremental_column')

        if custom_query:
            query = custom_query
        elif table_name:
            query = f"SELECT * FROM {table_name}"
        else:
            raise ValueError(f"Table '{table_id}' must have either 'table_name' or 'query'")

        if incremental and incremental_column:
            last_timestamp = self.last_refresh_timestamps.get(table_id)
            if last_timestamp:
                if "WHERE" in query.upper():
                    query += f" AND {incremental_column} > ?"
                else:
                    query += f" WHERE {incremental_column} > ?"

                df = pd.read_sql(query, connection, params=[last_timestamp])
            else:
                df = pd.read_sql(query, connection)
        else:
            # Rolling window filter (cache_window)
            cache_window = table_config.get("cache_window")
            if cache_window:
                date_col = cache_window.get("date_column") if isinstance(cache_window, dict) else getattr(cache_window, "date_column", None)
                months = cache_window.get("months", 12) if isinstance(cache_window, dict) else getattr(cache_window, "months", 12)
                if date_col:
                    clause = self._date_filter_clause(date_col, months)
                    if "WHERE" in query.upper():
                        query += f" AND {clause}"
                    else:
                        query += f" WHERE {clause}"
                    logger.info("Applying cache_window filter for '%s': %s", table_id, clause)

            df = pd.read_sql(query, connection)

        if not df.empty and incremental_column and incremental_column in df.columns:
            max_timestamp = df[incremental_column].max()
            if pd.notna(max_timestamp):
                self.last_refresh_timestamps[table_id] = pd.Timestamp(max_timestamp)

        return df

    def get_schema(self) -> Dict[str, str]:
        """
        Get schema information for all tables.

        Returns:
            Dictionary mapping column names to data types
        """
        try:
            connection = self._get_connection()

            schema = {}

            for table_config in self.tables:
                if not table_config.get("enabled", True):
                    continue

                table_name = table_config.get('table_name')
                if not table_name:
                    # Skip custom queries (can't introspect easily)
                    continue

                # Query INFORMATION_SCHEMA
                query = """
                    SELECT COLUMN_NAME, DATA_TYPE
                    FROM INFORMATION_SCHEMA.COLUMNS
                    WHERE TABLE_NAME = ?
                    ORDER BY ORDINAL_POSITION
                """

                cursor = connection.cursor()
                cursor.execute(query, (table_name,))

                for row in cursor.fetchall():
                    col_name = row[0]
                    sql_type = row[1]

                    # Map SQL types to readable types
                    if sql_type in ('int', 'bigint', 'smallint', 'tinyint'):
                        schema[col_name] = 'integer'
                    elif sql_type in ('float', 'real', 'decimal', 'numeric', 'money'):
                        schema[col_name] = 'float'
                    elif sql_type in ('datetime', 'datetime2', 'datetimeoffset'):
                        schema[col_name] = 'datetime'
                    elif sql_type == 'date':
                        schema[col_name] = 'date'
                    elif sql_type == 'bit':
                        schema[col_name] = 'boolean'
                    else:
                        schema[col_name] = 'string'

                cursor.close()

            # Add metadata columns
            schema['_source_id'] = 'string'
            schema['_table_name'] = 'string'

            return schema

        except Exception as e:
            logger.error(f"Failed to get schema for '{self.source_id}': {str(e)}")
            return {}

    def validate_connection(self) -> bool:
        """
        Validate SQL Server connection.

        Returns:
            True if connection successful
        """
        try:
            connection = self._get_connection()

            # Test query
            cursor = connection.cursor()
            cursor.execute("SELECT @@VERSION")
            version = cursor.fetchone()[0]
            cursor.close()

            logger.info(
                f"SQL Server connection validated for '{self.source_id}': {version[:50]}..."
            )
            return True

        except Exception as e:
            logger.error(f"SQL Server connection validation failed for '{self.source_id}': {str(e)}")
            return False

    def supports_incremental(self) -> bool:
        """
        Check if any table supports incremental updates.

        Returns:
            True if at least one table has incremental_column configured
        """
        return any(
            table.get('incremental_column') is not None
            for table in self.tables
            if table.get('enabled', True)
        )

    def get_columns_classes(self, table_id: str):
        """
        Load ColumnsClasses for a specific table.

        Args:
            table_id: Identifier of the table

        Returns:
            ColumnsClasses object for the table

        Raises:
            ValueError: If table not found or columns_class not configured
            ImportError: If columns_class module cannot be loaded
        """
        # Find table config
        table_config = next(
            (t for t in self.tables if t.get('table_id') == table_id),
            None
        )

        if not table_config:
            raise ValueError(f"Table '{table_id}' not found in connector '{self.source_id}'")

        columns_class_path = table_config.get('columns_class')
        if not columns_class_path:
            raise ValueError(
                f"Table '{table_id}' does not have 'columns_class' configured"
            )

        # Parse module:function path
        # Example: "qclick.classes.sql_tables.transactions:get_transactions_columns_descriptions"
        try:
            module_path, function_name = columns_class_path.split(':')
            module = importlib.import_module(module_path)
            module = importlib.reload(module)
            function = getattr(module, function_name)
            columns_classes = function()

            logger.debug(f"Loaded columns classes for table '{table_id}' from {columns_class_path}")
            return columns_classes

        except Exception as e:
            logger.error(f"Failed to load columns classes for '{table_id}': {str(e)}")
            raise ImportError(
                f"Cannot load columns_class '{columns_class_path}': {str(e)}"
            ) from e

    def __del__(self):
        """Cleanup: close connection on deletion."""
        self._close_connection()

    def __repr__(self) -> str:
        return (
            f"SQLServerConnector(source_id='{self.source_id}', "
            f"host='{self.host}', database='{self.database}', "
            f"tables={len(self.tables)})"
        )
