# routes/agents.py

"""
Agent Management Endpoints
===========================

GET  /agents/config                – current agent configuration
PUT  /agents/config                – update agent configuration
POST /agents/debate                – run a single debate round
GET  /agents/debate/{debate_id}    – get debate result
GET  /agents/debate/history        – recent debate history
POST /agents/propose               – get a standalone proposal
POST /agents/challenge             – challenge a code snippet
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter()

# In-memory debate store (replace with DB in production)
_DEBATES: Dict[str, Dict[str, Any]] = {}


# ── Models ────────────────────────────────────────────────────────────────────

class AgentConfigOut(BaseModel):
    debate_max_rounds:      int
    debate_consensus_threshold: float
    proposer_strategy:      str
    proposer_confidence_threshold: float
    challenger_strategy:    str
    challenger_min_issues:  int
    consensus_quality_threshold: str


class AgentConfigUpdate(BaseModel):
    debate_max_rounds:           Optional[int]   = None
    debate_consensus_threshold:  Optional[float] = None
    proposer_strategy:           Optional[str]   = None
    proposer_confidence_threshold: Optional[float] = None
    challenger_strategy:         Optional[str]   = None
    challenger_min_issues:       Optional[int]   = None
    consensus_quality_threshold: Optional[str]   = None


class DebateRequest(BaseModel):
    code:        str  = Field(..., min_length=1, description="Code to debate")
    description: str  = Field("", description="Task description for context")
    session_id:  Optional[str] = None
    schema_text: Optional[str] = None   # inject schema for column-aware debate


class IssueOut(BaseModel):
    severity:    str    # critical | high | medium | low
    category:    str    # correctness | performance | security | style
    description: str
    line:        Optional[int] = None
    suggestion:  str = ""


class DebateRoundOut(BaseModel):
    round_number: int
    proposal:     str
    challenge:    str
    defense:      str
    issues:       List[IssueOut]
    resolved:     bool


class DebateResult(BaseModel):
    debate_id:       str
    status:          str     # consensus | stalemate | timeout
    rounds_taken:    int
    final_code:      str
    consensus_score: float
    issues_resolved: int
    issues_remaining: int
    rounds:          List[DebateRoundOut]
    created_at:      str


class ProposalRequest(BaseModel):
    description: str  = Field(..., min_length=3)
    context:     Optional[str] = None
    schema_text: Optional[str] = None
    reuse_hint:  Optional[str] = None   # suggest an existing node_id to build on


class ChallengeRequest(BaseModel):
    code:        str  = Field(..., min_length=1)
    description: str  = ""
    depth:       str  = Field("thorough", pattern="^(thorough|balanced|lenient)$")
    schema_text: Optional[str] = None


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/config", response_model=AgentConfigOut,
            summary="Get current agent configuration")
async def get_agent_config() -> AgentConfigOut:
    """Return the current agent debate configuration."""
    try:
        from config.settings import settings
        return AgentConfigOut(
            debate_max_rounds              = getattr(settings, "debate_max_rounds",              4),
            debate_consensus_threshold     = getattr(settings, "debate_consensus_threshold",     0.90),
            proposer_strategy              = getattr(settings, "proposer_strategy",              "reuse_first"),
            proposer_confidence_threshold  = getattr(settings, "proposer_confidence_threshold",  0.80),
            challenger_strategy            = getattr(settings, "challenger_strategy",            "thorough"),
            challenger_min_issues          = getattr(settings, "challenger_min_issues_threshold", 1),
            consensus_quality_threshold    = getattr(settings, "consensus_quality_threshold",    "medium"),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.put("/config", response_model=AgentConfigOut,
            summary="Update agent configuration")
async def update_agent_config(update: AgentConfigUpdate) -> AgentConfigOut:
    """
    Patch agent configuration at runtime.
    Only provided fields are updated; omitted fields remain unchanged.
    """
    try:
        from config.settings import settings
        for field, value in update.model_dump(exclude_none=True).items():
            if hasattr(settings, field):
                setattr(settings, field, value)
        return await get_agent_config()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/debate", response_model=DebateResult, status_code=201,
             summary="Run a full agent debate")
async def run_debate(req: DebateRequest) -> DebateResult:
    """
    Run a multi-round Proposer ↔ Challenger debate on a code snippet.

    The debate ends when:
    - Consensus score ≥ consensus_threshold  (success)
    - Max rounds reached                     (stalemate)

    Returns the final agreed-upon code and full round history.
    """
    debate_id = f"debate-{uuid.uuid4().hex[:10]}"
    now       = _utc_now()

    try:
        from config.settings import settings
        from agents.proposer_agent  import ProposerAgent
        from agents.challenger_agent import ChallengerAgent
        from agents.consensus_builder import ConsensusBuilder
        from llm.llm_factory import create_client_for_task

        # Wire agents with task-optimal LLM clients
        proposer   = ProposerAgent(
            config     = settings,
            llm_client = create_client_for_task("agent_proposal", config=settings),
        )
        challenger = ChallengerAgent(
            config     = settings,
            llm_client = create_client_for_task("agent_challenge", config=settings),
        )
        consensus  = ConsensusBuilder(settings)

        extra_ctx = {"schema_text": req.schema_text} if req.schema_text else {}

        # Run debate loop
        rounds: List[DebateRoundOut] = []
        current_code = req.code
        max_rounds   = getattr(settings, "debate_max_rounds", 4)
        threshold    = getattr(settings, "debate_consensus_threshold", 0.90)
        final_status = "stalemate"

        for r in range(1, max_rounds + 1):
            proposal   = proposer.create_proposal(current_code, req.description, **extra_ctx)
            challenge  = challenger.challenge(proposal, **extra_ctx)
            defense    = proposer.defend(proposal, challenge)
            score      = consensus.evaluate(proposal, challenge, defense)

            issues = [
                IssueOut(
                    severity    = i.get("severity", "medium"),
                    category    = i.get("category", "correctness"),
                    description = i.get("description", ""),
                    line        = i.get("line"),
                    suggestion  = i.get("suggestion", ""),
                )
                for i in challenge.get("issues", [])
            ]

            resolved = score >= threshold
            rounds.append(DebateRoundOut(
                round_number = r,
                proposal     = proposal.get("code", current_code),
                challenge    = challenge.get("summary", ""),
                defense      = defense.get("response", ""),
                issues       = issues,
                resolved     = resolved,
            ))

            if resolved:
                current_code = proposal.get("code", current_code)
                final_status = "consensus"
                break

        total_issues    = sum(len(r.issues) for r in rounds)
        resolved_issues = sum(len(r.issues) for r in rounds if r.resolved)

        result = DebateResult(
            debate_id        = debate_id,
            status           = final_status,
            rounds_taken     = len(rounds),
            final_code       = current_code,
            consensus_score  = rounds[-1].resolved * 1.0 if rounds else 0.0,
            issues_resolved  = resolved_issues,
            issues_remaining = total_issues - resolved_issues,
            rounds           = rounds,
            created_at       = now,
        )
        _DEBATES[debate_id] = result.model_dump()
        return result

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/debate/{debate_id}", response_model=DebateResult,
            summary="Get debate result")
async def get_debate(debate_id: str) -> DebateResult:
    """Return the result of a previously completed debate."""
    record = _DEBATES.get(debate_id)
    if not record:
        raise HTTPException(status_code=404, detail=f"Debate not found: {debate_id}")
    return DebateResult(**record)


@router.get("/debate/history", summary="List recent debates")
async def debate_history(limit: int = 20) -> Dict[str, Any]:
    """Return the most recent debates (newest first)."""
    debates = sorted(
        _DEBATES.values(),
        key=lambda d: d.get("created_at", ""),
        reverse=True,
    )[:limit]
    return {"debates": debates, "total": len(_DEBATES)}


@router.post("/propose", summary="Generate a standalone proposal")
async def propose(req: ProposalRequest) -> Dict[str, Any]:
    """
    Ask the ProposerAgent to generate code for a description
    without running the full debate loop.
    """
    try:
        from config.settings import settings
        from agents.proposer_agent import ProposerAgent
        from llm.llm_factory import create_client_for_task

        agent = ProposerAgent(
            config     = settings,
            llm_client = create_client_for_task("agent_proposal", config=settings),
        )
        proposal = agent.create_proposal(
            code        = "",
            description = req.description,
            context     = req.context or "",
            schema_text = req.schema_text or "",
            reuse_hint  = req.reuse_hint or "",
        )
        return {"proposal": proposal, "created_at": _utc_now()}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/challenge", summary="Challenge a code snippet")
async def challenge(req: ChallengeRequest) -> Dict[str, Any]:
    """
    Ask the ChallengerAgent to analyse a code snippet without a full debate.
    Useful for one-shot code review.
    """
    try:
        from config.settings import settings
        from agents.challenger_agent import ChallengerAgent
        from llm.llm_factory import create_client_for_task

        agent = ChallengerAgent(
            config     = settings,
            llm_client = create_client_for_task("agent_challenge", config=settings),
        )
        proposal = {"code": req.code, "description": req.description}
        result   = agent.challenge(
            proposal    = proposal,
            depth       = req.depth,
            schema_text = req.schema_text or "",
        )
        return {"challenge": result, "created_at": _utc_now()}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
