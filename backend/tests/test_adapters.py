"""Offline adapter tests: MockTransport only, no credentials or paid model calls."""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
from loguru import logger

from app.services import parsing
from app.services.chunker import split_pages
from app.services.metrics import answer_metrics, exact_match, normalize_answer, retrieval_metrics, token_f1
from app.services.providers import AccountUnavailable, ProviderError, Providers
from app.services.ranking import bm25, rrf, tokenize


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        chat_base_url="https://chat.test/v1", chat_model="chat-test", chat_api_key="secret-do-not-log",
        embedding_base_url="https://embedding.test/v1", embedding_model="embedding-test",
        embedding_api_key="secret-do-not-log", embedding_dimensions=3,
        rerank_base_url="https://rerank.test", rerank_model="rerank-test", rerank_api_key="secret-do-not-log",
        mineru_base_url="http://mineru.test", model_timeout=10.0, max_output_tokens=2048,
    )


def _chunk(identifier: str = "c1", text: str = "Attention uses weighted values.", page: int = 1) -> dict[str, Any]:
    return {"id": identifier, "document_id": "doc1", "filename": "attention.pdf", "page": page, "text": text}


def _completion(content: object, finish_reason: str = "stop") -> httpx.Response:
    return httpx.Response(200, json={"choices": [{"finish_reason": finish_reason,
                                                "message": {"content": json.dumps(content)}}],
                                     "usage": {"prompt_tokens": 4, "completion_tokens": 3, "total_tokens": 7}})


async def _provider(handler: Any) -> Providers:
    provider = Providers(_settings())
    await provider.close()
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    return provider


async def test_embedding_batches_order_count_and_usage() -> None:
    calls: list[int] = []

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/embeddings"
        body = json.loads(request.content)
        calls.append(len(body["input"]))
        assert body["dimensions"] == 3
        assert body["encoding_format"] == "float"
        return httpx.Response(200, json={"data": [{"index": index, "embedding": [float(text), 1, 2]}
                                                  for index, text in reversed(list(enumerate(body["input"])))],
                                         "usage": {"total_tokens": len(body["input"])}})

    provider = await _provider(respond)
    try:
        vectors, metadata = await provider.embed([str(index) for index in range(35)])
        assert calls == [16, 16, 3]
        assert [vector[0] for vector in vectors] == list(range(35))
        assert metadata["total_tokens"] == 35
        assert metadata["dimensions"] == 3
        assert metadata["latency_ms"] >= 0
        assert await provider.embed([]) == ([], {**metadata, "total_tokens": 0, "latency_ms": pytest.approx(0, abs=1)})
    finally:
        await provider.close()


@pytest.mark.parametrize("rows", [
    [], [{"index": 0, "embedding": [1, 2]}], [{"index": 1, "embedding": [1, 2, 3]}],
    [{"index": True, "embedding": [1, 2, 3]}], [{"index": 0, "embedding": [1, "2", 3]}],
    [{"index": 0, "embedding": [1, True, 3]}],
])
async def test_embedding_rejects_invalid_vectors(rows: list[dict[str, Any]]) -> None:
    provider = await _provider(lambda request: httpx.Response(200, json={"data": rows}))
    try:
        with pytest.raises(ProviderError):
            await provider.embed(["text"])
    finally:
        await provider.close()


async def test_embedding_rejects_nonfinite_values() -> None:
    provider = await _provider(lambda request: httpx.Response(
        200, content=b'{"data":[{"index":0,"embedding":[NaN,1,2]}]}'
    ))
    try:
        with pytest.raises(ProviderError, match="nonfinite"):
            await provider.embed(["text"])
    finally:
        await provider.close()


