"""Read user conversations + the CTE extractions used in them, for review/judging.

Backed by the purpose-built CTE-extraction log (``services.cte_extraction_log``),
which records, per /chat turn, the user's VERBATIM query and whether the answer
REUSED an existing CTE or GENERATED a new one.

Each /chat turn is surfaced as its OWN conversation entry (``conv_id`` =
``"<session>::<idx>"``). A client that reuses one session_id across many distinct
questions would otherwise collapse them into a single entry — this keeps every
question visible and scopes each entry's CTEs to that turn's execution.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from services import cte_extraction_log


def list_conversations(limit: int = 100) -> List[Dict[str, Any]]:
    """Recent conversations (one per turn): id, query, cte_mode/names, updated_at."""
    return cte_extraction_log.list_records(limit=limit)


def load_conversation_turns(
    conv_id: str, *, sample_rows: int = 5
) -> Optional[Dict[str, Any]]:
    """A conversation's turn(s): verbatim query + ONLY the CTE(s) executed + results.

    Each turn: { query, response, cte_mode, cte_names, ctes:[{label, sql}],
    results:[{label, columns, row_count, rows(sample), error}] }. ``ctes`` and
    ``cte_names`` are restricted to the CTEs actually executed in this turn (those
    with a matching result), dropping exploratory SQL fragments / unrelated names.
    """
    data = cte_extraction_log.load_record(conv_id)
    if data is None:
        return None
    turns: List[Dict[str, Any]] = []
    for rec in data.get("records", []):
        results_raw = rec.get("results") or []
        results = [
            {
                "label": r.get("label", ""),
                "columns": r.get("columns") or [],
                "row_count": r.get("row_count"),
                "rows": (r.get("rows") or [])[:sample_rows],
                "error": r.get("error"),
            }
            for r in results_raw
        ]
        # Only CTEs that were actually executed (have a matching result label).
        exec_labels = {r.get("label", "") for r in results_raw if r.get("label")}
        all_ctes = rec.get("ctes") or []
        ctes = [c for c in all_ctes if c.get("label", "") in exec_labels] or all_ctes
        cte_names = list(dict.fromkeys(c.get("label", "") for c in ctes if c.get("label")))
        if not cte_names:
            cte_names = rec.get("cte_names", [])
        turns.append(
            {
                "query": rec.get("original_query", ""),
                "augmented_query": rec.get("augmented_query", ""),
                "response": rec.get("response", ""),
                "cte_mode": rec.get("cte_mode", "none"),
                "cte_names": cte_names,
                "ctes": ctes,
                "results": results,
            }
        )
    return {"session_id": conv_id, "turn_count": len(turns), "turns": turns}
