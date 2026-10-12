"""Resumable document ingestion; parsed/embedding caches never contain answer keys."""
import asyncio
import hashlib
import json
from pathlib import Path

from loguru import logger
from sqlalchemy import func, select

from app.api.common import chunk_json, owned, scoped
from app.config import settings
from app.db import Session, generate_id
from app.models import Chunk, Document, KnowledgeBase
from app.services.chunker import split_pages
from app.services.configuration import resolve_settings
from app.services.documents import SOURCE_FILES, purge_document, read_text_source
from app.services.parsing import parse_pdf
from app.services.providers import ProviderError, Providers
from app.services.rag import validate_index_config
from app.services.vectors import VectorStore


def document_dir(document_id: int) -> Path:
    return settings.data_dir / "documents" / str(document_id)


async def set_stage(document_id: int, stage: str) -> None:
    async with Session() as db:
        doc = await owned(db, Document, document_id)
        doc.status, doc.stage, doc.error = "processing", stage, None
        await db.commit()


async def ingest_document(document_id: int) -> None:
    folder = document_dir(document_id)
    async with Session() as db:
        doc = await owned(db, Document, document_id)
        kb = await owned(db, KnowledgeBase, doc.knowledge_base_id)
        if doc.status == "ready" or doc.review_status in ("pending", "rejected"):
            return
        runtime_settings = await resolve_settings(db=db)
        validate_index_config(kb, runtime_settings)
        kb_id, filename = kb.id, doc.filename
        chunk_size, overlap = kb.chunk_size, kb.chunk_overlap
        source_type, replaces = doc.source_type or "pdf", doc.replaces_document_id
    await set_stage(document_id, "parsing")
    if source_type == "pdf":
        parsed = await parse_pdf(folder / "source.pdf", folder / "parse", runtime_settings.mineru_base_url,
                                 lambda stage: set_stage(document_id, stage))
    else:
        # Markdown / plain text are already text: no external parser involved.
        parsed = await asyncio.to_thread(read_text_source, folder / SOURCE_FILES[source_type])
    await set_stage(document_id, "chunking")
    split = await asyncio.to_thread(split_pages, parsed["pages"], chunk_size, overlap)
    if not split:
        raise ProviderError("PDF 解析后没有可索引文本，请检查扫描质量或 MinerU 输出")
    async with Session() as db:
        doc = await owned(db, Document, document_id)
        existing = list((await db.scalars(scoped(Chunk).where(Chunk.document_id == doc.id).order_by(Chunk.chunk_index))).all())
        if not existing:
            count = await db.scalar(select(func.count(Chunk.id)).where(
                Chunk.tenant_id == settings.tenant_id, Chunk.knowledge_base_id == kb_id))
            if count + len(split) > runtime_settings.max_kb_chunks:
                raise ProviderError("文档加入后超过知识库容量上限，请创建另一个知识库")
            existing = [Chunk(id=generate_id(), tenant_id=settings.tenant_id, knowledge_base_id=kb_id,
                              document_id=doc.id, chunk_index=i, page=c["page"], text=c["text"])
                        for i, c in enumerate(split)]
            db.add_all(existing)
        doc.markdown, doc.page_count = parsed["markdown"], parsed["page_count"]
        await db.commit()
        chunks = [chunk_json(c, filename) for c in existing]
    await set_stage(document_id, "embedding")
    digest = hashlib.sha256(json.dumps({"model": runtime_settings.embedding_model, "url": runtime_settings.embedding_base_url,
        "dimensions": runtime_settings.embedding_dimensions, "texts": [c["text"] for c in chunks]}, ensure_ascii=False).encode()).hexdigest()
    cache = folder / "embeddings"
    cache.mkdir(exist_ok=True)
    providers, vectors = Providers(runtime_settings), VectorStore(runtime_settings)
    embeddings: list[list[float]] = []
    try:
        for start in range(0, len(chunks), 16):
            batch_path = cache / f"{digest}-{start}.json"
            if batch_path.exists():
                batch = json.loads(batch_path.read_text(encoding="utf-8"))
            else:
                values, usage = await providers.embed([c["text"] for c in chunks[start:start + 16]])
                batch = {"vectors": values, "usage": usage}
                temp = batch_path.with_suffix(".tmp")
                temp.write_text(json.dumps(batch), encoding="utf-8")
                temp.replace(batch_path)
            embeddings.extend(batch["vectors"])
        await set_stage(document_id, "indexing")
        await vectors.upsert(chunks, embeddings, kb_id, document_id)
        async with Session() as db:
            kb = await owned(db, KnowledgeBase, kb_id, lock=True)
            doc = await owned(db, Document, document_id, lock=True)
            doc.status, doc.stage, doc.error = "ready", "ready", None
            doc.chunk_count = len(chunks)
            kb.version += 1
            await db.commit()
    finally:
        await providers.close()
        await vectors.close()
    if replaces:
        try:
            await purge_document(replaces, enforce_mutable=False)
        except Exception:  # noqa: BLE001 - the new version is ready; a leftover old copy can be deleted manually.
            logger.opt(exception=True).error("Replaced document cleanup failed: old={}, new={}", replaces, document_id)
