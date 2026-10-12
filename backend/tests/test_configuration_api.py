"""Offline configuration/API/queue contracts; no .env reads, database or paid calls.

The session double evaluates the actual SQLAlchemy predicates so tenant filters
are exercised, rather than replacing resource lookup with an unconditional mock.
The real app routers/validation handler run through ASGI without its lifespan.
"""

from __future__ import annotations

import copy
import importlib
import socket
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import httpx
import pytest
from pydantic_settings.sources import DotEnvSettingsSource, EnvSettingsSource
from sqlalchemy.sql import operators
from sqlalchemy.sql.dml import Update
from sqlalchemy.sql.elements import BindParameter, False_, True_, UnaryExpression

from app.api.deps import current_principal
from app.services.auth import Principal

ADMIN = Principal(id=1, username="admin", display_name="Admin", role="admin")

TENANT = 700000000000000001
OTHER_TENANT = TENANT + 1
PROFILE_ID = 101
OTHER_PROFILE_ID = 102
CONVERSATION_ID = 301
PLAIN_KEY = "fixture-only-plaintext-key"
OTHER_KEY = "fixture-only-replacement-key"
PROTOCOLS = ["openai_chat", "openai_responses", "anthropic"]


def _value(expression: Any) -> Any:
    if isinstance(expression, BindParameter):
        return expression.value
    if isinstance(expression, True_):
        return True
    if isinstance(expression, False_):
        return False
    raise AssertionError(f"Unsupported mock SQL value: {type(expression).__name__}")


def _matches(row: Any, conditions: Any) -> bool:
    for condition in conditions:
        left = getattr(row, condition.left.key)
        right = _value(condition.right)
        operation = condition.operator
        if operation in (operators.eq, operators.is_):
            matched = left == right
        elif operation is operators.in_op:
            matched = left in right
        elif operation is operators.lt:
            matched = left < right
        else:
            raise AssertionError(f"Unsupported mock SQL operator: {operation.__name__}")
        if not matched:
            return False
    return True


class MockSession:
    """Small async stateful session double for the SELECT/UPDATE shapes under test."""

    def __init__(self) -> None:
        self.rows: list[Any] = []
        self.statements: list[Any] = []
        self.commits = 0
        self.rollbacks = 0
        self._next_id = 10000
        self._saved: list[tuple[Any, dict[str, Any]]] = []

    def checkpoint(self) -> None:
        self._saved = [(row, {column.name: copy.deepcopy(getattr(row, column.name))
                              for column in row.__table__.columns}) for row in self.rows]

    async def __aenter__(self) -> MockSession:
        self.checkpoint()
        return self

    async def __aexit__(self, *args: Any) -> None:
        return None

    def add(self, row: Any) -> None:
        if row not in self.rows:
            self.rows.append(row)
        for column in row.__table__.columns:
            if getattr(row, column.name) is not None:
                continue
            if column.name == "id":
                self._next_id += 1
                setattr(row, column.name, self._next_id)
            elif column.name in {"created_at", "updated_at"}:
                setattr(row, column.name, datetime.now(UTC))
            elif column.default is not None:
                default = column.default
                setattr(row, column.name, default.arg(None) if default.is_callable else default.arg)

    def add_all(self, rows: list[Any]) -> None:
        for row in rows:
            self.add(row)

    async def flush(self) -> None:
        return None

    async def refresh(self, row: Any) -> None:
        assert row in self.rows

    async def commit(self) -> None:
        self.commits += 1
        self.checkpoint()

    async def rollback(self) -> None:
        self.rollbacks += 1
        self.rows = [row for row, _ in self._saved]
        for row, fields in self._saved:
            for name, value in fields.items():
                setattr(row, name, copy.deepcopy(value))

    def _select(self, statement: Any) -> list[Any]:
        self.statements.append(statement)
        model = statement.column_descriptions[0]["entity"]
        rows = [row for row in self.rows if isinstance(row, model) and _matches(row, statement._where_criteria)]
        for clause in reversed(statement._order_by_clauses):
            descending = isinstance(clause, UnaryExpression) and clause.modifier is operators.desc_op
            name = clause.element.key if isinstance(clause, UnaryExpression) else clause.key
            rows.sort(key=lambda row, field=name: getattr(row, field), reverse=descending)
        if statement._limit_clause is not None:
            rows = rows[:statement._limit_clause.value]
        return rows

    async def scalar(self, statement: Any) -> Any:
        rows = self._select(statement)
        return rows[0] if rows else None

    async def scalars(self, statement: Any) -> Any:
        return SimpleNamespace(all=lambda: self._select(statement))

    async def execute(self, statement: Any, *args: Any) -> Any:
        assert isinstance(statement, Update), "No DDL or real database access is permitted in this test"
        self.statements.append(statement)
        rows = [row for row in self.rows if row.__tablename__ == statement.table.name
                and _matches(row, statement._where_criteria)]
        for row in rows:
            for column, value in statement._values.items():
                setattr(row, getattr(column, "key", column), _value(value))
        return SimpleNamespace(rowcount=len(rows))


