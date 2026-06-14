"""Admin endpoints: list user conversations and the CTE extractions in them.

Read-only views over the persisted memory store, used by the brikz-admin
"Conversations" view (and as context for the Claude Code CTE-pertinence judge).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query

from services import conversation_review, cte_extraction_log

router = APIRouter()


@router.get("", summary="List user conversations (with CTE-usage counts)")
async def list_conversations(limit: int = Query(100, ge=1, le=500)):
    items = conversation_review.list_conversations(limit=limit)
    return {"conversations": items, "count": len(items)}


@router.get("/{session_id}", summary="A conversation's turns: query → CTE(s) → result")
async def get_conversation(session_id: str, sample_rows: int = Query(5, ge=0, le=50)):
    data = conversation_review.load_conversation_turns(session_id, sample_rows=sample_rows)
    if data is None:
        raise HTTPException(status_code=404, detail=f"Conversation not found: {session_id}")
    return data


@router.delete("", summary="Delete ALL conversations")
async def delete_all_conversations():
    deleted = cte_extraction_log.delete_all()
    return {"success": True, "deleted": deleted}


@router.delete("/{session_id}", summary="Delete one conversation (a single turn)")
async def delete_conversation(session_id: str):
    cte_extraction_log.delete_record(session_id)
    return {"success": True, "session_id": session_id}
