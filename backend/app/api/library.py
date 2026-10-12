"""Tenant-scoped knowledge bases and validated, durable PDF ingestion."""
# ruff: noqa: BLE001 -- HTTP and file boundaries must sanitize every unexpected exception.
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import traceback
import unicodedata
from pathlib import Path, PurePosixPath
from typing import Annotated, Any

import pymupdf
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import FileResponse
from loguru import logger
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import chunk_json, enqueue, kb_json, scoped, serialize
from app.api.deps import CurrentUser
from app.config import settings
from app.db import generate_id, get_db
from app.models import Chunk, Document, Job, KnowledgeBase
from app.schemas import KBCreate
from app.services.access import (
    can_manage_kb,
    check_document_removal,
    manageable_document,
    manageable_kb,
    readable_document,
    readable_kb,
    visible_documents,
    visible_kbs,
)
from app.services.auth import Principal
from app.services.configuration import resolve_settings
from app.services.documents import (
    MEDIA_TYPES,
    SOURCE_FILES,
    check_mutable,
    document_directory,
    purge_document,
    register_document,
    replace_document,
    source_file,
    source_type_for,
    validate_text,
)
from app.services.providers import ProviderError
from app.services.rag import index_settings_snapshot
from app.services.retrieval import RetrievalConfig

router = APIRouter()
ResourceID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]
MAX_BATCH_FILES = 10
MAX_UPLOAD_BYTES = 50 * 1024 * 1024


def _log_failure(operation: str, error: BaseException, resource_id: int | None = None) -> None:
    # Never render exception text or traceback locals (SQL/HTTP errors can contain credentials).
    safe_error = RuntimeError(f"{operation} ({type(error).__name__})")
    stack = " > ".join(f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__))
    logger.opt(exception=(RuntimeError, safe_error, None)).error(
        "Library operation failed: operation={}, resource_id={}, stack={}",
        operation, resource_id, stack, exc_info=True
    )


async def kb_view(db: AsyncSession, principal: Principal, kb: KnowledgeBase) -> dict[str, Any]:
    """Library JSON plus the caller's permissions and pending-review count."""
    data = await kb_json(db, kb)
    data["can_manage"] = can_manage_kb(principal, kb)
    if kb.scope == "platform" and principal.is_admin:
        data["pending_count"] = await db.scalar(select(func.count(Document.id)).where(
            Document.tenant_id == settings.tenant_id, Document.knowledge_base_id == kb.id,
            Document.review_status == "pending"))
    return data


def safe_filename(filename: str | None) -> str:
    """Keep only a cross-platform basename; never use this name as a disk path."""
    name = PurePosixPath((filename or "").replace("\\", "/")).name.strip()
    if (not name or len(name) > 200 or ":" in name
            or any(unicodedata.category(char).startswith("C") for char in name)):
        raise HTTPException(400, "文件名无效，请使用不超过 200 个字符的普通文件名")
    if PurePosixPath(name.lower()).stem == "" or name.startswith("."):
        raise HTTPException(400, "文件名无效")
    source_type_for(name)
    return name


def source_pdf(document_id: int) -> Path:
    """Return only the immutable source.pdf of an already authorized document."""
    return source_file(document_id, "pdf")


def validate_pdf(path: Path) -> int:
    """Check the size, PDF magic, encryption and readable page tree without model calls."""
    maximum = min(MAX_UPLOAD_BYTES, settings.max_upload_mb * 1024 * 1024)
    if path.stat().st_size > maximum:
        raise HTTPException(413, "单个 PDF 文件不能超过 50 MB 或服务器配置上限")
    with path.open("rb") as handle:
        if handle.read(5) != b"%PDF-":
            raise HTTPException(400, "文件内容不是有效的 PDF")
    try:
        with pymupdf.open(path) as pdf:
            if pdf.is_encrypted or pdf.needs_pass or (pdf.metadata or {}).get("encryption"):
                raise HTTPException(400, "暂不支持加密 PDF，请先解除密码保护")
            if not pdf.is_pdf or pdf.page_count < 1:
                raise HTTPException(400, "PDF 不包含可读取的页面")
            for page_number in range(pdf.page_count):
                pdf.load_page(page_number)
            return pdf.page_count
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("validate_pdf", error)
        raise HTTPException(400, "PDF 文件已损坏或无法读取，请检查后重新上传") from None


