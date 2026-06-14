#!/usr/bin/env python3
"""
qsql — run one SQL statement against the parquet cache AND the live Oracle
source, side-by-side, with a diff on scalar outputs.

Intended to run INSIDE the brikz-agent container (both the parquet cache
and the Oracle thick client are wired there). The preferred entry point
from the dev Mac is `./deploy/qsql "<SQL>"`.

Placeholders in the SQL:
    {table}     → `taamine.ca_view` for Oracle, `ca_view` (DuckDB view over
                  the parquet) for Parquet.
    {oracle}    → raw Oracle-side table name.
    {parquet}   → raw DuckDB-side view name.

Examples:
    qsql "SELECT COUNT(*) AS n FROM {table} WHERE EXERSTAT = 2026"
    qsql "SELECT EXERSTAT AS y, SUM(PRIMNETT) AS ca FROM {table} GROUP BY EXERSTAT"
    qsql --only parquet "SELECT MIN(PRIMNETT), MAX(PRIMNETT) FROM {table}"

Environment overrides (all optional):
    LEXIA_SOURCE_ID   datasources.yaml source_id (default: oracle_env)
    LEXIA_TABLE_ID    datasources.yaml table_id  (default: ca_view)
    LEXIA_PARQUET_DIR parquet directory (default: /app/data/parquet)
"""
from __future__ import annotations

# Silence Pydantic v1→v2 deprecation spam before any import pulls settings in.
import warnings as _w
_w.filterwarnings("ignore")
import os as _os
_os.environ.setdefault("PYTHONWARNINGS", "ignore")

import argparse
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Optional

# Make sure /app and /app/data are on sys.path so the local `config` and
# `services` packages resolve the same way the running API does.
_APP = Path("/app")
for _p in (_APP, _APP / "data"):
    s = str(_p)
    if _p.is_dir() and s not in sys.path:
        sys.path.insert(0, s)

# ── Presets — handy canned diagnostic queries ────────────────────────────────
PRESETS: Dict[str, str] = {
    "row_count":
        "SELECT COUNT(*) AS n FROM {table}",
    "row_count_2026":
        "SELECT COUNT(*) AS n FROM {table} WHERE EXERSTAT = 2026",
    "sum_primnett":
        "SELECT SUM(COALESCE(PRIMNETT, 0)) AS total_ca FROM {table}",
    "sum_primnett_2026":
        "SELECT SUM(COALESCE(PRIMNETT, 0)) AS total_ca "
        "FROM {table} WHERE EXERSTAT = 2026",
    "sum_by_year":
        "SELECT EXERSTAT AS year, COUNT(*) AS n, "
        "SUM(COALESCE(PRIMNETT, 0)) AS total_ca "
        "FROM {table} GROUP BY EXERSTAT ORDER BY EXERSTAT",
    "nulls_primnett":
        "SELECT COUNT(*) AS rows_total, "
        "SUM(CASE WHEN PRIMNETT IS NULL THEN 1 ELSE 0 END) AS nulls, "
        "MIN(PRIMNETT) AS min_v, MAX(PRIMNETT) AS max_v "
        "FROM {table}",
}


# ── Config loading ───────────────────────────────────────────────────────────

def _load_table_config(source_id: str, table_id: str) -> Dict[str, Any]:
    """Read the requested source/table block from datasources.yaml (via settings)."""
    from config import get_settings  # local import to respect sys.path setup

    settings = get_settings()
    sources = settings.data_sources or []
    for src in sources:
        if getattr(src, "source_id", None) != source_id:
            continue
        tables = getattr(src, "tables", None) or []
        for tbl in tables:
            tid = getattr(tbl, "table_id", None)
            if tid == table_id:
                return {
                    "source": src.model_dump() if hasattr(src, "model_dump") else dict(src),
                    "table":  tbl.model_dump() if hasattr(tbl, "model_dump") else dict(tbl),
                }
        raise SystemExit(f"table_id '{table_id}' not found under source '{source_id}'")
    raise SystemExit(f"source_id '{source_id}' not found in datasources.yaml")


# ── Oracle side ──────────────────────────────────────────────────────────────

def _oracle_connect(src_cfg: Dict[str, Any]):
    # Importing the connector triggers thick-mode init (see oracle_connector.py).
    import services.connectors.oracle_connector as _oc  # noqa: F401
    import oracledb

    dsn = oracledb.makedsn(
        src_cfg["host"],
        src_cfg.get("port", 1521),
        service_name=src_cfg["service_name"],
    )
    return oracledb.connect(
        user=src_cfg["username"],
        password=src_cfg["password"],
        dsn=dsn,
    )


