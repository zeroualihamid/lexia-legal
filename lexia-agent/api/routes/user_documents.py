"""
User Documents router
=====================

Per-owner / per-case document indexing and retrieval for the Lexia legal
platform, backed by Qdrant + FastEmbed (multilingual, 1024d by default).

The NestJS backend (lexia-backend) is the only caller. Requests are
authenticated with a shared internal secret header (``x-internal-secret``)
because the agent has no incoming OIDC auth.

Endpoints (mounted at prefix ``/documents`` and ``/cases``):
    POST   /documents/index            chunk + embed + upsert one document
    POST   /documents/search           semantic search (owner [+ case/doc] scoped)
    DELETE /documents/{document_id}     delete a document's points (owner scoped)
    DELETE /cases/{case_id}/documents   delete a whole case's points (owner scoped)
"""

from __future__ import annotations

import os
import threading
import uuid
from typing import List, Optional

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel

# Stable UUID namespace so re-indexing a document overwrites its old chunks.
_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")

router = APIRouter()
cases_router = APIRouter()

_QDRANT_URL = os.getenv("QDRANT_URL") or (
    f"http://{os.getenv('QDRANT_HOST', 'localhost')}:{os.getenv('QDRANT_PORT', '6333')}"
)
_QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None
_COLLECTION = os.getenv("LEXIA_USER_DOCS_COLLECTION", "lexia_user_docs")
_EMBED_MODEL = os.getenv("LEXIA_DOC_EMBED_MODEL", "intfloat/multilingual-e5-large")
_INTERNAL_SECRET = os.getenv("LEXIA_AGENT_INTERNAL_SECRET", "")

_CHUNK_CHARS = 3200  # ~800 tokens
_CHUNK_OVERLAP = 400  # ~100 tokens

_client = None
_client_lock = threading.Lock()
_indexed_payload = False


# ─────────────────────────────────────────────────────────────────────────────
# Lazy Qdrant + FastEmbed client
# ─────────────────────────────────────────────────────────────────────────────

def _get_client():
    """Lazily build a Qdrant client with the FastEmbed model configured."""
    global _client
    if _client is None:
        with _client_lock:
            if _client is None:
                from qdrant_client import QdrantClient

                client = QdrantClient(url=_QDRANT_URL, api_key=_QDRANT_API_KEY)
                client.set_model(_EMBED_MODEL)
                _client = client
    return _client


def _ensure_payload_indexes(client) -> None:
    """Create keyword payload indexes for the fields we filter on (idempotent)."""
    global _indexed_payload
    if _indexed_payload:
        return
    from qdrant_client import models

    for field in ("owner_id", "case_id", "document_id", "doc_type"):
        try:
            client.create_payload_index(
                collection_name=_COLLECTION,
                field_name=field,
                field_schema=models.PayloadSchemaType.KEYWORD,
            )
        except Exception:
            # Collection may not exist yet, or index already present — ignore.
            pass
    _indexed_payload = True


def _check_secret(secret: Optional[str]) -> None:
    if _INTERNAL_SECRET and secret != _INTERNAL_SECRET:
        raise HTTPException(status_code=401, detail="invalid internal secret")


def _chunk_text(text: str) -> List[str]:
    from services.legal_graph.text_chunking import chunk_text

    return chunk_text(text)


# ─────────────────────────────────────────────────────────────────────────────
# Schemas
# ─────────────────────────────────────────────────────────────────────────────

class IndexRequest(BaseModel):
    owner_id: str
    case_id: str
    document_id: str
    doc_type: Optional[str] = None
    title: Optional[str] = None
    text: str


class SearchRequest(BaseModel):
    owner_id: str
    query: str
    case_id: Optional[str] = None
    document_id: Optional[str] = None
    limit: int = 10


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.post("/index")
def index_document(
    body: IndexRequest,
    x_internal_secret: Optional[str] = Header(default=None),
):
    _check_secret(x_internal_secret)
    client = _get_client()

    chunks = _chunk_text(body.text)
    if not chunks:
        return {"chunks": 0}

    # Remove any previous chunks for this document (idempotent re-index).
    _delete_by_filter(client, owner_id=body.owner_id, document_id=body.document_id)

    documents: List[str] = []
    metadata: List[dict] = []
    ids: List[str] = []
    for i, chunk in enumerate(chunks):
        documents.append(chunk)
        metadata.append(
            {
                "owner_id": body.owner_id,
                "case_id": body.case_id,
                "document_id": body.document_id,
                "doc_type": body.doc_type,
                "title": body.title,
                "visibility": "private",
                "chunk_index": i,
                "content": chunk,
            }
        )
        ids.append(str(uuid.uuid5(_NAMESPACE, f"{body.document_id}-{i}")))

    client.add(
        collection_name=_COLLECTION,
        documents=documents,
        metadata=metadata,
        ids=ids,
    )
    _ensure_payload_indexes(client)

    return {"chunks": len(chunks)}


