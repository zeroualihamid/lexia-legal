# routes/graph.py

"""
Graph Query Endpoints
=====================

GET  /graph/search                – semantic similarity search
GET  /graph/node/{node_id}        – single node details
GET  /graph/node/{node_id}/neighbors – adjacent nodes
POST /graph/path                  – find path between two nodes
GET  /graph/top                   – top-N nodes by quality
GET  /graph/stats                 – graph statistics
DELETE /graph/node/{node_id}      – remove a node
"""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

router = APIRouter()


# ── Models ────────────────────────────────────────────────────────────────────

class NodeOut(BaseModel):
    node_id:          str
    code:             str
    description:      str
    step_type:        str
    schema_table:     str
    quality_score:    float
    success_rate:     float
    total_executions: int
    avg_duration:     float
    created_at:       str
    updated_at:       str
    metadata:         Dict[str, Any] = {}


class SearchResult(BaseModel):
    node_id:     str
    score:       float
    description: str
    snippet:     str
    metadata:    Dict[str, Any] = {}


class SearchResponse(BaseModel):
    query:     str
    results:   List[SearchResult]
    total:     int
    threshold: float


class PathRequest(BaseModel):
    start_node_id: str
    end_node_id:   str
    strategy:      str  = Field("sequential",
                                pattern="^(sequential|semantic|dependency|any)$")
    max_length:    int  = Field(6, ge=2, le=10)


class PathHop(BaseModel):
    node_id:   str
    edge_type: str
    snippet:   str


class PathResponse(BaseModel):
    found:       bool
    path_type:   str
    total_score: float
    length:      int
    hops:        List[PathHop]
    summary:     str


class GraphStats(BaseModel):
    node_count:    int
    edge_count:    int
    density:       float
    is_dag:        bool
    storage_path:  str
    index_size:    int
    model_name:    str


# ── Endpoints ─────────────────────────────────────────────────────────────────

@router.get("/search", response_model=SearchResponse,
            summary="Semantic similarity search")
async def search_graph(
    q:            str           = Query(..., min_length=2, description="Search query"),
    top_k:        int           = Query(5,   ge=1, le=50),
    threshold:    float         = Query(0.70, ge=0.0, le=1.0),
    schema_table: Optional[str] = Query(None, description="Filter by table"),
) -> SearchResponse:
    """
    Find code nodes semantically similar to the query.
    Returns nodes ranked by cosine similarity score.
    """
    try:
        graph  = _get_graph()
        filter_fn = (
            (lambda e: e.metadata.get("schema_table") == schema_table)
            if schema_table else None
        )
        results = graph.search.query(
            query_text = q,
            top_k      = top_k,
            threshold  = threshold,
            filter_fn  = filter_fn,
        )
        return SearchResponse(
            query     = q,
            results   = [
                SearchResult(
                    node_id     = r.node_id,
                    score       = r.score,
                    description = r.description,
                    snippet     = r.snippet,
                    metadata    = r.metadata,
                )
                for r in results
            ],
            total     = len(results),
            threshold = threshold,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/node/{node_id}", response_model=NodeOut,
            summary="Get node details")
async def get_node(node_id: str) -> NodeOut:
    """Return full details for a single graph node."""
    graph = _get_graph()
    node  = graph.backend.get_node(node_id)
    if node is None:
        raise HTTPException(status_code=404, detail=f"Node not found: {node_id}")
    return _node_to_out(node)


@router.get("/node/{node_id}/neighbors", summary="Get neighbouring nodes")
async def get_neighbors(
    node_id:   str,
    direction: str           = Query("out",  pattern="^(in|out|both)$"),
    edge_type: Optional[str] = Query(None,
                description="Filter: leads_to|similar_to|refines|depends_on"),
) -> Dict[str, Any]:
    """Return nodes adjacent to node_id along a given direction."""
    graph     = _get_graph()
    neighbors = graph.backend.get_neighbors(
        node_id   = node_id,
        direction = direction,
        edge_type = edge_type,
    )
    return {
        "node_id":   node_id,
        "direction": direction,
        "neighbors": [_node_to_out(n).__dict__ for n in neighbors],
        "count":     len(neighbors),
    }