async def _write_upload(upload: UploadFile, path: Path, source_type: str = "pdf") -> tuple[str, int]:
    maximum = min(MAX_UPLOAD_BYTES, settings.max_upload_mb * 1024 * 1024)
    digest = hashlib.sha256()
    size = 0
    with path.open("xb") as handle:
        while block := await upload.read(1024 * 1024):
            size += len(block)
            if size > maximum:
                raise HTTPException(413, "单个 PDF 文件不能超过 50 MB 或服务器配置上限")
            digest.update(block)
            await asyncio.to_thread(handle.write, block)
        await asyncio.to_thread(handle.flush)
        await asyncio.to_thread(os.fsync, handle.fileno())
    pages = await asyncio.to_thread(validate_pdf if source_type == "pdf" else validate_text, path)
    return digest.hexdigest(), pages


_check_mutable = check_mutable


async def _rollback_upload(db: AsyncSession, directories: list[Path]) -> None:
    try:
        await db.rollback()
    except Exception as error:
        _log_failure("upload_rollback", error)
    finally:
        # Only directories created by THIS request enter the list; never remove a duplicate's files.
        for directory in directories:
            try:
                await asyncio.to_thread(shutil.rmtree, directory)
            except OSError as error:
                _log_failure("upload_cleanup", error)


@router.get("/knowledge-bases")
async def list_knowledge_bases(db: Annotated[AsyncSession, Depends(get_db)],
                               principal: CurrentUser) -> list[dict[str, Any]]:
    try:
        rows = (await db.scalars(scoped(KnowledgeBase).where(visible_kbs(principal))
                                 .order_by(KnowledgeBase.scope.desc(), KnowledgeBase.id.desc()))).all()
        return [await kb_view(db, principal, kb) for kb in rows]
    except Exception as error:
        _log_failure("list_knowledge_bases", error)
        raise HTTPException(500, "读取知识库失败，请稍后重试") from None


@router.post("/knowledge-bases", status_code=201)
async def create_knowledge_base(request: KBCreate, db: Annotated[AsyncSession, Depends(get_db)],
                                principal: CurrentUser) -> dict[str, Any]:
    if request.scope == "platform" and not principal.is_admin:
        raise HTTPException(403, "只有管理员可以创建平台知识库")
    try:
        runtime_settings = await resolve_settings(db=db)
        kb = KnowledgeBase(tenant_id=settings.tenant_id, **request.model_dump(), owner_id=principal.id,
                           embedding_model=runtime_settings.embedding_model,
                           embedding_dimensions=runtime_settings.embedding_dimensions,
                           index_config=index_settings_snapshot(runtime_settings))
        db.add(kb)
        await db.flush()
        await db.refresh(kb)
        return await kb_view(db, principal, kb)
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("create_knowledge_base", error)
        raise HTTPException(500, "创建知识库失败，请稍后重试") from None


@router.get("/knowledge-bases/{knowledge_base_id}")
async def get_knowledge_base(knowledge_base_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                             principal: CurrentUser) -> dict[str, Any]:
    try:
        return await kb_view(db, principal, await readable_kb(db, principal, knowledge_base_id))
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("get_knowledge_base", error, knowledge_base_id)
        raise HTTPException(500, "读取知识库失败，请稍后重试") from None


