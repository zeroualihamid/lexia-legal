"""
Playground API — Agent Flow debugger with step-through execution.

GET  /playground/flow-schema      — Return flow graph structure (nodes + edges)
POST /playground/stream           — Run agent flow with granular debug events (SSE)
POST /playground/control/{run_id} — Pause / Resume / Step execution
POST /playground/chat             — LLM debugging assistant with trace context
"""

from __future__ import annotations

import copy
import json
import threading
import uuid
import asyncio
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Dict, List, Optional

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from api.sse_streaming import SSEEvent
from monitoring.logger import get_logger

router = APIRouter()
logger = get_logger(__name__)


# ── Flow Schema (static description) ──────────────────────────────────────

FLOW_SCHEMA = {
    "nodes": [
        {
            "id": "pre_processing",
            "name": "Pre-Processing",
            "type": "pre",
            "description": "DTO cache warm-up, query augmentation, embedding column search, plan decomposition",
            "methods": ["_ensure_dto_cache", "_augment_query", "_search_embeddings_for_columns", "_decompose_plan"],
        },
        {
            "id": "AgentRouter",
            "name": "Agent Router",
            "type": "router",
            "description": "LLM decides next action via native tool calling. Returns 'dispatch' (call tools) or 'respond' (final answer).",
            "methods": ["prep → extract query, messages, tools, iteration", "exec → LLM generate_with_tools()", "post → route to dispatch or respond"],
        },
        {
            "id": "ToolDispatch",
            "name": "Tool Dispatch",
            "type": "executor",
            "description": "Execute tool calls from the router (sql_query, semantic_search, web_search, etc.)",
            "methods": ["prep → extract tool_calls, registry", "exec → registry.execute() for each tool", "post → store results as pending_tool_results"],
        },
        {
            "id": "Verify",
            "name": "Verify",
            "type": "decision",
            "description": "Check tool results. Route back to Router ('think') or force response if all tools errored at max iterations.",
            "methods": ["prep → extract tool_results, iteration", "exec → decide think vs respond", "post → route action"],
        },
        {
            "id": "AgentResponse",
            "name": "Response",
            "type": "output",
            "description": "Format final response, save to conversation memory, stream completion event.",
            "methods": ["prep → extract response, session_id", "exec → emit response event", "post → save to memory, return 'done'"],
        },
    ],
    "edges": [
        {"from": "pre_processing", "to": "AgentRouter", "label": "start"},
        {"from": "AgentRouter", "to": "ToolDispatch", "label": "dispatch"},
        {"from": "AgentRouter", "to": "AgentResponse", "label": "respond"},
        {"from": "ToolDispatch", "to": "Verify", "label": "default"},
        {"from": "Verify", "to": "AgentRouter", "label": "think"},
        {"from": "Verify", "to": "AgentResponse", "label": "respond"},
        {"from": "AgentResponse", "to": None, "label": "done"},
    ],
    "tools": [
        "sql_query", "semantic_search", "list_tables",
        "describe_table", "web_search", "read_file",
    ],
}


# ── Models ─────────────────────────────────────────────────────────────────

class PlaygroundRunRequest(BaseModel):
    query: str = Field(..., min_length=1, max_length=2000)
    max_iterations: int = Field(default=10, ge=1, le=20)
    start_paused: bool = Field(default=False, description="Start in paused state (step mode)")


class PlaygroundControlRequest(BaseModel):
    action: str = Field(..., description="pause | resume | step")


class PlaygroundChatRequest(BaseModel):
    message: str = Field(..., min_length=1)
    trace: List[Dict[str, Any]] = Field(default_factory=list)
    shared_state_summary: Optional[str] = None


# ── Debug Session Management ───────────────────────────────────────────────

@dataclass
class DebugSession:
    run_id: str
    pause_event: threading.Event = field(default_factory=threading.Event)
    step_mode: bool = False
    is_running: bool = False
    trace: List[Dict[str, Any]] = field(default_factory=list)
    shared_snapshot: Dict[str, Any] = field(default_factory=dict)


_debug_sessions: Dict[str, DebugSession] = {}


def _get_session(run_id: str) -> Optional[DebugSession]:
    return _debug_sessions.get(run_id)


