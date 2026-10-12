"""Retrieval tuning runs: presets, grid expansion, durable execution and applying a winner."""
from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi import Path as PathParam
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import enqueue, kb_json, owned, scoped
from app.db import get_db
from app.models import KnowledgeBase, TuningRun
from app.schemas import TuningApply, TuningCreate
from app.services.metrics import RANKING_METRICS
from app.services.retrieval import RetrievalConfig
from app.services.tuning import (
    TuningError,
    create_tuning_run,
    expand_grid,
    preset_candidates,
    tuning_json,
)

router = APIRouter()
DB = Annotated[AsyncSession, Depends(get_db)]
ID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]


def resolve_candidates(body: TuningCreate) -> list[dict[str, Any]]:
    """Explicit candidates, a grid over a base config, or the preset grid (in that order)."""
    if body.candidates:
        return [{"name": c.name, "config": c.config.model_dump()} for c in body.candidates]
    if body.grid:
        return expand_grid((body.base or RetrievalConfig()).model_dump(), body.grid)
    return preset_candidates(body.include_paid_rewrite)


@router.get("/tuning/presets")
async def presets(include_paid_rewrite: bool = False) -> dict[str, Any]:
    return {"candidates": preset_candidates(include_paid_rewrite), "objectives": list(RANKING_METRICS),
            "tunable_fields": sorted(set(RetrievalConfig.model_fields) - {"document_ids"})}


@router.get("/tuning-runs")
async def list_runs(db: DB) -> list[dict[str, Any]]:
    rows = (await db.scalars(scoped(TuningRun).order_by(TuningRun.id.desc()).limit(100))).all()
    return [tuning_json(row) for row in rows]


@router.post("/tuning-runs", status_code=201)
async def create_run(body: TuningCreate, db: DB) -> dict[str, Any]:
    try:
        run = await create_tuning_run(db, name=body.name, knowledge_base_id=body.knowledge_base_id,
                                      dataset_id=body.dataset_id, candidates=resolve_candidates(body),
                                      objective=body.objective, limit=body.limit)
    except TuningError as error:
        raise HTTPException(400, str(error)) from None
    return tuning_json(run)


@router.get("/tuning-runs/{run_id}")
async def get_run(run_id: ID, db: DB, include_results: bool = False) -> dict[str, Any]:
    return tuning_json(await owned(db, TuningRun, run_id), include_results)


@router.post("/tuning-runs/{run_id}/pause")
async def pause_run(run_id: ID, db: DB) -> dict[str, Any]:
    run = await owned(db, TuningRun, run_id, lock=True)
    if run.status not in {"queued", "running"}:
        raise HTTPException(409, "只有排队或运行中的调优可以暂停")
    run.status = "paused"
    return tuning_json(run)


@router.post("/tuning-runs/{run_id}/resume")
async def resume_run(run_id: ID, db: DB) -> dict[str, Any]:
    run = await owned(db, TuningRun, run_id, lock=True)
    if run.status not in {"paused", "failed"}:
        raise HTTPException(409, "只有已暂停或失败的调优可以继续")
    # Failed pairs are retried; finished ones are kept.
    run.results = {name: {qid: row for qid, row in rows.items() if "error" not in row}
                   for name, rows in run.results.items()}
    run.failed = 0
    run.status, run.error = "queued", None
    enqueue(db, "tune", run.id)
    return tuning_json(run)


@router.post("/tuning-runs/{run_id}/apply")
async def apply_candidate(run_id: ID, body: TuningApply, db: DB) -> dict[str, Any]:
    """Make one candidate the library's default pipeline for chat and MCP."""
    run = await owned(db, TuningRun, run_id)
    match = next((c for c in run.candidates if c["name"] == body.candidate), None)
    if match is None:
        raise HTTPException(404, "调优任务中没有该候选配置")
    kb = await owned(db, KnowledgeBase, run.knowledge_base_id, lock=True)
    kb.retrieval_config = match["config"]
    await db.flush()
    await db.refresh(kb)
    return await kb_json(db, kb)
