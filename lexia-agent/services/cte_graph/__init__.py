"""CTE dependency graph — public surface.

This package exposes a small, self-contained service layer to:

1. parse a SQL string containing ``WITH … AS (…)`` CTEs,
2. detect parent → child dependencies between CTEs (name-based),
3. embed each CTE description with ``all-MiniLM-L6-v2`` (sentence-transformers),
4. store the resulting :class:`networkx.DiGraph` in memory + on disk (pickle),
5. serve it to a ReactFlow front-end (nodes + edges + path analysis + search).

Everything is intentionally minimal: no DB, no async, no caching layer.
For a production-scale variant, swap :class:`GraphStore` for a Postgres /
S3-backed implementation and the in-memory embedding lookup for pgvector
or Qdrant.  The service interfaces are designed to make those swaps
straightforward.
"""

from .embeddings import EmbeddingService
from .graph_builder import GraphBuilder, BuildError, CycleError, ParseError
from .graph_store import GraphStore
from .library_graph_cache import (
    clear_library_graph_cache_for_tests,
    DEFAULT_AGENT_CTE_LIBRARIES,
    get_agent_cte_embedding_service,
    get_cached_library_graph,
    invalidate_cte_library_graph_caches,
    reporting_sql_dir,
)
from .library_loader import LibraryCTE, LibraryError, load_library, DEFAULT_LIBRARIES
from .paths import ParentPathFinder
from .reactflow import to_reactflow
from .search import SemanticSearch
from .sql_parser import CTEDef, extract_ctes


__all__ = [
    "BuildError",
    "CycleError",
    "ParseError",
    "CTEDef",
    "DEFAULT_AGENT_CTE_LIBRARIES",
    "DEFAULT_LIBRARIES",
    "EmbeddingService",
    "clear_library_graph_cache_for_tests",
    "get_agent_cte_embedding_service",
    "get_cached_library_graph",
    "invalidate_cte_library_graph_caches",
    "GraphBuilder",
    "GraphStore",
    "LibraryCTE",
    "LibraryError",
    "ParentPathFinder",
    "SemanticSearch",
    "extract_ctes",
    "load_library",
    "reporting_sql_dir",
    "to_reactflow",
]
