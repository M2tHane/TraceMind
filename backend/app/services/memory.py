"""Long-term memory: store, deduplicate, search, update, merge, review and audit.

Memories live in a namespace (the ``user_id`` column): ``platform`` for organization-wide
memories every account reads, or ``user:<account id>`` for one employee's personal memories.
Employee proposals for the platform namespace wait in ``pending`` until an administrator
approves them; only ``active`` memories are ever searched or used in answers. Vectors
live next to the row in PostgreSQL (``REAL[]``) and are searched per user by exact
cosine similarity, which is precise and transactionally consistent for the
hundreds-to-thousands of memories one user owns. Search fuses vector and BM25
rankings with RRF; when embedding is unavailable, memories are still stored and
remain findable lexically.

Model calls (embedding, merge, extraction) never run inside a database transaction.
Every change appends a MemoryEvent with before/after snapshots.
"""
from __future__ import annotations

import hashlib
import re
import unicodedata
from datetime import UTC, datetime
from typing import Any, Literal

import numpy as np
from loguru import logger
from sqlalchemy import func, or_, select

from app.api.common import scoped, serialize
from app.config import Settings, settings
from app.db import Session, generate_id
from app.models import Memory, MemoryEvent
from app.services.configuration import resolve_settings
from app.services.providers import ProviderError, Providers
from app.services.ranking import bm25, rrf

CATEGORIES = ("preference", "profile", "fact", "goal", "instruction", "other")
Category = Literal["preference", "profile", "fact", "goal", "instruction", "other"]
OnDuplicate = Literal["skip", "update", "insert"]
MAX_CONTENT = 4000
MAX_ACTIVE_PER_USER = 10000
_USER_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.@:\-]{0,127}")


class MemoryError(ValueError):
    """Caller-safe memory failure; ``status`` maps onto an HTTP status code."""

    def __init__(self, message: str, status: int = 400) -> None:
        super().__init__(message)
        self.status = status


def valid_user(user_id: str) -> str:
    if not isinstance(user_id, str) or not _USER_RE.fullmatch(user_id):
        raise MemoryError("user_id 须为 1-128 位字母、数字或 _ . @ : -，且以字母或数字开头")
    return user_id


def _content(text: str) -> str:
    if not isinstance(text, str) or not text.strip():
        raise MemoryError("记忆内容不能为空")
    text = text.strip()
    if len(text) > MAX_CONTENT:
        raise MemoryError(f"单条记忆不能超过 {MAX_CONTENT} 个字符")
    return text


def _tags(tags: list[str] | None) -> list[str]:
    cleaned = list(dict.fromkeys(t.strip()[:50] for t in tags or [] if isinstance(t, str) and t.strip()))
    if len(cleaned) > 20:
        raise MemoryError("每条记忆最多 20 个标签")
    return cleaned


def _importance(value: int) -> int:
    if type(value) is not int or not 1 <= value <= 5:
        raise MemoryError("importance 须为 1 到 5 的整数")
    return value


def _category(value: str) -> str:
    if value not in CATEGORIES:
        raise MemoryError("category 须为 " + "/".join(CATEGORIES))
    return value


def content_hash(text: str) -> str:
    normalized = " ".join(unicodedata.normalize("NFKC", text).casefold().split())
    return hashlib.sha256(normalized.encode()).hexdigest()


def embedding_identity(runtime: Settings) -> str:
    return f"{runtime.embedding_model}@{runtime.embedding_dimensions}@{runtime.embedding_base_url}"


def memory_json(row: Memory, **extra: Any) -> dict[str, Any]:
    data = serialize(row, exclude={"content_hash", "embedding_model"})
    data["has_embedding"] = row.embedding is not None
    return {**data, **extra}


def _snapshot(row: Memory) -> dict[str, Any]:
    return serialize(row, exclude={"content_hash", "embedding_model", "access_count", "last_accessed_at"})


async def _record(db: Any, row: Memory, action: str, before: dict | None, actor: str) -> None:
    """Flush and reload server-generated columns, then append the audit event."""
    after = None
    if action != "purge":
        await db.flush()
        await db.refresh(row)
        after = _snapshot(row)
    db.add(MemoryEvent(tenant_id=settings.tenant_id, memory_id=row.id, user_id=row.user_id, action=action,
                       before=before, after=after, actor=actor[:50]))


