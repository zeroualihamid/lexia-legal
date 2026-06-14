"""LangChain :class:`BaseChatModel` adapter over the project's own ``llm/`` clients.

This keeps a single LLM code path: tool-call routing, retries, streaming,
and provider fallback all stay in ``llm/llm_factory.create_client_for_task``.
The adapter only translates between LangChain's message / tool schema and
``llm.base_llm.LLMResponse``.

Supports:
  - chat (_generate)
  - tool calling (bind_tools → AIMessage.tool_calls)
  - streaming (_stream) — falls back to single-chunk emit if the underlying
    BaseLLM has no streaming tool-call API (true for most providers when
    tools are bound).
"""

from __future__ import annotations

import json
import uuid
from typing import Any, Dict, Iterator, List, Optional, Sequence, Type, Union

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import (
    AIMessage,
    AIMessageChunk,
    BaseMessage,
    HumanMessage,
    SystemMessage,
    ToolMessage,
)
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from langchain_core.tools import BaseTool
from langchain_core.utils.function_calling import convert_to_openai_tool
from pydantic import Field, PrivateAttr

from llm.base_llm import BaseLLM, ToolCall, ToolDefinition
from llm.llm_factory import create_client_for_task
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ── Message conversion ──────────────────────────────────────────────────────


def _lc_to_provider_messages(messages: Sequence[BaseMessage]) -> List[Dict[str, Any]]:
    """Convert LangChain messages → provider-format dicts that ``llm/`` clients accept.

    System messages are stripped here — they are passed as the ``system`` arg
    of ``generate_with_tools`` (matches the existing convention).
    """
    out: List[Dict[str, Any]] = []
    for m in messages:
        if isinstance(m, SystemMessage):
            # Handled separately by caller; skip.
            continue
        if isinstance(m, HumanMessage):
            out.append({"role": "user", "content": _msg_text(m)})
            continue
        if isinstance(m, AIMessage):
            tcalls = []
            for tc in m.tool_calls or []:
                tcalls.append({
                    "id": tc.get("id") or _new_tool_id(),
                    "type": "function",
                    "function": {
                        "name": tc["name"],
                        "arguments": json.dumps(tc.get("args") or {}),
                    },
                })
            entry: Dict[str, Any] = {
                "role": "assistant",
                "content": _msg_text(m) or None,
            }
            if tcalls:
                entry["tool_calls"] = tcalls
            out.append(entry)
            continue
        if isinstance(m, ToolMessage):
            out.append({
                "role": "tool",
                "tool_call_id": m.tool_call_id,
                "content": _msg_text(m),
            })
            continue
        # Fallback for any other typed message
        out.append({"role": "user", "content": _msg_text(m)})
    return out


def _extract_system(messages: Sequence[BaseMessage]) -> Optional[str]:
    sys_parts = [_msg_text(m) for m in messages if isinstance(m, SystemMessage)]
    sys_parts = [s for s in sys_parts if s]
    if not sys_parts:
        return None
    return "\n\n".join(sys_parts)


def _msg_text(m: BaseMessage) -> str:
    c = m.content
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        # LangChain content blocks: pick text parts.
        parts: List[str] = []
        for block in c:
            if isinstance(block, dict):
                if block.get("type") == "text":
                    parts.append(str(block.get("text", "")))
                elif "text" in block:
                    parts.append(str(block["text"]))
            else:
                parts.append(str(block))
        return "\n".join(parts)
    return str(c)


def _new_tool_id() -> str:
    return f"call_{uuid.uuid4().hex[:24]}"


# ── Tool conversion ─────────────────────────────────────────────────────────


def _tools_to_tool_definitions(
    tools: Sequence[Union[BaseTool, Dict[str, Any], Type]],
) -> List[ToolDefinition]:
    """Turn LangChain tool specs into ``llm.base_llm.ToolDefinition``."""
    out: List[ToolDefinition] = []
    for t in tools:
        spec = convert_to_openai_tool(t)
        fn = spec.get("function", {})
        out.append(ToolDefinition(
            name=fn.get("name", ""),
            description=fn.get("description", "") or "",
            input_schema=fn.get("parameters") or {"type": "object", "properties": {}},
        ))
    return out