@router.post("/search")
def search_documents(
    body: SearchRequest,
    x_internal_secret: Optional[str] = Header(default=None),
):
    _check_secret(x_internal_secret)
    client = _get_client()

    from qdrant_client import models

    must = [
        models.FieldCondition(
            key="owner_id", match=models.MatchValue(value=body.owner_id)
        )
    ]
    if body.case_id:
        must.append(
            models.FieldCondition(
                key="case_id", match=models.MatchValue(value=body.case_id)
            )
        )
    if body.document_id:
        must.append(
            models.FieldCondition(
                key="document_id", match=models.MatchValue(value=body.document_id)
            )
        )

    try:
        results = client.query(
            collection_name=_COLLECTION,
            query_text=body.query,
            query_filter=models.Filter(must=must),
            limit=max(1, min(body.limit, 50)),
        )
    except Exception:
        # Collection does not exist yet (no documents indexed) -> empty result.
        return {"hits": []}

    hits = []
    for r in results:
        meta = r.metadata or {}
        hits.append(
            {
                "document_id": meta.get("document_id"),
                "case_id": meta.get("case_id"),
                "doc_type": meta.get("doc_type"),
                "chunk_index": meta.get("chunk_index", 0),
                "content": meta.get("content") or getattr(r, "document", "") or "",
                "score": r.score,
            }
        )

    # Reasoning-graph expansion: pull legally-connected chunks (court_reasoning →
    # final_decision, etc.) from the pre-built legal graph. Defensive: any failure
    # leaves plain semantic hits untouched.
    if _graph_expansion_enabled() and hits:
        try:
            hits = _expand_hits_via_graph(hits, body.owner_id, client)
        except Exception:
            pass

    return {"hits": hits}


def _graph_expansion_enabled() -> bool:
    return os.getenv("LEXIA_GRAPH_EXPANSION", "1").strip().lower() in {"1", "true", "yes", "on"}


def _expand_hits_via_graph(hits: List[dict], owner_id: str, client) -> List[dict]:
    """Append reasoning-connected chunks discovered via the legal graph.

    Maps each semantic hit to its Qdrant point id, asks the graph for
    reasoning-connected neighbours, and re-includes those chunks — but only after
    verifying (via Qdrant payload) that each neighbour belongs to the requesting
    owner, so expansion can never leak another tenant's documents.
    """
    from nodes.legal_graph.graph_retrieval import expand_point_ids

    have_ids = set()
    for hit in hits:
        document_id = hit.get("document_id")
        if document_id is None:
            continue
        chunk_index = hit.get("chunk_index", 0)
        have_ids.add(str(uuid.uuid5(_NAMESPACE, f"{document_id}-{chunk_index}")))

    if not have_ids:
        return hits

    expansions = expand_point_ids(
        list(have_ids),
        max_neighbors_per_node=3,
        max_total=max(4, len(hits)),
    )
    candidate_ids = [e["point_id"] for e in expansions if e["point_id"] not in have_ids]
    if not candidate_ids:
        return hits

    payloads = {}
    try:
        records = client.retrieve(
            collection_name=_COLLECTION, ids=candidate_ids, with_payload=True
        )
        for record in records:
            payloads[str(record.id)] = record.payload or {}
    except Exception:
        return hits

    base_score = min((h.get("score") or 0.0) for h in hits)
    added = set()
    for expansion in expansions:
        neighbor_id = expansion["point_id"]
        if neighbor_id in have_ids or neighbor_id in added:
            continue
        payload = payloads.get(neighbor_id)
        if not payload or payload.get("owner_id") != owner_id:
            continue  # owner-safety: skip chunks not owned by the requester
        added.add(neighbor_id)
        hits.append(
            {
                "document_id": payload.get("document_id") or expansion.get("document_id"),
                "case_id": payload.get("case_id"),
                "doc_type": payload.get("doc_type"),
                "chunk_index": payload.get("chunk_index", expansion.get("chunk_index") or 0),
                "content": payload.get("content") or expansion.get("text") or "",
                "score": round(max(0.0, base_score - 0.01), 4),
                "via_reasoning": {
                    "connected_to": expansion["source_point_id"],
                    "relation_type": expansion["relation_type"],
                    "confidence": expansion["confidence"],
                    "explanation": expansion["explanation"],
                    "direction": expansion["direction"],
                },
            }
        )
    return hits


@router.delete("/{document_id}")
def delete_document(
    document_id: str,
    owner_id: str,
    x_internal_secret: Optional[str] = Header(default=None),
):
    _check_secret(x_internal_secret)
    client = _get_client()
    _delete_by_filter(client, owner_id=owner_id, document_id=document_id)
    return {"deleted": True}


@cases_router.delete("/{case_id}/documents")
def delete_case_documents(
    case_id: str,
    owner_id: str,
    x_internal_secret: Optional[str] = Header(default=None),
):
    _check_secret(x_internal_secret)
    client = _get_client()
    _delete_by_filter(client, owner_id=owner_id, case_id=case_id)
    return {"deleted": True}


def _delete_by_filter(
    client,
    owner_id: str,
    document_id: Optional[str] = None,
    case_id: Optional[str] = None,
) -> None:
    from qdrant_client import models

    must = [
        models.FieldCondition(key="owner_id", match=models.MatchValue(value=owner_id))
    ]
    if document_id:
        must.append(
            models.FieldCondition(
                key="document_id", match=models.MatchValue(value=document_id)
            )
        )
    if case_id:
        must.append(
            models.FieldCondition(
                key="case_id", match=models.MatchValue(value=case_id)
            )
        )
    try:
        client.delete(
            collection_name=_COLLECTION,
            points_selector=models.FilterSelector(filter=models.Filter(must=must)),
        )
    except Exception:
        # Nothing to delete / collection missing — ignore.
        pass
