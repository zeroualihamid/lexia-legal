"""
ConnectorFactoryNode — Create a connector for the next source in the queue.

Pops the next DataSourceConfig from sources_to_process and creates the
appropriate connector via lazy imports (QVD, SQLServer, CSV, Oracle, Supabase).
Registers the connector in ConnectorManager if not already present.
"""

from typing import Any, Dict, Tuple

from nodes.base_node import BaseNode
from config import DataSourceConfig


def _create_connector(source_config: DataSourceConfig):
    """
    Lazy-import factory — only imports the connector module needed.

    Returns a BaseConnector instance.
    """
    config_dict = source_config.model_dump()
    source_type = source_config.type

    if source_type == "qvd":
        from services.connectors.qvd_connector import QVDConnector
        return QVDConnector(config_dict)

    elif source_type == "sqlserver":
        from services.connectors.sqlserver_connector import SQLServerConnector
        return SQLServerConnector(config_dict)

    elif source_type == "csv":
        from services.connectors.csv_connector import CSVConnector
        return CSVConnector(config_dict)

    elif source_type == "oracle":
        from services.connectors.oracle_connector import OracleConnector
        return OracleConnector(config_dict)

    elif source_type == "supabase":
        from services.connectors.supabase_connector import SupabaseConnector
        return SupabaseConnector(config_dict)

    elif source_type == "xlsx":
        from services.connectors.xlsx_connector import XLSXConnector
        return XLSXConnector(config_dict)

    elif source_type == "minio":
        from services.connectors.minio_connector import MinIOConnector
        return MinIOConnector(config_dict)

    else:
        raise ValueError(f"Unsupported connector type: {source_type}")


class ConnectorFactoryNode(BaseNode):
    """Pop the next source config and create/register its connector."""

    def prep(self, shared: Dict[str, Any]):
        self.log_entry(shared)
        sources = shared.get("sources_to_process", [])
        if not sources:
            self.logger.info("All sources processed — finishing dataloader flow")
            return None
        source_config: DataSourceConfig = sources.pop(0)
        self.logger.info(f"Next source: {source_config.source_id} (type={source_config.type})")
        return source_config

    def exec(self, prep_result):
        if prep_result is None:
            return None
        source_config = prep_result
        connector = _create_connector(source_config)
        return connector, source_config

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Any) -> str:
        if exec_result is None:
            return "done"

        connector, source_config = exec_result
        connector_manager = self.require_from_shared(shared, "connector_manager")

        # Register if not already present
        if connector_manager.get_connector(connector.source_id) is None:
            connector_manager.register_connector(connector)
            self.logger.info(f"Registered new connector: {connector.source_id}")
        else:
            self.logger.debug(f"Connector already registered: {connector.source_id}")

        shared["current_connector"] = connector
        shared["current_source_config"] = source_config
        return "default"
