"""Build the LangChain :class:`AgentExecutor` that drives the Brikz agent.

Pipeline (mirrors flows/agent_flow.py):

    [pre-loop reasoning] → AgentExecutor(create_tool_calling_agent, tools, llm)
                                       ↓
                            think → act → observe loop
                                       ↓
                              final answer (streamed)

The pre-loop result (augmented query, plan, column matches, CTE prompt
block) is folded into the system prompt before the loop starts, so the
LLM sees everything in one place. Conversation memory is bridged from the
project's existing :class:`MemoryStore` via :class:`BrikzChatHistory`.

Use :func:`run_brikz_agent` for one-shot calls, :func:`arun_brikz_agent`
for async, and :func:`create_brikz_agent_executor` if you need to drive
the executor manually (e.g. from a streaming route).
"""

from __future__ import annotations

import logging
import re
import warnings
from typing import Any, Dict, List, Optional, Tuple

# NOTE: LangChain 1.x moved the non-LangGraph AgentExecutor + tool-calling
# agent factory into the `langchain_classic` package. We use this explicitly
# because the project requirement forbids LangGraph (`langchain.agents.create_agent`
# uses LangGraph internally). Verified against langchain-core / langchain_classic
# 1.x: this remains the supported non-LangGraph agent path.
from langchain_classic.agents import AgentExecutor, create_tool_calling_agent
from langchain_core._api.deprecation import LangChainDeprecationWarning
from langchain_core.chat_history import BaseChatMessageHistory
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.prompts import ChatPromptTemplate, MessagesPlaceholder
from langchain_core.runnables.history import RunnableWithMessageHistory

# RunnableWithMessageHistory is deprecated in favour of LangGraph persistence,
# but LangGraph is intentionally not used here. Per the LangChain docs it stays
# functional and is the recommended non-LangGraph way to attach chat history, so
# silence only this one recurring warning to keep request logs clean.
warnings.filterwarnings(
    "ignore",
    message=r".*RunnableWithMessageHistory.*",
    category=LangChainDeprecationWarning,
)

from agent.config import get_section
from agent.cte_fast_path import run_cte_fast_path, run_cte_fast_path_for_match
from agent.cte_retriever import build_no_data_refusal
from agent.llm_adapter import BrikzLLM
from agent.preloop import PreloopResult, run_preloop
from agent.tools import build_tool_list

logger = logging.getLogger(__name__)


# ── Chat history bridge over the project's MemoryStore ──────────────────────


class BrikzChatHistory(BaseChatMessageHistory):
    """Adapter from :class:`nodes.memory.memory_store.MemoryStore` to LangChain."""

    def __init__(self, memory_store: Any, session_id: str):
        self.memory_store = memory_store
        self.session_id = session_id

    @property
    def messages(self) -> List[BaseMessage]:
        if not self.memory_store:
            return []
        try:
            session = self.memory_store.get(self.session_id)
            if session is None or not session.short_term:
                return []
            out: List[BaseMessage] = []
            for msg in session.short_term:
                role = (getattr(msg, "role", "") or "").lower()
                content = getattr(msg, "content", "") or ""
                if role == "user":
                    out.append(HumanMessage(content=content))
                elif role == "assistant":
                    out.append(AIMessage(content=content))
            return out
        except Exception as exc:
            logger.warning("BrikzChatHistory.messages failed: %s", exc)
            return []

    def add_messages(self, messages: List[BaseMessage]) -> None:
        if not self.memory_store:
            return
        try:
            session = self.memory_store.get_or_create(self.session_id)
            for m in messages:
                if isinstance(m, HumanMessage):
                    session.add_message("user", m.content if isinstance(m.content, str) else str(m.content))
                elif isinstance(m, AIMessage):
                    session.add_message("assistant", m.content if isinstance(m.content, str) else str(m.content))
            self.memory_store.save(self.session_id)
        except Exception as exc:
            logger.warning("BrikzChatHistory.add_messages failed: %s", exc)

    def clear(self) -> None:
        # Intentional no-op: clearing the persistent session is out of scope.
        pass


