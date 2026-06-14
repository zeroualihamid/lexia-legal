"""LoadDefinitionsNode — read ``definitions.yaml`` from disk for a render.

The render pipeline needs the parsed definitions in shared state so the
downstream nodes (validation gate, SQL batch, narrative generation,
template render) can dispatch on ``kind``.  This node:

1. Resolves the on-disk path under ``data/reporting/templates/<id>/``.
2. Parses the YAML — failing fast with a clear error when malformed.
3. Filters out blocks marked ``deprecated`` (kept on disk for history).
4. Pre-orders blocks by ``depends_on`` (when present) so an upstream
   batch executor can iterate without re-sorting.

Inputs (shared state)
─────────────────────
* ``template_id``        — required.
* ``templates_root``     — optional override.

Outputs
───────
* ``report_definitions`` — fully parsed dict.
* ``validated_blocks``   — blocks that are NOT deprecated, in dependency
                           order.  This is the same shape the SQL batch
                           expects, allowing render flows to skip a
                           dedicated validate step when the on-disk YAML
                           is already trusted.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from nodes.base_node import BaseNode


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"


def _toposort_blocks(blocks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Return ``blocks`` ordered so every dependency precedes its dependents.

    Cycles are broken by appending the offending node — the SQL executor
    will surface the error at runtime.  ``depends_on`` references that
    don't exist in the block list are silently ignored (the renderer
    handles missing values via the ``missing[]`` channel).
    """
    by_id: Dict[str, Dict[str, Any]] = {b["id"]: b for b in blocks if b.get("id")}
    visited: Dict[str, bool] = {}
    result: List[Dict[str, Any]] = []

    def visit(bid: str, stack: set) -> None:
        if visited.get(bid):
            return
        if bid in stack:
            logger.warning("dependency cycle involving %r — breaking", bid)
            return
        node = by_id.get(bid)
        if node is None:
            return
        stack.add(bid)
        for dep in node.get("depends_on") or []:
            visit(dep, stack)
        stack.discard(bid)
        visited[bid] = True
        result.append(node)

    for b in blocks:
        visit(b.get("id") or "", set())
    return result


class LoadDefinitionsNode(BaseNode):
    """Read ``definitions.yaml`` from disk and prepare it for the renderer."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "LoadDefinitions")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        template_id = shared.get("template_id")
        if not template_id:
            raise ValueError("LoadDefinitionsNode requires 'template_id' in shared state")
        troot_raw = shared.get("templates_root")
        troot = Path(troot_raw) if troot_raw else _DEFAULT_TEMPLATES_ROOT
        return {
            "template_id":     template_id,
            "templates_root":  troot,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        template_id: str   = prep_result["template_id"]
        troot:       Path  = prep_result["templates_root"]
        defs_path = troot / template_id / "definitions.yaml"
        if not defs_path.is_file():
            raise FileNotFoundError(
                f"definitions.yaml not found for template {template_id!r}: {defs_path}"
            )
        try:
            data = yaml.safe_load(defs_path.read_text(encoding="utf-8")) or {}
        except yaml.YAMLError as e:
            raise ValueError(
                f"could not parse {defs_path}: {type(e).__name__}: {e}"
            ) from e
        if not isinstance(data, dict):
            raise ValueError(
                f"{defs_path}: top-level YAML must be a mapping (got {type(data).__name__})"
            )

        blocks_raw = data.get("blocks")
        if blocks_raw is None:
            raise ValueError(
                f"{defs_path}: missing required key 'blocks' (per-field "
                f"schema is no longer supported — re-bootstrap the template)"
            )
        if not isinstance(blocks_raw, list):
            raise ValueError(
                f"{defs_path}: 'blocks' must be a list, got "
                f"{type(blocks_raw).__name__}"
            )

        def _has_executable_sql(b: Dict[str, Any]) -> bool:
            """A block is executable if it carries a non-empty ``sql:``,
            a ``cte_ref:``, or — for ``mixed`` — a non-empty ``ctes:``."""
            if (b.get("sql") or "").strip():
                return True
            if b.get("cte_ref"):
                return True
            ctes = b.get("ctes")
            if isinstance(ctes, list) and ctes:
                return True
            return False

        live_blocks = [
            b for b in blocks_raw
            if isinstance(b, dict)
            and not b.get("deprecated")
            and _has_executable_sql(b)
        ]
        ordered = _toposort_blocks(live_blocks)
        logger.info(
            "loaded %d blocks from %s (%d live, %d deprecated, %d sql-less)",
            len(blocks_raw), defs_path,
            len(ordered),
            sum(1 for b in blocks_raw if isinstance(b, dict) and b.get("deprecated")),
            len(blocks_raw) - len(live_blocks) - sum(
                1 for b in blocks_raw if isinstance(b, dict) and b.get("deprecated")
            ),
        )
        return {
            "definitions":      data,
            "validated_blocks": ordered,
            "definitions_path": str(defs_path),
        }

    def post(
        self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any],
    ) -> str:
        shared["report_definitions"] = exec_result["definitions"]
        shared["validated_blocks"]   = exec_result["validated_blocks"]
        shared["definitions_path"]   = exec_result["definitions_path"]
        self.log_exit("default")
        return "default"
