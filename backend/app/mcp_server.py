"""MCP server exposing knowledge retrieval, document management, memory and tuning.

Every call acts as a workbench account and obeys the same permissions as the web UI:
  * Streamable HTTP, mounted by app.main at http://127.0.0.1:8010/mcp. Requires a personal
    access token created on the account page: ``Authorization: Bearer rwb_...``.
  * stdio:  cd backend && RAG_MCP_TOKEN=rwb_... .venv/bin/python -m app.mcp_server [--with-worker]
    Without --with-worker, uploads are queued and processed by the running API.

Libraries and memories are either ``platform`` (shared, administered) or ``personal``
(private to the caller). Employee uploads into platform libraries and employee platform
memories are proposals that wait for administrator approval. Every tool call is recorded
in the administrator's MCP call log (identifiers and sizes only, never free text).
Identifiers are decimal strings.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import os
import sys
import time
from collections.abc import Awaitable
from contextlib import suppress
from contextvars import ContextVar
from typing import Any, Literal, TypeVar

from fastapi import HTTPException
from mcp.server.mcpserver import Context, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations
from pydantic import ValidationError
from sqlalchemy import func, select

from app.api.common import kb_json, owned, scoped, serialize
from app.config import settings
from app.db import Session
from app.models import Chunk, Dataset, Document, KnowledgeBase, TuningRun, User
from app.schemas import KBCreate
from app.services import memory, rag
from app.services.access import (
    can_manage_kb,
    check_document_removal,
    manageable_document,
    manageable_kb,
    memory_namespace,
    readable_document,
    readable_kb,
    require_memory_admin,
    visible_documents,
    visible_kbs,
)
from app.services.audit import log_mcp_call, log_query
from app.services.auth import Principal, resolve_api_token
from app.services.configuration import resolve_settings
from app.services.documents import (
    create_document,
    document_json,
    purge_document,
    replace_document,
    review_document,
)
from app.services.providers import ProviderError
from app.services.retrieval import RetrievalConfig
from app.services.tuning import (
    TuningError,
    create_tuning_run,
    expand_grid,
    preset_candidates,
    tuning_json,
)

T = TypeVar("T")
Method = Literal["auto", "bm25", "vector", "hybrid", "hybrid_rerank"]
Scope = Literal["personal", "platform"]
Category = Literal["preference", "profile", "fact", "goal", "instruction", "other"]
READ = ToolAnnotations(read_only_hint=True, idempotent_hint=True, open_world_hint=False)
WRITE = ToolAnnotations(read_only_hint=False, destructive_hint=False, open_world_hint=False)
DESTRUCTIVE = ToolAnnotations(read_only_hint=False, destructive_hint=True, open_world_hint=False)

# Tools that only administrators may call.
ADMIN_TOOLS = {"review_list", "review_decide", "dataset_list", "tuning_start", "tuning_status", "tuning_apply"}

_principal: ContextVar[Principal | None] = ContextVar("mcp_principal", default=None)
# Account used by the stdio transport (and by in-process clients without an HTTP request).
_stdio_principal: Principal | None = None


class WorkbenchMCP(MCPServer):
    """Resolves the calling account, enforces admin-only tools and logs every call."""

    async def call_tool(self, name: str, arguments: dict[str, Any], context: Context | None = None) -> Any:
        request = None
        if context is not None:
            with suppress(ValueError):
                request = context.request_context.request
        principal = getattr(getattr(request, "state", None), "principal", None) if request is not None else None
        transport = "http" if request is not None else "stdio"
        principal = principal or _principal.get() or _stdio_principal
        started = time.perf_counter()
        error: str | None = None
        token = _principal.set(principal)
        try:
            if principal is None:
                raise ToolError("未认证：请使用个人访问令牌（HTTP: Authorization: Bearer rwb_...，stdio: RAG_MCP_TOKEN）")
            if name in ADMIN_TOOLS and not principal.is_admin:
                raise ToolError("该工具仅限管理员使用")
            result = await super().call_tool(name, arguments, context)
            if getattr(result, "is_error", False):
                error = _result_text(result)
            return result
        except Exception as exc:
            error = str(exc)[:1000] or type(exc).__name__
            raise
        finally:
            _principal.reset(token)
            if principal is not None:
                await log_mcp_call(principal, tool=name, arguments=arguments, transport=transport,
                                   latency_ms=(time.perf_counter() - started) * 1000, error=error)


def _result_text(result: Any) -> str:
    parts = [getattr(item, "text", "") for item in getattr(result, "content", []) or []]
    return " ".join(part for part in parts if part)[:1000] or "tool error"


mcp = WorkbenchMCP(
    "tracemind",
    instructions=(
        "Enterprise RAG workbench acting as the token owner's account. Typical flow: kb_list → rag_search "
        "(retrieval with a stage-by-stage trace) or rag_answer (cited answer, personalized by the caller's "
        "memories). Libraries and memories have scope 'platform' (shared) or 'personal' (private). Manage "
        "sources with document_upload/update/delete (PDF via base64, Markdown/TXT via text); uploads by "
        "employees into platform libraries wait for administrator approval. Keep long-term memory with "
        "memory_* tools: search before answering, add durable facts/preferences, merge duplicates. Employee "
        "writes to platform memory become proposals. IDs are decimal strings. rag_answer, memory_merge "
        "(without content), memory_extract and multi_query retrieval call the chat model and may incur cost."
    ),
)


def me() -> Principal:
    principal = _principal.get()
    if principal is None:
        raise ToolError("未认证")
    return principal


def _id(value: str, name: str = "id") -> int:
    if not (isinstance(value, str) and value.isascii() and value.isdecimal() and 0 < int(value) <= 2**63 - 1):
        raise ToolError(f"{name} must be a positive decimal identifier string")
    return int(value)


async def _call(operation: Awaitable[T]) -> T:
    """Turn caller-safe service failures into MCP tool errors, never leak internals."""
    try:
        return await operation
    except ToolError:
        raise
    except HTTPException as error:
        raise ToolError(str(error.detail)) from None
    except (memory.MemoryError, TuningError, ProviderError) as error:
        raise ToolError(str(error)) from None
    except ValidationError as error:
        raise ToolError("Invalid arguments: " + "; ".join(
            f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in error.errors()[:5])) from None


def _payload(content: str | None, content_base64: str | None) -> bytes:
    if (content is None) == (content_base64 is None):
        raise ToolError("Provide exactly one of content (Markdown/TXT text) or content_base64 (any file)")
    if content is not None:
        return content.encode("utf-8")
    try:
        return base64.b64decode(content_base64 or "", validate=True)
    except (binascii.Error, ValueError):
        raise ToolError("content_base64 is not valid base64") from None


async def _config(kb: KnowledgeBase, method: str, top_k: int, retrieval: dict | None,
                  document_ids: list[str] | None) -> RetrievalConfig:
    if retrieval is not None:
        data = dict(retrieval)
    elif method == "auto":
        data = dict(kb.retrieval_config) if kb.retrieval_config else RetrievalConfig.from_method(
            "hybrid_rerank").model_dump()
    else:
        data = RetrievalConfig.from_method(method).model_dump()
    data["top_k"] = top_k
    data["fusion_k"] = max(data.get("fusion_k", 20), top_k)
    if document_ids is not None:
        data["document_ids"] = [str(_id(d, "document_id")) for d in document_ids]
    return RetrievalConfig.model_validate(data)


async def _readable_kb(knowledge_base_id: str) -> KnowledgeBase:
    async with Session() as db:
        return await readable_kb(db, me(), _id(knowledge_base_id, "knowledge_base_id"))


async def _kb_view(db: Any, kb: KnowledgeBase) -> dict[str, Any]:
    return {**await kb_json(db, kb), "can_manage": can_manage_kb(me(), kb)}


def _hit(row: dict[str, Any], rank: int) -> dict[str, Any]:
    hit = {"rank": rank, "chunk_id": row["id"], "document_id": row["document_id"], "filename": row["filename"],
           "page": row["page"], "score": round(float(row.get("score", 0.0)), 6), "text": row["text"]}
    for key in ("context_before", "context_after"):
        if row.get(key):
            hit[key] = row[key]
    return hit


def _actor() -> str:
    return f"user:{me().id}"


def _visible(scope: str, row: dict[str, Any]) -> bool:
    """Employees see active platform memories plus their own proposals."""
    principal = me()
    if scope == "personal" or principal.is_admin or row["status"] == "active":
        return True
    return row.get("created_by") == str(principal.id)


async def _readable_memory(scope: str, memory_id: int) -> dict[str, Any]:
    row = await memory.get_memory(memory_namespace(me(), scope), memory_id)
    if not _visible(scope, row):
        raise ToolError("资源不存在")
    return row


# ───────────────────────────── knowledge bases & retrieval ─────────────────────────────

@mcp.tool(annotations=READ)
async def whoami() -> dict[str, Any]:
    """The account this MCP connection acts as (role decides which tools and scopes are allowed)."""
    return me().public()


@mcp.tool(annotations=READ)
async def kb_list(scope: Literal["all", "platform", "personal"] = "all") -> dict[str, Any]:
    """List knowledge bases visible to the caller (platform + own personal) with counts and config."""
    async with Session() as db:
        statement = scoped(KnowledgeBase).where(visible_kbs(me()))
        if scope != "all":
            statement = statement.where(KnowledgeBase.scope == scope)
        rows = (await db.scalars(statement.order_by(KnowledgeBase.scope.desc(), KnowledgeBase.id.desc()))).all()
        return {"knowledge_bases": [await _kb_view(db, kb) for kb in rows]}


@mcp.tool(annotations=WRITE)
async def kb_create(name: str, description: str = "", scope: Scope = "personal", chunk_size: int = 2200,
                    chunk_overlap: int = 400) -> dict:
    """Create a knowledge base. Employees create personal libraries; scope="platform" is admin-only."""
    async def run() -> dict:
        body = KBCreate(name=name, description=description, scope=scope, chunk_size=chunk_size,
                        chunk_overlap=chunk_overlap)
        if body.scope == "platform" and not me().is_admin:
            raise ToolError("只有管理员可以创建平台知识库")
        async with Session() as db:
            runtime = await resolve_settings(db=db)
            kb = KnowledgeBase(tenant_id=settings.tenant_id, **body.model_dump(), owner_id=me().id,
                               embedding_model=runtime.embedding_model,
                               embedding_dimensions=runtime.embedding_dimensions,
                               index_config=rag.index_settings_snapshot(runtime))
            db.add(kb)
            await db.flush()
            await db.refresh(kb)
            result = await _kb_view(db, kb)
            await db.commit()
            return result
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def kb_set_retrieval_config(knowledge_base_id: str, config: dict[str, Any] | None = None) -> dict:
    """Set a library's default retrieval pipeline (used by method="auto" and chat), null clears it.

    Requires management rights (platform: administrators, personal: owner). Fields: routes
    ["vector","bm25"], route_k, bm25_weight, vector_weight, rrf_k, fusion_k, rerank, query_rewrite
    ("none"|"multi_query"), rewrite_count, min_score (rerank only), dedupe_threshold, mmr_lambda,
    neighbor_window, top_k.
    """
    async def run() -> dict:
        validated = RetrievalConfig.model_validate(config).model_dump() if config else {}
        async with Session() as db:
            kb = await manageable_kb(db, me(), _id(knowledge_base_id, "knowledge_base_id"), lock=True)
            kb.retrieval_config = validated
            await db.flush()
            await db.refresh(kb)
            result = await _kb_view(db, kb)
            await db.commit()
            return result
    return await _call(run())


@mcp.tool(annotations=READ)
async def rag_search(knowledge_base_id: str, query: str, top_k: int = 5, method: Method = "auto",
                     retrieval: dict[str, Any] | None = None, document_ids: list[str] | None = None,
                     include_trace: bool = True) -> dict[str, Any]:
    """Retrieve the most relevant chunks for a query (no answer generation).

    method="auto" uses the library's tuned default, else hybrid_rerank. `retrieval` overrides with a
    full pipeline config. `document_ids` restricts recall to specific documents. The trace lists every
    stage (scope → query_rewrite → recall.vector/recall.bm25 → fusion → rerank → postprocess) with
    latency, counts and leading candidates.
    """
    async def run() -> dict:
        kb = await _readable_kb(knowledge_base_id)
        if not query.strip() or not 1 <= top_k <= 20:
            raise ToolError("query must be nonempty and top_k between 1 and 20")
        config = await _config(kb, method, top_k, retrieval, document_ids)
        started, error, count = time.perf_counter(), None, 0
        try:
            result = await rag.search(kb.id, query.strip(), config)
            count = len(result["supplied"])
        except Exception as exc:
            error = type(exc).__name__
            raise
        finally:
            await log_query(me(), source="mcp", action="search", knowledge_base_id=kb.id, kb_scope=kb.scope,
                            query=query, method=method, result_count=count,
                            latency_ms=(time.perf_counter() - started) * 1000, error=error)
        response = {"query": query, "results": [_hit(row, rank) for rank, row in enumerate(result["supplied"], 1)],
                    "retrieval_ms": result["retrieval_ms"], "retrieval_config": result["retrieval_config"]}
        if include_trace:
            response["queries"], response["trace"] = result["queries"], result["trace"]
        return response
    return await _call(run())


@mcp.tool(annotations=READ)
async def rag_answer(knowledge_base_id: str, question: str, use_memory: bool = True, top_k: int = 5,
                     method: Method = "auto", retrieval: dict[str, Any] | None = None,
                     include_trace: bool = False) -> dict[str, Any]:
    """Answer a question from the knowledge base with verified citations (calls the chat model).

    With use_memory, the caller's standing preferences/instructions, platform memories and memories
    relevant to the question personalize the answer, memories are never cited.
    The model abstains when the retrieved sources do not support an answer.
    """
    async def run() -> dict:
        kb = await _readable_kb(knowledge_base_id)
        if not question.strip() or not 1 <= top_k <= 20:
            raise ToolError("question must be nonempty and top_k between 1 and 20")
        config = await _config(kb, method, top_k, retrieval, None)
        runtime = await resolve_settings()
        memories = None
        if use_memory:
            memories = await memory.memories_for_answer(me().memory_namespace, question, runtime=runtime) or None
        started, error, count = time.perf_counter(), None, 0
        try:
            result = await rag.answer_question(kb.id, question.strip(), retrieval=config, runtime_settings=runtime,
                                               memories=memories)
            count, error = len(result["citations"]), result.get("error")
        except Exception as exc:
            error = type(exc).__name__
            raise
        finally:
            await log_query(me(), source="mcp", action="answer", knowledge_base_id=kb.id, kb_scope=kb.scope,
                            query=question, method=method, result_count=count,
                            latency_ms=(time.perf_counter() - started) * 1000, error=error)
        response = {"answer": result["answer"], "abstain": result["abstain"],
                    "citations": [_hit(row, rank) for rank, row in enumerate(result["citations"], 1)],
                    "memories_used": memories or [], "timing": result["timing"], "usage": result["usage"]}
        if include_trace:
            response["trace"] = result["trace"]
        return response
    return await _call(run())


# ───────────────────────────── documents ─────────────────────────────

@mcp.tool(annotations=READ)
async def document_list(knowledge_base_id: str) -> dict[str, Any]:
    """List documents of a knowledge base with processing and review status."""
    async def run() -> dict:
        async with Session() as db:
            kb = await readable_kb(db, me(), _id(knowledge_base_id, "knowledge_base_id"))
            rows = (await db.scalars(scoped(Document).where(Document.knowledge_base_id == kb.id,
                                                            visible_documents(me()))
                                     .order_by(Document.id.desc()))).all()
            return {"documents": [document_json(row) for row in rows]}
    return await _call(run())


@mcp.tool(annotations=READ)
async def document_get(document_id: str, include_text: bool = False, max_chars: int = 20000) -> dict[str, Any]:
    """Get one document's status, optionally its parsed text (truncated to max_chars)."""
    async def run() -> dict:
        async with Session() as db:
            document, _ = await readable_document(db, me(), _id(document_id, "document_id"))
            result = document_json(document)
            if include_text:
                text = document.markdown or ""
                result["text"], result["truncated"] = text[:max(0, max_chars)], len(text) > max_chars
                result["chunk_count_stored"] = await db.scalar(select(func.count(Chunk.id)).where(
                    Chunk.tenant_id == settings.tenant_id, Chunk.document_id == document.id))
            return result
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def document_upload(knowledge_base_id: str, filename: str, content: str | None = None,
                          content_base64: str | None = None) -> dict[str, Any]:
    """Upload a document for parsing and indexing (asynchronous, poll document_get for status=ready).

    Use `content` for Markdown (.md) or plain text (.txt), `content_base64` for PDF. The filename
    extension selects the type. Employee uploads into a platform library get review_status="pending"
    and are only parsed after an administrator approves them.
    """
    async def run() -> dict:
        data = _payload(content, content_base64)
        async with Session() as db:
            kb = await readable_kb(db, me(), _id(knowledge_base_id, "knowledge_base_id"))
            document = await create_document(db, kb.id, filename, data, uploader=me())
            result = document_json(document)
            await db.commit()
            return result
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def document_update(document_id: str, content: str | None = None, content_base64: str | None = None,
                          filename: str | None = None) -> dict[str, Any]:
    """Replace a ready document with new content without downtime (requires management rights).

    A new document version is ingested, the old one stays searchable until the new one is ready and is
    then deleted automatically. Returns the new document (track it with document_get).
    """
    async def run() -> dict:
        data = _payload(content, content_base64)
        async with Session() as db:
            await manageable_document(db, me(), _id(document_id, "document_id"))
            document = await replace_document(db, _id(document_id, "document_id"), data, filename, uploader=me())
            result = document_json(document)
            await db.commit()
            return result
    return await _call(run())


