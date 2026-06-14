"""CTE library tools for the agent (pickle-graph backed).

The CTE library is a single persisted NetworkX pickle managed by
:class:`services.cte_graph.repository.CTEGraphRepository` — there is no longer
an ``index.yaml`` or per-CTE ``.sql`` file on disk.  The graph is both the
catalogue and the executable definition; each node carries its ``rawSql`` body,
an embedded description, and its dependency edges.

Tools (names kept stable for the agent + config whitelist):

* ``list_accounting_ctes``  — list catalogue nodes (name, description, deps).
* ``read_accounting_cte``   — raw SQL of one node + its dependency chain.
* ``execute_accounting_cte``— assemble the node's full ancestor closure (or a
  custom ``WITH … SELECT …`` with library refs injected), register the graph's
  parquet source view, and run on DuckDB.
* ``save_accounting_cte``   — upsert a node (re-embed + re-persist the pickle),
  then execute it immediately by default.

The parquet "ledger" pointer lives in the graph metadata (``source_view`` →
``parquet_source``); execution registers that view, so there is no implicit
``ledger`` requirement anymore.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, List, Optional

from llm.base_llm import ToolResult
from services.cte_graph.repository import CTERepositoryError, get_repository
from services.tool_registry import Tool

logger = logging.getLogger(__name__)

_DEFAULT_MAX_ROWS = 200


# ── Tool: list_accounting_ctes ─────────────────────────────────────────────


def _handle_list_accounting_ctes(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    repo = get_repository()
    ctes = repo.list_ctes()
    if not ctes:
        return ToolResult(
            tool_use_id="",
            content=f"Aucun CTE dans le graphe {repo.graph_id!r}. Créez-en un avec save_accounting_cte.",
            is_error=True,
        )

    name_filter = (args.get("name_filter") or "").strip().lower()
    lines: List[str] = [
        f"Catalogue des CTE (graphe {repo.graph_id}, source {repo.source_view()}):",
        "",
    ]
    for entry in ctes:
        name = entry.get("name") or ""
        if name_filter and name_filter not in name.lower():
            continue
        desc = (entry.get("description") or "").strip()
        lines.append(f"### {name}")
        if desc:
            lines.append(desc)
        lines.append(f"- depends_on: {entry.get('depends_on') or '[]'}")
        lines.append(f"- used_by: {entry.get('used_by') or '[]'}")
        if entry.get("projects"):
            lines.append(f"- projects: {entry['projects']}")
        if entry.get("parameters"):
            lines.append(f"- parameters: {entry['parameters']}")
        lines.append("")
    return ToolResult(tool_use_id="", content="\n".join(lines).rstrip())


list_accounting_ctes_tool = Tool(
    name="list_accounting_ctes",
    description=(
        "Liste les CTE de la bibliothèque (graphe pickle data/cte_graphs/) avec "
        "leur description, leurs dépendances (`depends_on`) et leurs colonnes "
        "projetées. À utiliser AVANT `execute_accounting_cte` pour choisir le bon CTE."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "name_filter": {
                "type": "string",
                "description": (
                    "Filtre optionnel sur le nom (substring, casse insensible). "
                    "Ex: 'pnb', 'agence', 'ratios'."
                ),
            },
        },
    },
    handler=_handle_list_accounting_ctes,
    category="read-only",
)


# ── Tool: read_accounting_cte ──────────────────────────────────────────────


def _handle_read_accounting_cte(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    name = (args.get("cte_name") or "").strip()
    if not name:
        return ToolResult(tool_use_id="", content="cte_name est requis.", is_error=True)

    repo = get_repository()
    graph = repo.load()
    node = repo.get_cte(name, graph)
    if node is None:
        known = ", ".join(c["name"] for c in repo.list_ctes(graph)) or "(aucun)"
        return ToolResult(
            tool_use_id="",
            content=f"CTE inconnu: {name!r}. CTE disponibles: {known}",
            is_error=True,
        )

    chain = repo.ancestor_closure(name, graph)
    out: List[str] = [
        f"### {name}",
        f"Description: {node.get('description') or ''}",
        f"Dépendances (ordre topologique, hors {name}): "
        f"{[n for n in chain if n != name] or '[]'}",
        f"Projects: {node.get('projects') or []}",
        "",
        "```sql",
        node.get("rawSql") or "",
        "```",
    ]
    return ToolResult(tool_use_id="", content="\n".join(out))


read_accounting_cte_tool = Tool(
    name="read_accounting_cte",
    description=(
        "Renvoie le SQL brut d'un CTE + sa chaîne de dépendances (depuis le graphe). "
        "Utile pour grounder une analyse avant d'écrire un `WITH … SELECT …` qui s'appuie dessus."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "cte_name": {
                "type": "string",
                "description": "Nom du CTE (ex: 'final_ratios', 'aggregated_agency').",
            },
        },
        "required": ["cte_name"],
    },
    handler=_handle_read_accounting_cte,
    category="read-only",
)


# ── Execution (structured + tool) ──────────────────────────────────────────


def execute_accounting_cte_structured(
    *,
    cte_name: str = "",
    sql: str = "",
    parameters: Optional[Dict[str, Any]] = None,
    parquet_paths: Optional[Dict[str, str]] = None,  # accepted for back-compat; ignored
    max_rows: int = _DEFAULT_MAX_ROWS,
    ctx: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Execute a library CTE (or custom CTE-shaped SQL) and return structured data.

    Delegates to :meth:`CTEGraphRepository.execute`: full transitive ancestor
    closure assembly + parquet view registration from the graph metadata.
    ``parquet_paths`` is accepted but ignored — the source is the graph's
    ``parquet_source`` pointer.
    """
    if parquet_paths:
        logger.debug("execute_accounting_cte_structured: ignoring parquet_paths override %s", parquet_paths)
    return get_repository().execute(
        cte_name=cte_name,
        sql=sql,
        parameters=parameters,
        max_rows=max_rows,
        ctx=ctx,
    )


