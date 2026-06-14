"""
ConversationMemoryNode — State-of-the-art conversation memory management.

This PocketFlow node manages the full lifecycle of conversation memory for a
user session.  It implements a two-tier architecture (short-term + long-term)
that keeps the LLM context window optimally filled without ever exceeding the
token budget.

Architecture:
    ┌────────────────────────────────────────────────────────────┐
    │  prep()                                                    │
    │    Read session_id, user_query, system_prompt from shared  │
    │    Load or create SessionMemory from MemoryStore           │
    │    Record the new user message                             │
    └────────────────┬───────────────────────────────────────────┘
                     │
    ┌────────────────▼───────────────────────────────────────────┐
    │  exec()                                                    │
    │    1. Drain overflow from short-term → summarize via LLM   │
    │    2. Extract entities from new messages via LLM           │
    │    3. Build optimized context messages array               │
    └────────────────┬───────────────────────────────────────────┘
                     │
    ┌────────────────▼───────────────────────────────────────────┐
    │  post()                                                    │
    │    Write memory_messages (ready for LLM) to shared         │
    │    Write memory_context (summary, entities) to shared      │
    │    Persist session to disk                                 │
    └────────────────────────────────────────────────────────────┘

Shared state contract:
    Required inputs:
        session_id      (str)
        user_query      (str) or query (str)

    Optional inputs:
        memory_system_prompt  (str)   — base system prompt
        memory_store          (MemoryStore) — shared store instance
        llm_response          (str)   — previous assistant response to record

    Outputs:
        memory_messages       (list[dict])  — ready-to-send messages array
        memory_context        (dict)        — summary, entities, stats
        memory_session        (SessionMemory) — full session object
"""

from __future__ import annotations

import time
import yaml
from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from nodes.memory.memory_store import (
    MemoryStore,
    SessionMemory,
    EntityMap,
    estimate_tokens,
)
from llm.llm_factory import get_llm
from config import get_settings
from monitoring.logger import get_logger

logger = get_logger(__name__)

_DEFAULT_SHORT_TERM_SIZE = 20  # message pairs (40 messages)
_DEFAULT_TOKEN_BUDGET = 3000
_SUMMARY_PROMPT_BUDGET = 600


