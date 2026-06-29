"""Self-QA tests for the unified all-judgments GraphRAG memory layer."""

from __future__ import annotations

import pickle

import networkx as nx
import pytest

from nodes.legal_graph.graph_utils import build_reasoning_subgraph, validate_reasoning_path
from services.legal_graph.explorer import load_graph_from_directory, path_from_node, query_subgraph
from services.legal_graph.unified_builder import build_unified_judgments_graph, data_root, unified_dir


def _node_texts(graph: nx.MultiDiGraph, node_ids: list[str]) -> str:
    parts = []
    for node_id in node_ids:
        attrs = graph.nodes.get(node_id, {})
        parts.append(str(attrs.get("text") or attrs.get("text_preview") or ""))
    return "\n".join(parts).lower()


@pytest.fixture(scope="module")
def unified_graph() -> nx.MultiDiGraph:
    pkl = unified_dir() / "legal_graph.pkl"
    if not pkl.exists():
        pytest.skip("Unified graph not built — run: python scripts/build_unified_judgments_graph.py --consolidate")
    graph = load_graph_from_directory(unified_dir())
    assert graph.number_of_nodes() > 0
    return graph


class TestUnifiedGraphStructure:
    def test_single_pkl_artifact_exists(self):
        pkl = unified_dir() / "legal_graph.pkl"
        if not pkl.exists():
            pytest.skip("Unified graph not built")
        legal_pkls = list(data_root().glob("legal_graph*/**/*.pkl"))
        assert len(legal_pkls) == 1
        assert legal_pkls[0].name == "legal_graph.pkl"
        assert legal_pkls[0].parent.name == "legal_graph_unified"

    def test_graph_has_multiple_judgments(self, unified_graph: nx.MultiDiGraph):
        judgment_ids = {
            str(attrs.get("judgment_id") or attrs.get("document_id"))
            for _, attrs in unified_graph.nodes(data=True)
        }
        assert len(judgment_ids) >= 2

    def test_has_reasoning_edges(self, unified_graph: nx.MultiDiGraph):
        reasoning = build_reasoning_subgraph(unified_graph, cross_case=True)
        assert reasoning.number_of_edges() > 0

    def test_excludes_contracts(self, unified_graph: nx.MultiDiGraph):
        titles = set()
        for _nid, attrs in unified_graph.nodes(data=True):
            meta = attrs.get("metadata") or {}
            title = str(meta.get("title") or attrs.get("source_pdf_path") or "").lower()
            if title:
                titles.add(title)
        assert not any("contrat" in t or "ns_factory" in t for t in titles)
        assert any("camscanner" in t or "قرار" in t for t in titles)


class TestUnifiedGraphSelfQA:
    def test_article_503_commerce(self, unified_graph: nx.MultiDiGraph):
        result = query_subgraph(
            unified_graph,
            query="article 503 modèle de commerce expert comptable",
        )
        assert result.node_ids, result.message
        blob = _node_texts(unified_graph, result.node_ids)
        assert "503" in blob or "المدونة" in blob or "خبير" in blob or "expert" in blob

    def test_bank_credit_dispute(self, unified_graph: nx.MultiDiGraph):
        result = query_subgraph(
            unified_graph,
            query="قرض بنكي مديونية فوائد استئناف",
        )
        assert result.node_ids
        blob = _node_texts(unified_graph, result.node_ids)
        assert any(token in blob for token in ("قرض", "مديون", "بنك", "فوائ", "درهم", "crédit", "compte"))

    def test_facts_to_decision_preset(self, unified_graph: nx.MultiDiGraph):
        result = query_subgraph(unified_graph, preset_id="facts_to_decision", depth=4)
        assert result.seeds
        assert result.node_ids
        types = {
            str(unified_graph.nodes[nid].get("section_type") or "")
            for nid in result.node_ids
        }
        assert types & {"facts", "court_reasoning", "final_decision", "party_claim", "applicable_rule"}

    def test_reasoning_path_within_judgment(self, unified_graph: nx.MultiDiGraph):
        seeds = query_subgraph(
            unified_graph,
            query="محكمة الاستئناf التجارية الدar البيضاء",
        ).seeds
        assert seeds
        path = path_from_node(unified_graph, seeds[0], query="Comment le tribunal décide-t-il ?")
        assert path.path_node_ids
        if len(path.path_node_ids) > 1:
            assert validate_reasoning_path(
                unified_graph,
                path.path_node_ids,
                cross_case=False,
            )


class TestUnifiedGraphPersistence:
    def test_pickle_roundtrip(self):
        pkl = unified_dir() / "legal_graph.pkl"
        if not pkl.exists():
            pytest.skip("Unified graph not built")
        assert pkl.exists()
        with pkl.open("rb") as fh:
            graph = pickle.load(fh)
        assert isinstance(graph, nx.MultiDiGraph)
        assert graph.graph.get("unified_legal") is True or graph.graph.get("unified_judgments") is True
        assert graph.number_of_nodes() > 0