def _forbid_external(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("An external connection or real provider was attempted in an offline test")


@pytest.fixture
def env(monkeypatch: pytest.MonkeyPatch, tmp_path: Any) -> Iterator[SimpleNamespace]:
    # Configuration imports normally read backend/.env. Explicitly suppress both
    # sources before importing app modules; never inspect real credentials.
    with patch.object(DotEnvSettingsSource, "_read_env_files", return_value={}), \
            patch.object(EnvSettingsSource, "_load_env_vars", return_value={}):
        main = importlib.import_module("app.main")
        config = importlib.import_module("app.config")
        db_module = importlib.import_module("app.db")
        configuration = importlib.import_module("app.services.configuration")
        profiles = importlib.import_module("app.api.model_profiles")
        services = importlib.import_module("app.api.service_settings")
        models = importlib.import_module("app.models")
        worker = importlib.import_module("app.worker")
        rag = importlib.import_module("app.services.rag")
    monkeypatch.setattr(socket.socket, "connect", _forbid_external)
    for name, value in {
        "tenant_id": TENANT, "data_dir": tmp_path, "chat_model": "bootstrap-model",
        "chat_protocol": "openai_chat", "chat_base_url": "https://bootstrap.test/v1", "chat_api_key": "",
        "embedding_api_key": "", "rerank_api_key": "",
    }.items():
        monkeypatch.setattr(config.settings, name, value)
    db = MockSession()
    for module in (db_module, configuration, worker):
        monkeypatch.setattr(module, "Session", lambda: db)
    for module in (profiles, services, rag):
        monkeypatch.setattr(module, "Providers", _forbid_external)
    monkeypatch.setattr(rag, "answer_question", _forbid_external)
    ciphertext = configuration.encrypt_secret(PLAIN_KEY)
    default = models.ModelProfile(
        id=PROFILE_ID, tenant_id=TENANT, name="Default fixture", model="saved-model", protocol="openai_chat",
        base_url="https://model.test/v1", api_key_ciphertext=ciphertext, is_default=True,
        max_tokens=512, timeout_seconds=15, json_mode=True,
    )
    foreign = models.ModelProfile(
        id=OTHER_PROFILE_ID, tenant_id=OTHER_TENANT, name="Foreign fixture", model="foreign-model",
        protocol="anthropic", base_url="https://foreign.test/v1", api_key_ciphertext=ciphertext,
        is_default=True,
    )
    service_row = models.ServiceConfiguration(
        tenant_id=TENANT,
        config={"embedding": {"model": "saved-embedding", "base_url": "http://embedding.test/v1", "dimensions": 3},
                "rerank": {"model": "saved-rerank", "base_url": "http://rerank.test/v1", "protocol": "standard"},
                "mineru": {"base_url": "http://mineru.test"},
                "milvus": {"uri": "http://milvus.test", "collection": "rag_workbench_fixture"}},
        secrets_ciphertext={"embedding": ciphertext, "rerank": ciphertext},
    )
    foreign_service = models.ServiceConfiguration(
        tenant_id=OTHER_TENANT, config={"embedding": {"model": "foreign-embedding"}}, secrets_ciphertext={},
    )
    kb = models.KnowledgeBase(id=201, tenant_id=TENANT, name="Fixture KB", embedding_model="saved-embedding",
                              embedding_dimensions=3, scope="platform", owner_id=ADMIN.id)
    conversation = models.Conversation(id=CONVERSATION_ID, tenant_id=TENANT, knowledge_base_id=kb.id,
                                       owner_id=ADMIN.id)
    db.add_all([default, foreign, service_row, foreign_service, kb, conversation])
    db.checkpoint()

    async def get_test_db() -> AsyncIterator[MockSession]:
        db.checkpoint()
        try:
            yield db
            await db.commit()
        except Exception:
            await db.rollback()
            raise

    overrides = dict(main.app.dependency_overrides)
    main.app.dependency_overrides[db_module.get_db] = get_test_db
    main.app.dependency_overrides[current_principal] = lambda: ADMIN
    yield SimpleNamespace(
        app=main.app, settings=config.settings, db=db, configuration=configuration, profiles=profiles,
        services=services, models=models, worker=worker, rag=rag, default=default, foreign=foreign,
        service_row=service_row, foreign_service=foreign_service, ciphertext=ciphertext,
    )
    main.app.dependency_overrides.clear()
    main.app.dependency_overrides.update(overrides)


@pytest.fixture
async def client(env: SimpleNamespace) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=env.app), base_url="http://localhost") as http:
        yield http