class ConversationMemoryNode(BaseNode):
    """
    Manages conversation memory with automatic summarization and entity tracking.

    Parameters:
        max_short_term:  Maximum number of messages in the short-term window.
        token_budget:    Token budget for the context messages array.
        persist_dir:     Directory for disk persistence (None = in-memory only).
        auto_summarize:  Whether to auto-summarize overflow messages.
        auto_entities:   Whether to auto-extract entities from new messages.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        max_short_term: int = _DEFAULT_SHORT_TERM_SIZE,
        token_budget: int = _DEFAULT_TOKEN_BUDGET,
        persist_dir: Optional[str] = None,
        auto_summarize: bool = True,
        auto_entities: bool = True,
    ):
        super().__init__(name or "ConversationMemory")
        self.max_short_term = max_short_term
        self.token_budget = token_budget
        self.auto_summarize = auto_summarize
        self.auto_entities = auto_entities
        self._default_store = MemoryStore(persist_dir=persist_dir)

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        session_id = self.require_from_shared(shared, "session_id")
        user_query = shared.get("user_query") or shared.get("query") or ""

        store: MemoryStore = shared.get("memory_store") or self._default_store
        session = store.get_or_create(session_id)

        prev_response = shared.get("llm_response")
        if prev_response and (
            not session.short_term
            or session.short_term[-1].content != prev_response
        ):
            session.add_message("assistant", prev_response)

        if user_query:
            session.add_message("user", user_query)

        system_prompt = shared.get("memory_system_prompt") or shared.get("llm_system_prompt") or ""
        model = shared.get("memory_model") or shared.get("llm_model") or get_settings().llm.model

        return {
            "session": session,
            "store": store,
            "system_prompt": system_prompt,
            "model": model,
            "user_query": user_query,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        session: SessionMemory = prep_result["session"]
        model: str = prep_result["model"]
        system_prompt: str = prep_result["system_prompt"]

        start = time.time()

        overflow = session.get_overflow(self.max_short_term)
        if overflow and self.auto_summarize:
            self._summarize_overflow(session, overflow, model)

        if self.auto_entities and session.short_term:
            recent = session.short_term[-2:]
            self._extract_entities(session, recent, model)

        messages = session.build_context_messages(
            system_prompt=system_prompt,
            token_budget=self.token_budget,
        )

        duration = time.time() - start
        self.logger.info(
            "Memory built: %d context msgs, %d short-term, summary=%d chars, "
            "entities=%d, %.1fms",
            len(messages),
            len(session.short_term),
            len(session.running_summary),
            sum(
                len(getattr(session.entities, a, []))
                for a in ("files", "tables", "columns", "topics")
            ),
            duration * 1000,
        )

        return {
            "messages": messages,
            "stats": {
                "short_term_count": len(session.short_term),
                "total_messages": session.total_messages,
                "summary_length": len(session.running_summary),
                "context_messages_count": len(messages),
                "context_tokens_estimate": sum(estimate_tokens(m["content"]) for m in messages),
                "duration_ms": round(duration * 1000, 1),
            },
        }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any],
    ) -> str:
        session: SessionMemory = prep_result["session"]
        store: MemoryStore = prep_result["store"]

        shared["memory_messages"] = exec_result["messages"]
        shared["memory_context"] = {
            "running_summary": session.running_summary,
            "entities": session.entities.to_text(),
            "stats": exec_result["stats"],
        }
        shared["memory_session"] = session
        shared["memory_store"] = store

        store.save(session.session_id)

        self.log_exit("default")
        return "default"

    # ── Summarization ───────────────────────────────────────────────────────

    def _summarize_overflow(
        self,
        session: SessionMemory,
        overflow: List,
        model: str,
    ) -> None:
        """Progressively summarize messages that rolled out of short-term."""
        overflow_text = "\n".join(
            f"[{m.role.upper()}]: {m.content}" for m in overflow
        )
        overflow_tokens = sum(m.token_estimate for m in overflow)

        if overflow_tokens < 50:
            session.summary_message_count += len(overflow)
            return

        prompt = self._build_summary_prompt(session.running_summary, overflow_text)

        try:
            sync_client, _ = get_llm()
            response = sync_client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=_SUMMARY_PROMPT_BUDGET,
            )
            new_summary = response.choices[0].message.content.strip()
            session.running_summary = new_summary
            session.summary_message_count += len(overflow)
            self.logger.info(
                "Summarized %d overflow messages (%d tokens) → %d char summary",
                len(overflow),
                overflow_tokens,
                len(new_summary),
            )
        except Exception as e:
            self.logger.warning("Summarization failed, keeping old summary: %s", e)
            session.summary_message_count += len(overflow)

    @staticmethod
    def _build_summary_prompt(existing_summary: str, new_messages: str) -> str:
        from prompt_loader import load_template
        base = load_template("memory", "conversation_summary")
        parts = [base]
        if existing_summary:
            parts.extend(["", "EXISTING SUMMARY:", existing_summary])
        parts.extend(["", "NEW MESSAGES TO INTEGRATE:", new_messages, "", "UPDATED SUMMARY:"])
        return "\n".join(parts)

    # ── Entity extraction ───────────────────────────────────────────────────

    def _extract_entities(
        self,
        session: SessionMemory,
        recent_messages: List,
        model: str,
    ) -> None:
        """Extract key entities from recent messages and merge into session."""
        text = "\n".join(f"[{m.role.upper()}]: {m.content}" for m in recent_messages)
        if estimate_tokens(text) < 10:
            return

        from prompt_loader import load_template
        entity_base = load_template("memory", "entity_extraction")
        prompt = f"{entity_base}\n\nCONVERSATION:\n{text}\n\nYAML:"

        try:
            sync_client, _ = get_llm()
            response = sync_client.chat.completions.create(
                model=model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=300,
            )
            raw = response.choices[0].message.content.strip()
            if "```" in raw:
                raw = raw.split("```yaml")[-1].split("```")[0].strip()
                if not raw:
                    raw = response.choices[0].message.content.strip()
                    raw = raw.split("```")[-2].strip() if "```" in raw else raw
            parsed = yaml.safe_load(raw)
            if isinstance(parsed, dict):
                new_entities = EntityMap(
                    files=parsed.get("files", []) or [],
                    tables=parsed.get("tables", []) or [],
                    columns=parsed.get("columns", []) or [],
                    topics=parsed.get("topics", []) or [],
                )
                session.entities.merge(new_entities)
        except Exception as e:
            self.logger.debug("Entity extraction failed (non-critical): %s", e)


# ── Session maintenance helper (used by agent_flow's AgentResponseNode) ─────

def maintain_session(
    session: SessionMemory,
    *,
    max_short_term: int = _DEFAULT_SHORT_TERM_SIZE,
    auto_summarize: bool = True,
    auto_entities: bool = True,
    model: Optional[str] = None,
) -> None:
    """Drain overflow → summarize, then refresh entities from recent turns.

    Mutates ``session`` in place. Safe to call after every assistant turn:
    summarization only fires once short_term exceeds ``max_short_term``,
    and entity extraction always runs on the last 2 messages (cheap LLM call).
    Failures are logged and swallowed so the agent flow never breaks on
    memory maintenance.
    """
    node = ConversationMemoryNode(
        max_short_term=max_short_term,
        auto_summarize=auto_summarize,
        auto_entities=auto_entities,
    )
    resolved_model = model or get_settings().llm.model

    overflow = session.get_overflow(max_short_term)
    if overflow and auto_summarize:
        node._summarize_overflow(session, overflow, resolved_model)
    elif overflow:
        session.summary_message_count += len(overflow)

    if auto_entities and session.short_term:
        node._extract_entities(session, session.short_term[-2:], resolved_model)


# ── Convenience function ────────────────────────────────────────────────────

def build_memory_context(
    session_id: str,
    user_query: str,
    *,
    system_prompt: str = "",
    prev_response: str = "",
    store: Optional[MemoryStore] = None,
    max_short_term: int = _DEFAULT_SHORT_TERM_SIZE,
    token_budget: int = _DEFAULT_TOKEN_BUDGET,
    model: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Standalone helper: run the memory node logic and return results.

    Returns dict with keys: messages, context, session.
    """
    node = ConversationMemoryNode(
        max_short_term=max_short_term,
        token_budget=token_budget,
    )
    shared: Dict[str, Any] = {
        "session_id": session_id,
        "user_query": user_query,
        "memory_system_prompt": system_prompt,
    }
    if prev_response:
        shared["llm_response"] = prev_response
    if store:
        shared["memory_store"] = store
    if model:
        shared["memory_model"] = model

    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    return {
        "messages": shared["memory_messages"],
        "context": shared["memory_context"],
        "session": shared["memory_session"],
    }
