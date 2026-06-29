"""Build a single unified judgments graph (.pkl) for GraphRAG-style legal memory."""

from __future__ import annotations

import json
import logging
import os
import pickle
from collections import Counter
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import networkx as nx

from nodes.legal_graph.graph_utils import ensure_legal_graph, graphml_safe_copy
from nodes.legal_graph.legal_graph_nodes import (
    ConnectToExistingGraphNode,
    LoadGraphNode,
    SaveGraphNode,
    UpsertChunkNodesNode,
    classify_document_type,
)
from nodes.legal_graph.models import LegalGraphConfig, RetrievedChunk
from nodes.legal_graph.visualization import render_graph_png

logger = logging.getLogger(__name__)

UNIFIED_GRAPH_ID = "legal_graph_unified"
UNIFIED_DIR_NAME = "legal_graph_unified"
UNIFIED_PKL_NAME = "legal_graph.pkl"
UNIFIED_GRAPHML_NAME = "legal_graph.graphml"
UNIFIED_SUMMARY_NAME = "legal_graph_summary.json"

DEFAULT_JUDGMENT_COLLECTIONS = [
    "judgments_social",
    "judgments_commercial",
    "judgments_civil",
    "judgments_criminal",
    "judgments_family",
    "judgments_constitutional",
    "judgments_real_estate",
    "judgments_admin",
    "lexia_user_docs",
    "user_documents",
]


def data_root() -> Path:
    return Path(os.getenv("LEGAL_GRAPH_DATA_DIR", "data")).resolve()


def unified_dir() -> Path:
    override = os.getenv("LEGAL_GRAPH_UNIFIED_DIR")
    if override:
        return Path(override).resolve()
    return data_root() / UNIFIED_DIR_NAME


def unified_pkl_path() -> Path:
    override = os.getenv("LEGAL_GRAPH_UNIFIED_PKL")
    if override:
        return Path(override).resolve()
    return unified_dir() / UNIFIED_PKL_NAME


def _edge_stats(graph: nx.MultiDiGraph) -> Tuple[Dict[str, int], Dict[str, int], int]:
    edge_counts: Counter[str] = Counter()
    layer_counts: Counter[str] = Counter()
    reasoning_count = 0
    for _source, _target, _key, attrs in graph.edges(keys=True, data=True):
        relation_type = str(attrs.get("relation_type") or _key or "unknown")
        layer = str(attrs.get("edge_layer") or ("reasoning" if attrs.get("reasoning_edge") else "discovery"))
        edge_counts[relation_type] += 1
        layer_counts[layer] += 1
        if attrs.get("reasoning_edge") is True:
            reasoning_count += 1
    return dict(edge_counts), dict(layer_counts), reasoning_count


