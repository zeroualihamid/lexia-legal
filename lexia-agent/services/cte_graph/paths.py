"""Parent-path analysis from every root to a selected node.

A *root* is any node whose in-degree is zero — i.e., a CTE that does not
reference any other CTE in the same WITH clause.  We enumerate every
simple path from every root to the selected node, pick the shortest one
(by hop count), and bundle a ``highlight`` payload that the front-end
can render directly without re-walking the graph.
"""

from __future__ import annotations

from typing import Any, Dict, List

import networkx as nx


class ParentPathFinder:
    """Stateless utility: pass a graph, get path analysis."""

    @staticmethod
    def all_parent_paths(graph: nx.DiGraph, node_id: str) -> Dict[str, Any]:
        """Return ``{selected_node, all_parent_paths, shortest_path, highlight}``.

        Raises
        ------
        KeyError
            If *node_id* is not in the graph.  The API layer maps this
            to a 404.
        """
        if node_id not in graph:
            raise KeyError(node_id)

        roots = [n for n in graph.nodes() if graph.in_degree(n) == 0]

        all_paths: List[List[str]] = []
        if node_id in roots:
            # The node itself is a root → the only "path" is the trivial
            # self-path.  We expose it explicitly so the UI can still
            # render a highlight even when nothing else is upstream.
            all_paths.append([node_id])
        else:
            for root in roots:
                # ``all_simple_paths`` already excludes cycles, but our
                # graph is a DAG so this is a guarantee.
                for path in nx.all_simple_paths(graph, source=root, target=node_id):
                    all_paths.append(list(path))

        shortest = min(all_paths, key=len) if all_paths else []
        highlight_edges = [
            {"source": shortest[i], "target": shortest[i + 1]}
            for i in range(len(shortest) - 1)
        ]

        return {
            "selected_node":    node_id,
            "all_parent_paths": all_paths,
            "shortest_path":    shortest,
            "highlight": {
                "nodes": list(shortest),
                "edges": highlight_edges,
            },
        }
