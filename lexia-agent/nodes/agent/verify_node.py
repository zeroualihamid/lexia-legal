"""
VerifyNode — Check tool results and decide whether to continue or finish.

This is the "observe" step of the think → act → observe loop.
Routes back to the router ("think") or forward to the response node ("respond").
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


class VerifyNode(BaseNode):
    """Check tool results and decide next action."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "Verify")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "tool_results": shared.get("pending_tool_results", []),
            "iteration": shared.get("agent_iteration", 0),
            "max_iterations": shared.get("max_iterations", 8),
            "stream_callback": shared.get("stream_callback"),
        }

    def exec(self, prep_res: Dict[str, Any]) -> Dict[str, Any]:
        results = prep_res["tool_results"]
        iteration = prep_res["iteration"]
        max_iter = prep_res["max_iterations"]

        all_errors = all(r.is_error for r in results) if results else False
        has_any_result = any(not r.is_error for r in results)

        # If all tools errored and we're running out of iterations, stop
        if all_errors and iteration >= max_iter - 1:
            return {"action": "respond", "reason": "all tools failed at max iterations"}

        # Otherwise, always route back to the router to let the LLM decide
        return {"action": "think", "reason": "continue agent loop"}

    def post(self, shared: Dict[str, Any], prep_res: Dict[str, Any], exec_res: Dict[str, Any]) -> str:
        action = exec_res["action"]
        emit = prep_res.get("stream_callback")

        if emit:
            emit("iteration", f"Agent iteration {prep_res['iteration']}", {
                "iteration": prep_res["iteration"],
                "action": action,
                "reason": exec_res.get("reason", ""),
            })

        if action == "respond":
            # Force response — clear pending results and set flag
            shared["force_respond"] = True
            self.log_exit("respond")
            return "respond"

        self.log_exit("think")
        return "think"
