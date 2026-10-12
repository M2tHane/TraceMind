"""Staged retrieval pipeline with an inspectable recall trace.

    query ─► rewrite (optional) ─► multi-route recall (BM25 / vector, per query)
          ─► weighted RRF fusion ─► rerank (optional) ─► post-process
             (score threshold, near-duplicate removal, MMR diversity, top-k)
          ─► neighbor-context expansion

Every stage appends an entry to ``trace`` with its parameters, latency, output
count and a compact view of the leading candidates, so the full recall chain is
visible in debug results, stored chat messages, evaluation payloads and MCP.

Scores are only comparable within one stage. ``min_score`` therefore applies only
to reranker scores, never to RRF or raw BM25 values.
"""
from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.ranking import bm25, rrf, tokenize

Route = Literal["bm25", "vector"]
LEGACY_METHODS = ("bm25", "vector", "hybrid", "hybrid_rerank")
_TRACE_CANDIDATES = 20
_TRACE_EXCERPT = 200  # characters of chunk text kept per trace candidate


class RetrievalConfig(BaseModel):
    """Complete, serializable description of one retrieval strategy."""
    model_config = ConfigDict(extra="forbid")

    routes: list[Route] = Field(default_factory=lambda: ["vector", "bm25"], min_length=1, max_length=2)
    route_k: int = Field(default=20, ge=1, le=200, description="Candidates recalled per route and query")
    bm25_weight: float = Field(default=1.0, ge=0, le=10)
    vector_weight: float = Field(default=1.0, ge=0, le=10)
    rrf_k: int = Field(default=60, ge=1, le=1000)
    fusion_k: int = Field(default=20, ge=1, le=200, description="Fused candidates kept and sent to rerank")
    rerank: bool = True
    query_rewrite: Literal["none", "multi_query"] = "none"
    rewrite_count: int = Field(default=3, ge=1, le=5)
    min_score: float | None = Field(default=None, description="Minimum reranker score; requires rerank")
    dedupe_threshold: float = Field(default=1.0, ge=0.5, le=1.0,
                                    description="Token Jaccard at or above which a chunk is a duplicate; 1 disables")
    mmr_lambda: float | None = Field(default=None, ge=0, le=1,
                                     description="Relevance/diversity tradeoff; None disables MMR")
    neighbor_window: int = Field(default=0, ge=0, le=2, description="Adjacent chunks attached as context")
    top_k: int = Field(default=5, ge=1, le=20)
    document_ids: list[str] | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def consistent(self) -> RetrievalConfig:
        if len(set(self.routes)) != len(self.routes):
            raise ValueError("Retrieval routes cannot be repeated")
        if self.min_score is not None and not self.rerank:
            raise ValueError("min_score only applies to reranker scores; enable rerank")
        if self.top_k > self.fusion_k:
            raise ValueError("top_k cannot exceed fusion_k")
        if self.document_ids is not None:
            if not self.document_ids or any(not (d.isascii() and d.isdecimal() and 0 < int(d) <= 2**63 - 1)
                                            for d in self.document_ids):
                raise ValueError("document_ids must be a nonempty list of decimal document identifiers")
        return self

    @classmethod
    def from_method(cls, method: str, top_k: int = 5, candidate_k: int = 20) -> RetrievalConfig:
        """Map the legacy method names onto equivalent pipeline settings."""
        if method not in LEGACY_METHODS:
            raise ValueError("Unknown retrieval method")
        routes: list[Route] = {"bm25": ["bm25"], "vector": ["vector"]}.get(method, ["vector", "bm25"])
        return cls(routes=routes, route_k=candidate_k, fusion_k=candidate_k, top_k=min(top_k, candidate_k),
                   rerank=method == "hybrid_rerank")

    def needs_embedding(self) -> bool:
        return "vector" in self.routes


@dataclass
class RetrievalCache:
    """Per-run memo of paid calls; safe to share across configurations of one run."""
    embeddings: dict[str, list[float]] = field(default_factory=dict)
    rerank_scores: dict[tuple[str, str], float] = field(default_factory=dict)
    rewrites: dict[tuple[str, int], list[str]] = field(default_factory=dict)


