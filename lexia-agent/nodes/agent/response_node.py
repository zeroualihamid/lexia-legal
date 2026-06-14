"""
AgentResponseNode — Format and stream the final agent response.

Also saves structured results to session memory for follow-up queries.
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


class AgentResponseNode(BaseNode):
    """Format and deliver the final agent response."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "AgentResponse")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "response": shared.get("agent_response", ""),
            "iteration": shared.get("agent_iteration", 0),
            "stream_callback": shared.get("stream_callback"),
            "session_id": shared.get("session_id", "default"),
            "query": shared.get("query", ""),
        }

    def exec(self, prep_res: Dict[str, Any]) -> Dict[str, Any]:
        response = prep_res["response"]
        emit = prep_res.get("stream_callback")

        if emit:
            emit("response", "Préparation de la réponse finale...", {
                "iteration_count": prep_res["iteration"],
                "session_id": prep_res["session_id"],
            })

        return {"response": response}

    def post(self, shared: Dict[str, Any], prep_res: Dict[str, Any], exec_res: Dict[str, Any]) -> str:
        shared["final_response"] = exec_res["response"]

        # Save to memory store for follow-up queries
        memory_store = shared.get("memory_store")
        session_id = prep_res["session_id"]
        if memory_store and session_id:
            session = memory_store.get_or_create(session_id)
            session.add_message("user", prep_res["query"])
            session.add_message(
                "assistant",
                exec_res["response"],
                metadata=_build_assistant_metadata(shared, prep_res["iteration"]),
            )
            try:
                from nodes.memory import maintain_session
                maintain_session(session)
            except Exception as exc:
                logger.debug("maintain_session failed (non-fatal): %s", exc)
            memory_store.save(session_id)

        emit = prep_res.get("stream_callback")
        if emit:
            emit("complete", "Agent flow complete", {
                "iterations": prep_res["iteration"],
            })

        self.log_exit("done")
        return "done"


def _build_assistant_metadata(shared: Dict[str, Any], iteration: int) -> Dict[str, Any]:
    """Pack iteration count + light snapshots of prior-turn results.

    Persisted memory is JSON; results are truncated to keep the file size
    bounded across long conversations. ``MemoryStore.get_last_result()`` reads
    these keys to inject "Prior Query Context" into the next turn's system
    prompt.
    """
    metadata: Dict[str, Any] = {"agent_iteration_count": iteration}

    raw_queries = shared.get("sql_queries") or []
    if raw_queries:
        slim_queries = []
        for q in raw_queries[:5]:
            if isinstance(q, dict):
                sql = str(q.get("sql", ""))[:1500]
                label = str(q.get("label", ""))[:80]
                slim_queries.append({"sql": sql, "label": label})
            else:
                slim_queries.append({"sql": str(q)[:1500], "label": ""})
        metadata["sql_queries"] = slim_queries

    raw_results = shared.get("sql_results") or []
    if raw_results:
        summary_lines = []
        for r in raw_results[:5]:
            if not isinstance(r, dict):
                continue
            label = str(r.get("label", ""))[:80]
            cols = r.get("columns") or []
            row_count = r.get("row_count")
            if row_count is None:
                rows = r.get("rows") or []
                row_count = len(rows) if isinstance(rows, list) else 0
            cols_preview = ", ".join(str(c) for c in list(cols)[:8])
            summary_lines.append(f"- {label}: {row_count} rows, columns=[{cols_preview}]")
        if summary_lines:
            metadata["sql_results_summary"] = "\n".join(summary_lines)

    chart = shared.get("chart_data")
    if isinstance(chart, dict) and chart:
        metadata["chart_data"] = {
            "title": str(chart.get("title", ""))[:200],
            "chart_type": str(chart.get("chart_type", chart.get("type", "")))[:40],
        }

    return metadata
