"""Offline tests for the staged retrieval pipeline, ranking metrics and tuning helpers."""
from types import SimpleNamespace
from typing import Any

import pytest
from pydantic import ValidationError

from app.models import TuningRun
from app.services.metrics import ranking_metrics
from app.services.ranking import rrf
from app.services.retrieval import (
    Recall,
    RetrievalCache,
    RetrievalConfig,
    attach_neighbors,
    dedupe,
    mmr,
)
from app.services.tuning import TuningError, expand_grid, preset_candidates, summarize, validate_candidates


def chunk(identifier: str, text: str, document: str = "1", index: int = 0) -> dict[str, Any]:
    return {"id": identifier, "document_id": document, "filename": f"doc{document}.md", "page": 1,
            "chunk_index": index, "text": text}


CHUNKS = [
    chunk("a", "retrieval augmented generation combines search and generation", "1", 0),
    chunk("b", "low rank adaptation fine tunes large models", "1", 1),
    chunk("c", "reasoning and acting agents interleave thoughts and tool calls", "2", 0),
    chunk("d", "attention is all you need transformer architecture", "2", 1),
]


class FakeProviders:
    def __init__(self) -> None:
        self.embedded: list[list[str]] = []
        self.reranked: list[list[str]] = []
        self.rewrites = 0

    async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict]:
        self.embedded.append(list(texts))
        return [[float(len(t)), 1.0] for t in texts], {"total_tokens": len(texts)}

    async def rerank(self, question: str, rows: list[dict]) -> list[dict]:
        self.reranked.append([r["id"] for r in rows])
        # Prefer chunk "c", then alphabetical; scores are deterministic.
        return sorted(({**r, "score": 0.9 if r["id"] == "c" else 0.5 - ord(r["id"]) / 1000} for r in rows),
                      key=lambda r: r["score"], reverse=True)

    async def rewrite_queries(self, question: str, count: int) -> list[str]:
        self.rewrites += 1
        return ["tool calls agents", question]


class FakeVectors:
    def __init__(self, order: list[str]) -> None:
        self.order, self.calls = order, []

    async def search(self, vector, knowledge_base_id, limit, document_ids=None):
        self.calls.append({"limit": limit, "document_ids": document_ids})
        return [{"id": i, "score": 1.0 - n / 10} for n, i in enumerate(self.order[:limit])]


async def run(config: RetrievalConfig, providers=None, vectors=None, cache=None, question="agents tool calls"):
    providers = providers or FakeProviders()
    vectors = vectors or FakeVectors(["d", "a", "c", "b"])
    result = await Recall(providers, vectors, cache=cache).run(question, CHUNKS, config, 7)
    return result, providers, vectors


def test_legacy_methods_map_to_equivalent_pipelines() -> None:
    assert RetrievalConfig.from_method("bm25").routes == ["bm25"]
    assert not RetrievalConfig.from_method("hybrid").rerank
    config = RetrievalConfig.from_method("hybrid_rerank", top_k=3, candidate_k=30)
    assert (config.rerank, config.route_k, config.fusion_k, config.top_k) == (True, 30, 30, 3)
    with pytest.raises(ValueError):
        RetrievalConfig.from_method("no_context")


@pytest.mark.parametrize("payload", [
    {"routes": ["bm25", "bm25"]}, {"routes": []}, {"min_score": 0.1, "rerank": False},
    {"top_k": 10, "fusion_k": 5}, {"document_ids": ["x"]}, {"document_ids": []}, {"unknown": 1},
])
def test_invalid_configs_are_rejected(payload: dict) -> None:
    with pytest.raises(ValidationError):
        RetrievalConfig.model_validate(payload)


async def test_hybrid_matches_legacy_rrf_and_traces_every_stage() -> None:
    config = RetrievalConfig.from_method("hybrid", top_k=2, candidate_k=5)
    result, providers, _ = await run(config)
    stages = [entry["stage"] for entry in result["trace"]]
    assert stages == ["scope", "recall.vector", "recall.bm25", "fusion", "postprocess"]
    dense = [{**c, "score": 0} for c in sorted(CHUNKS, key=lambda c: ["d", "a", "c", "b"].index(c["id"]))]
    lexical = result["trace"][2]["candidates"]
    expected = rrf([dense, [{"id": c["id"]} for c in lexical]], limit=5)
    assert [r["id"] for r in result["contexts"]] == [r["id"] for r in expected]
    assert len(result["supplied"]) == 2 and providers.reranked == []
    assert result["embedding_tokens"] == 1


async def test_weights_shift_fusion_toward_one_route() -> None:
    vector_heavy, _, _ = await run(RetrievalConfig(rerank=False, bm25_weight=0.0, top_k=1))
    bm25_heavy, _, _ = await run(RetrievalConfig(rerank=False, vector_weight=0.0, top_k=1))
    assert vector_heavy["supplied"][0]["id"] == "d"
    assert bm25_heavy["supplied"][0]["id"] == "c"


async def test_rerank_threshold_and_cache_reuse_paid_calls() -> None:
    cache = RetrievalCache()
    config = RetrievalConfig(top_k=3, min_score=0.6)
    first, providers, _ = await run(config, cache=cache)
    assert [r["id"] for r in first["supplied"]] == ["c"]
    second, providers2, _ = await run(RetrievalConfig(top_k=2), cache=cache)
    assert providers2.embedded == [] and providers2.reranked == []
    assert second["supplied"][0]["id"] == "c"


