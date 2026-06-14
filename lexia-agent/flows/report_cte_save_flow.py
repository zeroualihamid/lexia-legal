"""report_cte_save_flow — generate and persist one block CTE from a prompt.

Pipeline (``run_report_cte_save``):
    scan template → prepare prompt/context → draft block CTE → merge block
    into definitions → validate blocks → persist definitions.yaml → write CTE
    ``.sql`` under ``data/reporting/sql/<template_id>/`` → build NetworkX graph
    via :class:`services.cte_graph.GraphBuilder` and persist with
    :class:`services.cte_graph.GraphStore` under ``data/cte_graphs/``
    (same directory as the CTE graph API).

Standalone audit SQL (``run_contrats_audit_cte_generation``):
    LLM generates PostgreSQL/MySQL-style audit CTEs using
    :data:`flows.contrats_audit_prompt.CONTRATS_AUDIT_SQL_PROMPT`, writes the
    combined script to ``insurance_audit/contrats_audit_controls.sql``, splits
    each CTE into ``insurance_audit/<slug>.sql``, refreshes
    ``insurance_audit/index.yaml`` for the reporting CTE catalog / graphe UI,
    and persists a NetworkX pickle under ``insurance_audit__contrats``.

This module exposes ``run_contrats_audit_cte_generation`` (CLI default: insurance audit SQL)
and ``run_report_cte_save`` for template block saves (API).
"""

from __future__ import annotations

import logging
import os
import re
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import yaml

from nodes.reporting.block_draft_node import BlockDraftNode
from nodes.reporting.block_validate_node import BlockValidateNode
from nodes.reporting.cte_save_finalize_node import CteSaveFinalizeNode
from nodes.reporting.cte_save_prepare_node import CteSavePrepareNode
from nodes.reporting.definition_persist_node import DefinitionPersistNode
from nodes.reporting.template_scan_node import TemplateScanNode
from nodes.reporting.sql_helpers import BlockValidationReport
from services.cte_graph.graph_builder import CycleError, GraphBuilder, ParseError
from services.cte_graph.graph_store import GraphStore
from services.cte_graph.library_graph_cache import invalidate_cte_library_graph_caches
from services.cte_graph.sql_parser import CTEDef, extract_ctes


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"
_DEFAULT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"
_DEFAULT_SAVED_CTE_SQL = _PROJECT_ROOT / "data" / "reporting" / "sql"
_DEFAULT_CTE_GRAPH_DIR = _PROJECT_ROOT / "data" / "cte_graphs"
_INSURANCE_AUDIT_SQL_DIR = _DEFAULT_SAVED_CTE_SQL / "insurance_audit"
_DEFAULT_INSURANCE_AUDIT_SQL = _INSURANCE_AUDIT_SQL_DIR / "contrats_audit_controls.sql"

_STANDALONE_AUDIT_SYSTEM = """\
Tu génères exclusivement du SQL d'audit pour la table `contrats`.
Réponds avec UN SEUL bloc markdown ```sql ... ``` contenant tout le SQL demandé.
Aucun texte hors du bloc. Commentaires SQL en français (-- ...).
Syntaxe compatible PostgreSQL et MySQL 8+.

Règles de structure obligatoires :
- Première CTE : lecture seule de `contrats` (ex. `contrats_base`).
- Chaque CTE suivante dans le WITH doit référencer **par son nom** la CTE **immédiatement précédente** dans le FROM (chaîne linéaire), jamais `contrats` à nouveau.
- Ordre des CTE = ordre des contrôles ; le graphe de dépendances doit être une chaîne (arêtes parent → enfant).
"""


def _extract_sql_fence(text: str) -> str:
    """Return SQL from a ```sql … ``` fence, or stripped raw text."""
    text = (text or "").strip()
    m = re.search(r"```(?:sql)?\s*([\s\S]*?)```", text, re.IGNORECASE)
    if m:
        return m.group(1).strip()
    return text


def _fs_slug(value: str) -> str:
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in value)
    return safe.strip("_") or "block"


