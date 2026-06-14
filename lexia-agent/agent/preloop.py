"""Pre-loop reasoning pipeline for the LangChain AgentExecutor.

Runs BEFORE the think → act → observe loop, mirroring the existing
``flows/agent_flow.py`` pipeline:

  1. DTO cache warm-up
  2. Query augmentation
  2b. Embedding column search
  2c. CTE library retrieval (via :func:`agent.cte_retriever.search_or_create_cte`)
  3. Plan decomposition

The output is a :class:`PreloopResult` containing the augmented query, the
analysis plan, pre-resolved column matches, the CTE prompt block, and the
fully-assembled system prompt that the AgentExecutor will receive.

Implementation is intentionally a thin port of the helpers in
``flows/agent_flow.py`` so behaviour is identical and a future refactor
can collapse the two into a single module.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

from agent.cte_retriever import CTEMatch, search_or_create_cte
from agent.config import get_section
from llm.base_llm import BaseLLM
from monitoring.logger import get_logger

logger = get_logger(__name__)


# ── Result container ────────────────────────────────────────────────────────


@dataclass
class PreloopResult:
    original_query: str
    augmented_query: str
    analysis_plan: str = ""
    column_matches: Dict[str, List[Dict[str, Any]]] = field(default_factory=dict)
    cte_match: CTEMatch = field(default_factory=CTEMatch)
    compact_schema: str = ""
    parquet_stems: List[str] = field(default_factory=list)
    system_prompt: str = ""


# ── Public entrypoint ───────────────────────────────────────────────────────


def run_preloop(
    query: str,
    *,
    llm_client: BaseLLM,
    session_id: str = "default",
    memory_store: Any = None,
    skills_context: str = "",
    skip_plan_on_cte_hit: bool = False,
) -> PreloopResult:
    """Run the full pre-loop pipeline and return the assembled system prompt.

    When *skip_plan_on_cte_hit* is True and the CTE library returns a confident
    hit, plan decomposition (a ~8 s LLM round-trip) is skipped: the caller is
    about to try the CTE fast path, which executes the matched CTE directly and
    never consumes the step plan. On a fast-path decline the executor still runs
    with the full schema, the highlighted CTE catalogue, and the skills context
    — only the supplementary step plan is absent. The plan is NEVER skipped on a
    miss, where the full agent needs it most.
    """
    preloop_cfg = get_section("preloop")

    parquet_dir = _resolve_parquet_dir(preloop_cfg)

    # 1. DTO cache warm-up
    compact_schema = ""
    if (preloop_cfg.get("dto_cache") or {}).get("warm_on_start", True):
        compact_schema = _ensure_dto_cache(parquet_dir)
    parquet_stems = _list_parquet_files(parquet_dir)

    # 1b. Scope the pre-loop to the active skill's data source (when a matched
    # skill bound one), so augmentation, the injected schema, and any new-CTE
    # design target the skill's parquet instead of the default/dominant source.
    active_stem = _active_source_stem()
    if active_stem and active_stem in parquet_stems:
        parquet_stems = [active_stem]
        scoped_schema = _scope_schema_to_source(compact_schema, active_stem)
        if not scoped_schema:
            # No DTO for this source — derive its schema from the parquet so the
            # agent still sees the right columns (and not the other sources').
            scoped_schema = _schema_from_parquet(parquet_dir, active_stem)
        if scoped_schema:
            compact_schema = scoped_schema

    # 2. Query augmentation
    augmented = query
    if (preloop_cfg.get("query_augmentation") or {}).get("enabled", True):
        augmented = _augment_query(
            query, llm_client, compact_schema, parquet_stems,
            memory_store=memory_store, session_id=session_id,
        )

    # 2b. Embedding column search
    column_matches: Dict[str, List[Dict[str, Any]]] = {}
    if (preloop_cfg.get("embedding_column_search") or {}).get("enabled", True):
        ecs_cfg = preloop_cfg.get("embedding_column_search") or {}
        column_matches = _search_embeddings_for_columns(
            augmented, parquet_dir,
            threshold=float(ecs_cfg.get("threshold", 0.30)),
            top_k_per_column=int(ecs_cfg.get("top_k_per_column", 5)),
        )

    # 2c. CTE library retrieval (search-or-create, no hallucination)
    cte_match = search_or_create_cte(augmented_query=augmented, original_query=query)

    # 3. Plan decomposition
    analysis_plan = ""
    if (preloop_cfg.get("plan_decomposition") or {}).get("enabled", True):
        if skip_plan_on_cte_hit and cte_match.found:
            logger.info(
                "Pre-loop: confident CTE hit (%s) — skipping plan decomposition "
                "(CTE fast-path candidate)",
                (cte_match.hits[0].get("name") if cte_match.hits else "?"),
            )
        else:
            analysis_plan = _decompose_plan(
                augmented, llm_client, compact_schema, column_matches,
                memory_store=memory_store, session_id=session_id,
            )

    # Assemble system prompt
    system_prompt = _build_system_prompt(
        compact_schema=compact_schema,
        parquet_stems=parquet_stems,
        skills_context=skills_context,
        analysis_plan=analysis_plan,
        memory_store=memory_store,
        session_id=session_id,
        column_matches=column_matches,
        cte_graph_context=cte_match.prompt_context,
    )

    return PreloopResult(
        original_query=query,
        augmented_query=augmented,
        analysis_plan=analysis_plan,
        column_matches=column_matches,
        cte_match=cte_match,
        compact_schema=compact_schema,
        parquet_stems=parquet_stems,
        system_prompt=system_prompt,
    )


# ── Helpers (1:1 ports of flows/agent_flow.py) ──────────────────────────────


def _resolve_parquet_dir(preloop_cfg: Dict[str, Any]) -> Path:
    cfg_path = (preloop_cfg.get("dto_cache") or {}).get("parquet_dir")
    if cfg_path:
        return Path(cfg_path)
    try:
        from config import get_settings
        settings = get_settings()
        return Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")
    except Exception:
        return Path("data/parquet")


def _ensure_dto_cache(parquet_dir: Path) -> str:
    try:
        from flows.dto_cache_flow import get_compact_schema, get_dto_cache, run_dto_cache_flow
    except Exception as exc:
        logger.warning("dto_cache_flow unavailable: %s", exc)
        return _build_fallback_schema(parquet_dir)

    try:
        if not get_dto_cache():
            logger.info("DTO cache empty — running dto_cache_flow to populate it")
            run_dto_cache_flow(str(parquet_dir))
        schema = get_compact_schema(parquet_dir)
    except Exception as exc:
        logger.warning("DTO cache warm-up failed: %s", exc)
        schema = ""

    if not schema:
        schema = _build_fallback_schema(parquet_dir)
    return schema


def _build_fallback_schema(parquet_dir: Path) -> str:
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return ""

    parquet_files = sorted(parquet_dir.glob("*.parquet"))
    data_files = [
        f for f in parquet_files
        if not f.stem.endswith(("_embeddings", "_distinct"))
    ]
    if not data_files:
        return "(No parquet data files found)"

    lines: List[str] = []
    for pf_path in data_files:
        try:
            pf = pq.ParquetFile(pf_path)
            schema = pf.schema_arrow
            lines.append(f"### {pf_path.stem} → read_parquet('{pf_path}')")
            lines.append(f"Rows: {pf.metadata.num_rows:,}")
            for i in range(len(schema)):
                f = schema.field(i)
                lines.append(f"  - {f.name} ({f.type})")
            lines.append("")
        except Exception as exc:
            logger.warning("Could not read parquet metadata for %s: %s", pf_path, exc)
    return "\n".join(lines)


def _list_parquet_files(parquet_dir: Path) -> List[str]:
    return sorted(
        f.stem for f in parquet_dir.glob("*.parquet")
        if not f.stem.endswith(("_embeddings", "_distinct"))
    )


def _active_source_stem() -> str:
    """Parquet stem of the active skill's bound source, or '' when unbound."""
    try:
        from services.cte_graph.repository import get_active_cte_source

        src = get_active_cte_source()
    except Exception:
        return ""
    if not src:
        return ""
    parquet_source, source_view = src
    if parquet_source:
        return Path(parquet_source).stem
    return (source_view or "").strip()


