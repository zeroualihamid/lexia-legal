"""PocketFlow nodes for persistent legal graph reasoning."""

from __future__ import annotations

import os
import pickle
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import networkx as nx

from nodes.base_node import BaseNode
from nodes.legal_graph.claude_code_client import ClaudeCodeClient
from nodes.legal_graph.graph_utils import (
    best_edge_between,
    build_reasoning_subgraph,
    citation_from_source,
    common_values,
    cosine_similarity,
    ensure_legal_graph,
    get_source_from_graph_node,
    graphml_safe_copy,
    is_reasoning_relation,
    node_attrs_from_chunk,
    nodes_with_same_field,
    relation_weight,
    retrieved_chunk_from_qdrant_result,
    text_preview,
    upsert_edge,
    validate_reasoning_path,
)
from nodes.legal_graph.models import (
    CONTRACT_NODE_TYPES,
    DOCUMENT_TYPES,
    DISCOVERY_RELATION_TYPES,
    EdgeSpec,
    FinalAnswer,
    GOAL_SECTION_TYPES,
    JUDGMENT_NODE_TYPES,
    LegalGraphConfig,
    NODE_TYPE_PRIORITY,
    REASONING_RELATION_TYPES,
    ReasoningPathStep,
    RetrievedChunk,
)


def _config(shared: Dict[str, Any]) -> LegalGraphConfig:
    cfg = shared.get("legal_graph_config")
    if isinstance(cfg, LegalGraphConfig):
        return cfg
    if isinstance(cfg, dict):
        return LegalGraphConfig.model_validate(cfg)
    return LegalGraphConfig()


def _claude(shared: Dict[str, Any], cfg: LegalGraphConfig) -> ClaudeCodeClient:
    client = shared.get("legal_graph_claude_client")
    if isinstance(client, ClaudeCodeClient):
        return client
    client = ClaudeCodeClient(
        timeout_seconds=cfg.claude_timeout_seconds,
        require_token=cfg.require_claude_token,
    )
    shared["legal_graph_claude_client"] = client
    return client


def _as_chunk(value: Any) -> RetrievedChunk:
    if isinstance(value, RetrievedChunk):
        return value
    return RetrievedChunk.model_validate(value)


def _as_chunks(values: Iterable[Any]) -> List[RetrievedChunk]:
    return [_as_chunk(value) for value in values]


class LoadGraphNode(BaseNode):
    """Load the persisted graph or create an empty one."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "LoadGraph")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        graph_file_path = Path(shared.get("graph_file_path") or cfg.graph_file_path)
        return {"graph_file_path": graph_file_path}

    def exec(self, prep_result: Dict[str, Any]) -> nx.MultiDiGraph:
        path: Path = prep_result["graph_file_path"]
        if not path.exists():
            self.logger.info("Legal graph not found at %s; creating a new graph", path)
            return ensure_legal_graph()
        try:
            with path.open("rb") as fh:
                graph = pickle.load(fh)
            return ensure_legal_graph(graph)
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not load legal graph %s: %s; creating a new graph", path, exc)
            return ensure_legal_graph()

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: nx.MultiDiGraph) -> str:
        shared["graph"] = exec_result
        shared["graph_file_path"] = str(prep_result["graph_file_path"])
        return "default"


class RetrieveChunksNode(BaseNode):
    """Retrieve existing Qdrant chunks for a query without indexing new content."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "RetrieveChunks")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        query = str(shared.get("query") or "").strip()
        if not query:
            raise ValueError("RetrieveChunksNode requires 'query' in shared state")
        cfg = _config(shared)
        top_k = int(shared.get("top_k") or cfg.top_k or 100)
        top_k = max(1, min(top_k, 500))
        return {
            "query": query,
            "query_vector": shared.get("query_vector"),
            "qdrant_filter": shared.get("qdrant_filter"),
            "top_k": top_k,
            "config": cfg,
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[RetrievedChunk]:
        cfg: LegalGraphConfig = prep_result["config"]
        try:
            from qdrant_client import QdrantClient
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("qdrant-client unavailable: %s", exc)
            return []

        client = QdrantClient(url=cfg.qdrant_url, api_key=cfg.qdrant_api_key)
        chunks: List[RetrievedChunk] = []
        for collection in cfg.qdrant_collections:
            try:
                results = self._query_collection(client, collection, prep_result, cfg)
            except Exception as exc:  # noqa: BLE001
                self.logger.warning("Qdrant retrieval failed for collection %s: %s", collection, exc)
                continue
            for result in results:
                try:
                    chunks.append(retrieved_chunk_from_qdrant_result(result, collection))
                except Exception as exc:  # noqa: BLE001
                    self.logger.warning("Skipping malformed Qdrant result in %s: %s", collection, exc)

        chunks.sort(key=lambda item: item.qdrant_score if item.qdrant_score is not None else -1.0, reverse=True)
        return chunks[: prep_result["top_k"]]

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: List[RetrievedChunk]) -> str:
        shared["retrieved_chunks"] = [chunk.model_dump() for chunk in exec_result]
        return "default"

    def _query_collection(
        self,
        client: Any,
        collection: str,
        prep_result: Dict[str, Any],
        cfg: LegalGraphConfig,
    ) -> List[Any]:
        top_k = prep_result["top_k"]
        query_filter = self._qdrant_filter(prep_result.get("qdrant_filter"))
        query_vector = prep_result.get("query_vector")
        if query_vector is not None:
            try:
                response = client.query_points(
                    collection_name=collection,
                    query=query_vector,
                    query_filter=query_filter,
                    limit=top_k,
                    with_payload=True,
                    with_vectors=True,
                )
                return list(getattr(response, "points", response) or [])
            except AttributeError:
                return list(
                    client.search(
                        collection_name=collection,
                        query_vector=query_vector,
                        query_filter=query_filter,
                        limit=top_k,
                        with_payload=True,
                        with_vectors=True,
                    )
                )

        try:
            client.set_model(cfg.query_embed_model)
        except Exception as exc:  # noqa: BLE001
            self.logger.warning("Could not configure Qdrant text query model %s: %s", cfg.query_embed_model, exc)
        return list(
            client.query(
                collection_name=collection,
                query_text=prep_result["query"],
                query_filter=query_filter,
                limit=top_k,
            )
        )

    @staticmethod
    def _qdrant_filter(value: Any) -> Any:
        if value is None:
            return None
        if not isinstance(value, dict):
            return value
        try:
            from qdrant_client import models

            if hasattr(models.Filter, "model_validate"):
                return models.Filter.model_validate(value)
            return models.Filter(**value)
        except Exception:
            return value


