"""Scheduled LLM consolidation that keeps each user's memory collection below a threshold.

For every user whose active memories exceed ``memory_consolidation_threshold``:

1. Near-duplicate or closely related memories are grouped (cosine similarity of the stored
   embeddings; memories without a current embedding fall back to category + lexical overlap).
2. The chat model rewrites each group into one memory, applied through ``merge_memories`` so
   sources become ``merged`` and every change is a MemoryEvent by ``system:consolidation``.
3. If the user is still above the target (``threshold * target_ratio``), the lowest-value
   memories (low importance, rarely used, least recently touched) are soft-deleted, which
   stays restorable.

Model calls never run inside a database transaction. A failing user never stops the others.
Each run is recorded in ``memory_consolidation_runs``; at most one run is ``running`` per tenant
(enforced by a partial unique index), which is what makes a manual trigger answer 409.
The worker supervisor schedules runs; a manual run is queued as a ``consolidate`` job.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import numpy as np
from loguru import logger
from sqlalchemy import func, select, update
from sqlalchemy.exc import IntegrityError

from app.api.common import enqueue, scoped, serialize
from app.config import settings
from app.db import Session
from app.models import Memory, MemoryConsolidationRun
from app.services import memory
from app.services.configuration import resolve_settings
from app.services.providers import ProviderError, Providers
from app.services.ranking import tokenize

ACTOR = "system:consolidation"
MAX_GROUP = 8
LEXICAL_SIMILARITY = 0.6
MAX_LEXICAL_ROWS = 2000


class ConsolidationBusy(RuntimeError):
    """A consolidation run is already in progress."""


@dataclass
class Row:
    id: int
    content: str
    category: str
    importance: int
    created_at: datetime
    embedding: list[float] | None = None
    embedding_model: str = ""


def target_for(threshold: int | None = None, ratio: float | None = None) -> int:
    threshold = settings.memory_consolidation_threshold if threshold is None else threshold
    ratio = settings.memory_consolidation_target_ratio if ratio is None else ratio
    return max(1, min(threshold, int(threshold * ratio)))


def config_json() -> dict[str, Any]:
    return {"enabled": settings.memory_consolidation_enabled,
            "interval_minutes": settings.memory_consolidation_interval_minutes,
            "threshold": settings.memory_consolidation_threshold,
            "target_ratio": settings.memory_consolidation_target_ratio,
            "target": target_for(),
            "similarity": settings.memory_consolidation_similarity,
            "batch_size": settings.memory_consolidation_batch_size,
            "max_active_per_user": memory.MAX_ACTIVE_PER_USER}


# ---------------------------------------------------------------- grouping


def _embedding_groups(rows: list[Row], similarity: float) -> list[tuple[list[Row], float]]:
    """Greedy seed clustering: no chaining, groups never exceed ``MAX_GROUP``."""
    if len(rows) < 2:
        return []
    matrix = np.asarray([row.embedding for row in rows], dtype=np.float32)
    norms = np.linalg.norm(matrix, axis=1)
    matrix = matrix / np.where(norms == 0, 1.0, norms)[:, None]
    free = np.ones(len(rows), dtype=bool)
    groups: list[tuple[list[Row], float]] = []
    for seed in sorted(range(len(rows)), key=lambda i: (-rows[i].importance, rows[i].id)):
        if not free[seed]:
            continue
        scores = matrix @ matrix[seed]
        scores[~free] = -1.0
        scores[seed] = -1.0
        near = np.flatnonzero(scores >= similarity)
        if near.size == 0:
            continue
        near = near[np.argsort(-scores[near])][:MAX_GROUP - 1]
        members = [seed, *near.tolist()]
        free[members] = False
        groups.append(([rows[i] for i in members], float(np.mean(scores[near]))))
    return groups


def _lexical_groups(rows: list[Row]) -> list[tuple[list[Row], float]]:
    """Same-category memories with high token overlap (Jaccard) when no embedding is available."""
    groups: list[tuple[list[Row], float]] = []
    by_category: dict[str, list[Row]] = {}
    for row in rows[:MAX_LEXICAL_ROWS]:
        by_category.setdefault(row.category, []).append(row)
    for members in by_category.values():
        tokens = {row.id: set(tokenize(row.content)) for row in members}
        free = {row.id for row in members if tokens[row.id]}
        for seed in sorted(members, key=lambda row: (-row.importance, row.id)):
            if seed.id not in free:
                continue
            scored = []
            for other in members:
                if other.id == seed.id or other.id not in free:
                    continue
                union = len(tokens[seed.id] | tokens[other.id])
                score = len(tokens[seed.id] & tokens[other.id]) / union if union else 0.0
                if score >= LEXICAL_SIMILARITY:
                    scored.append((score, other))
            if not scored:
                continue
            scored.sort(key=lambda item: -item[0])
            scored = scored[:MAX_GROUP - 1]
            chosen = [seed, *(other for _, other in scored)]
            free -= {row.id for row in chosen}
            groups.append((chosen, sum(score for score, _ in scored) / len(scored)))
    return groups


def find_groups(rows: list[Row], identity: str, similarity: float) -> list[list[Row]]:
    """Groups of 2+ related memories, biggest and tightest first."""
    embedded = [row for row in rows if row.embedding is not None and row.embedding_model == identity]
    dimensions = {len(row.embedding) for row in embedded}
    if len(dimensions) > 1:
        usable = max(dimensions, key=lambda size: sum(len(row.embedding) == size for row in embedded))
        embedded = [row for row in embedded if len(row.embedding) == usable]
    taken = {row.id for row in embedded}
    groups = _embedding_groups(embedded, similarity) + _lexical_groups([row for row in rows if row.id not in taken])
    groups.sort(key=lambda item: (-len(item[0]), -item[1]))
    return [members for members, _ in groups]


# ---------------------------------------------------------------- one user


async def users_over_threshold(threshold: int | None = None) -> list[tuple[str, int]]:
    threshold = settings.memory_consolidation_threshold if threshold is None else threshold
    async with Session() as db:
        count = func.count(Memory.id)
        rows = (await db.execute(select(Memory.user_id, count).where(
            Memory.tenant_id == settings.tenant_id, Memory.status == "active",
        ).group_by(Memory.user_id).having(count > threshold).order_by(count.desc(), Memory.user_id))).all()
    return [(user_id, total) for user_id, total in rows]


async def _active_count(user_id: str) -> int:
    async with Session() as db:
        return await db.scalar(select(func.count(Memory.id)).where(
            Memory.tenant_id == settings.tenant_id, Memory.user_id == user_id, Memory.status == "active")) or 0


async def consolidate_user(user_id: str, runtime: Any | None = None) -> dict[str, int]:
    """Merge related memories, then archive the least valuable until the user is at the target.

    Returns ``{"before", "after", "groups", "merged", "archived"}``. Raises on model failures so
    the caller can record them; nothing is archived after such a failure.
    """
    user_id = memory.valid_user(user_id)
    threshold, target = settings.memory_consolidation_threshold, target_for()
    async with Session() as db:
        found = (await db.scalars(scoped(Memory).where(Memory.user_id == user_id, Memory.status == "active")
                                  .order_by(Memory.id))).all()
        rows = [Row(m.id, m.content, m.category, m.importance, m.created_at, m.embedding, m.embedding_model)
                for m in found]
    result = {"before": len(rows), "after": len(rows), "groups": 0, "merged": 0, "archived": 0}
    if len(rows) <= threshold:
        return result
    runtime = runtime or await resolve_settings()
    identity = memory.embedding_identity(runtime)

    # 1+2: merge related memories, biggest groups first, only as many as needed to reach the target.
    need = len(rows) - target
    chosen: list[list[Row]] = []
    for members in find_groups(rows, identity, settings.memory_consolidation_similarity):
        if need <= 0:
            break
        chosen.append(members)
        need -= len(members) - 1
    batch_size = max(1, settings.memory_consolidation_batch_size)
    for start in range(0, len(chosen), batch_size):
        batch = chosen[start:start + batch_size]
        notes = [[row.content for row in sorted(group, key=lambda r: (r.created_at, r.id))] for group in batch]
        providers = Providers(runtime)
        try:
            contents = await providers.consolidate_memories(notes)
        finally:
            await providers.close()
        for group, content in zip(batch, contents, strict=True):
            try:
                await memory.merge_memories(user_id, [row.id for row in group], content=content, actor=ACTOR,
                                            runtime=runtime)
            except memory.MemoryError as error:
                # Edited meanwhile, or an unusable model answer: leave this group alone.
                logger.warning("Consolidation skipped a group for {}: {}", user_id, error)
                continue
            result["groups"] += 1
            result["merged"] += len(group)

    # 3: still above the target, soft-delete the least valuable memories (restorable).
    remaining = await _active_count(user_id)
    result["after"] = remaining
    if remaining > target:
        async with Session() as db:
            victims = list((await db.scalars(
                select(Memory.id).where(Memory.tenant_id == settings.tenant_id, Memory.user_id == user_id,
                                        Memory.status == "active")
                .order_by(Memory.importance, Memory.access_count,
                          func.coalesce(Memory.last_accessed_at, Memory.updated_at), Memory.id)
                .limit(remaining - target))).all())
        for start in range(0, len(victims), 200):
            await memory.delete_memories(user_id, victims[start:start + 200], actor=ACTOR)
        result["archived"] = len(victims)
        result["after"] = await _active_count(user_id)
    return result


# ---------------------------------------------------------------- runs


async def create_run(trigger: str) -> dict[str, Any]:
    """Insert a ``running`` run (manual runs also queue their job); raises ``ConsolidationBusy``."""
    if trigger not in ("schedule", "manual"):
        raise ValueError("trigger must be schedule or manual")
    try:
        async with Session() as db, db.begin():
            run = MemoryConsolidationRun(tenant_id=settings.tenant_id, status="running", trigger=trigger,
                                         users_processed=0, memories_merged=0, memories_archived=0)
            db.add(run)
            await db.flush()
            await db.refresh(run)
            if trigger == "manual":
                enqueue(db, "consolidate", run.id)
            return serialize(run)
    except IntegrityError:
        raise ConsolidationBusy("已有一个记忆整理任务正在运行") from None


async def _finish(run_id: int, status: str, error: str | None, **counters: int) -> None:
    async with Session() as db, db.begin():
        await db.execute(update(MemoryConsolidationRun).where(
            MemoryConsolidationRun.tenant_id == settings.tenant_id, MemoryConsolidationRun.id == run_id,
        ).values(status=status, error=error, finished_at=datetime.now(UTC), **counters))


def _reason(error: Exception) -> str:
    return str(error)[:300] if isinstance(error, (ProviderError, memory.MemoryError)) else "处理失败，详见服务端日志"


async def execute_run(run_id: int) -> None:
    """Consolidate every user over the threshold and record the outcome; never raises (except cancel)."""
    users = merged = archived = 0
    failures: list[str] = []
    try:
        candidates = await users_over_threshold()
        runtime = await resolve_settings() if candidates else None
        for user_id, total in candidates:
            try:
                outcome = await consolidate_user(user_id, runtime)
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.opt(exception=True).error("Memory consolidation failed for {} ({} active)", user_id, total)
                failures.append(f"{user_id}: {_reason(error)}")
                continue
            users, merged, archived = users + 1, merged + outcome["merged"], archived + outcome["archived"]
            logger.info("Consolidated {}: {} -> {} active ({} merged, {} archived)", user_id, outcome["before"],
                        outcome["after"], outcome["merged"], outcome["archived"])
            async with Session() as db, db.begin():
                await db.execute(update(MemoryConsolidationRun).where(
                    MemoryConsolidationRun.tenant_id == settings.tenant_id, MemoryConsolidationRun.id == run_id,
                ).values(users_processed=users, memories_merged=merged, memories_archived=archived))
        status = "failed" if failures and not users else "completed"
        await _finish(run_id, status, "; ".join(failures)[:1000] or None, users_processed=users,
                      memories_merged=merged, memories_archived=archived)
    except asyncio.CancelledError:
        raise
    except Exception as error:
        logger.opt(exception=True).error("Memory consolidation run {} failed", run_id)
        await _finish(run_id, "failed", _reason(error), users_processed=users, memories_merged=merged,
                      memories_archived=archived)


async def consolidation_due() -> bool:
    """True when the newest run (of any trigger) started at least one interval ago."""
    interval = timedelta(minutes=max(1, settings.memory_consolidation_interval_minutes))
    async with Session() as db:
        latest = await db.scalar(select(func.max(MemoryConsolidationRun.started_at)).where(
            MemoryConsolidationRun.tenant_id == settings.tenant_id))
    return latest is None or datetime.now(UTC) - latest >= interval


async def recover_interrupted() -> None:
    """Called when the worker starts: scheduled runs cut off by a restart can never finish.

    Manual runs are backed by a queued job that restarts them, so they are left running.
    """
    async with Session() as db, db.begin():
        await db.execute(update(MemoryConsolidationRun).where(
            MemoryConsolidationRun.tenant_id == settings.tenant_id, MemoryConsolidationRun.status == "running",
            MemoryConsolidationRun.trigger == "schedule",
        ).values(status="failed", error="Interrupted by worker restart", finished_at=datetime.now(UTC)))


async def run_scheduled() -> bool:
    """Start and execute one scheduled run in-process; False when another run is in progress."""
    try:
        run = await create_run("schedule")
    except ConsolidationBusy:
        return False
    await execute_run(int(run["id"]))
    return True


async def scheduler(poll_seconds: float = 60.0, initial_delay: float = 30.0) -> None:
    """Worker task: run consolidation whenever the configured interval has elapsed."""
    await asyncio.sleep(initial_delay)
    while True:
        try:
            if await consolidation_due():
                await run_scheduled()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.opt(exception=True).error("Memory consolidation scheduler interrupted")
        await asyncio.sleep(poll_seconds)


async def overview(limit: int = 20) -> dict[str, Any]:
    """Settings, recent runs and the users currently above the threshold (for the admin console)."""
    async with Session() as db:
        runs = (await db.scalars(scoped(MemoryConsolidationRun).order_by(
            MemoryConsolidationRun.started_at.desc(), MemoryConsolidationRun.id.desc()).limit(limit))).all()
    over = await users_over_threshold()
    return {"settings": config_json(), "running": any(run.status == "running" for run in runs),
            "runs": [serialize(run) for run in runs],
            "users_over_threshold": [{"user_id": user_id, "active": total} for user_id, total in over[:50]]}
