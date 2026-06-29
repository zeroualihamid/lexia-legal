"""Shared text chunking for user documents and legal graph indexing."""

from __future__ import annotations

from typing import List

_CHUNK_CHARS = 3200
_CHUNK_OVERLAP = 400


def chunk_text(text: str) -> List[str]:
    """Character-based chunking with overlap, preferring paragraph boundaries."""
    text = (text or "").strip()
    if not text:
        return []
    if len(text) <= _CHUNK_CHARS:
        return [text]

    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    chunks: List[str] = []
    buf = ""
    for para in paragraphs:
        if len(buf) + len(para) + 2 <= _CHUNK_CHARS:
            buf = f"{buf}\n\n{para}" if buf else para
        else:
            if buf:
                chunks.append(buf)
            if len(para) > _CHUNK_CHARS:
                start = 0
                while start < len(para):
                    chunks.append(para[start : start + _CHUNK_CHARS])
                    start += _CHUNK_CHARS - _CHUNK_OVERLAP
                buf = ""
            else:
                buf = para
    if buf:
        chunks.append(buf)
    return chunks
