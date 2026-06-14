"""routes/cte_graph.py — CTE dependency graph API.

Endpoints
─────────
``POST /cte-graph/build``
    Parse a SQL string + a description map, build a NetworkX DiGraph,
    persist it, return ``{graph_id, node_count, edge_count}``.

``GET /cte-graph/{graph_id}``
    Return the graph in ReactFlow-compatible JSON.

``POST /cte-graph/search``
    Semantic search over the descriptions of one graph.

``GET /cte-graph/{graph_id}/node/{node_id}/parent-paths``
    Enumerate every simple path from any root to *node_id* and report
    the shortest one + a highlight payload for the front-end.

A separate prefix from the existing ``/graph/*`` namespace
(``ReasoningGraph`` — code-knowledge graph) keeps the two services
unambiguous.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import unicodedata
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from uuid import uuid4

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from services.cte_graph import (
    BuildError,
    CycleError,
    DEFAULT_LIBRARIES,
    EmbeddingService,
    GraphBuilder,
    GraphStore,
    LibraryError,
    ParentPathFinder,
    ParseError,
    SemanticSearch,
    load_library,
    to_reactflow,
)
from services.cte_graph.library_graph_cache import invalidate_cte_library_graph_caches
from tools.accounting_tools import execute_accounting_cte_structured

from flows.dto_cache_flow import (
    format_selected_dto_schemas_for_prompt,
    get_dto_cache,
    list_dto_stems_on_disk,
)


logger = logging.getLogger(__name__)
router = APIRouter()


# ── Request / response models ──────────────────────────────────────────────


class BuildRequest(BaseModel):
    sql: str = Field(..., min_length=1, description="SQL with WITH clause")
    cte_descriptions: Dict[str, str] = Field(
        default_factory=dict,
        description="Optional map of CTE name → description.",
    )
    dialect: Optional[str] = Field(
        default="duckdb",
        description="sqlglot dialect; defaults to DuckDB.",
    )


class BuildResponse(BaseModel):
    graph_id:   str
    node_count: int
    edge_count: int
    roots:      List[str]
    leaves:     List[str]


class BuildLibraryRequest(BaseModel):
    """Optional payload for ``POST /cte-graph/build-library``.

    *libraries* lets the caller restrict the build to a subset of the
    sub-folders under ``data/reporting/sql/`` (defaults to every folder
    declared in :data:`DEFAULT_LIBRARIES`).

    When *profile_id* is set, *libraries* on this body are ignored and the
    profile's saved library list is used. The graph is stored under a stable
    id ``cte-prof-<profile_id>`` so each catalogue card maps to one graph.
    """

    libraries: Optional[List[str]] = Field(
        default=None,
        description=(
            "Sub-folders to load (e.g. ['accounting', 'blocks']). "
            "Ignored when profile_id is set."
        ),
    )
    profile_id: Optional[str] = Field(
        default=None,
        description=(
            "Build from this profile's libraries and persist under the canonical "
            "graph id for that profile."
        ),
    )
    force_rebuild: bool = Field(
        default=False,
        description="When true with profile_id, rebuild even if a graph pickle already exists.",
    )


class GenerateProfileGraphRequest(BaseModel):
    """Payload optionnel pour la génération agent d'une chaîne CTE linéaire."""

    additional_instructions: str = Field(
        default="",
        description="Instructions ou contraintes métier supplémentaires pour le plan SQL.",
    )


class GenerateProfileGraphResponse(BaseModel):
    """Résultat de la génération + graphe reconstruit."""

    success: bool
    message: str
    graph_id: Optional[str] = None
    node_count: int = 0
    edge_count: int = 0
    roots: List[str] = Field(default_factory=list)
    leaves: List[str] = Field(default_factory=list)
    cte_count: int = 0
    chain_warning: Optional[str] = None
    plan_reasoning: Optional[str] = None
    error: Optional[str] = None
    duration_ms: float = 0.0


class ReactFlowGraph(BaseModel):
    nodes: List[Dict[str, Any]]
    edges: List[Dict[str, Any]]


class SearchRequest(BaseModel):
    graph_id: str = Field(..., min_length=1)
    query:    str = Field(..., min_length=1)
    top_k:    int = Field(5, ge=1, le=50)


class SearchHit(BaseModel):
    node_id:          str
    name:             str
    description:      str
    similarity_score: float
    parents:          List[str]
    children:         List[str]


class HighlightEdge(BaseModel):
    source: str
    target: str


class Highlight(BaseModel):
    nodes: List[str]
    edges: List[HighlightEdge]


class ParentPathsResponse(BaseModel):
    selected_node:    str
    all_parent_paths: List[List[str]]
    shortest_path:    List[str]
    highlight:        Highlight


class QueryRequest(BaseModel):
    graph_id: str = Field(..., min_length=1)
    query: str = Field(..., min_length=1)
    parquet_paths: Dict[str, str] = Field(
        default_factory=dict,
        description="Optional `{ledger,balance}` parquet overrides.",
    )
    parameters: Dict[str, Any] = Field(
        default_factory=dict,
        description="Optional runtime parameters such as `period`.",
    )
    top_k: int = Field(5, ge=1, le=20)
    max_rows: int = Field(50, ge=1, le=1000)
    cte_name: Optional[str] = Field(
        default=None,
        description="Optional explicit executable CTE selection.",
    )


class QueryExecutionResponse(BaseModel):
    cte_name: Optional[str]
    description: str
    execution_chain: List[str]
    columns: List[str]
    rows: List[Dict[str, Any]]
    row_count: int
    truncated: bool
    sql: str
    parameters: Dict[str, Any]
    bound_parameters: Dict[str, Any]
    missing_parameters: List[str]
    resolved_paths: Dict[str, str]


class QueryResponse(BaseModel):
    selected_node: str
    matched_nodes: List[str]
    search_hits: List[SearchHit]
    parent_paths: ParentPathsResponse
    execution: QueryExecutionResponse


# ── Singletons (process-local) ─────────────────────────────────────────────
#
# We hold one ``EmbeddingService`` for the lifetime of the process so the
# heavy SentenceTransformer model loads only once.  The ``GraphStore``
# is similarly cached but does its own fine-grained locking, so it's
# safe to share across requests.

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_CTE_GRAPH_DIR    = _PROJECT_ROOT / "data" / "cte_graphs"
_REPORTING_SQL_DIR = _PROJECT_ROOT / "data" / "reporting" / "sql"
_PROFILE_FILE = _PROJECT_ROOT / "data" / "cte_graph_profiles.json"

_embeddings: Optional[EmbeddingService] = None
_store:      Optional[GraphStore]       = None


def _get_embeddings() -> EmbeddingService:
    global _embeddings
    if _embeddings is None:
        _embeddings = EmbeddingService()
    return _embeddings


def _get_store() -> GraphStore:
    global _store
    if _store is None:
        _store = GraphStore(_CTE_GRAPH_DIR)
    return _store


_RE_PERIOD_RANGE = re.compile(r"(\d{4}-\d{2}-\d{2})\s*(?:\.\.|au|to|-)\s*(\d{4}-\d{2}-\d{2})")
_RE_PERIOD_MONTH = re.compile(r"\b(20\d{2}-\d{2})\b")
_RE_PERIOD_DATE = re.compile(r"\b(20\d{2}-\d{2}-\d{2})\b")
_RE_PERIOD_YEAR = re.compile(r"\b(20\d{2})\b")


