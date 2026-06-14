"""Read the reporting CTE library on disk and return parsed records.

The reporting flow ships its own catalog of reusable CTEs at
``brikz-agent/data/reporting/sql/<library>/``.  Each ``library`` folder
contains:

* ``index.yaml``   — declarative catalog of every CTE in the folder.  The
  schema is the same one consumed by ``BlockDraftNode`` /
  ``sql_helpers.expand_includes``: each entry has a ``name``,
  ``description``, ``depends_on``, optional ``parameters`` and ``projects``.
* ``<name>.sql``   — the verbatim CTE body in *inline* form
  (``<name> AS ( … )``) or, occasionally, in the full ``WITH …`` form.

For the CTE graph viewer we deliberately bypass SQL parsing.  Dependencies
are *already declared* in ``index.yaml`` and that catalog is the source of
truth used by the rest of the system; re-deriving them from the SQL would
risk drifting out of sync, miss includes, or fail on missing transitive
references.

This module exposes:

* :class:`LibraryCTE` — one record per catalog entry, with the SQL body
  resolved from disk.
* :func:`load_library` — read one or more sub-folders and return the merged
  list of records.  Names must be unique across all loaded sub-folders.
* :class:`LibraryError` — raised when the catalog points to a missing
  ``.sql`` file or declares a duplicate / unknown dependency.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import yaml


logger = logging.getLogger(__name__)


# Default sub-folders inside ``data/reporting/sql/`` that we load by
# default.  ``blocks`` is currently empty but supported for forward-
# compatibility.
DEFAULT_LIBRARIES: Tuple[str, ...] = ("accounting", "blocks")


# Strip a leading ``WITH`` so SQL files written in the full-CTE form
# (``WITH foo AS ( … )``) collapse to the inline form (``foo AS ( … )``)
# we expose to the front-end. Mirrors :func:`sql_helpers._read_library_cte`.
_RE_LEADING_WITH = re.compile(r"^\s*WITH\s+", flags=re.IGNORECASE)


class LibraryError(ValueError):
    """Raised when the on-disk library is malformed or inconsistent."""


@dataclass(frozen=True)
class LibraryCTE:
    """One catalog entry — SQL body + metadata.

    ``library`` records the sub-folder the CTE was loaded from (e.g.
    ``accounting``).  Useful for colour-coding nodes in the front-end and
    for filtering when a single graph mixes multiple sub-folders.
    """

    name:        str
    description: str
    raw_sql:     str
    depends_on:  Tuple[str, ...]   = ()
    parameters:  Tuple[str, ...]   = ()
    projects:    Tuple[str, ...]   = ()
    library:     str               = "accounting"
    source_path: Optional[str]     = None


def _coerce_str_list(value: Any) -> List[str]:
    """Best-effort coercion of YAML scalars to a list of clean strings.

    Tolerates ``None``, scalar (one item), or list-of-strings.  Items that
    aren't strings or are blank are dropped — the catalog occasionally uses
    placeholder syntax like ``[<all from base_ledger>]`` for documentation
    that we don't want bleeding into the dependency graph.
    """
    if value is None:
        return []
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    if isinstance(value, (list, tuple)):
        out: List[str] = []
        for item in value:
            if not isinstance(item, str):
                continue
            stripped = item.strip()
            if not stripped:
                continue
            # Skip ``<all from base_ledger>``-style placeholder entries —
            # they're documentation, not real column / dep names.
            if stripped.startswith("<") and stripped.endswith(">"):
                continue
            out.append(stripped)
        return out
    return []


def _read_sql_body(path: Path) -> str:
    """Return the file contents with any leading ``WITH`` stripped."""
    text = path.read_text(encoding="utf-8").strip()
    return _RE_LEADING_WITH.sub("", text, count=1).strip()


def _load_one_library(library_dir: Path, library: str) -> List[LibraryCTE]:
    """Parse ``<library_dir>/index.yaml`` + sibling SQL files.

    Validates only what we can fix locally:

    * ``index.yaml`` must exist and parse as YAML.
    * Each ``ctes:`` entry must declare a non-empty ``name`` and a
      ``file`` (``<name>.sql`` is also tried as fallback).
    * The referenced SQL file must exist on disk.

    Cross-library dependency resolution (a ``depends_on`` entry that
    targets a CTE in a *different* sub-folder) is deferred to
    :func:`load_library`, which has the full set of names visible.
    """
    index_path = library_dir / "index.yaml"
    if not index_path.is_file():
        raise LibraryError(f"missing index.yaml at {index_path}")

    try:
        doc = yaml.safe_load(index_path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as e:
        raise LibraryError(f"cannot parse {index_path}: {e}") from e
    if not isinstance(doc, dict):
        raise LibraryError(f"{index_path} must be a YAML mapping at top level")

    raw_entries = doc.get("ctes") or []
    if not isinstance(raw_entries, list):
        raise LibraryError(f"{index_path}: 'ctes' must be a list")

    records: List[LibraryCTE] = []
    seen_names: set = set()
    for idx, entry in enumerate(raw_entries):
        if not isinstance(entry, dict):
            logger.debug("library_loader: skipping non-dict entry #%d in %s", idx, index_path)
            continue
        name = (entry.get("name") or "").strip()
        if not name:
            raise LibraryError(f"{index_path}: entry #{idx} has no 'name'")
        if name in seen_names:
            raise LibraryError(
                f"{index_path}: duplicate CTE name {name!r}"
            )
        seen_names.add(name)

        file_value = entry.get("file") or f"{name}.sql"
        sql_path = library_dir / file_value
        if not sql_path.is_file():
            raise LibraryError(
                f"{index_path}: CTE {name!r} points to missing file {sql_path}"
            )

        body = _read_sql_body(sql_path)

        records.append(LibraryCTE(
            name        = name,
            description = (entry.get("description") or "").strip(),
            raw_sql     = body,
            depends_on  = tuple(_coerce_str_list(entry.get("depends_on"))),
            parameters  = tuple(_coerce_str_list(entry.get("parameters"))),
            projects    = tuple(_coerce_str_list(entry.get("projects"))),
            library     = library,
            source_path = str(sql_path),
        ))

    return records


def _load_library_from_graph(library: str) -> Optional[List[LibraryCTE]]:
    """Fallback: synthesize :class:`LibraryCTE` records from the pickle graph.

    The pickle graph (``data/cte_graphs/cte-prof-<library>.pkl``) is the
    single source of truth once the on-disk ``index.yaml`` + ``.sql`` files
    are retired.  This lets every legacy consumer of :func:`load_library`
    (graph build/rebuild) keep working by reading SQL from graph nodes.

    Returns ``None`` when no pickle graph exists for *library* (so the caller
    can fall back to its own missing-folder handling).
    """
    try:
        from .library_graph_cache import graph_id_for_library
        from .repository import get_repository

        repo = get_repository(graph_id_for_library(library))
        graph = repo.load()
    except Exception as exc:  # pragma: no cover - defensive
        logger.debug("library_loader: pickle fallback failed for %s: %s", library, exc)
        return None

    if graph is None or graph.number_of_nodes() == 0:
        return None

    records: List[LibraryCTE] = []
    for nid, attrs in graph.nodes(data=True):
        records.append(
            LibraryCTE(
                name=attrs.get("name", nid),
                description=attrs.get("description", "") or "",
                raw_sql=attrs.get("rawSql", "") or "",
                depends_on=tuple(attrs.get("parents", []) or []),
                parameters=tuple(attrs.get("parameters", []) or []),
                projects=tuple(attrs.get("projects", []) or []),
                library=library,
                source_path=None,
            )
        )
    return records


def load_library(
    base_dir: Path,
    libraries: Optional[Sequence[str]] = None,
) -> List[LibraryCTE]:
    """Load every requested library and return all CTE records.

    For each requested *library*, prefer the on-disk ``<base_dir>/<library>/``
    folder (``index.yaml`` + ``.sql``) when present; otherwise fall back to the
    persisted pickle graph (``data/cte_graphs/cte-prof-<library>.pkl``) so the
    pickle is the single source of truth once the on-disk catalogue is retired.

    The result is **flat**: names must be unique across *all* loaded
    libraries — duplicates raise :class:`LibraryError`.
    """
    libs = list(libraries or DEFAULT_LIBRARIES)
    if not libs:
        raise LibraryError("at least one library must be requested")

    out: List[LibraryCTE] = []
    seen_names: Dict[str, str] = {}

    for lib in libs:
        sub = base_dir / lib
        if sub.is_dir() and (sub / "index.yaml").is_file():
            lib_records = _load_one_library(sub, library=lib)
        else:
            lib_records = _load_library_from_graph(lib)
            if lib_records is None:
                logger.debug(
                    "library_loader: no folder and no pickle for %s; skipping", lib
                )
                continue

        for record in lib_records:
            if record.name in seen_names:
                raise LibraryError(
                    f"CTE name {record.name!r} declared twice "
                    f"(in {seen_names[record.name]!r} and {lib!r})"
                )
            seen_names[record.name] = lib
            out.append(record)

    if not out:
        # Empty is legitimate now: a library may live only as a pickle graph
        # with zero nodes (freshly created), or the on-disk folder may be a
        # freshly created profile directory. Return empty rather than raising
        # so callers (graph build) get an empty graph instead of a 500.
        return []

    # Validate that every depends_on points at a known CTE.  We don't
    # silently drop unknown deps — they almost always indicate a typo or
    # an out-of-sync index.yaml, both of which the user wants surfaced.
    known = {r.name for r in out}
    for record in out:
        unknown = [d for d in record.depends_on if d not in known]
        if unknown:
            raise LibraryError(
                f"CTE {record.name!r} declares unknown dependencies: {unknown!r}"
            )

    return out