class UpsertChunkNodesNode(BaseNode):
    """Create or update graph nodes using Qdrant point ids as stable node ids."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "UpsertChunkNodes")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "chunks": _as_chunks(shared.get("retrieved_chunks", [])),
            "claude": _claude(shared, cfg),
            "config": cfg,
            "judgments_only": bool(shared.get("judgments_only", cfg.judgments_only)),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        graph: nx.MultiDiGraph = prep_result["graph"]
        chunks: List[RetrievedChunk] = prep_result["chunks"]
        claude: ClaudeCodeClient = prep_result["claude"]
        classify_limit = int(os.getenv("LEGAL_GRAPH_CLASSIFY_LIMIT", "10"))
        upserted_ids: List[str] = []
        skipped_ids: List[str] = []
        document_types = _document_types_by_document(chunks)

        for index, chunk in enumerate(chunks):
            document_key = chunk.document_id or chunk.source_pdf_id or chunk.source_pdf_path or chunk.qdrant_collection
            document_type = document_types.get(str(document_key), classify_document_type([chunk.model_dump()]))
            chunk.metadata = dict(chunk.metadata or {})
            chunk.metadata["document_type"] = document_type
            if prep_result["judgments_only"] and document_type != "judgment":
                skipped_ids.append(chunk.qdrant_point_id)
                continue
            node_id = chunk.qdrant_point_id
            existing = dict(graph.nodes[node_id]) if node_id in graph else {}
            if not chunk.section_type:
                chunk.section_type = classify_node_type(chunk.model_dump(), document_type=document_type)
                if chunk.section_type == "unknown" and index < classify_limit and claude.validate_available():
                    classified = claude.classify_node_type(text=chunk.text, metadata=chunk.metadata)
                    if classified:
                        chunk.section_type = classified
            attrs = node_attrs_from_chunk(chunk, existing=existing)
            if node_id in graph:
                graph.nodes[node_id].update(attrs)
            else:
                graph.add_node(node_id, **attrs)
            upserted_ids.append(node_id)

        return {"graph": graph, "upserted_node_ids": upserted_ids, "skipped_node_ids": skipped_ids}

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: Dict[str, Any]) -> str:
        shared["graph"] = exec_result["graph"]
        shared["upserted_node_ids"] = exec_result["upserted_node_ids"]
        shared["skipped_node_ids"] = exec_result["skipped_node_ids"]
        return "default"


class ConnectToExistingGraphNode(BaseNode):
    """Attach newly retrieved chunks to existing graph nodes."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "ConnectToExistingGraph")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "upserted_node_ids": list(shared.get("upserted_node_ids") or []),
            "query": str(shared.get("query") or ""),
            "config": cfg,
            "claude": _claude(shared, cfg),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        graph: nx.MultiDiGraph = prep_result["graph"]
        cfg: LegalGraphConfig = prep_result["config"]
        connected_edge_ids: List[str] = []
        llm_candidates: List[Tuple[str, str]] = []
        seen_llm_pairs: Set[Tuple[str, str]] = set()

        for node_id in prep_result["upserted_node_ids"]:
            if node_id not in graph:
                continue
            metadata_candidates = self._metadata_edges(graph, node_id, cfg)
            connected_edge_ids.extend(metadata_candidates["edge_ids"])
            for pair in metadata_candidates["candidate_pairs"]:
                if pair not in seen_llm_pairs:
                    seen_llm_pairs.add(pair)
                    llm_candidates.append(pair)

            semantic = self._semantic_edges(graph, node_id, cfg, metadata_candidates["candidate_nodes"])
            connected_edge_ids.extend(semantic["edge_ids"])
            for pair in semantic["candidate_pairs"]:
                if pair not in seen_llm_pairs:
                    seen_llm_pairs.add(pair)
                    llm_candidates.append(pair)

        connected_edge_ids.extend(
            self._llm_edges(
                graph,
                llm_candidates[: cfg.llm_edge_limit],
                prep_result["query"],
                prep_result["claude"],
            )
        )
        return {"graph": graph, "connected_edge_ids": connected_edge_ids}

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: Dict[str, Any]) -> str:
        shared["graph"] = exec_result["graph"]
        shared["connected_edge_ids"] = exec_result["connected_edge_ids"]
        return "default"

    def _metadata_edges(self, graph: nx.MultiDiGraph, node_id: str, cfg: LegalGraphConfig) -> Dict[str, Any]:
        node = graph.nodes[node_id]
        edge_ids: List[str] = []
        candidate_nodes: Set[str] = set()
        candidate_pairs: List[Tuple[str, str]] = []

        relation_fields = [
            ("same_document", "document_id"),
            ("same_judgment", "judgment_id"),
            ("same_source_pdf", "source_pdf_id"),
            ("same_section", "section_title"),
            ("same_page", "page_number"),
        ]
        for relation_type, field in relation_fields:
            targets = nodes_with_same_field(
                graph,
                field,
                node.get(field),
                exclude=node_id,
                limit=cfg.max_candidates_per_node,
            )
            for target in targets:
                if relation_type == "same_page" and not _same_source_family(node, graph.nodes[target]):
                    continue
                candidate_nodes.add(target)
                edge_ids.append(
                    self._add_relation(
                        graph,
                        node_id,
                        target,
                        relation_type,
                        "metadata",
                        f"Shared {field}: {node.get(field)}",
                    )
                )
                edge_ids.append(
                    self._add_relation(
                        graph,
                        target,
                        node_id,
                        relation_type,
                        "metadata",
                        f"Shared {field}: {node.get(field)}",
                    )
                )
                candidate_pairs.append((node_id, target))

        paragraph_index = node.get("paragraph_index")
        if paragraph_index is not None:
            for target, attrs in graph.nodes(data=True):
                if target == node_id or not _same_source_family(node, attrs):
                    continue
                target_index = attrs.get("paragraph_index")
                if target_index == paragraph_index + 1:
                    candidate_nodes.add(str(target))
                    edge_ids.append(
                        self._add_relation(
                            graph,
                            node_id,
                            str(target),
                            "next_paragraph",
                            "metadata",
                            "Consecutive paragraph in the same source",
                        )
                    )
                elif target_index == paragraph_index - 1:
                    candidate_nodes.add(str(target))
                    edge_ids.append(
                        self._add_relation(
                            graph,
                            node_id,
                            str(target),
                            "previous_paragraph",
                            "metadata",
                            "Consecutive paragraph in the same source",
                        )
                    )
                if len(candidate_nodes) >= cfg.max_candidates_per_node:
                    break

        for target, attrs in graph.nodes(data=True):
            if target == node_id:
                continue
            shared_articles = common_values(node.get("cited_articles") or [], attrs.get("cited_articles") or [])
            shared_cases = common_values(node.get("cited_cases") or [], attrs.get("cited_cases") or [])
            if shared_articles:
                candidate_nodes.add(str(target))
                edge_ids.append(
                    self._add_relation(
                        graph,
                        node_id,
                        str(target),
                        "cites_article",
                        "citation_parser",
                        "Discovery link: both chunks reference article(s): " + ", ".join(shared_articles[:5]),
                        evidence=shared_articles[:5],
                    )
                )
                candidate_pairs.append((node_id, str(target)))
            if shared_cases:
                candidate_nodes.add(str(target))
                edge_ids.append(
                    self._add_relation(
                        graph,
                        node_id,
                        str(target),
                        "cites_case",
                        "citation_parser",
                        "Discovery link: both chunks reference case(s): " + ", ".join(shared_cases[:5]),
                        evidence=shared_cases[:5],
                    )
                )
                candidate_pairs.append((node_id, str(target)))
            if len(candidate_nodes) >= cfg.max_candidates_per_node:
                break

        return {
            "edge_ids": edge_ids,
            "candidate_nodes": candidate_nodes,
            "candidate_pairs": candidate_pairs,
        }

    def _semantic_edges(
        self,
        graph: nx.MultiDiGraph,
        node_id: str,
        cfg: LegalGraphConfig,
        metadata_candidates: Set[str],
    ) -> Dict[str, Any]:
        node = graph.nodes[node_id]
        candidates = set(metadata_candidates)
        for target in graph.nodes:
            if target == node_id:
                continue
            if len(candidates) >= cfg.max_candidates_per_node:
                break
            target_attrs = graph.nodes[target]
            if _same_source_family(node, target_attrs) or _shares_citation(node, target_attrs):
                candidates.add(str(target))

        scored: List[Tuple[float, str]] = []
        for target in candidates:
            sim = cosine_similarity(node.get("vector"), graph.nodes[target].get("vector"))
            if sim is not None and sim >= cfg.semantic_similarity_threshold:
                scored.append((sim, target))
        scored.sort(reverse=True)

        edge_ids: List[str] = []
        candidate_pairs: List[Tuple[str, str]] = []
        for sim, target in scored[: cfg.max_candidates_per_node]:
            explanation = f"Vector cosine similarity {sim:.3f}"
            weight = relation_weight("similar_to", similarity=sim)
            spec = EdgeSpec(
                source=node_id,
                target=target,
                relation_type="similar_to",
                weight=weight,
                confidence=min(1.0, max(0.0, sim)),
                explanation=explanation,
                evidence=[explanation],
                extraction_method="semantic_similarity",
                edge_layer="discovery",
                reasoning_edge=False,
            )
            edge_ids.append(upsert_edge(graph, spec))
            spec_reverse = spec.model_copy(update={"source": target, "target": node_id})
            edge_ids.append(upsert_edge(graph, spec_reverse))
            candidate_pairs.append((node_id, target))
        return {"edge_ids": edge_ids, "candidate_pairs": candidate_pairs}

    def _llm_edges(
        self,
        graph: nx.MultiDiGraph,
        pairs: List[Tuple[str, str]],
        query: str,
        claude: ClaudeCodeClient,
    ) -> List[str]:
        if not pairs or not claude.validate_available():
            return []
        edge_ids: List[str] = []
        for source, target in pairs:
            if source not in graph or target not in graph:
                continue
            inferred = claude.infer_relationship(
                source_node=dict(graph.nodes[source]),
                target_node=dict(graph.nodes[target]),
                query=query,
            )
            if not inferred:
                continue
            relation_type = inferred["relation_type"]
            confidence = float(inferred.get("confidence", 0.0))
            if relation_type not in REASONING_RELATION_TYPES:
                continue
            if confidence < 0.65:
                continue
            if graph.nodes[source].get("judgment_id") != graph.nodes[target].get("judgment_id"):
                continue
            spec = EdgeSpec(
                source=source,
                target=target,
                relation_type=relation_type,
                weight=relation_weight(relation_type),
                confidence=confidence,
                explanation=str(inferred.get("explanation") or ""),
                evidence=list(inferred.get("evidence") or []),
                extraction_method="llm_inference",
                edge_layer="reasoning",
                reasoning_edge=True,
            )
            edge_ids.append(upsert_edge(graph, spec))
        return edge_ids

    def _add_relation(
        self,
        graph: nx.MultiDiGraph,
        source: str,
        target: str,
        relation_type: str,
        extraction_method: str,
        explanation: str,
        *,
        evidence: Optional[List[str]] = None,
    ) -> str:
        spec = EdgeSpec(
            source=source,
            target=target,
            relation_type=relation_type,
            weight=10.0,
            confidence=1.0 if extraction_method == "metadata" else 0.85,
            explanation=explanation,
            evidence=evidence or [],
            extraction_method=extraction_method,
            edge_layer="discovery",
            reasoning_edge=False,
        )
        return upsert_edge(graph, spec)


