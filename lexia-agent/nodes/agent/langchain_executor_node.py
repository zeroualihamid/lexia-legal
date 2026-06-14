"""PocketFlow node that runs the LangChain :class:`AgentExecutor`.

This replaces the four-node ``Router → Dispatch → Verify → Response`` loop
with a single node that delegates the whole think → act → observe loop to
LangChain. The pre-loop reasoning (DTO warm-up, query augmentation,
embedding column search, CTE retrieval, plan decomposition) is run inside
``agent.langchain_agent.create_brikz_agent_executor`` so the system
prompt the executor receives is identical to the legacy flow.

Shared-state contract (compatible with the legacy agent flow):

  IN:
    - ``query``                   (str, required)
    - ``original_query``          (str, optional)
    - ``session_id``              (str, optional)
    - ``memory_store``            (MemoryStore, optional)
    - ``stream_callback``         (callable, optional)
    - ``max_iterations``          (int, optional)
    - ``skills_context``          (str, optional)

  OUT:
    - ``final_response``          (str)        — same key as AgentResponseNode
    - ``agent_iteration``         (int)        — # of executor steps used
    - ``preloop_result``          (PreloopResult)
    - ``langchain_intermediate``  (list[tuple]) — raw agent steps

Return action: ``"done"`` (no further branching).
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)


class LangChainAgentExecutorNode(BaseNode):
    """Run the whole agent loop via LangChain's AgentExecutor."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "LangChainAgentExecutor")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        return {
            "query":            shared.get("query", ""),
            "original_query":   shared.get("original_query", ""),
            "session_id":       shared.get("session_id", "default"),
            "memory_store":     shared.get("memory_store"),
            "skills_context":   shared.get("skills_context", "") or "",
            "stream_callback":  shared.get("stream_callback"),
        }

    def exec(self, prep_res: Dict[str, Any]) -> Dict[str, Any]:
        from agent.langchain_agent import run_brikz_agent

        emit = prep_res.get("stream_callback")
        if emit:
            emit("thinking", "Démarrage de l'agent (pré-loop reasoning)…", None)

        # Pass the stream callback so the CTE fast-path can stream llm_token
        # events directly to /chat/ when the query maps to a known CTE.
        result = run_brikz_agent(
            query=prep_res["query"] or prep_res["original_query"],
            session_id=prep_res["session_id"],
            memory_store=prep_res["memory_store"],
            skills_context=prep_res["skills_context"],
            stream_callback=emit,
        )

        if emit:
            emit("complete", "Agent terminé", {
                "cte_hit": result.get("cte_hit"),
                "cte_created": result.get("cte_created"),
            })

        return result

    def post(self, shared: Dict[str, Any], prep_res: Dict[str, Any], exec_res: Dict[str, Any]) -> str:
        shared["final_response"] = exec_res.get("answer", "")
        shared["agent_response"] = exec_res.get("answer", "")
        shared["augmented_query"] = exec_res.get("augmented_query")
        shared["analysis_plan"] = exec_res.get("analysis_plan")
        shared["langchain_intermediate"] = exec_res.get("intermediate_steps")
        shared["cte_hit"] = exec_res.get("cte_hit")
        shared["cte_created"] = exec_res.get("cte_created")
        shared["is_greeting"] = exec_res.get("is_greeting", False)

        # Structured tool outputs (used by the chat route for charts + payload).
        shared["sql_queries"] = exec_res.get("sql_queries", []) or []
        shared["sql_results"] = exec_res.get("sql_results", []) or []
        shared["rendered_reports"] = exec_res.get("rendered_reports", []) or []

        intermediate = exec_res.get("intermediate_steps") or []
        shared["agent_iteration"] = len(intermediate)

        self.log_exit("done")
        return "done"
