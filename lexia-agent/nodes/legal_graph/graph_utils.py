"""NetworkX graph helpers for the legal graph flow."""

from __future__ import annotations

import json
import math
from datetime import datetime, timezone
from typing import Any, Dict, Iterable, List, Optional, Tuple

import networkx as nx

from nodes.legal_graph.models import (
    DEFAULT_RELATION_WEIGHTS,
    DISCOVERY_RELATION_TYPES,
    EdgeSpec,
    REASONING_RELATION_TYPES,
    RetrievedChunk,
)


def utc_now() -> str:
    """Return a stable ISO timestamp."""
    return datetime.now(timezone.utc).isoformat()


def text_preview(text: str, limit: int = 700) -> str:
    clean = " ".join((text or "").split())
    if len(clean) <= limit:
        return clean
    return clean[: limit - 1].rstrip() + "..."


def ensure_legal_graph(graph: Optional[nx.Graph] = None) -> nx.MultiDiGraph:
    """Return a MultiDiGraph, converting existing NetworkX graphs if needed."""
    if graph is None:
        g = nx.MultiDiGraph()
    elif isinstance(graph, nx.MultiDiGraph):
        g = graph
    else:
        g = nx.MultiDiGraph(graph)
    g.graph.setdefault("graph_type", "lexia_legal_chunk_graph")
    g.graph.setdefault("created_at", utc_now())
    g.graph["updated_at"] = utc_now()
    migrate_edge_layers(g)
    return g


def edge_layer_for_relation(relation_type: str) -> str:
    """Return the logical edge layer for a relation type."""
    if relation_type in REASONING_RELATION_TYPES:
        return "reasoning"
    return "discovery"


def is_reasoning_relation(relation_type: str) -> bool:
    return relation_type in REASONING_RELATION_TYPES


def migrate_edge_layers(graph: nx.MultiDiGraph) -> None:
    """Annotate old graph edges with edge_layer/reasoning_edge in place."""
    for _source, _target, _key, attrs in graph.edges(keys=True, data=True):
        relation_type = str(attrs.get("relation_type") or _key or "")
        extraction_method = str(attrs.get("extraction_method") or "")
        if extraction_method in {"metadata", "semantic_similarity", "citation_parser"}:
            edge_layer = "discovery"
        else:
            edge_layer = attrs.get("edge_layer") or edge_layer_for_relation(relation_type)
        attrs["edge_layer"] = edge_layer
        attrs["reasoning_edge"] = bool(
            attrs.get("reasoning_edge") is True
            or (edge_layer == "reasoning" and relation_type in REASONING_RELATION_TYPES)
        )
        if relation_type in DISCOVERY_RELATION_TYPES or edge_layer == "discovery":
            attrs["edge_layer"] = "discovery"
            attrs["reasoning_edge"] = False
            attrs["weight"] = 10.0


def as_list(value: Any) -> List[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, tuple) or isinstance(value, set):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return []
        try:
            parsed = json.loads(stripped)
            if isinstance(parsed, list):
                return as_list(parsed)
        except Exception:
            pass
        separators = ["\n", ";", ","]
        for sep in separators:
            if sep in stripped:
                return [part.strip() for part in stripped.split(sep) if part.strip()]
        return [stripped]
    return [str(value).strip()] if str(value).strip() else []


def maybe_int(value: Any) -> Optional[int]:
    if value in (None, ""):
        return None
    try:
        return int(value)
    except Exception:
        return None


def coerce_vector(vector: Any) -> Optional[List[float]]:
    """Extract a float vector from Qdrant's possible vector shapes."""
    if vector is None:
        return None
    if isinstance(vector, dict):
        for key in ("default", "dense", "text", "vector"):
            if key in vector:
                return coerce_vector(vector[key])
        for value in vector.values():
            coerced = coerce_vector(value)
            if coerced:
                return coerced
        return None
    if isinstance(vector, (list, tuple)):
        values: List[float] = []
        for item in vector:
            try:
                values.append(float(item))
            except Exception:
                return None
        return values
    return None


def cosine_similarity(a: Any, b: Any) -> Optional[float]:
    va = coerce_vector(a)
    vb = coerce_vector(b)
    if not va or not vb or len(va) != len(vb):
        return None
    dot = sum(x * y for x, y in zip(va, vb))
    na = math.sqrt(sum(x * x for x in va))
    nb = math.sqrt(sum(y * y for y in vb))
    if na == 0 or nb == 0:
        return None
    return dot / (na * nb)


def payload_value(payload: Dict[str, Any], *keys: str) -> Any:
    for key in keys:
        if key in payload and payload[key] not in (None, ""):
            return payload[key]
    return None


def _result_payload(result: Any) -> Dict[str, Any]:
    payload = getattr(result, "payload", None)
    if payload:
        return dict(payload)
    metadata = getattr(result, "metadata", None)
    if metadata:
        return dict(metadata)
    if isinstance(result, dict):
        return dict(result.get("payload") or result.get("metadata") or result)
    return {}


