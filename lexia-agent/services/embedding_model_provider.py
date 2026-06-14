"""Process-level SentenceTransformer cache.

All call-sites should obtain models via :func:`get_embedding_model` instead of
constructing :class:`sentence_transformers.SentenceTransformer` directly. This
ensures that the heavy weights are loaded at most once per process per model
name, regardless of which entry point (FastAPI, CLI, tests) triggered the call.
"""

from __future__ import annotations

import logging
import threading
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

DEFAULT_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"

_MODELS: Dict[str, Any] = {}
_LOCK = threading.Lock()


def _try_app_state(model_name: str) -> Optional[Any]:
    """Return the FastAPI-preloaded model if it matches ``model_name``.

    Imported lazily so non-API entry points don't pay the FastAPI import cost.
    """
    try:
        from main import app  # type: ignore
    except Exception:
        return None

    cached = getattr(getattr(app, "state", None), "embedding_model", None)
    if cached is None:
        return None

    cached_name = getattr(cached, "_model_card_vars", None) or getattr(
        cached, "model_card_data", None
    )
    # Best-effort name match: SentenceTransformer doesn't expose the source id
    # directly, but the startup pre-load uses DEFAULT_EMBEDDING_MODEL. Trust
    # the pre-load only when the caller asks for the same default name.
    if model_name == DEFAULT_EMBEDDING_MODEL:
        return cached
    return None


def get_embedding_model(model_name: str = DEFAULT_EMBEDDING_MODEL) -> Any:
    """Return a cached :class:`SentenceTransformer` for ``model_name``.

    Construction happens at most once per name per process. Thread-safe.
    """
    cached = _MODELS.get(model_name)
    if cached is not None:
        return cached

    with _LOCK:
        cached = _MODELS.get(model_name)
        if cached is not None:
            return cached

        from_app = _try_app_state(model_name)
        if from_app is not None:
            _MODELS[model_name] = from_app
            return from_app

        from sentence_transformers import SentenceTransformer

        logger.info("Loading SentenceTransformer (provider cache miss): %s", model_name)
        model = SentenceTransformer(model_name)
        _MODELS[model_name] = model
        return model


def register_model(model_name: str, model: Any) -> None:
    """Register an already-loaded model under ``model_name``.

    Called by the FastAPI startup hook so subsequent ``get_embedding_model``
    requests for the same name skip even the ``app.state`` lookup.
    """
    with _LOCK:
        _MODELS[model_name] = model
