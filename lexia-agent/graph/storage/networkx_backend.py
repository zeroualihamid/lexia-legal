# graph/storage/networkx_backend.py

"""
NetworkX Backend
================

Persistent graph storage built on NetworkX.

Responsibilities:
  - Add / update / remove nodes and edges
  - Persist to / load from disk (JSON + optional .npy for vectors)
  - Expose raw graph for path-finding algorithms
  - Provide lightweight query helpers used by ReasoningGraph

Disk layout (under storage_path/):
    graph.json          – node + edge attributes (no vectors)
    vectors/            – one .npy file per node_id  (optional, kept separate
                          from EmbeddingCache to allow graph-only export)
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

from monitoring.logger import get_logger

logger = get_logger(__name__)

# NetworkX is a required dependency for this backend
try:
    import networkx as nx
except ImportError:  # pragma: no cover
    raise ImportError("networkx is required.  pip install networkx")


# ─────────────────────────────────────────────────────────────────────────────
# Data structures (plain dicts stored inside nx node/edge attr dicts)
# ─────────────────────────────────────────────────────────────────────────────

# Node attribute keys (stored in nx graph)
_N = {
    "code":              "code",
    "description":       "description",
    "step_type":         "step_type",
    "success_rate":      "success_rate",
    "total_executions":  "total_executions",
    "avg_duration":      "avg_duration",
    "quality_score":     "quality_score",
    "schema_table":      "schema_table",
    "created_at":        "created_at",
    "updated_at":        "updated_at",
    "metadata":          "metadata",
}

# Edge attribute keys
_E = {
    "edge_type":  "edge_type",
    "weight":     "weight",
    "created_at": "created_at",
    "metadata":   "metadata",
}


def _now() -> float:
    """Return current Unix timestamp in seconds."""
    return time.time()


# ─────────────────────────────────────────────────────────────────────────────
# Backend
# ─────────────────────────────────────────────────────────────────────────────

class NetworkXBackend:
    """
    Persistent NetworkX-based graph storage.

    Config keys read:
        graph_storage_path   – root directory (default: ./data/graph)
        graph_auto_save      – persist after every mutation (default: True)
    """

    _GRAPH_FILE   = "graph.json"
    _VECTORS_DIR  = "vectors"

    def __init__(self, config=None):
        if config is None:
            from config.settings import settings
            config = settings

        storage_path = getattr(config, "graph_storage_path", "./data/graph")
        self._auto_save = getattr(config, "graph_auto_save", True)

        self._root        = Path(storage_path)
        self._vectors_dir = self._root / self._VECTORS_DIR
        self._root.mkdir(parents=True, exist_ok=True)
        self._vectors_dir.mkdir(exist_ok=True)

        self.graph: nx.DiGraph = self._load_or_create()

        logger.info(
            f"NetworkXBackend ready — "
            f"{self.node_count} nodes, {self.edge_count} edges  "
            f"(path={self._root})"
        )

    # ── Node CRUD ─────────────────────────────────────────────────────────────

    def add_node(
        self,
        node_id:    str,
        code:       str,
        description: str = "",
        step_type:  str = "generic",
        schema_table: str = "",
        metadata:   Optional[Dict] = None,
    ) -> str:
        """
        Insert or overwrite a node.  Returns node_id.
        """
        now = _now()
        attrs = {
            _N["code"]:             code,
            _N["description"]:      description,
            _N["step_type"]:        step_type,
            _N["success_rate"]:     0.0,
            _N["total_executions"]: 0,
            _N["avg_duration"]:     0.0,
            _N["quality_score"]:    0.0,
            _N["schema_table"]:     schema_table,
            _N["created_at"]:       now,
            _N["updated_at"]:       now,
            _N["metadata"]:         metadata or {},
        }

        if self.graph.has_node(node_id):
            # Preserve execution stats on update
            existing = self.graph.nodes[node_id]
            attrs[_N["success_rate"]]     = existing.get(_N["success_rate"],     0.0)
            attrs[_N["total_executions"]] = existing.get(_N["total_executions"], 0)
            attrs[_N["avg_duration"]]     = existing.get(_N["avg_duration"],     0.0)
            attrs[_N["quality_score"]]    = existing.get(_N["quality_score"],    0.0)
            attrs[_N["created_at"]]       = existing.get(_N["created_at"],       now)

        self.graph.add_node(node_id, **attrs)
        self._maybe_save()
        logger.debug(f"Node upserted: {node_id[:12]}")
        return node_id

    def get_node(self, node_id: str) -> Optional[Dict[str, Any]]:
        """Return node attribute dict or None."""
        if not self.graph.has_node(node_id):
            return None
        data = dict(self.graph.nodes[node_id])
        data["node_id"] = node_id
        return data

    def update_node(self, node_id: str, **kwargs) -> bool:
        """Patch specific attributes on an existing node."""
        if not self.graph.has_node(node_id):
            return False
        self.graph.nodes[node_id].update(kwargs)
        self.graph.nodes[node_id][_N["updated_at"]] = _now()
        self._maybe_save()
        return True

    def remove_node(self, node_id: str) -> bool:
        """Delete node + all its edges.  Returns True if found."""
        if not self.graph.has_node(node_id):
            return False
        self.graph.remove_node(node_id)
        self._delete_vector(node_id)
        self._maybe_save()
        logger.debug(f"Node removed: {node_id[:12]}")
        return True

    def record_execution(
        self,
        node_id:  str,
        success:  bool,
        duration: float,
    ) -> bool:
        """
        Update rolling execution statistics for a node.

        Uses exponential moving average for avg_duration so old slow runs
        don't permanently penalise a node.
        """
        if not self.graph.has_node(node_id):
            return False

        attrs   = self.graph.nodes[node_id]
        n       = attrs.get(_N["total_executions"], 0)
        old_sr  = attrs.get(_N["success_rate"],     0.0)
        old_dur = attrs.get(_N["avg_duration"],      0.0)

        new_n   = n + 1
        # Cumulative mean for success rate
        new_sr  = (old_sr * n + (1.0 if success else 0.0)) / new_n
        # EMA (α = 0.2) for duration
        alpha   = 0.2
        new_dur = alpha * duration + (1 - alpha) * old_dur if n > 0 else duration
        # Quality: success-rate biased, slight bonus for fast execution
        speed   = max(0.0, 1.0 - new_dur / 60.0)    # 0..1, worst at ≥60 s
        quality = 0.7 * new_sr + 0.3 * speed

        attrs[_N["total_executions"]] = new_n
        attrs[_N["success_rate"]]     = round(new_sr,  4)
        attrs[_N["avg_duration"]]     = round(new_dur, 4)
        attrs[_N["quality_score"]]    = round(quality, 4)
        attrs[_N["updated_at"]]       = _now()

        self._maybe_save()
        return True

    # ── Edge CRUD ─────────────────────────────────────────────────────────────

    def add_edge(
        self,
        source_id:  str,
        target_id:  str,
        edge_type:  str = "leads_to",
        weight:     float = 1.0,
        metadata:   Optional[Dict] = None,
    ) -> bool:
        """
        Add or update a directed edge.  Both nodes must exist.
        Returns False if either node is missing.
        """
        if not (self.graph.has_node(source_id) and self.graph.has_node(target_id)):
            logger.warning(
                f"Cannot add edge {source_id[:8]}→{target_id[:8]}: node missing"
            )
            return False

        self.graph.add_edge(
            source_id,
            target_id,
            **{
                _E["edge_type"]:  edge_type,
                _E["weight"]:     weight,
                _E["created_at"]: _now(),
                _E["metadata"]:   metadata or {},
            },
        )
        self._maybe_save()
        return True

    def get_edge(self, source_id: str, target_id: str) -> Optional[Dict]:
        """Return edge attribute dict or None."""
        if not self.graph.has_edge(source_id, target_id):
            return None
        return dict(self.graph[source_id][target_id])

    def remove_edge(self, source_id: str, target_id: str) -> bool:
        if not self.graph.has_edge(source_id, target_id):
            return False
        self.graph.remove_edge(source_id, target_id)
        self._maybe_save()
        return True

    # ── Query helpers ─────────────────────────────────────────────────────────

    def iter_nodes(
        self,
        schema_table: Optional[str] = None,
        min_executions: int = 0,
        min_success_rate: float = 0.0,
        step_type: Optional[str] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Iterate over nodes matching optional filters."""
        for node_id, attrs in self.graph.nodes(data=True):
            if schema_table and attrs.get(_N["schema_table"]) != schema_table:
                continue
            if attrs.get(_N["total_executions"], 0) < min_executions:
                continue
            if attrs.get(_N["success_rate"], 0.0) < min_success_rate:
                continue
            if step_type and attrs.get(_N["step_type"]) != step_type:
                continue
            row = dict(attrs)
            row["node_id"] = node_id
            yield row

    def get_neighbors(
        self,
        node_id:   str,
        direction: str = "out",          # "out" | "in" | "both"
        edge_type: Optional[str] = None,
    ) -> List[Dict]:
        """Return neighbouring nodes (filtered by edge_type)."""
        if not self.graph.has_node(node_id):
            return []

        if direction == "out":
            edges = list(self.graph.out_edges(node_id, data=True))
            nbr_ids = [t for _, t, _ in edges]
            edge_data = {t: d for _, t, d in edges}
        elif direction == "in":
            edges = list(self.graph.in_edges(node_id, data=True))
            nbr_ids = [s for s, _, _ in edges]
            edge_data = {s: d for s, _, d in edges}
        else:
            out_e = list(self.graph.out_edges(node_id, data=True))
            in_e  = list(self.graph.in_edges(node_id,  data=True))
            nbr_ids  = [t for _, t, _ in out_e] + [s for s, _, _ in in_e]
            edge_data = {t: d for _, t, d in out_e}
            edge_data.update({s: d for s, _, d in in_e})

        results = []
        for nid in nbr_ids:
            ed = edge_data.get(nid, {})
            if edge_type and ed.get(_E["edge_type"]) != edge_type:
                continue
            node = self.get_node(nid)
            if node:
                node["edge_data"] = ed
                results.append(node)
        return results

    def find_path(
        self,
        source_id: str,
        target_id: str,
    ) -> Optional[List[str]]:
        """Shortest path between two nodes (list of node_ids), or None."""
        try:
            return nx.shortest_path(self.graph, source_id, target_id)
        except (nx.NetworkXNoPath, nx.NodeNotFound):
            return None

    def top_nodes(
        self,
        n: int = 10,
        by: str = "quality_score",       # any node attribute key
        schema_table: Optional[str] = None,
    ) -> List[Dict]:
        """Return the top-n nodes sorted by a numeric attribute."""
        nodes = list(self.iter_nodes(schema_table=schema_table))
        nodes.sort(key=lambda x: x.get(by, 0.0), reverse=True)
        return nodes[:n]
    
    def search_similar(
        self,
        embedding: List[float],
        threshold: float = 0.70,
        top_k: int = 5,
    ) -> List[Dict]:
        """
        Search for nodes similar to the given embedding vector.
        
        Args:
            embedding: Query embedding vector
            threshold: Minimum cosine similarity threshold
            top_k: Maximum number of results to return
            
        Returns:
            List of node dicts with similarity scores, sorted by score descending
        """
        if not embedding:
            return []
        
        results = []
        
        # Iterate all nodes and compute similarity
        for node_id in self.graph.nodes():
            node_vector = self.load_vector(node_id)
            
            if node_vector is None:
                continue
            
            # Compute cosine similarity
            similarity = self._cosine_similarity(embedding, node_vector)
            
            if similarity >= threshold:
                node_data = self.get_node(node_id)
                if node_data:
                    node_data['similarity_score'] = round(similarity, 4)
                    results.append(node_data)
        
        # Sort by similarity score descending
        results.sort(key=lambda x: x.get('similarity_score', 0.0), reverse=True)
        
        # Return top_k results
        return results[:top_k]
    
    @staticmethod
    def _cosine_similarity(vec_a: List[float], vec_b: List[float]) -> float:
        """Compute cosine similarity between two vectors."""
        if len(vec_a) != len(vec_b):
            return 0.0
        
        dot_product = sum(a * b for a, b in zip(vec_a, vec_b))
        norm_a = sum(a * a for a in vec_a) ** 0.5
        norm_b = sum(b * b for b in vec_b) ** 0.5
        
        if norm_a == 0.0 or norm_b == 0.0:
            return 0.0
        
        return dot_product / (norm_a * norm_b)

    # ── Vector storage (co-located .npy files) ────────────────────────────────

    def save_vector(self, node_id: str, vector: List[float]) -> None:
        """Persist an embedding vector alongside the node."""
        try:
            import numpy as np
            path = self._vector_path(node_id)
            np.save(str(path), np.array(vector, dtype="float32"))
        except ImportError:
            # JSON fallback
            self._vector_path(node_id).with_suffix(".json").write_text(
                json.dumps(vector)
            )

    def load_vector(self, node_id: str) -> Optional[List[float]]:
        """Load the embedding vector for a node, or None."""
        npy_path  = self._vector_path(node_id)
        json_path = npy_path.with_suffix(".json")

        if npy_path.exists():
            try:
                import numpy as np
                return np.load(str(npy_path)).tolist()
            except Exception:
                pass

        if json_path.exists():
            try:
                return json.loads(json_path.read_text())
            except Exception:
                pass

        return None

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self) -> None:
        """Serialise graph (without vectors) to disk."""
        path = self._root / self._GRAPH_FILE
        data = nx.node_link_data(self.graph)
        path.write_text(json.dumps(data, indent=2, default=str))
        logger.debug(f"Graph saved → {path}")

    def load(self) -> None:
        """Reload graph from disk (replaces in-memory state)."""
        self.graph = self._load_or_create()
        logger.info(
            f"Graph reloaded: {self.node_count} nodes, {self.edge_count} edges"
        )

    # ── Properties ────────────────────────────────────────────────────────────

    @property
    def node_count(self) -> int:
        return self.graph.number_of_nodes()

    @property
    def edge_count(self) -> int:
        return self.graph.number_of_edges()

    def stats(self) -> Dict:
        return {
            "node_count":    self.node_count,
            "edge_count":    self.edge_count,
            "storage_path":  str(self._root),
            "is_dag":        nx.is_directed_acyclic_graph(self.graph),
            "density":       round(nx.density(self.graph), 6),
        }

    # ── Internals ─────────────────────────────────────────────────────────────

    def _load_or_create(self) -> nx.DiGraph:
        path = self._root / self._GRAPH_FILE
        if path.exists():
            try:
                data = json.loads(path.read_text())
                g    = nx.node_link_graph(data, directed=True, multigraph=False)
                logger.info(f"Graph loaded from {path}")
                return g
            except Exception as e:
                logger.warning(f"Could not load graph ({e}), starting fresh")
        return nx.DiGraph()

    def _maybe_save(self) -> None:
        if self._auto_save:
            self.save()

    def _vector_path(self, node_id: str) -> Path:
        safe = node_id.replace("/", "_").replace("\\", "_")
        return self._vectors_dir / f"{safe}.npy"

    def _delete_vector(self, node_id: str) -> None:
        for suffix in (".npy", ".json"):
            p = self._vector_path(node_id).with_suffix(suffix)
            p.unlink(missing_ok=True)
