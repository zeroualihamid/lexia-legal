"""EvaluateConditionsNode — turn condition SQL results into ``render_flags``.

Conditions are stored by :class:`ReportSqlBatchNode` in
``shared['_condition_results']`` as ``dict[flag_name -> bool]``.  The
batch node already routes each condition block to its flag name (the
``IF:<flag>`` marker the block contains), so this node's job is now
mostly:

1. Merge ``_condition_results`` with any pre-supplied
   ``default_flags`` and pre-existing ``render_flags`` (e.g. from the
   edit-agent's preview).
2. Surface the IF flags that the template references but no block
   produced — useful for the API so it can prompt the user / draft a
   missing block.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode


class EvaluateConditionsNode(BaseNode):
    """Map condition SQL results onto ``render_flags`` for the renderer."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "EvaluateConditions")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "results":         shared.get("_condition_results") or {},
            "definitions":     shared.get("report_definitions") or {},
            "scan":            shared.get("template_scan"),
            "default_flags":   shared.get("default_flags") or {},
            "existing_flags":  shared.get("render_flags") or {},
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        results: Dict[str, Any]            = prep_result["results"]
        scan                               = prep_result["scan"]
        default_flags: Dict[str, bool]     = prep_result["default_flags"]
        existing: Dict[str, bool]          = prep_result["existing_flags"]

        # ``_condition_results`` is already keyed by flag name (the
        # ``ReportSqlBatchNode`` resolves ``inner_conditions[0]`` for each
        # ``kind=condition`` block before storing the result), so we just
        # merge defaults → existing → SQL results in priority order.
        flags: Dict[str, bool] = dict(default_flags)
        flags.update(existing)
        for key, value in results.items():
            flags[key] = bool(value)

        # Identify IF flags from the template that no block produced.
        unmatched: List[str] = []
        if scan is not None:
            scanned_flags = {c.name for c in scan.conditions}
            for f in scanned_flags:
                if f not in flags:
                    unmatched.append(f)

        return {"flags": flags, "unmatched": unmatched}

    def post(
        self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any],
    ) -> str:
        shared["render_flags"]            = exec_result["flags"]
        shared["render_flags_unmatched"]  = exec_result["unmatched"]
        if exec_result["unmatched"]:
            self.logger.warning(
                "Unmatched IF flags (no condition + no default): %s",
                exec_result["unmatched"],
            )
        self.log_exit("default")
        return "default"
