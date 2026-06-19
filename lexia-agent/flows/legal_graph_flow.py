"""Legal graph PocketFlow orchestration.

Pipeline:

    LoadGraphNode
        -> RetrieveChunksNode
        -> UpsertChunkNodesNode
        -> ConnectToExistingGraphNode
        -> SelectStartGoalNode
        -> GraphSearchNode
        -> SaveGraphNode
        -> GenerateAnswerNode

Shared-state contract:

Required:
    query

Optional:
    graph_file_path
    graphml_file_path
    qdrant_filter
    query_vector
    target_node_id
    top_k
    legal_graph_config
    legal_graph_claude_client

Outputs:
    graph
    retrieved_chunks
    upserted_node_ids
    connected_edge_ids
    start_node_id
    goal_node_id
    reasoning_path
    reasoning_path_node_ids
    final_answer
    graph_file_path
"""

from __future__ import annotations

from typing import Any, Dict, Optional

from pocketflow import Flow

from monitoring.logger import get_logger
from nodes.legal_graph.claude_code_client import ClaudeCodeClient
from nodes.legal_graph.legal_graph_nodes import (
    ConnectToExistingGraphNode,
    GenerateAnswerNode,
    GraphSearchNode,
    LoadGraphNode,
    RetrieveChunksNode,
    SaveGraphNode,
    SelectStartGoalNode,
    UpsertChunkNodesNode,
)
from nodes.legal_graph.models import LegalGraphConfig

logger = get_logger(__name__)


def create_legal_graph_flow() -> Flow:
    """Assemble the legal graph reasoning pipeline."""
    load_graph = LoadGraphNode()
    retrieve_chunks = RetrieveChunksNode()
    upsert_nodes = UpsertChunkNodesNode()
    connect_graph = ConnectToExistingGraphNode()
    select_start_goal = SelectStartGoalNode()
    search_graph = GraphSearchNode()
    save_graph = SaveGraphNode()
    generate_answer = GenerateAnswerNode()

    (
        load_graph
        >> retrieve_chunks
        >> upsert_nodes
        >> connect_graph
        >> select_start_goal
        >> search_graph
        >> save_graph
        >> generate_answer
    )

    return Flow(start=load_graph)


def run_legal_graph_flow(
    query: str,
    *,
    graph_file_path: Optional[str] = None,
    graphml_file_path: Optional[str] = None,
    qdrant_filter: Optional[Any] = None,
    query_vector: Optional[Any] = None,
    target_node_id: Optional[str] = None,
    top_k: Optional[int] = None,
    judgments_only: Optional[bool] = None,
    cross_case: Optional[bool] = None,
    config: Optional[LegalGraphConfig | Dict[str, Any]] = None,
    claude_client: Optional[ClaudeCodeClient] = None,
) -> Dict[str, Any]:
    """Run the legal graph flow and return shared state."""
    shared: Dict[str, Any] = {"query": query}
    if graph_file_path:
        shared["graph_file_path"] = graph_file_path
    if graphml_file_path:
        shared["graphml_file_path"] = graphml_file_path
    if qdrant_filter is not None:
        shared["qdrant_filter"] = qdrant_filter
    if query_vector is not None:
        shared["query_vector"] = query_vector
    if target_node_id:
        shared["target_node_id"] = target_node_id
    if top_k is not None:
        shared["top_k"] = top_k
    if judgments_only is not None:
        shared["judgments_only"] = judgments_only
    if cross_case is not None:
        shared["cross_case"] = cross_case
    if config is not None:
        shared["legal_graph_config"] = config
    if claude_client is not None:
        shared["legal_graph_claude_client"] = claude_client

    logger.info("Starting legal graph flow")
    create_legal_graph_flow().run(shared)
    logger.info(
        "Legal graph flow complete: chunks=%d path=%d",
        len(shared.get("retrieved_chunks") or []),
        len(shared.get("reasoning_path") or []),
    )
    return shared
