"""Approval history and log filters of the administrator console, over HTTP on real PostgreSQL.

RAG_DB_TEST=1 .venv/bin/python -m pytest -q tests/test_admin_reviews_logs.py
Runs in a fresh tenant that is deleted afterwards. No model or vector service is called.
"""
import os
from datetime import UTC, datetime, timedelta

import httpx
import pytest
from sqlalchemy import delete, select

from app import models
from app.config import settings
from app.db import Session, engine, generate_id
from app.main import app
from app.services.auth import hash_password
from app.services.configuration import bootstrap_configuration

pytestmark = pytest.mark.skipif(os.getenv("RAG_DB_TEST") != "1", reason="Opt-in PostgreSQL test")
PASSWORD = "Chief-new-passw0rd"
ROOT, ALICE, BOB = generate_id(), generate_id(), generate_id()
KB_HANDBOOK, KB_PRODUCT = generate_id(), generate_id()


@pytest.fixture
async def tenant(monkeypatch: pytest.MonkeyPatch):
    tenant_id = generate_id()
    await engine.dispose()
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    async with Session() as db, db.begin():
        db.add(models.User(tenant_id=tenant_id, id=ROOT, username="root", display_name="Root", role="admin",
                           password_hash=hash_password(PASSWORD), must_change_password=False))
        db.add(models.User(tenant_id=tenant_id, id=ALICE, username="alice", display_name="Alice", role="employee",
                           password_hash=hash_password(PASSWORD), must_change_password=False))
        db.add(models.User(tenant_id=tenant_id, id=BOB, username="bob", display_name="", role="employee",
                           password_hash=hash_password(PASSWORD), must_change_password=False))
        await bootstrap_configuration(db)
    yield tenant_id
    async with Session() as db, db.begin():
        for model in (models.User, models.UserSession, models.KnowledgeBase, models.Document, models.QueryLog,
                      models.McpCallLog, models.ServiceConfiguration, models.ModelProfile):
            await db.execute(delete(model).where(model.tenant_id == tenant_id))
    await engine.dispose()


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8010")


async def sign_in(http: httpx.AsyncClient, username: str) -> None:
    assert (await http.post("/api/auth/login", json={"username": username, "password": PASSWORD})).status_code == 200


def library(tenant_id: int, name: str, scope: str = "platform", kb_id: int | None = None) -> models.KnowledgeBase:
    return models.KnowledgeBase(id=kb_id or generate_id(), tenant_id=tenant_id, name=name, scope=scope,
                                embedding_model="fixture", embedding_dimensions=8)


def document(tenant_id: int, kb: int, name: str, **fields) -> models.Document:
    return models.Document(id=generate_id(), tenant_id=tenant_id, knowledge_base_id=kb, filename=name,
                           file_sha256="0" * 64, source_type="markdown", **fields)


async def test_review_history_lists_decided_documents_with_filters(tenant) -> None:
    now = datetime.now(UTC)
    async with Session() as db, db.begin():
        db.add_all([library(tenant, "员工手册", kb_id=KB_HANDBOOK), library(tenant, "产品手册", kb_id=KB_PRODUCT)])
        db.add_all([
            document(tenant, KB_HANDBOOK, "ok-old.md", status="ready", stage="ready", review_status="approved",
                     uploaded_by=ALICE, reviewed_by=ROOT, reviewed_at=now - timedelta(days=40), review_note=""),
            document(tenant, KB_HANDBOOK, "ok-new.md", status="ready", stage="ready", review_status="approved",
                     uploaded_by=ALICE, reviewed_by=ROOT, reviewed_at=now - timedelta(hours=2), review_note=""),
            document(tenant, KB_PRODUCT, "wifi.txt", status="rejected", stage="rejected", review_status="rejected",
                     uploaded_by=BOB, reviewed_by=ROOT, reviewed_at=now - timedelta(hours=1),
                     review_note="含有内网密码_100%"),
            # Not a review decision: auto-approved upload, still pending upload, personal upload.
            document(tenant, KB_HANDBOOK, "auto.md", status="ready", stage="ready", review_status="approved", uploaded_by=ROOT),
            document(tenant, KB_HANDBOOK, "waiting.md", status="pending_review", stage="pending_review",
                     review_status="pending", uploaded_by=ALICE),
        ])
    async with client() as http, client() as employee:
        await sign_in(employee, "alice")
        assert (await employee.get("/api/admin/reviews/history")).status_code == 403
        await sign_in(http, "root")
        reply = await http.get("/api/admin/reviews/history")
        assert reply.status_code == 200, reply.text
        body = reply.json()
        assert [row["filename"] for row in body["items"]] == ["wifi.txt", "ok-new.md", "ok-old.md"]
        assert body["total"] == 3 and body["counts"] == {"all": 3, "approved": 2, "rejected": 1}
        assert body["limit"] == 50 and body["offset"] == 0
        rejected = body["items"][0]
        assert rejected["result"] == "rejected" and rejected["review_note"] == "含有内网密码_100%"
        assert rejected["knowledge_base_name"] == "产品手册" and rejected["reviewed_at"]
        assert rejected["uploader"] == {"username": "bob", "display_name": ""}
        assert rejected["reviewer"] == {"username": "root", "display_name": "Root"}
        assert "markdown" not in rejected

        only = (await http.get("/api/admin/reviews/history", params={"result": "approved"})).json()
        assert [row["filename"] for row in only["items"]] == ["ok-new.md", "ok-old.md"]
        assert only["total"] == 2 and only["counts"]["rejected"] == 1
        assert (await http.get("/api/admin/reviews/history", params={"result": "pending"})).status_code == 422

        found = (await http.get("/api/admin/reviews/history", params={"q": "WIFI"})).json()
        assert [row["filename"] for row in found["items"]] == ["wifi.txt"]
        # The note is searched too, and LIKE wildcards in the query are literal.
        assert (await http.get("/api/admin/reviews/history", params={"q": "100%"})).json()["total"] == 1
        assert (await http.get("/api/admin/reviews/history", params={"q": "%"})).json()["total"] == 1
        assert (await http.get("/api/admin/reviews/history", params={"q": "_"})).json()["total"] == 1

        by_user = (await http.get("/api/admin/reviews/history", params={"uploader_id": ALICE})).json()
        assert by_user["total"] == 2 and by_user["counts"]["rejected"] == 0
        recent = (await http.get("/api/admin/reviews/history",
                                 params={"since": (now - timedelta(days=30)).isoformat()})).json()
        assert [row["filename"] for row in recent["items"]] == ["wifi.txt", "ok-new.md"]
        assert recent["counts"]["all"] == 2
        window = (await http.get("/api/admin/reviews/history", params={
            "since": (now - timedelta(days=60)).isoformat(), "until": (now - timedelta(days=30)).isoformat()})).json()
        assert [row["filename"] for row in window["items"]] == ["ok-old.md"]

        page = (await http.get("/api/admin/reviews/history", params={"limit": 1, "offset": 1})).json()
        assert [row["filename"] for row in page["items"]] == ["ok-new.md"] and page["total"] == 3
        assert (await http.get("/api/admin/reviews/history", params={"type": "document"})).json()["total"] == 3
        assert (await http.get("/api/admin/reviews/history", params={"type": "memory"})).status_code == 422


