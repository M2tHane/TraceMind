"""Resumable evaluation execution and coverage-aware automatic/lexical summaries.

Question/reference/evidence snapshots are read from EvalItem, never from a live
edited dataset. Gold is passed only to metrics and the optional judge. No DB
transaction is held while a model call is in flight.
"""

from __future__ import annotations

import asyncio
import copy
import math
from collections.abc import Sequence
from datetime import UTC, datetime
from statistics import fmean
from typing import Any
from weakref import WeakValueDictionary

from loguru import logger
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, settings
from app.db import Session
from app.models import EvalItem, EvalRun, KnowledgeBase
from app.services.configuration import resolve_settings
from app.services.metrics import answer_metrics, retrieval_metrics
from app.services.providers import AccountUnavailable, ProviderError, Providers
from app.services.rag import answer_question, validate_index_config

_MAX_ATTEMPTS = 3
_RUN_LOCKS: WeakValueDictionary[int, asyncio.Lock] = WeakValueDictionary()
_METRIC_KEYS = ("exact_match", "token_f1", "hit_at_5", "evidence_recall_at_5", "mrr_at_10")


class EvaluationPaused(ProviderError):
    """Internal control flow: no further paid call may start for this run."""


def _valid_judgment(judgment: object) -> bool:
    return (isinstance(judgment, dict) and type(judgment.get("correct")) is bool
            and type(judgment.get("faithful")) is bool and isinstance(judgment.get("reason"), str)
            and bool(judgment["reason"].strip()))


def _metrics(item: EvalItem) -> dict[str, Any]:
    result = item.result_payload
    metrics = answer_metrics(result.get("answer", "") if result else "", item.reference_answer or "")
    if not result and item.reference_answer and item.reference_answer.strip():
        # A failed generation is not a correct empty answer, even for unusual labels.
        metrics.update(exact_match=0.0, token_f1=0.0)
    metrics.update(retrieval_metrics(result.get("contexts", []) if result else [], item.evidence or []))
    return metrics


def _number(value: object) -> float | None:
    if type(value) not in (int, float):
        return None
    try:
        return float(value) if math.isfinite(value) else None
    except OverflowError:
        return None


def _p95(samples: list[float]) -> float | None:
    return sorted(samples)[math.ceil(len(samples) * 0.95) - 1] if samples else None


def _total_tokens(payload: object) -> int:
    if not isinstance(payload, dict) or not isinstance(payload.get("usage"), dict):
        return 0
    count = payload["usage"].get("total_tokens", 0)
    return count if type(count) is int and count >= 0 else 0


def _observations(item: EvalItem) -> dict[str, Any]:
    # Reuse durable metrics rather than repeating quote alignment for every item
    # on every progress refresh (which would make a run quadratic in corpus work).
    expected: set[str] = set()
    if (item.reference_answer or "").strip():
        expected.update(("exact_match", "token_f1"))
    if item.evidence:
        expected.update(("hit_at_5", "evidence_recall_at_5", "mrr_at_10"))
    saved = item.metrics or {}
    if not item.result_payload or any(_number(saved.get(key)) is None for key in expected):
        return _metrics(item)
    return {key: saved[key] for key in expected}


def _build_summary(items: Sequence[EvalItem], methods: Sequence[str]) -> dict[str, Any]:
    grouped: dict[str, Any] = {}
    for method in dict.fromkeys([*methods, *(item.method for item in items)]):
        rows = [item for item in items if item.method == method]
        observations = [_observations(item) for item in rows]
        judgments = [item.judgment for item in rows if _valid_judgment(item.judgment)]
        pending = sum(item.status in {"queued", "running"} for item in rows)
        completed = sum(bool(item.result_payload) for item in rows)
        failed = sum(item.status == "failed" and not item.result_payload for item in rows)
        tokens = sum(_total_tokens(item.result_payload) + _total_tokens(item.judgment) for item in rows)
        row_summary: dict[str, Any] = {
            "count": len(rows), "completed": completed, "failed": failed, "pending": pending,
            "scored": len(judgments), "unscored": len(rows) - len(judgments),
            "answer_labeled": sum(bool((item.reference_answer or "").strip()) for item in rows),
            "evidence_labeled": sum(bool(item.evidence) for item in rows),
            "auto_correct": (fmean(float(judgment["correct"]) for judgment in judgments)
                             if rows and not pending and len(judgments) == len(rows) else None),
            "total_tokens": tokens, "evaluation_complete": not bool(pending),
        }
        for metric in _METRIC_KEYS:
            observed = [value for result in observations if (value := _number(result.get(metric))) is not None]
            # Failed labeled generations contribute zero. Queued/running rows never
            # disappear from a denominator to create a deceptively final accuracy.
            row_summary[metric] = fmean(observed) if observed and not pending else None
            row_summary[metric + "_denominator"] = len(observed)
        for phase in ("retrieval", "generation"):
            samples: list[float] = []
            for item in rows:
                timing = (item.result_payload or {}).get("timing", {})
                elapsed = _number(timing.get(phase + "_ms")) if isinstance(timing, dict) else None
                if elapsed is not None and elapsed >= 0:
                    samples.append(elapsed)
            row_summary[phase + "_p95_ms"] = _p95(samples)
        grouped[method] = row_summary
    return {
        "by_method": grouped,
        "note": (
            "Automatic/lexical proxies, not human scores. Retrieval uses quoted-text lexical mapping, "
            "not page-hit relevance. Failed labeled generations remain in lexical denominators. "
            "Pending cohorts have no final metric; auto_correct is null unless every item has a valid "
            "automatic judgment. Missing judges are unscored, never assumed incorrect. Token usage "
            "includes recorded answer and judge usage; unavailable failed-call usage is not estimated."
        ),
    }


