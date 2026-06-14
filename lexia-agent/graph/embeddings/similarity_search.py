# graph/embeddings/similarity_search.py

"""
Similarity Search
=================

Finds the most semantically similar code nodes for a given query.

Two search backends:
    LinearSearch   – exact cosine scan, O(n·d), fine for < 10 000 nodes
    ANNSearch      – approximate nearest-neighbour via faiss (optional),
                     O(log n), needed for large graphs

Usage:
    search  = SimilaritySearch(config)
    results = search.query(
        query_text = "filter dataframe by date range",
        top_k      = 5,
        threshold  = 0.70,
    )
    for r in results:
        print(r.score, r.node_id, r.snippet)
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from graph.embeddings.code_embedder import CodeEmbedder
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Result container
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class SearchResult:
    """A single result returned by SimilaritySearch.query()."""
    node_id:      str
    score:        float          # cosine similarity [0, 1]
    code:         str
    description:  str
    snippet:      str            # first 120 chars of code for display
    metadata:     Dict[str, Any] = field(default_factory=dict)

    def __repr__(self) -> str:
        return (
            f"SearchResult(node={self.node_id[:8]}, "
            f"score={self.score:.3f}, snippet={self.snippet[:50]!r})"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Vector index entry
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class VectorEntry:
    node_id:     str
    vector:      List[float]
    code:        str
    description: str
    metadata:    Dict[str, Any] = field(default_factory=dict)


# ─────────────────────────────────────────────────────────────────────────────
# Main search class
# ─────────────────────────────────────────────────────────────────────────────

class SimilaritySearch:
    """
    Semantic similarity search over stored code embeddings.

    Maintains an in-memory index that is rebuilt from the graph on startup
    and updated incrementally as new nodes are added.

    Config keys read:
        similarity_threshold     – default minimum score (default: 0.70)
        similarity_top_k         – default number of results (default: 5)
        similarity_backend       – 'linear' | 'faiss'  (default: 'linear')
        embedding_model          – forwarded to CodeEmbedder
    """

    def __init__(self, config=None):
        if config is None:
            from config.settings import settings
            config = settings

        self._threshold = getattr(config, "similarity_threshold", 0.70)
        self._top_k     = getattr(config, "similarity_top_k",     5)
        self._backend   = getattr(config, "similarity_backend",   "linear").lower()

        self._embedder  = CodeEmbedder(config)
        self._index:    List[VectorEntry] = []
        self._faiss_index = None          # lazily built when backend == 'faiss'

        logger.info(
            f"SimilaritySearch ready — backend={self._backend}, "
            f"threshold={self._threshold}, top_k={self._top_k}"
        )

    # ── Index management ──────────────────────────────────────────────────────

    def add(
        self,
        node_id:     str,
        code:        str,
        description: str = "",
        metadata:    Optional[Dict] = None,
        force:       bool = False,
    ) -> None:
        """
        Embed and add a code node to the search index.

        Args:
            node_id:     Unique graph node identifier
            code:        Python source code
            description: Human-readable description
            metadata:    Arbitrary dict (stored with result)
            force:       Re-embed even if already indexed
        """
        # Don't double-index unless forced
        if not force and any(e.node_id == node_id for e in self._index):
            logger.debug(f"Node {node_id[:8]} already indexed, skipping")
            return

        embedding = self._embedder.embed_code(code, description, metadata=metadata)

        entry = VectorEntry(
            node_id=node_id,
            vector=embedding.vector,
            code=code,
            description=description,
            metadata=metadata or {},
        )
        self._index.append(entry)
        self._faiss_index = None     # invalidate FAISS index

        logger.debug(f"Indexed node {node_id[:8]} ({len(self._index)} total)")

    def add_batch(self, nodes: List[Dict]) -> None:
        """
        Add multiple nodes at once.

        Each dict must have 'node_id' and 'code'.
        Optional keys: 'description', 'metadata'.
        """
        items = [
            {"code": n["code"], "description": n.get("description", ""),
             "metadata": n.get("metadata", {})}
            for n in nodes
        ]
        embeddings = self._embedder.embed_batch(items)

        for node, emb in zip(nodes, embeddings):
            self._index.append(VectorEntry(
                node_id=node["node_id"],
                vector=emb.vector,
                code=node["code"],
                description=node.get("description", ""),
                metadata=node.get("metadata", {}),
            ))

        self._faiss_index = None
        logger.info(f"Batch indexed {len(nodes)} nodes ({len(self._index)} total)")

    def remove(self, node_id: str) -> bool:
        """Remove a node from the index. Returns True if found."""
        before = len(self._index)
        self._index = [e for e in self._index if e.node_id != node_id]
        removed = len(self._index) < before
        if removed:
            self._faiss_index = None
        return removed

    def clear(self) -> None:
        """Wipe entire index."""
        self._index.clear()
        self._faiss_index = None

    # ── Search ────────────────────────────────────────────────────────────────

    def query(
        self,
        query_text: str,
        top_k:      Optional[int]   = None,
        threshold:  Optional[float] = None,
        filter_fn:  Optional[Any]   = None,
    ) -> List[SearchResult]:
        """
        Find the most similar nodes for a natural-language query.

        Args:
            query_text: e.g. "filter dataframe by date range"
            top_k:      max results (overrides config default)
            threshold:  min cosine similarity (overrides config default)
            filter_fn:  optional callable(VectorEntry) → bool to pre-filter index

        Returns:
            List of SearchResult sorted by score descending
        """
        if not self._index:
            logger.warning("SimilaritySearch index is empty — no results")
            return []

        k         = top_k     if top_k     is not None else self._top_k
        min_score = threshold if threshold is not None else self._threshold

        t0 = time.perf_counter()

        # Embed the query
        query_vector = self._embedder.embed_query(query_text)

        # Choose backend
        if self._backend == "faiss":
            scored = self._faiss_search(query_vector, k, filter_fn)
        else:
            scored = self._linear_search(query_vector, k, filter_fn)

        # Apply threshold
        results = [
            _to_result(entry, score)
            for entry, score in scored
            if score >= min_score
        ]

        elapsed = (time.perf_counter() - t0) * 1000
        logger.info(
            f"Query '{query_text[:50]}' → {len(results)} results "
            f"(threshold={min_score}, {elapsed:.1f} ms)"
        )
        return results

    def query_by_vector(
        self,
        vector:     List[float],
        top_k:      Optional[int]   = None,
        threshold:  Optional[float] = None,
        filter_fn:  Optional[Any]   = None,
    ) -> List[SearchResult]:
        """
        Search using a pre-computed vector (e.g. from CodeEmbedder directly).
        Same as query() but skips the embedding step.
        """
        k         = top_k     if top_k     is not None else self._top_k
        min_score = threshold if threshold is not None else self._threshold

        if self._backend == "faiss":
            scored = self._faiss_search(vector, k, filter_fn)
        else:
            scored = self._linear_search(vector, k, filter_fn)

        return [
            _to_result(e, s) for e, s in scored if s >= min_score
        ]

    # ── Backend implementations ───────────────────────────────────────────────

    def _linear_search(
        self,
        query_vec: List[float],
        k: int,
        filter_fn: Optional[Any],
    ) -> List[Tuple[VectorEntry, float]]:
        """Exact cosine similarity scan — O(n·d)."""
        candidates = (
            [e for e in self._index if filter_fn(e)]
            if filter_fn else self._index
        )

        scored = [
            (entry, _cosine(query_vec, entry.vector))
            for entry in candidates
        ]
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:k]

    def _faiss_search(
        self,
        query_vec: List[float],
        k: int,
        filter_fn: Optional[Any],
    ) -> List[Tuple[VectorEntry, float]]:
        """
        Approximate nearest-neighbour search via FAISS.
        Falls back to linear if faiss is not installed.
        """
        try:
            import faiss
            import numpy as np
        except ImportError:
            logger.warning("faiss not installed, falling back to linear search")
            return self._linear_search(query_vec, k, filter_fn)

        # Rebuild FAISS index when stale
        if self._faiss_index is None:
            self._rebuild_faiss(faiss, np)

        q = np.array([query_vec], dtype="float32")
        faiss.normalize_L2(q)
        distances, indices = self._faiss_index.search(q, min(k * 2, len(self._index)))

        results = []
        for dist, idx in zip(distances[0], indices[0]):
            if idx < 0:
                continue
            entry = self._index[idx]
            if filter_fn and not filter_fn(entry):
                continue
            results.append((entry, float(dist)))   # dist is inner-product = cosine after L2-norm
            if len(results) == k:
                break
        return results

    def _rebuild_faiss(self, faiss, np) -> None:
        logger.info(f"Building FAISS index ({len(self._index)} vectors)…")
        dim = len(self._index[0].vector)
        idx = faiss.IndexFlatIP(dim)   # inner-product after L2 norm = cosine
        vecs = np.array([e.vector for e in self._index], dtype="float32")
        faiss.normalize_L2(vecs)
        idx.add(vecs)
        self._faiss_index = idx
        logger.info("FAISS index built ✓")

    # ── Stats ─────────────────────────────────────────────────────────────────

    def stats(self) -> Dict:
        return {
            "index_size":    len(self._index),
            "dimension":     self._embedder.dimension,
            "model":         self._embedder.model_name,
            "backend":       self._backend,
            "threshold":     self._threshold,
            "faiss_ready":   self._faiss_index is not None,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _cosine(a: List[float], b: List[float]) -> float:
    """Cosine similarity between two float vectors."""
    dot  = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a)) or 1e-10
    norm_b = math.sqrt(sum(y * y for y in b)) or 1e-10
    return dot / (norm_a * norm_b)


def _to_result(entry: VectorEntry, score: float) -> SearchResult:
    snippet = entry.code.strip().replace("\n", " ")[:120]
    return SearchResult(
        node_id=entry.node_id,
        score=round(score, 4),
        code=entry.code,
        description=entry.description,
        snippet=snippet,
        metadata=entry.metadata,
    )
