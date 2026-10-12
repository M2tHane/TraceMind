"""RAG orchestration shared by interactive questions and evaluation runs."""
from collections.abc import Awaitable, Callable
from time import perf_counter
from typing import Any

from sqlalchemy import select

from app.api.common import chunk_json, owned
from app.config import Settings, settings
from app.db import Session
from app.models import Chunk, Document, KnowledgeBase
from app.services.configuration import resolve_settings
from app.services.providers import ProviderError, Providers
from app.services.retrieval import LEGACY_METHODS, Recall, RetrievalCache, RetrievalConfig
from app.services.vectors import VectorStore


def index_settings_snapshot(runtime_settings: Settings) -> dict[str, str]:
    """Return the non-secret identity of the embedding index for a new library."""
    return {name: getattr(runtime_settings, name) for name in (
        "embedding_base_url", "milvus_uri", "milvus_collection",
    )}


def validate_index_config(kb: KnowledgeBase, runtime_settings: Settings) -> None:
    """Reject incompatible or uninitialized indexes instead of mixing vector spaces."""
    expected = index_settings_snapshot(runtime_settings)
    if (kb.embedding_model != runtime_settings.embedding_model
            or kb.embedding_dimensions != runtime_settings.embedding_dimensions
            or not isinstance(kb.index_config, dict)
            or any(kb.index_config.get(name) != value for name, value in expected.items())):
        raise ProviderError("当前 Embedding 或向量库配置与知识库不一致，请恢复配置或创建新知识库")


def resolve_retrieval(method: str, top_k: int, candidate_k: int,
                      retrieval: RetrievalConfig | dict | None = None) -> RetrievalConfig | None:
    """Explicit pipeline settings win; otherwise the legacy method maps to an equivalent pipeline."""
    if method == "no_context":
        return None
    if retrieval is not None:
        return retrieval if isinstance(retrieval, RetrievalConfig) else RetrievalConfig.model_validate(retrieval)
    return RetrievalConfig.from_method(method, top_k, candidate_k)


async def load_ready_chunks(knowledge_base_id: int, runtime_settings: Settings) -> list[dict[str, Any]]:
    """Validate the index identity and load every chunk of ready documents in one knowledge base."""
    async with Session() as db:
        kb = await owned(db, KnowledgeBase, knowledge_base_id)
        validate_index_config(kb, runtime_settings)
        rows = (await db.execute(select(Chunk, Document.filename).join(
            Document, Chunk.document_id == Document.id
        ).where(
            Chunk.tenant_id == settings.tenant_id, Document.tenant_id == settings.tenant_id,
            Chunk.knowledge_base_id == kb.id, Document.knowledge_base_id == kb.id,
            Document.status == "ready",
        ).order_by(Chunk.id).limit(runtime_settings.max_kb_chunks + 1))).all()
    if len(rows) > runtime_settings.max_kb_chunks:
        raise ProviderError("知识库超过本地 BM25 工作台容量上限，请拆分知识库")
    chunks = [chunk_json(chunk, filename) for chunk, filename in rows]
    if not chunks:
        raise ProviderError("知识库还没有可检索文档，请等待解析与索引完成")
    return chunks


async def answer_question(
    knowledge_base_id: int, question: str, method: str = "hybrid_rerank", top_k: int = 5,
    candidate_k: int = 20, retrieval_only: bool = False, history: list[dict] | None = None,
    progress: Callable[[str], Awaitable[None]] | None = None,
    before_model_call: Callable[[], Awaitable[None]] | None = None,
    runtime_settings: Settings | None = None,
    retrieval: RetrievalConfig | dict | None = None,
    memories: list[str] | None = None,
    cache: RetrievalCache | None = None,
) -> dict[str, Any]:
    runtime_settings = runtime_settings if runtime_settings is not None else await resolve_settings()
    providers = Providers(runtime_settings)
    vectors = VectorStore(runtime_settings)
    started = perf_counter()
    try:
        config = resolve_retrieval(method, top_k, candidate_k, retrieval)
        if config is None:
            async with Session() as db:
                await owned(db, KnowledgeBase, knowledge_base_id)
            recall = {"contexts": [], "supplied": [], "trace": [], "queries": [question], "embedding_tokens": 0}
        else:
            chunks = await load_ready_chunks(knowledge_base_id, runtime_settings)
            recall = await Recall(providers, vectors, cache=cache, before_model_call=before_model_call,
                                  progress=progress).run(question, chunks, config, knowledge_base_id)
        retrieval_ms = (perf_counter() - started) * 1000
        supplied = recall["supplied"]
        if retrieval_only:
            answer = {"answer": "", "citations": [], "abstain": False, "usage": {}, "latency_ms": 0}
        elif method != "no_context" and not supplied:
            answer = {"answer": "当前知识库没有找到足够的参考材料，无法据此回答。", "citations": [],
                      "abstain": True, "usage": {}, "latency_ms": 0}
        else:
            if progress:
                await progress("generating")
            if before_model_call:
                await before_model_call()
            answer = await providers.answer(question, supplied,
                                            method=method if method in {*LEGACY_METHODS, "no_context"}
                                            else "hybrid_rerank",
                                            history=history, memories=memories)
        by_id = {c["id"]: c for c in supplied}
        cited_ids = list(dict.fromkeys(answer["citations"]))
        if any(cid not in by_id for cid in cited_ids):
            raise ProviderError("模型返回了不在本次材料中的引用，未展示该回答")
        return {
            "answer": answer["answer"], "abstain": answer["abstain"], "method": method,
            "citations": [by_id[cid] for cid in cited_ids], "contexts": recall["contexts"],
            "generation_context_ids": list(by_id), "retrieval_only": retrieval_only,
            "retrieval_config": config.model_dump() if config else None,
            "queries": recall["queries"], "trace": recall["trace"],
            "timing": {"retrieval_ms": round(retrieval_ms, 2), "generation_ms": answer.get("latency_ms", 0)},
            "usage": {**answer.get("usage", {}), "embedding_tokens": recall["embedding_tokens"]},
        }
    finally:
        await providers.close()
        await vectors.close()


async def search(knowledge_base_id: int, query: str, config: RetrievalConfig,
                 runtime_settings: Settings | None = None) -> dict[str, Any]:
    """Retrieval only (no generation): ranked chunks plus the full recall trace."""
    runtime_settings = runtime_settings if runtime_settings is not None else await resolve_settings()
    providers, vectors = Providers(runtime_settings), VectorStore(runtime_settings)
    started = perf_counter()
    try:
        chunks = await load_ready_chunks(knowledge_base_id, runtime_settings)
        recall = await Recall(providers, vectors).run(query, chunks, config, knowledge_base_id)
        return {**recall, "retrieval_ms": round((perf_counter() - started) * 1000, 2),
                "retrieval_config": config.model_dump()}
    finally:
        await providers.close()
        await vectors.close()
