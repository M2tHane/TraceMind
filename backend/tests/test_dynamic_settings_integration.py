"""Dynamic-settings integration contracts; all database and provider I/O is mocked."""
from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import evaluation as evaluation_api
from app.api import library
from app.config import Settings
from app.models import Chunk, Dataset, Document, EvalItem, EvalRun, KnowledgeBase, Question
from app.schemas import KBCreate, RunCreate
from app.services import evaluation, ingestion, rag
from app.services.auth import Principal
from app.services.providers import ProviderError

EMPLOYEE = Principal(id=2, username="alice", display_name="Alice", role="employee")


def _settings(**changes: Any) -> Settings:
    # model_construct never reads environment variables or .env files.
    return Settings.model_construct(**{
        "tenant_id": 123, "chat_model": "chat-runtime", "chat_protocol": "openai_responses",
        "json_mode": False, "chat_base_url": "https://chat.example.test/v1",
        "chat_api_key": "fake-test-chat-key", "embedding_model": "embedding-runtime",
        "embedding_base_url": "https://embedding.example.test/v1", "embedding_dimensions": 3,
        "embedding_api_key": "fake-test-embedding-key", "rerank_model": "rerank-runtime",
        "rerank_base_url": "https://rerank.example.test/v1", "rerank_protocol": "standard",
        "rerank_api_key": "fake-test-rerank-key", "max_output_tokens": 256, "model_timeout": 15.0,
        "mineru_base_url": "https://parser.example.test", "milvus_uri": "http://vectors.example.test:19530",
        "milvus_collection": "rag_workbench_runtime", **changes,
    })


def _kb(runtime: Settings) -> KnowledgeBase:
    return KnowledgeBase(id=3, tenant_id=123, name="offline", scope="platform", version=1, chunk_size=200, chunk_overlap=20,
                         embedding_model=runtime.embedding_model,
                         embedding_dimensions=runtime.embedding_dimensions,
                         index_config=rag.index_settings_snapshot(runtime))


def _db() -> MagicMock:
    db = MagicMock(spec=AsyncSession)
    db.__aenter__.return_value = db
    db.scalars = AsyncMock(return_value=MagicMock())
    db.execute = AsyncMock(return_value=MagicMock())
    transaction = MagicMock()
    transaction.__aenter__ = AsyncMock()
    transaction.__aexit__ = AsyncMock(return_value=False)
    db.begin.return_value = transaction
    return db


def _run_config(runtime: Settings) -> dict[str, Any]:
    names = ("chat_model", "embedding_model", "embedding_dimensions", "rerank_model",
             "chat_protocol", "json_mode", "rerank_protocol", "chat_base_url", "embedding_base_url",
             "rerank_base_url", "max_output_tokens", "model_timeout", "milvus_uri", "milvus_collection")
    return {"kb_version": 1, **{name: getattr(runtime, name) for name in names}}


@pytest.mark.parametrize("field", ["embedding_model", "embedding_dimensions", "embedding_base_url",
                                  "milvus_uri", "milvus_collection", "empty", "partial"])
def test_index_guard_rejects_changed_or_uninitialized_identity(field: str) -> None:
    runtime = _settings()
    kb = _kb(runtime)
    rag.validate_index_config(kb, runtime)
    if field in {"embedding_model", "embedding_dimensions"}:
        setattr(kb, field, "old")
    elif field == "empty":
        kb.index_config = {}
    elif field == "partial":
        del kb.index_config["embedding_base_url"]
    else:
        kb.index_config[field] = "old"
    with pytest.raises(ProviderError, match="Embedding"):
        rag.validate_index_config(kb, runtime)