async def test_rerank_uses_native_double_path_and_sorts_copies() -> None:
    chunks = [_chunk("a"), _chunk("b")]
    original = copy.deepcopy(chunks)

    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/api/v1/services/rerank/text-rerank/text-rerank"
        body = json.loads(request.content)
        assert body["parameters"]["top_n"] == 2
        assert body["input"]["documents"] == [chunk["text"] for chunk in chunks]
        return httpx.Response(200, json={"output": {"results": [
            {"index": 0, "relevance_score": 0.2}, {"index": 1, "relevance_score": 0.9},
        ]}})

    provider = await _provider(respond)
    try:
        result = await provider.rerank("question", chunks)
        assert [chunk["id"] for chunk in result] == ["b", "a"]
        assert result[0]["score"] == 0.9
        assert chunks == original
        assert await provider.rerank("question", []) == []
    finally:
        await provider.close()


@pytest.mark.parametrize("indices", [[0], [0, 0], [0, 2], [0, True]])
async def test_rerank_requires_complete_permutation(indices: list[int]) -> None:
    provider = await _provider(lambda request: httpx.Response(200, json={"output": {"results": [
        {"index": index, "relevance_score": 1} for index in indices
    ]}}))
    try:
        with pytest.raises(ProviderError):
            await provider.rerank("question", [_chunk("a"), _chunk("b")])
    finally:
        await provider.close()


async def test_answer_context_citations_history_and_usage() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/chat/completions"
        body = json.loads(request.content)
        assert body["max_tokens"] == 2048
        assert body["response_format"] == {"type": "json_object"}
        assert body["messages"][1] == {"role": "user", "content": "Earlier question"}
        assert json.loads(body["messages"][-1]["content"])["sources"][0]["id"] == "c1"
        return _completion({"answer": "Weighted values.", "citations": ["c1", "c1"], "abstain": False})

    provider = await _provider(respond)
    try:
        result = await provider.answer("What?", [_chunk()], history=[{"role": "user", "content": "Earlier question"}])
        assert result["citations"] == ["c1"]
        assert result["usage"] == {"total_tokens": 7}
        assert result["latency_ms"] >= 0
    finally:
        await provider.close()


@pytest.mark.parametrize("content,finish", [
    ({"answer": "Fact", "citations": ["fabricated"], "abstain": False}, "stop"),
    ({"answer": "Fact", "citations": [], "abstain": False}, "stop"),
    ({"answer": "Fact", "citations": ["c1"], "abstain": "false"}, "stop"),
    ({"answer": "", "citations": [], "abstain": True}, "stop"),
    ({"answer": "Unknown", "citations": ["c1"], "abstain": True}, "stop"),
    ({"answer": "Fact", "citations": ["c1"], "abstain": False}, "length"),
    ({"answer": "Fact", "citations": ["c1"], "abstain": False}, "content_filter"),
    ({"answer": "Fact", "citations": ["c1"], "abstain": False, "extra": 1}, "stop"),
    (["not an object"], "stop"),
])
async def test_answer_rejects_invalid_or_truncated_schema(content: object, finish: str) -> None:
    provider = await _provider(lambda request: _completion(content, finish))
    try:
        with pytest.raises(ProviderError):
            await provider.answer("Question", [_chunk()])
    finally:
        await provider.close()


async def test_answer_rejects_fenced_or_partial_json_without_repair() -> None:
    provider = await _provider(lambda request: httpx.Response(200, json={"choices": [
        {"finish_reason": "stop", "message": {"content": '```json\n{"answer":"partial"}\n```'}},
    ]}))
    try:
        with pytest.raises(ProviderError, match="final JSON"):
            await provider.answer("Question", [_chunk()])
    finally:
        await provider.close()


async def test_no_context_uses_knowledge_and_never_leaks_sources() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        assert "own general knowledge" in body["messages"][0]["content"]
        assert json.loads(body["messages"][-1]["content"])["sources"] == []
        return _completion({"answer": "Paris", "citations": [], "abstain": False})

    provider = await _provider(respond)
    try:
        assert not (await provider.answer("Capital of France?", [_chunk()], method="no_context"))["abstain"]
    finally:
        await provider.close()


