"""report_edit_agent_flow — agent loop for editing a template's definitions.

Mirrors the architecture of :func:`flows.agent_flow.create_agent_flow`
(``router → dispatch → verify`` with a ``respond → done`` exit) but
swaps the global tool registry for a **scoped reporting registry**
(see :mod:`tools.reporting_tools`).  The agent never gets access to
``sql_query`` or other data-analysis tools — its only contract with the
world is the block-scoped reporting tools.

Tool catalogue exposed to the LLM (block schema)
───────────────────────────────────────────────
* ``list_blocks``               — overview of every tagged block.
* ``get_block``                 — read one block's YAML payload.
* ``get_block_html``            — raw HTML excerpt of the tagged div.
* ``propose_block_definition``  — DRY-RUN validation of a draft block.
* ``set_block_definition``      — atomic write after validation
                                   (bumps version, appends history).
* ``set_subblock_definition``   — patch ONE sub-CTE of a ``kind=mixed``
                                   block (rounding, formatting, per-cell
                                   SQL) without rewriting siblings.
* ``preview_block``             — execute the block's CTE with sample
                                   params (≤ 5 rows).
* ``set_template_parameters``   — merge top-level ``parameters:`` in
                                   ``definitions.yaml`` (defaults for
                                   ``$param``; use when the user names
                                   a client, year, etc.).
* ``delete_block``              — mark a block deprecated.
* ``rescan_template``           — re-parse HTML, append skeleton blocks
                                   for new ``data-block`` markers and
                                   deprecate vanished ones.
* ``apply_template_html_patch`` — unique substring replace in
                                   ``report-template.html`` (layout /
                                   new ``data-block`` regions).  YAML
                                   tools alone do not change this file.
* ``apply_report_css_patch``      — unique substring replace in
                                   ``report.css`` (styling inlined at render).

Wiring
──────
Triggered by:
    POST /reporting/templates/{template_id}/edit-agent

Streams events through ``stream_callback`` using the same
``(event, message, data)`` shape as the data-analysis agent so the
existing chat SSE plumbing works unchanged.

Shared state contract (set by :func:`run_report_edit_agent`)
──────────────────────────────────────────────────────────
The reporting tools read these keys from ``ctx`` (which is the entire
agent shared state):

* ``template_id``             — required.
* ``templates_root``          — optional override.
* ``accounting_library_dir``  — optional override.
* ``block_library_dir``       — optional override (defaults to
                                 ``data/reporting/sql/fragment_library/``).
* ``parquet_paths``           — optional, used by ``preview_block``.
* ``parquet_cache_dir``       — optional, forwarded to ``rescan_template``.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional

import yaml
from pocketflow import Flow, Node as PFNode

from nodes.agent.response_node import AgentResponseNode
from nodes.agent.router_node import AgentRouterNode
from nodes.agent.tool_dispatch_node import ToolDispatchNode
from nodes.agent.verify_node import VerifyNode
from nodes.reporting.template_scan_node import ScanResult, scan_template
from tools.reporting_tools import build_reporting_registry


logger = logging.getLogger(__name__)


StreamCallback = Callable[[str, str, Optional[Dict[str, Any]]], None]


_PROJECT_ROOT = Path(__file__).resolve().parent.parent
_TEMPLATES_ROOT       = _PROJECT_ROOT / "data" / "reporting" / "templates"
_DEFAULT_LIBRARY      = _PROJECT_ROOT / "data" / "reporting" / "sql" / "accounting"
_DEFAULT_FRAGMENT_LIBRARY = _PROJECT_ROOT / "data" / "reporting" / "sql" / "fragment_library"


def _ensure_block_library_path(explicit: Optional[Path]) -> Path:
    """Return the reusable block-CTE library root, creating ``index.yaml`` if absent."""
    root = Path(explicit).resolve() if explicit else _DEFAULT_FRAGMENT_LIBRARY
    root.mkdir(parents=True, exist_ok=True)
    idx = root / "index.yaml"
    if not idx.is_file():
        idx.write_text(
            yaml.safe_dump({"version": 1, "ctes": []}, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
    return root


def _block_library_agent_notes(library_path: str) -> str:
    """Instructions for saving bespoke CTEs next to definitions."""
    return f"""\
