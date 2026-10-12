"""Datasets and immutable, resumable experiment runs."""
import csv
import hashlib
import io
import json
from typing import Annotated

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi import Path as PathParam
from fastapi.responses import JSONResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.common import dataset_json, enqueue, owned, scoped, serialize
from app.config import ROOT, settings
from app.db import generate_id, get_db
from app.models import Dataset, Document, EvalItem, EvalRun, KnowledgeBase, Question
from app.schemas import DatasetCreate, QuestionInput, RunCreate
from app.services.configuration import resolve_settings
from app.services.providers import ProviderError
from app.services.rag import validate_index_config

router = APIRouter()
DB = Annotated[AsyncSession, Depends(get_db)]
ID = Annotated[int, PathParam(gt=0, le=2**63 - 1)]


@router.get("/datasets")
async def datasets(db: DB) -> list[dict]:
    rows = (await db.scalars(scoped(Dataset).order_by(Dataset.created_at.desc()))).all()
    return [await dataset_json(db, row) for row in rows]


@router.post("/datasets", status_code=201)
async def create_dataset(body: DatasetCreate, db: DB) -> dict:
    row = Dataset(tenant_id=settings.tenant_id, **body.model_dump())
    db.add(row)
    await db.flush()
    return await dataset_json(db, row)


@router.get("/datasets/{dataset_id}/questions")
async def questions(dataset_id: ID, db: DB) -> list[dict]:
    await owned(db, Dataset, dataset_id)
    rows = (await db.scalars(scoped(Question).where(Question.dataset_id == dataset_id).order_by(Question.id))).all()
    return [serialize(row) for row in rows]


@router.post("/datasets/{dataset_id}/questions", status_code=201)
async def add_question(dataset_id: ID, body: QuestionInput, db: DB) -> dict:
    await owned(db, Dataset, dataset_id, lock=True)
    duplicate = await db.scalar(scoped(Question).where(Question.dataset_id == dataset_id, Question.question == body.question))
    if duplicate:
        raise HTTPException(409, "评测集中已有相同问题")
    row = Question(tenant_id=settings.tenant_id, dataset_id=dataset_id, **body.model_dump())
    db.add(row)
    await db.flush()
    return serialize(row)


@router.patch("/questions/{question_id}")
async def edit_question(question_id: ID, body: QuestionInput, db: DB) -> dict:
    row = await owned(db, Question, question_id, lock=True)
    duplicate = await db.scalar(scoped(Question).where(Question.dataset_id == row.dataset_id,
                                                       Question.id != row.id, Question.question == body.question))
    if duplicate:
        raise HTTPException(409, "评测集中已有相同问题")
    for name, val in body.model_dump().items():
        setattr(row, name, val)
    await db.flush()
    return serialize(row)


def validated_questions(raw: list[dict]) -> list[QuestionInput]:
    if not raw or len(raw) > 1000:
        raise HTTPException(400, "一次需要导入 1 到 1000 道题")
    validated: list[QuestionInput] = []
    seen: set[str] = set()
    for index, row in enumerate(raw, 1):
        fields = {k: row[k] for k in QuestionInput.model_fields if k in row}
        if fields.get("review_status") == "auto_checked_pending_human_review":
            fields["review_status"] = "pending"
        if isinstance(fields.get("evidence"), str):
            try:
                fields["evidence"] = json.loads(fields["evidence"] or "[]")
            except ValueError as exc:
                raise HTTPException(400, f"第 {index} 行证据不是有效 JSON") from exc
        try:
            question = QuestionInput.model_validate(fields)
        except ValidationError as exc:
            raise HTTPException(400, f"第 {index} 行问题格式有误，请检查题目、可答性和证据字段") from exc
        if question.question in seen:
            raise HTTPException(400, f"第 {index} 行问题重复，未导入任何题目")
        seen.add(question.question)
        validated.append(question)
    return validated


async def insert_questions(db: AsyncSession, dataset_id: int, rows: list[QuestionInput]) -> None:
    existing = set((await db.scalars(select(Question.question).where(
        Question.tenant_id == settings.tenant_id, Question.dataset_id == dataset_id))).all())
    if any(q.question in existing for q in rows):
        raise HTTPException(409, "导入包含评测集中已有的问题，未导入任何题目")
    db.add_all([Question(tenant_id=settings.tenant_id, dataset_id=dataset_id, **q.model_dump()) for q in rows])
    await db.flush()