async def test_query_log_multi_library_filter_and_today_counts(tenant) -> None:
    now = datetime.now(UTC)
    kb = [generate_id() for _ in range(5)]

    def log(kb: int, scope: str, **fields) -> models.QueryLog:
        return models.QueryLog(id=generate_id(), tenant_id=tenant, user_id=ALICE, username="alice", source="chat",
                               action="answer", knowledge_base_id=kb, kb_scope=scope, query_chars=5, method="hybrid",
                               **fields)
    async with Session() as db, db.begin():
        db.add_all([
            log(kb[0], "platform", query="年假", created_at=now),
            log(kb[1], "platform", query="报销", status="error", error="timeout", created_at=now),
            log(kb[2], "platform", query="打印机", created_at=now),
            log(kb[3], "personal", query=None, created_at=now),
            log(kb[4], "personal", query=None, created_at=now - timedelta(days=3)),
        ])
        db.add_all([library(tenant, f"库{index}", kb_id=kb[index]) for index in range(3)])
    async with client() as http:
        await sign_in(http, "root")
        everything = (await http.get("/api/admin/query-logs")).json()
        assert everything["total"] == 5 and everything["today"] == {"count": 4, "failed": 1}

        two = (await http.get("/api/admin/query-logs",
                              params=[("knowledge_base_id", kb[0]), ("knowledge_base_id", kb[1])])).json()
        assert sorted(row["knowledge_base_id"] for row in two["items"]) == sorted([str(kb[0]), str(kb[1])])
        # Today's figures describe the whole day, not the current filter.
        assert two["total"] == 2 and two["today"] == {"count": 4, "failed": 1}
        single = (await http.get("/api/admin/query-logs", params={"knowledge_base_id": kb[2]})).json()
        assert single["total"] == 1 and single["items"][0]["knowledge_base_name"] == "库2"

        personal = (await http.get("/api/admin/query-logs", params={"include_personal": "true"})).json()
        assert personal["total"] == 2 and {row["kb_scope"] for row in personal["items"]} == {"personal"}
        assert all(row["query"] is None for row in personal["items"])
        mixed = (await http.get("/api/admin/query-logs",
                                params={"knowledge_base_id": kb[0], "include_personal": "true"})).json()
        assert mixed["total"] == 3
        failed = (await http.get("/api/admin/query-logs", params={"status": "error", "include_personal": "true",
                                                                  "knowledge_base_id": kb[1]})).json()
        assert failed["total"] == 1

        # Day boundaries follow the client's midnight when supplied.
        later = (await http.get("/api/admin/query-logs",
                                params={"today_since": (now + timedelta(hours=1)).isoformat()})).json()
        assert later["today"] == {"count": 0, "failed": 0}
        wide = (await http.get("/api/admin/query-logs",
                               params={"today_since": (now - timedelta(days=4)).isoformat()})).json()
        assert wide["today"] == {"count": 5, "failed": 1}


async def test_retry_requeues_a_failed_document_and_returns_it(tenant, monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    async with Session() as db, db.begin():
        db.add(library(tenant, "员工手册", kb_id=KB_HANDBOOK))
        failed = document(tenant, KB_HANDBOOK, "leave.md", status="failed", stage="failed", error="embedding failed",
                          review_status="approved", uploaded_by=ROOT)
        db.add(failed)
    folder = tmp_path / "documents" / str(failed.id)
    folder.mkdir(parents=True)
    (folder / "source.md").write_text("# 休假制度", encoding="utf-8")
    try:
        async with client() as http:
            await sign_in(http, "root")
            response = await http.post(f"/api/documents/{failed.id}/retry")
        assert response.status_code == 202, response.text
        assert (response.json()["status"], response.json()["error"]) == ("queued", None)
        assert response.json()["updated_at"]
        async with Session() as db:
            row = await db.get(models.Document, failed.id)
            jobs = (await db.scalars(select(models.Job).where(models.Job.tenant_id == tenant,
                                                              models.Job.resource_id == failed.id))).all()
        assert row.status == "queued" and [job.job_type for job in jobs] == ["parse"]
    finally:
        async with Session() as db, db.begin():
            await db.execute(delete(models.Job).where(models.Job.tenant_id == tenant))
