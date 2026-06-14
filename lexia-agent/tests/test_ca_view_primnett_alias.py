"""Regression: ca_view must expose ``PRIMNETT`` when parquet only has ``primnett`` (etc.)."""

from __future__ import annotations

import tempfile
from pathlib import Path

import duckdb
import pytest

from nodes.reporting.parquet_resolver import (
    ensure_ca_view_registered,
    register_source_view,
    resolve_ca_view_parquet_path,
)
from nodes.reporting.sql_helpers import (
    default_insurance_merge_library_dirs,
    expand_includes,
)

_CLEANED_DATA_BODY = """
  SELECT
    sd.* EXCLUDE (PRIMNETT),
    CAST(sd.PRIMNETT AS DOUBLE) AS PRIMNETT,
    COALESCE(CAST(sd.PRIMNETT AS DOUBLE), 0) AS PRIMNETT_CLEAN,
    CASE
      WHEN sd.CODEACTE IN ('P2', 'P13') THEN 'Renewal'
      ELSE 'New'
    END AS new_vs_renewal
  FROM source_data AS sd
"""


def _parquet_path_lowercase_only(tmp: Path) -> str:
    p = (tmp / "lowercase_only.parquet").as_posix()
    duckdb.connect().execute(
        f"COPY (SELECT 100.0::DOUBLE AS primnett, 'P2' AS CODEACTE) TO '{p}' (FORMAT PARQUET)"
    )
    return p


def test_register_ca_view_maps_primnett_to_primnett_column() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        path = _parquet_path_lowercase_only(tmp)
        conn = duckdb.connect()
        try:
            register_source_view(conn, "ca_view", path)
            cols = {r[0] for r in conn.execute("DESCRIBE ca_view").fetchall()}
        finally:
            conn.close()
    assert "PRIMNETT" in cols
    assert "CODEACTE" in cols
    assert "primnett" not in cols  # folded into PRIMNETT only (no duplicate raw name)


def test_cleaned_data_cte_runs_on_lowercase_parquet() -> None:
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        path = _parquet_path_lowercase_only(tmp)
        conn = duckdb.connect()
        try:
            register_source_view(conn, "ca_view", path)
            q = f"""
            WITH source_data AS (SELECT * FROM ca_view),
            cleaned_data AS ({_CLEANED_DATA_BODY.strip()})
            SELECT PRIMNETT, PRIMNETT_CLEAN, new_vs_renewal FROM cleaned_data
            """
            row = conn.execute(q).fetchone()
        finally:
            conn.close()
    assert row is not None
    assert float(row[0]) == pytest.approx(100.0)
    assert float(row[1]) == pytest.approx(100.0)
    assert row[2] == "Renewal"


def test_production_oracle_sample_still_has_primnett() -> None:
    root = Path(__file__).resolve().parent.parent
    path = root / "data" / "parquet" / "oracle_env_ca_view.parquet"
    if not path.is_file():
        pytest.skip("no bundled oracle_env_ca_view.parquet")
    conn = duckdb.connect()
    try:
        register_source_view(conn, "ca_view", str(path))
        n = conn.execute(
            "SELECT COUNT(*) FROM (WITH source_data AS (SELECT * FROM ca_view), "
            f"cleaned_data AS ({_CLEANED_DATA_BODY.strip()}) SELECT 1 FROM cleaned_data LIMIT 1) t"
        ).fetchone()[0]
    finally:
        conn.close()
    assert n == 1


def test_resolve_ca_view_parquet_path_skips_distinct_artifact() -> None:
    root = Path(__file__).resolve().parent.parent
    parquet_dir = root / "data" / "parquet"
    sample = parquet_dir / "oracle_env_ca_view.parquet"
    distinct = parquet_dir / "oracle_env_ca_view_distinct.parquet"
    if not sample.is_file() or not distinct.is_file():
        pytest.skip("bundled ca_view sample or distinct artifact missing")

    chosen = resolve_ca_view_parquet_path(parquet_dir)
    assert chosen is not None
    assert Path(chosen).name == "oracle_env_ca_view.parquet"


def test_ensure_ca_view_registered_uses_executable_parquet() -> None:
    root = Path(__file__).resolve().parent.parent
    parquet_dir = root / "data" / "parquet"
    sample = parquet_dir / "oracle_env_ca_view.parquet"
    distinct = parquet_dir / "oracle_env_ca_view_distinct.parquet"
    if not sample.is_file() or not distinct.is_file():
        pytest.skip("bundled ca_view sample or distinct artifact missing")

    conn = duckdb.connect()
    try:
        path = ensure_ca_view_registered(
            conn,
            parquet_dir=parquet_dir,
            expanded_sql="SELECT * FROM ca_view",
        )
        assert path is not None
        assert Path(path).name == "oracle_env_ca_view.parquet"
        cols = {r[0] for r in conn.execute("DESCRIBE ca_view").fetchall()}
    finally:
        conn.close()

    assert "PRIMNETT" in cols


def _accounting_library_present() -> bool:
    root = Path(__file__).resolve().parent.parent
    return (root / "data" / "reporting" / "sql" / "accounting" / "index.yaml").is_file()


@pytest.mark.skipif(
    not _accounting_library_present(),
    reason="legacy accounting/blocks include library retired (CTEs now live in the pickle graph)",
)
def test_insurance_period_metrics_expands_transitive_dependencies() -> None:
    root = Path(__file__).resolve().parent.parent
    sql = (
        "WITH {{include: period_metrics}}\n"
        "SELECT ROUND(SUM(prime_nette_mois) / 1000000.0, 1) AS ca_encaisse_total\n"
        "FROM period_metrics\n"
        "WHERE year = (SELECT MAX(year) FROM period_metrics)"
    )
    expanded = expand_includes(
        sql,
        root / "data" / "reporting" / "sql" / "accounting",
        extra_library_dirs=[root / "data" / "reporting" / "sql" / "blocks"],
        merge_library_dirs=default_insurance_merge_library_dirs(),
    )

    assert "source_data AS (" in expanded
    assert "cleaned_data AS (" in expanded
    assert "enriched_data AS (" in expanded
    assert "period_metrics AS (" in expanded


@pytest.mark.skipif(
    not _accounting_library_present(),
    reason="legacy accounting/blocks include library retired (CTEs now live in the pickle graph)",
)
def test_insurance_period_metrics_query_executes_on_bundled_ca_view() -> None:
    root = Path(__file__).resolve().parent.parent
    parquet_dir = root / "data" / "parquet"
    sample = parquet_dir / "oracle_env_ca_view.parquet"
    if not sample.is_file():
        pytest.skip("no bundled oracle_env_ca_view.parquet")

    sql = (
        "WITH {{include: period_metrics}}\n"
        "SELECT ROUND(SUM(prime_nette_mois) / 1000000.0, 1) AS ca_encaisse_total\n"
        "FROM period_metrics\n"
        "WHERE year = (SELECT MAX(year) FROM period_metrics)"
    )
    expanded = expand_includes(
        sql,
        root / "data" / "reporting" / "sql" / "accounting",
        extra_library_dirs=[root / "data" / "reporting" / "sql" / "blocks"],
        merge_library_dirs=default_insurance_merge_library_dirs(),
    )

    conn = duckdb.connect()
    try:
        ensure_ca_view_registered(
            conn,
            parquet_dir=parquet_dir,
            expanded_sql=expanded,
        )
        row = conn.execute(expanded).fetchone()
    finally:
        conn.close()

    assert row is not None
