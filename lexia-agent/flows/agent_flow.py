"""
Agent Flow — think → act → observe agentic loop with reasoning enhancements.

Before entering the tool-calling loop, the flow performs:
  1. DTO cache warm-up       — loads all parquet schemas so the LLM sees every table
  2. Query augmentation      — rewrites the user query into a clear, self-contained form
  2b. Embedding column search — embeds the query against all _embeddings.parquet files
                                to pre-resolve which columns and exact categorical values
                                are relevant (injected into system prompt + plan)
  2c. CTE library retrieval  — semantic search over the NetworkX graph of reporting SQL
                                CTEs (accounting catalog) via all-MiniLM-L6-v2; injects
                                relevant CTE names into the system prompt for /chat
  3. Plan decomposition      — breaks complex queries into numbered sub-steps injected
                                into the system prompt so the agent follows a logical plan

Pipeline:
    [pre-processing] → AgentRouterNode ──[dispatch]──→ ToolDispatchNode → VerifyNode ──[think]──→ AgentRouterNode
                            │                                                   └──[respond]──→ AgentResponseNode
                            └──[respond]──→ AgentResponseNode ──[done]──→ (end)
"""
from __future__ import annotations

import sys
from pathlib import Path

if __name__ == '__main__':
    project_root = Path(__file__).resolve().parent.parent
    if str(project_root) not in sys.path:
        sys.path.insert(0, str(project_root))
    _data_dir = str(project_root / "data")
    if _data_dir not in sys.path:
        sys.path.insert(0, _data_dir)

import logging
from typing import Any, Callable, Dict, List, Optional

from pocketflow import Flow, Node as PFNode

from nodes.agent.router_node import AgentRouterNode
from nodes.agent.tool_dispatch_node import ToolDispatchNode
from nodes.agent.verify_node import VerifyNode
from nodes.agent.response_node import AgentResponseNode
from nodes.memory.memory_store import MemoryStore
from services.tool_registry import get_default_registry

logger = logging.getLogger(__name__)

StreamCallback = Callable[[str, str, Optional[dict]], None]


class _FlowEndNode(PFNode):
    """No-op terminal node."""
    pass


def create_agent_flow(max_iterations: int = 10) -> Flow:
    """Assemble the agent DAG with think-act-observe loop."""
    router = AgentRouterNode(max_iterations=max_iterations)
    dispatch = ToolDispatchNode()
    verify = VerifyNode()
    response = AgentResponseNode()
    flow_end = _FlowEndNode()

    router - "dispatch" >> dispatch
    router - "respond" >> response
    dispatch >> verify
    verify - "think" >> router
    # Route through router so a final LLM synthesis runs when tools fail near max iterations.
    verify - "respond" >> router
    response - "done" >> flow_end

    return Flow(start=router)


# ── Pre-processing helpers ──────────────────────────────────────────────────

def _ensure_dto_cache(parquet_dir: Path) -> str:
    """Warm the DTO cache if empty, then return the compact schema string."""
    from flows.dto_cache_flow import get_compact_schema, get_dto_cache, run_dto_cache_flow

    if not get_dto_cache():
        logger.info("DTO cache empty — running dto_cache_flow to populate it")
        run_dto_cache_flow(str(parquet_dir))

    schema = get_compact_schema(parquet_dir)
    if not schema:
        schema = _build_fallback_schema(parquet_dir)
    return schema


def _build_fallback_schema(parquet_dir: Path) -> str:
    """Build a minimal schema from raw parquet metadata when DTO cache is empty."""
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
            cols = []
            for i in range(len(schema)):
                f = schema.field(i)
                cols.append(f"  - {f.name} ({f.type})")
            lines.extend(cols)
            lines.append("")
        except Exception as exc:
            logger.warning("Could not read parquet metadata for %s: %s", pf_path, exc)
    return "\n".join(lines)


def _list_parquet_files(parquet_dir: Path) -> List[str]:
    """Return stems of all data parquet files (excluding embeddings/distinct)."""
    return sorted(
        f.stem for f in parquet_dir.glob("*.parquet")
        if not f.stem.endswith(("_embeddings", "_distinct"))
    )


