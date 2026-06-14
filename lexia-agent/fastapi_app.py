#!/usr/bin/env python3
"""
FastAPI app for agent-analyst with SSE streaming.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, AsyncGenerator, Optional
from uuid import uuid4

from dotenv import load_dotenv
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

PROJECT_ROOT = Path(__file__).resolve().parent.parent
AGENT_DIR = Path(__file__).resolve().parent

load_dotenv(AGENT_DIR / ".env")
load_dotenv(PROJECT_ROOT / ".env")

# Make the agent-analyst directory importable as "agent_analyst"
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

if "agent_analyst" not in sys.modules:
    spec = importlib.util.spec_from_file_location(
        "agent_analyst",
        AGENT_DIR / "__init__.py",
        submodule_search_locations=[str(AGENT_DIR)],
    )
    module = importlib.util.module_from_spec(spec)
    sys.modules["agent_analyst"] = module
    spec.loader.exec_module(module)

from agent_analyst.agent import ThinkingAgent  # type: ignore[import-not-found]  # noqa: E402
from agent_analyst.models import (  # type: ignore[import-not-found]  # noqa: E402
    AgentConfig,
    LLMProvider,
    StepStatus,
)


class ChatRequest(BaseModel):
    message: str
    sessionId: Optional[str] = None
    taskId: Optional[str] = None


app = FastAPI(title="agent-analyst SSE API")
default_origins = ["http://localhost:5173", "http://127.0.0.1:5173"]
env_origins = os.getenv("CORS_ORIGINS")
origins = (
    [o.strip() for o in env_origins.split(",") if o.strip()]
    if env_origins
    else default_origins
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)
_agent: ThinkingAgent | None = None


def _resolve_provider() -> LLMProvider:
    raw = os.getenv("LLM_PROVIDER") or os.getenv("PROVIDER") or os.getenv("AGENT_PROVIDER")
    if not raw:
        return LLMProvider.OPENAI
    try:
        return LLMProvider(raw)
    except Exception:
        return LLMProvider.OPENAI


def _resolve_api_key(provider: LLMProvider) -> str | None:
    direct = os.getenv("LLM_API_KEY")
    if direct:
        return direct
    key_map = {
        LLMProvider.OPENAI: "OPENAI_API_KEY",
        LLMProvider.ANTHROPIC: "ANTHROPIC_API_KEY",
        LLMProvider.DEEPSEEK: "DEEPSEEK_API_KEY",
        LLMProvider.GROQ: "GROQ_API_KEY",
        LLMProvider.KIMI: "KIMI_API_KEY",
    }
    env_key = key_map.get(provider)
    return os.getenv(env_key) if env_key else None


def get_agent() -> ThinkingAgent:
    global _agent
    if _agent is None:
        provider = _resolve_provider()
        base_url = os.getenv("LLM_BASE_URL")
        model = os.getenv("LLM_MODEL")
        temperature = float(os.getenv("LLM_TEMPERATURE", "1.0"))
        api_key = _resolve_api_key(provider)
        config = AgentConfig(
            llm_provider=provider,
            llm_base_url=base_url or AgentConfig().llm_base_url,
            llm_api_key=api_key,
            llm_model=model or AgentConfig().llm_model,
            llm_temperature=temperature,
            skills_dir=AGENT_DIR / "skills",
            prompts_dir=AGENT_DIR / "prompts",
            data_dir=AGENT_DIR / "data",
            output_dir=AGENT_DIR / "generated",
        )
        _agent = ThinkingAgent(config)
    return _agent


def _now() -> str:
    return datetime.utcnow().isoformat() + "Z"


async def _emit(queue: asyncio.Queue, payload: dict[str, Any]) -> None:
    await queue.put(payload)


async def _run_agent(
    queue: asyncio.Queue,
    query: str,
    task_id: str,
    session_id: str,
) -> None:
    agent = get_agent()
    try:
        await _emit(
            queue,
            {
                "type": "start",
                "taskId": task_id,
                "sessionId": session_id,
                "timestamp": _now(),
            },
        )

        await _emit(
            queue,
            {
                "type": "status",
                "taskId": task_id,
                "sessionId": session_id,
                "status": "planning",
                "progress": 5,
                "message": "Construction du plan...",
                "timestamp": _now(),
            },
        )

        plan = await agent._think(query)

        await _emit(
            queue,
            {
                "type": "status",
                "taskId": task_id,
                "sessionId": session_id,
                "status": "planning",
                "progress": 15,
                "message": f"Plan généré ({len(plan.steps)} étape(s))",
                "timestamp": _now(),
            },
        )

        iteration = 0
        for step in plan.steps:
            iteration += 1
            await _emit(
                queue,
                {
                    "type": "status",
                    "taskId": task_id,
                    "sessionId": session_id,
                    "status": "processing",
                    "progress": min(80, 15 + iteration * 10),
                    "message": f"Exécution étape {step.id}: {step.description}",
                    "timestamp": _now(),
                },
            )
            await agent._execute_step(step, plan, iteration)
            if step.status == StepStatus.SUCCESS:
                await _emit(
                    queue,
                    {
                        "type": "status",
                        "taskId": task_id,
                        "sessionId": session_id,
                        "status": "processing",
                        "progress": min(85, 20 + iteration * 10),
                        "message": f"Étape {step.id} terminée",
                        "timestamp": _now(),
                    },
                )
            else:
                await _emit(
                    queue,
                    {
                        "type": "error",
                        "taskId": task_id,
                        "sessionId": session_id,
                        "content": step.error or "Échec d'une étape",
                        "timestamp": _now(),
                    },
                )
                return

        await _emit(
            queue,
            {
                "type": "status",
                "taskId": task_id,
                "sessionId": session_id,
                "status": "synthesising",
                "progress": 90,
                "message": "Synthèse en cours...",
                "timestamp": _now(),
            },
        )

        answer = await agent._synthesise(query, plan)

        for line in answer.splitlines():
            await _emit(
                queue,
                {
                    "type": "chunk",
                    "taskId": task_id,
                    "sessionId": session_id,
                    "content": line + "\n",
                    "timestamp": _now(),
                },
            )

        await _emit(
            queue,
            {
                "type": "complete",
                "taskId": task_id,
                "sessionId": session_id,
                "result": {
                    "response": answer,
                },
                "timestamp": _now(),
            },
        )
    except Exception as exc:
        await _emit(
            queue,
            {
                "type": "error",
                "taskId": task_id,
                "sessionId": session_id,
                "content": str(exc),
                "timestamp": _now(),
            },
        )
    finally:
        await _emit(
            queue,
            {
                "type": "done",
                "taskId": task_id,
                "sessionId": session_id,
                "timestamp": _now(),
            },
        )


async def _event_stream(
    request: Request, query: str, task_id: str, session_id: str
) -> AsyncGenerator[str, None]:
    queue: asyncio.Queue = asyncio.Queue()
    task = asyncio.create_task(_run_agent(queue, query, task_id, session_id))

    while True:
        if await request.is_disconnected():
            task.cancel()
            break
        try:
            payload = await asyncio.wait_for(queue.get(), timeout=15.0)
        except asyncio.TimeoutError:
            yield ": heartbeat\n\n"
            continue

        yield f"data: {json.dumps(payload)}\n\n"

        if payload.get("type") in {"complete", "error", "done"}:
            break


@app.post("/chat")
async def chat(request: Request, body: ChatRequest) -> StreamingResponse:
    if not body.message:
        return StreamingResponse(
            iter(["data: " + json.dumps({"type": "error", "content": "Message is required"}) + "\n\n"]),
            media_type="text/event-stream",
        )

    task_id = body.taskId or str(uuid4())
    session_id = body.sessionId or str(uuid4())

    return StreamingResponse(
        _event_stream(request, body.message, task_id, session_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.get("/health")
async def health() -> JSONResponse:
    return JSONResponse(
        {
            "status": "ok",
            "agent": "ready",
        }
    )
