"""Validated API inputs. Large identifiers are accepted as decimal strings."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.services.retrieval import RetrievalConfig

Method = Literal["bm25", "vector", "hybrid", "hybrid_rerank", "no_context"]


class InputModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    @model_validator(mode="before")
    @classmethod
    def valid_identifiers(cls, payload: object) -> object:
        if isinstance(payload, dict):
            for name, val in payload.items():
                if name in {"knowledge_base_id", "dataset_id", "document_id", "model_profile_id"} and val is not None:
                    if isinstance(val, bool) or not (isinstance(val, int) or
                            isinstance(val, str) and val.isascii() and val.isdecimal()):
                        raise ValueError("Resource identifiers must be decimal integers")
                    if not 0 < int(val) <= 2**63 - 1:
                        raise ValueError("Resource identifier is outside BIGINT range")
        return payload


class KBCreate(InputModel):
    name: str = Field(min_length=1, max_length=200)
    scope: Literal["platform", "personal"] = "personal"
    description: str = Field(default="", max_length=4000)
    chunk_size: int = Field(default=2200, ge=200, le=8000)
    chunk_overlap: int = Field(default=400, ge=0, le=2000)

    @model_validator(mode="after")
    def valid_overlap(self) -> "KBCreate":
        if self.chunk_overlap >= self.chunk_size:
            raise ValueError("chunk_overlap must be smaller than chunk_size")
        return self


class ConversationCreate(InputModel):
    knowledge_base_id: int = Field(gt=0)
    title: str = Field(default="新对话", min_length=1, max_length=200)


class MessageCreate(InputModel):
    model_profile_id: int | None = Field(default=None, gt=0)
    content: str = Field(min_length=1, max_length=12000)
    method: Method = "hybrid_rerank"
    top_k: int = Field(default=5, ge=1, le=20)
    candidate_k: int = Field(default=20, ge=5, le=100)
    retrieval: RetrievalConfig | None = None

    @model_validator(mode="after")
    def valid_limits(self) -> "MessageCreate":
        if self.top_k > self.candidate_k:
            raise ValueError("top_k cannot exceed candidate_k")
        return self


class DebugRequest(InputModel):
    knowledge_base_id: int = Field(gt=0)
    question: str = Field(min_length=1, max_length=12000)
    methods: list[Method] = Field(min_length=1, max_length=5)
    retrieval_only: bool = False
    top_k: int = Field(default=5, ge=1, le=20)
    candidate_k: int = Field(default=20, ge=5, le=100)
    reference_answer: str = Field(default="", max_length=16000)
    retrieval: RetrievalConfig | None = Field(default=None, description="Extra custom pipeline result")

    @model_validator(mode="after")
    def valid_methods(self) -> "DebugRequest":
        if len(self.methods) != len(set(self.methods)) or self.top_k > self.candidate_k:
            raise ValueError("Unique methods and top_k <= candidate_k are required")
        return self


class DatasetCreate(InputModel):
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=4000)


class Evidence(InputModel):
    document_id: str | None = None
    doc_id: str | None = None
    page: int = Field(ge=1)
    quote: str = Field(min_length=1, max_length=16000)

    @model_validator(mode="after")
    def has_document(self) -> "Evidence":
        if not self.document_id and not self.doc_id:
            raise ValueError("An evidence document identifier is required")
        return self


class QuestionInput(InputModel):
    question: str = Field(min_length=1, max_length=12000)
    reference_answer: str = Field(default="", max_length=16000)
    answerable: bool = True
    evidence: list[Evidence] = Field(default_factory=list, max_length=30)
    review_status: Literal["pending", "reviewed"] = "pending"


class RunCreate(InputModel):
    name: str = Field(min_length=1, max_length=200)
    knowledge_base_id: int = Field(gt=0)
    dataset_id: int = Field(gt=0)
    methods: list[Method] = Field(min_length=1, max_length=5)
    limit: int = Field(default=10, ge=1, le=1000)
    judge_enabled: bool = False

    @model_validator(mode="after")
    def unique_methods(self) -> "RunCreate":
        if len(self.methods) != len(set(self.methods)):
            raise ValueError("Methods cannot be repeated")
        return self


MemoryCategory = Literal["preference", "profile", "fact", "goal", "instruction", "other"]


class MemoryCreate(InputModel):
    content: str = Field(min_length=1, max_length=4000)
    category: MemoryCategory = "other"
    tags: list[str] = Field(default_factory=list, max_length=20)
    importance: int = Field(default=3, ge=1, le=5)
    attributes: dict = Field(default_factory=dict)
    expires_at: datetime | None = None
    on_duplicate: Literal["skip", "update", "insert"] = "skip"
    dedupe_threshold: float = Field(default=0.92, ge=0.5, le=1.0)


class MemoryUpdate(InputModel):
    content: str | None = Field(default=None, min_length=1, max_length=4000)
    category: MemoryCategory | None = None
    tags: list[str] | None = Field(default=None, max_length=20)
    importance: int | None = Field(default=None, ge=1, le=5)
    attributes: dict | None = None
    expires_at: datetime | None = None
    clear_expiry: bool = False
    expected_version: int | None = Field(default=None, ge=1)


class MemorySearch(InputModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=5, ge=1, le=50)
    categories: list[MemoryCategory] | None = None
    tags: list[str] | None = None
    min_importance: int | None = Field(default=None, ge=1, le=5)
    min_similarity: float | None = Field(default=None, ge=-1, le=1)


class MemoryMerge(InputModel):
    memory_ids: list[str] = Field(min_length=2, max_length=50)
    content: str | None = Field(default=None, min_length=1, max_length=4000)
    category: MemoryCategory | None = None
    tags: list[str] | None = None
    importance: int | None = Field(default=None, ge=1, le=5)


class MemoryExtract(InputModel):
    text: str = Field(min_length=1, max_length=50000)
    max_items: int = Field(default=10, ge=1, le=30)
    dedupe_threshold: float = Field(default=0.92, ge=0.5, le=1.0)
    dry_run: bool = False


class TuningCandidate(InputModel):
    name: str = Field(min_length=1, max_length=200)
    config: RetrievalConfig


class TuningCreate(InputModel):
    name: str = Field(min_length=1, max_length=200)
    knowledge_base_id: int = Field(gt=0)
    dataset_id: int = Field(gt=0)
    candidates: list[TuningCandidate] | None = Field(default=None, max_length=24)
    grid: dict[str, list] | None = None
    base: RetrievalConfig | None = None
    include_paid_rewrite: bool = False
    objective: str = "mrr_at_10"
    limit: int = Field(default=100, ge=1, le=1000)


class TuningApply(InputModel):
    candidate: str = Field(min_length=1, max_length=200)
