"""Tests for the ambiguity gate (query_clarification)."""

from __future__ import annotations

from agent.cte_retriever import CTEMatch
from agent.query_clarification import (
    generate_clarification_message,
    is_ambiguous_query,
    maybe_clarify_query,
)


def _match(*scores: float) -> CTEMatch:
    hits = [
        {"name": f"cte_{i}", "similarity_score": s, "description": f"desc {i}"}
        for i, s in enumerate(scores)
    ]
    return CTEMatch(found=False, hits=hits)


def test_performant_client_query_is_ambiguous():
    q = "qui est le client le plus performant"
    assert is_ambiguous_query(q, _match(0.43, 0.41))


def test_explicit_pnb_query_not_ambiguous():
    q = "donne le PNB total"
    # Low score but explicit metric → should proceed (create / agent), not clarify.
    assert not is_ambiguous_query(q, _match(0.40))


def test_confident_hit_never_ambiguous():
    q = "qui est le client le plus performant"
    match = CTEMatch(found=True, hits=[{"name": "top_client", "similarity_score": 0.72}])
    assert not is_ambiguous_query(q, match)


def test_close_competing_near_misses_are_ambiguous():
    q = "classement des clients"
    assert is_ambiguous_query(q, _match(0.44, 0.42))


def test_deterministic_clarification_mentions_cte_paths():
    q = "qui est le client le plus performant"
    text = generate_clarification_message(q, _match(0.43, 0.41))
    low = text.lower()
    assert "ambigu" in low or "précise" in low or "reformul" in low
    assert "pnb" in low or "qualit" in low
    assert "cte" in low or "`top_client" in low or "save_accounting" in low


def test_maybe_clarify_returns_result_for_performant_query(monkeypatch):
    monkeypatch.setattr(
        "agent.query_clarification.search_or_create_cte",
        lambda **kw: _match(0.43, 0.41),
    )
    monkeypatch.setattr(
        "agent.query_clarification.generate_clarification_message",
        lambda query, match, **kw: "Question ambiguë — choisissez PNB ou qualité.",
    )
    out = maybe_clarify_query("qui est le client le plus performant")
    assert out is not None
    assert out.get("needs_clarification") is True
    assert "PNB" in out["answer"] or "qualité" in out["answer"]
    assert out["intermediate_steps"] == []


def test_maybe_clarify_skips_when_not_ambiguous(monkeypatch):
    monkeypatch.setattr(
        "agent.query_clarification.search_or_create_cte",
        lambda **kw: _match(0.40),
    )
    out = maybe_clarify_query("donne le PNB total")
    assert out is None
