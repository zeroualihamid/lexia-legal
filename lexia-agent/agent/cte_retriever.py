"""CTE search-or-create retriever.

On every agent invocation:

  1. Embed the (augmented) query.
  2. Run :class:`services.cte_graph.SemanticSearch` over the cached library
     NetworkX graph (``services.cte_graph.library_graph_cache``).
  3. If the best hit's similarity ≥ threshold → return the matched CTE
     bundle for system-prompt injection. (No DB call here.)
  4. On miss → draft a new CTE with one LLM call and persist it via
     ``services.cte_graph.repository.CTEGraphRepository.upsert_cte`` (embed its
     description, re-validate the DAG, and re-persist the pickle under
     ``data/cte_graphs/``).
  5. If after generation the postgres execution still yields **no rows**, the
     caller (the AgentExecutor wrapper) must refuse with the configured
     ``no_data_refusal`` message rather than hallucinate.

The retriever NEVER hallucinates data. It only injects CTE SQL into the
prompt or returns a structured "no-CTE" sentinel.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import networkx as nx

from agent.config import get_section

logger = logging.getLogger(__name__)


@dataclass
class CTEMatch:
    """Result of a CTE search call.

    ``found`` is True when at least one hit cleared the threshold; the
    caller injects ``prompt_context`` into the system prompt. ``hits``
    contains the raw SemanticSearch payloads (with similarity_score,
    parents, children) for downstream selectors.

    On miss, ``created_name`` may be set if a fresh CTE was drafted +
    persisted; callers should then re-run search to pick it up.
    """

    found: bool = False
    hits: List[Dict[str, Any]] = field(default_factory=list)
    prompt_context: str = ""
    created_name: Optional[str] = None
    no_data: bool = False
    no_data_message: str = ""


# ── Public API ──────────────────────────────────────────────────────────────


def search_or_create_cte(
    augmented_query: str,
    original_query: str = "",
    *,
    top_k: Optional[int] = None,
    threshold: Optional[float] = None,
    create_on_miss: bool = True,
) -> CTEMatch:
    """Search the CTE library graph. Create + persist a CTE on miss.

    Args:
        augmented_query: Rewritten, self-contained user query.
        original_query: Original user phrasing (used to bias embedding).
        top_k: Override config value.
        threshold: Override config value.
        create_on_miss: When False, skip the generation step (read-only mode).

    Returns:
        :class:`CTEMatch` — never raises on a library failure; logs and
        returns an empty match instead so the agent can continue.
    """
    cfg = get_section("cte")
    lib_cfg = cfg.get("library_search", {}) or {}
    sem_cfg = cfg.get("semantic_search", {}) or {}
    create_cfg = cfg.get("create_on_miss", {}) or {}

    k = int(top_k or lib_cfg.get("top_k") or sem_cfg.get("top_k") or 7)
    thr = float(threshold if threshold is not None else sem_cfg.get("threshold", 0.55))
    neigh_max = int(lib_cfg.get("neighborhood_max", 12))

    text = (augmented_query or "").strip()
    oq = (original_query or "").strip()
    if oq and oq not in text:
        text = f"{oq}\n{text}"
    if not text:
        return CTEMatch()

    hits, prompt_ctx = _run_library_search(text, top_k=k, neighborhood_max=neigh_max)
    best = float(hits[0]["similarity_score"]) if hits else 0.0
    if hits and best >= thr:
        logger.info(
            "CTE library hit: %s (score=%.3f, threshold=%.2f)",
            hits[0].get("name"), best, thr,
        )
        return CTEMatch(found=True, hits=hits, prompt_context=prompt_ctx)

    logger.info(
        "CTE library miss (best=%.3f < threshold=%.2f, hits=%d)",
        best, thr, len(hits),
    )

    if not (create_on_miss and create_cfg.get("enabled", True)):
        return CTEMatch(found=False, hits=hits, prompt_context=prompt_ctx)

    # Try to draft + persist a new CTE.
    created_name = _generate_and_persist_cte(text)
    if created_name is None:
        return CTEMatch(found=False, hits=hits, prompt_context=prompt_ctx)

    # Re-run search with the freshly-appended node.
    hits2, prompt_ctx2 = _run_library_search(text, top_k=k, neighborhood_max=neigh_max)
    if hits2 and float(hits2[0]["similarity_score"]) >= thr:
        return CTEMatch(
            found=True,
            hits=hits2,
            prompt_context=prompt_ctx2,
            created_name=created_name,
        )

    return CTEMatch(
        found=False,
        hits=hits2 or hits,
        prompt_context=prompt_ctx2 or prompt_ctx,
        created_name=created_name,
    )


def build_no_data_refusal() -> str:
    """Return the configured refusal message for the "no rows" case.

    The AgentExecutor wrapper calls this when:
      - the CTE was found / created, AND
      - postgres execution returned 0 rows.

    Returning this string instead of a fabricated answer is enforced by
    nodes/agent/router_node parity (see system prompt rules).
    """
    msg = (get_section("cte").get("create_on_miss") or {}).get("no_data_refusal")
    return str(msg or "Aucune donnée n'a pu être extraite pour votre requête.").strip()


# ── Internals ───────────────────────────────────────────────────────────────


def _run_library_search(
    text: str,
    *,
    top_k: int,
    neighborhood_max: int,
):
    """Wraps the existing CTE library search to return (hits, formatted_prompt_block)."""
    try:
        from services.cte_graph.library_graph_cache import (
            get_agent_cte_embedding_service,
            get_cached_library_graph,
        )
        from services.cte_graph.search import SemanticSearch
    except Exception as exc:
        logger.warning("CTE library search unavailable (%s)", exc)
        return [], ""

    graph = get_cached_library_graph()
    if graph is None or graph.number_of_nodes() == 0:
        return [], ""

    try:
        finder = SemanticSearch(get_agent_cte_embedding_service())
        hits = finder.query(graph, text, top_k=top_k)
    except Exception as exc:
        logger.warning("SemanticSearch failed: %s", exc)
        return [], ""

    if not hits:
        return [], ""

    hit_names = {str(h.get("name") or h.get("node_id") or "") for h in hits}
    hit_names.discard("")
    extra: List[str] = []
    for h in hits:
        for p in h.get("parents") or []:
            s = str(p)
            if s and s not in hit_names and s not in extra:
                extra.append(s)
            if len(extra) >= neighborhood_max:
                break
        for c in h.get("children") or []:
            s = str(c)
            if s and s not in hit_names and s not in extra:
                extra.append(s)
            if len(extra) >= neighborhood_max:
                break
        if len(extra) >= neighborhood_max:
            break

    return hits, _format_cte_prompt_block(hits, extra[:neighborhood_max])


def _format_cte_prompt_block(hits: List[Dict[str, Any]], neighborhood: List[str]) -> str:
    """Compact human-readable block for the agent's system prompt."""
    if not hits:
        return ""
    lines: List[str] = []
    for h in hits:
        name = h.get("name") or h.get("node_id") or "?"
        score = float(h.get("similarity_score") or 0.0)
        pct = max(0, min(100, int(round(score * 100))))
        lines.append(f"- **{name}** (similarity ~{pct}%)")
        desc = (h.get("description") or "").strip().replace("\n", " ")
        if desc:
            if len(desc) > 280:
                desc = desc[:277] + "…"
            lines.append(f"  {desc}")
        parents = list(h.get("parents") or [])
        children = list(h.get("children") or [])
        lines.append(f"  depends_on → {parents} | used_by → {children}")
    if neighborhood:
        lines.append("")
        lines.append("Nearby CTEs (extra context): " + ", ".join(f"`{n}`" for n in neighborhood))
    return "\n".join(lines)


