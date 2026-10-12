"""Durable queued conversations and bounded, synchronous RAG comparisons."""
# ruff: noqa: BLE001 -- HTTP/model boundaries must sanitize every unexpected exception.
from __future__ import annotations

import asyncio
import time
import traceback
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from loguru import logger
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import enqueue, owned, scoped, serialize
from app.api.deps import AdminUser, CurrentUser
from app.api.library import ResourceID
from app.config import settings
from app.db import get_db
from app.models import Conversation, Document, KnowledgeBase, Message
from app.schemas import ConversationCreate, DebugRequest, MessageCreate
from app.services.access import readable_kb
from app.services.audit import log_query
from app.services.auth import Principal
from app.services.configuration import get_chat_snapshot, public_snapshot, resolve_settings
from app.services.metrics import answer_metrics
from app.services.providers import ProviderError

router = APIRouter()
_debug_semaphore = asyncio.Semaphore(2)


def _log_failure(operation: str, error: BaseException, resource_id: int | None = None) -> None:
    safe_error = RuntimeError(f"{operation} ({type(error).__name__})")
    stack = " > ".join(f"{frame.name}:{frame.lineno}" for frame in traceback.extract_tb(error.__traceback__))
    logger.opt(exception=(RuntimeError, safe_error, None)).error(
        "Chat operation failed: operation={}, resource_id={}, stack={}",
        operation, resource_id, stack, exc_info=True
    )


def _validate_id(identifier: int) -> None:
    if type(identifier) is not int or not 0 < identifier <= 2**63 - 1:
        raise HTTPException(400, "知识库编号无效")


async def _require_ready(db: AsyncSession, knowledge_base_id: int) -> None:
    ready = await db.scalar(scoped(Document).where(
        Document.knowledge_base_id == knowledge_base_id, Document.status == "ready",
        Document.chunk_count > 0,
    ).limit(1))
    if ready is None:
        raise HTTPException(409, "知识库还没有可检索文档，请等待解析与索引完成")


@router.get("/conversations")
async def list_conversations(db: Annotated[AsyncSession, Depends(get_db)],
                             principal: CurrentUser) -> list[dict[str, Any]]:
    try:
        conversations = (await db.scalars(scoped(Conversation).where(Conversation.owner_id == principal.id)
                                          .order_by(Conversation.id.desc()))).all()
        return [serialize(conversation) for conversation in conversations]
    except Exception as error:
        _log_failure("list_conversations", error)
        raise HTTPException(500, "读取会话列表失败，请稍后重试") from None


@router.post("/conversations", status_code=201)
async def create_conversation(request: ConversationCreate, db: Annotated[AsyncSession, Depends(get_db)],
                              principal: CurrentUser) -> dict[str, Any]:
    try:
        _validate_id(request.knowledge_base_id)
        await readable_kb(db, principal, request.knowledge_base_id)
        conversation = Conversation(tenant_id=settings.tenant_id, owner_id=principal.id, **request.model_dump())
        db.add(conversation)
        await db.flush()
        return serialize(conversation)
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("create_conversation", error, request.knowledge_base_id)
        raise HTTPException(500, "创建会话失败，请稍后重试") from None


@router.get("/conversations/{conversation_id}/messages")
async def list_messages(conversation_id: ResourceID, db: Annotated[AsyncSession, Depends(get_db)],
                        principal: CurrentUser) -> list[dict[str, Any]]:
    try:
        await own_conversation(db, principal, conversation_id)
        messages = (await db.scalars(scoped(Message).where(
            Message.conversation_id == conversation_id,
        ).order_by(Message.id))).all()
        return [serialize(message) for message in messages]
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("list_messages", error, conversation_id)
        raise HTTPException(500, "读取会话消息失败，请稍后重试") from None


