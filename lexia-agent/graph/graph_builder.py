# graph/graph_builder.py

"""
Graph Builder
=============

Builds and maintains the reasoning graph from code execution history.

Responsibilities:
  - Add new code nodes after successful (or failed) executions
  - Detect and wire edges automatically:
      LEADS_TO      – sequential steps in the same session
      SIMILAR_TO    – high semantic similarity (via embeddings)
      REFINES       – improved version of a previous node
      DEPENDS_ON    – explicit step dependency declared in metadata
  - Deduplicate: hash-identical code reuses the existing node
  - Session tracking: remembers the last node per session for LEADS_TO edges

Usage:
    from graph.graph_builder import GraphBuilder
    from graph.reasoning_graph import ReasoningGraph

    graph   = ReasoningGraph(config)
    builder = GraphBuilder(graph, config)

    node_id = builder.add_execution(
        code        = "df = pd.read_parquet('sales.parquet')",
        description = "Load sales parquet file",
        success     = True,
        duration    = 1.2,
        metadata    = {
            "session_id":   "s-001",
            "step_id":      "step-1",
            "step_index":   0,
            "schema_table": "commande_entete",
        }
    )
"""

from __future__ import annotations

import hashlib
import time
from typing import Any, Dict, List, Optional

from graph.storage.networkx_backend import NetworkXBackend
from graph.embeddings.code_embedder  import CodeEmbedder
from graph.embeddings.similarity_search import SimilaritySearch
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Edge type constants (mirrors graph/edge.py EdgeType values)
# ─────────────────────────────────────────────────────────────────────────────
LEADS_TO      = "leads_to"
SIMILAR_TO    = "similar_to"
REFINES       = "refines"
DEPENDS_ON    = "depends_on"
ALTERNATIVE_TO= "alternative_to"


