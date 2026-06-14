# graph/embeddings/embedding_models.py

"""
Embedding Model Implementations
================================

Provides a common interface across four backends:

    CodeBERTModel            – microsoft/codebert-base (best for code)
    SentenceTransformerModel – paraphrase-multilingual-MiniLM-L12-v2 (multilingual, fast)
    OpenAIEmbeddingModel     – text-embedding-3-small (API-based, no local GPU)
    TFIDFModel               – TF-IDF sparse → dense (zero-dependency fallback)

All models expose the same API:
    model.embed(text: str) -> List[float]
    model.embed_batch(texts: List[str]) -> List[List[float]]
    model.dimension -> int
"""

from __future__ import annotations

import hashlib
import os
from abc import ABC, abstractmethod
from typing import List, Optional

from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Abstract base
# ─────────────────────────────────────────────────────────────────────────────

class BaseEmbeddingModel(ABC):
    """Common interface for all embedding backends."""

    @property
    @abstractmethod
    def dimension(self) -> int:
        """Output vector dimension."""

    @property
    @abstractmethod
    def model_name(self) -> str:
        """Human-readable model identifier."""

    @abstractmethod
    def embed(self, text: str) -> List[float]:
        """Embed a single text string → float vector."""

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        """
        Embed multiple texts.  Default: loop over embed().
        Override for true batch inference.
        """
        return [self.embed(t) for t in texts]

    def __repr__(self) -> str:
        return f"<{self.__class__.__name__} model={self.model_name} dim={self.dimension}>"


# ─────────────────────────────────────────────────────────────────────────────
# CodeBERT
# ─────────────────────────────────────────────────────────────────────────────