def _scope_schema_to_source(compact_schema: str, stem: str) -> str:
    """Keep only the ``### <stem> → …`` section(s) of *compact_schema*.

    Returns '' when nothing matches so the caller keeps the full schema.
    """
    if not compact_schema or not stem:
        return ""
    blocks = re.split(r"(?m)(?=^### )", compact_schema)
    kept = [b for b in blocks if b.lstrip().startswith(f"### {stem}")]
    return "".join(kept).strip()


def _schema_from_parquet(parquet_dir: Path, stem: str) -> str:
    """Build a compact schema block for a single parquet (no DTO required)."""
    try:
        import pyarrow.parquet as pq
    except ImportError:
        return ""
    path = parquet_dir / f"{stem}.parquet"
    if not path.exists():
        return ""
    try:
        pf = pq.ParquetFile(path)
        schema = pf.schema_arrow
        lines = [f"### {stem} → read_parquet('{path}')", f"Rows: {pf.metadata.num_rows:,}"]
        for i in range(len(schema)):
            field = schema.field(i)
            lines.append(f"  - {field.name} ({field.type})")
        return "\n".join(lines)
    except Exception as exc:
        logger.warning("Could not build parquet schema for %s: %s", stem, exc)
        return ""


def _search_embeddings_for_columns(
    query: str,
    parquet_dir: Path,
    *,
    threshold: float,
    top_k_per_column: int,
) -> Dict[str, List[Dict[str, Any]]]:
    try:
        import json as _json
        import numpy as np
        from nodes.dataloader.embedding_parquet_rows import (
            iter_embedding_parquet_rows,
            normalize_embedding_vectors_payload,
        )
        from nodes.dataloader.semantic_search_node import _best_similarity
    except Exception as exc:
        logger.warning("Embedding column search unavailable: %s", exc)
        return {}

    distinct_files = sorted(parquet_dir.glob("*_distinct.parquet"))
    embeddings_files = sorted(parquet_dir.glob("*_embeddings.parquet"))
    seen: set = set()
    files: List[Path] = []
    for f in distinct_files:
        seen.add(f.stem.removesuffix("_distinct"))
        files.append(f)
    for f in embeddings_files:
        if f.stem.removesuffix("_embeddings") not in seen:
            files.append(f)

    if not files:
        return {}

    try:
        from services.embedding_model_provider import get_embedding_model
        model = get_embedding_model()
    except Exception as exc:
        logger.warning("Could not load embedding model: %s", exc)
        return {}

    q_vec = np.asarray(model.encode(query, show_progress_bar=False), dtype=np.float32)

    all_matches: List[Dict[str, Any]] = []
    for fpath in files:
        source = fpath.stem.removesuffix("_distinct").removesuffix("_embeddings")
        for col, val, defs_json, emb_json in iter_embedding_parquet_rows(fpath):
            vectors = normalize_embedding_vectors_payload(emb_json)
            if not vectors:
                continue
            score = _best_similarity(q_vec, vectors)
            if score < threshold:
                continue
            try:
                definitions = _json.loads(defs_json) if isinstance(defs_json, str) else (defs_json or [])
            except (ValueError, TypeError):
                definitions = []
            def_text = definitions[0] if isinstance(definitions, list) and definitions else ""
            all_matches.append({
                "column_name": col,
                "value": val,
                "definition": def_text,
                "score": round(float(score), 4),
                "source": source,
            })

    grouped: Dict[str, List[Dict[str, Any]]] = {}
    all_matches.sort(key=lambda m: m["score"], reverse=True)
    for m in all_matches:
        col = m["column_name"]
        if col not in grouped:
            grouped[col] = []
        if len(grouped[col]) < top_k_per_column:
            grouped[col].append(m)

    total = sum(len(v) for v in grouped.values())
    logger.info(
        "Embedding column search: %d matches across %d columns (threshold=%.2f)",
        total, len(grouped), threshold,
    )
    return grouped