class SelectStartGoalNode(BaseNode):
    """Choose start and goal nodes for legal reasoning search."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "SelectStartGoal")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "upserted_node_ids": list(shared.get("upserted_node_ids") or []),
            "target_node_id": shared.get("target_node_id") or shared.get("goal_node_id"),
            "cross_case": bool(shared.get("cross_case", cfg.cross_case)),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Optional[str]]:
        graph: nx.MultiDiGraph = prep_result["graph"]
        upserted_ids: List[str] = [node_id for node_id in prep_result["upserted_node_ids"] if node_id in graph]
        if not upserted_ids:
            return {"start_node_id": None, "goal_node_id": None}

        start = max(
            upserted_ids,
            key=lambda node_id: graph.nodes[node_id].get("qdrant_score")
            if graph.nodes[node_id].get("qdrant_score") is not None
            else -1.0,
        )
        explicit_goal = prep_result.get("target_node_id")
        if explicit_goal and explicit_goal in graph:
            if not prep_result["cross_case"]:
                if graph.nodes[start].get("judgment_id") != graph.nodes[explicit_goal].get("judgment_id"):
                    return {"start_node_id": start, "goal_node_id": None}
            return {"start_node_id": start, "goal_node_id": explicit_goal}

        start_judgment_id = graph.nodes[start].get("judgment_id")
        scoped_ids = [
            node_id
            for node_id in upserted_ids
            if prep_result["cross_case"] or graph.nodes[node_id].get("judgment_id") == start_judgment_id
        ]
        goal = _choose_goal_node(graph, scoped_ids)
        if not goal:
            start_attrs = graph.nodes[start]
            family_nodes = [
                str(node_id)
                for node_id, attrs in graph.nodes(data=True)
                if str(node_id) != start
                and _same_source_family(start_attrs, attrs)
                and (prep_result["cross_case"] or attrs.get("judgment_id") == start_judgment_id)
            ]
            goal = _choose_goal_node(graph, family_nodes)
        return {"start_node_id": start, "goal_node_id": goal or start}

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: Dict[str, Optional[str]]) -> str:
        shared["start_node_id"] = exec_result["start_node_id"]
        shared["goal_node_id"] = exec_result["goal_node_id"]
        return "default"


class GraphSearchNode(BaseNode):
    """Find a legal reasoning path using only reasoning edges."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "GraphSearch")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "start_node_id": shared.get("start_node_id"),
            "goal_node_id": shared.get("goal_node_id"),
            "upserted_node_ids": list(shared.get("upserted_node_ids") or []),
            "cross_case": bool(shared.get("cross_case", cfg.cross_case)),
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        graph: nx.MultiDiGraph = prep_result["graph"]
        start = prep_result.get("start_node_id")
        goal = prep_result.get("goal_node_id")
        path: List[str] = []
        search_method = "none"
        status = "no_reasoning_path"
        message = "No legal reasoning path exists yet. Discovery links exist, but they are not valid reasoning edges."
        suggested_action = "Run LLM relationship inference on this judgment."

        if start and goal and start in graph and goal in graph:
            if start == goal:
                path = [start]
                search_method = "single_node"
                status = "ok"
                message = ""
                suggested_action = ""
            else:
                reasoning_graph = build_reasoning_subgraph(graph, cross_case=prep_result["cross_case"])
                path, search_method = self._find_path(reasoning_graph, graph, start, goal)
                if path and validate_reasoning_path(graph, path, cross_case=prep_result["cross_case"]):
                    status = "ok"
                    message = ""
                    suggested_action = ""
                else:
                    path = []
                    search_method = "no_reasoning_path"

        return {
            "reasoning_path": _path_steps(graph, path),
            "reasoning_path_node_ids": path,
            "graph_search_method": search_method,
            "status": status,
            "message": message,
            "suggested_action": suggested_action,
        }

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: Dict[str, Any]) -> str:
        shared["reasoning_path"] = exec_result["reasoning_path"]
        shared["reasoning_path_node_ids"] = exec_result["reasoning_path_node_ids"]
        shared["graph_search_method"] = exec_result["graph_search_method"]
        shared["graph_search_status"] = exec_result["status"]
        shared["graph_search_message"] = exec_result["message"]
        shared["suggested_action"] = exec_result["suggested_action"]
        return "default"

    def _find_path(self, reasoning_graph: nx.DiGraph, graph: nx.MultiDiGraph, start: str, goal: str) -> Tuple[List[str], str]:
        if start not in reasoning_graph or goal not in reasoning_graph:
            return [], "no_reasoning_path"
        try:
            return nx.astar_path(
                reasoning_graph,
                start,
                goal,
                heuristic=lambda node_id, goal_id: _astar_heuristic(graph, str(node_id), str(goal_id)),
                weight="weight",
            ), "astar"
        except Exception:
            pass
        try:
            return nx.dijkstra_path(reasoning_graph, start, goal, weight="weight"), "dijkstra"
        except Exception:
            pass
        try:
            return nx.shortest_path(reasoning_graph, start, goal), "bfs"
        except Exception:
            return [], "no_reasoning_path"