def _infer_query_parameters(query: str, explicit: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(explicit or {})
    lower_keys = {str(k).lower() for k in out}
    if "period" in lower_keys:
        return out

    text = (query or "").strip()
    if not text:
        return out

    if m := _RE_PERIOD_RANGE.search(text):
        out["period"] = f"{m.group(1)}..{m.group(2)}"
        return out
    if m := _RE_PERIOD_MONTH.search(text):
        out["period"] = m.group(1)
        return out
    if m := _RE_PERIOD_DATE.search(text):
        out["period"] = m.group(1)
        return out
    if m := _RE_PERIOD_YEAR.search(text):
        year = m.group(1)
        out["period"] = f"{year}-01-01..{year}-12-31"
    return out


def _normalize_query_text(text: str) -> str:
    raw = unicodedata.normalize("NFKD", text or "")
    ascii_text = "".join(ch for ch in raw if not unicodedata.combining(ch))
    return re.sub(r"\s+", " ", ascii_text).strip().lower()


def _query_mentions_opex(text: str) -> bool:
    lowered = _normalize_query_text(text)
    if "opex" in lowered:
        return True
    has_charge = "charge" in lowered or "depense" in lowered or "expense" in lowered
    return has_charge and (
        "exploitation" in lowered
        or "operating" in lowered
        or "operationnelle" in lowered
        or "operationnelles" in lowered
    )


def _pick_best_accounting_node(
    graph: Any,
    ranked_hits: List[Dict[str, Any]],
    query: str,
) -> Optional[str]:
    normalized = _normalize_query_text(query)
    wants_list = any(token in normalized for token in [
        "liste", "detail", "details", "detaillee", "detaillees",
        "breakdown", "par compte", "par categorie", "par categorie",
    ])
    wants_total = any(token in normalized for token in [
        "total", "montant", "combien", "c quoi", "c est quoi", "what is",
    ])
    mentions_opex = _query_mentions_opex(query)

    hit_scores = {hit["node_id"]: float(hit.get("similarity_score") or 0.0) for hit in ranked_hits}
    candidates: List[tuple[float, str]] = []
    for node_id, attrs in graph.nodes(data=True):
        # Executable = the node carries SQL. (Legacy graphs stamped a node-level
        # `library="accounting"`; CTEs created via upsert_cte don't — gate on rawSql.)
        if not str(attrs.get("rawSql") or "").strip():
            continue
        name = str(attrs.get("name", node_id))
        description = str(attrs.get("description", "") or "")
        projects = [
            p for p in (attrs.get("projects") or [])
            if isinstance(p, str) and p and not p.startswith("<")
        ]
        multi_project = len(projects) > 1
        node_text = _normalize_query_text(f"{name} {description}")
        score = hit_scores.get(node_id, 0.0)

        if wants_list and multi_project:
            score += 0.18
        if wants_total and not multi_project:
            score += 0.14

        if mentions_opex:
            if node_id == "opex_breakdown" and wants_list:
                score += 1.35
            if node_id == "opex_total" and wants_total:
                score += 1.10
            if node_id == "opex_breakdown" and wants_total:
                score += 0.35
            if any(token in node_text for token in [
                "charges d exploitation",
                "charge d exploitation",
                "operating expenses",
                "opex",
                "autres charges",
            ]):
                score += 0.45

        candidates.append((score, node_id))

    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates[0][1]


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _slugify(value: str) -> str:
    raw = unicodedata.normalize("NFKD", value or "")
    ascii_text = "".join(ch for ch in raw if not unicodedata.combining(ch))
    slug = re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")
    return slug or "cte-graph"


def _graph_id_for_profile(profile_id: str) -> str:
    """Canonical GraphStore key for a CTE profile (one graph per catalogue card)."""
    safe = _slugify(profile_id)
    return f"cte-prof-{safe}"


def _profile_cte_count(profile_id: str) -> int:
    """Number of CTEs in a profile's built graph (0 if not built / empty)."""
    try:
        g = _get_store().get(_graph_id_for_profile(profile_id))
        return int(g.number_of_nodes()) if g is not None else 0
    except Exception:
        return 0


def _skill_graph_index() -> Dict[str, str]:
    """Map a profile graph_id (``cte-prof-<slug>``) → its SKILL.md name, when linked.

    A skill binds to ``cte-prof-<slug(skill name)>``; profiles whose id slugs to the
    same key are the same graph, so they're "associated to" that SKILL.md.
    """
    out: Dict[str, str] = {}
    try:
        from skill_registry import load_skill_definitions

        for sd in load_skill_definitions():
            label = (getattr(sd, "name", "") or getattr(sd, "directory_name", "") or "").strip()
            for key in (getattr(sd, "name", ""), getattr(sd, "directory_name", "")):
                if key and key.strip():
                    out[_graph_id_for_profile(key.strip())] = label
    except Exception:
        logger.warning("skill graph index unavailable", exc_info=True)
    return out


def _available_dto_stems() -> List[str]:
    """Stems from on-disk ``*_dto.py`` plus any extra keys in the runtime DTO cache."""
    return sorted(set(list_dto_stems_on_disk()) | set(get_dto_cache().keys()))


def _pkl_library_names() -> List[str]:
    """Library names backed by a persisted pickle graph (``cte-prof-<slug>.pkl``)."""
    if not _CTE_GRAPH_DIR.is_dir():
        return []
    names: List[str] = []
    for p in _CTE_GRAPH_DIR.glob("cte-prof-*.pkl"):
        slug = p.stem[len("cte-prof-"):]
        if slug:
            names.append(slug.replace("-", "_"))
    return sorted(set(names))


def _available_libraries() -> List[str]:
    folder_names: List[str] = []
    if _REPORTING_SQL_DIR.is_dir():
        folder_names = [
            path.name
            for path in _REPORTING_SQL_DIR.iterdir()
            if path.is_dir() and (path / "index.yaml").exists()
        ]
    names = sorted(set(folder_names) | set(_pkl_library_names()))
    return names or list(DEFAULT_LIBRARIES)


def _sql_library_dir_for_profile_id(profile_id: str) -> Optional[Path]:
    """Resolved path to ``data/reporting/sql/<profile_id>/`` if *profile_id* is a safe single segment."""
    if not profile_id or not re.match(r"^[A-Za-z0-9][A-Za-z0-9._-]*$", profile_id):
        return None
    candidate = (_REPORTING_SQL_DIR / profile_id).resolve()
    root = _REPORTING_SQL_DIR.resolve()
    try:
        candidate.relative_to(root)
    except ValueError:
        return None
    return candidate


def _library_folder_names() -> List[str]:
    """Each catalogue card: an on-disk library folder (``index.yaml``) or a pickle graph."""
    folder_names: List[str] = []
    if _REPORTING_SQL_DIR.is_dir():
        folder_names = [
            path.name
            for path in _REPORTING_SQL_DIR.iterdir()
            if path.is_dir() and (path / "index.yaml").is_file()
        ]
    return sorted(set(folder_names) | set(_pkl_library_names()))


# Map pre-v2 profile ids (multi-library / marketing ids) → canonical folder name.
_LEGACY_PROFILE_TO_LIBRARY: Dict[str, Optional[str]] = {
    "finance-accounting-core": "accounting",
    "reporting-blocks-layout": "blocks",
    "full-reporting-catalog": None,  # combined view — dropped when syncing to one-folder rule
    "audit-assurance-contrats": "insurance_audit",
}


def _template_for_library(lib: str) -> Dict[str, Any]:
    """Default label/help text for a library folder (id == folder name)."""
    meta: Dict[str, Tuple[str, str, List[str]]] = {
        "accounting": (
            "Comptabilité (ledger / balance)",
            (
                "Graphe des CTE comptables exécutables sur ledger et balance, orienté chiffre "
                "d'affaires, charges, marges et soldes."
            ),
            [
                "Quel est le chiffre d'affaires 2025 ?",
                "Donne la liste des charges d'exploitation 2025.",
            ],
        ),
        "blocks": (
            "Blocs de reporting",
            (
                "CTE de blocs et dépendances de template : quels fragments alimentent les "
                "sections du rapport HTML."
            ),
            [
                "Quel bloc alimente le score global ?",
            ],
        ),
        "insurance_audit": (
            "Audit assurance",
            (
                "CTE de contrôle sur la table contrats. Fichiers sous "
                "data/reporting/sql/insurance_audit/ ; recharger le graphe après régénération."
            ),
            [
                "Quelles anomalies prime nette vs RC ?",
            ],
        ),
    }
    if lib in meta:
        name, desc, examples = meta[lib]
    else:
        name = lib.replace("_", " ").title()
        desc = f"Bibliothèque CTE « {lib} » (dossier data/reporting/sql/{lib}/)."
        examples = [f"Exemple de question sur la bibliothèque {lib} ?"]
    return {
        "id": lib,
        "name": name,
        "description": desc,
        "libraries": [lib],
        "dto_stems": [],
        "query_examples": examples,
        "updated_at": _utc_now_iso(),
    }


def _merge_saved_folder_profile(lib: str, template: Dict[str, Any], saved: Dict[str, Any]) -> Dict[str, Any]:
    """Keep user-edited name, description, examples, DTOs, graph_id; force id and single library."""
    out = {**template}
    if saved.get("name"):
        out["name"] = str(saved["name"]).strip() or out["name"]
    if saved.get("description") is not None:
        out["description"] = str(saved.get("description") or "").strip()
    if saved.get("query_examples"):
        out["query_examples"] = list(saved["query_examples"])
    if saved.get("dto_stems"):
        out["dto_stems"] = list(saved["dto_stems"])
    if saved.get("graph_id"):
        out["graph_id"] = str(saved["graph_id"]).strip()
    if saved.get("updated_at"):
        out["updated_at"] = str(saved["updated_at"])
    out["id"] = lib
    out["libraries"] = [lib]
    return out


def _sync_profiles_from_disk() -> List[Dict[str, Any]]:
    """One profile per CTE library folder; merge customizations from cte_graph_profiles.json."""
    folders = _library_folder_names()
    saved_list: List[Dict[str, Any]] = []
    if _PROFILE_FILE.exists():
        try:
            payload = json.loads(_PROFILE_FILE.read_text(encoding="utf-8"))
            raw = payload.get("profiles") if isinstance(payload, dict) else None
            if isinstance(raw, list):
                saved_list = [x for x in raw if isinstance(x, dict)]
        except Exception:
            saved_list = []

    saved_by_lib: Dict[str, Dict[str, Any]] = {}
    for s in saved_list:
        libs = [x for x in (s.get("libraries") or []) if isinstance(x, str)]
        if len(libs) == 1 and libs[0] in folders:
            # Prefer the latest if duplicates
            saved_by_lib[libs[0]] = s
            continue
        sid = str(s.get("id") or "")
        mapped = _LEGACY_PROFILE_TO_LIBRARY.get(sid)
        if mapped and mapped in folders:
            if mapped not in saved_by_lib:
                saved_by_lib[mapped] = {**s, "id": mapped, "libraries": [mapped]}

    merged: List[Dict[str, Any]] = []
    for lib in folders:
        template = _template_for_library(lib)
        saved = saved_by_lib.get(lib)
        if saved:
            merged.append(_merge_saved_folder_profile(lib, template, saved))
        else:
            merged.append(template)
    return merged


def _normalize_profile_record(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Each profile references exactly one on-disk library folder."""
    available = set(_available_libraries())
    folders = set(_library_folder_names())
    raw_libs = [
        lib for lib in raw.get("libraries", [])
        if isinstance(lib, str) and lib in available
    ]
    pid = str(raw.get("id") or _slugify(str(raw.get("name") or uuid4().hex)))

    if len(raw_libs) > 1:
        if pid in folders and pid in available:
            raw_libs = [pid]
        else:
            raw_libs = [raw_libs[0]]
    if not raw_libs:
        if pid in available:
            raw_libs = [pid]
        else:
            names = sorted(folders & available)
            raw_libs = [names[0]] if names else ([list(DEFAULT_LIBRARIES)[0]] if DEFAULT_LIBRARIES else [])
    libraries = raw_libs[:1]

    dto_ok = set(_available_dto_stems())
    dto_stems = [
        s for s in raw.get("dto_stems", [])
        if isinstance(s, str) and s.strip() and s.strip() in dto_ok
    ]
    dto_stems = sorted(set(dto_stems))
    query_examples = [
        example.strip()
        for example in raw.get("query_examples", [])
        if isinstance(example, str) and example.strip()
    ]
    graph_id: Optional[str] = None
    if raw.get("graph_id") is not None and str(raw.get("graph_id")).strip():
        graph_id = str(raw.get("graph_id")).strip()
    return {
        "id": str(raw.get("id") or _slugify(str(raw.get("name") or uuid4().hex))),
        "name": str(raw.get("name") or "Nouveau graphe CTE").strip() or "Nouveau graphe CTE",
        "description": str(raw.get("description") or "").strip(),
        "libraries": libraries,
        "dto_stems": dto_stems,
        "query_examples": query_examples,
        "updated_at": str(raw.get("updated_at") or _utc_now_iso()),
        "graph_id": graph_id,
    }


def _write_profiles_file(profiles: List[Dict[str, Any]], *, only_if_changed: bool = True) -> None:
    normalized = [_normalize_profile_record(p) for p in profiles]
    payload = json.dumps({"profiles": normalized}, ensure_ascii=False, indent=2) + "\n"
    if only_if_changed and _PROFILE_FILE.exists():
        try:
            if _PROFILE_FILE.read_text(encoding="utf-8") == payload:
                return
        except OSError:
            pass
    _PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)
    _PROFILE_FILE.write_text(payload, encoding="utf-8")


def _ensure_profile_file() -> None:
    """Ensure parent dir exists; catalogue rows are derived from SQL library folders."""
    _PROFILE_FILE.parent.mkdir(parents=True, exist_ok=True)


def _load_profiles() -> List[Dict[str, Any]]:
    _ensure_profile_file()
    merged = _sync_profiles_from_disk()
    out = [_normalize_profile_record(item) for item in merged]
    _write_profiles_file(out, only_if_changed=True)
    return out


def _save_profiles(profiles: List[Dict[str, Any]]) -> None:
    _write_profiles_file(profiles, only_if_changed=False)


def _set_profile_graph_id(profile_id: str, graph_id: str) -> None:
    """Persist the canonical graph id on a profile after a successful build."""
    profiles = _load_profiles()
    for index, profile in enumerate(profiles):
        if profile["id"] != profile_id:
            continue
        merged = {**profile, "graph_id": graph_id, "updated_at": _utc_now_iso()}
        profiles[index] = _normalize_profile_record(merged)
        _save_profiles(profiles)
        return


def _find_profile_or_404(profile_id: str) -> Dict[str, Any]:
    for profile in _load_profiles():
        if profile["id"] == profile_id:
            return profile
    raise HTTPException(status_code=404, detail=f"CTE graph profile not found: {profile_id}")


def _rebuild_stored_graph_for_profile(profile_id: str) -> BuildResponse:
    """Charge les CTE sur disque pour le dossier du profil et persiste le graphe canonique."""
    profile_rec = _find_profile_or_404(profile_id)
    libraries = list(profile_rec.get("libraries") or [])
    if not libraries:
        raise HTTPException(
            status_code=400,
            detail={"error": "no_libraries", "message": "Profil sans dossier bibliothèque."},
        )

    try:
        records = load_library(_REPORTING_SQL_DIR, libraries=libraries)
    except LibraryError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "library_error", "message": str(e)},
        ) from e
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=404,
            detail={"error": "library_missing", "message": str(e)},
        ) from e

    builder = GraphBuilder(embeddings=_get_embeddings())
    # Preserve graph-level metadata (parquet_source / source_view) across rebuilds.
    canonical_gid = _graph_id_for_profile(profile_id)
    _existing = _get_store().get(canonical_gid)
    _graph_meta = dict(_existing.graph) if _existing is not None else None
    try:
        graph = builder.build_from_library(records, graph_meta=_graph_meta)
    except CycleError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "cyclic_dependency", "cycle": e.cycle, "message": str(e)},
        ) from e
    except BuildError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "build_error", "message": str(e)},
        ) from e

    stats = GraphBuilder.stats(graph)
    graph_id = _get_store().put(graph, graph_id=canonical_gid)
    _set_profile_graph_id(profile_id, graph_id)
    invalidate_cte_library_graph_caches()

    return BuildResponse(
        graph_id   = graph_id,
        node_count = stats["node_count"],
        edge_count = stats["edge_count"],
        roots      = stats["roots"],
        leaves     = stats["leaves"],
    )


def _coerce_profile_id(name: str, requested_id: Optional[str] = None) -> str:
    base = _slugify(requested_id or name)
    existing = {profile["id"] for profile in _load_profiles()}
    if base not in existing:
        return base
    idx = 2
    while f"{base}-{idx}" in existing:
        idx += 1
    return f"{base}-{idx}"


def _extract_last_user_message(messages: List["ProfileChatMessage"]) -> str:
    for message in reversed(messages):
        if message.role == "user" and message.content.strip():
            return message.content.strip()
    return ""


def _instruction_updates_profile(
    current_id: str,
    instruction: str,
    profiles: List[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """When the UI has an open profile and the user states a business/SQL constraint.

    Returns a full assistant payload with ``operation="update"`` or ``None`` if the
    message does not look like an instruction (leave LLM / heuristic answer).
    """
    instruction = (instruction or "").strip()
    if not instruction:
        return None
    low = instruction.lower()
    triggers = (
        "colonne",
        "colonnes",
        "solde",
        "calcul",
        "calculs",
        "dto",
        "utiliser",
        "doit",
        "doivent",
        "devoir",
        "ledger",
        "balance",
        "filtre",
        "filtres",
        "agrég",
        "montant",
        "compte",
        "grand livre",
        "reporting",
    )
    if not any(t in low for t in triggers):
        return None

    base = next((dict(p) for p in profiles if p.get("id") == current_id), None)
    if not base:
        return None

    desc = (base.get("description") or "").strip()
    if instruction.lower() not in desc.lower():
        new_desc = f"{desc}\n\n— Consigne métier : {instruction}".strip() if desc else f"Consigne métier : {instruction}"
    else:
        new_desc = desc or instruction

    qex = [x for x in (base.get("query_examples") or []) if isinstance(x, str) and x.strip()]
    if instruction not in qex and len(qex) < 30:
        qex.append(instruction[:500])

    dto_stems = [s for s in (base.get("dto_stems") or []) if isinstance(s, str)]
    avail = set(_available_dto_stems())
    if any(k in low for k in ("solde", "balance", "grand livre")):
        for stem in sorted(avail):
            sl = stem.lower()
            if ("balance" in sl or "grand_livre" in sl or "livre" in sl) and stem not in dto_stems:
                dto_stems.append(stem)

    merged = {
        **base,
        "description": new_desc,
        "query_examples": qex,
        "dto_stems": sorted({s for s in dto_stems if s in avail}),
        "updated_at": _utc_now_iso(),
    }
    merged = _normalize_profile_record(merged)

    ready_to_generate, follow_up_questions = _infer_cte_generation_state(
        instruction,
        merged,
    )

    return {
        "assistant_message": (
            "Le contexte du graphe est suffisant. Enregistrez puis utilisez « Générer le graph » "
            "pour proposer les CTE et reconstruire le schéma."
            if ready_to_generate
            else "J’ai enrichi le brouillon du profil, mais il me manque encore quelques précisions avant de générer les CTE."
        ),
        "operation": "update",
        "target_profile_id": current_id,
        "draft_profile": merged,
        "ready_to_generate": ready_to_generate,
        "follow_up_questions": follow_up_questions,
    }


def _infer_cte_generation_state(
    latest_user_message: str,
    current_profile: Optional[Dict[str, Any]] = None,
) -> Tuple[bool, List[str]]:
    text_parts = [latest_user_message or ""]
    if current_profile:
        text_parts.append(str(current_profile.get("description") or ""))
        text_parts.extend(str(x) for x in (current_profile.get("query_examples") or []) if x)
        text_parts.extend(str(x) for x in (current_profile.get("dto_stems") or []) if x)
    normalized = _normalize_query_text(" ".join(text_parts))

    has_scope = any(token in normalized for token in (
        "chiffre d affaire", "ca ", "revenu", "revenue", "charge", "solde", "marge",
        "contrat", "prime", "ledger", "balance", "grand livre", "audit", "reporting",
        "compte", "resultat", "kpi",
    ))
    has_sources = any(token in normalized for token in (
        "ledger", "balance", "parquet", "dto", "grand livre", "colon", "source",
        "table", "vue", "journal", "ecriture",
    ))
    has_output = any(token in normalized for token in (
        "calcul", "colonne", "colonnes", "liste", "total", "agreg", "agrég",
        "group", "resultat", "sortie", "kpi", "tableau", "detail", "comparatif",
        "mensuel", "annuel", "par ", "by ",
    ))

    follow_up_questions: List[str] = []
    if not has_scope:
        follow_up_questions.append(
            "Quel indicateur ou domaine métier ce graphe doit-il couvrir exactement ?"
        )
    if not has_sources:
        follow_up_questions.append(
            "Quelles sources ou classes DTO doivent alimenter les CTE (ledger, balance, autre) ?"
        )
    if not has_output:
        follow_up_questions.append(
            "Quel résultat final attendez-vous : colonnes, agrégations ou tableau de sortie ?"
        )
    return len(follow_up_questions) == 0, follow_up_questions[:3]


def _heuristic_profile_assistant(
    latest_user_message: str,
    profiles: List[Dict[str, Any]],
    current_profile_id: Optional[str] = None,
) -> Dict[str, Any]:
    if current_profile_id:
        forced = _instruction_updates_profile(current_profile_id, latest_user_message, profiles)
        if forced is not None:
            return forced

    normalized = _normalize_query_text(latest_user_message)
    by_name = {
        _normalize_query_text(profile["name"]): profile
        for profile in profiles
    }
    available = _available_libraries()
    ready_to_generate, follow_up_questions = _infer_cte_generation_state(latest_user_message)

    if any(token in normalized for token in ["supprime", "supprimer", "delete", "remove"]):
        target = next(
            (
                profile
                for key, profile in by_name.items()
                if key and key in normalized
            ),
            None,
        )
        if target:
            return {
                "assistant_message": (
                    f"Suppression proposée pour le graphe « {target['name']} ». "
                    "Appliquez l'action pour retirer ce profil du catalogue."
                ),
                "operation": "delete",
                "target_profile_id": target["id"],
                "draft_profile": None,
                "ready_to_generate": False,
                "follow_up_questions": [],
            }
        return {
            "assistant_message": (
                "Je n'ai pas pu identifier le graphe à supprimer. "
                "Mentionnez explicitement son nom pour que je prépare la suppression."
            ),
            "operation": "none",
            "target_profile_id": None,
            "draft_profile": None,
            "ready_to_generate": False,
            "follow_up_questions": [
                "Quel est le nom exact du graphe CTE à supprimer ?",
            ],
        }

    if not ready_to_generate:
        return {
            "assistant_message": (
                "J’ai besoin de quelques précisions avant de proposer les CTE du graphe. "
                "Répondez aux questions ci-dessous et je préparerai ensuite le brouillon."
            ),
            "operation": "none",
            "target_profile_id": None,
            "draft_profile": None,
            "ready_to_generate": False,
            "follow_up_questions": follow_up_questions,
        }

    libraries = [lib for lib in available if lib in normalized]
    suggested_id = _coerce_profile_id(latest_user_message[:80] or "nouveau-graphe-cte")
    if libraries:
        suggested_id = libraries[0]
    name = "Nouveau graphe CTE"

    return {
        "assistant_message": (
            "Le contexte est suffisant. J’ai préparé un brouillon de profil ; appliquez-le puis "
            "utilisez « Enregistrer + Générer » pour créer les CTE et reconstruire le schéma."
        ),
        "operation": "create",
        "target_profile_id": None,
        "draft_profile": _normalize_profile_record(
            {
                "id": suggested_id,
                "name": name,
                "description": latest_user_message,
                "libraries": [suggested_id],
                "query_examples": [latest_user_message[:500]],
            }
        ),
        "ready_to_generate": True,
        "follow_up_questions": [],
    }


class CTEGraphProfile(BaseModel):
    id: str
    name: str
    description: str = ""
    libraries: List[str] = Field(default_factory=list)
    dto_stems: List[str] = Field(default_factory=list)
    query_examples: List[str] = Field(default_factory=list)
    updated_at: str
    graph_id: Optional[str] = Field(
        default=None,
        description="Stable id of the last built graph for this profile (cte-prof-<id>).",
    )
    cte_count: int = Field(default=0, description="Number of CTEs in the built graph.")
    skill: Optional[str] = Field(
        default=None, description="SKILL.md this graph is associated with (if any)."
    )


class CTEGraphProfileCreate(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., min_length=1)
    description: str = ""
    # A CTE graph MUST be associated to a SKILL.md (its `name` or directory_name).
    skill: str = Field(..., min_length=1)
    libraries: List[str] = Field(default_factory=list)
    dto_stems: List[str] = Field(default_factory=list)
    query_examples: List[str] = Field(default_factory=list)


class CTEGraphProfileUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    libraries: Optional[List[str]] = None
    dto_stems: Optional[List[str]] = None
    query_examples: Optional[List[str]] = None


class CTEGraphProfileListResponse(BaseModel):
    profiles: List[CTEGraphProfile]
    available_libraries: List[str]
    available_dto_stems: List[str]
    count: int


class ProfileChatMessage(BaseModel):
    role: str
    content: str


class ProfileAssistantRequest(BaseModel):
    messages: List[ProfileChatMessage]
    current_profile_id: Optional[str] = None
    dto_stems: Optional[List[str]] = Field(
        default=None,
        description="DTO parquet stems selected in the UI — schema text is injected for the assistant.",
    )


class ProfileAssistantResponse(BaseModel):
    assistant_message: str
    operation: str
    target_profile_id: Optional[str] = None
    draft_profile: Optional[CTEGraphProfile] = None
    ready_to_generate: bool = False
    follow_up_questions: List[str] = Field(default_factory=list)


# ── Endpoints ──────────────────────────────────────────────────────────────


@router.get(
    "/profiles",
    response_model=CTEGraphProfileListResponse,
    summary="List available CTE graph profiles",
)
async def list_cte_graph_profiles() -> CTEGraphProfileListResponse:
    skill_idx = _skill_graph_index()
    profiles = []
    for profile in _load_profiles():
        gid = _graph_id_for_profile(profile["id"])
        profiles.append(CTEGraphProfile(**{
            **profile,
            "cte_count": _profile_cte_count(profile["id"]),
            "skill": skill_idx.get(gid),
        }))
    return CTEGraphProfileListResponse(
        profiles=profiles,
        available_libraries=_available_libraries(),
        available_dto_stems=_available_dto_stems(),
        count=len(profiles),
    )


@router.get(
    "/profiles/{profile_id}",
    response_model=CTEGraphProfile,
    summary="Get one CTE graph profile",
)
async def get_cte_graph_profile(profile_id: str) -> CTEGraphProfile:
    return CTEGraphProfile(**_find_profile_or_404(profile_id))


@router.post(
    "/profiles",
    response_model=CTEGraphProfile,
    status_code=201,
    summary="Create a CTE graph profile",
)
async def create_cte_graph_profile(body: CTEGraphProfileCreate) -> CTEGraphProfile:
    skill = (body.skill or "").strip()
    if not skill:
        raise HTTPException(
            status_code=400,
            detail="Un graphe CTE doit être associé à un skill (SKILL.md). Sélectionnez un skill.",
        )
    # Tie the profile to the skill: id slugs to the skill so the built graph is the
    # skill's library (cte-prof-<slug(skill)>).
    profile_id = _slugify(skill)
    library_dir = _sql_library_dir_for_profile_id(profile_id)
    if library_dir is None:
        raise HTTPException(
            status_code=400,
            detail="Identifiant invalide. Utilisez un nom de dossier simple (lettres, chiffres, ., _, -).",
        )
    if library_dir.exists():
        raise HTTPException(
            status_code=409,
            detail=f"Le dossier data/reporting/sql/{profile_id}/ existe déjà.",
        )

    payload = {
        "version": 1,
        "ctes": [],
    }
    try:
        library_dir.mkdir(parents=True, exist_ok=False)
        (library_dir / "index.yaml").write_text(
            yaml.safe_dump(payload, sort_keys=False, allow_unicode=True),
            encoding="utf-8",
        )
    except Exception as exc:
        try:
            if library_dir.exists():
                for child in library_dir.iterdir():
                    child.unlink(missing_ok=True)
                library_dir.rmdir()
        except Exception:
            logger.warning("Failed to rollback CTE library dir creation for %s", profile_id, exc_info=True)
        raise HTTPException(
            status_code=500,
            detail=f"Impossible de créer le dossier CTE: {exc}",
        ) from exc

    profiles = _load_profiles()
    record = _normalize_profile_record({
        "id": profile_id,
        "name": body.name,
        "description": body.description,
        "libraries": [profile_id],
        "dto_stems": body.dto_stems or [],
        "query_examples": body.query_examples or [],
        "updated_at": _utc_now_iso(),
    })
    profiles = [p for p in profiles if p.get("id") != profile_id]
    profiles.append(record)
    _save_profiles(profiles)
    invalidate_cte_library_graph_caches()
    return CTEGraphProfile(**record)


@router.put(
    "/profiles/{profile_id}",
    response_model=CTEGraphProfile,
    summary="Update a CTE graph profile",
)
async def update_cte_graph_profile(
    profile_id: str,
    body: CTEGraphProfileUpdate,
) -> CTEGraphProfile:
    if body.libraries is not None:
        raise HTTPException(
            status_code=400,
            detail=(
                "Le champ « libraries » est fixé par le dossier sur disque "
                "(data/reporting/sql/<id>/). Ne l’envoyez pas lors d’une mise à jour."
            ),
        )
    profiles = _load_profiles()
    updated: Optional[Dict[str, Any]] = None
    for index, profile in enumerate(profiles):
        if profile["id"] != profile_id:
            continue
        next_record = dict(profile)
        if body.name is not None:
            next_record["name"] = body.name
        if body.description is not None:
            next_record["description"] = body.description
        if body.dto_stems is not None:
            next_record["dto_stems"] = body.dto_stems
        if body.query_examples is not None:
            next_record["query_examples"] = body.query_examples
        next_record["updated_at"] = _utc_now_iso()
        profiles[index] = _normalize_profile_record(next_record)
        updated = profiles[index]
        break
    if updated is None:
        raise HTTPException(status_code=404, detail=f"CTE graph profile not found: {profile_id}")
    _save_profiles(profiles)
    return CTEGraphProfile(**updated)


@router.delete(
    "/profiles/{profile_id}",
    summary="Delete a CTE graph profile",
)
async def delete_cte_graph_profile(profile_id: str) -> Dict[str, Any]:
    profiles = _load_profiles()
    removed_record: Optional[Dict[str, Any]] = None
    for profile in profiles:
        if profile["id"] == profile_id:
            removed_record = profile
            break
    if removed_record is None:
        raise HTTPException(status_code=404, detail=f"CTE graph profile not found: {profile_id}")

    # Always drop the persisted graph for this card.
    _get_store().delete(_graph_id_for_profile(profile_id))
    gid = removed_record.get("graph_id")
    if gid:
        _get_store().delete(gid)

    lib_path = _sql_library_dir_for_profile_id(profile_id)
    removed_folder = bool(lib_path and lib_path.is_dir())
    if removed_folder:
        try:
            shutil.rmtree(lib_path)
        except OSError as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to remove CTE library directory {lib_path}: {e}",
            ) from e
        invalidate_cte_library_graph_caches()
        _load_profiles()
    else:
        remaining = [p for p in profiles if p["id"] != profile_id]
        _save_profiles(remaining)

    return {
        "success": True,
        "profile_id": profile_id,
        "removed_folder": removed_folder,
    }


@router.post(
    "/profiles/prune-empty",
    summary="Delete CTE graph profiles whose built graph has no CTEs",
)
async def prune_empty_cte_graph_profiles() -> Dict[str, Any]:
    deleted: List[str] = []
    for profile in list(_load_profiles()):
        pid = profile["id"]
        if _profile_cte_count(pid) == 0:
            try:
                await delete_cte_graph_profile(pid)
                deleted.append(pid)
            except HTTPException:
                logger.warning("prune-empty: could not delete profile %s", pid)
            except Exception:
                logger.warning("prune-empty: error deleting profile %s", pid, exc_info=True)
    return {"deleted": deleted, "count": len(deleted)}


@router.post(
    "/profiles/ai-assist",
    response_model=ProfileAssistantResponse,
    summary="Chat assistant for creating/updating/removing CTE graph profiles",
)
async def assist_cte_graph_profiles(body: ProfileAssistantRequest) -> ProfileAssistantResponse:
    profiles = _load_profiles()
    latest_user_message = _extract_last_user_message(body.messages)
    if not latest_user_message:
        return ProfileAssistantResponse(
            assistant_message=(
                "Décrivez le graphe CTE à créer, modifier ou supprimer. "
                "Précisez le périmètre métier et les bibliothèques visées."
            ),
            operation="none",
        )

    current_pid = (body.current_profile_id or "").strip()
    current_profile_doc: Optional[Dict[str, Any]] = None
    if current_pid:
        for profile in profiles:
            if profile.get("id") == current_pid:
                current_profile_doc = profile
                break

    system_prompt = """\
Tu aides à gérer un catalogue de graphes CTE pour Brikz.
Tu dois répondre strictement en JSON avec les clés:
- assistant_message: string
- operation: one of ["none","create","update","delete"]
- target_profile_id: string|null
- draft_profile: object|null with keys {id,name,description,libraries,dto_stems,query_examples,updated_at}
- ready_to_generate: boolean
- follow_up_questions: string[]

Contraintes:
- Réponds en français.
- Un profil = exactement un dossier `data/reporting/sql/<nom>/`.
- Pour un draft_profile, `libraries` doit contenir exactement un élément, identique à `id`.
- Pour une création, tu peux proposer un nouvel `id` de dossier simple (lettres, chiffres, tirets, underscores).
- `dto_stems` : liste de tiges parquet (stems) prises dans `available_dto_stems` du contexte. N'invente jamais de stems inconnus. Quand l'utilisateur cite des colonnes (ex. Solde), des soldes, grand livre ou balance, ajoute les DTO pertinents parmi `available_dto_stems` (ex. stems contenant balance, livre, ledger si disponibles).
- Si l'utilisateur demande une suppression, mets operation="delete" et renseigne target_profile_id.

**Profil déjà ouvert dans l'UI** — le contexte JSON inclut `current_profile_id` et souvent `current_profile` :
- Si `current_profile_id` est non nul et l'utilisateur formule une **consigne métier ou technique** (colonnes à utiliser, calculs, soldes, DTO, règles de reporting, etc.), tu **dois** répondre avec operation="update", target_profile_id égal à `current_profile_id`, et un draft_profile qui reprend ce profil en enrichissant **description** (résume la consigne) et **query_examples** / **dto_stems** si pertinent.
- **Ne pose pas** la question « voulez-vous créer un nouveau profil ou modifier l'existant » lorsque `current_profile_id` est défini : la cible est toujours le profil ouvert.
- Tu ne modifies pas les fichiers `.sql` sur disque ; dans assistant_message, signale en une phrase qu'il faudra **Enregistrer** le profil puis éventuellement **Générer le graph** (ou éditer les SQL) pour refléter la règle dans les CTE.

- Si le contexte n'est pas assez précis pour proposer les CTE, mets ready_to_generate=false et remplis follow_up_questions avec 1 à 3 questions courtes.
- Si le contexte est suffisant pour préparer les CTE, mets ready_to_generate=true et propose un brouillon cohérent (create ou update).
- Si l'intention est vraiment hors sujet, mets operation="none" et pose une question courte.
"""

    dto_schema_text = ""
    if body.dto_stems:
        dto_schema_text = format_selected_dto_schemas_for_prompt(body.dto_stems)

    try:
        from config import get_settings
        from llm.llm_factory import get_llm

        settings = get_settings()
        client, _ = get_llm()

        payload_messages = [
            {"role": "system", "content": system_prompt},
            {
                "role": "system",
                "content": json.dumps(
                    {
                        "available_libraries": _available_libraries(),
                        "available_dto_stems": _available_dto_stems(),
                        "profiles": profiles,
                        "current_profile_id": body.current_profile_id,
                        "current_profile": current_profile_doc,
                    },
                    ensure_ascii=False,
                ),
            },
        ]
        if dto_schema_text:
            payload_messages.append(
                {
                    "role": "system",
                    "content": (
                        "Schémas DTO sélectionnés dans l'interface (contrats de colonnes pour CTE / SQL) :\n"
                        + dto_schema_text
                    ),
                }
            )
        payload_messages.extend(
            {"role": message.role, "content": message.content}
            for message in body.messages
        )
        response = client.chat.completions.create(
            model=settings.llm.model,
            messages=payload_messages,
            temperature=0.2,
            max_tokens=1200,
        )
        content = (response.choices[0].message.content or "").strip()
        if content.startswith("```"):
            content = re.sub(r"^```(?:json)?\s*", "", content)
            content = re.sub(r"\s*```$", "", content)
        parsed = json.loads(content)
    except Exception:
        parsed = _heuristic_profile_assistant(latest_user_message, profiles, current_pid or None)

    # Si le LLM hésite (none) alors qu'un profil est ouvert et que le message est une consigne : fusionner.
    if str(parsed.get("operation") or "none").lower() == "none":
        if current_pid:
            forced = _instruction_updates_profile(current_pid, latest_user_message, profiles)
            if forced is not None:
                parsed = forced

    operation = str(parsed.get("operation") or "none").lower()
    if operation not in {"none", "create", "update", "delete"}:
        operation = "none"
    draft_profile = parsed.get("draft_profile")
    normalized_draft = None
    if isinstance(draft_profile, dict):
        normalized_draft = CTEGraphProfile(
            **_normalize_profile_record(
                {
                    **draft_profile,
                    "updated_at": _utc_now_iso(),
                    "id": draft_profile.get("id") or _coerce_profile_id(draft_profile.get("name") or "cte-graph"),
                }
            )
        )

    inferred_ready, inferred_questions = _infer_cte_generation_state(
        latest_user_message,
        draft_profile if isinstance(draft_profile, dict) else current_profile_doc,
    )
    ready_to_generate = parsed.get("ready_to_generate")
    if not isinstance(ready_to_generate, bool):
        ready_to_generate = inferred_ready
    raw_follow_up_questions = parsed.get("follow_up_questions")
    follow_up_questions = [
        str(question).strip()
        for question in (raw_follow_up_questions or [])
        if isinstance(question, str) and question.strip()
    ]
    if not follow_up_questions and not ready_to_generate:
        follow_up_questions = inferred_questions

    return ProfileAssistantResponse(
        assistant_message=str(parsed.get("assistant_message") or "").strip()
        or "Action préparée.",
        operation=operation,
        target_profile_id=parsed.get("target_profile_id"),
        draft_profile=normalized_draft,
        ready_to_generate=ready_to_generate,
        follow_up_questions=follow_up_questions,
    )


@router.post(
    "/profiles/{profile_id}/generate-graph",
    response_model=GenerateProfileGraphResponse,
    summary="Génère une chaîne CTE linéaire (agent) et reconstruit le graphe du profil",
)
async def generate_profile_cte_graph(
    profile_id: str,
    body: Optional[GenerateProfileGraphRequest] = None,
) -> GenerateProfileGraphResponse:
    """Deux phases LLM (plan → SQL) sauf profil *insurance_audit* (prompt contrats dédié)."""
    profile_id = profile_id.strip()
    profile = _find_profile_or_404(profile_id)
    lib_path = _sql_library_dir_for_profile_id(profile_id)
    if lib_path is None:
        raise HTTPException(
            status_code=400,
            detail="Identifiant de profil invalide pour un dossier sous data/reporting/sql/.",
        )
    body = body or GenerateProfileGraphRequest()

    from flows.cte_profile_chain_generate import run_profile_cte_chain_generation

    gen = run_profile_cte_chain_generation(
        profile,
        lib_path,
        additional_instructions=body.additional_instructions or "",
    )

    plan = gen.get("phase1")
    plan_reasoning: Optional[str] = None
    if isinstance(plan, dict) and plan.get("reasoning"):
        plan_reasoning = str(plan["reasoning"])

    if not gen.get("success"):
        return GenerateProfileGraphResponse(
            success=False,
            message=gen.get("error") or "La génération a échoué.",
            error=gen.get("error"),
            chain_warning=gen.get("chain_warning"),
            plan_reasoning=plan_reasoning,
            duration_ms=float(gen.get("duration_ms") or 0.0),
        )

    try:
        br = _rebuild_stored_graph_for_profile(profile_id)
    except HTTPException as e:
        detail = e.detail
        if isinstance(detail, dict):
            msg = str(detail.get("message") or detail)
        else:
            msg = str(detail)
        return GenerateProfileGraphResponse(
            success=False,
            message=f"Fichiers générés mais échec de reconstruction du graphe : {msg}",
            error=msg,
            chain_warning=gen.get("chain_warning"),
            plan_reasoning=plan_reasoning,
            cte_count=int((gen.get("library") or {}).get("cte_count") or 0),
            duration_ms=float(gen.get("duration_ms") or 0.0),
        )

    lib = gen.get("library") or {}
    cte_n = int(lib.get("cte_count") or gen.get("insurance_audit_cte_count") or 0)

    return GenerateProfileGraphResponse(
        success=True,
        message="Chaîne CTE générée et graphe reconstruit.",
        graph_id=br.graph_id,
        node_count=br.node_count,
        edge_count=br.edge_count,
        roots=br.roots,
        leaves=br.leaves,
        cte_count=cte_n,
        chain_warning=gen.get("chain_warning"),
        plan_reasoning=plan_reasoning,
        duration_ms=float(gen.get("duration_ms") or 0.0),
    )


@router.post("/build", response_model=BuildResponse, summary="Build a CTE graph")
async def build_graph(req: BuildRequest) -> BuildResponse:
    builder = GraphBuilder(embeddings=_get_embeddings())
    try:
        graph = builder.build(
            req.sql,
            req.cte_descriptions or {},
            dialect=req.dialect or "duckdb",
        )
    except CycleError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "cyclic_dependency", "cycle": e.cycle, "message": str(e)},
        )
    except ParseError as e:
        raise HTTPException(status_code=400, detail={"error": "parse_error", "message": str(e)})
    except BuildError as e:
        raise HTTPException(status_code=400, detail={"error": "build_error", "message": str(e)})

    stats   = GraphBuilder.stats(graph)
    graph_id = _get_store().put(graph)

    return BuildResponse(
        graph_id   = graph_id,
        node_count = stats["node_count"],
        edge_count = stats["edge_count"],
        roots      = stats["roots"],
        leaves     = stats["leaves"],
    )


@router.post(
    "/build-library",
    response_model=BuildResponse,
    summary="Build a graph from the on-disk reporting CTE library",
)
async def build_library_graph(
    req: Optional[BuildLibraryRequest] = None,
) -> BuildResponse:
    """Construct the dependency graph from
    ``brikz-agent/data/reporting/sql/<library>/index.yaml``.

    When *profile_id* is set, library folders come from that profile and the
    result is stored under :func:`_graph_id_for_profile` so each UI card has
    a stable graph id. Otherwise behaviour matches the original endpoint
    (anonymous build → random ``graph_id``).
    """
    body = req or BuildLibraryRequest()
    libraries: List[str]
    canonical_gid: Optional[str] = None

    if body.profile_id:
        profile_rec = _find_profile_or_404(body.profile_id.strip())
        libraries = list(profile_rec.get("libraries") or list(DEFAULT_LIBRARIES))
        canonical_gid = _graph_id_for_profile(body.profile_id.strip())
        if (
            canonical_gid
            and not body.force_rebuild
            and _get_store().exists(canonical_gid)
        ):
            graph_cached = _get_store().get(canonical_gid)
            if graph_cached is not None:
                stats = GraphBuilder.stats(graph_cached)
                if not profile_rec.get("graph_id"):
                    _set_profile_graph_id(body.profile_id.strip(), canonical_gid)
                invalidate_cte_library_graph_caches()
                return BuildResponse(
                    graph_id   = canonical_gid,
                    node_count = stats["node_count"],
                    edge_count = stats["edge_count"],
                    roots      = stats["roots"],
                    leaves     = stats["leaves"],
                )
    else:
        libraries = list(body.libraries) if body.libraries else list(DEFAULT_LIBRARIES)

    try:
        records = load_library(_REPORTING_SQL_DIR, libraries=libraries)
    except LibraryError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "library_error", "message": str(e)},
        )
    except FileNotFoundError as e:
        raise HTTPException(
            status_code=404,
            detail={"error": "library_missing", "message": str(e)},
        )

    builder = GraphBuilder(embeddings=_get_embeddings())
    try:
        graph = builder.build_from_library(records)
    except CycleError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "cyclic_dependency", "cycle": e.cycle, "message": str(e)},
        )
    except BuildError as e:
        raise HTTPException(
            status_code=400,
            detail={"error": "build_error", "message": str(e)},
        )

    stats = GraphBuilder.stats(graph)
    graph_id = _get_store().put(graph, graph_id=canonical_gid)
    if body.profile_id:
        _set_profile_graph_id(body.profile_id.strip(), graph_id)
    invalidate_cte_library_graph_caches()

    return BuildResponse(
        graph_id   = graph_id,
        node_count = stats["node_count"],
        edge_count = stats["edge_count"],
        roots      = stats["roots"],
        leaves     = stats["leaves"],
    )


@router.get(
    "/{graph_id}",
    response_model=ReactFlowGraph,
    summary="Fetch a graph in ReactFlow shape",
)
async def get_graph(graph_id: str) -> ReactFlowGraph:
    graph = _get_store().get(graph_id)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"Graph not found: {graph_id}")
    payload = to_reactflow(graph)
    return ReactFlowGraph(**payload)


@router.post(
    "/search",
    response_model=List[SearchHit],
    summary="Semantic search over node descriptions",
)
async def search_graph(req: SearchRequest) -> List[SearchHit]:
    graph = _get_store().get(req.graph_id)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"Graph not found: {req.graph_id}")

    finder = SemanticSearch(_get_embeddings())
    hits = finder.query(graph, req.query, top_k=req.top_k)
    return [SearchHit(**h) for h in hits]


@router.get(
    "/{graph_id}/node/{node_id}/parent-paths",
    response_model=ParentPathsResponse,
    summary="All parent paths from any root to a node + shortest path",
)
async def get_parent_paths(graph_id: str, node_id: str) -> ParentPathsResponse:
    graph = _get_store().get(graph_id)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"Graph not found: {graph_id}")

    try:
        payload = ParentPathFinder.all_parent_paths(graph, node_id)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail=f"Node {node_id!r} not in graph {graph_id!r}",
        )
    return ParentPathsResponse(**payload)


@router.post(
    "/query",
    response_model=QueryResponse,
    summary="Semantic CTE selection + recursive execution over parquet sources",
)
async def query_graph(req: QueryRequest) -> QueryResponse:
    graph = _get_store().get(req.graph_id)
    if graph is None:
        raise HTTPException(status_code=404, detail=f"Graph not found: {req.graph_id}")

    finder = SemanticSearch(_get_embeddings())
    hits = finder.query(graph, req.query, top_k=max(req.top_k, graph.number_of_nodes()))

    selected_node = (req.cte_name or "").strip()
    if not selected_node:
        selected_node = _pick_best_accounting_node(graph, hits, req.query) or ""
    if not selected_node and hits:
        selected_node = hits[0]["node_id"]
    if not selected_node:
        raise HTTPException(
            status_code=404,
            detail={"error": "no_match", "message": "Aucun CTE correspondant à la requête."},
        )
    if selected_node not in graph:
        raise HTTPException(
            status_code=404,
            detail={"error": "unknown_cte", "message": f"CTE introuvable dans le graphe: {selected_node}"},
        )

    # Executable = the node carries SQL. The legacy node-level `library="accounting"`
    # gate is dead: CTEs created via upsert_cte have no node-level library, so it
    # rejected every skill-library CTE. Gate on rawSql instead.
    if not str(graph.nodes[selected_node].get("rawSql") or "").strip():
        raise HTTPException(
            status_code=400,
            detail={
                "error": "non_executable_cte",
                "message": f"Le CTE sélectionné ({selected_node}) n'a pas de SQL exécutable.",
            },
        )

    try:
        parent_payload = ParentPathFinder.all_parent_paths(graph, selected_node)
    except KeyError:
        raise HTTPException(
            status_code=404,
            detail={"error": "unknown_cte", "message": f"CTE introuvable dans le graphe: {selected_node}"},
        )

    parquet_paths = {
        str(name): str(path)
        for name, path in (req.parquet_paths or {}).items()
        if str(name).strip() and str(path).strip()
    }
    parameters = _infer_query_parameters(req.query, req.parameters or {})

    # Execute against the SELECTED graph, not the process-wide default repository.
    from services.cte_graph.repository import set_active_cte_graph

    set_active_cte_graph(req.graph_id)

    try:
        execution = execute_accounting_cte_structured(
            cte_name=selected_node,
            parameters=parameters,
            parquet_paths=parquet_paths,
            max_rows=req.max_rows,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail={"error": "invalid_query", "message": str(exc)})
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail={"error": "execution_failed", "message": str(exc)})
    except Exception as exc:
        logger.exception("cte query execution failed")
        raise HTTPException(
            status_code=500,
            detail={"error": "internal_error", "message": str(exc)},
        )

    visible_hits = list(hits)
    if selected_node:
        visible_hits.sort(
            key=lambda hit: (
                0 if hit["node_id"] == selected_node else 1,
                -float(hit.get("similarity_score") or 0.0),
            )
        )
    visible_hits = visible_hits[: req.top_k]

    return QueryResponse(
        selected_node=selected_node,
        matched_nodes=[h["node_id"] for h in visible_hits],
        search_hits=[SearchHit(**h) for h in visible_hits],
        parent_paths=ParentPathsResponse(**parent_payload),
        execution=QueryExecutionResponse(**execution),
    )