def _format_column_matches(column_matches: Dict[str, List[Dict[str, Any]]]) -> str:
    if not column_matches:
        return ""
    lines: List[str] = []
    for col, matches in column_matches.items():
        source = matches[0]["source"] if matches else ""
        lines.append(f"### Column: {col}  (source: {source})")
        for m in matches:
            lines.append(f"- SQL_VALUE: '{m['value']}'  (confidence: {m['score']})")
            if m.get("definition"):
                lines.append(f"  meaning: {m['definition']}")
        lines.append("")
    return "\n".join(lines)


def _format_recent_turns(memory_store: Any, session_id: Optional[str],
                        *, max_turns: int = 6, max_chars_per_msg: int = 600) -> str:
    if not memory_store or not session_id:
        return ""
    try:
        session = memory_store.get(session_id)
    except Exception:
        return ""
    if session is None or not getattr(session, "short_term", None):
        return ""
    recent = session.short_term[-max_turns:]
    lines: List[str] = []
    for msg in recent:
        content = (getattr(msg, "content", "") or "").strip().replace("\n", " ")
        if len(content) > max_chars_per_msg:
            content = content[:max_chars_per_msg] + "…"
        if content:
            lines.append(f"[{msg.role.upper()}] {content}")
    summary = (getattr(session, "running_summary", "") or "").strip()
    if not lines and not summary:
        return ""
    parts: List[str] = []
    if summary:
        parts.append("CONVERSATION SUMMARY (older turns):")
        parts.append(summary[:1500])
        parts.append("")
    if lines:
        parts.append("RECENT TURNS (most recent last):")
        parts.extend(lines)
    return "\n".join(parts)


