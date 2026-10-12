"""End-to-end MCP flow on real PostgreSQL + Milvus with deterministic fake model calls.

RAG_E2E_TEST=1 .venv/bin/python -m pytest -q tests/test_mcp_e2e.py
Uses a fresh tenant, a throwaway rag_workbench_e2e_* Milvus collection and a temporary data
directory; all are removed afterwards. No paid model request is made.
"""
import hashlib
import json
import os
import secrets
from typing import Any

import pytest
from mcp import Client
from pymilvus import MilvusClient
from sqlalchemy import delete, select

from app import mcp_server, models
from app.config import settings
from app.db import Session, engine, generate_id
from app.mcp_server import mcp
from app.services import providers as provider_module
from app.services.auth import Principal, hash_password, principal_of
from app.services.configuration import bootstrap_configuration
from app.services.ingestion import ingest_document
from app.services.ranking import tokenize
from app.services.tuning import execute_tuning

pytestmark = pytest.mark.skipif(os.getenv("RAG_E2E_TEST") != "1", reason="Opt-in PostgreSQL + Milvus test")
DIMENSIONS = 64

DOC_A = """# Retrieval augmented generation

RAG combines a retriever with a generator. The retriever recalls passages from a corpus and the
generator writes an answer grounded in those passages."""
DOC_B = """# LoRA

Low-rank adaptation freezes pretrained weights and trains small rank decomposition matrices,
which reduces trainable parameters for fine tuning."""
DOC_A2 = """# Retrieval augmented generation (v2)

Hybrid retrieval fuses BM25 and dense vectors with reciprocal rank fusion before reranking."""


def vector(text: str) -> list[float]:
    values = [0.0] * DIMENSIONS
    for token in tokenize(text):
        values[int(hashlib.md5(token.encode()).hexdigest(), 16) % DIMENSIONS] += 1.0
    values[0] += 0.01  # never an all-zero vector
    return values


@pytest.fixture
async def workspace(monkeypatch: pytest.MonkeyPatch, tmp_path):
    tenant_id = generate_id()
    collection = "rag_workbench_e2e_" + secrets.token_hex(4)
    await engine.dispose()
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "milvus_collection", collection)
    monkeypatch.setattr(settings, "embedding_dimensions", DIMENSIONS)
    calls: dict[str, Any] = {"embed": 0, "rerank": 0, "answer": 0, "merge": 0}

    async def embed(self, texts):
        calls["embed"] += 1
        return [vector(t) for t in texts], {"total_tokens": len(texts)}

    async def rerank(self, question, rows):
        calls["rerank"] += 1
        wanted = set(tokenize(question))
        scored = [{**r, "score": len(wanted & set(tokenize(r["text"]))) / (len(wanted) or 1)} for r in rows]
        return sorted(scored, key=lambda r: r["score"], reverse=True)

    async def answer(self, question, contexts, method="hybrid_rerank", history=None):
        calls["answer"] += 1
        return {"answer": "grounded answer", "citations": [contexts[0]["id"]],
                "abstain": False, "usage": {}, "latency_ms": 1}

    async def merge(self, notes):
        calls["merge"] += 1
        return " + ".join(notes)

    monkeypatch.setattr(provider_module.Providers, "embed", embed)
    monkeypatch.setattr(provider_module.Providers, "rerank", rerank)
    monkeypatch.setattr(provider_module.Providers, "answer", answer)
    monkeypatch.setattr(provider_module.Providers, "merge_memories", merge)
    async with Session() as db:
        await bootstrap_configuration(db)
        users = {}
        for username, role in (("e2e-admin", "admin"), ("e2e-alice", "employee"), ("e2e-bob", "employee")):
            user = models.User(tenant_id=tenant_id, username=username, display_name=username, role=role,
                               password_hash=hash_password("unused-password-123"), must_change_password=False)
            db.add(user)
            await db.flush()
            users[username.removeprefix("e2e-")] = principal_of(user, via="token")
        await db.commit()
    calls["users"] = users
    yield calls
    async with Session() as db, db.begin():
        for model in (models.KnowledgeBase, models.Document, models.Chunk, models.Job, models.Dataset,
                      models.Question, models.TuningRun, models.Memory, models.MemoryEvent,
                      models.ModelProfile, models.ServiceConfiguration, models.User, models.QueryLog,
                      models.McpCallLog):
            await db.execute(delete(model).where(model.tenant_id == tenant_id))
    await engine.dispose()
    client = MilvusClient(uri=settings.milvus_uri)
    if client.has_collection(collection):
        client.drop_collection(collection)
    client.close()