def _handle_execute_accounting_cte(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    cte_name = (args.get("cte_name") or "").strip()
    custom_sql = (args.get("sql") or "").strip()
    try:
        result = execute_accounting_cte_structured(
            cte_name=cte_name,
            sql=custom_sql,
            parameters=dict(args.get("parameters") or {}),
            max_rows=int(args.get("max_rows") or _DEFAULT_MAX_ROWS),
            ctx=ctx,
        )
    except (CTERepositoryError, Exception) as exc:
        return ToolResult(tool_use_id="", content=str(exc), is_error=True)

    cols = result["columns"]
    rows = result["rows"]
    truncated = result["truncated"]
    missing = result["missing_parameters"]
    resolved_paths = result["resolved_paths"]
    expanded = result["sql"]

    summary: List[str] = []
    summary.append(f"Colonnes: {', '.join(cols) if cols else '(aucune)'}")
    summary.append(f"Lignes retournées: {len(rows)}{' (tronqué)' if truncated else ''}")
    if missing:
        summary.append(f"Paramètres non liés (NULL): {', '.join(missing)}")
    if resolved_paths:
        rendered = ", ".join(f"{k}={Path(v).name}" for k, v in resolved_paths.items())
        summary.append(f"Sources DuckDB: {rendered}")
    if result["execution_chain"]:
        summary.append(f"Chaîne récursive exécutée: {' -> '.join(result['execution_chain'])}")
    summary.append("")
    for r in rows[:50]:
        summary.append(" | ".join(str(v) for v in r.values()))
    if len(rows) > 50:
        summary.append(f"... ({len(rows) - 50} lignes supplémentaires non affichées)")
    summary.append("")
    summary.append("--- SQL final (closure assemblée) ---")
    summary.append(expanded)
    return ToolResult(tool_use_id="", content="\n".join(summary))


execute_accounting_cte_tool = Tool(
    name="execute_accounting_cte",
    description=(
        "Exécute un CTE de la bibliothèque (ou un `WITH … SELECT …` arbitraire) sur "
        "DuckDB. Assemble automatiquement la fermeture transitive des CTE parents "
        "(ordre topologique), enregistre la vue source parquet du graphe, lie "
        "`$period` / `$prior_period` puis renvoie les colonnes + lignes + le SQL "
        "assemblé. Préférer `cte_name` pour un CTE de la bibliothèque, et `sql` "
        "quand on veut composer plusieurs CTE en une seule requête."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "cte_name": {
                "type": "string",
                "description": "Nom d'un CTE de la bibliothèque (ex: 'final_ratios').",
            },
            "sql": {
                "type": "string",
                "description": (
                    "SQL CTE-shaped optionnel (`WITH x AS (…) SELECT … FROM x`). "
                    "Les références à des CTE de la bibliothèque (FROM aggregated_client) "
                    "sont résolues automatiquement (fermeture injectée)."
                ),
            },
            "parameters": {
                "type": "object",
                "description": (
                    "Valeurs des paramètres `$param`. Ex: `{'period': '2026-01'}`."
                ),
            },
            "max_rows": {
                "type": "integer",
                "description": "Plafond du nombre de lignes (défaut 200, max 1000).",
                "default": _DEFAULT_MAX_ROWS,
            },
        },
    },
    handler=_handle_execute_accounting_cte,
    category="read-only",
)


