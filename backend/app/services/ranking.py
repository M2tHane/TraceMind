"""Deterministic lexical ranking and reciprocal-rank fusion (no gold inputs)."""

from __future__ import annotations

import re
import unicodedata
from typing import Any

from rank_bm25 import BM25Plus

_TOKEN_RE = re.compile(r"[a-z]+|\d+(?:\.\d+)?|[㐀-䶿一-鿿豈-﫿\U00020000-\U000323af]")


def tokenize(text: str) -> list[str]:
    """NFKC lowercase English words/numbers and individual Han characters."""
    return _TOKEN_RE.findall(unicodedata.normalize("NFKC", text).lower())


def bm25(query: str, chunks: list[dict[str, Any]], k: int) -> list[dict[str, Any]]:
    """Positive-IDF BM25 with no baseline score for nonmatching documents.

    rank_bm25.BM25Plus with delta=0 retains length-normalized BM25 scoring while
    avoiding Okapi's zero/negative IDF on a tiny one-document/local corpus.
    Nonmatching or zero-score chunks are never filled in to reach k.
    """
    if type(k) is not int or k < 0:
        raise ValueError("k must be a nonnegative integer")
    tokens = tokenize(query)
    if not chunks or not tokens or k == 0:
        return []
    seen: set[str] = set()
    rows: list[dict[str, Any]] = []
    for chunk in chunks:
        if chunk["id"] not in seen:
            seen.add(chunk["id"])
            rows.append(chunk)
    corpus = [tokenize(chunk["text"]) for chunk in rows]
    if not any(corpus):
        return []
    scores = BM25Plus(corpus, delta=0).get_scores(tokens)
    ranked = [{**chunk, "score": float(score)} for chunk, score in zip(rows, scores, strict=True) if score > 0]
    return sorted(ranked, key=lambda chunk: chunk["score"], reverse=True)[:k]


def rrf(
    rankings: list[list[dict[str, Any]]], k: int = 60, limit: int = 20,
    weights: list[float] | None = None,
) -> list[dict[str, Any]]:
    """Fuse deduplicated ranks, copying rows and counting each ID once per list.

    Optional nonnegative ``weights`` scale each ranking's contribution (weighted RRF).
    """
    if type(k) is not int or k < 1 or type(limit) is not int or limit < 0:
        raise ValueError("RRF k must be positive and limit must be nonnegative")
    if weights is None:
        weights = [1.0] * len(rankings)
    if len(weights) != len(rankings) or any(not w >= 0 for w in weights):
        raise ValueError("RRF weights must be nonnegative and match the rankings")
    rows: dict[str, dict[str, Any]] = {}
    scores: dict[str, float] = {}
    for ranking, weight in zip(rankings, weights, strict=True):
        seen: set[str] = set()
        for chunk in ranking:
            identifier = chunk["id"]
            if identifier in seen:
                continue
            seen.add(identifier)
            rows.setdefault(identifier, chunk)
            scores[identifier] = scores.get(identifier, 0.0) + weight / (k + len(seen))
    return [{**rows[identifier], "score": score} for identifier, score in
            sorted(scores.items(), key=lambda item: item[1], reverse=True)[:limit]]
