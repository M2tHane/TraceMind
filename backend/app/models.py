"""Tenant-scoped models. Relations are maintained in application code, without foreign keys."""
from datetime import datetime

from sqlalchemy import BigInteger, Boolean, DateTime, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import ARRAY, JSONB, REAL
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.db import generate_id


class Base(DeclarativeBase):
    pass


class TenantModel(Base):
    __abstract__ = True
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, default=generate_id, comment="Snowflake ID")
    tenant_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Server-owned workspace")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), comment="Created time")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), comment="Updated time")


class KnowledgeBase(TenantModel):
    __tablename__ = "knowledge_bases"
    name: Mapped[str] = mapped_column(String(200), comment="Display name")
    description: Mapped[str] = mapped_column(Text, default="", comment="Description")
    chunk_size: Mapped[int] = mapped_column(Integer, default=2200, comment="Chunk character target")
    chunk_overlap: Mapped[int] = mapped_column(Integer, default=400, comment="Overlap characters")
    embedding_model: Mapped[str] = mapped_column(String(200), comment="Immutable embedding model")
    embedding_dimensions: Mapped[int] = mapped_column(Integer, comment="Immutable embedding dimensions")
    index_config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Frozen embedding endpoint and vector store identity")
    version: Mapped[int] = mapped_column(Integer, default=1, comment="Incremented when index changes")
    retrieval_config: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Default retrieval pipeline, e.g. from tuning")
    scope: Mapped[str] = mapped_column(String(20), default="platform", server_default="platform", index=True, comment="platform/personal")
    owner_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Creator, owner of a personal library")


class Document(TenantModel):
    __tablename__ = "documents"
    knowledge_base_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Knowledge base ID")
    filename: Mapped[str] = mapped_column(String(200), comment="Original safe filename")
    file_sha256: Mapped[str] = mapped_column(String(64), index=True, comment="PDF hash")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, comment="Processing state")
    stage: Mapped[str] = mapped_column(String(30), default="queued", comment="Processing stage")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized failure")
    page_count: Mapped[int] = mapped_column(Integer, default=0, comment="PDF page count")
    chunk_count: Mapped[int] = mapped_column(Integer, default=0, comment="Indexed chunk count")
    markdown: Mapped[str] = mapped_column(Text, default="", comment="Parsed Markdown")
    source_type: Mapped[str] = mapped_column(String(20), default="pdf", server_default="pdf", comment="pdf/markdown/text")
    replaces_document_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, comment="Document removed once this one is ready")
    uploaded_by: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Uploader account")
    review_status: Mapped[str] = mapped_column(String(20), default="approved", server_default="approved", index=True, comment="approved/pending/rejected")
    reviewed_by: Mapped[int | None] = mapped_column(BigInteger, nullable=True, comment="Reviewer account")
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Review time")
    review_note: Mapped[str] = mapped_column(Text, default="", server_default="", comment="Reviewer note")


class Chunk(TenantModel):
    __tablename__ = "chunks"
    knowledge_base_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Knowledge base ID")
    document_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Document ID")
    chunk_index: Mapped[int] = mapped_column(Integer, comment="Chunk order")
    page: Mapped[int] = mapped_column(Integer, comment="1-based parser page anchor")
    text: Mapped[str] = mapped_column(Text, comment="Parsed chunk text")


class Conversation(TenantModel):
    __tablename__ = "conversations"
    knowledge_base_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Immutable knowledge base ID")
    title: Mapped[str] = mapped_column(String(200), default="新对话", comment="Conversation title")
    owner_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Owning account")


class Message(TenantModel):
    __tablename__ = "messages"
    conversation_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Conversation ID")
    model_profile_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Selected model profile ID")
    model_snapshot: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Public model identity, never credentials")
    role: Mapped[str] = mapped_column(String(20), comment="user or assistant")
    content: Mapped[str] = mapped_column(Text, default="", comment="Visible message")
    status: Mapped[str] = mapped_column(String(20), default="completed", index=True, comment="Generation state")
    stage: Mapped[str] = mapped_column(String(30), default="completed", comment="Generation stage")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized failure")
    citations: Mapped[list] = mapped_column(JSONB, default=list, comment="Verified source snapshots")
    contexts: Mapped[list] = mapped_column(JSONB, default=list, comment="Retrieved context snapshots")
    method: Mapped[str] = mapped_column(String(30), default="hybrid_rerank", comment="Retrieval strategy")
    timing: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Stage timings in ms")
    usage: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Provider returned usage")
    retrieval_trace: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Pipeline config, queries and per-stage recall trace")


