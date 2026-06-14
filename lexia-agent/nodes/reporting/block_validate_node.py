"""BlockValidateNode — enforce the per-block ``definitions.yaml`` invariants.

This node replaces the legacy per-field :class:`SqlValidateNode` for the
new block-based schema (``data/reporting/SCHEMA.md``).  Each block is
either backed by inline ``sql:``, a ``cte_ref:`` to the shared block-CTE
library at ``data/reporting/sql/fragment_library/``, or — for ``mixed`` blocks —
a list of sub-CTEs in ``ctes:``.

The node:

1. Reads ``shared['report_definitions']`` (already-parsed YAML).
2. Calls :func:`nodes.reporting.sql_helpers.validate_blocks` over every
   non-deprecated, non-empty block.
3. Writes back the per-block reports plus a small summary suitable for
   SSE/UI display, and the list of validated blocks the SQL-batch
   executor consumes.

Inputs (``shared``)
───────────────────
* ``report_definitions``      — parsed YAML dict (must contain ``blocks``).
* ``accounting_library_dir``  — optional path to ``sql/accounting/`` for
                                ``{{include: <atom>}}`` resolution.
* ``block_library_dir``       — optional path to ``sql/fragment_library/`` for
                                ``cte_ref:`` resolution.

Outputs
* ``block_validation_reports``  — list of :class:`BlockValidationReport`.
* ``block_validation_summary``  — JSON-friendly summary with counts.
* ``validated_blocks``          — block dicts that passed validation;
                                   the SQL batch executor iterates this.

Action returned by :meth:`post`
* ``"invalid"`` in strict mode if any block failed; otherwise ``"default"``.
"""

from __future__ import annotations

from dataclasses import asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

from nodes.base_node import BaseNode
from nodes.reporting.sql_helpers import (
    BlockValidationReport,
    default_insurance_merge_library_dirs,
    validate_blocks,
)


class BlockValidateNode(BaseNode):
    """Validate every block in ``shared['report_definitions']``."""

    def __init__(
        self,
        name: Optional[str] = None,
        *,
        strict: bool = True,
        dialect: str = "duckdb",
    ):
        super().__init__(name or "BlockValidate")
        self.strict = strict
        self.dialect = dialect

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        defs = shared.get("report_definitions")
        if not isinstance(defs, dict):
            raise ValueError(
                "BlockValidateNode requires 'report_definitions' (parsed YAML "
                "dict) in shared state"
            )
        if not isinstance(defs.get("blocks"), list):
            raise ValueError(
                "BlockValidateNode requires definitions['blocks'] to be a list "
                "(rebuild via the new block-based bootstrap if upgrading)"
            )

        library_dir_raw = shared.get("accounting_library_dir")
        library_dir: Optional[Path] = (
            Path(library_dir_raw) if library_dir_raw else None
        )
        block_library_dir_raw = shared.get("block_library_dir")
        block_library_dir: Optional[Path] = (
            Path(block_library_dir_raw) if block_library_dir_raw else None
        )

        return {
            "definitions":       defs,
            "library_dir":       library_dir,
            "block_library_dir": block_library_dir,
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[BlockValidationReport]:
        merge = default_insurance_merge_library_dirs()
        return validate_blocks(
            prep_result["definitions"],
            library_dir        = prep_result["library_dir"],
            block_library_dir  = prep_result["block_library_dir"],
            merge_library_dirs = merge or None,
            dialect            = self.dialect,
        )

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Any,
        exec_result: List[BlockValidationReport],
    ) -> str:
        defs: Dict[str, Any] = prep_result["definitions"]
        all_blocks: List[Dict[str, Any]] = defs.get("blocks") or []

        invalid_ids = [r.block_id for r in exec_result if not r.ok]
        warned_ids  = [r.block_id for r in exec_result if r.warnings]

        shared["block_validation_reports"] = exec_result

        # JSON-friendly view (drops the parsed AST, keeps the message lists).
        def _serialize(r: BlockValidationReport) -> Dict[str, Any]:
            d = asdict(r)
            d.pop("parsed", None)
            d["sub_reports"] = [
                _serialize_sub(s) for s in r.sub_reports
            ]
            return d

        def _serialize_sub(r: BlockValidationReport) -> Dict[str, Any]:
            d = asdict(r)
            d.pop("parsed", None)
            d.pop("sub_reports", None)
            return d

        shared["block_validation_summary"] = {
            "total":        len(exec_result),
            "valid":        sum(1 for r in exec_result if r.ok),
            "invalid":      len(invalid_ids),
            "with_warning": len(warned_ids),
            "invalid_ids":  invalid_ids,
            "warned_ids":   warned_ids,
            "reports":      [_serialize(r) for r in exec_result],
        }

        valid_ids = {r.block_id for r in exec_result if r.ok}
        shared["validated_blocks"] = [
            b for b in all_blocks if b.get("id") in valid_ids
        ]

        if invalid_ids:
            self.logger.warning(
                "Block validation: %d invalid block(s): %s",
                len(invalid_ids), invalid_ids[:10],
            )
            for r in exec_result:
                if not r.ok:
                    for err in r.errors:
                        self.logger.warning("  - %s: %s", r.block_id, err)
            if self.strict:
                self.log_exit("invalid")
                return "invalid"

        self.log_exit("default")
        return "default"