_DRAFT_SYSTEM = (
    "Tu es un ingénieur analytics. Tu conçois des CTE SQL DuckDB réutilisables et "
    "PARAMÉTRÉS sur la table source du graphe : les valeurs de filtre ne sont jamais "
    "codées en dur, mais exposées comme paramètres `$nom`. Réponds UNIQUEMENT en YAML."
)

_DRAFT_TEMPLATE = """\
Conçois UN nouveau CTE **PARAMÉTRÉ** et réutilisable pour répondre à la requête.

### Requête
{query}

### Vue source (FROM ...)
{source_view}

### CTE existants (réutilise-les via FROM <nom> si pertinent)
{catalogue}

### Règle de paramétrage (IMPÉRATIVE)
Les valeurs de FILTRE présentes dans la requête (année/exercice, période, catégorie,
branche, entité, intermédiaire, …) NE doivent JAMAIS être écrites en dur dans le SQL.
Remplace-les par des paramètres DuckDB `$nom` (snake_case, sans accents). Le CTE doit
rester GÉNÉRIQUE et réutilisable pour d'AUTRES valeurs — sinon on créerait un CTE par
combinaison (année × catégorie × …), ce qui est interdit.
- ✗ INTERDIT : `WHERE EXERSTAT = 2025 AND LIBECATE = 'RC A.V.A'`, nommé `primes_rc_ava_2025`
- ✓ CORRECT  : `WHERE EXERSTAT = $year AND LIBECATE = $libecate`, nommé `primes_par_categorie`
N'introduis un paramètre QUE pour une valeur réellement présente dans la requête ; ne
paramètre pas ce qui n'est pas filtré.

### Contraintes
- Le `sql` est le CORPS du CTE uniquement (entre les parenthèses de `nom AS ( ... )`), commençant par SELECT.
- Référence la vue source `{source_view}` ou un CTE existant dans le FROM.
- `parameters` liste les paramètres `$nom` utilisés (noms seuls, sans le `$`), ou [].
- `depends_on` liste les CTE existants référencés (ou []).
- `name` en snake_case ASCII, GÉNÉRIQUE : sans année ni valeur de filtre dans le nom.

Réponds au format:
```yaml
name: <snake_case_generique>
description: <description métier courte>
parameters: [<param1>, <param2>, ...]
depends_on: [<cte_existant>, ...]
sql: |
  SELECT ... WHERE col = $param1 ...
```"""


