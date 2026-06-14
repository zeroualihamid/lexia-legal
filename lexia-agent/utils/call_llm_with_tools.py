"""
call_llm_with_tools — thin wrapper around BaseLLM.generate_with_tools().

Provides:
  - Automatic LLM client creation via ``create_client_for_task``
  - vLLM-specific path that uses the raw OpenAI SDK ``chat.completions``
    format with ``tool_choice`` for maximum compatibility
  - Structured logging of tool calls and token usage
  - A single import for any node that needs tool-calling
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Dict, List, Optional

from llm.base_llm import BaseLLM, LLMResponse, ToolCall, ToolDefinition

logger = logging.getLogger(__name__)


def _get_provider(llm_client: BaseLLM) -> str:
    return getattr(getattr(llm_client, "config", None), "provider", "") or ""


def _is_vllm_provider(llm_client: BaseLLM) -> bool:
    return _get_provider(llm_client) == "vllm"


def _is_anthropic_provider(llm_client: BaseLLM) -> bool:
    return _get_provider(llm_client) == "anthropic"


# ── Message format adapters ──────────────────────────────────────────────────

def _openai_messages_to_anthropic(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Convert OpenAI-format messages to Anthropic's expected format.

    Transformations:
      - ``role: "tool"``  →  merged into the preceding ``role: "user"`` message
        (or a new one) as ``{"type": "tool_result", ...}`` content blocks.
      - Assistant messages with a ``tool_calls`` list → ``role: "assistant"``
        with ``content: [{"type": "tool_use", ...}]`` blocks.
    """
    out: List[Dict[str, Any]] = []
    pending_tool_results: List[Dict[str, Any]] = []

    def _flush_tool_results():
        nonlocal pending_tool_results
        if not pending_tool_results:
            return
        block: List[Dict[str, Any]] = []
        for tr in pending_tool_results:
            block.append({
                "type": "tool_result",
                "tool_use_id": tr.get("tool_call_id", ""),
                "content": tr.get("content", ""),
            })
        if out and out[-1]["role"] == "user" and isinstance(out[-1].get("content"), list):
            out[-1]["content"].extend(block)
        else:
            out.append({"role": "user", "content": block})
        pending_tool_results = []

    for msg in messages:
        role = msg.get("role", "")

        if role == "tool":
            pending_tool_results.append(msg)
            continue

        _flush_tool_results()

        if role == "assistant" and msg.get("tool_calls"):
            content_blocks: List[Dict[str, Any]] = []
            text = msg.get("content")
            if text:
                content_blocks.append({"type": "text", "text": text})
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                raw_args = fn.get("arguments", "{}")
                try:
                    input_data = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                except (json.JSONDecodeError, TypeError):
                    input_data = {"raw": raw_args}
                content_blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "input": input_data,
                })
            out.append({"role": "assistant", "content": content_blocks})
            continue

        if role == "system":
            continue

        out.append(msg)

    _flush_tool_results()
    return out


# ── Schema sanitisation ─────────────────────────────────────────────────────

_ALLOWED_SCHEMA_KEYS = frozenset({
    "type", "properties", "required", "description", "items", "enum",
})


def clean_parameters_for_openai(parameters: dict) -> dict:
    """Strip non-standard fields from a JSON-Schema so the OpenAI/vLLM
    function-calling endpoint accepts it.

    Only keeps: type, properties, required, description, items, enum.
    Recurses into nested objects and array items.
    """
    if not isinstance(parameters, dict):
        return parameters

    cleaned: Dict[str, Any] = {"type": parameters.get("type", "object")}

    if "properties" in parameters:
        cleaned_properties: Dict[str, Any] = {}
        for prop_name, prop_def in parameters["properties"].items():
            if isinstance(prop_def, dict):
                cleaned_prop: Dict[str, Any] = {}
                if "type" in prop_def:
                    cleaned_prop["type"] = prop_def["type"]
                if "description" in prop_def:
                    cleaned_prop["description"] = prop_def["description"]
                if "items" in prop_def:
                    cleaned_prop["items"] = clean_parameters_for_openai(prop_def["items"])
                if "properties" in prop_def:
                    cleaned_prop["properties"] = {
                        k: clean_parameters_for_openai(v)
                        for k, v in prop_def["properties"].items()
                    }
                if "enum" in prop_def:
                    cleaned_prop["enum"] = prop_def["enum"]
                cleaned_properties[prop_name] = cleaned_prop
            else:
                cleaned_properties[prop_name] = prop_def
        cleaned["properties"] = cleaned_properties

    if "required" in parameters:
        cleaned["required"] = parameters["required"]
    if "description" in parameters:
        cleaned["description"] = parameters["description"]

    return cleaned