class Dataset(TenantModel):
    __tablename__ = "datasets"
    name: Mapped[str] = mapped_column(String(200), comment="Dataset name")
    description: Mapped[str] = mapped_column(Text, default="", comment="Dataset description")


class Question(TenantModel):
    __tablename__ = "questions"
    dataset_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Dataset ID")
    question: Mapped[str] = mapped_column(Text, comment="Question")
    reference_answer: Mapped[str] = mapped_column(Text, default="", comment="Reference, never indexed")
    answerable: Mapped[bool] = mapped_column(Boolean, default=True, comment="Answerable from corpus")
    evidence: Mapped[list] = mapped_column(JSONB, default=list, comment="Document/page/quote gold evidence")
    review_status: Mapped[str] = mapped_column(String(30), default="pending", comment="Human review state")


class EvalRun(TenantModel):
    __tablename__ = "eval_runs"
    name: Mapped[str] = mapped_column(String(200), comment="Run name")
    dataset_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Dataset ID")
    knowledge_base_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Knowledge base ID")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, comment="Run state")
    methods: Mapped[list] = mapped_column(JSONB, default=list, comment="Frozen methods")
    judge_enabled: Mapped[bool] = mapped_column(Boolean, default=False, comment="Paid judge explicitly enabled")
    total: Mapped[int] = mapped_column(Integer, default=0, comment="Question-method pairs")
    completed: Mapped[int] = mapped_column(Integer, default=0, comment="Completed answers")
    failed: Mapped[int] = mapped_column(Integer, default=0, comment="Failed answers")
    config: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Immutable experiment snapshot")
    summary: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Metric aggregates")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized run error")


class EvalItem(TenantModel):
    __tablename__ = "eval_items"
    run_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Run ID")
    question_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Original question ID")
    question: Mapped[str] = mapped_column(Text, comment="Frozen question")
    reference_answer: Mapped[str] = mapped_column(Text, default="", comment="Frozen reference")
    answerable: Mapped[bool] = mapped_column(Boolean, default=True, comment="Frozen answerability")
    evidence: Mapped[list] = mapped_column(JSONB, default=list, comment="Frozen evidence")
    method: Mapped[str] = mapped_column(String(30), comment="Method")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, comment="Item state")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Generation error")
    result_payload: Mapped[dict | None] = mapped_column(JSONB, nullable=True, comment="Answer + source snapshots")
    metrics: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Deterministic metric results")
    judgment: Mapped[dict | None] = mapped_column(JSONB, nullable=True, comment="Automatic judge result")
    judge_error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Missing judgment reason")
    attempts: Mapped[int] = mapped_column(Integer, default=0, comment="Generation attempts")
    judge_attempts: Mapped[int] = mapped_column(Integer, default=0, comment="Judge attempts")
    attempt_history: Mapped[list] = mapped_column(JSONB, default=list, comment="Append-only failed attempt audit")


class Job(TenantModel):
    __tablename__ = "jobs"
    job_type: Mapped[str] = mapped_column(String(30), comment="parse/chat/evaluate/tune/consolidate")
    resource_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Target resource ID")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, comment="Queue state")
    params: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Job parameters")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized error")


class ModelProfile(TenantModel):
    __tablename__ = "model_profiles"
    __table_args__ = (
        Index("uq_model_profiles_default", "tenant_id", unique=True,
              postgresql_where=text("is_default AND NOT is_deleted")),
        {"comment": "Tenant-scoped model profiles"},
    )
    name: Mapped[str] = mapped_column(String(200), comment="Display name")
    model: Mapped[str] = mapped_column(String(200), comment="Provider model ID")
    protocol: Mapped[str] = mapped_column(String(30), comment="Wire protocol")
    base_url: Mapped[str] = mapped_column(String(1000), comment="Validated HTTP endpoint")
    api_key_ciphertext: Mapped[str] = mapped_column(Text, default="", comment="Encrypted write-only credential")
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, comment="Default chat profile")
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, comment="Available for new messages")
    is_deleted: Mapped[bool] = mapped_column(Boolean, default=False, comment="Archived profile")
    max_tokens: Mapped[int] = mapped_column(Integer, default=4096, comment="Maximum output tokens")
    timeout_seconds: Mapped[int] = mapped_column(Integer, default=120, comment="Request timeout seconds")
    json_mode: Mapped[bool] = mapped_column(Boolean, default=True, comment="Native JSON mode for OpenAI protocols")