@router.get("/knowledge-bases/{knowledge_base_id}/documents")
async def list_documents(knowledge_base_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                         principal: CurrentUser) -> list[dict[str, Any]]:
    try:
        await readable_kb(db, principal, knowledge_base_id)
        rows = (await db.scalars(scoped(Document).where(
            Document.knowledge_base_id == knowledge_base_id, visible_documents(principal),
        ).order_by(Document.id.desc()))).all()
        return [serialize(document, exclude={"markdown"}) for document in rows]
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("list_documents", error, knowledge_base_id)
        raise HTTPException(500, "读取文档列表失败，请稍后重试") from None


@router.post("/knowledge-bases/{knowledge_base_id}/documents", status_code=202)
async def upload_documents(knowledge_base_id: ResourceID,
                           files: Annotated[list[UploadFile], File()],
                           db: Annotated[AsyncSession, Depends(get_db)],
                           principal: CurrentUser) -> list[dict[str, Any]]:
    directories: list[Path] = []
    committed = False
    try:
        if not 1 <= len(files) <= MAX_BATCH_FILES:
            raise HTTPException(400, "每批请上传 1 至 10 个文件")
        names = [safe_filename(upload.filename) for upload in files]
        kb = await readable_kb(db, principal, knowledge_base_id, lock=True)
        await _check_mutable(db, knowledge_base_id)
        documents: list[Document] = []
        seen_hashes: set[str] = set()
        for upload, name in zip(files, names, strict=True):
            document_id = generate_id()
            directory = document_directory(document_id)
            directory.mkdir(parents=True, exist_ok=False)
            directories.append(directory)
            source_type = source_type_for(name)
            digest, pages = await _write_upload(upload, directory / SOURCE_FILES[source_type], source_type)
            duplicate = digest in seen_hashes or await db.scalar(scoped(Document).where(
                Document.knowledge_base_id == knowledge_base_id, Document.file_sha256 == digest,
                Document.status.not_in(("deleting", "rejected")),
            ).limit(1)) is not None
            if duplicate:
                raise HTTPException(409, "该文件已存在于此知识库或本次上传批次中，请移除重复文件")
            seen_hashes.add(digest)
            document = Document(id=document_id, tenant_id=settings.tenant_id,
                                knowledge_base_id=knowledge_base_id, filename=name,
                                file_sha256=digest, page_count=pages, status="queued", stage="queued",
                                source_type=source_type)
            register_document(db, kb, document, principal)
            documents.append(document)
        await db.flush()
        response = [serialize(document, exclude={"markdown"}) for document in documents]
        # The files and queued jobs must survive together before returning success.
        await db.commit()
        committed = True
        return response
    except HTTPException:
        await _rollback_upload(db, directories)
        raise
    except asyncio.CancelledError:
        if not committed:
            await _rollback_upload(db, directories)
        raise
    except Exception as error:
        if not committed:
            await _rollback_upload(db, directories)
        _log_failure("upload_documents", error, knowledge_base_id)
        raise HTTPException(500, "上传失败，未接受本批文档，请稍后重试") from None
    finally:
        for upload in files:
            try:
                await upload.close()
            except Exception as error:
                _log_failure("close_upload", error, knowledge_base_id)


@router.get("/documents/{document_id}")
async def get_document(document_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                       principal: CurrentUser) -> dict[str, Any]:
    try:
        document, _ = await readable_document(db, principal, document_id)
        return serialize(document, exclude={"markdown"})
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("get_document", error, document_id)
        raise HTTPException(500, "读取文档失败，请稍后重试") from None


@router.get("/documents/{document_id}/parsed")
async def get_parsed_document(document_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                              principal: CurrentUser) -> dict[str, Any]:
    try:
        document, _ = await readable_document(db, principal, document_id)
        if document.stage not in {"chunking", "embedding", "indexing", "ready", "failed"}:
            return {"markdown": "", "chunks": []}
        chunks = (await db.scalars(scoped(Chunk).where(
            Chunk.document_id == document.id, Chunk.knowledge_base_id == document.knowledge_base_id,
        ).order_by(Chunk.chunk_index, Chunk.id))).all()
        return {"markdown": document.markdown or "",
                "chunks": [chunk_json(chunk, document.filename) for chunk in chunks]}
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("get_parsed_document", error, document_id)
        raise HTTPException(500, "读取解析结果失败，请稍后重试") from None