@mcp.tool(annotations=DESTRUCTIVE)
async def document_delete(document_id: str) -> dict[str, Any]:
    """Permanently delete a document: vectors, chunks, metadata and stored files.

    Requires management rights, except that uploaders may withdraw their own pending submissions.
    """
    async def run() -> dict:
        async with Session() as db:
            document, kb = await readable_document(db, me(), _id(document_id, "document_id"))
            check_document_removal(me(), kb, document)
        return await purge_document(document.id)
    return await _call(run())


# ───────────────────────────── memory ─────────────────────────────

@mcp.tool(annotations=WRITE)
async def memory_add(content: str, scope: Scope = "personal", category: Category = "other",
                     tags: list[str] | None = None, importance: int = 3, attributes: dict[str, Any] | None = None,
                     on_duplicate: Literal["skip", "update", "insert"] = "skip",
                     dedupe_threshold: float = 0.92) -> dict[str, Any]:
    """Store a long-term memory (one self-contained fact per memory).

    scope="personal" (default) is private to the caller. scope="platform" is shared with everyone:
    administrators write directly, employees submit a proposal (status "pending") for approval.
    Near-duplicates (same normalized text or cosine >= dedupe_threshold) are detected: "skip" returns the
    existing memory, "update" rewrites it with the new content, "insert" stores anyway.
    """
    proposal = scope == "platform" and not me().is_admin
    return await _call(memory.add_memory(memory_namespace(me(), scope), content, category=category, tags=tags,
                                         importance=importance, attributes=attributes,
                                         on_duplicate="skip" if proposal else on_duplicate,
                                         dedupe_threshold=dedupe_threshold, source="mcp", created_by=me().id,
                                         pending=proposal))