def _provider_tool_call_to_lc(tc: ToolCall) -> Dict[str, Any]:
    """Provider ToolCall → LangChain AIMessage.tool_calls entry."""
    args = tc.arguments if isinstance(tc.arguments, dict) else {}
    return {
        "name": tc.name,
        "args": args,
        "id": tc.id or _new_tool_id(),
        "type": "tool_call",
    }


# ── BaseChatModel adapter ───────────────────────────────────────────────────


class BrikzLLM(BaseChatModel):
    """LangChain :class:`BaseChatModel` backed by ``llm.base_llm.BaseLLM``.

    Prefer constructing via :meth:`from_task` so the task-routing in
    ``config.yaml`` decides which provider/model to use.
    """

    client: BaseLLM = Field(...)
    task: str = Field(default="agent")
    _bound_tools: List[ToolDefinition] = PrivateAttr(default_factory=list)

    model_config = {"arbitrary_types_allowed": True}

    # ── Constructors ────────────────────────────────────────────────────

    @classmethod
    def from_task(cls, task: str = "agent", **kwargs) -> "BrikzLLM":
        """Build via the project's ``create_client_for_task`` factory."""
        client = create_client_for_task(task, **kwargs)
        return cls(client=client, task=task)

    # ── LangChain plumbing ──────────────────────────────────────────────

    @property
    def _llm_type(self) -> str:
        return f"brikz-{self.client.config.provider}"

    @property
    def _identifying_params(self) -> Dict[str, Any]:
        return {
            "provider": self.client.config.provider,
            "model": self.client.config.model,
            "task": self.task,
        }

    def bind_tools(
        self,
        tools: Sequence[Union[BaseTool, Dict[str, Any], Type]],
        **kwargs: Any,
    ) -> "BrikzLLM":
        """Return a copy with provider-format tool definitions attached.

        ``create_tool_calling_agent`` calls this; the returned instance is
        used for every step of the AgentExecutor loop.
        """
        new = self.__class__(client=self.client, task=self.task)
        new._bound_tools = _tools_to_tool_definitions(tools)
        return new

    # ── Generation ──────────────────────────────────────────────────────

    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> ChatResult:
        provider_messages = _lc_to_provider_messages(messages)
        system = _extract_system(messages)

        try:
            response = self.client.generate_with_tools(
                messages=provider_messages,
                tools=self._bound_tools,
                system=system,
            )
        except NotImplementedError:
            # Provider has no tool-call API; fall back to plain text generation.
            logger.warning("LLM client lacks generate_with_tools; using plain generate()")
            last_user = next(
                (m for m in reversed(provider_messages) if m.get("role") == "user"),
                {"content": ""},
            )
            response = self.client.generate(
                prompt=last_user.get("content", ""),
                system=system,
            )

        lc_tool_calls = [_provider_tool_call_to_lc(tc) for tc in response.tool_calls]
        ai = AIMessage(
            content=response.content or "",
            tool_calls=lc_tool_calls,
            response_metadata={
                "model": response.model,
                "stop_reason": response.stop_reason,
                "usage": response.usage or {},
            },
        )
        return ChatResult(generations=[ChatGeneration(message=ai)])

    def _stream(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        """Best-effort streaming.

        Most provider clients in ``llm/`` don't stream tool-calling natively,
        so when tools are bound we emit a single chunk built from
        ``_generate``. When tools are NOT bound, we use ``generate_stream``
        if available.
        """
        if self._bound_tools:
            result = self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            msg = result.generations[0].message
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content=msg.content,
                    tool_calls=getattr(msg, "tool_calls", []) or [],
                    response_metadata=getattr(msg, "response_metadata", {}) or {},
                )
            )
            return

        system = _extract_system(messages)
        last_user = next(
            (m for m in reversed(messages) if isinstance(m, HumanMessage)),
            None,
        )
        prompt = _msg_text(last_user) if last_user else ""

        try:
            stream = self.client.generate_stream(prompt=prompt, system=system)
            for chunk in stream:
                text = chunk if isinstance(chunk, str) else getattr(chunk, "content", str(chunk))
                if not text:
                    continue
                if run_manager is not None:
                    run_manager.on_llm_new_token(text)
                yield ChatGenerationChunk(message=AIMessageChunk(content=text))
        except Exception as exc:
            logger.warning("generate_stream failed (%s); falling back to non-streaming", exc)
            result = self._generate(messages, stop=stop, run_manager=run_manager, **kwargs)
            msg = result.generations[0].message
            yield ChatGenerationChunk(message=AIMessageChunk(content=msg.content))
