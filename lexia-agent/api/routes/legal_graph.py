"""Legal graph artifact browser.

This route exposes generated legal graph files under ``data/legal_graph*`` so
the admin UI can list every available graph and render its PNG views.
"""

import json
import os
import pickle
import threading
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from legal_graph_agent import LegalGraphAgent
from nodes.legal_graph.legal_graph_nodes import (
    ConnectToExistingGraphNode,
    GraphSearchNode,
    LoadGraphNode,
    SaveGraphNode,
    SelectStartGoalNode,
    UpsertChunkNodesNode,
)
from nodes.legal_graph.models import LegalGraphConfig
from nodes.legal_graph.visualization import render_graph_png


router = APIRouter()

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_IMAGE_SUFFIXES = {".png"}
_DOWNLOAD_SUFFIXES = {".png", ".json", ".graphml", ".pkl"}
_BUILD_JOBS: Dict[str, Dict[str, Any]] = {}
_BUILD_LOCK = threading.Lock()
_MAX_BUILD_JOBS = 50
_DEFAULT_JUDGMENT_COLLECTIONS = [
    "judgments_social",
    "judgments_commercial",
    "judgments_civil",
    "judgments_criminal",
    "judgments_family",
    "judgments_constitutional",
    "judgments_real_estate",
    "judgments_admin",
    "lexia_user_docs",
]


class LegalGraphImage(BaseModel):
    filename: str
    kind: str
    label: str
    url: str
    size_bytes: int
    updated_at: str


class LegalGraphFile(BaseModel):
    filename: str
    kind: str
    url: str
    size_bytes: int
    updated_at: str


class LegalGraphStats(BaseModel):
    document_count: Optional[int] = None
    chunk_count: Optional[int] = None
    graph_nodes: Optional[int] = None
    graph_edges: Optional[int] = None
    reasoning_edge_count: Optional[int] = None
    edge_counts: Dict[str, int] = Field(default_factory=dict)
    layer_counts: Dict[str, int] = Field(default_factory=dict)
    graph_search_status: Optional[str] = None
    graph_search_method: Optional[str] = None
    graph_search_message: Optional[str] = None


class LegalGraphArtifact(BaseModel):
    id: str
    name: str
    directory: str
    updated_at: str
    images: List[LegalGraphImage]
    files: List[LegalGraphFile]
    stats: LegalGraphStats
    summary: Dict[str, Any] = Field(default_factory=dict)


class LegalGraphListResponse(BaseModel):
    graphs: List[LegalGraphArtifact]
    count: int
    data_root: str


class LegalGraphBuildRequest(BaseModel):
    query: str = Field(
        default="jurisprudence marocaine jugement motifs décision faits procédure",
        description="Text query used to retrieve judgment chunks from Qdrant.",
    )
    top_k: int = Field(default=100, ge=1, le=500)
    judgments_only: bool = True
    cross_case: bool = False
    collections: Optional[List[str]] = None


class LegalGraphBuildResponse(BaseModel):
    success: bool
    message: str
    graph: LegalGraphArtifact
    retrieved_chunks: int
    upserted_nodes: int
    skipped_nodes: int
    connected_edges: int


class LegalGraphBuildJobStatus(BaseModel):
    job_id: str
    status: str
    progress: int
    phase: str
    message: str
    current_file: Optional[str] = None
    processed_documents: int = 0
    total_documents: int = 0
    retrieved_chunks: int = 0
    upserted_nodes: int = 0
    skipped_nodes: int = 0
    connected_edges: int = 0
    graph: Optional[LegalGraphArtifact] = None
    error: Optional[str] = None
    started_at: str
    updated_at: str
    completed_at: Optional[str] = None