@mcp.tool(annotations=READ)
async def memory_search(query: str, scope: Scope = "personal", top_k: int = 5, categories: list[str] | None = None,
                        tags: list[str] | None = None, min_importance: int | None = None,
                        min_similarity: float | None = None) -> dict[str, Any]:
    """Semantic + keyword search over active memories of one scope (ranked, with similarity)."""
    return await _call(memory.search_memories(memory_namespace(me(), scope), query, top_k=top_k,
                                              categories=categories, tags=tags, min_importance=min_importance,
                                              min_similarity=min_similarity))


@mcp.tool(annotations=READ)
async def memory_list(scope: Scope = "personal",
                      status: Literal["active", "pending", "rejected", "merged", "deleted", "all"] = "active",
                      category: str | None = None, tag: str | None = None, limit: int = 50,
                      offset: int = 0) -> dict[str, Any]:
    """List memories newest first, with paging and filters. Employees see their own platform proposals."""
    created_by = me().id if scope == "platform" and not me().is_admin and status != "active" else None
    return await _call(memory.list_memories(memory_namespace(me(), scope), status=status, category=category,
                                            tag=tag, limit=limit, offset=offset, created_by=created_by))


@mcp.tool(annotations=READ)
async def memory_get(memory_id: str, scope: Scope = "personal") -> dict[str, Any]:
    """Get one memory."""
    return await _call(_readable_memory(scope, _id(memory_id, "memory_id")))


