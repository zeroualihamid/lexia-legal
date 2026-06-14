# routes/conversation.py

"""
Conversation Endpoints
======================

GET    /conversation/{session_id}          – full conversation history
GET    /conversation/{session_id}/messages – paginated messages
POST   /conversation/{session_id}/message  – add a manual message
DELETE /conversation/{session_id}          – clear session history
GET    /conversation/                      – list all sessions
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()


# ── Models ────────────────────────────────────────────────────────────────────

class MessageIn(BaseModel):
    role:    str  = Field(..., pattern="^(user|assistant|system)$")
    content: str  = Field(..., min_length=1)
    metadata: Optional[Dict[str, Any]] = None


class MessageOut(BaseModel):
    message_id: str
    role:       str
    content:    str
    timestamp:  str
    metadata:   Dict[str, Any] = {}


class ConversationSummary(BaseModel):
    session_id:    str
    message_count: int
    created_at:    str
    updated_at:    str
    last_query:    str = ""


class ConversationHistory(BaseModel):
    session_id:    str
    messages:      List[MessageOut]
    message_count: int
    created_at:    str
    updated_at:    str


class SessionListResponse(BaseModel):
    sessions:   List[ConversationSummary]
    total:      int
    page:       int
    page_size:  int


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/", response_model=SessionListResponse, summary="List all sessions")
async def list_sessions(
    page:      int = Query(1,  ge=1),
    page_size: int = Query(20, ge=1, le=100),
) -> SessionListResponse:
    """Return a paginated list of active conversation sessions."""
    try:
        from config.settings import settings
        from conversation.history_manager import ConversationHistoryManager

        mgr      = ConversationHistoryManager(settings)
        sessions = mgr.list_sessions()

        total  = len(sessions)
        start  = (page - 1) * page_size
        paged  = sessions[start: start + page_size]

        return SessionListResponse(
            sessions  = [_session_to_summary(s) for s in paged],
            total     = total,
            page      = page,
            page_size = page_size,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{session_id}", response_model=ConversationHistory,
            summary="Get full conversation history")
async def get_conversation(session_id: str) -> ConversationHistory:
    """Return the complete message history for a session."""
    try:
        from config.settings import settings
        from conversation.history_manager import ConversationHistoryManager

        mgr     = ConversationHistoryManager(settings)
        messages_data = mgr.get_history(session_id)

        if not messages_data:
            raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")

        messages = [_msg_to_out(m) for m in messages_data]

        return ConversationHistory(
            session_id    = session_id,
            messages      = messages,
            message_count = len(messages),
            created_at    = messages[0].timestamp if messages else _utc_now(),
            updated_at    = messages[-1].timestamp if messages else _utc_now(),
        )
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{session_id}/messages", summary="Get paginated messages")
async def get_messages(
    session_id: str,
    page:       int           = Query(1,    ge=1),
    page_size:  int           = Query(20,   ge=1, le=200),
    role:       Optional[str] = Query(None, description="Filter by role"),
) -> Dict[str, Any]:
    """Return paginated messages for a session with optional role filter."""
    try:
        from config.settings import settings
        from conversation.history_manager import ConversationHistoryManager

        mgr     = ConversationHistoryManager(settings)
        messages = mgr.get_history(session_id)

        if not messages:
            raise HTTPException(status_code=404, detail=f"Session not found: {session_id}")
        if role:
            messages = [m for m in messages if m.get("role") == role]

        total  = len(messages)
        start  = (page - 1) * page_size
        paged  = messages[start: start + page_size]

        return {
            "session_id": session_id,
            "messages":   [_msg_to_out(m).__dict__ for m in paged],
            "total":      total,
            "page":       page,
            "page_size":  page_size,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/{session_id}/message", response_model=MessageOut,
             status_code=201, summary="Append a message")
async def add_message(session_id: str, msg: MessageIn) -> MessageOut:
    """
    Manually append a message to a conversation session.
    Useful for injecting system context or user corrections.
    """
    try:
        from config.settings import settings
        from conversation.history_manager import ConversationHistoryManager

        mgr = ConversationHistoryManager(settings)
        message_id = mgr.add_message(
            session_id=session_id,
            role=msg.role,
            content=msg.content,
            metadata=msg.metadata or {},
        )

        return MessageOut(
            message_id=message_id,
            role=msg.role,
            content=msg.content,
            timestamp=_utc_now(),
            metadata=msg.metadata or {},
        )

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/{session_id}", status_code=204, summary="Clear session history")
async def clear_session(session_id: str) -> None:
    """
    Permanently delete the conversation history for a session.
    The session_id can be reused afterwards (starts fresh).
    """
    try:
        from config.settings import settings
        from conversation.history_manager import ConversationHistoryManager

        mgr = ConversationHistoryManager(settings)
        mgr.clear_session(session_id)

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── Helpers ───────────────────────────────────────────────────────────────────

def _msg_to_out(msg: Dict[str, Any]) -> MessageOut:
    return MessageOut(
        message_id = msg.get("message_id", f"msg-{uuid.uuid4().hex[:8]}"),
        role       = msg.get("role", "user"),
        content    = msg.get("content", ""),
        timestamp  = msg.get("timestamp", _utc_now()),
        metadata   = msg.get("metadata", {}),
    )


def _session_to_summary(session: Dict[str, Any]) -> ConversationSummary:
    messages   = session.get("messages", [])
    last_query = next(
        (m["content"] for m in reversed(messages) if m.get("role") == "user"),
        ""
    )
    return ConversationSummary(
        session_id    = session.get("session_id", ""),
        message_count = len(messages),
        created_at    = session.get("created_at", _utc_now()),
        updated_at    = session.get("updated_at", _utc_now()),
        last_query    = last_query[:120],
    )


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()
