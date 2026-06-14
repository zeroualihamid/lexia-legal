"""Pickle-graph CTE repository — the single source of truth for CTEs.

This module replaces the on-disk ``index.yaml`` + per-CTE ``.sql`` catalogue.
A library is one persisted :class:`networkx.DiGraph` pickle under
``data/cte_graphs/<graph_id>.pkl`` (see :class:`GraphStore`).  The graph is
both the catalogue *and* the executable definition:

Graph-level metadata (``graph.graph``)
    * ``library``        — logical library name (e.g. ``analyse_bancaire``).
    * ``parquet_source`` — absolute/relative path to the backing parquet
      "ledger" file (e.g. ``data/parquet/oracle_env_ca_view.parquet``).
    * ``source_view``    — DuckDB view name the root CTEs read from
      (e.g. ``oracle_env_ca_view``).  Registered before execution.
    * ``schema_version`` — bump when the node schema changes.

Node attributes (one per CTE)
    ``id, name, description, rawSql, parents, children,
    description_embedding, parameters, projects``.

Behaviour
    * ``upsert_cte`` / ``delete_cte`` re-embed, re-validate the DAG, and
      **re-persist the pickle** on every mutation (create / update / remove).
    * ``search`` runs cosine similarity over the node description embeddings.
    * ``execute`` runs the matched CTE plus its **full transitive ancestor
      closure** (topological order) against ``source_view`` → ``parquet_source``.
    * ``highlight_path`` exposes the shortest root→node path for the UI only.
"""

from __future__ import annotations

import copy
import logging
import re
import threading
from contextvars import ContextVar
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

import networkx as nx

from .graph_store import GraphStore
from .paths import ParentPathFinder
from .search import SemanticSearch

logger = logging.getLogger(__name__)


# ── Defaults ────────────────────────────────────────────────────────────────

_PROJECT_ROOT = Path(__file__).resolve().parents[2]

# Default = the populated skill library (skill `accounting_dashboard`, name
# `insurance-production-dashboard`). Every CTE library maps 1:1 to a SKILL.md:
# graph id = `cte-prof-<slug(skill name)>`. The agent binds the matched skill's
# library per request; this is only the last-resort fallback.
DEFAULT_GRAPH_ID = "cte-prof-insurance-production-dashboard"
DEFAULT_LIBRARY = "insurance-production-dashboard"
DEFAULT_PARQUET_SOURCE = "data/parquet/oracle_env_ca_view.parquet"
DEFAULT_SOURCE_VIEW = "oracle_env_ca_view"
SCHEMA_VERSION = 1

_DEFAULT_MAX_ROWS = 200
_HARD_MAX_ROWS = 1000