def retrieved_chunk_from_qdrant_result(result: Any, collection: str) -> RetrievedChunk:
    """Normalize Qdrant/FastEmbed result objects into RetrievedChunk."""
    payload = _result_payload(result)
    point_id = (
        getattr(result, "id", None)
        or payload_value(payload, "qdrant_point_id", "point_id", "id")
        or payload_value(payload, "chunk_id")
    )
    if point_id is None and isinstance(result, dict):
        point_id = result.get("id")
    if point_id is None:
        raise ValueError("Qdrant result is missing a point id")

    text = (
        payload_value(payload, "content", "text", "chunk_text", "page_content")
        or getattr(result, "document", None)
        or ""
    )
    vector = getattr(result, "vector", None)
    if vector is None and isinstance(result, dict):
        vector = result.get("vector")

    score = getattr(result, "score", None)
    if score is None and isinstance(result, dict):
        score = result.get("score")

    return RetrievedChunk(
        qdrant_point_id=str(point_id),
        chunk_id=str(payload_value(payload, "chunk_id") or point_id),
        document_id=payload_value(payload, "document_id", "doc_id"),
        judgment_id=payload_value(payload, "judgment_id", "case_id"),
        source_pdf_id=payload_value(payload, "source_pdf_id", "pdf_id"),
        source_pdf_path=payload_value(payload, "source_pdf_path", "pdf_path", "source_path"),
        qdrant_collection=collection,
        page_number=maybe_int(payload_value(payload, "page_number", "page", "page_index")),
        paragraph_index=maybe_int(payload_value(payload, "paragraph_index", "chunk_index", "paragraph")),
        section_title=payload_value(payload, "section_title", "title", "heading"),
        section_type=payload_value(payload, "section_type", "doc_type", "node_type"),
        text=str(text or ""),
        text_preview=text_preview(str(text or "")),
        legal_entities=as_list(payload_value(payload, "legal_entities", "entities")),
        cited_articles=as_list(payload_value(payload, "cited_articles", "articles")),
        cited_cases=as_list(payload_value(payload, "cited_cases", "cases")),
        qdrant_score=float(score) if score is not None else None,
        vector=vector,
        metadata=payload,
    )