def _active(user_id: str) -> Any:
    now = datetime.now(UTC)
    return scoped(Memory).where(Memory.user_id == user_id, Memory.status == "active",
                                or_(Memory.expires_at.is_(None), Memory.expires_at > now))


async def _embed(texts: list[str], runtime: Settings) -> list[list[float]] | None:
    """Embed or return None; memory writes must not fail because embedding is down."""
    providers = Providers(runtime)
    try:
        vectors, _ = await providers.embed(texts)
        return vectors
    except ProviderError as error:
        logger.warning("Memory embedding unavailable; falling back to lexical only: {}", error)
        return None
    finally:
        await providers.close()


def _cosine(query: list[float], rows: list[Memory]) -> np.ndarray:
    matrix = np.asarray([row.embedding for row in rows], dtype=np.float32)
    vector = np.asarray(query, dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1) * (np.linalg.norm(vector) or 1.0)
    return (matrix @ vector) / np.where(norms == 0, 1.0, norms)


async def _owned(db: Any, user_id: str, memory_id: int, lock: bool = False) -> Memory:
    statement = scoped(Memory).where(Memory.id == memory_id, Memory.user_id == user_id)
    if lock:
        statement = statement.with_for_update()
    row = await db.scalar(statement)
    if row is None:
        raise MemoryError("记忆不存在", 404)
    return row


async def add_memory(
    user_id: str, content: str, *, category: str = "other", tags: list[str] | None = None,
    importance: int = 3, attributes: dict | None = None, expires_at: datetime | None = None,
    source: str = "api", on_duplicate: OnDuplicate = "skip", dedupe_threshold: float = 0.92,
    runtime: Settings | None = None, created_by: int | None = None, pending: bool = False,
) -> dict[str, Any]:
    """Create a memory unless an equivalent active one exists (see ``on_duplicate``).

    ``pending`` stores a proposal awaiting review; it is never merged into an existing memory.
    """
    user_id, content = valid_user(user_id), _content(content)
    category, tags, importance = _category(category), _tags(tags), _importance(importance)
    if on_duplicate not in ("skip", "update", "insert") or not 0.5 <= dedupe_threshold <= 1.0:
        raise MemoryError("on_duplicate 须为 skip/update/insert，dedupe_threshold 须在 0.5-1 之间")
    runtime = runtime or await resolve_settings()
    identity = embedding_identity(runtime)
    vectors = await _embed([content], runtime)
    vector = vectors[0] if vectors else None
    digest = content_hash(content)
    async with Session() as db, db.begin():
        duplicate, similarity = None, None
        if on_duplicate != "insert":
            duplicate = await db.scalar(_active(user_id).where(Memory.content_hash == digest).limit(1))
            similarity = 1.0 if duplicate else None
            if duplicate is None and vector is not None:
                candidates = list((await db.scalars(_active(user_id).where(
                    Memory.embedding_model == identity, Memory.embedding.is_not(None)))).all())
                if candidates:
                    scores = _cosine(vector, candidates)
                    best = int(np.argmax(scores))
                    if float(scores[best]) >= dedupe_threshold:
                        duplicate, similarity = candidates[best], round(float(scores[best]), 4)
        if duplicate is not None and (on_duplicate == "skip" or pending):
            return {"action": "duplicate", "similarity": similarity, "memory": memory_json(duplicate)}
        if duplicate is not None:
            row = await _owned(db, user_id, duplicate.id, lock=True)
            before = _snapshot(row)
            row.content, row.content_hash = content, digest
            row.embedding, row.embedding_model = vector, identity if vector is not None else ""
            row.tags = list(dict.fromkeys([*row.tags, *tags]))
            row.importance, row.version = max(row.importance, importance), row.version + 1
            row.attributes = {**row.attributes, **(attributes or {})}
            if expires_at is not None:
                row.expires_at = expires_at
            await _record(db, row, "update", before, source)
            return {"action": "updated", "similarity": similarity, "memory": memory_json(row)}
        active = await db.scalar(select(func.count(Memory.id)).where(
            Memory.tenant_id == settings.tenant_id, Memory.user_id == user_id, Memory.status == "active"))
        if active >= MAX_ACTIVE_PER_USER:
            raise MemoryError("该用户的有效记忆数量已达上限，请先合并或删除", 409)
        row = Memory(id=generate_id(), tenant_id=settings.tenant_id, user_id=user_id, content=content,
                     category=category, tags=tags, importance=importance, source=source[:50],
                     attributes=attributes or {}, content_hash=digest, embedding=vector,
                     embedding_model=identity if vector is not None else "", expires_at=expires_at,
                     status="pending" if pending else "active", version=1, access_count=0,
                     scope="platform" if user_id == "platform" else "personal", created_by=created_by)
        db.add(row)
        await _record(db, row, "create", None, source)
        return {"action": "pending" if pending else "created", "similarity": similarity, "memory": memory_json(row)}