_CTE_DEF_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(", re.IGNORECASE)
_CTE_NAME_OK = re.compile(r"^[A-Za-z][A-Za-z0-9_]*$")
_INCLUDE_RE = re.compile(r"\{\{\s*include:\s*([A-Za-z0-9_]+)\s*\}\}", re.IGNORECASE)


def _normalize_cte_def(name: str, raw_sql: str) -> str:
    """Return a canonical ``name AS ( … )`` CTE definition.

    Accepts an inner body (``SELECT …``), an already-formed ``name AS ( … )``
    definition, or a **full self-contained statement** with its own ``WITH``
    (``WITH local AS (…) SELECT …``). Leading SQL line-comments and blank
    lines are stripped so definitions concatenate cleanly inside a single
    ``WITH`` clause.

    A full ``WITH … SELECT …`` statement (which the agent's ``save_accounting_cte``
    commonly produces) cannot be concatenated as ``name AS (<text>)``: naively
    stripping the leading ``WITH`` would expose ``local AS (…) SELECT …``, whose
    trailing top-level ``SELECT`` then collides with ``assemble_sql``'s
    ``SELECT * FROM name`` → ``Parser Error: syntax error at or near "SELECT"``.
    Such statements are wrapped as a derived-table subquery so they become one
    valid CTE body.
    """
    text = (raw_sql or "").strip()
    lines = text.splitlines()
    while lines and (lines[0].strip().startswith("--") or not lines[0].strip()):
        lines.pop(0)
    text = "\n".join(lines).strip()

    # Full statement with its own WITH clause → wrap as a subquery so it forms a
    # single, valid CTE body (DuckDB allows WITH/ORDER BY inside a derived table).
    if re.match(r"^\s*WITH\s+", text, flags=re.IGNORECASE):
        return f"{name} AS (\nSELECT * FROM (\n{text}\n) AS _{name}_src\n)"

    # Already a clean ``name AS ( … )`` definition (no stray trailing statement).
    if _CTE_DEF_RE.match(text):
        return text

    # Bare inner body (``SELECT …``).
    return f"{name} AS (\n{text}\n)"


def _extract_include_names(sql_text: str) -> List[str]:
    return sorted({m.group(1) for m in _INCLUDE_RE.finditer(sql_text or "")})


def _strip_include_macros(sql_text: str) -> str:
    """Drop ``{{include: name}}`` macros — dependencies are graph edges now."""
    return _INCLUDE_RE.sub("", sql_text or "")


# ── Repository ───────────────────────────────────────────────────────────────


class CTERepositoryError(ValueError):
    """Raised on invalid CTE mutations (bad name, cycle, unknown dep…)."""


class CTEGraphRepository:
    """Single-pickle CTE library: catalogue + executable graph.

    One instance maps to one ``graph_id`` (one pickle file).  All mutations
    persist immediately and invalidate the in-process agent graph cache so
    the next retrieval sees the change.
    """

    def __init__(
        self,
        *,
        graph_id: str = DEFAULT_GRAPH_ID,
        graph_dir: Optional[Path] = None,
        library: str = DEFAULT_LIBRARY,
        parquet_source: str = DEFAULT_PARQUET_SOURCE,
        source_view: str = DEFAULT_SOURCE_VIEW,
    ) -> None:
        self.graph_id = graph_id
        self.library = library
        self._default_parquet_source = parquet_source
        self._default_source_view = source_view
        base = graph_dir or (_PROJECT_ROOT / "data" / "cte_graphs")
        self._store = GraphStore(base)
        self._lock = threading.RLock()

    # ── Persistence ──────────────────────────────────────────────────────

    def load(self) -> nx.DiGraph:
        """Return the graph (creating an empty, metadata-stamped one if absent)."""
        with self._lock:
            graph = self._store.get(self.graph_id)
            if graph is None:
                graph = nx.DiGraph()
            self._ensure_metadata(graph)
            return graph

    def _persist(self, graph: nx.DiGraph) -> None:
        self._ensure_metadata(graph)
        self._store.put(graph, graph_id=self.graph_id)
        self._invalidate_caches()

    def _ensure_metadata(self, graph: nx.DiGraph) -> None:
        meta = graph.graph
        meta.setdefault("library", self.library)
        meta.setdefault("parquet_source", self._default_parquet_source)
        meta.setdefault("source_view", self._default_source_view)
        meta["schema_version"] = SCHEMA_VERSION

    @staticmethod
    def _invalidate_caches() -> None:
        try:
            from .library_graph_cache import invalidate_cte_library_graph_caches

            invalidate_cte_library_graph_caches()
        except Exception as exc:  # pragma: no cover - defensive
            logger.debug("cache invalidation skipped: %s", exc)

    # ── Metadata accessors ───────────────────────────────────────────────

    def parquet_source(self, graph: Optional[nx.DiGraph] = None) -> str:
        g = graph if graph is not None else self.load()
        return str(g.graph.get("parquet_source") or self._default_parquet_source)

    def source_view(self, graph: Optional[nx.DiGraph] = None) -> str:
        g = graph if graph is not None else self.load()
        return str(g.graph.get("source_view") or self._default_source_view)

    def resolved_parquet_path(self, graph: Optional[nx.DiGraph] = None) -> Path:
        raw = self.parquet_source(graph)
        p = Path(raw)
        return p if p.is_absolute() else (_PROJECT_ROOT / p)

    # ── Catalogue reads ──────────────────────────────────────────────────

    def list_ctes(self, graph: Optional[nx.DiGraph] = None) -> List[Dict[str, Any]]:
        g = graph if graph is not None else self.load()
        out: List[Dict[str, Any]] = []
        for nid, attrs in g.nodes(data=True):
            out.append(
                {
                    "name": attrs.get("name", nid),
                    "description": attrs.get("description", "") or "",
                    "depends_on": list(attrs.get("parents", []) or []),
                    "used_by": list(attrs.get("children", []) or []),
                    "projects": list(attrs.get("projects", []) or []),
                    "parameters": list(attrs.get("parameters", []) or []),
                }
            )
        out.sort(key=lambda r: r["name"])
        return out

    def get_cte(self, name: str, graph: Optional[nx.DiGraph] = None) -> Optional[Dict[str, Any]]:
        g = graph if graph is not None else self.load()
        if name not in g:
            return None
        attrs = g.nodes[name]
        return {
            "name": attrs.get("name", name),
            "description": attrs.get("description", "") or "",
            "rawSql": attrs.get("rawSql", "") or "",
            "depends_on": list(attrs.get("parents", []) or []),
            "used_by": list(attrs.get("children", []) or []),
            "projects": list(attrs.get("projects", []) or []),
            "parameters": list(attrs.get("parameters", []) or []),
        }

    def has_cte(self, name: str, graph: Optional[nx.DiGraph] = None) -> bool:
        g = graph if graph is not None else self.load()
        return name in g

    # ── Dependency / assembly ────────────────────────────────────────────

    def ancestor_closure(self, name: str, graph: Optional[nx.DiGraph] = None) -> List[str]:
        """Return *name* + every transitive ancestor, in topological order."""
        g = graph if graph is not None else self.load()
        if name not in g:
            raise CTERepositoryError(f"CTE inconnu: {name!r}")
        nodes = nx.ancestors(g, name) | {name}
        sub = g.subgraph(nodes)
        return list(nx.topological_sort(sub))

    def highlight_path(self, name: str, graph: Optional[nx.DiGraph] = None) -> Dict[str, Any]:
        """Shortest root→node path bundle (visualisation only)."""
        g = graph if graph is not None else self.load()
        return ParentPathFinder.all_parent_paths(g, name)

    def assemble_sql(
        self,
        name: str,
        graph: Optional[nx.DiGraph] = None,
        *,
        select_clause: str = "*",
    ) -> str:
        """Build ``WITH <closure…> SELECT <select_clause> FROM <name>``."""
        g = graph if graph is not None else self.load()
        chain = self.ancestor_closure(name, g)
        defs = [str(g.nodes[n].get("rawSql") or "").strip() for n in chain]
        defs = [d for d in defs if d]
        with_clause = ",\n".join(defs)
        return f"WITH {with_clause}\nSELECT {select_clause} FROM {name}"

    def assemble_custom_sql(self, sql: str, graph: Optional[nx.DiGraph] = None) -> str:
        """Inject referenced-library closures into an arbitrary CTE-shaped query.

        References can be ``{{include: name}}`` macros or bare identifiers
        (``FROM aggregated_client``) that match a library node not already
        defined inside the user's own ``WITH``.
        """
        g = graph if graph is not None else self.load()
        text = _strip_include_macros(sql)
        include_names = _extract_include_names(sql)

        # Library nodes referenced as bare identifiers in the query.
        user_defined = {m.group(1).lower() for m in re.finditer(
            r"([A-Za-z_][A-Za-z0-9_]*)\s+AS\s*\(", text, re.IGNORECASE
        )}
        referenced: set = set(include_names)
        for nid in g.nodes():
            if str(nid).lower() in user_defined:
                continue
            if re.search(rf"\b{re.escape(str(nid))}\b", text):
                referenced.add(str(nid))

        if not referenced:
            return text

        closure_nodes: set = set()
        for n in referenced:
            if n in g:
                closure_nodes |= set(self.ancestor_closure(n, g))
        # Drop any the user already defines themselves.
        closure_nodes = {n for n in closure_nodes if n.lower() not in user_defined}
        if not closure_nodes:
            return text

        ordered = [n for n in nx.topological_sort(g.subgraph(closure_nodes))]
        defs = [str(g.nodes[n].get("rawSql") or "").strip() for n in ordered]
        defs = [d for d in defs if d]
        lib_with = ",\n".join(defs)

        stripped = re.sub(r"^\s*WITH\s+", "", text.strip(), count=1, flags=re.IGNORECASE)
        if stripped is not text.strip():
            # User had their own WITH — merge by comma.
            return f"WITH {lib_with},\n{stripped}"
        return f"WITH {lib_with}\n{text.strip()}"

    # ── Search ───────────────────────────────────────────────────────────

    def search(
        self,
        text: str,
        *,
        top_k: int = 5,
        threshold: float = 0.55,
        graph: Optional[nx.DiGraph] = None,
    ) -> Dict[str, Any]:
        """Cosine search over node descriptions. Returns hit/miss + ranked hits."""
        g = graph if graph is not None else self.load()
        if g.number_of_nodes() == 0 or not (text or "").strip():
            return {"found": False, "best_score": 0.0, "hits": []}
        from .library_graph_cache import get_agent_cte_embedding_service

        finder = SemanticSearch(get_agent_cte_embedding_service())
        hits = finder.query(g, text, top_k=top_k)
        best = float(hits[0]["similarity_score"]) if hits else 0.0
        return {"found": bool(hits) and best >= threshold, "best_score": best, "hits": hits}

    # ── Schema validation (dry-run against the real parquet) ─────────────

    def validate_cte(
        self,
        name: str,
        graph: Optional[nx.DiGraph] = None,
    ) -> Optional[str]:
        """Bind the CTE's closure against the real parquet (``LIMIT 0``).

        Returns ``None`` when the SQL binds cleanly (all referenced columns
        exist), else a human-readable error string. This catches CTEs written
        against a schema that does not match ``parquet_source``.
        """
        from nodes.dataloader.duckdb_query_node import open_connection
        from nodes.reporting.parquet_resolver import (
            derive_implicit_params,
            register_source_view,
        )
        from nodes.reporting.sql_helpers import (
            bind_params_case_insensitive,
            field_param_names,
        )

        g = graph if graph is not None else self.load()
        if name not in g:
            return f"CTE inconnu: {name!r}"
        assembled = self.assemble_sql(name, g) + "\nLIMIT 0"
        refs = field_param_names(assembled)
        bound = bind_params_case_insensitive(refs, derive_implicit_params(refs, {}))

        parquet_path = self.resolved_parquet_path(g)
        if not parquet_path.is_file():
            return f"Parquet source introuvable: {parquet_path}"

        conn = open_connection(memory_limit="512MB", temp_directory="data/.duckdb_tmp")
        try:
            register_source_view(conn, self.source_view(g), str(parquet_path))
            try:
                (conn.execute(assembled, bound) if bound else conn.execute(assembled)).fetchall()
            except Exception as exc:
                return f"{type(exc).__name__}: {exc}"
        finally:
            conn.close()
        return None

    def validate_all(self, graph: Optional[nx.DiGraph] = None) -> Dict[str, Optional[str]]:
        """Validate every node; map name → None (ok) or error string."""
        g = graph if graph is not None else self.load()
        return {n: self.validate_cte(n, g) for n in g.nodes()}

    # ── Mutations (rebuild pkl on every create / update / remove) ─────────

    def upsert_cte(
        self,
        name: str,
        raw_sql: str,
        description: str = "",
        *,
        depends_on: Optional[Sequence[str]] = None,
        parameters: Optional[Sequence[str]] = None,
        projects: Optional[Sequence[str]] = None,
        validate: bool = True,
    ) -> Dict[str, Any]:
        """Create or replace a CTE node, re-embed, re-validate DAG, persist.

        When *validate* is true (default), the node's closure is dry-run
        (``LIMIT 0``) against the real parquet before persisting; a CTE that
        references non-existent columns is rejected with a clear error instead
        of being silently saved.
        """
        name = (name or "").strip()
        if not _CTE_NAME_OK.match(name):
            raise CTERepositoryError(
                f"Nom de CTE invalide: {name!r}. Utiliser snake_case ASCII (ex: pnb_par_agence)."
            )
        body = (raw_sql or "").strip()
        if not body:
            raise CTERepositoryError("Le corps SQL du CTE est requis.")

        explicit = {str(x).strip() for x in (depends_on or []) if str(x).strip()}
        inferred = set(_extract_include_names(raw_sql))

        with self._lock:
            # Work on a copy so a failed mutation never leaks into the cache.
            graph = copy.deepcopy(self.load())

            # Bare-identifier references to existing library nodes count as deps.
            stripped = _strip_include_macros(raw_sql)
            for nid in graph.nodes():
                if str(nid) == name:
                    continue
                if re.search(rf"\b{re.escape(str(nid))}\b", stripped):
                    inferred.add(str(nid))

            merged_deps = sorted(explicit | inferred)
            unknown = [d for d in merged_deps if d not in graph and d != name]
            if unknown:
                known = ", ".join(sorted(graph.nodes())) or "(aucun)"
                raise CTERepositoryError(
                    f"Dépendances absentes du graphe: {unknown}. CTE connus: {known}. "
                    "Créez d'abord les briques manquantes."
                )

            from .library_graph_cache import get_agent_cte_embedding_service

            emb = get_agent_cte_embedding_service()
            # Embed the humanized CTE name + projected columns alongside the
            # description so queries that echo the CTE's name (e.g. "chiffre
            # d'affaires par an" → ``chiffre_affaires_annuel``) match strongly
            # enough for the fast-path to reuse it, instead of re-deriving it.
            _human_name = re.sub(r"[_\s]+", " ", name).strip()
            _proj = " ".join(re.sub(r"[_\s]+", " ", str(p)) for p in (projects or []))
            embed_text = ". ".join(
                part for part in (_human_name, _proj, (description or "").strip()) if part
            )
            vector = emb.encode_one(embed_text or description or "")
            canonical_sql = _normalize_cte_def(name, raw_sql)

            # Always record the $params the SQL references so reuse can BIND them
            # (instead of baking literals into a per-combination CTE). Auto-extract
            # from the body when the caller didn't declare them explicitly.
            cte_params = [str(p).strip() for p in (parameters or []) if str(p).strip()]
            if not cte_params:
                try:
                    from nodes.reporting.sql_helpers import field_param_names

                    cte_params = field_param_names(canonical_sql)
                except Exception:
                    cte_params = []

            existed = name in graph
            # Remove stale incoming edges so a replacement can change deps.
            if existed:
                for parent in list(graph.predecessors(name)):
                    graph.remove_edge(parent, name)
                    kids = graph.nodes[parent].get("children") or []
                    graph.nodes[parent]["children"] = [c for c in kids if c != name]

            graph.add_node(
                name,
                id=name,
                name=name,
                description=description or "",
                rawSql=canonical_sql,
                parents=list(merged_deps),
                children=list(graph.nodes[name].get("children", []) or []) if existed else [],
                description_embedding=vector,
                parameters=list(cte_params),
                projects=list(projects or []),
            )

            for dep in merged_deps:
                graph.add_edge(dep, name)
                kids = graph.nodes[dep].get("children") or []
                if name not in kids:
                    kids.append(name)
                    graph.nodes[dep]["children"] = kids

            if not nx.is_directed_acyclic_graph(graph):
                try:
                    cyc = [u for u, _v, *_ in nx.find_cycle(graph, orientation="original")]
                except nx.NetworkXNoCycle:
                    cyc = [name]
                raise CTERepositoryError(f"Cycle de dépendances détecté: {cyc}")

            if validate:
                err = self.validate_cte(name, graph)
                if err:
                    raise CTERepositoryError(
                        f"CTE « {name} » invalide vis-à-vis du schéma réel "
                        f"({self.source_view(graph)} → {self.parquet_source(graph)}): {err}. "
                        "Corrigez les colonnes référencées (elles doivent exister dans le parquet)."
                    )

            self._persist(graph)

        logger.info("CTE upserted: %s (deps=%s, replaced=%s)", name, merged_deps, existed)
        return {"name": name, "depends_on": merged_deps, "replaced": existed}

    def delete_cte(self, name: str) -> bool:
        """Remove a CTE node + its edges; persist. Returns True if removed."""
        name = (name or "").strip()
        with self._lock:
            graph = copy.deepcopy(self.load())
            if name not in graph:
                return False
            dependents = list(graph.successors(name))
            if dependents:
                logger.warning(
                    "Deleting CTE %s leaves dependents without parent: %s",
                    name, dependents,
                )
            for parent in list(graph.predecessors(name)):
                kids = graph.nodes[parent].get("children") or []
                graph.nodes[parent]["children"] = [c for c in kids if c != name]
            for child in dependents:
                pars = graph.nodes[child].get("parents") or []
                graph.nodes[child]["parents"] = [p for p in pars if p != name]
            graph.remove_node(name)
            self._persist(graph)
        logger.info("CTE deleted: %s", name)
        return True

    # ── Execution ────────────────────────────────────────────────────────

    def execute(
        self,
        *,
        cte_name: str = "",
        sql: str = "",
        select_clause: str = "*",
        parameters: Optional[Dict[str, Any]] = None,
        max_rows: int = _DEFAULT_MAX_ROWS,
        ctx: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Assemble closure (or inject library refs), register the parquet view, run.

        No ``ledger`` requirement: the source view name + parquet path come
        from the graph metadata (``source_view`` → ``parquet_source``).
        """
        from nodes.dataloader.duckdb_query_node import open_connection
        from nodes.reporting.parquet_resolver import (
            derive_implicit_params,
            register_source_view,
        )
        from nodes.reporting.sql_helpers import (
            bind_params_case_insensitive,
            field_param_names,
        )

        cte_name = (cte_name or "").strip()
        custom_sql = (sql or "").strip()
        if not cte_name and not custom_sql:
            raise CTERepositoryError(
                "Fournir soit `cte_name` (CTE du graphe), soit `sql` (WITH … SELECT …)."
            )

        parameters = dict(parameters or {})
        max_rows = max(1, min(int(max_rows or _DEFAULT_MAX_ROWS), _HARD_MAX_ROWS))

        graph = self.load()
        execution_chain: List[str] = []
        description = ""

        if cte_name:
            if cte_name not in graph:
                known = ", ".join(sorted(graph.nodes())) or "(aucun)"
                raise CTERepositoryError(f"CTE inconnu: {cte_name!r}. Disponibles: {known}")
            execution_chain = self.ancestor_closure(cte_name, graph)
            description = str(graph.nodes[cte_name].get("description") or "")
            assembled = self.assemble_sql(cte_name, graph, select_clause=select_clause)
        else:
            assembled = self.assemble_custom_sql(custom_sql, graph)

        refs = field_param_names(assembled)
        enriched = derive_implicit_params(refs, parameters)
        bound = bind_params_case_insensitive(refs, enriched)
        missing = [n for n in refs if bound.get(n) is None]

        view_name = self.source_view(graph)
        parquet_path = self.resolved_parquet_path(graph)
        if not parquet_path.is_file():
            raise CTERepositoryError(
                f"Parquet source introuvable: {parquet_path}. "
                "Mettez à jour `parquet_source` du graphe ou déposez le fichier."
            )

        conn = open_connection(
            memory_limit="512MB",
            temp_directory="data/.duckdb_tmp",
            max_temp_size="10GB",
        )
        try:
            register_source_view(conn, view_name, str(parquet_path))
            try:
                relation = conn.execute(assembled, bound) if bound else conn.execute(assembled)
            except Exception as exc:
                hint = f" (paramètres non liés: {missing})" if missing else ""
                if "exists in the SELECT clause" in str(exc):
                    hint += (
                        " — indice: une colonne référencée n'existe pas dans le "
                        f"parquet source ({view_name}); le CTE a probablement été écrit "
                        "pour un schéma différent et doit être régénéré."
                    )
                raise CTERepositoryError(
                    f"Erreur SQL: {type(exc).__name__}: {exc}{hint}\n\nSQL exécuté:\n{assembled}"
                ) from exc
            cols = [d[0] for d in relation.description]
            fetched = relation.fetchmany(max_rows + 1)
        finally:
            conn.close()

        truncated = len(fetched) > max_rows
        rows = fetched[:max_rows]
        row_dicts = [dict(zip(cols, r)) for r in rows]

        if ctx is not None:
            label = (cte_name or custom_sql)[:80]
            ctx.setdefault("sql_queries", []).append({"label": label, "sql": assembled})
            ctx.setdefault("sql_results", []).append(
                {
                    "label": label,
                    "columns": cols,
                    "rows": row_dicts[:200],
                    "row_count": len(rows),
                }
            )

        return {
            "cte_name": cte_name or None,
            "description": description,
            "execution_chain": execution_chain,
            "columns": cols,
            "rows": row_dicts,
            "row_count": len(rows),
            "truncated": truncated,
            "sql": assembled,
            "parameters": enriched,
            "bound_parameters": bound,
            "missing_parameters": missing,
            "resolved_paths": {view_name: str(parquet_path)},
        }


# ── Process-wide accessor ────────────────────────────────────────────────────

_repo_lock = threading.Lock()
_repos: Dict[str, CTEGraphRepository] = {}

# Per-request active graph id, set by the agent flow from the skill matched to
# the user's query (see ``set_active_cte_graph``). When unset, no-argument
# callers (e.g. the accounting CTE tools) fall back to ``DEFAULT_GRAPH_ID``.
# A ContextVar keeps it isolated per thread/async context so concurrent
# requests never cross-contaminate each other's target graph.
_active_graph_id: ContextVar[Optional[str]] = ContextVar(
    "active_cte_graph_id", default=None
)


def set_active_cte_graph(graph_id: Optional[str]) -> None:
    """Bind the CTE graph that no-argument ``get_repository()`` calls resolve to.

    Pass ``None`` to clear (revert to ``DEFAULT_GRAPH_ID``).
    """
    _active_graph_id.set((graph_id or "").strip() or None)


def get_active_cte_graph() -> Optional[str]:
    """Return the current request's active graph id, or ``None`` when unset."""
    return _active_graph_id.get()


# Per-request active data source (parquet_source, source_view), set from the
# matched skill so a freshly-created skill graph is stamped with the skill's
# source instead of the default banking ledger.
_active_source: ContextVar[Optional[Tuple[str, str]]] = ContextVar(
    "active_cte_source", default=None
)


def set_active_cte_source(parquet_source: Optional[str], source_view: Optional[str]) -> None:
    """Bind the data source new graphs are created against (``None`` clears)."""
    ps = (parquet_source or "").strip()
    sv = (source_view or "").strip()
    _active_source.set((ps, sv) if (ps or sv) else None)


def get_active_cte_source() -> Optional[Tuple[str, str]]:
    """Return the current request's active ``(parquet_source, source_view)``."""
    return _active_source.get()


def get_repository(graph_id: Optional[str] = None) -> CTEGraphRepository:
    """Return a cached :class:`CTEGraphRepository` for *graph_id*.

    When *graph_id* is omitted, resolve the per-request active graph
    (``set_active_cte_graph``) and finally ``DEFAULT_GRAPH_ID``. A newly
    constructed repo is bound to the active source (``set_active_cte_source``)
    when one is set, so new skill graphs read from the skill's data.
    """
    if graph_id is None:
        graph_id = _active_graph_id.get() or DEFAULT_GRAPH_ID
    with _repo_lock:
        repo = _repos.get(graph_id)
        if repo is None:
            src = _active_source.get()
            kwargs: Dict[str, Any] = {"graph_id": graph_id}
            if src:
                ps, sv = src
                if ps:
                    kwargs["parquet_source"] = ps
                if sv:
                    kwargs["source_view"] = sv
            repo = CTEGraphRepository(**kwargs)
            _repos[graph_id] = repo
        return repo
