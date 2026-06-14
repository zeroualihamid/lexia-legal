# routes/streaming.py

"""
Streaming Endpoints (SSE)
==========================

Real-time Server-Sent Events endpoints for workflow and LLM streaming.

GET /stream/workflow/{run_id}  – stream workflow progress
POST /stream/llm                – stream LLM token generation
GET /stream/debate/{debate_id} – stream live debate rounds
"""

from typing import Optional
from fastapi import APIRouter, Body
from sse_starlette.sse import EventSourceResponse

from api.sse_streaming import (
    stream_workflow_progress,
    stream_llm_generation,
    SSEEvent,
)

router = APIRouter()


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/workflow/{run_id}", summary="Stream workflow progress (SSE)")
async def stream_workflow(
    run_id: str,
    session_id: Optional[str] = None,
):
    """
    Subscribe to real-time workflow progress via Server-Sent Events.

    Events:
        workflow_start   – run metadata
        step_start       – node begins execution
        step_complete    – node finished
        llm_token        – individual token during generation
        code_generated   – full code block ready
        validation_result– check result (syntax/security/schema)
        debate_round     – proposer ↔ challenger exchange
        execution_result – sandbox output
        workflow_complete– final result
        error            – pipeline error
        heartbeat        – keepalive (every 15s)

    Client example (JavaScript):
        const es = new EventSource('/stream/workflow/run-abc123');
        
        es.addEventListener('step_start', (e) => {
            const data = JSON.parse(e.data);
            console.log('Step started:', data.node);
        });
        
        es.addEventListener('code_generated', (e) => {
            const data = JSON.parse(e.data);
            updateEditor(data.code);
        });
        
        es.addEventListener('workflow_complete', (e) => {
            es.close();
        });
        
        es.onerror = () => es.close();

    Returns:
        Server-Sent Events stream (text/event-stream)
    """
    session = session_id or f"stream-{run_id}"
    
    async def event_generator():
        async for event in stream_workflow_progress(run_id, session):
            yield event.to_sse_payload()

    return EventSourceResponse(event_generator())


@router.post("/llm", summary="Stream LLM token generation (SSE)")
async def stream_llm(
    prompt: str = Body(..., embed=True),
    model: Optional[str] = Body("claude-sonnet-4", embed=True),
    system: Optional[str] = Body(None, embed=True),
):
    """
    Stream LLM token generation in real-time.

    Events:
        llm_start    – generation begins
        llm_token    – individual token
        llm_complete – generation finished
        llm_error    – error occurred

    Client example:
        const es = new EventSource('/stream/llm', {
            method: 'POST',
            body: JSON.stringify({prompt: "Write a function..."})
        });
        
        let code = '';
        es.addEventListener('llm_token', (e) => {
            code += JSON.parse(e.data).token;
            updateEditor(code);
        });
        
        es.addEventListener('llm_complete', () => es.close());

    Returns:
        Server-Sent Events stream
    """
    async def event_generator():
        async for event in stream_llm_generation(prompt, model, system):
            yield event.to_sse_payload()

    return EventSourceResponse(event_generator())


@router.get("/debate/{debate_id}", summary="Stream live agent debate (SSE)")
async def stream_debate(debate_id: str):
    """
    Stream a live Proposer ↔ Challenger debate in real-time.

    Events:
        debate_start      – debate metadata
        round_start       – round N begins
        proposal_ready    – proposer code ready
        challenge_ready   – challenger issues ready
        defense_ready     – proposer defense ready
        consensus_score   – round consensus score
        round_complete    – round finished (resolved: true/false)
        debate_complete   – final consensus or stalemate
        debate_error      – error occurred

    Client example:
        const es = new EventSource('/stream/debate/debate-abc123');
        
        es.addEventListener('proposal_ready', (e) => {
            const {code, round} = JSON.parse(e.data);
            showProposal(code, round);
        });
        
        es.addEventListener('challenge_ready', (e) => {
            const {issues} = JSON.parse(e.data);
            showIssues(issues);
        });
        
        es.addEventListener('debate_complete', (e) => {
            const {final_code, status} = JSON.parse(e.data);
            showFinalCode(final_code, status);
            es.close();
        });
    """
    async def event_generator():
        # Stub: would connect to live debate execution
        yield SSEEvent(
            event="debate_start",
            data={"debate_id": debate_id, "status": "streaming"},
        ).to_sse_payload()
        
        # Implementation would stream actual debate events here
        # async for event in _run_debate_with_streaming(debate_id):
        #     yield event.to_sse_payload()

    return EventSourceResponse(event_generator())