async def test_rag_without_sources_can_abstain() -> None:
    provider = await _provider(lambda request: _completion({"answer": "No support.", "citations": [], "abstain": True}))
    try:
        assert (await provider.answer("Question", []))["abstain"] is True
    finally:
        await provider.close()


async def test_judge_validates_and_returns_token_usage() -> None:
    def respond(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        user = json.loads(body["messages"][-1]["content"])
        assert user["answerable"] is False
        assert user["candidate"]["abstain"] is True
        return _completion({"correct": True, "faithful": True, "reason": "Appropriate abstention."})

    provider = await _provider(respond)
    try:
        result = await provider.judge("Unknown", "", False, {"answer": "Unknown", "abstain": True})
        assert result["correct"] is True
        assert result["usage"]["total_tokens"] == 7
    finally:
        await provider.close()


async def test_judge_rejects_coerced_booleans() -> None:
    provider = await _provider(lambda request: _completion({"correct": "yes", "faithful": 1, "reason": "x"}))
    try:
        with pytest.raises(ProviderError, match="judgment schema"):
            await provider.judge("Question", "Reference", True, {})
    finally:
        await provider.close()


async def test_account_quota_stops_next_request_and_redacts_errors() -> None:
    calls = 0
    logs: list[str] = []
    sink = logger.add(lambda message: logs.append(str(message)), diagnose=False, backtrace=False)

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(429, json={"error": {"code": "insufficient_quota",
                                                   "message": "secret-do-not-log raw provider error"}})

    provider = await _provider(respond)
    try:
        for _ in range(2):
            with pytest.raises(AccountUnavailable) as error:
                await provider.answer("Question", [], method="no_context")
            assert "secret-do-not-log" not in str(error.value)
        assert calls == 1
        assert "secret-do-not-log" not in "".join(logs)
        assert "raw provider error" not in "".join(logs)
    finally:
        logger.remove(sink)
        await provider.close()


async def test_read_timeout_is_not_replayed_and_error_is_safe() -> None:
    calls = 0

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ReadTimeout("secret-do-not-log", request=request)

    provider = await _provider(respond)
    try:
        with pytest.raises(ProviderError) as error:
            await provider.answer("Question", [], method="no_context")
        assert "secret-do-not-log" not in str(error.value)
        assert calls == 1
    finally:
        await provider.close()


def _mineru_result() -> dict[str, Any]:
    return {"results": {"sample": {"content_list": json.dumps([
        {"type": "text", "text": "A <b>readable</b> paragraph.", "page_idx": 0},
        {"type": "table", "table_caption": ["Table 1. Scores"], "page_idx": 0,
         "table_body": "<table><tr><td>A</td><td>0.8</td></tr></table>", "table_footnote": ["Table note."]},
        {"type": "image", "image_caption": ["Figure caption."], "image_footnote": ["Image note."], "page_idx": 1},
    ]), "middle_json": {"pdf_info": [
        {"page_idx": 0, "discarded_blocks": [{"type": "page_footnote", "lines": [
            {"spans": [{"content": "Important footnote."}]},
        ]}]}, {"page_idx": 1}, {"page_idx": 2},
    ]}}}}


def _mock_mineru(monkeypatch: pytest.MonkeyPatch, handler: Any) -> None:
    client_class = httpx.AsyncClient
    monkeypatch.setattr(parsing.httpx, "AsyncClient", lambda **kwargs: client_class(
        **kwargs, transport=httpx.MockTransport(handler)
    ))

    async def no_sleep(seconds: float) -> None:
        return None

    monkeypatch.setattr(parsing.asyncio, "sleep", no_sleep)


async def test_mineru_preserves_text_and_disk_cache_without_reupload(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"%PDF-offline-fixture")
    calls: list[tuple[str, str]] = []
    phases: list[str] = []

    async def progress(phase: str) -> None:
        phases.append(phase)

    def respond(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        if request.method == "POST":
            assert b'return_middle_json' in request.content
            return httpx.Response(200, json={"task_id": "task-1"})
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json=_mineru_result())
        return httpx.Response(200, json={"status": "completed"})

    _mock_mineru(monkeypatch, respond)
    result = await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress)
    assert result["page_count"] == 3  # Blank trailing pages still count from MinerU metadata.
    assert [page["page"] for page in result["pages"]] == [1, 2]
    for text in ("readable", "Table 1. Scores", "A | 0.8", "Table note.", "Important footnote.", "Figure caption.", "Image note."):
        assert text in result["markdown"]
    assert "<table>" not in result["markdown"]
    assert phases == ["parsing"]
    assert len(calls) == 3
    assert await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress) == result
    assert len(calls) == 3
    assert phases == ["parsing", "parsing"]
    folder = tmp_path / "cache" / hashlib.sha256(pdf.read_bytes()).hexdigest()
    assert {path.name for path in folder.iterdir()} == {"task.json", "response.json", "parsed.json"}
    (folder / "parsed.json").unlink()
    assert await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress) == result
    assert len(calls) == 3  # Raw response is sufficient to rebuild parsed text offline.


