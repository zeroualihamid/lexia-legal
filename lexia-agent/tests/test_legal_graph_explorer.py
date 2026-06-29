from __future__ import annotations

import pickle

import networkx as nx

from nodes.legal_graph.graph_utils import ensure_legal_graph, upsert_edge
from nodes.legal_graph.models import EdgeSpec
from services.legal_graph.explorer import (
    list_presets,
    load_graph_from_directory,
    path_from_node,
    query_subgraph,
    summarize_reasoning_path,
)


def _chunk_node(
    graph: nx.MultiDiGraph,
    point_id: str,
    *,
    paragraph_index: int,
    section_type: str,
    text: str,
    judgment_id: str = "judgment-1",
) -> str:
    graph.add_node(
        point_id,
        qdrant_point_id=point_id,
        chunk_id=f"chunk-{point_id}",
        document_id="doc-1",
        judgment_id=judgment_id,
        paragraph_index=paragraph_index,
        section_type=section_type,
        section_title=f"Section {paragraph_index}",
        text=text,
        text_preview=text[:120],
        vector=[1.0, 0.0, 0.0] if section_type == "claim" else [0.5, 0.5, 0.0],
    )
    return point_id


def _reasoning_edge(graph: nx.MultiDiGraph, source: str, target: str, relation: str) -> None:
    upsert_edge(
        graph,
        EdgeSpec(
            source=source,
            target=target,
            relation_type=relation,
            weight=2.0,
            confidence=0.9,
            explanation=f"{source} {relation} {target}",
            evidence=[],
            extraction_method="llm_inference",
            edge_layer="reasoning",
            reasoning_edge=True,
        ),
    )


def _mini_judgment_graph() -> nx.MultiDiGraph:
    graph = ensure_legal_graph()
    claim = _chunk_node(
        graph,
        "p-claim",
        paragraph_index=0,
        section_type="claim",
        text="Le demandeur sollicite la résiliation du contrat pour manquement.",
    )
    facts = _chunk_node(
        graph,
        "p-facts",
        paragraph_index=1,
        section_type="facts",
        text="Il ressort des faits que le défendeur n'a pas exécuté ses obligations.",
    )
    reasoning = _chunk_node(
        graph,
        "p-reason",
        paragraph_index=2,
        section_type="court_reasoning",
        text="La cour estime que le manquement est établi et que la règle de droit s'applique.",
    )
    decision = _chunk_node(
        graph,
        "p-decision",
        paragraph_index=3,
        section_type="final_decision",
        text="Par ces motifs, la cour accorde la demande et condamne le défendeur.",
    )
    _reasoning_edge(graph, claim, facts, "supports")
    _reasoning_edge(graph, facts, reasoning, "leads_to")
    _reasoning_edge(graph, reasoning, decision, "grants")
    return graph


def test_list_presets_returns_five_examples():
    presets = list_presets()
    assert len(presets) == 5
    assert presets[0]["id"] == "facts_to_decision"


def test_query_subgraph_finds_reasoning_nodes():
    graph = _mini_judgment_graph()
    result = query_subgraph(graph, preset_id="facts_to_decision", depth=3)
    assert result.seeds
    assert "p-claim" in result.node_ids or "p-facts" in result.node_ids
    assert "p-decision" in result.node_ids
    assert len(result.graph["edges"]) >= 2


def test_path_from_claim_reaches_decision(tmp_path):
    graph = _mini_judgment_graph()
    result = path_from_node(
        graph,
        "p-claim",
        query="Comment le tribunal passe-t-il des faits à la décision ?",
    )
    assert result.status == "ok"
    assert result.path_node_ids[0] == "p-claim"
    assert result.path_node_ids[-1] == "p-decision"
    assert result.search_method in {"astar", "dijkstra", "bfs"}
    assert result.summary
    assert len(result.path_steps) >= 2


def test_summarize_reasoning_path_fallback_without_llm():
    steps = [
        {
            "section_type": "facts",
            "text_preview": "Faits du litige",
            "relation_to_next": "leads_to",
            "edge_explanation": "Les faits mènent au raisonnement",
        },
        {
            "section_type": "final_decision",
            "text_preview": "Décision finale",
            "relation_to_next": None,
        },
    ]
    summary = summarize_reasoning_path("Question test", steps)
    assert summary["summary"]
    assert summary["key_steps"]


def test_load_graph_from_directory(tmp_path):
    graph = _mini_judgment_graph()
    target = tmp_path / "legal_graph.pkl"
    with target.open("wb") as fh:
        pickle.dump(graph, fh)

    loaded = load_graph_from_directory(tmp_path)
    assert loaded.number_of_nodes() == 4
    assert loaded.number_of_edges() == 3


def test_query_subgraph_works_with_generic_judgment_section_type():
    """Unified graph stores doc_type as section_type — explorer must infer legal roles."""
    graph = ensure_legal_graph()
    nodes = [
        ("p-adm", 0, "Il ressort des faits que le défendeur n'a pas exécuté ses obligations."),
        ("p-reason", 1, "Attendu que le manquement est établi, la cour applique la règle."),
        ("p-decision", 2, "Par ces motifs, la cour accorde la demande."),
    ]
    for point_id, paragraph_index, text in nodes:
        graph.add_node(
            point_id,
            qdrant_point_id=point_id,
            document_id="doc-1",
            judgment_id="judgment-1",
            paragraph_index=paragraph_index,
            section_type="judgment",
            text=text,
            text_preview=text[:120],
            metadata={"doc_type": "judgment", "document_type": "judgment"},
        )
        if paragraph_index > 0:
            upsert_edge(
                graph,
                EdgeSpec(
                    source=nodes[paragraph_index - 1][0],
                    target=point_id,
                    relation_type="next_paragraph",
                    weight=1.0,
                    confidence=1.0,
                    explanation="sequence",
                    evidence=[],
                    extraction_method="metadata",
                    edge_layer="discovery",
                    reasoning_edge=False,
                ),
            )

    result = query_subgraph(graph, preset_id="facts_to_decision", depth=3)
    assert result.seeds, result.message
    assert len(result.node_ids) >= 2
    assert len(result.graph["nodes"]) >= 2
    assert len(result.graph["edges"]) >= 1


def test_judgment_preset_excludes_contract_nodes():
    graph = ensure_legal_graph()
    _chunk_node(
        graph,
        "p-judgment",
        paragraph_index=0,
        section_type="facts",
        text="Il ressort des faits que le défendeur n'a pas exécuté ses obligations.",
    )
    graph.add_node(
        "p-contract",
        qdrant_point_id="p-contract",
        chunk_id="chunk-contract",
        document_id="contract-doc",
        judgment_id="contract-doc",
        paragraph_index=7,
        section_type="final_decision",
        text="- Application web back-office gestionnaire (React) et API REST sécurisée.",
        text_preview="- Application web back-office gestionnaire (React) et API REST sécurisée.",
        metadata={"doc_type": "contract", "title": "NS_FACTORY_Contrat.pdf"},
    )

    result = query_subgraph(graph, preset_id="facts_to_decision")
    node_ids = set(result.node_ids)
    assert "p-judgment" in node_ids
    assert "p-contract" not in node_ids
