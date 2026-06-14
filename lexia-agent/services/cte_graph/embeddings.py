"""Sentence-Transformer embedding helper for the CTE graph service.

The model is the ``all-MiniLM-L6-v2`` checkpoint from the
``sentence-transformers`` library.  We use the same model for indexing
node descriptions at build time and for embedding the user's query at
search time, otherwise cosine similarity is meaningless.

Lifecycle
─────────
``EmbeddingService`` lazily loads the model on first use.  In a long-
running FastAPI process this happens exactly once; subsequent encode
calls reuse the cached object.  We don't share a single global
singleton on purpose — tests instantiate their own to avoid leaking
state.

Failure mode
────────────
If the model can't be loaded (e.g. offline CI) or encoding raises, the
service falls back to a deterministic zero vector of the right size and
logs a warning.  The graph build keeps going so the user still gets a
usable structural view of their SQL.
"""

from __future__ import annotations

import logging
from typing import Iterable, List, Optional

import numpy as np


DEFAULT_MODEL_NAME = "all-MiniLM-L6-v2"
DEFAULT_DIM        = 384  # all-MiniLM-L6-v2

logger = logging.getLogger(__name__)


class EmbeddingService:
    """Thin wrapper around ``sentence_transformers.SentenceTransformer``.

    Parameters
    ----------
    model_name
        Name passed to ``SentenceTransformer(...)``.  Defaults to
        ``all-MiniLM-L6-v2``.
    dim_fallback
        Vector dimension used when the real model can't load — the
        service still returns vectors so callers don't have to special-
        case the failure.  Defaults to 384 (matches the real model).
    """

    def __init__(
        self,
        model_name: str = DEFAULT_MODEL_NAME,
        *,
        dim_fallback: int = DEFAULT_DIM,
    ) -> None:
        self.model_name = model_name
        self._dim = dim_fallback
        self._model = None
        self._load_error: Optional[Exception] = None

    @property
    def dimension(self) -> int:
        """Embedding vector size (real or fallback)."""
        return self._dim

    def _ensure_model(self):
        if self._model is not None or self._load_error is not None:
            return self._model
        try:
            from services.embedding_model_provider import get_embedding_model
            self._model = get_embedding_model(self.model_name)
            sample = self._model.encode(["probe"], show_progress_bar=False)
            self._dim = int(np.asarray(sample).shape[-1])
        except Exception as e:
            self._load_error = e
            logger.warning(
                "EmbeddingService: cannot load %r (%s); falling back to zero "
                "vectors of dimension %d. Search will be inert until model loads.",
                self.model_name, e, self._dim,
            )
        return self._model

    def encode(self, texts: Iterable[str]) -> List[np.ndarray]:
        """Embed a batch of texts. Returns a list of float32 vectors of
        :attr:`dimension` length.  Empty / blank inputs become zero
        vectors so they sort to the bottom of any cosine ranking."""
        items = list(texts)
        if not items:
            return []
        self._ensure_model()
        if self._model is None:
            return [np.zeros(self._dim, dtype=np.float32) for _ in items]

        cleaned = [(t or "").strip() for t in items]
        try:
            arr = self._model.encode(
                cleaned,
                show_progress_bar=False,
                normalize_embeddings=False,
            )
        except Exception as e:
            logger.warning(
                "EmbeddingService.encode failed (%s); returning zero vectors", e
            )
            return [np.zeros(self._dim, dtype=np.float32) for _ in items]

        out: List[np.ndarray] = []
        for raw, v in zip(cleaned, arr):
            if not raw:
                out.append(np.zeros(self._dim, dtype=np.float32))
            else:
                out.append(np.asarray(v, dtype=np.float32))
        return out

    def encode_one(self, text: str) -> np.ndarray:
        """Convenience wrapper for a single string."""
        return self.encode([text])[0]
