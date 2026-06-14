"""Serialise a :class:`networkx.DiGraph` to ReactFlow's JSON shape.

Position values are dummy ``(0, 0)`` because the front-end (dagre /
elk / custom layout) recomputes positions client-side.  Including a
sentinel keeps the schema strict so the front-end doesn't have to make
``position`` optional.
"""

from __future__ import annotations

from typing import Any, Dict, List

import networkx as nx


def to_reactflow(graph: nx.DiGraph) -> Dict[str, List[Dict[str, Any]]]:
    """Return ``{"nodes": [...], "edges": [...]}`` matching the spec.

    The serializer is deliberately conservative: it only emits the
    canonical fields documented in the API contract.  ``description_embedding``
    is **not** included — it's an internal-only attribute and would balloon
    the payload by ~3 KB per node on the wire.
    """
    nodes: List[Dict[str, Any]] = []
    for nid, attrs in graph.nodes(data=True):
        data: Dict[str, Any] = {
            "label":       attrs.get("name", nid),
            "name":        attrs.get("name", nid),
            "description": attrs.get("description", "") or "",
            "rawSql":      attrs.get("rawSql", "") or "",
            "parents":     list(attrs.get("parents", []) or []),
            "children":    list(attrs.get("children", []) or []),
        }
        # Optional, library-mode-only extras — emitted only when present so
        # arbitrary-SQL builds still match the original payload shape.
        if "library" in attrs and attrs["library"]:
            data["library"] = attrs["library"]
        if attrs.get("parameters"):
            data["parameters"] = list(attrs["parameters"])
        if attrs.get("projects"):
            data["projects"] = list(attrs["projects"])

        nodes.append({
            "id":       attrs.get("id", nid),
            "type":     "default",
            "position": {"x": 0, "y": 0},
            "data":     data,
        })

    edges: List[Dict[str, Any]] = []
    for src, tgt in graph.edges():
        edges.append({
            "id":     f"{src}__{tgt}",
            "source": src,
            "target": tgt,
            "label":  "",
        })

    return {"nodes": nodes, "edges": edges}