# ── Tool: save_accounting_cte (upsert + optional execute) ──────────────────


def _handle_save_accounting_cte(args: Dict[str, Any], ctx: Dict[str, Any]) -> ToolResult:
    cte_name = (args.get("cte_name") or "").strip()
    description = (args.get("description") or "").strip()
    inner_sql = (args.get("sql") or "").strip()
    if not cte_name or not description or not inner_sql:
        return ToolResult(
            tool_use_id="",
            content="Arguments requis: cte_name, description, sql (corps SQL à l'intérieur du CTE).",
            is_error=True,
        )

    depends_on = args.get("depends_on")
    if depends_on is None:
        depends_on = []
    if not isinstance(depends_on, list):
        return ToolResult(
            tool_use_id="",
            content="depends_on doit être une liste de noms de CTE existants.",
            is_error=True,
        )
    projects = args.get("projects")
    projects = projects if isinstance(projects, list) else []

    repo = get_repository()
    try:
        saved = repo.upsert_cte(
            cte_name,
            inner_sql,
            description,
            depends_on=[str(x) for x in depends_on],
            projects=[str(p) for p in projects],
        )
    except CTERepositoryError as exc:
        return ToolResult(tool_use_id="", content=str(exc), is_error=True)

    lines: List[str] = [
        f"CTE « {cte_name} » enregistré dans le graphe (re-persisté).",
        f"- depends_on: {saved['depends_on'] or '[]'}",
        f"- remplacement: {'oui' if saved['replaced'] else 'non (nouveau)'}",
        "",
    ]

    execute_now = args.get("execute_immediately")
    if execute_now is None:
        execute_now = True
    if execute_now:
        try:
            result = repo.execute(
                cte_name=cte_name,
                parameters=dict(args.get("parameters") or {}),
                max_rows=int(args.get("max_rows") or _DEFAULT_MAX_ROWS),
                ctx=ctx,
            )
        except (CTERepositoryError, Exception) as exc:
            lines.append(
                "Enregistrement OK, mais l'exécution immédiate a échoué — "
                f"vérifiez le SQL et les dépendances: {exc}"
            )
            return ToolResult(tool_use_id="", content="\n".join(lines), is_error=True)

        cols = result["columns"]
        rows = result["rows"]
        truncated = result["truncated"]
        lines.append("--- Résultat d'exécution immédiate ---")
        lines.append(f"Colonnes: {', '.join(cols) if cols else '(aucune)'}")
        lines.append(f"Lignes: {len(rows)}{' (tronqué)' if truncated else ''}")
        if result.get("resolved_paths"):
            rendered = ", ".join(
                f"{k}={Path(v).name}" for k, v in result["resolved_paths"].items()
            )
            lines.append(f"Sources: {rendered}")
        lines.append("")
        for r in rows[:50]:
            lines.append(" | ".join(str(v) for v in r.values()))
        if len(rows) > 50:
            lines.append(f"... ({len(rows) - 50} lignes de plus)")
        lines.append("")
        lines.append("--- SQL assemblé (extrait) ---")
        exp = (result.get("sql") or "")[:8000]
        lines.append(exp if exp else "(vide)")
        if result.get("sql") and len(result["sql"]) > 8000:
            lines.append("… (tronqué)")

    return ToolResult(tool_use_id="", content="\n".join(lines), is_error=False)


