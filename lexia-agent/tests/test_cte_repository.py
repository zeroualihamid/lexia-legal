"""Tests for the pickle-graph CTE repository (single source of truth)."""

from __future__ import annotations

from pathlib import Path

import pytest

from services.cte_graph.repository import (
    CTEGraphRepository,
    CTERepositoryError,
    get_repository,
)

_ROOT = Path(__file__).resolve().parent.parent
_PARQUET = _ROOT / "data" / "parquet" / "oracle_env_ca_view.parquet"
_CANONICAL_PKL = _ROOT / "data" / "cte_graphs" / "cte-prof-insurance-production-dashboard.pkl"

_needs_parquet = pytest.mark.skipif(
    not _PARQUET.is_file(), reason="oracle_env_ca_view.parquet not present"
)
_needs_canonical = pytest.mark.skipif(
    not _CANONICAL_PKL.is_file(), reason="canonical insurance-production pkl not present"
)


# ── Canonical graph (read-only) ──────────────────────────────────────────────


@_needs_canonical
def test_canonical_graph_has_metadata_and_nodes() -> None:
    repo = get_repository()
    g = repo.load()
    assert g.number_of_nodes() > 0
    assert g.graph.get("library") == "analyse_bancaire"
    assert g.graph.get("source_view") == "oracle_env_ca_view"
    assert g.graph.get("parquet_source", "").endswith("oracle_env_ca_view.parquet")
    assert g.graph.get("schema_version") == 1


@_needs_canonical
def test_ancestor_closure_is_topological() -> None:
    repo = get_repository()
    g = repo.load()
    if "final_ratios" not in g:
        pytest.skip("final_ratios not in canonical graph")
    chain = repo.ancestor_closure("final_ratios", g)
    # A parent must appear before any of its children in the closure order.
    for node in chain:
        for parent in g.nodes[node].get("parents", []) or []:
            if parent in chain:
                assert chain.index(parent) < chain.index(node)


@_needs_canonical
def test_assemble_sql_wraps_with_clause() -> None:
    repo = get_repository()
    g = repo.load()
    name = next(iter(g.nodes()))
    sql = repo.assemble_sql(name, g)
    assert sql.strip().upper().startswith("WITH ")
    assert f"FROM {name}" in sql


@_needs_parquet
@_needs_canonical
def test_hit_closure_execution_end_to_end() -> None:
    """A PNB CTE authored against the real schema runs end-to-end."""
    repo = get_repository()
    g = repo.load()
    if "pnb_agence_client" not in g:
        pytest.skip("pnb_agence_client not in canonical graph")
    result = repo.execute(cte_name="pnb_agence_client", max_rows=5)
    assert result["columns"]
    assert result["execution_chain"] == ["pnb_agence_client"] or "pnb_agence_client" in result["execution_chain"]


@_needs_parquet
@_needs_canonical
def test_search_returns_hit_for_pnb_query() -> None:
    repo = get_repository()
    res = repo.search("PNB par agence et par client", top_k=3, threshold=0.2)
    assert res["found"] is True
    assert res["hits"]


# ── Mutations against an isolated temp pkl (never touches canonical) ──────────


@_needs_parquet
def test_miss_create_persist_and_validation(tmp_path) -> None:
    repo = CTEGraphRepository(graph_id="test-tmp-lib", graph_dir=tmp_path, library="test")
    assert repo.load().number_of_nodes() == 0

    # Valid CTE referencing a real column → persisted, node count increments.
    repo.upsert_cte(
        "valid_clients",
        "SELECT CODEINTE FROM oracle_env_ca_view",
        "Liste des codes intermédiaires",
    )
    assert repo.has_cte("valid_clients")
    assert (tmp_path / "test-tmp-lib.pkl").is_file()
    assert repo.load().number_of_nodes() == 1

    # Invalid CTE referencing a non-existent column → rejected, not persisted.
    with pytest.raises(CTERepositoryError):
        repo.upsert_cte(
            "broken",
            "SELECT this_column_does_not_exist FROM oracle_env_ca_view",
            "Devrait échouer la validation",
        )
    assert not repo.has_cte("broken")
    assert repo.load().number_of_nodes() == 1

    # Delete removes the node and re-persists.
    assert repo.delete_cte("valid_clients") is True
    assert repo.load().number_of_nodes() == 0


@_needs_parquet
def test_dependent_closure_executes_on_temp_lib(tmp_path) -> None:
    repo = CTEGraphRepository(graph_id="test-tmp-dep", graph_dir=tmp_path, library="test")
    repo.upsert_cte("base", "SELECT CODEINTE, PRIMNETT AS enc FROM oracle_env_ca_view", "base")
    repo.upsert_cte(
        "agg",
        "SELECT CODEINTE, SUM(enc) AS total_enc FROM base GROUP BY CODEINTE",
        "agrégat par intermédiaire",
        depends_on=["base"],
    )
    chain = repo.ancestor_closure("agg")
    assert chain == ["base", "agg"]
    result = repo.execute(cte_name="agg", max_rows=5)
    assert "total_enc" in result["columns"]