@router.post("/datasets/{dataset_id}/import")
async def import_questions(dataset_id: ID, db: DB, file: UploadFile = File(...)) -> dict:
    dataset = await owned(db, Dataset, dataset_id, lock=True)
    blob = await file.read(10 * 1024 * 1024 + 1)
    await file.close()
    if len(blob) > 10 * 1024 * 1024:
        raise HTTPException(413, "题库文件不能超过 10 MB")
    try:
        text = blob.decode("utf-8-sig")
        if (file.filename or "").lower().endswith(".csv"):
            raw = list(csv.DictReader(io.StringIO(text)))
        else:
            raw = [json.loads(line) for line in text.splitlines() if line.strip()]
        if not all(isinstance(row, dict) for row in raw):
            raise ValueError("Expected objects")
    except (UnicodeError, ValueError, csv.Error) as exc:
        raise HTTPException(400, "请上传 UTF-8 编码的 JSONL 或 CSV 文件") from exc
    rows = validated_questions(raw)
    await insert_questions(db, dataset.id, rows)
    return {**await dataset_json(db, dataset), "imported": len(rows)}


@router.post("/datasets/import-example")
async def import_example(db: DB) -> dict:
    name = "论文问答示例 · 100 题"
    existing = await db.scalar(scoped(Dataset).where(Dataset.name == name))
    if existing:
        return await dataset_json(db, existing)
    path = ROOT / "examples/questions.jsonl"
    if not path.exists():
        raise HTTPException(404, "示例题库未安装")
    raw = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = validated_questions(raw)
    dataset = Dataset(tenant_id=settings.tenant_id, name=name,
                      description="4 篇公开论文，90 可答 / 10 不可答；自动标注，待人工审核。PDF 需单独上传入库。")
    db.add(dataset)
    await db.flush()
    await insert_questions(db, dataset.id, rows)
    return await dataset_json(db, dataset)


@router.get("/runs")
async def runs(db: DB) -> list[dict]:
    return [serialize(row) for row in (await db.scalars(scoped(EvalRun).order_by(EvalRun.created_at.desc()))).all()]


@router.post("/runs", status_code=201)
async def create_run(body: RunCreate, db: DB) -> dict:
    kb = await owned(db, KnowledgeBase, body.knowledge_base_id, lock=True)
    if kb.scope != "platform":
        # Runs and their answers are shared by all administrators, so personal libraries never enter them.
        raise HTTPException(409, "评测仅支持平台知识库")
    await owned(db, Dataset, body.dataset_id, lock=True)
    runtime_settings = await resolve_settings(db=db)
    try:
        validate_index_config(kb, runtime_settings)
    except ProviderError as error:
        raise HTTPException(409, str(error)) from None
    unfinished = await db.scalar(scoped(Document).where(Document.knowledge_base_id == kb.id,
                                                        Document.status.in_(["queued", "processing"])))
    if unfinished:
        raise HTTPException(409, "请等待知识库处理完成后冻结评测版本")
    ready = await db.scalar(select(func.count(Document.id)).where(
        Document.tenant_id == settings.tenant_id, Document.knowledge_base_id == kb.id, Document.status == "ready"))
    if not ready and any(method != "no_context" for method in body.methods):
        raise HTTPException(400, "知识库中还没有可检索文档")
    questions = list((await db.scalars(scoped(Question).where(Question.dataset_id == body.dataset_id)
                                      .order_by(Question.id).limit(body.limit))).all())
    if not questions:
        raise HTTPException(400, "评测集为空，请先添加题目")
    snapshot = [serialize(q) for q in questions]
    config = {"kb_version": kb.version, "chat_model": runtime_settings.chat_model,
              "chat_protocol": runtime_settings.chat_protocol, "json_mode": runtime_settings.json_mode,
              "embedding_model": runtime_settings.embedding_model, "rerank_model": runtime_settings.rerank_model,
              "rerank_protocol": runtime_settings.rerank_protocol,
              "embedding_dimensions": runtime_settings.embedding_dimensions, "top_k": 5, "candidate_k": 20,
              "max_output_tokens": runtime_settings.max_output_tokens,
              "model_timeout": runtime_settings.model_timeout,
              "chat_base_url": runtime_settings.chat_base_url,
              "embedding_base_url": runtime_settings.embedding_base_url,
              "rerank_base_url": runtime_settings.rerank_base_url,
              "milvus_uri": runtime_settings.milvus_uri, "milvus_collection": runtime_settings.milvus_collection,
              "question_ids": [str(q.id) for q in questions], "question_snapshot": snapshot,
              "dataset_sha256": hashlib.sha256(json.dumps(snapshot, sort_keys=True, ensure_ascii=False).encode()).hexdigest(),
              "scoring_label": "automatic lexical proxy / optional model judge; not human gold",
              "retrieval_backend": "Milvus + local BM25Plus(delta=0) + RRF(k=60)"}
    run = EvalRun(id=generate_id(), tenant_id=settings.tenant_id, name=body.name,
                  dataset_id=body.dataset_id, knowledge_base_id=kb.id, methods=body.methods,
                  judge_enabled=body.judge_enabled, total=len(questions) * len(body.methods), config=config)
    db.add(run)
    for question in questions:
        for method in body.methods:
            db.add(EvalItem(tenant_id=settings.tenant_id, run_id=run.id, question_id=question.id,
                           question=question.question, reference_answer=question.reference_answer,
                           answerable=question.answerable, evidence=question.evidence, method=method))
    enqueue(db, "evaluate", run.id)
    await db.flush()
    return serialize(run)


