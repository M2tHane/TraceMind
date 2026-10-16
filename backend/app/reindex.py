"""Rebuild every ready document into a new Milvus collection and repoint libraries to it.

    .venv/bin/python -m app.reindex --collection rag_workbench_chunks_v2 [--allow-embedding]

Use it when the collection schema changes (e.g. adding the BM25 full-text fields): an
existing collection is never edited. Chunks come from PostgreSQL and vectors from each
document's embedding cache; a missing cache aborts unless --allow-embedding permits paid
Embedding calls. Only libraries indexed in the current collection move; once every
document is written, those libraries and the runtime Milvus setting switch in one
transaction. The old collection is left untouched for rollback. Stop the API and worker
first, and wait until no document is queued or processing.
"""
from __future__ import annotations

import argparse
import asyncio
import sys

from sqlalchemy import select
from sqlalchemy.orm.attributes import flag_modified

from app.api.common import chunk_json
from app.config import settings
from app.db import Session, engine
from app.models import Chunk, Document, KnowledgeBase
from app.services.configuration import configuration_row, resolve_settings
from app.services.ingestion import cached_embeddings, document_dir
from app.services.providers import ProviderError, Providers
from app.services.vectors import VectorStore


async def reindex(collection: str, allow_embedding: bool) -> None:
    runtime = await resolve_settings()
    if collection == runtime.milvus_collection:
        raise ProviderError("目标集合与当前集合相同")
    target = runtime.model_copy(update={"milvus_collection": collection})
    async with Session() as db:
        kbs = [kb for kb in (await db.scalars(select(KnowledgeBase).where(
            KnowledgeBase.tenant_id == settings.tenant_id))).all()
            if kb.index_config.get("milvus_collection") == runtime.milvus_collection
            and kb.index_config.get("milvus_uri") == runtime.milvus_uri]
        kb_ids = [kb.id for kb in kbs]
        busy = await db.scalar(select(Document.id).where(
            Document.tenant_id == settings.tenant_id, Document.knowledge_base_id.in_(kb_ids),
            Document.status.in_(("queued", "processing", "deleting"))).limit(1))
        if busy is not None:
            raise ProviderError(f"文档 {busy} 仍在处理中，请等待完成后再迁移")
        documents = (await db.execute(select(Document.id, Document.knowledge_base_id, Document.filename).where(
            Document.tenant_id == settings.tenant_id, Document.knowledge_base_id.in_(kb_ids),
            Document.status == "ready").order_by(Document.id))).all()
    providers = Providers(runtime) if allow_embedding else None
    vectors = VectorStore(target)
    written = 0
    try:
        for document_id, kb_id, filename in documents:
            async with Session() as db:
                rows = (await db.scalars(select(Chunk).where(
                    Chunk.tenant_id == settings.tenant_id, Chunk.document_id == document_id,
                ).order_by(Chunk.chunk_index))).all()
            chunks = [chunk_json(chunk, filename) for chunk in rows]
            if not chunks:
                continue
            embeddings = await cached_embeddings(document_dir(document_id), [c["text"] for c in chunks],
                                                 runtime, providers)
            await vectors.upsert(chunks, embeddings, kb_id, document_id)
            written += len(chunks)
            print(f"文档 {document_id}（{filename}）：{len(chunks)} 块")
    finally:
        await vectors.close()
        if providers is not None:
            await providers.close()
    async with Session() as db, db.begin():
        for kb in (await db.scalars(select(KnowledgeBase).where(KnowledgeBase.id.in_(kb_ids))
                                    .with_for_update())).all():
            kb.index_config = {**kb.index_config, "milvus_collection": collection}
            kb.version += 1
        row = await configuration_row(db, lock=True)
        row.config = {**row.config, "milvus": {**row.config.get("milvus", {}), "collection": collection}}
        flag_modified(row, "config")
    print(f"已写入 {written} 块到 {collection}；{len(kb_ids)} 个知识库已切换，旧集合 "
          f"{runtime.milvus_collection} 保留未动")


async def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.reindex")
    parser.add_argument("--collection", required=True, help="new rag_workbench_* collection name")
    parser.add_argument("--allow-embedding", action="store_true", help="embed documents whose cache is missing")
    args = parser.parse_args(argv)
    try:
        await reindex(args.collection, args.allow_embedding)
        return 0
    except ProviderError as error:
        print(f"失败：{error}", file=sys.stderr)
        return 1
    finally:
        await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
