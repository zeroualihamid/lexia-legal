"""Ambiguity gate — ask the user to refine before the agent loop.

When a query is analytically underspecified (superlative / ranking without a
clear metric) AND the CTE library only returns near-misses (below the
confidence threshold), we must NOT burn ``max_iterations`` on schema
exploration. Instead we return clarifying questions with reformulations that
map cleanly to CTE creation or execution paths.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

from agent.config import get_section
from agent.cte_retriever import CTEMatch, search_or_create_cte

logger = logging.getLogger(__name__)

# Superlative / ranking language without an explicit metric.
_SUPERLATIVE_RE = re.compile(
    r"\b("
    r"plus\s+(?:performant|rentable|important|grand|gros|élevé|élevée|fort|forte|"
    r"meilleur|meilleure|mauvais|mauvaise|pire|faible|bas|basse)|"
    r"le\s+(?:plus|moins)\s+\w+|"
    r"top\s*\d*|"
    r"meilleur(?:e|s)?|"
    r"pire(?:s)?|"
    r"principal(?:e|s)?|"
    r"premier(?:e|s)?|"
    r"dernier(?:e|s)?|"
    r"classement|"
    r"qui\s+est\s+le"
    r")\b",
    re.IGNORECASE,
)

# Explicit metrics / dimensions — when present, intent is usually clear enough.
_METRIC_RE = re.compile(
    r"\b("
    r"pnb|mni|encours|solde|marge|intérêt|interet|"
    r"capitaux|crédit|credit|débit|debit|"
    r"qualit[ée]|notation|profil|"
    r"chiffre|ca\b|revenu|"
    r"ratio|coefficient|"
    r"nombre\s+de\s+clients?|nb\s+clients?"
    r")\b",
    re.IGNORECASE,
)

_CLARIFY_SYSTEM = (
    "Tu es l'assistant analytique Brikz. La requête utilisateur est ambiguë : "
    "plusieurs interprétations mènent à des CTE SQL différentes. "
    "Tu NE dois PAS exécuter de SQL ni inventer de chiffres. "
    "Pose 2 à 3 questions courtes et propose des reformulations concrètes "
    "alignées sur la création ou l'exécution d'un CTE réutilisable. "
    "Réponds en français, en markdown léger (titres + listes)."
)

_CLARIFY_TEMPLATE = """\
### Requête utilisateur (ambiguë)
{query}

### CTE proches (similarité insuffisante pour exécution automatique)
{near_miss_ctes}

### Catalogue CTE disponible (extrait)
{catalogue}

### Compétence métier (si applicable)
{skills_excerpt}

### Consignes
1. Explique en 1 phrase pourquoi la question est ambiguë (métrique, dimension, période…).
2. Pose **2 à 3 questions** de clarification numérotées.
3. Pour chaque interprétation plausible, propose une **reformulation exacte** que l'utilisateur peut recopier, et indique :
   - le **nom de CTE existant** à exécuter (`execute_accounting_cte`) s'il convient, OU
   - le **nom suggéré** pour une nouvelle CTE (`save_accounting_cte`) avec la granularité (client, agence, gestionnaire…).