@router.get("/runs/{run_id}")
async def get_run(run_id: ID, db: DB) -> dict:
    return serialize(await owned(db, EvalRun, run_id))


@router.get("/runs/{run_id}/items")
async def run_items(run_id: ID, db: DB) -> list[dict]:
    await owned(db, EvalRun, run_id)
    return [serialize(row) for row in (await db.scalars(scoped(EvalItem).where(
        EvalItem.run_id == run_id).order_by(EvalItem.question_id, EvalItem.method))).all()]


@router.post("/runs/{run_id}/pause")
async def pause_run(run_id: ID, db: DB) -> dict:
    row = await owned(db, EvalRun, run_id, lock=True)
    if row.status in {"queued", "running"}:
        row.status = "paused"
    await db.flush()
    return serialize(row)


@router.post("/runs/{run_id}/resume")
async def resume_run(run_id: ID, db: DB) -> dict:
    row = await owned(db, EvalRun, run_id, lock=True)
    if row.status not in {"paused", "failed"}:
        raise HTTPException(409, "只有暂停或失败的实验可以恢复")
    kb = await owned(db, KnowledgeBase, row.knowledge_base_id)
    if kb.version != row.config["kb_version"]:
        raise HTTPException(409, "知识库版本已经变化，请创建新实验")
    row.status, row.error = "queued", None
    enqueue(db, "evaluate", row.id)
    await db.flush()
    return serialize(row)


@router.post("/runs/{run_id}/retry-failed")
async def retry_run(run_id: ID, db: DB) -> dict:
    row = await owned(db, EvalRun, run_id, lock=True)
    if row.status in {"running", "queued"}:
        raise HTTPException(409, "请等待实验完成或暂停后再重试")
    kb = await owned(db, KnowledgeBase, row.knowledge_base_id)
    if kb.version != row.config["kb_version"]:
        raise HTTPException(409, "知识库版本已经变化，请创建新实验")
    items = (await db.scalars(scoped(EvalItem).where(EvalItem.run_id == row.id))).all()
    count = 0
    for item in items:
        failed_answer = item.result_payload is None and item.status == "failed" and item.attempts < 3
        missing_judge = row.judge_enabled and item.result_payload is not None and item.judgment is None and item.judge_attempts < 3
        if failed_answer or missing_judge:
            item.status = "queued"
            count += 1
    if not count:
        raise HTTPException(400, "没有可重试的任务，或已达到每项最多 3 次上限")
    row.status, row.error = "queued", None
    enqueue(db, "evaluate", row.id)
    await db.flush()
    return serialize(row)


@router.get("/runs/{run_id}/export")
async def export_run(run_id: ID, db: DB) -> JSONResponse:
    run = await owned(db, EvalRun, run_id)
    rows = (await db.scalars(scoped(EvalItem).where(EvalItem.run_id == run.id).order_by(EvalItem.id))).all()
    return JSONResponse({"run": serialize(run), "items": [{**serialize(row), "attempt_history": row.attempt_history} for row in rows]},
                        headers={"Content-Disposition": f'attachment; filename="experiment-{run.id}.json"'})