def _profile(**overrides: Any) -> dict[str, Any]:
    return {"name": "New fixture", "model": "selected-model", "protocol": "openai_chat",
            "base_url": "https://selected.test/v1", "api_key": PLAIN_KEY, **overrides}


def _assert_public(response: httpx.Response, env: SimpleNamespace) -> None:
    assert PLAIN_KEY not in response.text
    assert OTHER_KEY not in response.text
    assert env.ciphertext not in response.text
    assert "api_key_ciphertext" not in response.text
    assert "secrets_ciphertext" not in response.text


async def test_gets_are_write_only_and_tenant_scoped(client: httpx.AsyncClient, env: SimpleNamespace) -> None:
    profiles = await client.get("/api/model-profiles")
    assert profiles.status_code == 200
    assert [row["id"] for row in profiles.json()] == [str(PROFILE_ID)]
    assert profiles.json()[0]["api_key_set"] is True
    _assert_public(profiles, env)
    services = await client.get("/api/settings")
    assert services.status_code == 200
    assert services.json()["chat"]["profile_id"] == str(PROFILE_ID)
    assert services.json()["embedding"]["model"] == "saved-embedding"
    assert services.json()["embedding"]["configured"] is True
    assert services.json()["rerank"]["protocol"] == "standard"
    _assert_public(services, env)
    for statement in env.db.statements:
        assert any(condition.left.key == "tenant_id" and _value(condition.right) == TENANT
                   for condition in statement._where_criteria)


@pytest.mark.parametrize("payload", [
    {"api_key": PLAIN_KEY, "max_tokens": "not-an-integer"},
    {"api_key": PLAIN_KEY, "base_url": "https://user:" + PLAIN_KEY + "@model.test"},
    {"api_key": {"secret": PLAIN_KEY}}, {"api_key": PLAIN_KEY, "name": None},
    {"api_key": PLAIN_KEY, "unexpected": {"ciphertext": "cipher-fixture"}},
])
async def test_profile_422_never_echoes_secret_inputs_or_validator_context(
    client: httpx.AsyncClient, env: SimpleNamespace, payload: dict[str, Any],
) -> None:
    response = await client.post("/api/model-profiles", json=_profile(**payload))
    assert response.status_code == 422
    _assert_public(response, env)
    assert "cipher-fixture" not in response.text
    assert all(set(error) == {"loc", "type", "msg"} for error in response.json()["detail"])