class ServiceConfiguration(TenantModel):
    __tablename__ = "service_configurations"
    __table_args__ = (Index("uq_service_configurations_tenant", "tenant_id", unique=True),
                      {"comment": "Tenant service settings and bootstrap marker"})
    config: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Service settings grouped by service")
    secrets_ciphertext: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Encrypted credentials keyed by service")


class Memory(TenantModel):
    __tablename__ = "memories"
    __table_args__ = (Index("ix_memories_scope", "tenant_id", "user_id", "status"),
                      {"comment": "Per-user long-term memories"})
    user_id: Mapped[str] = mapped_column(String(128), comment="Owner namespace user:<account id>")
    created_by: Mapped[int | None] = mapped_column(BigInteger, nullable=True, comment="Author account")
    content: Mapped[str] = mapped_column(Text, comment="Memory text")
    category: Mapped[str] = mapped_column(String(30), default="other", comment="preference/profile/fact/goal/instruction/other")
    tags: Mapped[list] = mapped_column(JSONB, default=list, server_default="[]", comment="Free-form tags")
    importance: Mapped[int] = mapped_column(Integer, default=3, comment="1 (low) to 5 (high)")
    source: Mapped[str] = mapped_column(String(50), default="api", comment="Writer: api/mcp/extract/merge")
    status: Mapped[str] = mapped_column(String(20), default="active", comment="active/merged/deleted")
    merged_into_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, comment="Merge target memory ID")
    attributes: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Caller metadata")
    content_hash: Mapped[str] = mapped_column(String(64), comment="Normalized content SHA-256")
    embedding: Mapped[list | None] = mapped_column(ARRAY(REAL), nullable=True, comment="Embedding vector")
    embedding_model: Mapped[str] = mapped_column(String(200), default="", comment="Embedding identity model@dims")
    version: Mapped[int] = mapped_column(Integer, default=1, comment="Incremented on every content change")
    access_count: Mapped[int] = mapped_column(Integer, default=0, comment="Times returned by search")
    last_accessed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Last search hit")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Optional expiry")


class MemoryEvent(TenantModel):
    __tablename__ = "memory_events"
    __table_args__ = (Index("ix_memory_events_memory", "tenant_id", "memory_id"),
                      {"comment": "Append-only memory audit trail"})
    memory_id: Mapped[int] = mapped_column(BigInteger, comment="Memory ID")
    user_id: Mapped[str] = mapped_column(String(128), index=True, comment="Memory owner")
    action: Mapped[str] = mapped_column(String(20), comment="create/update/delete/merge/restore/purge")
    before: Mapped[dict | None] = mapped_column(JSONB, nullable=True, comment="State before change")
    after: Mapped[dict | None] = mapped_column(JSONB, nullable=True, comment="State after change")
    actor: Mapped[str] = mapped_column(String(50), default="api", comment="api/mcp/system")


class MemoryConsolidationRun(TenantModel):
    __tablename__ = "memory_consolidation_runs"
    __table_args__ = (Index("ix_memory_consolidation_runs_started", "tenant_id", "started_at"),
                      Index("uq_memory_consolidation_running", "tenant_id", unique=True,
                            postgresql_where=text("status = 'running'")),
                      {"comment": "Scheduled and manual LLM memory consolidation runs"})
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), comment="Run start")
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Run end")
    status: Mapped[str] = mapped_column(String(20), default="running", comment="running/completed/failed")
    trigger: Mapped[str] = mapped_column(String(20), default="schedule", comment="schedule/manual")
    users_processed: Mapped[int] = mapped_column(Integer, default=0, comment="Users consolidated")
    memories_merged: Mapped[int] = mapped_column(Integer, default=0, comment="Source memories merged away")
    memories_archived: Mapped[int] = mapped_column(Integer, default=0, comment="Low-value memories soft-deleted")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized failure summary")


class TuningRun(TenantModel):
    __tablename__ = "tuning_runs"
    name: Mapped[str] = mapped_column(String(200), comment="Run name")
    dataset_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Dataset ID")
    knowledge_base_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Knowledge base ID")
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, comment="Run state")
    objective: Mapped[str] = mapped_column(String(50), default="mrr_at_10", comment="Ranking metric")
    candidates: Mapped[list] = mapped_column(JSONB, default=list, comment="Named retrieval configurations")
    total: Mapped[int] = mapped_column(Integer, default=0, comment="Question-candidate pairs")
    completed: Mapped[int] = mapped_column(Integer, default=0, comment="Finished pairs")
    failed: Mapped[int] = mapped_column(Integer, default=0, comment="Failed pairs")
    results: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Per-candidate per-question metrics")
    leaderboard: Mapped[list] = mapped_column(JSONB, default=list, comment="Candidates ranked by objective")
    config: Mapped[dict] = mapped_column(JSONB, default=dict, comment="Frozen questions and service snapshot")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized run error")


