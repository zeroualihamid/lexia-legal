"""Build a :class:`networkx.DiGraph` from a SQL CTE statement.

Each node carries:

* ``id``                     — the CTE name (also the node key in the graph)
* ``name``                   — same as ``id``, kept for explicit serialization
* ``description``            — user-supplied or empty string
* ``rawSql``                 — the verbatim CTE body
* ``parents``                — list of immediate parent names (in source order)
* ``children``               — list of immediate child names (in source order)
* ``description_embedding``  — float32 numpy vector

Edges are simple ``parent → child`` directed edges with no attributes.

The build is **strict** about cycles: if dependency detection produces a
cycle (which the SQL parser tries to prevent by only emitting back-
references to earlier-declared CTEs), we raise :class:`CycleError` with
the offending node list so the caller can surface a 400.
"""

from __future__ import annotations

import logging
from typing import Any, Dict, Iterable, List, Optional, Sequence

import networkx as nx

from .embeddings import EmbeddingService
from .library_loader import LibraryCTE
from .sql_parser import CTEDef, extract_ctes


logger = logging.getLogger(__name__)


# ── Errors ─────────────────────────────────────────────────────────────────


class BuildError(ValueError):
    """Base class for build-time errors."""


class ParseError(BuildError):
    """SQL couldn't be parsed or contained no CTEs."""


class CycleError(BuildError):
    """Dependency detection produced a cycle.

    The cycle nodes are exposed via :attr:`cycle` so the API layer can
    return them in the 400 response body.
    """

    def __init__(self, cycle: List[str]) -> None:
        super().__init__(f"Cyclic dependency detected: {' → '.join(cycle + [cycle[0]])}")
        self.cycle = list(cycle)


# ── Builder ────────────────────────────────────────────────────────────────


