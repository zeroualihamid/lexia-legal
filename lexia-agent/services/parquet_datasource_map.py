"""
Map parquet filenames to datasource metadata from ``datasources.yaml`` (via Settings).

Used by the parquet API and prompts so file lists respect ``source_id`` / table ``enabled`` flags.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

from config import get_settings


def build_parquet_config_map() -> Dict[str, Dict[str, Any]]:
    """
    Build a map of parquet filename -> config metadata (enabled, source_id, table_id, cache_type).

    ``enabled`` reflects ``data_sources[].enabled`` and, for SQL tables,
    ``source.enabled and table.enabled``.
    """
    settings = get_settings()
    mapping: Dict[str, Dict[str, Any]] = {}

    for source in settings.data_sources:
        source_id = source.source_id
        source_enabled = bool(source.enabled)

        mapping[f"{source_id}.parquet"] = {
            "source_id": source_id,
            "table_id": None,
            "cache_type": "data",
            "enabled": source_enabled,
        }
        if source.cache_file:
            cache_basename = Path(source.cache_file).name
            mapping[cache_basename] = {
                "source_id": source_id,
                "table_id": None,
                "cache_type": "data",
                "enabled": source_enabled,
            }
        if source.embeddings_file:
            emb_basename = Path(source.embeddings_file).name
            mapping[emb_basename] = {
                "source_id": source_id,
                "table_id": None,
                "cache_type": "embeddings",
                "enabled": source_enabled,
            }
        mapping[f"{source_id}_data.parquet"] = {
            "source_id": source_id,
            "table_id": None,
            "cache_type": "data",
            "enabled": source_enabled,
        }
        mapping[f"{source_id}_embeddings.parquet"] = {
            "source_id": source_id,
            "table_id": None,
            "cache_type": "embeddings",
            "enabled": source_enabled,
        }

        if source.tables:
            for table in source.tables:
                table_id = table.table_id
                table_enabled = bool(table.enabled)
                combined_enabled = source_enabled and table_enabled

                mapping[f"{source_id}_{table_id}.parquet"] = {
                    "source_id": source_id,
                    "table_id": table_id,
                    "cache_type": "data",
                    "enabled": combined_enabled,
                }
                mapping[f"{source_id}_{table_id}_embeddings.parquet"] = {
                    "source_id": source_id,
                    "table_id": table_id,
                    "cache_type": "embeddings",
                    "enabled": combined_enabled,
                }
                if table.cache_file:
                    mapping[Path(table.cache_file).name] = {
                        "source_id": source_id,
                        "table_id": table_id,
                        "cache_type": "data",
                        "enabled": combined_enabled,
                    }
                if table.embeddings_file:
                    mapping[Path(table.embeddings_file).name] = {
                        "source_id": source_id,
                        "table_id": table_id,
                        "cache_type": "embeddings",
                        "enabled": combined_enabled,
                    }

    # Categorical distinct files: <stem>_distinct.parquet — same enabled as base data file
    extra: Dict[str, Dict[str, Any]] = {}
    for fname, meta in mapping.items():
        if meta.get("cache_type") == "embeddings" and fname.endswith("_embeddings.parquet"):
            continue
        stem = Path(fname).stem
        if stem.endswith("_distinct"):
            continue
        distinct_fname = f"{stem}_distinct.parquet"
        if distinct_fname not in mapping:
            extra[distinct_fname] = {
                **meta,
                "cache_type": "distinct",
            }
    mapping.update(extra)

    return mapping


def _source_enabled_by_id() -> Dict[str, bool]:
    return {s.source_id: bool(s.enabled) for s in get_settings().data_sources}


def parquet_file_is_enabled(
    filename: str,
    config_map: Optional[Dict[str, Dict[str, Any]]] = None,
) -> bool:
    """
    Whether *filename* should be treated as enabled for listing/querying,
    based on ``datasources.yaml`` loaded in Settings.
    """
    if config_map is None:
        config_map = build_parquet_config_map()

    if filename in config_map:
        return bool(config_map[filename].get("enabled", False))

    stem = Path(filename).stem
    if stem.endswith("_distinct"):
        base_name = stem[: -len("_distinct")] + ".parquet"
        if base_name in config_map:
            return bool(config_map[base_name].get("enabled", False))

    enabled_by_id = _source_enabled_by_id()
    for sid in sorted(enabled_by_id.keys(), key=len, reverse=True):
        if filename == f"{sid}.parquet" or filename.startswith(f"{sid}_"):
            return enabled_by_id[sid]

    return False


def list_enabled_parquet_filenames(cache_dir: Path) -> List[str]:
    """Sorted parquet basenames under *cache_dir* whose datasource is enabled."""
    if not cache_dir.is_dir():
        return []
    cm = build_parquet_config_map()
    names: List[str] = []
    for path in sorted(cache_dir.glob("*.parquet")):
        if parquet_file_is_enabled(path.name, cm):
            names.append(path.name)
    return names
