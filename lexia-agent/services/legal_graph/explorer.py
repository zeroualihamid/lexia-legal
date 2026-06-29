"""Interactive legal graph exploration for admin UI and MCP tools."""

from __future__ import annotations

import json
import math
import pickle
import re
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Set, Tuple

import networkx as nx

from nodes.legal_graph.graph_utils import (
    build_reasoning_subgraph,
    ensure_legal_graph,
    text_preview,
    validate_reasoning_path,
)
from nodes.legal_graph.legal_graph_nodes import (
    GraphSearchNode,
    _choose_goal_node,
    _path_steps,
    classify_node_type,
)
from nodes.legal_graph.visualization import _node_fill

MAX_SUBGRAPH_NODES = 80
MAX_SUBGRAPH_EDGES = 120

_GENERIC_SECTION_TYPES = frozenset({"judgment", "unknown", "other", "chunk", ""})

_DISCOVERY_RELATIONS = frozenset(
    {
        "same_document",
        "same_judgment",
        "same_source_pdf",
        "same_section",
        "next_paragraph",
        "previous_paragraph",
        "similar_to",
    }
)

_EXAMPLE_QUERIES_RAW = [
    {
        "id": "facts_to_decision",
        "label": "Faits → décision",
        "question": "Comment le tribunal passe-t-il des faits à la décision ?",
        "intent": "Chaîne complète de raisonnement",
        "section_types": ["facts", "claim", "court_reasoning", "final_decision"],
        "relation_boost": [],
    },
    {
        "id": "claims_to_dispositif",
        "label": "Demandes → dispositif",
        "question": "Quels faits et demandes précèdent le dispositif ?",
        "intent": "Parties → issue",
        "section_types": ["party_claim", "plaintiff_argument", "facts", "final_decision"],
        "relation_boost": [],
    },
    {
        "id": "rule_application",
        "label": "Application de la règle",
        "question": "Comment la cour applique-t-elle la règle de droit ?",
        "intent": "Norme → application",
        "section_types": ["applicable_rule", "applies_rule", "court_reasoning"],
        "relation_boost": ["applies_rule"],
    },
    {
        "id": "motifs_support",
        "label": "Motifs de la décision",
        "question": "Quels motifs juridiques soutiennent la décision ?",
        "intent": "Motifs → décision",
        "section_types": ["supports", "explains", "court_reasoning", "legal_analysis"],
        "relation_boost": ["supports", "explains"],
    },
    {
        "id": "analysis_to_resolution",
        "label": "Analyse → résolution",
        "question": "Quelle chaîne mène de l'analyse au règlement du litige ?",
        "intent": "Analyse → issue",
        "section_types": ["legal_analysis", "court_reasoning", "resolves", "grants", "denies"],
        "relation_boost": ["resolves", "grants", "denies", "leads_to"],
    },
]

EXAMPLE_QUERIES: List[Dict[str, Any]] = list(_EXAMPLE_QUERIES_RAW)


class LegalGraphNotFoundError(FileNotFoundError):
    """Raised when a graph artifact or pickle cannot be loaded."""


class LegalGraphExplorerError(ValueError):
    """Raised for invalid explorer inputs."""


@dataclass
class ExploreQueryResult:
    preset_id: Optional[str]
    query: str
    seeds: List[str]
    node_ids: List[str]
    edge_ids: List[str]
    graph: Dict[str, List[Dict[str, Any]]]
    stats: Dict[str, Any] = field(default_factory=dict)
    truncated: bool = False
    message: str = ""


@dataclass
class ExplorePathResult:
    node_id: str
    goal_node_id: Optional[str]
    path_node_ids: List[str]
    path_steps: List[Dict[str, Any]]
    highlighted_edge_ids: List[str]
    graph: Dict[str, List[Dict[str, Any]]]
    search_method: str
    status: str
    summary: str
    key_steps: List[str] = field(default_factory=list)
    confidence_score: float = 0.0
    message: str = ""
    suggested_action: str = ""


def list_presets() -> List[Dict[str, Any]]:
    return [dict(item) for item in EXAMPLE_QUERIES]


def _preset_by_id(preset_id: str) -> Optional[Dict[str, Any]]:
    for preset in EXAMPLE_QUERIES:
        if preset["id"] == preset_id:
            return preset
    return None


