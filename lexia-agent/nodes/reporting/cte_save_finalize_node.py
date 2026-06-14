"""CteSaveFinalizeNode — merge one drafted block back into definitions.

This node takes the successful output of :class:`BlockDraftNode` and produces
the full ``report_definitions`` payload expected by validation + persistence.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from nodes.base_node import BaseNode


class CteSaveFinalizeNode(BaseNode):
    """Replace or append the drafted block inside ``report_definitions``."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "CteSaveFinalize")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        defs = shared.get("report_definitions")
        drafted = shared.get("drafted_block")
        report = shared.get("draft_report")
        if not isinstance(defs, dict):
            raise ValueError("CteSaveFinalizeNode requires 'report_definitions'")
        if not isinstance(drafted, dict) or not drafted.get("id"):
            raise ValueError("CteSaveFinalizeNode requires 'drafted_block'")
        return {
            "definitions": defs,
            "drafted_block": drafted,
            "draft_report": report,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        defs = dict(prep_result["definitions"])
        drafted = dict(prep_result["drafted_block"])
        blocks = list(defs.get("blocks") or [])
        action = "created"
        for index, block in enumerate(blocks):
            if isinstance(block, dict) and block.get("id") == drafted["id"]:
                blocks[index] = drafted
                action = "updated"
                break
        else:
            blocks.append(drafted)
        defs["blocks"] = blocks
        return {"definitions": defs, "action": action}

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        shared["report_definitions"] = exec_result["definitions"]
        shared["save_cte_action"] = exec_result["action"]
        self.log_exit("default")
        return "default"
