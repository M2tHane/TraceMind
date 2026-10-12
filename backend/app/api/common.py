"""Tenant lookup and explicit browser serialization."""
from datetime import datetime
from typing import Any, TypeVar

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Chunk, Dataset, Document, Job, KnowledgeBase, Question, TenantModel

T = TypeVar("T", bound=TenantModel)


def scoped(model: type[T]) -> Any:
    return select(model).where(model.tenant_id == settings.tenant_id)


async def owned(db: AsyncSession, model: type[T], resource_id: int, lock: bool = False) -> T:
    statement = scoped(model).where(model.id == resource_id)
    if lock:
        statement = statement.with_for_update()
    row = await db.scalar(statement)
    if row is None:
        raise HTTPException(404, "资源不存在")
    return row


def serialize(row: TenantModel, exclude: set[str] | None = None) -> dict[str, Any]:
    excluded = {"tenant_id", "embedding", "file_sha256", "attempt_history", "api_key_ciphertext", "secrets_ciphertext"} | (exclude or set())
    result: dict[str, Any] = {}
    for column in row.__table__.columns:
        name = column.name
        if name in excluded:
            continue
        val = getattr(row, name)
        if name == "id" or name.endswith(("_id", "_by")):
            val = str(val) if val is not None else None
        elif isinstance(val, datetime):
            val = val.isoformat()
        result["result" if name == "result_payload" else name] = val
    return result


async def kb_json(db: AsyncSession, kb: KnowledgeBase) -> dict[str, Any]:
    counts = (await db.execute(select(
        func.count(Document.id),
        func.count(Document.id).filter(Document.status == "ready"),
        func.coalesce(func.sum(Document.chunk_count), 0),
    ).where(Document.tenant_id == settings.tenant_id, Document.knowledge_base_id == kb.id,
            # Unapproved uploads are private to their uploader and administrators (see pending_count).
            Document.review_status == "approved"))).one()
    return {**serialize(kb), "document_count": counts[0], "ready_count": counts[1], "chunk_count": counts[2]}


async def dataset_json(db: AsyncSession, dataset: Dataset) -> dict[str, Any]:
    count = await db.scalar(select(func.count(Question.id)).where(
        Question.tenant_id == settings.tenant_id, Question.dataset_id == dataset.id))
    return {**serialize(dataset), "question_count": count}


def chunk_json(chunk: Chunk, filename: str, score: float | None = None) -> dict[str, Any]:
    content = {"id": str(chunk.id), "document_id": str(chunk.document_id), "filename": filename,
               "page": chunk.page, "chunk_index": chunk.chunk_index, "text": chunk.text}
    if score is not None:
        content["score"] = float(score)
    return content


def enqueue(db: AsyncSession, job_type: str, resource_id: int, params: dict | None = None) -> None:
    db.add(Job(tenant_id=settings.tenant_id, job_type=job_type, resource_id=resource_id, params=params or {}))
