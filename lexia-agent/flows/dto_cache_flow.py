"""
DTO KV Cache Flow — Startup flow that pre-loads all DTO modules into an
in-memory cache and builds a compact schema string for LLM prompts.

Run once at application startup via ``run_dto_cache_flow()``.  Consumers
call ``get_compact_schema(parquet_dir)`` to obtain a token-efficient
schema representation, or ``get_cached_dto(stem)`` for programmatic
access to column metadata.

Pipeline:  DTOScanNode → DTOLoadNode → DTOCacheStoreNode
"""

from __future__ import annotations

import importlib
import json
import os
import re
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

from pocketflow import Node, Flow

from monitoring.logger import get_logger

logger = get_logger(__name__)

_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_DTO_DIR = _PROJECT_ROOT / "data" / "classes" / "dtos"
_DATA_DIR = _PROJECT_ROOT / "data"


def dto_module_directory() -> Path:
    """Return the directory of ``*_dto.py`` files.

    Override with env ``LEXIA_DTO_MODULE_DIR`` (absolute or relative path) when
    the agent process cwd or install layout does not place ``data/`` next to
    the code (e.g. some containers).
    """
    raw = os.environ.get("LEXIA_DTO_MODULE_DIR", "").strip()
    if raw:
        return Path(raw).expanduser().resolve()
    return _DTO_DIR


def list_dto_stems_on_disk() -> List[str]:
    """Stems for every ``*_dto.py`` (or ``*_dto*.so`` if no .py), same as :class:`DTOScanNode`."""
    scan_dir = dto_module_directory()
    if not scan_dir.is_dir():
        logger.warning("DTO module directory not found: %s", scan_dir)
        return []

    py_files = sorted(scan_dir.glob("*_dto.py"))
    if py_files:
        return [p.stem.removesuffix("_dto") for p in py_files]

    stems: List[str] = []
    for path in sorted(scan_dir.glob("*_dto*.so")):
        raw = path.stem.split(".cpython-")[0] if ".cpython-" in path.stem else path.stem
        stems.append(raw.removesuffix("_dto"))
    return stems

# ---------------------------------------------------------------------------
# Module-level singleton caches
# ---------------------------------------------------------------------------
_DTO_KV_CACHE: Dict[str, Dict[str, Any]] = {}
_COMPACT_SCHEMA_CACHE: Dict[str, str] = {}

# Patterns used to detect casting hints in column descriptions
_TRYCAST_RE = re.compile(r"TRY_CAST|numérique stocké|caster", re.IGNORECASE)
_NOCAST_RE = re.compile(r"ne pas convertir|textuelle", re.IGNORECASE)
_SPECIAL_CHAR_RE = re.compile(r"[ °*#@/\\(){}]")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_dto_cache() -> Dict[str, Dict[str, Any]]:
    """Return the full KV cache dict (stem -> entry)."""
    return _DTO_KV_CACHE


def get_cached_dto(stem: str) -> Optional[Dict[str, Any]]:
    """Lookup a single DTO entry by its parquet stem name."""
    return _DTO_KV_CACHE.get(stem)


def get_cache_metadata(stem: str) -> Optional[Dict[str, Any]]:
    """Return the .meta.json dict for a parquet stem, or None."""
    entry = _DTO_KV_CACHE.get(stem)
    if entry:
        return entry.get("cache_metadata")
    return None


def format_selected_dto_schemas_for_prompt(stems: Sequence[str]) -> str:
    """Build a prompt section listing column contracts for the given parquet/DTO stems.

    Used by the CTE graph profile assistant and any flow that must steer the LLM
    toward ``SELECT`` shapes aligned with :class:`ColumnClass` metadata.
    """
    if not stems:
        return ""
    cache = get_dto_cache()
    blocks: List[str] = []
    for raw in stems:
        stem = str(raw).strip()
        if not stem or stem not in cache:
            continue
        entry = cache[stem]
        lines: List[str] = [f"#### `{stem}`"]
        summ = get_parquet_content_summary(stem)
        if summ:
            lines.append(f"- Aperçu cache parquet: {summ}")
        fd = (entry.get("file_description") or "").strip()
        if fd:
            lines.append(fd)
        cc = entry.get("columns_classes")
        cols = getattr(cc, "columns", None) if cc is not None else None
        if cols:
            lines.append(
                "- Colonnes (respecter les noms exacts en SQL; types indicatifs):"
            )
            for col in cols:
                cname = getattr(col, "column_name", None) or "?"
                ctype = getattr(col, "type", None) or "string"
                cat = getattr(col, "is_categorical", False)
                desc = (getattr(col, "description", None) or "").replace("\n", " ").strip()
                if len(desc) > 220:
                    desc = desc[:217] + "…"
                tag = "catégoriel" if cat else "scalaire"
                lines.append(
                    f"  - `{cname}` : **{ctype}** ({tag}) — {desc}"
                )
        else:
            mod = entry.get("module")
            if mod is not None:
                lines.append(
                    "- Colonnes: non résolues dans le cache DTO. "
                    "Vérifier que le module expose `get_columns_descriptions()` "
                    "ou équivalent, puis redémarrer l'agent."
                )
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks) if blocks else ""


