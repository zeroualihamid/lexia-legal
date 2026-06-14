"""Normalize rows from ``*_embeddings.parquet`` / ``*_distinct.parquet`` for semantic search.

Supports both legacy schemas (one ``distinct_value`` per row) and batched columns
(``distinct_values`` as a list / JSON per row).
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

logger = logging.getLogger(__name__)


def normalize_embedding_vectors_payload(emb_raw: Any) -> List[Any]:
    """Turn parquet cell into ``list[list[float]]`` for :func:`semantic_search_node._best_similarity`."""
    if emb_raw is None:
        return []
    if isinstance(emb_raw, str):
        try:
            emb_raw = json.loads(emb_raw)
        except (json.JSONDecodeError, TypeError):
            return []
    if not isinstance(emb_raw, list):
        return []
    if len(emb_raw) == 0:
        return []
    # Single numeric vector → one candidate vector
    if all(isinstance(x, (int, float)) for x in emb_raw):
        return [emb_raw]
    return emb_raw


def iter_embedding_parquet_rows(parquet_path: Path) -> Iterator[Tuple[str, Any, Any, Any]]:
    """Yield ``(column_name, distinct_value, definition_values, embedded_values)`` per *value*.

    *definition_values* and *embedded_values* are passed through as stored (often JSON /
    list). Callers that expect a single embedding list per value should handle zipping.
    """
    import duckdb

    path = str(parquet_path)
    conn = duckdb.connect(database=":memory:")
    try:
        cur = conn.execute("SELECT * FROM read_parquet($1) LIMIT 1000000", [path])
        desc = cur.description
        if not desc:
            return
        col_names = [c[0] for c in desc]
        lower = {c.lower(): c for c in col_names}

        has_dv = "distinct_value" in lower
        has_dvs = "distinct_values" in lower
        if not has_dv and not has_dvs:
            logger.warning("Parquet %s has neither distinct_value nor distinct_values", parquet_path.name)
            return

        cn_key = lower.get("column_name", "column_name")
        def_key = lower.get("definition_values", "definition_values")
        emb_key = lower.get("embedded_values", "embedded_values")

        for row in cur.fetchall():
            d = dict(zip(col_names, row))
            cname = d.get(cn_key) or d.get("column_name")
            if cname is None:
                continue
            defs_raw = d.get(def_key)
            emb_raw = d.get(emb_key)

            dv_col = lower.get("distinct_value")
            if has_dv and dv_col is not None and d.get(dv_col) is not None:
                yield (
                    str(cname),
                    d.get(dv_col),
                    defs_raw,
                    emb_raw,
                )
                continue

            if has_dvs:
                dvs = d.get("distinct_values")
                if isinstance(dvs, str):
                    try:
                        dvs = json.loads(dvs)
                    except (json.JSONDecodeError, TypeError):
                        dvs = []
                if not isinstance(dvs, list):
                    continue
                embs = emb_raw
                if isinstance(embs, str):
                    try:
                        embs = json.loads(embs)
                    except (json.JSONDecodeError, TypeError):
                        embs = []
                if not isinstance(embs, list):
                    continue
                n = min(len(dvs), len(embs))
                for i in range(n):
                    yield (str(cname), dvs[i], defs_raw, embs[i] if i < len(embs) else [])
    finally:
        conn.close()


def collect_embedding_rows(parquet_path: Path) -> List[Dict[str, Any]]:
    """Materialize as list of dicts with keys compatible with :mod:`semantic_tool`."""
    out: List[Dict[str, Any]] = []
    for col_name, dv, defs_raw, emb_raw in iter_embedding_parquet_rows(parquet_path):
        out.append({
            "column_name": col_name,
            "distinct_value": dv,
            "definition_values": defs_raw,
            "embedded_values": emb_raw,
        })
    return out
