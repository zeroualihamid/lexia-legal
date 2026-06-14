# api/sse_streaming.py

"""
Server-Sent Events (SSE) Streaming
===================================

Real-time streaming of workflow progress, LLM token generation,
and incremental step results to clients.

FastAPI SSE implementation using sse-starlette.

Install:
    pip install sse-starlette

Usage (backend):
    from api.sse_streaming import stream_workflow_progress

    @app.get("/workflow/{run_id}/stream")
    async def stream(run_id: str):
        return EventSourceResponse(stream_workflow_progress(run_id))

Usage (frontend):
    const eventSource = new EventSource('/workflow/run-abc123/stream');
    
    eventSource.addEventListener('step_start', (e) => {
        console.log('Step started:', JSON.parse(e.data));
    });
    
    eventSource.addEventListener('llm_token', (e) => {
        updateCodeDisplay(JSON.parse(e.data).token);
    });
    
    eventSource.addEventListener('complete', (e) => {
        eventSource.close();
    });
"""

import asyncio
import json
import time
from typing import Any, AsyncGenerator, Dict, Optional
from dataclasses import dataclass
from datetime import date, datetime, time as dt_time, timezone
from decimal import Decimal
from uuid import UUID


def _sse_json_default(obj: Any) -> Any:
    """
    Serialize types that json.dumps does not handle (SQL rows, workflow state, etc.).
    """
    if isinstance(obj, datetime):
        return obj.isoformat()
    if isinstance(obj, date):
        return obj.isoformat()
    if isinstance(obj, dt_time):
        return obj.isoformat()
    if isinstance(obj, Decimal):
        return float(obj)
    if isinstance(obj, UUID):
        return str(obj)
    if isinstance(obj, (bytes, bytearray, memoryview)):
        if isinstance(obj, memoryview):
            obj = obj.tobytes()
        return bytes(obj).decode("utf-8", errors="replace")
    try:
        import numpy as np

        if isinstance(obj, np.generic):
            return obj.item()
    except ImportError:
        pass
    raise TypeError(f"Object of type {type(obj).__name__} is not JSON serializable")


# ─────────────────────────────────────────────────────────────────────────────
# Event types
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SSEEvent:
    """Base SSE event structure."""
    event: str                      # event type (step_start, llm_token, etc.)
    data: Dict[str, Any]            # JSON payload
    id: Optional[str] = None        # optional event ID for resume
    retry: Optional[int] = None     # reconnection timeout (ms)

    def to_sse_payload(self) -> Dict[str, Any]:
        """Convert to EventSourceResponse payload dict."""
        payload: Dict[str, Any] = {
            "event": self.event,
            "data": json.dumps(self.data, ensure_ascii=False, default=_sse_json_default),
        }
        if self.id:
            payload["id"] = self.id
        if self.retry:
            payload["retry"] = self.retry
        return payload


# ─────────────────────────────────────────────────────────────────────────────
# Workflow progress streaming
# ─────────────────────────────────────────────────────────────────────────────