# ── Safe Serialization Helpers ─────────────────────────────────────────────

def _safe_json(obj: Any, max_len: int = 2000) -> Any:
    """Make an object JSON-serializable with truncation."""
    if obj is None:
        return None
    if isinstance(obj, (bool, int, float)):
        return obj
    if isinstance(obj, str):
        return obj[:max_len] + "…" if len(obj) > max_len else obj
    if isinstance(obj, (list, tuple)):
        items = [_safe_json(v, max_len=500) for v in obj[:20]]
        if len(obj) > 20:
            items.append(f"... ({len(obj) - 20} more)")
        return items
    if isinstance(obj, dict):
        return {str(k): _safe_json(v, max_len=500) for k, v in list(obj.items())[:30]}
    if hasattr(obj, "__dataclass_fields__"):
        return {k: _safe_json(getattr(obj, k, None), max_len=500) for k in obj.__dataclass_fields__}
    if hasattr(obj, "__dict__"):
        cls = type(obj).__name__
        return f"<{cls}>"
    return str(obj)[:max_len]


def _snapshot_shared(shared: Dict[str, Any]) -> Dict[str, Any]:
    """Create a JSON-safe snapshot of the shared state."""
    skip_keys = {"agent_llm_client", "tool_registry", "connector_manager", "memory_store", "stream_callback"}
    snap = {}
    for k, v in shared.items():
        if k in skip_keys:
            snap[k] = f"<{type(v).__name__}>" if v is not None else None
        else:
            snap[k] = _safe_json(v)
    return snap


# ── DebugFlow — Instrumented PocketFlow execution ─────────────────────────

from pocketflow import Flow


class DebugFlow(Flow):
    """Flow subclass that instruments node execution with debug events."""

    def __init__(self, start=None, *, debug_callback=None, session: Optional[DebugSession] = None):
        super().__init__(start=start)
        self._debug_cb: Optional[Callable] = debug_callback
        self._session: Optional[DebugSession] = session

    def _emit(self, event: str, node: str, data: Dict[str, Any]):
        ts = datetime.now(timezone.utc).isoformat()
        entry = {"event": event, "node": node, "data": data, "timestamp": ts}
        if self._session:
            self._session.trace.append(entry)
        if self._debug_cb:
            self._debug_cb(event, node, {**data, "timestamp": ts})

    def _check_pause(self, node_name: str):
        if self._session and not self._session.pause_event.is_set():
            self._emit("paused", node_name, {"reason": "User paused execution"})
            self._session.pause_event.wait()
            self._emit("resumed", node_name, {})

    def _wrap_node(self, node, name: str):
        """Wrap prep/exec/post to emit granular debug events."""
        orig_prep = node.prep
        orig_exec = node.exec
        orig_post = node.post
        flow = self

        def debug_prep(shared):
            result = orig_prep(shared)
            flow._emit("prep_done", name, {"summary": _safe_json(result)})
            return result

        def debug_exec(prep_res):
            result = orig_exec(prep_res)
            flow._emit("exec_done", name, {"summary": _safe_json(result)})
            return result

        def debug_post(shared, prep_res, exec_res):
            action = orig_post(shared, prep_res, exec_res)
            flow._emit("post_done", name, {"action": action})
            if flow._session:
                flow._session.shared_snapshot = _snapshot_shared(shared)
            return action

        node.prep = debug_prep
        node.exec = debug_exec
        node.post = debug_post

    def _orch(self, shared, params=None):
        p = params or {**self.params}
        curr_template = self.start_node
        last_action = None

        while curr_template:
            curr = copy.copy(curr_template)
            node_name = getattr(curr, "_name", type(curr).__name__)

            # Emit node_enter
            self._emit("node_enter", node_name, {
                "iteration": shared.get("agent_iteration", 0),
            })

            # Pause check
            self._check_pause(node_name)

            # Instrument
            self._wrap_node(curr, node_name)

            # Execute
            curr.set_params(p)
            try:
                last_action = curr._run(shared)
            except Exception as exc:
                self._emit("node_error", node_name, {"error": str(exc)})
                raise

            # Snapshot
            if self._session:
                self._session.shared_snapshot = _snapshot_shared(shared)

            # Emit node_exit
            self._emit("node_exit", node_name, {"action": last_action})

            # Step mode: auto-pause after node
            if self._session and self._session.step_mode:
                self._session.step_mode = False
                self._session.pause_event.clear()

            # Next node
            curr_template = self.get_next_node(curr, last_action)

        return last_action


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/flow-schema", summary="Get agent flow graph structure")
async def get_flow_schema():
    """Return the agent flow DAG: nodes, edges, tools, and method descriptions."""
    return FLOW_SCHEMA