def _data_root() -> Path:
    configured = os.getenv("LEGAL_GRAPH_DATA_DIR", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    return (_PROJECT_ROOT / "data").resolve()


def _utc_iso(timestamp: float) -> str:
    return datetime.fromtimestamp(timestamp, tz=timezone.utc).isoformat()


def _file_updated_at(path: Path) -> str:
    return _utc_iso(path.stat().st_mtime)


def _has_direct_graph_artifacts(directory: Path) -> bool:
    if not directory.exists() or not directory.is_dir():
        return False
    return any(
        item.is_file() and item.suffix.lower() in _DOWNLOAD_SUFFIXES
        for item in directory.iterdir()
    )


def _has_root_legal_graph_artifacts(directory: Path) -> bool:
    if not directory.exists() or not directory.is_dir():
        return False
    return any(
        item.is_file()
        and item.name.startswith("legal_graph")
        and item.suffix.lower() in _DOWNLOAD_SUFFIXES
        for item in directory.iterdir()
    )


def _graph_dirs() -> Dict[str, Path]:
    root = _data_root()
    if not root.exists():
        return {}

    graph_dirs: Dict[str, Path] = {}
    for item in sorted(root.iterdir(), key=lambda p: p.name):
        if item.is_dir() and item.name.startswith("legal_graph") and _has_direct_graph_artifacts(item):
            graph_dirs[item.name] = item.resolve()

    if _has_root_legal_graph_artifacts(root):
        graph_dirs.setdefault("legal_graph", root)

    return graph_dirs


def _summary_file(directory: Path) -> Optional[Path]:
    candidates = sorted(
        [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() == ".json" and "summary" in path.name.lower()],
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    return candidates[0] if candidates else None


def _read_summary(directory: Path) -> Dict[str, Any]:
    path = _summary_file(directory)
    if path is None:
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _int_value(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, float):
        return int(value)
    if isinstance(value, str) and value.isdigit():
        return int(value)
    return None


def _int_dict(value: Any) -> Dict[str, int]:
    if not isinstance(value, dict):
        return {}
    out: Dict[str, int] = {}
    for key, raw in value.items():
        parsed = _int_value(raw)
        if parsed is not None:
            out[str(key)] = parsed
    return out


def _safe_run_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_job_snapshot(job_id: str) -> LegalGraphBuildJobStatus:
    with _BUILD_LOCK:
        job = _BUILD_JOBS.get(job_id)
        if not job:
            raise HTTPException(status_code=404, detail=f"Legal graph build job not found: {job_id}")
        return LegalGraphBuildJobStatus.model_validate(json.loads(json.dumps(job)))


def _trim_build_jobs() -> None:
    if len(_BUILD_JOBS) <= _MAX_BUILD_JOBS:
        return
    stale = sorted(_BUILD_JOBS.items(), key=lambda item: str(item[1].get("updated_at") or ""))
    for job_id, _job in stale[: max(0, len(_BUILD_JOBS) - _MAX_BUILD_JOBS)]:
        _BUILD_JOBS.pop(job_id, None)


def _update_build_job(job_id: str, **updates: Any) -> None:
    with _BUILD_LOCK:
        job = _BUILD_JOBS.get(job_id)
        if not job:
            return
        job.update(updates)
        job["updated_at"] = _now_iso()
        _trim_build_jobs()


def _create_build_job() -> str:
    job_id = uuid.uuid4().hex
    now = _now_iso()
    with _BUILD_LOCK:
        _BUILD_JOBS[job_id] = {
            "job_id": job_id,
            "status": "queued",
            "progress": 0,
            "phase": "queued",
            "message": "Build queued.",
            "current_file": None,
            "processed_documents": 0,
            "total_documents": 0,
            "retrieved_chunks": 0,
            "upserted_nodes": 0,
            "skipped_nodes": 0,
            "connected_edges": 0,
            "graph": None,
            "error": None,
            "started_at": now,
            "updated_at": now,
            "completed_at": None,
        }
        _trim_build_jobs()
    return job_id


def _graph_counts_from_pickle(directory: Path) -> Tuple[Optional[int], Optional[int]]:
    candidates = sorted(directory.glob("*.pkl"), key=lambda p: p.stat().st_mtime, reverse=True)
    if not candidates:
        return None, None

    try:
        with candidates[0].open("rb") as fh:
            graph = pickle.load(fh)
    except Exception:
        return None, None

    node_count = None
    edge_count = None
    if hasattr(graph, "number_of_nodes"):
        try:
            node_count = int(graph.number_of_nodes())
        except Exception:
            node_count = None
    if hasattr(graph, "number_of_edges"):
        try:
            edge_count = int(graph.number_of_edges())
        except Exception:
            edge_count = None
    return node_count, edge_count


def _document_count(summary: Dict[str, Any]) -> Optional[int]:
    explicit = _int_value(summary.get("document_count"))
    if explicit is not None:
        return explicit
    for key in ("selected_documents", "documents"):
        docs = summary.get(key)
        if isinstance(docs, list):
            return len(docs)
    return None


def _stats(directory: Path, summary: Dict[str, Any]) -> LegalGraphStats:
    graph_nodes = _int_value(summary.get("graph_nodes"))
    graph_edges = _int_value(summary.get("graph_edges"))
    pickle_nodes: Optional[int] = None
    pickle_edges: Optional[int] = None
    if graph_nodes is None or graph_edges is None:
        pickle_nodes, pickle_edges = _graph_counts_from_pickle(directory)
    return LegalGraphStats(
        document_count=_document_count(summary),
        chunk_count=_int_value(summary.get("chunk_count")),
        graph_nodes=graph_nodes if graph_nodes is not None else pickle_nodes,
        graph_edges=graph_edges if graph_edges is not None else pickle_edges,
        reasoning_edge_count=_int_value(summary.get("reasoning_edge_count")),
        edge_counts=_int_dict(summary.get("edge_counts")),
        layer_counts=_int_dict(summary.get("layer_counts")),
        graph_search_status=str(summary.get("graph_search_status")) if summary.get("graph_search_status") else None,
        graph_search_method=str(summary.get("graph_search_method")) if summary.get("graph_search_method") else None,
        graph_search_message=str(summary.get("graph_search_message")) if summary.get("graph_search_message") else None,
    )


def _image_kind(path: Path) -> str:
    stem = path.stem.lower()
    if "combined" in stem:
        return "combined"
    if "discovery" in stem:
        return "discovery"
    if "reasoning" in stem:
        return "reasoning"
    if "augmented" in stem:
        return "augmented"
    if "selected" in stem or "qdrant" in stem:
        return "selection"
    return "graph"


def _image_label(kind: str) -> str:
    labels = {
        "combined": "Vue combinée",
        "discovery": "Découverte",
        "reasoning": "Raisonnement",
        "augmented": "Graphe augmenté",
        "selection": "Sélection Qdrant/MinIO",
        "graph": "Graphe",
    }
    return labels.get(kind, kind.replace("_", " ").title())


def _file_kind(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix == ".graphml":
        return "graphml"
    if suffix == ".pkl":
        return "pickle"
    if suffix == ".json":
        return "summary" if "summary" in path.name.lower() else "json"
    if suffix == ".png":
        return _image_kind(path)
    return suffix.lstrip(".") or "file"


def _graph_artifact(graph_id: str, directory: Path) -> LegalGraphArtifact:
    files = sorted(
        [path for path in directory.iterdir() if path.is_file() and path.suffix.lower() in _DOWNLOAD_SUFFIXES],
        key=lambda p: (p.suffix.lower() != ".png", p.name.lower()),
    )
    updated_ts = max((path.stat().st_mtime for path in files), default=directory.stat().st_mtime)
    summary = _read_summary(directory)

    images = [
        LegalGraphImage(
            filename=path.name,
            kind=_image_kind(path),
            label=_image_label(_image_kind(path)),
            url=f"/legal-graphs/{graph_id}/images/{path.name}",
            size_bytes=path.stat().st_size,
            updated_at=_file_updated_at(path),
        )
        for path in files
        if path.suffix.lower() in _IMAGE_SUFFIXES
    ]

    downloads = [
        LegalGraphFile(
            filename=path.name,
            kind=_file_kind(path),
            url=f"/legal-graphs/{graph_id}/files/{path.name}",
            size_bytes=path.stat().st_size,
            updated_at=_file_updated_at(path),
        )
        for path in files
    ]

    return LegalGraphArtifact(
        id=graph_id,
        name=graph_id.replace("_", " "),
        directory=str(directory.relative_to(_data_root())) if directory != _data_root() else ".",
        updated_at=_utc_iso(updated_ts),
        images=images,
        files=downloads,
        stats=_stats(directory, summary),
        summary=summary,
    )


def _chunk_document_key(chunk: Dict[str, Any]) -> str:
    return str(
        chunk.get("document_id")
        or chunk.get("source_pdf_id")
        or chunk.get("source_pdf_path")
        or chunk.get("qdrant_collection")
        or chunk.get("qdrant_point_id")
        or "unknown"
    )


def _chunk_title(chunk: Dict[str, Any]) -> str:
    metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
    return str(
        metadata.get("title")
        or metadata.get("filename")
        or metadata.get("file_name")
        or chunk.get("section_title")
        or _chunk_document_key(chunk)
    )


def _summary_documents(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    by_key: Dict[str, Dict[str, Any]] = {}
    counts = Counter(_chunk_document_key(chunk) for chunk in chunks)
    for chunk in chunks:
        key = _chunk_document_key(chunk)
        if key in by_key:
            continue
        metadata = chunk.get("metadata") if isinstance(chunk.get("metadata"), dict) else {}
        minio_bucket = metadata.get("minio_bucket")
        minio_key = metadata.get("minio_key")
        minio_path = (
            metadata.get("minio_path")
            or metadata.get("source_pdf_path")
            or (f"s3://{minio_bucket}/{minio_key}" if minio_bucket and minio_key else None)
            or chunk.get("source_pdf_path")
        )
        by_key[key] = {
            "collection": chunk.get("qdrant_collection"),
            "document_id": chunk.get("document_id"),
            "title": _chunk_title(chunk),
            "qdrant_chunks": counts[key],
            "minio_path": minio_path,
            "minio_size": metadata.get("minio_size") or metadata.get("size"),
            "document_type": metadata.get("document_type"),
        }
    return list(by_key.values())


def _display_document_filename(document: Dict[str, Any]) -> str:
    for key in ("minio_path", "title", "document_id", "collection"):
        value = document.get(key)
        if not value:
            continue
        text = str(value)
        if key == "minio_path":
            trimmed = text.rstrip("/")
            filename = trimmed.rsplit("/", 1)[-1] if "/" in trimmed else trimmed
            return filename or text
        return text
    return "Jugement sans nom"


def _chunk_groups(chunks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    documents = _summary_documents(chunks)
    document_meta = {
        str(document.get("document_id") or document.get("minio_path") or document.get("title") or index): document
        for index, document in enumerate(documents)
    }
    groups_by_key: Dict[str, Dict[str, Any]] = {}

    for chunk in chunks:
        key = _chunk_document_key(chunk)
        document = document_meta.get(key)
        if document is None:
            document = {
                "document_id": chunk.get("document_id"),
                "collection": chunk.get("qdrant_collection"),
                "title": _chunk_title(chunk),
                "minio_path": (chunk.get("metadata") or {}).get("minio_path") if isinstance(chunk.get("metadata"), dict) else None,
            }
        group = groups_by_key.setdefault(
            key,
            {
                "key": key,
                "filename": _display_document_filename(document),
                "chunks": [],
            },
        )
        group["chunks"].append(chunk)

    return sorted(groups_by_key.values(), key=lambda item: str(item["filename"]).lower())


def _edge_counts(graph: Any) -> Tuple[Dict[str, int], Dict[str, int], int]:
    edge_counts: Counter[str] = Counter()
    layer_counts: Counter[str] = Counter()
    reasoning_count = 0
    for _source, _target, _key, attrs in graph.edges(keys=True, data=True):
        relation_type = str(attrs.get("relation_type") or _key or "unknown")
        layer = str(attrs.get("edge_layer") or ("reasoning" if attrs.get("reasoning_edge") else "discovery"))
        edge_counts[relation_type] += 1
        layer_counts[layer] += 1
        if attrs.get("reasoning_edge") is True:
            reasoning_count += 1
    return dict(edge_counts), dict(layer_counts), reasoning_count


def _write_build_artifacts(run_dir: Path, shared: Dict[str, Any], collections: List[str]) -> None:
    graph = shared["graph"]
    for mode in ("combined", "discovery", "reasoning"):
        render_graph_png(
            graph,
            run_dir / f"admin_judgments_only_{mode}_view.png",
            mode=mode,
            title=f"Legal Graph - {mode.title()}",
        )

    chunks = list(shared.get("retrieved_chunks") or [])
    edge_counts, layer_counts, reasoning_edge_count = _edge_counts(graph)
    summary = {
        "source_collections": collections,
        "selected_documents": _summary_documents(chunks),
        "excluded_documents": [],
        "document_count": len({_chunk_document_key(chunk) for chunk in chunks}),
        "chunk_count": len(chunks),
        "graph_nodes": graph.number_of_nodes(),
        "graph_edges": graph.number_of_edges(),
        "edge_counts": edge_counts,
        "layer_counts": layer_counts,
        "reasoning_edge_count": reasoning_edge_count,
        "invalid_reasoning_edges": [],
        "contracts_in_graph": [],
        "start_node": shared.get("start_node_id"),
        "goal_node": shared.get("goal_node_id"),
        "graph_search_status": shared.get("graph_search_status"),
        "graph_search_method": shared.get("graph_search_method"),
        "graph_search_message": shared.get("graph_search_message"),
        "reasoning_path": shared.get("reasoning_path_node_ids") or [],
        "reasoning_png": str(run_dir / "admin_judgments_only_reasoning_view.png"),
        "discovery_png": str(run_dir / "admin_judgments_only_discovery_view.png"),
        "combined_png": str(run_dir / "admin_judgments_only_combined_view.png"),
        "pkl_path": shared.get("graph_file_path"),
        "graphml_path": shared.get("graphml_file_path"),
    }
    (run_dir / "admin_judgments_only_summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def _build_config(body: LegalGraphBuildRequest, run_dir: Path) -> Tuple[LegalGraphConfig, List[str]]:
    collections = body.collections or _DEFAULT_JUDGMENT_COLLECTIONS
    graph_file = run_dir / "admin_judgments_only_graph.pkl"
    graphml_file = run_dir / "admin_judgments_only_graph.graphml"
    config = LegalGraphConfig(
        graph_file_path=graph_file,
        graphml_file_path=graphml_file,
        qdrant_collections=collections,
        top_k=body.top_k,
        judgments_only=body.judgments_only,
        cross_case=body.cross_case,
    )
    return config, collections


def _run_build_flow_with_progress(job_id: str, body: LegalGraphBuildRequest) -> None:
    run_id = f"legal_graph_admin_{_safe_run_id()}"
    run_dir = _data_root() / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    config, collections = _build_config(body, run_dir)
    shared: Dict[str, Any] = {
        "query": body.query,
        "legal_graph_config": config,
        "top_k": body.top_k,
        "judgments_only": body.judgments_only,
        "cross_case": body.cross_case,
    }

    try:
        _update_build_job(
            job_id,
            status="running",
            progress=4,
            phase="initializing",
            message="Initialisation du graphe juridique.",
        )
        agent = LegalGraphAgent(config=config)
        shared["legal_graph_claude_client"] = agent.claude_client

        _update_build_job(
            job_id,
            progress=10,
            phase="retrieving",
            message="Recherche des jugements dans Qdrant.",
        )
        chunks = agent.retrieve(
            body.query,
            top_k=body.top_k,
        )
        retrieved_chunks = [chunk.model_dump() if hasattr(chunk, "model_dump") else dict(chunk) for chunk in chunks]
        groups = _chunk_groups(retrieved_chunks)
        total_documents = len(groups)
        shared["retrieved_chunks"] = retrieved_chunks

        _update_build_job(
            job_id,
            progress=18,
            phase="retrieved",
            message=f"{len(retrieved_chunks)} chunks récupérés depuis {total_documents} jugement(s).",
            total_documents=total_documents,
            retrieved_chunks=len(retrieved_chunks),
        )

        _update_build_job(
            job_id,
            progress=22,
            phase="loading_graph",
            message="Chargement du graphe persistant.",
        )
        LoadGraphNode().run(shared)

        upserted_node_ids: List[str] = []
        skipped_node_ids: List[str] = []
        if groups:
            for index, group in enumerate(groups):
                start_progress = 24 + int((index / total_documents) * 42)
                _update_build_job(
                    job_id,
                    progress=start_progress,
                    phase="processing_judgment",
                    message=f"Traitement du jugement {index + 1}/{total_documents}.",
                    current_file=group["filename"],
                    processed_documents=index,
                    total_documents=total_documents,
                )
                shared["retrieved_chunks"] = group["chunks"]
                UpsertChunkNodesNode().run(shared)
                upserted_node_ids.extend(shared.get("upserted_node_ids") or [])
                skipped_node_ids.extend(shared.get("skipped_node_ids") or [])
                _update_build_job(
                    job_id,
                    progress=24 + int(((index + 1) / total_documents) * 42),
                    processed_documents=index + 1,
                    upserted_nodes=len(upserted_node_ids),
                    skipped_nodes=len(skipped_node_ids),
                )
        else:
            _update_build_job(
                job_id,
                progress=66,
                phase="processing_judgment",
                message="Aucun jugement récupéré pour cette requête.",
                current_file=None,
                processed_documents=0,
                total_documents=0,
            )

        shared["retrieved_chunks"] = retrieved_chunks
        shared["upserted_node_ids"] = upserted_node_ids
        shared["skipped_node_ids"] = skipped_node_ids

        _update_build_job(
            job_id,
            progress=70,
            phase="connecting",
            message="Création des liens entre chunks et jugements.",
            current_file=None,
        )
        ConnectToExistingGraphNode().run(shared)

        _update_build_job(
            job_id,
            progress=78,
            phase="selecting_reasoning_path",
            message="Sélection des nœuds de départ et d'arrivée.",
            connected_edges=len(shared.get("connected_edge_ids") or []),
        )
        SelectStartGoalNode().run(shared)

        _update_build_job(
            job_id,
            progress=84,
            phase="searching",
            message="Recherche du chemin de raisonnement.",
        )
        GraphSearchNode().run(shared)

        _update_build_job(
            job_id,
            progress=90,
            phase="saving",
            message="Sauvegarde du graphe et export GraphML.",
        )
        SaveGraphNode().run(shared)

        _update_build_job(
            job_id,
            progress=95,
            phase="rendering",
            message="Rendu des vues PNG du graphe.",
        )
        _write_build_artifacts(run_dir, shared, collections)
        artifact = _graph_artifact(run_id, run_dir)

        _update_build_job(
            job_id,
            status="completed",
            progress=100,
            phase="completed",
            message="Graphe juridique généré.",
            current_file=None,
            processed_documents=total_documents,
            total_documents=total_documents,
            retrieved_chunks=len(retrieved_chunks),
            upserted_nodes=len(upserted_node_ids),
            skipped_nodes=len(skipped_node_ids),
            connected_edges=len(shared.get("connected_edge_ids") or []),
            graph=artifact.model_dump(),
            completed_at=_now_iso(),
        )
    except Exception as exc:
        _update_build_job(
            job_id,
            status="failed",
            phase="failed",
            progress=100,
            message="Échec de génération du graphe juridique.",
            error=str(exc),
            completed_at=_now_iso(),
        )


def _resolve_graph_dir(graph_id: str) -> Path:
    graph_dir = _graph_dirs().get(graph_id)
    if graph_dir is None:
        raise HTTPException(status_code=404, detail=f"Legal graph not found: {graph_id}")
    return graph_dir.resolve()


def _resolve_artifact(graph_id: str, filename: str, suffixes: set[str]) -> Path:
    if Path(filename).name != filename or "/" in filename or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid artifact filename")

    graph_dir = _resolve_graph_dir(graph_id)
    path = (graph_dir / filename).resolve()
    if path.parent != graph_dir or not path.is_file() or path.suffix.lower() not in suffixes:
        raise HTTPException(status_code=404, detail=f"Legal graph artifact not found: {filename}")
    return path


@router.get("", response_model=LegalGraphListResponse, include_in_schema=False)
@router.get("/", response_model=LegalGraphListResponse, summary="List generated legal graph artifacts")
async def list_legal_graphs() -> LegalGraphListResponse:
    graphs = [
        _graph_artifact(graph_id, directory)
        for graph_id, directory in _graph_dirs().items()
    ]
    graphs.sort(key=lambda graph: graph.updated_at, reverse=True)
    return LegalGraphListResponse(
        graphs=graphs,
        count=len(graphs),
        data_root=str(_data_root()),
    )


@router.post("/build", response_model=LegalGraphBuildResponse, summary="Build a judgment-only legal graph")
async def build_legal_graph(body: LegalGraphBuildRequest) -> LegalGraphBuildResponse:
    run_id = f"legal_graph_admin_{_safe_run_id()}"
    run_dir = _data_root() / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    config, collections = _build_config(body, run_dir)

    try:
        agent = LegalGraphAgent(config=config)
        shared = agent.run(
            body.query,
            top_k=body.top_k,
            judgments_only=body.judgments_only,
            cross_case=body.cross_case,
        )
        _write_build_artifacts(run_dir, shared, collections)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Legal graph build failed: {exc}") from exc

    artifact = _graph_artifact(run_id, run_dir)
    return LegalGraphBuildResponse(
        success=True,
        message="Legal graph built and rendered.",
        graph=artifact,
        retrieved_chunks=len(shared.get("retrieved_chunks") or []),
        upserted_nodes=len(shared.get("upserted_node_ids") or []),
        skipped_nodes=len(shared.get("skipped_node_ids") or []),
        connected_edges=len(shared.get("connected_edge_ids") or []),
    )


@router.post("/build-jobs", response_model=LegalGraphBuildJobStatus, summary="Start a legal graph build job")
async def start_legal_graph_build_job(body: LegalGraphBuildRequest) -> LegalGraphBuildJobStatus:
    job_id = _create_build_job()
    thread = threading.Thread(
        target=_run_build_flow_with_progress,
        args=(job_id, body),
        name=f"legal-graph-build-{job_id[:8]}",
        daemon=True,
    )
    thread.start()
    return _build_job_snapshot(job_id)


@router.get("/build-jobs/{job_id}", response_model=LegalGraphBuildJobStatus, summary="Get legal graph build job status")
async def get_legal_graph_build_job(job_id: str) -> LegalGraphBuildJobStatus:
    return _build_job_snapshot(job_id)


@router.get("/{graph_id}/images/{filename}", summary="Render a legal graph PNG")
async def get_legal_graph_image(graph_id: str, filename: str) -> FileResponse:
    path = _resolve_artifact(graph_id, filename, _IMAGE_SUFFIXES)
    return FileResponse(path, media_type="image/png", filename=path.name)


@router.get("/{graph_id}/files/{filename}", summary="Download a legal graph artifact")
async def get_legal_graph_file(graph_id: str, filename: str) -> FileResponse:
    path = _resolve_artifact(graph_id, filename, _DOWNLOAD_SUFFIXES)
    media_types = {
        ".graphml": "application/graphml+xml",
        ".json": "application/json",
        ".pkl": "application/octet-stream",
        ".png": "image/png",
    }
    return FileResponse(path, media_type=media_types.get(path.suffix.lower()), filename=path.name)
