"""
Data Loader Flow — PocketFlow-based data refresh pipeline.

Pipeline:
    ConfigLoader → ConnectorFactory → DataFetch → CacheSave → Embedding
                       ↑                  ↑ retry ──┘(on error)
                       └── next_source ───┘(from Embedding)
                       └── skip_source ───┘(from DataFetch on exhausted retries)

Triggered by:
    - API endpoint  POST /data/refresh
    - Background scheduler (RefreshScheduler)
"""

from typing import Any, Dict, Optional

from pocketflow import Flow, Node as PFNode

from nodes.dataloader.config_loader_node import ConfigLoaderNode
from nodes.dataloader.connector_factory_node import ConnectorFactoryNode
from nodes.dataloader.data_fetch_node import DataFetchNode
from nodes.dataloader.cache_save_node import CacheSaveNode
from nodes.dataloader.embedding_node import EmbeddingNode

from monitoring.logger import get_logger

logger = get_logger(__name__)


class _FlowEndNode(PFNode):
    """No-op terminal node to silence PocketFlow 'action not found' warnings."""
    pass


def create_dataloader_flow() -> Flow:
    """
    Assemble the data-loader DAG.

    Returns:
        Flow with ConfigLoaderNode as start node.
    """
    config_loader = ConfigLoaderNode()
    connector_factory = ConnectorFactoryNode()
    data_fetch = DataFetchNode()
    cache_save = CacheSaveNode()
    embedding = EmbeddingNode()
    flow_end = _FlowEndNode()

    # Linear pipeline
    config_loader >> connector_factory >> data_fetch >> cache_save >> embedding

    # Terminal transitions (no more sources to process)
    connector_factory - "done" >> flow_end
    embedding - "done" >> flow_end

    # Loop: after embedding, if more sources → back to connector_factory
    embedding - "next_source" >> connector_factory

    # Retry: fetch error → retry fetch
    data_fetch - "retry" >> data_fetch

    # Skip: unrecoverable fetch error → jump to next source via connector_factory
    data_fetch - "skip_source" >> connector_factory

    return Flow(start=config_loader)


def run_dataloader_flow(
    connector_manager,
    settings,
    source_id: Optional[str] = None,
    incremental: bool = False,
) -> Dict[str, Any]:
    """
    Run the data-loader flow.

    Called by the API route handler or the background scheduler.

    Args:
        connector_manager: ConnectorManager instance with cache/embedding managers.
        settings: Application Settings (with data_sources list).
        source_id: If set, only refresh this single source. None = all enabled.
        incremental: If True, attempt incremental fetch where supported.

    Returns:
        Dict mapping source_id to result dicts:
            {source_id: {"success": bool, "rows": int, "error": str | None, ...}}
    """
    flow = create_dataloader_flow()

    shared: Dict[str, Any] = {
        "connector_manager": connector_manager,
        "settings": settings,
        "target_source_id": source_id,
        "incremental": incremental,
        "sources_to_process": [],
        "results": {},
    }

    logger.info(
        f"Starting dataloader flow "
        f"(source_id={source_id or 'all'}, incremental={incremental})"
    )

    flow.run(shared)

    logger.info(f"Dataloader flow complete: {shared['results']}")
    return shared["results"]
