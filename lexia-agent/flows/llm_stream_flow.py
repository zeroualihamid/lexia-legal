"""
LLM Stream Flow — Stream an LLM response with conversation memory.

Pipeline:
    ConversationMemoryNode → LLMStreamNode → FlowEnd

The memory node loads/creates the session, builds the context-managed
messages array (short-term window + running summary + entities), then
the stream node sends that array to the LLM and streams the response.

Shared-state contract:
──────────────────────────────────────────────
  Required:
    query or user_query  (str)  – prompt to send to the LLM

  Optional:
    session_id           (str)  – session for memory (auto-generated if missing)
    llm_system_prompt    (str)  – base system message
    llm_stream_callback  (callable) – called with each text chunk
    llm_model            (str)  – override model
    memory_store         (MemoryStore) – shared store instance

Outputs:
    llm_response         – full accumulated response text
    llm_streamed         – True
    memory_messages      – messages array sent to the LLM
    memory_context       – { running_summary, entities, stats }
    memory_session       – SessionMemory object
"""

from __future__ import annotations

import uuid
from typing import Any, Callable, Dict, Optional

from pocketflow import Flow, Node as PFNode

from nodes.memory.conversation_memory_node import ConversationMemoryNode
from nodes.memory.memory_store import MemoryStore
from nodes.llm.llm_stream_node import LLMStreamNode

from monitoring.logger import get_logger

logger = get_logger(__name__)


class _SaveResponseNode(PFNode):
    """Record the assistant reply back into session memory and persist."""

    def post(self, shared, prep_res, exec_res):
        session = shared.get("memory_session")
        if not session:
            return "default"

        llm_response = shared.get("llm_response", "")
        if llm_response and (
            not session.short_term
            or session.short_term[-1].content != llm_response
        ):
            session.add_message("assistant", llm_response)

        store: Optional[MemoryStore] = shared.get("memory_store")
        if store:
            store.save(session.session_id)

        return "default"


def create_llm_stream_flow(
    max_short_term: int = 20,
    token_budget: int = 3000,
    persist_dir: Optional[str] = None,
) -> Flow:
    """Assemble the LLM stream pipeline with conversation memory.

    Pipeline:  Memory → LLMStream → SaveResponse

    Args:
        max_short_term: Max messages in the short-term memory window.
        token_budget: Token budget for the context messages array.
        persist_dir: Directory for memory persistence (None = in-memory).

    Returns:
        Flow: ConversationMemoryNode >> LLMStreamNode >> _SaveResponseNode
    """
    memory = ConversationMemoryNode(
        max_short_term=max_short_term,
        token_budget=token_budget,
        persist_dir=persist_dir,
    )
    llm_stream = LLMStreamNode()
    save_response = _SaveResponseNode()

    memory >> llm_stream >> save_response

    return Flow(start=memory)


def run_llm_stream(
    query: str,
    *,
    session_id: Optional[str] = None,
    system_prompt: Optional[str] = None,
    stream_callback: Optional[Callable[[str], None]] = None,
    model: Optional[str] = None,
    persist_dir: Optional[str] = None,
) -> Dict[str, Any]:
    """Run the LLM stream flow with conversation memory.

    Args:
        query: Prompt to send to the LLM.
        session_id: Session identifier for memory continuity.
                    Auto-generated if not provided.
        system_prompt: Optional base system message.
        stream_callback: Optional callback for each text chunk.
        model: Optional model override.
        persist_dir: Directory for memory persistence.

    Returns:
        Shared state dict with llm_response, memory_messages, etc.
    """
    flow = create_llm_stream_flow(persist_dir=persist_dir)

    shared: Dict[str, Any] = {
        "session_id": session_id or f"stream-{uuid.uuid4().hex[:12]}",
        "query": query,
        "user_query": query,
    }
    if system_prompt:
        shared["llm_system_prompt"] = system_prompt
        shared["memory_system_prompt"] = system_prompt
    if stream_callback:
        shared["llm_stream_callback"] = stream_callback
    if model:
        shared["llm_model"] = model

    logger.info("Starting LLM stream flow (session=%s)", shared["session_id"])
    flow.run(shared)
    logger.info("LLM stream flow complete")
    return shared


if __name__ == "__main__":
    def on_chunk(text: str) -> None:
        print(text, end="", flush=True)

    result = run_llm_stream(
        query="hello",
        session_id="test-session",
        stream_callback=on_chunk,
    )
    print("\n\n--- Full response ---")
    print(result["llm_response"])
    print("\n--- Memory context ---")
    print(result.get("memory_context", {}))