@mcp.tool(annotations=WRITE)
async def memory_update(memory_id: str, scope: Scope = "personal", content: str | None = None,
                        category: Category | None = None, tags: list[str] | None = None,
                        importance: int | None = None, attributes: dict[str, Any] | None = None,
                        expected_version: int | None = None) -> dict[str, Any]:
    """Update a memory (platform: administrators only).

    Pass expected_version (from memory_get) to avoid overwriting concurrent edits.
    """
    async def run() -> dict:
        require_memory_admin(me(), scope)
        return await memory.update_memory(memory_namespace(me(), scope), _id(memory_id, "memory_id"),
                                          content=content, category=category, tags=tags, importance=importance,
                                          attributes=attributes, expected_version=expected_version,
                                          actor=_actor())
    return await _call(run())


@mcp.tool(annotations=DESTRUCTIVE)
async def memory_delete(memory_ids: list[str], scope: Scope = "personal", hard: bool = False) -> dict[str, Any]:
    """Delete memories. Soft delete (default) can be undone with memory_restore, hard=True purges.

    Platform memories: administrators only, employees may withdraw their own pending proposals.
    """
    async def run() -> dict:
        ids = [_id(m, "memory_id") for m in memory_ids]
        if scope == "platform" and not me().is_admin:
            for memory_id in ids:
                row = await _readable_memory(scope, memory_id)
                if row["status"] != "pending" or row.get("created_by") != str(me().id):
                    raise ToolError("只有管理员可以删除平台记忆，员工仅可撤回自己待审批的提议")
        return await memory.delete_memories(memory_namespace(me(), scope), ids, hard=hard, actor=_actor())
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def memory_restore(memory_id: str, scope: Scope = "personal") -> dict[str, Any]:
    """Restore a soft-deleted memory (platform: administrators only)."""
    async def run() -> dict:
        require_memory_admin(me(), scope)
        return await memory.restore_memory(memory_namespace(me(), scope), _id(memory_id, "memory_id"),
                                           actor=_actor())
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def memory_merge(memory_ids: list[str], scope: Scope = "personal", content: str | None = None,
                       category: Category | None = None, tags: list[str] | None = None,
                       importance: int | None = None) -> dict[str, Any]:
    """Merge 2+ memories into a new one, sources are marked merged and linked to it.

    Without `content` the chat model writes the consolidated memory (later notes win on conflict).
    Tags are unioned and importance takes the maximum unless given. Platform: administrators only.
    """
    async def run() -> dict:
        require_memory_admin(me(), scope)
        return await memory.merge_memories(memory_namespace(me(), scope), [_id(m, "memory_id") for m in memory_ids],
                                           content=content, category=category, tags=tags, importance=importance,
                                           actor=_actor())
    return await _call(run())


