# routes/health.py

"""
Health Check Endpoints
======================

GET /health/         – basic liveness probe
GET /health/ready    – readiness: checks all subsystems
GET /health/metrics  – lightweight runtime metrics
"""

import time
import platform
import psutil
from datetime import datetime, timezone
from typing import Dict, Any

from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter()

# Track process start time for uptime calculation
_START_TIME = time.time()


# ── Response models ───────────────────────────────────────────────────────────

class LivenessResponse(BaseModel):
    status: str                  # "ok"
    timestamp: str
    version: str = "1.0.0"


class SubsystemStatus(BaseModel):
    name:    str
    status:  str                 # "ok" | "degraded" | "error"
    latency_ms: float = 0.0
    detail:  str = ""


class ReadinessResponse(BaseModel):
    status:     str              # "ready" | "degraded" | "not_ready"
    timestamp:  str
    uptime_seconds: float
    subsystems: list[SubsystemStatus]


class MetricsResponse(BaseModel):
    uptime_seconds:    float
    cpu_percent:       float
    memory_mb:         float
    memory_percent:    float
    python_version:    str
    platform:          str
    timestamp:         str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=LivenessResponse, summary="Liveness probe")
async def liveness() -> LivenessResponse:
    """
    Minimal liveness probe.
    Returns 200 OK as long as the process is alive.
    Used by load balancers and container orchestrators.
    """
    return LivenessResponse(
        status    = "ok",
        timestamp = _utc_now(),
    )


@router.get("/ready", response_model=ReadinessResponse, summary="Readiness probe")
async def readiness() -> ReadinessResponse:
    """
    Deep readiness check.
    Verifies that every critical subsystem is operational.
    Returns 200 if ready, 503 if degraded or not ready.
    """
    subsystems: list[SubsystemStatus] = []

    # Check graph backend
    subsystems.append(await _check_graph())

    # Check LLM factory (can it build a client?)
    subsystems.append(await _check_llm())

    # Check embedding system
    subsystems.append(await _check_embeddings())

    # Check conversation history store
    subsystems.append(await _check_conversation_store())

    # Determine overall status
    statuses = {s.status for s in subsystems}
    if "error" in statuses:
        overall = "not_ready"
    elif "degraded" in statuses:
        overall = "degraded"
    else:
        overall = "ready"

    return ReadinessResponse(
        status         = overall,
        timestamp      = _utc_now(),
        uptime_seconds = round(time.time() - _START_TIME, 1),
        subsystems     = subsystems,
    )


@router.get("/metrics", response_model=MetricsResponse, summary="Runtime metrics")
async def metrics() -> MetricsResponse:
    """
    Lightweight runtime metrics (CPU, memory, uptime).
    Does not require auth — suitable for internal monitoring.
    """
    try:
        proc    = psutil.Process()
        mem_mb  = proc.memory_info().rss / 1_048_576
        mem_pct = proc.memory_percent()
        cpu_pct = proc.cpu_percent(interval=0.1)
    except Exception:
        mem_mb = mem_pct = cpu_pct = 0.0

    return MetricsResponse(
        uptime_seconds  = round(time.time() - _START_TIME, 1),
        cpu_percent     = round(cpu_pct, 1),
        memory_mb       = round(mem_mb,  1),
        memory_percent  = round(mem_pct, 1),
        python_version  = platform.python_version(),
        platform        = platform.system(),
        timestamp       = _utc_now(),
    )


# ── Subsystem checks ─────────────────────────────────────────────────────────

async def _check_graph() -> SubsystemStatus:
    t0 = time.perf_counter()
    try:
        from graph.reasoning_graph import ReasoningGraph
        from config.settings import settings
        g = ReasoningGraph(settings)
        _ = g.backend.node_count
        return SubsystemStatus(
            name       = "graph",
            status     = "ok",
            latency_ms = _ms(t0),
            detail     = f"{g.backend.node_count} nodes",
        )
    except Exception as e:
        return SubsystemStatus(
            name="graph", status="error",
            latency_ms=_ms(t0), detail=str(e)
        )


async def _check_llm() -> SubsystemStatus:
    t0 = time.perf_counter()
    try:
        from llm.llm_factory import get_available_providers
        from config.settings import settings
        providers = get_available_providers(settings)
        status = "ok" if providers else "degraded"
        return SubsystemStatus(
            name       = "llm",
            status     = status,
            latency_ms = _ms(t0),
            detail     = f"providers={providers}",
        )
    except Exception as e:
        return SubsystemStatus(
            name="llm", status="error",
            latency_ms=_ms(t0), detail=str(e)
        )


async def _check_embeddings() -> SubsystemStatus:
    t0 = time.perf_counter()
    try:
        from graph.embeddings.embedding_cache import EmbeddingCache
        from config.settings import settings
        cache = EmbeddingCache(settings)
        stats = cache.stats()
        return SubsystemStatus(
            name       = "embeddings",
            status     = "ok",
            latency_ms = _ms(t0),
            detail     = f"disk_entries={stats['disk_entries']}",
        )
    except Exception as e:
        return SubsystemStatus(
            name="embeddings", status="error",
            latency_ms=_ms(t0), detail=str(e)
        )


async def _check_conversation_store() -> SubsystemStatus:
    t0 = time.perf_counter()
    try:
        from monitoring.conversation_history_manager import ConversationHistoryManager
        from config.settings import settings
        mgr = ConversationHistoryManager(settings)
        return SubsystemStatus(
            name       = "conversation_store",
            status     = "ok",
            latency_ms = _ms(t0),
        )
    except Exception as e:
        return SubsystemStatus(
            name="conversation_store", status="degraded",
            latency_ms=_ms(t0), detail=str(e)
        )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _ms(t0: float) -> float:
    return round((time.perf_counter() - t0) * 1000, 2)
