"""Isolated Milvus collection adapter; every SDK call runs off the event loop.

Only rag_workbench_* collections are accepted. There are intentionally no drop or
migration methods, and an incompatible existing schema is never edited. Deletion is
limited to one document's vectors under the mandatory tenant + knowledge base scope.
"""

from __future__ import annotations

import asyncio
import math
import re
from typing import Any, Protocol

from loguru import logger
from pymilvus import DataType, MilvusClient

from app.services.providers import ProviderError


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
            indexes = self._client.prepare_index_params()
            indexes.add_index(field_name="vector", index_type="FLAT", metric_type="COSINE")
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
            rows.append({"id": identifier, "vector": self._validated_vector(vector),
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
        kb_id = _identifier(knowledge_base_id)
        scope = f'tenant_id == "{self._tenant_id}" and knowledge_base_id == "{kb_id}"'
        if document_ids is not None:
            if not document_ids:
                return []
            scope += " and document_id in [" + ", ".join(f'"{_identifier(d)}"' for d in document_ids) + "]"
        if type(limit) is not int or not 1 <= limit <= 16384:
            raise _error("Vector search limit must be between 1 and 16384")
        query_vector = self._validated_vector(vector)
        await self.ensure()
        async with self._lock:
            try:
                assert self._client is not None
                results = await asyncio.to_thread(
                    self._client.search, collection_name=self.collection, data=[query_vector],
                    anns_field="vector", limit=limit,
                    filter=scope, output_fields=["id"], search_params={"metric_type": "COSINE", "params": {}},
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
                raise _error("Milvus vector search failed; check the local vector service") from None

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
