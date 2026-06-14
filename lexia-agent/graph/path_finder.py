# graph/path_finder.py

"""
Path Finder
===========

Discovers reasoning paths through the code knowledge graph.

A "reasoning path" is an ordered sequence of code nodes that together
solve a multi-step problem (e.g. load → filter → aggregate → export).

Three search strategies:
    sequential   – follow LEADS_TO edges (proven workflow sequences)
    semantic     – jump between SIMILAR_TO / REFINES nodes (concept chains)
    dependency   – follow DEPENDS_ON edges (explicit requirement chains)

Usage:
    from graph.path_finder import PathFinder, ReasoningPath

    finder = PathFinder(graph, config)

    # All paths from a start node up to depth 4
    paths = finder.find_from(start_node_id="node-abc123", max_length=4)

    # Shortest path between two known nodes
    path = finder.find_between("node-abc123", "node-def456")

    # Best paths for a natural-language query
    paths = finder.find_for_query("load parquet and calculate monthly totals")
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Set

from monitoring.logger import get_logger

logger = get_logger(__name__)

try:
    import networkx as nx
except ImportError:
    raise ImportError("networkx is required.  pip install networkx")


# ─────────────────────────────────────────────────────────────────────────────
# Data class
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ReasoningPath:
    """
    An ordered sequence of graph nodes forming a reasoning chain.

    Attributes:
        node_ids     – ordered list of node_id strings
        nodes        – ordered list of node attribute dicts
        total_score  – composite quality score (set by PathScorer)
        path_type    – 'sequential' | 'semantic' | 'dependency' | 'hybrid'
        edge_types   – edge type for each hop, len == len(nodes) - 1
        metadata     – arbitrary extra info
    """
    node_ids:    List[str]
    nodes:       List[Dict[str, Any]]
    total_score: float = 0.0
    path_type:   str   = "sequential"
    edge_types:  List[str] = field(default_factory=list)
    metadata:    Dict[str, Any] = field(default_factory=dict)

    # ── Convenience ───────────────────────────────────────────────────────────

    def __len__(self) -> int:
        return len(self.node_ids)

    def __iter__(self) -> Iterator[Dict[str, Any]]:
        return iter(self.nodes)

    def get_codes(self) -> List[str]:
        """Return the code string of every node in order."""
        return [n.get("code", "") for n in self.nodes]

    def get_combined_code(self, separator: str = "\n\n") -> str:
        """Concatenate all code snippets in path order."""
        return separator.join(c for c in self.get_codes() if c)

    def summary(self) -> str:
        descriptions = [n.get("description", n.get("node_id", "?")[:12])
                        for n in self.nodes]
        return " → ".join(descriptions)

    def to_dict(self) -> Dict:
        return {
            "node_ids":    self.node_ids,
            "total_score": round(self.total_score, 4),
            "path_type":   self.path_type,
            "length":      len(self),
            "edge_types":  self.edge_types,
            "summary":     self.summary(),
            "metadata":    self.metadata,
        }


# ─────────────────────────────────────────────────────────────────────────────
# Path Finder
# ─────────────────────────────────────────────────────────────────────────────

class PathFinder:
    """
    Discovers reasoning paths through the code knowledge graph.

    Config keys read:
        path_max_length       – hard cap on path length            (default: 6)
        path_max_results      – max paths returned per query       (default: 10)
        path_min_node_quality – skip nodes below this quality score (default: 0.0)
        similarity_top_k      – top-k for semantic anchor search   (default: 5)
        similarity_threshold  – min cosine for semantic hops       (default: 0.70)
    """

    # Edge types followed by each strategy
    _LEADS_TO_TYPES   = {"leads_to"}
    _SEMANTIC_TYPES   = {"similar_to", "refines", "alternative_to"}
    _DEPENDENCY_TYPES = {"depends_on"}
    _ALL_TYPES        = _LEADS_TO_TYPES | _SEMANTIC_TYPES | _DEPENDENCY_TYPES

    def __init__(self, graph=None, config=None):
        """
        Args:
            graph:  ReasoningGraph (or None → created from config)
            config: configuration object
        """
        if config is None:
            from config.settings import settings
            config = settings

        if graph is not None:
            self._graph = graph
        else:
            from graph.reasoning_graph import ReasoningGraph
            self._graph = ReasoningGraph(config)

        self._max_length    = getattr(config, "path_max_length",       6)
        self._max_results   = getattr(config, "path_max_results",      10)
        self._min_quality   = getattr(config, "path_min_node_quality", 0.0)
        self._top_k         = getattr(config, "similarity_top_k",      5)
        self._sim_threshold = getattr(config, "similarity_threshold",  0.70)

        logger.info(
            f"PathFinder ready — max_length={self._max_length}, "
            f"max_results={self._max_results}"
        )

    # =========================================================================
    # Public API
    # =========================================================================

    def find_between(
        self,
        start_id:   str,
        end_id:     str,
        strategy:   str = "sequential",
        max_length: Optional[int] = None,
    ) -> Optional[ReasoningPath]:
        """
        Find the single best path between two known nodes.

        Args:
            start_id:   Source node_id
            end_id:     Target node_id
            strategy:   'sequential' | 'semantic' | 'dependency' | 'any'
            max_length: Override default max_length

        Returns:
            Best ReasoningPath or None if unreachable
        """
        paths = self.find_all_between(
            start_id   = start_id,
            end_id     = end_id,
            strategy   = strategy,
            max_length = max_length,
        )
        return paths[0] if paths else None

    def find_all_between(
        self,
        start_id:   str,
        end_id:     str,
        strategy:   str = "sequential",
        max_length: Optional[int] = None,
    ) -> List[ReasoningPath]:
        """
        Find all paths between two nodes.

        Returns:
            List of ReasoningPath sorted by total_score descending
        """
        nx_graph = self._graph.backend.graph
        cutoff   = min(max_length or self._max_length, self._max_length)

        if not (nx_graph.has_node(start_id) and nx_graph.has_node(end_id)):
            return []

        # Build strategy-filtered subgraph view
        view     = self._strategy_view(nx_graph, strategy)
        paths    = []

        try:
            for raw_path in nx.all_simple_paths(view, start_id, end_id, cutoff=cutoff):
                rp = self._build_path(raw_path, nx_graph, strategy)
                if rp:
                    paths.append(rp)
                if len(paths) >= self._max_results:
                    break
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            pass
        except Exception as e:
            logger.warning(f"find_all_between error: {e}")

        paths.sort(key=lambda p: p.total_score, reverse=True)
        logger.info(
            f"find_all_between({start_id[:8]}→{end_id[:8]}): "
            f"{len(paths)} paths found"
        )
        return paths

    def find_from(
        self,
        start_id:   str,
        strategy:   str = "sequential",
        max_length: Optional[int] = None,
    ) -> List[ReasoningPath]:
        """
        Find all paths that START from a given node (no fixed endpoint).

        Explores the graph up to max_length hops from start_id.
        Useful for: "given this code, what could come next?"

        Returns:
            List of ReasoningPath (each ending at a different leaf node)
        """
        nx_graph = self._graph.backend.graph
        cutoff   = min(max_length or self._max_length, self._max_length)

        if not nx_graph.has_node(start_id):
            return []

        view  = self._strategy_view(nx_graph, strategy)
        paths = []

        # DFS from start_id; collect every path to a leaf or at max depth
        for raw_path in _dfs_paths(view, start_id, cutoff):
            if len(raw_path) < 2:          # skip trivial single-node paths
                continue
            rp = self._build_path(raw_path, nx_graph, strategy)
            if rp:
                paths.append(rp)
            if len(paths) >= self._max_results:
                break

        paths.sort(key=lambda p: p.total_score, reverse=True)
        logger.info(f"find_from({start_id[:8]}): {len(paths)} paths found")
        return paths

    def find_for_query(
        self,
        query:      str,
        strategy:   str = "sequential",
        max_length: Optional[int] = None,
        schema_table: Optional[str] = None,
    ) -> List[ReasoningPath]:
        """
        Find paths relevant to a natural-language query.

        Step 1: semantic search → anchor nodes
        Step 2: for each anchor, explore forward via find_from()
        Step 3: rank all collected paths by score

        Args:
            query:        Natural-language description of the task
            strategy:     Edge traversal strategy
            max_length:   Override max_length
            schema_table: Restrict to nodes from a specific table

        Returns:
            Globally ranked list of ReasoningPath
        """
        t0 = time.perf_counter()

        # Filter function for schema restriction
        filter_fn = None
        if schema_table:
            filter_fn = lambda e: e.metadata.get("schema_table") == schema_table

        # Semantic search for anchor nodes
        try:
            anchors = self._graph.search.query(
                query_text = query,
                top_k      = self._top_k,
                threshold  = self._sim_threshold,
                filter_fn  = filter_fn,
            )
        except Exception as e:
            logger.warning(f"Semantic search failed: {e}")
            anchors = []

        if not anchors:
            logger.warning(f"No anchor nodes found for query: '{query[:60]}'")
            return []

        # Explore from each anchor
        all_paths: List[ReasoningPath] = []
        seen_signatures: Set[str] = set()

        for anchor in anchors:
            sub_paths = self.find_from(
                start_id   = anchor.node_id,
                strategy   = strategy,
                max_length = max_length,
            )
            for path in sub_paths:
                sig = ":".join(path.node_ids)
                if sig not in seen_signatures:
                    seen_signatures.add(sig)
                    # Boost score by anchor similarity
                    path.total_score += anchor.score * 0.1
                    path.metadata["anchor_score"]  = anchor.score
                    path.metadata["anchor_node_id"] = anchor.node_id
                    all_paths.append(path)

        all_paths.sort(key=lambda p: p.total_score, reverse=True)
        result = all_paths[: self._max_results]

        elapsed = (time.perf_counter() - t0) * 1000
        logger.info(
            f"find_for_query('{query[:40]}'): "
            f"{len(result)} paths in {elapsed:.0f} ms"
        )
        return result

    def find_shortest(
        self,
        start_id: str,
        end_id:   str,
    ) -> Optional[ReasoningPath]:
        """
        Dijkstra shortest path weighted by (1 − quality_score).
        Lower quality → higher cost → penalised route.
        """
        nx_graph = self._graph.backend.graph

        if not (nx_graph.has_node(start_id) and nx_graph.has_node(end_id)):
            return None

        # Build weight dict: edge weight = 1 - quality_score of TARGET node
        def edge_weight(u, v, data):
            quality = nx_graph.nodes[v].get("quality_score", 0.5)
            return max(0.001, 1.0 - quality)

        try:
            raw = nx.dijkstra_path(nx_graph, start_id, end_id, weight=edge_weight)
            return self._build_path(raw, nx_graph, "any")
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return None

    # =========================================================================
    # Private helpers
    # =========================================================================

    def _strategy_view(self, g: nx.DiGraph, strategy: str) -> nx.DiGraph:
        """
        Return a subgraph view containing only edges relevant to the strategy.
        """
        if strategy == "sequential":
            allowed = self._LEADS_TO_TYPES
        elif strategy == "semantic":
            allowed = self._SEMANTIC_TYPES
        elif strategy == "dependency":
            allowed = self._DEPENDENCY_TYPES
        else:                                    # "any" / "hybrid"
            return g                             # all edges

        def keep_edge(u, v, data):
            return data.get("edge_type", "") in allowed

        return nx.subgraph_view(g, filter_edge=keep_edge)

    def _build_path(
        self,
        node_id_list: List[str],
        nx_graph:     nx.DiGraph,
        strategy:     str,
    ) -> Optional[ReasoningPath]:
        """
        Materialise a list of node_ids into a ReasoningPath.
        Skips paths that contain low-quality nodes (below _min_quality).
        """
        nodes      = []
        edge_types = []

        for i, nid in enumerate(node_id_list):
            attrs = nx_graph.nodes.get(nid)
            if attrs is None:
                return None                      # dangling reference

            quality = attrs.get("quality_score", 0.0)
            if quality < self._min_quality:
                return None                      # path quality gate

            row = dict(attrs)
            row["node_id"] = nid
            nodes.append(row)

            if i > 0:
                prev = node_id_list[i - 1]
                edge_data  = nx_graph.edges.get((prev, nid), {})
                edge_types.append(edge_data.get("edge_type", "unknown"))

        # Initial score: mean quality of nodes
        score = (sum(n.get("quality_score", 0.0) for n in nodes) / len(nodes)
                 if nodes else 0.0)

        return ReasoningPath(
            node_ids   = list(node_id_list),
            nodes      = nodes,
            total_score= round(score, 4),
            path_type  = strategy,
            edge_types = edge_types,
        )


# ─────────────────────────────────────────────────────────────────────────────
# DFS generator
# ─────────────────────────────────────────────────────────────────────────────

def _dfs_paths(
    graph:  nx.DiGraph,
    start:  str,
    cutoff: int,
) -> Iterator[List[str]]:
    """
    Yield all simple paths reachable from start up to cutoff hops.
    Memory-efficient generator — does not materialise all paths at once.
    """
    stack = [(start, [start], {start})]   # (current, path_so_far, visited)
    while stack:
        node, path, visited = stack.pop()
        successors = list(graph.successors(node))

        if not successors or len(path) >= cutoff + 1:
            yield path
            continue

        extended = False
        for nbr in successors:
            if nbr not in visited:
                stack.append((nbr, path + [nbr], visited | {nbr}))
                extended = True

        if not extended:
            yield path
