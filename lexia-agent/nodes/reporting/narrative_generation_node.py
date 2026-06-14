"""NarrativeGenerationNode — turn SQL grounding rows into French prose.

For each ``kind=narrative`` block (or each narrative-typed sub-CTE
inside a ``kind=mixed`` block), :class:`ReportSqlBatchNode` has already
produced **one** row of grounding columns (the block's SQL projects
exactly the keys listed in ``grounding_fields:``) and stored it under
``_narrative_inputs["NARRATIVE:<slot>"]``.  This node:

1. Reads ``_narrative_inputs[<NARRATIVE:slot>] = {col: value, ...}``
   from shared state.
2. Looks up each NARRATIVE slot's ``style:`` directive,
   ``grounding_fields:`` and (optional) ``fallback_text:`` from
   ``report_definitions['blocks']`` — a slot's metadata may live on
   the leaf block whose ``kind == 'narrative'`` or on a sub-CTE inside
   a ``mixed`` block.
3. Serialises the grounding row as YAML and asks the LLM to *narrate
   over the evidence* — never invent numbers.  The system prompt makes
   this constraint explicit and lists every grounding column.
4. Stores the rendered HTML (or fallback) under ``render_narratives``,
   which the existing :class:`TemplateRenderNode` already consumes.
5. Records per-narrative timing + status under
   ``narrative_run_reports`` so the API can stream them as SSE events.

If a grounding column is ``None``/missing, the node uses the field's
``fallback_text`` when present (otherwise an empty string), so the
template never displays half-baked sentences.

Why this lives here
───────────────────
Narratives are the only field kind whose final output is **not** what
the SQL produced; they always go through the LLM.  Keeping the LLM call
in its own node lets us:

* Cache narrative results by ``(field_id, grounding_row_hash)``
  (left as a future optimisation — see ``_grounding_signature``).
* Emit per-narrative SSE events without touching the SQL batch.
* Run the renderer with deterministic fixtures in tests by injecting a
  fake ``call_llm`` (see ``tests/reporting/test_narrative_generation.py``).

Inputs (shared state)
─────────────────────
* ``report_definitions``  — full YAML; used to find ``style`` /
  ``fallback_text`` per ``NARRATIVE:slot`` field.
* ``_narrative_inputs``   — dict[field_id -> grounding row dict] from
  :class:`ReportSqlBatchNode`.
* ``template_scan``       — required so we know which slots actually
  appear in the template (we don't waste LLM calls on orphan
  definitions).

Optional shared keys
* ``render_narratives``   — pre-existing dict (e.g. supplied by tests
  or the edit-agent's preview tool); only slots NOT already present
  are generated.
* ``narrative_max_rows``  — int, cap on serialised list-grounding
  values (default 10 to keep prompts small).

Outputs
* ``render_narratives``        — dict[name -> HTML string].
* ``narrative_run_reports``    — list[NarrativeReport].
"""

from __future__ import annotations

import json
import logging
import time
from dataclasses import asdict, dataclass, field
from typing import Any, Callable, Dict, List, Optional

import yaml

from nodes.base_node import BaseNode
from nodes.reporting.template_scan_node import (
    NarrativeDescriptor,
    ScanResult,
)


logger = logging.getLogger(__name__)


# Optional emit callback — same signature as the bootstrap flow's emit.
EmitFn = Callable[..., None]


# ── Per-narrative report ───────────────────────────────────────────────────


@dataclass
class NarrativeReport:
    """Per-slot outcome of the narrative-generation step."""
    field_id:    str
    slot:        str
    ok:          bool                = False
    used_fallback: bool              = False
    duration_ms: float               = 0.0
    error:       Optional[str]       = None
    grounding_keys: List[str]        = field(default_factory=list)


# ── System prompt ──────────────────────────────────────────────────────────