# ── Greeting / small-talk fast-path ─────────────────────────────────────────

# Pure greetings/courtesies should be answered instantly with a friendly
# message — without running the expensive pre-loop (DTO warm-up, augmentation,
# CTE retrieval, planning) or the anti-hallucination "no data" refusal that the
# analytical pipeline would otherwise return.

# Greeting detection + reply are handled by the LLM (not a hardcoded word list or
# fixed reply strings) so any greeting in any language/dialect works — "salam",
# "labas", "bonjour", "hello", "ça va", "merci", … — and the answer is in the
# user's OWN language. One cheap LLM call decides AND replies, far cheaper than the
# full augmentation/CTE/plan pipeline (which would otherwise fabricate an analysis
# for a bare greeting).
_GREETING_SYSTEM = (
    "Tu filtres les messages entrants pour Brikz, un assistant d'ANALYSE DE DONNÉES "
    "financières.\n"
    "Si le message est UNIQUEMENT une salutation, une formule de politesse ou du "
    "small-talk, SANS aucune demande de données, de chiffre ou d'analyse "
    "(ex : « salam », « bonjour », « hello », « ça va ? », « labas », « merci », "
    "« good morning »), réponds par un message d'accueil court (2 à 3 phrases) : "
    "salue en retour, présente-toi brièvement comme Brikz, et invite l'utilisateur "
    "à poser une question d'analyse. N'invente AUCUN chiffre et ne lance AUCUNE "
    "analyse.\n"
    "RÈGLE ABSOLUE DE LANGUE : réponds STRICTEMENT dans la même langue/dialecte que "
    "le message de l'utilisateur — anglais → anglais, français → français, "
    "arabe/darija → arabe/darija. Ne traduis jamais en français un message anglais.\n"
    "Si le message contient la moindre question ou demande de données / chiffres / "
    "analyse, réponds EXACTEMENT par le seul token : __NOT_GREETING__"
)

_NOT_GREETING = "__NOT_GREETING__"


def _maybe_greeting_response(query: str) -> Optional[str]:
    """LLM-driven greeting handler.

    Returns a friendly reply in the user's OWN language when *query* is a pure
    greeting / courtesy / small-talk, else ``None`` (→ run the full agent). A cheap
    structural gate (short message, no digits) skips the LLM call for messages that
    clearly aren't bare greetings (years/amounts/long questions).
    """
    q = (query or "").strip()
    if not q:
        return None
    words = re.findall(r"\w+", q)
    if len(words) > 8 or any(ch.isdigit() for ch in q):
        return None
    try:
        from llm.llm_factory import create_client_for_task

        client = create_client_for_task("agent")
        resp = client.generate(q, system=_GREETING_SYSTEM, max_tokens=200, temperature=0.3)
        text = (getattr(resp, "content", "") or "").strip()
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("LLM greeting check failed (%s); deferring to full agent", exc)
        return None
    if not text or _NOT_GREETING in text:
        return None
    return text


def _greeting_result(query: str, reply: str, memory_store: Any, session_id: str) -> Dict[str, Any]:
    """Assemble the standard result dict for a greeting (and persist the turn).

    *reply* is the LLM-generated greeting (already in the user's language).
    """
    if memory_store is not None:
        try:
            session = memory_store.get_or_create(session_id)
            session.add_message("user", query)
            session.add_message("assistant", reply)
            memory_store.save(session_id)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Greeting memory persist failed: %s", exc)
    return {
        "query": query,
        "augmented_query": query,
        "analysis_plan": "",
        "cte_hit": False,
        "cte_created": None,
        "answer": reply,
        "intermediate_steps": [],
        "sql_queries": [],
        "sql_results": [],
        "rendered_reports": [],
        "is_greeting": True,
    }


# ── Executor builder ────────────────────────────────────────────────────────


