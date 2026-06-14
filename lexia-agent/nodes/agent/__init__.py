"""Agent nodes.

Two flavours coexist:

  - Legacy PocketFlow agent loop (4 nodes):
      AgentRouterNode → ToolDispatchNode → VerifyNode → AgentResponseNode
    Kept for backwards compatibility with ``flows/agent_flow.py``.

  - LangChain-backed single-node executor:
      LangChainAgentExecutorNode
    Used by ``flows/langchain_agent_flow.py`` — same shared-state contract.
"""

from nodes.agent.router_node import AgentRouterNode
from nodes.agent.tool_dispatch_node import ToolDispatchNode
from nodes.agent.verify_node import VerifyNode
from nodes.agent.response_node import AgentResponseNode
from nodes.agent.langchain_executor_node import LangChainAgentExecutorNode

__all__ = [
    "AgentRouterNode",
    "ToolDispatchNode",
    "VerifyNode",
    "AgentResponseNode",
    "LangChainAgentExecutorNode",
]
