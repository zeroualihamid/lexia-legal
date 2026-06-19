"""Legal graph artifact browser.

This route exposes generated legal graph files under ``data/legal_graph*`` so
the admin UI can list every available graph and render its PNG views.
"""

import json
import os
import pickle
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field


router = APIRouter()

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_IMAGE_SUFFIXES = {".png"}
_DOWNLOAD_SUFFIXES = {".png", ".json", ".graphml", ".pkl"}


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
    pickle_nodes, pickle_edges = _graph_counts_from_pickle(directory)
    return LegalGraphStats(
        document_count=_document_count(summary),
        chunk_count=_int_value(summary.get("chunk_count")),
        graph_nodes=_int_value(summary.get("graph_nodes")) or pickle_nodes,
        graph_edges=_int_value(summary.get("graph_edges")) or pickle_edges,
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
