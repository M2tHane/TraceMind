"""Isolated Milvus collection adapter; every SDK call runs off the event loop.

Only rag_workbench_* collections are accepted. There are intentionally no drop or
migration methods, and an incompatible existing schema is never edited. Deletion is
limited to one document's vectors under the mandatory tenant + knowledge base scope.

Each row carries the chunk text as well as its dense vector: Milvus derives a BM25
sparse vector from the text (jieba words, lowercased, punctuation dropped), so the
keyword route is a server-side full-text search instead of an in-process rebuild.
BM25 term statistics span the whole collection, not one knowledge base.
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any, Protocol

from loguru import logger
from pymilvus import DataType, Function, FunctionType, MilvusClient

from app.services.providers import ProviderError

# Fixed at collection creation; changing it means building a new collection.
TEXT_ANALYZER = {"tokenizer": "jieba", "filter": ["lowercase", "cnalphanumonly"]}
TEXT_MAX_BYTES = 65535


class VectorSettings(Protocol):
    milvus_uri: str
    milvus_collection: str
    embedding_dimensions: int
    tenant_id: int


def _error(message: str) -> ProviderError:
    error = ProviderError(message)
    logger.opt(exception=(ProviderError, error, None)).error("Vector service failure: {}", message, exc_info=True)
    return error


def _identifier(value: object) -> str:
    # Filters can contain only canonical decimal integer IDs, never arbitrary
    # user text. Reject bools/floats rather than silently truncating/coercing them.
    if not (type(value) is int or isinstance(value, str) and re.fullmatch(r"[0-9]+", value)):
        raise _error("Vector scope identifiers must be positive integers")
    number = int(value)
    if number < 1 or number > 2**63 - 1:
        raise _error("Vector scope identifiers must be positive 64-bit integers")
    return str(number)


class VectorStore:
    """MilvusClient wrapper using string IDs, COSINE search and tenant/KB scope."""

    def __init__(self, settings: VectorSettings) -> None:
        self.settings = settings
        self.collection = settings.milvus_collection
        if not re.fullmatch(r"rag_workbench_[A-Za-z0-9_]{1,240}", self.collection):
            raise _error("Vector collection must use the isolated rag_workbench_ namespace")
        if type(settings.embedding_dimensions) is not int or settings.embedding_dimensions < 1:
            raise _error("Vector dimensions must be a positive integer")
        self._tenant_id = _identifier(settings.tenant_id)
        self._client: MilvusClient | None = None
        self._ready = False
        self._lock = asyncio.Lock()

    def _ensure_sync(self) -> None:
        if self._client is None:
            self._client = MilvusClient(uri=self.settings.milvus_uri, timeout=30)
        if not self._client.has_collection(collection_name=self.collection):
            schema = self._client.create_schema(auto_id=False, enable_dynamic_field=False)
            schema.add_field(field_name="id", datatype=DataType.VARCHAR, is_primary=True, max_length=128)
            for name in ("tenant_id", "knowledge_base_id", "document_id"):
                schema.add_field(field_name=name, datatype=DataType.VARCHAR, max_length=64)
            schema.add_field(field_name="vector", datatype=DataType.FLOAT_VECTOR,
                             dim=self.settings.embedding_dimensions)
            schema.add_field(field_name="text", datatype=DataType.VARCHAR, max_length=TEXT_MAX_BYTES,
                             enable_analyzer=True, analyzer_params=TEXT_ANALYZER)
            schema.add_field(field_name="sparse", datatype=DataType.SPARSE_FLOAT_VECTOR)
            schema.add_function(Function(name="text_bm25", function_type=FunctionType.BM25,
                                         input_field_names=["text"], output_field_names=["sparse"]))
            indexes = self._client.prepare_index_params()
            indexes.add_index(field_name="vector", index_type="FLAT", metric_type="COSINE")
            indexes.add_index(field_name="sparse", index_type="SPARSE_INVERTED_INDEX", metric_type="BM25")
            self._client.create_collection(collection_name=self.collection, schema=schema,
                                           index_params=indexes, consistency_level="Strong")
        info = self._client.describe_collection(collection_name=self.collection)
        fields = {field["name"]: field for field in info.get("fields", [])}
        vector = fields.get("vector", {})
        if (int(vector.get("params", {}).get("dim", 0)) != self.settings.embedding_dimensions
                or vector.get("type") != DataType.FLOAT_VECTOR):
            raise _error("Existing workbench vector collection has incompatible embedding dimensions or type")
        if (not fields.get("id", {}).get("is_primary") or fields["id"].get("type") != DataType.VARCHAR
                or any(fields.get(name, {}).get("type") != DataType.VARCHAR
                       for name in ("tenant_id", "knowledge_base_id", "document_id"))):
            raise _error("Existing workbench vector collection has an incompatible scope schema")
        if (fields.get("text", {}).get("type") != DataType.VARCHAR
                or fields.get("sparse", {}).get("type") != DataType.SPARSE_FLOAT_VECTOR):
            raise _error("Existing workbench vector collection has no BM25 full-text fields; "
                         "rebuild it with python -m app.reindex")
        self._client.load_collection(collection_name=self.collection)

    async def ensure(self) -> None:
        """Create the isolated collection only if absent; otherwise validate/load."""
        async with self._lock:
            if self._ready:
                return
            try:
                await asyncio.to_thread(self._ensure_sync)
            except ProviderError:
                raise
            except Exception:  # noqa: BLE001 - SDK boundary; never expose raw connection/credential errors.
                raise _error("Cannot initialize Milvus workbench collection; check service and schema") from None
            self._ready = True

    def _validated_vector(self, vector: list[float]) -> list[float]:
        if (not isinstance(vector, list) or len(vector) != self.settings.embedding_dimensions
                or any(type(number) not in (int, float) or not math.isfinite(number) for number in vector)):
            raise _error("Vector values must be finite and match the configured embedding dimensions")
        return [float(number) for number in vector]

    def _scope(self, knowledge_base_id: int, document_ids: list[str] | None) -> str:
        scope = f'tenant_id == "{self._tenant_id}" and knowledge_base_id == "{_identifier(knowledge_base_id)}"'
        if document_ids is not None:
            scope += " and document_id in [" + ", ".join(f'"{_identifier(d)}"' for d in document_ids) + "]"
        return scope

    async def upsert(
        self, chunks: list[dict[str, Any]], vectors: list[list[float]],
        knowledge_base_id: int, document_id: int,
    ) -> None:
        """Idempotently store supplied chunk IDs, scoped by server tenant and KB."""
        kb_id, doc_id = _identifier(knowledge_base_id), _identifier(document_id)
        if len(chunks) != len(vectors):
            raise _error("Chunk and vector counts do not match")
        rows: list[dict[str, Any]] = []
        seen: set[str] = set()
        for chunk, vector in zip(chunks, vectors, strict=True):
            identifier = chunk.get("id")
            if not isinstance(identifier, str) or not identifier or len(identifier) > 128:
                raise _error("Vector chunk IDs must be nonempty strings of at most 128 characters")
            if identifier in seen:
                raise _error("Duplicate chunk IDs in vector upsert batch")
            seen.add(identifier)
            if _identifier(chunk.get("document_id")) != doc_id:
                raise _error("Vector upsert contains a chunk from another document")
            text = chunk.get("text")
            if not isinstance(text, str) or len(text.encode("utf-8")) > TEXT_MAX_BYTES:
                raise _error(f"Vector chunk text must be a string of at most {TEXT_MAX_BYTES} UTF-8 bytes")
            rows.append({"id": identifier, "vector": self._validated_vector(vector), "text": text,
                         "tenant_id": self._tenant_id, "knowledge_base_id": kb_id, "document_id": doc_id})
        if not rows:
            return
        await self.ensure()
        async with self._lock:
            try:
                assert self._client is not None
                response = await asyncio.to_thread(self._client.upsert, collection_name=self.collection,
                                                   data=rows)
                if int(response.get("upsert_count", -1)) != len(rows):
                    raise _error("Milvus did not acknowledge every chunk in the upsert batch")
            except ProviderError:
                raise
            except Exception:  # noqa: BLE001 - SDK boundary; never expose raw connection/credential errors.
                raise _error("Milvus vector upsert failed; identical chunk IDs may be retried safely") from None

    async def search(
        self, vector: list[float], knowledge_base_id: int, limit: int = 20,
        document_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Strongly consistent nearest neighbors with mandatory tenant + KB filter."""
        return await self._search(self._validated_vector(vector), "vector", "COSINE",
                                  knowledge_base_id, limit, document_ids, "vector")

    async def bm25_search(
        self, query: str, knowledge_base_id: int, limit: int = 20,
        document_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Server-side BM25 full-text search over chunk text, same scope rules as ``search``."""
        if not isinstance(query, str):
            raise _error("BM25 query must be a string")
        if not query.strip():
            return []
        return await self._search(query, "sparse", "BM25", knowledge_base_id, limit, document_ids, "BM25")

    async def _search(
        self, data: list[float] | str, field: str, metric: str, knowledge_base_id: int, limit: int,
        document_ids: list[str] | None, label: str,
    ) -> list[dict[str, Any]]:
        scope = self._scope(knowledge_base_id, document_ids)
        if document_ids is not None and not document_ids:
            return []
        if type(limit) is not int or not 1 <= limit <= 16384:
            raise _error("Vector search limit must be between 1 and 16384")
        await self.ensure()
        async with self._lock:
            try:
                assert self._client is not None
                results = await asyncio.to_thread(
                    self._client.search, collection_name=self.collection, data=[data],
                    anns_field=field, limit=limit,
                    filter=scope, output_fields=["id"], search_params={"metric_type": metric, "params": {}},
                    consistency_level="Strong",
                )
                if not isinstance(results, list) or len(results) != 1 or not isinstance(results[0], list):
                    raise _error("Milvus returned an invalid search result")
                rows: list[dict[str, Any]] = []
                seen: set[str] = set()
                for hit in results[0]:
                    identifier, score = hit.get("id"), hit.get("distance")
                    if not isinstance(identifier, str) or not identifier or not isinstance(score, (int, float)):
                        raise _error("Milvus returned an invalid chunk identifier or score")
                    if not math.isfinite(score):
                        raise _error("Milvus returned a nonfinite similarity score")
                    if identifier not in seen:
                        rows.append({"id": identifier, "score": float(score)})
                        seen.add(identifier)
                return rows[:limit]
            except ProviderError:
                raise
            except Exception:  # noqa: BLE001 - SDK boundary; never expose raw connection/credential errors.
                raise _error(f"Milvus {label} search failed; check the local vector service") from None

    async def delete_document(self, knowledge_base_id: int, document_id: int) -> None:
        """Remove one document's vectors; the filter always carries tenant + KB + document."""
        kb_id, doc_id = _identifier(knowledge_base_id), _identifier(document_id)
        await self.ensure()
        async with self._lock:
            try:
                assert self._client is not None
                await asyncio.to_thread(
                    self._client.delete, collection_name=self.collection,
                    filter=(f'tenant_id == "{self._tenant_id}" and knowledge_base_id == "{kb_id}" '
                            f'and document_id == "{doc_id}"'),
                )
            except ProviderError:
                raise
            except Exception:  # noqa: BLE001 - SDK boundary; never expose raw connection/credential errors.
                raise _error("Milvus vector deletion failed; the document can be deleted again safely") from None

    async def close(self) -> None:
        """Close the SDK client outside the event loop."""
        async with self._lock:
            if self._client is None:
                return
            try:
                await asyncio.to_thread(self._client.close)
            except Exception:  # noqa: BLE001 - SDK boundary; never expose raw connection/credential errors.
                raise _error("Milvus client cleanup failed") from None
            finally:
                self._client = None
                self._ready = False
