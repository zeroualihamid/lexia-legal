"""
Memory Store — Session-scoped conversation memory with short-term and long-term tiers.

Architecture:
  ┌──────────────────────────────────────────────┐
  │  SessionMemory (per session_id)              │
  │  ┌───────────────────┐ ┌───────────────────┐ │
  │  │  Short-term        │ │  Long-term        │ │
  │  │  (sliding window)  │ │  (running summary │ │
  │  │  verbatim messages  │ │   + entity map)   │ │
  │  └───────────────────┘ └───────────────────┘ │
  └──────────────────────────────────────────────┘

Short-term: last N message pairs kept verbatim for high-fidelity recall.
Long-term:  a running summary that gets progressively updated when messages
            roll out of the short-term window.  Also an entity map that
            tracks referenced files, tables, variables, and topics.
"""

from __future__ import annotations

import json
import threading
import time
from copy import deepcopy
from dataclasses import dataclass, field, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from monitoring.logger import get_logger

logger = get_logger(__name__)


@dataclass
class MemoryMessage:
    role: str  # "user" | "assistant" | "system"
    content: str
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)
    token_estimate: int = 0

    def __post_init__(self):
        if self.token_estimate == 0:
            self.token_estimate = estimate_tokens(self.content)

    def to_chat_dict(self) -> Dict[str, str]:
        return {"role": self.role, "content": self.content}


@dataclass
class EntityMap:
    """Tracks key entities mentioned across the conversation."""
    files: List[str] = field(default_factory=list)
    tables: List[str] = field(default_factory=list)
    columns: List[str] = field(default_factory=list)
    topics: List[str] = field(default_factory=list)
    custom: Dict[str, str] = field(default_factory=dict)

    def merge(self, other: "EntityMap") -> None:
        for attr in ("files", "tables", "columns", "topics"):
            existing = set(getattr(self, attr))
            for item in getattr(other, attr):
                if item not in existing:
                    getattr(self, attr).append(item)
                    existing.add(item)
        self.custom.update(other.custom)

    def to_text(self) -> str:
        parts: List[str] = []
        if self.files:
            parts.append(f"Files: {', '.join(self.files[-10:])}")
        if self.tables:
            parts.append(f"Tables: {', '.join(self.tables[-10:])}")
        if self.columns:
            parts.append(f"Columns: {', '.join(self.columns[-15:])}")
        if self.topics:
            parts.append(f"Topics: {', '.join(self.topics[-8:])}")
        if self.custom:
            extras = [f"{k}={v}" for k, v in list(self.custom.items())[-5:]]
            parts.append(f"Other: {', '.join(extras)}")
        return "; ".join(parts) if parts else ""