async def test_multi_query_rewrites_once_and_fuses_all_queries() -> None:
    config = RetrievalConfig(query_rewrite="multi_query", rerank=False, top_k=2)
    result, providers, vectors = await run(config)
    assert providers.rewrites == 1
    assert result["queries"] == ["agents tool calls", "tool calls agents"]
    assert len(vectors.calls) == 2 and providers.embedded == [["agents tool calls", "tool calls agents"]]
    assert [e["stage"] for e in result["trace"]].count("recall.bm25") == 2


async def test_document_filter_scopes_both_routes() -> None:
    config = RetrievalConfig(rerank=False, document_ids=["2"], top_k=2)
    result, _, vectors = await run(config)
    assert {r["document_id"] for r in result["contexts"]} == {"2"}
    assert vectors.calls[0]["document_ids"] == ["2"]
    assert result["trace"][0]["corpus_chunks"] == 2


def test_postprocessing_helpers() -> None:
    rows = [chunk("x", "alpha beta gamma"), chunk("y", "alpha beta gamma"), chunk("z", "delta epsilon")]
    assert [r["id"] for r in dedupe(rows, 0.9)] == ["x", "z"]
    assert [r["id"] for r in dedupe(rows, 1.0)] == ["x", "y", "z"]
    assert [r["id"] for r in mmr(rows, 2, 0.3)] == ["x", "z"]
    expanded = attach_neighbors([CHUNKS[1]], CHUNKS, 1)[0]
    assert expanded["context_before"] == CHUNKS[0]["text"] and expanded["context_after"] == ""
    assert expanded["text"] == CHUNKS[1]["text"]


def test_ranking_metrics_rank_aware() -> None:
    evidence = [{"document_id": "2", "page": 1, "quote": "reasoning and acting agents interleave"},
                {"document_id": "1", "page": 1, "quote": "never retrieved quote text here"}]
    metrics = ranking_metrics([CHUNKS[3], CHUNKS[2], CHUNKS[0]], evidence)
    assert metrics["hit_at_1"] == 0.0 and metrics["hit_at_3"] == 1.0
    assert metrics["mrr_at_10"] == 0.5 and metrics["recall_at_5"] == 0.5
    assert 0 < metrics["ndcg_at_10"] < 1
    assert ranking_metrics(CHUNKS, []) == {}
    # Overlapping chunks repeating one quote must not push nDCG above 1.
    duplicate = {**CHUNKS[2], "id": "c2"}
    repeated = ranking_metrics([CHUNKS[2], duplicate], evidence[:1])
    assert repeated["ndcg_at_10"] == 1.0 and repeated["mrr_at_10"] == 1.0


def test_tuning_grid_presets_and_leaderboard() -> None:
    grid = expand_grid(RetrievalConfig().model_dump(), {"rerank": [True, False], "route_k": [20, 40]})
    assert len(grid) == 4 and grid[0]["name"] == "grid:rerank=True,route_k=20"
    with pytest.raises(TuningError):
        expand_grid({}, {"document_ids": [["1"]]})
    with pytest.raises(TuningError):
        validate_candidates([{"name": "a", "config": {}}, {"name": "a", "config": {}}])
    assert {c["name"] for c in preset_candidates()} >= {"bm25", "vector", "hybrid", "hybrid_rerank"}
    assert len(validate_candidates(preset_candidates(include_paid_rewrite=True))) == 9
    run = TuningRun(objective="mrr_at_10", candidates=[{"name": "fast"}, {"name": "deep"}, {"name": "bad"}],
                    results={"fast": {"1": {"metrics": {"mrr_at_10": 1.0, "ndcg_at_10": 0.5}, "latency_ms": 5}},
                             "deep": {"1": {"metrics": {"mrr_at_10": 1.0, "ndcg_at_10": 0.9}, "latency_ms": 50}},
                             "bad": {"1": {"error": "x"}}})
    board = summarize(run)
    # Ties on the objective fall back to nDCG, never to cache-affected latency.
    assert [e["name"] for e in board] == ["deep", "fast", "bad"]
    assert board[2]["failed"] == 1 and board[2]["mrr_at_10"] is None


def test_answer_payload_carries_memories_without_citing_them() -> None:
    # Memories enter the prompt payload separately from citable sources.
    import json

    from app.services.providers import Providers
    captured: dict = {}

    async def complete(messages):
        captured["messages"] = messages
        return {"answer": "ok", "citations": ["a"], "abstain": False}, {}, 1.0

    providers = Providers(SimpleNamespace(model_timeout=5, chat_api_key="", embedding_api_key="", rerank_api_key=""))
    providers._complete = complete
    import asyncio
    result = asyncio.run(providers.answer("q", [CHUNKS[0]], memories=["prefers short answers"]))
    payload = json.loads(captured["messages"][-1]["content"])
    assert payload["user_memories"] == ["prefers short answers"] and result["citations"] == ["a"]
    assert "never be cited" in captured["messages"][0]["content"]
    asyncio.run(providers.close())


def test_ndcg_never_exceeds_one_when_one_chunk_quotes_several_labels() -> None:
    chunk = {"id": "c9", "document_id": "2", "filename": "react.pdf", "page": 1,
             "text": "Agents interleave reasoning and acting. Tools return observations to the model."}
    labels = [{"document_id": "2", "page": 1, "quote": "interleave reasoning and acting"},
              {"document_id": "2", "page": 1, "quote": "Tools return observations"}]
    metrics = ranking_metrics([chunk], labels)
    assert metrics["recall_at_5"] == 1.0 and metrics["mrr_at_10"] == 1.0
    assert 0 < metrics["ndcg_at_10"] <= 1.0
