# routes/chat.py

"""
Chat Endpoints
==============

POST /chat/stream    – Submit query, get SSE stream (agent flow)
GET  /chat/sessions  – List user's chat sessions
"""

import math
import uuid
import asyncio
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, Header, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.sse_streaming import SSEEvent
from flows.langchain_agent_flow import run_langchain_agent_flow
from flows.chart_flow import run_chart_flow
from monitoring.logger import get_logger


def _sanitize(obj: Any) -> Any:
    """Make an object JSON-safe by replacing pandas NA/NaT/NaN with None."""
    if obj is None:
        return None
    if isinstance(obj, float) and (math.isnan(obj) or math.isinf(obj)):
        return None
    if isinstance(obj, dict):
        return {k: _sanitize(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_sanitize(v) for v in obj]
    try:
        import pandas as pd
        if pd.isna(obj):
            return None
    except (TypeError, ValueError, ImportError):
        pass
    return obj

router = APIRouter()
logger = get_logger(__name__)

# ─── ECharts option builder ──────────────────────────────────────────────────

_CHART_COLORS = [
    "#6366f1", "#8b5cf6", "#a78bfa", "#c084fc",
    "#38bdf8", "#22d3ee", "#34d399", "#fbbf24",
    "#f87171", "#fb923c",
]


def _build_echarts_option(chart_data: dict) -> dict:
    """Convert the chart_flow payload into an ECharts option object."""
    chart_type = chart_data.get("chart_type", "bar")
    title = chart_data.get("title", "")
    labels = chart_data.get("labels", [])
    datasets = chart_data.get("datasets", [])

    if chart_type == "pie":
        pie_data = []
        values = datasets[0]["data"] if datasets else []
        for i, lbl in enumerate(labels):
            pie_data.append({
                "name": lbl,
                "value": values[i] if i < len(values) else 0,
            })
        return {
            "title": {"text": title, "left": "center", "textStyle": {"fontSize": 14}},
            "tooltip": {"trigger": "item", "formatter": "{b}: {c} ({d}%)"},
            "legend": {"orient": "horizontal", "bottom": 0, "type": "scroll"},
            "color": _CHART_COLORS,
            "series": [{
                "type": "pie",
                "radius": ["35%", "65%"],
                "center": ["50%", "48%"],
                "data": pie_data,
                "label": {"show": True, "formatter": "{b}\n{d}%"},
                "emphasis": {"itemStyle": {"shadowBlur": 10, "shadowColor": "rgba(0,0,0,0.2)"}},
            }],
        }

    echart_type = "line" if chart_type in ("line", "area") else "bar"
    series = []
    for idx, ds in enumerate(datasets):
        s = {
            "name": ds.get("label", f"Série {idx + 1}"),
            "type": echart_type,
            "data": ds.get("data", []),
            "smooth": True if echart_type == "line" else False,
            "itemStyle": {"color": _CHART_COLORS[idx % len(_CHART_COLORS)]},
        }
        if chart_type == "area":
            s["areaStyle"] = {"opacity": 0.15}
        series.append(s)

    return {
        "title": {"text": title, "left": "center", "textStyle": {"fontSize": 14}},
        "tooltip": {"trigger": "axis"},
        "legend": {
            "bottom": 0,
            "type": "scroll",
            "data": [ds.get("label", "") for ds in datasets],
        } if len(datasets) > 1 else None,
        "grid": {"left": "3%", "right": "4%", "bottom": "12%", "top": "16%", "containLabel": True},
        "xAxis": {"type": "category", "data": labels, "axisLabel": {"rotate": 30 if len(labels) > 8 else 0}},
        "yAxis": {"type": "value"},
        "color": _CHART_COLORS,
        "series": series,
    }


# In-memory session store (replace with Redis/DB in production)
_SESSIONS: dict[str, dict] = {}

# Conversation memory store (persisted across turns for follow-up queries)
from nodes.memory.memory_store import MemoryStore as _MemoryStore

_MEMORY_STORE = _MemoryStore(persist_dir="data/memory")


def _get_memory_store() -> _MemoryStore:
    return _MEMORY_STORE


# ─────────────────────────────────────────────────────────────────────────────
# Models
# ─────────────────────────────────────────────────────────────────────────────

class ChatRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000, description="User query")


