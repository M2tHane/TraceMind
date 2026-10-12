"""Retrieval-only parameter tuning over labelled questions.

A tuning run freezes the questions that carry gold evidence plus a list of named
RetrievalConfig candidates, then executes every (question, candidate) pair without
answer generation. Questions are iterated in the outer loop so one RetrievalCache
reuses query embeddings, rewrites and reranker scores across all candidates: adding
a candidate costs (almost) no extra paid calls.

Progress is committed after every question, so pause/resume and worker restarts
only redo unfinished questions. Results are the same lexical evidence proxy as the
evaluation module, not human relevance judgments.
"""
from __future__ import annotations

import itertools
import statistics
from time import perf_counter
from typing import Any

from loguru import logger
from sqlalchemy.orm.attributes import flag_modified

from app.api.common import owned
from app.config import Settings
from app.db import Session
from app.models import KnowledgeBase, TuningRun
from app.services.configuration import resolve_settings
from app.services.metrics import RANKING_METRICS, ranking_metrics
from app.services.providers import AccountUnavailable, ProviderError, Providers
from app.services.rag import load_ready_chunks, validate_index_config
from app.services.retrieval import Recall, RetrievalCache, RetrievalConfig
from app.services.vectors import VectorStore

MAX_CANDIDATES = 24


class TuningError(ValueError):
    pass


def preset_candidates(include_paid_rewrite: bool = False) -> list[dict[str, Any]]:
    """A practical default grid: single routes, fusion weights, rerank and post-processing."""
    presets: list[tuple[str, dict[str, Any]]] = [
        ("bm25", RetrievalConfig.from_method("bm25").model_dump()),
        ("vector", RetrievalConfig.from_method("vector").model_dump()),
        ("hybrid", RetrievalConfig.from_method("hybrid").model_dump()),
        ("hybrid_vector_heavy", {**RetrievalConfig.from_method("hybrid").model_dump(), "vector_weight": 2.0}),
        ("hybrid_bm25_heavy", {**RetrievalConfig.from_method("hybrid").model_dump(), "bm25_weight": 2.0}),
        ("hybrid_rerank", RetrievalConfig.from_method("hybrid_rerank").model_dump()),
        ("hybrid_rerank_wide", {**RetrievalConfig.from_method("hybrid_rerank").model_dump(),
                                "route_k": 40, "fusion_k": 30}),
        ("hybrid_rerank_dedupe_mmr", {**RetrievalConfig.from_method("hybrid_rerank").model_dump(),
                                      "dedupe_threshold": 0.85, "mmr_lambda": 0.7}),
    ]
    if include_paid_rewrite:
        presets.append(("multi_query_rerank", {**RetrievalConfig.from_method("hybrid_rerank").model_dump(),
                                               "query_rewrite": "multi_query", "rewrite_count": 3}))
    return [{"name": name, "config": config} for name, config in presets]


def expand_grid(base: dict[str, Any], grid: dict[str, list[Any]], prefix: str = "grid") -> list[dict[str, Any]]:
    """Cartesian product of parameter values applied on top of a base configuration."""
    if not grid:
        raise TuningError("grid 至少需要一个参数")
    allowed = set(RetrievalConfig.model_fields) - {"document_ids"}
    if unknown := set(grid) - allowed:
        raise TuningError("不支持的调参字段：" + ", ".join(sorted(unknown)))
    if any(not isinstance(values, list) or not values for values in grid.values()):
        raise TuningError("grid 中每个参数都需要非空取值列表")
    keys = sorted(grid)
    combos = list(itertools.product(*(grid[key] for key in keys)))
    if len(combos) > MAX_CANDIDATES:
        raise TuningError(f"参数组合 {len(combos)} 个，超过上限 {MAX_CANDIDATES}")
    return [{"name": prefix + ":" + ",".join(f"{k}={v}" for k, v in zip(keys, combo, strict=True)),
             "config": {**base, **dict(zip(keys, combo, strict=True))}} for combo in combos]


