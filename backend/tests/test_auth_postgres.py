"""Accounts, sessions, tokens, role guards and admin console over HTTP on real PostgreSQL.

RAG_DB_TEST=1 .venv/bin/python -m pytest -q tests/test_auth_postgres.py
Runs in a fresh tenant that is deleted afterwards. No model or vector service is called.
"""
import os

import httpx
import pytest
from sqlalchemy import delete

from app import models
from app.config import settings
from app.db import Session, engine, generate_id
from app.main import app
from app.mcp_server import mcp
from app.services import audit
from app.services.auth import hash_password
from app.services.configuration import bootstrap_configuration

pytestmark = pytest.mark.skipif(os.getenv("RAG_DB_TEST") != "1", reason="Opt-in PostgreSQL test")
ADMIN_PASSWORD = "Admin-initial-1"


@pytest.fixture
async def tenant(monkeypatch: pytest.MonkeyPatch):
    tenant_id = generate_id()
    await engine.dispose()
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    async with Session() as db, db.begin():
        db.add(models.User(tenant_id=tenant_id, username="root", display_name="Root", role="admin",
                           password_hash=hash_password(ADMIN_PASSWORD), must_change_password=True))
        await bootstrap_configuration(db)
    yield tenant_id
    async with Session() as db, db.begin():
        for model in (models.User, models.UserSession, models.ApiToken, models.KnowledgeBase, models.Document,
                      models.Memory, models.MemoryEvent, models.QueryLog, models.McpCallLog, models.Conversation,
                      models.ServiceConfiguration, models.ModelProfile):
            await db.execute(delete(model).where(model.tenant_id == tenant_id))
    await engine.dispose()


def client() -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8010")


async def login(http: httpx.AsyncClient, username: str, password: str) -> httpx.Response:
    return await http.post("/api/auth/login", json={"username": username, "password": password})


async def test_login_forced_password_change_and_sessions(tenant) -> None:
    async with client() as http:
        assert (await http.get("/api/knowledge-bases")).status_code == 401
        assert (await http.get("/api/health")).status_code in (200, 503)
        assert (await login(http, "root", "wrong-password")).status_code == 401
        response = await login(http, "ROOT", ADMIN_PASSWORD)
        assert response.status_code == 200 and response.json()["must_change_password"] is True
        cookie = response.headers["set-cookie"].lower()
        assert "httponly" in cookie and "samesite=lax" in cookie
        # Until the initial password is replaced, only the account endpoints work.
        assert (await http.get("/api/knowledge-bases")).status_code == 403
        assert (await http.get("/api/auth/me")).json()["username"] == "root"
        weak = await http.post("/api/auth/password", json={"current_password": ADMIN_PASSWORD,
                                                           "new_password": "short"})
        assert weak.status_code == 400
        changed = await http.post("/api/auth/password", json={"current_password": ADMIN_PASSWORD,
                                                              "new_password": "Chief-new-passw0rd"})
        assert changed.status_code == 200 and changed.json()["must_change_password"] is False
        assert (await http.get("/api/knowledge-bases")).status_code == 200
        assert (await http.post("/api/auth/logout")).status_code == 204
        assert (await http.get("/api/auth/me")).status_code == 401