@router.get("/documents/{document_id}/file")
async def get_document_file(document_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                            principal: CurrentUser) -> FileResponse:
    try:
        document, _ = await readable_document(db, principal, document_id)
        path = source_file(document.id, document.source_type)
        return FileResponse(path, media_type=MEDIA_TYPES[document.source_type],
                            filename=safe_filename(document.filename),
                            content_disposition_type="inline", headers={"X-Content-Type-Options": "nosniff"})
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("get_document_file", error, document_id)
        raise HTTPException(500, "读取 PDF 失败，请稍后重试") from None


@router.post("/documents/{document_id}/retry", status_code=202)
async def retry_document(document_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                         principal: CurrentUser) -> dict[str, Any]:
    try:
        document, _ = await manageable_document(db, principal, document_id, lock_kb=True)
        await _check_mutable(db, document.knowledge_base_id)
        # Re-read with scope and a row lock: the identity map may hold an earlier failed state.
        document = await db.scalar(scoped(Document).where(Document.id == document_id)
                                   .with_for_update().execution_options(populate_existing=True))
        if document is None:
            raise HTTPException(404, "资源不存在")
        if document.status != "failed":
            raise HTTPException(409, "仅处理失败的文档可以重试，请等待当前任务完成")
        active_job = await db.scalar(scoped(Job).where(
            Job.job_type == "parse", Job.resource_id == document.id,
            Job.status.in_(("queued", "running", "processing")),
        ).limit(1))
        if active_job is not None:
            raise HTTPException(409, "该文档已有处理任务，请勿重复重试")
        source_file(document.id, document.source_type)
        document.status, document.stage, document.error = "queued", "queued", None
        enqueue(db, "parse", document.id)
        await db.flush()
        return serialize(document, exclude={"markdown"})
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("retry_document", error, document_id)
        raise HTTPException(500, "重试文档失败，请稍后重试") from None


@router.put("/documents/{document_id}/content", status_code=202)
async def replace_document_content(document_id: ResourceID, file: Annotated[UploadFile, File()],
                                   db: Annotated[AsyncSession, Depends(get_db)],
                                   principal: CurrentUser) -> dict[str, Any]:
    """Upload a new version. The current one stays searchable until the new one is ready."""
    try:
        await manageable_document(db, principal, document_id)
        data = await file.read(settings.max_upload_mb * 1024 * 1024 + 1)
        document = await replace_document(db, document_id, data, safe_filename(file.filename), uploader=principal)
        return serialize(document, exclude={"markdown"})
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("replace_document", error, document_id)
        raise HTTPException(500, "更新文档失败，请稍后重试") from None
    finally:
        await file.close()


@router.delete("/documents/{document_id}")
async def delete_document(document_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                          principal: CurrentUser) -> dict[str, Any]:
    try:
        document, kb = await readable_document(db, principal, document_id)
        check_document_removal(principal, kb, document)
        await db.rollback()
        return await purge_document(document_id)
    except HTTPException:
        raise
    except ProviderError as error:
        raise HTTPException(409, str(error)) from None
    except Exception as error:
        _log_failure("delete_document", error, document_id)
        raise HTTPException(500, "删除文档失败，可再次执行删除") from None


@router.put("/knowledge-bases/{knowledge_base_id}/retrieval-config")
async def set_retrieval_config(knowledge_base_id: ResourceID, config: RetrievalConfig | None,
                               db: Annotated[AsyncSession, Depends(get_db)],
                               principal: CurrentUser) -> dict[str, Any]:
    """Set (or clear with null) the default pipeline used by chat and MCP for this library."""
    kb = await manageable_kb(db, principal, knowledge_base_id, lock=True)
    kb.retrieval_config = config.model_dump() if config else {}
    await db.flush()
    await db.refresh(kb)
    return await kb_view(db, principal, kb)
