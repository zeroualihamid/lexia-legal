"""Promote inline ``sql:`` on block dicts to files under ``sql/fragment_library/``.

Definitions persisted to ``definitions.yaml`` should reference CTEs via
``cte_ref:`` only — never embed raw SQL in YAML.  Call
:func:`materialize_block_inline_sql` before validate/persist (edit-agent,
CLI migration, etc.).
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Dict, List, Optional


_SAFE_REF_CHUNK = re.compile(r"[^a-zA-Z0-9_]+")


def template_sql_prefix(template_id: str) -> str:
    """Stable identifier segment for ``<prefix>__<block_id>.sql`` names."""
    tid = (template_id or "template").strip()
    return tid.replace("-", "_")


def _safe_cte_ref_fragment(s: str) -> str:
    return _SAFE_REF_CHUNK.sub("_", s).strip("_") or "x"


def _strip_block_suffix(bid: str) -> str:
    """Drop a trailing ``_block`` from an auto-generated cte_ref base.

    Block ids commonly end with ``_block`` for HTML readability; the CTE
    name shouldn't carry that boilerplate. ``total_collected_revenue_block``
    becomes ``total_collected_revenue``. Ids that don't end with ``_block``
    are returned unchanged so existing call sites are unaffected.
    """
    if bid.endswith("_block") and len(bid) > len("_block"):
        return bid[: -len("_block")]
    return bid


def materialize_block_inline_sql(
    block: Dict[str, Any],
    *,
    block_library_dir: Path,
    template_id: str,
    overwrite: bool = True,
) -> Dict[str, Any]:
    """Write inline ``sql`` to ``<library>/<ref>.sql`` and set ``cte_ref``.

    * Leaf blocks: ``<prefix>__<block_id>.sql``
    * Mixed sub-CTEs: ``<prefix>__<parent_id>__<sub_id>.sql``

    Removes ``sql`` keys from the returned dict (and from each mixed sub-CTE).
    If ``sql`` is empty/missing, leaves the block unchanged (still strips null sql).

    When ``overwrite`` is False and the target file already exists, raises
    ``FileExistsError`` (library-first workflow).
    """
    if not isinstance(block, dict):
        return block

    bdir = Path(block_library_dir)
    bdir.mkdir(parents=True, exist_ok=True)
    prefix = template_sql_prefix(template_id)
    bid = _safe_cte_ref_fragment(str(block.get("id") or "block"))
    kind = (block.get("kind") or "").strip()

    out = dict(block)

    if kind == "mixed":
        new_ctes: List[Any] = []
        for sub in out.get("ctes") or []:
            if not isinstance(sub, dict):
                new_ctes.append(sub)
                continue
            s = dict(sub)
            sql_t = (s.get("sql") or "").strip()
            cref = (s.get("cte_ref") or "").strip()
            sid = _safe_cte_ref_fragment(str(s.get("id") or "sub"))

            if sql_t:
                if cref:
                    path = bdir / f"{cref}.sql"
                else:
                    cref = f"{prefix}__{_strip_block_suffix(bid)}__{sid}"
                    path = bdir / f"{cref}.sql"
                    s["cte_ref"] = cref
                if path.exists() and not overwrite:
                    raise FileExistsError(path)
                path.write_text(sql_t + "\n", encoding="utf-8")
                s.pop("sql", None)
            else:
                s.pop("sql", None)
            new_ctes.append(s)
        out["ctes"] = new_ctes
        out.pop("sql", None)
        return out

    sql_t = (out.get("sql") or "").strip()
    cref = (out.get("cte_ref") or "").strip()

    # kind=empty was historically a no-SQL placeholder. Under the current
    # validate_block contract it must project exactly one column, so SQL is
    # required and goes through the same materialization path as other leaf
    # kinds. The only short-circuit is when there is genuinely nothing to
    # write (no sql AND no cte_ref) — drop a stray empty sql key and return.
    if not sql_t and not cref:
        out.pop("sql", None)
        return out

    if sql_t:
        if cref:
            path = bdir / f"{cref}.sql"
        else:
            cref = f"{prefix}__{_strip_block_suffix(bid)}"
            path = bdir / f"{cref}.sql"
            out["cte_ref"] = cref
        if path.exists() and not overwrite:
            raise FileExistsError(path)
        path.write_text(sql_t + "\n", encoding="utf-8")
        out.pop("sql", None)
    else:
        out.pop("sql", None)

    return out


def materialize_mixed_sub_inline_sql(
    sub: Dict[str, Any],
    *,
    parent_block_id: str,
    block_library_dir: Path,
    template_id: str,
    overwrite: bool = True,
) -> Dict[str, Any]:
    """Promote inline ``sql`` on a single mixed sub-CTE to the block library."""
    wrapped = materialize_block_inline_sql(
        {
            "id": parent_block_id,
            "kind": "mixed",
            "ctes": [dict(sub)],
        },
        block_library_dir=block_library_dir,
        template_id=template_id,
        overwrite=overwrite,
    )
    out_sub = (wrapped.get("ctes") or [sub])[0]
    return out_sub if isinstance(out_sub, dict) else sub


def materialize_all_blocks(
    blocks: List[Dict[str, Any]],
    *,
    block_library_dir: Path,
    template_id: str,
    overwrite: bool = True,
) -> List[Dict[str, Any]]:
    return [
        materialize_block_inline_sql(
            b,
            block_library_dir=block_library_dir,
            template_id=template_id,
            overwrite=overwrite,
        )
        for b in blocks
        if isinstance(b, dict)
    ]
