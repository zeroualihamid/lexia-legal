"""Process-local cache of the CTE library graph (pickle-backed).

The CTE library is a single persisted NetworkX pickle per library
(``data/cte_graphs/cte-prof-<library>.pkl``), managed by
:class:`services.cte_graph.repository.CTEGraphRepository`.  This module keeps
a thin in-process cache + the shared embedding service so semantic search over
``/chat`` requests does not re-load the pickle every time.
"""

from __future__ import annotations

import logging
import os
import re
import threading
from contextvars import ContextVar
from pathlib import Path
from typing import Dict, Optional, Sequence, Tuple

import networkx as nx

from .embeddings import EmbeddingService

logger = logging.getLogger(__name__)

# Default agent CTE-search library = the populated SKILL library (skill
# `accounting_dashboard`, name `insurance-production-dashboard`). Each library
# corresponds to a SKILL.md (graph id `cte-prof-<slug(skill name)>`); the agent
# binds the matched skill's library per request via set_active_cte_libraries.
DEFAULT_AGENT_CTE_LIBRARIES: Tuple[str, ...] = ("insurance-production-dashboard",)

_reporting_sql_root: Optional[Path] = None
_agent_embedding_service: Optional[EmbeddingService] = None
_graph_cache: Dict[str, nx.DiGraph] = {}
_lock = threading.Lock()


def reporting_sql_dir() -> Path:
    """``brikz-agent/data/reporting/sql`` (legacy path; retained for callers)."""
    global _reporting_sql_root
    if _reporting_sql_root is None:
        _reporting_sql_root = Path(__file__).resolve().parents[2] / "data" / "reporting" / "sql"
    return _reporting_sql_root


# Per-request active libraries, set by the agent flow from the matched skill so
# the CTE *search* reads the SAME graph the tools *write* to (otherwise the
# fast-path searches the default banking library and never finds a CTE the
# agent just saved under a skill graph). When unset, fall back to env/default.
_active_libraries: ContextVar[Optional[Tuple[str, ...]]] = ContextVar(
    "active_cte_libraries", default=None
)


def set_active_cte_libraries(libraries: Optional[Sequence[str]]) -> None:
    """Bind the libraries the CTE search resolves to (``None`` clears)."""
    if not libraries:
        _active_libraries.set(None)
        return
    cleaned = tuple(dict.fromkeys(str(l).strip() for l in libraries if str(l).strip()))
    _active_libraries.set(cleaned or None)


def get_active_cte_libraries() -> Optional[Tuple[str, ...]]:
    """Return the current request's active libraries, or ``None`` when unset."""
    return _active_libraries.get()


def _libraries_from_env() -> Tuple[str, ...]:
    """Active libraries (per-request) → ``LEXIA_CTE_GRAPH_LIBRARIES`` → default."""
    active = _active_libraries.get()
    if active:
        return active
    raw = os.environ.get("LEXIA_CTE_GRAPH_LIBRARIES", "").strip()
    if not raw:
        return DEFAULT_AGENT_CTE_LIBRARIES
    parts = tuple(sorted({p.strip() for p in raw.split(",") if p.strip()}))
    return parts if parts else DEFAULT_AGENT_CTE_LIBRARIES


def graph_id_for_library(library: str) -> str:
    """Map a library name to its persisted pickle graph id (``cte-prof-<slug>``)."""
    slug = re.sub(r"[^a-z0-9]+", "-", (library or "").strip().lower()).strip("-")
    return f"cte-prof-{slug or 'default'}"


def get_agent_cte_embedding_service() -> EmbeddingService:
    """Single :class:`EmbeddingService` per process for build + search."""
    global _agent_embedding_service
    with _lock:
        if _agent_embedding_service is None:
            _agent_embedding_service = EmbeddingService()
        return _agent_embedding_service


def get_cached_library_graph(
    libraries: Optional[Sequence[str]] = None,
) -> Optional[nx.DiGraph]:
    """Return the cached :class:`networkx.DiGraph` loaded from the pickle repository.

    *libraries* defaults to env ``LEXIA_CTE_GRAPH_LIBRARIES`` or
    :data:`DEFAULT_AGENT_CTE_LIBRARIES`.  When several libraries are requested
    their graphs are composed into one.  Returns ``None`` on failure so callers
    degrade gracefully.
    """
    libs = (
        tuple(sorted(set(libraries)))
        if libraries is not None
        else _libraries_from_env()
    )
    cache_key = "|".join(libs)

    with _lock:
        hit = _graph_cache.get(cache_key)
    if hit is not None:
        return hit

    try:
        from .repository import get_repository

        graphs = [get_repository(graph_id_for_library(lib)).load() for lib in libs]
        graphs = [g for g in graphs if g is not None and g.number_of_nodes() > 0]
        if not graphs:
            graph = nx.DiGraph()
        elif len(graphs) == 1:
            graph = graphs[0]
        else:
            graph = nx.compose_all(graphs)
    except Exception as e:
        logger.warning("CTE library graph load failed: %s", e)
        return None

    with _lock:
        _graph_cache[cache_key] = graph
        return graph


def clear_library_graph_cache_for_tests() -> None:
    """Reset caches (pytest only)."""
    global _agent_embedding_service, _reporting_sql_root
    with _lock:
        _graph_cache.clear()
        _agent_embedding_service = None
        _reporting_sql_root = None


def invalidate_cte_library_graph_caches() -> None:
    """Drop in-process library graphs so the next load re-reads the pickle."""
    with _lock:
        _graph_cache.clear()