def format_tools_for_openai(
    tools: List[ToolDefinition],
) -> List[Dict[str, Any]]:
    """Convert ``ToolDefinition`` objects into the OpenAI function-calling
    wire format, cleaning each schema along the way.

    Returns a list of ``{"type": "function", "function": {…}}`` dicts.
    """
    formatted: List[Dict[str, Any]] = []
    for t in tools:
        if not t.name or not isinstance(t.name, str):
            logger.warning("Skipping tool with invalid name: %s", t.name)
            continue
        formatted.append({
            "type": "function",
            "function": {
                "name": str(t.name),
                "description": str(t.description or ""),
                "parameters": clean_parameters_for_openai(t.input_schema),
            },
        })
    logger.debug("Formatted %d tools for OpenAI", len(formatted))
    return formatted


# ── vLLM-specific call path ─────────────────────────────────────────────────

def _call_vllm_with_tools(
    llm_client: BaseLLM,
    messages: List[Dict[str, Any]],
    tools: List[ToolDefinition],
    system: Optional[str] = None,
    tool_choice: str = "auto",
    **kwargs,
) -> LLMResponse:
    """vLLM-specific tool-calling path using raw OpenAI SDK **streaming**.

    vLLM's non-streaming ``/v1/chat/completions`` has a known issue where
    ``tool_calls`` comes back as an empty list even when the model generates
    them.  Streaming works correctly, so we always stream and reassemble.
    """
    raw_client = getattr(llm_client, "client", None)
    if raw_client is None:
        raise ValueError("vLLM client has no underlying OpenAI SDK 'client' attribute")

    cfg = llm_client.config

    full_messages = list(messages)
    if system:
        full_messages.insert(0, {"role": "system", "content": system})

    tool_configs = format_tools_for_openai(tools)

    call_params: Dict[str, Any] = {
        "model": kwargs.get("model", cfg.model),
        "messages": full_messages,
        "stream": True,
    }

    if tool_configs:
        call_params["tools"] = tool_configs
        call_params["tool_choice"] = tool_choice

    stream = raw_client.chat.completions.create(**call_params)

    # Reassemble content and tool calls from streamed deltas
    content_parts: List[str] = []
    tc_accum: Dict[int, Dict[str, str]] = {}
    finish_reason: Optional[str] = None
    model_name: Optional[str] = None
    response_id: Optional[str] = None

    for chunk in stream:
        if model_name is None:
            model_name = getattr(chunk, "model", None)
        if response_id is None:
            response_id = getattr(chunk, "id", None)

        if not chunk.choices:
            continue
        choice = chunk.choices[0]
        delta = choice.delta

        if delta.content:
            content_parts.append(delta.content)

        if delta.tool_calls:
            for tc_delta in delta.tool_calls:
                idx = tc_delta.index
                if idx not in tc_accum:
                    tc_accum[idx] = {"id": "", "name": "", "arguments": ""}
                if tc_delta.id:
                    tc_accum[idx]["id"] = tc_delta.id
                if tc_delta.function:
                    if tc_delta.function.name:
                        tc_accum[idx]["name"] += tc_delta.function.name
                    if tc_delta.function.arguments:
                        tc_accum[idx]["arguments"] += tc_delta.function.arguments

        if choice.finish_reason:
            finish_reason = choice.finish_reason

    # Build ToolCall objects from accumulated stream data
    tool_calls: List[ToolCall] = []
    for idx in sorted(tc_accum):
        entry = tc_accum[idx]
        if not entry["name"]:
            continue
        try:
            args = json.loads(entry["arguments"])
        except (json.JSONDecodeError, TypeError):
            args = {"raw": entry["arguments"]}
        tool_calls.append(
            ToolCall(id=entry["id"], name=entry["name"], arguments=args)
        )

    full_content = "".join(content_parts)

    return LLMResponse(
        content=full_content,
        model=model_name or cfg.model,
        usage={"input_tokens": 0, "output_tokens": 0, "total_tokens": 0},
        metadata={"id": response_id or "", "finish_reason": finish_reason},
        tool_calls=tool_calls,
        stop_reason="tool_use" if tool_calls else "end_turn",
    )


