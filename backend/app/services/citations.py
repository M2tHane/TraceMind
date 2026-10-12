"""Inline citation markers in generated answers.

The model writes ``[[<source id>]]`` right after the sentence a source supports. Stored and returned
answers carry ``[^n]`` instead, where ``n`` is the 1-based position in the answer's citation list, so
clients can place a marker on the sentence it belongs to.
"""
from __future__ import annotations

import re

RAW_MARKER = re.compile(r"\[\[\s*([^\[\]\s]{1,128})\s*\]\]")


class MarkerError(ValueError):
    """The answer referenced a source that was not supplied."""


def place_markers(answer: str, citations: list[str], allowed_ids: set[str]) -> tuple[str, list[str]]:
    """Validate raw markers and renumber them; returns (answer with ``[^n]``, ordered citation IDs).

    Citations appear in order of their first marker; cited sources without a marker follow, so every
    ``[^n]`` points into the returned list. Adjacent duplicates of the same marker collapse.
    """
    marked = [match.group(1) for match in RAW_MARKER.finditer(answer)]
    unknown = [identifier for identifier in marked if identifier not in allowed_ids]
    if unknown:
        raise MarkerError("Chat model marked a source outside the supplied contexts")
    order = list(dict.fromkeys([*marked, *citations]))
    number = {identifier: index for index, identifier in enumerate(order, 1)}
    text = RAW_MARKER.sub(lambda match: f"[^{number[match.group(1)]}]", answer)
    text = re.sub(r"(\[\^\d{1,3}\])(?:\s*\1)+", r"\1", text)
    return text, order


def strip_markers(text: str) -> str:
    """Answer text without citation markers (for metrics, copying and plain-text consumers)."""
    return re.sub(r"[ \t]*(?:\[\^\d{1,3}\]|\[\[\s*[^\[\]\s]{1,128}\s*\]\])", "", text)