def create_brikz_agent_executor(
    *,
    query: Optional[str] = None,
    session_id: str = "default",
    memory_store: Any = None,
    llm: Optional[BrikzLLM] = None,
    skills_context: str = "",
    tool_context: Optional[Dict[str, Any]] = None,
    skip_plan_on_cte_hit: bool = False,
) -> Tuple[AgentExecutor, PreloopResult]:
    """Build an :class:`AgentExecutor` with the pre-loop reasoning baked in.

    Returns (executor, preloop_result). When ``query`` is provided, the
    pre-loop runs immediately and its augmented query is folded into the
    system prompt. When None, callers must run the pre-loop themselves
    before invoking the executor (used by ``stream_agent_events``).

    ``tool_context`` is the shared dict the data/CTE tools accumulate their
    structured outputs (``sql_queries`` / ``sql_results`` /
    ``rendered_reports``) into. Pass one in to harvest those after invoking
    the executor (e.g. to drive chart generation).
    """
    agent_cfg = get_section("agent") or {}

    llm = llm or BrikzLLM.from_task("agent")

    # Inject the domain-expertise skill(s) relevant to this query when the
    # caller didn't supply any. This is the chokepoint every full-agent entry
    # point (flow node, streaming, one-shot) flows through, so doing it here
    # guarantees the agent always sees the right formulas/règles métier — e.g.
    # "donne le MNI" pulls the indicateurs-bancaires-comex skill carrying the
    # marge-nette-d'intérêt formula it needs to design/execute a CTE.
    if not skills_context and query:
        try:
            from skill_registry import build_skills_context_for_query
            skills_context = build_skills_context_for_query(query)
        except Exception as exc:  # pragma: no cover - defensive
            logger.warning("Skill auto-injection failed (non-fatal): %s", exc)
            skills_context = ""

    # Run pre-loop reasoning before assembling the prompt
    preloop_result = run_preloop(
        query=query or "",
        llm_client=llm.client,
        session_id=session_id,
        memory_store=memory_store,
        skills_context=skills_context,
        skip_plan_on_cte_hit=skip_plan_on_cte_hit,
    )

    if tool_context is None:
        tool_context = {}
    tools = build_tool_list(tool_context=tool_context)

    # The system prompt is fully-rendered text (schema, CTE catalogue, SQL
    # examples) that can contain literal braces like {"period"} or {block_id}.
    # Pass it as a literal SystemMessage so ChatPromptTemplate does NOT try to
    # interpret those braces as template variables.
    prompt = ChatPromptTemplate.from_messages([
        SystemMessage(content=preloop_result.system_prompt or "You are the Brikz analytical agent."),
        MessagesPlaceholder(variable_name="chat_history", optional=True),
        ("human", "{input}"),
        MessagesPlaceholder(variable_name="agent_scratchpad"),
    ])

    agent = create_tool_calling_agent(llm=llm, tools=tools, prompt=prompt)

    executor = AgentExecutor(
        agent=agent,
        tools=tools,
        max_iterations=int(agent_cfg.get("max_iterations", 10)),
        early_stopping_method=agent_cfg.get("early_stopping_method", "force"),
        verbose=bool(agent_cfg.get("verbose", True)),
        return_intermediate_steps=bool(agent_cfg.get("return_intermediate_steps", True)),
        handle_parsing_errors=True,
    )

    if memory_store is not None:
        # output_messages_key="output" is set explicitly: AgentExecutor returns a
        # multi-key dict ({output, intermediate_steps, …}), so we must tell
        # RunnableWithMessageHistory which key holds the AI reply to persist
        # rather than relying on its implicit "output" fallback.
        executor = RunnableWithMessageHistory(
            executor,
            lambda sid: BrikzChatHistory(memory_store, sid),
            input_messages_key="input",
            history_messages_key="chat_history",
            output_messages_key="output",
        )

    return executor, preloop_result


# ── High-level entrypoints ──────────────────────────────────────────────────


