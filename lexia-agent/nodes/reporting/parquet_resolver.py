"""Parquet discovery + schema-aware view registration for the reporting flow.

This module bridges two realities:

* the **CTE library** (``data/reporting/sql/accounting/*.sql``) is written
  against an English, normalised schema (``account_code``, ``date``,
  ``debit``, …) — see ``base_ledger.sql``;
* the **parquet files** shipped under ``data/parquet/`` come from the
  XLSX importer and use the customer's original (French) column names
  (``N_de_compte``, ``Date``, ``Debit``, …).

Rather than asking every block author to remember the column rename
(or duplicate the alias logic in every CTE), we centralise it here:

* :func:`discover_parquet_files` walks the data/parquet directory and
  returns a :class:`ParquetEntry` per file, including its detected
  *kind* (``ledger`` / ``balance`` / ``unknown``) and which canonical
  ``definitions.sources[*].name`` it can fulfill.

* :func:`pick_default_paths` chooses one parquet per source name when
  the caller (e.g. the preview endpoint) didn't supply an explicit
  ``parquet_paths`` mapping.

* :func:`register_source_view` introspects the parquet's schema and
  emits a ``CREATE OR REPLACE VIEW <name>`` whose projection aliases
  every recognised French column onto its canonical English name.
  Unknown columns pass through unchanged so downstream CTEs that need
  raw columns still work.

The module is intentionally dependency-light: it only relies on
``duckdb`` (already used by the rest of the flow) and the standard
library.  No pandas / pyarrow needed.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Mapping, Optional


logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────────────
# Column aliases
#
# Maps a *canonical* (English) column name to the list of source-column
# candidates we accept, ordered by preference.  When registering a
# parquet as a DuckDB view, the first candidate that exists in the
# parquet's schema wins.  Lookups are case-insensitive (DuckDB stores
# identifiers case-insensitively by default but the aliasing layer
# treats casing leniently as well).
#
# Add new aliases here when integrating new accounting exports — the
# rest of the pipeline picks them up without modification.
# ─────────────────────────────────────────────────────────────────────────────

CANONICAL_COLUMN_ALIASES: Dict[str, List[str]] = {
    "account_code":    ["account_code", "N_de_compte", "Compte", "compte"],
    "account_label":   ["account_label", "Libelle_de_compte", "libelle_de_compte"],
    "date":            ["date", "Date"],
    "journal":         ["journal", "Journal", "Code_journal"],
    "description":     [
        "description",
        "Libelle_de_piece",
        "Libelle_de_ligne",
        "libelle_de_piece",
        "libelle_de_ligne",
    ],
    "debit":           ["debit", "Debit"],
    "credit":          ["credit", "Credit"],
    "balance":         ["balance", "Solde"],
    "balance_n1":      ["balance_n1", "Solde_N1"],
    "balance_n2":      ["balance_n2", "Solde_N2"],
    "piece_number":    ["piece_number", "N_de_piece", "n_de_piece"],
    "third_party_id":  ["third_party_id", "Identifiant_du_tiers"],
    "third_party":     ["third_party", "Tiers"],
    # Oracle CA / assurance exports — naming varies by extractor (case, separators).
    # Reporting blocks always reference ``PRIMNETT``; bind whichever physical column exists.
    "PRIMNETT": [
        "PRIMNETT",
        "primnett",
        "PrimNett",
        "PRIM_NETT",
        "prime_nette",
        "PRIME_NETTE",
    ],
}

# Target DuckDB type for each canonical column so the view exposes a
# uniform schema regardless of how the parquet was originally typed
# (e.g. account_code is sometimes a BIGINT, but every accounting CTE
# expects a VARCHAR for ``SUBSTRING(account_code, 1, 1)`` to work).
# Columns absent from this map are aliased without an explicit cast.
CANONICAL_COLUMN_TYPES: Dict[str, str] = {
    "account_code":    "VARCHAR",
    "account_label":   "VARCHAR",
    "journal":         "VARCHAR",
    "description":     "VARCHAR",
    "piece_number":    "VARCHAR",
    "third_party_id":  "VARCHAR",
    "third_party":     "VARCHAR",
    # Numeric columns are intentionally left without a hard cast — the
    # CTE library wraps them in ``COALESCE(... , 0)::DOUBLE`` so the
    # view doesn't have to commit to FLOAT vs DOUBLE here.
}

# Source-name → canonical-column requirements.  Used to detect which
# ``definitions.sources[*].name`` a given parquet can fulfil.
SOURCE_REQUIREMENTS: Dict[str, List[str]] = {
    # ``ledger`` is the standard name for the grand-livre view consumed
    # by ``base_ledger`` — every CTE in the accounting library
    # transitively needs it.
    "ledger":  ["account_code", "date", "debit", "credit"],
    # ``balance`` is the optional balance sheet companion.
    "balance": ["account_code", "balance"],
}

# Minimum shape expected by the insurance-production catalogue bound through
# DuckDB view ``ca_view``. We keep it intentionally small: enough to reject
# derived artefacts such as ``oracle_env_ca_view_distinct.parquet`` while still
# accepting extractor variants that keep the same business semantics.
CA_VIEW_REQUIRED_COLUMNS: List[str] = [
    "PRIMNETT",
    "CODEACTE",
]


@dataclass
class ParquetEntry:
    """One parquet file discovered under ``data/parquet/``."""
    filename: str                          # ``grand_livre_2025_…_xlsx.parquet``
    path:     str                          # absolute filesystem path
    size_bytes: int = 0
    columns:  List[str] = field(default_factory=list)
    is_embeddings: bool = False            # ``*_embeddings.parquet``
    kind:     str = "unknown"              # ``ledger`` / ``balance`` / ``unknown``
    matches_sources: List[str] = field(default_factory=list)
    label:    str = ""                     # human-friendly label (date range)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "filename":        self.filename,
            "path":            self.path,
            "size_bytes":      self.size_bytes,
            "columns":         self.columns,
            "is_embeddings":   self.is_embeddings,
            "kind":            self.kind,
            "matches_sources": self.matches_sources,
            "label":           self.label,
        }


# ── Discovery ──────────────────────────────────────────────────────────────


# matches the date suffix appended by the XLSX importer:
#   grand_livre_2025_01_01_2025_12_31_xlsx.parquet
#   balance_2023_11_15_2024_12_31_xlsx.parquet
_DATE_SUFFIX = re.compile(
    r"_(?P<sy>\d{4})_(?P<sm>\d{2})_(?P<sd>\d{2})"
    r"_(?P<ey>\d{4})_(?P<em>\d{2})_(?P<ed>\d{2})"
)


def _humanise_label(filename: str) -> str:
    """Build a user-friendly label like ``Grand livre · 2025-01-01 → 2025-12-31``."""
    base = filename.removesuffix(".parquet").removesuffix("_xlsx")
    m = _DATE_SUFFIX.search(base)
    if not m:
        return base
    head = base[: m.start()].rstrip("_").replace("_", " ").strip().capitalize()
    return (
        f"{head or base} · "
        f"{m['sy']}-{m['sm']}-{m['sd']} → {m['ey']}-{m['em']}-{m['ed']}"
    )


def _read_parquet_columns(path: Path) -> List[str]:
    """Return the column names of a parquet file using DuckDB.

    DuckDB is already a hard dependency of the reporting pipeline and
    can introspect parquet without materialising rows, so we don't drag
    pandas / pyarrow into this helper.  Returns ``[]`` on any read error
    — callers treat that as ``kind="unknown"``.

    We use ``DESCRIBE SELECT * FROM read_parquet(...)`` which gives a
    consistent (column_name, column_type, …) shape across DuckDB
    versions — ``parquet_schema`` returns lower-level metadata
    (``logical_type`` etc.) and the column-name field has been renamed
    over time.
    """
    try:
        import duckdb  # local import keeps top-level imports lean
    except Exception:
        logger.debug("duckdb import failed in parquet_resolver")
        return []
    try:
        conn = duckdb.connect()
        try:
            rows = conn.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{path.as_posix()}')"
            ).fetchall()
            return [r[0] for r in rows]
        finally:
            conn.close()
    except Exception as exc:
        logger.warning("parquet schema read failed for %s: %s", path, exc)
        return []


def _detect_kind(columns: Iterable[str]) -> str:
    """Map a column set to a coarse ``kind``: ``ledger`` / ``balance`` / unknown."""
    cset = {c.lower() for c in columns}
    has_canonical = lambda canon: any(  # noqa: E731 — small inline helper
        cand.lower() in cset for cand in CANONICAL_COLUMN_ALIASES.get(canon, [])
    )
    if all(has_canonical(c) for c in SOURCE_REQUIREMENTS["ledger"]):
        return "ledger"
    if all(has_canonical(c) for c in SOURCE_REQUIREMENTS["balance"]):
        return "balance"
    return "unknown"


def _matching_sources(columns: Iterable[str]) -> List[str]:
    """Return every ``definitions.sources[*].name`` this parquet can satisfy."""
    cset = {c.lower() for c in columns}
    out: List[str] = []
    for src, required in SOURCE_REQUIREMENTS.items():
        ok = True
        for canon in required:
            if not any(
                cand.lower() in cset
                for cand in CANONICAL_COLUMN_ALIASES.get(canon, [canon])
            ):
                ok = False
                break
        if ok:
            out.append(src)
    return out


def _has_required_columns(
    columns: Iterable[str],
    required: Iterable[str],
) -> bool:
    """Return ``True`` when *columns* satisfy every canonical requirement."""
    cset = {c.lower() for c in columns}
    for canon in required:
        if not any(
            cand.lower() in cset
            for cand in CANONICAL_COLUMN_ALIASES.get(canon, [canon])
        ):
            return False
    return True


def discover_parquet_files(
    parquet_dir: Path,
    *,
    include_embeddings: bool = False,
) -> List[ParquetEntry]:
    """Enumerate ``*.parquet`` files under ``parquet_dir``.

    The result is sorted by:
      1. ``is_embeddings`` (data files first, embedding indexes last);
      2. ``kind`` (``ledger`` first, then ``balance``, then unknown);
      3. ``filename`` (alphabetical) — typically chronological because
         the importer suffixes the period in the filename.

    By default ``*_embeddings.parquet`` files are filtered out — they
    aren't usable as a CTE source.  Pass ``include_embeddings=True`` to
    surface them in the UI (read-only).
    """
    if not parquet_dir.is_dir():
        return []

    entries: List[ParquetEntry] = []
    for path in sorted(parquet_dir.glob("*.parquet")):
        is_emb = path.stem.endswith("_embeddings")
        if is_emb and not include_embeddings:
            continue
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        cols = _read_parquet_columns(path)
        kind = _detect_kind(cols) if cols else "unknown"
        matches = _matching_sources(cols) if cols else []
        entries.append(
            ParquetEntry(
                filename=path.name,
                path=str(path.resolve()),
                size_bytes=size,
                columns=cols,
                is_embeddings=is_emb,
                kind=kind,
                matches_sources=matches,
                label=_humanise_label(path.name),
            )
        )

    kind_order = {"ledger": 0, "balance": 1, "unknown": 2}
    entries.sort(
        key=lambda e: (
            1 if e.is_embeddings else 0,
            kind_order.get(e.kind, 9),
            e.filename,
        )
    )
    return entries


def _entry_window(entry: ParquetEntry) -> Optional[tuple[str, str]]:
    """Return the ``(start_iso, end_iso)`` window encoded in the filename, if any."""
    m = _DATE_SUFFIX.search(entry.filename)
    if not m:
        return None
    return (
        f"{m['sy']}-{m['sm']}-{m['sd']}",
        f"{m['ey']}-{m['em']}-{m['ed']}",
    )


def _parse_period_window(period: Optional[str]) -> Optional[tuple[str, str]]:
    """Coerce a ``$period`` literal to ``(start_iso, end_iso)``."""
    if not period:
        return None
    p = str(period).strip()
    if not p:
        return None
    m = _RE_PERIOD_RANGE.match(p)
    if m:
        return (
            f"{m[1]}-{m[2]}-{m[3]}",
            f"{m[4]}-{m[5]}-{m[6]}",
        )
    m = _RE_PERIOD_DATE.match(p)
    if m:
        s = f"{m[1]}-{m[2]}-{m[3]}"
        return (s, s)
    m = _RE_PERIOD_MONTH.match(p)
    if m:
        from calendar import monthrange
        y, mo = int(m[1]), int(m[2])
        return (f"{y:04d}-{mo:02d}-01", f"{y:04d}-{mo:02d}-{monthrange(y, mo)[1]:02d}")
    return None


def _windows_overlap(a: tuple[str, str], b: tuple[str, str]) -> bool:
    return a[0] <= b[1] and b[0] <= a[1]


def pick_default_paths(
    sources: List[Mapping[str, Any]],
    discovered: List[ParquetEntry],
    *,
    period: Optional[str] = None,
) -> Dict[str, str]:
    """Best-effort ``{source_name: path}`` map when the caller didn't supply one.

    Strategy: for each declared source we pick the discovered parquet
    whose ``matches_sources`` includes that name, ranking candidates by:

    1. Detected ``kind`` matching the source name exactly (so a balance
       export wins over a grand-livre that also exposes ``Solde``).
    2. **Date-window overlap** with ``period`` when supplied — a 2025
       question must not bind to a 2026-only ledger.
    3. Filename order (alphabetical == chronological because the
       importer suffixes the period dates), latest first.

    ``period`` accepts the same shapes as :func:`derive_implicit_params`
    (``YYYY-MM``, ``YYYY-MM-DD``, ``YYYY-MM-DD..YYYY-MM-DD``).
    """
    out: Dict[str, str] = {}
    if not sources or not discovered:
        return out
    by_source: Dict[str, List[ParquetEntry]] = {}
    for entry in discovered:
        if entry.is_embeddings:
            continue
        for src_name in entry.matches_sources:
            by_source.setdefault(src_name, []).append(entry)

    period_win = _parse_period_window(period)

    for src in sources:
        name = src.get("name") if isinstance(src, Mapping) else None
        if not name:
            continue
        candidates = by_source.get(name) or []
        if not candidates:
            continue
        kind_matches = [e for e in candidates if e.kind == name]
        pool = kind_matches or candidates

        if period_win is not None:
            overlapping = [
                e for e in pool
                if (w := _entry_window(e)) is not None and _windows_overlap(w, period_win)
            ]
            if overlapping:
                pool = overlapping

        out[name] = sorted(pool, key=lambda e: e.filename)[-1].path
    return out


# ── View registration ─────────────────────────────────────────────────────


def _build_select_list(parquet_columns: List[str]) -> str:
    """Build the SELECT-list of the adapter view.

    For each canonical column, we pick the first source-column that
    exists (case-insensitive) and emit ``"<src>" AS <canonical>``.  We
    also forward every source column under its original name *unless*
    that name is already used as a canonical alias (to avoid duplicate
    column names in the view's schema).

    The fallback ``SELECT *`` path (used when introspection failed) is
    handled by the caller — this helper expects a non-empty
    ``parquet_columns``.
    """
    lower_to_actual: Dict[str, str] = {c.lower(): c for c in parquet_columns}
    used_lower: set = set()
    select_parts: List[str] = []

    for canonical, candidates in CANONICAL_COLUMN_ALIASES.items():
        for cand in candidates:
            actual = lower_to_actual.get(cand.lower())
            if actual is None:
                continue
            target_type = CANONICAL_COLUMN_TYPES.get(canonical)
            if target_type:
                select_parts.append(
                    f'CAST("{actual}" AS {target_type}) AS {canonical}'
                )
            else:
                select_parts.append(f'"{actual}" AS {canonical}')
            used_lower.add(actual.lower())
            break

    for col in parquet_columns:
        if col.lower() in used_lower:
            continue
        if col.lower() in CANONICAL_COLUMN_ALIASES:
            continue
        select_parts.append(f'"{col}"')

    return ",\n    ".join(select_parts) or "*"


def register_source_view(
    conn: Any,
    name: str,
    path: str,
    *,
    parquet_columns: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Register one DuckDB view exposing *path* as a canonical schema.

    The view's projection includes both the canonical English column
    names expected by ``base_ledger`` and friends, *and* the original
    (French) columns under their raw names — so a CTE can choose
    whichever vocabulary it prefers.

    Parameters
    ----------
    conn:
        A DuckDB connection (the same one that will run the CTEs).
    name:
        Source name from ``definitions.sources[*].name`` (e.g.
        ``"ledger"``).  Becomes the view name verbatim.
    path:
        Absolute path to the parquet file.
    parquet_columns:
        Optional pre-fetched column list.  When ``None`` we ask DuckDB
        for the schema before building the SELECT-list.

    Returns
    -------
    dict
        ``{"name": ..., "path": ..., "columns_in": [...], "aliased": [...]}``
        — useful for diagnostics and for surfacing in preview responses.
    """
    if not name or not path:
        raise ValueError(
            f"register_source_view: both name and path are required "
            f"(got name={name!r}, path={path!r})"
        )

    columns = parquet_columns
    if columns is None:
        try:
            rows = conn.execute(
                f"DESCRIBE SELECT * FROM read_parquet('{path}')"
            ).fetchall()
            columns = [r[0] for r in rows]
        except Exception as exc:
            logger.warning(
                "register_source_view: could not introspect %s (%s); "
                "falling back to SELECT *",
                path, exc,
            )
            columns = []

    if not columns:
        select_list = "*"
    else:
        select_list = _build_select_list(columns)

    sql = (
        f"CREATE OR REPLACE VIEW {name} AS\n"
        f"SELECT\n    {select_list}\n"
        f"FROM read_parquet('{path}')"
    )
    conn.execute(sql)

    aliased = [
        canonical
        for canonical, candidates in CANONICAL_COLUMN_ALIASES.items()
        if any(c.lower() in {col.lower() for col in (columns or [])} for c in candidates)
    ]
    logger.info(
        "registered view %r → %s (aliased canonical columns: %s)",
        name, path, aliased,
    )
    return {
        "name": name,
        "path": path,
        "columns_in": columns or [],
        "aliased": aliased,
    }


def resolve_ca_view_parquet_path(
    parquet_dir: Path,
    parquet_paths: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    """Filesystem path backing DuckDB relation ``ca_view`` (production assurance Oracle).

    Priority:

    1. Explicit ``parquet_paths`` entry for ``ca_view`` or ``oracle_env_ca_view``.
    2. Best matching ``oracle_env_ca_view*.parquet`` under *parquet_dir*.

    The folder may also contain derived artefacts such as
    ``oracle_env_ca_view_distinct.parquet``. Those files are useful for semantic
    search / profiling, but they do not expose the production schema expected by
    the ``insurance_production`` CTE catalogue. We therefore prefer candidates
    whose columns satisfy :data:`CA_VIEW_REQUIRED_COLUMNS`, then prefer
    non-``distinct`` filenames, then fall back to filename order.
    """
    pp = dict(parquet_paths or {})
    for key in ("ca_view", "oracle_env_ca_view"):
        if pp.get(key):
            return pp[key]
    for raw_k, v in pp.items():
        if raw_k and raw_k.lower() in {"ca_view", "oracle_env_ca_view"}:
            return v
    discovered = discover_parquet_files(parquet_dir)
    cand = [
        e for e in discovered
        if "oracle_env_ca_view" in e.filename.lower() and not e.is_embeddings
    ]
    if not cand:
        return None
    schema_ok = [
        e for e in cand
        if _has_required_columns(e.columns, CA_VIEW_REQUIRED_COLUMNS)
    ]
    pool = schema_ok or cand

    def _score(entry: ParquetEntry) -> tuple[int, int, int, int, str]:
        lower = entry.filename.lower()
        exact = 1 if lower == "oracle_env_ca_view.parquet" else 0
        non_distinct = 0 if "distinct" in lower else 1
        has_schema = 1 if _has_required_columns(entry.columns, CA_VIEW_REQUIRED_COLUMNS) else 0
        return (
            exact,
            has_schema,
            non_distinct,
            len(entry.columns or []),
            entry.filename,
        )

    return max(pool, key=_score).path


def ensure_ca_view_registered(
    conn: Any,
    *,
    parquet_dir: Path,
    parquet_paths: Optional[Mapping[str, str]] = None,
    expanded_sql: Optional[str] = None,
) -> Optional[str]:
    """Register ``CREATE OR REPLACE VIEW ca_view AS …`` for ``insurance_production``.

    ``source_data.sql`` starts with ``SELECT * FROM ca_view``.  Preview/render must
    bind that name to the Oracle CA parquet (typically ``oracle_env_ca_view*.parquet``).

    * When *expanded_sql* is set (HTTP preview), registration runs only if the query
      references ``ca_view``.
    * When *expanded_sql* is ``None`` (batch render), register whenever a matching
      parquet exists so blocks using insurance includes always see the view.

    Returns the parquet path used, or ``None`` when skipped / unresolved.
    """
    paths = dict(parquet_paths or {})
    if expanded_sql is not None:
        if not re.search(r"\bca_view\b", expanded_sql, re.IGNORECASE):
            return None
    path = resolve_ca_view_parquet_path(parquet_dir, paths)
    if not path:
        if expanded_sql is not None and re.search(
            r"\bca_view\b", expanded_sql, re.IGNORECASE,
        ):
            logger.warning(
                "expanded SQL references ca_view but no parquet matched "
                "(dir=%s); add definitions.sources or oracle_env_ca_view*.parquet",
                parquet_dir,
            )
        return None
    register_source_view(conn, "ca_view", path)
    return path


# ── Auto-derived parameters (single $period → $prior_period / $year) ────


_RE_PERIOD_MONTH = re.compile(r"^\s*(\d{4})-(\d{2})\s*$")
_RE_PERIOD_DATE  = re.compile(r"^\s*(\d{4})-(\d{2})-(\d{2})\s*$")
_RE_PERIOD_RANGE = re.compile(
    r"^\s*(\d{4})-(\d{2})-(\d{2})\s*\.\.\s*(\d{4})-(\d{2})-(\d{2})\s*$"
)


def derive_implicit_params(
    refs: Iterable[str],
    provided: Optional[Mapping[str, Any]],
) -> Dict[str, Any]:
    """Auto-fill ``$prior_period`` (and ``$year``) from a single ``$period``.

    The user used to supply both ``$period`` and ``$prior_period``
    (and sometimes ``$year``) by hand.  With the unified parameter UX
    they only set ``$period``; this helper reads it and fills any of
    the other slots that the SQL references but the user didn't bind.

    Recognised ``$period`` shapes:

    * ``YYYY-MM``                            → month-aligned
    * ``YYYY-MM-DD``                         → single date
    * ``YYYY-MM-DD..YYYY-MM-DD``             → inclusive date range

    Derivation rules (all year-shifted **by one calendar year** so a
    "vs prior period" comparison runs against the same window in the
    previous year):

    * ``$prior_period`` — always emitted as a single ``YYYY-MM-DD``
      string equal to the *start* of ``$period`` shifted back by one
      year.  We never emit a range here: every CTE that consumes
      ``$prior_period`` does ``EXTRACT(year FROM $prior_period)`` or
      similar, which only works on a single date / castable scalar.
    * ``$year``         — 4-digit year extracted from the start of
      ``$period``.

    The function never overwrites a value the user already provided
    explicitly — it only fills gaps.  Returns a *new* dict; the input
    is not mutated.
    """
    out: Dict[str, Any] = dict(provided or {})

    period_value: Optional[str] = None
    for k, v in (provided or {}).items():
        if str(k).lower() == "period" and v is not None and str(v).strip():
            period_value = str(v).strip()
            break
    if period_value is None:
        return out

    refs_lower = {str(r).lower() for r in refs or []}

    def _has(name: str) -> bool:
        return name in refs_lower

    def _provided_lower(name: str) -> bool:
        return any(str(k).lower() == name for k in (provided or {}))

    start_y: Optional[int] = None
    start_m: Optional[int] = None
    start_d: Optional[int] = None
    end_y:   Optional[int] = None
    end_m:   Optional[int] = None
    end_d:   Optional[int] = None

    m = _RE_PERIOD_MONTH.match(period_value)
    if m:
        start_y, start_m = int(m[1]), int(m[2])
        start_d = 1
    else:
        m = _RE_PERIOD_DATE.match(period_value)
        if m:
            start_y, start_m, start_d = int(m[1]), int(m[2]), int(m[3])
        else:
            m = _RE_PERIOD_RANGE.match(period_value)
            if m:
                start_y, start_m, start_d = int(m[1]), int(m[2]), int(m[3])
                end_y,   end_m,   end_d   = int(m[4]), int(m[5]), int(m[6])

    if start_y is None:
        return out

    if _has("prior_period") and not _provided_lower("prior_period"):
        # Always a single DATE-castable string (start of period, year-1) —
        # see the docstring for the rationale.
        prior = f"{start_y - 1:04d}-{start_m:02d}-{start_d or 1:02d}"
        for k in list(out.keys()):
            if str(k).lower() == "prior_period":
                del out[k]
        out["prior_period"] = prior

    if _has("year") and not _provided_lower("year"):
        for k in list(out.keys()):
            if str(k).lower() == "year":
                del out[k]
        out["year"] = start_y

    return out
