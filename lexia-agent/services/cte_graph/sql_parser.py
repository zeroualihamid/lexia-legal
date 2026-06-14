"""SQL → CTE extractor.

Single responsibility: turn a SQL string into ``[CTEDef(name, raw_sql), …]``
plus a dependency map ``{child: [parent, …]}``.

Implementation choice
─────────────────────
We **first** parse the SQL with ``sqlglot`` to robustly recover the list
of CTE names and their *exact* body slice.  Naïve regex extraction breaks
on nested parentheses, comments, string literals and dialect-specific
keywords, all of which sqlglot handles correctly.

Once we have ``{name: body_sql}``, dependency detection is intentionally
**name-based** (per spec): we scan each body for word-bounded occurrences
of every other CTE name.  This is cheap, predictable, and good enough for
typical analyst SQL.  Edge cases that name-based matching cannot handle
(a CTE name shadowed by a subquery alias, a comment containing another
CTE's name, identifiers split across line breaks by a dialect tokenizer)
are explicitly out of scope.

Recursive CTEs (``WITH RECURSIVE``) are out of scope: we treat them as a
parse error to surface the unsupported case clearly to the caller.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Dict, List, Tuple

import sqlglot
from sqlglot import exp


# ── Public API ─────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CTEDef:
    """One CTE's name and verbatim SQL body (without the surrounding
    ``alias AS (…)``).

    ``raw_sql`` is the body exactly as it appears in the source string,
    with leading/trailing whitespace stripped.  We preserve the exact
    text so the front-end can show it back to the user without lossy
    round-tripping through the AST.
    """

    name: str
    raw_sql: str


def extract_ctes(sql: str, *, dialect: str = "duckdb") -> Tuple[List[CTEDef], Dict[str, List[str]]]:
    """Parse *sql*, return the ordered list of CTEs and their dependency map.

    Returns
    -------
    ctes
        ``CTEDef`` objects in source order (the order of the ``WITH``
        clause).  A given CTE name may not appear twice — we raise on
        duplicates because they make dependency direction ambiguous.
    deps
        ``{child: [parent, …]}`` — only includes CTE-to-CTE edges,
        i.e. references to CTE names defined **earlier** in the same
        statement.  Self-references and references to non-CTE tables
        are filtered out.

    Raises
    ------
    ValueError
        Empty input, no ``WITH`` clause, ``WITH RECURSIVE`` (out of
        scope), duplicate CTE names, or unparseable SQL.
    """
    if sql is None or not sql.strip():
        raise ValueError("Empty SQL input")

    try:
        parsed = sqlglot.parse_one(sql, read=dialect)
    except sqlglot.errors.ParseError as e:
        raise ValueError(f"Unparseable SQL: {e}") from e
    if parsed is None:
        raise ValueError("Unparseable SQL: empty AST")

    with_clause = parsed.find(exp.With)
    if with_clause is None:
        raise ValueError("SQL has no WITH clause — nothing to analyze")
    if with_clause.args.get("recursive"):
        raise ValueError("WITH RECURSIVE is out of scope for this MVP")

    cte_nodes = list(with_clause.expressions)
    if not cte_nodes:
        raise ValueError("WITH clause has no CTE definitions")

    ctes: List[CTEDef] = []
    bodies: Dict[str, str] = {}
    for cte in cte_nodes:
        alias = cte.alias_or_name
        if not alias:
            raise ValueError("Found a CTE without an alias")
        if alias in bodies:
            raise ValueError(f"Duplicate CTE name: {alias!r}")
        body_node = cte.this  # the inner Select / Union / …
        body_sql = (body_node.sql(dialect=dialect) if body_node is not None else "").strip()
        ctes.append(CTEDef(name=alias, raw_sql=body_sql))
        bodies[alias] = body_sql

    deps = _detect_dependencies(ctes, bodies)
    return ctes, deps


# ── Dependency detection (name-based) ──────────────────────────────────────


_RE_LINE_COMMENT  = re.compile(r"--[^\n]*")
_RE_BLOCK_COMMENT = re.compile(r"/\*.*?\*/", re.DOTALL)
_RE_STRING_LITERAL = re.compile(r"'(?:[^'\\]|\\.|'')*'")


def _strip_noise(sql: str) -> str:
    """Remove SQL comments and string literals so they can't trigger false
    matches against CTE names.

    This is deliberately a textual scrub — we don't need full lexical
    correctness, just enough to avoid surprises like a comment that
    happens to mention another CTE name."""
    sql = _RE_LINE_COMMENT.sub(" ", sql)
    sql = _RE_BLOCK_COMMENT.sub(" ", sql)
    sql = _RE_STRING_LITERAL.sub("''", sql)
    return sql


def _detect_dependencies(
    ctes: List[CTEDef], bodies: Dict[str, str]
) -> Dict[str, List[str]]:
    """For each CTE body, find references to *previously declared* CTEs.

    We restrict matches to **earlier-declared** CTEs because that's the
    only direction non-recursive WITH clauses can travel.  Even if a body
    syntactically mentions a later CTE name, the SQL standard forbids
    that backward reference — so we don't emit it as a dependency edge,
    avoiding accidental cycles.
    """
    declared_so_far: List[str] = []
    deps: Dict[str, List[str]] = {}
    for cte in ctes:
        scrubbed = _strip_noise(bodies.get(cte.name, ""))
        parents: List[str] = []
        for candidate in declared_so_far:
            # Word boundary keeps us from matching ``revenue_total`` inside
            # ``revenue_total_yoy``.
            pattern = re.compile(rf"\b{re.escape(candidate)}\b", re.IGNORECASE)
            if pattern.search(scrubbed):
                parents.append(candidate)
        deps[cte.name] = parents
        declared_so_far.append(cte.name)
    return deps
