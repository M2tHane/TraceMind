"""Administrator console: accounts, approvals for platform content, query and MCP call logs."""
from __future__ import annotations

import secrets
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi import Path as PathParam
from pydantic import Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import owned, scoped, serialize
from app.api.deps import AdminUser, require_admin
from app.config import settings
from app.db import get_db
from app.models import Document, KnowledgeBase, McpCallLog, QueryLog, User
from app.schemas import InputModel
from app.services import memory
from app.services.auth import (
    AuthError,
    hash_password,
    normalize_username,
    revoke_user_sessions,
    validate_password,
)
from app.services.documents import document_json, review_document

router = APIRouter(prefix="/admin", dependencies=[Depends(require_admin)])
DB = Annotated[AsyncSession, Depends(get_db)]
ID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]


class UserCreate(InputModel):
    username: str = Field(min_length=3, max_length=64)
    display_name: str = Field(default="", max_length=100)
    role: Literal["admin", "employee"] = "employee"


class UserPatch(InputModel):
    display_name: str | None = Field(default=None, max_length=100)
    role: Literal["admin", "employee"] | None = None
    status: Literal["active", "disabled"] | None = None


class ReviewDecision(InputModel):
    approve: bool
    note: str = Field(default="", max_length=1000)


def generate_password(username: str = "") -> str:
    """A temporary password the user must replace at first login."""
    while True:
        candidate = secrets.token_urlsafe(12)
        try:
            return validate_password(candidate, username)
        except AuthError:
            continue


def user_json(user: User) -> dict[str, Any]:
    return serialize(user, exclude={"password_hash"})


def _auth_error(error: AuthError) -> HTTPException:
    return HTTPException(error.status, str(error))


async def _active_admins(db: AsyncSession) -> int:
    return await db.scalar(select(func.count(User.id)).where(
        User.tenant_id == settings.tenant_id, User.role == "admin", User.status == "active")) or 0


# ---------------------------------------------------------------- accounts


@router.get("/users")
async def list_users(db: DB) -> list[dict[str, Any]]:
    rows = (await db.scalars(scoped(User).order_by(User.role, User.username))).all()
    return [user_json(row) for row in rows]


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, db: DB) -> dict[str, Any]:
    try:
        username = normalize_username(body.username)
    except AuthError as error:
        raise _auth_error(error) from None
    if await db.scalar(scoped(User).where(User.username == username).limit(1)) is not None:
        raise HTTPException(409, "用户名已存在")
    password = generate_password(username)
    user = User(tenant_id=settings.tenant_id, username=username, display_name=body.display_name.strip(),
                role=body.role, password_hash=hash_password(password), status="active", must_change_password=True)
    db.add(user)
    await db.flush()
    await db.refresh(user)
    # The temporary password is returned once and never stored in clear text.
    return {**user_json(user), "temporary_password": password}


@router.patch("/users/{user_id}")
async def patch_user(user_id: ID, body: UserPatch, principal: AdminUser, db: DB) -> dict[str, Any]:
    user = await owned(db, User, user_id, lock=True)
    demoting = body.role == "employee" and user.role == "admin"
    disabling = body.status == "disabled" and user.status == "active"
    if user.id == principal.id and (demoting or disabling):
        raise HTTPException(409, "不能停用自己或取消自己的管理员身份")
    if (demoting or disabling) and user.role == "admin" and await _active_admins(db) <= 1:
        raise HTTPException(409, "至少需要保留一名启用的管理员")
    if body.display_name is not None:
        user.display_name = body.display_name.strip()
    if body.role is not None:
        user.role = body.role
    if body.status is not None:
        user.status = body.status
    if disabling or demoting:
        # Role and status are read per request, but signing out makes the change immediate and visible.
        await revoke_user_sessions(db, user.id)
    await db.flush()
    await db.refresh(user)
    return user_json(user)


@router.post("/users/{user_id}/reset-password")
async def reset_password(user_id: ID, principal: AdminUser, db: DB) -> dict[str, Any]:
    user = await owned(db, User, user_id, lock=True)
    if user.id == principal.id:
        raise HTTPException(409, "请在账户页修改自己的密码")
    password = generate_password(user.username)
    user.password_hash, user.must_change_password = hash_password(password), True
    await revoke_user_sessions(db, user.id)
    await db.flush()
    await db.refresh(user)
    return {**user_json(user), "temporary_password": password}


# ---------------------------------------------------------------- approvals


@router.get("/reviews")
async def pending_reviews(db: DB) -> dict[str, Any]:
    rows = (await db.execute(
        select(Document, KnowledgeBase.name, User.username, User.display_name)
        .join(KnowledgeBase, KnowledgeBase.id == Document.knowledge_base_id)
        .outerjoin(User, User.id == Document.uploaded_by)
        .where(Document.tenant_id == settings.tenant_id, Document.review_status == "pending")
        .order_by(Document.id))).all()
    documents = [{**document_json(document), "knowledge_base_name": kb_name,
                  "uploader": {"username": username or "", "display_name": display_name or ""}}
                 for document, kb_name, username, display_name in rows]
    memories = await memory.pending_platform_memories()
    authors = {int(row["created_by"]) for row in memories if row.get("created_by")}
    names = dict((await db.execute(select(User.id, User.username).where(User.id.in_(authors)))).all()) \
        if authors else {}
    for row in memories:
        row["author"] = names.get(int(row["created_by"]), "") if row.get("created_by") else ""
    return {"documents": documents, "memories": memories}