@pytest.mark.parametrize("failed_read", ["status", "result"])
async def test_mineru_get_failure_resumes_existing_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, failed_read: str,
) -> None:
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"%PDF-recovery")
    uploads = 0
    broken = True

    async def progress(phase: str) -> None:
        assert phase == "parsing"

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal uploads
        if request.method == "POST":
            uploads += 1
            return httpx.Response(200, json={"task_id": "recover-1"})
        is_result = request.url.path.endswith("/result")
        if broken and (failed_read == "status" or is_result):
            raise httpx.ConnectError("raw service credentials must never leak", request=request)
        if is_result:
            return httpx.Response(200, json=_mineru_result())
        return httpx.Response(200, json={"status": "completed"})

    _mock_mineru(monkeypatch, respond)
    with pytest.raises(ProviderError, match="saved task"):
        await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress)
    broken = False
    result = await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress)
    assert result["pages"]
    assert uploads == 1


@pytest.mark.parametrize("scenario", ["failed", "empty", "timeout"])
async def test_mineru_empty_failed_timeout_raise_no_fallback(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, scenario: str,
) -> None:
    pdf = tmp_path / "sample.pdf"
    pdf.write_bytes(b"%PDF-failed")
    uploads = 0

    async def progress(phase: str) -> None:
        assert phase == "parsing"

    def respond(request: httpx.Request) -> httpx.Response:
        nonlocal uploads
        if request.method == "POST":
            uploads += 1
            return httpx.Response(200, json={"task_id": "failed-1"})
        if request.url.path.endswith("/result"):
            return httpx.Response(200, json={"results": {"sample": {"content_list": []}}})
        return httpx.Response(200, json={"status": "failed" if scenario == "failed" else "completed",
                                         "error": "secret-do-not-log"})

    _mock_mineru(monkeypatch, respond)
    if scenario == "timeout":
        monkeypatch.setattr(parsing, "_TASK_TIMEOUT", 0)
    for _ in range(2):
        with pytest.raises(ProviderError) as error:
            await parsing.parse_pdf(pdf, tmp_path / "cache", "http://mineru.test", progress)
        assert "secret-do-not-log" not in str(error.value)
    assert uploads == 1


def test_html_keeps_tables_and_drops_nonvisible_script() -> None:
    assert parsing.strip_html("<p>A &amp; B</p><script>secret()</script><p>C</p>") == "A & B\n\nC"
    assert parsing.strip_html("<tr><td>one</td><td>two</td></tr>") == "one | two |"