# Bibliothèque de CTE pour blocs ``data-block``

Dossier sur disque : ``{library_path}``  
Chaque entrée = ``<name>.sql`` + ligne dans ``index.yaml``.  Le rendu et
``validate_block`` résolvent ``cte_ref: <name>`` depuis ce dossier.

**Quand un DIV / sous-CTE a besoin d'une CTE dédiée** (non couverte seule
par la bibliothèque comptable) :

1. Valider le SQL (WITH …) avec ``propose_block_definition`` sur le bloc
   cible (inline ``sql:`` d'abord si besoin).
2. **Persister le SQL** : passez ``sql:`` à ``set_block_definition`` ou
   ``set_subblock_definition`` — l'outil écrit ``sql/fragment_library/<ref>.sql``
   (nom canonique ``<template_id>__<block_id>`` …) et n'enregistre dans
   ``definitions.yaml`` que ``cte_ref``.
3. **Réutiliser** : dans le YAML versionné, il ne doit rester que ``cte_ref:``.

Composer d'abord avec la bibliothèque comptable (``FROM revenue``,
``{{{{include: …}}}}`` dans ``data/reporting/sql/accounting/``) ; le dossier
**fragment_library** sert aux fragments réutilisables propres au rapport ou partagés
entre plusieurs ``data-block``.
"""


# ── Flow factory ───────────────────────────────────────────────────────────


class _FlowEndNode(PFNode):
    """No-op terminal node — same shape as in :mod:`flows.agent_flow`."""
    pass


def create_report_edit_agent_flow(max_iterations: int = 10) -> Flow:
    """Assemble the reporting-agent DAG (router → dispatch → verify loop)."""
    router = AgentRouterNode(max_iterations=max_iterations)
    dispatch = ToolDispatchNode()
    verify = VerifyNode()
    response = AgentResponseNode()
    flow_end = _FlowEndNode()

    router - "dispatch" >> dispatch
    router - "respond" >> response
    dispatch >> verify
    verify - "think" >> router
    verify - "respond" >> router
    response - "done" >> flow_end

    return Flow(start=router)


# ── System prompt ──────────────────────────────────────────────────────────


_SYSTEM_PROMPT_BASE = """\
Vous êtes l'agent éditeur de rapports comptables Brikz.  Votre rôle :
mettre à jour le dictionnaire de définitions d'un template (un fichier
``definitions.yaml``) à la demande de l'utilisateur, **bloc par bloc**.
L'unité de travail n'est plus un champ isolé mais un **bloc** : un
``<élément data-block="<nom>">`` du HTML qui regroupe une ou plusieurs
balises DSL (`{{TOKEN}}`, `BEGIN/END:section`, `IF:flag`, `NARRATIVE`).

# Invariants stricts

1. Le fichier ``definitions.yaml`` persisté ne doit **jamais** contenir de champ
   ``sql:`` sur un bloc ou sous-CTE : uniquement ``cte_ref:`` pointant vers
   ``data/reporting/sql/fragment_library/<nom>.sql``.  Les outils ``set_block_definition``
   et ``set_subblock_definition`` acceptent encore ``sql:`` dans l''appel ;
   ils écrivent automatiquement le fichier sous ``fragment_library/`` et ne conservent que ``cte_ref``.
2. Le contrat de projection dépend du ``kind`` du bloc :
     - ``scalar``      → 1 ligne ; colonnes alias = chaque token déclaré
                          (lowercased ou via ``mapping``) ;
     - ``condition``   → 1 ligne ; 1 colonne booléenne nommée comme le flag ;
     - ``chart_array`` → N lignes ; 1 colonne ``AS value`` ;
     - ``section``     → N lignes ; colonnes alias = inner_tokens du
                          ``BEGIN:`` (lowercased ou via ``mapping``) ;
     - ``narrative``   → 1 ligne ; colonnes alias = ``grounding_fields:``.
   Pour ``mixed`` : remplir ``ctes:`` avec une liste de sous-CTEs feuilles.
