"""
Data source connectors for multi-source architecture.

This package provides pluggable connectors for various data sources:
- QVD: QlikView data files
- SQL Server: Microsoft SQL Server databases
- CSV: Comma-separated value files
- Oracle: Oracle database connections
- Supabase: PostgreSQL databases hosted on Supabase
"""

from services.connectors.base_connector import (
    BaseConnector,
    DataSourceMetadata,
    RefreshPolicy,
)
from services.connectors.qvd_connector import QVDConnector
from services.connectors.sqlserver_connector import SQLServerConnector
from services.connectors.csv_connector import CSVConnector
from services.connectors.oracle_connector import OracleConnector
from services.connectors.supabase_connector import SupabaseConnector

__all__ = [
    "BaseConnector",
    "DataSourceMetadata",
    "RefreshPolicy",
    "QVDConnector",
    "SQLServerConnector",
    "CSVConnector",
    "OracleConnector",
    "SupabaseConnector",
]