def test_chunker_bounds_overlap_indices_and_tail() -> None:
    chunks = split_pages([{"page": 1, "text": "abcdefghijklmno"}, {"page": 3, "text": "tail"}], 6, 2)
    assert [chunk["text"] for chunk in chunks] == ["abcdef", "efghij", "ijklmn", "mno", "tail"]
    assert [chunk["chunk_index"] for chunk in chunks] == list(range(5))
    assert [chunk["page"] for chunk in chunks] == [1, 1, 1, 1, 3]
    assert all(0 < len(chunk["text"]) <= 6 for chunk in chunks)
    assert split_pages([{"page": 1, "text": "  \n"}], 6, 2) == []


@pytest.mark.parametrize("size,overlap", [(0, 0), (5, 5), (5, -1), (5, 6), (True, 0)])
def test_chunker_rejects_nonprogressing_configuration(size: int, overlap: int) -> None:
    with pytest.raises(ValueError):
        split_pages([{"page": 1, "text": "text"}], size, overlap)


def test_bm25_no_match_empty_and_small_corpus() -> None:
    rows = [_chunk("a", "attention attention 中文"), _chunk("b", "unrelated"), _chunk("c", "")]
    original = copy.deepcopy(rows)
    assert tokenize("ATTENTION 中文 １２") == ["attention", "中", "文", "12"]
    assert [row["id"] for row in bm25("attention", rows, 10)] == ["a"]
    assert bm25("missing", rows, 10) == []
    assert bm25("", rows, 10) == []
    assert bm25("text", [_chunk(text="")], 10) == []
    assert bm25("attention", [rows[0]], 10)[0]["score"] > 0
    assert [row["id"] for row in bm25("中文", rows, 10)] == ["a"]
    assert rows == original


def test_rrf_deduplicates_each_ranking_and_does_not_mutate_inputs() -> None:
    a, b = _chunk("a"), _chunk("b")
    rankings = [[a, a, b], [b, a]]
    original = copy.deepcopy(rankings)
    result = rrf(rankings)
    assert [row["id"] for row in result] == ["a", "b"]
    assert result[0]["score"] == pytest.approx(1 / 61 + 1 / 62)
    assert result[1]["score"] == pytest.approx(1 / 62 + 1 / 61)
    assert rankings == original
    assert rrf(rankings, limit=1) == result[:1]
    assert rrf([]) == []


def test_answer_metrics_multisets_numbers_and_missing_reference() -> None:
    assert exact_match("中文 Ａttention!", "中文 attention") == 1
    assert exact_match("-0.2", "0.2") == 0
    assert normalize_answer("−0.2 1e-3") == "-0.2 1e-3"
    assert token_f1("cat cat dog", "cat dog dog") == pytest.approx(2 / 3)
    assert token_f1("中文", "中文语") == pytest.approx(4 / 5)
    assert token_f1("answer", ["no", "answer"]) == 1
    assert token_f1("answer", []) is None
    assert exact_match("answer", []) is None
    assert answer_metrics("answer", " ") == {}
    assert answer_metrics("answer", "answer")["answer_metric_label"] == "lexical_proxy"


def test_retrieval_lexical_mapping_not_page_hit_and_unmapped_denominator() -> None:
    contexts = [_chunk("wrong", "Unrelated content."), _chunk("yes", "Attention uses weighted values.")]
    evidence = [{"doc_id": "attention", "page": 1, "quote": "Attention uses weighted values"},
                {"document_id": "doc1", "page": 1, "quote": "Completely different missing fact"}]
    scores = retrieval_metrics(contexts, evidence)
    assert scores["hit_at_5"] == 1
    assert scores["evidence_recall_at_5"] == 0.5
    assert scores["mrr_at_10"] == 0.5
    assert scores["evidence_count"] == 2
    assert scores["retrieval_metric_label"] == "lexical_proxy"
    assert retrieval_metrics(contexts, []) == {}
    assert retrieval_metrics([], evidence)["evidence_recall_at_5"] == 0
    assert retrieval_metrics(contexts[:1], evidence)["hit_at_5"] == 0