@pytest.mark.parametrize("payload", [
    {"embedding": {"api_key": PLAIN_KEY, "dimensions": -1}},
    {"rerank": {"api_key": PLAIN_KEY, "protocol": "unsupported"}},
    {"embedding": {"api_key": PLAIN_KEY, "base_url": "http://model.test?key=" + PLAIN_KEY}},
    {"milvus": {"collection": "outside_workbench"}}, {"embedding": None},
])
async def test_service_422_is_safe_and_does_not_mutate_saved_settings(
    client: httpx.AsyncClient, env: SimpleNamespace, payload: dict[str, Any],
) -> None:
    original = copy.deepcopy(env.service_row.config)
    response = await client.patch("/api/settings", json=payload)
    assert response.status_code == 422
    _assert_public(response, env)
    assert env.service_row.config == original


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_create_encrypts_key_and_selects_one_tenant_default(
    client: httpx.AsyncClient, env: SimpleNamespace, protocol: str,
) -> None:
    response = await client.post("/api/model-profiles", json=_profile(protocol=protocol, is_default=True))
    assert response.status_code == 201, response.text
    _assert_public(response, env)
    assert response.json()["protocol"] == protocol
    assert response.json()["is_default"] is True
    created = next(row for row in env.db.rows if isinstance(row, env.models.ModelProfile)
                   and row.id == int(response.json()["id"]))
    assert created.api_key_ciphertext != PLAIN_KEY
    assert env.configuration.decrypt_secret(created.api_key_ciphertext) == PLAIN_KEY
    assert env.default.is_default is False
    assert env.foreign.is_default is True
    listed = (await client.get("/api/model-profiles")).json()
    assert sum(row["is_default"] for row in listed) == 1
    assert listed[0]["id"] == response.json()["id"]


async def test_profile_patch_omits_preserves_and_empty_clears_key(
    client: httpx.AsyncClient, env: SimpleNamespace,
) -> None:
    original = env.default.api_key_ciphertext
    response = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={"name": "Renamed"})
    assert response.status_code == 200 and response.json()["api_key_set"] is True
    assert env.default.api_key_ciphertext == original
    response = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={"api_key": OTHER_KEY})
    assert response.status_code == 200
    assert env.configuration.decrypt_secret(env.default.api_key_ciphertext) == OTHER_KEY
    _assert_public(response, env)
    response = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={"api_key": ""})
    assert response.status_code == 200 and response.json()["api_key_set"] is False
    assert env.default.api_key_ciphertext == ""
    response = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={"api_key": None})
    assert response.status_code == 422


async def test_service_patch_preserves_other_fields_and_empty_clears_secret(
    client: httpx.AsyncClient, env: SimpleNamespace,
) -> None:
    original = dict(env.service_row.secrets_ciphertext)
    response = await client.patch("/api/settings", json={"embedding": {"model": "edited-embedding"}})
    assert response.status_code == 200
    assert env.service_row.secrets_ciphertext == original
    assert env.service_row.config["embedding"]["dimensions"] == 3
    response = await client.patch("/api/settings", json={"embedding": {"api_key": ""},
                                                       "rerank": {"api_key": OTHER_KEY, "protocol": "dashscope"}})
    assert response.status_code == 200
    assert response.json()["embedding"]["configured"] is False
    assert env.service_row.secrets_ciphertext["embedding"] == ""
    assert env.configuration.decrypt_secret(env.service_row.secrets_ciphertext["rerank"]) == OTHER_KEY
    assert "api_key" not in env.service_row.config["rerank"]
    assert env.foreign_service.config == {"embedding": {"model": "foreign-embedding"}}
    _assert_public(response, env)