def load_graph_from_directory(directory: Path) -> nx.MultiDiGraph:
    """Load the newest pickle graph from a legal graph artifact directory."""
    directory = directory.resolve()
    if not directory.is_dir():
        raise LegalGraphNotFoundError(f"Graph directory not found: {directory}")

    candidates = sorted(directory.glob("*.pkl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        raise LegalGraphNotFoundError(f"No pickle graph in {directory}")

    try:
        with candidates[0].open("rb") as fh:
            graph = pickle.load(fh)
    except Exception as exc:
        raise LegalGraphNotFoundError(f"Could not load graph pickle: {exc}") from exc

    return ensure_legal_graph(graph)


def _query_terms(text: str) -> List[str]:
    terms: List[str] = []
    for raw in re.split(r"\s+", (text or "").strip()):
        if not raw:
            continue
        if re.search(r"[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]", raw):
            clean = raw.strip(".,?!;:()[]\"'").lower()
            if len(clean) >= 2:
                terms.append(clean)
            continue
        for tok in re.findall(r"\w+", raw.lower()):
            if len(tok) > 2 or tok.isdigit():
                terms.append(tok)
    return terms


def _compute_idf(graph: nx.MultiDiGraph, terms: List[str]) -> Dict[str, float]:
    n = graph.number_of_nodes() or 1
    df: Dict[str, int] = {t: 0 for t in terms}
    for _, attrs in graph.nodes(data=True):
        haystack = " ".join(
            [
                str(attrs.get("section_type") or ""),
                str(attrs.get("section_title") or ""),
                str(attrs.get("text_preview") or ""),
            ]
        ).lower()
        for term in terms:
            if term in haystack:
                df[term] += 1
    return {t: math.log(1 + n / (1 + df[t])) for t in terms}


def _document_type(attrs: Dict[str, Any]) -> str:
    """Resolve document type from node attrs / embedded Qdrant metadata."""
    meta = attrs.get("metadata") or {}
    if isinstance(meta, str):
        try:
            import json

            meta = json.loads(meta) if meta else {}
        except Exception:
            meta = {}
    dt = str(
        attrs.get("document_type")
        or meta.get("document_type")
        or meta.get("doc_type")
        or ""
    ).lower()
    if dt in {"judgment", "contract", "statute"}:
        return dt
    haystack = " ".join(
        str(value or "")
        for value in [
            meta.get("title"),
            attrs.get("section_title"),
            attrs.get("source_pdf_path"),
            str(attrs.get("text_preview") or "")[:400],
        ]
    ).lower()
    if any(token in haystack for token in ("contrat", "contract", "licence d'usage", "prestataire")):
        return "contract"
    if any(
        token in haystack
        for token in (
            "محكمة",
            "قرار",
            "حكم",
            "استئناف",
            "السلطة القضائية",
            "tribunal",
            "cour d'appel",
            "jugement",
        )
    ):
        return "judgment"
    return "unknown"


def _document_title(attrs: Dict[str, Any]) -> str:
    meta = attrs.get("metadata") or {}
    if isinstance(meta, str):
        try:
            import json

            meta = json.loads(meta) if meta else {}
        except Exception:
            meta = {}
    return str(meta.get("title") or attrs.get("source_pdf_path") or attrs.get("document_id") or "")


def _is_contract_node(attrs: Dict[str, Any]) -> bool:
    dt = _document_type(attrs)
    if dt == "contract":
        return True
    title = _document_title(attrs).lower()
    return any(token in title for token in ("contrat", "contract", "licence d'usage", "prestataire"))


def _effective_section_type(attrs: Dict[str, Any]) -> str:
    """Resolve a node's legal role even when persisted section_type is generic (e.g. 'judgment')."""
    raw = str(attrs.get("section_type") or "").lower()
    if raw and raw not in _GENERIC_SECTION_TYPES:
        return raw
    chunk = {
        "section_type": attrs.get("section_type"),
        "section_title": attrs.get("section_title"),
        "text": str(attrs.get("text") or ""),
        "metadata": attrs.get("metadata") or {},
    }
    return classify_node_type(chunk, document_type=_document_type(attrs))


def _seeds_from_section_boost(
    graph: nx.MultiDiGraph,
    section_boost: Set[str],
    *,
    judgments_only: bool = False,
    max_k: int = 3,
) -> List[str]:
    """Pick seed nodes directly from preset section types (works for Arabic OCR graphs)."""
    if not section_boost:
        return []

    wanted = {s.lower() for s in section_boost}
    by_type: Dict[str, List[str]] = defaultdict(list)
    for nid, attrs in graph.nodes(data=True):
        if judgments_only and _is_contract_node(attrs):
            continue
        role = _effective_section_type(attrs)
        if role in wanted:
            by_type[role].append(str(nid))

    seeds: List[str] = []
    priority = [
        "facts",
        "party_claim",
        "plaintiff_argument",
        "defendant_argument",
        "applicable_rule",
        "applies_rule",
        "court_reasoning",
        "legal_analysis",
        "final_decision",
        "admissibility",
        "jurisdiction",
        "damages",
        "costs",
    ]
    for role in priority:
        if role not in by_type:
            continue
        candidates = sorted(
            by_type[role],
            key=lambda nid: (
                graph.nodes[nid].get("paragraph_index")
                if graph.nodes[nid].get("paragraph_index") is not None
                else 0
            ),
        )
        if candidates:
            seeds.append(candidates[0])
        if len(seeds) >= max_k:
            break

    if not seeds:
        for role in sorted(by_type.keys()):
            seeds.append(by_type[role][0])
            if len(seeds) >= max_k:
                break
    return seeds


def _score_nodes(
    graph: nx.MultiDiGraph,
    terms: List[str],
    *,
    section_boost: Optional[Set[str]] = None,
    judgments_only: bool = False,
) -> List[Tuple[float, str]]:
    if not terms and not section_boost:
        return []
    idf = _compute_idf(graph, terms)
    section_boost = {s.lower() for s in (section_boost or set())}
    scored: List[Tuple[float, str]] = []

    for nid, attrs in graph.nodes(data=True):
        if judgments_only and _is_contract_node(attrs):
            continue
        section_type = _effective_section_type(attrs)
        haystack = " ".join(
            [
                section_type,
                str(attrs.get("section_title") or ""),
                str(attrs.get("text_preview") or ""),
                str(attrs.get("text") or "")[:500],
            ]
        ).lower()
        score = 0.0
        if section_type in section_boost:
            score += 500.0
        for term in terms:
            weight = idf.get(term, 1.0)
            if term == section_type:
                score += 1000.0 * weight
            elif haystack.startswith(term):
                score += 100.0 * weight
            elif term in haystack:
                score += 1.0 * weight
        if score > 0:
            scored.append((score, str(nid)))

    scored.sort(key=lambda item: (-item[0], len(graph.nodes[item[1]].get("label") or item[1]), item[1]))
    return scored


def _pick_seeds(scored: List[Tuple[float, str]], max_k: int = 3, gap_ratio: float = 0.2) -> List[str]:
    if not scored:
        return []
    top_score = scored[0][0]
    seeds: List[str] = []
    for score, nid in scored[:max_k]:
        if seeds and score < top_score * gap_ratio:
            break
        seeds.append(nid)
    return seeds


def _bfs_reasoning(
    graph: nx.MultiDiGraph,
    start_nodes: List[str],
    depth: int,
    *,
    judgment_id: Optional[str] = None,
) -> Tuple[Set[str], List[Tuple[str, str, str]]]:
    reasoning = build_reasoning_subgraph(graph, cross_case=False)
    visited: Set[str] = set(start_nodes)
    frontier = set(start_nodes)
    edges_seen: List[Tuple[str, str, str]] = []

    for _ in range(max(1, depth)):
        next_frontier: Set[str] = set()
        for node in frontier:
            if node not in reasoning:
                continue
            for neighbor in reasoning.successors(node):
                if judgment_id:
                    n_j = graph.nodes.get(neighbor, {}).get("judgment_id")
                    if n_j and n_j != judgment_id:
                        continue
                edge_data = reasoning.get_edge_data(node, neighbor) or {}
                rel = str(edge_data.get("relation_type") or "reasoning")
                edges_seen.append((node, neighbor, rel))
                if neighbor not in visited:
                    next_frontier.add(neighbor)
            for neighbor in reasoning.predecessors(node):
                if judgment_id:
                    n_j = graph.nodes.get(neighbor, {}).get("judgment_id")
                    if n_j and n_j != judgment_id:
                        continue
                edge_data = reasoning.get_edge_data(neighbor, node) or {}
                rel = str(edge_data.get("relation_type") or "reasoning")
                edges_seen.append((neighbor, node, rel))
                if neighbor not in visited:
                    next_frontier.add(neighbor)
        visited.update(next_frontier)
        frontier = next_frontier

    return visited, edges_seen


def _bfs_discovery(
    graph: nx.MultiDiGraph,
    start_nodes: List[str],
    depth: int,
    *,
    judgment_id: Optional[str] = None,
) -> Tuple[Set[str], List[Tuple[str, str, str]]]:
    """Expand subgraph through discovery edges when no reasoning layer exists yet."""
    visited: Set[str] = set(start_nodes)
    frontier = set(start_nodes)
    edges_seen: List[Tuple[str, str, str]] = []
    seen_edges: Set[str] = set()

    def _maybe_add(source: str, target: str, rel: str) -> None:
        if judgment_id:
            n_j = graph.nodes.get(target, {}).get("judgment_id")
            if n_j and str(n_j) != str(judgment_id):
                return
        eid = _edge_key(source, target, rel)
        if eid not in seen_edges:
            seen_edges.add(eid)
            edges_seen.append((source, target, rel))
        if target not in visited:
            visited.add(target)

    for _ in range(max(1, depth)):
        next_frontier: Set[str] = set()
        for node in frontier:
            if node not in graph:
                continue
            for neighbor in graph.successors(node):
                for _key, attrs in graph[node][neighbor].items():
                    rel = str(attrs.get("relation_type") or _key or "related")
                    if rel in _DISCOVERY_RELATIONS:
                        _maybe_add(node, str(neighbor), rel)
                        if str(neighbor) not in frontier:
                            next_frontier.add(str(neighbor))
            for neighbor in graph.predecessors(node):
                for _key, attrs in graph[neighbor][node].items():
                    rel = str(attrs.get("relation_type") or _key or "related")
                    if rel in _DISCOVERY_RELATIONS:
                        _maybe_add(str(neighbor), node, rel)
                        if str(neighbor) not in frontier:
                            next_frontier.add(str(neighbor))
        frontier = next_frontier - visited

    return visited, edges_seen


def _cap_subgraph(
    node_ids: Set[str],
    edges: List[Tuple[str, str, str]],
) -> Tuple[Set[str], List[Tuple[str, str, str]], bool]:
    truncated = False
    if len(node_ids) <= MAX_SUBGRAPH_NODES and len(edges) <= MAX_SUBGRAPH_EDGES:
        return node_ids, edges, truncated

    truncated = True
    capped_nodes = set(list(node_ids)[:MAX_SUBGRAPH_NODES])
    capped_edges: List[Tuple[str, str, str]] = []
    for source, target, rel in edges:
        if source in capped_nodes and target in capped_nodes:
            capped_edges.append((source, target, rel))
        if len(capped_edges) >= MAX_SUBGRAPH_EDGES:
            break
    return capped_nodes, capped_edges, truncated


def _edge_key(source: str, target: str, relation: str) -> str:
    return f"{source}->{target}:{relation}"


def _collect_edges_for_nodes(
    graph: nx.MultiDiGraph,
    node_ids: Set[str],
    *,
    reasoning_only: bool = True,
) -> List[Tuple[str, str, str]]:
    edges: List[Tuple[str, str, str]] = []
    for source, target, _key, attrs in graph.edges(keys=True, data=True):
        if source not in node_ids or target not in node_ids:
            continue
        if reasoning_only and attrs.get("reasoning_edge") is not True:
            continue
        rel = str(attrs.get("relation_type") or _key or "reasoning")
        edges.append((str(source), str(target), rel))
    return edges


def _section_color(section_type: str) -> str:
    role = (section_type or "unknown").lower()
    fill = _node_fill(role)
    return fill if fill.startswith("#") else "#f9fafb"


def to_reactflow(
    graph: nx.MultiDiGraph,
    node_ids: Set[str],
    edges: List[Tuple[str, str, str]],
    *,
    seeds: Optional[List[str]] = None,
    path_node_ids: Optional[List[str]] = None,
    path_edge_ids: Optional[List[str]] = None,
) -> Dict[str, List[Dict[str, Any]]]:
    seed_set = set(seeds or [])
    path_set = set(path_node_ids or [])
    path_edges = set(path_edge_ids or [])

    doc_groups: Dict[str, List[str]] = defaultdict(list)
    for node_id in node_ids:
        if node_id not in graph:
            continue
        doc_id = str(graph.nodes[node_id].get("document_id") or "unknown")
        doc_groups[doc_id].append(node_id)

    positions: Dict[str, Dict[str, float]] = {}
    row_gap = 160.0
    col_width = 280.0
    y = 0.0
    for doc_id in sorted(doc_groups.keys()):
        ordered = sorted(
            doc_groups[doc_id],
            key=lambda nid: (
                graph.nodes[nid].get("paragraph_index")
                if graph.nodes[nid].get("paragraph_index") is not None
                else 0
            ),
        )
        for index, node_id in enumerate(ordered):
            positions[node_id] = {"x": index * col_width, "y": y}
        y += row_gap

    rf_nodes: List[Dict[str, Any]] = []
    for node_id in sorted(node_ids):
        if node_id not in graph:
            continue
        attrs = graph.nodes[node_id]
        section_type = _effective_section_type(attrs)
        pos = positions.get(node_id, {"x": 0, "y": 0})
        preview = str(attrs.get("text_preview") or text_preview(str(attrs.get("text") or "")))
        rf_nodes.append(
            {
                "id": node_id,
                "type": "legalGraphNode",
                "position": pos,
                "data": {
                    "label": f"C{attrs.get('paragraph_index', '?')} · {section_type}",
                    "section_type": section_type,
                    "section_title": str(attrs.get("section_title") or ""),
                    "document_title": _document_title(attrs),
                    "document_type": _document_type(attrs),
                    "paragraph_index": attrs.get("paragraph_index"),
                    "text_preview": preview,
                    "judgment_id": attrs.get("judgment_id"),
                    "document_id": attrs.get("document_id"),
                    "color": _section_color(section_type),
                    "isSeed": node_id in seed_set,
                    "isOnPath": node_id in path_set,
                },
            }
        )

    rf_edges: List[Dict[str, Any]] = []
    seen: Set[str] = set()
    for source, target, relation in edges:
        eid = _edge_key(source, target, relation)
        if eid in seen:
            continue
        seen.add(eid)
        rf_edges.append(
            {
                "id": eid,
                "source": source,
                "target": target,
                "label": relation,
                "data": {
                    "relation_type": relation,
                    "isOnPath": eid in path_edges,
                },
            }
        )

    return {"nodes": rf_nodes, "edges": rf_edges}


def query_subgraph(
    graph: nx.MultiDiGraph,
    *,
    preset_id: Optional[str] = None,
    query: Optional[str] = None,
    depth: int = 3,
) -> ExploreQueryResult:
    preset = _preset_by_id(preset_id) if preset_id else None
    if preset_id and not preset:
        raise LegalGraphExplorerError(f"Unknown preset_id: {preset_id}")

    question = str(query or (preset or {}).get("question") or "").strip()
    if not question:
        raise LegalGraphExplorerError("query or preset_id is required")

    terms = _query_terms(question)
    section_boost = set((preset or {}).get("section_types") or [])
    judgment_preset = bool(section_boost & {"facts", "court_reasoning", "final_decision", "party_claim"})
    scored = _score_nodes(
        graph,
        terms,
        section_boost=section_boost,
        judgments_only=judgment_preset,
    )
    seeds = _pick_seeds(scored)
    if not seeds and section_boost:
        seeds = _seeds_from_section_boost(
            graph,
            section_boost,
            judgments_only=judgment_preset,
        )

    if not seeds:
        return ExploreQueryResult(
            preset_id=preset_id,
            query=question,
            seeds=[],
            node_ids=[],
            edge_ids=[],
            graph={"nodes": [], "edges": []},
            stats={"matched_nodes": 0, "reasoning_edges": 0},
            message="Aucun nœud correspondant dans ce graphe.",
        )

    judgment_id = graph.nodes[seeds[0]].get("judgment_id")
    node_ids, bfs_edges = _bfs_reasoning(
        graph,
        seeds,
        depth,
        judgment_id=str(judgment_id) if judgment_id else None,
    )
    reasoning = build_reasoning_subgraph(graph, cross_case=False)
    if reasoning.number_of_edges() == 0 or len(node_ids) <= len(seeds):
        disc_nodes, disc_edges = _bfs_discovery(
            graph,
            seeds,
            depth,
            judgment_id=str(judgment_id) if judgment_id else None,
        )
        node_ids = set(node_ids) | disc_nodes
        merged_edges: List[Tuple[str, str, str]] = []
        seen_edge_keys: Set[str] = set()
        for source, target, rel in bfs_edges + disc_edges:
            eid = _edge_key(source, target, rel)
            if eid in seen_edge_keys:
                continue
            seen_edge_keys.add(eid)
            merged_edges.append((source, target, rel))
        bfs_edges = merged_edges

    all_edges = _collect_edges_for_nodes(graph, node_ids, reasoning_only=True)
    if not all_edges:
        all_edges = _collect_edges_for_nodes(graph, node_ids, reasoning_only=False)
    if not all_edges:
        all_edges = bfs_edges

    node_ids, all_edges, truncated = _cap_subgraph(node_ids, all_edges)
    edge_ids = [_edge_key(s, t, r) for s, t, r in all_edges]

    reasoning_count = graph.number_of_edges()
    stats = {
        "matched_nodes": len(node_ids),
        "reasoning_edges": len(all_edges),
        "seeds": seeds,
        "depth": depth,
        "judgment_id": judgment_id,
    }

    return ExploreQueryResult(
        preset_id=preset_id,
        query=question,
        seeds=seeds,
        node_ids=sorted(node_ids),
        edge_ids=edge_ids,
        graph=to_reactflow(graph, node_ids, all_edges, seeds=seeds),
        stats=stats,
        truncated=truncated,
        message=(
            f"Sous-graphe tronqué à {MAX_SUBGRAPH_NODES} nœuds / {MAX_SUBGRAPH_EDGES} arêtes."
            if truncated
            else ""
        ),
    )


def _goal_for_node(graph: nx.MultiDiGraph, start_node_id: str) -> Optional[str]:
    if start_node_id not in graph:
        return None
    start_judgment = graph.nodes[start_node_id].get("judgment_id")
    scoped = [
        str(nid)
        for nid, attrs in graph.nodes(data=True)
        if not _is_contract_node(attrs)
        and (not start_judgment or attrs.get("judgment_id") == start_judgment)
    ]
    return _choose_goal_node(graph, scoped)


def _path_edge_ids(graph: nx.MultiDiGraph, path: List[str]) -> List[str]:
    edge_ids: List[str] = []
    for index in range(len(path) - 1):
        source, target = path[index], path[index + 1]
        if graph.has_edge(source, target):
            for _key, attrs in graph[source][target].items():
                if attrs.get("reasoning_edge") is True:
                    rel = str(attrs.get("relation_type") or _key)
                    edge_ids.append(_edge_key(source, target, rel))
                    break
    return edge_ids


def path_from_node(
    graph: nx.MultiDiGraph,
    node_id: str,
    *,
    query: Optional[str] = None,
    goal_node_id: Optional[str] = None,
) -> ExplorePathResult:
    if node_id not in graph:
        raise LegalGraphExplorerError(f"Unknown node_id: {node_id}")

    goal = goal_node_id if goal_node_id and goal_node_id in graph else _goal_for_node(graph, node_id)
    question = str(query or "Comment ce jugement raisonne-t-il ?").strip()

    path: List[str] = []
    search_method = "none"
    status = "no_reasoning_path"
    message = (
        "Aucun chemin de raisonnement n'existe encore. "
        "Des liens de découverte existent, mais ils ne constituent pas un raisonnement valide."
    )
    suggested_action = "Lancer l'inférence LLM des relations sur ce jugement."

    if goal and goal in graph:
        if node_id == goal:
            path = [node_id]
            search_method = "single_node"
            status = "ok"
            message = ""
            suggested_action = ""
        else:
            reasoning_graph = build_reasoning_subgraph(graph, cross_case=False)
            path, search_method = GraphSearchNode()._find_path(reasoning_graph, graph, node_id, goal)
            if path and validate_reasoning_path(graph, path, cross_case=False):
                status = "ok"
                message = ""
                suggested_action = ""
            else:
                path = []
                search_method = "no_reasoning_path"

    path_steps = _path_steps(graph, path) if path else []
    highlighted_edge_ids = _path_edge_ids(graph, path) if path else []

    path_nodes = set(path)
    path_edges_tuples = [
        (path[i], path[i + 1], str(path_steps[i].get("relation_to_next") or "reasoning"))
        for i in range(len(path) - 1)
        if path_steps[i].get("relation_to_next")
    ]
    if not path_edges_tuples and path:
        path_edges_tuples = [(path[i], path[i + 1], "reasoning") for i in range(len(path) - 1)]

    extra_nodes = set(path_nodes)
    for source, target, _rel in path_edges_tuples:
        extra_nodes.add(source)
        extra_nodes.add(target)

    summary_payload = summarize_reasoning_path(question, path_steps)
    rf = to_reactflow(
        graph,
        extra_nodes,
        path_edges_tuples or _collect_edges_for_nodes(graph, extra_nodes),
        path_node_ids=path,
        path_edge_ids=highlighted_edge_ids,
    )

    return ExplorePathResult(
        node_id=node_id,
        goal_node_id=goal,
        path_node_ids=path,
        path_steps=path_steps,
        highlighted_edge_ids=highlighted_edge_ids,
        graph=rf,
        search_method=search_method,
        status=status,
        summary=str(summary_payload.get("summary") or ""),
        key_steps=list(summary_payload.get("key_steps") or []),
        confidence_score=float(summary_payload.get("confidence_score") or 0.0),
        message=message,
        suggested_action=suggested_action,
    )


def _fallback_summary(question: str, path_steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not path_steps:
        return {
            "summary": "Aucun chemin de raisonnement n'a pu être construit à partir de ce nœud.",
            "key_steps": [],
            "confidence_score": 0.0,
        }

    lines = [f"Question : {question}", "", "Chaîne de raisonnement juridique :"]
    key_steps: List[str] = []
    for index, step in enumerate(path_steps, start=1):
        section = step.get("section_type") or "section"
        preview = str(step.get("text_preview") or "")[:180]
        relation = step.get("relation_to_next")
        line = f"{index}. [{section}] {preview}"
        lines.append(line)
        key_steps.append(line)
        if relation:
            lines.append(f"   → ({relation}) {step.get('edge_explanation') or ''}".rstrip())

    return {
        "summary": "\n".join(lines).strip(),
        "key_steps": key_steps,
        "confidence_score": 0.45,
    }


def summarize_reasoning_path(question: str, path_steps: List[Dict[str, Any]]) -> Dict[str, Any]:
    if not path_steps:
        return _fallback_summary(question, path_steps)

    try:
        from llm.llm_factory import create_llm_client

        llm = create_llm_client(provider="deepseek", temperature=0.2, max_tokens=1200)
        prompt = f"""
Explique comment ce chemin répond à une question juridique marocaine. Réponds en JSON uniquement.

Question:
{question}

Chemin (étapes):
{json.dumps(path_steps, ensure_ascii=False, default=str)[:14000]}

Schéma JSON:
{{"summary": "explication courte en français", "key_steps": ["..."], "confidence_score": 0.0}}
"""
        response = llm.generate(prompt)
        content = (response.content or "").strip()
        if "```" in content:
            content = content.split("```json")[-1].split("```")[0].strip()
        data = json.loads(content)
        if isinstance(data, dict) and data.get("summary"):
            return {
                "summary": str(data.get("summary") or ""),
                "key_steps": [str(s) for s in (data.get("key_steps") or [])],
                "confidence_score": float(data.get("confidence_score") or 0.65),
            }
    except Exception:
        pass

    return _fallback_summary(question, path_steps)
