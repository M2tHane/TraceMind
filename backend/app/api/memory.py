"""Memory HTTP API for the signed-in account.

``scope=personal`` addresses the caller's own memories (namespace ``user:<id>``).
``scope=platform`` addresses shared memories: everyone reads active ones, administrators
change them directly, and employees submit proposals that wait for approval.
"""
from __future__ import annotations

from collections.abc import Awaitable
from typing import Annotated, Any, Literal, TypeVar

from fastapi import APIRouter, HTTPException, Query
from fastapi import Path as PathParam

from app.api.deps import CurrentUser
from app.schemas import MemoryCreate, MemoryExtract, MemoryMerge, MemorySearch, MemoryUpdate
from app.services import memory
from app.services.access import memory_namespace, require_memory_admin
from app.services.auth import Principal
from app.services.providers import ProviderError

router = APIRouter()
MemoryID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]
Scope = Annotated[Literal["personal", "platform"], Query()]
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


def visible_to(principal: Principal, scope: str, row: dict[str, Any]) -> bool:
    """Employees see active platform memories plus their own proposals."""
    if scope == "personal" or principal.is_admin or row["status"] == "active":
        return True
    return row.get("created_by") == str(principal.id)


async def readable_memory(principal: Principal, scope: str, memory_id: int) -> dict[str, Any]:
    row = await call(memory.get_memory(memory_namespace(principal, scope), memory_id))
    if not visible_to(principal, scope, row):
        raise HTTPException(404, "资源不存在")
    return row


@router.get("/memories")
async def list_memories(principal: CurrentUser, scope: Scope = "personal", status: str = "active",
                        category: str | None = None, tag: str | None = None,
                        limit: Annotated[int, Query(ge=1, le=500)] = 50,
                        offset: Annotated[int, Query(ge=0)] = 0, mine: bool = False) -> dict[str, Any]:
    created_by = None
    if scope == "platform" and (mine or (not principal.is_admin and status != "active")):
        created_by = principal.id
    return await call(memory.list_memories(memory_namespace(principal, scope), status=status, category=category,
                                           tag=tag, limit=limit, offset=offset, created_by=created_by))


@router.post("/memories", status_code=201)
async def add_memory(body: MemoryCreate, principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    proposal = scope == "platform" and not principal.is_admin
    return await call(memory.add_memory(memory_namespace(principal, scope), body.content, category=body.category,
                                        tags=body.tags, importance=body.importance, attributes=body.attributes,
                                        expires_at=body.expires_at, source="web",
                                        on_duplicate="skip" if proposal else body.on_duplicate,
                                        dedupe_threshold=body.dedupe_threshold, created_by=principal.id,
                                        pending=proposal))


@router.delete("/memories")
async def clear_memories(principal: CurrentUser, hard: bool = False) -> dict[str, Any]:
    """Clear the caller's personal memories. Platform memories are never cleared in bulk."""
    return await call(memory.clear_user(principal.memory_namespace, hard=hard, actor=actor(principal)))


@router.post("/memories/search")
async def search_memories(body: MemorySearch, principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    return await call(memory.search_memories(memory_namespace(principal, scope), body.query, top_k=body.top_k,
                                             categories=body.categories, tags=body.tags,
                                             min_importance=body.min_importance,
                                             min_similarity=body.min_similarity))


@router.post("/memories/merge", status_code=201)
async def merge_memories(body: MemoryMerge, principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    require_memory_admin(principal, scope)
    return await call(memory.merge_memories(memory_namespace(principal, scope), parse_ids(body.memory_ids),
                                            content=body.content, category=body.category, tags=body.tags,
                                            importance=body.importance, actor=actor(principal)))


@router.post("/memories/extract")
async def extract_memories(body: MemoryExtract, principal: CurrentUser) -> dict[str, Any]:
    """Extract durable facts into the caller's personal memories."""
    return await call(memory.extract_memories(principal.memory_namespace, body.text, max_items=body.max_items,
                                              dedupe_threshold=body.dedupe_threshold, actor=actor(principal),
                                              dry_run=body.dry_run))


@router.post("/memories/reembed")
async def reembed_memories(principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    require_memory_admin(principal, scope)
    return await call(memory.reembed_user(memory_namespace(principal, scope)))


@router.get("/memories/{memory_id}")
async def get_memory(memory_id: MemoryID, principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    return await readable_memory(principal, scope, memory_id)


@router.patch("/memories/{memory_id}")
async def update_memory(memory_id: MemoryID, body: MemoryUpdate, principal: CurrentUser,
                        scope: Scope = "personal") -> dict[str, Any]:
    require_memory_admin(principal, scope)
    return await call(memory.update_memory(memory_namespace(principal, scope), memory_id, **body.model_dump(),
                                           actor=actor(principal)))


@router.delete("/memories/{memory_id}")
async def delete_memory(memory_id: MemoryID, principal: CurrentUser, scope: Scope = "personal",
                        hard: bool = False) -> dict[str, Any]:
    if scope == "platform" and not principal.is_admin:
        # Employees may withdraw their own pending proposal, nothing else.
        row = await readable_memory(principal, scope, memory_id)
        if row["status"] != "pending" or row.get("created_by") != str(principal.id):
            raise HTTPException(403, "只有管理员可以删除平台记忆；员工仅可撤回自己待审批的提议")
    return await call(memory.delete_memories(memory_namespace(principal, scope), [memory_id], hard=hard,
                                             actor=actor(principal)))


@router.post("/memories/{memory_id}/restore")
async def restore_memory(memory_id: MemoryID, principal: CurrentUser, scope: Scope = "personal") -> dict[str, Any]:
    require_memory_admin(principal, scope)
    return await call(memory.restore_memory(memory_namespace(principal, scope), memory_id, actor=actor(principal)))


@router.get("/memories/{memory_id}/history")
async def memory_history(memory_id: MemoryID, principal: CurrentUser,
                         scope: Scope = "personal") -> list[dict[str, Any]]:
    await readable_memory(principal, scope, memory_id)
    return await call(memory.memory_history(memory_namespace(principal, scope), memory_id))