@mcp.tool(annotations=READ)
async def memory_history(memory_id: str, scope: Scope = "personal") -> dict[str, Any]:
    """Audit trail of a memory: create/update/delete/merge/restore/purge/approve with snapshots."""
    async def run() -> dict:
        await _readable_memory(scope, _id(memory_id, "memory_id"))
        return {"events": await memory.memory_history(memory_namespace(me(), scope), _id(memory_id, "memory_id"))}
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def memory_extract(text: str, max_items: int = 10, dry_run: bool = False) -> dict[str, Any]:
    """Extract durable personal memories (preferences, profile, goals…) from conversation text.

    Calls the chat model. Duplicates of existing memories are skipped. dry_run returns candidates only.
    """
    return await _call(memory.extract_memories(me().memory_namespace, text, max_items=max_items, actor=_actor(),
                                               dry_run=dry_run))


@mcp.tool(annotations=DESTRUCTIVE)
async def memory_clear(confirm: bool, hard: bool = False) -> dict[str, Any]:
    """Delete ALL of the caller's personal memories (soft by default, hard=True purges). Needs confirm=true."""
    if confirm is not True:
        raise ToolError("Set confirm=true to delete every personal memory")
    return await _call(memory.clear_user(me().memory_namespace, hard=hard, actor=_actor()))


