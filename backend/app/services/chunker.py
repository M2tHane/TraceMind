"""Standalone fixed-size chunking adapted from Supie TextChunker._chunk_fixed_size.

This intentionally keeps the original separator preference and bounded overlap,
without importing Supie or using questions, reference answers, or gold evidence.
"""

from __future__ import annotations

from typing import Any

_SEPARATORS = ("\n\n", "\n", ". ", "。", "! ", "? ", " ")


def split_pages(
    pages: list[dict[str, Any]], chunk_size: int, chunk_overlap: int,
) -> list[dict[str, Any]]:
    """Split each page independently, preserving page anchors and global indices.

    Sizes are character counts, not model tokens. Every nonempty chunk is at
    most chunk_size; a short final tail is retained. Invalid overlaps are rejected
    rather than generating nearly identical one-character-advance chunks.
    """
    if type(chunk_size) is not int or chunk_size < 1:
        raise ValueError("chunk_size must be a positive integer")
    if type(chunk_overlap) is not int or not 0 <= chunk_overlap < chunk_size:
        raise ValueError("chunk_overlap must satisfy 0 <= overlap < chunk_size")
    chunks: list[dict[str, Any]] = []
    min_boundary = max(chunk_overlap + 1, min(600, chunk_size // 3))
    for page in pages:
        anchor, text = page.get("page"), page.get("text")
        if type(anchor) is not int or anchor < 1 or not isinstance(text, str):
            raise ValueError("Each page requires a positive page anchor and string text")
        start = 0
        while start < len(text):
            end = min(start + chunk_size, len(text))
            if end < len(text):
                for separator in _SEPARATORS:
                    boundary = text.rfind(separator, start, end)
                    if boundary > start + min_boundary:
                        end = boundary + len(separator)
                        break
            content = text[start:end].strip()
            if content:
                chunks.append({"page": anchor, "text": content, "chunk_index": len(chunks)})
            if end >= len(text):
                break
            start = max(start + 1, end - chunk_overlap)
    return chunks
