from __future__ import annotations

import pickle

import networkx as nx

from nodes.legal_graph.graph_utils import ensure_legal_graph, get_source_from_graph_node, upsert_edge
from nodes.legal_graph.legal_graph_nodes import (
    ConnectToExistingGraphNode,
    GenerateAnswerNode,
    GraphSearchNode,
    LoadGraphNode,
    SaveGraphNode,
    SelectStartGoalNode,
    UpsertChunkNodesNode,
    classify_document_type,
)
from nodes.legal_graph.models import EdgeSpec, LegalGraphConfig


def _chunk(
    point_id: str,
    *,
    paragraph_index: int,
    section_type: str = "court_reasoning",
    score: float = 0.9,
    document_id: str = "doc-1",
    judgment_id: str = "judgment-1",
    title: str = "doc-1.pdf",
    text: str | None = None,
):
    return {
        "qdrant_point_id": point_id,
        "chunk_id": f"chunk-{point_id}",
        "document_id": document_id,
        "judgment_id": judgment_id,
        "source_pdf_id": "pdf-1",
        "source_pdf_path": f"/minio/judgments/{title}",
        "qdrant_collection": "judgments_civil",
        "page_number": 3,
        "paragraph_index": paragraph_index,
        "section_title": title,
        "section_type": section_type,
        "text": text or f"المملكة المغربية محكمة قرار حكم Legal text for {point_id}",
        "text_preview": text or f"Legal text for {point_id}",
        "legal_entities": ["court"],
        "cited_articles": ["article 230"],
        "qdrant_score": score,
        "vector": [1.0, 0.0, 0.0] if point_id == "p1" else [0.99, 0.01, 0.0],
        "metadata": {"chunk_id": f"chunk-{point_id}", "title": title},
    }


def _shared(tmp_path, graph=None):
    return {
        "graph": graph or ensure_legal_graph(),
        "legal_graph_config": LegalGraphConfig(
            graph_file_path=tmp_path / "legal_graph.pkl",
            graphml_file_path=tmp_path / "legal_graph.graphml",
            qdrant_collections=["judgments_civil"],
            semantic_similarity_threshold=0.7,
            llm_edge_limit=0,
        ),
    }


def test_upsert_chunk_nodes_is_idempotent_and_preserves_source_fields(tmp_path):
    shared = _shared(tmp_path)
    shared["retrieved_chunks"] = [_chunk("p1", paragraph_index=1)]

    UpsertChunkNodesNode().run(shared)
    UpsertChunkNodesNode().run(shared)

    graph = shared["graph"]
    assert graph.number_of_nodes() == 1
    assert shared["upserted_node_ids"] == ["p1"]
    assert graph.nodes["p1"]["qdrant_point_id"] == "p1"
    assert graph.nodes["p1"]["chunk_id"] == "chunk-p1"
    assert graph.nodes["p1"]["source_pdf_path"] == "/minio/judgments/doc-1.pdf"
    assert graph.nodes["p1"]["metadata"]["chunk_id"] == "chunk-p1"


def test_connect_node_adds_metadata_citation_and_semantic_edges_without_duplicates(tmp_path):
    shared = _shared(tmp_path)
    shared["retrieved_chunks"] = [
        _chunk("p1", paragraph_index=1, score=0.95),
        _chunk("p2", paragraph_index=2, section_type="final_decision", score=0.8),
    ]
    UpsertChunkNodesNode().run(shared)

    ConnectToExistingGraphNode().run(shared)
    graph = shared["graph"]
    edge_count = graph.number_of_edges()

    assert graph.has_edge("p1", "p2", key="same_document")
    assert graph.has_edge("p1", "p2", key="next_paragraph")
    assert graph.has_edge("p1", "p2", key="cites_article")
    assert graph.has_edge("p1", "p2", key="similar_to")
    assert graph.edges["p1", "p2", "same_document"]["edge_layer"] == "discovery"
    assert graph.edges["p1", "p2", "same_document"]["reasoning_edge"] is False
    assert graph.edges["p1", "p2", "similar_to"]["reasoning_edge"] is False
    assert graph.edges["p1", "p2", "cites_article"]["reasoning_edge"] is False

    ConnectToExistingGraphNode().run(shared)
    assert graph.number_of_edges() == edge_count


def test_search_save_load_and_generate_fallback_answer(tmp_path):
    shared = _shared(tmp_path)
    shared["query"] = "What did the court decide?"
    shared["retrieved_chunks"] = [
        _chunk("p1", paragraph_index=1, score=0.95),
        _chunk("p2", paragraph_index=2, section_type="final_decision", score=0.8),
    ]
    UpsertChunkNodesNode().run(shared)
    ConnectToExistingGraphNode().run(shared)
    upsert_edge(
        shared["graph"],
        EdgeSpec(
            source="p1",
            target="p2",
            relation_type="leads_to",
            weight=1.0,
            confidence=0.9,
            explanation="The reasoning leads to the final decision.",
            extraction_method="llm_inference",
            edge_layer="reasoning",
            reasoning_edge=True,
        ),
    )
    SelectStartGoalNode().run(shared)
    GraphSearchNode().run(shared)
    GenerateAnswerNode().run(shared)

    assert shared["start_node_id"] == "p1"
    assert shared["goal_node_id"] == "p2"
    assert shared["reasoning_path_node_ids"]
    assert shared["graph_search_status"] == "ok"
    assert "chunk-p1" in shared["final_answer"]["supporting_chunks"]
    assert shared["final_answer"]["citations"]

    SaveGraphNode().run(shared)
    assert shared["graph_file_path"].endswith("legal_graph.pkl")

    with open(shared["graph_file_path"], "rb") as fh:
        persisted = pickle.load(fh)
    assert isinstance(persisted, nx.MultiDiGraph)
    assert "p1" in persisted

    loaded_shared = _shared(tmp_path)
    loaded_shared["graph_file_path"] = shared["graph_file_path"]
    LoadGraphNode().run(loaded_shared)
    source = get_source_from_graph_node(loaded_shared["graph"], "p1")
    assert source["source_pdf_path"] == "/minio/judgments/doc-1.pdf"
    assert source["page_number"] == 3


