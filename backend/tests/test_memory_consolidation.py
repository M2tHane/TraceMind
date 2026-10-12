"""Scheduled memory consolidation against migrated PostgreSQL with fake embedding and chat models.

RAG_DB_TEST=1 .venv/bin/python -m pytest -q tests/test_memory_consolidation.py
Each test uses a fresh random tenant and deletes its rows afterwards. No model is called.
"""
import hashlib
import os
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import httpx
import pytest
from sqlalchemy import delete, select, update

from app import models
from app.config import settings
from app.db import Session, engine, generate_id
from app.main import app
from app.services import memory, memory_consolidation
from app.services.auth import hash_password
from app.services.configuration import bootstrap_configuration
from app.services.providers import ProviderError
from app.services.ranking import tokenize

needs_db = pytest.mark.skipif(os.getenv("RAG_DB_TEST") != "1", reason="Opt-in PostgreSQL test")
DIMENSIONS = 64
PASSWORD = "Admin-initial-1"


def fake_vector(text: str) -> list[float]:
    vector = [0.0] * DIMENSIONS
    for token in tokenize(text):
        vector[int(hashlib.md5(token.encode()).hexdigest(), 16) % DIMENSIONS] += 1.0
    return vector


def word(group: int, index: int) -> str:
    """Letters only: the tokenizer splits digits off words."""
    return "w" + chr(97 + group) * 3 + chr(97 + index) * 3


def variant(group: int, extra: int) -> str:
    """Seven shared words plus one distinguishing word: cosine 0.875, Jaccard 0.78."""
    return " ".join([*(word(group, i) for i in range(7)), "x" + chr(97 + extra) * 4])


@pytest.fixture
async def world(monkeypatch: pytest.MonkeyPatch):
    tenant_id = generate_id()
    runtime = SimpleNamespace(embedding_model="fake", embedding_dimensions=DIMENSIONS,
                              embedding_base_url="http://fake.invalid")
    state = SimpleNamespace(embedding_up=True, llm_calls=[], fail_when=None, runtime=runtime)

    async def embed(texts, _runtime):
        return [fake_vector(t) for t in texts] if state.embedding_up else None

    async def resolve(*_args, **_kwargs):
        return runtime

    class FakeProviders:
        def __init__(self, _settings):
            pass

        async def consolidate_memories(self, groups):
            state.llm_calls.append(groups)
            if state.fail_when and any(state.fail_when in note for group in groups for note in group):
                raise ProviderError("chat model unavailable")
            return ["CONSOLIDATED: " + " | ".join(group) for group in groups]

        async def close(self):
            pass

    await engine.dispose()
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    monkeypatch.setattr(settings, "memory_consolidation_threshold", 10)
    monkeypatch.setattr(settings, "memory_consolidation_target_ratio", 0.5)
    monkeypatch.setattr(memory, "_embed", embed)
    monkeypatch.setattr(memory, "resolve_settings", resolve)
    monkeypatch.setattr(memory_consolidation, "resolve_settings", resolve)
    monkeypatch.setattr(memory_consolidation, "Providers", FakeProviders)
    yield state
    async with Session() as db, db.begin():
        for model in (models.Memory, models.MemoryEvent, models.MemoryConsolidationRun, models.Job,
                      models.User, models.UserSession, models.ServiceConfiguration, models.ModelProfile):
            await db.execute(delete(model).where(model.tenant_id == tenant_id))
    await engine.dispose()


async def seed(user: str) -> dict[str, list[int]]:
    """Four clusters of three near-duplicates plus four singletons: 16 active against threshold 10."""
    clusters = []
    for group in range(4):
        clusters.append([int((await memory.add_memory(user, variant(group, extra), importance=3,
                                                      on_duplicate="insert"))["memory"]["id"])
                         for extra in range(3)])
    singles = []
    notes = ("likes hiking", "owns a cat", "drinks green tea", "plays chess")
    for importance, note in zip((1, 1, 2, 5), notes, strict=True):
        singles.append(int((await memory.add_memory(user, f"The user {note}", importance=importance))["memory"]["id"]))
    return {"clusters": clusters, "singles": singles}


async def active_count(user: str) -> int:
    return (await memory.list_memories(user, limit=1))["total"]


async def latest_run(run_id: int) -> models.MemoryConsolidationRun:
    async with Session() as db:
        return await db.scalar(select(models.MemoryConsolidationRun).where(
            models.MemoryConsolidationRun.id == run_id))