_SYSTEM_PROMPT = """\
Vous êtes un analyste financier français chargé de rédiger un commentaire
pour un rapport comptable.  Vous DEVEZ vous appuyer EXCLUSIVEMENT sur les
données structurées fournies sous la clé `evidence:` ; toute valeur
chiffrée que vous citez doit provenir de ces données.

# Règles strictes

1. N'inventez aucun chiffre absent de `evidence:`.  Si une donnée est
   manquante (`null`/absente), évitez simplement d'en parler.
2. Respectez la consigne de style donnée par l'utilisateur (longueur,
   tonalité, public).
3. Sortez UNIQUEMENT du HTML — un ou plusieurs paragraphes `<p>…</p>`.
   N'ajoutez pas de balises `<html>`, `<body>`, de titres `<h*>`, de
   listes, de tableaux ou d'attributs autres que `class="narrative"`
   sur les paragraphes.
4. Mettez en valeur les variations significatives (>5 %) et les
   chiffres clés en gras (`<strong>…</strong>`) lorsque c'est utile.
5. Formatez les montants en euros avec espaces fins comme séparateurs
   de milliers (ex: `8 083 €`) et les pourcentages avec un seul
   chiffre après la virgule (ex: `12,3 %`).  Utilisez un tiret cadratin
   (`—`) pour les valeurs nulles.
6. Aucun commentaire méta du type « voici un paragraphe ».  Rédigez
   directement.
"""


_USER_PROMPT_TEMPLATE = """\
# Slot
{slot_id}

# Style demandé
{style}

# Champs disponibles (alias → description courte)
{grounding_keys}

# evidence (extrait du CTE de ce slot)
```yaml
{evidence_yaml}
```

Rédigez maintenant le commentaire HTML."""


# ── Helpers ────────────────────────────────────────────────────────────────


def _truncate_lists(value: Any, max_items: int) -> Any:
    """Recursively cap list lengths in nested structures so prompts stay small."""
    if isinstance(value, list):
        if len(value) > max_items:
            value = value[:max_items] + [f"... ({len(value) - max_items} more truncated)"]
        return [_truncate_lists(v, max_items) for v in value]
    if isinstance(value, dict):
        return {k: _truncate_lists(v, max_items) for k, v in value.items()}
    return value


def _row_has_any_value(row: Dict[str, Any]) -> bool:
    """Return True iff at least one column carries a usable value.

    "Usable" means: not None, not NaN, not an empty list/dict/string.
    Numeric zero IS considered usable — a balance of 0 € is information.
    """
    if not row:
        return False
    for v in row.values():
        if v is None:
            continue
        # Catch float NaN (and pandas/numpy NaN flavours that compare to themselves
        # falsy via `!= self`).
        if isinstance(v, float) and v != v:  # NaN check
            continue
        if isinstance(v, (list, dict)) and not v:
            continue
        if isinstance(v, str) and not v.strip():
            continue
        return True
    return False


def _grounding_signature(field_id: str, row: Dict[str, Any]) -> str:
    """Stable signature for cache lookups (future use)."""
    serialised = json.dumps(row, sort_keys=True, default=str)
    return f"{field_id}::{hash(serialised) & 0xFFFFFFFF:x}"


def _slot_metadata_from_blocks(
    definitions: Dict[str, Any],
) -> Dict[str, Dict[str, Any]]:
    """Build a ``slot_name -> {grounding_fields, style, fallback_text, source_id}`` map.

    Walks every block (and every sub-CTE inside ``kind=mixed`` blocks),
    keeping the first ``kind=narrative`` entry encountered for each slot.
    The slot for a narrative entry is resolved in priority order:

    1. The first ``NARRATIVE:<slot>`` entry in the entry's ``tokens:`` list.
    2. The entry's ``id`` if it begins with ``"NARRATIVE:"``.
    3. The entry's ``id`` itself (allowing block-id == slot-name shortcuts).

    The slot key in the returned map is the bare slot (no
    ``"NARRATIVE:"`` prefix) — that's what
    :class:`TemplateScanNode` exposes via ``NarrativeDescriptor.name``.
    """
    out: Dict[str, Dict[str, Any]] = {}

    def _normalise_slot(raw: str) -> str:
        if not raw:
            return ""
        return raw[len("NARRATIVE:"):] if raw.startswith("NARRATIVE:") else raw

    def _resolve_slot(entry: Dict[str, Any]) -> str:
        tokens = entry.get("tokens") or []
        if isinstance(tokens, list):
            for tok in tokens:
                if isinstance(tok, str) and tok.startswith("NARRATIVE:"):
                    return _normalise_slot(tok)
        raw_id = entry.get("id") or ""
        return _normalise_slot(raw_id)

    def _ingest(entry: Dict[str, Any], parent_id: Optional[str]) -> None:
        if (entry.get("kind") or "").strip() != "narrative":
            return
        slot = _resolve_slot(entry)
        if not slot or slot in out:
            return
        out[slot] = {
            "id":               entry.get("id") or parent_id or "",
            "grounding_fields": list(entry.get("grounding_fields") or []),
            "style":            entry.get("style"),
            "fallback_text":    entry.get("fallback_text"),
            "parent_id":        parent_id,
        }

    for blk in definitions.get("blocks") or []:
        if not isinstance(blk, dict):
            continue
        if blk.get("deprecated"):
            continue
        _ingest(blk, parent_id=None)
        if (blk.get("kind") or "").strip() == "mixed":
            for sub in blk.get("ctes") or []:
                if isinstance(sub, dict):
                    _ingest(sub, parent_id=blk.get("id"))
    return out


