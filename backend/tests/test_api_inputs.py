"""Offline API boundaries: no database, MinerU, Milvus or paid model requests."""
from __future__ import annotations

import asyncio
import io
import json
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import httpx
import pymupdf
import pytest
from fastapi import FastAPI, HTTPException, Response, UploadFile
from fastapi.testclient import TestClient
from loguru import logger
from pydantic import ValidationError
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.api import chat, library, system
from app.api.deps import current_principal
from app.config import settings
from app.db import get_db
from app.models import Conversation, Document, EvalRun, Job, KnowledgeBase, Message, TenantModel
from app.schemas import ConversationCreate, DebugRequest, KBCreate, MessageCreate
from app.services.auth import Principal
from app.services.providers import ProviderError

ADMIN = Principal(id=1, username="admin", display_name="Admin", role="admin")


def _pdf(text: str = "A readable test PDF", *, encrypted: bool = False) -> bytes:
    with pymupdf.open() as pdf:
        page = pdf.new_page()
        page.insert_text((72, 72), text)
        if encrypted:
            return pdf.tobytes(encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="test-user", owner_pw="test-owner")
        return pdf.tobytes()


def _upload(content: bytes, name: str = "document.pdf") -> UploadFile:
    return UploadFile(file=io.BytesIO(content), filename=name)


def _kb() -> KnowledgeBase:
    return KnowledgeBase(id=11, tenant_id=settings.tenant_id, name="Test", scope="platform", owner_id=1,
                         chunk_size=2200,
                         chunk_overlap=400, embedding_model=settings.embedding_model,
                         embedding_dimensions=settings.embedding_dimensions)


def _document(identifier: int = 21, status: str = "ready", stage: str | None = None) -> Document:
    return Document(id=identifier, tenant_id=settings.tenant_id, knowledge_base_id=11,
                    filename="document.pdf", file_sha256="0" * 64, status=status, stage=stage or status,
                    page_count=1, chunk_count=1, markdown="Parsed document")


def _conversation() -> Conversation:
    return Conversation(id=31, tenant_id=settings.tenant_id, knowledge_base_id=11, title="新对话", owner_id=1)


def _db(rows: list[object] | None = None) -> tuple[MagicMock, list[TenantModel]]:
    """Only mimic session I/O; actual SQL expressions are separately checked for scoping."""
    db = MagicMock(spec=AsyncSession)
    added: list[TenantModel] = []
    db.add.side_effect = added.append
    db.add_all.side_effect = added.extend
    db.scalar = AsyncMock(side_effect=rows) if rows is not None else AsyncMock(return_value=None)
    db.execute = AsyncMock()
    db.scalars = AsyncMock(return_value=MagicMock())
    db.rollback = AsyncMock()
    db.commit = AsyncMock()

    async def flush() -> None:
        for number, row in enumerate(added, 101):
            if row.id is None:
                row.id = number
            row.created_at = datetime.now(UTC)
            row.updated_at = row.created_at
            if isinstance(row, Document):
                row.chunk_count = row.chunk_count or 0
                row.markdown = row.markdown or ""
            if isinstance(row, Message):
                row.citations = row.citations or []
                row.contexts = row.contexts or []
                row.timing = row.timing or {}
                row.usage = row.usage or {}

    db.flush = AsyncMock(side_effect=flush)
    return db, added


def _sql(statement: object) -> str:
    return str(statement.compile(dialect=postgresql.dialect(), compile_kwargs={"literal_binds": True}))


@pytest.fixture
def storage(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "max_upload_mb", 50)
    return tmp_path


@pytest.mark.parametrize("name,expected", [
    ("../../report.pdf", "report.pdf"), (r"C:\private\报告.PDF", "报告.PDF"),
    ("/tmp/example.pdf", "example.pdf"), ("  report.pdf  ", "report.pdf"),
])
def test_filename_is_always_a_basename(name: str, expected: str) -> None:
    assert library.safe_filename(name) == expected