def _search_embeddings_for_columns(
    query: str,
    parquet_dir: Path,
    threshold: float = 0.30,
    top_k_per_column: int = 5,
) -> Dict[str, List[Dict[str, Any]]]:
    """Embed *query* and score against all ``_embeddings.parquet`` (or
    ``_distinct.parquet``) files.  Returns matches grouped by column_name.

    Returns::

        {
            "PRODUIT_RISQUE": [
                {"value": "RG ACIER", "definition": "Garantie ...", "score": 0.42, "source": "oracle_env_ca_view"},
                ...
            ],
            ...
        }
    """
    try:
        import json as _json
        import numpy as np
        from nodes.dataloader.embedding_parquet_rows import (
            iter_embedding_parquet_rows,
            normalize_embedding_vectors_payload,
        )
        from nodes.dataloader.semantic_search_node import _best_similarity
    except ImportError as exc:
        logger.warning("Embedding search unavailable (missing deps): %s", exc)
        return {}

    # Discover embedding files — prefer _distinct, fall back to _embeddings
    distinct_files = sorted(parquet_dir.glob("*_distinct.parquet"))
    embeddings_files = sorted(parquet_dir.glob("*_embeddings.parquet"))
    seen_stems: set = set()
    files: List[Path] = []
    for f in distinct_files:
        stem = f.stem.removesuffix("_distinct")
        seen_stems.add(stem)
        files.append(f)
    for f in embeddings_files:
        stem = f.stem.removesuffix("_embeddings")
        if stem not in seen_stems:
            files.append(f)

    if not files:
        logger.info("No _embeddings or _distinct parquet files found for column search")
        return {}

    # Load (or reuse) the SentenceTransformer model
    try:
        from services.embedding_model_provider import get_embedding_model
        model = get_embedding_model()
    except Exception as exc:
        logger.warning("Could not load SentenceTransformer: %s", exc)
        return {}

    query_vec = np.asarray(model.encode(query, show_progress_bar=False), dtype=np.float32)

    # Score every row across all files
    all_matches: List[Dict[str, Any]] = []
    for fpath in files:
        source_stem = fpath.stem.removesuffix("_distinct").removesuffix("_embeddings")
        for col_name, distinct_val, defs_json, emb_json in iter_embedding_parquet_rows(fpath):
            embedded_vectors = normalize_embedding_vectors_payload(emb_json)
            if not embedded_vectors:
                continue

            score = _best_similarity(query_vec, embedded_vectors)
            if score < threshold:
                continue

            try:
                definitions = _json.loads(defs_json) if isinstance(defs_json, str) else (defs_json or [])
            except (ValueError, TypeError):
                definitions = []
            def_text = definitions[0] if isinstance(definitions, list) and definitions else ""

            all_matches.append({
                "column_name": col_name,
                "value": distinct_val,
                "definition": def_text,
                "score": round(float(score), 4),
                "source": source_stem,
            })

    # Group by column_name, keep top-K per column, sorted by score descending
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
    """Render column matches as a compact text block for LLM prompts.

    Output is designed so the LLM can copy-paste the SQL_VALUE directly
    into a WHERE clause.  Definitions are labelled as informational only.
    """
    if not column_matches:
        return ""
    lines: List[str] = []
    for col_name, matches in column_matches.items():
        source = matches[0]["source"] if matches else ""
        lines.append(f"### Column: {col_name}  (source: {source})")
        for m in matches:
            lines.append(f"- SQL_VALUE: '{m['value']}'  (confidence: {m['score']})")
            if m.get("definition"):
                lines.append(f"  meaning: {m['definition']}")
        lines.append("")
    return "\n".join(lines)


