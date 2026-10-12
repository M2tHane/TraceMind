"""Who may see and change which knowledge base, document and memory namespace.

Rules:
  * Platform libraries are visible to every account; only administrators manage them.
    Employees may upload into them, but uploads wait for administrator approval.
  * Personal libraries are visible to and managed by their owner only (administrators
    included: they manage accounts, not employees' private content).
  * Unapproved platform documents are visible to administrators and their uploader only.
  * Memories are always private to their owner (namespace "user:<id>").
Invisible resources answer 404, so identifiers of private resources are not confirmed.
"""
from __future__ import annotations

from typing import Any

from fastapi import HTTPException
from sqlalchemy import and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import owned
from app.models import Document, KnowledgeBase
from app.services.auth import Principal


def visible_kbs(principal: Principal) -> Any:
    return or_(KnowledgeBase.scope == "platform",
               and_(KnowledgeBase.scope == "personal", KnowledgeBase.owner_id == principal.id))


def can_read_kb(principal: Principal, kb: KnowledgeBase) -> bool:
    return kb.scope == "platform" or kb.owner_id == principal.id


def can_manage_kb(principal: Principal, kb: KnowledgeBase) -> bool:
    return principal.is_admin if kb.scope == "platform" else kb.owner_id == principal.id


async def readable_kb(db: AsyncSession, principal: Principal, kb_id: int, lock: bool = False) -> KnowledgeBase:
    kb = await owned(db, KnowledgeBase, kb_id, lock=lock)
    if not can_read_kb(principal, kb):
        raise HTTPException(404, "资源不存在")
    return kb


async def manageable_kb(db: AsyncSession, principal: Principal, kb_id: int, lock: bool = False) -> KnowledgeBase:
    kb = await readable_kb(db, principal, kb_id, lock=lock)
    if not can_manage_kb(principal, kb):
        raise HTTPException(403, "只有管理员可以管理平台知识库")
    return kb


def can_see_document(principal: Principal, kb: KnowledgeBase, document: Document) -> bool:
    if not can_read_kb(principal, kb):
        return False
    return document.review_status == "approved" or principal.is_admin or document.uploaded_by == principal.id


def visible_documents(principal: Principal) -> Any:
    """Extra filter for platform document lists: approved, or the caller's own submissions."""
    if principal.is_admin:
        return Document.id.is_not(None)
    return or_(Document.review_status == "approved", Document.uploaded_by == principal.id)


async def readable_document(db: AsyncSession, principal: Principal, document_id: int, lock: bool = False,
                            lock_kb: bool = False) -> tuple[Document, KnowledgeBase]:
    document = await owned(db, Document, document_id, lock=lock)
    kb = await owned(db, KnowledgeBase, document.knowledge_base_id, lock=lock_kb)
    if not can_see_document(principal, kb, document):
        raise HTTPException(404, "资源不存在")
    return document, kb


async def manageable_document(db: AsyncSession, principal: Principal, document_id: int, lock: bool = False,
                              lock_kb: bool = False) -> tuple[Document, KnowledgeBase]:
    document, kb = await readable_document(db, principal, document_id, lock=lock, lock_kb=lock_kb)
    if not can_manage_kb(principal, kb):
        raise HTTPException(403, "只有管理员可以修改或删除平台知识库中的文档")
    return document, kb


def check_document_removal(principal: Principal, kb: KnowledgeBase, document: Document) -> None:
    """Uploaders may withdraw their own unapproved submissions, everything else needs management rights."""
    withdrawing = document.review_status != "approved" and document.uploaded_by == principal.id
    if not withdrawing and not can_manage_kb(principal, kb):
        raise HTTPException(403, "只有管理员可以修改或删除平台知识库中的文档")