@pytest.mark.parametrize("name", [None, "", ".pdf", ".md", "../", "notes.docx", "report.pdf.exe",
                                  "a\x00.pdf", "a\n.pdf", "x\u202e.pdf", "report:secret.pdf", "a" * 201 + ".pdf"])
def test_rejects_unsafe_filenames(name: str | None) -> None:
    with pytest.raises(HTTPException) as error:
        library.safe_filename(name)
    assert error.value.status_code == 400


@pytest.mark.parametrize("name", ["paper.pdf", "notes.md", "README.markdown", "log.txt"])
def test_accepts_supported_source_types(name: str) -> None:
    assert library.safe_filename(name) == name


@pytest.mark.parametrize("identifier", [0, -1, 2**63, True, "../../etc"])
def test_document_path_requires_positive_bigint(identifier: Any, storage: Path) -> None:
    with pytest.raises(HTTPException):
        library.document_directory(identifier)


def test_source_file_uses_id_not_filename_and_rejects_symlinks(storage: Path) -> None:
    folder = library.document_directory(123)
    folder.mkdir(parents=True)
    source = folder / "source.pdf"
    source.write_bytes(_pdf())
    assert library.source_pdf(123) == source
    outside = storage / "outside.pdf"
    outside.write_bytes(b"private")
    source.unlink()
    source.symlink_to(outside)
    with pytest.raises(HTTPException):
        library.source_pdf(123)
    other = storage / "documents" / "124"
    other.symlink_to(folder, target_is_directory=True)
    with pytest.raises(HTTPException):
        library.document_directory(124)
    assert outside.read_bytes() == b"private"


def test_validates_pdf_readability_and_page_count(tmp_path: Path) -> None:
    path = tmp_path / "source.pdf"
    path.write_bytes(_pdf())
    assert library.validate_pdf(path) == 1


@pytest.mark.parametrize("content", [b"", b"not a pdf", b"%PDF-1.7\nnot a valid page tree"])
def test_rejects_spoofed_or_damaged_pdf(content: bytes, tmp_path: Path) -> None:
    path = tmp_path / "source.pdf"
    path.write_bytes(content)
    with pytest.raises(HTTPException) as error:
        library.validate_pdf(path)
    assert error.value.status_code == 400


def test_rejects_encrypted_pdf(tmp_path: Path) -> None:
    path = tmp_path / "encrypted.pdf"
    path.write_bytes(_pdf(encrypted=True))
    with pytest.raises(HTTPException) as error:
        library.validate_pdf(path)
    assert error.value.status_code == 400
    assert "加密" in error.value.detail


def test_rejects_owner_only_encryption_without_open_password(tmp_path: Path) -> None:
    path = tmp_path / "owner-encrypted.pdf"
    with pymupdf.open() as pdf:
        pdf.new_page()
        pdf.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner-only", user_pw="")
    with pytest.raises(HTTPException) as error:
        library.validate_pdf(path)
    assert error.value.status_code == 400
    assert "加密" in error.value.detail


def test_rejects_empty_page_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    path = tmp_path / "source.pdf"
    path.write_bytes(b"%PDF-1.7\n")
    pdf = MagicMock()
    pdf.is_encrypted = False
    pdf.needs_pass = False
    pdf.metadata = {}
    pdf.is_pdf = True
    pdf.page_count = 0
    pdf.__enter__.return_value = pdf
    monkeypatch.setattr(library.pymupdf, "open", lambda *_: pdf)
    with pytest.raises(HTTPException) as error:
        library.validate_pdf(path)
    assert "页面" in error.value.detail


def test_hard_fifty_megabyte_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "max_upload_mb", 100)
    path = tmp_path / "large.pdf"
    with path.open("wb") as handle:
        handle.write(b"%PDF-")
        handle.truncate(50 * 1024 * 1024 + 1)
    with pytest.raises(HTTPException) as error:
        library.validate_pdf(path)
    assert error.value.status_code == 413


