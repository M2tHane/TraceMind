"""Memory service against migrated PostgreSQL with a deterministic fake embedding.

RAG_DB_TEST=1 .venv/bin/python -m pytest -q tests/test_memory_postgres.py
Each test uses a fresh random tenant and deletes its rows afterwards. No model is called.
"""
import hashlib
import os
from types import SimpleNamespace

import pytest
from sqlalchemy import delete

from app.config import settings
from app.db import Session, engine, generate_id
from app.models import Memory, MemoryEvent
from app.services import memory
from app.services.ranking import tokenize

pytestmark = pytest.mark.skipif(os.getenv("RAG_DB_TEST") != "1" and os.getenv("RAG_CONFIG_DB_TEST") != "1",
                                reason="Opt-in PostgreSQL test")
DIMENSIONS = 64


def fake_vector(text: str) -> list[float]:
    vector = [0.0] * DIMENSIONS
    for token in tokenize(text):
        vector[int(hashlib.md5(token.encode()).hexdigest(), 16) % DIMENSIONS] += 1.0
    return vector


@pytest.fixture
async def tenant(monkeypatch: pytest.MonkeyPatch):
    tenant_id = generate_id()
    runtime = SimpleNamespace(embedding_model="fake", embedding_dimensions=DIMENSIONS,
                              embedding_base_url="http://fake.invalid")
    state = SimpleNamespace(embedding_up=True, merges=[], runtime=runtime)

    async def embed(texts, _runtime):
        return [fake_vector(t) for t in texts] if state.embedding_up else None

    async def resolve(*_args, **_kwargs):
        return runtime

    class FakeProviders:
        def __init__(self, _settings):
            pass

        async def merge_memories(self, notes):
            state.merges.append(notes)
            return " / ".join(notes)

        async def extract_memories(self, text, max_items):
            return [{"content": "User prefers concise answers", "category": "preference", "importance": 4}]

        async def close(self):
            pass

    # Each test runs on a fresh event loop; pooled asyncpg connections must not cross loops.
    await engine.dispose()
    monkeypatch.setattr(settings, "tenant_id", tenant_id)
    monkeypatch.setattr(memory, "_embed", embed)
    monkeypatch.setattr(memory, "resolve_settings", resolve)
    monkeypatch.setattr(memory, "Providers", FakeProviders)
    yield state
    async with Session() as db, db.begin():
        await db.execute(delete(Memory).where(Memory.tenant_id == tenant_id))
        await db.execute(delete(MemoryEvent).where(MemoryEvent.tenant_id == tenant_id))
    await engine.dispose()


async def test_add_dedupes_exact_and_semantic_duplicates(tenant):
    first = await memory.add_memory("alice", "Alice prefers Python and dark mode", category="preference",
                                    tags=["ui"])
    assert first["action"] == "created"
    exact = await memory.add_memory("alice", "  alice PREFERS python and dark mode ")
    assert exact["action"] == "duplicate" and exact["memory"]["id"] == first["memory"]["id"]
    similar = await memory.add_memory("alice", "Alice prefers Python and dark mode!", dedupe_threshold=0.9)
    assert similar["action"] == "duplicate"
    updated = await memory.add_memory("alice", "Alice prefers Python, dark mode", tags=["lang"],
                                      importance=5, on_duplicate="update", dedupe_threshold=0.8)
    assert updated["action"] == "updated"
    assert updated["memory"]["version"] == 2 and updated["memory"]["importance"] == 5
    assert set(updated["memory"]["tags"]) == {"ui", "lang"}
    forced = await memory.add_memory("alice", "Alice prefers Python, dark mode", on_duplicate="insert")
    assert forced["action"] == "created"


async def test_search_is_user_scoped_hybrid_and_tracks_access(tenant):
    await memory.add_memory("alice", "Alice is a backend engineer working with PostgreSQL", category="profile")
    await memory.add_memory("alice", "Alice likes hiking on weekends", category="preference")
    await memory.add_memory("bob", "Bob is a backend engineer working with PostgreSQL")
    found = await memory.search_memories("alice", "PostgreSQL engineer", top_k=1)
    assert found["mode"] == "hybrid" and found["searched"] == 2
    assert found["results"][0]["content"].startswith("Alice is a backend")
    assert found["results"][0]["user_id"] == "alice"
    listed = await memory.list_memories("alice")
    hits = {row["content"]: row["access_count"] for row in listed["items"]}
    assert hits["Alice is a backend engineer working with PostgreSQL"] == 1
    only_pref = await memory.search_memories("alice", "PostgreSQL", categories=["preference"])
    assert all(row["category"] == "preference" for row in only_pref["results"])