async def search_memories(
    user_id: str, query: str, *, top_k: int = 5, categories: list[str] | None = None,
    tags: list[str] | None = None, min_importance: int | None = None, min_similarity: float | None = None,
    runtime: Settings | None = None, touch: bool = True,
) -> dict[str, Any]:
    """Hybrid (cosine + BM25, RRF) search over one user's active memories."""
    user_id = valid_user(user_id)
    if not isinstance(query, str) or not query.strip():
        raise MemoryError("查询不能为空")
    if not 1 <= top_k <= 50:
        raise MemoryError("top_k 须在 1-50 之间")
    runtime = runtime or await resolve_settings()
    identity = embedding_identity(runtime)
    vectors = await _embed([query.strip()], runtime)
    async with Session() as db, db.begin():
        statement = _active(user_id)
        if categories:
            statement = statement.where(Memory.category.in_([_category(c) for c in categories]))
        if min_importance is not None:
            statement = statement.where(Memory.importance >= _importance(min_importance))
        rows = list((await db.scalars(statement.order_by(Memory.id))).all())
        wanted = set(_tags(tags))
        if wanted:
            rows = [row for row in rows if wanted & set(row.tags)]
        by_id = {str(row.id): row for row in rows}
        docs = [{"id": str(row.id), "text": row.content} for row in rows]
        lexical = bm25(query, docs, max(top_k * 4, 20))
        dense: list[dict[str, Any]] = []
        similarity: dict[str, float] = {}
        embedded = [row for row in rows if row.embedding is not None and row.embedding_model == identity]
        if vectors and embedded:
            scores = _cosine(vectors[0], embedded)
            for row, score in zip(embedded, scores, strict=True):
                similarity[str(row.id)] = round(float(score), 4)
            dense = sorted(({"id": str(row.id), "text": row.content, "score": float(score)}
                            for row, score in zip(embedded, scores, strict=True)
                            if min_similarity is None or score >= min_similarity),
                           key=lambda item: item["score"], reverse=True)[:max(top_k * 4, 20)]
        fused = rrf([dense, lexical], limit=max(top_k * 4, 20)) if dense or lexical else []
        for item in fused:
            # Importance nudges ordering by at most +/-10% without overriding relevance.
            item["score"] *= 1 + 0.05 * (by_id[item["id"]].importance - 3)
        fused = sorted(fused, key=lambda item: item["score"], reverse=True)[:top_k]
        results = [memory_json(by_id[item["id"]], score=round(item["score"], 6),
                               similarity=similarity.get(item["id"])) for item in fused]
        if touch:
            now = datetime.now(UTC)
            for item in fused:
                row = by_id[item["id"]]
                row.access_count, row.last_accessed_at = row.access_count + 1, now
        return {"results": results, "searched": len(rows),
                "mode": "hybrid" if vectors and embedded else "lexical",
                "unembedded": len(rows) - len(embedded)}


async def list_memories(
    user_id: str, *, status: str = "active", category: str | None = None, tag: str | None = None,
    limit: int = 50, offset: int = 0, created_by: int | None = None,
) -> dict[str, Any]:
    user_id = valid_user(user_id)
    if status not in ("active", "pending", "rejected", "merged", "deleted", "all") or not 1 <= limit <= 500 \
            or offset < 0:
        raise MemoryError("status 须为 active/pending/rejected/merged/deleted/all，limit 须在 1-500 之间")
    async with Session() as db:
        statement = scoped(Memory).where(Memory.user_id == user_id)
        if status != "all":
            statement = statement.where(Memory.status == status)
        if category:
            statement = statement.where(Memory.category == _category(category))
        if tag:
            statement = statement.where(Memory.tags.contains([tag]))
        if created_by is not None:
            statement = statement.where(Memory.created_by == created_by)
        total = await db.scalar(select(func.count()).select_from(statement.subquery()))
        rows = (await db.scalars(statement.order_by(Memory.updated_at.desc(), Memory.id.desc())
                                 .limit(limit).offset(offset))).all()
        return {"total": total, "items": [memory_json(row) for row in rows]}