def test_retrieval_anchor_identity_deduplication_and_cutoffs() -> None:
    evidence = [{"doc_id": "attention", "page": 2, "quote": "Attention uses weighted values."}]
    # An exact adjacent-page quote may be a MinerU merged paragraph; a distant page cannot.
    assert retrieval_metrics([_chunk(page=1)], evidence)["hit_at_5"] == 1
    assert retrieval_metrics([_chunk(page=4)], evidence)["hit_at_5"] == 0
    assert retrieval_metrics([{**_chunk(), "filename": "other.pdf"}], evidence)["hit_at_5"] == 0
    explicit = [{**evidence[0], "document_id": "different-document"}]
    assert retrieval_metrics([_chunk()], explicit)["hit_at_5"] == 0
    contexts = [_chunk(str(index), "Unrelated.") for index in range(5)] + [_chunk("yes")]
    scores = retrieval_metrics([contexts[0], *contexts], evidence)
    assert scores["hit_at_5"] == 0
    assert scores["mrr_at_10"] == pytest.approx(1 / 6)
    assert scores["evidence_matched_at_10"] == 1
    assert retrieval_metrics([_chunk()], [{"doc_id": "attention", "page": 1, "quote": ""}])["hit_at_5"] == 0


def _mock_vectors(
    monkeypatch: pytest.MonkeyPatch, *, exists: bool = False, dimensions: int = 3,
) -> tuple[Any, dict[str, Any]]:
    from app.services import vectors

    main_thread = threading.get_ident()
    state: dict[str, Any] = {"calls": [], "stored": {}, "hits": [{"id": "c1", "distance": 0.9}]}

    def record(operation: str, kwargs: dict[str, Any]) -> None:
        assert threading.get_ident() != main_thread, "Milvus SDK work must run outside the event loop"
        state["calls"].append((operation, kwargs))

    class FakeSchema:
        def add_field(self, **kwargs: Any) -> None:
            record("add_field", kwargs)

    class FakeIndexes:
        def add_index(self, **kwargs: Any) -> None:
            record("add_index", kwargs)

    class FakeClient:
        def __init__(self, **kwargs: Any) -> None:
            record("init", kwargs)

        def has_collection(self, **kwargs: Any) -> bool:
            record("has_collection", kwargs)
            return exists

        def create_schema(self, **kwargs: Any) -> FakeSchema:
            record("create_schema", kwargs)
            return FakeSchema()

        def prepare_index_params(self) -> FakeIndexes:
            record("prepare_index_params", {})
            return FakeIndexes()

        def create_collection(self, **kwargs: Any) -> None:
            record("create_collection", kwargs)

        def describe_collection(self, **kwargs: Any) -> dict[str, Any]:
            record("describe_collection", kwargs)
            return {"fields": [
                {"name": "id", "type": vectors.DataType.VARCHAR, "is_primary": True},
                *[{"name": name, "type": vectors.DataType.VARCHAR}
                  for name in ("tenant_id", "knowledge_base_id", "document_id")],
                {"name": "vector", "type": vectors.DataType.FLOAT_VECTOR, "params": {"dim": dimensions}},
            ]}

        def load_collection(self, **kwargs: Any) -> None:
            record("load_collection", kwargs)

        def upsert(self, **kwargs: Any) -> dict[str, int]:
            record("upsert", kwargs)
            for row in kwargs["data"]:
                state["stored"][row["id"]] = row
            return {"upsert_count": len(kwargs["data"])}

        def search(self, **kwargs: Any) -> list[list[dict[str, Any]]]:
            record("search", kwargs)
            if state.get("search_error"):
                raise RuntimeError("secret-do-not-log")
            return [state["hits"]]

        def close(self) -> None:
            record("close", {})

    monkeypatch.setattr(vectors, "MilvusClient", FakeClient)
    settings = _settings()
    settings.milvus_uri = "http://milvus.test:19530"
    settings.milvus_collection = "rag_workbench_test"
    settings.tenant_id = 123
    return vectors.VectorStore(settings), state