def _format_recent_turns(
    memory_store: Optional[MemoryStore],
    session_id: Optional[str],
    *,
    max_turns: int = 6,
    max_chars_per_msg: int = 600,
) -> str:
    """Render the last few short-term turns as a compact transcript.

    Returns "" when there is no usable memory or the session is fresh, so
    callers can prepend the result unconditionally.
    """
    if not memory_store or not session_id:
        return ""
    try:
        session = memory_store.get(session_id)
    except Exception:
        return ""
    if session is None or not session.short_term:
        return ""

    recent = session.short_term[-max_turns:]
    lines: List[str] = []
    for msg in recent:
        content = (msg.content or "").strip().replace("\n", " ")
        if len(content) > max_chars_per_msg:
            content = content[:max_chars_per_msg] + "…"
        if content:
            lines.append(f"[{msg.role.upper()}] {content}")

    summary = (session.running_summary or "").strip()
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
    llm_client,
    compact_schema: str,
    parquet_stems: List[str],
    *,
    memory_store: Optional["MemoryStore"] = None,
    session_id: Optional[str] = None,
) -> str:
    """Use the LLM to rewrite the user query into a clearer, self-contained form.

    When ``memory_store`` and ``session_id`` are provided, the most recent
    conversation turns are injected before the augmentation prompt so the
    rewriter can resolve references like "même chose" or "et pour Q3".
    """
    from prompt_loader import render_template
    from utils.call_llm_with_tools import call_llm_with_tools

    source_list = "\n".join(f"- {s}" for s in parquet_stems) if parquet_stems else "(none loaded)"

    augment_prompt = render_template(
        "agent", "query_augmentation",
        query=query,
        source_list=source_list,
        compact_schema=compact_schema[:3000],
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
            tools=[],
            llm_client=llm_client,
            task="agent",
        )
        text = resp.content or ""
        import re
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
    llm_client,
    compact_schema: str,
    column_matches: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    *,
    memory_store: Optional["MemoryStore"] = None,
    session_id: Optional[str] = None,
) -> str:
    """Ask the LLM to decompose a complex query into numbered analysis steps.

    When conversation memory is provided, recent turns are injected so
    multi-step plans can build on what was already explored or computed.
    """
    from prompt_loader import render_template
    from utils.call_llm_with_tools import call_llm_with_tools

    matched_section = ""
    if column_matches:
        matched_section = (
            "\n\nPRE-RESOLVED VALUES FROM EMBEDDING SEARCH:\n"
            + _format_column_matches(column_matches)
            + "\nIMPORTANT: The SQL_VALUE entries above are the EXACT strings to use in "
            "WHERE clauses (e.g., WHERE LIBEPROD = 'Véhicule à 2 ou 3 Roues'). "
            "The 'meaning' lines are human descriptions — NEVER use them in SQL. "
            "NEVER use ILIKE or LIKE — always use `=` with the exact SQL_VALUE."
        )

    plan_prompt = render_template(
        "agent", "plan_decomposition",
        query=query,
        compact_schema=compact_schema[:3000],
        matched_section=matched_section,
    )

    recent = _format_recent_turns(memory_store, session_id)
    if recent:
        plan_prompt = (
            "PRIOR CONVERSATION (use only when the new query builds on it):\n"
            f"{recent}\n\n"
            f"{plan_prompt}"
        )

    try:
        resp = call_llm_with_tools(
            messages=[{"role": "user", "content": plan_prompt}],
            tools=[],
            llm_client=llm_client,
            task="agent",
        )
        text = resp.content or ""
        import re
        steps = re.findall(r"STEP\s+\d+\s*[:：]\s*(.+)", text, re.IGNORECASE)
        if steps:
            plan = "\n".join(f"{i+1}. {s.strip()}" for i, s in enumerate(steps))
            logger.info("Decomposed query into %d steps", len(steps))
            return plan
    except Exception as exc:
        logger.warning("Plan decomposition failed: %s", exc)

    return ""


def _format_cte_graph_context(
    hits: List[Dict[str, Any]],
    neighborhood: List[str],
) -> str:
    """Render semantic CTE hits + optional neighborhood for the system prompt."""
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


def _retrieve_cte_graph_prompt_context(
    augmented_query: str,
    original_query: str,
    *,
    top_k: int = 7,
    neighborhood_max: int = 12,
) -> str:
    """Embed-augmented retrieval over the cached reporting CTE library graph.

    Uses the same :class:`EmbeddingService` and graph as
    ``services.cte_graph.library_graph_cache`` / ``SemanticSearch``.
    On any failure, returns an empty string so ``/chat`` still runs.
    """
    text = (augmented_query or "").strip()
    oq = (original_query or "").strip()
    if oq and oq not in text:
        text = f"{oq}\n{text}"
    if not text:
        return ""
    try:
        from services.cte_graph.library_graph_cache import (
            get_agent_cte_embedding_service,
            get_cached_library_graph,
        )
        from services.cte_graph.search import SemanticSearch

        graph = get_cached_library_graph()
        if graph is None or graph.number_of_nodes() == 0:
            return ""

        finder = SemanticSearch(get_agent_cte_embedding_service())
        hits = finder.query(graph, text, top_k=top_k)
        if not hits:
            return ""

        hit_names = {str(h.get("name") or h.get("node_id") or "") for h in hits}
        hit_names.discard("")
        extra: List[str] = []
        for h in hits:
            for p in h.get("parents") or []:
                ps = str(p)
                if ps not in hit_names and ps not in extra:
                    extra.append(ps)
                if len(extra) >= neighborhood_max:
                    break
            for c in h.get("children") or []:
                cs = str(c)
                if cs not in hit_names and cs not in extra:
                    extra.append(cs)
                if len(extra) >= neighborhood_max:
                    break
            if len(extra) >= neighborhood_max:
                break

        return _format_cte_graph_context(hits, extra[:neighborhood_max])
    except Exception as exc:
        logger.warning("CTE graph retrieval for agent prompt failed: %s", exc)
        return ""