async def get_memory(user_id: str, memory_id: int) -> dict[str, Any]:
    async with Session() as db:
        return memory_json(await _owned(db, valid_user(user_id), memory_id))


async def update_memory(
    user_id: str, memory_id: int, *, content: str | None = None, category: str | None = None,
    tags: list[str] | None = None, importance: int | None = None, attributes: dict | None = None,
    expires_at: datetime | None = None, clear_expiry: bool = False, expected_version: int | None = None,
    actor: str = "api", runtime: Settings | None = None,
) -> dict[str, Any]:
    """Patch an active memory; content changes re-embed and bump ``version``."""
    user_id = valid_user(user_id)
    vector, identity = None, ""
    if content is not None:
        content = _content(content)
        runtime = runtime or await resolve_settings()
        identity = embedding_identity(runtime)
        vectors = await _embed([content], runtime)
        vector = vectors[0] if vectors else None
    async with Session() as db, db.begin():
        row = await _owned(db, user_id, memory_id, lock=True)
        if row.status != "active":
            raise MemoryError("只能修改有效状态的记忆", 409)
        if expected_version is not None and row.version != expected_version:
            raise MemoryError(f"记忆已被修改（当前版本 {row.version}），请重新读取后再更新", 409)
        before = _snapshot(row)
        if content is not None and content != row.content:
            row.content, row.content_hash = content, content_hash(content)
            row.embedding, row.embedding_model = vector, identity if vector is not None else ""
            row.version += 1
        if category is not None:
            row.category = _category(category)
        if tags is not None:
            row.tags = _tags(tags)
        if importance is not None:
            row.importance = _importance(importance)
        if attributes is not None:
            row.attributes = {**row.attributes, **attributes}
        if clear_expiry:
            row.expires_at = None
        elif expires_at is not None:
            row.expires_at = expires_at
        await _record(db, row, "update", before, actor)
        return memory_json(row)


async def delete_memories(user_id: str, memory_ids: list[int], *, hard: bool = False,
                          actor: str = "api") -> dict[str, Any]:
    """Soft delete (restorable) or permanently purge memories; audit events are kept either way."""
    user_id = valid_user(user_id)
    if not 1 <= len(memory_ids) <= 200:
        raise MemoryError("一次可删除 1-200 条记忆")
    async with Session() as db, db.begin():
        rows = [await _owned(db, user_id, memory_id, lock=True) for memory_id in dict.fromkeys(memory_ids)]
        for row in rows:
            before = _snapshot(row)
            if hard:
                await _record(db, row, "purge", before, actor)
                await db.delete(row)
            elif row.status != "deleted":
                row.status = "deleted"
                await _record(db, row, "delete", before, actor)
        return {"deleted": [str(row.id) for row in rows], "hard": hard}


async def restore_memory(user_id: str, memory_id: int, actor: str = "api") -> dict[str, Any]:
    async with Session() as db, db.begin():
        row = await _owned(db, valid_user(user_id), memory_id, lock=True)
        if row.status != "deleted":
            raise MemoryError("只有已删除的记忆可以恢复", 409)
        before = _snapshot(row)
        row.status = "active"
        await _record(db, row, "restore", before, actor)
        return memory_json(row)