class GraphBuilder:
    """Stateless builder — construct a fresh DiGraph per call."""

    def __init__(self, embeddings: Optional[EmbeddingService] = None) -> None:
        self.embeddings = embeddings or EmbeddingService()

    # ---------------------------------------------------------------------

    def build(
        self,
        sql: str,
        descriptions: Optional[Dict[str, str]] = None,
        *,
        dialect: str = "duckdb",
    ) -> nx.DiGraph:
        """Parse *sql*, embed descriptions, return a populated DiGraph.

        Descriptions for CTE names that don't actually appear in the SQL
        are silently dropped (with a debug log) so the front-end can
        cheerfully ship stale dictionaries without breaking the build.
        """
        try:
            ctes, deps = extract_ctes(sql, dialect=dialect)
        except ValueError as e:
            raise ParseError(str(e)) from e

        descriptions = descriptions or {}
        if descriptions:
            unknown = sorted(set(descriptions) - {c.name for c in ctes})
            if unknown:
                logger.debug(
                    "GraphBuilder: ignoring %d description key(s) for unknown CTEs: %s",
                    len(unknown), unknown,
                )

        # Embed descriptions in one batch — much faster than one-by-one.
        names: List[str] = [c.name for c in ctes]
        descs: List[str] = [descriptions.get(n, "") or "" for n in names]
        vectors = self.embeddings.encode(descs)

        graph = nx.DiGraph()
        for cte, desc, vec in zip(ctes, descs, vectors):
            graph.add_node(
                cte.name,
                id              = cte.name,
                name            = cte.name,
                description     = desc,
                rawSql          = cte.raw_sql,
                parents         = list(deps.get(cte.name, [])),
                children        = [],  # filled in below
                description_embedding = vec,
            )

        for child, parents in deps.items():
            for parent in parents:
                if parent == child:
                    continue
                if not graph.has_node(parent):
                    # Defensive: parser should never emit references to
                    # undeclared names, but guard anyway.
                    logger.debug(
                        "GraphBuilder: skipping edge to undeclared parent %r", parent
                    )
                    continue
                graph.add_edge(parent, child)
                graph.nodes[parent]["children"].append(child)

        # Final structural sanity check.
        if not nx.is_directed_acyclic_graph(graph):
            try:
                cycle = list(nx.find_cycle(graph, orientation="original"))
                cycle_nodes = [u for u, _v, *_ in cycle]
            except nx.NetworkXNoCycle:
                cycle_nodes = list(graph.nodes())[:1]
            raise CycleError(cycle_nodes or list(graph.nodes())[:1])

        return graph

    # ---------------------------------------------------------------------

    def build_from_library(
        self,
        records: Sequence[LibraryCTE],
        *,
        graph_meta: Optional[Dict[str, Any]] = None,
    ) -> nx.DiGraph:
        """Build a graph from pre-resolved :class:`LibraryCTE` records.

        Unlike :meth:`build`, this path **skips SQL parsing** entirely:
        dependencies are taken verbatim from the catalog's ``depends_on``
        declarations, which are already the source of truth used by the
        rest of the reporting flow (``sql_helpers.expand_includes``).

        This avoids two failure modes that are real with the on-disk
        library:

        1. ``$period`` placeholders make some bodies fail to parse with
           ``sqlglot`` in strict mode.
        2. A name-based scan can't see through ``{{include: …}}`` macros,
           so it would report fewer dependencies than the catalog does.

        Validation:

        * Self-references in ``depends_on`` are dropped (the catalog
          author probably typed the wrong name; we surface this via debug
          logs and ignore).
        * Cycles still raise :class:`CycleError` — the catalog must be a
          DAG, by construction.
        * Missing dependencies (referenced but not declared anywhere)
          would already have been caught by
          :func:`library_loader.load_library`; we double-check here as
          defence-in-depth and log + skip if any slip through.
        """
        if not records:
            # Empty on-disk catalog (new profile, or placeholder index.yaml).
            empty = nx.DiGraph()
            if graph_meta:
                empty.graph.update(graph_meta)
            return empty

        names: List[str] = [r.name for r in records]
        if len(set(names)) != len(names):
            seen: set = set()
            dups = [n for n in names if n in seen or seen.add(n)]  # type: ignore[func-returns-value]
            raise BuildError(f"duplicate CTE names in library records: {sorted(set(dups))!r}")

        # Embed all descriptions in one batch.
        descs: List[str] = [r.description or "" for r in records]
        vectors = self.embeddings.encode(descs)

        graph = nx.DiGraph()
        for record, desc, vec in zip(records, descs, vectors):
            graph.add_node(
                record.name,
                id              = record.name,
                name            = record.name,
                description     = desc,
                rawSql          = record.raw_sql or "",
                parents         = [],   # filled below in declared order
                children        = [],   # filled below in declared order
                description_embedding = vec,
                # Library-specific extras — picked up by reactflow.to_reactflow.
                library         = record.library,
                parameters      = list(record.parameters),
                projects        = list(record.projects),
                source_path     = record.source_path or "",
            )

        known = set(names)
        for record in records:
            for parent in record.depends_on:
                if parent == record.name:
                    logger.debug(
                        "GraphBuilder: dropping self-edge on %r", record.name
                    )
                    continue
                if parent not in known:
                    # ``load_library`` already raises on this; defensive log.
                    logger.warning(
                        "GraphBuilder: %r depends on unknown CTE %r; skipping edge",
                        record.name, parent,
                    )
                    continue
                if not graph.has_edge(parent, record.name):
                    graph.add_edge(parent, record.name)
                    graph.nodes[parent]["children"].append(record.name)
                    graph.nodes[record.name]["parents"].append(parent)

        if not nx.is_directed_acyclic_graph(graph):
            try:
                cycle = list(nx.find_cycle(graph, orientation="original"))
                cycle_nodes = [u for u, _v, *_ in cycle]
            except nx.NetworkXNoCycle:
                cycle_nodes = list(graph.nodes())[:1]
            raise CycleError(cycle_nodes or list(graph.nodes())[:1])

        if graph_meta:
            graph.graph.update(graph_meta)

        return graph

    # ---------------------------------------------------------------------

    @staticmethod
    def stats(graph: nx.DiGraph) -> Dict[str, Any]:
        """Cheap structural snapshot used by the API responses."""
        n_nodes = graph.number_of_nodes()
        n_edges = graph.number_of_edges()
        roots   = [n for n in graph.nodes() if graph.in_degree(n) == 0]
        leaves  = [n for n in graph.nodes() if graph.out_degree(n) == 0]
        return {
            "node_count": n_nodes,
            "edge_count": n_edges,
            "roots":      sorted(roots),
            "leaves":     sorted(leaves),
            "is_dag":     nx.is_directed_acyclic_graph(graph),
        }
