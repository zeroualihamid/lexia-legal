"""
Card API Routes
================

CRUD endpoints for domain analysis cards.
All reads are instant (JSON file), writes are atomic.
"""

import threading
from typing import List, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from agents.domain.card_models import DomainCard
from agents.domain.card_store import (
    load_cards,
    load_status,
    remove_card,
    reorder_cards,
    save_cards,
)
from agents.domain.registry import DOMAIN_AGENTS, _refresh_domain_agents
from monitoring.logger import get_logger

logger = get_logger(__name__)

router = APIRouter()


def _valid_domain(domain: str) -> bool:
    """Check if domain exists, refreshing custom domains first."""
    _refresh_domain_agents()
    return domain in DOMAIN_AGENTS


# ── Request / response models ─────────────────────────────────────────────

class RefreshRequest(BaseModel):
    domain: Optional[str] = Field(None, description="Single domain to refresh; omit for all")

class CreateCardRequest(BaseModel):
    user_request: str = Field(..., min_length=1, max_length=2000)
    card_type: str = Field("analysis", description="'kpi' or 'analysis'")

class ReorderRequest(BaseModel):
    card_ids: List[str] = Field(..., min_length=1)

class PinRequest(BaseModel):
    pinned: bool

class UpdatePromptRequest(BaseModel):
    prompt: str = Field(..., min_length=1, max_length=4000)


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.get("/{domain}")
async def get_cards(domain: str):
    """Return all cards for a domain — instant read from JSON."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")
    cards = load_cards(domain)
    return {"domain": domain, "cards": [c.to_dict() for c in cards], "count": len(cards)}


@router.get("/{domain}/status")
async def get_status(domain: str):
    """Return refresh status for a domain."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")
    status = load_status(domain)
    return {"domain": domain, **status}


@router.post("/refresh")
async def refresh_cards(request: Request, body: RefreshRequest):
    """Trigger an immediate card refresh (background thread)."""
    orchestrator = getattr(request.app.state, "card_orchestrator", None)
    if not orchestrator:
        raise HTTPException(503, "Card orchestrator not initialized")

    if orchestrator.is_running:
        return {"status": "already_running", "message": "A refresh is already in progress"}

    if body.domain:
        if not _valid_domain(body.domain):
            raise HTTPException(404, f"Unknown domain: {body.domain}")
        t = threading.Thread(
            target=orchestrator.run_single_agent,
            args=(body.domain,),
            daemon=True,
            name=f"card-refresh-{body.domain}",
        )
        t.start()
        return {"status": "started", "domain": body.domain}
    else:
        t = threading.Thread(
            target=orchestrator.run_all_agents,
            daemon=True,
            name="card-refresh-all",
        )
        t.start()
        return {"status": "started", "domain": "all"}


@router.post("/{domain}")
async def create_card(domain: str, body: CreateCardRequest, request: Request):
    """Create a custom card via LLM from a user request."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")

    orchestrator = getattr(request.app.state, "card_orchestrator", None)
    if not orchestrator:
        raise HTTPException(503, "Card orchestrator not initialized")

    card = orchestrator.create_custom_card(domain, body.user_request, card_type=body.card_type)
    if not card:
        raise HTTPException(500, "Failed to generate card")

    return {"domain": domain, "card": card.to_dict()}


@router.delete("/{domain}/{card_id}")
async def delete_card(domain: str, card_id: str):
    """Remove a card."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")
    cards = remove_card(domain, card_id)
    return {"domain": domain, "remaining": len(cards)}


@router.patch("/{domain}/reorder")
async def reorder(domain: str, body: ReorderRequest):
    """Update card display order."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")
    cards = reorder_cards(domain, body.card_ids)
    return {"domain": domain, "cards": [c.to_dict() for c in cards]}


@router.patch("/{domain}/{card_id}/prompt")
async def update_card_prompt(domain: str, card_id: str, body: UpdatePromptRequest, request: Request):
    """Update a card's prompt and regenerate it via LLM."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")

    orchestrator = getattr(request.app.state, "card_orchestrator", None)
    if not orchestrator:
        raise HTTPException(503, "Card orchestrator not initialized")

    card = orchestrator.regenerate_card(domain, card_id, body.prompt)
    if not card:
        raise HTTPException(500, "Failed to regenerate card from prompt")

    return {"domain": domain, "card": card.to_dict()}


@router.patch("/{domain}/{card_id}/pin")
async def pin_card(domain: str, card_id: str, body: PinRequest):
    """Toggle pin state on a card (pinned cards survive auto-refresh)."""
    if not _valid_domain(domain):
        raise HTTPException(404, f"Unknown domain: {domain}")
    cards = load_cards(domain)
    found = False
    for c in cards:
        if c.card_id == card_id:
            c.pinned = body.pinned
            found = True
            break
    if not found:
        raise HTTPException(404, f"Card not found: {card_id}")
    save_cards(domain, cards)
    return {"domain": domain, "card_id": card_id, "pinned": body.pinned}