def _run_oracle(
    sql: str,
    src_cfg: Dict[str, Any],
    retries: int = 3,
    backoff_s: float = 3.0,
) -> tuple[list[str], list[tuple]]:
    # ORA-12518 / ORA-12520 (listener couldn't hand off) is typically transient;
    # retry a few times with a short backoff before giving up.
    import oracledb

    last_exc: Optional[Exception] = None
    for attempt in range(1, retries + 1):
        try:
            con = _oracle_connect(src_cfg)
        except oracledb.DatabaseError as exc:
            code = getattr(exc.args[0], "code", None) if exc.args else None
            msg = str(exc)
            transient = code in (12518, 12520, 12519, 12516, 12514) or \
                any(t in msg for t in ("ORA-12518", "ORA-12520", "ORA-12519", "ORA-12516"))
            last_exc = exc
            if transient and attempt < retries:
                print(f"  ! oracle transient error ({msg.splitlines()[0]}) — "
                      f"retry {attempt}/{retries - 1} in {backoff_s:.0f}s")
                time.sleep(backoff_s)
                continue
            raise

        try:
            cur = con.cursor()
            cur.execute(sql)
            cols = [d[0] for d in cur.description]
            rows = cur.fetchall()
            cur.close()
            return cols, rows
        finally:
            con.close()
    if last_exc:
        raise last_exc
    raise RuntimeError("oracle run failed with no exception captured")


# ── Parquet side (DuckDB) ────────────────────────────────────────────────────

def _run_parquet(sql: str, parquet_path: Path, view_name: str) -> tuple[list[str], list[tuple]]:
    import duckdb

    if not parquet_path.is_file():
        raise SystemExit(f"parquet file not found: {parquet_path}")

    con = duckdb.connect(":memory:")
    try:
        con.execute(
            f'CREATE OR REPLACE VIEW "{view_name}" '
            f"AS SELECT * FROM read_parquet('{parquet_path.as_posix()}')"
        )
        rel = con.execute(sql)
        cols = [d[0] for d in rel.description]
        rows = [tuple(r) for r in rel.fetchall()]
        return cols, rows
    finally:
        con.close()


# ── Rendering ────────────────────────────────────────────────────────────────

def _is_num(v: Any) -> bool:
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return True
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return True
    except Exception:
        pass
    return False


def _fmt(v: Any) -> str:
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return f"{v:,.4f}".rstrip("0").rstrip(".") if "." in f"{v:,.4f}" else f"{v:,.0f}"
    if isinstance(v, int):
        return f"{v:,}"
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return _fmt(float(v))
    except Exception:
        pass
    return str(v)


def _print_table(title: str, cols: list[str], rows: list[tuple], limit: int = 50) -> None:
    n = len(rows)
    header = f"── {title} ── ({n} row{'s' if n != 1 else ''})"
    print(f"\n{header}")
    if not rows:
        print("  (no rows)")
        return

    shown = rows[:limit]
    # Right-align columns that are numeric in every shown row; left-align otherwise.
    align_right = [
        all(_is_num(r[i]) or r[i] is None for r in shown)
        for i in range(len(cols))
    ]
    widths = [
        max(len(c), *(len(_fmt(r[i])) for r in shown))
        for i, c in enumerate(cols)
    ]

    def _cell(val: str, width: int, right: bool) -> str:
        return val.rjust(width) if right else val.ljust(width)

    hdr = "  ".join(_cell(c, w, r) for c, w, r in zip(cols, widths, align_right))
    sep = "  ".join("─" * w for w in widths)
    print(hdr)
    print(sep)
    for row in shown:
        print("  ".join(
            _cell(_fmt(v), w, r) for v, w, r in zip(row, widths, align_right)
        ))
    if n > limit:
        print(f"  … {n - limit} more rows not shown (use --limit N to expand)")


