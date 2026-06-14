"""DefinitionPersistNode — atomic write of ``definitions.yaml``.

After the agent (or bootstrap flow) has produced an in-memory
``definitions`` dict, this node:

1. Loads any pre-existing ``definitions.yaml`` from disk.
2. **Merges** the in-memory definitions onto disk, preserving:

   * top-level ``parameters`` and ``sources`` (only adding new entries),
   * any block whose ``status`` is ``live`` (i.e. a human reviewer has
     promoted it — never overwritten by drafting),
   * any block with executable SQL (inline ``sql:``, a ``cte_ref:``, or
     a non-empty ``ctes:`` list for ``mixed`` blocks) that isn't being
     re-drafted in this pass.

3. Marks blocks whose ``data-block`` marker vanished from the template
   as ``deprecated: true`` (kept for history).
4. Bumps ``version:`` and writes an append-only audit entry to
   ``definitions.history.jsonl``.
5. Performs an **atomic write** (temp file + ``os.replace``) so a
   half-written YAML can never leak.

Inputs (shared state)
─────────────────────
* ``report_definitions``   — the in-memory definitions to persist.
* ``template_id``          — used to compute the on-disk path.
* ``templates_root``       — optional absolute path; defaults to
  ``data/reporting/templates``.
* ``draft_reports``        — optional, embedded in audit log entry.
* ``agent_note``           — optional, free-form note recorded in the
  audit log so the UI can show *why* a version was written (e.g.
  ``"agent.set_block pnl_score_card_global"``).
* ``actor``                — optional source string (``"bootstrap"``,
  ``"edit-agent"``, ``"manual"``).  Defaults to ``"bootstrap"`` for
  the merge mode and ``"edit-agent"`` for the replace mode.
* ``persist_mode``         — ``"merge"`` (default — bootstrap semantic)
  or ``"replace"``.  In replace mode the in-memory ``blocks`` list is
  treated as the desired final state and is written verbatim (after the
  version bump + audit log).  This is the path used by the report-edit
  agent — every agent update has already loaded the current state, so
  any merge logic would silently swallow live-block changes.

Outputs
* ``definitions_path``     — absolute path of the written YAML.
* ``definitions_history_path`` — absolute path of the audit log.
* ``persist_summary``      — dict with counts & version info.
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from nodes.base_node import BaseNode


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"


# ── Helpers ────────────────────────────────────────────────────────────────


def _atomic_write_yaml(path: Path, payload: Dict[str, Any]) -> None:
    """Write *payload* as YAML to *path* atomically (tmp → replace)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_path = tempfile.mkstemp(
        prefix=path.name + ".",
        suffix=".tmp",
        dir=str(path.parent),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            yaml.safe_dump(
                payload,
                fh,
                allow_unicode=True,
                sort_keys=False,
                width=100,
            )
        os.replace(tmp_path, path)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise


def _append_history(path: Path, entry: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _index_by_id(items: List[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    return {it["id"]: it for it in items if isinstance(it, dict) and it.get("id")}


def _load_existing(path: Path) -> Dict[str, Any]:
    if not path.is_file():
        return {}
    try:
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        logger.warning("could not parse existing %s: %s", path, e)
        return {}


def _merge_top_level_lists(
    existing: List[Dict[str, Any]], drafted: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Merge two lists of ``{id: …, …}`` dicts.  New entries from drafted
    are appended; entries with the same id keep the existing version."""
    by_id = _index_by_id(existing)
    out: List[Dict[str, Any]] = list(existing)
    for item in drafted:
        if not isinstance(item, dict):
            continue
        iid = item.get("id")
        if not iid:
            continue
        if iid in by_id:
            continue
        out.append(item)
    return out


def _block_has_executable_sql(b: Dict[str, Any]) -> bool:
    """A block carries executable SQL iff it provides one of:

    * a non-empty inline ``sql:`` string, or
    * a ``cte_ref:`` to a row in the block-CTE library, or
    * a non-empty ``ctes:`` list (``mixed`` blocks).
    """
    if (b.get("sql") or "").strip():
        return True
    if b.get("cte_ref"):
        return True
    ctes = b.get("ctes")
    if isinstance(ctes, list) and ctes:
        return True
    return False


def _merge_blocks(
    existing_blocks: List[Dict[str, Any]],
    drafted_blocks:  List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Merge blocks with these rules:

    * **drafted** is the new desired state (from the bootstrap pass or
      a per-block re-draft).
    * For each existing block:
        - if the same id appears in drafted *and* existing.status == 'live',
          the existing version is kept (human-acked, never re-drafted);
        - if the same id appears in drafted *and* existing has executable
          SQL but drafted is invalid (or empty), keep existing;
        - otherwise the drafted version wins.
    * Existing blocks whose id is NOT in drafted are kept and marked
      ``deprecated: true`` (the ``data-block`` was removed from the HTML).
    """
    existing_by_id = _index_by_id(existing_blocks)

    out: List[Dict[str, Any]] = []
    seen_ids: set = set()

    for b in drafted_blocks:
        bid = b.get("id")
        if not bid:
            continue
        seen_ids.add(bid)
        existing = existing_by_id.get(bid)
        if existing is None:
            out.append(b)
            continue
        existing_status = (existing.get("status") or "").lower()
        drafted_status  = (b.get("status") or "").lower()

        if existing_status == "live":
            out.append(existing)
            continue
        if (
            _block_has_executable_sql(existing)
            and (drafted_status == "invalid" or not _block_has_executable_sql(b))
        ):
            out.append(existing)
            continue
        out.append(b)

    for bid, eb in existing_by_id.items():
        if bid in seen_ids:
            continue
        deprecated = dict(eb)
        deprecated["deprecated"] = True
        deprecated.setdefault("status", "deprecated")
        out.append(deprecated)

    return out


# ── Node ───────────────────────────────────────────────────────────────────


class DefinitionPersistNode(BaseNode):
    """Atomically persist (and version) ``definitions.yaml``."""

    def __init__(
        self,
        name: Optional[str] = None,
        templates_root: Optional[Path] = None,
    ):
        super().__init__(name or "DefinitionPersist")
        self._templates_root = templates_root or _DEFAULT_TEMPLATES_ROOT

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        defs = shared.get("report_definitions")
        if not defs:
            raise ValueError(
                "DefinitionPersistNode requires 'report_definitions' in shared "
                "state (run BlockDraftNode first)"
            )
        template_id = defs.get("template_id") or shared.get("template_id")
        if not template_id:
            raise ValueError("template_id missing from definitions and shared state")

        templates_root_raw = shared.get("templates_root")
        templates_root = (
            Path(templates_root_raw) if templates_root_raw else self._templates_root
        )
        target_dir = templates_root / template_id
        mode = (shared.get("persist_mode") or "merge").lower()
        if mode not in ("merge", "replace"):
            raise ValueError(
                f"persist_mode must be 'merge' or 'replace', got {mode!r}"
            )
        actor = (
            shared.get("actor")
            or ("edit-agent" if mode == "replace" else "bootstrap")
        )
        return {
            "definitions":     defs,
            "template_id":     template_id,
            "definitions_path": target_dir / "definitions.yaml",
            "history_path":     target_dir / "definitions.history.jsonl",
            "draft_reports":   shared.get("draft_reports") or [],
            "persist_mode":    mode,
            "agent_note":      shared.get("agent_note"),
            "actor":           actor,
        }

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        defs:             Dict[str, Any] = prep_result["definitions"]
        path:             Path           = prep_result["definitions_path"]
        history:          Path           = prep_result["history_path"]
        mode:             str            = prep_result["persist_mode"]

        existing = _load_existing(path)
        existing_version = int(existing.get("version") or 0)

        if mode == "replace":
            merged_blocks     = list(defs.get("blocks") or [])
            merged_parameters = list(defs.get("parameters") or [])
            merged_sources    = list(defs.get("sources") or [])
        else:
            merged_blocks = _merge_blocks(
                existing.get("blocks") or [],
                defs.get("blocks") or [],
            )
            merged_parameters = _merge_top_level_lists(
                existing.get("parameters") or [],
                defs.get("parameters") or [],
            )
            merged_sources = _merge_top_level_lists(
                existing.get("sources") or [],
                defs.get("sources") or [],
            )

        merged: Dict[str, Any] = {
            "template_id": defs["template_id"],
            "version":     existing_version + 1,
            "parameters":  merged_parameters,
            "sources":     merged_sources,
            "blocks":      merged_blocks,
            "metadata": {
                **(existing.get("metadata") or {}),
                **(defs.get("metadata")     or {}),
                "last_persist_at": datetime.now(timezone.utc).isoformat(),
                "last_persist_mode": mode,
            },
        }

        _atomic_write_yaml(path, merged)

        deprecated_count = sum(
            1 for b in merged["blocks"] if b.get("deprecated")
        )
        invalid_count = sum(
            1 for b in merged["blocks"]
            if (b.get("status") or "").lower() == "invalid"
        )
        live_count = sum(
            1 for b in merged["blocks"]
            if (b.get("status") or "").lower() == "live"
        )

        # Audit log entry — purposely small + JSON-friendly.
        from dataclasses import asdict
        draft_reports_audit: List[Dict[str, Any]] = []
        for r in prep_result["draft_reports"] or []:
            try:
                d = asdict(r)
                d.pop("validation", None)
                d.pop("raw_response", None)
                draft_reports_audit.append(d)
            except Exception:
                continue

        entry: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "template_id":      merged["template_id"],
            "version":          merged["version"],
            "actor":            prep_result["actor"],
            "persist_mode":     prep_result["persist_mode"],
            "blocks_total":     len(merged["blocks"]),
            "blocks_invalid":   invalid_count,
            "blocks_deprecated": deprecated_count,
            "blocks_live":      live_count,
            "draft_reports":    draft_reports_audit,
        }
        note = prep_result.get("agent_note")
        if note:
            entry["note"] = str(note)
        _append_history(history, entry)

        summary = {
            "version":            merged["version"],
            "blocks_total":       len(merged["blocks"]),
            "blocks_invalid":     invalid_count,
            "blocks_deprecated":  deprecated_count,
            "blocks_live":        live_count,
            "definitions_path":   str(path),
            "history_path":       str(history),
        }
        return {
            "merged":              merged,
            "definitions_path":    str(path),
            "history_path":        str(history),
            "summary":             summary,
        }

    def post(
        self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any],
    ) -> str:
        shared["report_definitions"]      = exec_result["merged"]
        shared["definitions_path"]        = exec_result["definitions_path"]
        shared["definitions_history_path"]= exec_result["history_path"]
        shared["persist_summary"]         = exec_result["summary"]
        self.log_exit("default")
        return "default"