async def _run(db: AsyncSession, run_id: int, *, lock: bool = False) -> EvalRun:
    statement = select(EvalRun).where(EvalRun.tenant_id == settings.tenant_id, EvalRun.id == run_id)
    run = await db.scalar(statement.with_for_update() if lock else statement)
    if run is None:
        raise ProviderError("Evaluation run is unavailable")
    return run


async def _item(db: AsyncSession, run_id: int, item_id: int) -> EvalItem:
    item = await db.scalar(select(EvalItem).where(
        EvalItem.tenant_id == settings.tenant_id, EvalItem.run_id == run_id, EvalItem.id == item_id,
    ).with_for_update())
    if item is None:
        raise ProviderError("Evaluation item is unavailable")
    return item


async def _preflight(run_id: int, runtime_settings: Settings) -> None:
    paused_reason: str | None = None
    async with Session() as db, db.begin():
        run = await _run(db, run_id, lock=True)
        if run.status not in {"queued", "running"}:
            paused_reason = "Evaluation is paused or no longer running"
        else:
            kb = await db.scalar(select(KnowledgeBase).where(
                KnowledgeBase.tenant_id == settings.tenant_id, KnowledgeBase.id == run.knowledge_base_id,
            ))
            expected = {
                "kb_version": kb.version if kb is not None else None,
                "chat_model": runtime_settings.chat_model, "embedding_model": runtime_settings.embedding_model,
                "rerank_model": runtime_settings.rerank_model,
                "embedding_dimensions": runtime_settings.embedding_dimensions,
            }
            for key in ("chat_base_url", "embedding_base_url", "rerank_base_url", "max_output_tokens",
                        "model_timeout", "milvus_uri", "milvus_collection"):
                if key in run.config:
                    expected[key] = getattr(runtime_settings, key)
            legacy_protocols = {"chat_protocol": "openai_chat", "json_mode": True,
                                "rerank_protocol": "dashscope"}
            protocol_mismatch = any(
                run.config.get(key, legacy) != getattr(runtime_settings, key)
                for key, legacy in legacy_protocols.items()
            )
            index_mismatch = kb is None
            if kb is not None:
                try:
                    validate_index_config(kb, runtime_settings)
                except ProviderError:
                    index_mismatch = True
            if (index_mismatch or protocol_mismatch
                    or any(run.config.get(key) != value for key, value in expected.items())):
                paused_reason = "Evaluation paused: knowledge base or model configuration differs from its snapshot"
                run.status, run.error = "paused", paused_reason
    if paused_reason:
        raise EvaluationPaused(paused_reason)


def _safe_error(error: Exception, stage: str, run_id: int, item_id: int) -> str:
    message = str(error) if isinstance(error, ProviderError) else f"Evaluation {stage} failed unexpectedly"
    # ProviderError is a sanitized adapter boundary. Do not log raw DB/HTTP
    # exceptions or diagnose frame locals (which may hold prompts/credentials).
    sanitized = ProviderError(message)
    logger.opt(exception=(ProviderError, sanitized, None)).error(
        "Evaluation {} failed: run_id={}, item_id={}, category={}", stage, run_id, item_id,
        type(error).__name__, exc_info=True,
    )
    return message