3. Composez TOUJOURS depuis la bibliothèque comptable avant d'inventer
   un calcul : utilisez ``{{include: <nom>}}`` pour réutiliser les
   briques (voir ``data/reporting/sql/accounting/index.yaml``).
4. Si une formule de bloc est commune à plusieurs templates, préférez
   ``cte_ref: <nom>`` réutilisant un fichier existant dans ``fragment_library/``.
   Pour une CTE **nouvelle**, passez ``sql:`` une fois à ``set_block_definition`` /
   ``set_subblock_definition`` (matérialisation automatique vers ``sql/fragment_library/``).
5. Avant TOUTE écriture, appelez ``propose_block_definition`` pour
   valider la forme.  N'appelez ``set_block_definition`` que si la
   validation passe.
6. Si l'utilisateur ne précise pas, **conservez** les autres blocs
   intacts — ne supprimez jamais un bloc non demandé.
7. Pour vérifier qu'une formule produit le bon résultat, utilisez
   ``preview_block`` (5 lignes max) — c'est plus fiable que les
   simulations mentales.  Les valeurs par défaut déclarées dans
   ``parameters:`` (via ``set_template_parameters``) sont appliquées
   avant les paramètres de l'appel, comme en rendu final.
8. **HTML du template** : ``set_block_definition`` / ``definitions.yaml``
   ne modifient **jamais** ``report-template.html``.  Toute demande de
   mise en page (ordre des blocs, pied de page, nouveau
   ``data-block="…"``, texte autour des ``{{TOKEN}}``) **exige**
   ``apply_template_html_patch`` avec un ``old_text`` qui n'apparaît
   **qu'une fois** (copier un extrait large depuis ``get_block_html``).
   Après ajout de balises ``data-block``, appelez ``rescan_template``
   puis ``set_block_definition`` pour chaque nouveau bloc.