@router.post("/stream", summary="Run agent flow with debug events (SSE)")
async def playground_stream(
    req: PlaygroundRunRequest,
    request: Request,
):
    """Run the agent flow with granular debug events for each node lifecycle step.

    Events emitted (in addition to normal agent events):
    - ``pre_step``    — pre-processing step (dto_cache, augment, embeddings, plan)
    - ``node_enter``  — entering a node
    - ``prep_done``   — node.prep() completed
    - ``exec_done``   — node.exec() completed
    - ``post_done``   — node.post() completed with action
    - ``node_exit``   — leaving a node
    - ``node_error``  — exception in node
    - ``paused``      — execution paused
    - ``resumed``     — execution resumed
    - ``state_snapshot`` — shared state snapshot
    - ``flow_complete`` — agent flow finished
    """
    run_id = f"dbg-{uuid.uuid4().hex[:10]}"

    session = DebugSession(run_id=run_id)
    session.pause_event.set()  # Start running (not paused)
    if req.start_paused:
        session.pause_event.clear()
        session.step_mode = True
    session.is_running = True
    _debug_sessions[run_id] = session

    queue: asyncio.Queue = asyncio.Queue()
    flow_result: dict = {}
    loop = asyncio.get_running_loop()

    DONE = object()

    def on_event(event: str, message: str, data: Optional[dict] = None):
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {"event": event, "message": message, "data": data or {}},
        )

    def debug_callback(event: str, node: str, data: dict):
        """Bridge debug events to SSE queue."""
        on_event(event, node, {"node": node, **data})

    async def run_flow():
        def run_sync():
            from pathlib import Path
            from config import get_settings
            from llm.llm_factory import create_client_for_task
            from services.tool_registry import get_default_registry
            from nodes.memory.memory_store import MemoryStore

            settings = get_settings()
            parquet_dir = Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")

            # LLM client
            on_event("pre_step", "Loading LLM client...", {"step": "llm_client"})
            llm_client = create_client_for_task("agent")
            on_event("pre_step", f"LLM: {llm_client.config.provider}/{llm_client.config.model}", {
                "step": "llm_client",
                "provider": llm_client.config.provider,
                "model": llm_client.config.model,
            })

            # DTO cache + schema
            on_event("pre_step", "Loading DTO cache & schema...", {"step": "dto_cache"})
            from flows.agent_flow import _ensure_dto_cache, _list_parquet_files
            compact_schema = _ensure_dto_cache(parquet_dir)
            parquet_stems = _list_parquet_files(parquet_dir)
            on_event("pre_step", f"Schema: {len(compact_schema)} chars, {len(parquet_stems)} files", {
                "step": "dto_cache",
                "schema_len": len(compact_schema),
                "file_count": len(parquet_stems),
                "parquet_stems": parquet_stems,
                "schema": compact_schema[:3000],
            })

            # Query augmentation
            on_event("pre_step", "Augmenting query...", {"step": "augment"})
            from flows.agent_flow import _augment_query
            from nodes.memory.memory_store import MemoryStore as _MS
            _playground_store = _MS(persist_dir="data/memory")
            augmented = _augment_query(
                req.query, llm_client, compact_schema, parquet_stems,
                memory_store=_playground_store, session_id="playground",
            )
            on_event("pre_step", f"Augmented: {augmented[:120]}", {
                "step": "augment",
                "original": req.query,
                "augmented": augmented,
            })

            # Embedding column search
            on_event("pre_step", "Searching embeddings for column matches...", {"step": "embeddings"})
            from flows.agent_flow import _search_embeddings_for_columns, _format_column_matches
            column_matches = _search_embeddings_for_columns(augmented, parquet_dir)
            match_count = sum(len(v) for v in column_matches.values())
            on_event("pre_step", f"Found {match_count} matches in {len(column_matches)} columns", {
                "step": "embeddings",
                "match_count": match_count,
                "columns": list(column_matches.keys()),
                "matches": _safe_json(column_matches),
            })

            # Plan decomposition
            on_event("pre_step", "Decomposing query into plan...", {"step": "plan"})
            from flows.agent_flow import _decompose_plan
            plan = _decompose_plan(
                augmented, llm_client, compact_schema, column_matches=column_matches,
                memory_store=_playground_store, session_id="playground",
            )
            on_event("pre_step", f"Plan: {plan.count(chr(10))+1 if plan else 0} steps", {
                "step": "plan",
                "plan": plan,
            })

            # Build system prompt
            on_event("pre_step", "Building system prompt...", {"step": "system_prompt"})
            from flows.agent_flow import _build_system_prompt, _retrieve_cte_graph_prompt_context
            from skill_registry import load_skill_definitions, build_selected_skills_context
            skills = load_skill_definitions()
            skills_ctx = build_selected_skills_context(skills, include_full_content=False) if skills else ""

            cte_graph_ctx = _retrieve_cte_graph_prompt_context(augmented, req.query)

            memory_store = MemoryStore(persist_dir="data/memory")
            system_prompt = _build_system_prompt(
                compact_schema=compact_schema,
                parquet_stems=parquet_stems,
                skills_context=skills_ctx,
                analysis_plan=plan,
                memory_store=memory_store,
                session_id="playground",
                column_matches=column_matches,
                cte_graph_context=cte_graph_ctx,
            )
            on_event("pre_step", f"System prompt: {len(system_prompt)} chars", {
                "step": "system_prompt",
                "prompt_length": len(system_prompt),
                "prompt_preview": system_prompt[:5000],
            })

            # Build flow with debug instrumentation
            from nodes.agent.router_node import AgentRouterNode
            from nodes.agent.tool_dispatch_node import ToolDispatchNode
            from nodes.agent.verify_node import VerifyNode
            from nodes.agent.response_node import AgentResponseNode

            r = AgentRouterNode(max_iterations=req.max_iterations)
            d = ToolDispatchNode()
            v = VerifyNode()
            resp = AgentResponseNode()

            from pocketflow import Node as _PFNode

            class _EndNode(_PFNode):
                """No-op terminal node for the debug flow."""
                pass

            end = _EndNode()
            end._name = "FlowEnd"

            r - "dispatch" >> d
            r - "respond" >> resp
            d >> v
            v - "think" >> r
            v - "respond" >> resp
            resp - "done" >> end

            flow = DebugFlow(start=r, debug_callback=debug_callback, session=session)

            registry = get_default_registry()

            shared: Dict[str, Any] = {
                "query": augmented,
                "original_query": req.query,
                "session_id": "playground",
                "max_iterations": req.max_iterations,
                "agent_iteration": 0,
                "agent_messages": [],
                "agent_system_prompt": system_prompt,
                "agent_llm_client": llm_client,
                "tool_registry": registry,
                "tool_definitions": registry.list_definitions(),
                "pending_tool_results": [],
                "memory_store": memory_store,
                "connector_manager": getattr(request.app.state, "connector_manager", None),
                "stream_callback": on_event,
            }

            on_event("pre_complete", "Pre-processing complete. Starting agent loop.", {
                "augmented_query": augmented,
                "plan": plan,
                "column_match_count": match_count,
            })

            flow.run(shared)
            flow_result["shared"] = shared

        try:
            await loop.run_in_executor(None, run_sync)
        except Exception as exc:
            logger.exception("Playground flow failed: %s", exc)
            loop.call_soon_threadsafe(
                queue.put_nowait,
                {"event": "error", "message": str(exc), "data": {"type": type(exc).__name__}},
            )
        finally:
            session.is_running = False
            loop.call_soon_threadsafe(queue.put_nowait, DONE)

    async def event_generator():
        task = asyncio.create_task(run_flow())

        yield SSEEvent(event="run_start", data={
            "run_id": run_id,
            "query": req.query,
            "max_iterations": req.max_iterations,
            "start_paused": req.start_paused,
        }).to_sse_payload()

        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=30.0)
            except asyncio.TimeoutError:
                yield SSEEvent(event="heartbeat", data={"run_id": run_id}).to_sse_payload()
                continue

            if item is DONE:
                break

            evt = item.get("event", "debug")
            msg = item.get("message", "")
            data = item.get("data") or {}

            yield SSEEvent(
                event=evt,
                data=_safe_json({"run_id": run_id, "message": msg, **data}),
            ).to_sse_payload()

        await task

        shared = flow_result.get("shared", {})
        yield SSEEvent(event="flow_complete", data=_safe_json({
            "run_id": run_id,
            "iterations": shared.get("agent_iteration", 0),
            "final_response": shared.get("final_response", ""),
            "sql_queries": shared.get("sql_queries", []),
            "sql_results": shared.get("sql_results", []),
            "shared_state": _snapshot_shared(shared),
        })).to_sse_payload()

    return EventSourceResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={"X-Run-ID": run_id},
    )


