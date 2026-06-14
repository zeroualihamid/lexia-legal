"""
AgentRouterNode — LLM decides next action via native tool calling.

This is the "think" step of the think → act → observe loop.
The LLM receives conversation history + tool definitions and either:
  - Returns tool_calls → action="dispatch"
  - Returns text (no tool calls) → action="respond"

Reasoning enhancements:
  - Soft nudge at (max_iterations - 2) to start synthesizing
  - Hard stop at max_iterations with a final synthesis LLM call
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from llm.base_llm import ToolDefinition
from utils.call_llm_with_tools import call_llm_with_tools
from monitoring.logger import get_logger

logger = get_logger(__name__)

_MAX_ITERATIONS = 10


class AgentRouterNode(BaseNode):
    """LLM-based action selection via native tool calling."""

    def __init__(self, name: Optional[str] = None, max_iterations: int = _MAX_ITERATIONS):
        super().__init__(name or "AgentRouter")
        self._max_iterations = max_iterations

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "query": shared.get("query", ""),
            "original_query": shared.get("original_query", ""),
            "messages": shared.get("agent_messages", []),
            "tool_definitions": shared.get("tool_definitions", []),
            "system_prompt": shared.get("agent_system_prompt", ""),
            "iteration": shared.get("agent_iteration", 0),
            "pending_tool_results": shared.get("pending_tool_results", []),
            "llm_client": shared.get("agent_llm_client"),
            "stream_callback": shared.get("stream_callback"),
            "force_respond": shared.get("force_respond", False),
        }

    def _force_synthesis(self, prep_res: Dict[str, Any], emit) -> Dict[str, Any]:
        """Final LLM call without tools to produce a comprehensive answer."""
        messages = list(prep_res["messages"])
        for tr in prep_res.get("pending_tool_results", []):
            messages.append({
                "role": "tool",
                "tool_call_id": tr.tool_use_id,
                "content": tr.content,
            })

        original = prep_res.get("original_query") or prep_res.get("query", "")
        messages.append({
            "role": "user",
            "content": (
                f"Original question: \"{original}\"\n\n"
                "Based on ALL the data gathered above, provide a COMPLETE, well-structured "
                "answer to this question. Include specific numbers, comparisons, and insights. "
                "Use markdown formatting (headers, tables, bullet points) for clarity. "
                "Respond in the same language as the original question.\n"
                "IMPORTANT: NEVER mention SQL, queries, column names, table names, or any "
                "technical details. In tables and text, never display bare internal codes "
                "(CODEPROD, CODECATE, CODEBRAN, CODEACTE, CODTYPIN, PRODRISQ, CODEINTE, …) as "
                "the dimension shown to the user — use designation columns (LIBEPROD, LIBECATE, "
                "LIBEBRAN, LIBEACTE, LIBTYPIN, PRODUIT_RISQUE, RAISOCIN, …) or explicit French "
                "business labels. Filtering on codes in tools is fine; the synthesized answer "
                "must use libellés only.\n"
                "Currency: MAD (Dirham marocain). Number format: spaces as thousand separators, "
                "comma as decimal, 2 decimal places (e.g. 1 234 567,89 MAD). Percentages: 12,34 %."
            ),
        })

        llm = prep_res.get("llm_client")
        if llm is not None:
            try:
                response = call_llm_with_tools(
                    messages=messages,
                    tools=[],
                    system=prep_res["system_prompt"],
                    llm_client=llm,
                    task="agent",
                )
                if response.content:
                    return {"action": "respond", "content": response.content}
            except Exception as exc:
                logger.error("Final synthesis LLM call failed: %s", exc)

        last_results = prep_res.get("pending_tool_results", [])
        summary_parts = [r.content for r in last_results if r.content and not r.is_error]
        fallback = "\n\n".join(summary_parts) if summary_parts else ""
        return {"action": "respond", "content": fallback, "force_respond": True}

    def exec(self, prep_res: Dict[str, Any]) -> Dict[str, Any]:
        iteration = prep_res["iteration"]
        emit = prep_res.get("stream_callback")

        # VerifyNode routes here when all tools failed near max iterations — must synthesize.
        if prep_res.get("force_respond"):
            if emit:
                emit("thinking", "Synthèse finale après échec des outils…")
            logger.warning("force_respond from VerifyNode — running final synthesis.")
            return self._force_synthesis(prep_res, emit)

        # Hard stop: force a final synthesis call
        if iteration >= self._max_iterations:
            logger.warning("Agent hit max iterations (%d), forcing synthesis.", self._max_iterations)
            if emit:
                emit("thinking", f"Max iterations ({self._max_iterations}), synthesizing final answer...")
            return self._force_synthesis(prep_res, emit)

        # Build messages for LLM
        messages = list(prep_res["messages"])

        for tr in prep_res.get("pending_tool_results", []):
            messages.append({
                "role": "tool",
                "tool_call_id": tr.tool_use_id,
                "content": tr.content,
            })

        query = prep_res["query"]
        if iteration == 0 and query:
            messages.append({"role": "user", "content": query})

        # Soft nudge: when approaching max iterations, encourage the agent to wrap up
        remaining = self._max_iterations - iteration
        if remaining <= 2 and iteration > 0:
            messages.append({
                "role": "user",
                "content": (
                    f"[SYSTEM NOTE: {remaining} iteration(s) remaining. "
                    "If you have enough data, stop calling tools and provide your final answer now. "
                    "If you still need critical data, make your last tool call(s).]"
                ),
            })

        tools: List[ToolDefinition] = prep_res["tool_definitions"]

        if emit:
            emit("thinking", f"Agent thinking (iteration {iteration + 1}/{self._max_iterations})...")

        response = call_llm_with_tools(
            messages=messages,
            tools=tools,
            system=prep_res["system_prompt"],
            llm_client=prep_res.get("llm_client"),
            task="agent",
        )

        if response.has_tool_calls:
            if emit:
                tool_names = ", ".join(tc.name for tc in response.tool_calls)
                emit("thinking", f"Agent calling: {tool_names}")
            return {
                "action": "dispatch",
                "tool_calls": response.tool_calls,
                "text": response.content,
                "messages": messages,
            }
        else:
            content = response.content or ""
            # If the text answer is too short and we have budget left, it might
            # be a premature stop. Force synthesis from tool results instead.
            if len(content) < 50 and iteration > 1 and remaining > 0:
                logger.info("Short response detected (%d chars), forcing synthesis.", len(content))
                return self._force_synthesis(prep_res, emit)
            if emit:
                emit("thinking", "Agent generating final response...")
            return {
                "action": "respond",
                "content": content,
                "messages": messages,
            }

    def post(self, shared: Dict[str, Any], prep_res: Dict[str, Any], exec_res: Dict[str, Any]) -> str:
        import json as _json

        action = exec_res.get("action", "respond")
        shared["agent_iteration"] = prep_res["iteration"] + 1

        if action == "dispatch":
            shared["current_tool_calls"] = exec_res["tool_calls"]
            shared["agent_messages"] = exec_res.get("messages", [])

            openai_tool_calls = []
            for tc in exec_res["tool_calls"]:
                openai_tool_calls.append({
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": _json.dumps(tc.arguments) if isinstance(tc.arguments, dict) else str(tc.arguments),
                    },
                })
            shared["agent_messages"].append({
                "role": "assistant",
                "content": exec_res.get("text") or None,
                "tool_calls": openai_tool_calls,
            })
            self.log_exit("dispatch")
            return "dispatch"
        else:
            shared["agent_response"] = exec_res.get("content", "")
            shared["agent_messages"] = exec_res.get("messages", [])
            shared.pop("force_respond", None)
            self.log_exit("respond")
            return "respond"
