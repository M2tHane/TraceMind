"""Document lifecycle shared by the HTTP API and MCP: typed sources, delete and replace.

Supported sources: PDF (parsed by MinerU), Markdown and plain text (UTF-8, indexed
directly). Replacement is zero-downtime: the new version is ingested as a separate
document carrying ``replaces_document_id``; only once it is ready is the old one
removed. If the new version fails, the old one stays searchable.

Deletion first marks the document ``deleting`` (excluded from retrieval), then
removes vectors, chunks, the row and finally files. Each step is idempotent, so a
failed delete can simply be repeated.
"""
from __future__ import annotations

import asyncio
import hashlib
import shutil
from datetime import UTC, datetime
from pathlib import Path, PurePosixPath
from typing import Any

from fastapi import HTTPException
from loguru import logger
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import enqueue, owned, scoped, serialize
from app.config import settings
from app.db import Session, generate_id
from app.models import Chunk, Document, EvalRun, KnowledgeBase
from app.services.auth import Principal
from app.services.configuration import resolve_settings
from app.services.rag import validate_index_config
from app.services.vectors import VectorStore

SOURCE_TYPES = {".pdf": "pdf", ".md": "markdown", ".markdown": "markdown", ".txt": "text"}
SOURCE_FILES = {"pdf": "source.pdf", "markdown": "source.md", "text": "source.txt"}
MEDIA_TYPES = {"pdf": "application/pdf", "markdown": "text/markdown; charset=utf-8",
               "text": "text/plain; charset=utf-8"}


def source_type_for(filename: str) -> str:
    source_type = SOURCE_TYPES.get(PurePosixPath(filename.lower()).suffix)
    if source_type is None:
        raise HTTPException(400, "仅支持 PDF、Markdown（.md）和纯文本（.txt）文件")
    return source_type


def document_directory(document_id: int) -> Path:
    """Resolve a server-generated ID beneath the storage root, rejecting symlinks."""
    if type(document_id) is not int or not 0 < document_id <= 2**63 - 1:
        raise HTTPException(400, "文档编号无效")
    root = (settings.data_dir / "documents").resolve()
    directory = root / str(document_id)
    if directory.is_symlink() or directory.resolve().parent != root:
        raise HTTPException(400, "文档存储路径无效")
    return directory


def source_file(document_id: int, source_type: str = "pdf") -> Path:
    source = document_directory(document_id) / SOURCE_FILES.get(source_type, "source.pdf")
    if source.is_symlink() or not source.is_file():
        raise HTTPException(404, "原始文件不存在，请重新上传")
    return source