# ───────────────────────────── administrator review ─────────────────────────────

@mcp.tool(annotations=READ)
async def review_list() -> dict[str, Any]:
    """(Admin) Pending employee uploads into platform libraries and pending platform memory proposals."""
    async with Session() as db:
        rows = (await db.execute(
            select(Document, KnowledgeBase.name, User.username)
            .join(KnowledgeBase, KnowledgeBase.id == Document.knowledge_base_id)
            .outerjoin(User, User.id == Document.uploaded_by)
            .where(Document.tenant_id == settings.tenant_id, Document.review_status == "pending")
            .order_by(Document.id))).all()
    documents = [{**document_json(document), "knowledge_base_name": kb_name, "uploader": username or ""}
                 for document, kb_name, username in rows]
    return {"documents": documents, "memories": await memory.pending_platform_memories()}


@mcp.tool(annotations=WRITE)
async def review_decide(kind: Literal["document", "memory"], id: str, approve: bool,
                        note: str = "") -> dict[str, Any]:
    """(Admin) Approve or reject a pending document (approval starts parsing) or platform memory."""
    async def run() -> dict:
        if kind == "memory":
            return await memory.review_memory(_id(id), approve=approve, reviewer_id=me().id, note=note)
        async with Session() as db:
            document_id = _id(id)
            await owned(db, KnowledgeBase, (await owned(db, Document, document_id)).knowledge_base_id, lock=True)
            document = await review_document(db, document_id, approve=approve, reviewer=me(), note=note)
            await db.refresh(document)
            result = document_json(document)
            await db.commit()
            return result
    return await _call(run())