def get_parquet_content_summary(stem: str) -> str:
    """Build a human-readable summary of what's in the parquet cache for *stem*."""
    meta = get_cache_metadata(stem)
    if not meta:
        # Fallback: try DTO module's own function
        entry = _DTO_KV_CACHE.get(stem)
        if entry and hasattr(entry.get("module"), "get_parquet_content_summary"):
            try:
                return entry["module"].get_parquet_content_summary()
            except Exception:
                pass
        return ""

    parts: List[str] = []
    months = meta.get("cache_window_months")
    date_col = meta.get("date_column")
    if months and date_col:
        min_d = meta.get("min_date", "?")
        max_d = meta.get("max_date", "?")
        parts.append(f"{months} mois, {date_col} de {min_d} à {max_d}")
    rows = meta.get("row_count")
    if rows is not None:
        parts.append(f"{rows:,} lignes")
    return ", ".join(parts) if parts else ""


def get_compact_schema(parquet_dir: Path) -> str:
    """Return the pre-built compact schema for a given parquet directory.

    Returns empty string if cache has not been populated yet.
    """
    return _COMPACT_SCHEMA_CACHE.get(str(parquet_dir), "")


def invalidate_cache() -> None:
    """Clear all caches (for hot-reload / test scenarios)."""
    _DTO_KV_CACHE.clear()
    _COMPACT_SCHEMA_CACHE.clear()


# ---------------------------------------------------------------------------
# Compact schema builder helpers
# ---------------------------------------------------------------------------

def _needs_quoting(col_name: str) -> bool:
    return bool(_SPECIAL_CHAR_RE.search(col_name))


def _col_display(col_name: str) -> str:
    if _needs_quoting(col_name):
        return f'"{col_name}"'
    return col_name


def _col_tags(col) -> str:
    """Produce inline compact tags from a ColumnClass."""
    parts: List[str] = []
    if col.is_categorical:
        parts.append("[CAT]")
    desc_lower = col.description.lower() if col.description else ""
    if _TRYCAST_RE.search(col.description or ""):
        parts.append("{TRY_CAST AS DOUBLE}")
    elif _NOCAST_RE.search(col.description or ""):
        parts.append("{text, no cast}")
    return " " + " ".join(parts) if parts else ""


def _build_compact_schema(parquet_dir: Path) -> str:
    """Build the compact schema string from the KV cache contents.

    For tables with a rolling-window cache, the schema includes:
    - ``[CACHE: N mois, col de X à Y, R lignes]`` when parquet exists
    - ``[LIVE_SQL(dialect, source_id, table_ref)]`` when live access is available
    For tables without cache_window metadata, just the parquet path (existing behaviour).
    """
    if not _DTO_KV_CACHE:
        return "(No data sources available)"

    sections: List[str] = []
    for stem, entry in sorted(_DTO_KV_CACHE.items()):
        parquet_path = parquet_dir / f"{stem}.parquet"
        parquet_exists = parquet_path.exists()
        columns_classes = entry.get("columns_classes")
        if not columns_classes:
            continue

        meta: Optional[Dict[str, Any]] = entry.get("cache_metadata")

        # ── header line ──────────────────────────────────────────
        if meta:
            # Table with cache metadata (SQL source with rolling window)
            if parquet_exists:
                header = f"### {stem} → read_parquet('{parquet_path}')"
            else:
                db_ref = meta.get("db_table_ref", stem)
                dialect = meta.get("dialect", "sql")
                source_id = meta.get("source_id", "unknown")
                header = f"### {stem} → LIVE_SQL({dialect}, {source_id}, {db_ref})"
        else:
            header = f"### {stem} → read_parquet('{parquet_path}')"

        # ── annotation lines ─────────────────────────────────────
        annotations: List[str] = []
        if meta:
            months = meta.get("cache_window_months")
            date_col = meta.get("date_column")
            if months and date_col and parquet_exists:
                min_d = meta.get("min_date", "?")
                max_d = meta.get("max_date", "?")
                rows = meta.get("row_count", "?")
                annotations.append(
                    f"  [CACHE: {months} mois, {date_col} de {min_d} à {max_d}, {rows} lignes]"
                )
            db_ref = meta.get("db_table_ref", "")
            dialect = meta.get("dialect")
            source_id = meta.get("source_id")
            if dialect and source_id and db_ref:
                annotations.append(
                    f"  [LIVE_SQL({dialect}, {source_id}, {db_ref}) — historique complet disponible]"
                )

        # ── column line ──────────────────────────────────────────
        col_parts: List[str] = []
        for col in columns_classes.columns:
            display = _col_display(col.column_name)
            tags = _col_tags(col)
            col_parts.append(f"{display} {col.type}{tags}")

        col_line = "  " + ", ".join(col_parts)
        block = header
        if annotations:
            block += "\n" + "\n".join(annotations)
        block += "\n" + col_line
        sections.append(block)

    return "\n\n".join(sections)


