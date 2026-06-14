"""Fast-path: execute an already-identified library CTE directly.

When a user query maps with high confidence to an existing library CTE
(e.g. ``"donne le pnb"`` → ``pnb_total``), running the full agent pipeline
wastes several **sequential** LLM round-trips on a decision that is, in
practice, already made:

    run_preloop:  query_augmentation (LLM)  ─┐
                  embedding_column_search    │  all run even though the
                  cte_retrieval (~10 ms hit) │  matching CTE is already known
                  plan_decomposition (LLM)  ─┘
    AgentExecutor loop:  decide-tool (LLM) → execute_accounting_cte → final (LLM)

For a query whose CTE is already in the library that is ~4 LLM calls before
the answer streams. This module short-circuits all of it:

    1. Identify the CTE with the existing :func:`search_or_create_cte`
       (cheap semantic search over the cached library graph, ~10 ms, no LLM).
    2. Fire it through the existing repository executor
       (:func:`execute_accounting_cte_structured`) — the same code path the
       ``execute_accounting_cte`` tool uses, with full parent-closure assembly.
    3. Stream a concise, grounded answer with a **single** streamed LLM call.

It NEVER fabricates data: the answer is generated strictly from the CTE's
execution rows, and the function returns ``None`` — so the caller falls back
to the full agent — whenever the match is weak, execution fails, or no rows
come back. The full agent retains its create-on-miss / no-data-refusal
behaviour for those cases.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, Sequence

from agent.config import get_section
from agent.cte_retriever import search_or_create_cte

logger = logging.getLogger(__name__)

StreamCallback = Callable[[str, str, Optional[dict]], None]

_DEFAULT_MAX_ROWS = 200
_DEFAULT_SUMMARY_MAX_ROWS = 30


# ── Config ───────────────────────────────────────────────────────────────────


def _fast_path_cfg() -> Dict[str, Any]:
    """Read the ``cte.fast_path`` config block with sensible defaults.

    ``threshold`` defaults to the semantic-search threshold so the fast path
    triggers exactly when the library considers a CTE a confident match.
    """
    cte_cfg = get_section("cte") or {}
    fp = cte_cfg.get("fast_path") or {}
    sem_threshold = float((cte_cfg.get("semantic_search") or {}).get("threshold", 0.55))
    return {
        "enabled": bool(fp.get("enabled", True)),
        "threshold": float(fp.get("threshold", sem_threshold)),
        "max_rows": int(fp.get("max_rows", _DEFAULT_MAX_ROWS)),
        "summary_max_rows": int(fp.get("summary_max_rows", _DEFAULT_SUMMARY_MAX_ROWS)),
        "summarize": str(fp.get("summarize", "llm")).strip().lower(),
        # Verify the candidate CTE matches the query's requested breakdown
        # before reusing it (one cheap LLM yes/no call). Default on.
        "verify": bool(fp.get("verify", True)),
    }


def _answers_requested_breakdown(query: str, cte_name: str, hit: Dict[str, Any]) -> bool:
    """Return True iff CTE *cte_name* produces the breakdown *query* asks for.

    A single cheap LLM yes/no check that compares the query's requested grouping
    dimension against the CTE's projected columns + description. Fails CLOSED
    (returns False) on any error so a mismatched CTE is never silently executed.
    """
    description = str(hit.get("description") or "").strip()
    projects = hit.get("projects") or []
    raw_sql = str(hit.get("rawSql") or "").strip()
    # The GROUP BY in the SQL is the most reliable signal of the breakdown
    # dimension, so always enrich from the repository to get it.
    try:
        from services.cte_graph.repository import get_repository

        meta = get_repository().get_cte(cte_name) or {}
        description = description or str(meta.get("description") or "").strip()
        projects = projects or (meta.get("projects") or [])
        raw_sql = raw_sql or str(meta.get("rawSql") or "").strip()
    except Exception:
        pass

    prompt = (
        f"Question de l'utilisateur : {query}\n\n"
        f"CTE candidate « {cte_name} » :\n"
        f"- colonnes produites : {', '.join(str(p) for p in projects) or '(inconnues)'}\n"
        f"- description : {description or '(non disponible)'}\n"
        f"- SQL : {raw_sql or '(non disponible)'}\n\n"
        "Vérifie si cette CTE renvoie EXACTEMENT ce que demande la question — ni "
        "plus, ni moins — en regardant ses DIMENSIONS de regroupement (GROUP BY).\n\n"
        "Distingue :\n"
        "- FILTRE = restreint les lignes (une année « 2025 », un statut, une "
        "catégorie précise). Une année / période est TOUJOURS un filtre, jamais une "
        "ventilation.\n"
        "- VENTILATION = une dimension par laquelle les résultats sont DÉCOMPOSÉS et "
        "listés (par branche, par produit, par intermédiaire, par mois si une "
        "évolution est demandée…).\n\n"
        "Décision :\n"
        "1. Repère la/les VENTILATION(S) demandée(s). Une question de TOTAL / chiffre "
        "global (« donne le chiffre d'affaires 2025 », « le CA total ») ne demande "
        "AUCUNE ventilation.\n"
        "2. NON si la CTE AJOUTE au moins une dimension de ventilation NON demandée "
        "(ex. question « CA 2025 » → une CTE « par produit » ou « par branche » ajoute "
        "une ventilation non demandée).\n"
        "3. NON si la question demande une ventilation par X mais la CTE ne la fournit "
        "pas (ou ventile par une autre dimension).\n"
        "4. Sinon OUI. Une CTE « total par année » paramétrée sur l'année convient "
        "PARFAITEMENT pour « le CA de telle année » (l'année est un filtre, pas une "
        "ventilation supplémentaire).\n\n"
        "Réponds par un seul mot : OUI ou NON."
    )
    try:
        from llm.llm_factory import create_client_for_task

        client = create_client_for_task("agent")
        resp = client.generate(prompt, system=None, max_tokens=4, temperature=0.0)
        verdict = (getattr(resp, "content", "") or "").strip().upper()
        ok = verdict.startswith("OUI") or verdict.startswith("YES")
        if not ok:
            logger.info("Fast-path verify: %s → %r (decline)", cte_name, verdict[:20])
        return ok
    except Exception as exc:
        logger.warning("Fast-path verify failed for %s (%s) — declining", cte_name, exc)
        return False


def _cte_parameters(cte_name: str, hit: Dict[str, Any]) -> List[str]:
    """Declared `$param` names of a CTE (from the hit, falling back to the repo)."""
    params = list(hit.get("parameters") or [])
    if params:
        return [str(p) for p in params]
    try:
        from services.cte_graph.repository import get_repository

        meta = get_repository().get_cte(cte_name) or {}
        return [str(p) for p in (meta.get("parameters") or [])]
    except Exception:
        return []


def _extract_cte_params(
    query: str, cte_name: str, param_names: Sequence[str], hit: Dict[str, Any]
) -> Optional[Dict[str, Any]]:
    """Extract ``{param: value}`` from *query* for a parameterized CTE (one cheap LLM call).

    Returns the full mapping on success, or ``None`` if any parameter cannot be
    resolved from the query — in which case the fast path defers to the full
    agent (which can bind tool parameters itself). Fails CLOSED on any error.
    """
    if not param_names:
        return {}
    raw_sql = str(hit.get("rawSql") or "").strip()
    description = str(hit.get("description") or "").strip()
    try:
        from services.cte_graph.repository import get_repository

        meta = get_repository().get_cte(cte_name) or {}
        raw_sql = raw_sql or str(meta.get("rawSql") or "").strip()
        description = description or str(meta.get("description") or "").strip()
    except Exception:
        pass

    prompt = (
        f"Question de l'utilisateur : {query}\n\n"
        f"CTE paramétré « {cte_name} » — SQL :\n{raw_sql or '(non disponible)'}\n"
        f"Description : {description or '(non disponible)'}\n\n"
        f"Extrais depuis la QUESTION la valeur de chaque paramètre : {list(param_names)}.\n"
        "Réponds STRICTEMENT en JSON {\"param\": valeur}. Utilise un nombre pour les "
        "années/exercices (ex: 2026), une chaîne exacte pour les libellés/catégories "
        "(ex: \"RC A.V.A\"). Si une valeur n'est PAS présente dans la question, mets null."
    )
    try:
        import json
        import re as _re

        from llm.llm_factory import create_client_for_task

        client = create_client_for_task("agent")
        resp = client.generate(
            prompt, system="Réponds uniquement en JSON.", max_tokens=200, temperature=0.0
        )
        content = (getattr(resp, "content", "") or "").strip()
        m = _re.search(r"\{.*\}", content, _re.S)
        data = json.loads(m.group(0)) if m else {}
    except Exception as exc:
        logger.warning("Fast-path param extraction failed for %s (%s) — deferring", cte_name, exc)
        return None

    out: Dict[str, Any] = {}
    unresolved: List[str] = []
    for p in param_names:
        key = str(p).lstrip("$")
        val = data.get(key, data.get(p))
        if val is None:
            unresolved.append(key)
        else:
            out[key] = val

    # Period anchors the question left implicit — a *relative* window like
    # "12 derniers mois", "récemment", or no period at all — default to the
    # LATEST period present in the data. This is exactly what the full agent
    # does (it explores the source to find the most recent period first), so
    # the fast path stays faithful while skipping that exploration.
    if unresolved:
        recovered = _resolve_period_anchors_from_data(unresolved, raw_sql, out, query)
        out.update(recovered)
        for key in unresolved:
            if key not in out:
                logger.info("Fast-path: param %r unresolved for %s — deferring", key, cte_name)
                return None
    return out


def _resolve_period_anchors_from_data(
    param_names: Sequence[str], raw_sql: str, known: Dict[str, Any], query: str = ""
) -> Dict[str, Any]:
    """Resolve unresolved ``$year`` / ``$month`` *period-anchor* params to the
    latest period in the active source.

    Domain-agnostic: each param's column is inferred from the SQL (the column it
    is compared against, e.g. ``EXERSTAT = $annee_fin`` → ``EXERSTAT``), and
    year-vs-month is classified by magnitude (a ``MAX`` ≤ 12 is a month). The
    month is anchored *inside* the latest year (the overall max month can differ
    from the max month of the most recent year). Returns ``{param: value}`` only
    for params it can confidently resolve; anything else is left for the caller
    to defer on.
    """
    import re as _re

    if not raw_sql or not param_names:
        return {}

    # 1. Map each param to the column it is compared against in the SQL.
    param_col: Dict[str, str] = {}
    for key in param_names:
        pat = _re.escape("$" + key)
        cols = _re.findall(r"([A-Za-z_]\w*)\s*(?:<=|>=|=|<|>)\s*" + pat, raw_sql)
        cols += _re.findall(pat + r"\s*(?:<=|>=|=|<|>)\s*([A-Za-z_]\w*)", raw_sql)
        cols = [c for c in cols if c and not c.isdigit() and c.upper() not in {"AND", "OR", "NULL"}]
        if cols:
            param_col[key] = max(set(cols), key=cols.count)
    if not param_col:
        return {}

    # 2. Resolve the source view + MAX of each referenced column.
    try:
        from services.cte_graph.repository import get_repository

        repo = get_repository()
        view = (repo.source_view() or "").strip()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Fast-path period anchor: no source view (%s)", exc)
        return {}
    if not view:
        return {}

    def _scalar(sql: str) -> Optional[int]:
        try:
            res = repo.execute(sql=sql, max_rows=1)
            rows = res.get("rows") or []
            if not rows:
                return None
            v = list(rows[0].values())[0]
            return int(v) if v is not None else None
        except Exception as exc:
            logger.warning("Fast-path period-anchor query failed (%s): %s", sql, exc)
            return None

    col_max: Dict[str, int] = {}
    for col in sorted(set(param_col.values())):
        m = _scalar(f"SELECT MAX({col}) AS m FROM {view}")
        if m is not None:
            col_max[col] = m

    # 3. Classify year (MAX > 12) vs month (1..12).
    year_cols = [c for c, m in col_max.items() if m > 12]
    month_cols = [c for c, m in col_max.items() if 1 <= m <= 12]
    latest_year = col_max[year_cols[0]] if year_cols else None

    # An EXPLICIT year in the question (« le CA 2025 ») wins over the latest-year
    # default — only relative windows (« 12 derniers mois », no period) fall back
    # to the most recent period. Anchor any month inside that chosen year.
    _ym = _re.search(r"\b(?:19|20)\d{2}\b", query or "")
    explicit_year = int(_ym.group(0)) if _ym else None
    anchor_year = explicit_year if explicit_year is not None else latest_year

    month_in_year: Dict[str, int] = {}
    if month_cols and year_cols and anchor_year is not None:
        ycol = year_cols[0]
        for mcol in month_cols:
            mm = _scalar(f"SELECT MAX({mcol}) AS m FROM {view} WHERE {ycol} = {anchor_year}")
            if mm is not None:
                month_in_year[mcol] = mm

    resolved: Dict[str, Any] = {}
    for key, col in param_col.items():
        if col in year_cols and anchor_year is not None:
            resolved[key] = anchor_year
        elif col in month_in_year:
            resolved[key] = month_in_year[col]
        elif col in col_max:
            resolved[key] = col_max[col]  # fallback: plain MAX
    if resolved:
        logger.info("Fast-path: resolved period anchors from data → %s", resolved)
    return resolved


# ── Public entrypoint ──────────────────────────────────────────────────────────


def run_cte_fast_path(
    query: str,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    stream_callback: Optional[StreamCallback] = None,
) -> Optional[Dict[str, Any]]:
    """Try to answer *query* by directly executing an already-identified CTE.

    Returns a result dict with the same shape as
    :func:`agent.langchain_agent.run_brikz_agent` on success, or ``None`` when
    the fast path does not apply (weak match, execution error, or zero rows) so
    the caller can fall back to the full agent.

    When *stream_callback* is provided it receives ``(event, message, data)``
    tuples compatible with the ``/chat/`` SSE contract: a ``tool_start`` /
    ``tool_result`` pair around the CTE execution, then ``llm_token`` events as
    the answer streams.
    """
    cfg = _fast_path_cfg()
    if not cfg["enabled"]:
        return None

    q = (query or "").strip()
    if not q:
        return None

    # 1. Identify the CTE — cheap semantic search on the raw query (no LLM,
    #    no augmentation). create_on_miss=False keeps this read-only and fast.
    match = search_or_create_cte(augmented_query=q, original_query=q, create_on_miss=False)

    emit = stream_callback if callable(stream_callback) else None
    return _execute_matched_cte(
        q, match, cfg, session_id=session_id, memory_store=memory_store, emit=emit
    )


def run_cte_fast_path_for_match(
    query: str,
    match: Any,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    stream_callback: Optional[StreamCallback] = None,
) -> Optional[Dict[str, Any]]:
    """Fast-path execution for an **already-resolved** CTE match.

    The plain :func:`run_cte_fast_path` searches the *raw* query, which often
    scores just under threshold for conversational questions (e.g.
    ``"Y a-t-il des intermédiaires sous-performants…"`` → 0.50 < 0.55). The
    full agent's pre-loop then **augments** the query (grounding it in real
    column names) and re-runs the same library search, which scores far higher
    (≈0.82). This entrypoint lets the caller reuse that augmented, high-confidence
    :class:`~agent.cte_retriever.CTEMatch` to execute the CTE directly — skipping
    the expensive plan/sub-agent/tool-calling loop — instead of throwing the
    augmentation work away.

    Returns the same result-dict shape as :func:`run_cte_fast_path` on success,
    or ``None`` (so the caller falls back to the full agent loop) when the match
    is weak, the breakdown doesn't fit, params can't be bound, or execution
    yields no rows.
    """
    cfg = _fast_path_cfg()
    if not cfg["enabled"]:
        return None
    q = (query or "").strip()
    if not q or match is None:
        return None
    emit = stream_callback if callable(stream_callback) else None
    return _execute_matched_cte(
        q, match, cfg, session_id=session_id, memory_store=memory_store, emit=emit
    )


def _execute_matched_cte(
    q: str,
    match: Any,
    cfg: Dict[str, Any],
    *,
    session_id: str,
    memory_store: Any,
    emit: Optional[StreamCallback],
) -> Optional[Dict[str, Any]]:
    """Verify → bind params → execute → summarize a resolved CTE match.

    Shared by :func:`run_cte_fast_path` (raw-query search) and
    :func:`run_cte_fast_path_for_match` (pre-augmented search). Returns the
    result dict on success or ``None`` to defer to the full agent.
    """
    if not getattr(match, "found", False) or not getattr(match, "hits", None):
        return None

    if float(match.hits[0].get("similarity_score") or 0.0) < cfg["threshold"]:
        logger.info(
            "CTE fast-path declined: best=%.3f < threshold=%.2f",
            float(match.hits[0].get("similarity_score") or 0.0), cfg["threshold"],
        )
        return None

    # Precision gate: embedding recall matches on the *metric* name ("chiffre
    # d'affaires") but is blind to the requested *breakdown dimension* — so a
    # "par branche" query can match a "par année" CTE (and vice-versa when both
    # exist). Walk the above-threshold candidates and reuse the FIRST one whose
    # breakdown the verifier confirms; if none matches, defer to the full agent.
    # Domain-agnostic: no hardcoded dimension vocabulary.
    best = None
    for hit in match.hits:
        if float(hit.get("similarity_score") or 0.0) < cfg["threshold"]:
            break  # hits are score-sorted; the rest are weaker
        name = str(hit.get("name") or hit.get("node_id") or "").strip()
        if not name:
            continue
        if not cfg["verify"] or _answers_requested_breakdown(q, name, hit):
            best = hit
            break
        logger.info("Fast-path: %s rejected by breakdown gate, trying next", name)
    if best is None:
        logger.info(
            "CTE fast-path declined: no candidate matches the requested breakdown — "
            "deferring to full agent",
        )
        return None
    score = float(best.get("similarity_score") or 0.0)
    cte_name = str(best.get("name") or best.get("node_id") or "").strip()

    # Parameterized CTE? Bind its `$param` values from the query so a single
    # generic CTE (e.g. `primes_par_categorie` with $year/$libecate) serves every
    # combination. If any value can't be resolved, defer to the full agent.
    cte_params: Dict[str, Any] = {}
    param_names = _cte_parameters(cte_name, best)
    if param_names:
        extracted = _extract_cte_params(q, cte_name, param_names, best)
        if not extracted:
            logger.info(
                "CTE fast-path declined: unresolved parameters %s for %s — deferring to full agent",
                param_names, cte_name,
            )
            return None
        cte_params = extracted

    if emit:
        param_note = f" — {cte_params}" if cte_params else ""
        emit(
            "tool_start",
            f"CTE « {cte_name} » identifiée (similarité {int(round(score * 100))} %) — exécution directe{param_note}",
            {"tool": "execute_accounting_cte", "input": {"cte_name": cte_name, "parameters": cte_params}},
        )

    # 2. Execute the CTE directly via the existing repository executor.
    tool_context: Dict[str, Any] = {}
    try:
        from tools.accounting_tools import execute_accounting_cte_structured

        result = execute_accounting_cte_structured(
            cte_name=cte_name, parameters=cte_params, max_rows=cfg["max_rows"], ctx=tool_context
        )
    except Exception as exc:
        logger.warning(
            "CTE fast-path execution failed for %s (%s) — falling back to agent",
            cte_name, exc,
        )
        return None

    cols: List[str] = result.get("columns") or []
    rows: List[Dict[str, Any]] = result.get("rows") or []
    if not rows:
        # No data: defer to the full agent, which may create a better CTE or
        # apply the configured no-data refusal. The fast path only "wins" when
        # it confidently produces grounded data.
        logger.info("CTE fast-path: %s returned 0 rows — falling back to agent", cte_name)
        return None

    if emit:
        emit(
            "tool_result",
            f"CTE « {cte_name} » exécutée ({len(rows)} ligne(s))",
            {"tool": "execute_accounting_cte", "preview": _preview(cols, rows)},
        )

    logger.info(
        "CTE fast-path HIT: %s (score=%.3f, rows=%d) — answering directly, skipping the agent loop",
        cte_name, score, len(rows),
    )

    # 3. Summarize the rows — a single (streamed) LLM call grounded on the data.
    description = str(result.get("description") or best.get("description") or "").strip()
    answer = _summarize(q, cte_name, description, cols, rows, cfg, emit)

    # 4. Persist the turn (parity with the full-agent memory bridge).
    _persist_turn(memory_store, session_id, q, answer)

    return {
        "query": q,
        "augmented_query": q,
        "analysis_plan": "",
        "cte_hit": True,
        "cte_created": None,
        "answer": answer,
        "intermediate_steps": [],
        "sql_queries": tool_context.get("sql_queries", []),
        "sql_results": tool_context.get("sql_results", []),
        "rendered_reports": [],
        "fast_path": True,
        "fast_path_cte": cte_name,
    }


# ── Summary generation ──────────────────────────────────────────────────────────


_SUMMARY_SYSTEM = (
    "Tu es Brikz, un assistant d'analyse de données financières. "
    "Réponds en français, de façon professionnelle et structurée. "
    "Tu présentes TOUJOURS les résultats chiffrés sous forme de **tableau "
    "Markdown** lisible, puis tu fournis une **analyse** des données. "
    "Tous les montants monétaires sont en MAD (Dirham marocain) : formate-les "
    "« 1 234 567,89 MAD » (espace comme séparateur de milliers, deux décimales), "
    "sauf si une autre devise est explicitement indiquée. "
    "Base-toi STRICTEMENT sur les données fournies : n'invente aucun chiffre "
    "et n'ajoute aucune donnée absente du tableau."
)


# Optional bar-chart block the LLM emits BEFORE the table when the result is a
# comparable breakdown. The brikz-frontend buffers the streamed text, pulls
# this <BAR>…</BAR> block out and renders it as an inline bar-chart card.
_BAR_CHART_INSTRUCTION = (
    "## Graphique (UNIQUEMENT si pertinent)\n"
    "Si les données sont une VENTILATION comparable (au moins 2 catégories/"
    "périodes avec une mesure numérique : par année, par branche, par produit, "
    "par mois…), émets D'ABORD un bloc `<BAR>…</BAR>` contenant UNE SEULE ligne "
    "de JSON (il sera remplacé par un graphique à barres dans l'interface — "
    "n'ajoute ni titre « Graphique », ni bloc de code ``` autour) :\n"
    "<BAR>{\"title\":\"<titre court>\",\"x\":[\"<cat1>\",\"<cat2>\"],"
    "\"series\":[{\"name\":\"<mesure>\",\"data\":[<n1>,<n2>]}],\"unit\":\"MAD\"}</BAR>\n"
    "Règles STRICTES : `x` = libellés de l'axe horizontal (les mêmes que le "
    "tableau, même ordre) ; `data` = valeurs numériques BRUTES, dans le même "
    "ordre que `x` (PAS d'espaces, PAS de « MAD », point décimal `.`) ; JSON "
    "valide sur une seule ligne. N'émets AUCUN bloc si une seule valeur est "
    "demandée ou si une comparaison visuelle n'apporte rien.\n\n"
)


def _summarize(
    query: str,
    cte_name: str,
    description: str,
    cols: Sequence[str],
    rows: Sequence[Dict[str, Any]],
    cfg: Dict[str, Any],
    emit: Optional[StreamCallback],
) -> str:
    """Produce the final answer, streaming tokens through *emit* when given.

    With ``summarize: "llm"`` (default) a single non-tool ``generate_stream``
    call turns the rows into a short grounded answer — this is the only LLM
    round-trip on the fast path, and it streams. Falls back to a deterministic
    rendering of the rows if streaming yields nothing.
    """
    table = _render_rows_block(cols, rows, max_rows=int(cfg["summary_max_rows"]))

    if cfg["summarize"] != "llm":
        return _emit_full(emit, _deterministic_answer(cte_name, description, table))

    multi_row = len(rows) > 1
    if multi_row:
        format_instructions = (
            "Structure ta réponse ainsi :\n\n"
            + _BAR_CHART_INSTRUCTION
            + "## Tableau\n"
            "Reproduis les données ci-dessus sous forme de **tableau Markdown** "
            "(en-têtes lisibles, montants formatés en MAD). Conserve toutes les "
            "lignes fournies ; si la mention « (+N lignes supplémentaires) » "
            "apparaît, ajoute-la sous le tableau telle quelle.\n\n"
            "## Analyse\n"
            "Rédige 2 à 4 phrases d'analyse CIBLÉES sur ce que demande la question "
            "(chiffres clés : extrêmes, totaux, tendances). Ne déborde pas du "
            "périmètre demandé. N'invente aucune valeur."
        )
    else:
        format_instructions = (
            "Structure ta réponse en DEUX parties :\n\n"
            "## Résultat\n"
            "Présente les valeurs clés sous forme de **tableau Markdown** "
            "(indicateur | valeur), montants formatés en MAD.\n\n"
            "## Analyse\n"
            "Rédige 2 à 4 phrases qui répondent directement à la question en "
            "interprétant ce résultat. N'invente aucune valeur."
        )

    prompt = (
        f"Question de l'utilisateur : {query}\n\n"
        f"CTE exécutée : {cte_name}\n"
        f"Description : {description or '(non disponible)'}\n\n"
        f"Résultat de l'exécution (source unique de vérité) :\n{table}\n\n"
        + format_instructions
    )

    streamed: List[str] = []
    try:
        from llm.llm_factory import create_client_for_task

        client = create_client_for_task("agent")
        for piece in client.generate_stream(prompt, system=_SUMMARY_SYSTEM):
            text = piece if isinstance(piece, str) else (getattr(piece, "content", "") or "")
            if not text:
                continue
            streamed.append(text)
            if emit:
                emit("llm_token", "", {"token": text})
    except Exception as exc:
        logger.warning(
            "CTE fast-path summary streaming failed (%s); using deterministic fallback", exc
        )

    answer = "".join(streamed).strip()
    if answer:
        return answer

    # Nothing streamed (LLM unavailable / errored before any token) — emit a
    # deterministic, fully-grounded rendering so the user still gets the data.
    return _emit_full(emit, _deterministic_answer(cte_name, description, table))


def _emit_full(emit: Optional[StreamCallback], text: str) -> str:
    """Emit *text* as a single token event (when streaming) and return it."""
    if emit and text:
        emit("llm_token", "", {"token": text})
    return text


def _deterministic_answer(cte_name: str, description: str, table: str) -> str:
    header = description or cte_name
    return f"**{header}**\n\n{table}"


# ── Rendering helpers ──────────────────────────────────────────────────────────


def _fmt_value(v: Any) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "oui" if v else "non"
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        # Show integers without a trailing ".0"; otherwise round to 2 decimals.
        return str(int(v)) if v.is_integer() else f"{v:.2f}"
    try:
        from decimal import Decimal

        if isinstance(v, Decimal):
            f = float(v)
            return str(int(f)) if f.is_integer() else f"{f:.2f}"
    except Exception:  # pragma: no cover - defensive
        pass
    return str(v)


def _render_rows_block(cols: Sequence[str], rows: Sequence[Dict[str, Any]], *, max_rows: int) -> str:
    """Compact, LLM-friendly rendering of the result rows.

    Single-row results render as ``colonne : valeur`` lines (clearer for a
    one-row aggregate like ``pnb_total``); multi-row results render as a
    markdown table capped at *max_rows*.
    """
    cols = list(cols)
    rows = list(rows)
    if not cols or not rows:
        return "(aucune donnée)"

    if len(rows) == 1:
        row = rows[0]
        lines = [f"- {c} : {_fmt_value(row.get(c))}" for c in cols]
        return "\n".join(lines)

    shown = rows[:max_rows]
    lines = [
        "| " + " | ".join(cols) + " |",
        "| " + " | ".join("---" for _ in cols) + " |",
    ]
    for r in shown:
        lines.append("| " + " | ".join(_fmt_value(r.get(c)) for c in cols) + " |")
    if len(rows) > max_rows:
        lines.append(f"… (+{len(rows) - max_rows} lignes supplémentaires)")
    return "\n".join(lines)


def _preview(cols: Sequence[str], rows: Sequence[Dict[str, Any]]) -> str:
    block = _render_rows_block(cols, rows, max_rows=5)
    return block[:300] + ("…" if len(block) > 300 else "")


# ── Memory persistence ──────────────────────────────────────────────────────────


def _persist_turn(memory_store: Any, session_id: str, query: str, answer: str) -> None:
    if memory_store is None:
        return
    try:
        session = memory_store.get_or_create(session_id)
        session.add_message("user", query)
        session.add_message("assistant", answer)
        memory_store.save(session_id)
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("CTE fast-path memory persist failed: %s", exc)
