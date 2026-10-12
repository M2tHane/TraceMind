"""Opt-in configuration integration against migrated PostgreSQL, always rolled back.

RAG_CONFIG_DB_TEST=1 uv run pytest -q tests/test_configuration_postgres.py
No lifespan/worker is started and no external model request is made.
"""
import os
import secrets
from contextlib import asynccontextmanager

import httpx
import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app import worker
from app.api.deps import current_principal
from app.config import settings
from app.db import engine, generate_id, get_db
from app.main import app
from app.models import Job, ModelProfile, ServiceConfiguration
from app.services import rag
from app.services.auth import Principal
from app.services.configuration import bootstrap_configuration, decrypt_secret

pytestmark = pytest.mark.skipif(os.getenv("RAG_CONFIG_DB_TEST") != "1", reason="Opt-in PostgreSQL test")


@pytest.mark.asyncio
async def test_saved_settings_and_queued_snapshot_with_real_postgres(monkeypatch, tmp_path):
    tenant_id = generate_id()
    original_key = secrets.token_urlsafe(24)
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    monkeypatch.setattr(settings, "chat_api_key", original_key)
    monkeypatch.setattr(settings, "embedding_api_key", original_key)
    monkeypatch.setattr(settings, "rerank_api_key", original_key)
    monkeypatch.setattr(settings, "chat_base_url", "https://initial.invalid/v1")
    monkeypatch.setattr(settings, "chat_model", "initial-model")
    monkeypatch.setattr(settings, "embedding_base_url", "https://embedding.invalid/v1")
    monkeypatch.setattr(settings, "rerank_base_url", "https://rerank.invalid")
    monkeypatch.setattr(settings, "mineru_base_url", "http://127.0.0.1:1")
    monkeypatch.setattr(settings, "milvus_uri", "http://127.0.0.1:2")

    async with engine.connect() as connection:
        transaction = await connection.begin()
        db = AsyncSession(bind=connection, expire_on_commit=False, join_transaction_mode="create_savepoint")

        async def dependency():
            try:
                yield db
                await db.commit()
            except Exception:
                await db.rollback()
                raise

        @asynccontextmanager
        async def worker_session():
            yield db

        app.dependency_overrides[get_db] = dependency
        app.dependency_overrides[current_principal] = lambda: Principal(id=1, username="admin", display_name="",
                                                                        role="admin")
        monkeypatch.setattr(worker, "Session", worker_session)
        captured = []

        async def fake_answer(*args, **kwargs):
            captured.append(kwargs["runtime_settings"])
            return {"answer": "mock response", "citations": [], "contexts": [], "timing": {}, "usage": {}}

        monkeypatch.setattr(rag, "answer_question", fake_answer)
        try:
            await bootstrap_configuration(db)
            await db.commit()
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost") as client:
                profiles = (await client.get("/api/model-profiles")).json()
                assert len(profiles) == 1
                initial_id = profiles[0]["id"]
                assert profiles[0]["api_key_set"] is True
                saved_key = secrets.token_urlsafe(24)
                response = await client.post("/api/model-profiles", json={
                    "name": "integration profile", "model": "chosen-model", "protocol": "openai_responses",
                    "base_url": "https://chosen.invalid/v1", "api_key": saved_key,
                })
                assert response.status_code == 201, response.text
                assert saved_key not in response.text and "ciphertext" not in response.text
                profile_id = response.json()["id"]
                assert (await client.patch(f"/api/model-profiles/{profile_id}", json={"name": "renamed"})).status_code == 200
                profile = await db.scalar(select(ModelProfile).where(
                    ModelProfile.tenant_id == tenant_id, ModelProfile.id == int(profile_id)))
                assert decrypt_secret(profile.api_key_ciphertext) == saved_key
                assert (await client.patch(f"/api/model-profiles/{profile_id}", json={"is_default": True})).status_code == 200
                assert (await client.delete(f"/api/model-profiles/{profile_id}")).status_code == 409
                assert (await client.patch(f"/api/model-profiles/{profile_id}", json={"enabled": False})).status_code == 409
                assert (await client.delete(f"/api/model-profiles/{generate_id()}")).status_code == 404
                assert (await client.post(f"/api/model-profiles/{profile_id}/test", json={})).status_code == 400
                assert (await client.post("/api/settings/test/embedding", json={})).status_code == 400
                invalid = await client.post("/api/model-profiles", json={
                    "name": "bad", "model": "model", "protocol": "unsupported",
                    "base_url": "https://chosen.invalid", "api_key": saved_key,
                })
                assert invalid.status_code == 422 and saved_key not in invalid.text

                service_result = await client.patch("/api/settings", json={"embedding": {
                    "model": "embedding-v2", "base_url": "https://emb-v2.invalid/v1", "dimensions": 8,
                    "api_key": saved_key,
                }})
                assert service_result.status_code == 200, service_result.text
                assert service_result.json()["embedding"]["dimensions"] == 8
                assert saved_key not in service_result.text and "ciphertext" not in service_result.text
                assert (await client.patch("/api/settings", json={"embedding": {"model": "embedding-v3"}})).status_code == 200
                stored = await db.scalar(select(ServiceConfiguration).where(ServiceConfiguration.tenant_id == tenant_id))
                assert decrypt_secret(stored.secrets_ciphertext["embedding"]) == saved_key
                assert (await client.patch("/api/settings", json={"embedding": {"api_key": ""}})).json()["embedding"]["configured"] is False

                kb = await client.post("/api/knowledge-bases", json={"name": "configuration integration"})
                assert kb.status_code == 201, kb.text
                conversation = await client.post("/api/conversations", json={"knowledge_base_id": kb.json()["id"]})
                assert conversation.status_code == 201
                response = await client.post(f"/api/conversations/{conversation.json()['id']}/messages", json={
                    "content": "mock question", "method": "no_context", "model_profile_id": profile_id,
                })
                assert response.status_code == 202, response.text
                message = response.json()
                assert message["model_profile_id"] == profile_id
                assert message["model_snapshot"]["model"] == "chosen-model"
                assert "ciphertext" not in response.text and saved_key not in response.text
                job = await db.scalar(select(Job).where(Job.tenant_id == tenant_id,
                                                       Job.resource_id == int(message["id"])))
                queued = dict(job.params)
                assert decrypt_secret(queued["model_config"]["api_key_ciphertext"]) == saved_key
                await client.patch(f"/api/model-profiles/{profile_id}", json={"model": "changed-model", "api_key": ""})
                # Worker resolves services through its regular helper using this rollback-bound session.
                from app.services.configuration import resolve_settings

                async def resolve(model_config):
                    return await resolve_settings(model_config, db)

                monkeypatch.setattr(worker, "resolve_settings", resolve)
                await worker.answer_message(int(message["id"]), queued)
                assert len(captured) == 1
                assert captured[0].chat_model == "chosen-model"
                assert captured[0].chat_protocol == "openai_responses"
                assert captured[0].chat_api_key == saved_key
                assert captured[0].embedding_model == "embedding-v3"
                assert captured[0].embedding_dimensions == 8
                assert settings.chat_model == "initial-model"
                await client.patch(f"/api/model-profiles/{initial_id}", json={"is_default": True})
                assert (await client.delete(f"/api/model-profiles/{profile_id}")).status_code == 204
                assert (await client.get("/api/model-profiles")).json()[0]["id"] == initial_id
                await bootstrap_configuration(db)
                assert len((await client.get("/api/model-profiles")).json()) == 1
        finally:
            app.dependency_overrides.pop(get_db, None)
            app.dependency_overrides.pop(current_principal, None)
            await db.close()
            await transaction.rollback()
    await engine.dispose()