save_accounting_cte_tool = Tool(
    name="save_accounting_cte",
    description=(
        "Enregistre un **nouveau** CTE (ou remplace un existant du même nom) dans le "
        "graphe pickle : embed la description, recalcule les arêtes de dépendances, "
        "re-valide le DAG et **re-persiste le pickle**, puis par défaut **exécute "
        "immédiatement** ce CTE pour répondre à la question. "
        "Appelez cet outil lorsque `list_accounting_ctes` ne propose pas la métrique "
        "voulue. Le champ `sql` est le **corps** entre les parenthèses du CTE "
        "(sans la ligne `nom AS (`).\n"
        "RÈGLE DE PARAMÉTRAGE (impérative) : les valeurs de FILTRE de la question "
        "(année/exercice, période, catégorie, branche, entité…) ne doivent JAMAIS être "
        "codées en dur. Remplace-les par des paramètres DuckDB `$nom` et passe leurs "
        "valeurs via `parameters` lors de l'exécution. Le CTE doit rester GÉNÉRIQUE et "
        "réutilisable, et son nom ne doit contenir ni année ni valeur de filtre.\n"
        "  ✗ `WHERE EXERSTAT = 2025 AND LIBECATE = 'RC A.V.A'` nommé `primes_rc_ava_2025`\n"
        "  ✓ `WHERE EXERSTAT = $year AND LIBECATE = $libecate` nommé `primes_par_categorie` "
        "puis `parameters={'year': 2025, 'libecate': 'RC A.V.A'}`.\n"
        "Avant de créer un CTE, vérifie avec `list_accounting_ctes` qu'un CTE paramétré "
        "équivalent n'existe pas déjà (réutilise-le en changeant seulement `parameters`)."
    ),
    input_schema={
        "type": "object",
        "properties": {
            "cte_name": {
                "type": "string",
                "description": "Identifiant du CTE (snake_case), ex. pnb_par_agence.",
            },
            "description": {
                "type": "string",
                "description": "Description métier pour le catalogue et la recherche sémantique.",
            },
            "sql": {
                "type": "string",
                "description": (
                    "Corps SQL du CTE uniquement (entre parenthèses). Référencer "
                    "les CTE existants par leur nom (FROM aggregated_client) pour composer. "
                    "Paramètre les valeurs de filtre avec `$nom` (ex: `WHERE EXERSTAT = $year "
                    "AND LIBECATE = $libecate`) — JAMAIS de littéraux d'année/catégorie en dur."
                ),
            },
            "depends_on": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Liste explicite des CTE parents (doivent exister). "
                    "Facultatif si déjà déductible des références dans sql."
                ),
            },
            "projects": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Colonnes projetées catalogue (optionnel).",
            },
            "execute_immediately": {
                "type": "boolean",
                "description": "Si true (défaut), exécute le CTE après sauvegarde et renvoie les lignes.",
                "default": True,
            },
            "parameters": {
                "type": "object",
                "description": "Paramètres $period / autres pour l'exécution.",
            },
            "max_rows": {
                "type": "integer",
                "description": "Plafond lignes pour l'exécution (défaut 200).",
            },
        },
        "required": ["cte_name", "description", "sql"],
    },
    handler=_handle_save_accounting_cte,
    category="write",
)