class CodeBERTModel(BaseEmbeddingModel):
    """
    microsoft/codebert-base  — 768-dim bimodal encoder trained on
    (code, docstring) pairs.  Best for code similarity tasks.

    Requires: pip install transformers torch
    """

    _HUGGINGFACE_ID = "microsoft/codebert-base"

    def __init__(self, device: Optional[str] = None):
        self._device = device or ("cuda" if self._cuda_available() else "cpu")
        self._tokenizer = None
        self._model = None
        logger.info(f"CodeBERTModel will use device: {self._device}")

    # lazy-load so import is instant even without torch installed
    def _load(self):
        if self._model is not None:
            return
        try:
            from transformers import RobertaTokenizer, RobertaModel
            import torch
            logger.info(f"Loading {self._HUGGINGFACE_ID} …")
            self._tokenizer = RobertaTokenizer.from_pretrained(self._HUGGINGFACE_ID)
            self._model     = RobertaModel.from_pretrained(self._HUGGINGFACE_ID)
            self._model.eval()
            self._model.to(self._device)
            self._torch = torch
            logger.info("CodeBERT loaded ✓")
        except ImportError:
            raise ImportError(
                "transformers and torch are required for CodeBERTModel. "
                "pip install transformers torch"
            )

    @property
    def dimension(self) -> int:
        return 768

    @property
    def model_name(self) -> str:
        return self._HUGGINGFACE_ID

    def embed(self, text: str) -> List[float]:
        self._load()
        torch = self._torch
        inputs = self._tokenizer(
            text,
            return_tensors="pt",
            truncation=True,
            max_length=512,
            padding=True,
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = self._model(**inputs)
        # CLS token → mean pool is more robust for longer snippets
        vector = outputs.last_hidden_state.mean(dim=1).squeeze().cpu().tolist()
        return vector

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        self._load()
        torch = self._torch
        inputs = self._tokenizer(
            texts,
            return_tensors="pt",
            truncation=True,
            max_length=512,
            padding=True,
        )
        inputs = {k: v.to(self._device) for k, v in inputs.items()}
        with torch.no_grad():
            outputs = self._model(**inputs)
        vectors = outputs.last_hidden_state.mean(dim=1).cpu().tolist()
        return vectors

    @staticmethod
    def _cuda_available() -> bool:
        try:
            import torch
            return torch.cuda.is_available()
        except ImportError:
            return False


# ─────────────────────────────────────────────────────────────────────────────
# Sentence-Transformers
# ─────────────────────────────────────────────────────────────────────────────

class SentenceTransformerModel(BaseEmbeddingModel):
    """
    paraphrase-multilingual-MiniLM-L12-v2  — 384-dim, multilingual encoder.
    Supports 50+ languages including French, English, Spanish, etc.
    Ideal for multilingual applications like French financial queries.

    Requires: pip install sentence-transformers
    """

    def __init__(self, model_id: str = "paraphrase-multilingual-MiniLM-L12-v2"):
        self._model_id = model_id
        self._model    = None

    def _load(self):
        if self._model is not None:
            return
        try:
            from services.embedding_model_provider import get_embedding_model
            self._model = get_embedding_model(self._model_id)
        except ImportError:
            raise ImportError(
                "sentence-transformers required. "
                "pip install sentence-transformers"
            )

    @property
    def dimension(self) -> int:
        # common sizes for popular models
        _dims = {
            "all-MiniLM-L6-v2": 384,
            "all-mpnet-base-v2": 768,
            "paraphrase-multilingual-MiniLM-L12-v2": 384,
        }
        return _dims.get(self._model_id, 384)

    @property
    def model_name(self) -> str:
        return self._model_id

    def embed(self, text: str) -> List[float]:
        self._load()
        return self._model.encode(text, convert_to_numpy=True).tolist()

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        self._load()
        return self._model.encode(texts, convert_to_numpy=True).tolist()


# ─────────────────────────────────────────────────────────────────────────────
# OpenAI Embeddings
# ─────────────────────────────────────────────────────────────────────────────

class OpenAIEmbeddingModel(BaseEmbeddingModel):
    """
    text-embedding-3-small  — 1536-dim, API-based (no local GPU needed).
    Highest quality but incurs API cost.

    Requires: pip install openai
    """

    _MODEL_DIMS = {
        "text-embedding-3-small": 1536,
        "text-embedding-3-large": 3072,
        "text-embedding-ada-002": 1536,
    }

    def __init__(
        self,
        model_id: str = "text-embedding-3-small",
        api_key: Optional[str] = None,
    ):
        self._model_id = model_id
        self._api_key  = api_key or os.getenv("OPENAI_API_KEY", "")
        self._client   = None

    def _load(self):
        if self._client is not None:
            return
        try:
            from openai import OpenAI
            self._client = OpenAI(api_key=self._api_key)
            logger.info(f"OpenAI embedding client ready ({self._model_id})")
        except ImportError:
            raise ImportError("openai package required.  pip install openai")

    @property
    def dimension(self) -> int:
        return self._MODEL_DIMS.get(self._model_id, 1536)

    @property
    def model_name(self) -> str:
        return self._model_id

    def embed(self, text: str) -> List[float]:
        self._load()
        response = self._client.embeddings.create(input=text, model=self._model_id)
        return response.data[0].embedding

    def embed_batch(self, texts: List[str]) -> List[List[float]]:
        self._load()
        response = self._client.embeddings.create(input=texts, model=self._model_id)
        # API returns results in order
        return [item.embedding for item in sorted(response.data, key=lambda x: x.index)]


# ─────────────────────────────────────────────────────────────────────────────
# TF-IDF fallback (zero heavy dependencies)
# ─────────────────────────────────────────────────────────────────────────────

class TFIDFModel(BaseEmbeddingModel):
    """
    TF-IDF bag-of-words reduced to a fixed-size dense vector via hashing.
    Zero external dependencies — always works as a fallback.
    Much weaker than neural models but instant and free.
    """

    def __init__(self, dimension: int = 256):
        self._dim = dimension

    @property
    def dimension(self) -> int:
        return self._dim

    @property
    def model_name(self) -> str:
        return f"tfidf-hash-{self._dim}"

    def embed(self, text: str) -> List[float]:
        """
        Hash each token into a bucket, accumulate TF weights,
        then L2-normalise to a unit vector.
        """
        import math, re
        tokens = re.findall(r"[a-zA-Z_]\w*", text.lower())
        counts: dict[int, float] = {}
        for tok in tokens:
            idx = int(hashlib.md5(tok.encode()).hexdigest(), 16) % self._dim
            counts[idx] = counts.get(idx, 0.0) + 1.0

        vec = [0.0] * self._dim
        for idx, cnt in counts.items():
            vec[idx] = 1.0 + math.log(cnt)          # TF

        norm = math.sqrt(sum(x * x for x in vec)) or 1.0
        return [x / norm for x in vec]


# ─────────────────────────────────────────────────────────────────────────────
# Factory
# ─────────────────────────────────────────────────────────────────────────────

def create_embedding_model(config=None) -> BaseEmbeddingModel:
    """
    Create the embedding model specified in config (or a sensible fallback).

    Config keys read:
        embedding_model  – 'codebert' | 'sentence-transformer' | 'openai' | 'tfidf'
        embedding_model_id – override the specific HuggingFace / OpenAI model string
        openai_api_key   – only for OpenAI backend
    """
    if config is None:
        from config.settings import settings
        config = settings

    backend    = getattr(config, "embedding_model",    "codebert").lower()
    model_id   = getattr(config, "embedding_model_id", None)
    openai_key = getattr(config, "openai_api_key",     None)

    logger.info(f"Creating embedding model: backend={backend}")

    try:
        if backend == "codebert":
            return CodeBERTModel()

        if backend in ("sentence-transformer", "sentence_transformer", "sbert"):
            mid = model_id or "paraphrase-multilingual-MiniLM-L12-v2"
            return SentenceTransformerModel(mid)

        if backend == "openai":
            mid = model_id or "text-embedding-3-small"
            return OpenAIEmbeddingModel(mid, api_key=openai_key)

        if backend == "tfidf":
            return TFIDFModel()

        logger.warning(f"Unknown embedding backend '{backend}', falling back to TF-IDF")
        return TFIDFModel()

    except ImportError as e:
        logger.warning(f"Could not load {backend}: {e}. Falling back to TF-IDF.")
        return TFIDFModel()