def scroll_judgment_chunks(
    collections: Optional[List[str]] = None,
    *,
    page_size: int = 256,
    max_points: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Scroll all points from judgment Qdrant collections."""
    from nodes.legal_graph.graph_utils import retrieved_chunk_from_qdrant_result

    collections = collections or DEFAULT_JUDGMENT_COLLECTIONS
    try:
        from qdrant_client import QdrantClient
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"qdrant-client unavailable: {exc}") from exc

    cfg = LegalGraphConfig(qdrant_collections=collections)
    client = QdrantClient(url=cfg.qdrant_url, api_key=cfg.qdrant_api_key)
    chunks: List[Dict[str, Any]] = []
    seen_ids: set[str] = set()

    for collection in collections:
        offset = None
        while True:
            try:
                records, offset = client.scroll(
                    collection_name=collection,
                    limit=page_size,
                    offset=offset,
                    with_payload=True,
                    with_vectors=True,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning("Qdrant scroll failed for %s: %s", collection, exc)
                break
            if not records:
                break
            for record in records:
                point_id = str(getattr(record, "id", record))
                if point_id in seen_ids:
                    continue
                seen_ids.add(point_id)
                try:
                    chunk = retrieved_chunk_from_qdrant_result(record, collection)
                    chunks.append(chunk.model_dump())
                except Exception as exc:  # noqa: BLE001
                    logger.debug("Skip malformed point %s: %s", point_id, exc)
                if max_points and len(chunks) >= max_points:
                    return chunks
            if offset is None:
                break
    return chunks


def _filter_judgment_chunks(chunks: List[Dict[str, Any]]) -> Tuple[List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Keep only judgment documents; return (included, excluded)."""
    grouped: Dict[str, List[Dict[str, Any]]] = {}
    for chunk in chunks:
        key = str(
            chunk.get("document_id")
            or chunk.get("source_pdf_id")
            or chunk.get("source_pdf_path")
            or chunk.get("qdrant_collection")
            or "unknown"
        )
        grouped.setdefault(key, []).append(chunk)

    included: List[Dict[str, Any]] = []
    excluded_meta: List[Dict[str, Any]] = []
    for document_key, document_chunks in grouped.items():
        document_type = classify_document_type(document_chunks)
        meta = document_chunks[0].get("metadata") or {}
        title = meta.get("title") or document_chunks[0].get("section_title") or document_key
        if document_type != "judgment":
            excluded_meta.append(
                {
                    "document_id": document_key,
                    "title": title,
                    "document_type": document_type,
                    "chunks": len(document_chunks),
                }
            )
            continue
        for chunk in document_chunks:
            chunk_meta = dict(chunk.get("metadata") or {})
            chunk_meta["document_type"] = "judgment"
            chunk["metadata"] = chunk_meta
            included.append(chunk)
    return included, excluded_meta


def _iter_legal_graph_pkls(*, exclude: Optional[Path] = None) -> List[Path]:
    root = data_root()
    paths: List[Path] = []
    for pkl in sorted(root.glob("legal_graph*/**/*.pkl")):
        if exclude and pkl.resolve() == exclude.resolve():
            continue
        paths.append(pkl)
    return paths


def merge_persisted_legal_graphs(*, exclude: Optional[Path] = None) -> nx.MultiDiGraph:
    """Merge nodes and edges from every persisted legal-graph pickle."""
    merged = ensure_legal_graph()
    merged.graph["graph_id"] = UNIFIED_GRAPH_ID
    merged.graph["unified_legal"] = True

    for pkl_path in _iter_legal_graph_pkls(exclude=exclude):
        try:
            with pkl_path.open("rb") as fh:
                graph = pickle.load(fh)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Skip unreadable pickle %s: %s", pkl_path, exc)
            continue
        if not isinstance(graph, nx.MultiDiGraph):
            continue

        for node_id, attrs in graph.nodes(data=True):
            payload = dict(attrs)
            if node_id in merged:
                merged.nodes[node_id].update(payload)
            else:
                merged.add_node(node_id, **payload)

        for source, target, key, attrs in graph.edges(keys=True, data=True):
            edge_key = str(key or attrs.get("relation_type") or "related")
            payload = dict(attrs)
            if merged.has_edge(source, target, key=edge_key):
                merged.edges[source, target, edge_key].update(payload)
            else:
                merged.add_edge(source, target, key=edge_key, **payload)

    return merged


def chunks_from_graph(graph: nx.MultiDiGraph) -> List[Dict[str, Any]]:
    """Serialize graph nodes back into RetrievedChunk-compatible dicts."""
    chunks: List[Dict[str, Any]] = []
    for node_id, attrs in graph.nodes(data=True):
        meta = dict(attrs.get("metadata") or {})
        chunks.append(
            {
                "qdrant_point_id": attrs.get("qdrant_point_id") or node_id,
                "chunk_id": attrs.get("chunk_id") or node_id,
                "document_id": attrs.get("document_id"),
                "judgment_id": attrs.get("judgment_id") or attrs.get("document_id"),
                "source_pdf_id": attrs.get("source_pdf_id"),
                "source_pdf_path": attrs.get("source_pdf_path"),
                "qdrant_collection": attrs.get("qdrant_collection") or "lexia_user_docs",
                "page_number": attrs.get("page_number"),
                "paragraph_index": attrs.get("paragraph_index"),
                "section_title": attrs.get("section_title"),
                "section_type": attrs.get("section_type"),
                "text": attrs.get("text") or "",
                "text_preview": attrs.get("text_preview"),
                "vector": attrs.get("vector"),
                "legal_entities": attrs.get("legal_entities") or [],
                "cited_articles": attrs.get("cited_articles") or [],
                "cited_cases": attrs.get("cited_cases") or [],
                "qdrant_score": attrs.get("qdrant_score"),
                "metadata": meta,
            }
        )
    return chunks


def delete_other_legal_graph_pkls(*, keep: Path) -> List[str]:
    """Delete every legal-graph .pkl except the canonical unified file."""
    removed: List[str] = []
    keep_resolved = keep.resolve()
    for pkl_path in _iter_legal_graph_pkls():
        if pkl_path.resolve() == keep_resolved:
            continue
        try:
            pkl_path.unlink()
            removed.append(str(pkl_path))
            logger.info("Deleted legal graph pickle: %s", pkl_path)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not delete %s: %s", pkl_path, exc)
    return removed


def cleanup_legacy_graph_directories(*, keep: Optional[Path] = None) -> List[str]:
    """Remove historical legal_graph_* artifact folders (admin test runs, etc.)."""
    keep_dir = (keep or unified_dir()).resolve()
    removed: List[str] = []
    root = data_root()
    if not root.exists():
        return removed

    for item in sorted(root.iterdir()):
        if not item.is_dir():
            continue
        if not item.name.startswith("legal_graph"):
            continue
        if item.resolve() == keep_dir:
            continue
        try:
            import shutil

            shutil.rmtree(item)
            removed.append(str(item))
            logger.info("Removed legacy legal graph directory: %s", item)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not remove %s: %s", item, exc)
    return removed


def consolidate_legal_graphs(
    *,
    use_qdrant: bool = True,
    delete_legacy_pkls: bool = True,
    cleanup_legacy_dirs: bool = True,
) -> Dict[str, Any]:
    """Build one judgments-only unified graph from Postgres + Qdrant."""
    from services.legal_graph.judgment_indexer import sync_postgres_judgments_to_qdrant

    out_dir = unified_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    pkl_path = out_dir / UNIFIED_PKL_NAME

    if cleanup_legacy_dirs:
        cleanup_legacy_graph_directories(keep=out_dir)

    sync_stats: Dict[str, Any] = {}
    if use_qdrant:
        try:
            sync_stats = sync_postgres_judgments_to_qdrant()
        except Exception as exc:  # noqa: BLE001
            logger.warning("Judgment Qdrant sync skipped: %s", exc)
            sync_stats = {"skipped": str(exc)}

    summary = build_unified_judgments_graph(
        use_qdrant=use_qdrant,
        delete_legacy_pkls=False,
        fresh=True,
    )
    summary["postgres_sync"] = sync_stats
    summary["source"] = "postgres_sync+qdrant" if sync_stats.get("documents") else summary.get("source")

    if delete_legacy_pkls:
        summary["deleted_pkls"] = delete_other_legal_graph_pkls(keep=pkl_path)

    if cleanup_legacy_dirs:
        summary["deleted_dirs"] = cleanup_legacy_graph_directories(keep=out_dir)

    return summary


def load_fallback_chunks_from_pkls() -> List[Dict[str, Any]]:
    """Load judgment chunks from the canonical unified pickle (legacy pkls are removed)."""
    pkl = unified_pkl_path()
    if pkl.exists():
        try:
            with pkl.open("rb") as fh:
                graph = pickle.load(fh)
            if isinstance(graph, nx.MultiDiGraph) and graph.number_of_nodes() > 0:
                chunks = chunks_from_graph(graph)
                judgment_chunks, _ = _filter_judgment_chunks(chunks)
                return judgment_chunks
        except Exception as exc:  # noqa: BLE001
            logger.warning("Could not load unified pickle %s: %s", pkl, exc)
    return []


def build_unified_judgments_graph(
    *,
    collections: Optional[List[str]] = None,
    query: str = "jurisprudence marocaine jugement motifs décision faits procédure",
    use_qdrant: bool = True,
    max_points: Optional[int] = None,
    output_dir: Optional[Path] = None,
    delete_legacy_pkls: bool = False,
    fresh: bool = False,
) -> Dict[str, Any]:
    """Build or rebuild the canonical unified legal graph pickle."""
    if delete_legacy_pkls:
        return consolidate_legal_graphs(use_qdrant=use_qdrant, delete_legacy_pkls=True)
    out_dir = output_dir or unified_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    pkl_path = out_dir / UNIFIED_PKL_NAME
    graphml_path = out_dir / UNIFIED_GRAPHML_NAME
    summary_path = out_dir / UNIFIED_SUMMARY_NAME

    raw_chunks: List[Dict[str, Any]] = []
    source = "qdrant"
    if use_qdrant:
        try:
            raw_chunks = scroll_judgment_chunks(collections, max_points=max_points)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Qdrant scroll failed, falling back to local pickles: %s", exc)
            source = "fallback_pkls"
            raw_chunks = load_fallback_chunks_from_pkls()
    else:
        source = "fallback_pkls"
        raw_chunks = load_fallback_chunks_from_pkls()

    if not raw_chunks and source == "qdrant":
        source = "fallback_pkls"
        raw_chunks = load_fallback_chunks_from_pkls()

    judgment_chunks, excluded = _filter_judgment_chunks(raw_chunks)
    if not judgment_chunks:
        raise RuntimeError("No judgment chunks available to build unified graph")

    config = LegalGraphConfig(
        graph_file_path=pkl_path,
        graphml_file_path=graphml_path,
        qdrant_collections=collections or DEFAULT_JUDGMENT_COLLECTIONS,
        top_k=len(judgment_chunks),
        judgments_only=True,
        cross_case=True,
        llm_edge_limit=int(os.getenv("LEGAL_GRAPH_LLM_EDGE_LIMIT", "24")),
    )

    shared: Dict[str, Any] = {
        "query": query,
        "legal_graph_config": config,
        "retrieved_chunks": judgment_chunks,
        "judgments_only": True,
        "cross_case": True,
        "enable_cross_judgment": True,
    }

    if fresh:
        shared["graph"] = ensure_legal_graph()
    else:
        LoadGraphNode().run(shared)
    UpsertChunkNodesNode().run(shared)
    ConnectToExistingGraphNode().run(shared)
    shared["graph_file_path"] = str(pkl_path)
    shared["graphml_file_path"] = str(graphml_path)
    SaveGraphNode().run(shared)

    graph: nx.MultiDiGraph = shared["graph"]
    edge_counts, layer_counts, reasoning_edge_count = _edge_stats(graph)

    for mode in ("combined", "discovery", "reasoning"):
        render_graph_png(
            graph,
            out_dir / f"legal_graph_{mode}_view.png",
            mode=mode,
            title=f"Unified Judgments Graph — {mode.title()}",
        )

    documents = {}
    for chunk in judgment_chunks:
        doc_id = str(chunk.get("document_id") or chunk.get("judgment_id") or "unknown")
        meta = chunk.get("metadata") or {}
        documents.setdefault(
            doc_id,
            {
                "document_id": doc_id,
                "title": meta.get("title") or chunk.get("section_title") or doc_id,
                "qdrant_chunks": 0,
                "collection": chunk.get("qdrant_collection"),
            },
        )
        documents[doc_id]["qdrant_chunks"] += 1

    summary = {
        "graph_id": UNIFIED_GRAPH_ID,
        "source": source,
        "source_collections": config.qdrant_collections,
        "selected_documents": list(documents.values()),
        "excluded_documents": excluded,
        "document_count": len(documents),
        "chunk_count": len(judgment_chunks),
        "graph_nodes": graph.number_of_nodes(),
        "graph_edges": graph.number_of_edges(),
        "edge_counts": edge_counts,
        "layer_counts": layer_counts,
        "reasoning_edge_count": reasoning_edge_count,
        "pkl_path": str(pkl_path),
        "graphml_path": str(graphml_path),
        "combined_png": str(out_dir / "legal_graph_combined_view.png"),
        "reasoning_png": str(out_dir / "legal_graph_reasoning_view.png"),
        "discovery_png": str(out_dir / "legal_graph_discovery_view.png"),
    }
    summary_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    graph.graph["unified_judgments"] = True
    graph.graph["graph_id"] = UNIFIED_GRAPH_ID
    with pkl_path.open("wb") as fh:
        pickle.dump(graph, fh)
    graphml_path.parent.mkdir(parents=True, exist_ok=True)
    nx.write_graphml(graphml_safe_copy(graph), graphml_path)

    return summary