# ---------------------------------------------------------------------------
# PocketFlow Nodes
# ---------------------------------------------------------------------------

class DTOScanNode(Node):
    """Scan the DTO directory for *_dto.py (or compiled *_dto.*.so) files."""

    def prep(self, shared: Dict[str, Any]):
        return None

    def exec(self, _) -> List[Tuple[str, Path]]:
        scan_dir = dto_module_directory()
        if not scan_dir.is_dir():
            logger.warning("DTO directory not found: %s", scan_dir)
            return []

        # Prefer .py in dev; fall back to compiled .so in release builds
        py_files = sorted(scan_dir.glob("*_dto.py"))
        if py_files:
            results = [(p.stem.removesuffix("_dto"), p) for p in py_files]
        else:
            results = []
            for path in sorted(scan_dir.glob("*_dto*.so")):
                # e.g. ca_view_dto.cpython-312-x86_64-linux-gnu.so
                raw = path.stem.split(".cpython-")[0] if ".cpython-" in path.stem else path.stem
                stem = raw.removesuffix("_dto")
                results.append((stem, path))
        logger.info("[dto_cache] Scanned %d DTO files from %s", len(results), scan_dir)
        return results

    def post(self, shared, prep_res, exec_res):
        shared["dto_files"] = exec_res
        return "default"


class DTOLoadNode(Node):
    """Import each DTO module and extract column/file metadata."""

    def prep(self, shared: Dict[str, Any]):
        return shared.get("dto_files", [])

    def exec(self, dto_files: List[Tuple[str, Path]]) -> Dict[str, Dict[str, Any]]:
        data_str = str(_DATA_DIR)
        if data_str not in sys.path:
            sys.path.insert(0, data_str)

        entries: Dict[str, Dict[str, Any]] = {}
        for stem, path in dto_files:
            # For compiled .so files, strip cpython suffix from stem
            mod_stem = path.stem.split(".cpython-")[0] if ".cpython-" in path.stem else path.stem
            module_name = f"classes.dtos.{mod_stem}"
            try:
                mod = importlib.import_module(module_name)

                columns_classes = None
                if hasattr(mod, "get_columns_descriptions"):
                    columns_classes = mod.get_columns_descriptions()

                file_description = None
                if hasattr(mod, "get_file_description"):
                    file_description = mod.get_file_description()

                entries[stem] = {
                    "module": mod,
                    "columns_classes": columns_classes,
                    "file_description": file_description,
                }
                logger.debug("[dto_cache] Loaded DTO: %s", stem)
            except Exception as exc:
                logger.warning("[dto_cache] Failed to import DTO %s: %s", module_name, exc)

        return entries

    def post(self, shared, prep_res, exec_res):
        shared["dto_entries"] = exec_res
        return "default"


class DTOCacheStoreNode(Node):
    """Store loaded DTO entries into the module-level caches."""

    def prep(self, shared: Dict[str, Any]):
        return {
            "dto_entries": shared.get("dto_entries", {}),
            "parquet_dir": Path(shared.get("parquet_cache_dir", "data/parquet")),
        }

    def exec(self, prep_res: Dict[str, Any]) -> Dict[str, Any]:
        return prep_res

    def post(self, shared, prep_res, exec_res):
        global _DTO_KV_CACHE, _COMPACT_SCHEMA_CACHE

        entries = exec_res["dto_entries"]
        parquet_dir = exec_res["parquet_dir"]

        _DTO_KV_CACHE.clear()
        _DTO_KV_CACHE.update(entries)

        # Load .meta.json sidecars into cache entries
        for stem, entry in _DTO_KV_CACHE.items():
            meta_path = parquet_dir / f"{stem}.meta.json"
            if meta_path.exists():
                try:
                    entry["cache_metadata"] = json.loads(meta_path.read_text())
                    logger.debug("[dto_cache] Loaded meta for %s", stem)
                except Exception as exc:
                    logger.warning("[dto_cache] Failed to load meta %s: %s", meta_path, exc)

        compact = _build_compact_schema(parquet_dir)
        _COMPACT_SCHEMA_CACHE[str(parquet_dir)] = compact

        shared["compact_schema"] = compact
        logger.info(
            "[dto_cache] Cached %d DTOs, compact schema: %d chars",
            len(_DTO_KV_CACHE),
            len(compact),
        )
        return "default"


# ---------------------------------------------------------------------------
# Flow assembly & runner
# ---------------------------------------------------------------------------

def create_dto_cache_flow() -> Flow:
    scan = DTOScanNode()
    load = DTOLoadNode()
    store = DTOCacheStoreNode()
    scan >> load >> store
    return Flow(start=scan)


def run_dto_cache_flow(parquet_cache_dir: str | None = None) -> Dict[str, Any]:
    """Run the DTO cache flow synchronously. Call once at startup."""
    shared: Dict[str, Any] = {
        "parquet_cache_dir": parquet_cache_dir or str(_PROJECT_ROOT / "data" / "parquet"),
    }
    flow = create_dto_cache_flow()
    flow.run(shared)
    return shared