def validate_candidates(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if not 1 <= len(candidates) <= MAX_CANDIDATES:
        raise TuningError(f"候选配置须为 1-{MAX_CANDIDATES} 个")
    names = [c.get("name") for c in candidates]
    if any(not isinstance(n, str) or not 1 <= len(n) <= 200 for n in names) or len(set(names)) != len(names):
        raise TuningError("候选配置名称须唯一且为 1-200 个字符")
    validated = []
    for candidate in candidates:
        try:
            config = RetrievalConfig.model_validate(candidate.get("config") or {})
        except ValueError as error:
            raise TuningError(f"候选配置 {candidate['name']} 无效：{error}") from None
        validated.append({"name": candidate["name"], "config": config.model_dump()})
    return validated


def _mean(values: list[float]) -> float | None:
    return round(statistics.fmean(values), 4) if values else None


def summarize(run: TuningRun) -> list[dict[str, Any]]:
    """Per-candidate means, ranked by the objective, then nDCG, Hit@1 and Recall@5.

    Latency is reported but never ranks: candidates share one paid-call cache, so whichever
    runs first for a question pays the real embedding/rerank latency.
    """
    board = []
    for candidate in run.candidates:
        rows = list(run.results.get(candidate["name"], {}).values())
        ok = [row for row in rows if "error" not in row]
        latency = sorted(row["latency_ms"] for row in ok)
        entry: dict[str, Any] = {"name": candidate["name"], "questions": len(rows), "failed": len(rows) - len(ok),
                                 "latency_p50_ms": round(statistics.median(latency), 2) if latency else None,
                                 "latency_p95_ms": round(latency[min(len(latency) - 1, int(len(latency) * .95))], 2)
                                 if latency else None}
        for metric in RANKING_METRICS:
            entry[metric] = _mean([row["metrics"][metric] for row in ok if metric in row["metrics"]])
        board.append(entry)
    keys = [run.objective, "ndcg_at_10", "hit_at_1", "recall_at_5"]
    return sorted(board, key=lambda e: tuple(-(e.get(key) or 0.0) for key in keys))


async def _status(run_id: int) -> str:
    async with Session() as db:
        return (await owned(db, TuningRun, run_id)).status


async def execute_tuning(run_id: int) -> None:
    async with Session() as db:
        run = await owned(db, TuningRun, run_id)
        if run.status not in {"queued", "running"}:
            return
        run.status, run.error = "running", None
        await db.commit()
        kb_id, frozen_version = run.knowledge_base_id, run.config["kb_version"]
        candidates = [(c["name"], RetrievalConfig.model_validate(c["config"])) for c in run.candidates]
        questions = run.config["questions"]
    runtime: Settings = await resolve_settings()
    providers, vectors = Providers(runtime), VectorStore(runtime)
    cache = RetrievalCache()
    try:
        async with Session() as db:
            kb = await owned(db, KnowledgeBase, kb_id)
            validate_index_config(kb, runtime)
            if kb.version != frozen_version:
                raise ProviderError("知识库在调优创建后发生变化，请重新创建调优任务")
        chunks = await load_ready_chunks(kb_id, runtime)
        for question in questions:
            if await _status(run_id) != "running":
                logger.info("Tuning paused before question: run_id={}", run_id)
                return
            async with Session() as db:
                done = {name for name, _ in candidates
                        if question["id"] in (await owned(db, TuningRun, run_id)).results.get(name, {})}
            rows: dict[str, dict[str, Any]] = {}
            for name, config in candidates:
                if name in done:
                    continue
                started = perf_counter()
                try:
                    recall = await Recall(providers, vectors, cache=cache).run(
                        question["question"], chunks, config, kb_id)
                    rows[name] = {"metrics": ranking_metrics(recall["contexts"], question["evidence"]),
                                  "latency_ms": round((perf_counter() - started) * 1000, 2),
                                  "top_ids": [row["id"] for row in recall["contexts"][:10]]}
                except AccountUnavailable:
                    raise
                except ProviderError as error:
                    rows[name] = {"error": str(error)[:500]}
            async with Session() as db:
                run = await owned(db, TuningRun, run_id, lock=True)
                for name, row in rows.items():
                    run.results.setdefault(name, {})[question["id"]] = row
                run.completed += sum("error" not in row for row in rows.values())
                run.failed += sum("error" in row for row in rows.values())
                flag_modified(run, "results")
                run.leaderboard = summarize(run)
                await db.commit()
        async with Session() as db:
            run = await owned(db, TuningRun, run_id)
            run.status, run.leaderboard = "completed", summarize(run)
            await db.commit()
    except AccountUnavailable:
        async with Session() as db:
            run = await owned(db, TuningRun, run_id)
            run.status, run.error = "paused", "模型账户不可用，调优已暂停；恢复额度后可继续"
            await db.commit()
    finally:
        await providers.close()
        await vectors.close()


async def create_tuning_run(db: Any, *, name: str, knowledge_base_id: int, dataset_id: int,
                            candidates: list[dict[str, Any]], objective: str = "mrr_at_10",
                            limit: int = 100) -> TuningRun:
    """Freeze labelled questions and candidates, then enqueue; caller commits."""
    from sqlalchemy import func, select

    from app.api.common import enqueue, scoped
    from app.config import settings
    from app.db import generate_id
    from app.models import Dataset, Document, Question

    if objective not in RANKING_METRICS:
        raise TuningError("objective 须为 " + "/".join(RANKING_METRICS))
    if not 1 <= limit <= 1000:
        raise TuningError("limit 须在 1-1000 之间")
    candidates = validate_candidates(candidates)
    kb = await owned(db, KnowledgeBase, knowledge_base_id, lock=True)
    if kb.scope != "platform":
        # Results are shared by all administrators, so personal libraries never enter them.
        raise TuningError("检索调优仅支持平台知识库")
    await owned(db, Dataset, dataset_id)
    runtime = await resolve_settings(db=db)
    try:
        validate_index_config(kb, runtime)
    except ProviderError as error:
        raise TuningError(str(error)) from None
    if await db.scalar(scoped(Document).where(Document.knowledge_base_id == kb.id,
                                              Document.status.in_(["queued", "processing"])).limit(1)):
        raise TuningError("请等待知识库处理完成后再调优")
    ready = await db.scalar(select(func.count(Document.id)).where(
        Document.tenant_id == settings.tenant_id, Document.knowledge_base_id == kb.id, Document.status == "ready"))
    if not ready:
        raise TuningError("知识库中还没有可检索文档")
    rows = (await db.scalars(scoped(Question).where(Question.dataset_id == dataset_id, Question.answerable)
                             .order_by(Question.id))).all()
    questions = [{"id": str(q.id), "question": q.question, "evidence": q.evidence} for q in rows if q.evidence][:limit]
    if not questions:
        raise TuningError("评测集中没有带证据标注的可回答题目，无法计算检索指标")
    run = TuningRun(id=generate_id(), tenant_id=settings.tenant_id, name=name, dataset_id=dataset_id,
                    knowledge_base_id=kb.id, objective=objective, candidates=candidates,
                    total=len(questions) * len(candidates), results={}, leaderboard=[],
                    config={"kb_version": kb.version, "questions": questions,
                            "embedding_model": runtime.embedding_model, "rerank_model": runtime.rerank_model,
                            "metric_label": "lexical evidence proxy; not human relevance"})
    db.add(run)
    enqueue(db, "tune", run.id)
    await db.flush()
    return run


def tuning_json(run: TuningRun, include_results: bool = False) -> dict[str, Any]:
    from app.api.common import serialize

    data = serialize(run, exclude=set() if include_results else {"results"})
    data["config"] = {k: v for k, v in run.config.items() if k != "questions"}
    data["question_count"] = len(run.config.get("questions", []))
    data["best"] = run.leaderboard[0] if run.leaderboard else None
    return data
