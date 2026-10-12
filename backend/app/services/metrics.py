"""Deterministic lexical proxies adapted from Supie's offline rag_metrics/rag_parse.

These are not semantic relevance, human correctness, or retrieval precision.
Evidence without a lexical match remains in the denominator; an empty evidence
list is unscorable rather than a zero or perfect retrieval score.
"""

from __future__ import annotations

import math
import re
import unicodedata
from collections import Counter
from collections.abc import Sequence
from difflib import SequenceMatcher
from html import unescape
from pathlib import PurePosixPath
from typing import Any

_TOKEN_RE = re.compile(
    r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?|[a-z]+|"
    r"[㐀-䶿一-鿿豈-﫿\U00020000-\U000323af]"
)


def normalize_answer(answer: str) -> str:
    """NFKC/lowercase tokens with signed decimals and CJK characters preserved."""
    return " ".join(_TOKEN_RE.findall(unicodedata.normalize("NFKC", answer).lower().replace("−", "-")))


def exact_match(prediction: str, references: str | Sequence[str]) -> float | None:
    """Best normalized exact match; no reference sequence gives no observation."""
    refs = [references] if isinstance(references, str) else references
    normalized = normalize_answer(prediction)
    return max((float(normalized == normalize_answer(reference)) for reference in refs), default=None)


def token_f1(prediction: str, references: str | Sequence[str]) -> float | None:
    """Best multiset token F1, a lexical proxy rather than semantic correctness."""
    refs = [references] if isinstance(references, str) else references
    predicted = normalize_answer(prediction).split()
    scores = []
    for reference in refs:
        expected = normalize_answer(reference).split()
        common = sum((Counter(predicted) & Counter(expected)).values())
        count = len(predicted) + len(expected)
        scores.append(2 * common / count if count else 1.0)
    return max(scores, default=None)


def answer_metrics(prediction: str, reference_answer: str) -> dict[str, Any]:
    """Only emit answer scores when a nonblank reference was supplied."""
    if not reference_answer.strip():
        return {}
    return {"exact_match": exact_match(prediction, reference_answer),
            "token_f1": token_f1(prediction, reference_answer), "answer_metric_label": "lexical_proxy"}


def _evidence_normalize(text: str) -> str:
    plain = unescape(re.sub(r"<[^>]+>", "", text))
    return "".join(char for char in unicodedata.normalize("NFKC", plain).lower() if char.isalnum())


def _containment(quote: str, text: str) -> float:
    if not quote or not text:
        return 0.0
    if quote in text:
        return 1.0
    blocks = SequenceMatcher(None, quote, text, autojunk=False).get_matching_blocks()
    if max((block.size for block in blocks), default=0) < min(25, len(quote) * 0.3):
        return 0.0
    return sum(block.size for block in blocks) / len(quote)


def _stem(filename: object) -> str:
    return PurePosixPath(str(filename or "").replace("\\", "/")).stem.casefold()


def _matches(chunk: dict[str, Any], evidence: dict[str, Any]) -> bool:
    # Explicit DB IDs take precedence; a conflicting filename is not a bypass.
    document_id = evidence.get("document_id")
    if document_id:
        same_document = str(chunk.get("document_id", "")) == str(document_id)
    else:
        portable_id = _stem(evidence.get("doc_id"))
        same_document = bool(portable_id) and portable_id in {
            _stem(chunk.get("filename")), _stem(chunk.get("doc_id")),
        }
    page, anchor = evidence.get("page"), chunk.get("page")
    if (not same_document or type(page) is not int or type(anchor) is not int
            or page < 1 or anchor < 1 or abs(page - anchor) > 1):
        return False
    quote, text = evidence.get("quote", ""), chunk.get("text", "")
    if not isinstance(quote, str) or not isinstance(text, str):
        return False
    threshold = 0.9 if page == anchor else 0.98
    return _containment(_evidence_normalize(quote), _evidence_normalize(text)) >= threshold