def _history(item: EvalItem, stage: str, message: str) -> None:
    count = item.attempts if stage == "generation" else item.judge_attempts
    item.attempt_history = [*(item.attempt_history or []), {
        "stage": stage, "attempt": count, "error": message,
        "at": datetime.now(UTC).isoformat(),
    }]


def _judge_input(result: dict[str, Any]) -> dict[str, Any]:
    identifiers = result.get("generation_context_ids")
    contexts = result.get("contexts")
    citations = result.get("citations", [])
    if (not isinstance(identifiers, list) or any(not isinstance(identifier, str) for identifier in identifiers)
            or not isinstance(contexts, list) or not isinstance(citations, list)):
        raise ProviderError("Judge withheld: actual generation context snapshot is missing")
    by_id = {row["id"]: row for row in contexts if isinstance(row, dict) and isinstance(row.get("id"), str)}
    allowed = set(identifiers)
    if any(identifier not in by_id for identifier in identifiers):
        raise ProviderError("Judge withheld: actual generation context snapshot is incomplete")
    if any(not isinstance(row, dict) or row.get("id") not in allowed for row in citations):
        raise ProviderError("Judge withheld: a citation is outside the generation context snapshot")
    if result.get("method") == "no_context" and (identifiers or citations):
        raise ProviderError("Judge withheld: no-context result unexpectedly contains sources")
    return {"answer": result.get("answer", ""), "abstain": result.get("abstain", False),
            "method": result.get("method"), "generation_context_ids": list(dict.fromkeys(identifiers)),
            "contexts": [copy.deepcopy(by_id[identifier]) for identifier in dict.fromkeys(identifiers)],
            "citations": copy.deepcopy(citations)}


async def _record_failure(run_id: int, item_id: int, stage: str, error: Exception) -> None:
    message = _safe_error(error, stage, run_id, item_id)
    async with Session() as db, db.begin():
        run, item = await _run(db, run_id, lock=True), await _item(db, run_id, item_id)
        _history(item, stage, message)
        if stage == "generation":
            item.error = message
            item.metrics = _metrics(item)
        else:
            item.judge_error = message
            item.judgment = None
        if isinstance(error, AccountUnavailable):
            run.status, run.error, item.status = "paused", message, "queued"
        else:
            item.status = "failed" if stage == "generation" else "completed"


async def _requeue_after_pause(run_id: int, item_id: int) -> None:
    async with Session() as db, db.begin():
        item = await _item(db, run_id, item_id)
        if item.status == "running":
            item.status = "queued"


async def _evaluate_item(run_id: int, item_id: int, runtime_settings: Settings) -> None:
    await _preflight(run_id, runtime_settings)
    async with Session() as db, db.begin():
        run, item = await _run(db, run_id), await _item(db, run_id, item_id)
        if item.status not in {"queued", "running"}:
            return
        needs_answer = not bool(item.result_payload)
        if needs_answer and item.attempts >= _MAX_ATTEMPTS:
            item.status, item.error = "failed", "Generation attempt limit reached"
            item.metrics = _metrics(item)
            return
        item.status = "running"
        if needs_answer:
            item.attempts += 1
        kb_id, question, method = run.knowledge_base_id, item.question, item.method
        top_k, candidate_k = run.config.get("top_k", 5), run.config.get("candidate_k", 20)
    if needs_answer:
        try:
            async def before_model_call() -> None:
                await _preflight(run_id, runtime_settings)

            # Only the question reaches answer generation. Reference/evidence do not.
            result = await answer_question(kb_id, question, method=method, top_k=top_k,
                                           candidate_k=candidate_k, before_model_call=before_model_call,
                                           runtime_settings=runtime_settings)
            if not isinstance(result, dict) or not isinstance(result.get("answer"), str) or not result["answer"].strip():
                raise ProviderError("Generation returned no valid answer payload")
        except EvaluationPaused:
            await _requeue_after_pause(run_id, item_id)
            raise
        except Exception as error:  # noqa: BLE001 - isolate one item; sanitize at the service boundary.
            await _record_failure(run_id, item_id, "generation", error)
            if isinstance(error, AccountUnavailable):
                raise EvaluationPaused("Evaluation paused because the model account is unavailable") from None
            return
        async with Session() as db, db.begin():
            item = await _item(db, run_id, item_id)
            item.result_payload, item.error = result, None
            item.metrics = _metrics(item)
    # Generation is now durable, even if paused/terminated before judging.
    async with Session() as db, db.begin():
        run, item = await _run(db, run_id), await _item(db, run_id, item_id)
        item.metrics = _metrics(item)
        if not run.judge_enabled or _valid_judgment(item.judgment):
            item.status = "completed"
            if _valid_judgment(item.judgment):
                item.judge_error = None
            return
        item.judgment = None
        if item.judge_attempts >= _MAX_ATTEMPTS:
            item.status, item.judge_error = "completed", "Judge attempt limit reached"
            return
        payload = copy.deepcopy(item.result_payload)
        question, reference, answerable = item.question, item.reference_answer, item.answerable
    try:
        await _preflight(run_id, runtime_settings)
    except EvaluationPaused:
        await _requeue_after_pause(run_id, item_id)
        raise
    async with Session() as db, db.begin():
        item = await _item(db, run_id, item_id)
        item.judge_attempts += 1
    provider: Providers | None = None
    try:
        candidate = _judge_input(payload)
        await _preflight(run_id, runtime_settings)
        provider = Providers(runtime_settings)
        judgment = await provider.judge(question, reference, answerable, candidate)
        if not _valid_judgment(judgment):
            raise ProviderError("Judge returned an invalid judgment schema")
    except EvaluationPaused:
        await _requeue_after_pause(run_id, item_id)
        raise
    except Exception as error:  # noqa: BLE001 - invalid/missing judges are unscored, never false labels.
        await _record_failure(run_id, item_id, "judge", error)
        if isinstance(error, AccountUnavailable):
            raise EvaluationPaused("Evaluation paused because the model account is unavailable") from None
        return
    finally:
        if provider is not None:
            try:
                await provider.close()
            except Exception as error:  # noqa: BLE001 - cleanup must not discard an already paid valid judgment.
                _safe_error(error, "judge_cleanup", run_id, item_id)
    async with Session() as db, db.begin():
        item = await _item(db, run_id, item_id)
        item.judgment, item.judge_error, item.status = judgment, None, "completed"


