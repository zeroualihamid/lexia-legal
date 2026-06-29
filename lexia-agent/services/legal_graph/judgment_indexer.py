"""Sync judgment OCR text from Postgres into lexia_user_docs for graph building."""

from __future__ import annotations

import logging
import os
import uuid
from typing import Any, Dict, List

from services.legal_graph.text_chunking import chunk_text

logger = logging.getLogger(__name__)

_GLOBAL_JUDGMENTS_CASE_ID = "00000000-0000-0000-0000-000000000001"
_NAMESPACE = uuid.UUID("6f9619ff-8b86-d011-b42d-00c04fc964ff")
_COLLECTION = os.getenv("LEXIA_USER_DOCS_COLLECTION", "lexia_user_docs")
_QDRANT_URL = os.getenv("QDRANT_URL") or (
    f"http://{os.getenv('QDRANT_HOST', 'localhost')}:{os.getenv('QDRANT_PORT', '6333')}"
)
_QDRANT_API_KEY = os.getenv("QDRANT_API_KEY") or None
_EMBED_MODEL = os.getenv("LEXIA_DOC_EMBED_MODEL", "intfloat/multilingual-e5-large")

_qdrant_client = None


def _get_qdrant_client():
    global _qdrant_client
    if _qdrant_client is None:
        from qdrant_client import QdrantClient

        client = QdrantClient(url=_QDRANT_URL, api_key=_QDRANT_API_KEY)
        client.set_model(_EMBED_MODEL)
        _qdrant_client = client
    return _qdrant_client


def _delete_document_points(client, *, owner_id: str, document_id: str) -> None:
    from qdrant_client import models

    try:
        client.delete(
            collection_name=_COLLECTION,
            points_selector=models.FilterSelector(
                filter=models.Filter(
                    must=[
                        models.FieldCondition(
                            key="owner_id", match=models.MatchValue(value=owner_id)
                        ),
                        models.FieldCondition(
                            key="document_id", match=models.MatchValue(value=document_id)
                        ),
                    ]
                )
            ),
        )
    except Exception:
        pass


def _postgres_dsn() -> str:
    if os.getenv("DATABASE_URL"):
        return os.getenv("DATABASE_URL")  # type: ignore[return-value]
    user = os.getenv("POSTGRES_USER", "legal_ai")
    password = os.getenv("POSTGRES_PASSWORD", "")
    host = os.getenv("POSTGRES_HOST", "postgres")
    port = os.getenv("POSTGRES_PORT", "5432")
    db = os.getenv("POSTGRES_DB", "legal_ai")
    return f"postgresql://{user}:{password}@{host}:{port}/{db}"


def fetch_judgment_documents() -> List[Dict[str, Any]]:
    """Load published/ready judgment documents with OCR text from Postgres."""
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError as exc:
        raise RuntimeError(f"psycopg2 unavailable: {exc}") from exc

    conn = psycopg2.connect(_postgres_dsn())
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(
                """
                SELECT id, title_ar, ocr_text, owner_id, case_id, collection
                FROM documents
                WHERE document_type = 'judgment'
                  AND ocr_text IS NOT NULL
                  AND LENGTH(TRIM(ocr_text)) > 200
                ORDER BY title_ar
                """
            )
            return [dict(row) for row in cur.fetchall()]
    finally:
        conn.close()


def sync_postgres_judgments_to_qdrant() -> Dict[str, Any]:
    """Re-index every judgment document into lexia_user_docs (FastEmbed, 1024d)."""
    try:
        documents = fetch_judgment_documents()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Postgres judgment sync skipped: %s", exc)
        return {"documents": 0, "chunks": 0, "skipped": str(exc)}

    if not documents:
        return {"documents": 0, "chunks": 0}

    client = _get_qdrant_client()
    synced = 0
    chunks_total = 0
    errors: List[str] = []

    for doc in documents:
        doc_id = str(doc["id"])
        owner_id = str(doc.get("owner_id") or "system")
        case_id = str(doc.get("case_id") or _GLOBAL_JUDGMENTS_CASE_ID)
        title = str(doc.get("title_ar") or doc_id)
        text = str(doc.get("ocr_text") or "")
        chunks = chunk_text(text)
        if not chunks:
            errors.append(f"{doc_id}: empty after chunking")
            continue

        try:
            _delete_document_points(client, owner_id=owner_id, document_id=doc_id)
            documents_payload: List[str] = []
            metadata_payload: List[dict] = []
            ids: List[str] = []
            for index, chunk in enumerate(chunks):
                documents_payload.append(chunk)
                metadata_payload.append(
                    {
                        "owner_id": owner_id,
                        "case_id": case_id,
                        "document_id": doc_id,
                        "doc_type": "judgment",
                        "document_type": "judgment",
                        "title": title,
                        "visibility": "public",
                        "chunk_index": index,
                        "content": chunk,
                        "collection": doc.get("collection") or "judgments_commercial",
                    }
                )
                ids.append(str(uuid.uuid5(_NAMESPACE, f"{doc_id}-{index}")))

            client.add(
                collection_name=_COLLECTION,
                documents=documents_payload,
                metadata=metadata_payload,
                ids=ids,
            )
            synced += 1
            chunks_total += len(chunks)
        except Exception as exc:  # noqa: BLE001
            logger.warning("Failed to index judgment %s: %s", doc_id, exc)
            errors.append(f"{doc_id}: {exc}")

    logger.info(
        "Synced %s judgment documents (%s chunks) into %s",
        synced,
        chunks_total,
        _COLLECTION,
    )
    return {"documents": synced, "chunks": chunks_total, "errors": errors}
