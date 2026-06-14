"""LangChain :class:`BaseTool` wrappers around PocketFlow flows.

Each wrapper exposes one flow's ``run_*`` entrypoint as a typed tool the
LangChain :class:`AgentExecutor` can call. The wrappers do NOT alter the
underlying flow — they only translate typed Pydantic args into the flow's
positional / shared-state arguments and serialize the flow's result into a
short string for the next LLM turn.

To expose a new flow as a tool:

  1. Implement / extend a wrapper in ``agent/tools/flow_tools.py`` (or pick a
     module per domain).
  2. Register it in :data:`AVAILABLE_TOOLS`.
  3. Add its key to ``tools.enabled`` in ``config/langchain_config.yaml``.
"""

from agent.tools.registry import build_tool_list, AVAILABLE_TOOLS

__all__ = ["build_tool_list", "AVAILABLE_TOOLS"]