# ─────────────────────────────────────────────────────────────────────────────
# Session Management Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _get_or_create_session(session_id: Optional[str]) -> str:
    if session_id:
        if session_id not in _SESSIONS:
            _SESSIONS[session_id] = {
                "session_id": session_id,
                "created_at": _utc_now(),
                "runs": [],
            }
            logger.info(f"Created session from header: {session_id}")
        else:
            logger.info(f"Continuing session: {session_id}")
        return session_id

    new_session_id = f"chat-{uuid.uuid4().hex[:12]}"
    _SESSIONS[new_session_id] = {
        "session_id": new_session_id,
        "created_at": _utc_now(),
        "runs": [],
    }
    logger.info(f"Created new session: {new_session_id}")
    return new_session_id


def _record_run(session_id: str, run_id: str, query: str) -> None:
    if session_id in _SESSIONS:
        _SESSIONS[session_id]["runs"].append({
            "run_id": run_id,
            "query": query,
            "timestamp": _utc_now(),
        })


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

_FLOW_DONE = object()


@router.post("/stream", summary="Chat with streaming response (SSE)")
async def chat_stream(
    request: Request,
    req: ChatRequest,
    x_session_id: Optional[str] = Header(None, alias="X-Session-ID"),
):
    """
    Submit a query and receive real-time streaming results via SSE.

    Runs the Agent Flow (think-act-observe loop) which autonomously:
    1. Resolves entity names via semantic search on categorical embeddings
    2. Generates and executes SQL queries against parquet data
    3. Searches the web for external knowledge when needed
    4. Iterates until the answer is satisfactory (max 8 iterations)

    **Events Emitted:**
    - ``session_created``    – new session info
    - ``workflow_start``     – flow started
    - ``thinking``           – agent reasoning step
    - ``tool_start``         – tool execution begins
    - ``tool_result``        – tool execution result
    - ``iteration``          – loop iteration info
    - ``response``           – final response text
    - ``workflow_complete``  – final results with SQL data
    - ``chart_data``         – chart visualization data
    - ``error``              – error occurred
    - ``heartbeat``          – keepalive
    """
    is_new_session = not (x_session_id and x_session_id in _SESSIONS)
    session_id = _get_or_create_session(x_session_id)
    run_id = f"run-{uuid.uuid4().hex[:12]}"
    _record_run(session_id, run_id, req.query)

    queue: asyncio.Queue = asyncio.Queue()
    flow_result: dict = {}
    loop = asyncio.get_running_loop()

    def on_event(event: str, message: str, data: Optional[dict] = None) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"event": event, "message": message, "data": data},
        )

    async def run_flow_in_thread() -> None:
        def run_sync() -> None:
            _cm = getattr(request.app.state, "connector_manager", None)
            store = _get_memory_store()

            shared = run_langchain_agent_flow(
                query=req.query,
                session_id=session_id,
                stream_callback=on_event,
                connector_manager=_cm,
                memory_store=store,
            )
            flow_result["shared"] = shared

            # Log a clean CTE-extraction record (verbatim query + reused/generated)
            # for the admin review — independent of the augmented/sub-agent memory.
            try:
                from services import cte_extraction_log
                cte_extraction_log.append_record(session_id, req.query, shared)
            except Exception as _log_exc:  # noqa: BLE001
                logger.debug("cte_extraction_log failed (non-fatal): %s", _log_exc)

            # Run chart flow if agent produced SQL results
            sql_queries = shared.get("sql_queries", [])
            sql_results = shared.get("sql_results", [])
            if sql_queries:
                try:
                    chart_shared = run_chart_flow(
                        sql_queries=sql_queries,
                        sql_results=sql_results,
                        query=req.query,
                        stream_callback=on_event,
                    )
                    flow_result["chart_shared"] = chart_shared
                except Exception as chart_exc:
                    logger.warning("Chart flow failed (non-fatal): %s", chart_exc)

        try:
            await loop.run_in_executor(None, run_sync)
        except Exception as e:
            logger.exception("Agent flow failed: %s", e)
            loop.call_soon_threadsafe(
                queue.put_nowait,
                {"event": "error", "message": str(e), "data": None},
            )
        finally:
            loop.call_soon_threadsafe(queue.put_nowait, _FLOW_DONE)

    async def event_generator():
        task = asyncio.create_task(run_flow_in_thread())

        if is_new_session:
            yield SSEEvent(
                event="session_created",
                data={"session_id": session_id, "message": "Nouvelle session créée"},
            ).to_sse_payload()

        yield SSEEvent(
            event="workflow_start",
            data={"run_id": run_id, "session_id": session_id, "query": req.query},
        ).to_sse_payload()

        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield SSEEvent(event="heartbeat", data={"session_id": session_id}).to_sse_payload()
                continue

            if item is _FLOW_DONE:
                break

            event_type = item.get("event", "thinking")
            message = item.get("message", "")
            data = item.get("data") or {}

            if event_type == "error":
                yield SSEEvent(
                    event="error",
                    data={"session_id": session_id, "run_id": run_id, "message": message},
                ).to_sse_payload()
                continue

            if event_type in ("complete", "chart_ready"):
                continue

            yield SSEEvent(
                event=event_type,
                data={"session_id": session_id, "run_id": run_id, "message": message, **data},
            ).to_sse_payload()

        await task

        # Build workflow_complete payload with agent results + any SQL data
        shared = flow_result.get("shared", {})
        sql_queries = shared.get("sql_queries", [])
        sql_results = shared.get("sql_results", [])
        final_response = shared.get("final_response", "")

        workflow_payload: dict = {
            "session_id": session_id,
            "run_id": run_id,
            "status": "success",
            "response_type": "agent",
            "strategic_response": final_response,
            "iteration_count": shared.get("agent_iteration", 0),
            "sql_queries": [
                {"label": q.get("label"), "sql": q.get("sql")}
                for q in sql_queries
            ],
            "sql_results": [
                {
                    "label": r.get("label"),
                    "columns": r.get("columns", []),
                    "row_count": r.get("row_count", 0),
                    "rows": r.get("rows", [])[:50],
                    "error": r.get("error"),
                }
                for r in sql_results
            ],
        }

        yield SSEEvent(
            event="workflow_complete",
            data=_sanitize(workflow_payload),
        ).to_sse_payload()

        # Emit chart data if available
        chart_shared = flow_result.get("chart_shared", {})
        chart_data = chart_shared.get("chart_data")
        if chart_data and chart_shared.get("chartable"):
            chart_id = f"chart-{uuid.uuid4().hex[:10]}"
            echarts_option = _build_echarts_option(chart_data)
            yield SSEEvent(
                event="chart_data",
                data=_sanitize({
                    "chartId": chart_id,
                    "query": req.query,
                    "chart": {
                        "chartType": chart_data.get("chart_type", "bar"),
                        "option": echarts_option,
                    },
                }),
            ).to_sse_payload()

    return EventSourceResponse(
        event_generator(),
        headers={
            "X-Session-ID": session_id,
            "Access-Control-Expose-Headers": "X-Session-ID",
        },
    )


@router.delete("/memory/{session_id}", summary="Reset conversation memory")
async def reset_memory(session_id: str):
    """Delete conversation memory for a session (short-term + long-term + disk)."""
    store = _get_memory_store()
    store.delete(session_id)
    # Also clear the in-memory session runs
    _SESSIONS.pop(session_id, None)
    logger.info("Reset memory for session: %s", session_id)
    return {"success": True, "session_id": session_id, "message": "Memory reset"}


@router.get("/sessions", summary="List chat sessions")
async def list_sessions(
    limit: int = 20,
):
    """List recent chat sessions."""
    sessions = []
    for sid, data in list(_SESSIONS.items())[:limit]:
        runs = data.get("runs", [])
        sessions.append({
            "session_id": sid,
            "created_at": data.get("created_at", ""),
            "run_count": len(runs),
            "last_query": runs[-1]["query"][:80] if runs else "",
        })

    return {
        "sessions": sessions,
        "total": len(_SESSIONS),
    }


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