async def test_milvus_ensure_schema_create_once_and_all_calls_off_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    store, state = _mock_vectors(monkeypatch)
    try:
        await asyncio.gather(store.ensure(), store.ensure(), store.ensure())
        operations = [name for name, _ in state["calls"]]
        assert operations.count("create_collection") == 1
        assert operations.count("describe_collection") == 1
        creation = next(kwargs for name, kwargs in state["calls"] if name == "create_collection")
        assert creation["collection_name"] == "rag_workbench_test"
        assert creation["consistency_level"] == "Strong"
        schema = next(kwargs for name, kwargs in state["calls"] if name == "create_schema")
        assert schema == {"auto_id": False, "enable_dynamic_field": False}
    finally:
        await store.close()
    assert state["calls"][-1][0] == "close"


async def test_milvus_existing_collection_dimension_mismatch_is_not_modified(monkeypatch: pytest.MonkeyPatch) -> None:
    store, state = _mock_vectors(monkeypatch, exists=True, dimensions=4)
    try:
        with pytest.raises(ProviderError, match="dimensions"):
            await store.ensure()
        assert "create_collection" not in [name for name, _ in state["calls"]]
    finally:
        await store.close()


async def test_milvus_upsert_idempotent_string_scopes_and_strong_search(monkeypatch: pytest.MonkeyPatch) -> None:
    store, state = _mock_vectors(monkeypatch)
    chunks = [{**_chunk(), "document_id": "456"}]
    try:
        await store.upsert(chunks, [[1, 2, 3]], knowledge_base_id=789, document_id=456)
        await store.upsert(chunks, [[3, 2, 1]], knowledge_base_id=789, document_id=456)
        assert len(state["stored"]) == 1
        assert state["stored"]["c1"] == {"id": "c1", "vector": [3.0, 2.0, 1.0],
                                             "tenant_id": "123", "knowledge_base_id": "789", "document_id": "456"}
        result = await store.search([1, 2, 3], knowledge_base_id=789, limit=5)
        assert result == [{"id": "c1", "score": 0.9}]
        search = next(kwargs for name, kwargs in state["calls"] if name == "search")
        assert search["filter"] == 'tenant_id == "123" and knowledge_base_id == "789"'
        assert search["consistency_level"] == "Strong"
        assert search["limit"] == 5
        assert search["anns_field"] == "vector"
    finally:
        await store.close()


async def test_milvus_validates_scopes_batch_dimensions_and_safe_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    store, state = _mock_vectors(monkeypatch)
    chunks = [{**_chunk(), "document_id": "456"}]
    try:
        with pytest.raises(ProviderError, match="identifiers"):
            await store.search([1, 2, 3], knowledge_base_id='1" or true')
        with pytest.raises(ProviderError, match="dimensions"):
            await store.search([1, 2], knowledge_base_id=789)
        with pytest.raises(ProviderError, match="another document"):
            await store.upsert(chunks, [[1, 2, 3]], knowledge_base_id=789, document_id=457)
        with pytest.raises(ProviderError, match="counts"):
            await store.upsert(chunks, [], knowledge_base_id=789, document_id=456)
        assert state["calls"] == []
        state["search_error"] = True
        with pytest.raises(ProviderError) as error:
            await store.search([1, 2, 3], knowledge_base_id=789)
        assert "secret-do-not-log" not in str(error.value)
    finally:
        await store.close()


def test_milvus_rejects_original_project_collection_namespace(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import vectors

    store, state = _mock_vectors(monkeypatch)
    settings = store.settings
    settings.milvus_collection = "rag_eval_20260928"
    with pytest.raises(ProviderError, match="isolated"):
        vectors.VectorStore(settings)
    assert state["calls"] == []
