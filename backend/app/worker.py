"""PostgreSQL-backed job lanes; no Redis, no in-memory-only task queue."""
import asyncio
import time
from contextlib import suppress

from loguru import logger
from sqlalchemy import text, update

from app.api.common import owned, scoped
from app.config import settings
from app.db import Session, engine
from app.models import (
    Conversation,
    Document,
    EvalItem,
    EvalRun,
    Job,
    MemoryConsolidationRun,
    Message,
    TuningRun,
)
from app.services.configuration import resolve_settings
from app.services.providers import ProviderError


def safe_error(exc: Exception) -> str:
    return str(exc)[:1000] if isinstance(exc, ProviderError) else "任务执行失败，请检查服务连接及服务端日志后重试"


async def _log_chat(params: dict, kb_id: int, started: float, result_count: int = 0,
                    error: str | None = None) -> None:
    from app.services.audit import log_query
    from app.services.auth import Principal
    who = params.get("principal")
    principal = Principal(id=who["id"], username=who["username"], display_name="", role=who["role"]) if who else None
    await log_query(principal, source="chat", action="answer", knowledge_base_id=kb_id,
                    kb_scope=params.get("kb_scope", "personal"), query=params["question"],
                    method=params.get("method", ""), result_count=result_count,
                    latency_ms=(time.perf_counter() - started) * 1000, error=error)


async def answer_message(message_id: int, params: dict) -> None:
    from app.services.citations import strip_markers
    from app.services.rag import answer_question
    async with Session() as db:
        message = await owned(db, Message, message_id)
        if message.status == "completed":
            return
        conversation = await owned(db, Conversation, message.conversation_id)
        history = (await db.scalars(scoped(Message).where(
            Message.conversation_id == conversation.id, Message.id < message.id,
            Message.status == "completed").order_by(Message.id.desc()).limit(7))).all()
        # Current user question is already supplied separately.
        history_rows = [{"role": m.role, "content": strip_markers(m.content)} for m in reversed(history)
                        if m.content != params["question"]]
        message.status, message.stage = "processing", "retrieving"
        await db.commit()
        kb_id = conversation.knowledge_base_id

    async def progress(stage: str) -> None:
        async with Session() as db:
            msg = await owned(db, Message, message_id)
            msg.stage = stage
            await db.commit()

    runtime_settings = await resolve_settings(params.get("model_config"))
    started = time.perf_counter()
    try:
        result = await answer_question(kb_id, params["question"], method=params.get("method", "hybrid_rerank"),
                                       top_k=params.get("top_k", 5), candidate_k=params.get("candidate_k", 20),
                                       history=history_rows, progress=progress, runtime_settings=runtime_settings,
                                       retrieval=params.get("retrieval"))
    except Exception as exc:
        await _log_chat(params, kb_id, started, error=safe_error(exc))
        raise
    await _log_chat(params, kb_id, started, result_count=len(result["contexts"]))
    async with Session() as db:
        message = await owned(db, Message, message_id)
        message.content = result["answer"]
        message.citations, message.contexts = result["citations"], result["contexts"]
        message.timing, message.usage = result["timing"], result["usage"]
        message.retrieval_trace = {"config": result.get("retrieval_config"), "queries": result.get("queries", []),
                                   "stages": result.get("trace", [])}
        message.status, message.stage, message.error = "completed", "completed", None
        await db.commit()


async def process_job(job_id: int, job_type: str, resource_id: int, params: dict) -> None:
    try:
        if job_type == "parse":
            from app.services.ingestion import ingest_document
            await ingest_document(resource_id)
        elif job_type == "chat":
            await answer_message(resource_id, params)
        elif job_type == "evaluate":
            from app.services.evaluation import execute_run
            await execute_run(resource_id)
        elif job_type == "tune":
            from app.services.tuning import execute_tuning
            await execute_tuning(resource_id)
        elif job_type == "consolidate":
            from app.services.memory_consolidation import execute_run
            await execute_run(resource_id)
        else:
            raise ValueError("Unsupported job type")
        async with Session() as db:
            job = await owned(db, Job, job_id)
            job.status, job.error = "completed", None
            await db.commit()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        message = safe_error(exc)
        logger.opt(exception=True).error("Job failed: id={}, kind={}, resource={}", job_id, job_type, resource_id)
        async with Session() as db:
            job = await owned(db, Job, job_id)
            job.status, job.error = "failed", message
            model = {"parse": Document, "chat": Message, "evaluate": EvalRun, "tune": TuningRun,
                     "consolidate": MemoryConsolidationRun}.get(job_type)
            if model:
                row = await owned(db, model, resource_id)
                row.status, row.error = "failed", message
                if hasattr(row, "stage"):
                    row.stage = "failed"
            await db.commit()


async def lane(job_type: str) -> None:
    while True:
        try:
            async with Session() as db:
                job = await db.scalar(scoped(Job).where(Job.status == "queued", Job.job_type == job_type)
                                      .order_by(Job.id).with_for_update(skip_locked=True).limit(1))
                if job:
                    job.status = "running"
                    job_id, resource_id, params = job.id, job.resource_id, job.params
                    await db.commit()
            if job:
                await process_job(job_id, job_type, resource_id, params)
            else:
                await asyncio.sleep(0.75)
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.opt(exception=True).error("Worker lane interrupted: {}", job_type)
            await asyncio.sleep(3)


async def serve_worker() -> None:
    tasks: list[asyncio.Task] = []
    # One supervisor owns recovery; lanes within it run independently so parsing
    # does not prevent questions against already-ready documents.
    async with engine.connect() as lock_connection:
        acquired = await lock_connection.scalar(text("SELECT pg_try_advisory_lock(731802602)"))
        await lock_connection.commit()
        if not acquired:
            logger.info("Another workbench worker already owns the queue")
            return
        try:
            async with Session() as db:
                for model, previous, next_state in [(Job, "running", "queued"), (Message, "processing", "queued"),
                                                     (EvalItem, "running", "queued"),
                                                     (TuningRun, "running", "queued")]:
                    await db.execute(update(model).where(model.tenant_id == settings.tenant_id,
                                                         model.status == previous).values(status=next_state))
                await db.commit()
            from app.services import memory_consolidation
            await memory_consolidation.recover_interrupted()
            tasks = [asyncio.create_task(lane(kind), name=f"rag-{kind}")
                     for kind in ("parse", "chat", "chat", "evaluate", "tune", "consolidate")]
            if settings.memory_consolidation_enabled:
                tasks.append(asyncio.create_task(memory_consolidation.scheduler(), name="rag-memory-consolidation"))
            logger.info("Worker ready: parse=1, chat=2, evaluation=1, tuning=1, memory consolidation={}",
                        f"every {settings.memory_consolidation_interval_minutes} min"
                        if settings.memory_consolidation_enabled else "manual only")
            await asyncio.gather(*tasks)
        finally:
            for task in tasks:
                task.cancel()
            for task in tasks:
                with suppress(asyncio.CancelledError):
                    await task
            await lock_connection.execute(text("SELECT pg_advisory_unlock(731802602)"))
            await lock_connection.commit()


if __name__ == "__main__":
    asyncio.run(serve_worker())
