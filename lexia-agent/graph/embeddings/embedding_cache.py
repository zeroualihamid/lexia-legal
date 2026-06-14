# graph/embeddings/embedding_cache.py

"""
Embedding Cache
===============

Two-tier cache (memory LRU + disk) for embedding vectors.

    L1 – in-process LRU dict (fast, bounded by max_memory_entries)
    L2 – disk storage as .npy files inside cache_dir

Write path:  set()  → writes L1 + L2
Read path:   get()  → L1 hit → return;  L2 hit → promote to L1 → return;  miss → None

Usage:
    cache = EmbeddingCache(config)
    cache.set("model:sha256abc", [0.1, 0.2, ...])
    vec = cache.get("model:sha256abc")   # → [0.1, 0.2, ...]  or  None
"""

from __future__ import annotations

import json
import os
import time
from collections import OrderedDict
from pathlib import Path
from typing import Dict, List, Optional

from monitoring.logger import get_logger

logger = get_logger(__name__)


class EmbeddingCache:
    """
    Two-tier embedding cache: memory LRU + NumPy disk files.

    Config keys read:
        embedding_cache_dir         – directory for .npy files (default: ./data/embedding_cache)
        embedding_cache_max_memory  – max LRU entries (default: 1000)
        embedding_cache_ttl         – seconds before a disk entry is stale (default: 0 = forever)
    """

    _MANIFEST_FILE = "manifest.json"

    def __init__(self, config=None):
        if config is None:
            from config.settings import settings
            config = settings

        cache_dir   = getattr(config, "embedding_cache_dir",        "./data/embedding_cache")
        max_memory  = getattr(config, "embedding_cache_max_memory",  1000)
        self._ttl   = getattr(config, "embedding_cache_ttl",         0)   # 0 = no expiry

        self._cache_dir  = Path(cache_dir)
        self._cache_dir.mkdir(parents=True, exist_ok=True)

        self._max_memory = max_memory
        self._lru:  OrderedDict[str, List[float]] = OrderedDict()
        self._manifest: Dict[str, float] = self._load_manifest()  # key → timestamp

        logger.info(
            f"EmbeddingCache ready — dir={self._cache_dir}, "
            f"max_memory={max_memory}, ttl={self._ttl}s"
        )

    # ── Public API ────────────────────────────────────────────────────────────

    def get(self, key: str) -> Optional[List[float]]:
        """
        Look up a vector by key.
        Returns the float list or None on miss / expiry.
        """
        # L1 – memory
        if key in self._lru:
            self._lru.move_to_end(key)   # mark as recently used
            return self._lru[key]

        # L2 – disk
        path = self._key_to_path(key)
        if not path.exists():
            return None

        # TTL check
        if self._ttl > 0:
            ts = self._manifest.get(key, 0.0)
            if (time.time() - ts) > self._ttl:
                self._evict_disk(key)
                return None

        try:
            import numpy as np
            vector = np.load(str(path)).tolist()
            self._promote_to_l1(key, vector)
            return vector
        except Exception as e:
            logger.warning(f"Cache read error for {key}: {e}")
            return None

    def set(self, key: str, vector: List[float]) -> None:
        """Store a vector in both L1 and L2."""
        # L1
        self._promote_to_l1(key, vector)

        # L2
        try:
            import numpy as np
            np.save(str(self._key_to_path(key)), np.array(vector, dtype="float32"))
            self._manifest[key] = time.time()
            self._save_manifest()
        except ImportError:
            # Fallback: store as JSON (slower, larger, but works without numpy)
            json_path = self._key_to_path(key).with_suffix(".json")
            json_path.write_text(json.dumps(vector))
            self._manifest[key] = time.time()
            self._save_manifest()
        except Exception as e:
            logger.warning(f"Cache write error for {key}: {e}")

    def delete(self, key: str) -> bool:
        """Remove a single entry from both tiers."""
        self._lru.pop(key, None)
        return self._evict_disk(key)

    def clear(self) -> int:
        """
        Wipe all cached entries.
        Returns the number of disk files removed.
        """
        self._lru.clear()
        count = 0
        for path in self._cache_dir.glob("*.npy"):
            path.unlink(missing_ok=True)
            count += 1
        for path in self._cache_dir.glob("*.json"):
            if path.name != self._MANIFEST_FILE:
                path.unlink(missing_ok=True)
                count += 1
        self._manifest = {}
        self._save_manifest()
        logger.info(f"Cache cleared: {count} files removed")
        return count

    def stats(self) -> Dict:
        """Return current cache statistics."""
        disk_files = len(list(self._cache_dir.glob("*.npy")))
        disk_size  = sum(
            p.stat().st_size for p in self._cache_dir.glob("*.npy")
        ) / (1024 * 1024)   # MB

        return {
            "memory_entries": len(self._lru),
            "disk_entries":   disk_files,
            "disk_size_mb":   round(disk_size, 2),
            "cache_dir":      str(self._cache_dir),
            "ttl_seconds":    self._ttl,
        }

    def warm_up(self, keys: List[str]) -> int:
        """
        Pre-load a list of keys from disk into memory.
        Returns the number successfully promoted.
        """
        count = 0
        for key in keys:
            if key not in self._lru and self.get(key) is not None:
                count += 1
        logger.info(f"Cache warm-up: {count}/{len(keys)} keys loaded into memory")
        return count

    # ── Internals ─────────────────────────────────────────────────────────────

    def _promote_to_l1(self, key: str, vector: List[float]) -> None:
        if key in self._lru:
            self._lru.move_to_end(key)
        else:
            self._lru[key] = vector
            self._lru.move_to_end(key)
            if len(self._lru) > self._max_memory:
                evicted_key, _ = self._lru.popitem(last=False)
                logger.debug(f"LRU eviction: {evicted_key[:20]}")

    def _key_to_path(self, key: str) -> Path:
        """Map a cache key to a filesystem path (avoid illegal chars)."""
        safe = key.replace(":", "_").replace("/", "_").replace("\\", "_")
        return self._cache_dir / f"{safe}.npy"

    def _evict_disk(self, key: str) -> bool:
        path = self._key_to_path(key)
        removed = False
        if path.exists():
            path.unlink()
            removed = True
        self._manifest.pop(key, None)
        return removed

    def _manifest_path(self) -> Path:
        return self._cache_dir / self._MANIFEST_FILE

    def _load_manifest(self) -> Dict[str, float]:
        path = self._manifest_path()
        if path.exists():
            try:
                return json.loads(path.read_text())
            except Exception:
                pass
        return {}

    def _save_manifest(self) -> None:
        try:
            self._manifest_path().write_text(json.dumps(self._manifest))
        except Exception as e:
            logger.warning(f"Failed to save cache manifest: {e}")