class GraphBuilder:
    """
    Constructs the reasoning graph from execution history.

    Config keys read:
        graph_similarity_threshold   – min cosine score to create SIMILAR_TO edge  (default: 0.88)
        graph_refine_threshold       – min cosine score to mark as REFINES edge     (default: 0.95)
        graph_max_similar_edges      – max SIMILAR_TO edges per new node            (default: 5)
        graph_leads_to_window        – max session steps back to wire LEADS_TO      (default: 1)
    """

    def __init__(self, graph=None, config=None):
        """
        Args:
            graph:  ReasoningGraph instance (or None to create from config)
            config: configuration object
        """
        if config is None:
            from config.settings import settings
            config = settings

        self._config = config

        # Accept either a ReasoningGraph wrapper or the raw backend directly
        if graph is not None:
            self._graph = graph
        else:
            from graph.reasoning_graph import ReasoningGraph
            self._graph = ReasoningGraph(config)

        # Thresholds
        self._sim_threshold    = getattr(config, "graph_similarity_threshold", 0.88)
        self._refine_threshold = getattr(config, "graph_refine_threshold",     0.95)
        self._max_similar      = getattr(config, "graph_max_similar_edges",    5)
        self._leads_window     = getattr(config, "graph_leads_to_window",      1)

        # session_id → [node_id, ...]  (ordered list of nodes added this session)
        self._session_nodes: Dict[str, List[str]] = {}

        logger.info(
            f"GraphBuilder ready — "
            f"sim_threshold={self._sim_threshold}, "
            f"refine_threshold={self._refine_threshold}"
        )

    # =========================================================================
    # Public API
    # =========================================================================

    def add_execution(
        self,
        code:        str,
        description: str = "",
        success:     bool = True,
        duration:    float = 0.0,
        metadata:    Optional[Dict[str, Any]] = None,
    ) -> str:
        """
        Record a code execution in the graph.

        Steps performed:
        1. Hash code → check for exact duplicate node
        2. Upsert node in backend
        3. Record execution stats (success_rate, quality_score)
        4. Embed code + description → store vector
        5. Auto-wire edges (LEADS_TO, SIMILAR_TO/REFINES, DEPENDS_ON)

        Args:
            code:        Python source that was executed
            description: Human-readable description of what the code does
            success:     Whether execution succeeded
            duration:    Wall-clock execution time in seconds
            metadata:    Dict with any of:
                           session_id   – groups steps into workflows
                           step_id      – unique step identifier
                           step_index   – position in the plan (0-based)
                           schema_table – ColumnsClasses table name
                           step_type    – "data_loading" | "filtering" | etc.
                           parent_node_id – explicit predecessor for REFINES edge

        Returns:
            node_id (str) — may be an existing node_id if code is a duplicate
        """
        meta       = metadata or {}
        session_id = meta.get("session_id", "default")
        t_start    = time.perf_counter()

        # ── 1. Deduplication ──────────────────────────────────────────────────
        code_hash = _sha256(code)
        existing  = self._find_node_by_hash(code_hash)

        if existing:
            node_id = existing
            logger.debug(f"Duplicate code detected — reusing node {node_id[:12]}")
            # Still record the new execution stats on the existing node
            self._graph.backend.record_execution(node_id, success, duration)
            self._track_session(session_id, node_id)
            self._wire_leads_to(session_id, node_id)
            return node_id

        # ── 2. Upsert node ───────────────────────────────────────────────────
        node_id = _make_node_id(code_hash, meta.get("step_id", ""))

        self._graph.backend.add_node(
            node_id     = node_id,
            code        = code,
            description = description,
            step_type   = meta.get("step_type", "generic"),
            schema_table= meta.get("schema_table", ""),
            metadata    = {
                "code_hash":   code_hash,
                "session_id":  session_id,
                "step_id":     meta.get("step_id", ""),
                "step_index":  meta.get("step_index", -1),
                **{k: v for k, v in meta.items()
                   if k not in ("session_id", "step_id", "step_index",
                                "schema_table", "step_type")},
            },
        )

        # ── 3. Execution stats ───────────────────────────────────────────────
        self._graph.backend.record_execution(node_id, success, duration)

        # ── 4. Embed and index ───────────────────────────────────────────────
        self._embed_and_index(node_id, code, description, meta)

        # ── 5. Wire edges ────────────────────────────────────────────────────
        self._track_session(session_id, node_id)
        self._wire_leads_to(session_id, node_id)
        self._wire_similar_and_refine(node_id, code, description, meta)
        self._wire_depends_on(node_id, meta)

        elapsed = (time.perf_counter() - t_start) * 1000
        logger.info(
            f"Execution added: {node_id[:12]} "
            f"(success={success}, {duration:.2f}s, graph_ms={elapsed:.0f})"
        )
        return node_id

    def add_execution_batch(
        self,
        executions: List[Dict[str, Any]],
    ) -> List[str]:
        """
        Add multiple executions efficiently (shared embedding batch call).

        Each dict must match the kwargs of add_execution():
            code, description, success, duration, metadata

        Returns:
            List of node_ids in the same order as input.
        """
        # Resolve duplicates first so we don't embed code we already have
        to_embed: List[Dict]  = []
        results:  List[str]   = []

        for ex in executions:
            code_hash = _sha256(ex["code"])
            existing  = self._find_node_by_hash(code_hash)
            if existing:
                results.append(existing)
                self._graph.backend.record_execution(
                    existing, ex.get("success", True), ex.get("duration", 0.0)
                )
            else:
                results.append(None)          # placeholder
                to_embed.append(ex)

        # Batch embed misses
        if to_embed:
            embed_items = [
                {"code": e["code"], "description": e.get("description", "")}
                for e in to_embed
            ]
            embeddings = self._graph.embedder.embed_batch(embed_items)
            embed_iter  = iter(zip(to_embed, embeddings))

        # Second pass: add nodes + wire edges
        embed_idx = 0
        for i, ex in enumerate(executions):
            if results[i] is not None:
                continue     # was a duplicate, already handled

            ex_obj, emb = next(embed_iter)
            node_id = self.add_execution(
                code        = ex["code"],
                description = ex.get("description", ""),
                success     = ex.get("success", True),
                duration    = ex.get("duration", 0.0),
                metadata    = ex.get("metadata", {}),
            )
            results[i] = node_id

        logger.info(f"Batch: {len(executions)} executions, "
                    f"{len(to_embed)} new nodes")
        return results

    def rebuild_similarity_index(self) -> int:
        """
        Re-index all graph nodes into the SimilaritySearch index.
        Useful after loading an existing graph from disk.

        Returns: number of nodes indexed.
        """
        nodes = list(self._graph.backend.iter_nodes())
        if not nodes:
            return 0

        self._graph.search.clear()
        batch = [
            {
                "node_id":     n["node_id"],
                "code":        n["code"],
                "description": n.get("description", ""),
                "metadata":    n.get("metadata", {}),
            }
            for n in nodes
        ]
        self._graph.search.add_batch(batch)
        logger.info(f"Similarity index rebuilt: {len(nodes)} nodes")
        return len(nodes)

    # =========================================================================
    # Private helpers
    # =========================================================================

    def _find_node_by_hash(self, code_hash: str) -> Optional[str]:
        """Return node_id whose metadata.code_hash matches, or None."""
        for node in self._graph.backend.iter_nodes():
            if node.get("metadata", {}).get("code_hash") == code_hash:
                return node["node_id"]
        return None

    def _embed_and_index(
        self,
        node_id:     str,
        code:        str,
        description: str,
        meta:        Dict,
    ) -> None:
        """Embed code+description, persist vector, add to search index."""
        try:
            emb = self._graph.embedder.embed_code(
                code        = code,
                description = description,
                metadata    = {"node_id": node_id, **meta},
            )
            self._graph.backend.save_vector(node_id, emb.vector)
            self._graph.search.add(
                node_id     = node_id,
                code        = code,
                description = description,
                metadata    = meta,
            )
        except Exception as e:
            logger.warning(f"Embedding failed for {node_id[:12]}: {e}")

    # ── Edge wiring ───────────────────────────────────────────────────────────

    def _track_session(self, session_id: str, node_id: str) -> None:
        self._session_nodes.setdefault(session_id, []).append(node_id)

    def _wire_leads_to(self, session_id: str, node_id: str) -> None:
        """Connect to the previous node(s) in this session."""
        history = self._session_nodes.get(session_id, [])
        # history already includes current node at the end
        window = history[-1 - self._leads_window : -1]
        for prev_id in window:
            if prev_id != node_id:
                ok = self._graph.backend.add_edge(
                    prev_id, node_id,
                    edge_type = LEADS_TO,
                    weight    = 1.0,
                    metadata  = {"session_id": session_id},
                )
                if ok:
                    logger.debug(f"Edge LEADS_TO: {prev_id[:8]} → {node_id[:8]}")

    def _wire_similar_and_refine(
        self,
        node_id:     str,
        code:        str,
        description: str,
        meta:        Dict,
    ) -> None:
        """
        Search for semantically similar existing nodes and wire edges.
        High similarity  (≥ refine_threshold) → REFINES
        Medium similarity(≥ sim_threshold)    → SIMILAR_TO
        """
        query = description or code[:200]

        try:
            results = self._graph.search.query(
                query_text = query,
                top_k      = self._max_similar + 1,   # +1 to exclude self
                threshold  = self._sim_threshold,
            )
        except Exception as e:
            logger.warning(f"Similarity search failed during edge wiring: {e}")
            return

        # Explicit parent for REFINES (passed in metadata)
        explicit_parent = meta.get("parent_node_id")

        wired = 0
        for result in results:
            if result.node_id == node_id:
                continue                          # skip self
            if wired >= self._max_similar:
                break

            # Decide edge type
            if (result.score >= self._refine_threshold
                    or result.node_id == explicit_parent):
                edge_type = REFINES
            else:
                edge_type = SIMILAR_TO

            ok = self._graph.backend.add_edge(
                node_id, result.node_id,
                edge_type = edge_type,
                weight    = round(result.score, 4),
                metadata  = {"similarity": result.score},
            )
            if ok:
                logger.debug(
                    f"Edge {edge_type}: {node_id[:8]} → "
                    f"{result.node_id[:8]} (score={result.score:.3f})"
                )
                wired += 1

    def _wire_depends_on(self, node_id: str, meta: Dict) -> None:
        """
        Wire explicit DEPENDS_ON edges from metadata.

        Metadata key: 'dependencies' → List[step_id str]
        We resolve step_id → node_id via session history.
        """
        deps = meta.get("dependencies", [])
        if not deps:
            return

        session_id = meta.get("session_id", "default")
        history    = self._session_nodes.get(session_id, [])

        for dep_step_id in deps:
            # Find node in session whose step_id matches
            dep_node_id = self._resolve_step_id(dep_step_id, session_id)
            if dep_node_id and dep_node_id != node_id:
                self._graph.backend.add_edge(
                    node_id, dep_node_id,
                    edge_type = DEPENDS_ON,
                    weight    = 1.0,
                    metadata  = {"step_id": dep_step_id},
                )
                logger.debug(
                    f"Edge DEPENDS_ON: {node_id[:8]} → {dep_node_id[:8]}"
                )

    def _resolve_step_id(
        self,
        step_id:    str,
        session_id: str,
    ) -> Optional[str]:
        """Find a node_id by its step_id within the same session."""
        for node in self._graph.backend.iter_nodes():
            m = node.get("metadata", {})
            if (m.get("step_id")    == step_id
                    and m.get("session_id") == session_id):
                return node["node_id"]
        return None


# ─────────────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────────────

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _make_node_id(code_hash: str, step_id: str = "") -> str:
    """
    Create a stable, human-skimmable node identifier.
    Format: node-<8 hex chars of code hash>[-step_id_suffix]
    """
    base = f"node-{code_hash[:8]}"
    if step_id:
        safe = step_id.replace(" ", "_")[:16]
        return f"{base}-{safe}"
    return base