@pytest.mark.parametrize("method,path,payload", [
    ("PATCH", "/api/model-profiles/{id}", {"name": "No access"}),
    ("DELETE", "/api/model-profiles/{id}", None),
    ("POST", "/api/model-profiles/{id}/test", {"confirm": True}),
])
async def test_foreign_and_missing_profiles_are_indistinguishable_404(
    client: httpx.AsyncClient, env: SimpleNamespace, method: str, path: str, payload: Any,
) -> None:
    foreign = await client.request(method, path.format(id=OTHER_PROFILE_ID), json=payload)
    missing = await client.request(method, path.format(id=999999), json=payload)
    assert foreign.status_code == missing.status_code == 404
    assert foreign.json() == missing.json()
    assert env.foreign.name == "Foreign fixture" and env.foreign.is_default is True


@pytest.mark.parametrize("payload", [{"enabled": False}, {"is_default": False}])
async def test_default_cannot_be_disabled_or_unset(
    client: httpx.AsyncClient, env: SimpleNamespace, payload: dict[str, bool],
) -> None:
    response = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json=payload)
    assert response.status_code == 409
    assert env.default.is_default is True and env.default.enabled is True
    assert (await client.delete(f"/api/model-profiles/{PROFILE_ID}")).status_code == 409


async def test_switch_default_then_archive_preserves_foreign_default(
    client: httpx.AsyncClient, env: SimpleNamespace,
) -> None:
    invalid = await client.post("/api/model-profiles", json=_profile(is_default=True, enabled=False))
    assert invalid.status_code == 409
    created = (await client.post("/api/model-profiles", json=_profile())).json()
    switched = await client.patch(f"/api/model-profiles/{created['id']}", json={"is_default": True})
    assert switched.status_code == 200 and switched.json()["is_default"] is True
    assert env.default.is_default is False and env.foreign.is_default is True
    archived = await client.delete(f"/api/model-profiles/{PROFILE_ID}")
    assert archived.status_code == 204
    assert env.default.is_deleted is True and env.default.enabled is False
    assert env.default.api_key_ciphertext == ""
    assert [row["id"] for row in (await client.get("/api/model-profiles")).json()] == [created["id"]]
    assert (await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={"name": "Archived"})).status_code == 404


@pytest.mark.parametrize("protocol", PROTOCOLS)
async def test_snapshot_and_resolve_are_isolated_from_later_profile_edits(
    env: SimpleNamespace, protocol: str,
) -> None:
    env.default.protocol = protocol
    snapshot = await env.configuration.get_chat_snapshot(env.db, PROFILE_ID)
    frozen = copy.deepcopy(snapshot)
    bootstrap = env.settings.model_dump()
    env.default.model = "edited-after-enqueue"
    env.default.protocol = "anthropic" if protocol != "anthropic" else "openai_chat"
    env.default.api_key_ciphertext = env.configuration.encrypt_secret(OTHER_KEY)
    resolved = await env.configuration.resolve_settings(snapshot, env.db)
    assert snapshot == frozen
    assert resolved is not env.settings
    assert resolved.chat_model == "saved-model" and resolved.chat_protocol == protocol
    assert resolved.chat_api_key == PLAIN_KEY
    assert resolved.embedding_model == "saved-embedding" and resolved.embedding_dimensions == 3
    assert resolved.rerank_protocol == "standard"
    assert resolved.max_output_tokens == 512 and resolved.model_timeout == 15
    assert env.settings.model_dump() == bootstrap
    resolved.chat_model = "caller-local-change"
    assert env.settings.chat_model == "bootstrap-model"
    public = env.configuration.public_snapshot(snapshot | {"api_key": PLAIN_KEY, "unknown_secret": "hidden"})
    assert public["id"] == str(PROFILE_ID)
    assert not {"api_key", "api_key_ciphertext", "unknown_secret"} & public.keys()


@pytest.mark.parametrize("endpoint", [f"/api/model-profiles/{PROFILE_ID}/test",
                                      "/api/settings/test/embedding", "/api/settings/test/rerank"])
