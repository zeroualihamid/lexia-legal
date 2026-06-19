"""Public interface for the Lexia legal graph agent."""

from __future__ import annotations

import pickle
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import networkx as nx
from pocketflow import Flow

from nodes.legal_graph.claude_code_client import ClaudeCodeClient
from nodes.legal_graph.graph_utils import (
    build_reasoning_subgraph,
    ensure_legal_graph,
    get_source_from_graph_node,
    graphml_safe_copy,
    validate_reasoning_path,
)
from nodes.legal_graph.legal_graph_nodes import (
    ConnectToExistingGraphNode,
    GenerateAnswerNode,
    GraphSearchNode,
    LoadGraphNode,
    RetrieveChunksNode,
    SaveGraphNode,
    SelectStartGoalNode,
    UpsertChunkNodesNode,
    classify_document_type,
    classify_node_type,
    infer_reasoning_edges_for_judgment,
)
from nodes.legal_graph.models import LegalGraphConfig


class LegalGraphAgent:
    """Reusable facade around the legal graph PocketFlow."""

    def __init__(
        self,
        *,
        config: Optional[LegalGraphConfig | Dict[str, Any]] = None,
        claude_client: Optional[ClaudeCodeClient] = None,
    ) -> None:
        self.config = (
            config
            if isinstance(config, LegalGraphConfig)
            else LegalGraphConfig.model_validate(config or {})
        )
        self.claude_client = claude_client or ClaudeCodeClient(
            timeout_seconds=self.config.claude_timeout_seconds,
            require_token=self.config.require_claude_token,
        )
        self.claude_available = self.claude_client.validate_available()

    def run(
        self,
        query: str,
        *,
        qdrant_filter: Optional[Any] = None,
        query_vector: Optional[Any] = None,
        target_node_id: Optional[str] = None,
        top_k: Optional[int] = None,
        judgments_only: Optional[bool] = None,
        cross_case: Optional[bool] = None,
    ) -> Dict[str, Any]:
        """Run the full graph reasoning flow."""
        shared: Dict[str, Any] = {
            "query": query,
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
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
        _create_agent_flow().run(shared)
        return shared

    def retrieve(
        self,
        query: str,
        *,
        qdrant_filter: Optional[Any] = None,
        query_vector: Optional[Any] = None,
        top_k: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        """Retrieve Qdrant chunks only; no graph mutation."""
        shared: Dict[str, Any] = {
            "query": query,
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
        if qdrant_filter is not None:
            shared["qdrant_filter"] = qdrant_filter
        if query_vector is not None:
            shared["query_vector"] = query_vector
        if top_k is not None:
            shared["top_k"] = top_k
        RetrieveChunksNode().run(shared)
        return list(shared.get("retrieved_chunks") or [])

    def load_graph(self) -> nx.MultiDiGraph:
        """Load the persisted graph, creating an empty graph if absent."""
        shared: Dict[str, Any] = {
            "legal_graph_config": self.config,
            "graph_file_path": str(self.config.graph_file_path),
            "legal_graph_claude_client": self.claude_client,
        }
        LoadGraphNode().run(shared)
        return ensure_legal_graph(shared.get("graph"))

    def save_graph(self, graph: Optional[nx.MultiDiGraph] = None) -> str:
        """Persist the graph and return the pickle path."""
        shared: Dict[str, Any] = {
            "graph": graph or self.load_graph(),
            "legal_graph_config": self.config,
            "graph_file_path": str(self.config.graph_file_path),
            "legal_graph_claude_client": self.claude_client,
        }
        SaveGraphNode().run(shared)
        return str(shared["graph_file_path"])

    def upsert_chunks(
        self,
        chunks: Iterable[Dict[str, Any]],
        *,
        graph: Optional[nx.MultiDiGraph] = None,
    ) -> Dict[str, Any]:
        """Idempotently add or update graph nodes from retrieved chunks."""
        shared: Dict[str, Any] = {
            "graph": graph or self.load_graph(),
            "retrieved_chunks": list(chunks),
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
        UpsertChunkNodesNode().run(shared)
        return {"graph": shared["graph"], "upserted_node_ids": shared["upserted_node_ids"]}

    def connect_to_existing_graph(
        self,
        graph: nx.MultiDiGraph,
        upserted_node_ids: Iterable[str],
        *,
        query: str = "",
    ) -> Dict[str, Any]:
        """Create metadata, citation, semantic and LLM-inferred edges."""
        shared: Dict[str, Any] = {
            "graph": graph,
            "upserted_node_ids": list(upserted_node_ids),
            "query": query,
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
        ConnectToExistingGraphNode().run(shared)
        return {"graph": shared["graph"], "connected_edge_ids": shared["connected_edge_ids"]}

    def search_graph(
        self,
        graph: nx.MultiDiGraph,
        *,
        start_node_id: str,
        goal_node_id: str,
        upserted_node_ids: Optional[Iterable[str]] = None,
        cross_case: bool = False,
    ) -> Dict[str, Any]:
        """Search for a legal reasoning path between graph nodes."""
        shared: Dict[str, Any] = {
            "graph": graph,
            "start_node_id": start_node_id,
            "goal_node_id": goal_node_id,
            "upserted_node_ids": list(upserted_node_ids or []),
            "cross_case": cross_case,
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
        GraphSearchNode().run(shared)
        return {
            "reasoning_path": shared.get("reasoning_path") or [],
            "reasoning_path_node_ids": shared.get("reasoning_path_node_ids") or [],
            "graph_search_method": shared.get("graph_search_method"),
            "status": shared.get("graph_search_status"),
            "message": shared.get("graph_search_message"),
            "suggested_action": shared.get("suggested_action"),
        }

    def find_reasoning_path(self, query: str, cross_case: bool = False) -> Dict[str, Any]:
        """Retrieve chunks and search only reasoning edges for a legal path."""
        shared: Dict[str, Any] = {
            "query": query,
            "cross_case": cross_case,
            "legal_graph_config": self.config,
            "legal_graph_claude_client": self.claude_client,
        }
        LoadGraphNode().run(shared)
        RetrieveChunksNode().run(shared)
        UpsertChunkNodesNode().run(shared)
        ConnectToExistingGraphNode().run(shared)
        SelectStartGoalNode().run(shared)
        GraphSearchNode().run(shared)
        SaveGraphNode().run(shared)
        return {
            "status": shared.get("graph_search_status"),
            "message": shared.get("graph_search_message"),
            "suggested_action": shared.get("suggested_action"),
            "reasoning_path": shared.get("reasoning_path") or [],
            "reasoning_path_node_ids": shared.get("reasoning_path_node_ids") or [],
            "start_node_id": shared.get("start_node_id"),
            "goal_node_id": shared.get("goal_node_id"),
            "graph_file_path": shared.get("graph_file_path"),
        }

    def find_similar_cases(self, query: str) -> Dict[str, Any]:
        """Discovery-only method for similar cases and cross-document navigation."""
        chunks = self.retrieve(query)
        graph = self.load_graph()
        similar_edges: List[Dict[str, Any]] = []
        for source, target, key, attrs in graph.edges(keys=True, data=True):
            if attrs.get("edge_layer") != "discovery":
                continue
            if attrs.get("relation_type") not in {"similar_to", "same_section", "same_document", "same_judgment"}:
                continue
            similar_edges.append(
                {
                    "source": source,
                    "target": target,
                    "relation_type": attrs.get("relation_type"),
                    "confidence": attrs.get("confidence"),
                    "explanation": attrs.get("explanation"),
                }
            )
        return {
            "retrieved_chunks": chunks,
            "discovery_edges": similar_edges,
        }

    def explain_path(
        self,
        query: str,
        reasoning_path: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """Ask Claude Code to explain a reasoning path; returns fallback if unavailable."""
        explanation = self.claude_client.explain_reasoning_path(
            query=query,
            path_steps=reasoning_path,
        )
        if explanation:
            return explanation
        return {
            "summary": "Claude Code is unavailable or returned invalid JSON; path explanation was not generated.",
            "confidence_score": 0.0,
            "key_steps": [],
        }

    def get_source_from_node(
        self,
        node_id: str,
        *,
        graph: Optional[nx.MultiDiGraph] = None,
    ) -> Dict[str, Any]:
        """Return chunk/source details for one graph node."""
        return get_source_from_graph_node(graph or self.load_graph(), node_id)

    def export_graph(
        self,
        *,
        graph: Optional[nx.MultiDiGraph] = None,
        path: Optional[str] = None,
    ) -> str:
        """Export the graph as GraphML and return the file path."""
        graph_to_export = ensure_legal_graph(graph or self.load_graph())
        target = Path(path or self.config.graphml_file_path or "data/legal_graph.graphml")
        target.parent.mkdir(parents=True, exist_ok=True)
        nx.write_graphml(graphml_safe_copy(graph_to_export), target)
        return str(target)

    def build_reasoning_subgraph(self, graph: Optional[nx.MultiDiGraph] = None, *, cross_case: bool = False) -> nx.DiGraph:
        return build_reasoning_subgraph(graph or self.load_graph(), cross_case=cross_case)

    def classify_document_type(self, chunks: List[Dict[str, Any]]) -> str:
        return classify_document_type(chunks)

    def classify_node_type(self, chunk: Dict[str, Any]) -> str:
        return classify_node_type(chunk)

    def infer_reasoning_edges_for_judgment(
        self,
        judgment_id: str,
        *,
        graph: Optional[nx.MultiDiGraph] = None,
        query: str = "",
    ) -> List[str]:
        return infer_reasoning_edges_for_judgment(
            graph or self.load_graph(),
            judgment_id,
            self.claude_client,
            query=query,
        )

    def validate_reasoning_path(
        self,
        path: List[str],
        *,
        graph: Optional[nx.MultiDiGraph] = None,
        cross_case: bool = False,
    ) -> bool:
        return validate_reasoning_path(graph or self.load_graph(), path, cross_case=cross_case)

    def _write_pickle(self, graph: nx.MultiDiGraph) -> None:
        self.config.graph_file_path.parent.mkdir(parents=True, exist_ok=True)
        with self.config.graph_file_path.open("wb") as fh:
            pickle.dump(graph, fh)


def _create_agent_flow() -> Flow:
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