async def stream_workflow_progress(
    run_id: str,
    session_id: str,
    poll_interval: float = 0.5,
) -> AsyncGenerator[SSEEvent, None]:
    """
    Stream incremental workflow progress for a run.

    Events emitted:
        workflow_start   – run metadata (run_id, session_id, query)
        step_start       – node begins execution
        step_progress    – intermediate status updates
        step_complete    – node finished (success/failed)
        llm_token        – individual token from LLM streaming
        code_generated   – full code block ready
        validation_result– syntax/security/schema check result
        debate_round     – proposer/challenger exchange
        execution_result – sandbox execution output
        workflow_complete– final result ready
        error            – pipeline error occurred
        heartbeat        – keepalive every 15s

    Args:
        run_id:        Workflow run identifier
        session_id:    Session identifier
        poll_interval: How often to poll shared state (seconds)

    Yields:
        SSEEvent objects for EventSourceResponse
    """
    from api.routes.workflow import _RUNS

    run = _RUNS.get(run_id)
    if not run:
        yield SSEEvent(
            event="error",
            data={"error": f"Run not found: {run_id}", "timestamp": _utc_now()},
            id=f"{run_id}-0",
            retry=5000,
        )
        return

    # Initial event
    yield SSEEvent(
        event="workflow_start",
        data={
            "run_id":     run_id,
            "session_id": run.get("session_id", session_id),
            "query":      run.get("query"),
            "status":     run.get("status"),
            "timestamp":  _utc_now(),
        },
        id=f"{run_id}-0",
        retry=5000,
    )

    event_counter = 0
    last_step_index = 0
    last_status = None
    last_heartbeat = time.time()
    heartbeat_interval = 15.0  # seconds

    try:
        while True:
            run = _RUNS.get(run_id)
            if not run:
                event_counter += 1
                yield SSEEvent(
                    event="error",
                    data={"error": f"Run not found: {run_id}", "timestamp": _utc_now()},
                    id=f"{run_id}-{event_counter}",
                )
                break

            # Emit newly recorded step results from /workflow/run execution
            steps = run.get("steps") or []
            while last_step_index < len(steps):
                step = steps[last_step_index]
                event_counter += 1
                yield SSEEvent(
                    event="step_complete",
                    data={
                        "index": last_step_index + 1,
                        "step": step,
                        "timestamp": _utc_now(),
                    },
                    id=f"{run_id}-{event_counter}",
                )
                last_step_index += 1

            # Emit status transitions
            status = run.get("status", "unknown")
            if status != last_status:
                event_counter += 1
                yield SSEEvent(
                    event="step_progress",
                    data={
                        "status": status,
                        "updated_at": run.get("updated_at"),
                        "timestamp": _utc_now(),
                    },
                    id=f"{run_id}-{event_counter}",
                )
                last_status = status

            # Terminal states
            if status == "success":
                result = run.get("result") or {}
                final_markdown = ""
                if isinstance(result, dict):
                    final_markdown = str(result.get("response") or "")

                # Emit chart_data before workflow_complete so the frontend
                # can render the chart while finalizing the message
                chart_data = result.get("chart_data") if isinstance(result, dict) else None
                if chart_data and isinstance(chart_data, dict):
                    event_counter += 1
                    yield SSEEvent(
                        event="chart_data",
                        data={
                            "chartId": chart_data.get("chartId"),
                            "query": chart_data.get("query"),
                            "chart": {
                                "chartType": chart_data.get("chartType"),
                                "option": chart_data.get("option"),
                            },
                            "timestamp": chart_data.get("timestamp", _utc_now()),
                        },
                        id=f"{run_id}-{event_counter}",
                    )

                event_counter += 1
                yield SSEEvent(
                    event="workflow_complete",
                    data={
                        "result": result,
                        "final_markdown": final_markdown,
                        "duration_ms": run.get("duration_ms"),
                        "timestamp": _utc_now(),
                    },
                    id=f"{run_id}-{event_counter}",
                )
                break
            if status == "failed":
                event_counter += 1
                yield SSEEvent(
                    event="error",
                    data={
                        "error": run.get("error", "Workflow failed"),
                        "timestamp": _utc_now(),
                    },
                    id=f"{run_id}-{event_counter}",
                )
                break
            if status == "cancelled":
                event_counter += 1
                yield SSEEvent(
                    event="cancelled",
                    data={"run_id": run_id, "timestamp": _utc_now()},
                    id=f"{run_id}-{event_counter}",
                )
                break

            # Heartbeat
            now = time.time()
            if now - last_heartbeat > heartbeat_interval:
                yield SSEEvent(
                    event="heartbeat",
                    data={"timestamp": _utc_now()},
                )
                last_heartbeat = now

            await asyncio.sleep(poll_interval)

    except asyncio.CancelledError:
        yield SSEEvent(
            event="cancelled",
            data={"run_id": run_id, "timestamp": _utc_now()},
        )
        raise