async def call(client: Client, tool: str, **arguments: Any) -> dict[str, Any]:
    result = await client.call_tool(tool, arguments)
    text = "".join(getattr(block, "text", "") for block in result.content)
    if result.is_error:
        raise AssertionError(f"{tool} failed: {text}")
    return result.structured_content if result.structured_content is not None else json.loads(text)


async def call_error(client: Client, tool: str, **arguments: Any) -> str:
    result = await client.call_tool(tool, arguments)
    assert result.is_error, f"{tool} unexpectedly succeeded"
    return "".join(getattr(block, "text", "") for block in result.content)


def act_as(monkeypatch: pytest.MonkeyPatch, principal: Principal) -> None:
    """In-process clients have no HTTP request: the stdio account is the caller."""
    monkeypatch.setattr(mcp_server, "_stdio_principal", principal)


async def test_agent_flow_documents_retrieval_memory_and_tuning(workspace, monkeypatch) -> None:
    calls, users = workspace, workspace["users"]
    act_as(monkeypatch, users["admin"])
    async with Client(mcp) as client:
        names = {tool.name for tool in (await client.list_tools()).tools}
        assert {"rag_search", "document_upload", "memory_merge", "tuning_start", "review_decide"} <= names
        assert (await call(client, "whoami"))["role"] == "admin"

        kb = await call(client, "kb_create", name="e2e", scope="platform", chunk_size=400, chunk_overlap=50)
        kb_id = kb["id"]
        assert kb["scope"] == "platform" and kb["can_manage"] is True
        doc_a = await call(client, "document_upload", knowledge_base_id=kb_id, filename="rag.md", content=DOC_A)
        doc_b = await call(client, "document_upload", knowledge_base_id=kb_id, filename="lora.txt", content=DOC_B)
        assert (doc_a["source_type"], doc_b["source_type"]) == ("markdown", "text")
        assert doc_a["review_status"] == "approved" and doc_a["status"] == "queued"
        assert "已存在" in await call_error(client, "document_upload", knowledge_base_id=kb_id,
                                            filename="copy.md", content=DOC_A)
        for document in (doc_a, doc_b):
            await ingest_document(int(document["id"]))
        assert (await call(client, "document_get", document_id=doc_a["id"], include_text=True))["status"] == "ready"

        found = await call(client, "rag_search", knowledge_base_id=kb_id, query="retriever generator passages")
        assert found["results"][0]["document_id"] == doc_a["id"]
        stages = [entry["stage"] for entry in found["trace"]]
        assert stages == ["scope", "recall.vector", "recall.bm25", "fusion", "rerank", "postprocess"]
        scoped = await call(client, "rag_search", knowledge_base_id=kb_id, query="retriever generator",
                            document_ids=[doc_b["id"]], method="hybrid")
        assert {hit["document_id"] for hit in scoped["results"]} == {doc_b["id"]}

        updated = await call(client, "document_update", document_id=doc_a["id"], content=DOC_A2)
        assert updated["replaces_document_id"] == doc_a["id"]
        still_old = await call(client, "rag_search", knowledge_base_id=kb_id, query="retriever generator passages")
        assert still_old["results"][0]["document_id"] == doc_a["id"]  # old version serves until the new is ready
        await ingest_document(int(updated["id"]))
        documents = await call(client, "document_list", knowledge_base_id=kb_id)
        assert {d["id"] for d in documents["documents"]} == {updated["id"], doc_b["id"]}
        fused = await call(client, "rag_search", knowledge_base_id=kb_id, query="reciprocal rank fusion BM25",
                           method="vector")
        assert fused["results"][0]["document_id"] == updated["id"]
        assert doc_a["id"] not in {hit["document_id"] for hit in fused["results"]}

        await call(client, "document_delete", document_id=doc_b["id"])
        after = await call(client, "rag_search", knowledge_base_id=kb_id, query="low rank adaptation", method="vector")
        assert {hit["document_id"] for hit in after["results"]} == {updated["id"]}

        # Personal memory of the administrator: add, dedupe, search, versioned update, merge, history.
        first = await call(client, "memory_add", content="Prefers answers in Chinese", category="preference",
                           tags=["lang"])
        second = await call(client, "memory_add", content="Works on hybrid retrieval research", category="profile",
                            importance=4)
        assert first["memory"]["user_id"] == f"user:{users['admin'].id}"
        assert (await call(client, "memory_add", content="prefers answers in chinese"))["action"] == "duplicate"
        searched = await call(client, "memory_search", query="hybrid retrieval")
        assert searched["results"][0]["id"] == second["memory"]["id"]
        updated_memory = await call(client, "memory_update", memory_id=first["memory"]["id"],
                                    content="Prefers concise answers in Chinese", expected_version=1)
        assert updated_memory["version"] == 2
        assert "已被修改" in await call_error(client, "memory_update", memory_id=first["memory"]["id"],
                                              content="x", expected_version=1)
        merged = await call(client, "memory_merge", memory_ids=[first["memory"]["id"], second["memory"]["id"]])
        assert calls["merge"] == 1 and merged["memory"]["importance"] == 4
        history = await call(client, "memory_history", memory_id=first["memory"]["id"])
        assert [e["action"] for e in history["events"]] == ["create", "update", "merge"]
        # A second personal memory: there is no shared "platform" namespace any more.
        standing = await call(client, "memory_add", content="Always cite page numbers", category="instruction")
        assert standing["memory"]["status"] == "active"
        assert standing["memory"]["user_id"] == f"user:{users['admin'].id}"
        # Agents still sending the retired scope argument are served from their own namespace.
        legacy = await call(client, "memory_add", scope="platform", content="Legacy scope argument is ignored")
        assert legacy["memory"]["user_id"] == f"user:{users['admin'].id}"

        answered = await call(client, "rag_answer", knowledge_base_id=kb_id,
                              question="What does hybrid retrieval fuse?")
        # RAG answers never consult memories; those are only for the memory tools.
        assert answered["answer"] == "grounded answer" and answered["citations"]
        assert "memories_used" not in answered

        async with Session() as db, db.begin():
            dataset = models.Dataset(tenant_id=settings.tenant_id, name="e2e", description="")
            db.add(dataset)
            await db.flush()
            db.add(models.Question(tenant_id=settings.tenant_id, dataset_id=dataset.id, review_status="reviewed",
                                   question="What does hybrid retrieval fuse?", reference_answer="BM25 and vectors",
                                   answerable=True, evidence=[{"document_id": updated["id"], "page": 1,
                                                               "quote": "fuses BM25 and dense vectors"}]))
            dataset_id = str(dataset.id)
        run = await call(client, "tuning_start", knowledge_base_id=kb_id, dataset_id=dataset_id,
                         grid={"rerank": [True, False]}, objective="mrr_at_10")
        assert run["total"] == 2 and run["question_count"] == 1
        await execute_tuning(int(run["id"]))
        status = await call(client, "tuning_status", run_id=run["id"])
        assert status["status"] == "completed" and status["completed"] == 2
        assert status["best"]["mrr_at_10"] == 1.0
        applied = await call(client, "tuning_apply", run_id=run["id"], candidate=status["best"]["name"])
        assert applied["retrieval_config"]["rerank"] in (True, False)
        auto = await call(client, "rag_search", knowledge_base_id=kb_id, query="BM25", method="auto")
        assert auto["retrieval_config"]["rerank"] == applied["retrieval_config"]["rerank"]

        assert "confirm" in await call_error(client, "memory_clear", confirm=False)
        cleared = await call(client, "memory_clear", confirm=True)
        assert cleared["deleted"] == 3
        assert "must be a positive decimal" in await call_error(client, "document_get", document_id="abc")


