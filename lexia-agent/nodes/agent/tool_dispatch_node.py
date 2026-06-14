"""
ToolDispatchNode — Execute tool calls selected by the AgentRouter.

This is the "act" step of the think → act → observe loop.
Executes each tool call via the ToolRegistry, streams progress events,
and collects ToolResults for the verify step.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from llm.base_llm import ToolCall, ToolResult
from monitoring.logger import get_logger

logger = get_logger(__name__)


class ToolDispatchNode(BaseNode):
    """Execute tool calls from the agent router."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ToolDispatch")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "tool_calls": shared.get("current_tool_calls", []),
            "registry": shared.get("tool_registry"),
            "context": shared,
            "stream_callback": shared.get("stream_callback"),
        }

    def exec(self, prep_res: Dict[str, Any]) -> List[ToolResult]:
        tool_calls: List[ToolCall] = prep_res["tool_calls"]
        registry = prep_res["registry"]
        ctx = prep_res["context"]
        emit = prep_res.get("stream_callback")

        if registry is None:
            raise ValueError("tool_registry is required in shared state")

        results: List[ToolResult] = []
        for tc in tool_calls:
            if emit:
                emit("tool_start", f"Executing tool: {tc.name}", {"tool": tc.name, "args": tc.arguments})

            result = registry.execute(
                name=tc.name,
                arguments=tc.arguments,
                context=ctx,
                tool_use_id=tc.id,
            )

            # Truncate very large results to avoid context explosion
            if len(result.content) > 15_000:
                result.content = result.content[:15_000] + "\n... (truncated)"

            if emit:
                status = "error" if result.is_error else "success"
                preview = result.content[:200] + "..." if len(result.content) > 200 else result.content
                emit("tool_result", f"Tool {tc.name}: {status}", {
                    "tool": tc.name,
                    "status": status,
                    "preview": preview,
                })

            results.append(result)
            logger.info(
                "Tool %s executed: %s (%d chars)",
                tc.name,
                "error" if result.is_error else "ok",
                len(result.content),
            )

        return results

    def post(self, shared: Dict[str, Any], prep_res: Dict[str, Any], exec_res: List[ToolResult]) -> str:
        shared["pending_tool_results"] = exec_res
        shared.pop("current_tool_calls", None)
        self.log_exit("default")
        return "default"
