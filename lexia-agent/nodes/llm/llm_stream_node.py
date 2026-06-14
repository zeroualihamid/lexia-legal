"""
LLMStreamNode — Stream an LLM response for a given query.

Uses get_llm() from llm.llm_factory to obtain the configured LLM client,
then streams the completion. Supports an optional stream_callback for
real-time chunk delivery (e.g. for SSE or WebSocket).

Inputs (via shared state):
- ``query`` or ``user_query`` (str): The prompt to send to the LLM.
- ``llm_system_prompt`` (optional, str): System message.
- ``llm_stream_callback`` (optional, callable): Called with each text chunk as it arrives.
- ``llm_model`` (optional, str): Override model. Default: get_settings().llm.model.

Outputs (via shared state):
- ``llm_response`` (str): Full accumulated response text.
- ``llm_streamed`` (bool): True if streaming was used.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Optional

from nodes.base_node import BaseNode
from monitoring.logger import get_logger
from llm.llm_factory import get_llm
from config import get_settings

logger = get_logger(__name__)


class LLMStreamNode(BaseNode):
    """Stream an LLM response for a query using the configured provider."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "LLMStream")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        query = shared.get("query") or shared.get("user_query")
        if not query:
            raise ValueError(
                "LLMStreamNode requires 'query' or 'user_query' in shared state"
            )

        memory_messages = shared.get("memory_messages")

        return {
            "query": query,
            "memory_messages": memory_messages,
            "system_prompt": shared.get("llm_system_prompt"),
            "stream_callback": shared.get("llm_stream_callback"),
            "model": shared.get("llm_model") or get_settings().llm.model,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        query: str = prep_result["query"]
        memory_messages: Optional[list] = prep_result.get("memory_messages")
        system_prompt: Optional[str] = prep_result["system_prompt"]
        stream_callback: Optional[Callable[[str], None]] = prep_result["stream_callback"]
        model: str = prep_result["model"]

        sync_client, _ = get_llm()

        if memory_messages:
            messages = list(memory_messages)
            self.logger.info("Using %d memory-managed messages", len(messages))
        else:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": query})

        self.logger.info("Streaming LLM response (model=%s)", model)

        response = sync_client.chat.completions.create(
            model=model,
            messages=messages,
            stream=True,
        )

        full_content = ""
        for chunk in response:
            if chunk.choices and chunk.choices[0].delta.content:
                text = chunk.choices[0].delta.content
                full_content += text
                if callable(stream_callback):
                    try:
                        stream_callback(text)
                    except Exception as e:
                        self.logger.warning("Stream callback error: %s", e)

        self.logger.info("LLM stream complete (%d chars)", len(full_content))
        return {
            "response": full_content,
            "streamed": True,
        }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Dict[str, Any],
        exec_result: Dict[str, Any],
    ) -> str:
        shared["llm_response"] = exec_result["response"]
        shared["llm_streamed"] = exec_result["streamed"]
        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    node = LLMStreamNode()
    chunks = []

    def on_chunk(text: str) -> None:
        chunks.append(text)
        print(text, end="", flush=True)

    shared = {
        "query": "What is 2 + 2? Reply in one short sentence.",
        "llm_stream_callback": on_chunk,
    }
    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    print("\n\n--- Full response ---")
    print(shared["llm_response"])