async def test_employee_permissions_reviews_and_audit_logs(workspace, monkeypatch) -> None:
    users = workspace["users"]
    admin, alice, bob = users["admin"], users["alice"], users["bob"]
    async with Client(mcp) as client:
        act_as(monkeypatch, admin)
        platform_kb = (await call(client, "kb_create", name="handbook", scope="platform"))["id"]
        approved = await call(client, "document_upload", knowledge_base_id=platform_kb, filename="rag.md",
                              content=DOC_A)
        await ingest_document(int(approved["id"]))

        act_as(monkeypatch, alice)
        assert "管理员" in await call_error(client, "kb_create", name="nope", scope="platform")
        assert "仅限管理员" in await call_error(client, "tuning_status", run_id="1")
        assert "仅限管理员" in await call_error(client, "review_list")
        personal_kb = (await call(client, "kb_create", name="alice notes"))["id"]
        listed = {kb["id"]: kb for kb in (await call(client, "kb_list"))["knowledge_bases"]}
        assert listed[platform_kb]["can_manage"] is False and listed[personal_kb]["can_manage"] is True

        # Employee upload into a platform library waits for approval and is not parsed.
        pending = await call(client, "document_upload", knowledge_base_id=platform_kb, filename="lora.txt",
                             content=DOC_B)
        assert pending["review_status"] == "pending" and pending["status"] == "pending_review"
        assert "管理员" in await call_error(client, "document_delete", document_id=approved["id"])
        assert "管理员" in await call_error(client, "document_update", document_id=approved["id"], content=DOC_A2)
        assert pending["id"] in {d["id"] for d in (await call(client, "document_list",
                                                                knowledge_base_id=platform_kb))["documents"]}
        hits = await call(client, "rag_search", knowledge_base_id=platform_kb, query="retriever generator passages")
        assert hits["results"][0]["document_id"] == approved["id"]

        # Personal content of an employee is private, also to administrators.
        own = await call(client, "document_upload", knowledge_base_id=personal_kb, filename="notes.md",
                         content=DOC_A2)
        assert own["review_status"] == "approved"
        await ingest_document(int(own["id"]))
        await call(client, "rag_search", knowledge_base_id=personal_kb, query="secret personal question")
        mine = await call(client, "memory_add", content="Alice prefers short answers", category="preference")
        assert mine["memory"]["user_id"] == f"user:{alice.id}"

        act_as(monkeypatch, bob)
        assert pending["id"] not in {d["id"] for d in (await call(client, "document_list",
                                                                    knowledge_base_id=platform_kb))["documents"]}
        assert "资源不存在" in await call_error(client, "document_get", document_id=pending["id"])
        assert personal_kb not in {kb["id"] for kb in (await call(client, "kb_list"))["knowledge_bases"]}
        assert "资源不存在" in await call_error(client, "rag_search", knowledge_base_id=personal_kb, query="x")
        assert (await call(client, "memory_list"))["total"] == 0
        assert (await call(client, "memory_search", query="short answers"))["results"] == []
        assert "记忆不存在" in await call_error(client, "memory_get", memory_id=mine["memory"]["id"])
        assert "记忆不存在" in await call_error(client, "memory_delete", memory_ids=[mine["memory"]["id"]])

        act_as(monkeypatch, admin)
        assert personal_kb not in {kb["id"] for kb in (await call(client, "kb_list"))["knowledge_bases"]}
        assert "资源不存在" in await call_error(client, "document_list", knowledge_base_id=personal_kb)
        reviews = await call(client, "review_list")
        assert [d["id"] for d in reviews["documents"]] == [pending["id"]]
        assert reviews["documents"][0]["uploader"] == alice.username
        assert set(reviews) == {"documents"}
        decided = await call(client, "review_decide", kind="document", id=pending["id"], approve=True)
        assert decided["review_status"] == "approved" and decided["status"] == "queued"
        await ingest_document(int(pending["id"]))

        act_as(monkeypatch, bob)
        lora = await call(client, "rag_search", knowledge_base_id=platform_kb, query="low rank adaptation",
                          method="vector")
        assert lora["results"][0]["document_id"] == pending["id"]
        assert (await call(client, "memory_list"))["total"] == 0  # alice's memories stay hers
        act_as(monkeypatch, alice)
        assert [m["content"] for m in (await call(client, "memory_list"))["items"]] == [
            "Alice prefers short answers"]

    async with Session() as db:
        queries = (await db.scalars(select(models.QueryLog).where(models.QueryLog.tenant_id == settings.tenant_id)
                                    .order_by(models.QueryLog.id))).all()
        mcp_calls = (await db.scalars(select(models.McpCallLog).where(
            models.McpCallLog.tenant_id == settings.tenant_id))).all()
    personal = [row for row in queries if row.knowledge_base_id == int(personal_kb)]
    assert personal and all(row.query is None and row.kb_scope == "personal" for row in personal)
    assert personal[0].query_chars == len("secret personal question") and personal[0].username == alice.username
    platform = [row for row in queries if row.knowledge_base_id == int(platform_kb) and row.status == "ok"]
    assert "retriever generator passages" in {row.query for row in platform}
    assert {row.source for row in queries} == {"mcp"}
    by_tool = {row.tool for row in mcp_calls}
    assert {"kb_create", "document_upload", "review_decide", "memory_add"} <= by_tool
    denied = [row for row in mcp_calls if row.tool == "review_list" and row.user_id == alice.id]
    assert denied and denied[0].status == "error"
    # Free text never reaches the call log: only sizes, identifiers and extensions.
    serialized = json.dumps([row.arguments for row in mcp_calls], ensure_ascii=False)
    assert "PostgreSQL 17" not in serialized and "secret personal" not in serialized and "notes.md" not in serialized
