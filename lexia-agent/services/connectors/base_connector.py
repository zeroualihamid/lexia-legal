"""
Base connector interface for multi-source data architecture.

This module defines the abstract base class for all data source connectors,
enabling pluggable support for QVD, SQL Server, CSV, Oracle, and other sources.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional, Any
import logging
import pandas as pd

logger = logging.getLogger(__name__)


class RefreshPolicy(Enum):
    """Data source refresh policies."""
    MANUAL = "manual"  # User-triggered refresh only
    POLLING = "polling"  # Automatic refresh on interval
    INCREMENTAL = "incremental"  # Fetch only new/changed data


@dataclass
class DataSourceMetadata:
    """Metadata tracking for a data source."""
    source_id: str
    source_type: str
    description: str
    refresh_policy: RefreshPolicy
    refresh_interval_seconds: Optional[int] = None
    last_refresh: Optional[datetime] = None
    last_refresh_status: str = "never"  # never, success, error
    last_error: Optional[str] = None
    row_count: int = 0
    column_count: int = 0
    cache_path: Optional[str] = None
    incremental_column: Optional[str] = None
    extra_metadata: Dict[str, Any] = field(default_factory=dict)

    def needs_refresh(self) -> bool:
        """Check if source needs refresh based on policy and interval."""
        if self.refresh_policy == RefreshPolicy.MANUAL:
            return False

        if self.last_refresh is None:
            return True

        if self.refresh_policy == RefreshPolicy.POLLING and self.refresh_interval_seconds:
            elapsed = (datetime.now() - self.last_refresh).total_seconds()
            return elapsed >= self.refresh_interval_seconds

        return False


class BaseConnector(ABC):
    """
    Abstract base class for data source connectors.

    All connectors must implement:
    - fetch_data(): Retrieve data from source
    - get_schema(): Return column definitions
    - validate_connection(): Check if source is accessible
    - supports_incremental(): Whether incremental updates are supported
    """

    def __init__(self, config: Dict[str, Any]):
        """
        Initialize connector with configuration.

        Args:
            config: Dictionary containing connector configuration
                Required keys: source_id, type, refresh_policy
        """
        self.config = config
        self.source_id = config["source_id"]
        self.source_type = config["type"]

        # Parse refresh policy
        refresh_policy_str = config.get("refresh_policy", "manual")
        self.refresh_policy = RefreshPolicy(refresh_policy_str)

        # Initialize metadata
        self.metadata = DataSourceMetadata(
            source_id=self.source_id,
            source_type=self.source_type,
            description=config.get("description", ""),
            refresh_policy=self.refresh_policy,
            refresh_interval_seconds=config.get("refresh_interval_seconds"),
        )

    @abstractmethod
    def fetch_data(self, incremental: bool = False, table_id: Optional[str] = None) -> pd.DataFrame:
        """
        Fetch data from the source.

        Args:
            incremental: If True, fetch only new/changed data since last refresh
            table_id: If provided, only fetch this specific table (multi-table sources)

        Returns:
            DataFrame with data from source, including _source_id column

        Raises:
            ConnectionError: If unable to connect to source
            ValueError: If data format is invalid
        """
        pass

    @abstractmethod
    def get_schema(self) -> Dict[str, str]:
        """
        Get schema information for the data source.

        Returns:
            Dictionary mapping column names to data types
            Example: {"CustomerID": "string", "Amount": "float64"}
        """
        pass

    @abstractmethod
    def validate_connection(self) -> bool:
        """
        Validate that the data source is accessible.

        Returns:
            True if connection successful, False otherwise
        """
        pass

    def supports_incremental(self) -> bool:
        """
        Check if this connector supports incremental updates.

        Returns:
            True if incremental updates are supported
        """
        return False

    def needs_refresh(self) -> bool:
        """
        Check if data source needs refresh based on policy and interval.

        Returns:
            True if refresh is needed
        """
        return self.metadata.needs_refresh()

    def update_metadata(
        self,
        df: Optional[pd.DataFrame] = None,
        status: str = "success",
        error: Optional[str] = None
    ):
        """
        Update metadata after refresh operation.

        Args:
            df: DataFrame that was fetched (for row/column counts)
            status: Refresh status ("success" or "error")
            error: Error message if status is "error"
        """
        self.metadata.last_refresh = datetime.now()
        self.metadata.last_refresh_status = status
        self.metadata.last_error = error

        if df is not None:
            self.metadata.row_count = len(df)
            self.metadata.column_count = len(df.columns)

    def get_metadata_dict(self) -> Dict[str, Any]:
        """
        Get metadata as dictionary for serialization.

        Returns:
            Dictionary with metadata fields
        """
        return {
            "source_id": self.metadata.source_id,
            "source_type": self.metadata.source_type,
            "description": self.metadata.description,
            "refresh_policy": self.metadata.refresh_policy.value,
            "refresh_interval_seconds": self.metadata.refresh_interval_seconds,
            "last_refresh": self.metadata.last_refresh.isoformat() if self.metadata.last_refresh else None,
            "last_refresh_status": self.metadata.last_refresh_status,
            "last_error": self.metadata.last_error,
            "row_count": self.metadata.row_count,
            "column_count": self.metadata.column_count,
            "cache_path": self.metadata.cache_path,
            "incremental_column": self.metadata.incremental_column,
            "supports_incremental": self.supports_incremental(),
            **self.metadata.extra_metadata
        }

    # ------------------------------------------------------------------
    # Cache window helpers (overridden per dialect)
    # ------------------------------------------------------------------

    def _date_filter_clause(self, date_column: str, months: int) -> str:
        """Return a dialect-specific WHERE clause for a rolling window.

        Override in subclass. Default is ANSI SQL / PostgreSQL style.
        """
        return f"{date_column} >= CURRENT_DATE - INTERVAL '{months}' MONTH"

    def _wrap_limit(self, sql: str, limit: int) -> str:
        """Wrap *sql* with a dialect-specific row limit.

        Override in subclass. Default is ANSI ``LIMIT`` (Postgres).
        """
        return f"SELECT * FROM ({sql}) _sub LIMIT {limit}"

    # ------------------------------------------------------------------
    # Generic preview / head
    # ------------------------------------------------------------------

    def fetch_table_head(
        self, table_id: str, limit: int = 100
    ) -> pd.DataFrame:
        """Fetch a small sample from the live database for preview / DTO bootstrapping."""
        table_config = self._find_table_config(table_id)
        if table_config is None:
            raise ValueError(
                f"Table '{table_id}' not found in connector '{self.source_id}'"
            )

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
        logger.info(
            "fetch_table_head('%s', limit=%d) on '%s'",
            table_id, limit, self.source_id,
        )
        return pd.read_sql(limited_sql, connection)

    def get_row_count_estimate(self, table_id: str) -> Optional[int]:
        """Return an estimated row count (from DB stats, not COUNT(*))."""
        return None

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _find_table_config(self, table_id: str) -> Optional[Dict[str, Any]]:
        """Lookup a table config dict by table_id."""
        tables: List[Dict[str, Any]] = getattr(self, "tables", []) or []
        return next(
            (t for t in tables if t.get("table_id") == table_id),
            None,
        )

    def _get_connection(self):
        """Get a live database connection (override in subclass)."""
        raise NotImplementedError

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(source_id='{self.source_id}', type='{self.source_type}')"
