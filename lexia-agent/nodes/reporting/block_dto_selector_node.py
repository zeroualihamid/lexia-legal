"""BlockDtoSelectorNode — pick the right DTO/parquet for a single block.

Drafting a CTE for a ``<div data-block="...">`` requires answering one
question first: *which DTO carries the columns this block must read?*  This
node scores every entry in :func:`flows.dto_cache_flow.get_dto_cache` (or,
when the cache is unpopulated, the entries listed in ``datasources.yaml``)
against the block's HTML excerpt + tokens + goal, and returns a single
``dto_<stem>`` choice.

Selection precedence
────────────────────
1. **Hint** — if the block's HTML carries ``data-source="<stem>"``, that
   wins outright (provided the stem exists). Operators use this when the
   intent is unambiguous.
2. **Embedding score** — cosine similarity between an LLM-friendly
   "block bag" (tokens split into words, HTML excerpt, goal) and a
   "DTO bag" (column names + descriptions + file_description + stem).
   Reuses :func:`services.embedding_model_provider.get_embedding_model`
   so the model loaded at startup is shared.
3. **LLM tiebreak** — when the top-1 / top-2 margin is below
   ``_LLM_TIE_MARGIN`` the node sends a small prompt to the agent LLM
   ("which of these DTOs fits this block?") and uses the answer.

Failure mode: if the embedding model isn't available *and* the LLM call
fails, the node returns the highest-scored DTO (or ``None`` if no DTOs
exist) and surfaces a warning event — bootstrap never crashes on this.

Inputs (``shared``)
* ``block_id``                — required.
* ``template_scan_obj``       — :class:`ScanResult` from TemplateScanNode.
* ``block_goal`` / ``existing_block`` — optional, used as extra context.

Outputs
* ``block_dto``  — dict ``{stem, dto_cte, columns, file_description,
  parquet_path, score, source}`` or ``None`` if nothing matched.
* ``block_dto_report`` — diagnostics (top-3 candidates, scores, margins).
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from nodes.base_node import BaseNode
from nodes.reporting.dto_source_generator import (
    _columns_from_dto,
    _dto_stem_from_parquet_stem,
    _load_datasource_entries,
    _resolve_dto_function,
)
from nodes.reporting.template_scan_node import BlockDescriptor, ScanResult


logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
_DEFAULT_DATASOURCES = _PROJECT_ROOT / "config" / "datasources.yaml"

_LLM_TIE_MARGIN = 0.05
_HINT_RE = re.compile(r'data-source\s*=\s*"([^"\s]+)"', re.IGNORECASE)
_WORD_SPLIT = re.compile(r"[_\-\s]+")


# Cached DTO bags (built once per process, since the DTO list rarely changes
# at runtime and embedding the bags is the slow part).
_DTO_BAG_CACHE: List[Dict[str, Any]] = []
_DTO_BAG_VECTORS: Optional[Any] = None


def _split_tokens(text: str) -> str:
    """Lower-case + split snake/kebab/CamelCase tokens into words.

    Helps the embedding model match ``CA_ENCAISSE_TOTAL`` against a DTO
    column described as "Chiffre d'affaires encaissé".
    """
    if not text:
        return ""
    s = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)
    s = _WORD_SPLIT.sub(" ", s)
    return s.lower().strip()


def _block_bag(descriptor: BlockDescriptor, goal: str) -> str:
    parts: List[str] = []
    parts.append(descriptor.name)
    if goal:
        parts.append(goal.strip())
    if descriptor.inner_scalars:
        parts.append(" ".join(_split_tokens(t) for t in descriptor.inner_scalars))
    if descriptor.inner_sections:
        parts.append(" ".join(_split_tokens(s) for s in descriptor.inner_sections))
    if descriptor.html_excerpt:
        excerpt = re.sub(r"<[^>]+>", " ", descriptor.html_excerpt)[:600]
        parts.append(_split_tokens(excerpt))
    return " | ".join(p for p in parts if p)


def _dto_bag(entry: Dict[str, Any]) -> str:
    parts: List[str] = [entry.get("stem", "")]
    desc = (entry.get("description") or "").strip()
    if desc:
        parts.append(desc[:600])
    cols = entry.get("columns") or []
    cols_repr = ", ".join(
        f"{c['column_name']} ({c.get('description','')})"[:160]
        for c in cols[:40]
    )
    if cols_repr:
        parts.append(cols_repr)
    return " | ".join(p for p in parts if p)


def _build_dto_inventory() -> List[Dict[str, Any]]:
    """Return one entry per DTO/parquet pair, regardless of cache state."""
    entries = _load_datasource_entries(_DEFAULT_DATASOURCES)
    out: List[Dict[str, Any]] = []
    for e in entries:
        stem = e.get("source_id") or ""
        if not stem:
            continue
        path = e.get("path")
        if not path:
            continue
        path_resolved = Path(path)
        if not path_resolved.is_absolute():
            path_resolved = (_PROJECT_ROOT / path).resolve()
        if not path_resolved.is_file():
            # Skip DTOs whose parquet hasn't materialised yet.
            continue
        cc = _resolve_dto_function(e.get("columns_class"))
        cols = _columns_from_dto(cc)
        if not cols:
            continue
        out.append({
            "stem": stem,
            "dto_cte": _dto_stem_from_parquet_stem(stem),
            "parquet_path": str(path_resolved),
            "description": e.get("description") or "",
            "columns": cols,
            "columns_class": e.get("columns_class"),
        })
    return out


def _embed(texts: List[str]) -> Optional[Any]:
    try:
        from services.embedding_model_provider import get_embedding_model
        import numpy as np
        model = get_embedding_model()
        vecs = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
        return np.asarray(vecs, dtype="float32")
    except Exception as exc:
        logger.warning("BlockDtoSelectorNode: embedding step unavailable — %s", exc)
        return None


def _ensure_dto_vectors(inventory: List[Dict[str, Any]]) -> Optional[Any]:
    global _DTO_BAG_CACHE, _DTO_BAG_VECTORS
    if _DTO_BAG_VECTORS is not None and len(_DTO_BAG_CACHE) == len(inventory):
        cached_stems = [e["stem"] for e in _DTO_BAG_CACHE]
        new_stems = [e["stem"] for e in inventory]
        if cached_stems == new_stems:
            return _DTO_BAG_VECTORS
    bags = [_dto_bag(e) for e in inventory]
    vecs = _embed(bags)
    if vecs is None:
        return None
    _DTO_BAG_CACHE = list(inventory)
    _DTO_BAG_VECTORS = vecs
    return vecs


def _score(block_text: str, dto_vectors: Any) -> Optional[Any]:
    import numpy as np
    block_vec = _embed([block_text])
    if block_vec is None:
        return None
    return (dto_vectors @ block_vec[0]).astype("float32")


def _llm_tiebreak(
    block_descriptor: BlockDescriptor,
    goal: str,
    candidates: List[Dict[str, Any]],
) -> Optional[str]:
    try:
        from llm.llm_factory import create_client_for_task
    except Exception as exc:
        logger.debug("BlockDtoSelectorNode: LLM factory unavailable — %s", exc)
        return None
    try:
        llm = create_client_for_task("agent")
    except Exception as exc:
        logger.debug("BlockDtoSelectorNode: cannot create LLM client — %s", exc)
        return None

    cand_lines: List[str] = []
    for c in candidates:
        col_summary = ", ".join(
            f"{x['column_name']}" for x in (c.get("columns") or [])[:8]
        )
        cand_lines.append(f"- {c['stem']}: {c['description'][:160]} | columns: {col_summary}")

    prompt = (
        "Given a reporting block, pick exactly ONE matching data source stem.\n"
        f"Block id: {block_descriptor.name}\n"
        f"Block goal: {goal or '(none)'}\n"
        f"Block tokens: {block_descriptor.inner_scalars}\n"
        "Candidates:\n" + "\n".join(cand_lines) + "\n\n"
        "Reply with the stem only (no quotes, no explanation)."
    )
    try:
        resp = llm.generate(messages=[{"role": "user", "content": prompt}])
        text = (resp.content or "").strip().split()[0] if resp else ""
        return text or None
    except Exception as exc:
        logger.debug("BlockDtoSelectorNode: LLM call failed — %s", exc)
        return None


# ── The node ───────────────────────────────────────────────────────────────


class BlockDtoSelectorNode(BaseNode):
    """Pick the best DTO for a single block. See module docstring."""

    def __init__(self, name: Optional[str] = None):
        super().__init__(name or "BlockDtoSelector")

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        scan: Optional[ScanResult] = shared.get("template_scan_obj")
        if scan is None:
            raise ValueError(
                "BlockDtoSelectorNode requires 'template_scan_obj' in shared "
                "state (run TemplateScanNode first)"
            )
        block_id = (shared.get("block_id") or "").strip()
        if not block_id:
            raise ValueError(
                "BlockDtoSelectorNode requires 'block_id' in shared state"
            )
        descriptor: Optional[BlockDescriptor] = next(
            (b for b in scan.blocks if b.name == block_id), None,
        )
        if descriptor is None:
            raise LookupError(
                f"BlockDtoSelectorNode: block_id={block_id!r} not in scan",
            )
        existing = shared.get("existing_block") or {}
        goal = (
            shared.get("block_goal")
            or (existing.get("goal") if isinstance(existing, dict) else "")
            or ""
        )
        return {"descriptor": descriptor, "goal": goal}

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        descriptor: BlockDescriptor = prep_result["descriptor"]
        goal: str = prep_result["goal"]

        inventory = _build_dto_inventory()
        if not inventory:
            return {
                "selection": None,
                "report": {
                    "block_id": descriptor.name,
                    "reason": "no DTOs available (datasources.yaml empty or "
                              "parquets missing)",
                    "candidates": [],
                },
            }

        # 1. Hint check
        hint_match = _HINT_RE.search(descriptor.html_excerpt or "")
        if hint_match:
            hint_stem = hint_match.group(1).strip()
            for e in inventory:
                if e["stem"] == hint_stem or e["dto_cte"] == hint_stem:
                    return {
                        "selection": {**e, "score": 1.0, "source": "hint"},
                        "report": {
                            "block_id": descriptor.name,
                            "candidates": [
                                {"stem": e["stem"], "score": 1.0, "via": "hint"},
                            ],
                        },
                    }

        # 2. Deterministic scoring
        block_text = _block_bag(descriptor, goal)
        dto_vecs = _ensure_dto_vectors(inventory)
        scores = _score(block_text, dto_vecs) if dto_vecs is not None else None

        if scores is None:
            # Embedding unavailable — fall back to a simple substring overlap so
            # callers still get an answer.
            ranked = _fallback_rank(block_text, inventory)
            picked = ranked[0] if ranked else None
            top3 = [{"stem": r["stem"], "score": r["score"], "via": "substring"}
                    for r in ranked[:3]]
            if picked is None:
                return {
                    "selection": None,
                    "report": {"block_id": descriptor.name, "candidates": top3},
                }
            sel = next(e for e in inventory if e["stem"] == picked["stem"])
            return {
                "selection": {**sel, "score": picked["score"], "source": "fallback"},
                "report": {"block_id": descriptor.name, "candidates": top3},
            }

        order = sorted(
            range(len(inventory)),
            key=lambda i: float(scores[i]),
            reverse=True,
        )
        top1 = order[0]
        top1_score = float(scores[top1])
        margin = top1_score - (float(scores[order[1]]) if len(order) > 1 else 0.0)
        candidates_report = [
            {
                "stem": inventory[i]["stem"],
                "score": float(scores[i]),
                "via": "embedding",
            }
            for i in order[:3]
        ]

        chosen_idx = top1
        source = "score"
        if margin < _LLM_TIE_MARGIN and len(order) > 1:
            llm_pick = _llm_tiebreak(
                descriptor, goal,
                [inventory[i] for i in order[:3]],
            )
            if llm_pick:
                for i in order[:3]:
                    if inventory[i]["stem"] == llm_pick or inventory[i]["dto_cte"] == llm_pick:
                        chosen_idx = i
                        source = "llm"
                        break

        chosen = inventory[chosen_idx]
        return {
            "selection": {
                **chosen,
                "score": float(scores[chosen_idx]),
                "source": source,
            },
            "report": {
                "block_id": descriptor.name,
                "candidates": candidates_report,
                "margin": margin,
            },
        }

    def post(
        self,
        shared: Dict[str, Any],
        prep_result: Any,
        exec_result: Dict[str, Any],
    ) -> str:
        shared["block_dto"] = exec_result["selection"]
        shared["block_dto_report"] = exec_result["report"]
        action = "default" if exec_result["selection"] else "no_dto"
        self.log_exit(action)
        return action


def _fallback_rank(
    block_text: str, inventory: List[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    """Cheap substring-overlap ranking used when embeddings are unavailable."""
    block_terms = set(re.findall(r"[a-z0-9]{3,}", block_text.lower()))
    out: List[Dict[str, Any]] = []
    for e in inventory:
        bag_terms = set(re.findall(r"[a-z0-9]{3,}", _dto_bag(e).lower()))
        if not bag_terms:
            continue
        overlap = len(block_terms & bag_terms)
        if overlap == 0:
            continue
        score = overlap / max(1, len(block_terms))
        out.append({"stem": e["stem"], "score": score})
    out.sort(key=lambda x: x["score"], reverse=True)
    return out


__all__ = ["BlockDtoSelectorNode"]
