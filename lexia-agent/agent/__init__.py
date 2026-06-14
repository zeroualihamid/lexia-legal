"""LangChain agent layer for brikz-agent.

This package wraps the existing PocketFlow flows + nodes as LangChain tools
and exposes a `create_brikz_agent_executor` builder that returns a
LangChain :class:`AgentExecutor` configured with the think → act → observe
loop, the pre-loop reasoning pipeline (DTO warm-up, query augmentation,
embedding column search, CTE library retrieval, plan decomposition), and
the CTE search-or-create retriever.

Public API:
    - create_brikz_agent_executor(...)  — build the AgentExecutor
    - run_brikz_agent(query, session_id, ...) — high-level entrypoint
    - BrikzLLM                          — BaseChatModel adapter over llm/
"""

from agent.llm_adapter import BrikzLLM
from agent.langchain_agent import (
    create_brikz_agent_executor,
    run_brikz_agent,
    arun_brikz_agent,
)

__all__ = [
    "BrikzLLM",
    "create_brikz_agent_executor",
    "run_brikz_agent",
    "arun_brikz_agent",
]