async def test_new_library_captures_resolved_index_not_bootstrap(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, db = _settings(), _db()
    resolve = AsyncMock(return_value=runtime)
    monkeypatch.setattr(library, "resolve_settings", resolve)
    monkeypatch.setattr(library, "settings", _settings(embedding_model="bootstrap"))
    monkeypatch.setattr(library, "kb_json", AsyncMock(return_value={"id": "3"}))
    await library.create_knowledge_base(KBCreate(name="Dynamic library"), db, EMPLOYEE)
    kb = db.add.call_args.args[0]
    assert kb.embedding_model == runtime.embedding_model
    assert kb.embedding_dimensions == runtime.embedding_dimensions
    assert kb.index_config == rag.index_settings_snapshot(runtime)
    assert "key" not in str(kb.index_config)
    resolve.assert_awaited_once_with(db=db)


@pytest.fixture
def rag_workspace(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    runtime, db = _settings(), _db()
    provider, vector = MagicMock(), MagicMock()
    provider.answer = AsyncMock(return_value={"answer": "Supported", "citations": [], "abstain": False})
    provider.embed = AsyncMock()
    provider.close = AsyncMock()
    vector.close = AsyncMock()
    providers = MagicMock(return_value=provider)
    vectors = MagicMock(return_value=vector)
    resolve = AsyncMock(return_value=runtime)
    kb = _kb(runtime)
    monkeypatch.setattr(rag, "Session", MagicMock(return_value=db))
    monkeypatch.setattr(rag, "owned", AsyncMock(return_value=kb))
    monkeypatch.setattr(rag, "resolve_settings", resolve)
    monkeypatch.setattr(rag, "Providers", providers)
    monkeypatch.setattr(rag, "VectorStore", vectors)
    return SimpleNamespace(runtime=runtime, db=db, kb=kb, provider=provider, vector=vector,
                           resolve=resolve, providers=providers, vectors=vectors)


@pytest.mark.parametrize("supplied", [False, True])
async def test_rag_resolves_only_when_no_captured_settings(rag_workspace: SimpleNamespace, supplied: bool) -> None:
    state = rag_workspace
    result = await rag.answer_question(3, "Question", method="no_context",
                                       runtime_settings=state.runtime if supplied else None)
    assert result["answer"] == "Supported"
    state.providers.assert_called_once_with(state.runtime)
    state.vectors.assert_called_once_with(state.runtime)
    if supplied:
        state.resolve.assert_not_awaited()
    else:
        state.resolve.assert_awaited_once_with()
    state.provider.close.assert_awaited_once()
    state.vector.close.assert_awaited_once()


@pytest.mark.parametrize("method", ["bm25", "vector", "hybrid", "hybrid_rerank"])
async def test_rag_rejects_changed_store_before_paid_calls(rag_workspace: SimpleNamespace, method: str) -> None:
    state = rag_workspace
    state.kb.index_config["milvus_collection"] = "rag_workbench_old"
    with pytest.raises(ProviderError, match="Embedding"):
        await rag.answer_question(3, "Question", method=method, runtime_settings=state.runtime)
    state.provider.answer.assert_not_awaited()
    state.provider.embed.assert_not_awaited()
    state.db.execute.assert_not_awaited()


async def test_ingestion_pins_runtime_and_preserves_bootstrap_storage(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
) -> None:
    runtime = _settings(data_dir=tmp_path / "not-the-document-root")
    bootstrap = _settings(data_dir=tmp_path, embedding_model="obsolete")
    kb, db = _kb(runtime), _db()
    document = Document(id=9, tenant_id=123, knowledge_base_id=3, filename="source.pdf", status="queued")
    chunk = Chunk(id=11, tenant_id=123, knowledge_base_id=3, document_id=9,
                  chunk_index=0, page=1, text="Document text")
    db.scalars.return_value.all.return_value = [chunk]
    folder = tmp_path / "documents" / "9"
    folder.mkdir(parents=True)
    resolve = AsyncMock(return_value=runtime)
    stages = AsyncMock()
    provider, vector = MagicMock(), MagicMock()
    provider.embed = AsyncMock(return_value=([[0.1, 0.2, 0.3]], {"total_tokens": 3}))
    provider.close = AsyncMock()
    vector.upsert, vector.close = AsyncMock(), AsyncMock()
    providers, vectors = MagicMock(return_value=provider), MagicMock(return_value=vector)

    async def parse(source: Path, destination: Path, endpoint: str, progress: Any) -> dict[str, Any]:
        assert source == folder / "source.pdf" and destination == folder / "parse"
        assert endpoint == runtime.mineru_base_url
        # Saved defaults change during parsing; later stages must keep their initial copy.
        resolve.return_value = _settings(embedding_model="changed", milvus_collection="rag_workbench_changed")
        return {"pages": [{"page": 1, "text": "Document text"}], "markdown": "Document text", "page_count": 1}

    async def owned(db: AsyncSession, model: type, identifier: int, lock: bool = False) -> Any:
        return document if model is Document else kb

    monkeypatch.setattr(ingestion, "settings", bootstrap)
    monkeypatch.setattr(ingestion, "Session", MagicMock(return_value=db))
    monkeypatch.setattr(ingestion, "owned", owned)
    monkeypatch.setattr(ingestion, "resolve_settings", resolve)
    monkeypatch.setattr(ingestion, "set_stage", stages)
    monkeypatch.setattr(ingestion, "parse_pdf", parse)
    monkeypatch.setattr(ingestion, "split_pages", lambda pages, size, overlap: pages)
    monkeypatch.setattr(ingestion, "Providers", providers)
    monkeypatch.setattr(ingestion, "VectorStore", vectors)
    await ingestion.ingest_document(9)
    resolve.assert_awaited_once_with(db=db)
    providers.assert_called_once_with(runtime)
    vectors.assert_called_once_with(runtime)
    vector.upsert.assert_awaited_once()
    assert list((folder / "embeddings").glob("*.json"))
    assert not runtime.data_dir.exists()
    assert document.status == "ready" and kb.version == 2


async def test_ingestion_rejects_incompatible_endpoint_before_parsing(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, db = _settings(), _db()
    kb = _kb(runtime)
    kb.index_config["embedding_base_url"] = "https://old.example.test/v1"
    document = Document(id=9, knowledge_base_id=3, status="queued")
    parse = AsyncMock()
    monkeypatch.setattr(ingestion, "Session", MagicMock(return_value=db))
    monkeypatch.setattr(ingestion, "owned", AsyncMock(side_effect=[document, kb]))
    monkeypatch.setattr(ingestion, "resolve_settings", AsyncMock(return_value=runtime))
    monkeypatch.setattr(ingestion, "parse_pdf", parse)
    monkeypatch.setattr(ingestion, "set_stage", AsyncMock())
    with pytest.raises(ProviderError, match="Embedding"):
        await ingestion.ingest_document(9)
    parse.assert_not_awaited()


async def test_new_evaluation_snapshots_all_dynamic_fields_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, db = _settings(), _db()
    resolve = AsyncMock(return_value=runtime)
    kb = _kb(runtime)
    question = Question(id=8, tenant_id=123, dataset_id=2, question="Question", reference_answer="Reference",
                        answerable=True, evidence=[], review_status="pending")
    db.scalar.side_effect = [None, 1]
    db.scalars.return_value.all.return_value = [question]
    monkeypatch.setattr(evaluation_api, "owned", AsyncMock(side_effect=[kb, Dataset(id=2)]))
    monkeypatch.setattr(evaluation_api, "resolve_settings", resolve)
    response = await evaluation_api.create_run(RunCreate(name="Dynamic run", knowledge_base_id=3, dataset_id=2,
                                                         methods=["hybrid"]), db)
    for name, expected in _run_config(runtime).items():
        assert response["config"][name] == expected
    assert not any("api_key" in key for key in response["config"])
    assert "fake-test" not in str(response)
    resolve.assert_awaited_once_with(db=db)


async def test_evaluation_creation_rejects_incompatible_library(monkeypatch: pytest.MonkeyPatch) -> None:
    runtime, db = _settings(), _db()
    kb = _kb(runtime)
    kb.index_config = {}
    monkeypatch.setattr(evaluation_api, "owned", AsyncMock(side_effect=[kb, Dataset(id=2)]))
    monkeypatch.setattr(evaluation_api, "resolve_settings", AsyncMock(return_value=runtime))
    with pytest.raises(HTTPException) as error:
        await evaluation_api.create_run(RunCreate(name="Bad run", knowledge_base_id=3, dataset_id=2,
                                                  methods=["hybrid"]), db)
    assert error.value.status_code == 409
    db.add.assert_not_called()


@pytest.fixture
def evaluation_workspace(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    runtime, db = _settings(), _db()
    kb = _kb(runtime)
    run = EvalRun(id=10, tenant_id=123, knowledge_base_id=3, dataset_id=2, name="Pinned run", status="queued",
                  methods=["no_context"], judge_enabled=True, total=2, config=_run_config(runtime), summary={})
    items = [EvalItem(id=identifier, tenant_id=123, run_id=10, question_id=identifier,
                      question=f"Question {identifier}", reference_answer="Supported", answerable=True,
                      evidence=[], method="no_context", status="queued", attempts=0, judge_attempts=0,
                      result_payload=None, judgment=None, metrics={}, attempt_history=[]) for identifier in (1, 2)]

    async def scalar(statement: Any) -> Any:
        assert any(clause.left.key == "tenant_id" for clause in statement._where_criteria)
        entity = statement.column_descriptions[0]["entity"]
        if entity is EvalRun:
            return run
        if entity is KnowledgeBase:
            return kb
        identifier = next(clause.right.value for clause in statement._where_criteria if clause.left.key == "id")
        return next(item for item in items if item.id == identifier)

    db.scalar.side_effect = scalar
    db.execute.return_value.scalars.return_value.all.return_value = items
    resolve = AsyncMock(return_value=runtime)
    monkeypatch.setattr(evaluation, "settings", _settings())
    monkeypatch.setattr(evaluation, "Session", MagicMock(return_value=db))
    monkeypatch.setattr(evaluation, "resolve_settings", resolve)
    return SimpleNamespace(runtime=runtime, db=db, kb=kb, run=run, items=items, resolve=resolve)


@pytest.mark.parametrize("field", ["chat_model", "embedding_model", "embedding_dimensions", "rerank_model",
                                  "chat_protocol", "json_mode", "rerank_protocol", "chat_base_url",
                                  "embedding_base_url", "rerank_base_url", "max_output_tokens", "model_timeout",
                                  "milvus_uri", "milvus_collection"])
async def test_evaluation_pauses_on_any_saved_configuration_mismatch(
    evaluation_workspace: SimpleNamespace, field: str,
) -> None:
    state = evaluation_workspace
    state.run.config[field] = "different"
    with pytest.raises(evaluation.EvaluationPaused, match="snapshot"):
        await evaluation._preflight(10, state.runtime)
    assert state.run.status == "paused"
    assert all(item.attempts == 0 for item in state.items)


@pytest.mark.parametrize("field,legacy,changed", [("chat_protocol", "openai_chat", "openai_responses"),
                                               ("json_mode", True, False),
                                               ("rerank_protocol", "dashscope", "standard")])
async def test_legacy_experiments_keep_original_protocol_assumptions(
    evaluation_workspace: SimpleNamespace, field: str, legacy: object, changed: object,
) -> None:
    state = evaluation_workspace
    del state.run.config[field]
    setattr(state.runtime, field, legacy)
    await evaluation._preflight(10, state.runtime)
    setattr(state.runtime, field, changed)
    with pytest.raises(evaluation.EvaluationPaused, match="snapshot"):
        await evaluation._preflight(10, state.runtime)


async def test_evaluation_answer_and_judge_share_one_capture_until_resume(
    evaluation_workspace: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = evaluation_workspace
    received: list[Settings] = []
    provider = MagicMock()
    provider.judge = AsyncMock(return_value={"correct": True, "faithful": True, "reason": "Supported"})
    provider.close = AsyncMock()
    providers = MagicMock(return_value=provider)

    async def answer(kb_id: int, question: str, *, runtime_settings: Settings,
                     before_model_call: Any, **kwargs: Any) -> dict[str, Any]:
        received.append(runtime_settings)
        state.resolve.return_value = _settings(chat_model="different-default")
        await before_model_call()
        return {"answer": "Supported", "abstain": False, "method": "no_context", "contexts": [],
                "citations": [], "generation_context_ids": [], "usage": {}, "timing": {}}

    answers = AsyncMock(side_effect=answer)
    monkeypatch.setattr(evaluation, "answer_question", answers)
    monkeypatch.setattr(evaluation, "Providers", providers)
    await evaluation.execute_run(10)
    state.resolve.assert_awaited_once_with()
    assert len(received) == 2 and all(config is state.runtime for config in received)
    assert providers.call_count == 2
    assert all(call.args[0] is state.runtime for call in providers.call_args_list)
    assert provider.judge.await_count == 2 and state.run.status == "completed"
    # A new worker invocation must not silently adopt changed defaults for a saved run.
    state.run.status = "queued"
    state.items[0].status = "queued"
    await evaluation.execute_run(10)
    assert state.run.status == "paused" and "snapshot" in state.run.error
    assert answers.await_count == 2 and provider.judge.await_count == 2
    assert state.resolve.await_count == 2