@router.post("/path", response_model=PathResponse, summary="Find path between nodes")
async def find_path(req: PathRequest) -> PathResponse:
    """
    Find the best reasoning path between two nodes using PathFinder.

    Strategies:
        sequential  – follow LEADS_TO edges (proven workflow order)
        semantic    – follow SIMILAR_TO / REFINES edges
        dependency  – follow DEPENDS_ON edges
        any         – all edge types
    """
    try:
        from graph.path_finder import PathFinder
        from graph.path_scorer import PathScorer
        from config.settings   import settings

        graph  = _get_graph()
        finder = PathFinder(graph, settings)
        scorer = PathScorer(settings)

        path = finder.find_between(
            start_id   = req.start_node_id,
            end_id     = req.end_node_id,
            strategy   = req.strategy,
            max_length = req.max_length,
        )

        if path is None:
            return PathResponse(
                found=False, path_type=req.strategy,
                total_score=0.0, length=0, hops=[], summary="No path found"
            )

        scorer.score_one(path)

        hops = []
        for i, node in enumerate(path.nodes):
            hops.append(PathHop(
                node_id   = node["node_id"],
                edge_type = path.edge_types[i - 1] if i > 0 else "start",
                snippet   = node.get("code", "")[:100],
            ))

        return PathResponse(
            found       = True,
            path_type   = path.path_type,
            total_score = path.total_score,
            length      = len(path),
            hops        = hops,
            summary     = path.summary(),
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/top", response_model=List[NodeOut], summary="Top-N nodes by quality")
async def top_nodes(
    n:            int           = Query(10, ge=1, le=100),
    by:           str           = Query("quality_score",
                  description="Sort field: quality_score|success_rate|total_executions"),
    schema_table: Optional[str] = Query(None),
) -> List[NodeOut]:
    """Return the top-N highest-quality nodes, optionally filtered by table."""
    graph = _get_graph()
    nodes = graph.backend.top_nodes(n=n, by=by, schema_table=schema_table)
    return [_node_to_out(node) for node in nodes]


@router.get("/stats", response_model=GraphStats, summary="Graph statistics")
async def graph_stats() -> GraphStats:
    """Return high-level graph and search index statistics."""
    try:
        graph = _get_graph()
        gs    = graph.backend.stats()
        ss    = graph.search.stats()
        return GraphStats(
            node_count   = gs["node_count"],
            edge_count   = gs["edge_count"],
            density      = gs["density"],
            is_dag       = gs["is_dag"],
            storage_path = gs["storage_path"],
            index_size   = ss["index_size"],
            model_name   = ss["model"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.delete("/node/{node_id}", status_code=204, summary="Remove a node")
async def delete_node(node_id: str) -> None:
    """
    Remove a node and all its edges from the graph.
    Also removes the node from the similarity search index.
    """
    graph   = _get_graph()
    removed = graph.backend.remove_node(node_id)
    if not removed:
        raise HTTPException(status_code=404, detail=f"Node not found: {node_id}")
    graph.search.remove(node_id)


# ── Helpers ───────────────────────────────────────────────────────────────────

_graph_instance = None

def _get_graph():
    """Return a cached ReasoningGraph instance."""
    global _graph_instance
    if _graph_instance is None:
        from graph.reasoning_graph import ReasoningGraph
        from config.settings       import settings
        _graph_instance = ReasoningGraph(settings)
    return _graph_instance


def _node_to_out(node: Dict) -> NodeOut:
    return NodeOut(
        node_id          = node.get("node_id", ""),
        code             = node.get("code", ""),
        description      = node.get("description", ""),
        step_type        = node.get("step_type", "generic"),
        schema_table     = node.get("schema_table", ""),
        quality_score    = node.get("quality_score", 0.0),
        success_rate     = node.get("success_rate", 0.0),
        total_executions = node.get("total_executions", 0),
        avg_duration     = node.get("avg_duration", 0.0),
        created_at       = node.get("created_at", ""),
        updated_at       = node.get("updated_at", ""),
        metadata         = node.get("metadata", {}),
    )