def _atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _filename_for_cte_names(ctes: List[CTEDef]) -> Dict[str, str]:
    """Map CTE name → unique ``*.sql`` file name under the library folder."""
    used: set = set()
    out: Dict[str, str] = {}
    for c in ctes:
        base = _fs_slug(c.name)
        slug = base
        n = 2
        while slug in used:
            slug = f"{base}_{n}"
            n += 1
        used.add(slug)
        out[c.name] = f"{slug}.sql"
    return out


def _validate_immediate_predecessor_chain(
    cte_names: List[str],
    deps: Dict[str, List[str]],
) -> Optional[str]:
    """Return a warning if the SQL does not reference each CTE's immediate predecessor."""
    if len(cte_names) < 2:
        return None
    for i in range(1, len(cte_names)):
        prev, cur = cte_names[i - 1], cte_names[i]
        parents = deps.get(cur) or []
        if prev not in parents:
            return (
                f"Chaîne CTE incomplète : « {cur} » doit référencer la CTE précédente "
                f"« {prev} » dans son corps SQL (FROM/JOIN). Parents détectés : {parents!r}. "
                "Sans cela le graphe n'a pas d'arêtes entre CTEs."
            )
    return None


def write_linear_cte_catalog(
    sql_text: str,
    library_dir: Path,
    *,
    dialect: str,
    descriptions: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    """Split a single ``WITH`` script into one ``.sql`` per CTE + ``index.yaml`` under *library_dir*.

    *descriptions* maps CTE name → catalog description; missing names get a generic label.
    """
    payload: Dict[str, Any] = {
        "ok": False,
        "cte_count": 0,
        "index_yaml_path": None,
        "cte_sql_paths": [],
        "error": None,
    }
    try:
        ctes, deps = extract_ctes(sql_text, dialect=dialect)
    except ValueError as e:
        payload["error"] = str(e)
        return payload

    if not ctes:
        payload["error"] = "no CTEs extracted"
        return payload

    desc_map = descriptions or {}
    library_dir.mkdir(parents=True, exist_ok=True)
    name_to_file = _filename_for_cte_names(ctes)

    entries: List[Dict[str, Any]] = []
    paths: List[str] = []
    for c in ctes:
        fname = name_to_file[c.name]
        path = library_dir / fname
        blurb = (desc_map.get(c.name) or "").strip() or f"Étape « {c.name} » (chaîne CTE)."
        body = (
            f"-- CTE — {c.name}\n"
            f"-- Catalogue reporting (généré)\n\n"
            f"{c.name} AS (\n{c.raw_sql}\n)\n"
        )
        _atomic_write_text(path, body)
        paths.append(str(path))
        entries.append({
            "name": c.name,
            "description": blurb,
            "file": fname,
            "depends_on": list(deps.get(c.name, [])),
        })

    index_path = library_dir / "index.yaml"
    index_yaml = yaml.safe_dump(
        {"version": 1, "ctes": entries},
        allow_unicode=True,
        sort_keys=False,
        width=120,
    )
    _atomic_write_text(index_path, index_yaml)

    payload["ok"] = True
    payload["cte_count"] = len(ctes)
    payload["index_yaml_path"] = str(index_path)
    payload["cte_sql_paths"] = paths
    payload["cte_names"] = [c.name for c in ctes]
    payload["deps"] = {k: list(v) for k, v in deps.items()}
    return payload


def _write_insurance_audit_cte_library(sql_text: str, *, dialect: str) -> Dict[str, Any]:
    """Emit one SQL file per CTE and ``index.yaml`` for :func:`load_library` / UI graphe."""
    desc: Dict[str, str] = {}
    if (sql_text or "").strip():
        try:
            ctes, _ = extract_ctes(sql_text, dialect=dialect)
            desc = {
                c.name: f"Contrôle audit — {c.name} (table contrats)."
                for c in ctes
            }
        except ValueError:
            pass
    return write_linear_cte_catalog(
        sql_text,
        _INSURANCE_AUDIT_SQL_DIR,
        dialect=dialect,
        descriptions=desc or None,
    )


def _primary_inline_sql(block: Dict[str, Any]) -> str:
    """SQL string used for GraphBuilder (single statement with ``WITH`` when applicable)."""
    return (block.get("sql") or "").strip()


def _format_saved_cte_sql(template_id: str, block: Dict[str, Any]) -> str:
    """Full artifact written to disk (header + inline SQL or expanded mixed ``ctes``)."""
    bid = block.get("id") or "unknown"
    header = (
        f"-- template_id: {template_id}\n"
        f"-- block_id: {bid}\n"
        f"-- saved by report_cte_save_flow\n\n"
    )
    body = _primary_inline_sql(block)
    if body:
        return header + body
    lines = [header.rstrip(), ""]
    ctes = block.get("ctes")
    if isinstance(ctes, list):
        for sub in ctes:
            if not isinstance(sub, dict):
                continue
            sid = sub.get("id") or "sub"
            sq = (sub.get("sql") or "").strip()
            lines.append(f"-- sub-CTE: {sid}")
            lines.append(sq if sq else "-- (empty)")
            lines.append("")
    return "\n".join(lines)


def _drafted_block_validation_ok(
    reports: List[BlockValidationReport], block_id: str
) -> bool:
    for r in reports:
        if r.block_id == block_id:
            return r.ok
    return False


def save_cte_sql_and_graph(
    *,
    template_id: str,
    block_id: str,
    block: Dict[str, Any],
    sql_root: Path,
    graph_store_dir: Path,
    dialect: str = "duckdb",
) -> Dict[str, Any]:
    """Write ``{template}/{block}.sql`` and persist a NetworkX DiGraph for inline SQL."""
    tid = _fs_slug(template_id)
    bid = _fs_slug(block_id)
    rel_dir = Path(tid)
    sql_path = sql_root / rel_dir / f"{bid}.sql"
    text = _format_saved_cte_sql(template_id, block)
    _atomic_write_text(sql_path, text)

    out: Dict[str, Any] = {
        "cte_sql_path": str(sql_path),
        "graph_id": None,
        "graph_stats": None,
        "graph_error": None,
    }

    inline = _primary_inline_sql(block)
    if not inline:
        out["graph_error"] = "no inline sql on block; skipped NetworkX build (see mixed ctes in .sql file)"
        return out

    builder = GraphBuilder()
    try:
        graph = builder.build(inline, dialect=dialect)
    except (ParseError, CycleError, ValueError) as e:
        out["graph_error"] = str(e)
        logger.warning("CTE graph build skipped for %s/%s: %s", template_id, block_id, e)
        return out

    store = GraphStore(graph_store_dir)
    gid = f"{tid}__{bid}"
    store.put(graph, graph_id=gid)
    out["graph_id"] = gid
    out["graph_stats"] = GraphBuilder.stats(graph)
    return out


def run_contrats_audit_cte_generation() -> Dict[str, Any]:
    """Emit standalone audit CTEs via LLM using ``CONTRATS_AUDIT_SQL_PROMPT``.

    Writes the combined script to ``insurance_audit/contrats_audit_controls.sql``,
    one ``.sql`` per CTE plus ``insurance_audit/index.yaml`` for the reporting
    catalog, invalidates in-process library caches, and stores a graph pickle as
    ``insurance_audit__contrats`` for direct API fetch. The UI profile
    **Audit assurance — contrats** (library ``insurance_audit``) rebuilds the
    same graph from disk via *Recharger le graphe actif*.
    """
    from config import get_settings
    from flows.contrats_audit_prompt import CONTRATS_AUDIT_SQL_PROMPT
    from llm.llm_factory import get_llm

    t0 = time.perf_counter()
    out_path = _DEFAULT_INSURANCE_AUDIT_SQL
    graph_dir = _DEFAULT_CTE_GRAPH_DIR
    graph_dialect = "postgres"

    try:
        settings = get_settings()
        client, _ = get_llm()
        cfg_mt = int(getattr(settings, "llm_max_tokens", 4096))
        mt = max(cfg_mt, 8192)
        response = client.chat.completions.create(
            model=settings.llm.model,
            messages=[
                {"role": "system", "content": _STANDALONE_AUDIT_SYSTEM},
                {"role": "user", "content": CONTRATS_AUDIT_SQL_PROMPT},
            ],
            temperature=0.1,
            max_tokens=mt,
        )
        raw = (response.choices[0].message.content or "").strip()
    except Exception as e:
        logger.exception("contrats audit LLM call failed")
        return {
            "success": False,
            "mode": "contrats_audit_sql",
            "error": str(e),
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }

    sql_text = _extract_sql_fence(raw)
    if not sql_text.strip():
        return {
            "success": False,
            "mode": "contrats_audit_sql",
            "error": "empty SQL after LLM response",
            "raw_response_preview": raw[:2000],
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }

    _atomic_write_text(out_path, sql_text)

    lib_info = _write_insurance_audit_cte_library(sql_text, dialect=graph_dialect)

    result: Dict[str, Any] = {
        "success": True,
        "mode": "contrats_audit_sql",
        "cte_sql_path": str(out_path),
        "insurance_audit_cte_count": lib_info.get("cte_count", 0),
        "insurance_audit_index_yaml": lib_info.get("index_yaml_path"),
        "insurance_audit_cte_sql_paths": lib_info.get("cte_sql_paths") or [],
        "insurance_audit_library_error": lib_info.get("error"),
        "insurance_audit_catalog_validate_error": None,
        "cte_graph_id": None,
        "cte_graph_stats": None,
        "cte_graph_error": None,
        "duration_ms": 0.0,
    }

    result["insurance_audit_chain_warning"] = _validate_immediate_predecessor_chain(
        lib_info.get("cte_names") or [],
        lib_info.get("deps") or {},
    )
    if result["insurance_audit_chain_warning"]:
        logger.warning("%s", result["insurance_audit_chain_warning"])

    if lib_info.get("ok"):
        try:
            from services.cte_graph.library_loader import LibraryError, load_library

            load_library(_DEFAULT_SAVED_CTE_SQL, libraries=["insurance_audit"])
        except LibraryError as e:
            result["insurance_audit_catalog_validate_error"] = str(e)
            logger.warning("insurance_audit catalog validation failed: %s", e)
        else:
            invalidate_cte_library_graph_caches()

    builder = GraphBuilder()
    try:
        graph = builder.build(sql_text, dialect=graph_dialect)
    except (ParseError, CycleError, ValueError) as e:
        result["cte_graph_error"] = str(e)
        logger.warning("contrats audit CTE graph build skipped: %s", e)
        result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
        return result

    store = GraphStore(graph_dir)
    gid = "insurance_audit__contrats"
    store.put(graph, graph_id=gid)
    result["cte_graph_id"] = gid
    result["cte_graph_stats"] = GraphBuilder.stats(graph)
    result["duration_ms"] = round((time.perf_counter() - t0) * 1000.0, 1)
    return result


def create_report_cte_save_flow() -> Dict[str, str]:
    """Return a sentinel describing the prompt → CTE save workflow."""
    return {
        "name": "report_cte_save_flow",
        "kind": "manual_orchestration",
        "description": (
            "TemplateScanNode → CteSavePrepareNode → BlockDraftNode → "
            "CteSaveFinalizeNode → BlockValidateNode → DefinitionPersistNode → "
            "save_cte_sql_and_graph (sql + NetworkX pickle)"
        ),
        "entrypoint": "run_report_cte_save",
    }


def run_report_cte_save(
    *,
    template_id: str,
    block_id: str,
    prompt: str,
    templates_root: Optional[Path] = None,
    library_dir: Optional[Path] = None,
    block_library_dir: Optional[Path] = None,
    parquet_cache_dir: Optional[str] = None,
    max_retries: int = 2,
    sql_output_root: Optional[Path] = None,
    cte_graph_store_dir: Optional[Path] = None,
    strict_validate_all_blocks: bool = False,
) -> Dict[str, Any]:
    """Generate a block CTE from *prompt*, validate it, and persist it."""
    t0 = time.perf_counter()
    templates_root = templates_root or _TEMPLATES_ROOT
    library_dir = library_dir or (_DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None)
    block_library_dir = block_library_dir or (
        _DEFAULT_FRAGMENT_LIBRARY if _DEFAULT_FRAGMENT_LIBRARY.is_dir() else None
    )

    shared: Dict[str, Any] = {
        "template_id": template_id,
        "block_id": block_id,
        "cte_prompt": prompt,
        "templates_root": str(templates_root),
        "accounting_library_dir": str(library_dir) if library_dir else None,
        "block_library_dir": str(block_library_dir) if block_library_dir else None,
        "persist_mode": "replace",
        "actor": "manual-save-cte",
        "agent_note": f"save_cte_flow {block_id}",
    }
    if parquet_cache_dir:
        shared["parquet_cache_dir"] = parquet_cache_dir

    template_html_path = Path(templates_root) / template_id / "report-template.html"
    if not template_html_path.is_file():
        return {
            "success": False,
            "template_id": template_id,
            "block_id": block_id,
            "error": f"Template HTML not found: {template_html_path}",
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }
    shared["template_path"] = str(template_html_path)

    TemplateScanNode().run(shared)
    CteSavePrepareNode().run(shared)
    BlockDraftNode(max_retries=max_retries).run(shared)

    draft_report = shared.get("draft_report")
    if getattr(draft_report, "ok", False) is not True:
        error = getattr(draft_report, "error", None) or "CTE draft failed"
        return {
            "success": False,
            "template_id": template_id,
            "block_id": block_id,
            "error": error,
            "draft_report": draft_report,
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }

    CteSaveFinalizeNode().run(shared)
    validation_action = BlockValidateNode(strict=strict_validate_all_blocks).run(shared)
    reports = shared.get("block_validation_reports") or []
    if not _drafted_block_validation_ok(reports, block_id):
        summary = shared.get("block_validation_summary") or {}
        return {
            "success": False,
            "template_id": template_id,
            "block_id": block_id,
            "error": "drafted block validation failed",
            "draft_report": draft_report,
            "validation_summary": summary,
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }
    if validation_action == "invalid":
        summary = shared.get("block_validation_summary") or {}
        return {
            "success": False,
            "template_id": template_id,
            "block_id": block_id,
            "error": "validation failed (other blocks)",
            "draft_report": draft_report,
            "validation_summary": summary,
            "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
        }

    DefinitionPersistNode().run(shared)
    persist_summary = shared.get("persist_summary") or {}
    drafted_block = shared.get("drafted_block") or {}
    validation_summary = shared.get("block_validation_summary") or {}

    sql_root = sql_output_root or _DEFAULT_SAVED_CTE_SQL
    graph_dir = cte_graph_store_dir or _DEFAULT_CTE_GRAPH_DIR
    cte_artifacts = save_cte_sql_and_graph(
        template_id=template_id,
        block_id=block_id,
        block=drafted_block,
        sql_root=sql_root,
        graph_store_dir=graph_dir,
    )

    return {
        "success": True,
        "template_id": template_id,
        "block_id": block_id,
        "action": shared.get("save_cte_action") or "updated",
        "block": drafted_block,
        "persist_summary": persist_summary,
        "validation_summary": validation_summary,
        "cte_sql_path": cte_artifacts.get("cte_sql_path"),
        "cte_graph_id": cte_artifacts.get("graph_id"),
        "cte_graph_stats": cte_artifacts.get("graph_stats"),
        "cte_graph_error": cte_artifacts.get("graph_error"),
        "duration_ms": round((time.perf_counter() - t0) * 1000.0, 1),
    }



if __name__ == "__main__":
    import json

    print(json.dumps(run_contrats_audit_cte_generation(), default=str, indent=2))