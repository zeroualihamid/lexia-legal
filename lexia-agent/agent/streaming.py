"""Streaming bridge from LangChain AgentExecutor events → FastAPI SSE.

Use :func:`stream_agent_events` from inside an async route handler:

    async def chat_stream(query: str, session_id: str):
        async for event in stream_agent_events(query, session_id=session_id):
            yield event

Each yielded value is a small ``dict`` matching the existing ``/chat/``
streaming contract: ``{"event": ..., "message": ..., "data": ...}``.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator, Dict, Optional

from agent.config import get_section
from agent.cte_fast_path import run_cte_fast_path, run_cte_fast_path_for_match
from agent.langchain_agent import create_brikz_agent_executor

logger = logging.getLogger(__name__)

_FP_DONE = object()


async def _drain_fast_path(
    run_fn,
    result_holder: Dict[str, Any],
    *,
    forward_tools: bool,
) -> AsyncIterator[Dict[str, Any]]:
    """Run a blocking fast-path ``run_fn(emit)`` off the loop, streaming its events.

    *run_fn* receives an ``emit(event, message, data)`` callback and returns the
    fast-path result dict (or ``None``). Its callback events are bridged onto an
    asyncio queue and re-yielded as ``{event, message, data}`` dicts so tokens
    stream token-by-token; the return value is stashed in
    ``result_holder["value"]``.
    """
    loop = asyncio.get_running_loop()
    fp_queue: asyncio.Queue = asyncio.Queue()

    def _emit(event: str, message: str, data: Optional[dict] = None) -> None:
        loop.call_soon_threadsafe(
            fp_queue.put_nowait, {"event": event, "message": message, "data": data}
        )

    def _run() -> None:
        try:
            result_holder["value"] = run_fn(_emit)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("CTE fast-path raised in stream_agent_events: %s", exc)
            result_holder["value"] = None
        finally:
            loop.call_soon_threadsafe(fp_queue.put_nowait, _FP_DONE)

    fp_task = asyncio.create_task(asyncio.to_thread(_run))
    while True:
        item = await fp_queue.get()
        if item is _FP_DONE:
            break
        ev = item.get("event")
        if ev == "llm_token":
            token = (item.get("data") or {}).get("token", "")
            if token:
                yield {"event": "token", "message": token, "data": None}
        elif forward_tools and ev in ("tool_start", "tool_result"):
            yield {"event": ev, "message": item.get("message", ""), "data": item.get("data")}
    await fp_task


async def stream_agent_events(
    query: str,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    connector_manager: Any = None,
) -> AsyncIterator[Dict[str, Any]]:
    """Stream LangChain agent events as ``{event, message, data}`` dicts."""
    cfg = get_section("streaming") or {}
    forward_tools = bool(cfg.get("forward_tool_events", True))

    # ── CTE fast-path (raw query) ──────────────────────────────────────────
    # When the query confidently maps to a library CTE, execute it directly and
    # stream a grounded answer — skipping augmentation, plan decomposition, and
    # the multi-turn agent loop.
    fp_result: Dict[str, Any] = {}
    async for ev in _drain_fast_path(
        lambda emit: run_cte_fast_path(
            query, session_id=session_id, memory_store=memory_store, stream_callback=emit
        ),
        fp_result,
        forward_tools=forward_tools,
    ):
        yield ev

    if fp_result.get("value") is not None:
        res = fp_result["value"]
        yield {
            "event": "complete",
            "message": "Agent flow complete",
            "data": {"output": res.get("answer"), "fast_path": True, "cte": res.get("fast_path_cte")},
        }
        return

    # ── Pre-loop (augmentation + CTE retrieval) ─────────────────────────────
    # Pass the query so the pre-loop reasons over it AND so the executor
    # auto-injects the domain-expertise skill(s) relevant to it (e.g. the
    # marge-nette-d'intérêt formula for "donne le MNI").
    executor, preloop_result = create_brikz_agent_executor(
        query=query,
        session_id=session_id,
        memory_store=memory_store,
        # Skip the ~8 s plan decomposition on a confident CTE hit — the
        # post-augmentation fast path below executes the matched CTE directly.
        skip_plan_on_cte_hit=True,
    )

    # ── CTE fast-path (post-augmentation) ──────────────────────────────────
    # The raw-query fast-path above missed, but the pre-loop just AUGMENTED the
    # query (grounding it in real columns) and its library search found a CTE at
    # high confidence. Reuse that match to execute the CTE directly instead of
    # throwing the augmentation away on a full plan/sub-agent/tool-calling loop
    # (which is what made known-CTE conversational queries take ~45 s).
    if preloop_result.cte_match.found:
        fp2_result: Dict[str, Any] = {}
        async for ev in _drain_fast_path(
            lambda emit: run_cte_fast_path_for_match(
                query,
                preloop_result.cte_match,
                session_id=session_id,
                memory_store=memory_store,
                stream_callback=emit,
            ),
            fp2_result,
            forward_tools=forward_tools,
        ):
            yield ev
        if fp2_result.get("value") is not None:
            res = fp2_result["value"]
            yield {
                "event": "complete",
                "message": "Agent flow complete",
                "data": {
                    "output": res.get("answer"),
                    "fast_path": True,
                    "cte": res.get("fast_path_cte"),
                },
            }
            return

    # ── Full agent path (fallback when both fast paths decline) ─────────────
    inputs = {
        "input": preloop_result.augmented_query,
        "original_input": query,
    }

    yield {"event": "preloop", "message": "Pre-loop reasoning complete", "data": {
        "augmented_query": preloop_result.augmented_query,
        "plan_steps": preloop_result.analysis_plan.count("\n") + 1 if preloop_result.analysis_plan else 0,
        "cte_hit": preloop_result.cte_match.found,
        "cte_created": preloop_result.cte_match.created_name,
    }}

    try:
        async for ev in executor.astream_events(inputs, version="v2"):
            etype = ev.get("event", "")
            if etype == "on_chat_model_stream":
                chunk = ev.get("data", {}).get("chunk")
                token = getattr(chunk, "content", "") if chunk else ""
                if token:
                    yield {"event": "token", "message": token, "data": None}
            elif forward_tools and etype == "on_tool_start":
                yield {
                    "event": "tool_start",
                    "message": f"Executing tool: {ev.get('name')}",
                    "data": {"tool": ev.get("name"), "input": ev.get("data", {}).get("input")},
                }
            elif forward_tools and etype == "on_tool_end":
                out = ev.get("data", {}).get("output")
                preview = (str(out)[:200] + "…") if out and len(str(out)) > 200 else str(out)
                yield {
                    "event": "tool_result",
                    "message": f"Tool {ev.get('name')} complete",
                    "data": {"tool": ev.get("name"), "preview": preview},
                }
            elif etype == "on_chain_end" and ev.get("name") == "AgentExecutor":
                output = ev.get("data", {}).get("output") or {}
                yield {
                    "event": "complete",
                    "message": "Agent flow complete",
                    "data": {"output": output.get("output")},
                }
    except Exception as exc:
        logger.exception("Agent streaming failed: %s", exc)
        yield {"event": "error", "message": str(exc), "data": None}
