"""CteSavePrepareNode — prepare shared state for one prompt-driven CTE save.

This node resolves the template files, loads or seeds ``definitions.yaml``,
finds the existing block payload (if any), and forwards the user prompt as
``block_goal`` for :class:`BlockDraftNode`.

Inputs (shared)
* ``template_id``          — required template folder id.
* ``block_id``             — required ``data-block`` id.
* ``cte_prompt``           — required user prompt describing the desired CTE.
* ``templates_root``       — optional override.
* ``template_scan``        — optional :class:`ScanResult` already loaded.

Outputs (shared)
* ``report_definitions``   — parsed definitions dict (seeded when missing).
* ``existing_block``       — existing block definition or ``None``.
* ``block_goal``           — stripped user prompt.
* ``force_redraft``        — ``True`` so the prompt always regenerates the block.
* ``template_scan_obj``    — raw scan object mirrored for ``BlockDraftNode``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, Optional

import yaml

from nodes.base_node import BaseNode


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"


class CteSavePrepareNode(BaseNode):
    """Load template state and forward the prompt into the draft pipeline."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "CteSavePrepare")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        template_id = str(shared.get("template_id") or "").strip()
        block_id = str(shared.get("block_id") or "").strip()
        prompt = str(shared.get("cte_prompt") or "").strip()
        if not template_id:
            raise ValueError("CteSavePrepareNode requires 'template_id'")
        if not block_id:
            raise ValueError("CteSavePrepareNode requires 'block_id'")
        if not prompt:
            raise ValueError("CteSavePrepareNode requires 'cte_prompt'")

        templates_root_raw = shared.get("templates_root")
        templates_root = Path(templates_root_raw) if templates_root_raw else _DEFAULT_TEMPLATES_ROOT
        template_dir = templates_root / template_id
        template_path = template_dir / "report-template.html"
        definitions_path = template_dir / "definitions.yaml"
        if not template_path.is_file():
            raise FileNotFoundError(f"Template not found: {template_path}")

        scan = shared.get("template_scan")
        if scan is None:
            scan = shared.get("template_scan_obj")
        if scan is None:
            raise ValueError("CteSavePrepareNode requires 'template_scan' or 'template_scan_obj'")

        if definitions_path.is_file():
            defs = yaml.safe_load(definitions_path.read_text(encoding="utf-8")) or {}
            if not isinstance(defs, dict):
                defs = {}
        else:
            defs = {
                "template_id": template_id,
                "version": 0,
                "parameters": [],
                "sources": [],
                "blocks": [],
                "metadata": {"seeded_by": "save-cte-flow"},
            }

        blocks = defs.get("blocks")
        if not isinstance(blocks, list):
            blocks = []
            defs["blocks"] = blocks

        existing_block = next(
            (
                block for block in blocks
                if isinstance(block, dict) and block.get("id") == block_id
            ),
            None,
        )
        return {
            "template_id": template_id,
            "block_id": block_id,
            "prompt": prompt,
            "definitions": defs,
            "existing_block": existing_block,
            "template_scan": scan,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        return prep_result

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any]) -> str:
        shared["report_definitions"] = exec_result["definitions"]
        shared["existing_block"] = exec_result["existing_block"]
        shared["block_goal"] = exec_result["prompt"]
        shared["force_redraft"] = True
        shared["template_scan_obj"] = exec_result["template_scan"]
        self.log_exit("default")
        return "default"