class User(TenantModel):
    __tablename__ = "users"
    __table_args__ = (Index("uq_users_username", "tenant_id", "username", unique=True),
                      {"comment": "Workbench accounts managed by administrators"})
    username: Mapped[str] = mapped_column(String(64), comment="Login name, lowercase")
    display_name: Mapped[str] = mapped_column(String(100), default="", comment="Display name")
    role: Mapped[str] = mapped_column(String(20), default="employee", comment="admin/employee")
    password_hash: Mapped[str] = mapped_column(String(300), comment="scrypt$N$r$p$salt$hash")
    status: Mapped[str] = mapped_column(String(20), default="active", index=True, comment="active/disabled")
    must_change_password: Mapped[bool] = mapped_column(Boolean, default=True, comment="Force a new password at next login")
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Last successful login")


class UserSession(TenantModel):
    __tablename__ = "user_sessions"
    __table_args__ = (Index("uq_user_sessions_token", "token_hash", unique=True),
                      {"comment": "Browser sessions, only the token hash is stored"})
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Account ID")
    token_hash: Mapped[str] = mapped_column(String(64), comment="SHA-256 of the session token")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), comment="Absolute expiry")
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Last request")
    user_agent: Mapped[str] = mapped_column(String(300), default="", comment="Client user agent")


class ApiToken(TenantModel):
    __tablename__ = "api_tokens"
    __table_args__ = (Index("uq_api_tokens_token", "token_hash", unique=True),
                      {"comment": "Personal access tokens for MCP and API clients"})
    user_id: Mapped[int] = mapped_column(BigInteger, index=True, comment="Account ID")
    name: Mapped[str] = mapped_column(String(100), comment="Token label")
    prefix: Mapped[str] = mapped_column(String(16), comment="Visible token prefix")
    token_hash: Mapped[str] = mapped_column(String(64), comment="SHA-256 of the token")
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Optional expiry")
    last_used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Last use")
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True, comment="Revocation time")


class QueryLog(TenantModel):
    __tablename__ = "query_logs"
    __table_args__ = (Index("ix_query_logs_created", "tenant_id", "created_at"),
                      {"comment": "Retrieval and answer requests, personal-library text is never stored"})
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Account ID")
    username: Mapped[str] = mapped_column(String(64), default="", comment="Username snapshot")
    source: Mapped[str] = mapped_column(String(20), comment="chat/debug/mcp")
    action: Mapped[str] = mapped_column(String(20), comment="search/answer")
    knowledge_base_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Knowledge base")
    kb_scope: Mapped[str] = mapped_column(String(20), default="platform", comment="platform/personal")
    query: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Question text, NULL for personal libraries")
    query_chars: Mapped[int] = mapped_column(Integer, default=0, comment="Question length")
    method: Mapped[str] = mapped_column(String(200), default="", comment="Pipeline summary")
    result_count: Mapped[int] = mapped_column(Integer, default=0, comment="Returned chunks or citations")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, comment="End-to-end latency")
    status: Mapped[str] = mapped_column(String(20), default="ok", comment="ok/error")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Sanitized error")


class McpCallLog(TenantModel):
    __tablename__ = "mcp_call_logs"
    __table_args__ = (Index("ix_mcp_call_logs_created", "tenant_id", "created_at"),
                      {"comment": "MCP tool calls, arguments are reduced to non-content metadata"})
    user_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, index=True, comment="Account ID")
    username: Mapped[str] = mapped_column(String(64), default="", comment="Username snapshot")
    token_id: Mapped[int | None] = mapped_column(BigInteger, nullable=True, comment="API token used")
    transport: Mapped[str] = mapped_column(String(20), default="http", comment="http/stdio")
    tool: Mapped[str] = mapped_column(String(64), index=True, comment="Tool name")
    arguments: Mapped[dict] = mapped_column(JSONB, default=dict, server_default="{}", comment="Identifiers and sizes only")
    status: Mapped[str] = mapped_column(String(20), default="ok", comment="ok/error")
    error: Mapped[str | None] = mapped_column(Text, nullable=True, comment="Tool error message")
    latency_ms: Mapped[int] = mapped_column(Integer, default=0, comment="Tool latency")