# ─────────────────────────────────────────────────────────────────────────────
# LLM token streaming
# ─────────────────────────────────────────────────────────────────────────────

async def stream_llm_generation(
    prompt: str,
    model: str = "claude-sonnet-4",
    system: Optional[str] = None,
) -> AsyncGenerator[SSEEvent, None]:
    """
    Stream LLM token generation in real-time.

    Events:
        llm_start    – generation begins
        llm_token    – individual token
        llm_complete – generation finished
        llm_error    – error occurred

    Frontend example:
        const es = new EventSource('/api/llm/stream');
        let code = '';
        es.addEventListener('llm_token', (e) => {
            code += JSON.parse(e.data).token;
            updateEditor(code);
        });
    """
    from llm.llm_factory import create_llm_client
    from config.settings import settings

    yield SSEEvent(
        event="llm_start",
        data={"model": model, "timestamp": _utc_now()},
    )

    try:
        client = create_llm_client(config=settings, model=model)

        # Use streaming if supported
        if hasattr(client, "generate_stream"):
            token_count = 0
            async for token in client.generate_stream(prompt, system=system):
                token_count += 1
                yield SSEEvent(
                    event="llm_token",
                    data={"token": token, "index": token_count},
                )
        else:
            # Fallback: non-streaming client, emit full response
            response = client.generate(prompt, system=system)
            yield SSEEvent(
                event="llm_token",
                data={"token": response.content, "index": 0},
            )

        yield SSEEvent(
            event="llm_complete",
            data={"timestamp": _utc_now()},
        )

    except Exception as e:
        yield SSEEvent(
            event="llm_error",
            data={"error": str(e), "timestamp": _utc_now()},
        )


# ─────────────────────────────────────────────────────────────────────────────
# Node instrumentation helpers
# ─────────────────────────────────────────────────────────────────────────────

class SSENodeInstrumenter:
    """
    Mixin for nodes to emit SSE events during execution.

    Usage in a node:
        class MyNode:
            def exec(self, prep_result: Dict) -> Any:
                sse = shared.get("sse_events")
                if sse:
                    await sse.put({
                        "type": "step_progress",
                        "data": {"node": self.name, "status": "processing"}
                    })
                # ... do work ...
                return result
    """

    @staticmethod
    async def emit(shared: Dict, event_type: str, data: Dict) -> None:
        """Emit an SSE event from within a node."""
        queue = shared.get("sse_events")
        if queue and isinstance(queue, asyncio.Queue):
            await queue.put({"type": event_type, "data": data})

    @staticmethod
    async def emit_step_start(shared: Dict, node_name: str) -> None:
        await SSENodeInstrumenter.emit(
            shared,
            "step_start",
            {"node": node_name, "timestamp": _utc_now()},
        )

    @staticmethod
    async def emit_step_complete(
        shared: Dict,
        node_name: str,
        success: bool,
        duration_ms: float,
    ) -> None:
        await SSENodeInstrumenter.emit(
            shared,
            "step_complete",
            {
                "node":        node_name,
                "success":     success,
                "duration_ms": duration_ms,
                "timestamp":   _utc_now(),
            },
        )

    @staticmethod
    async def emit_code_generated(shared: Dict, code: str, node: str) -> None:
        await SSENodeInstrumenter.emit(
            shared,
            "code_generated",
            {"code": code, "node": node, "timestamp": _utc_now()},
        )

    @staticmethod
    async def emit_validation_result(
        shared: Dict,
        validator: str,
        passed: bool,
        issues: list,
    ) -> None:
        await SSENodeInstrumenter.emit(
            shared,
            "validation_result",
            {
                "validator": validator,
                "passed":    passed,
                "issues":    issues,
                "timestamp": _utc_now(),
            },
        )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