async def test_upload_persists_pdf_and_enqueues_parse(storage: Path) -> None:
    db, added = _db([_kb(), None, None])
    content = _pdf()
    upload = _upload(content, "../../original.pdf")
    response = await library.upload_documents(11, [upload], db, ADMIN)
    document = next(row for row in added if isinstance(row, Document))
    job = next(row for row in added if isinstance(row, Job))
    assert document.filename == "original.pdf"
    assert library.source_pdf(document.id).read_bytes() == content
    assert document.page_count == 1
    assert job.job_type == "parse" and job.resource_id == document.id
    assert job.tenant_id == settings.tenant_id
    assert response[0]["id"] == str(document.id)
    assert response[0]["status"] == "queued"
    assert "file_sha256" not in response[0] and "markdown" not in response[0]
    assert upload.file.closed
    db.commit.assert_awaited_once()
    assert "FOR UPDATE" in _sql(db.scalar.call_args_list[0].args[0])
    for call in db.scalar.call_args_list:
        assert "tenant_id" in _sql(call.args[0])


async def test_duplicate_upload_does_not_delete_existing_pdf(storage: Path) -> None:
    previous = library.document_directory(21)
    previous.mkdir(parents=True)
    existing = previous / "source.pdf"
    existing.write_bytes(b"never delete this existing file")
    db, _ = _db([_kb(), None, _document()])
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(_pdf())], db, ADMIN)
    assert error.value.status_code == 409
    assert existing.read_bytes() == b"never delete this existing file"
    assert list((storage / "documents").iterdir()) == [previous]
    db.rollback.assert_awaited_once()
    db.commit.assert_not_awaited()


async def test_duplicate_within_batch_rolls_back_all_files(storage: Path) -> None:
    db, _ = _db([_kb(), None, None])
    content = _pdf()
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(content), _upload(content, "other.pdf")], db, ADMIN)
    assert error.value.status_code == 409
    assert not list((storage / "documents").iterdir())
    db.commit.assert_not_awaited()
    db.rollback.assert_awaited_once()


async def test_bad_second_file_cleans_the_entire_batch(storage: Path) -> None:
    db, _ = _db([_kb(), None, None])
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(_pdf()), _upload(b"invalid", "second.pdf")], db, ADMIN)
    assert error.value.status_code == 400
    assert not list((storage / "documents").iterdir())
    db.commit.assert_not_awaited()


async def test_upload_cleanup_on_database_commit_failure(storage: Path) -> None:
    db, _ = _db([_kb(), None, None])
    db.commit.side_effect = RuntimeError("secret-db-connection")
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(_pdf())], db, ADMIN)
    assert error.value.status_code == 500
    assert "secret" not in error.value.detail
    assert not list((storage / "documents").iterdir())
    db.rollback.assert_awaited_once()


async def test_streaming_upload_size_guard(storage: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "max_upload_mb", 1)
    db, _ = _db([_kb(), None])
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(b"%PDF-" + b"x" * (1024 * 1024))], db, ADMIN)
    assert error.value.status_code == 413
    assert not list((storage / "documents").iterdir())


@pytest.mark.parametrize("count", [0, 11])
async def test_upload_batch_size_guard(count: int, storage: Path) -> None:
    db, _ = _db()
    files = [_upload(b"unused") for _ in range(count)]
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, files, db, ADMIN)
    assert error.value.status_code == 400
    db.scalar.assert_not_awaited()
    assert all(upload.file.closed for upload in files)
    assert not (storage / "documents").exists()


@pytest.mark.parametrize("status", ["queued", "running", "paused"])
async def test_active_experiment_blocks_upload_before_writing(status: str, storage: Path) -> None:
    run = EvalRun(id=71, knowledge_base_id=11, status=status)
    db, _ = _db([_kb(), run])
    with pytest.raises(HTTPException) as error:
        await library.upload_documents(11, [_upload(_pdf())], db, ADMIN)
    assert error.value.status_code == 409
    assert not (storage / "documents").exists()
    statement = _sql(db.scalar.call_args_list[1].args[0])
    assert "tenant_id" in statement and "knowledge_base_id = 11" in statement
    assert all(value in statement for value in ("queued", "running", "paused"))