9. **CSS** : pour les changements de style (typographie, tableaux,
   ``.detail-account``, mise en page d'un cadre), patchez
   ``report.css`` via ``apply_report_css_patch`` (même contrainte
   d'unicité que pour le HTML).  Le rendu inline ce fichier — éditer
   le HTML seul ne suffit pas si le style vient d'une classe CSS.
10. **Paramètres globaux** : quand l'utilisateur donne un **littéral**
    (nom de client, année, période, …), enregistrez-le dans
    ``parameters:`` avec ``set_template_parameters`` (champ
    ``default``).  Sans cela, la valeur n'apparaît pas dans
    ``definitions.yaml`` et les blocs SQL qui utilisent
    ``$client_name`` / ``$year`` ne peuvent pas s'en servir.  Vous
    pouvez combiner : ``set_template_parameters`` puis, si le bloc
    lit encore la base (ex. ``NOM_ASSU``) au lieu de ``$client_name``,
    ``set_block_definition`` pour aligner le SQL sur les paramètres.
11. **Blocs mixed (``kind: mixed``)** : ne renvoyez **jamais** la liste
    ``ctes:`` complète pour un changement local.  Utilisez
    ``set_subblock_definition(block_id, sub_block_id, sql=…)`` qui
    patch UN sous-CTE, valide tout le parent puis persiste.
    Concrètement : un montant à arrondir / reformater dans un
    tableau (``{{AMOUNT}}``, ``{{TOTAL_*}}``, ``{{ACCOUNT_AMOUNT_*}}``)
    se modifie sur le sous-CTE qui produit cette colonne — pas sur le
    bloc parent ni sur un bloc voisin de type ``condition`` /
    ``scalar`` (qui ne porte pas la donnée).
12. **Repérage des montants** : un bloc ``condition`` (ex.
    ``monthly_section`` autour de ``IF:has_monthly``) ne contient
    aucun montant : c'est juste un drapeau d'affichage.  Les chiffres
    affichés dans la même page proviennent presque toujours d'un
    bloc voisin ``kind=mixed`` (ex. ``monthly_table``).  En cas de
    doute, lancez ``list_blocks`` puis ``get_block`` sur les voisins
    pour identifier le bon ``sub_block_id``.
13. **``kind: empty`` est un placeholder** créé par ``rescan_template``
    pour signaler qu'un ``data-block`` du HTML n'a pas encore de
    sémantique.  Si l'utilisateur décrit ce que le bloc doit
    **calculer** (un montant, un drapeau, une liste, …), votre
    première action est de **promouvoir** le ``kind`` vers la valeur
    qui correspond au contrat de projection (cf. règle 2) — ne
    persistez **jamais** ``kind: empty`` avec du SQL inline, l'outil
    rejettera la requête.  Ne gardez ``kind: empty`` que pour les
    blocs purement décoratifs / réservés.
15. **Source DTO obligatoire** — chaque CTE de bloc DOIT lire ses
    données depuis exactement un *DTO source* (CTE auto-générée du
    type ``dto_<parquet_stem>``, en général enregistrée dans
    ``data/reporting/sql/fragment_library/index.yaml``
    avec ``kind: source``.  Avant de rédiger un bloc :
    a. Si le ``data-block`` cible la mauvaise table, utilisez
       ``which_dto_for_block(block_id)`` (outil read-only) pour que le
       système choisisse la bonne source à votre place — il rend le
       ``FROM`` canonique, la liste des colonnes disponibles, et la
       valeur exacte à mettre dans ``depends_on:``.
    b. Sinon, ouvrez ``fragment_library/index.yaml`` (entrées ``dto_*``) et
       choisissez le ``dto_<stem>`` dont les colonnes correspondent
       aux ``tokens`` du bloc.
    c. Le SQL persisté doit ressembler à
       ``WITH <block_id> AS (SELECT … FROM dto_<stem> WHERE …)
       SELECT … FROM <block_id>`` — jamais de ``FROM read_parquet(...)``
       direct, jamais de ``FROM`` vers un autre ``dto_*``.
    d. ``set_block_definition`` doit recevoir
       ``depends_on: [dto_<stem>]`` pour que le moteur de rendu
       inline le wrap parquet en amont du bloc.

14. **Nom canonique d'une CTE de bloc** : si l'utilisateur souhaite
    un ``cte_ref:`` *propre* (ex. ``total_collected_revenue``) au
    lieu du nom auto-préfixé par le template (ex. ``mon_template__
    total_collected_revenue``), créez ``fragment_library/<nom>.sql``
    à la main (WITH …), ajoutez l'entrée dans ``index.yaml``, puis
    ``propose_block_definition`` et ``set_block_definition`` avec
    **uniquement** ``cte_ref: <nom>`` (sans ``sql:``).
    Sans fichier dédié, la CTE est nommée
    ``<template_id>__<block_id_sans_suffixe_block>`` automatiquement.

# Méthode de travail recommandée

1. ``list_blocks`` pour repérer le bloc à traiter, puis ``get_block``
   et ``get_block_html`` pour lire l'existant et le HTML correspondant.
2. Rédigez le YAML complet du bloc, validez avec
   ``propose_block_definition``.  En cas d'erreur, corrigez et
   recommencez.
3. Si OK : ``set_block_definition`` (atomique, versionne le YAML).
   ↳ Pour un bloc ``mixed``, préférez
   ``set_subblock_definition(block_id, sub_block_id, sql=…)`` :
   l'outil patch UN sous-CTE, revalide le parent, persiste, et
   évite de réécrire les sous-CTEs voisins.
4. Pour ajouter de nouveaux blocs détectés dans le HTML :
   ``rescan_template`` réconcilie ``definitions.yaml`` avec les
   ``data-block`` du template (skeleton créés, blocs disparus
   marqués ``deprecated``).
5. Pour créer un bloc **sans** balise correspondante dans le HTML :
   d'abord ``apply_template_html_patch`` pour insérer le
   ``<… data-block="id">…</…>``, puis ``rescan_template``, puis
   ``propose_block_definition`` / ``set_block_definition``.
"""


def _format_block_inventory(scan: ScanResult) -> str:
    """Render a compact catalogue of every tagged ``data-block`` element.

    The agent's reasoning unit is the **block**, so we surface each
    block's id, kind, structural marker, scalars, a short HTML excerpt
    pointer (line) and any orphan markers that escaped tagging.
    """
    lines: List[str] = []
    if scan.blocks:
        lines.append('## Blocs taggés (`data-block="..."`)')
        for b in scan.blocks:
            tokens = ", ".join(b.inner_scalars) or "—"
            structural_bits: List[str] = []
            if b.inner_sections:
                structural_bits.append(f"BEGIN:{b.inner_sections[0]}")
            if b.inner_conditions:
                structural_bits.append(f"IF:{b.inner_conditions[0]}")
            if b.inner_narratives:
                structural_bits.append(f"NARRATIVE:{b.inner_narratives[0]}")
            if b.inner_chart_arrays:
                structural_bits.append(f"CHART:{b.inner_chart_arrays[0]}")
            structural = ", ".join(structural_bits) or "—"
            lines.append(
                f"- {b.name:<32}  kind={b.kind:<11}  line={b.line:<4}  "
                f"structural=[{structural}]  scalars=[{tokens}]"
            )
    else:
        lines.append("## Blocs taggés")
        lines.append("(aucun bloc `data-block=` détecté — taggez le HTML)")

    if scan.orphans:
        lines.append("")
        lines.append("## ⚠ Marqueurs DSL hors bloc (à corriger dans le HTML)")
        for o in scan.orphans[:20]:
            lines.append(f"- {o.kind}:{o.name} (line {o.line})")

    return "\n".join(lines)


def _build_system_prompt(
    scan: Optional[ScanResult],
    *,
    block_library_path: Optional[str] = None,
) -> str:
    """Concatenate base prompt, block-library workflow, and inventory."""
    lib_path = block_library_path or str(_DEFAULT_FRAGMENT_LIBRARY)
    notes = _block_library_agent_notes(lib_path)
    base = f"{_SYSTEM_PROMPT_BASE}\n\n{notes}"
    if scan is None:
        return base
    inventory = _format_block_inventory(scan)
    return (
        f"{base}\n\n"
        f"# Inventaire des blocs détectés dans ce template\n\n"
        f"Source de vérité — chacun doit avoir une entrée dans "
        f"``definitions.yaml`` quand il sera défini :\n\n"
        f"{inventory}\n"
    )


# Re-exported for backward-compat (tests may import the name).
_SYSTEM_PROMPT = _SYSTEM_PROMPT_BASE


# ── Public runner ──────────────────────────────────────────────────────────


def run_report_edit_agent(
    query: str,
    template_id: str,
    *,
    session_id: str = "default",
    max_iterations: int = 10,
    stream_callback: Optional[StreamCallback] = None,
    templates_root: Optional[Path] = None,
    accounting_library_dir: Optional[Path] = None,
    block_library_dir: Optional[Path] = None,
    parquet_paths: Optional[Dict[str, str]] = None,
    parquet_cache_dir: Optional[str] = None,
    initial_messages: Optional[List[Dict[str, Any]]] = None,
    llm_client: Any = None,
) -> Dict[str, Any]:
    """Run an edit-agent loop bound to a single template.

    The agent cannot escape its template:  ``template_id`` is injected
    into the shared context once and the reporting tools refuse any
    operation without it.

    Args:
        query: User instruction.
        template_id: which template to edit.
        session_id: opaque session identifier (used for logging).
        max_iterations: max think→act→observe loops.
        stream_callback: ``(event, message, data)`` for SSE.
        templates_root: optional override for the templates folder.
        accounting_library_dir: optional override for the CTE library.
        parquet_paths: ``{source_name -> path}`` used by ``preview_field``.
        parquet_cache_dir: forwarded to ``rescan_template``.
        initial_messages: optional list of prior messages (for
            multi-turn sessions).  Excludes the system prompt.
        llm_client: optional pre-built LLM client.

    Returns:
        Dict with ``response``, ``iterations``, ``definitions_path``
        and the raw shared state under ``shared``.
    """
    if llm_client is None:
        from llm.llm_factory import create_client_for_task
        llm_client = create_client_for_task("agent")

    troot = templates_root or _TEMPLATES_ROOT
    library = accounting_library_dir or (
        _DEFAULT_LIBRARY if _DEFAULT_LIBRARY.is_dir() else None
    )
    block_lib_path = _ensure_block_library_path(block_library_dir)
    template_dir = troot / template_id
    template_html_path = template_dir / "report-template.html"
    if not template_html_path.is_file():
        raise FileNotFoundError(
            f"Template not found: {template_html_path}"
        )

    # NOTE: ``definitions.yaml`` is no longer required up-front.  When it
    # is missing the API endpoint seeds an empty stub before invoking us
    # so the agent's ``set_block_definition`` / ``propose_block_definition``
    # tools can author blocks one-by-one.  We don't recreate the stub here
    # so callers that bypass the API still get an explicit error from the
    # tools rather than a silent overwrite.

    # Scan the HTML template ourselves so the agent always sees the full
    # token inventory, even when ``definitions.yaml`` is empty.
    scan: Optional[ScanResult] = None
    try:
        scan = scan_template(template_html_path.read_text(encoding="utf-8"))
        logger.info(
            "edit-agent scan: %s blocks, %s orphans (%s scalars, %s sections, "
            "%s conditions, %s narratives, %s chart arrays total)",
            len(scan.blocks), len(scan.orphans),
            len(scan.scalars), len(scan.sections), len(scan.conditions),
            len(scan.narratives), len(scan.chart_arrays),
        )
        if scan.orphans:
            logger.warning(
                "edit-agent: template %r has %d orphan DSL marker(s) "
                "outside any data-block element",
                template_id, len(scan.orphans),
            )
    except Exception as e:
        logger.warning(
            "edit-agent: template scan failed for %r — proceeding without "
            "inventory: %s", template_id, e,
        )

    registry = build_reporting_registry()

    shared: Dict[str, Any] = {
        # ── agent bookkeeping ────────────────────────────────────────────
        "query":                 query,
        "original_query":        query,
        "session_id":            session_id,
        "max_iterations":        max_iterations,
        "agent_iteration":       0,
        "agent_messages":        list(initial_messages or []),
        "agent_system_prompt":   _build_system_prompt(
            scan,
            block_library_path=str(block_lib_path),
        ),
        "agent_llm_client":      llm_client,
        "tool_registry":         registry,
        "tool_definitions":      registry.list_definitions(),
        "pending_tool_results":  [],
        # ── reporting-tool context (read by handlers) ───────────────────
        "template_id":            template_id,
        "templates_root":         str(troot),
        "accounting_library_dir": str(library) if library else None,
        "block_library_dir":      str(block_lib_path),
        "parquet_paths":          dict(parquet_paths or {}),
        # ── scanned block inventory (used by tools + system prompt) ────
        "template_scan":          scan.to_dict() if scan else None,
        "template_scan_obj":      scan,
        "all_block_ids":          scan.all_block_ids if scan else [],
        "all_field_ids":          scan.all_field_ids if scan else [],
    }
    if parquet_cache_dir:
        shared["parquet_cache_dir"] = parquet_cache_dir
    if stream_callback is not None:
        shared["stream_callback"] = stream_callback

    logger.info(
        "Starting report_edit_agent: session=%s template=%s query=%s",
        session_id, template_id, query[:80],
    )
    flow = create_report_edit_agent_flow(max_iterations=max_iterations)
    flow.run(shared)

    return {
        "response":         shared.get("agent_response") or shared.get("final_response", ""),
        "iterations":       shared.get("agent_iteration", 0),
        "definitions_path": str(template_dir / "definitions.yaml"),
        "shared":           shared,
    }