async def test_paid_probes_require_explicit_confirmation(client: httpx.AsyncClient, endpoint: str) -> None:
    assert (await client.post(endpoint, json={})).status_code == 400
    assert (await client.post(endpoint, json={"confirm": False})).status_code == 400
    assert (await client.post(endpoint, json={"confirm": "true"})).status_code == 422


async def test_confirmed_profile_probe_uses_resolved_copy_and_closes_fake_provider(
    client: httpx.AsyncClient, env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[Any] = []

    class FakeProvider:
        def __init__(self, settings: Any) -> None:
            calls.append(settings)

        async def probe_chat(self) -> dict[str, Any]:
            calls.append("probe")
            return {"preview": "OK", "usage": {"total_tokens": 2}, "latency_ms": 1.0}

        async def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr(env.profiles, "Providers", FakeProvider)
    response = await client.post(f"/api/model-profiles/{PROFILE_ID}/test", json={"confirm": True})
    assert response.status_code == 200 and response.json()["success"] is True
    assert calls[1:] == ["probe", "close"]
    assert calls[0].chat_api_key == PLAIN_KEY and calls[0] is not env.settings
    assert env.db.rollbacks == 1
    _assert_public(response, env)


@pytest.mark.parametrize("protocol", PROTOCOLS)
@pytest.mark.parametrize("explicit", [False, True])
async def test_chat_snapshot_reaches_worker_unchanged_after_profile_edit(
    client: httpx.AsyncClient, env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch,
    protocol: str, explicit: bool,
) -> None:
    env.default.protocol = protocol
    env.db.add_all([
        env.models.Message(id=901, tenant_id=TENANT, conversation_id=CONVERSATION_ID,
                           role="user", content="Previous question"),
        env.models.Message(id=902, tenant_id=TENANT, conversation_id=CONVERSATION_ID,
                           role="assistant", content="Previous answer"),
    ])
    request = {"content": "Current question", "method": "no_context", "top_k": 3, "candidate_k": 8}
    if explicit:
        request["model_profile_id"] = str(PROFILE_ID)
    queued = await client.post(f"/api/conversations/{CONVERSATION_ID}/messages", json=request)
    assert queued.status_code == 202, queued.text
    _assert_public(queued, env)
    assert queued.json()["model_profile_id"] == str(PROFILE_ID)
    assert queued.json()["model_snapshot"]["protocol"] == protocol
    jobs = [row for row in env.db.rows if isinstance(row, env.models.Job)]
    assert len(jobs) == 1
    job = jobs[0]
    assert job.job_type == "chat" and job.resource_id == int(queued.json()["id"])
    frozen = copy.deepcopy(job.params["model_config"])
    assert frozen["api_key_ciphertext"] == env.ciphertext
    edited = await client.patch(f"/api/model-profiles/{PROFILE_ID}", json={
        "model": "edited-after-queue", "protocol": "anthropic", "api_key": OTHER_KEY,
    })
    assert edited.status_code == 200
    called: list[dict[str, Any]] = []

    async def answer_question(kb_id: int, question: str, **kwargs: Any) -> dict[str, Any]:
        called.append(kwargs)
        assert kb_id == 201 and question == "Current question"
        await kwargs["progress"]("generating")
        return {"answer": "Offline answer", "citations": [], "contexts": [],
                "timing": {"generation_ms": 1}, "usage": {"total_tokens": 2}}

    monkeypatch.setattr(env.rag, "answer_question", answer_question)
    await env.worker.process_job(job.id, job.job_type, job.resource_id, job.params)
    assert len(called) == 1
    assert called[0]["runtime_settings"].chat_model == "saved-model"
    assert called[0]["runtime_settings"].chat_protocol == protocol
    assert called[0]["runtime_settings"].chat_api_key == PLAIN_KEY
    assert called[0]["history"] == [{"role": "user", "content": "Previous question"},
                                    {"role": "assistant", "content": "Previous answer"}]
    assert called[0]["top_k"] == 3 and called[0]["candidate_k"] == 8
    assert job.params["model_config"] == frozen and job.status == "completed"
    messages = await client.get(f"/api/conversations/{CONVERSATION_ID}/messages")
    assert messages.status_code == 200
    _assert_public(messages, env)
    assistant = next(row for row in messages.json() if row["id"] == queued.json()["id"])
    assert assistant["status"] == "completed" and assistant["content"] == "Offline answer"
    assert assistant["model_snapshot"] == queued.json()["model_snapshot"]


@pytest.mark.parametrize("profile_id,expected", [(OTHER_PROFILE_ID, 404), (999999, 404), (PROFILE_ID, 409)])
async def test_chat_rejects_inaccessible_or_disabled_profile_before_enqueue(
    client: httpx.AsyncClient, env: SimpleNamespace, profile_id: int, expected: int,
) -> None:
    if profile_id == PROFILE_ID:
        env.default.enabled = False
    response = await client.post(f"/api/conversations/{CONVERSATION_ID}/messages", json={
        "content": "Question", "method": "no_context", "model_profile_id": str(profile_id),
    })
    assert response.status_code == expected
    assert not any(isinstance(row, (env.models.Job, env.models.Message)) for row in env.db.rows)


@pytest.mark.parametrize("target", ["profile", "settings", "message"])
async def test_422_does_not_reflect_ciphertext_or_plaintext_from_nested_inputs(
    client: httpx.AsyncClient, env: SimpleNamespace, target: str,
) -> None:
    secret = {"plaintext": PLAIN_KEY, "ciphertext": env.ciphertext}
    if target == "profile":
        response = await client.post("/api/model-profiles", json=_profile(api_key=secret))
    elif target == "settings":
        response = await client.patch("/api/settings", json={"embedding": {"api_key": secret}})
    else:
        response = await client.post(f"/api/conversations/{CONVERSATION_ID}/messages", json={
            "content": "Question", "method": "no_context", "model_config": secret,
        })
    assert response.status_code == 422
    _assert_public(response, env)


@pytest.mark.parametrize("service", ["embedding", "rerank"])
async def test_confirmed_service_probe_is_tiny_and_uses_only_fake_provider(
    client: httpx.AsyncClient, env: SimpleNamespace, monkeypatch: pytest.MonkeyPatch, service: str,
) -> None:
    calls: list[Any] = []

    class FakeProvider:
        def __init__(self, settings: Any) -> None:
            calls.append(settings)

        async def embed(self, texts: list[str]) -> tuple[list[list[float]], dict[str, int]]:
            assert texts == ["Connectivity test"]
            calls.append("embedding")
            return [[1.0, 0.0, 0.0]], {"total_tokens": 2}

        async def rerank(self, question: str, chunks: list[dict[str, str]]) -> list[dict[str, str]]:
            assert question == "connectivity"
            assert chunks == [{"id": "probe", "text": "Connectivity test"}]
            calls.append("rerank")
            return chunks

        async def close(self) -> None:
            calls.append("close")

    monkeypatch.setattr(env.services, "Providers", FakeProvider)
    response = await client.post(f"/api/settings/test/{service}", json={"confirm": True})
    assert response.status_code == 200 and response.json()["success"] is True
    assert calls[1:] == [service, "close"]
    assert calls[0].embedding_model == "saved-embedding"
    assert calls[0].rerank_protocol == "standard"
    assert env.db.rollbacks == 1
    _assert_public(response, env)


@pytest.mark.parametrize("schema_name", ["ProfileCreate", "ProfilePatch", "EmbeddingPatch", "RerankPatch"])
def test_configuration_schema_repr_hides_api_key(env: SimpleNamespace, schema_name: str) -> None:
    schemas = importlib.import_module("app.configuration_schemas")
    payload = _profile() if schema_name == "ProfileCreate" else {"api_key": PLAIN_KEY}
    request = getattr(schemas, schema_name)(**payload)
    assert request.api_key == PLAIN_KEY
    assert PLAIN_KEY not in repr(request)