def run_brikz_agent(
    query: str,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    connector_manager: Any = None,
    skills_context: str = "",
    stream_callback: Optional[Any] = None,
) -> Dict[str, Any]:
    """Synchronous one-shot agent call. Returns the full state dict.

    ``stream_callback`` (``(event, message, data) -> None``) is forwarded to the
    CTE fast path so it can stream ``llm_token`` events while the answer is
    generated; it is unused by the full agent loop (which can't token-stream
    while tools are bound).
    """
    greeting = _maybe_greeting_response(query)
    if greeting is not None:
        logger.info("Greeting fast-path for session=%s", session_id)
        return _greeting_result(query, greeting, memory_store, session_id)

    # Auto-resume: a background CTE-authoring job for this session just finished,
    # so its new CTEs are now in the library. Announce them and let the normal
    # retrieval/fast-path below answer with them.
    resume_note = _consume_background_note(session_id)

    # CTE fast-path: when the query confidently maps to a library CTE, execute
    # it directly and stream a grounded answer — skipping query augmentation,
    # plan decomposition, and the multi-turn tool-calling loop.
    fast = run_cte_fast_path(
        query,
        session_id=session_id,
        memory_store=memory_store,
        stream_callback=stream_callback,
    )
    if fast is not None:
        return _prepend_note(fast, resume_note)

    tool_context: Dict[str, Any] = {}
    executor, preloop = create_brikz_agent_executor(
        query=query,
        session_id=session_id,
        memory_store=memory_store,
        skills_context=skills_context,
        tool_context=tool_context,
        # The post-augmentation fast path below executes a confidently-matched
        # CTE directly, so the pre-loop skips the ~8 s plan decomposition on a
        # hit (it is only consumed by the full agent loop).
        skip_plan_on_cte_hit=True,
    )

    # Post-augmentation fast-path: the raw-query fast-path missed, but the
    # pre-loop just augmented the query and found a CTE at high confidence.
    # Execute it directly rather than running the full agent loop.
    if preloop.cte_match.found:
        fast2 = run_cte_fast_path_for_match(
            query,
            preloop.cte_match,
            session_id=session_id,
            memory_store=memory_store,
            stream_callback=stream_callback,
        )
        if fast2 is not None:
            return _prepend_note(fast2, resume_note)

    inputs = {"input": preloop.augmented_query}
    config = {"configurable": {"session_id": session_id}} if memory_store else {}
    raw = executor.invoke(inputs, config=config)

    answer = resume_note + _finalize_answer(query, raw, preloop, tool_context, session_id=session_id)

    return {
        "query": query,
        "augmented_query": preloop.augmented_query,
        "analysis_plan": preloop.analysis_plan,
        "cte_hit": preloop.cte_match.found,
        "cte_created": preloop.cte_match.created_name,
        "answer": answer,
        "intermediate_steps": raw.get("intermediate_steps"),
        "sql_queries": tool_context.get("sql_queries", []),
        "sql_results": tool_context.get("sql_results", []),
        "rendered_reports": tool_context.get("rendered_reports", []),
    }