def _slot_input_key(slot_name: str) -> str:
    """``ReportSqlBatchNode`` keys narrative inputs by ``NARRATIVE:<slot>``."""
    if slot_name.startswith("NARRATIVE:"):
        return slot_name
    return f"NARRATIVE:{slot_name}"


def _wrap_in_paragraph(text: str) -> str:
    """If the LLM forgot the `<p>` wrapper, add one — but never double-wrap."""
    stripped = (text or "").strip()
    if not stripped:
        return ""
    lower = stripped.lower()
    if lower.startswith("<p") or lower.startswith("<div"):
        return stripped
    return f'<p class="narrative">{stripped}</p>'


# ── PocketFlow node ─────────────────────────────────────────────────────────


class NarrativeGenerationNode(BaseNode):
    """Generate one HTML narrative per ``NARRATIVE:slot`` in the template.

    The node always processes every narrative slot scanned from the
    template, **not** every narrative field in the definitions, so a
    deprecated definition cannot leave a stray prose paragraph in the
    output.
    """

    def __init__(
        self,
        name: Optional[str] = None,
        emit: Optional[EmitFn] = None,
    ):
        super().__init__(name or "NarrativeGeneration")
        self._emit = emit or (lambda *a, **k: None)

    # ── prep ─────────────────────────────────────────────────────────────

    def prep(self, shared: Dict[str, Any]) -> Dict[str, Any]:
        self.log_entry(shared)
        scan: Optional[ScanResult] = shared.get("template_scan")
        if scan is None:
            raise ValueError(
                "NarrativeGenerationNode requires 'template_scan' in shared state "
                "(run TemplateScanNode first)"
            )

        defs = shared.get("report_definitions") or {}
        narrative_inputs: Dict[str, Dict[str, Any]] = (
            shared.get("_narrative_inputs") or {}
        )
        existing: Dict[str, str] = dict(shared.get("render_narratives") or {})
        max_rows = int(shared.get("narrative_max_rows") or 10)

        return {
            "scan":              scan,
            "definitions":       defs,
            "narrative_inputs":  narrative_inputs,
            "existing":          existing,
            "max_rows":          max_rows,
        }

    # ── exec ─────────────────────────────────────────────────────────────

    def exec(self, prep_result: Dict[str, Any]) -> Dict[str, Any]:
        scan: ScanResult                 = prep_result["scan"]
        defs: Dict[str, Any]             = prep_result["definitions"]
        inputs: Dict[str, Dict[str, Any]] = prep_result["narrative_inputs"]
        existing: Dict[str, str]         = prep_result["existing"]
        max_rows: int                    = prep_result["max_rows"]

        narrative_slots: List[NarrativeDescriptor] = list(scan.narratives)
        if not narrative_slots:
            return {
                "narratives": existing,
                "reports":    [],
            }

        slot_metadata = _slot_metadata_from_blocks(defs)
        results: Dict[str, str] = dict(existing)
        reports: List[NarrativeReport] = []

        self._emit(
            "narrative_start",
            f"Generating {len(narrative_slots)} narrative(s)…",
            total=len(narrative_slots),
        )

        for idx, narr in enumerate(narrative_slots, 1):
            slot = narr.name  # e.g. "pnl"
            if slot in results:
                # Caller pre-supplied this narrative (tests / edit-agent preview).
                reports.append(NarrativeReport(
                    field_id=_slot_input_key(slot),
                    slot=slot, ok=True,
                ))
                self._emit(
                    "narrative_skipped",
                    f"[{idx}/{len(narrative_slots)}] {slot} — pre-supplied",
                    slot=slot, index=idx, total=len(narrative_slots),
                )
                continue

            input_key = _slot_input_key(slot)
            meta = slot_metadata.get(slot)
            row = inputs.get(input_key)
            rep = NarrativeReport(field_id=input_key, slot=slot)
            t0 = time.perf_counter()

            try:
                if meta is None:
                    raise KeyError(
                        f"no narrative block defines slot {slot!r} "
                        f"(scan found NARRATIVE:{slot} in the template but "
                        f"no kind=narrative block produced it)"
                    )

                grounding_keys: List[str] = list(meta.get("grounding_fields") or [])
                rep.grounding_keys = list(grounding_keys)

                if row is None or not _row_has_any_value(row):
                    fallback = (meta.get("fallback_text") or "").strip()
                    results[slot] = _wrap_in_paragraph(fallback)
                    rep.used_fallback = True
                    rep.ok = True
                    self._emit(
                        "narrative_fallback",
                        f"[{idx}/{len(narrative_slots)}] {slot} — empty grounding, "
                        f"used fallback",
                        slot=slot, index=idx, total=len(narrative_slots),
                    )
                    continue

                trimmed_row = {
                    k: _truncate_lists(row.get(k), max_rows)
                    for k in (grounding_keys or list(row.keys()))
                }

                style = (meta.get("style") or "").strip() or (
                    "Analyste financier, 2 paragraphes, ton factuel."
                )
                evidence_yaml = yaml.safe_dump(
                    trimmed_row, allow_unicode=True, sort_keys=False, width=100,
                ).strip()

                user_prompt = _USER_PROMPT_TEMPLATE.format(
                    slot_id=input_key,
                    style=style,
                    grounding_keys=(
                        "\n".join(f"  - {k}" for k in grounding_keys)
                        if grounding_keys else "  (auto-derived from row keys)"
                    ),
                    evidence_yaml=evidence_yaml,
                )
                raw = self._call_llm(_SYSTEM_PROMPT, user_prompt)
                results[slot] = _wrap_in_paragraph(raw)
                rep.ok = True
                self._emit(
                    "narrative_ok",
                    f"[{idx}/{len(narrative_slots)}] {slot} — OK",
                    slot=slot, index=idx, total=len(narrative_slots),
                )

            except Exception as e:
                rep.ok = False
                rep.error = f"{type(e).__name__}: {e}"
                fallback = ""
                if meta is not None:
                    fallback = (meta.get("fallback_text") or "").strip()
                results[slot] = _wrap_in_paragraph(fallback)
                rep.used_fallback = bool(fallback)
                logger.error(
                    "[%s] narrative generation failed: %s", slot, rep.error,
                )
                self._emit(
                    "narrative_failed",
                    f"[{idx}/{len(narrative_slots)}] {slot} — {rep.error}",
                    slot=slot, error=rep.error,
                    index=idx, total=len(narrative_slots),
                )
            finally:
                rep.duration_ms = (time.perf_counter() - t0) * 1000.0
                reports.append(rep)

        return {
            "narratives": results,
            "reports":    reports,
        }

    # ── post ─────────────────────────────────────────────────────────────

    def post(
        self, shared: Dict[str, Any], prep_result: Any, exec_result: Dict[str, Any],
    ) -> str:
        shared["render_narratives"]      = exec_result["narratives"]
        shared["narrative_run_reports"]  = exec_result["reports"]
        shared["narrative_run_summary"]  = {
            "total":    len(exec_result["reports"]),
            "ok":       sum(1 for r in exec_result["reports"] if r.ok and not r.used_fallback),
            "fallback": sum(1 for r in exec_result["reports"] if r.used_fallback),
            "failed":   sum(1 for r in exec_result["reports"] if not r.ok),
            "reports":  [asdict(r) for r in exec_result["reports"]],
        }
        failed = [r for r in exec_result["reports"] if not r.ok]
        if failed:
            self.logger.warning(
                "%d/%d narrative generation(s) failed: %s",
                len(failed), len(exec_result["reports"]),
                [r.slot for r in failed][:10],
            )
        self.log_exit("default")
        return "default"

    # ── private ──────────────────────────────────────────────────────────

    def _call_llm(self, system_prompt: str, user_prompt: str) -> str:
        """Single LLM call.  Same wiring as :class:`BlockDraftNode` so tests
        can monkey-patch it identically."""
        from config import get_settings
        from llm.llm_factory import get_llm
        sync_client, _ = get_llm()
        model = get_settings().llm.model
        response = sync_client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user",   "content": user_prompt},
            ],
        )
        return response.choices[0].message.content or ""