class SaveGraphNode(BaseNode):
    """Persist the graph as pickle and optionally GraphML."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "SaveGraph")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "graph_file_path": Path(shared.get("graph_file_path") or cfg.graph_file_path),
            "graphml_file_path": Path(shared.get("graphml_file_path") or cfg.graphml_file_path)
            if (shared.get("graphml_file_path") or cfg.graphml_file_path)
            else None,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        graph: nx.MultiDiGraph = prep_result["graph"]
        graph_file_path: Path = prep_result["graph_file_path"]
        graph_file_path.parent.mkdir(parents=True, exist_ok=True)
        with graph_file_path.open("wb") as fh:
            pickle.dump(graph, fh)

        graphml_path: Optional[Path] = prep_result.get("graphml_file_path")
        graphml_saved = False
        if graphml_path:
            try:
                graphml_path.parent.mkdir(parents=True, exist_ok=True)
                nx.write_graphml(graphml_safe_copy(graph), graphml_path)
                graphml_saved = True
            except Exception as exc:  # noqa: BLE001
                self.logger.warning("GraphML export failed: %s", exc)
        return {
            "graph_file_path": str(graph_file_path),
            "graphml_file_path": str(graphml_path) if graphml_path else None,
            "graphml_saved": graphml_saved,
        }

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: Dict[str, Any]) -> str:
        shared["graph_file_path"] = exec_result["graph_file_path"]
        shared["graphml_file_path"] = exec_result["graphml_file_path"]
        shared["graphml_saved"] = exec_result["graphml_saved"]
        return "default"


class GenerateAnswerNode(BaseNode):
    """Generate a chunk-cited legal answer from the reasoning path."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "GenerateAnswer")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        cfg = _config(shared)
        return {
            "graph": ensure_legal_graph(shared.get("graph")),
            "query": str(shared.get("query") or ""),
            "reasoning_path": list(shared.get("reasoning_path") or []),
            "reasoning_path_node_ids": list(shared.get("reasoning_path_node_ids") or []),
            "claude": _claude(shared, cfg),
        }

    def exec(self, prep_result: Dict[str, Any]) -> FinalAnswer:
        graph: nx.MultiDiGraph = prep_result["graph"]
        path_node_ids: List[str] = [node_id for node_id in prep_result["reasoning_path_node_ids"] if node_id in graph]
        supporting_chunks = [_supporting_chunk_payload(graph, node_id) for node_id in path_node_ids]
        supporting_chunk_ids = [
            str(item.get("chunk_id") or item.get("qdrant_point_id"))
            for item in supporting_chunks
            if item.get("chunk_id") or item.get("qdrant_point_id")
        ]
        citations = [
            citation_from_source(get_source_from_graph_node(graph, node_id))
            for node_id in path_node_ids
            if node_id in graph
        ]

        if not supporting_chunk_ids:
            return FinalAnswer(
                answer="Aucune réponse juridique ne peut être générée sans chunks sourcés.",
                supporting_chunks=[],
                reasoning_path=[],
                confidence_score=0.0,
                citations=[],
                warnings=["no_supporting_chunks"],
            )

        claude: ClaudeCodeClient = prep_result["claude"]
        generated = claude.generate_legal_answer(
            query=prep_result["query"],
            path_steps=prep_result["reasoning_path"],
            supporting_chunks=supporting_chunks,
        )
        if isinstance(generated, dict) and generated.get("answer"):
            returned_chunks = [
                str(chunk_id)
                for chunk_id in generated.get("supporting_chunks", [])
                if str(chunk_id) in supporting_chunk_ids
            ] or supporting_chunk_ids
            returned_citations = [
                str(citation) for citation in generated.get("citations", []) if str(citation).strip()
            ] or citations
            return FinalAnswer(
                answer=str(generated.get("answer") or ""),
                supporting_chunks=returned_chunks,
                reasoning_path=generated.get("reasoning_path") or prep_result["reasoning_path"],
                confidence_score=_float(generated.get("confidence_score"), 0.65),
                citations=returned_citations,
                warnings=[],
                raw_llm_output=str(generated)[:4000],
            )

        answer_lines = [
            "Réponse fondée uniquement sur les chunks récupérés:",
            "",
        ]
        for item in supporting_chunks[:5]:
            answer_lines.append(f"- {item.get('chunk_id')}: {item.get('text_preview', '')}")
        return FinalAnswer(
            answer="\n".join(answer_lines).strip(),
            supporting_chunks=supporting_chunk_ids,
            reasoning_path=prep_result["reasoning_path"],
            confidence_score=0.35,
            citations=citations,
            warnings=["claude_unavailable_or_invalid_json"],
        )

    def post(self, shared: Dict[str, Any], prep_result: Dict[str, Any], exec_result: FinalAnswer) -> str:
        shared["final_answer"] = exec_result.model_dump()
        return "default"


