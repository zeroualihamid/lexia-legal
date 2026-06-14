"""LangChain-backed agent flow.

Drop-in replacement for ``flows.agent_flow.run_agent_flow`` that uses
LangChain's :class:`AgentExecutor` for the think → act → observe loop.

The pre-loop reasoning pipeline (DTO warm-up, query augmentation,
embedding column search, CTE library retrieval, plan decomposition) runs
inside ``agent.langchain_agent`` so the system prompt is identical to the
legacy flow.

Public API mirrors ``flows.agent_flow``:

    run_langchain_agent_flow(query, session_id=..., memory_store=..., ...)

Returns the same shared-state dict shape so existing callers keep working.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from pocketflow import Flow

from nodes.agent.langchain_executor_node import LangChainAgentExecutorNode

logger = logging.getLogger(__name__)

StreamCallback = Callable[[str, str, Optional[dict]], None]

# brikz-agent root (== /app in the container). Used to resolve a skill's
# relative ``parquet_source`` (e.g. ``data/parquet/…``) when checking that the
# data it binds actually exists on disk.
_AGENT_ROOT = Path(__file__).resolve().parents[1]


def _parquet_source_exists(parquet_source: str) -> bool:
    """True when a skill's bound parquet file actually exists on disk."""
    if not parquet_source:
        return False
    p = Path(parquet_source)
    candidates = [p] if p.is_absolute() else [_AGENT_ROOT / parquet_source, Path.cwd() / parquet_source]
    return any(c.is_file() for c in candidates)


def _skill_with_available_source(skills: Any) -> Any:
    """First skill whose bound parquet exists on disk, else ``None``."""
    for s in skills or []:
        if _parquet_source_exists(getattr(s, "parquet_source", "") or ""):
            return s
    return None


def _recent_history_text(memory_store: Any, session_id: str, *, max_turns: int = 4) -> str:
    """Best-effort recent-turn text for skill routing (empty on any issue)."""
    if not memory_store or not session_id:
        return ""
    try:
        session = memory_store.get(session_id)
        turns = getattr(session, "short_term", None) or []
        return " ".join(
            (getattr(m, "content", "") or "") for m in turns[-max_turns:]
        ).strip()
    except Exception:
        return ""


def create_langchain_agent_flow() -> Flow:
    """Build a one-node PocketFlow that delegates to LangChain."""
    node = LangChainAgentExecutorNode()
    return Flow(start=node)


def run_langchain_agent_flow(
    query: str,
    *,
    session_id: str = "default",
    max_iterations: int = 10,
    stream_callback: Optional[StreamCallback] = None,
    connector_manager: Any = None,
    memory_store: Any = None,
    skills_context: str = "",
) -> Dict[str, Any]:
    """Run the LangChain-backed agent flow.

    Returns the shared-state dict (same shape as ``flows.agent_flow.run_agent_flow``).
    """
    # Inject domain-expertise skills into the system prompt when the caller
    # didn't pass any. Query-aware: the skill(s) matching this query are injected
    # in full (so the agent gets the exact formulas to design/execute a CTE,
    # e.g. MNI → indicateurs-bancaires-comex), falling back to a compact
    # catalogue when nothing matches — instead of dumping every skill's full
    # body, which buried the relevant formulas and bloated the prompt.
    if not skills_context:
        try:
            from skill_registry import build_skills_context_for_query

            skills_context = build_skills_context_for_query(query)
        except Exception as exc:
            logger.warning("Skill context load failed (non-fatal): %s", exc)
            skills_context = ""

    # Route BOTH the CTE search and the write target to the skill matched for
    # this query, so the persisted pickle is named after that skill
    # (``cte-prof-<skill>``) AND the fast-path search reads that same graph (so
    # an existing CTE is reused instead of re-explored). When no skill matches,
    # clear the routing so behaviour falls back to the default library.
    try:
        from skill_registry import detect_skills_in_query, select_routing_skill
        from services.cte_graph.library_graph_cache import (
            graph_id_for_library,
            set_active_cte_libraries,
        )
        from services.cte_graph.repository import (
            set_active_cte_graph,
            set_active_cte_source,
        )

        # Include recent conversation so follow-ups ("et par branche ?") still
        # route to the right skill even without topical keywords in the new turn.
        _history = _recent_history_text(memory_store, session_id)
        _matched = detect_skills_in_query(query, history=_history)
        # Among matched skills, the one that declares a data source drives routing.
        _skill = select_routing_skill(_matched)
        # Never route to a CTE library we cannot execute: if the chosen skill's
        # parquet source is absent in THIS deployment (e.g. the Oracle export is
        # not loaded), the agent would retrieve CTEs that fail or answer from the
        # wrong data. Fall back to whichever skill HAS data on disk — preferring
        # a matched one, else any skill with an available source.
        if _skill is None or not _parquet_source_exists(getattr(_skill, "parquet_source", "") or ""):
            from skill_registry import load_skill_definitions

            _avail = _skill_with_available_source(_matched) or _skill_with_available_source(
                load_skill_definitions()
            )
            if _avail is not None:
                if _skill is not None and getattr(_skill, "name", None) != getattr(_avail, "name", None):
                    logger.info(
                        "Routing: skill '%s' has no parquet on disk — falling back to '%s' "
                        "(source present)",
                        getattr(_skill, "name", "?"), getattr(_avail, "name", "?"),
                    )
                _skill = _avail
        if _skill:
            _lib = _skill.name
            set_active_cte_graph(graph_id_for_library(_lib))
            set_active_cte_libraries([_lib])
            # Bind the skill's data source so the full-agent path (augmentation,
            # schema, new-CTE design) targets the skill's parquet, not the default.
            set_active_cte_source(_skill.parquet_source, _skill.source_view)
            logger.info(
                "Active CTE routing: library=%s graph=%s source=%s (skill=%s, candidates=%s)",
                _lib, graph_id_for_library(_lib), _skill.source_view or "(default)", _lib,
                [s.name for s in _matched],
            )
        else:
            set_active_cte_graph(None)
            set_active_cte_libraries(None)
            set_active_cte_source(None, None)
    except Exception as exc:
        logger.warning("CTE graph routing failed (non-fatal): %s", exc)

    flow = create_langchain_agent_flow()
    shared: Dict[str, Any] = {
        "query": query,
        "original_query": query,
        "session_id": session_id,
        "max_iterations": max_iterations,
        "memory_store": memory_store,
        "connector_manager": connector_manager,
        "skills_context": skills_context,
    }
    if stream_callback is not None:
        shared["stream_callback"] = stream_callback

    logger.info("Starting LangChain agent flow: session=%s query=%s", session_id, query[:60])
    flow.run(shared)
    logger.info("LangChain agent flow complete: %d steps", shared.get("agent_iteration", 0))
    return shared


if __name__ == "__main__":
    result = run_langchain_agent_flow(
        query="quelle est l'évolution mensuelle des ventes moto sur 2024 ?",
        session_id="lc-smoke-001",
    )
    print("─" * 80)
    print("Final response:")
    print(result.get("final_response") or "(empty)")
    print("─" * 80)
    print(f"Steps: {result.get('agent_iteration')}  CTE hit: {result.get('cte_hit')}")
