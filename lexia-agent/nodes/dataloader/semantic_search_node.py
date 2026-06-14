"""
SemanticSearchNode — Match a natural-language query against the pre-embedded
``_distinct.parquet`` produced by ``CategoricalDistinctNode``.

The node:
1. Loads the ``_distinct.parquet`` (via DuckDB for efficiency).
2. Embeds the incoming query with the same SentenceTransformer model.
3. Computes cosine similarity between the query embedding and every
   embedded vector stored in each row.
4. Returns the top-K rows ranked by similarity, together with their
   ``distinct_value``, ``definition_values`` and score.

Inputs (via shared state):
- ``semantic_query``          (str):       Natural-language search query.
- ``distinct_parquet_path``   (str|Path):  Path to the ``_distinct.parquet``.
- ``embedding_model``         (optional, str): SentenceTransformer model name.
- ``semantic_top_k``          (optional, int): Number of results.  Default 10.
- ``semantic_threshold``      (optional, float): Min similarity.  Default 0.0.
- ``semantic_columns``        (optional, list[str]): Restrict search to these
                              ``column_name`` values.  Default: all columns.

Outputs (via shared state):
- ``semantic_results``  (list[dict]):  Ranked matches, each dict:
      column_name, distinct_value, definition_values (list[str]),
      score (float).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

import duckdb
import numpy as np

from nodes.base_node import BaseNode
from monitoring.logger import get_logger

logger = get_logger(__name__)

DEFAULT_EMBEDDING_MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2"
DEFAULT_TOP_K = 10


def _cosine_similarity(a: np.ndarray, b: np.ndarray) -> float:
    """Cosine similarity between two 1-D vectors."""
    dot = np.dot(a, b)
    norm = np.linalg.norm(a) * np.linalg.norm(b)
    if norm == 0.0:
        return 0.0
    return float(dot / norm)


def _best_similarity(query_vec: np.ndarray, embedded_vectors: List[List[float]]) -> float:
    """Return the highest cosine similarity between *query_vec* and any
    vector in *embedded_vectors* (the row may contain multiple embeddings:
    one for the value itself, plus one per definition)."""
    if not embedded_vectors:
        return 0.0
    return max(
        _cosine_similarity(query_vec, np.asarray(v, dtype=np.float32))
        for v in embedded_vectors
    )


class SemanticSearchNode(BaseNode):
    """Search a _distinct.parquet index using embedding similarity."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "SemanticSearch")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)

        query = shared.get("semantic_query")
        if not query:
            raise ValueError("SemanticSearchNode requires 'semantic_query' in shared state")

        parquet_path = shared.get("distinct_parquet_path")
        if not parquet_path:
            raise ValueError("SemanticSearchNode requires 'distinct_parquet_path' in shared state")
        parquet_path = Path(parquet_path)
        if not parquet_path.is_file():
            raise FileNotFoundError(f"Distinct parquet not found: {parquet_path}")

        return {
            "query": query,
            "parquet_path": parquet_path,
            "model_name": shared.get("embedding_model", DEFAULT_EMBEDDING_MODEL),
            "model_instance": shared.get("embedding_model_instance"),
            "top_k": shared.get("semantic_top_k", DEFAULT_TOP_K),
            "threshold": shared.get("semantic_threshold", 0.0),
            "filter_columns": shared.get("semantic_columns"),
        }

    def exec(self, prep_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        query: str = prep_result["query"]
        parquet_path: Path = prep_result["parquet_path"]
        model_name: str = prep_result["model_name"]
        top_k: int = prep_result["top_k"]
        threshold: float = prep_result["threshold"]
        filter_columns: Optional[List[str]] = prep_result["filter_columns"]

        # --- 1. Load rows from distinct parquet via DuckDB ------------------
        conn = duckdb.connect(database=":memory:")
        try:
            sql = "SELECT column_name, distinct_value, definition_values, embedded_values FROM read_parquet($1)"
            if filter_columns:
                placeholders = ", ".join(f"'{c}'" for c in filter_columns)
                sql += f" WHERE column_name IN ({placeholders})"
            rows = conn.execute(sql, [str(parquet_path)]).fetchall()
        finally:
            conn.close()

        if not rows:
            self.logger.warning("No rows loaded from %s", parquet_path)
            return []

        self.logger.info(f"Loaded {len(rows):,} rows from {parquet_path}")

        # --- 2. Embed the query ---------------------------------------------
        model = prep_result.get("model_instance")
        if model is None:
            from services.embedding_model_provider import get_embedding_model
            model = get_embedding_model(model_name)
        else:
            self.logger.info("Using pre-loaded embedding model")
        query_vec = model.encode(query, show_progress_bar=False)
        query_vec = np.asarray(query_vec, dtype=np.float32)

        # --- 3. Score each row ----------------------------------------------
        scored: List[Dict[str, Any]] = []
        for col_name, distinct_val, defs_json, emb_json in rows:
            try:
                embedded_vectors = json.loads(emb_json) if emb_json else []
            except (json.JSONDecodeError, TypeError):
                embedded_vectors = []

            score = _best_similarity(query_vec, embedded_vectors)
            if score < threshold:
                continue

            try:
                definitions = json.loads(defs_json) if defs_json else []
            except (json.JSONDecodeError, TypeError):
                definitions = []

            scored.append({
                "column_name": col_name,
                "distinct_value": distinct_val,
                "definition_values": definitions,
                "score": round(score, 6),
            })

        # --- 4. Rank and trim -----------------------------------------------
        scored.sort(key=lambda r: r["score"], reverse=True)
        results = scored[:top_k]

        self.logger.info(
            f"Query '{query[:60]}…' → {len(results)} result(s) "
            f"(best score: {results[0]['score']:.4f})" if results else
            f"Query '{query[:60]}…' → 0 results"
        )
        return results

    def post(self, shared: Dict[str, Any], prep_result: Any, exec_result: List[Dict[str, Any]]) -> str:
        shared["semantic_results"] = exec_result
        self.log_exit("default")
        return "default"


if __name__ == "__main__":
    import sys

    _root = str(Path(__file__).resolve().parent.parent.parent)
    sys.path.insert(0, _root)
    sys.path.insert(0, str(Path(_root) / "data"))

    parquet_file = sys.argv[1] if len(sys.argv) > 1 else "data/parquet/apf_distinct.parquet"
    query = sys.argv[2] if len(sys.argv) > 2 else "aéroport mohamed V"

    node = SemanticSearchNode()
    shared = {
        "semantic_query": query,
        "distinct_parquet_path": parquet_file,
        "semantic_top_k": 10,
        "semantic_threshold": 0.0,
    }

    prep_result = node.prep(shared)
    exec_result = node.exec(prep_result)
    node.post(shared, prep_result, exec_result)

    print(f"\nQuery: {query}")
    print(f"Results: {len(shared['semantic_results'])}\n")
    for i, r in enumerate(shared["semantic_results"], 1):
        print(f"  {i}. [{r['score']:.4f}] {r['column_name']}: {r['distinct_value']}")
        if r["definition_values"]:
            print(f"     defs: {r['definition_values']}")