@dataclass
class SessionMemory:
    """Complete memory state for one session."""
    session_id: str
    short_term: List[MemoryMessage] = field(default_factory=list)
    running_summary: str = ""
    summary_message_count: int = 0
    entities: EntityMap = field(default_factory=EntityMap)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)

    @property
    def total_messages(self) -> int:
        return self.summary_message_count + len(self.short_term)

    @property
    def short_term_tokens(self) -> int:
        return sum(m.token_estimate for m in self.short_term)

    def add_message(self, role: str, content: str, metadata: Optional[Dict] = None) -> MemoryMessage:
        msg = MemoryMessage(role=role, content=content, metadata=metadata or {})
        self.short_term.append(msg)
        self.updated_at = time.time()
        return msg

    def get_overflow(self, max_short_term: int) -> List[MemoryMessage]:
        """Return messages that exceed the short-term window (oldest first)."""
        if len(self.short_term) <= max_short_term:
            return []
        overflow = self.short_term[: len(self.short_term) - max_short_term]
        self.short_term = self.short_term[len(self.short_term) - max_short_term :]
        return overflow

    def build_context_messages(
        self,
        system_prompt: Optional[str] = None,
        token_budget: int = 3000,
    ) -> List[Dict[str, str]]:
        """
        Build the optimal messages array for an LLM call.

        Layout:
            [system]  (system_prompt + running_summary + entities)
            [user/assistant pairs from short-term window]

        Trims oldest short-term messages if they exceed the token budget.
        """
        messages: List[Dict[str, str]] = []

        system_parts: List[str] = []
        if system_prompt:
            system_parts.append(system_prompt)
        if self.running_summary:
            system_parts.append(
                f"\n<conversation_summary>\n{self.running_summary}\n</conversation_summary>"
            )
        entity_text = self.entities.to_text()
        if entity_text:
            system_parts.append(
                f"\n<tracked_entities>\n{entity_text}\n</tracked_entities>"
            )

        if system_parts:
            system_content = "\n".join(system_parts)
            messages.append({"role": "system", "content": system_content})
            token_budget -= estimate_tokens(system_content)

        used = 0
        trimmed: List[Dict[str, str]] = []
        for msg in reversed(self.short_term):
            msg_tokens = msg.token_estimate
            if used + msg_tokens > token_budget and trimmed:
                break
            trimmed.append(msg.to_chat_dict())
            used += msg_tokens

        trimmed.reverse()
        messages.extend(trimmed)
        return messages

    def get_last_result(self) -> Optional[Dict[str, Any]]:
        """Return structured result metadata from the most recent assistant message.

        Walks short_term in reverse looking for an assistant message whose
        ``metadata`` contains ``sql_queries`` or ``chart_data``.  Returns a
        dict suitable for injection into ``prior_response_data``.
        """
        for msg in reversed(self.short_term):
            if msg.role != "assistant":
                continue
            meta = msg.metadata
            if not meta:
                continue
            if meta.get("sql_queries") or meta.get("chart_data"):
                parts: List[str] = []
                if meta.get("sql_queries"):
                    parts.append("## Prior SQL queries")
                    for i, q in enumerate(meta["sql_queries"], 1):
                        sql = q.get("sql", q) if isinstance(q, dict) else str(q)
                        parts.append(f"{i}. {sql}")
                if meta.get("sql_results_summary"):
                    parts.append(f"\n## Prior results summary\n{meta['sql_results_summary']}")
                if meta.get("chart_data"):
                    cd = meta["chart_data"]
                    parts.append(f"\n## Prior chart: {cd.get('title', '')}")
                return {
                    "text": "\n".join(parts),
                    "sql_queries": meta.get("sql_queries"),
                    "sql_results": meta.get("sql_results"),
                    "chart_data": meta.get("chart_data"),
                }
        return None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "session_id": self.session_id,
            "short_term": [asdict(m) for m in self.short_term],
            "running_summary": self.running_summary,
            "summary_message_count": self.summary_message_count,
            "entities": asdict(self.entities),
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SessionMemory":
        short_term = [MemoryMessage(**m) for m in data.get("short_term", [])]
        entities = EntityMap(**data.get("entities", {}))
        return cls(
            session_id=data["session_id"],
            short_term=short_term,
            running_summary=data.get("running_summary", ""),
            summary_message_count=data.get("summary_message_count", 0),
            entities=entities,
            created_at=data.get("created_at", time.time()),
            updated_at=data.get("updated_at", time.time()),
        )


class MemoryStore:
    """
    Thread-safe in-memory store with optional disk persistence.

    Usage:
        store = MemoryStore(persist_dir="/path/to/dir")
        session = store.get_or_create("sess-123")
        session.add_message("user", "Hello")
        store.save(session.session_id)
    """

    def __init__(self, persist_dir: Optional[str] = None):
        self._sessions: Dict[str, SessionMemory] = {}
        self._lock = threading.Lock()
        self._persist_dir: Optional[Path] = None
        if persist_dir:
            self._persist_dir = Path(persist_dir)
            self._persist_dir.mkdir(parents=True, exist_ok=True)
            self._load_all()

    def get_or_create(self, session_id: str) -> SessionMemory:
        with self._lock:
            if session_id not in self._sessions:
                self._sessions[session_id] = SessionMemory(session_id=session_id)
                logger.debug("Created new session memory: %s", session_id)
            return self._sessions[session_id]

    def get(self, session_id: str) -> Optional[SessionMemory]:
        with self._lock:
            return self._sessions.get(session_id)

    def delete(self, session_id: str) -> None:
        with self._lock:
            self._sessions.pop(session_id, None)
        if self._persist_dir:
            p = self._persist_dir / f"{session_id}.json"
            p.unlink(missing_ok=True)

    def save(self, session_id: str) -> None:
        if not self._persist_dir:
            return
        with self._lock:
            session = self._sessions.get(session_id)
            if not session:
                return
            data = session.to_dict()
        p = self._persist_dir / f"{session_id}.json"
        p.write_text(json.dumps(data, ensure_ascii=False, indent=2))

    def save_all(self) -> None:
        if not self._persist_dir:
            return
        with self._lock:
            ids = list(self._sessions.keys())
        for sid in ids:
            self.save(sid)

    def list_sessions(self) -> List[str]:
        with self._lock:
            return list(self._sessions.keys())

    def _load_all(self) -> None:
        if not self._persist_dir:
            return
        for p in self._persist_dir.glob("*.json"):
            try:
                data = json.loads(p.read_text())
                session = SessionMemory.from_dict(data)
                self._sessions[session.session_id] = session
                logger.debug("Loaded session memory from disk: %s", session.session_id)
            except Exception as e:
                logger.warning("Failed to load session %s: %s", p.stem, e)


def estimate_tokens(text: str) -> int:
    """Rough token estimate: ~4 chars per token for Latin text, ~2 for CJK."""
    if not text:
        return 0
    return max(1, len(text) // 4)
