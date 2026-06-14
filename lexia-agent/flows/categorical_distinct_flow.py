"""
Categorical Distinct Flow — Run CategoricalDistinctNode for a given source.

Accepts a ``source_id``, resolves its parquet cache + DTO, builds a
``ColumnsClasses`` containing **only** the caller-selected categorical columns,
and runs ``CategoricalDistinctNode`` to produce the ``_distinct.parquet`` with
LLM definitions + embeddings.

Designed to be called from an API endpoint via ``run_in_executor`` so that
the long-running LLM + embedding work doesn't block the event loop.
"""

from __future__ import annotations

import importlib
import logging
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DATA_DIR = _PROJECT_ROOT / "data"


def _ensure_data_on_path() -> None:
    s = str(_DATA_DIR)
    if s not in sys.path:
        sys.path.insert(0, s)


def _load_columns_classes(columns_class_ref: str):
    """Import a ColumnsClasses factory from a ``module`` or ``module:function`` ref."""
    _ensure_data_on_path()
    if ":" in columns_class_ref:
        mod_path, func_name = columns_class_ref.split(":", 1)
    else:
        mod_path = columns_class_ref
        func_name = "get_columns_descriptions"
    mod = importlib.import_module(mod_path)
    mod = importlib.reload(mod)
    return getattr(mod, func_name)()


def _resolve_parquet_path(source_cfg: dict) -> Optional[Path]:
    """Resolve the data parquet cache path from a datasource config dict."""
    raw = source_cfg.get("cache_file")
    if not raw:
        return None
    p = Path(raw)
    if p.is_absolute() and p.exists():
        return p
    cache_dir = _PROJECT_ROOT / "data" / "parquet"
    if (cache_dir / p.name).exists():
        return cache_dir / p.name
    if p.exists():
        return p
    return None


def _resolve_effective_config(
    source_cfg: Dict[str, Any],
    table_id: Optional[str],
) -> Dict[str, Any]:
    """Return a flat dict with columns_class / cache_file / embeddings_file.

    For multi-table sources the values live on the matching table entry, not on
    the source root.  This helper merges the right level into a single dict.
    """
    if table_id and source_cfg.get("tables"):
        tables = source_cfg["tables"]
        for tbl in tables:
            tbl_dict = tbl.dict() if hasattr(tbl, "dict") else dict(tbl)
            if tbl_dict.get("table_id") == table_id:
                return {**source_cfg, **tbl_dict}
    return source_cfg


def run_categorical_distinct(
    source_id: str,
    categorical_columns: List[str],
    source_cfg: Optional[Dict[str, Any]] = None,
    table_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Run CategoricalDistinctNode for *source_id* with the given categorical columns.

    Args:
        source_id: datasource identifier (must exist in datasources.yaml).
        categorical_columns: column names the user marked as categorical.
        source_cfg: pre-loaded source config dict (optional, loaded from YAML if absent).
        table_id: for multi-table sources, which table to target.

    Returns:
        Dict with ``success``, ``distinct_parquet_path``, ``summary``, ``duration_ms``.
    """
    from nodes.dataloader.categorical_distinct_node import CategoricalDistinctNode

    t0 = time.perf_counter()

    if source_cfg is None:
        from config import get_settings
        # Reload from YAML so freshly-edited entries (e.g. columns_class
        # added after an XLSX upload) are visible without an app restart.
        settings = get_settings(reload=True)
        source_cfg = next(
            (s for s in (settings.data_sources or []) if s.source_id == source_id),
            None,
        )
        if source_cfg is not None:
            source_cfg = source_cfg.dict() if hasattr(source_cfg, "dict") else dict(source_cfg)
    if not source_cfg:
        return {"success": False, "error": f"Source config not found: {source_id}"}

    effective = _resolve_effective_config(source_cfg, table_id)

    columns_class_ref = effective.get("columns_class", "")
    if not columns_class_ref:
        return {"success": False, "error": f"No columns_class configured for {source_id}/{table_id or ''}"}

    try:
        full_cc = _load_columns_classes(columns_class_ref)
    except Exception as e:
        return {"success": False, "error": f"Failed to load DTO: {e}"}

    parquet_path = _resolve_parquet_path(effective)
    if not parquet_path or not parquet_path.exists():
        return {"success": False, "error": f"Parquet cache not found for {source_id}"}

    from data.classes.columns_classes import ColumnClass, ColumnsClasses
    selected_set = set(categorical_columns)
    filtered_columns = []
    for col in full_cc.columns:
        if col.column_name in selected_set:
            d = col.model_dump() if hasattr(col, "model_dump") else col.dict()
            d["is_categorical"] = True
            filtered_columns.append(ColumnClass(**d))

    if not filtered_columns:
        return {"success": False, "error": "None of the selected columns exist in the DTO"}

    filtered_cc = ColumnsClasses(columns=filtered_columns)

    logger.info(
        "Running CategoricalDistinct for '%s' with %d categorical columns: %s",
        source_id, len(filtered_columns),
        [c.column_name for c in filtered_columns],
    )

    embeddings_file = effective.get("embeddings_file")
    distinct_output = None
    if embeddings_file:
        ep = Path(embeddings_file)
        if not ep.is_absolute():
            ep = _PROJECT_ROOT / "data" / "parquet" / ep.name
        distinct_output = str(ep)

    node = CategoricalDistinctNode(name=f"CategoricalDistinct_{source_id}")
    shared: Dict[str, Any] = {
        "parquet_path": str(parquet_path),
        "columns_classes": filtered_cc,
        "distinct_output": distinct_output,
    }

    try:
        prep = node.prep(shared)
        result = node.exec(prep)
        node.post(shared, prep, result)
    except Exception as e:
        logger.error("CategoricalDistinct failed for '%s': %s", source_id, e, exc_info=True)
        return {"success": False, "error": str(e)}

    elapsed = round((time.perf_counter() - t0) * 1000, 1)
    return {
        "success": True,
        "distinct_parquet_path": shared.get("distinct_parquet_path"),
        "summary": shared.get("distinct_summary", {}),
        "duration_ms": elapsed,
    }