@router.post("/control/{run_id}", summary="Control debug execution")
async def playground_control(run_id: str, req: PlaygroundControlRequest):
    """Pause, resume, or step through the agent flow execution."""
    session = _get_session(run_id)
    if not session:
        return {"error": f"Run '{run_id}' not found", "success": False}

    if req.action == "pause":
        session.pause_event.clear()
        return {"success": True, "state": "paused", "run_id": run_id}

    elif req.action == "resume":
        session.step_mode = False
        session.pause_event.set()
        return {"success": True, "state": "running", "run_id": run_id}

    elif req.action == "step":
        session.step_mode = True
        session.pause_event.set()  # Unblock one node, then re-pause
        return {"success": True, "state": "stepping", "run_id": run_id}

    return {"error": f"Unknown action: {req.action}", "success": False}


@router.post("/chat", summary="LLM debugging assistant")
async def playground_chat(req: PlaygroundChatRequest):
    """Chat with an LLM that has context about the execution trace for debugging."""
    from llm.llm_factory import create_client_for_task

    try:
        llm = create_client_for_task("agent")
    except Exception:
        from llm.llm_factory import create_llm_client
        llm = create_llm_client(provider="groq")

    # Build context from trace
    trace_text = ""
    if req.trace:
        lines = []
        for entry in req.trace[-50:]:  # Last 50 events
            evt = entry.get("event", "?")
            node = entry.get("node", entry.get("message", ""))
            data = entry.get("data", {})
            ts = data.get("timestamp", "")
            lines.append(f"[{ts}] {evt}: {node} {json.dumps(_safe_json(data, max_len=200), ensure_ascii=False)[:300]}")
        trace_text = "\n".join(lines)

    system_prompt = """You are a debugging assistant for the Brikz Agent flow.
You analyze execution traces to diagnose issues and suggest fixes.

The agent flow is a PocketFlow DAG with nodes:
- AgentRouter: LLM decides to call tools or respond (via generate_with_tools)
- ToolDispatch: Executes tool calls (sql_query, semantic_search, etc.)
- Verify: Checks results, routes back to Router or to Response
- AgentResponse: Formats final answer

Common issues:
- LLM returns empty content (model doesn't support tool calling)
- SQL errors (wrong table name, column name, syntax)
- Semantic search returns no matches (threshold too high, wrong query)
- Max iterations hit without useful result

When suggesting code fixes, show the exact file path and code change needed.
Respond in the user's language (French by default)."""

    messages = [{"role": "user", "content": f"""## Execution Trace
{trace_text or '(no trace available)'}

## Shared State Summary
{req.shared_state_summary or '(not available)'}

## User Question
{req.message}"""}]

    try:
        resp = llm.generate(messages=messages, system_prompt=system_prompt)
        return {"response": resp.content, "model": resp.model}
    except Exception as exc:
        return {"response": f"LLM error: {exc}", "model": "error"}


@router.get("/sessions", summary="List active debug sessions")
async def list_debug_sessions():
    """List all debug sessions with their status."""
    sessions = []
    for run_id, s in _debug_sessions.items():
        sessions.append({
            "run_id": run_id,
            "is_running": s.is_running,
            "is_paused": not s.pause_event.is_set(),
            "trace_count": len(s.trace),
        })
    return {"sessions": sessions}