def _diff_scalar(oracle_rows, parquet_rows, cols) -> None:
    """If both sides returned a single scalar, print absolute + relative delta."""
    if len(oracle_rows) != 1 or len(parquet_rows) != 1:
        return
    if len(cols) == 0:
        return

    def _as_num(v):
        if v is None:
            return None
        if isinstance(v, (int, float)):
            return float(v)
        try:
            from decimal import Decimal
            if isinstance(v, Decimal):
                return float(v)
        except Exception:
            pass
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    print("\n── Diff (scalar columns) ──")
    for i, c in enumerate(cols):
        o = _as_num(oracle_rows[0][i])
        p = _as_num(parquet_rows[0][i])
        if o is None or p is None:
            print(f"  {c:24s}  non-numeric — skipped")
            continue
        delta = p - o
        pct = (delta / o * 100.0) if o else float("inf")
        flag = "✓ exact" if abs(delta) < 1e-9 else (
            "✓ close" if abs(pct) < 0.01 else "✗ MISMATCH"
        )
        print(f"  {c:24s}  oracle={_fmt(o):>20s}  parquet={_fmt(p):>20s}  "
              f"Δ={_fmt(delta):>18s}  ({pct:+.4f}%)  {flag}")


# ── Main ─────────────────────────────────────────────────────────────────────

def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Run the same SQL on the parquet cache and on Oracle, then diff.",
    )
    parser.add_argument("--query", "-q", help="SQL with {table} placeholder")
    parser.add_argument("--preset", "-p", choices=sorted(PRESETS.keys()),
                        default=None, help="Use a canned query (default: sum_primnett_2026)")
    parser.add_argument("--source", default=os.environ.get("LEXIA_SOURCE_ID", "oracle_env"))
    parser.add_argument("--table",  default=os.environ.get("LEXIA_TABLE_ID",  "ca_view"))
    parser.add_argument("--parquet-dir",
                        default=os.environ.get("LEXIA_PARQUET_DIR", "/app/data/parquet"))
    parser.add_argument("--limit",  type=int, default=50,
                        help="Max rows to print per side (default 50)")
    parser.add_argument("--only", choices=("both", "oracle", "parquet"), default="both",
                        help="Run only one side (default: both)")
    parser.add_argument("--list-presets", action="store_true")
    args = parser.parse_args(argv)

    if args.list_presets:
        print("Presets:")
        for k, v in PRESETS.items():
            print(f"  {k:22s}  {v}")
        return 0

    sql_template = args.query or PRESETS[args.preset or "sum_primnett_2026"]
    cfg = _load_table_config(args.source, args.table)
    src_cfg = cfg["source"]
    tbl_cfg = cfg["table"]

    oracle_name  = tbl_cfg.get("table_name") or args.table
    parquet_name = Path(tbl_cfg.get("cache_file", f"{args.source}_{args.table}.parquet")).stem
    # DuckDB view name: strip the `<source>_` prefix for readability.
    duckdb_view = parquet_name.replace(f"{args.source}_", "", 1) or parquet_name

    oracle_sql  = sql_template.format(table=oracle_name,  oracle=oracle_name,  parquet=duckdb_view)
    parquet_sql = sql_template.format(table=duckdb_view,  oracle=oracle_name,  parquet=duckdb_view)

    parquet_file = Path(args.parquet_dir) / f"{parquet_name}.parquet"

    print("╭── compare_parquet_oracle ──────────────────────────────────────╮")
    print(f"  source / table      : {args.source} / {args.table}")
    print(f"  oracle table        : {oracle_name}")
    print(f"  parquet file        : {parquet_file}")
    print(f"  duckdb view         : {duckdb_view}")
    print(f"  query template      : {sql_template}")
    print("╰────────────────────────────────────────────────────────────────╯")

    o_cols = p_cols = None
    o_rows = p_rows = None

    if args.only in ("both", "oracle"):
        t0 = time.time()
        o_cols, o_rows = _run_oracle(oracle_sql, src_cfg)
        _print_table(f"Oracle  ({time.time() - t0:.2f}s)", o_cols, o_rows, args.limit)

    if args.only in ("both", "parquet"):
        t1 = time.time()
        p_cols, p_rows = _run_parquet(parquet_sql, parquet_file, duckdb_view)
        _print_table(f"Parquet ({time.time() - t1:.2f}s)", p_cols, p_rows, args.limit)

    if args.only != "both":
        return 0

    if len(o_rows) == 1 and len(p_rows) == 1 and o_cols == p_cols:
        _diff_scalar(o_rows, p_rows, o_cols)

    if o_cols != p_cols or len(o_rows) != len(p_rows):
        print("\n✗ shape mismatch — columns or row counts differ")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