@router.post("/conversations/{conversation_id}/messages", status_code=202)
async def create_message(conversation_id: ResourceID, request: MessageCreate,
                         db: Annotated[AsyncSession, Depends(get_db)], principal: CurrentUser) -> dict[str, Any]:
    try:
        conversation, kb = await own_conversation(db, principal, conversation_id, lock=True)
        pending = await db.scalar(scoped(Message).where(
            Message.conversation_id == conversation_id, Message.role == "assistant",
            Message.status.in_(("queued", "processing")),
        ).limit(1))
        if pending is not None:
            raise HTTPException(409, "上一条回答仍在生成中，请等待完成后再发送")
        if request.method != "no_context":
            await _require_ready(db, conversation.knowledge_base_id)
        first_user = await db.scalar(scoped(Message).where(
            Message.conversation_id == conversation_id, Message.role == "user",
        ).limit(1))
        if first_user is None:
            conversation.title = request.content[:48]
        model_snapshot = await get_chat_snapshot(db, request.model_profile_id)
        # Explicit pipeline > tuned library default (for the default method) > legacy method mapping.
        retrieval = (request.retrieval.model_dump() if request.retrieval else
                     kb.retrieval_config if request.method == "hybrid_rerank" and kb.retrieval_config else None)
        user_message = Message(tenant_id=settings.tenant_id, conversation_id=conversation_id,
                               role="user", content=request.content, method=request.method,
                               status="completed", stage="completed")
        assistant = Message(tenant_id=settings.tenant_id, conversation_id=conversation_id,
                            role="assistant", content="", method=request.method,
                            model_profile_id=int(model_snapshot["id"]),
                            model_snapshot=public_snapshot(model_snapshot),
                            status="queued", stage="queued")
        db.add_all([user_message, assistant])
        await db.flush()
        enqueue(db, "chat", assistant.id, params={
            "question": request.content, "method": request.method, "model_config": model_snapshot,
            "top_k": request.top_k, "candidate_k": request.candidate_k,
            "retrieval": retrieval,
            "principal": {"id": principal.id, "username": principal.username, "role": principal.role},
            "kb_scope": kb.scope,
        })
        return serialize(assistant)
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("create_message", error, conversation_id)
        raise HTTPException(500, "发送消息失败，请稍后重试") from None


async def own_conversation(db: AsyncSession, principal: Principal, conversation_id: int,
                           lock: bool = False) -> tuple[Conversation, KnowledgeBase]:
    """Conversations are private to their owner, and the library must still be readable."""
    conversation = await owned(db, Conversation, conversation_id, lock=lock)
    if conversation.owner_id != principal.id:
        raise HTTPException(404, "资源不存在")
    return conversation, await readable_kb(db, principal, conversation.knowledge_base_id)


def _error_result(method: str, message: str) -> dict[str, Any]:
    return {"method": method, "answer": "", "citations": [], "contexts": [], "abstain": False,
            "timing": {"retrieval_ms": 0, "generation_ms": 0}, "usage": {"total_tokens": 0},
            "error": message}


@router.post("/debug")
async def debug_question(request: DebugRequest, db: Annotated[AsyncSession, Depends(get_db)],
                         principal: AdminUser) -> dict[str, Any]:
    try:
        _validate_id(request.knowledge_base_id)
        kb_scope = (await readable_kb(db, principal, request.knowledge_base_id)).scope
        runtime_settings = await resolve_settings(db=db)
        # answer_question owns its own session. Do not hold this read transaction during model calls.
        await db.rollback()
    except HTTPException:
        raise
    except Exception as error:
        _log_failure("debug_authorize", error, request.knowledge_base_id)
        raise HTTPException(500, "读取调试知识库失败，请稍后重试") from None
    if _debug_semaphore.locked():
        raise HTTPException(429, "已有两个调试请求执行中，请等待完成后重试")
    async with _debug_semaphore:
        from app.services.rag import answer_question

        results: list[dict[str, Any]] = []
        runs: list[tuple[str, Any]] = [(method, None) for method in request.methods]
        if request.retrieval is not None:
            runs.append(("custom", request.retrieval))
        # Deliberately sequential: one request cannot fan out to all paid providers at once.
        for method, retrieval in runs:
            started = time.perf_counter()
            try:
                result = await answer_question(
                    knowledge_base_id=request.knowledge_base_id, question=request.question,
                    method="hybrid_rerank" if retrieval else method, top_k=request.top_k,
                    candidate_k=request.candidate_k, retrieval_only=request.retrieval_only,
                    runtime_settings=runtime_settings, retrieval=retrieval,
                )
                result["method"] = method
                await log_query(principal, source="debug", action="retrieve" if request.retrieval_only else "answer",
                                knowledge_base_id=request.knowledge_base_id, kb_scope=kb_scope,
                                query=request.question, method=method, result_count=len(result.get("contexts", [])),
                                latency_ms=(time.perf_counter() - started) * 1000, error=result.get("error"))
                if request.reference_answer and not request.retrieval_only and not result.get("error"):
                    result["metrics"] = answer_metrics(result["answer"], request.reference_answer)
                results.append(result)
            except ProviderError as error:
                # This class only contains caller-authored safe messages, not response bodies.
                _log_failure("debug_provider", error, request.knowledge_base_id)
                results.append(_error_result(method, f"服务调用失败：{error}"))
            except HTTPException as error:
                _log_failure("debug_resource", error, request.knowledge_base_id)
                results.append(_error_result(method, "调试资源不可用，请刷新知识库后重试"))
            except Exception as error:
                _log_failure("debug_question", error, request.knowledge_base_id)
                results.append(_error_result(method, "本次调试失败，请检查服务状态后重试"))
        return {"results": results}
