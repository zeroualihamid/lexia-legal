# routes/workflow.py

"""
Workflow Endpoints
==================

POST /workflow/run       – submit a new query and run the full pipeline
GET  /workflow/{run_id}  – poll execution status
POST /workflow/{run_id}/cancel – cancel a running workflow
GET  /workflow/history   – paginated list of past runs
"""

import uuid
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()

# In-memory run registry (replace with Redis / DB in production)
_RUNS: Dict[str, Dict[str, Any]] = {}


# ── Request / Response models ─────────────────────────────────────────────────

class RunWorkflowRequest(BaseModel):
    query:       str = Field(..., min_length=3, description="Natural-language task description")
    session_id:  Optional[str] = Field(None, description="Existing session to continue")
    config_override: Optional[Dict[str, Any]] = Field(None, description="Runtime config overrides")


class RunWorkflowResponse(BaseModel):
    run_id:     str
    session_id: str
    status:     str      # "queued" | "running" | "success" | "failed" | "cancelled"
    created_at: str


class StepResult(BaseModel):
    step_name:  str
    status:     str
    duration_ms: float
    output_summary: str = ""
    error: Optional[str] = None


class RunStatusResponse(BaseModel):
    run_id:       str
    session_id:   str
    status:       str
    query:        str
    created_at:   str
    updated_at:   str
    duration_ms:  Optional[float] = None
    steps:        List[StepResult] = []
    result:       Optional[Dict[str, Any]] = None
    error:        Optional[str] = None


class RunSummary(BaseModel):
    run_id:     str
    session_id: str
    status:     str
    query:      str
    created_at: str


class HistoryResponse(BaseModel):
    runs:       List[RunSummary]
    total:      int
    page:       int
    page_size:  int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.post("/run", response_model=RunWorkflowResponse, status_code=202,
             summary="Submit a workflow run")
async def run_workflow(
    req: RunWorkflowRequest,
    background_tasks: BackgroundTasks,
) -> RunWorkflowResponse:
    """
    Submit a natural-language query to the full code-generation pipeline.

    The workflow runs asynchronously. Poll GET /workflow/{run_id} for status.

    Pipeline stages:
        SchemaLoader → QueryAugmentation → PlanDecomposition →
        CodeGeneration → SyntaxValidation → SecurityCheck →
        Documentation → Optimization → FinalValidation →
        Debate (Proposer ↔ Challenger) → SandboxExecution → ResultHandler
    """
    run_id     = f"run-{uuid.uuid4().hex[:12]}"
    session_id = req.session_id or f"session-{uuid.uuid4().hex[:8]}"
    now        = _utc_now()

    run_record: Dict[str, Any] = {
        "run_id":     run_id,
        "session_id": session_id,
        "status":     "queued",
        "query":      req.query,
        "config_override": req.config_override or {},
        "created_at": now,
        "updated_at": now,
        "steps":      [],
        "result":     None,
        "error":      None,
        "_cancel":    False,
    }
    _RUNS[run_id] = run_record

    # Launch pipeline in background
    background_tasks.add_task(_execute_workflow, run_id, req)

    return RunWorkflowResponse(
        run_id     = run_id,
        session_id = session_id,
        status     = "queued",
        created_at = now,
    )


@router.get("/{run_id}", response_model=RunStatusResponse, summary="Poll run status")
async def get_run_status(run_id: str) -> RunStatusResponse:
    """
    Poll the status and incremental step results of a workflow run.

    Status values:
        queued      – waiting to start
        running     – pipeline in progress
        success     – completed successfully
        failed      – pipeline error
        cancelled   – cancelled by user
    """
    run = _get_run_or_404(run_id)
    return RunStatusResponse(**{k: v for k, v in run.items() if not k.startswith("_")})