def retrieval_metrics(contexts: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Top-5 evidence coverage and first-hit MRR@10 via quoted-text containment.

    Same-page containment >= .9, or adjacent-page containment >= .98 (MinerU
    paragraph merging), is required. A page hit alone never counts. Unmapped,
    malformed and out-of-range labels remain in the evidence denominator.
    """
    if not evidence:
        return {}
    seen: set[str] = set()
    ranked: list[dict[str, Any]] = []
    for chunk in contexts:
        if chunk["id"] not in seen:
            seen.add(chunk["id"])
            ranked.append(chunk)
    mapped = [{rank for rank, chunk in enumerate(ranked[:10], 1)
               if isinstance(label, dict) and _matches(chunk, label)} for label in evidence]
    top5_matches = sum(any(rank <= 5 for rank in ranks) for ranks in mapped)
    first_rank = min((rank for ranks in mapped for rank in ranks), default=None)
    return {"hit_at_5": float(top5_matches > 0), "evidence_recall_at_5": top5_matches / len(evidence),
            "mrr_at_10": 1.0 / first_rank if first_rank else 0.0,
            "retrieval_metric_label": "lexical_proxy", "evidence_count": len(evidence),
            "evidence_matched_at_5": top5_matches,
            "evidence_matched_at_10": sum(bool(ranks) for ranks in mapped)}


RANKING_METRICS = ("hit_at_1", "hit_at_3", "hit_at_5", "hit_at_10", "recall_at_5", "recall_at_10",
                   "mrr_at_10", "ndcg_at_10")


def ranking_metrics(contexts: list[dict[str, Any]], evidence: list[dict[str, Any]]) -> dict[str, Any]:
    """Rank-aware retrieval metrics for tuning, using the same evidence matching as above.

    A ranked chunk is relevant when it contains any gold evidence quote. Recall counts
    evidence labels covered within the cutoff. nDCG@10 credits each evidence label once,
    at its first matching rank (overlapping chunks often repeat one quote), and each rank at
    most once (one chunk may quote several labels), against an ideal ranking of min(#evidence, 10) labels, so it never exceeds 1. Same lexical-proxy caveat applies:
    this is not a human relevance pool.
    """
    if not evidence:
        return {}
    ranked: list[dict[str, Any]] = []
    seen: set[str] = set()
    for chunk in contexts:
        if chunk["id"] not in seen:
            seen.add(chunk["id"])
            ranked.append(chunk)
    ranked = ranked[:10]
    matches = [[_matches(chunk, label) if isinstance(label, dict) else False for label in evidence]
               for chunk in ranked]
    relevant = [any(row) for row in matches]

    def covered(k: int) -> int:
        return sum(any(matches[rank][index] for rank in range(min(k, len(matches))))
                   for index in range(len(evidence)))

    first = next((rank for rank, flag in enumerate(relevant, 1) if flag), None)
    first_hits = [next((rank for rank, row in enumerate(matches, 1) if row[index]), None)
                  for index in range(len(evidence))]
    # A rank earns gain once when it covers a not-yet-covered label: one chunk quoting two
    # labels must not out-score the ideal ranking, which places one label per rank.
    dcg = sum(1.0 / math.log2(rank + 1) for rank in {rank for rank in first_hits if rank is not None})
    ideal = sum(1.0 / math.log2(rank + 1) for rank in range(1, min(len(evidence), 10) + 1))
    result: dict[str, Any] = {f"hit_at_{k}": float(any(relevant[:k])) for k in (1, 3, 5, 10)}
    result.update({"recall_at_5": covered(5) / len(evidence), "recall_at_10": covered(10) / len(evidence),
                   "mrr_at_10": 1.0 / first if first else 0.0, "ndcg_at_10": dcg / ideal if ideal else 0.0,
                   "first_relevant_rank": first, "metric_label": "lexical_proxy"})
    return result