def node_attrs_from_chunk(chunk: RetrievedChunk, existing: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    """Build mandatory graph node fields from a retrieved Qdrant chunk."""
    existing = existing or {}
    created_at = existing.get("created_at") or utc_now()
    now = utc_now()
    return {
        "qdrant_point_id": chunk.qdrant_point_id,
        "chunk_id": chunk.chunk_id or chunk.qdrant_point_id,
        "document_id": chunk.document_id,
        "judgment_id": chunk.judgment_id,
        "source_pdf_id": chunk.source_pdf_id,
        "source_pdf_path": chunk.source_pdf_path,
        "qdrant_collection": chunk.qdrant_collection,
        "page_number": chunk.page_number,
        "paragraph_index": chunk.paragraph_index,
        "section_title": chunk.section_title,
        "section_type": chunk.section_type,
        "document_type": chunk.metadata.get("document_type") or existing.get("document_type"),
        "text_preview": chunk.text_preview or text_preview(chunk.text),
        "text": chunk.text,
        "vector": chunk.vector,
        "legal_entities": chunk.legal_entities,
        "cited_articles": chunk.cited_articles,
        "cited_cases": chunk.cited_cases,
        "qdrant_score": chunk.qdrant_score,
        "metadata": chunk.metadata,
        "created_at": created_at,
        "updated_at": now,
        "last_seen_at": now,
    }


def relation_weight(relation_type: str, similarity: Optional[float] = None) -> float:
    if relation_type in DISCOVERY_RELATION_TYPES:
        return 10.0
    return DEFAULT_RELATION_WEIGHTS.get(relation_type, 2.0)


def upsert_edge(graph: nx.MultiDiGraph, spec: EdgeSpec) -> str:
    """Add or update an edge keyed by relation_type and return its stable id."""
    now = utc_now()
    edge_key = spec.relation_type
    attrs = {
        "relation_type": spec.relation_type,
        "weight": float(spec.weight),
        "confidence": float(spec.confidence),
        "explanation": spec.explanation,
        "source": spec.source,
        "target": spec.target,
        "evidence": spec.evidence,
        "extraction_method": spec.extraction_method,
        "edge_layer": spec.edge_layer,
        "reasoning_edge": spec.reasoning_edge,
        "updated_at": now,
        "last_seen_at": now,
    }
    if graph.has_edge(spec.source, spec.target, key=edge_key):
        existing = graph.edges[spec.source, spec.target, edge_key]
        attrs["created_at"] = existing.get("created_at") or now
        existing.update(attrs)
    else:
        attrs["created_at"] = now
        graph.add_edge(spec.source, spec.target, key=edge_key, **attrs)
    graph.graph["updated_at"] = now
    return f"{spec.source}->{spec.target}:{edge_key}"


def build_reasoning_subgraph(
    graph: nx.MultiDiGraph,
    *,
    cross_case: bool = False,
) -> nx.DiGraph:
    """Build a DiGraph containing only edges approved for legal reasoning."""
    migrate_edge_layers(graph)
    reasoning_graph = nx.DiGraph()
    for node_id, attrs in graph.nodes(data=True):
        reasoning_graph.add_node(node_id, **attrs)
    for source, target, _key, attrs in graph.edges(keys=True, data=True):
        if attrs.get("reasoning_edge") is not True:
            continue
        relation_type = attrs.get("relation_type")
        if relation_type not in REASONING_RELATION_TYPES:
            continue
        if not cross_case:
            source_judgment = graph.nodes[source].get("judgment_id")
            target_judgment = graph.nodes[target].get("judgment_id")
            if source_judgment and target_judgment and source_judgment != target_judgment:
                continue
        existing = reasoning_graph.get_edge_data(source, target)
        if existing and float(existing.get("weight", 1.0)) <= float(attrs.get("weight", 1.0)):
            continue
        reasoning_graph.add_edge(source, target, **dict(attrs))
    return reasoning_graph


def validate_reasoning_path(
    graph: nx.MultiDiGraph,
    path: List[str],
    *,
    cross_case: bool = False,
) -> bool:
    """Validate that a path uses only legal reasoning edges."""
    if not path:
        return False
    if len(path) == 1:
        return path[0] in graph
    reasoning_graph = build_reasoning_subgraph(graph, cross_case=cross_case)
    for source, target in zip(path, path[1:]):
        if not reasoning_graph.has_edge(source, target):
            return False
        if not cross_case:
            source_judgment = graph.nodes[source].get("judgment_id")
            target_judgment = graph.nodes[target].get("judgment_id")
            if source_judgment and target_judgment and source_judgment != target_judgment:
                return False
    return True


def best_edge_between(graph: nx.MultiDiGraph, source: str, target: str) -> Optional[Dict[str, Any]]:
    if not graph.has_edge(source, target):
        return None
    data = graph.get_edge_data(source, target) or {}
    if not data:
        return None
    return min(data.values(), key=lambda attrs: float(attrs.get("weight", 1.0)))


def get_source_from_graph_node(graph: nx.MultiDiGraph, node_id: str) -> Dict[str, Any]:
    """Return source trace details for a graph node."""
    if node_id not in graph:
        raise KeyError(f"node not found: {node_id}")
    node = graph.nodes[node_id]
    return {
        "node_id": node_id,
        "qdrant_point_id": node.get("qdrant_point_id"),
        "chunk_id": node.get("chunk_id"),
        "document_id": node.get("document_id"),
        "judgment_id": node.get("judgment_id"),
        "source_pdf_id": node.get("source_pdf_id"),
        "source_pdf_path": node.get("source_pdf_path"),
        "qdrant_collection": node.get("qdrant_collection"),
        "page_number": node.get("page_number"),
        "paragraph_index": node.get("paragraph_index"),
        "section_title": node.get("section_title"),
        "section_type": node.get("section_type"),
        "text_preview": node.get("text_preview") or "",
        "metadata": node.get("metadata") or {},
    }


def citation_from_source(source: Dict[str, Any]) -> str:
    path = source.get("source_pdf_path") or source.get("document_id") or source.get("qdrant_collection") or "source"
    page = source.get("page_number")
    section = source.get("section_title") or ""
    chunk_id = source.get("chunk_id") or source.get("qdrant_point_id") or source.get("node_id")
    page_part = f"page {page}" if page is not None else "page ?"
    return f'[{path}, {page_part}, section "{section}", chunk_id "{chunk_id}"]'


def graphml_safe_copy(graph: nx.MultiDiGraph) -> nx.MultiDiGraph:
    """Create a GraphML-safe graph by JSON encoding complex attributes."""
    safe = nx.MultiDiGraph()
    for key, value in graph.graph.items():
        safe.graph[key] = _safe_value(value)
    for node_id, attrs in graph.nodes(data=True):
        safe.add_node(node_id, **{key: _safe_value(value) for key, value in attrs.items()})
    for source, target, key, attrs in graph.edges(keys=True, data=True):
        safe.add_edge(
            source,
            target,
            key=key,
            **{attr_key: _safe_value(value) for attr_key, value in attrs.items()},
        )
    return safe


def _safe_value(value: Any) -> Any:
    if value is None:
        return ""
    if isinstance(value, (str, int, float, bool)):
        return value
    try:
        return json.dumps(value, ensure_ascii=False, default=str)
    except Exception:
        return str(value)


def nodes_with_same_field(
    graph: nx.MultiDiGraph,
    field: str,
    value: Any,
    *,
    exclude: Optional[str] = None,
    limit: int = 50,
) -> List[str]:
    if value in (None, ""):
        return []
    found: List[str] = []
    for node_id, attrs in graph.nodes(data=True):
        if exclude and node_id == exclude:
            continue
        if attrs.get(field) == value:
            found.append(str(node_id))
            if len(found) >= limit:
                break
    return found


def common_values(left: Iterable[str], right: Iterable[str]) -> List[str]:
    return sorted(set(as_list(list(left))).intersection(as_list(list(right))))
