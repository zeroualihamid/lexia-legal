"""Query-time legal-graph retrieval expansion.

At chat time we must never call the LLM — reasoning edges are built *offline* by
the legal-graph build pipeline (``ConnectToExistingGraphNode`` →
``infer_reasoning_edges_for_judgment``) and persisted in the graph pickles. This
module loads those pre-built reasoning edges and, given a set of retrieved chunk
point ids, returns the reasoning-connected neighbours so the agent can pull a
chunk's *legal reasoning chain* (e.g. ``court_reasoning → final_decision``) into
retrieval instead of relying on vector similarity alone.

Node ids in the persisted graphs are Qdrant point ids (verified 1:1 with the
``lexia_user_docs`` collection), so expansion maps cleanly back to retrievable
chunks. The index is cached and only rebuilt when a graph pickle changes, so the
hot path is a couple of dict lookups.
"""

from __future__ import annotations

import glob
import os
import pickle
import threading
from typing import Any, Dict, List

_DATA_DIR = os.getenv("LEGAL_GRAPH_DATA_DIR", "/app/data")

_lock = threading.Lock()
_cache: Dict[str, Any] = {"sig": None, "neighbors": {}, "meta": {}}


def _graph_pickle_paths(data_dir: str) -> List[str]:
    paths: List[str] = []
    for directory in sorted(glob.glob(os.path.join(data_dir, "legal_graph_*"))):
        paths.extend(sorted(glob.glob(os.path.join(directory, "*.pkl"))))
    return paths


def _signature(paths: List[str]) -> tuple:
    return tuple((p, os.path.getmtime(p)) for p in paths if os.path.exists(p))


def _build_index(paths: List[str]):
    """Merge reasoning edges from every persisted legal graph into lookup maps."""
    neighbors: Dict[str, List[Dict[str, Any]]] = {}
    meta: Dict[str, Dict[str, Any]] = {}
    for path in paths:
        try:
            graph = pickle.load(open(path, "rb"))
        except Exception:
            continue
        for node_id, attrs in graph.nodes(data=True):
            point_id = str(attrs.get("qdrant_point_id") or node_id)
            if point_id not in meta:
                meta[point_id] = {
                    "document_id": attrs.get("document_id"),
                    "chunk_index": attrs.get("paragraph_index"),
                    "section_type": attrs.get("section_type"),
                    "judgment_id": attrs.get("judgment_id"),
                    "text": attrs.get("text") or attrs.get("text_preview") or "",
                }
        for source, target, data in graph.edges(data=True):
            if not data.get("reasoning_edge"):
                continue
            source_pid = str(graph.nodes[source].get("qdrant_point_id") or source)
            target_pid = str(graph.nodes[target].get("qdrant_point_id") or target)
            relation = data.get("relation_type")
            confidence = float(data.get("confidence") or 0.0)
            explanation = str(data.get("explanation") or "")
            neighbors.setdefault(source_pid, []).append(
                {
                    "point_id": target_pid,
                    "relation_type": relation,
                    "confidence": confidence,
                    "explanation": explanation,
                    "direction": "successor",
                }
            )
            neighbors.setdefault(target_pid, []).append(
                {
                    "point_id": source_pid,
                    "relation_type": relation,
                    "confidence": confidence,
                    "explanation": explanation,
                    "direction": "predecessor",
                }
            )
    # Strongest reasoning links first.
    for entries in neighbors.values():
        entries.sort(key=lambda e: e["confidence"], reverse=True)
    return neighbors, meta


def _ensure_index() -> Dict[str, Any]:
    paths = _graph_pickle_paths(_DATA_DIR)
    sig = _signature(paths)
    if _cache["sig"] != sig:
        with _lock:
            if _cache["sig"] != sig:
                neighbors, meta = _build_index(paths)
                _cache.update({"sig": sig, "neighbors": neighbors, "meta": meta})
    return _cache


def has_reasoning_graph() -> bool:
    return bool(_ensure_index()["neighbors"])


def expand_point_ids(
    point_ids: List[str],
    *,
    max_neighbors_per_node: int = 3,
    max_total: int = 8,
) -> List[Dict[str, Any]]:
    """Return reasoning-connected neighbours for the given retrieved point ids."""
    index = _ensure_index()
    neighbors = index["neighbors"]
    meta = index["meta"]
    source_set = {str(p) for p in point_ids}
    out: List[Dict[str, Any]] = []
    emitted: set = set()
    for point_id in source_set:
        source_document = (meta.get(point_id) or {}).get("document_id")
        for neighbor in neighbors.get(point_id, [])[:max_neighbors_per_node]:
            neighbor_id = neighbor["point_id"]
            if neighbor_id in source_set or neighbor_id in emitted:
                continue
            node_meta = meta.get(neighbor_id, {})
            # A legal reasoning chain belongs to a single ruling. Restrict expansion
            # to neighbours in the same document, which also filters out spurious
            # cross-document links (e.g. duplicate scans of the same judgment).
            if source_document and node_meta.get("document_id") != source_document:
                continue
            emitted.add(neighbor_id)
            out.append(
                {
                    "source_point_id": point_id,
                    "point_id": neighbor_id,
                    "document_id": node_meta.get("document_id"),
                    "chunk_index": node_meta.get("chunk_index"),
                    "section_type": node_meta.get("section_type"),
                    "text": node_meta.get("text", ""),
                    "relation_type": neighbor["relation_type"],
                    "confidence": neighbor["confidence"],
                    "explanation": neighbor["explanation"],
                    "direction": neighbor["direction"],
                }
            )
            if len(out) >= max_total:
                return out
    return out