async def arun_brikz_agent(
    query: str,
    *,
    session_id: str = "default",
    memory_store: Any = None,
    connector_manager: Any = None,
    skills_context: str = "",
    stream_callback: Optional[Any] = None,
) -> Dict[str, Any]:
    """Async one-shot agent call. Use this from FastAPI handlers."""
    import asyncio

    # LLM greeting check is a blocking call — keep it off the event loop.
    greeting = await asyncio.to_thread(_maybe_greeting_response, query)
    if greeting is not None:
        logger.info("Greeting fast-path (async) for session=%s", session_id)
        return _greeting_result(query, greeting, memory_store, session_id)

    # Auto-resume: announce CTEs authored by a just-finished background job.
    resume_note = _consume_background_note(session_id)

    # CTE fast-path (see run_brikz_agent). The fast path is synchronous
    # (DuckDB + streamed LLM call); run it off the event loop.
    import asyncio

    fast = await asyncio.to_thread(
        run_cte_fast_path,
        query,
        session_id=session_id,
        memory_store=memory_store,
        stream_callback=stream_callback,
    )
    if fast is not None:
        return _prepend_note(fast, resume_note)

    tool_context: Dict[str, Any] = {}
    executor, preloop = create_brikz_agent_executor(
        query=query,
        session_id=session_id,
        memory_store=memory_store,
        skills_context=skills_context,
        tool_context=tool_context,
        # The post-augmentation fast path below executes a confidently-matched
        # CTE directly, so the pre-loop skips the ~8 s plan decomposition on a
        # hit (it is only consumed by the full agent loop).
        skip_plan_on_cte_hit=True,
    )

    # Post-augmentation fast-path (see run_brikz_agent). Runs off the event
    # loop since it is synchronous (DuckDB + a streamed LLM call).
    if preloop.cte_match.found:
        fast2 = await asyncio.to_thread(
            run_cte_fast_path_for_match,
            query,
            preloop.cte_match,
            session_id=session_id,
            memory_store=memory_store,
            stream_callback=stream_callback,
        )
        if fast2 is not None:
            return _prepend_note(fast2, resume_note)

    inputs = {"input": preloop.augmented_query}
    config = {"configurable": {"session_id": session_id}} if memory_store else {}
    raw = await executor.ainvoke(inputs, config=config)

    answer = resume_note + _finalize_answer(query, raw, preloop, tool_context, session_id=session_id)

    return {
        "query": query,
        "augmented_query": preloop.augmented_query,
        "analysis_plan": preloop.analysis_plan,
        "cte_hit": preloop.cte_match.found,
        "cte_created": preloop.cte_match.created_name,
        "answer": answer,
        "intermediate_steps": raw.get("intermediate_steps"),
        "sql_queries": tool_context.get("sql_queries", []),
        "sql_results": tool_context.get("sql_results", []),
        "rendered_reports": tool_context.get("rendered_reports", []),
    }


# ── Anti-hallucination guard ────────────────────────────────────────────────


def _enforce_no_hallucination(answer: str, preloop: PreloopResult) -> str:
    """If the CTE pipeline yielded no data, refuse instead of returning the LLM text.

    This is a defense-in-depth check on top of the system-prompt rules:
    when the CTE search missed AND creation didn't yield a usable CTE,
    AND the agent has no tool results to ground its answer, return the
    configured refusal verbatim.
    """
    if preloop.cte_match.no_data:
        return preloop.cte_match.no_data_message or build_no_data_refusal()
    # If the CTE search failed entirely (no library hit, no creation) and the
    # agent's answer doesn't reference any concrete tool output, refuse.
    if (
        not preloop.cte_match.found
        and not preloop.cte_match.created_name
        and (preloop.cte_match.hits == [] or all(
            float(h.get("similarity_score") or 0.0) < 0.2 for h in preloop.cte_match.hits
        ))
        and not (answer or "").strip()
    ):
        return build_no_data_refusal()
    return answer


# ── Clarifying-questions fallback ───────────────────────────────────────────

# LangChain's AgentExecutor emits this literal output when it exhausts
# ``max_iterations`` with ``early_stopping_method="force"``. It means the agent
# could not ground the query (typically because a term in the question doesn't
# map to any known column/metric), NOT that the user got a useful answer.
_MAX_ITER_SENTINEL = "agent stopped due to max iterations"


def _is_unresolved_answer(
    answer: str, preloop: PreloopResult, tool_context: Dict[str, Any]
) -> bool:
    """True when the loop produced no grounded answer the user can act on.

    We only treat a query as "unresolved" when there are no SQL results to back
    an answer AND the text is either empty, the max-iterations sentinel, or the
    no-data refusal. A successful (grounded) answer is never overridden.
    """
    if tool_context.get("sql_results"):
        return False
    txt = (answer or "").strip()
    if not txt:
        return True
    if _MAX_ITER_SENTINEL in txt.lower():
        return True
    if preloop.cte_match.no_data:
        return True
    try:
        if txt == (build_no_data_refusal() or "").strip():
            return True
    except Exception:  # pragma: no cover - defensive
        pass
    return False