def test_reasoning_path_must_not_contain_similar_to_edges(tmp_path):
    shared = _shared(tmp_path)
    graph = shared["graph"]
    graph.add_node("a", judgment_id="j1", section_type="party_claim", chunk_id="a")
    graph.add_node("b", judgment_id="j1", section_type="final_decision", chunk_id="b")
    upsert_edge(
        graph,
        EdgeSpec(
            source="a",
            target="b",
            relation_type="similar_to",
            weight=10.0,
            confidence=0.99,
            explanation="semantic only",
            extraction_method="semantic_similarity",
            edge_layer="discovery",
            reasoning_edge=False,
        ),
    )
    shared.update({"start_node_id": "a", "goal_node_id": "b"})
    GraphSearchNode().run(shared)
    assert shared["graph_search_status"] == "no_reasoning_path"
    assert shared["reasoning_path_node_ids"] == []


def test_reasoning_path_must_not_cross_judgment_without_cross_case(tmp_path):
    shared = _shared(tmp_path)
    graph = shared["graph"]
    graph.add_node("a", judgment_id="j1", section_type="party_claim", chunk_id="a")
    graph.add_node("b", judgment_id="j2", section_type="final_decision", chunk_id="b")
    upsert_edge(
        graph,
        EdgeSpec(
            source="a",
            target="b",
            relation_type="leads_to",
            weight=1.0,
            confidence=0.9,
            explanation="bad cross-case edge",
            extraction_method="llm_inference",
            edge_layer="reasoning",
            reasoning_edge=True,
        ),
    )
    shared.update({"start_node_id": "a", "goal_node_id": "b", "cross_case": False})
    GraphSearchNode().run(shared)
    assert shared["graph_search_status"] == "no_reasoning_path"
    assert shared["reasoning_path_node_ids"] == []


def test_no_reasoning_edges_returns_no_reasoning_path_not_semantic_fallback(tmp_path):
    shared = _shared(tmp_path)
    shared["retrieved_chunks"] = [
        _chunk("p1", paragraph_index=1, section_type="party_claim"),
        _chunk("p2", paragraph_index=2, section_type="final_decision"),
    ]
    UpsertChunkNodesNode().run(shared)
    ConnectToExistingGraphNode().run(shared)
    SelectStartGoalNode().run(shared)
    GraphSearchNode().run(shared)
    assert shared["graph_search_status"] == "no_reasoning_path"
    assert shared["graph_search_method"] == "no_reasoning_path"
    assert shared["reasoning_path_node_ids"] == []
    assert "Discovery links exist" in shared["graph_search_message"]


def test_astar_returns_llm_reasoning_chain_exactly(tmp_path):
    shared = _shared(tmp_path)
    shared["retrieved_chunks"] = [
        _chunk("claim", paragraph_index=0, section_type="party_claim", score=1.0),
        _chunk("reasoning", paragraph_index=1, section_type="court_reasoning", score=0.8),
        _chunk("decision", paragraph_index=2, section_type="final_decision", score=0.7),
    ]
    UpsertChunkNodesNode().run(shared)
    for source, target, relation_type in [
        ("claim", "reasoning", "explains"),
        ("reasoning", "decision", "leads_to"),
    ]:
        upsert_edge(
            shared["graph"],
            EdgeSpec(
                source=source,
                target=target,
                relation_type=relation_type,
                weight=1.0,
                confidence=0.9,
                explanation="LLM reasoning edge",
                extraction_method="llm_inference",
                edge_layer="reasoning",
                reasoning_edge=True,
            ),
        )
    shared.update({"start_node_id": "claim", "goal_node_id": "decision"})
    GraphSearchNode().run(shared)
    assert shared["graph_search_method"] == "astar"
    assert shared["reasoning_path_node_ids"] == ["claim", "reasoning", "decision"]


def test_contracts_are_excluded_in_judgments_only_mode(tmp_path):
    shared = _shared(tmp_path)
    shared["judgments_only"] = True
    contract = _chunk(
        "contract-1",
        paragraph_index=0,
        section_type=None,
        document_id="contract-doc",
        judgment_id="contract-doc",
        title="NS_FACTORY_CANTOR_Contrat.pdf",
        text="Contrat entre les parties. Clause de confidentialité et résiliation.",
    )
    judgment = _chunk(
        "judgment-1",
        paragraph_index=0,
        section_type=None,
        document_id="judgment-doc",
        judgment_id="judgment-doc",
        title="CamScanner jugement.pdf",
        text="المملكة المغربية محكمة الاستئناف التجارية قرار حكم ملف رقم",
    )
    assert classify_document_type([contract]) == "contract"
    assert classify_document_type([judgment]) == "judgment"
    shared["retrieved_chunks"] = [contract, judgment]
    UpsertChunkNodesNode().run(shared)
    assert "contract-1" not in shared["graph"]
    assert "judgment-1" in shared["graph"]
    assert shared["skipped_node_ids"] == ["contract-1"]