async def merge_memories(
    user_id: str, memory_ids: list[int], *, content: str | None = None, category: str | None = None,
    tags: list[str] | None = None, importance: int | None = None, actor: str = "api",
    runtime: Settings | None = None,
) -> dict[str, Any]:
    """Merge 2+ active memories into a new one; sources become ``merged`` and point at it.

    Without explicit ``content`` the chat model consolidates the notes (may incur cost).
    """
    user_id = valid_user(user_id)
    ids = list(dict.fromkeys(memory_ids))
    if not 2 <= len(ids) <= 50:
        raise MemoryError("合并需要 2-50 条不同的记忆")
    async with Session() as db:
        sources = [await _owned(db, user_id, memory_id) for memory_id in ids]
        if any(row.status != "active" for row in sources):
            raise MemoryError("只能合并有效状态的记忆", 409)
        versions = {row.id: row.version for row in sources}
        ordered = sorted(sources, key=lambda row: row.created_at)
        notes = [row.content for row in ordered]
        merged_tags = list(dict.fromkeys(tag for row in ordered for tag in row.tags))
        merged_importance = max(row.importance for row in ordered)
        merged_category = ordered[-1].category
        merged_attributes = {k: v for row in ordered for k, v in row.attributes.items()}
    runtime = runtime or await resolve_settings()
    if content is None:
        providers = Providers(runtime)
        try:
            content = await providers.merge_memories(notes)
        finally:
            await providers.close()
    content = _content(content)
    identity = embedding_identity(runtime)
    vectors = await _embed([content], runtime)
    async with Session() as db, db.begin():
        locked = [await _owned(db, user_id, memory_id, lock=True) for memory_id in ids]
        if any(row.status != "active" or row.version != versions[row.id] for row in locked):
            raise MemoryError("待合并的记忆在合并期间被修改，请重试", 409)
        target = Memory(id=generate_id(), tenant_id=settings.tenant_id, user_id=user_id, content=content,
                        category=_category(category) if category else merged_category,
                        tags=_tags(tags) if tags is not None else merged_tags,
                        importance=_importance(importance) if importance is not None else merged_importance,
                        source="merge", attributes={**merged_attributes, "merged_from": [str(i) for i in ids]},
                        scope="platform" if user_id == "platform" else "personal",
                        content_hash=content_hash(content), embedding=vectors[0] if vectors else None,
                        embedding_model=identity if vectors else "", status="active", version=1, access_count=0)
        db.add(target)
        await _record(db, target, "create", None, actor)
        for row in locked:
            before = _snapshot(row)
            row.status, row.merged_into_id = "merged", target.id
            await _record(db, row, "merge", before, actor)
        return {"memory": memory_json(target), "merged": [str(i) for i in ids]}


async def memory_history(user_id: str, memory_id: int) -> list[dict[str, Any]]:
    user_id = valid_user(user_id)
    async with Session() as db:
        rows = (await db.scalars(scoped(MemoryEvent).where(
            MemoryEvent.memory_id == memory_id, MemoryEvent.user_id == user_id,
        ).order_by(MemoryEvent.id))).all()
        if not rows:
            raise MemoryError("记忆不存在或没有历史", 404)
        return [serialize(row) for row in rows]


async def extract_memories(user_id: str, text: str, *, max_items: int = 10, dedupe_threshold: float = 0.92,
                           actor: str = "extract", dry_run: bool = False) -> dict[str, Any]:
    """Let the chat model pull durable facts from conversation text, then add them with dedupe."""
    user_id = valid_user(user_id)
    if not isinstance(text, str) or not text.strip() or len(text) > 50000:
        raise MemoryError("待抽取文本须为 1-50000 个字符")
    if not 1 <= max_items <= 30:
        raise MemoryError("max_items 须在 1-30 之间")
    runtime = await resolve_settings()
    providers = Providers(runtime)
    try:
        candidates = await providers.extract_memories(text, max_items)
    finally:
        await providers.close()
    if dry_run:
        return {"candidates": candidates, "results": []}
    results = [await add_memory(user_id, item["content"], category=item["category"], importance=item["importance"],
                                source=actor, dedupe_threshold=dedupe_threshold, runtime=runtime)
               for item in candidates]
    return {"candidates": candidates, "results": results}


async def list_users(limit: int = 200) -> list[dict[str, Any]]:
    async with Session() as db:
        rows = (await db.execute(select(
            Memory.user_id, func.count(Memory.id).filter(Memory.status == "active"),
            func.count(Memory.id), func.max(Memory.updated_at),
        ).where(Memory.tenant_id == settings.tenant_id).group_by(Memory.user_id)
            .order_by(func.max(Memory.updated_at).desc()).limit(limit))).all()
        return [{"user_id": user_id, "active": active, "total": total, "updated_at": updated.isoformat()}
                for user_id, active, total, updated in rows]