def test_find_groups_embedding_and_lexical_fallback() -> None:
    now = datetime.now(UTC)
    rows = [memory_consolidation.Row(i, variant(i // 3, i % 3), "fact", 3, now, fake_vector(variant(i // 3, i % 3)),
                                     "fake") for i in range(6)]
    groups = memory_consolidation.find_groups(rows, "fake", 0.85)
    assert sorted(sorted(row.id for row in group) for group in groups) == [[0, 1, 2], [3, 4, 5]]
    # Same texts but no usable embedding: grouped by category + token overlap instead.
    plain = [memory_consolidation.Row(r.id, r.content, r.category, 3, now) for r in rows]
    lexical = memory_consolidation.find_groups(plain, "fake", 0.85)
    assert sorted(sorted(row.id for row in group) for group in lexical) == [[0, 1, 2], [3, 4, 5]]
    other_category = [*plain[:2], memory_consolidation.Row(9, plain[2].content, "goal", 3, now)]
    assert [sorted(r.id for r in g) for g in memory_consolidation.find_groups(other_category, "fake", 0.85)] == [[0, 1]]


async def test_consolidate_memories_validates_the_model_schema(monkeypatch) -> None:
    from app.services.providers import Providers

    providers = Providers.__new__(Providers)  # only the JSON schema check is under test
    answers = iter([
        {"memories": [{"group": 1, "content": " second "}, {"group": 0, "content": "first"}]},
        {"memories": [{"group": 0, "content": "only one"}]},
        {"memories": [{"group": 0, "content": "a"}, {"group": 0, "content": "b"}]},
        {"memories": [{"group": 0, "content": " "}, {"group": 1, "content": "b"}]},
        {"content": "wrong shape"},
    ])

    async def complete(_messages):
        return next(answers), {}, 0.0

    monkeypatch.setattr(providers, "_complete", complete)
    assert await providers.consolidate_memories([["a", "b"], ["c", "d"]]) == ["first", "second"]
    for _ in range(4):
        with pytest.raises(ProviderError):
            await providers.consolidate_memories([["a", "b"], ["c", "d"]])


@needs_db
async def test_below_threshold_is_a_noop(world) -> None:
    for text in ("one fact", "two fact", "three fact"):
        await memory.add_memory("user:1", text)
    assert await memory_consolidation.users_over_threshold() == []
    outcome = await memory_consolidation.consolidate_user("user:1")
    assert outcome == {"before": 3, "after": 3, "groups": 0, "merged": 0, "archived": 0}
    run = await memory_consolidation.create_run("schedule")
    await memory_consolidation.execute_run(int(run["id"]))
    row = await latest_run(int(run["id"]))
    assert (row.status, row.users_processed, row.memories_merged, row.memories_archived) == ("completed", 0, 0, 0)
    assert row.finished_at is not None and row.error is None
    assert world.llm_calls == [] and await active_count("user:1") == 3


@needs_db
async def test_above_threshold_merges_then_archives_down_to_target(world) -> None:
    ids = await seed("user:1")
    await seed("user:2")
    for _ in range(2):  # a small user stays untouched
        await memory.add_memory("user:3", "small collection", on_duplicate="insert")
    assert await memory_consolidation.users_over_threshold() == [("user:1", 16), ("user:2", 16)]

    run = await memory_consolidation.create_run("schedule")
    await memory_consolidation.execute_run(int(run["id"]))
    row = await latest_run(int(run["id"]))
    assert (row.status, row.users_processed, row.error) == ("completed", 2, None)
    assert (row.memories_merged, row.memories_archived) == (24, 6)  # 4 groups of 3 + 3 archived per user

    assert await active_count("user:1") == 5 == memory_consolidation.target_for()  # threshold 10 * 0.5
    assert await active_count("user:3") == 2
    merged = (await memory.list_memories("user:1", status="merged"))["items"]
    assert len(merged) == 12 and {int(m["id"]) for m in merged} == {i for c in ids["clusters"] for i in c}
    active = (await memory.list_memories("user:1"))["items"]
    consolidated = [m for m in active if m["source"] == "merge"]
    assert len(consolidated) == 4 and all(m["content"].startswith("CONSOLIDATED: ") for m in consolidated)
    assert all(m["importance"] == 3 for m in consolidated)
    # The three lowest-value singletons (importance 1, 1, 2) were soft-deleted, the importance-5 one kept.
    deleted = (await memory.list_memories("user:1", status="deleted"))["items"]
    assert sorted(m["importance"] for m in deleted) == [1, 1, 2]
    assert ids["singles"][3] in {int(m["id"]) for m in active}

    source_events = await memory.memory_history("user:1", ids["clusters"][0][0])
    assert [e["action"] for e in source_events] == ["create", "merge"]
    assert source_events[1]["actor"] == "system:consolidation"
    assert source_events[1]["before"]["status"] == "active" and source_events[1]["after"]["status"] == "merged"
    target_history = await memory.memory_history("user:1", int(consolidated[0]["id"]))
    assert target_history[0]["action"] == "create" and target_history[0]["actor"] == "system:consolidation"
    archived_history = await memory.memory_history("user:1", int(deleted[0]["id"]))
    assert archived_history[-1]["action"] == "delete" and archived_history[-1]["actor"] == "system:consolidation"
    assert (await memory.restore_memory("user:1", int(deleted[0]["id"])))["status"] == "active"  # soft delete


@needs_db
async def test_llm_failure_skips_one_user_without_stopping_others(world) -> None:
    await seed("user:1")
    await seed("user:2")
    for extra in range(3):  # user:1 is larger (so it goes first) and owns the cluster that breaks the model
        await memory.add_memory("user:1", "poison " + variant(5, extra), on_duplicate="insert")
    world.fail_when = "poison"

    run = await memory_consolidation.create_run("schedule")
    await memory_consolidation.execute_run(int(run["id"]))
    row = await latest_run(int(run["id"]))
    assert row.status == "completed" and row.users_processed == 1
    assert row.error is not None and row.error.startswith("user:1: chat model unavailable")
    assert await active_count("user:1") == 19  # untouched: nothing is archived after a failure
    assert await active_count("user:2") == 5  # the other user was still consolidated


@needs_db
async def test_every_user_failing_marks_the_run_failed(world) -> None:
    await seed("user:1")
    world.fail_when = "w"  # every cluster word starts with "w"
    run = await memory_consolidation.create_run("schedule")
    await memory_consolidation.execute_run(int(run["id"]))
    row = await latest_run(int(run["id"]))
    assert row.status == "failed" and row.users_processed == 0 and "chat model unavailable" in row.error
    assert row.finished_at is not None and await active_count("user:1") == 16


@needs_db
async def test_lexical_fallback_without_embeddings(world) -> None:
    world.embedding_up = False
    await seed("user:1")
    assert (await memory.list_memories("user:1"))["items"][0]["has_embedding"] is False
    outcome = await memory_consolidation.consolidate_user("user:1")
    assert outcome["groups"] == 4 and outcome["merged"] == 12 and outcome["after"] == 5


@needs_db
async def test_only_one_run_at_a_time_due_and_recovery(world) -> None:
    assert await memory_consolidation.consolidation_due() is True
    first = await memory_consolidation.create_run("schedule")
    with pytest.raises(memory_consolidation.ConsolidationBusy):
        await memory_consolidation.create_run("manual")
    assert await memory_consolidation.run_scheduled() is False
    await memory_consolidation.recover_interrupted()
    row = await latest_run(int(first["id"]))
    assert row.status == "failed" and row.error == "Interrupted by worker restart"
    assert await memory_consolidation.consolidation_due() is False  # a run just started
    async with Session() as db, db.begin():
        await db.execute(update(models.MemoryConsolidationRun).values(
            started_at=datetime.now(UTC) - timedelta(minutes=settings.memory_consolidation_interval_minutes + 1)))
    assert await memory_consolidation.consolidation_due() is True
    assert await memory_consolidation.run_scheduled() is True


async def login(http: httpx.AsyncClient, username: str) -> None:
    response = await http.post("/api/auth/login", json={"username": username, "password": PASSWORD})
    assert response.status_code == 200, response.text


@needs_db
async def test_admin_api_manual_trigger_and_overview(world) -> None:
    async with Session() as db, db.begin():
        for username, role in (("root", "admin"), ("emp", "employee")):
            db.add(models.User(tenant_id=settings.tenant_id, username=username, display_name=username, role=role,
                               password_hash=hash_password(PASSWORD), must_change_password=False))
        await bootstrap_configuration(db)
    await seed("user:1")
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8010") as admin, \
            httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8010") as employee:
        await login(admin, "root")
        await login(employee, "emp")
        assert (await employee.post("/api/admin/memory/consolidate")).status_code == 403
        assert (await employee.get("/api/admin/memory/consolidation")).status_code == 403

        overview = (await admin.get("/api/admin/memory/consolidation")).json()
        assert overview["settings"] == {
            "enabled": True, "interval_minutes": 360, "threshold": 10, "target_ratio": 0.5, "target": 5,
            "similarity": 0.85, "batch_size": 10, "max_active_per_user": memory.MAX_ACTIVE_PER_USER}
        assert overview["runs"] == [] and overview["running"] is False
        assert overview["users_over_threshold"] == [{"user_id": "user:1", "active": 16}]

        started = await admin.post("/api/admin/memory/consolidate")
        assert started.status_code == 202, started.text
        run = started.json()
        assert run["status"] == "running" and run["trigger"] == "manual" and run["finished_at"] is None
        assert (await admin.post("/api/admin/memory/consolidate")).status_code == 409
        async with Session() as db:
            jobs = (await db.scalars(select(models.Job).where(models.Job.tenant_id == settings.tenant_id))).all()
        assert [(j.job_type, j.resource_id, j.status) for j in jobs] == [("consolidate", int(run["id"]), "queued")]
        assert (await admin.get("/api/admin/memory/consolidation")).json()["running"] is True

        # The worker's consolidate lane runs the queued job.
        from app.worker import process_job
        await process_job(jobs[0].id, "consolidate", int(run["id"]), {})
        runs = (await admin.get("/api/admin/memory/consolidation")).json()
        assert runs["running"] is False and runs["users_over_threshold"] == []
        assert [(r["id"], r["status"], r["users_processed"], r["memories_merged"], r["memories_archived"])
                for r in runs["runs"]] == [(run["id"], "completed", 1, 12, 3)]
        assert (await admin.post("/api/admin/memory/consolidate")).status_code == 202