def validate_text(path: Path) -> int:
    """Strict UTF-8 with readable content; returns a single page anchor."""
    maximum = settings.max_upload_mb * 1024 * 1024
    if path.stat().st_size > maximum:
        raise HTTPException(413, "文件超过服务器上传上限")
    try:
        text = path.read_text(encoding="utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(400, "文本文件必须是 UTF-8 编码") from None
    if not text.strip():
        raise HTTPException(400, "文本文件没有可索引内容")
    if "\x00" in text:
        raise HTTPException(400, "文本文件包含二进制内容")
    return 1


def read_text_source(path: Path) -> dict[str, Any]:
    """Parsed shape of a Markdown/TXT source, matching the MinerU parser output."""
    text = path.read_text(encoding="utf-8-sig").replace("\r\n", "\n")
    return {"markdown": text, "pages": [{"page": 1, "text": text}], "page_count": 1}


async def check_mutable(db: AsyncSession, knowledge_base_id: int) -> None:
    active_run = await db.scalar(scoped(EvalRun).where(
        EvalRun.knowledge_base_id == knowledge_base_id, EvalRun.status.in_(("queued", "running", "paused")),
    ).limit(1))
    if active_run is not None:
        raise HTTPException(409, "该知识库有进行中或已暂停的评测，请完成评测后再修改，或创建新知识库")


def needs_review(kb: KnowledgeBase, uploader: Principal | None) -> bool:
    """Employee uploads into a platform library wait for administrator approval."""
    return kb.scope == "platform" and uploader is not None and not uploader.is_admin


def register_document(db: AsyncSession, kb: KnowledgeBase, document: Document, uploader: Principal | None) -> None:
    """Stamp uploader/review state and queue parsing unless the upload awaits review."""
    document.uploaded_by = uploader.id if uploader else None
    if needs_review(kb, uploader):
        document.review_status, document.status, document.stage = "pending", "pending_review", "pending_review"
    else:
        document.review_status = "approved"
        enqueue(db, "parse", document.id)
    db.add(document)


async def create_document(db: AsyncSession, knowledge_base_id: int, filename: str, data: bytes,
                          replaces: Document | None = None, uploader: Principal | None = None) -> Document:
    """Validate, store and enqueue (or hold for review) one source from memory. Caller commits."""
    from app.api.library import safe_filename, validate_pdf

    name = safe_filename(filename)
    source_type = source_type_for(name)
    if len(data) > settings.max_upload_mb * 1024 * 1024:
        raise HTTPException(413, "文件超过服务器上传上限")
    kb = await owned(db, KnowledgeBase, knowledge_base_id, lock=True)
    await check_mutable(db, knowledge_base_id)
    digest = hashlib.sha256(data).hexdigest()
    if replaces is not None and replaces.file_sha256 == digest:
        raise HTTPException(409, "新内容与当前版本完全相同，无需更新")
    duplicate = await db.scalar(scoped(Document).where(
        Document.knowledge_base_id == knowledge_base_id, Document.file_sha256 == digest,
        Document.status.not_in(("deleting", "rejected"))).limit(1))
    if duplicate is not None:
        raise HTTPException(409, "该内容已存在于此知识库")
    document_id = generate_id()
    directory = document_directory(document_id)
    directory.mkdir(parents=True, exist_ok=False)
    try:
        path = directory / SOURCE_FILES[source_type]
        await asyncio.to_thread(path.write_bytes, data)
        if source_type == "pdf":
            if data[:5] != b"%PDF-":
                raise HTTPException(400, "文件内容不是有效的 PDF")
            pages = await asyncio.to_thread(validate_pdf, path)
        else:
            pages = await asyncio.to_thread(validate_text, path)
        document = Document(id=document_id, tenant_id=settings.tenant_id, knowledge_base_id=knowledge_base_id,
                            filename=name, file_sha256=digest, page_count=pages, status="queued", stage="queued",
                            source_type=source_type, replaces_document_id=replaces.id if replaces else None)
        register_document(db, kb, document, uploader)
        await db.flush()
        return document
    except BaseException:
        await asyncio.to_thread(shutil.rmtree, directory, True)
        raise


async def replace_document(db: AsyncSession, document_id: int, data: bytes,
                           filename: str | None = None, uploader: Principal | None = None) -> Document:
    """Queue a new version; the old document is removed after the new one becomes ready."""
    old = await owned(db, Document, document_id, lock=True)
    if old.status != "ready":
        raise HTTPException(409, "只有已就绪的文档可以更新，请等待处理完成或重试")
    pending = await db.scalar(scoped(Document).where(
        Document.replaces_document_id == old.id, Document.status.in_(("queued", "processing"))).limit(1))
    if pending is not None:
        raise HTTPException(409, "该文档已有正在处理的新版本")
    return await create_document(db, old.knowledge_base_id, filename or old.filename, data, replaces=old,
                                 uploader=uploader)


async def purge_document(document_id: int, *, enforce_mutable: bool = True) -> dict[str, Any]:
    """Remove a document's vectors, chunks, row and files. Safe to repeat."""
    async with Session() as db, db.begin():
        document = await db.scalar(scoped(Document).where(Document.id == document_id).with_for_update())
        if document is None:
            return {"deleted": str(document_id), "already_absent": True}
        kb = await owned(db, KnowledgeBase, document.knowledge_base_id, lock=True)
        if enforce_mutable:
            await check_mutable(db, kb.id)
            if document.status in ("queued", "processing"):
                raise HTTPException(409, "文档正在处理中，请等待完成或失败后再删除")
        runtime = await resolve_settings(db=db)
        validate_index_config(kb, runtime)
        document.status, document.stage = "deleting", "deleting"
        kb_id, filename = kb.id, document.filename
    vectors = VectorStore(runtime)
    try:
        await vectors.delete_document(kb_id, document_id)
    finally:
        await vectors.close()
    async with Session() as db, db.begin():
        await db.execute(delete(Chunk).where(Chunk.tenant_id == settings.tenant_id, Chunk.document_id == document_id))
        await db.execute(delete(Document).where(Document.tenant_id == settings.tenant_id,
                                                Document.id == document_id))
        kb = await owned(db, KnowledgeBase, kb_id, lock=True)
        kb.version += 1
    await asyncio.to_thread(shutil.rmtree, document_directory(document_id), True)
    logger.info("Document deleted: id={}, kb={}", document_id, kb_id)
    return {"deleted": str(document_id), "filename": filename, "knowledge_base_id": str(kb_id)}


async def review_document(db: AsyncSession, document_id: int, *, approve: bool, reviewer: Principal,
                          note: str = "") -> Document:
    """Approve (queue parsing) or reject (discard the stored file) a pending platform upload."""
    document = await owned(db, Document, document_id, lock=True)
    if document.review_status != "pending":
        raise HTTPException(409, "该文档不在待审批状态")
    if approve:
        await check_mutable(db, document.knowledge_base_id)
        document.review_status, document.status, document.stage = "approved", "queued", "queued"
        enqueue(db, "parse", document.id)
    else:
        document.review_status, document.status, document.stage = "rejected", "rejected", "rejected"
        await asyncio.to_thread(shutil.rmtree, document_directory(document.id), True)
    document.reviewed_by, document.reviewed_at, document.review_note = reviewer.id, datetime.now(UTC), note[:1000]
    await db.flush()
    return document


def document_json(document: Document) -> dict[str, Any]:
    return serialize(document, exclude={"markdown"})