def _build_system_prompt(
    compact_schema: str,
    parquet_stems: List[str],
    skills_context: str,
    analysis_plan: str,
    memory_store: Optional[MemoryStore],
    session_id: str,
    column_matches: Optional[Dict[str, List[Dict[str, Any]]]] = None,
    cte_graph_context: str = "",
) -> str:
    """Assemble the full system prompt with all context."""
    from prompt_loader import load_template

    base = load_template("agent", "system_prompt")
    parts = [base]

    # Available parquet files
    if parquet_stems:
        file_list = "\n".join(f"- data/parquet/{s}.parquet" for s in parquet_stems)
        parts.append(f"\n## Available Parquet Files\n{file_list}")

    # Full schema
    if compact_schema:
        parts.append(f"\n## Data Schema (columns, types, tags)\n{compact_schema}")
        parts.append(
            "\n**Présentation métier :** pour dimensions produit/catégorie/branche/acte/intervenant, "
            "les réponses finales doivent afficher les colonnes **libellé** (`LIBEPROD`, `LIBECATE`, "
            "`LIBEBRAN`, `LIBEACTE`, `LIBTYPIN`, `PRODUIT_RISQUE`, `RAISOCIN`, …), "
            "pas seules les colonnes **code** (`CODEPROD`, `CODECATE`, …)."
        )
    else:
        parts.append(
            "\n## Data Schema\nNo schema loaded. "
            "Use `list_tables` and `describe_table` to discover available data."
        )

    # Pre-resolved column matches from embedding search
    if column_matches:
        formatted = _format_column_matches(column_matches)
        parts.append(
            "\n## Pre-resolved Column Matches (use these in SQL)\n"
            "Embedding search already resolved these categorical values for your query.\n"
            "**Rules:**\n"
            "- Copy the `SQL_VALUE` strings exactly into `WHERE column = 'SQL_VALUE'`.\n"
            "- The `meaning` lines explain what the value represents — NEVER use them in SQL.\n"
            "- NEVER use ILIKE/LIKE to fuzzy-match definitions or descriptions.\n"
            "- Skip `semantic_search` for these columns — go straight to `sql_query`.\n\n"
            + formatted
        )

    # Analysis plan
    if analysis_plan:
        parts.append(f"\n## Analysis Plan (follow these steps)\n{analysis_plan}")

    if cte_graph_context:
        parts.append(
            "\n## Relevant accounting CTEs (semantic retrieval)\n"
            "These CTE names come from **embedding similarity** to the user question "
            "(weak signal — verify with `list_accounting_ctes` when unsure). "
            "For quantitative answers over the **chart of accounts**, prefer "
            "`execute_accounting_cte` with `cte_name=` set to one of these; "
            "if none apply, use `read_accounting_cte` and `save_accounting_cte` to "
            "add a CTE, persist it, and run it in one step. "
            "The tool expands `depends_on` transitively (same as the reporting library).\n\n"
            + cte_graph_context
        )

    if skills_context:
        parts.append(f"\n## Domain Expertise\n{skills_context}")

    # Conversation memory
    if memory_store:
        try:
            session = memory_store.get_or_create(session_id)
            if session.running_summary:
                parts.append(f"\n## Conversation Summary\n{session.running_summary}")
            entity_text = session.entities.to_text()
            if entity_text:
                parts.append(f"\n## Known Entities\n{entity_text}")
            last_result = session.get_last_result()
            if last_result and last_result.get("text"):
                parts.append(f"\n## Prior Query Context\n{last_result['text']}")
        except Exception:
            pass

    return "\n".join(parts)


# ── Public API ──────────────────────────────────────────────────────────────