@router.get("/reviews/count")
async def pending_count(db: DB) -> dict[str, int]:
    documents = await db.scalar(select(func.count(Document.id)).where(
        Document.tenant_id == settings.tenant_id, Document.review_status == "pending")) or 0
    memories = len(await memory.pending_platform_memories(limit=1000))
    return {"documents": documents, "memories": memories, "total": documents + memories}


@router.post("/reviews/documents/{document_id}")
async def decide_document(document_id: ID, body: ReviewDecision, principal: AdminUser, db: DB) -> dict[str, Any]:
    await owned(db, KnowledgeBase, (await owned(db, Document, document_id)).knowledge_base_id, lock=True)
    document = await review_document(db, document_id, approve=body.approve, reviewer=principal, note=body.note)
    await db.refresh(document)
    return document_json(document)


@router.post("/reviews/memories/{memory_id}")
async def decide_memory(memory_id: ID, body: ReviewDecision, principal: AdminUser) -> dict[str, Any]:
    try:
        return await memory.review_memory(memory_id, approve=body.approve, reviewer_id=principal.id,
                                          note=body.note)
    except memory.MemoryError as error:
        raise HTTPException(error.status, str(error)) from None


# ---------------------------------------------------------------- logs


def _page(limit: int, offset: int) -> dict[str, int]:
    return {"limit": limit, "offset": offset}


Limit = Annotated[int, Query(ge=1, le=500)]
Offset = Annotated[int, Query(ge=0)]


@router.get("/query-logs")
async def query_logs(db: DB, user_id: int | None = None, knowledge_base_id: int | None = None,
                     source: Literal["chat", "debug", "mcp"] | None = None,
                     kb_scope: Literal["platform", "personal"] | None = None,
                     status: Literal["ok", "error"] | None = None, q: str | None = None,
                     since: datetime | None = None, until: datetime | None = None,
                     limit: Limit = 50, offset: Offset = 0) -> dict[str, Any]:
    statement = scoped(QueryLog)
    for column, value in ((QueryLog.user_id, user_id), (QueryLog.knowledge_base_id, knowledge_base_id),
                          (QueryLog.source, source), (QueryLog.kb_scope, kb_scope), (QueryLog.status, status)):
        if value is not None:
            statement = statement.where(column == value)
    if q:
        pattern = q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        statement = statement.where(QueryLog.query.ilike(f"%{pattern}%", escape="\\"))
    if since:
        statement = statement.where(QueryLog.created_at >= since)
    if until:
        statement = statement.where(QueryLog.created_at < until)
    total = await db.scalar(select(func.count()).select_from(statement.subquery()))
    rows = (await db.scalars(statement.order_by(QueryLog.id.desc()).limit(limit).offset(offset))).all()
    names = await _kb_names(db, {row.knowledge_base_id for row in rows if row.knowledge_base_id})
    items = [{**serialize(row), "knowledge_base_name": names.get(row.knowledge_base_id, "")} for row in rows]
    return {"total": total, "items": items, **_page(limit, offset)}


@router.get("/mcp-logs")
async def mcp_logs(db: DB, user_id: int | None = None, tool: str | None = None,
                   status: Literal["ok", "error"] | None = None, since: datetime | None = None,
                   until: datetime | None = None, limit: Limit = 50, offset: Offset = 0) -> dict[str, Any]:
    statement = scoped(McpCallLog)
    for column, value in ((McpCallLog.user_id, user_id), (McpCallLog.tool, tool), (McpCallLog.status, status)):
        if value is not None:
            statement = statement.where(column == value)
    if since:
        statement = statement.where(McpCallLog.created_at >= since)
    if until:
        statement = statement.where(McpCallLog.created_at < until)
    total = await db.scalar(select(func.count()).select_from(statement.subquery()))
    rows = (await db.scalars(statement.order_by(McpCallLog.id.desc()).limit(limit).offset(offset))).all()
    tools = (await db.scalars(select(McpCallLog.tool).where(McpCallLog.tenant_id == settings.tenant_id)
                              .distinct().order_by(McpCallLog.tool))).all()
    return {"total": total, "items": [serialize(row) for row in rows], "tools": list(tools),
            **_page(limit, offset)}


async def _kb_names(db: AsyncSession, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    return dict((await db.execute(select(KnowledgeBase.id, KnowledgeBase.name).where(
        KnowledgeBase.tenant_id == settings.tenant_id, KnowledgeBase.id.in_(ids)))).all())

