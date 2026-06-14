"""Render-template tool for the data-analysis agent.

Lets ``flows/agent_flow.py`` produce a self-contained HTML rendering of a
report template (default: ``model1``) without hitting the HTTP route.
The tool delegates to :func:`flows.report_render_flow.run_report_render`,
which:

1. Auto-resolves parquet paths under ``data/parquet/`` (period-aware).
2. Registers ``ledger`` / ``balance`` views with the canonical-column
   adapter so the accounting CTE library (``base_ledger``,
   ``period_filtered_ledger``, …) sees English aliases.
3. Executes every block CTE in ``definitions.yaml`` with recursive
   ``{{include: …}}`` injection.
4. Generates narratives and folds condition flags.
5. Inlines the template's ``report.css`` into the rendered HTML so the
   output is displayable in an ``<iframe srcDoc>`` without an external
   stylesheet round-trip.

The full HTML is stored in ``context['rendered_reports']`` for the UI
layer to surface; the textual tool result is a compact summary so it
doesn't blow the LLM's context window.

This is the *agent-facing* counterpart of ``POST /reporting/templates/
{template_id}/render`` and shares the same flow — they only differ in
how the result is delivered.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List

from llm.base_llm import ToolResult
from services.tool_registry import Tool

logger = logging.getLogger(__name__)


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TEMPLATES_ROOT = _PROJECT_ROOT / "data" / "reporting" / "templates"


def _list_template_ids() -> List[str]:
    if not _TEMPLATES_ROOT.is_dir():
        return []
    out: List[str] = []
    for child in sorted(_TEMPLATES_ROOT.iterdir()):
        if child.is_dir() and (child / "report-template.html").is_file():
            out.append(child.name)
    return out


def _handle_render_report_template(
    arguments: Dict[str, Any],
    context: Dict[str, Any],
) -> ToolResult:
    template_id = (arguments.get("template_id") or "model1").strip()
    if not template_id:
        avail = ", ".join(_list_template_ids()) or "(aucun)"
        return ToolResult(
            tool_use_id="",
            content="`template_id` requis. Templates disponibles: " + avail,
            is_error=True,
        )

    parameters = arguments.get("parameters") or {}
    if not isinstance(parameters, dict):
        return ToolResult(
            tool_use_id="",
            content="`parameters` doit être un objet JSON.",
            is_error=True,
        )

    parquet_paths = arguments.get("parquet_paths") or {}
    if not isinstance(parquet_paths, dict):
        return ToolResult(
            tool_use_id="",
            content="`parquet_paths` doit être un objet JSON.",
            is_error=True,
        )

    pre_supplied = arguments.get("pre_supplied_narratives") or {}
    if not isinstance(pre_supplied, dict):
        pre_supplied = {}

    include_html = bool(arguments.get("include_html", False))
    html_max_chars = int(arguments.get("html_max_chars") or 4000)
    if html_max_chars < 0:
        html_max_chars = 0

    template_dir = _TEMPLATES_ROOT / template_id
    if not (template_dir / "report-template.html").is_file():
        avail = ", ".join(_list_template_ids()) or "(aucun)"
        return ToolResult(
            tool_use_id="",
            content=(
                f"Template introuvable: {template_id!r}. "
                f"Templates disponibles: {avail}"
            ),
            is_error=True,
        )
    if not (template_dir / "definitions.yaml").is_file():
        return ToolResult(
            tool_use_id="",
            content=(
                f"`definitions.yaml` manquant pour {template_id!r}. "
                f"Lancez d'abord la phase d'amorçage "
                f"(POST /reporting/templates/{template_id}/bootstrap)."
            ),
            is_error=True,
        )

    try:
        from flows.report_render_flow import run_report_render

        result = run_report_render(
            template_id=template_id,
            parameters=parameters,
            parquet_paths=parquet_paths,
            pre_supplied_narratives=pre_supplied or None,
        )
    except Exception as exc:
        logger.exception("render_report_template crashed")
        return ToolResult(
            tool_use_id="",
            content=f"Erreur de rendu: {type(exc).__name__}: {exc}",
            is_error=True,
        )

    success = bool(result.get("success"))
    html = result.get("html") or ""
    missing = result.get("missing") or []
    sql_errors = result.get("sql_errors") or []
    sql_summary = result.get("sql_summary") or {}
    narr_summary = result.get("narrative_summary") or {}
    duration_ms = result.get("duration_ms") or 0

    context.setdefault("rendered_reports", []).append({
        "template_id":   template_id,
        "success":       success,
        "duration_ms":   duration_ms,
        "html":          html,
        "missing":       missing,
        "sql_summary":   sql_summary,
        "narrative_summary": narr_summary,
        "sql_errors":    sql_errors,
        "parameters":    parameters,
    })

    lines: List[str] = []
    lines.append(
        f"{'OK' if success else 'PARTIEL'} — rendu HTML du template "
        f"{template_id!r} en {duration_ms / 1000:.2f}s"
    )
    if sql_summary:
        lines.append(
            "Blocs SQL: "
            f"{sql_summary.get('ok', 0)}/{sql_summary.get('total', 0)} OK"
            f" ({sql_summary.get('failed', 0)} échec(s))"
        )
    if narr_summary:
        lines.append(
            "Narratives: "
            f"{narr_summary.get('ok', 0)} OK, "
            f"{narr_summary.get('fallback', 0)} fallback, "
            f"{narr_summary.get('failed', 0)} échec(s) sur "
            f"{narr_summary.get('total', 0)}"
        )
    if missing:
        lines.append(
            f"Tokens manquants ({len(missing)}): {', '.join(missing[:10])}"
        )
    if sql_errors:
        lines.append("Erreurs SQL :")
        for err in sql_errors[:5]:
            lines.append(
                f"  - {err.get('block_id') or '?'} "
                f"[{err.get('kind') or '?'}]: {err.get('error')}"
            )

    lines.append(f"HTML rendu: {len(html)} caractères, CSS inline.")
    if include_html and html and html_max_chars > 0:
        lines.append("")
        lines.append("--- HTML (extrait) ---")
        lines.append(html[:html_max_chars])
        if len(html) > html_max_chars:
            lines.append(
                f"... ({len(html) - html_max_chars} caractères tronqués)"
            )

    return ToolResult(
        tool_use_id="",
        content="\n".join(lines),
        is_error=not success,
    )


render_report_template_tool = Tool(
    name="render_report_template",
    description=(
        "Rend un template de rapport (par défaut `model1`) en HTML autonome "
        "(CSS inline, prêt pour `<iframe srcDoc>`). Exécute en cascade tous "
        "les blocs SQL définis dans `definitions.yaml`, en injectant "
        "récursivement les CTE de la bibliothèque comptable "
        "(`base_ledger`, `period_filtered_ledger`, …), enregistre les vues "
        "`ledger`/`balance` avec adaptation French→English, lie `$period` / "
        "`$prior_period` puis génère les narratives manquantes. "
        "Renvoie un résumé (blocs OK/échecs, tokens manquants, durée) et "
        "stocke le HTML complet dans le contexte agent (`rendered_reports`) "
        "pour affichage côté UI. À utiliser pour répondre aux demandes du "
        "type 'fais le rendu HTML pour 2025', 'génère le rapport annuel', "
        "ou pour vérifier qu'un template tourne avant export PDF."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "template_id": {
                "type": "string",
                "description": (
                    "Identifiant du template (dossier sous "
                    "`data/reporting/templates/`). Défaut: `model1`."
                ),
                "default": "model1",
            },
            "parameters": {
                "type": "object",
                "description": (
                    "Paramètres de rendu. Au minimum `period` "
                    "(`YYYY-MM`, `YYYY-MM-DD`, ou "
                    "`YYYY-MM-DD..YYYY-MM-DD`). Optionnel: "
                    "`client_name`, `report_title`."
                ),
            },
            "parquet_paths": {
                "type": "object",
                "description": (
                    "Override `{source: chemin_parquet}` "
                    "(`{'ledger': '/abs/path.parquet'}`). Sinon, "
                    "auto-détection sous `data/parquet/` filtrée par la "
                    "fenêtre de `period`."
                ),
            },
            "pre_supplied_narratives": {
                "type": "object",
                "description": (
                    "Map `{slot: html}` injectée telle quelle (court-circuite "
                    "l'appel LLM pour ces slots). Optionnel."
                ),
            },
            "include_html": {
                "type": "boolean",
                "description": (
                    "Inclure un extrait du HTML rendu dans la réponse texte "
                    "du tool. Défaut: false (le HTML complet reste dans "
                    "`context.rendered_reports`)."
                ),
                "default": False,
            },
            "html_max_chars": {
                "type": "integer",
                "description": (
                    "Plafond de caractères du HTML quand "
                    "`include_html=true`. Défaut: 4000."
                ),
                "default": 4000,
            },
        },
        "required": ["template_id"],
    },
    handler=_handle_render_report_template,
    category="external",
)
