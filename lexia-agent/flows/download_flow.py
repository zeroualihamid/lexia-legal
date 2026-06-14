"""
Download Flow — Reasoning-capable download pipeline.

Pipeline:
    DownloadNode ──[done]──→ FlowEnd
        ↑ retry ──┘ (on transient error, up to 3 retries)
        └─[failed]──→ FlowEnd

Triggered by:
    - API endpoint  POST /parquet/download-agent/{source_id}/{table_id}
    - Runs in a background thread to avoid blocking the event loop
"""

from typing import Any, Dict, Optional

from pocketflow import Flow, Node as PFNode

from nodes.dataloader.download_node import DownloadNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


class _FlowEndNode(PFNode):
    """No-op terminal node."""
    pass


def create_download_flow() -> Flow:
    """Assemble the download DAG with retry loop."""
    download = DownloadNode()
    flow_end = _FlowEndNode()

    download - "done" >> flow_end
    download - "failed" >> flow_end
    download - "retry" >> download

    return Flow(start=download)


def run_download_flow(
    connector_manager,
    source_id: str,
    table_id: str,
    incremental: bool = False,
    resume: bool = True,
    job: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Run the download flow in the calling thread.

    Args:
        connector_manager: ConnectorManager instance.
        source_id: Data source identifier.
        table_id: Specific table to download.
        incremental: Attempt incremental download if supported.
        resume: If True, resume from existing partial parquet file.
        job: Mutable job dict shared with the API layer for live updates.

    Returns:
        Dict with download results including success, row_count, file_path, etc.
    """
    flow = create_download_flow()

    events = []
    shared: Dict[str, Any] = {
        "connector_manager": connector_manager,
        "source_id": source_id,
        "table_id": table_id,
        "incremental": incremental,
        "resume": resume,
        "events": events,
        "job": job,
    }

    logger.info(
        "Starting download flow: source=%s table=%s incremental=%s",
        source_id, table_id, incremental,
    )

    flow.run(shared)

    result = shared.get("download_result", {})
    result["events"] = events
    logger.info("Download flow complete: %s", {k: v for k, v in result.items() if k != "events"})
    return result
