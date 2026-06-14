"""Cosine-similarity search over node ``description_embedding`` vectors."""

from __future__ import annotations

from typing import Any, Dict, List

import networkx as nx
import numpy as np

from .embeddings import EmbeddingService


def _cosine(a: np.ndarray, b: np.ndarray) -> float:
    """Single-vector cosine similarity, NaN-safe.

    Returns ``0.0`` when either vector is zero — that maps the embedding
    fallback (zero vector on encoder failure) to the bottom of the
    ranking, which is exactly the desired behaviour."""
    a = np.asarray(a, dtype=np.float32).reshape(-1)
    b = np.asarray(b, dtype=np.float32).reshape(-1)
    if a.size == 0 or b.size == 0 or a.size != b.size:
        return 0.0
    na = float(np.linalg.norm(a))
    nb = float(np.linalg.norm(b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return float(np.dot(a, b) / (na * nb))


class SemanticSearch:
    """Top-K cosine ranking over node descriptions.

    The embedding service must be the **same** one used at build time —
    otherwise the query and node vectors live in different spaces and
    similarity is meaningless.  The API layer enforces this by re-using
    the global service singleton.
    """

    def __init__(self, embeddings: EmbeddingService) -> None:
        self.embeddings = embeddings

    def query(
        self,
        graph: nx.DiGraph,
        text: str,
        *,
        top_k: int = 5,
    ) -> List[Dict[str, Any]]:
        if top_k <= 0:
            return []
        if graph.number_of_nodes() == 0:
            return []

        q_vec = self.embeddings.encode_one(text or "")
        scored: List[Dict[str, Any]] = []
        for nid, attrs in graph.nodes(data=True):
            score = _cosine(q_vec, attrs.get("description_embedding"))
            scored.append({
                "node_id":          nid,
                "name":             attrs.get("name", nid),
                "description":      attrs.get("description", "") or "",
                "similarity_score": score,
                "parents":          list(attrs.get("parents", []) or []),
                "children":         list(attrs.get("children", []) or []),
            })

        scored.sort(key=lambda r: r["similarity_score"], reverse=True)
        return scored[:top_k]
