"""Unit tests for the CTE fast-path (agent/cte_fast_path.py).

These are hermetic: the semantic search, the DuckDB CTE execution, and the
summarizer LLM are all stubbed, so the tests exercise the routing + streaming
logic without needing a parquet file, an embedding model, or a network call.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

import agent.cte_fast_path as fp
from agent.cte_retriever import CTEMatch


# ── Helpers ────────────────────────────────────────────────────────────────


def _match(name: str, score: float) -> CTEMatch:
    return CTEMatch(
        found=True,
        hits=[{"name": name, "similarity_score": score, "description": f"desc {name}"}],
        prompt_context="ctx",
    )


def _exec_result(rows: List[Dict[str, Any]]) -> Dict[str, Any]:
    cols = list(rows[0].keys()) if rows else []
    return {
        "cte_name": "pnb_total",
        "description": "PNB total agrégé",
        "execution_chain": ["pnb_total"],
        "columns": cols,
        "rows": rows,
        "row_count": len(rows),
        "truncated": False,
        "sql": "WITH pnb_total AS (...) SELECT * FROM pnb_total",
    }


def _patch(monkeypatch, *, match: CTEMatch, exec_result: Dict[str, Any], summarize: str = "deterministic"):
    """Stub search + execution + config so the fast path runs offline."""
    monkeypatch.setattr(fp, "search_or_create_cte", lambda **kw: match)

    import tools.accounting_tools as at

    def _fake_exec(*, cte_name="", sql="", parameters=None, max_rows=200, ctx=None, **kw):
        if ctx is not None:
            ctx.setdefault("sql_queries", []).append({"label": cte_name, "sql": exec_result["sql"]})
            ctx.setdefault("sql_results", []).append(
                {
                    "label": cte_name,
                    "columns": exec_result["columns"],
                    "rows": exec_result["rows"],
                    "row_count": exec_result["row_count"],
                }
            )
        return exec_result

    monkeypatch.setattr(at, "execute_accounting_cte_structured", _fake_exec)

    base = fp._fast_path_cfg()
    monkeypatch.setattr(fp, "_fast_path_cfg", lambda: {**base, "enabled": True, "threshold": 0.55, "summarize": summarize})


def _collect():
    events: List[tuple] = []

    def cb(event, message, data=None):
        events.append((event, message, data))

    return events, cb


# ── Tests ──────────────────────────────────────────────────────────────────


def test_fast_path_hits_and_streams(monkeypatch):
    _patch(monkeypatch, match=_match("pnb_total", 0.60), exec_result=_exec_result([{"pnb_total_approx": 347}]))
    events, cb = _collect()

    res = fp.run_cte_fast_path("donne le pnb", session_id="t", stream_callback=cb)

    assert res is not None
    assert res["fast_path"] is True
    assert res["fast_path_cte"] == "pnb_total"
    assert res["cte_hit"] is True
    assert res["sql_results"] and res["sql_results"][0]["row_count"] == 1
    assert "347" in res["answer"]

    kinds = [e for e, _m, _d in events]
    assert "tool_start" in kinds
    assert "tool_result" in kinds
    assert "llm_token" in kinds  # answer streamed, even in deterministic mode

    # The streamed tokens concatenate to the returned answer.
    streamed = "".join(d.get("token", "") for e, _m, d in events if e == "llm_token" and d)
    assert streamed == res["answer"]


def test_fast_path_declines_on_weak_match(monkeypatch):
    _patch(monkeypatch, match=_match("pnb_total", 0.40), exec_result=_exec_result([{"x": 1}]))
    res = fp.run_cte_fast_path("donne le pnb", session_id="t")
    assert res is None  # below threshold → defer to full agent


def test_fast_path_declines_on_no_match(monkeypatch):
    monkeypatch.setattr(fp, "search_or_create_cte", lambda **kw: CTEMatch(found=False, hits=[]))
    res = fp.run_cte_fast_path("quelque chose", session_id="t")
    assert res is None


def test_fast_path_declines_on_zero_rows(monkeypatch):
    _patch(monkeypatch, match=_match("pnb_total", 0.70), exec_result=_exec_result([]))
    res = fp.run_cte_fast_path("donne le pnb", session_id="t")
    assert res is None  # no data → defer to full agent (create-on-miss / refusal)


def test_fast_path_declines_when_disabled(monkeypatch):
    base = fp._fast_path_cfg()
    monkeypatch.setattr(fp, "_fast_path_cfg", lambda: {**base, "enabled": False})
    # search should not even be consulted
    monkeypatch.setattr(fp, "search_or_create_cte", lambda **kw: pytest.fail("must not search when disabled"))
    res = fp.run_cte_fast_path("donne le pnb", session_id="t")
    assert res is None


def test_fast_path_falls_back_to_agent_on_exec_error(monkeypatch):
    monkeypatch.setattr(fp, "search_or_create_cte", lambda **kw: _match("pnb_total", 0.70))
    import tools.accounting_tools as at

    def _boom(**kw):
        raise RuntimeError("duckdb exploded")

    monkeypatch.setattr(at, "execute_accounting_cte_structured", _boom)
    base = fp._fast_path_cfg()
    monkeypatch.setattr(fp, "_fast_path_cfg", lambda: {**base, "enabled": True, "threshold": 0.55})

    res = fp.run_cte_fast_path("donne le pnb", session_id="t")
    assert res is None  # execution error → defer to full agent


def test_fast_path_llm_summary_streams_tokens(monkeypatch):
    _patch(
        monkeypatch,
        match=_match("pnb_total", 0.60),
        exec_result=_exec_result([{"pnb_total_approx": 347}]),
        summarize="llm",
    )

    class _FakeClient:
        def generate_stream(self, prompt, system=None, **kw):
            for piece in ["Le PNB ", "total est ", "de 347."]:
                yield piece

    import llm.llm_factory as factory

    monkeypatch.setattr(factory, "create_client_for_task", lambda task, **kw: _FakeClient())

    events, cb = _collect()
    res = fp.run_cte_fast_path("donne le pnb", session_id="t", stream_callback=cb)

    assert res is not None
    assert res["answer"] == "Le PNB total est de 347."
    tokens = [d.get("token") for e, _m, d in events if e == "llm_token" and d]
    assert tokens == ["Le PNB ", "total est ", "de 347."]  # streamed token-by-token