def _generate_and_persist_cte(query_text: str) -> Optional[str]:
    """Best-effort CTE drafting + persistence into the pickle graph on a miss.

    Drafts one CTE with a single LLM call, then persists it via
    :meth:`CTEGraphRepository.upsert_cte` (embed + re-validate DAG +
    re-persist pickle). Returns the created CTE name, or None on failure so
    callers degrade gracefully.
    """
    try:
        import yaml

        from services.cte_graph.repository import CTERepositoryError, get_repository
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("CTE repository unavailable (%s)", exc)
        return None

    repo = get_repository()
    try:
        graph = repo.load()
        catalogue_lines = [
            f"- {c['name']}: {(c.get('description') or '').strip()[:120]}"
            for c in repo.list_ctes(graph)
        ]
        catalogue = "\n".join(catalogue_lines) or "(aucun)"
        source_view = repo.source_view(graph)
    except Exception as exc:
        logger.warning("CTE catalogue read failed: %s", exc)
        return None

    try:
        from llm.llm_factory import create_llm_client

        client = create_llm_client()
        resp = client.generate(
            _DRAFT_TEMPLATE.format(
                query=query_text, source_view=source_view, catalogue=catalogue
            ),
            system=_DRAFT_SYSTEM,
        )
        content = getattr(resp, "content", None) or str(resp)
    except Exception as exc:
        logger.warning("CTE drafting LLM call failed: %s", exc)
        return None

    try:
        text = content.strip()
        if "```" in text:
            # Extract the first fenced block (```yaml … ``` or ``` … ```).
            parts = text.split("```")
            for chunk in parts:
                c = chunk.strip()
                if c.lower().startswith("yaml"):
                    c = c[4:].strip()
                if "name:" in c and "sql:" in c:
                    text = c
                    break
        draft = yaml.safe_load(text)
        if not isinstance(draft, dict):
            raise ValueError("draft is not a mapping")
        name = str(draft.get("name") or "").strip()
        sql_body = str(draft.get("sql") or "").strip()
        description = str(draft.get("description") or "").strip()
        deps = draft.get("depends_on") or []
        if not isinstance(deps, list):
            deps = []
        raw_params = draft.get("parameters") or []
        params = (
            [str(p).lstrip("$").strip() for p in raw_params if str(p).strip()]
            if isinstance(raw_params, list)
            else []
        )
        if not name or not sql_body:
            raise ValueError("draft missing name/sql")
    except Exception as exc:
        logger.warning("CTE draft parse failed: %s", exc)
        return None

    try:
        saved = repo.upsert_cte(
            name,
            sql_body,
            description,
            depends_on=[str(d) for d in deps],
            parameters=params,
        )
    except CTERepositoryError as exc:
        logger.warning("CTE upsert rejected: %s", exc)
        return None
    except Exception as exc:
        logger.warning("CTE upsert failed: %s", exc)
        return None

    logger.info("CTE drafted + persisted: %s", saved["name"])
    return saved["name"]
