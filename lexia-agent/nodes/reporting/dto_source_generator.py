"""Generate one ``dto_<stem>`` source CTE per parquet/DTO pair.

Every reporting block CTE must read its data from a single source CTE so the
``depends_on`` chain stays explicit and ``inject_accounting_dependencies``
can stitch the parquet read into the final SQL at render time.

This module materialises one ``data/reporting/sql/fragment_library/dto_<stem>.sql`` file
per entry in :func:`flows.dto_cache_flow.get_dto_cache` and registers each
file in the block library ``index.yaml`` under ``kind: source``.

The generated SQL is shape:

    WITH dto_<stem> AS (
        SELECT <canonical-aliased columns>
        FROM read_parquet('<absolute path>')
    )
    SELECT * FROM dto_<stem>

Block authors then write::

    WITH my_block AS (SELECT … FROM dto_<stem>) SELECT … FROM my_block

…and ``inject_accounting_dependencies`` inlines the dto source ahead of the
block's ``WITH`` automatically (because the block declares
``depends_on: [dto_<stem>]`` in the block library index).
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from nodes.reporting.parquet_resolver import _build_select_list


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent


def _dto_stem_from_parquet_stem(parquet_stem: str) -> str:
    """Canonical block-library name for a parquet stem.

    Uses the ``dto_`` prefix so generated source CTEs are visually distinct
    from human-authored block CTEs in ``fragment_library/index.yaml``.
    """
    return f"dto_{parquet_stem}"


def _columns_from_dto(columns_classes: Any) -> List[Dict[str, Any]]:
    """Extract a list of ``{column_name, type, description, is_categorical}``
    from a ``ColumnsClasses`` instance, tolerating attribute or dict shape.
    """
    if columns_classes is None:
        return []
    cols = getattr(columns_classes, "columns", None)
    if cols is None and isinstance(columns_classes, dict):
        cols = columns_classes.get("columns")
    out: List[Dict[str, Any]] = []
    for col in cols or []:
        name = getattr(col, "column_name", None) or (
            col.get("column_name") if isinstance(col, dict) else None
        )
        if not name:
            continue
        out.append({
            "column_name": name,
            "type": (
                getattr(col, "type", None)
                or (col.get("type") if isinstance(col, dict) else None)
                or "string"
            ),
            "description": (
                getattr(col, "description", None)
                or (col.get("description") if isinstance(col, dict) else None)
                or ""
            ),
            "is_categorical": bool(
                getattr(col, "is_categorical", False)
                or (col.get("is_categorical") if isinstance(col, dict) else False)
            ),
        })
    return out


def generate_dto_source_sql(
    parquet_stem: str,
    parquet_path: str,
    columns_classes: Any,
) -> str:
    """Build the SQL body for ``dto_<stem>.sql``.

    The SELECT list reuses :func:`_build_select_list` so canonical aliases
    (``account_code``, ``date``, ``debit``, …) are applied wherever a DTO
    column happens to match — this keeps the source CTE compatible with
    accounting-library CTEs that already read those canonical names.
    Non-canonical DTO columns pass through under their original name.
    """
    cols = _columns_from_dto(columns_classes)
    column_names = [c["column_name"] for c in cols]
    select_clause = _build_select_list(column_names) if column_names else "*"
    dto_cte = _dto_stem_from_parquet_stem(parquet_stem)
    # The final SELECT * keeps the CTE shape (WITH … SELECT) that
    # validate_block expects for any leaf-kind block.
    return (
        f"WITH {dto_cte} AS (\n"
        f"    SELECT\n        {select_clause}\n"
        f"    FROM read_parquet('{parquet_path}')\n"
        f")\n"
        f"SELECT * FROM {dto_cte}\n"
    )


def _ensure_index(block_library_dir: Path) -> Dict[str, Any]:
    block_library_dir.mkdir(parents=True, exist_ok=True)
    idx_path = block_library_dir / "index.yaml"
    if not idx_path.is_file():
        idx_path.write_text(
            yaml.safe_dump({"version": 1, "ctes": []}, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
        return {"version": 1, "ctes": []}
    data = yaml.safe_load(idx_path.read_text(encoding="utf-8")) or {}
    data.setdefault("version", 1)
    data.setdefault("ctes", [])
    return data


def _upsert_index_entry(idx: Dict[str, Any], entry: Dict[str, Any]) -> bool:
    """Insert or update an entry by name. Returns True if the index changed."""
    name = entry["name"]
    ctes: List[Dict[str, Any]] = list(idx.get("ctes") or [])
    for i, existing in enumerate(ctes):
        if isinstance(existing, dict) and existing.get("name") == name:
            if existing == entry:
                return False
            ctes[i] = entry
            idx["ctes"] = ctes
            return True
    ctes.append(entry)
    idx["ctes"] = ctes
    return True


def _ensure_data_on_path() -> None:
    """Make sure ``data/`` is on ``sys.path`` so ``classes.dtos.*`` imports work.

    Mirrors what ``flows.dto_cache_flow.DTOLoadNode.exec`` does.
    """
    import sys
    data_dir = str(_PROJECT_ROOT / "data")
    if data_dir not in sys.path:
        sys.path.insert(0, data_dir)


def _resolve_dto_function(columns_class_ref: Optional[str]) -> Any:
    """Import ``module.path:function_name`` and return the ColumnsClasses.

    The ``columns_class`` field in ``datasources.yaml`` follows
    ``classes.dtos.ca_view_dto:get_ca_view_columns_descriptions``.
    """
    if not columns_class_ref or ":" not in columns_class_ref:
        return None
    _ensure_data_on_path()
    import importlib
    module_path, fn_name = columns_class_ref.split(":", 1)
    try:
        mod = importlib.import_module(module_path)
        fn = getattr(mod, fn_name, None)
        if fn is None:
            return None
        return fn()
    except Exception as exc:  # noqa: BLE001 - keep generator resilient
        logger.warning(
            "dto_source_generator: could not load %s — %s",
            columns_class_ref, exc,
        )
        return None


def _load_datasource_entries(datasources_yaml: Path) -> List[Dict[str, Any]]:
    """Read ``datasources.yaml`` and expand into per-table entries.

    Reuses ``nodes.input.schema_loader_node._to_datasource_entry_from_data_source``
    so the parquet stem ↔ DTO function mapping stays in one place.
    """
    if not datasources_yaml.is_file():
        return []
    raw = yaml.safe_load(datasources_yaml.read_text(encoding="utf-8")) or {}
    sources = raw.get("data_sources") or []
    from nodes.input.schema_loader_node import _to_datasource_entry_from_data_source

    out: List[Dict[str, Any]] = []
    for src in sources:
        if not src.get("enabled", True):
            continue
        out.extend(_to_datasource_entry_from_data_source(src))
    return out


def generate_all_dto_sources(
    parquet_dir: Path,
    block_library_dir: Path,
    *,
    overwrite: bool = False,
    datasources_yaml: Optional[Path] = None,
) -> List[str]:
    """Materialise one ``dto_<stem>.sql`` per DTO/parquet pair.

    Args:
        parquet_dir: location of ``<stem>.parquet`` files. Used to resolve
            absolute paths embedded in the generated SQL.
        block_library_dir: usually ``data/reporting/sql/fragment_library/``.
        overwrite: when False, skip files that already exist on disk
            (the index entry is still upserted in case metadata changed).
        datasources_yaml: optional override for the datasources config path
            (defaults to ``config/datasources.yaml`` relative to project root).

    Returns:
        List of dto stems written or refreshed (``["dto_oracle_env_ca_view", …]``).
    """
    block_library_dir = Path(block_library_dir)
    parquet_dir = Path(parquet_dir).resolve()
    cfg_path = datasources_yaml or (_PROJECT_ROOT / "config" / "datasources.yaml")

    entries = _load_datasource_entries(Path(cfg_path))
    idx = _ensure_index(block_library_dir)
    written: List[str] = []
    index_changed = False

    for entry in sorted(entries, key=lambda e: e.get("source_id") or ""):
        parquet_stem = entry.get("source_id") or ""
        if not parquet_stem:
            continue

        # Path can be absolute or relative to project root.
        path_raw = entry.get("path")
        if not path_raw:
            continue
        parquet_path = Path(path_raw)
        if not parquet_path.is_absolute():
            parquet_path = (_PROJECT_ROOT / path_raw).resolve()
        if not parquet_path.is_file():
            logger.debug(
                "dto_source_generator: skipping %s (parquet not found at %s)",
                parquet_stem, parquet_path,
            )
            continue

        columns_classes = _resolve_dto_function(entry.get("columns_class"))
        cols = _columns_from_dto(columns_classes)
        if not cols:
            logger.warning(
                "dto_source_generator: %s has no columns in its DTO — skipping",
                parquet_stem,
            )
            continue

        dto_name = _dto_stem_from_parquet_stem(parquet_stem)
        sql_path = block_library_dir / f"{dto_name}.sql"
        sql = generate_dto_source_sql(
            parquet_stem,
            str(parquet_path),
            columns_classes,
        )
        if sql_path.is_file() and not overwrite:
            # Leave the file alone but still keep the index entry fresh.
            pass
        else:
            sql_path.write_text(sql, encoding="utf-8")
            written.append(dto_name)

        description = (
            f"Source CTE for {parquet_stem}.parquet. "
            f"{(entry.get('description') or '').strip()[:200]}"
        ).strip()
        index_entry = {
            "name": dto_name,
            "kind": "source",
            "description": description,
            "projects": [c["column_name"] for c in cols],
            "depends_on": [],
            "parameters": [],
            "parquet_stem": parquet_stem,
        }
        cls_ref = entry.get("columns_class")
        if cls_ref:
            index_entry["dto_module"] = cls_ref.split(":", 1)[0]

        if _upsert_index_entry(idx, index_entry):
            index_changed = True

    if index_changed:
        idx_path = block_library_dir / "index.yaml"
        idx_path.write_text(
            yaml.safe_dump(idx, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )

    return written


__all__ = [
    "generate_dto_source_sql",
    "generate_all_dto_sources",
    "_dto_stem_from_parquet_stem",
]
