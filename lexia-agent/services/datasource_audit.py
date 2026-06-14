"""Datasource alignment audit + safe pruning.

Cross-references the three things that describe a Brikz data source and must stay
in sync:
  • ``config/datasources.yaml``         — declared sources (connections + tables)
  • ``data/classes/dtos/<slug>_dto.py`` — column schema (DTO) per source
  • ``data/parquet/*.parquet``          — cached data files

It reports orphans/mismatches and can safely delete orphan files. Orphan
detection is deliberately CONSERVATIVE — a parquet is flagged only when NOTHING
references it (no DTO, no datasource, no SKILL.md, no CTE graph) — so the analyser
never proposes deleting a file that is actually in use.

Backed by the ``audit_datasources`` / ``prune_datasource_file`` /
``remove_datasource_entry`` MCP tools used by the admin Data-page chat analyser.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Dict, List

# services/ sits directly under the agent root (/app), so parents[1] == root.
_ROOT = Path(__file__).resolve().parents[1]
_DATASOURCES_YAML = _ROOT / "config" / "datasources.yaml"
_PARQUET_DIR = _ROOT / "data" / "parquet"
_DTO_DIR = _ROOT / "data" / "classes" / "dtos"
_SKILLS_DIR = _ROOT / "prompts" / "skills"
_CTE_GRAPH_DIR = _ROOT / "data" / "cte_graphs"

# Connection-type sources are remote (no local parquet/DTO is expected for them).
_CONNECTION_TYPES = {"oracle", "minio", "sqlserver", "mssql", "postgres", "supabase"}

# Files we are allowed to delete, by parent directory. Anything else is refused.
_PRUNABLE_DIRS = [_PARQUET_DIR, _DTO_DIR]


# ── helpers ──────────────────────────────────────────────────────────────────


def _load_yaml_sources() -> List[Dict[str, Any]]:
    import yaml

    if not _DATASOURCES_YAML.exists():
        return []
    data = yaml.safe_load(_DATASOURCES_YAML.read_text(encoding="utf-8")) or {}
    return list(data.get("data_sources") or [])


def _list_dtos() -> List[str]:
    if not _DTO_DIR.exists():
        return []
    return sorted(p.stem for p in _DTO_DIR.glob("*_dto.py"))


def _dto_slug(stem: str) -> str:
    return stem[:-4] if stem.endswith("_dto") else stem


def _list_parquet() -> List[str]:
    if not _PARQUET_DIR.exists():
        return []
    return sorted(p.name for p in _PARQUET_DIR.glob("*.parquet"))


def _parquet_base(name: str) -> str:
    """``oracle_env_ca_view_data.parquet`` → ``oracle_env_ca_view``."""
    stem = name[: -len(".parquet")] if name.endswith(".parquet") else name
    for suffix in ("_data", "_embeddings"):
        if stem.endswith(suffix):
            return stem[: -len(suffix)]
    return stem


def _skill_refs(name: str, base: str) -> List[str]:
    """SKILL.md files that mention this parquet file (by name or base slug)."""
    refs: List[str] = []
    if not _SKILLS_DIR.exists():
        return refs
    for skill_md in _SKILLS_DIR.glob("*/SKILL.md"):
        try:
            txt = skill_md.read_text(encoding="utf-8")
        except Exception:
            continue
        if name in txt or base in txt:
            refs.append(f"skill:{skill_md.parent.name}")
    return refs


def _cte_graph_refs(name: str, base: str) -> List[str]:
    """CTE graphs whose metadata points at this parquet (best-effort, safe)."""
    refs: List[str] = []
    if not _CTE_GRAPH_DIR.exists():
        return refs
    import pickle

    for pkl in _CTE_GRAPH_DIR.glob("*.pkl"):
        if pkl.stem.startswith("_backup"):
            continue
        try:
            with open(pkl, "rb") as fh:
                graph = pickle.load(fh)
            meta = getattr(graph, "graph", {}) or {}
            src = str(meta.get("parquet_source", ""))
            if name in src or (base and base in src):
                refs.append(f"cte_graph:{pkl.stem}")
        except Exception:
            continue
    return refs


# ── public API ───────────────────────────────────────────────────────────────


def audit_datasources() -> Dict[str, Any]:
    """Report alignment between datasources.yaml ⨯ DTO classes ⨯ parquet files."""
    sources = _load_yaml_sources()
    dtos = _list_dtos()
    parquet = _list_parquet()

    source_ids = [str(s.get("source_id")) for s in sources if s.get("source_id")]
    dto_slugs = {_dto_slug(d) for d in dtos}

    def _match_source(base: str) -> str | None:
        for sid in source_ids:
            if base == sid or base.startswith(sid + "_") or sid in base:
                return sid
        return None

    def _match_dto(base: str) -> str | None:
        for d in dtos:
            slug = _dto_slug(d)
            if slug == base or slug in base or base in slug:
                return d
        return None

    parquet_info: List[Dict[str, Any]] = []
    orphan_parquet: List[str] = []
    for name in parquet:
        base = _parquet_base(name)
        matched_dto = _match_dto(base)
        matched_source = _match_source(base)
        refs = _skill_refs(name, base) + _cte_graph_refs(name, base)
        referenced = bool(matched_dto or matched_source or refs)
        try:
            size = (_PARQUET_DIR / name).stat().st_size
        except OSError:
            size = None
        info = {
            "file": name,
            "path": f"data/parquet/{name}",
            "base": base,
            "size_bytes": size,
            "matched_dto": matched_dto,
            "matched_source": matched_source,
            "referenced_by": refs,
            "orphan": not referenced,
        }
        parquet_info.append(info)
        if not referenced:
            orphan_parquet.append(f"data/parquet/{name}")

    # Orphan DTO: a schema with no parquet cache and no datasource entry.
    orphan_dto: List[str] = []
    for d in dtos:
        slug = _dto_slug(d)
        has_parquet = any(slug == _parquet_base(n) or slug in _parquet_base(n) for n in parquet)
        has_source = _match_source(slug) is not None
        if not has_parquet and not has_source:
            orphan_dto.append(f"data/classes/dtos/{d}.py")

    # Missing parquet: a FILE source (csv/xlsx/qvd…) with no cached parquet yet.
    missing_parquet: List[Dict[str, Any]] = []
    for s in sources:
        stype = str(s.get("type", "")).lower()
        sid = str(s.get("source_id") or "")
        if not sid or stype in _CONNECTION_TYPES:
            continue
        if not any(n.startswith(sid) for n in parquet):
            missing_parquet.append({"source_id": sid, "type": stype, "expected_prefix": f"{sid}_*.parquet"})

    datasources = [
        {
            "source_id": s.get("source_id"),
            "type": s.get("type"),
            "enabled": s.get("enabled"),
            "is_connection": str(s.get("type", "")).lower() in _CONNECTION_TYPES,
            "table_count": len(s.get("tables") or []),
        }
        for s in sources
    ]

    aligned = not (orphan_parquet or orphan_dto or missing_parquet)
    return {
        "aligned": aligned,
        "datasources": datasources,
        "dtos": dtos,
        "parquet_files": parquet_info,
        "findings": {
            "orphan_parquet": orphan_parquet,
            "orphan_dto": orphan_dto,
            "missing_parquet": missing_parquet,
        },
        "summary": {
            "datasource_count": len(sources),
            "dto_count": len(dtos),
            "parquet_count": len(parquet),
            "orphan_parquet": len(orphan_parquet),
            "orphan_dto": len(orphan_dto),
            "missing_parquet": len(missing_parquet),
        },
    }


def prune_file(path: str) -> Dict[str, Any]:
    """Delete ONE file — only if it lives under data/parquet/ or data/classes/dtos/.

    Refuses any path outside those directories so the analyser can never delete
    application code or config. Idempotent: deleting an absent file succeeds.
    """
    raw = str(path or "").strip()
    if not raw:
        return {"success": False, "error": "empty path"}
    p = Path(raw)
    p = (p if p.is_absolute() else _ROOT / p).resolve()
    allowed = [d.resolve() for d in _PRUNABLE_DIRS]
    if not any(str(p) == str(d) or str(p).startswith(str(d) + os.sep) for d in allowed):
        return {
            "success": False,
            "error": f"refused: {p} is outside the prunable dirs "
            "(data/parquet, data/classes/dtos)",
        }
    if p.is_dir():
        return {"success": False, "error": f"refused: {p} is a directory"}
    if not p.exists():
        return {"success": True, "deleted": False, "note": "already absent", "path": str(p)}
    p.unlink()
    return {"success": True, "deleted": True, "path": str(p)}


def remove_source_entry(source_id: str) -> Dict[str, Any]:
    """Remove a ``data_sources`` entry (by ``source_id``) from datasources.yaml."""
    import yaml

    sid = str(source_id or "").strip()
    if not sid:
        return {"success": False, "error": "empty source_id"}
    if not _DATASOURCES_YAML.exists():
        return {"success": False, "error": "datasources.yaml not found"}
    data = yaml.safe_load(_DATASOURCES_YAML.read_text(encoding="utf-8")) or {}
    srcs = list(data.get("data_sources") or [])
    kept = [s for s in srcs if str(s.get("source_id")) != sid]
    if len(kept) == len(srcs):
        return {"success": False, "error": f"source_id not found: {sid}"}
    data["data_sources"] = kept
    _DATASOURCES_YAML.write_text(
        yaml.safe_dump(data, sort_keys=False, allow_unicode=True, default_flow_style=False),
        encoding="utf-8",
    )
    return {"success": True, "removed": sid, "remaining": [s.get("source_id") for s in kept]}
