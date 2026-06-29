"""Stdio MCP server exposing legal graph exploration tools.

Run:  python /app/mcp/legal_graph_mcp_server.py   (cwd /app, stdio transport)

Optional env:
    LEXIA_LEGAL_GRAPH_ID  — default graph artifact id when graph_id is omitted
    LEGAL_GRAPH_DATA_DIR    — data root (same as REST routes)
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, "/app")

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("lexia-legal-graph")

_DEFAULT_GRAPH_ID = os.environ.get("LEXIA_LEGAL_GRAPH_ID", "").strip()


def _graph_dirs() -> Dict[str, Path]:
    from api.routes.legal_graph import _graph_dirs as route_graph_dirs

    return route_graph_dirs()


def _resolve_graph_id(graph_id: Optional[str]) -> str:
    gid = (graph_id or _DEFAULT_GRAPH_ID or "").strip()
    if not gid:
        dirs = _graph_dirs()
        if not dirs:
            raise ValueError("No legal graph artifacts found under LEGAL_GRAPH_DATA_DIR")
        gid = sorted(dirs.keys())[0]
    if gid not in _graph_dirs():
        raise ValueError(f"Legal graph not found: {gid}")
    return gid


def _load_graph(graph_id: Optional[str] = None):
    from services.legal_graph.explorer import load_graph_from_directory

    gid = _resolve_graph_id(graph_id)
    directory = _graph_dirs()[gid]
    return gid, load_graph_from_directory(directory)


@mcp.tool()
def list_legal_graph_presets() -> List[Dict[str, Any]]:
    """Return the five preset exploration questions for legal reasoning demos."""
    from services.legal_graph.explorer import list_presets

    return list_presets()


@mcp.tool()
def explore_legal_graph_query(
    preset_id: Optional[str] = None,
    query: Optional[str] = None,
    graph_id: Optional[str] = None,
    depth: int = 3,
) -> Dict[str, Any]:
    """Return a reasoning subgraph (ReactFlow nodes/edges) for a preset or free-text query."""
    from services.legal_graph.explorer import query_subgraph

    if not preset_id and not (query or "").strip():
        raise ValueError("preset_id or query is required")

    gid, graph = _load_graph(graph_id)
    result = query_subgraph(graph, preset_id=preset_id, query=query, depth=depth)
    return {
        "graph_id": gid,
        "preset_id": result.preset_id,
        "query": result.query,
        "seeds": result.seeds,
        "node_ids": result.node_ids,
        "edge_ids": result.edge_ids,
        "graph": result.graph,
        "stats": result.stats,
        "truncated": result.truncated,
        "message": result.message,
    }


@mcp.tool()
def explore_legal_graph_path(
    node_id: str,
    query: Optional[str] = None,
    graph_id: Optional[str] = None,
    goal_node_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run A* on reasoning edges from node_id to a goal and summarize the legal chain."""
    from services.legal_graph.explorer import path_from_node

    gid, graph = _load_graph(graph_id)
    result = path_from_node(
        graph,
        node_id,
        query=query,
        goal_node_id=goal_node_id,
    )
    return {
        "graph_id": gid,
        "node_id": result.node_id,
        "goal_node_id": result.goal_node_id,
        "path_node_ids": result.path_node_ids,
        "path_steps": result.path_steps,
        "highlighted_edge_ids": result.highlighted_edge_ids,
        "graph": result.graph,
        "search_method": result.search_method,
        "status": result.status,
        "summary": result.summary,
        "key_steps": result.key_steps,
        "confidence_score": result.confidence_score,
        "message": result.message,
        "suggested_action": result.suggested_action,
    }


if __name__ == "__main__":
    mcp.run()