def _augment_query(
    query: str,
    llm_client: BaseLLM,
    compact_schema: str,
    parquet_stems: List[str],
    *,
    memory_store: Any = None,
    session_id: Optional[str] = None,
) -> str:
    try:
        from prompt_loader import render_template
        from utils.call_llm_with_tools import call_llm_with_tools
    except Exception as exc:
        logger.warning("Augmentation helpers unavailable: %s", exc)
        return query

    source_list = "\n".join(f"- {s}" for s in parquet_stems) if parquet_stems else "(none loaded)"
    augment_prompt = render_template(
        "agent", "query_augmentation",
        query=query, source_list=source_list, compact_schema=compact_schema[:3000],
    )
    recent = _format_recent_turns(memory_store, session_id)
    if recent:
        augment_prompt = (
            "PRIOR CONVERSATION (use only to resolve references in the new query):\n"
            f"{recent}\n\n"
            "If the new query refers to a metric, period, or entity that was "
            "discussed above, expand the reference explicitly in ENHANCED_QUERY. "
            "If the new query is unrelated, ignore the prior conversation.\n\n"
            f"{augment_prompt}"
        )

    try:
        resp = call_llm_with_tools(
            messages=[{"role": "user", "content": augment_prompt}],
            tools=[], llm_client=llm_client, task="agent",
        )
        text = resp.content or ""
        match = re.search(r"ENHANCED[_ ]?QUERY\s*[:：]\s*(.+)", text, re.IGNORECASE | re.DOTALL)
        if match:
            enhanced = match.group(1).strip().strip('"\'«»')
            if len(enhanced) > 20:
                logger.info("Query augmented: %s", enhanced[:120])
                return enhanced
    except Exception as exc:
        logger.warning("Query augmentation failed, using original: %s", exc)
    return query