def run_agent_flow(
    query: str,
    *,
    session_id: str = "default",
    max_iterations: int = 10,
    stream_callback: Optional[StreamCallback] = None,
    connector_manager: Any = None,
    memory_store: Optional[MemoryStore] = None,
    llm_client: Any = None,
) -> Dict[str, Any]:
    """Run the agent flow with pre-processing (augmentation + planning).

    Args:
        query: User's natural-language question.
        session_id: Conversation session identifier.
        max_iterations: Max think-act-observe loops.
        stream_callback: ``(event, message, data)`` for real-time SSE.
        connector_manager: ConnectorManager for data access.
        memory_store: MemoryStore for conversation persistence.
        llm_client: BaseLLM client with tool-calling support.

    Returns:
        Shared state dict after flow completes.
    """
    from config import get_settings

    settings = get_settings()
    parquet_dir = Path(getattr(settings, "parquet_cache_dir", None) or "data/parquet")

    # ── Step 0: LLM client ──────────────────────────────────────────────
    if llm_client is None:
        from llm.llm_factory import create_client_for_task
        llm_client = create_client_for_task("agent")

    # ── Step 1: Warm DTO cache + build schema ───────────────────────────
    compact_schema = _ensure_dto_cache(parquet_dir)
    parquet_stems = _list_parquet_files(parquet_dir)
    logger.info("Schema loaded: %d chars, %d parquet files", len(compact_schema), len(parquet_stems))

    # ── Step 2: Augment user query ──────────────────────────────────────
    augmented_query = _augment_query(
        query, llm_client, compact_schema, parquet_stems,
        memory_store=memory_store, session_id=session_id,
    )

    # ── Step 2b: Semantic column resolution via embeddings ───────────────
    column_matches = _search_embeddings_for_columns(
        augmented_query, parquet_dir, threshold=0.30, top_k_per_column=5,
    )

    # ── Step 3: Decompose into analysis plan ────────────────────────────
    analysis_plan = _decompose_plan(
        augmented_query, llm_client, compact_schema, column_matches=column_matches,
        memory_store=memory_store, session_id=session_id,
    )

    cte_graph_context = _retrieve_cte_graph_prompt_context(augmented_query, query)

    # ── Step 4: Build rich system prompt ────────────────────────────────
    from skill_registry import load_skill_definitions, build_selected_skills_context
    skills = load_skill_definitions()
    skills_context = build_selected_skills_context(skills, include_full_content=True) if skills else ""

    system_prompt = _build_system_prompt(
        compact_schema=compact_schema,
        parquet_stems=parquet_stems,
        skills_context=skills_context,
        analysis_plan=analysis_plan,
        memory_store=memory_store,
        session_id=session_id,
        column_matches=column_matches,
        cte_graph_context=cte_graph_context,
    )

    # ── Step 5: Build tool registry ─────────────────────────────────────
    registry = get_default_registry()

    # Build initial messages from memory
    initial_messages: List[Dict[str, Any]] = []
    if memory_store:
        try:
            session = memory_store.get_or_create(session_id)
            ctx_messages = session.build_context_messages(system_prompt=None, token_budget=4000)
            initial_messages = [m for m in ctx_messages if m["role"] != "system"]
        except Exception:
            pass

    # ── Step 6: Run the agent loop ──────────────────────────────────────
    flow = create_agent_flow(max_iterations=max_iterations)

    shared: Dict[str, Any] = {
        "query": augmented_query,
        "original_query": query,
        "session_id": session_id,
        "max_iterations": max_iterations,
        "agent_iteration": 0,
        "agent_messages": initial_messages,
        "agent_system_prompt": system_prompt,
        "agent_llm_client": llm_client,
        "tool_registry": registry,
        "tool_definitions": registry.list_definitions(),
        "pending_tool_results": [],
        "memory_store": memory_store,
        "connector_manager": connector_manager,
    }
    if stream_callback is not None:
        shared["stream_callback"] = stream_callback

    logger.info(
        "Starting agent flow: session=%s query=%s augmented=%s plan_steps=%d",
        session_id, query[:60], augmented_query[:60],
        analysis_plan.count("\n") + 1 if analysis_plan else 0,
    )
    flow.run(shared)

    logger.info("Agent flow complete: %d iterations", shared.get("agent_iteration", 0))
    return shared


# ============================================================================
# EXAMPLE USAGE
# ============================================================================

if __name__ == '__main__':
    import json
    import time

    from config import get_settings

    cfg = get_settings()

    print("=" * 80)
    print("TESTING AGENT FLOW (augmented + planned)")
    print("=" * 80)
    print(f"LLM provider: {cfg.llm.provider}  model: {cfg.llm.model}")

    query = "donne la liste des quittances pour Assurance responsabilité civile obligatoire et options tous risques pour les véhicules à deux ou trois roues (motos, scooters)."
    session_id = "test-agent-session-001"

    print(f"\nQuery: {query}")
    print(f"Session ID: {session_id}")
    print("\nStarting agent flow...\n")

    t0 = time.time()
    shared = run_agent_flow(query=query, session_id=session_id)
    elapsed = time.time() - t0

    print("\n" + "=" * 80)
    print("AGENT FLOW RESULTS")
    print("=" * 80)
    print(f"Elapsed: {elapsed:.1f}s")
    print(f"Iterations: {shared.get('agent_iteration', 0)}")
    print(f"Augmented query: {shared.get('query', '')[:200]}")

    response = shared.get("final_response", "")
    if response:
        print(f"\nFinal Response ({len(response)} chars):\n{response}")
    else:
        print("\n(empty response)")

    print("\n" + "=" * 80)