async def clear_user(user_id: str, *, hard: bool = False, actor: str = "api") -> dict[str, Any]:
    """Delete every memory of one user: soft-deletes active ones, or purges everything with ``hard``."""
    user_id = valid_user(user_id)
    async with Session() as db:
        statement = select(Memory.id).where(Memory.tenant_id == settings.tenant_id, Memory.user_id == user_id)
        if not hard:
            # Merged sources stay linked to their merge target; restoring them would duplicate it.
            statement = statement.where(Memory.status == "active")
        ids = list((await db.scalars(statement)).all())
    total = 0
    for start in range(0, len(ids), 200):
        batch = ids[start:start + 200]
        await delete_memories(user_id, batch, hard=hard, actor=actor)
        total += len(batch)
    return {"user_id": user_id, "deleted": total, "hard": hard}


async def reembed_user(user_id: str) -> dict[str, Any]:
    """Embed active memories that lack a vector for the current embedding configuration."""
    user_id = valid_user(user_id)
    runtime = await resolve_settings()
    identity = embedding_identity(runtime)
    async with Session() as db:
        rows = list((await db.scalars(_active(user_id).where(
            or_(Memory.embedding.is_(None), Memory.embedding_model != identity)))).all())
        pending = {row.id: row.content for row in rows}
    updated = 0
    items = list(pending.items())
    for start in range(0, len(items), 64):
        batch = items[start:start + 64]
        vectors = await _embed([content for _, content in batch], runtime)
        if vectors is None:
            raise MemoryError("Embedding 服务不可用，无法重建记忆向量", 503)
        async with Session() as db, db.begin():
            for (memory_id, content), vector in zip(batch, vectors, strict=True):
                row = await _owned(db, user_id, memory_id, lock=True)
                if row.content == content:
                    row.embedding, row.embedding_model = vector, identity
                    updated += 1
    return {"user_id": user_id, "reembedded": updated, "pending": len(items)}


async def memories_for_answer(user_id: str, question: str, *, runtime: Settings | None = None,
                              relevant_k: int = 5, min_similarity: float = 0.35, standing_k: int = 3,
                              include_platform: bool = True) -> list[str]:
    """Memories that should personalize one answer: the user's own plus platform memories.

    Standing preferences/instructions apply to every question, so the most important ones
    are always included. Other memories must be relevant: a lexical match, or vector
    similarity of at least ``min_similarity``.
    """
    chosen = await _namespace_memories(user_id, question, runtime, relevant_k, min_similarity, standing_k)
    if include_platform and user_id != "platform":
        for content in await _namespace_memories("platform", question, runtime, relevant_k, min_similarity,
                                                 standing_k):
            if content not in chosen:
                chosen.append(content)
    return chosen


async def _namespace_memories(user_id: str, question: str, runtime: Settings | None, relevant_k: int,
                              min_similarity: float, standing_k: int) -> list[str]:
    found = await search_memories(user_id, question, top_k=relevant_k, runtime=runtime)
    relevant = [row for row in found["results"]
                if row["similarity"] is None or row["similarity"] >= min_similarity]
    async with Session() as db:
        standing = (await db.scalars(_active(valid_user(user_id)).where(
            Memory.category.in_(("preference", "instruction")),
        ).order_by(Memory.importance.desc(), Memory.updated_at.desc()).limit(standing_k))).all()
    chosen = {row["id"]: row["content"] for row in relevant}
    for row in standing:
        chosen.setdefault(str(row.id), row.content)
    return list(chosen.values())


async def pending_platform_memories(limit: int = 200) -> list[dict[str, Any]]:
    async with Session() as db:
        rows = (await db.scalars(scoped(Memory).where(Memory.user_id == "platform", Memory.status == "pending")
                                 .order_by(Memory.id).limit(limit))).all()
        return [memory_json(row) for row in rows]


async def review_memory(memory_id: int, *, approve: bool, reviewer_id: int, note: str = "") -> dict[str, Any]:
    """Approve or reject a pending platform memory proposal."""
    async with Session() as db, db.begin():
        row = await _owned(db, "platform", memory_id, lock=True)
        if row.status != "pending":
            raise MemoryError("该平台记忆不在待审批状态", 409)
        before = _snapshot(row)
        row.status, row.reviewed_by = ("active" if approve else "rejected"), reviewer_id
        if note:
            row.attributes = {**row.attributes, "review_note": note[:500]}
        await _record(db, row, "approve" if approve else "reject", before, f"user:{reviewer_id}")
        return memory_json(row)
