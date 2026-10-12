"""Memory HTTP API for the signed-in account.

Every endpoint operates on the caller's own memories (namespace ``user:<id>``). There is no
shared namespace. Legacy clients may still send a ``scope`` query parameter; it is ignored.
"""
from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, Any, TypeVar

from fastapi import APIRouter, HTTPException, Query
from fastapi import Path as PathParam

from app.api.deps import CurrentUser
from app.schemas import MemoryCreate, MemoryExtract, MemoryMerge, MemorySearch, MemoryUpdate
from app.services import memory
from app.services.auth import Principal
from app.services.providers import ProviderError

router = APIRouter()
MemoryID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]
T = TypeVar("T")


def parse_ids(values: list[str]) -> list[int]:
    if any(not (isinstance(v, str) and v.isascii() and v.isdecimal() and 0 < int(v) <= 2**63 - 1) for v in values):
        raise HTTPException(422, "memory_ids 须为十进制记忆编号")
    return [int(v) for v in values]


async def call(operation: Awaitable[T]) -> T:
    """Map caller-safe service errors onto HTTP statuses."""
    try:
        return await operation
    except memory.MemoryError as error:
        raise HTTPException(error.status, str(error)) from None
    except ProviderError as error:
        raise HTTPException(502, f"模型服务调用失败：{error}") from None


def actor(principal: Principal) -> str:
    return f"user:{principal.id}"


@router.get("/memories")
async def list_memories(principal: CurrentUser, status: str = "active", category: str | None = None,
                        tag: str | None = None, limit: Annotated[int, Query(ge=1, le=500)] = 50,
                        offset: Annotated[int, Query(ge=0)] = 0) -> dict[str, Any]:
    return await call(memory.list_memories(principal.memory_namespace, status=status, category=category,
                                           tag=tag, limit=limit, offset=offset))


@router.post("/memories", status_code=201)
async def add_memory(body: MemoryCreate, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.add_memory(principal.memory_namespace, body.content, category=body.category,
                                        tags=body.tags, importance=body.importance, attributes=body.attributes,
                                        expires_at=body.expires_at, source="web", on_duplicate=body.on_duplicate,
                                        dedupe_threshold=body.dedupe_threshold, created_by=principal.id))


@router.delete("/memories")
async def clear_memories(principal: CurrentUser, hard: bool = False) -> dict[str, Any]:
    """Clear all of the caller's memories."""
    return await call(memory.clear_user(principal.memory_namespace, hard=hard, actor=actor(principal)))


@router.post("/memories/search")
async def search_memories(body: MemorySearch, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.search_memories(principal.memory_namespace, body.query, top_k=body.top_k,
                                             categories=body.categories, tags=body.tags,
                                             min_importance=body.min_importance,
                                             min_similarity=body.min_similarity))


@router.post("/memories/merge", status_code=201)
async def merge_memories(body: MemoryMerge, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.merge_memories(principal.memory_namespace, parse_ids(body.memory_ids),
                                            content=body.content, category=body.category, tags=body.tags,
                                            importance=body.importance, actor=actor(principal)))


@router.post("/memories/extract")
async def extract_memories(body: MemoryExtract, principal: CurrentUser) -> dict[str, Any]:
    """Extract durable facts into the caller's memories."""
    return await call(memory.extract_memories(principal.memory_namespace, body.text, max_items=body.max_items,
                                              dedupe_threshold=body.dedupe_threshold, actor=actor(principal),
                                              dry_run=body.dry_run))


@router.post("/memories/reembed")
async def reembed_memories(principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.reembed_user(principal.memory_namespace))


@router.get("/memories/{memory_id}")
async def get_memory(memory_id: MemoryID, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.get_memory(principal.memory_namespace, memory_id))


@router.patch("/memories/{memory_id}")
async def update_memory(memory_id: MemoryID, body: MemoryUpdate, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.update_memory(principal.memory_namespace, memory_id, **body.model_dump(),
                                           actor=actor(principal)))


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: MemoryID, principal: CurrentUser, hard: bool = False) -> dict[str, Any]:
    return await call(memory.delete_memories(principal.memory_namespace, [memory_id], hard=hard,
                                             actor=actor(principal)))


@router.post("/memories/{memory_id}/restore")
async def restore_memory(memory_id: MemoryID, principal: CurrentUser) -> dict[str, Any]:
    return await call(memory.restore_memory(principal.memory_namespace, memory_id, actor=actor(principal)))


@router.get("/memories/{memory_id}/history")
async def memory_history(memory_id: MemoryID, principal: CurrentUser) -> list[dict[str, Any]]:
    return await call(memory.memory_history(principal.memory_namespace, memory_id))