async def refresh_summary(run_id: int) -> dict[str, Any]:
    """Persist method summaries and answer/failure counts for a tenant-owned run."""
    try:
        async with Session() as db, db.begin():
            run = await _run(db, run_id, lock=True)
            items = (await db.execute(select(EvalItem).where(
                EvalItem.tenant_id == settings.tenant_id, EvalItem.run_id == run_id,
            ).order_by(EvalItem.id))).scalars().all()
            summary = _build_summary(items, run.methods)
            run.summary = summary
            run.completed = sum(bool(item.result_payload) for item in items)
            run.failed = sum(item.status == "failed" and not item.result_payload for item in items)
            if run.status == "running" and all(item.status in {"completed", "failed"} for item in items):
                run.status = "completed"
            return summary
    except ProviderError:
        raise
    except Exception as error:  # noqa: BLE001 - sanitize DB/serialization errors at the public service boundary.
        raise ProviderError(_safe_error(error, "summary", run_id, 0)) from None


async def execute_run(run_id: int) -> None:
    """Execute each queued/recovering item at most once per explicit invocation.

    Retry routes must explicitly requeue failed/missing-judge items. Successful
    answers and valid judgments are never regenerated; three attempts per stage
    is a lifetime cap. A quota error pauses the run immediately with its answer
    checkpoint intact. The local worker serializes duplicate jobs for this run.
    """
    lock = _RUN_LOCKS.setdefault(run_id, asyncio.Lock())
    async with lock:
        try:
            # One resolved copy spans every answer/judge call in this invocation.
            # A later resume resolves again and must match the immutable run snapshot.
            runtime_settings = await resolve_settings()
            await _preflight(run_id, runtime_settings)
            async with Session() as db, db.begin():
                run = await _run(db, run_id, lock=True)
                if run.status not in {"queued", "running"}:
                    return
                run.status, run.error = "running", None
                items = (await db.execute(select(EvalItem).where(
                    EvalItem.tenant_id == settings.tenant_id, EvalItem.run_id == run_id,
                    EvalItem.status.in_(["queued", "running"]),
                ).order_by(EvalItem.id))).scalars().all()
                item_ids = [item.id for item in items]
            for item_id in item_ids:
                await _evaluate_item(run_id, item_id, runtime_settings)
                await refresh_summary(run_id)
        except EvaluationPaused:
            logger.info("Evaluation stopped before further model calls: run_id={}", run_id)
        except Exception as error:  # noqa: BLE001 - worker must receive only sanitized service errors.
            raise ProviderError(_safe_error(error, "execution", run_id, 0)) from None
        finally:
            await refresh_summary(run_id)
