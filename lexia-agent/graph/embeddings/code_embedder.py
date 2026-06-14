# graph/embeddings/code_embedder.py

"""
Code Embedder
=============

High-level façade that:
  1. Combines code + description into a single rich text for embedding
  2. Delegates to the configured EmbeddingModel
  3. Reads/writes through EmbeddingCache
  4. Exposes clean helpers used by GraphBuilder and SimilaritySearch

Usage:
    embedder = CodeEmbedder(config)

    # Single embedding
    emb = embedder.embed_code(code, description="load parquet file")
    print(emb.vector[:5])   # [0.02, -0.11, ...]
    print(emb.dimension)    # 768

    # Batch
    embeddings = embedder.embed_batch([
        {"code": code1, "description": "load data"},
        {"code": code2, "description": "filter rows"},
    ])
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from graph.embeddings.embedding_models import BaseEmbeddingModel, create_embedding_model
from graph.embeddings.embedding_cache  import EmbeddingCache
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Data class
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class CodeEmbedding:
    """Embedding result for a single code snippet."""
    vector:      List[float]
    text_used:   str          # the combined text that was embedded
    code_hash:   str          # SHA-256 of the raw code (cache key)
    model_name:  str
    from_cache:  bool = False
    elapsed_ms:  float = 0.0
    metadata:    Dict[str, Any] = field(default_factory=dict)

    @property
    def dimension(self) -> int:
        return len(self.vector)

    def to_dict(self) -> Dict:
        return {
            "vector":     self.vector,
            "text_used":  self.text_used,
            "code_hash":  self.code_hash,
            "model_name": self.model_name,
            "from_cache": self.from_cache,
            "elapsed_ms": self.elapsed_ms,
            "metadata":   self.metadata,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Embedder
# ─────────────────────────────────────────────────────────────────────────────

class CodeEmbedder:
    """
    Generates embeddings for code snippets.

    The embedding represents BOTH the code and its description so that
    semantic search can match queries like "load parquet" to code that
    reads a file even when exact tokens differ.
    """

    # Weight applied to description tokens (repeated to boost signal)
    _DESC_REPEATS = 3

    def __init__(self, config=None):
        if config is None:
            from config.settings import settings
            config = settings

        self._model: BaseEmbeddingModel = create_embedding_model(config)
        self._cache: EmbeddingCache     = EmbeddingCache(config)

        logger.info(
            f"CodeEmbedder ready — model={self._model.model_name}, "
            f"dim={self._model.dimension}"
        )

    # ── Public API ────────────────────────────────────────────────────────────

    def embed_code(
        self,
        code:        str,
        description: str = "",
        metadata:    Optional[Dict] = None,
        force:       bool = False,
    ) -> CodeEmbedding:
        """
        Embed a single code snippet (with optional description).

        Args:
            code:        Python source code
            description: Human-readable description of what the code does
            metadata:    Arbitrary dict stored alongside the embedding
            force:       If True, bypass cache and re-embed

        Returns:
            CodeEmbedding with .vector, .code_hash, .from_cache, etc.
        """
        code_hash = _sha256(code)
        cache_key = f"{self._model.model_name}:{code_hash}"

        # Cache hit
        if not force:
            cached = self._cache.get(cache_key)
            if cached is not None:
                logger.debug(f"Cache hit for {code_hash[:8]}")
                return CodeEmbedding(
                    vector=cached,
                    text_used="<from cache>",
                    code_hash=code_hash,
                    model_name=self._model.model_name,
                    from_cache=True,
                    metadata=metadata or {},
                )

        # Build combined text and embed
        combined = self._build_text(code, description)
        t0 = time.perf_counter()
        vector = self._model.embed(combined)
        elapsed = (time.perf_counter() - t0) * 1000

        # Store in cache
        self._cache.set(cache_key, vector)

        logger.debug(
            f"Embedded {code_hash[:8]} ({len(code)} chars) "
            f"in {elapsed:.1f} ms"
        )

        return CodeEmbedding(
            vector=vector,
            text_used=combined,
            code_hash=code_hash,
            model_name=self._model.model_name,
            from_cache=False,
            elapsed_ms=elapsed,
            metadata=metadata or {},
        )

    def embed_query(self, query: str) -> List[float]:
        """
        Embed a natural-language search query.
        No caching — queries are short and varied.
        """
        cleaned = _clean_query(query)
        return self._model.embed(cleaned)

    def embed_batch(
        self,
        items: List[Dict[str, str]],
        force: bool = False,
    ) -> List[CodeEmbedding]:
        """
        Embed a list of {"code": ..., "description": ...} dicts efficiently.

        Cache hits are resolved first; only misses are sent to the model
        in a single batched inference call.
        """
        results:  List[Optional[CodeEmbedding]] = [None] * len(items)
        to_embed: List[tuple[int, str, str, str]] = []  # (idx, combined, hash, desc)

        # Phase 1 — resolve cache hits
        for idx, item in enumerate(items):
            code      = item.get("code", "")
            desc      = item.get("description", "")
            code_hash = _sha256(code)
            cache_key = f"{self._model.model_name}:{code_hash}"

            if not force:
                cached = self._cache.get(cache_key)
                if cached is not None:
                    results[idx] = CodeEmbedding(
                        vector=cached,
                        text_used="<from cache>",
                        code_hash=code_hash,
                        model_name=self._model.model_name,
                        from_cache=True,
                        metadata=item.get("metadata", {}),
                    )
                    continue

            combined = self._build_text(code, desc)
            to_embed.append((idx, combined, code_hash, code))

        # Phase 2 — batch inference for misses
        if to_embed:
            texts   = [t[1] for t in to_embed]
            t0      = time.perf_counter()
            vectors = self._model.embed_batch(texts)
            elapsed = (time.perf_counter() - t0) * 1000
            logger.info(
                f"Batch embedded {len(to_embed)} snippets in {elapsed:.1f} ms"
            )

            for (idx, combined, code_hash, code), vector in zip(to_embed, vectors):
                cache_key = f"{self._model.model_name}:{code_hash}"
                self._cache.set(cache_key, vector)
                results[idx] = CodeEmbedding(
                    vector=vector,
                    text_used=combined,
                    code_hash=code_hash,
                    model_name=self._model.model_name,
                    from_cache=False,
                    elapsed_ms=elapsed / len(to_embed),
                    metadata=items[idx].get("metadata", {}),
                )

        return results  # type: ignore[return-value]

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def dimension(self) -> int:
        return self._model.dimension

    @property
    def model_name(self) -> str:
        return self._model.model_name

    # ── Internals ─────────────────────────────────────────────────────────────

    def _build_text(self, code: str, description: str) -> str:
        """
        Combine code and description into a single embedding-friendly string.

        Description is repeated to give it higher weight relative to the
        (often noisy) code tokens.
        """
        parts = []
        if description:
            # Repeat description to amplify its semantic signal
            parts.append((description.strip() + " ") * self._DESC_REPEATS)
        parts.append(_clean_code(code))
        return " ".join(parts).strip()


# ─────────────────────────────────────────────────────────────────────────────
# Utilities
# ─────────────────────────────────────────────────────────────────────────────

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _clean_code(code: str) -> str:
    """
    Light normalisation: strip comments and blank lines so two equivalent
    snippets that differ only in comments get the same embedding.
    """
    lines = []
    for line in code.splitlines():
        stripped = line.strip()
        if stripped and not stripped.startswith("#"):
            lines.append(stripped)
    return " ".join(lines)


def _clean_query(query: str) -> str:
    """Lowercase and strip punctuation for consistent query embedding."""
    query = query.lower().strip()
    query = re.sub(r"[^\w\s]", " ", query)
    return re.sub(r"\s+", " ", query)