# ───────────────────────────── evaluation & tuning (admin) ─────────────────────────────

@mcp.tool(annotations=READ)
async def dataset_list() -> dict[str, Any]:
    """(Admin) List evaluation datasets (questions with gold evidence drive retrieval tuning)."""
    async with Session() as db:
        rows = (await db.scalars(scoped(Dataset).order_by(Dataset.id.desc()))).all()
        return {"datasets": [serialize(row) for row in rows]}


@mcp.tool(annotations=WRITE)
async def tuning_start(knowledge_base_id: str, dataset_id: str, name: str = "MCP tuning",
                       candidates: list[dict[str, Any]] | None = None, grid: dict[str, list] | None = None,
                       base: dict[str, Any] | None = None, objective: str = "mrr_at_10",
                       limit: int = 100) -> dict[str, Any]:
    """(Admin) Start a retrieval tuning run (no answer generation), rank configurations by `objective`.

    Candidates: explicit [{"name", "config"}], or `grid` (e.g. {"route_k": [20, 40], "rerank": [true,
    false]}) applied over `base`, or the built-in preset grid when both are omitted. Objectives: hit_at_k,
    recall_at_5/10, mrr_at_10, ndcg_at_10. Poll tuning_status, apply the winner with tuning_apply.
    """
    async def run() -> dict:
        if candidates:
            chosen = candidates
        elif grid:
            chosen = expand_grid(RetrievalConfig.model_validate(base or {}).model_dump(), grid)
        else:
            chosen = preset_candidates()
        async with Session() as db:
            await readable_kb(db, me(), _id(knowledge_base_id, "knowledge_base_id"))
            created = await create_tuning_run(db, name=name, knowledge_base_id=_id(knowledge_base_id),
                                              dataset_id=_id(dataset_id), candidates=chosen,
                                              objective=objective, limit=limit)
            result = tuning_json(created)
            await db.commit()
            return result
    return await _call(run())