@router.post("/{run_id}/cancel", summary="Cancel a running workflow")
async def cancel_run(run_id: str) -> Dict[str, str]:
    """
    Request cancellation of a queued or running workflow.
    The pipeline checks this flag between steps.
    """
    run = _get_run_or_404(run_id)

    if run["status"] in ("success", "failed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Run is already in terminal state: {run['status']}"
        )

    run["_cancel"]    = True
    run["status"]     = "cancelled"
    run["updated_at"] = _utc_now()

    return {"run_id": run_id, "status": "cancelled"}


@router.get("/history", response_model=HistoryResponse, summary="List past runs")
async def get_history(
    session_id: Optional[str] = Query(None, description="Filter by session"),
    status:     Optional[str] = Query(None, description="Filter by status"),
    page:       int           = Query(1,    ge=1),
    page_size:  int           = Query(20,   ge=1, le=100),
) -> HistoryResponse:
    """
    Return a paginated list of workflow runs, newest first.
    """
    runs = list(_RUNS.values())

    if session_id:
        runs = [r for r in runs if r["session_id"] == session_id]
    if status:
        runs = [r for r in runs if r["status"] == status]

    runs.sort(key=lambda r: r["created_at"], reverse=True)
    total  = len(runs)
    start  = (page - 1) * page_size
    paged  = runs[start: start + page_size]

    return HistoryResponse(
        runs=[
            RunSummary(
                run_id     = r["run_id"],
                session_id = r["session_id"],
                status     = r["status"],
                query      = r["query"],
                created_at = r["created_at"],
            )
            for r in paged
        ],
        total     = total,
        page      = page,
        page_size = page_size,
    )


# ── Background pipeline executor ─────────────────────────────────────────────

async def _execute_workflow(run_id: str, req: RunWorkflowRequest, domain: Optional[str] = None) -> None:
    """Run the full pipeline and update the run record incrementally."""
    run        = _RUNS[run_id]
    session_id = run["session_id"]
    t_start    = time.perf_counter()

    run["status"]     = "running"
    run["updated_at"] = _utc_now()

    try:
        from config.settings import settings

        # Apply any config overrides
        config = settings
        for k, v in (req.config_override or {}).items():
            if hasattr(config, k):
                setattr(config, k, v)

        # Shared state for the pipeline
        shared: Dict[str, Any] = {
            "user_query":   req.query,
            "session_id":   session_id,
            "config":       config,
            "run_id":       run_id,
            "step_results": run["steps"],   # pipeline writes step results here
        }

        # Execute — domain-scoped or general-purpose
        result = await _run_sync(shared, domain=domain)
        run["result"]      = result
        run["duration_ms"] = round((time.perf_counter() - t_start) * 1000, 1)
        run["updated_at"]  = _utc_now()

        # Reflect inner workflow outcome consistently in top-level run status.
        if isinstance(result, dict) and result.get("success") is False:
            run["status"] = "failed"
            run["error"] = result.get("error", "Workflow execution failed")
        else:
            run["status"] = "success"

    except Exception as e:
        run["status"]      = "failed"
        run["error"]       = str(e)
        run["duration_ms"] = round((time.perf_counter() - t_start) * 1000, 1)
        run["updated_at"]  = _utc_now()


async def _run_sync(shared: Dict, domain: Optional[str] = None) -> Dict:
    """Thin async wrapper around the synchronous PocketFlow pipeline."""
    import asyncio

    if domain:
        from flows.domain_workflow import run_domain_workflow as _run_domain
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
            lambda: _run_domain(
                query=shared["user_query"],
                session_id=shared["session_id"],
                domain_id=domain,
                config=shared["config"],
                step_results=shared.get("step_results", []),
                run_id=shared.get("run_id"),
            ),
        )

    from flows.main_workflow import run_workflow as _run
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(
        None,
        lambda: _run(
            query=shared["user_query"],
            session_id=shared["session_id"],
            config=shared["config"],
            step_results=shared.get("step_results", []),
            run_id=shared.get("run_id"),
        ),
    )


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_run_or_404(run_id: str) -> Dict:
    run = _RUNS.get(run_id)
    if not run:
        raise HTTPException(status_code=404, detail=f"Run not found: {run_id}")
    return run


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