def call_llm_with_tools(
    *,
    messages: List[Dict[str, Any]],
    tools: List[ToolDefinition],
    system: Optional[str] = None,
    llm_client: Optional[BaseLLM] = None,
    task: str = "agent",
    tool_choice: str = "auto",
    **kwargs,
) -> LLMResponse:
    """Call an LLM with tool definitions and return a structured response.

    Args:
        messages:    Conversation history (list of ``{"role": …, "content": …}``).
        tools:       Available tool definitions.
        system:      Optional system prompt.
        llm_client:  Pre-built ``BaseLLM`` instance.  When *None*, one is
                     created automatically via ``create_client_for_task(task)``.
        task:        Task key used to resolve the LLM provider/model from
                     ``config.yaml`` task_routing (only used when *llm_client*
                     is ``None``).
        tool_choice: Tool choice strategy — ``"auto"``, ``"none"``, or a
                     specific tool name.  Used by the vLLM path; other
                     providers rely on their client's default behavior.
        **kwargs:    Forwarded to ``generate_with_tools`` (e.g. ``temperature``,
                     ``max_tokens``).

    Returns:
        ``LLMResponse`` — inspect ``.has_tool_calls``, ``.tool_calls``,
        ``.content``, and ``.usage``.
    """
    if llm_client is None:
        from llm.llm_factory import create_client_for_task
        llm_client = create_client_for_task(task)

    tool_names = [t.name for t in tools]
    provider = getattr(getattr(llm_client, "config", None), "provider", "unknown")
    logger.debug(
        "call_llm_with_tools [%s]: %d messages, %d tools (%s), system=%s chars",
        provider,
        len(messages),
        len(tools),
        ", ".join(tool_names),
        len(system) if system else 0,
    )

    t0 = time.perf_counter()

    if _is_vllm_provider(llm_client):
        logger.debug("Using vLLM raw SDK path (tool_choice=%s)", tool_choice)
        response = _call_vllm_with_tools(
            llm_client,
            messages=messages,
            tools=tools,
            system=system,
            tool_choice=tool_choice,
            **kwargs,
        )
    elif _is_anthropic_provider(llm_client):
        adapted = _openai_messages_to_anthropic(messages)
        logger.debug("Anthropic path: adapted %d → %d messages", len(messages), len(adapted))
        response = llm_client.generate_with_tools(
            messages=adapted,
            tools=tools,
            system=system,
            **kwargs,
        )
    else:
        response = llm_client.generate_with_tools(
            messages=messages,
            tools=tools,
            system=system,
            **kwargs,
        )

    elapsed_ms = (time.perf_counter() - t0) * 1000

    usage = response.usage or {}
    total_tokens = usage.get("total_tokens", 0)

    cache_read = usage.get("cache_read_input_tokens", 0)
    cache_created = usage.get("cache_creation_input_tokens", 0)
    cache_suffix = ""
    if cache_read or cache_created:
        cache_suffix = f", cache_read={cache_read}, cache_write={cache_created}"

    if response.has_tool_calls:
        called = ", ".join(tc.name for tc in response.tool_calls)
        logger.info(
            "LLM tool call [%s]: [%s] (%d tokens, %.0fms%s)",
            provider,
            called,
            total_tokens,
            elapsed_ms,
            cache_suffix,
        )
    else:
        snippet = (response.content or "")[:120].replace("\n", " ")
        logger.info(
            "LLM text response [%s]: \"%s%s\" (%d tokens, %.0fms%s)",
            provider,
            snippet,
            "…" if len(response.content or "") > 120 else "",
            total_tokens,
            elapsed_ms,
            cache_suffix,
        )

    return response


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s  %(message)s")

    from llm.llm_factory import create_client_for_task

    client = create_client_for_task("agent")
    print(f"Provider: {client.config.provider}, Model: {client.config.model}")

    tools = [
        ToolDefinition(
            name="greet",
            description="Say hello to someone by name",
            input_schema={
                "type": "object",
                "properties": {
                    "name": {
                        "type": "string",
                        "description": "The person's name to greet",
                    }
                },
                "required": ["name"],
            },
        )
    ]

    resp = call_llm_with_tools(
        messages=[{"role": "user", "content": "Say hello to Alice using the greet tool."}],
        tools=tools,
        system="You are a helpful assistant. Use tools when appropriate.",
        llm_client=client,
    )
    print(f"has_tool_calls={resp.has_tool_calls}")
    print(f"content={resp.content!r}")
    print(f"stop_reason={resp.stop_reason!r}")
    if resp.tool_calls:
        for tc in resp.tool_calls:
            print(f"  tool: {tc.name}({tc.arguments})")
    else:
        print("  (no tool calls)")