def _decompose_plan(
    query: str,
    llm_client: BaseLLM,
    compact_schema: str,
    column_matches: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    *,
    memory_store: Any = None,
    session_id: Optional[str] = None,
) -> str:
    try:
        from prompt_loader import render_template
        from utils.call_llm_with_tools import call_llm_with_tools
    except Exception as exc:
        logger.warning("Plan decomposition helpers unavailable: %s", exc)
        return ""

    matched_section = ""
    if column_matches:
        matched_section = (
            "\n\nPRE-RESOLVED VALUES FROM EMBEDDING SEARCH:\n"
            + _format_column_matches(column_matches)
            + "\nIMPORTANT: The SQL_VALUE entries above are the EXACT strings to use in "
            "WHERE clauses. The 'meaning' lines are descriptions — NEVER use them in SQL. "
            "NEVER use ILIKE or LIKE — always use `=` with the exact SQL_VALUE."
        )

    plan_prompt = render_template(
        "agent", "plan_decomposition",
        query=query, compact_schema=compact_schema[:3000], matched_section=matched_section,
    )
    recent = _format_recent_turns(memory_store, session_id)
    if recent:
        plan_prompt = (
            "PRIOR CONVERSATION (use only when the new query builds on it):\n"
            f"{recent}\n\n{plan_prompt}"
        )

    try:
        resp = call_llm_with_tools(
            messages=[{"role": "user", "content": plan_prompt}],
            tools=[], llm_client=llm_client, task="agent",
        )
        text = resp.content or ""
        steps = re.findall(r"STEP\s+\d+\s*[:：]\s*(.+)", text, re.IGNORECASE)
        if steps:
            plan = "\n".join(f"{i+1}. {s.strip()}" for i, s in enumerate(steps))
            logger.info("Decomposed query into %d steps", len(steps))
            return plan
    except Exception as exc:
        logger.warning("Plan decomposition failed: %s", exc)
    return ""