def _generate_clarifying_questions(
    query: str, preloop: PreloopResult
) -> Optional[str]:
    """Ask the LLM for targeted questions that narrow an ambiguous query.

    Returns a short message (acknowledgement + 2-4 numbered questions, in the
    user's language) grounded in the available schema/CTE context, or ``None``
    if generation fails. Used as a fallback instead of returning a bare
    "Agent stopped due to max iterations." / no-data refusal.
    """
    try:
        schema = (preloop.compact_schema or "").strip()
        cte_ctx = (getattr(preloop.cte_match, "prompt_context", "") or "").strip()
        system = (
            "You are a financial-data analyst assistant. The user's question could "
            "not be resolved against the available data: one or more terms are "
            "ambiguous or do not map to a known column, metric, or CTE. Do NOT "
            "invent data and do NOT attempt to answer the question. Instead, reply "
            "in the SAME language as the user with one short sentence saying you "
            "need to clarify the request, followed by 2 to 4 specific, numbered "
            "questions that would let you map the request to actual columns / "
            "metrics. When a term is ambiguous, propose concrete interpretations "
            "using real column or metric names from the context below."
        )
        human = (
            f"User question:\n{query}\n\n"
            f"Available columns / schema:\n{schema or '(none available)'}\n\n"
            f"Available analytical metrics (CTEs):\n{cte_ctx or '(none available)'}"
        )
        llm = BrikzLLM.from_task("agent")
        resp = llm.invoke(
            [SystemMessage(content=system), HumanMessage(content=human)]
        )
        text = (getattr(resp, "content", "") or "").strip()
        return text or None
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Clarifying-questions generation failed: %s", exc)
        return None


def _synthesize_from_results(
    query: str, raw: Dict[str, Any], tool_context: Dict[str, Any]
) -> Optional[str]:
    """Salvage a grounded answer from the data gathered before max-iterations.

    Complex diagnostic questions can make the agent run many CTE executions
    (CA by enseigne, events, boycott impact…) and exhaust ``max_iterations``
    before it writes a conclusion — LangChain then returns the bare
    "Agent stopped due to max iterations." sentinel and all that data is wasted.
    Here we feed the tool observations it DID collect to one LLM call so the user
    gets the analysis instead of a dead end. Strictly grounded: no new data.
    """
    # The tool observations the agent actually saw (execute_accounting_cte etc.).
    blocks: List[str] = []
    for step in (raw.get("intermediate_steps") or []):
        try:
            action, obs = step
        except Exception:
            continue
        tool = getattr(action, "tool", "") or ""
        if tool in ("execute_accounting_cte", "sql_query", "describe_table") and obs:
            blocks.append(f"### Outil {tool}\n{str(obs)}")
    if not blocks:
        for r in (tool_context.get("sql_results") or []):
            blocks.append(str(r))
    if not blocks:
        return None
    # Most-recent observations first (the agent refines toward the answer); cap size.
    data = "\n\n".join(blocks[-10:])[:14000]
    system = (
        "Tu es Brikz, analyste de données financières. Réponds en français, en "
        "markdown clair. Montants en MAD (« 1 234 567,89 MAD »). Base-toi "
        "STRICTEMENT sur les données fournies : n'invente aucun chiffre."
    )
    human = (
        f"Question de l'utilisateur :\n{query}\n\n"
        "L'agent a collecté ces résultats de CTE (source unique de vérité) avant "
        f"d'atteindre sa limite d'itérations :\n\n{data}\n\n"
        "À partir UNIQUEMENT de ces données, rédige la réponse finale :\n"
        "1. un **tableau** Markdown des chiffres clés pertinents,\n"
        "2. une **analyse** (diagnostic) qui répond directement à la question.\n"
        "Si les données ne permettent pas de conclure sur un point, dis-le "
        "explicitement plutôt que d'inventer."
    )
    try:
        llm = BrikzLLM.from_task("agent")
        resp = llm.invoke([SystemMessage(content=system), HumanMessage(content=human)])
        text = (getattr(resp, "content", "") or "").strip()
        return text or None
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Max-iter synthesis failed: %s", exc)
        return None