def _same_source_family(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    for field in ("document_id", "judgment_id", "source_pdf_id", "source_pdf_path"):
        if left.get(field) and left.get(field) == right.get(field):
            return True
    return False


def _shares_citation(left: Dict[str, Any], right: Dict[str, Any]) -> bool:
    return bool(
        common_values(left.get("cited_articles") or [], right.get("cited_articles") or [])
        or common_values(left.get("cited_cases") or [], right.get("cited_cases") or [])
    )


def classify_document_type(chunks: List[Dict[str, Any]]) -> str:
    """Classify a source document before adding it to a reasoning graph."""
    raw = " ".join(
        str(value)
        for chunk in chunks
        for value in [
            chunk.get("source_pdf_path"),
            chunk.get("section_title"),
            chunk.get("text"),
            (chunk.get("metadata") or {}).get("title"),
            (chunk.get("metadata") or {}).get("doc_type"),
        ]
        if value
    ).lower()
    if any(token in raw for token in ("contrat", "contract", "agreement", "clause", "signature", "cocontractant")):
        return "contract"
    if any(token in raw for token in ("bulletin officiel", "bo_", "dahir", "décret", "decret", "loi n°", "القانون رقم")):
        return "statute"
    if any(
        token in raw
        for token in (
            "محكمة",
            "قرار",
            "حكم",
            "استئناف",
            "السلطة القضائية",
            "المملكة المغربية",
            "ملف رقم",
            "tribunal",
            "cour d'appel",
            "jugement",
        )
    ):
        return "judgment"
    return "unknown"


def classify_node_type(chunk: Dict[str, Any], *, document_type: Optional[str] = None) -> str:
    """Classify a chunk into judgment or contract-specific node types."""
    metadata = chunk.get("metadata") or {}
    if chunk.get("section_type"):
        section_type = str(chunk["section_type"])
        legacy_map = {
            "claim": "party_claim",
            "supporting_fact": "facts",
            "reasoning": "court_reasoning",
            "decision": "final_decision",
            "ruling": "final_decision",
            "conclusion": "final_decision",
        }
        if section_type in legacy_map:
            return legacy_map[section_type]
        if section_type in JUDGMENT_NODE_TYPES or section_type in CONTRACT_NODE_TYPES:
            return section_type
    document_type = document_type or str(metadata.get("document_type") or "unknown")
    raw = " ".join(
        str(value)
        for value in [
            metadata.get("section_type"),
            metadata.get("doc_type"),
            metadata.get("title"),
            chunk.get("section_title"),
            chunk.get("text", "")[:2500],
        ]
        if value
    ).lower()

    if document_type == "contract":
        if any(token in raw for token in ("confidential", "confidentialité", "سرية")):
            return "confidentiality_clause"
        if any(token in raw for token in ("résiliation", "termination", "فسخ")):
            return "termination_clause"
        if any(token in raw for token in ("responsabilité", "liability", "garantie")):
            return "liability_clause"
        if any(token in raw for token in ("paiement", "payment", "prix", "montant")):
            return "payment_clause"
        if any(token in raw for token in ("livraison", "delivery", "réception")):
            return "delivery_clause"
        if any(token in raw for token in ("litige", "dispute", "tribunal compétent", "arbitrage")):
            return "dispute_resolution"
        if any(token in raw for token in ("droit applicable", "governing law", "loi applicable")):
            return "governing_law"
        if any(token in raw for token in ("parties", "entre les soussignés", "société")):
            return "party_definition"
        if any(token in raw for token in ("objet", "object")):
            return "object"
        if any(token in raw for token in ("obligation", "s'engage", "engagement")):
            return "obligation"
        if any(token in raw for token in ("signature", "signé")):
            return "signature"
        if any(token in raw for token in ("annexe", "annex")):
            return "annex"
        return "unknown"

    if any(token in raw for token in ("final", "decision", "ruling", "conclusion", "par ces motifs", "حكمت", "قررت", "وتطبيقا")):
        return "final_decision"
    if any(token in raw for token in ("اختصاص", "jurisdiction", "compétence")):
        return "jurisdiction"
    if any(token in raw for token in ("قبول", "admissibilité", "irrecevable", "admissible")):
        return "admissibility"
    if any(token in raw for token in ("تعويض", "dommages", "damages", "indemnité")):
        return "damages"
    if any(token in raw for token in ("الصائر", "dépens", "frais", "costs")):
        return "costs"
    if any(token in raw for token in ("حيث", "motif", "attendu", "تعليل", "considérant")):
        return "court_reasoning"
    if any(token in raw for token in ("تحليل", "analysis", "analyse")):
        return "legal_analysis"
    if any(token in raw for token in ("المادة", "الفصل", "article", "مدونة", "القانون")):
        return "applicable_rule"
    if any(token in raw for token in ("وسيلة", "دفع", "argument", "أثار", "تمسك")):
        if any(token in raw for token in ("المستأنف عليه", "المدعى عليها", "defendant", "défendeur")):
            return "defendant_argument"
        if any(token in raw for token in ("المستأنفة", "المدعية", "plaintiff", "demandeur")):
            return "plaintiff_argument"
        return "party_claim"
    if any(token in raw for token in ("طلب", "claim", "demande", "ملتمس", "يلتمس")):
        return "party_claim"
    if any(token in raw for token in ("خبرة", "وثيقة", "إثبات", "preuve", "evidence")):
        return "evidence"
    if any(token in raw for token in ("وقائع", "facts", "fait", "عرض")):
        return "facts"
    if any(token in raw for token in ("إجراء", "procedure", "procédure", "مسطرة")):
        return "procedure"
    if any(token in raw for token in ("سابقة", "precedent", "اجتهاد")):
        return "precedent"
    return "unknown"


def _document_types_by_document(chunks: List[RetrievedChunk]) -> Dict[str, str]:
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for chunk in chunks:
        document_key = chunk.document_id or chunk.source_pdf_id or chunk.source_pdf_path or chunk.qdrant_collection
        grouped.setdefault(str(document_key), []).append(chunk.model_dump())
    return {document_key: classify_document_type(values) for document_key, values in grouped.items()}


def infer_reasoning_edges_for_judgment(
    graph: nx.MultiDiGraph,
    judgment_id: str,
    claude: ClaudeCodeClient,
    *,
    query: str = "",
    limit: int = 40,
) -> List[str]:
    """Infer legal reasoning edges within one judgment using Claude Code."""
    if not claude.validate_available():
        return []
    nodes = [
        str(node_id)
        for node_id, attrs in graph.nodes(data=True)
        if attrs.get("judgment_id") == judgment_id
    ]
    by_type: Dict[str, List[str]] = {}
    for node_id in nodes:
        node_type = str(graph.nodes[node_id].get("section_type") or "unknown")
        by_type.setdefault(node_type, []).append(node_id)

    candidate_type_pairs = [
        ("facts", "evidence"),
        ("facts", "legal_issue"),
        ("party_claim", "court_reasoning"),
        ("defendant_argument", "court_reasoning"),
        ("plaintiff_argument", "court_reasoning"),
        ("applicable_rule", "court_reasoning"),
        ("precedent", "court_reasoning"),
        ("court_reasoning", "final_decision"),
        ("legal_analysis", "final_decision"),
        ("damages", "final_decision"),
        ("costs", "final_decision"),
    ]
    candidate_pairs: List[Tuple[str, str]] = []
    for source_type, target_type in candidate_type_pairs:
        for source in by_type.get(source_type, []):
            for target in by_type.get(target_type, []):
                if source != target:
                    candidate_pairs.append((source, target))
                if len(candidate_pairs) >= limit:
                    break
            if len(candidate_pairs) >= limit:
                break
        if len(candidate_pairs) >= limit:
            break

    edge_ids: List[str] = []
    for source, target in candidate_pairs:
        inferred = claude.infer_relationship(
            source_node=dict(graph.nodes[source]),
            target_node=dict(graph.nodes[target]),
            query=query,
        )
        if not inferred:
            continue
        relation_type = inferred.get("relation_type")
        confidence = float(inferred.get("confidence") or 0.0)
        if relation_type not in REASONING_RELATION_TYPES or confidence < 0.65:
            continue
        spec = EdgeSpec(
            source=source,
            target=target,
            relation_type=relation_type,
            weight=relation_weight(relation_type),
            confidence=confidence,
            explanation=str(inferred.get("explanation") or ""),
            evidence=list(inferred.get("evidence") or []),
            extraction_method="llm_inference",
            edge_layer="reasoning",
            reasoning_edge=True,
        )
        edge_ids.append(upsert_edge(graph, spec))
    return edge_ids


def _heuristic_node_type(chunk: RetrievedChunk) -> str:
    document_type = str((chunk.metadata or {}).get("document_type") or "unknown")
    return classify_node_type(chunk.model_dump(), document_type=document_type)


def _choose_goal_node(graph: nx.MultiDiGraph, node_ids: List[str]) -> Optional[str]:
    final_types = {
        "final_decision",
        "final_ruling",
        "decision",
        "ruling",
        "conclusion",
    }
    candidates = [
        node_id
        for node_id in node_ids
        if str(graph.nodes[node_id].get("section_type") or "").lower() in final_types
    ]
    if not candidates:
        candidates = [
            node_id
            for node_id in node_ids
            if str(graph.nodes[node_id].get("section_type") or "").lower() in GOAL_SECTION_TYPES
            or "reason" in str(graph.nodes[node_id].get("section_type") or "").lower()
            or "motif" in str(graph.nodes[node_id].get("section_title") or "").lower()
        ]
    if not candidates:
        return None
    return max(
        candidates,
        key=lambda node_id: graph.nodes[node_id].get("qdrant_score")
        if graph.nodes[node_id].get("qdrant_score") is not None
        else -1.0,
    )


def _astar_heuristic(graph: nx.MultiDiGraph, node_id: str, goal_id: str) -> float:
    if node_id not in graph or goal_id not in graph:
        return 1.0
    node = graph.nodes[node_id]
    goal = graph.nodes[goal_id]
    similarity = cosine_similarity(node.get("vector"), goal.get("vector"))
    semantic_distance = 1.0 - similarity if similarity is not None else 0.5
    priority = NODE_TYPE_PRIORITY.get(str(node.get("section_type") or "").lower(), 0.35)
    return max(0.0, semantic_distance + priority)


def _path_steps(graph: nx.MultiDiGraph, path: List[str]) -> List[Dict[str, Any]]:
    steps: List[Dict[str, Any]] = []
    for index, node_id in enumerate(path):
        attrs = graph.nodes[node_id]
        edge = None
        if index < len(path) - 1:
            edge = best_edge_between(graph, node_id, path[index + 1]) or best_edge_between(graph, path[index + 1], node_id)
        step = ReasoningPathStep(
            node_id=node_id,
            chunk_id=attrs.get("chunk_id"),
            section_type=attrs.get("section_type"),
            section_title=attrs.get("section_title"),
            text_preview=attrs.get("text_preview") or text_preview(attrs.get("text", "")),
            relation_to_next=edge.get("relation_type") if edge else None,
            edge_explanation=edge.get("explanation") if edge else None,
            source=get_source_from_graph_node(graph, node_id),
        )
        steps.append(step.model_dump())
    return steps


def _supporting_chunk_payload(graph: nx.MultiDiGraph, node_id: str) -> Dict[str, Any]:
    attrs = graph.nodes[node_id]
    return {
        "qdrant_point_id": attrs.get("qdrant_point_id"),
        "chunk_id": attrs.get("chunk_id"),
        "document_id": attrs.get("document_id"),
        "judgment_id": attrs.get("judgment_id"),
        "source_pdf_path": attrs.get("source_pdf_path"),
        "page_number": attrs.get("page_number"),
        "section_title": attrs.get("section_title"),
        "section_type": attrs.get("section_type"),
        "text_preview": attrs.get("text_preview") or text_preview(attrs.get("text", "")),
        "text": attrs.get("text") or "",
        "citation": citation_from_source(get_source_from_graph_node(graph, node_id)),
    }


def _float(value: Any, default: float) -> float:
    try:
        return float(value)
    except Exception:
        return default
