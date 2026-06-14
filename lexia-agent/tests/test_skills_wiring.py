"""Tests that the LangChain agent actually wires the prompts/skills library in.

Regression cover for the "donne le MNI → Agent stopped due to max iterations"
report: the banking skill (carrying the marge-nette-d'intérêt / PNB formulas)
must be (a) detectable from banking queries and (b) injected into the system
prompt the AgentExecutor receives, so the agent has the formula it needs to
design / execute a CTE.

Hermetic: the pre-loop (DTO warm-up, augmentation, CTE retrieval, LLM calls) is
stubbed, so these exercise the skill resolution + wiring only — no parquet,
embedding model, or network call.
"""

from __future__ import annotations

import pytest

from skill_registry import (
    build_skills_context_for_query,
    detect_skills_in_query,
    load_skill_definitions,
)

_BANK = "indicateurs_bancaires_comex"


# ── Skill detection (frontmatter aliases) ───────────────────────────────────


@pytest.mark.parametrize(
    "query",
    [
        "donne le MNI",
        "donne le PNB",
        "quelle est la marge nette d'intérêt ?",
        "calcule le coefficient d'exploitation",
        "indicateurs bancaires COMEX du mois dernier",
    ],
)
def test_banking_queries_detect_banking_skill(query):
    matches = detect_skills_in_query(query)
    assert _BANK in {s.directory_name for s in matches}, (
        f"{query!r} should map to the banking skill, got "
        f"{[s.directory_name for s in matches]}"
    )


def test_banking_skill_aliases_parse_correctly():
    """The frontmatter `aliases:` list must hold the real aliases (not get
    swallowed into `description`)."""
    bank = next(s for s in load_skill_definitions() if s.directory_name == _BANK)
    aliases_upper = {a.upper() for a in bank.aliases}
    assert "MNI" in aliases_upper
    assert "PNB" in aliases_upper
    assert len(bank.aliases) >= 5


def test_unrelated_query_detects_nothing():
    assert detect_skills_in_query("évolution des ventes moto sur 2024") == []


# ── Query-aware context builder ─────────────────────────────────────────────


def test_context_for_mni_is_focused_and_carries_the_formula():
    ctx = build_skills_context_for_query("donne le MNI")
    low = ctx.lower()
    # The marge-d'intérêt formula must be present…
    assert "marge d'intérêt" in low or "marge nette d'intérêt" in low
    assert "%capitaux_cred_rc" in low  # a column from the formula
    # …and the irrelevant tourism skill must NOT be dumped in.
    assert "tourisme" not in low and "onmt" not in low


def test_context_falls_back_to_catalogue_when_nothing_matches():
    ctx = build_skills_context_for_query("blarg unrelated zzz query")
    # Compact catalogue lists multiple skills by name, not one skill's full body.
    assert ctx.count("\n- ") >= 2 or ctx.count("- ") >= 2


# ── Executor auto-injection (the actual wiring) ─────────────────────────────


class _DummyLLM:
    client = object()


def test_create_executor_auto_injects_skill_for_query(monkeypatch):
    """create_brikz_agent_executor must resolve skills from the query and hand
    them to the pre-loop (and thus the system prompt)."""
    import agent.langchain_agent as la

    captured: dict = {}

    class _Stop(Exception):
        pass

    def _fake_preloop(*, query, llm_client, session_id, memory_store, skills_context):
        captured["skills_context"] = skills_context
        captured["query"] = query
        raise _Stop()

    monkeypatch.setattr(la, "run_preloop", _fake_preloop)

    with pytest.raises(_Stop):
        la.create_brikz_agent_executor(query="donne le MNI", session_id="t", llm=_DummyLLM())

    assert captured["query"] == "donne le MNI"
    assert "marge" in captured["skills_context"].lower()


def test_create_executor_keeps_caller_supplied_skills(monkeypatch):
    """An explicit skills_context must not be overwritten by auto-detection."""
    import agent.langchain_agent as la

    captured: dict = {}

    class _Stop(Exception):
        pass

    def _fake_preloop(*, query, llm_client, session_id, memory_store, skills_context):
        captured["skills_context"] = skills_context
        raise _Stop()

    monkeypatch.setattr(la, "run_preloop", _fake_preloop)

    with pytest.raises(_Stop):
        la.create_brikz_agent_executor(
            query="donne le MNI",
            session_id="t",
            llm=_DummyLLM(),
            skills_context="EXPLICIT-CONTEXT",
        )

    assert captured["skills_context"] == "EXPLICIT-CONTEXT"