def _excerpt(text: Any) -> str:
    compact = " ".join(str(text or "").split())
    return compact if len(compact) <= _TRACE_EXCERPT else compact[:_TRACE_EXCERPT - 1] + "…"


def _compact(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Top candidates of one stage, with a short text excerpt so a trace can be read on its own."""
    return [{"rank": rank, "id": row["id"], "document_id": row.get("document_id"), "filename": row.get("filename"),
             "page": row.get("page"), "score": round(float(row.get("score", 0.0)), 6), "text": _excerpt(row.get("text"))}
            for rank, row in enumerate(rows[:_TRACE_CANDIDATES], 1)]


def _jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def dedupe(rows: list[dict[str, Any]], threshold: float) -> list[dict[str, Any]]:
    """Drop chunks whose token set nearly equals an earlier, higher-ranked chunk."""
    if threshold >= 1.0:
        return list(rows)
    kept: list[dict[str, Any]] = []
    signatures: list[set[str]] = []
    for row in rows:
        signature = set(tokenize(row["text"]))
        if any(_jaccard(signature, other) >= threshold for other in signatures):
            continue
        kept.append(row)
        signatures.append(signature)
    return kept


def mmr(rows: list[dict[str, Any]], k: int, lambda_: float) -> list[dict[str, Any]]:
    """Maximal marginal relevance over rank-normalized relevance and token Jaccard similarity."""
    if len(rows) <= 1 or k <= 0:
        return list(rows[:k])
    relevance = [1.0 - index / len(rows) for index in range(len(rows))]
    signatures = [set(tokenize(row["text"])) for row in rows]
    selected: list[int] = []
    remaining = list(range(len(rows)))
    while remaining and len(selected) < k:
        def gain(index: int) -> float:
            redundancy = max((_jaccard(signatures[index], signatures[j]) for j in selected), default=0.0)
            return lambda_ * relevance[index] - (1 - lambda_) * redundancy
        best = max(remaining, key=gain)
        selected.append(best)
        remaining.remove(best)
    return [rows[index] for index in selected]


def attach_neighbors(rows: list[dict[str, Any]], chunks: list[dict[str, Any]], window: int) -> list[dict[str, Any]]:
    """Copy rows with adjacent same-document chunk text as context_before/context_after.

    The cited ``text`` is never altered, so evidence metrics still measure the
    retrieved chunk itself rather than the expanded window.
    """
    if window <= 0:
        return rows
    by_position = {(c["document_id"], c.get("chunk_index")): c for c in chunks if c.get("chunk_index") is not None}
    expanded: list[dict[str, Any]] = []
    for row in rows:
        index = row.get("chunk_index")
        if index is None:
            expanded.append(row)
            continue
        before = [by_position[(row["document_id"], index - offset)]["text"] for offset in range(window, 0, -1)
                  if (row["document_id"], index - offset) in by_position]
        after = [by_position[(row["document_id"], index + offset)]["text"] for offset in range(1, window + 1)
                 if (row["document_id"], index + offset) in by_position]
        expanded.append({**row, "context_before": "\n".join(before), "context_after": "\n".join(after)})
    return expanded


class Recall:
    """Executes one configuration; providers/vectors are injected so tests and tuning can share them."""

    def __init__(self, providers: Any, vectors: Any, cache: RetrievalCache | None = None,
                 before_model_call: Callable[[], Awaitable[None]] | None = None,
                 progress: Callable[[str], Awaitable[None]] | None = None) -> None:
        self.providers, self.vectors = providers, vectors
        self.cache = cache or RetrievalCache()
        self.before_model_call, self.progress = before_model_call, progress
        self.embedding_tokens = 0

    async def _paid(self) -> None:
        if self.before_model_call:
            await self.before_model_call()

    async def _rewrite(self, question: str, count: int) -> list[str]:
        key = (question, count)
        if key not in self.cache.rewrites:
            await self._paid()
            self.cache.rewrites[key] = await self.providers.rewrite_queries(question, count)
        return self.cache.rewrites[key]

    async def _embed(self, texts: list[str]) -> list[list[float]]:
        missing = list(dict.fromkeys(t for t in texts if t not in self.cache.embeddings))
        if missing:
            await self._paid()
            vectors, usage = await self.providers.embed(missing)
            self.embedding_tokens += int(usage.get("total_tokens", 0) or 0)
            self.cache.embeddings.update(zip(missing, vectors, strict=True))
        return [self.cache.embeddings[t] for t in texts]

    async def _rerank(self, question: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        missing = [row for row in rows if (question, row["id"]) not in self.cache.rerank_scores]
        if missing:
            if self.progress:
                await self.progress("reranking")
            await self._paid()
            for row in await self.providers.rerank(question, missing):
                self.cache.rerank_scores[(question, row["id"])] = row["score"]
        scored = [{**row, "score": self.cache.rerank_scores[(question, row["id"])]} for row in rows]
        return sorted(scored, key=lambda row: row["score"], reverse=True)

    async def run(self, question: str, chunks: list[dict[str, Any]], config: RetrievalConfig,
                  knowledge_base_id: int) -> dict[str, Any]:
        trace: list[dict[str, Any]] = []

        def record(stage: str, started: float, rows: list[dict[str, Any]] | None = None, **detail: Any) -> None:
            entry: dict[str, Any] = {"stage": stage, "ms": round((perf_counter() - started) * 1000, 2), **detail}
            if rows is not None:
                entry["count"], entry["candidates"] = len(rows), _compact(rows)
            trace.append(entry)

        started = perf_counter()
        if config.document_ids is not None:
            allowed = set(config.document_ids)
            chunks = [c for c in chunks if c["document_id"] in allowed]
        record("scope", started, corpus_chunks=len(chunks), document_filter=config.document_ids)

        queries = [question]
        if config.query_rewrite == "multi_query":
            started = perf_counter()
            rewrites = await self._rewrite(question, config.rewrite_count)
            queries += [q for q in rewrites if q.strip() and q.strip() != question]
            record("query_rewrite", started, queries=queries)

        lists: list[list[dict[str, Any]]] = []
        weights: list[float] = []
        source = {c["id"]: c for c in chunks}
        # Vector first keeps the legacy hybrid tie-break order.
        for route in sorted(config.routes, key=lambda r: r != "vector"):
            started = perf_counter()
            if route == "vector":
                vectors = await self._embed(queries)
                for query, vector in zip(queries, vectors, strict=True):
                    hits = await self.vectors.search(vector, knowledge_base_id, config.route_k,
                                                     document_ids=config.document_ids)
                    ranking = [{**source[h["id"]], "score": h["score"]} for h in hits if h["id"] in source]
                    lists.append(ranking)
                    weights.append(config.vector_weight)
                    record("recall.vector", started, ranking, query=query, k=config.route_k)
                    started = perf_counter()
            else:
                for query in queries:
                    ranking = await asyncio.to_thread(bm25, query, chunks, config.route_k)
                    lists.append(ranking)
                    weights.append(config.bm25_weight)
                    record("recall.bm25", started, ranking, query=query, k=config.route_k)
                    started = perf_counter()

        started = perf_counter()
        if len(lists) == 1:
            ranked = lists[0][:config.fusion_k]
            record("fusion", started, ranked, method="single_route")
        else:
            ranked = rrf(lists, k=config.rrf_k, limit=config.fusion_k, weights=weights)
            record("fusion", started, ranked, method="weighted_rrf", rrf_k=config.rrf_k, weights=weights)

        if config.rerank and ranked:
            started = perf_counter()
            ranked = await self._rerank(question, ranked)
            record("rerank", started, ranked)

        started = perf_counter()
        before = len(ranked)
        if config.min_score is not None:
            ranked = [row for row in ranked if row["score"] >= config.min_score]
        ranked = dedupe(ranked, config.dedupe_threshold)
        if config.mmr_lambda is not None:
            ranked = mmr(ranked, len(ranked), config.mmr_lambda)
        supplied = attach_neighbors(ranked[:config.top_k], chunks, config.neighbor_window)
        record("postprocess", started, supplied, input=before, kept=len(ranked), min_score=config.min_score,
               dedupe_threshold=config.dedupe_threshold, mmr_lambda=config.mmr_lambda,
               neighbor_window=config.neighbor_window, top_k=config.top_k)
        return {"contexts": ranked, "supplied": supplied, "trace": trace, "queries": queries,
                "embedding_tokens": self.embedding_tokens}