def _finalize_answer(
    query: str,
    raw: Dict[str, Any],
    preloop: PreloopResult,
    tool_context: Dict[str, Any],
    *,
    session_id: str = "default",
) -> str:
    """Post-process the raw agent output: enforce grounding, else clarify.

    When the loop fails to produce a grounded answer (max-iterations sentinel,
    empty output, or no-data refusal with no SQL results), return LLM-generated
    clarifying questions so the user can narrow the subject — instead of a dead
    "Agent stopped due to max iterations." reply.
    """
    answer = _enforce_no_hallucination(raw.get("output", ""), preloop)
    # Max-iterations but the agent DID gather data (complex diagnostic query):
    # synthesize a grounded answer from what it collected instead of returning
    # the bare "Agent stopped due to max iterations." sentinel.
    if _MAX_ITER_SENTINEL in (answer or "").lower() and (
        raw.get("intermediate_steps") or tool_context.get("sql_results")
    ):
        synth = _synthesize_from_results(query, raw, tool_context)
        if synth:
            logger.info(
                "Max-iterations for session=%s; synthesized answer from gathered data",
                session_id,
            )
            return synth
    if _is_unresolved_answer(answer, preloop, tool_context):
        # Hard query: delegate CTE authoring to Claude Code in the BACKGROUND
        # (non-blocking) and immediately keep the user engaged with clarifying
        # questions. The 30–90 s authoring is hidden behind that dialogue; the
        # new CTEs persist and are reused on the user's next turn.
        bg_started = _maybe_start_background_cte_job(query, session_id)
        clarification = _generate_clarifying_questions(query, preloop)
        if clarification:
            logger.info(
                "Query unresolved for session=%s; clarifying questions%s",
                session_id, " + background CTE job" if bg_started else "",
            )
            return clarification + (_BG_NOTE if bg_started else "")
    return answer


_BG_NOTE = (
    "\n\n---\n_💡 Je prépare en arrière-plan des indicateurs (CTE) adaptés à votre "
    "question. Le temps que vous précisiez votre besoin ci-dessus, ces analyses se "
    "construisent ; reposez la question dans un instant et j'aurai les données prêtes._"
)


def _consume_background_note(session_id: str) -> str:
    """If a background CTE job just finished for this session, return a short
    'new indicators ready' banner to prepend to the answer (else '')."""
    try:
        from agent.cte_background import consume_completed_job

        job = consume_completed_job(session_id)
        if job and job.get("created"):
            ctes = ", ".join(f"`{c}`" for c in job["created"])
            logger.info(
                "Auto-resume for session=%s: announcing background CTEs %s",
                session_id, job["created"],
            )
            return (
                f"✅ J'ai préparé de nouveaux indicateurs réutilisables : {ctes}. "
                "Voici la réponse à votre question :\n\n"
            )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Background auto-resume note skipped: %s", exc)
    return ""


def _prepend_note(result: Dict[str, Any], note: str) -> Dict[str, Any]:
    """Prepend *note* to a result dict's ``answer`` (no-op when note is empty)."""
    if note and isinstance(result, dict) and result.get("answer"):
        result = {**result, "answer": note + result["answer"]}
    return result


def _maybe_start_background_cte_job(query: str, session_id: str) -> bool:
    """Fire a background Claude Code CTE-authoring run bound to the active graph.

    Returns True when a job was started. Best-effort: any failure is swallowed
    so the chat reply is never affected.
    """
    try:
        from agent.cte_background import start_cte_job
        from services.cte_graph.repository import get_active_cte_source, get_repository

        gid = get_repository().graph_id
        src = get_active_cte_source() or ("", "")
        if not gid:
            return False
        return bool(
            start_cte_job(
                session_id, query, graph_id=gid,
                parquet_source=src[0] or "", source_view=src[1] or "",
            )
        )
    except Exception as exc:  # pragma: no cover - defensive
        logger.warning("Background CTE delegation skipped: %s", exc)
        return False
