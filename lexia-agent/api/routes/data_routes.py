"""
Data Loader API Routes

Provides endpoints for triggering PocketFlow-based data refresh,
listing source status, and checking scheduler health.
"""

import logging
import threading
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel

from services.connector_manager import ConnectorManager
from services.refresh_scheduler import RefreshScheduler

logger = logging.getLogger(__name__)

router = APIRouter()


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class RefreshStartedResponse(BaseModel):
    status: str = "started"
    source_id: Optional[str] = None
    sources: Optional[list] = None
    message: str = ""


class SourceStatusItem(BaseModel):
    source_id: str
    source_type: str
    description: str
    refresh_policy: str
    last_refresh: Optional[str] = None
    last_refresh_status: str
    row_count: int
    column_count: int
    cache_size_mb: Optional[float] = None
    next_refresh_seconds: Optional[float] = None


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _get_connector_manager(request: Request) -> ConnectorManager:
    cm = getattr(request.app.state, "connector_manager", None)
    if cm is None:
        raise HTTPException(status_code=503, detail="ConnectorManager not initialized")
    return cm


def _get_refresh_scheduler(request: Request) -> Optional[RefreshScheduler]:
    return getattr(request.app.state, "refresh_scheduler", None)


def _run_flow_in_background(
    connector_manager,
    settings,
    source_id: Optional[str] = None,
    incremental: bool = False,
):
    """Run the dataloader flow in a daemon thread so the endpoint returns immediately."""
    from flows.dataloader_flow import run_dataloader_flow

    def _target():
        try:
            run_dataloader_flow(
                connector_manager=connector_manager,
                settings=settings,
                source_id=source_id,
                incremental=incremental,
            )
        except Exception as exc:
            logger.error(f"Background dataloader flow failed: {exc}", exc_info=True)

    t = threading.Thread(target=_target, daemon=True, name="dataloader-flow")
    t.start()


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------

@router.post("/refresh")
async def refresh_all_sources(
    request: Request,
    incremental: bool = Query(False, description="Use incremental fetch where supported"),
):
    """
    Refresh all enabled data sources.

    Runs the full dataloader flow in a background thread and returns immediately.
    """
    connector_manager = _get_connector_manager(request)
    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        raise HTTPException(status_code=503, detail="Settings not initialized")

    source_ids = [
        s.source_id for s in settings.data_sources if s.enabled
    ]

    _run_flow_in_background(connector_manager, settings, incremental=incremental)

    return RefreshStartedResponse(
        status="started",
        sources=source_ids,
        message=f"Dataloader flow started for {len(source_ids)} source(s)",
    )


@router.post("/refresh/{source_id}")
async def refresh_single_source(
    source_id: str,
    request: Request,
    incremental: bool = Query(False, description="Use incremental fetch where supported"),
):
    """
    Refresh a single data source by source_id.

    Runs the dataloader flow for this source in a background thread.
    """
    connector_manager = _get_connector_manager(request)
    settings = getattr(request.app.state, "settings", None)
    if settings is None:
        raise HTTPException(status_code=503, detail="Settings not initialized")

    # Validate source exists
    known_ids = [s.source_id for s in settings.data_sources if s.enabled]
    if source_id not in known_ids:
        raise HTTPException(status_code=404, detail=f"Source not found or disabled: {source_id}")

    _run_flow_in_background(connector_manager, settings, source_id=source_id, incremental=incremental)

    return RefreshStartedResponse(
        status="started",
        source_id=source_id,
        message=f"Dataloader flow started for source '{source_id}'",
    )


@router.get("/sources")
async def list_sources(request: Request):
    """
    List all registered data sources with their status.
    """
    connector_manager = _get_connector_manager(request)
    refresh_scheduler = _get_refresh_scheduler(request)

    next_refresh_times: dict = {}
    if refresh_scheduler:
        next_refresh_times = refresh_scheduler.get_next_run_times()

    sources = []
    for connector in connector_manager.connectors.values():
        cache_info = connector_manager.cache_manager.get_cache_info(connector.source_id)
        sources.append(
            SourceStatusItem(
                source_id=connector.source_id,
                source_type=connector.source_type,
                description=connector.metadata.description,
                refresh_policy=connector.metadata.refresh_policy.value,
                last_refresh=(
                    connector.metadata.last_refresh.isoformat()
                    if connector.metadata.last_refresh
                    else None
                ),
                last_refresh_status=connector.metadata.last_refresh_status,
                row_count=connector.metadata.row_count,
                column_count=connector.metadata.column_count,
                cache_size_mb=cache_info.get("size_mb") if cache_info else None,
                next_refresh_seconds=next_refresh_times.get(connector.source_id),
            )
        )

    return sources


@router.get("/scheduler")
async def get_scheduler_status(request: Request):
    """
    Return scheduler status: running flag, registered sources, next run times.
    """
    refresh_scheduler = _get_refresh_scheduler(request)

    if refresh_scheduler is None:
        return {
            "enabled": False,
            "message": "Refresh scheduler not initialized",
        }

    status = refresh_scheduler.get_status()
    status["enabled"] = True
    return status