async def test_parsed_document_hides_queued_chunks() -> None:
    db, _ = _db([_document(status="queued"), _kb()])
    assert await library.get_parsed_document(21, db, ADMIN) == {"markdown": "", "chunks": []}
    db.scalars.assert_not_awaited()


async def test_parsed_chunks_are_document_kb_and_tenant_scoped() -> None:
    db, _ = _db([_document(), _kb()])
    db.scalars.return_value.all.return_value = []
    assert await library.get_parsed_document(21, db, ADMIN) == {"markdown": "Parsed document", "chunks": []}
    statement = _sql(db.scalars.call_args.args[0])
    assert "chunks.tenant_id" in statement
    assert "chunks.document_id = 21" in statement
    assert "chunks.knowledge_base_id = 11" in statement


async def test_foreign_document_is_404_before_filesystem_access(monkeypatch: pytest.MonkeyPatch) -> None:
    db, _ = _db([None])
    source = MagicMock()
    monkeypatch.setattr(library, "source_pdf", source)
    with pytest.raises(HTTPException) as error:
        await library.get_document_file(21, db, ADMIN)
    assert error.value.status_code == 404
    source.assert_not_called()


async def test_retry_locks_and_rechecks_document_before_enqueuing(storage: Path) -> None:
    failed = _document(status="failed")
    folder = library.document_directory(failed.id)
    folder.mkdir(parents=True)
    (folder / "source.pdf").write_bytes(_pdf())
    db, added = _db([failed, _kb(), None, failed, None])
    result = await library.retry_document(failed.id, db, ADMIN)
    assert result["status"] == "queued"
    assert result["error"] is None
    job = next(row for row in added if isinstance(row, Job))
    assert job.job_type == "parse" and job.resource_id == failed.id
    assert "FOR UPDATE" in _sql(db.scalar.call_args_list[1].args[0])
    assert "FOR UPDATE" in _sql(db.scalar.call_args_list[3].args[0])
    assert "tenant_id" in _sql(db.scalar.call_args_list[3].args[0])


async def test_retry_rejects_active_experiment() -> None:
    db, added = _db([_document(status="failed"), _kb(), EvalRun(status="paused")])
    with pytest.raises(HTTPException) as error:
        await library.retry_document(21, db, ADMIN)
    assert error.value.status_code == 409
    assert not added


async def test_retry_rejects_duplicate_pending_job() -> None:
    failed = _document(status="failed")
    db, added = _db([failed, _kb(), None, failed, Job(status="queued")])
    with pytest.raises(HTTPException) as error:
        await library.retry_document(21, db, ADMIN)
    assert error.value.status_code == 409 and not added


@pytest.mark.parametrize("model,payload", [
    (KBCreate, {"name": "   "}),
    (KBCreate, {"name": "test", "chunk_size": 200, "chunk_overlap": 200}),
    (KBCreate, {"name": "test", "tenant_id": 123}),
    (MessageCreate, {"content": "   "}),
    (MessageCreate, {"content": "hi", "method": "unknown"}),
    (MessageCreate, {"content": "hi", "top_k": 20, "candidate_k": 5}),
    (MessageCreate, {"content": "hi", "candidate_k": 101}),
    (DebugRequest, {"knowledge_base_id": 1, "question": "hi", "methods": []}),
    (DebugRequest, {"knowledge_base_id": 1, "question": "hi", "methods": ["bm25", "bm25"]}),
    (DebugRequest, {"knowledge_base_id": 1, "question": "hi", "methods": ["bm25"], "tenant_id": 2}),
    (ConversationCreate, {"knowledge_base_id": -1}),
])
def test_request_schemas_reject_invalid_inputs(model: Any, payload: dict[str, Any]) -> None:
    with pytest.raises(ValidationError):
        model.model_validate(payload)


async def test_chat_rejects_pending_assistant_before_persisting() -> None:
    db, added = _db([_conversation(), _kb(), Message(status="queued")])
    with pytest.raises(HTTPException) as error:
        await chat.create_message(31, MessageCreate(content="question"), db, ADMIN)
    assert error.value.status_code == 409 and not added
    assert "FOR UPDATE" in _sql(db.scalar.call_args_list[0].args[0])
    assert "messages.tenant_id" in _sql(db.scalar.call_args_list[2].args[0])