async def test_admin_manages_accounts_and_employee_is_restricted(tenant) -> None:
    async with client() as admin_http, client() as alice_http:
        await login(admin_http, "root", ADMIN_PASSWORD)
        await admin_http.post("/api/auth/password", json={"current_password": ADMIN_PASSWORD,
                                                          "new_password": "Chief-new-passw0rd"})
        created = await admin_http.post("/api/admin/users", json={"username": "Alice", "display_name": "Alice"})
        assert created.status_code == 201
        alice = created.json()
        assert alice["username"] == "alice" and "password_hash" not in alice
        temporary = alice.pop("temporary_password")
        assert (await admin_http.post("/api/admin/users", json={"username": "alice"})).status_code == 409
        root_id = next(u["id"] for u in (await admin_http.get("/api/admin/users")).json() if u["username"] == "root")
        assert (await admin_http.patch(f"/api/admin/users/{root_id}", json={"role": "employee"})).status_code == 409
        assert (await admin_http.patch(f"/api/admin/users/{root_id}", json={"status": "disabled"})).status_code == 409

        await login(alice_http, "alice", temporary)
        await alice_http.post("/api/auth/password", json={"current_password": temporary,
                                                          "new_password": "Wonder-land-77x"})
        for path in ("/api/admin/users", "/api/datasets", "/api/tuning-runs", "/api/settings",
                     "/api/admin/query-logs", "/api/admin/mcp-logs"):
            assert (await alice_http.get(path)).status_code == 403, path
        assert (await alice_http.post("/api/knowledge-bases", json={"name": "x", "scope": "platform"})
                ).status_code == 403
        personal = await alice_http.post("/api/knowledge-bases", json={"name": "Alice notes"})
        assert personal.status_code == 201 and personal.json()["scope"] == "personal"
        platform = await admin_http.post("/api/knowledge-bases", json={"name": "Handbook", "scope": "platform"})
        assert platform.status_code == 201
        alice_view = {kb["id"] for kb in (await alice_http.get("/api/knowledge-bases")).json()}
        admin_view = {kb["id"] for kb in (await admin_http.get("/api/knowledge-bases")).json()}
        assert alice_view == {personal.json()["id"], platform.json()["id"]}
        assert personal.json()["id"] not in admin_view
        assert (await admin_http.get(f"/api/knowledge-bases/{personal.json()['id']}")).status_code == 404

        # Memories are always private to the caller; a legacy scope query parameter is ignored.
        created = await alice_http.post("/api/memories?scope=platform", json={"content": "Office closes at 6pm"})
        assert created.status_code == 201, created.text
        memory = created.json()["memory"]
        assert memory["status"] == "active" and memory["user_id"] == f"user:{alice['id']}"
        for suffix in ("", "?scope=personal", "?scope=platform"):
            listed = (await alice_http.get(f"/api/memories{suffix}")).json()
            assert [m["content"] for m in listed["items"]] == ["Office closes at 6pm"]
            assert (await admin_http.get(f"/api/memories{suffix}")).json()["total"] == 0
        assert (await alice_http.patch(f"/api/memories/{memory['id']}?scope=platform",
                                       json={"importance": 5})).status_code == 200
        assert (await admin_http.get(f"/api/memories/{memory['id']}")).status_code == 404
        # Admin reviews cover documents only.
        reviews = (await admin_http.get("/api/admin/reviews")).json()
        assert reviews == {"documents": []}
        assert (await admin_http.get("/api/admin/reviews/count")).json() == {"documents": 0, "total": 0}
        assert (await admin_http.post(f"/api/admin/reviews/memories/{memory['id']}",
                                      json={"approve": True})).status_code in (404, 405)

        # Disabling an account signs it out immediately.
        assert (await admin_http.patch(f"/api/admin/users/{alice['id']}", json={"status": "disabled"})
                ).status_code == 200
        assert (await alice_http.get("/api/auth/me")).status_code == 401
        assert (await login(alice_http, "alice", "Wonder-land-77x")).status_code == 403
        reset = await admin_http.post(f"/api/admin/users/{alice['id']}/reset-password")
        assert reset.status_code == 200 and reset.json()["must_change_password"] is True


async def test_personal_tokens_authenticate_mcp_and_are_logged(tenant, monkeypatch) -> None:
    monkeypatch.setattr(audit, "ENABLED", True)
    async with client() as http:
        await login(http, "root", ADMIN_PASSWORD)
        await http.post("/api/auth/password", json={"current_password": ADMIN_PASSWORD,
                                                    "new_password": "Chief-new-passw0rd"})
        created = await http.post("/api/auth/tokens", json={"name": "agent"})
        assert created.status_code == 201
        raw = created.json()["token"]
        assert raw.startswith("rwb_") and "token_hash" not in created.json()
        assert all("token" not in row for row in (await http.get("/api/auth/tokens")).json())
        token_id = created.json()["id"]

    body = {"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "whoami", "arguments": {}}}
    headers = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json",
               "MCP-Protocol-Version": "2025-06-18"}
    async with mcp.session_manager.run(), client() as http:
        assert (await http.post("/mcp", json=body, headers=headers)).status_code == 401
        assert (await http.post("/mcp", json=body, headers={**headers, "Authorization": "Bearer rwb_bad"})
                ).status_code == 401
        response = await http.post("/mcp", json=body, headers={**headers, "Authorization": f"Bearer {raw}"})
        assert response.status_code == 200, response.text
        assert response.json()["result"]["structuredContent"]["username"] == "root"
        # Bearer tokens also work on the REST API, but cannot mint further tokens.
        bearer = {"Authorization": f"Bearer {raw}"}
        assert (await http.get("/api/auth/me", headers=bearer)).json()["via"] == "token"
        assert (await http.post("/api/auth/tokens", json={"name": "x"}, headers=bearer)).status_code == 403
        await login(http, "root", "Chief-new-passw0rd")
        logs = (await http.get("/api/admin/mcp-logs")).json()
        assert logs["items"][0]["tool"] == "whoami" and logs["items"][0]["transport"] == "http"
        assert logs["items"][0]["token_id"] == token_id
        assert (await http.delete(f"/api/auth/tokens/{token_id}")).json()["revoked_at"]
        assert (await http.post("/mcp", json=body, headers={**headers, "Authorization": f"Bearer {raw}"})
                ).status_code == 401