async def test_lexical_fallback_when_embedding_is_down(tenant):
    tenant.embedding_up = False
    created = await memory.add_memory("carol", "Carol owns the billing service")
    assert created["memory"]["has_embedding"] is False
    found = await memory.search_memories("carol", "billing")
    assert found["mode"] == "lexical" and found["results"][0]["content"] == "Carol owns the billing service"
    tenant.embedding_up = True
    assert (await memory.reembed_user("carol"))["reembedded"] == 1
    assert (await memory.search_memories("carol", "billing"))["mode"] == "hybrid"


async def test_update_uses_optimistic_version_and_records_history(tenant):
    created = (await memory.add_memory("dave", "Dave lives in Berlin"))["memory"]
    memory_id = int(created["id"])
    updated = await memory.update_memory("dave", memory_id, content="Dave lives in Munich", expected_version=1)
    assert updated["version"] == 2 and updated["content"] == "Dave lives in Munich"
    with pytest.raises(memory.MemoryError) as conflict:
        await memory.update_memory("dave", memory_id, content="Dave lives in Hamburg", expected_version=1)
    assert conflict.value.status == 409
    with pytest.raises(memory.MemoryError) as other_user:
        await memory.update_memory("erin", memory_id, importance=1)
    assert other_user.value.status == 404
    history = await memory.memory_history("dave", memory_id)
    assert [event["action"] for event in history] == ["create", "update"]
    assert history[1]["before"]["content"] == "Dave lives in Berlin"
    assert history[1]["after"]["content"] == "Dave lives in Munich"


async def test_merge_with_model_and_explicit_content(tenant):
    a = (await memory.add_memory("fay", "Fay uses vim", tags=["editor"], importance=2))["memory"]
    b = (await memory.add_memory("fay", "Fay writes Rust", tags=["lang"], importance=4))["memory"]
    merged = await memory.merge_memories("fay", [int(a["id"]), int(b["id"])])
    assert tenant.merges == [["Fay uses vim", "Fay writes Rust"]]
    target = merged["memory"]
    assert target["content"] == "Fay uses vim / Fay writes Rust" and target["importance"] == 4
    assert set(target["tags"]) == {"editor", "lang"} and target["source"] == "merge"
    sources = (await memory.list_memories("fay", status="merged"))["items"]
    assert {row["merged_into_id"] for row in sources} == {target["id"]}
    with pytest.raises(memory.MemoryError):
        await memory.merge_memories("fay", [int(a["id"]), int(target["id"])], content="x")
    c = (await memory.add_memory("fay", "Fay drinks tea"))["memory"]
    explicit = await memory.merge_memories("fay", [int(target["id"]), int(c["id"])],
                                           content="Fay: vim, Rust, tea", category="profile")
    assert explicit["memory"]["category"] == "profile" and len(tenant.merges) == 1


async def test_soft_delete_restore_purge_and_clear(tenant):
    row = (await memory.add_memory("gus", "Gus is on call this week"))["memory"]
    memory_id = int(row["id"])
    await memory.delete_memories("gus", [memory_id])
    assert (await memory.search_memories("gus", "on call"))["results"] == []
    assert (await memory.restore_memory("gus", memory_id))["status"] == "active"
    await memory.delete_memories("gus", [memory_id], hard=True)
    with pytest.raises(memory.MemoryError):
        await memory.get_memory("gus", memory_id)
    actions = [e["action"] for e in await memory.memory_history("gus", memory_id)]
    assert actions == ["create", "delete", "restore", "purge"]
    for text in ("one fact", "two fact", "three fact"):
        await memory.add_memory("gus", text, on_duplicate="insert")
    assert (await memory.clear_user("gus"))["deleted"] == 3
    assert (await memory.list_memories("gus"))["total"] == 0
    users = {u["user_id"]: u for u in await memory.list_users()}
    assert users["gus"]["active"] == 0 and users["gus"]["total"] == 3


async def test_extract_adds_with_dedupe_and_validates_user(tenant):
    result = await memory.extract_memories("hana", "I always want concise answers please")
    assert result["results"][0]["action"] == "created"
    again = await memory.extract_memories("hana", "Again: concise answers")
    assert again["results"][0]["action"] == "duplicate"
    with pytest.raises(memory.MemoryError):
        await memory.add_memory("bad user!", "x")

