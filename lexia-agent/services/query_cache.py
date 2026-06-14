"""
SemanticQueryCache — Cache NL queries + SQL + results indexed by semantic embedding.

Similar future queries return instantly without hitting the LLM.

Storage layout::

    data/query_cache/
      index.parquet       # query_hash | query_text | source_ids | sql_json |
                          # result_file | created_at | ttl_hours | target_types
      embeddings.npy      # dense float32 matrix, row-aligned with index.parquet
      results/
        <hash>.parquet    # result DataFrame for cached query
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

_EMPTY_INDEX_COLS = [
    "query_hash",
    "query_text",
    "source_ids_json",
    "sql_json",
    "result_file",
    "created_at",
    "ttl_hours",
    "target_types_json",
]


@dataclass
class CachedQueryResult:
    query_text: str
    sql: List[Dict]
    results: List[Dict]
    source_ids: List[str]
    target_types: List[str]
    created_at: datetime
    similarity: float


def _query_hash(text: str) -> str:
    return hashlib.sha256(text.strip().lower().encode()).hexdigest()[:16]


class SemanticQueryCache:
    """Semantic cache for NL queries + SQL + results."""

    def __init__(
        self,
        cache_dir: Path,
        model: Any,  # SentenceTransformer (lazy or pre-loaded)
        similarity_threshold: float = 0.92,
        ttl_hours: int = 24,
    ):
        self._cache_dir = Path(cache_dir)
        self._results_dir = self._cache_dir / "results"
        self._index_path = self._cache_dir / "index.parquet"
        self._embeddings_path = self._cache_dir / "embeddings.npy"
        self._model = model
        self._threshold = similarity_threshold
        self._ttl = timedelta(hours=ttl_hours)

        self._index: Optional[pd.DataFrame] = None
        self._embeddings: Optional[np.ndarray] = None

        self._cache_dir.mkdir(parents=True, exist_ok=True)
        self._results_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Bootstrap / persistence
    # ------------------------------------------------------------------

    def load(self) -> None:
        """Load index + embeddings from disk."""
        if self._index_path.exists() and self._embeddings_path.exists():
            try:
                self._index = pd.read_parquet(self._index_path)
                self._embeddings = np.load(self._embeddings_path)
                logger.info(
                    "[query_cache] Loaded %d cached queries",
                    len(self._index),
                )
            except Exception as exc:
                logger.warning("[query_cache] Failed to load cache: %s", exc)
                self._index = None
                self._embeddings = None
        else:
            self._index = pd.DataFrame(columns=_EMPTY_INDEX_COLS)
            self._embeddings = np.empty((0, 0), dtype=np.float32)

    def _save_index(self) -> None:
        if self._index is not None:
            self._index.to_parquet(self._index_path, index=False)
        if self._embeddings is not None and self._embeddings.size > 0:
            np.save(self._embeddings_path, self._embeddings)

    # ------------------------------------------------------------------
    # Lookup
    # ------------------------------------------------------------------

    def lookup(
        self,
        query: str,
        source_id: Optional[str] = None,
    ) -> Optional[CachedQueryResult]:
        """Embed the NL query, cosine-search against stored embeddings.

        Returns the best match above threshold, or ``None``.
        """
        if self._index is None or self._index.empty or self._embeddings is None or self._embeddings.size == 0:
            return None

        q_emb = self._encode(query)
        if q_emb is None:
            return None

        # Cosine similarity
        norms = np.linalg.norm(self._embeddings, axis=1, keepdims=True)
        norms = np.where(norms == 0, 1, norms)
        normalized = self._embeddings / norms
        q_norm = q_emb / (np.linalg.norm(q_emb) or 1)
        sims = normalized @ q_norm

        now = datetime.now(timezone.utc)
        best_idx, best_sim = -1, 0.0
        for i in range(len(sims)):
            if sims[i] < self._threshold:
                continue
            row = self._index.iloc[i]
            created = pd.Timestamp(row["created_at"]).to_pydatetime()
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            ttl = timedelta(hours=int(row.get("ttl_hours", 24)))
            if now - created > ttl:
                continue
            if source_id:
                src_ids = json.loads(row.get("source_ids_json", "[]"))
                if source_id not in src_ids and src_ids:
                    continue
            if sims[i] > best_sim:
                best_sim = sims[i]
                best_idx = i

        if best_idx < 0:
            return None

        row = self._index.iloc[best_idx]
        result_file = self._results_dir / row["result_file"]
        if not result_file.exists():
            return None

        try:
            results = json.loads(result_file.read_text())
        except Exception:
            return None

        return CachedQueryResult(
            query_text=row["query_text"],
            sql=json.loads(row["sql_json"]),
            results=results,
            source_ids=json.loads(row.get("source_ids_json", "[]")),
            target_types=json.loads(row.get("target_types_json", "[]")),
            created_at=pd.Timestamp(row["created_at"]).to_pydatetime(),
            similarity=float(best_sim),
        )

    # ------------------------------------------------------------------
    # Store
    # ------------------------------------------------------------------

    def store(
        self,
        query: str,
        sql: List[Dict],
        results: List[Dict],
        source_ids: List[str],
    ) -> None:
        """Embed the NL query text, append to index, save result as JSON."""
        q_emb = self._encode(query)
        if q_emb is None:
            return

        qh = _query_hash(query)
        result_filename = f"{qh}.json"
        result_path = self._results_dir / result_filename

        # Write result data
        try:
            result_path.write_text(json.dumps(results, default=str, ensure_ascii=False))
        except Exception as exc:
            logger.warning("[query_cache] Failed to write result file: %s", exc)
            return

        target_types = list(set(q.get("target", "duckdb") for q in sql))

        new_row = pd.DataFrame([{
            "query_hash": qh,
            "query_text": query,
            "source_ids_json": json.dumps(source_ids),
            "sql_json": json.dumps(sql, default=str),
            "result_file": result_filename,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "ttl_hours": int(self._ttl.total_seconds() // 3600),
            "target_types_json": json.dumps(target_types),
        }])

        if self._index is None or self._index.empty:
            self._index = new_row
            self._embeddings = q_emb.reshape(1, -1)
        else:
            self._index = pd.concat([self._index, new_row], ignore_index=True)
            self._embeddings = np.vstack([self._embeddings, q_emb.reshape(1, -1)])

        self._save_index()
        logger.info("[query_cache] Stored query (hash=%s, %d results)", qh, len(results))

    # ------------------------------------------------------------------
    # Invalidation
    # ------------------------------------------------------------------

    def invalidate(self, source_id: Optional[str] = None) -> int:
        """Remove all entries involving *source_id*. If None, clear everything."""
        if self._index is None or self._index.empty:
            return 0

        if source_id is None:
            count = len(self._index)
            self._index = pd.DataFrame(columns=_EMPTY_INDEX_COLS)
            self._embeddings = np.empty((0, 0), dtype=np.float32)
            # Remove all result files
            for f in self._results_dir.glob("*.json"):
                f.unlink(missing_ok=True)
            self._save_index()
            logger.info("[query_cache] Invalidated ALL %d entries", count)
            return count

        mask = self._index["source_ids_json"].apply(
            lambda s: source_id in json.loads(s) if isinstance(s, str) else False
        )
        to_remove = self._index[mask]
        count = len(to_remove)

        if count == 0:
            return 0

        for _, row in to_remove.iterrows():
            rf = self._results_dir / row["result_file"]
            rf.unlink(missing_ok=True)

        keep = ~mask
        self._index = self._index[keep].reset_index(drop=True)
        if self._embeddings is not None and self._embeddings.shape[0] == len(keep):
            self._embeddings = self._embeddings[keep.values]
        else:
            self._embeddings = np.empty((0, 0), dtype=np.float32)

        self._save_index()
        logger.info("[query_cache] Invalidated %d entries for source '%s'", count, source_id)
        return count

    def prune_expired(self) -> int:
        """Remove entries older than TTL."""
        if self._index is None or self._index.empty:
            return 0

        now = datetime.now(timezone.utc)
        expired_mask = self._index.apply(
            lambda row: (
                now - pd.Timestamp(row["created_at"]).to_pydatetime().replace(tzinfo=timezone.utc)
            ) > timedelta(hours=int(row.get("ttl_hours", 24))),
            axis=1,
        )

        to_remove = self._index[expired_mask]
        count = len(to_remove)
        if count == 0:
            return 0

        for _, row in to_remove.iterrows():
            rf = self._results_dir / row["result_file"]
            rf.unlink(missing_ok=True)

        keep = ~expired_mask
        self._index = self._index[keep].reset_index(drop=True)
        if self._embeddings is not None and self._embeddings.shape[0] == len(keep):
            self._embeddings = self._embeddings[keep.values]

        self._save_index()
        logger.info("[query_cache] Pruned %d expired entries", count)
        return count

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _encode(self, text: str) -> Optional[np.ndarray]:
        try:
            if hasattr(self._model, "encode"):
                return np.array(self._model.encode([text])[0], dtype=np.float32)
            elif callable(self._model):
                return np.array(self._model(text), dtype=np.float32)
        except Exception as exc:
            logger.warning("[query_cache] Encoding failed: %s", exc)
        return None

    @property
    def size(self) -> int:
        return len(self._index) if self._index is not None else 0


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_query_cache: Optional[SemanticQueryCache] = None


def get_query_cache() -> Optional[SemanticQueryCache]:
    return _query_cache


def init_query_cache(
    cache_dir: str = "data/query_cache",
    model: Any = None,
    similarity_threshold: float = 0.92,
    ttl_hours: int = 24,
) -> SemanticQueryCache:
    """Initialize the global query cache singleton. Call once at startup."""
    global _query_cache
    _query_cache = SemanticQueryCache(
        cache_dir=Path(cache_dir),
        model=model,
        similarity_threshold=similarity_threshold,
        ttl_hours=ttl_hours,
    )
    _query_cache.load()
    _query_cache.prune_expired()
    logger.info(
        "[query_cache] Initialized: %d entries, threshold=%.2f, ttl=%dh",
        _query_cache.size, similarity_threshold, ttl_hours,
    )
    return _query_cache