async def test_chat_requires_ready_knowledge_base_for_retrieval() -> None:
    db, added = _db([_conversation(), _kb(), None, None])
    with pytest.raises(HTTPException) as error:
        await chat.create_message(31, MessageCreate(content="question", method="bm25"), db, ADMIN)
    assert error.value.status_code == 409 and not added


SNAPSHOT = {"id": 7, "name": "Default", "model": "chat-model", "protocol": "openai_chat",
            "base_url": "https://models.test/v1", "max_tokens": 4096, "timeout_seconds": 120, "json_mode": True,
            "api_key_ciphertext": "encrypted"}


async def test_no_context_chat_persists_user_assistant_and_exact_job_parameters(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(chat, "get_chat_snapshot", AsyncMock(return_value=dict(SNAPSHOT)))
    conversation = _conversation()
    db, added = _db([conversation, _kb(), None, None])
    question = "This is the first question " * 5
    response = await chat.create_message(31, MessageCreate(content=question, method="no_context"), db, ADMIN)
    user, assistant, job = added
    assert isinstance(user, Message) and user.role == "user"
    assert isinstance(assistant, Message) and assistant.role == "assistant"
    assert isinstance(job, Job) and job.job_type == "chat"
    assert response["id"] == str(assistant.id) and response["status"] == "queued"
    assert conversation.title == question[:48]
    assert job.resource_id == assistant.id
    assert job.params == {"question": question.strip(), "method": "no_context", "top_k": 5, "candidate_k": 20,
                          "model_config": SNAPSHOT, "retrieval": None,
                          "principal": {"id": 1, "username": "admin", "role": "admin"}, "kb_scope": "platform"}
    assert assistant.model_profile_id == 7 and "api_key_ciphertext" not in assistant.model_snapshot
    assert all(row.tenant_id == settings.tenant_id for row in added)
    db.commit.assert_not_awaited()  # get_db owns the transaction including the job.


async def test_debug_runs_methods_sequentially_and_reports_errors_separately(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import rag

    calls = []

    async def answer_question(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        if kwargs["method"] == "vector":
            raise RuntimeError("secret-provider-token")
        return {"method": kwargs["method"], "answer": "the answer", "citations": [], "contexts": [],
                "abstain": False, "timing": {}, "usage": {}}

    monkeypatch.setattr(rag, "answer_question", answer_question)
    monkeypatch.setattr(chat, "_debug_semaphore", asyncio.Semaphore(2))
    monkeypatch.setattr(chat, "resolve_settings", AsyncMock(return_value=settings))
    db, _ = _db([_kb()])
    request = DebugRequest(knowledge_base_id=11, question="question", methods=["bm25", "vector", "no_context"],
                           reference_answer="the answer")
    result = await chat.debug_question(request, db, ADMIN)
    assert [call["method"] for call in calls] == request.methods
    assert all(set(call) == {"knowledge_base_id", "question", "method", "top_k", "candidate_k", "retrieval_only",
                             "runtime_settings", "retrieval"} for call in calls)
    assert all(call["runtime_settings"] is settings and call["retrieval"] is None for call in calls)
    assert result["results"][0]["metrics"]["token_f1"] == 1
    assert "error" in result["results"][1]
    assert "secret-provider-token" not in json.dumps(result)
    assert result["results"][2]["answer"] == "the answer"
    db.rollback.assert_awaited_once()


async def test_debug_retrieval_only_has_no_answer_metrics(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import rag

    answer = AsyncMock(return_value={"method": "bm25", "answer": "", "contexts": []})
    monkeypatch.setattr(rag, "answer_question", answer)
    monkeypatch.setattr(chat, "resolve_settings", AsyncMock(return_value=settings))
    db, _ = _db([_kb()])
    result = await chat.debug_question(DebugRequest(knowledge_base_id=11, question="q", methods=["bm25"],
                                                   retrieval_only=True, reference_answer="gold"), db, ADMIN)
    assert "metrics" not in result["results"][0]
    assert answer.call_args.kwargs["retrieval_only"] is True


async def test_debug_known_provider_error_is_safe_and_unknown_http_detail_is_hidden(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import rag

    monkeypatch.setattr(rag, "answer_question", AsyncMock(side_effect=[
        ProviderError("模型额度不足"), HTTPException(500, "secret-body"),
    ]))
    monkeypatch.setattr(chat, "resolve_settings", AsyncMock(return_value=settings))
    db, _ = _db([_kb()])
    result = await chat.debug_question(DebugRequest(knowledge_base_id=11, question="q",
                                                   methods=["bm25", "vector"]), db, ADMIN)
    assert "模型额度不足" in result["results"][0]["error"]
    assert "secret-body" not in json.dumps(result)


async def test_debug_limits_concurrent_clients_to_two(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.services import rag

    gate = asyncio.Event()
    both_entered = asyncio.Event()
    entered = 0

    async def answer_question(**kwargs: Any) -> dict[str, Any]:
        nonlocal entered
        entered += 1
        if entered == 2:
            both_entered.set()
        await gate.wait()
        return {"method": kwargs["method"], "answer": "done"}

    monkeypatch.setattr(rag, "answer_question", answer_question)
    monkeypatch.setattr(chat, "_debug_semaphore", asyncio.Semaphore(2))
    monkeypatch.setattr(chat, "resolve_settings", AsyncMock(return_value=settings))
    request = DebugRequest(knowledge_base_id=11, question="q", methods=["no_context"])
    tasks = [asyncio.create_task(chat.debug_question(request, _db([_kb()])[0], ADMIN)) for _ in range(2)]
    try:
        await asyncio.wait_for(both_entered.wait(), timeout=2)
        with pytest.raises(HTTPException) as error:
            await chat.debug_question(request, _db([_kb()])[0], ADMIN)
        assert error.value.status_code == 429
        assert entered == 2
    finally:
        gate.set()
        await asyncio.gather(*tasks)


@pytest.mark.parametrize("url,expected", [
    ("https://user:password@models.test/v1?api_key=secret#private", "https://models.test/v1"),
    ("http://[::1]:8000/", "http://[::1]:8000"),
    ("not-a-url", ""), ("file:///etc/passwd", ""),
    ("http://models.test:invalid/v1", ""), ("https://models.test/v1\n", ""),
])
def test_model_urls_are_sanitized(url: str, expected: str) -> None:
    assert system.safe_base_url(url) == expected


async def test_settings_never_exposes_keys_passwords_or_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    from app.api import service_settings

    runtime = settings.model_copy(update={
        "chat_api_key": "secret-chat-key", "embedding_api_key": "secret-embedding-key",
        "rerank_api_key": "secret-rerank-key",
        "chat_base_url": "https://user:secret-pass@models.test/v1?token=private",
    })
    monkeypatch.setattr(service_settings, "resolve_settings", AsyncMock(return_value=runtime))
    monkeypatch.setattr(service_settings, "get_chat_snapshot", AsyncMock(return_value=dict(SNAPSHOT)))
    response = await service_settings.get_settings(_db()[0])
    encoded = json.dumps(response)
    assert "secret" not in encoded and "private" not in encoded
    assert "database_url" not in encoded and settings.database_url not in encoded
    assert response["chat"]["configured"] is True
    assert response["chat"]["base_url"] == "https://models.test/v1"
    assert response["storage"] == {"backend": "PostgreSQL + Milvus", "local_only": True}
    assert response["config_file"] == "backend/.env"


async def test_health_actually_executes_select_one_and_sanitizes_failures() -> None:
    db, _ = _db()
    response = Response()
    assert await system.health(response, db) == {"status": "ok", "database": "connected"}
    assert str(db.execute.call_args.args[0]) == "SELECT 1"
    db.execute.side_effect = RuntimeError("postgresql://secret:password@host/db")
    assert await system.health(response, db) == {"status": "degraded", "database": "unavailable"}
    assert response.status_code == 503
    db.rollback.assert_awaited_once()


async def test_settings_check_makes_no_model_probes(monkeypatch: pytest.MonkeyPatch) -> None:
    requests: list[httpx.Request] = []
    original_client = httpx.AsyncClient

    def respond(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json={"status": "ok", "private": "never return this body"})

    monkeypatch.setattr(system.httpx, "AsyncClient", lambda **kwargs: original_client(
        transport=httpx.MockTransport(respond), **kwargs,
    ))
    monkeypatch.setattr(system, "_milvus_version", lambda config=None: None)
    monkeypatch.setattr(system, "resolve_settings", AsyncMock(
        return_value=settings.model_copy(update={"mineru_base_url": "http://mineru.test"})))
    db, _ = _db()
    result = await system.check_settings(db)
    assert [(request.method, str(request.url)) for request in requests] == [("GET", "http://mineru.test/health")]
    assert len(result["checks"]) == 6
    assert "never return this body" not in json.dumps(result)
    assert all(check["status"] in {"configured", "not_configured"} for check in result["checks"][3:])


async def test_milvus_probe_is_read_only(monkeypatch: pytest.MonkeyPatch) -> None:
    import pymilvus

    client = MagicMock()
    constructor = MagicMock(return_value=client)
    monkeypatch.setattr(pymilvus, "MilvusClient", constructor)
    system._milvus_version()
    client.get_server_version.assert_called_once_with(timeout=5)
    client.close.assert_called_once()
    assert [call[0] for call in client.mock_calls] == ["get_server_version", "close"]


@pytest.mark.parametrize("name", ["../attention.pdf", "ATTENTION.pdf", "other.pdf", "", "/etc/passwd"])
def test_example_downloads_require_allowlisted_names(name: str) -> None:
    with pytest.raises(HTTPException) as error:
        system.example_pdf(name)
    assert error.value.status_code == 404


async def test_examples_list_only_installed_allowlisted_regular_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(system, "ROOT", tmp_path)
    root = tmp_path / "examples" / "pdfs"
    root.mkdir(parents=True)
    (root / "attention.pdf").write_bytes(_pdf())
    (root / "unlisted.pdf").write_bytes(_pdf())
    (root / "rag.pdf").symlink_to(root / "unlisted.pdf")
    assert await system.list_examples() == [{"name": "attention.pdf", "url": "/api/examples/attention.pdf"}]
    with pytest.raises(HTTPException):
        system.example_pdf("rag.pdf")


def test_failure_logs_do_not_render_exception_text_or_locals() -> None:
    logs: list[str] = []
    handler = logger.add(logs.append, diagnose=True)
    try:
        try:
            raise RuntimeError("secret-log-token")
        except RuntimeError as error:
            library._log_failure("offline_test", error, 1)
            chat._log_failure("offline_test", error, 1)
            system._log_failure("offline_test", error)
    finally:
        logger.remove(handler)
    combined = "".join(logs)
    assert "secret-log-token" not in combined
    assert "offline_test" in combined
    assert "test_failure_logs" in combined


def test_router_input_validation_never_calls_database() -> None:
    app = FastAPI()
    app.include_router(library.router, prefix="/api")
    app.include_router(chat.router, prefix="/api")
    db, _ = _db()

    async def offline_db() -> AsyncIterator[MagicMock]:
        yield db

    app.dependency_overrides[get_db] = offline_db
    app.dependency_overrides[current_principal] = lambda: ADMIN
    with TestClient(app) as client:
        for identifier in ("-1", "0", str(2**63), "abc"):
            assert client.get(f"/api/documents/{identifier}").status_code == 422
        assert client.post("/api/knowledge-bases", json={"name": "Test", "tenant_id": 4}).status_code == 422
        assert client.post("/api/debug", json={"knowledge_base_id": "1", "question": "q",
                                               "methods": ["bm25", "bm25"]}).status_code == 422
    db.scalar.assert_not_awaited()