def _build_system_prompt(
    *,
    compact_schema: str,
    parquet_stems: List[str],
    skills_context: str,
    analysis_plan: str,
    memory_store: Any,
    session_id: str,
    column_matches: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    cte_graph_context: str = "",
) -> str:
    try:
        from prompt_loader import load_template
        base = load_template("agent", "system_prompt")
    except Exception:
        base = ""

    parts: List[str] = [base] if base else []

    # Guarantee the MAD currency/format rule even if the base template (which
    # already carries it) failed to load — the agent must ALWAYS present money
    # in MAD. This is a deployment-wide convention, not a domain assumption.
    if not base:
        parts.append(
            "\n## Format monétaire (OBLIGATOIRE)\n"
            "- Tous les montants monétaires sont en **MAD (Dirham marocain)**, format "
            "« 1 234 567,89 MAD » (espace = séparateur de milliers, 2 décimales), "
            "sauf si l'utilisateur demande explicitement une autre devise."
        )

    # ── Final-answer presentation (table + analysis) ────────────────────────
    # Every data answer must surface the figures in a Markdown table AND an
    # explicit analysis, so the user gets both the numbers and their meaning.
    parts.append(
        "\n## Présentation de la réponse finale (OBLIGATOIRE)\n"
        "RÉPONDS DROIT AU BUT, STRICTEMENT dans la portée de la question. Ne donne "
        "QUE la dimension et la période demandées ; n'ajoute AUCUNE autre dimension, "
        "période ou comparaison que l'utilisateur n'a pas demandée.\n"
        "- Question à valeur unique (ex. « le chiffre d'affaires 2025 ») → réponds "
        "en UNE phrase directe contenant le chiffre TOTAL demandé (ou un petit "
        "tableau « Indicateur | Valeur » de 1 ligne) + au plus une phrase de "
        "contexte. NE ventile PAS par produit / branche / année si ce n'est pas "
        "demandé, et NE montre PAS d'autres années.\n"
        "- Question demandant une ventilation (ex. « CA par branche », « par mois », "
        "« évolution ») → tableau Markdown des lignes demandées + 2 à 4 phrases "
        "d'analyse ciblée sur ce qui est demandé.\n"
        "- GRAPHIQUE : quand la réponse est une ventilation comparable (≥ 2 "
        "catégories/périodes avec une mesure numérique), émets D'ABORD un bloc "
        "`<BAR>…</BAR>` contenant UNE seule ligne de JSON (remplacé par un "
        "graphique à barres dans l'interface ; n'ajoute ni titre « Graphique » ni "
        "bloc de code ``` autour) : "
        "<BAR>{\"title\":\"<titre court>\",\"x\":[\"<cat1>\",\"<cat2>\"],"
        "\"series\":[{\"name\":\"<mesure>\",\"data\":[<n1>,<n2>]}],\"unit\":\"MAD\"}</BAR>. "
        "`x` = libellés (mêmes que le tableau, même ordre) ; `data` = valeurs "
        "numériques BRUTES (sans espaces ni « MAD », point décimal). N'émets AUCUN "
        "bloc pour une valeur unique ou si la comparaison visuelle n'apporte rien.\n"
        "Choisis la CTE dont la PORTÉE correspond exactement à la question (un total "
        "annuel → la CTE de total par année filtrée sur l'année ; une ventilation → "
        "la CTE ventilée). Ne réutilise pas une CTE qui ajoute des dimensions non "
        "demandées. Montants en MAD « 1 234 567,89 MAD ». Base-toi STRICTEMENT sur "
        "les données exécutées — n'invente aucune valeur."
    )

    # ── Mandatory CTE-only operating policy (highest priority) ──────────────
    # The agent answers EXCLUSIVELY through the accounting-CTE library
    # (embedded graphs under data/cte_graphs / data/reporting/sql). It must
    # execute a retrieved CTE with its parents, create + persist a new CTE on a
    # miss, and NEVER write generic ad-hoc SQL.
    parts.append(
        "\n## POLITIQUE CTE OBLIGATOIRE (PRIORITÉ ABSOLUE)\n"
        "Vous répondez EXCLUSIVEMENT via la bibliothèque de CTE comptables "
        "(graphes embarqués sous `data/cte_graphs` / `data/reporting/sql`). "
        "Workflow IMPOSÉ, sans exception :\n"
        "1. Les CTE pertinentes ont déjà été retrouvées par **similarité "
        "d'embeddings** (section « Relevant accounting CTEs » plus bas). Si une "
        "CTE correspond à la question, APPELEZ immédiatement "
        "`execute_accounting_cte(cte_name=...)` : ses CTE **parentes** "
        "(`depends_on`) sont injectées et exécutées automatiquement.\n"
        "2. Vous pouvez d'abord `read_accounting_cte` pour vérifier le calcul et "
        "`list_accounting_ctes` pour confirmer le nom exact.\n"
        "3. Si AUCUNE CTE n'existe pour la question : CONCEVEZ-en une nouvelle en "
        "réutilisant les CTE existantes (`{{include: nom_cte}}`) puis "
        "ENREGISTREZ-la avec `save_accounting_cte` (exécution immédiate par "
        "défaut). Elle devient ainsi RÉUTILISABLE pour les prochaines questions.\n"
        "4. INTERDICTION ABSOLUE d'écrire du SQL générique ou ad hoc hors "
        "bibliothèque. L'outil `sql_query` n'est PAS disponible. Toute donnée "
        "chiffrée DOIT provenir d'une CTE de la bibliothèque — existante "
        "(exécutée) ou nouvellement enregistrée.\n"
        "`semantic_search`, `list_tables` et `describe_table` servent UNIQUEMENT "
        "à grounder la conception d'une CTE (valeurs exactes, colonnes, types) ; "
        "ils ne produisent jamais la réponse finale."
    )

    if parquet_stems:
        file_list = "\n".join(f"- data/parquet/{s}.parquet" for s in parquet_stems)
        parts.append(f"\n## Available Parquet Files\n{file_list}")

    if compact_schema:
        parts.append(f"\n## Data Schema (columns, types, tags)\n{compact_schema}")
        parts.append(
            "\n**Présentation des dimensions :** lorsqu'une dimension possède à la fois "
            "une colonne de **code** technique et une colonne de **libellé** lisible, "
            "afficher le libellé (et non le code) dans les réponses finales. Les noms de "
            "colonnes concrets proviennent du schéma ci-dessus et des compétences métier."
        )
    else:
        parts.append(
            "\n## Data Schema\nNo schema loaded. "
            "Use `list_tables` and `describe_table` to discover available data."
        )

    if column_matches:
        parts.append(
            "\n## Pre-resolved Column Matches (use these in SQL)\n"
            "Embedding search already resolved these categorical values for your query.\n"
            "**Rules:**\n"
            "- Copy the `SQL_VALUE` strings exactly into `WHERE column = 'SQL_VALUE'`.\n"
            "- The `meaning` lines explain what the value represents — NEVER use them in SQL.\n"
            "- NEVER use ILIKE/LIKE to fuzzy-match definitions or descriptions.\n\n"
            + _format_column_matches(column_matches)
        )

    if analysis_plan:
        parts.append(f"\n## Analysis Plan (follow these steps)\n{analysis_plan}")

    if cte_graph_context:
        parts.append(
            "\n## Relevant accounting CTEs (semantic retrieval)\n"
            "These CTE names were retrieved by **embedding similarity** to the user "
            "question from the CTE graphs. You MUST act on them:\n"
            "- Pick the best-matching CTE and call `execute_accounting_cte(cte_name=...)`; "
            "its parent CTEs (`depends_on`) run automatically.\n"
            "- If NONE truly fits, design a new CTE (reusing these via "
            "`{{include: ...}}`) and persist it with `save_accounting_cte` so it is "
            "reusable next time. Do NOT fall back to generic SQL.\n\n"
            + cte_graph_context
        )
    else:
        parts.append(
            "\n## Aucune CTE retrouvée par embedding\n"
            "La recherche sémantique n'a renvoyé aucune CTE au-dessus du seuil. "
            "CONSULTEZ `list_accounting_ctes` pour vérifier le catalogue ; si rien "
            "ne convient, CONCEVEZ puis ENREGISTREZ une nouvelle CTE avec "
            "`save_accounting_cte` (réutilisation future). N'écrivez JAMAIS de SQL "
            "générique."
        )

    if skills_context:
        parts.append(
            "\n## Expertise métier (formules & règles — BASE pour CONCEVOIR les CTE)\n"
            "Ces compétences décrivent les formules, définitions et règles de "
            "calcul des indicateurs. Elles font autorité. UTILISEZ-LES pour :\n"
            "- résoudre un sigle ou un indicateur métier en sa définition / formule "
            "exacte, telle que fournie par les compétences ci-dessous ;\n"
            "- CONCEVOIR une nouvelle CTE (`save_accounting_cte`) qui implémente "
            "cette formule quand la bibliothèque n'en contient pas encore une ;\n"
            "- choisir les bonnes colonnes/mesures et la bonne granularité.\n"
            "Ne demandez un paramètre à l'utilisateur (ex. taux moyen) que s'il "
            "est indispensable et introuvable dans les données.\n\n"
            + skills_context
        )

    if memory_store:
        try:
            session = memory_store.get_or_create(session_id)
            if getattr(session, "running_summary", ""):
                parts.append(f"\n## Conversation Summary\n{session.running_summary}")
            entity_text = session.entities.to_text() if hasattr(session, "entities") else ""
            if entity_text:
                parts.append(f"\n## Known Entities\n{entity_text}")
            last_result = session.get_last_result() if hasattr(session, "get_last_result") else None
            if last_result and last_result.get("text"):
                parts.append(f"\n## Prior Query Context\n{last_result['text']}")
        except Exception:
            pass

    # Anti-hallucination guard — mirrors cte_retriever.build_no_data_refusal contract.
    parts.append(
        "\n## Data integrity rules (MANDATORY)\n"
        "- Answer ONLY through the accounting-CTE library: execute an existing CTE "
        "(with its parents) or create + persist a new one. NEVER write generic, "
        "ad-hoc SQL outside the library.\n"
        "- NEVER fabricate numbers, rows, or column values. Every figure in your answer "
        "must come from a CTE execution result that you can cite.\n"
        "- If a CTE returns zero rows, you MUST refuse with the configured no-data "
        "message; do NOT invent placeholder data.\n"
        "- If the CTE library lacks a relevant CTE AND CTE creation also fails to "
        "produce data, refuse and ask the user to clarify."
    )

    return "\n".join(parts)