@mcp.tool(annotations=READ)
async def tuning_status(run_id: str) -> dict[str, Any]:
    """(Admin) Progress and leaderboard (per-candidate mean metrics and latency) of a tuning run."""
    async def run() -> dict:
        async with Session() as db:
            return tuning_json(await owned(db, TuningRun, _id(run_id, "run_id")))
    return await _call(run())


@mcp.tool(annotations=WRITE)
async def tuning_apply(run_id: str, candidate: str) -> dict[str, Any]:
    """(Admin) Make a tuning candidate the knowledge base's default retrieval pipeline."""
    async def run() -> dict:
        async with Session() as db:
            tuning = await owned(db, TuningRun, _id(run_id, "run_id"))
            match = next((c for c in tuning.candidates if c["name"] == candidate), None)
            if match is None:
                raise ToolError("Candidate not found in this tuning run")
            kb = await manageable_kb(db, me(), tuning.knowledge_base_id, lock=True)
            kb.retrieval_config = match["config"]
            await db.flush()
            await db.refresh(kb)
            result = await _kb_view(db, kb)
            await db.commit()
            return result
    return await _call(run())


# Built once at import: session_manager exists only after the app is created.
mcp_http_app = mcp.streamable_http_app(streamable_http_path="/mcp", stateless_http=True, json_response=True)


async def _stdio(with_worker: bool, token: str) -> None:
    global _stdio_principal
    async with Session() as db:
        _stdio_principal = await resolve_api_token(db, token)
        await db.commit()
    if _stdio_principal is None:
        raise SystemExit("RAG_MCP_TOKEN (or --token) must be a valid personal access token (rwb_...)")
    worker = None
    if with_worker:
        from app.worker import serve_worker
        worker = asyncio.create_task(serve_worker(), name="rag-worker")
    try:
        await mcp.run_stdio_async()
    finally:
        if worker:
            worker.cancel()
            with suppress(asyncio.CancelledError):
                await worker


def _token_argument(argv: list[str]) -> str:
    if "--token" in argv:
        index = argv.index("--token")
        if index + 1 < len(argv):
            return argv[index + 1]
    return os.environ.get("RAG_MCP_TOKEN", "")


if __name__ == "__main__":
    from loguru import logger

    logger.remove()
    logger.add(sys.stderr, diagnose=False, backtrace=False)  # stdout carries the MCP protocol
    asyncio.run(_stdio("--with-worker" in sys.argv, _token_argument(sys.argv)))