4. Mentionnez les colonnes clés quand pertinent (`Client Code Qualité`, `%Encours_RC`, PNB, MNI…).
5. Ne dépassez pas 250 mots. Pas de SQL complet — seulement les noms de CTE et reformulations.
"""


def _clarify_cfg() -> Dict[str, Any]:
    agent_cfg = get_section("agent") or {}
    raw = agent_cfg.get("clarification") or {}
    sem_thr = float((get_section("cte") or {}).get("semantic_search", {}).get("threshold", 0.55))
    return {
        "enabled": bool(raw.get("enabled", True)),
        "near_miss_min": float(raw.get("near_miss_min", 0.28)),
        "near_miss_max": float(raw.get("near_miss_max", sem_thr)),
        "score_spread": float(raw.get("score_spread", 0.06)),
    }


def is_ambiguous_query(query: str, match: CTEMatch, *, cfg: Optional[Dict[str, Any]] = None) -> bool:
    """Return True when we should ask the user to refine instead of looping."""
    cfg = cfg or _clarify_cfg()
    if not cfg.get("enabled"):
        return False
    if match.found:
        return False

    q = (query or "").strip()
    if not q:
        return False

    hits = match.hits or []
    best = float(hits[0].get("similarity_score") or 0.0) if hits else 0.0
    second = float(hits[1].get("similarity_score") or 0.0) if len(hits) > 1 else 0.0

    lo = float(cfg["near_miss_min"])
    hi = float(cfg["near_miss_max"])
    near_miss = lo <= best < hi
    close_competitors = len(hits) >= 2 and (best - second) <= float(cfg["score_spread"])

    has_superlative = bool(_SUPERLATIVE_RE.search(q))
    has_metric = bool(_METRIC_RE.search(q))

    # Ranking / superlative without an explicit metric → clarify before exploring.
    if has_superlative and not has_metric:
        return True

    # Several near-miss CTEs with similar scores → pick one interpretation first.
    if near_miss and close_competitors:
        return True

    # Near miss + superlative even when a weak metric token might be present elsewhere.
    if near_miss and has_superlative and best < hi:
        return True

    return False


def _format_near_miss_block(hits: List[Dict[str, Any]], limit: int = 5) -> str:
    if not hits:
        return "(aucune CTE proche)"
    lines: List[str] = []
    for h in hits[:limit]:
        name = h.get("name") or h.get("node_id") or "?"
        score = float(h.get("similarity_score") or 0.0)
        desc = (h.get("description") or "").strip().replace("\n", " ")
        if len(desc) > 160:
            desc = desc[:157] + "…"
        lines.append(f"- `{name}` (~{int(round(score * 100))} %) — {desc or '(sans description)'}")
    return "\n".join(lines)


def _catalogue_excerpt(limit: int = 12) -> str:
    try:
        from services.cte_graph.repository import get_repository

        repo = get_repository()
        lines = [
            f"- `{c['name']}`: {(c.get('description') or '')[:100]}"
            for c in repo.list_ctes()[:limit]
        ]
        return "\n".join(lines) or "(catalogue vide)"
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("catalogue excerpt failed: %s", exc)
        return "(catalogue indisponible)"


def _deterministic_clarification(query: str, match: CTEMatch) -> str:
    """Fallback when the LLM call fails — still CTE-aligned."""
    hits = match.hits or []
    top_names = [str(h.get("name") or "") for h in hits[:3] if h.get("name")]
    cte_hint = ", ".join(f"`{n}`" for n in top_names if n) or "`pnb_agence_client`"

    return (
        f"Votre question **« {query.strip()} »** est ambiguë : « performant / meilleur / top » "
        "peut désigner plusieurs métriques ou dimensions, et aucune CTE existante ne correspond "
        "avec assez de confiance pour une exécution directe.\n\n"
        "**Précisez votre intention parmi :**\n\n"
        "1. **Performance financière (PNB)** — client avec le Produit Net Bancaire le plus élevé\n"
        "   → Reformulez : *« Quel client a le PNB le plus élevé ? »*\n"
        f"   → CTE existante proche : {cte_hint} ; sinon nouvelle CTE `top_client_pnb`.\n\n"
        "2. **Notation qualité crédit** — meilleur `Client Code Qualité` "
        "(ex. « 01 - PERFORMANT - TRES BON »)\n"
        "   → Reformulez : *« Quels clients ont la notation PERFORMANT la plus élevée ? »*\n"
        "   → Nouvelle CTE suggérée : `top_client_qualite`.\n\n"
        "3. **Autre indicateur** — précisez la mesure (MNI, encours, marge…) et éventuellement "
        "la période ou l'agence.\n\n"
        "Répondez avec la reformulation qui vous convient ; je créerai ou exécuterai le CTE "
        "correspondant."
    )


def generate_clarification_message(
    query: str,
    match: CTEMatch,
    *,
    skills_context: str = "",
) -> str:
    """Build clarifying questions + CTE-aligned reformulation suggestions."""
    skills_excerpt = (skills_context or "").strip()
    if len(skills_excerpt) > 2000:
        skills_excerpt = skills_excerpt[:1997] + "…"

    prompt = _CLARIFY_TEMPLATE.format(
        query=query.strip(),
        near_miss_ctes=_format_near_miss_block(match.hits or []),
        catalogue=_catalogue_excerpt(),
        skills_excerpt=skills_excerpt or "(aucune compétence métier injectée)",
    )

    try:
        from llm.llm_factory import create_llm_client

        client = create_llm_client()
        resp = client.generate(prompt, system=_CLARIFY_SYSTEM)
        text = (getattr(resp, "content", None) or str(resp)).strip()
        if len(text) > 80:
            return text
    except Exception as exc:
        logger.warning("Clarification LLM failed, using deterministic fallback: %s", exc)

    return _deterministic_clarification(query, match)


def maybe_clarify_query(
    query: str,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    skills_context: str = "",
) -> Optional[Dict[str, Any]]:
    """If *query* is ambiguous, return a full agent result dict; else ``None``."""
    cfg = _clarify_cfg()
    if not cfg.get("enabled"):
        return None

    q = (query or "").strip()
    if not q:
        return None

    match = search_or_create_cte(
        augmented_query=q,
        original_query=q,
        create_on_miss=False,
    )

    if not is_ambiguous_query(q, match, cfg=cfg):
        return None

    logger.info(
        "Ambiguity gate: asking user to refine (best CTE score=%.3f, hits=%d)",
        float(match.hits[0].get("similarity_score") or 0.0) if match.hits else 0.0,
        len(match.hits or []),
    )

    if not skills_context:
        try:
            from skill_registry import build_skills_context_for_query

            skills_context = build_skills_context_for_query(q)
        except Exception:  # pragma: no cover - defensive
            skills_context = ""

    answer = generate_clarification_message(q, match, skills_context=skills_context)

    if memory_store is not None:
        try:
            session = memory_store.get_or_create(session_id)
            session.add_message("user", q)
            session.add_message("assistant", answer)
            memory_store.save(session_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Clarification memory persist failed: %s", exc)

    return {
        "query": q,
        "augmented_query": q,
        "analysis_plan": "",
        "cte_hit": False,
        "cte_created": None,
        "answer": answer,
        "intermediate_steps": [],
        "sql_queries": [],
        "sql_results": [],
        "rendered_reports": [],
        "needs_clarification": True,
    }
