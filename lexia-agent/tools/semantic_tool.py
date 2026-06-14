"""
semantic_search tool — Resolve natural-language entity names to exact categorical
values using embedding similarity against _distinct.parquet or _embeddings.parquet
files.

This is critical for generating accurate SQL WHERE clauses: the LLM must use
exact categorical values (e.g., "Automobile" not "automobile" or "auto").
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)

_SEMANTIC_THRESHOLD = 0.35
_SEMANTIC_TOP_K = 5


def _handle_semantic_search(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    """Search categorical embeddings for exact matching values."""
    query = args.get("query", "").strip()
    if not query:
        return ToolResult(tool_use_id="", content="No search query provided.", is_error=True)

    column_filter = args.get("column_name")
    top_k = args.get("top_k", _SEMANTIC_TOP_K)

    # Find parquet cache directory
    from config import get_settings
    settings = get_settings()
    cache_dir = Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")

    # Discover embedding files: prefer _distinct.parquet, fall back to _embeddings.parquet
    distinct_files = sorted(cache_dir.glob("*_distinct.parquet"))
    embeddings_files = sorted(cache_dir.glob("*_embeddings.parquet"))
    # Deduplicate: for a given source stem, prefer _distinct (smaller) over _embeddings
    seen_stems: set = set()
    combined_files: List[Path] = []
    for f in distinct_files:
        stem = f.stem.removesuffix("_distinct")
        seen_stems.add(stem)
        combined_files.append(f)
    for f in embeddings_files:
        stem = f.stem.removesuffix("_embeddings")
        if stem not in seen_stems:
            combined_files.append(f)
    if not combined_files:
        return ToolResult(
            tool_use_id="",
            content="No categorical embedding files found (*_distinct.parquet or *_embeddings.parquet). Run embedding generation first.",
            is_error=True,
        )

    # Use SemanticSearchNode logic directly
    try:
        import duckdb
        import numpy as np
        from services.embedding_model_provider import get_embedding_model
        from nodes.dataloader.embedding_parquet_rows import (
            iter_embedding_parquet_rows,
            normalize_embedding_vectors_payload,
        )
        from nodes.dataloader.semantic_search_node import _best_similarity

        model = get_embedding_model()
        query_vec = np.asarray(model.encode(query, show_progress_bar=False), dtype=np.float32)

        all_matches: List[Dict[str, Any]] = []

        for dist_path in combined_files:
            source_name = dist_path.stem  # e.g. "oracle_env_ca_view_distinct"
            for col_name, distinct_val, defs_json, emb_json in iter_embedding_parquet_rows(dist_path):
                if column_filter and col_name != column_filter:
                    continue
                embedded_vectors = normalize_embedding_vectors_payload(emb_json)
                if not embedded_vectors:
                    continue

                score = _best_similarity(query_vec, embedded_vectors)
                if score < _SEMANTIC_THRESHOLD:
                    continue

                try:
                    definitions = json.loads(defs_json) if isinstance(defs_json, str) else (defs_json or [])
                except (json.JSONDecodeError, TypeError):
                    definitions = []
                if not isinstance(definitions, list):
                    definitions = []

                all_matches.append({
                    "source": source_name,
                    "column_name": col_name,
                    "distinct_value": distinct_val,
                    "definitions": definitions,
                    "score": round(score, 4),
                })

        # Sort by score and take top_k
        all_matches.sort(key=lambda r: r["score"], reverse=True)
        results = all_matches[:top_k]

        if not results:
            return ToolResult(
                tool_use_id="",
                content=f"No categorical values matched for '{query}' above threshold {_SEMANTIC_THRESHOLD}.",
            )

        # Format as structured text — clearly separate SQL values from definitions
        lines = [
            f"## Semantic matches for: \"{query}\"",
            f"Found {len(results)} match(es).\n",
            "IMPORTANT: Use ONLY the SQL_VALUE strings in WHERE clauses with `=`.",
            "The 'meaning' lines are human descriptions — NEVER put them in SQL.",
            "NEVER use ILIKE or LIKE — always use exact `column = 'SQL_VALUE'`.\n",
        ]

        by_col: Dict[str, List] = {}
        for m in results:
            key = f"{m['column_name']} ({m['source']})"
            by_col.setdefault(key, []).append(m)

        for col_key, matches in by_col.items():
            lines.append(f"### Column: {col_key}")
            for m in matches:
                lines.append(f"  - SQL_VALUE: '{m['distinct_value']}'  (confidence: {m['score']})")
                if m["definitions"]:
                    lines.append(f"    meaning: {', '.join(m['definitions'])}")

        return ToolResult(tool_use_id="", content="\n".join(lines))

    except ImportError as exc:
        return ToolResult(
            tool_use_id="",
            content=f"Semantic search dependencies missing: {exc}",
            is_error=True,
        )
    except Exception as exc:
        logger.error("Semantic search failed: %s", exc, exc_info=True)
        return ToolResult(tool_use_id="", content=f"Semantic search error: {exc}", is_error=True)


semantic_search_tool = Tool(
    name="semantic_search",
    description=(
        "Search categorical column embeddings to find the exact distinct values matching a natural-language term. "
        "Use this BEFORE writing SQL with WHERE clauses on categorical columns (marked [CAT] in schema). "
        "For example, searching 'automobile' returns SQL_VALUE: 'Automobile' for column LIBEBRAN. "
        "Then use WHERE LIBEBRAN = 'Automobile' in your SQL (exact equality, NEVER LIKE/ILIKE). "
        "The returned SQL_VALUE strings are the ONLY correct values for WHERE clauses."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The entity or value to search for (e.g., 'automobile', 'accident corporel', 'nord').",
            },
            "column_name": {
                "type": "string",
                "description": "Optional: restrict search to a specific column name (e.g., 'LIBEBRAN').",
            },
            "top_k": {
                "type": "integer",
                "description": "Max results to return (default 5).",
                "default": 5,
            },
        },
        "required": ["query"],
    },
    handler=_handle_semantic_search,
    category="read-only",
)
