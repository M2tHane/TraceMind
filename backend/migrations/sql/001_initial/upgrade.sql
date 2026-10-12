
CREATE TABLE IF NOT EXISTS chunks (
	knowledge_base_id BIGINT NOT NULL, 
	document_id BIGINT NOT NULL, 
	chunk_index INTEGER NOT NULL, 
	page INTEGER NOT NULL, 
	text TEXT NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS conversations (
	knowledge_base_id BIGINT NOT NULL, 
	title VARCHAR(200) NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS datasets (
	name VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS documents (
	knowledge_base_id BIGINT NOT NULL, 
	filename VARCHAR(200) NOT NULL, 
	file_sha256 VARCHAR(64) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	stage VARCHAR(30) NOT NULL, 
	error TEXT, 
	page_count INTEGER NOT NULL, 
	chunk_count INTEGER NOT NULL, 
	markdown TEXT NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS eval_items (
	run_id BIGINT NOT NULL, 
	question_id BIGINT NOT NULL, 
	question TEXT NOT NULL, 
	reference_answer TEXT NOT NULL, 
	answerable BOOLEAN NOT NULL, 
	evidence JSONB NOT NULL, 
	method VARCHAR(30) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	error TEXT, 
	result_payload JSONB, 
	metrics JSONB NOT NULL, 
	judgment JSONB, 
	judge_error TEXT, 
	attempts INTEGER NOT NULL, 
	judge_attempts INTEGER NOT NULL, 
	attempt_history JSONB NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS eval_runs (
	name VARCHAR(200) NOT NULL, 
	dataset_id BIGINT NOT NULL, 
	knowledge_base_id BIGINT NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	methods JSONB NOT NULL, 
	judge_enabled BOOLEAN NOT NULL, 
	total INTEGER NOT NULL, 
	completed INTEGER NOT NULL, 
	failed INTEGER NOT NULL, 
	config JSONB NOT NULL, 
	summary JSONB NOT NULL, 
	error TEXT, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS jobs (
	job_type VARCHAR(30) NOT NULL, 
	resource_id BIGINT NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	params JSONB NOT NULL, 
	error TEXT, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS knowledge_bases (
	name VARCHAR(200) NOT NULL, 
	description TEXT NOT NULL, 
	chunk_size INTEGER NOT NULL, 
	chunk_overlap INTEGER NOT NULL, 
	embedding_model VARCHAR(200) NOT NULL, 
	embedding_dimensions INTEGER NOT NULL, 
	version INTEGER NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS messages (
	conversation_id BIGINT NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	content TEXT NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	stage VARCHAR(30) NOT NULL, 
	error TEXT, 
	citations JSONB NOT NULL, 
	contexts JSONB NOT NULL, 
	method VARCHAR(30) NOT NULL, 
	timing JSONB NOT NULL, 
	usage JSONB NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;


CREATE TABLE IF NOT EXISTS questions (
	dataset_id BIGINT NOT NULL, 
	question TEXT NOT NULL, 
	reference_answer TEXT NOT NULL, 
	answerable BOOLEAN NOT NULL, 
	evidence JSONB NOT NULL, 
	review_status VARCHAR(30) NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
)

;

CREATE INDEX IF NOT EXISTS ix_chunks_document_id ON chunks (document_id);

CREATE INDEX IF NOT EXISTS ix_chunks_tenant_id ON chunks (tenant_id);

CREATE INDEX IF NOT EXISTS ix_chunks_knowledge_base_id ON chunks (knowledge_base_id);

CREATE INDEX IF NOT EXISTS ix_conversations_tenant_id ON conversations (tenant_id);

CREATE INDEX IF NOT EXISTS ix_conversations_knowledge_base_id ON conversations (knowledge_base_id);

CREATE INDEX IF NOT EXISTS ix_datasets_tenant_id ON datasets (tenant_id);

CREATE INDEX IF NOT EXISTS ix_documents_file_sha256 ON documents (file_sha256);

CREATE INDEX IF NOT EXISTS ix_documents_status ON documents (status);

CREATE INDEX IF NOT EXISTS ix_documents_knowledge_base_id ON documents (knowledge_base_id);

CREATE INDEX IF NOT EXISTS ix_documents_tenant_id ON documents (tenant_id);

CREATE INDEX IF NOT EXISTS ix_eval_items_status ON eval_items (status);

CREATE INDEX IF NOT EXISTS ix_eval_items_question_id ON eval_items (question_id);

CREATE INDEX IF NOT EXISTS ix_eval_items_tenant_id ON eval_items (tenant_id);

CREATE INDEX IF NOT EXISTS ix_eval_items_run_id ON eval_items (run_id);

CREATE INDEX IF NOT EXISTS ix_eval_runs_status ON eval_runs (status);

CREATE INDEX IF NOT EXISTS ix_eval_runs_tenant_id ON eval_runs (tenant_id);

CREATE INDEX IF NOT EXISTS ix_eval_runs_dataset_id ON eval_runs (dataset_id);

CREATE INDEX IF NOT EXISTS ix_eval_runs_knowledge_base_id ON eval_runs (knowledge_base_id);

CREATE INDEX IF NOT EXISTS ix_jobs_resource_id ON jobs (resource_id);

CREATE INDEX IF NOT EXISTS ix_jobs_tenant_id ON jobs (tenant_id);

CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs (status);

CREATE INDEX IF NOT EXISTS ix_knowledge_bases_tenant_id ON knowledge_bases (tenant_id);

CREATE INDEX IF NOT EXISTS ix_messages_tenant_id ON messages (tenant_id);

CREATE INDEX IF NOT EXISTS ix_messages_status ON messages (status);

CREATE INDEX IF NOT EXISTS ix_messages_conversation_id ON messages (conversation_id);

CREATE INDEX IF NOT EXISTS ix_questions_dataset_id ON questions (dataset_id);

CREATE INDEX IF NOT EXISTS ix_questions_tenant_id ON questions (tenant_id);

COMMENT ON COLUMN chunks.knowledge_base_id IS 'Knowledge base ID';

COMMENT ON COLUMN chunks.document_id IS 'Document ID';

COMMENT ON COLUMN chunks.chunk_index IS 'Chunk order';

COMMENT ON COLUMN chunks.page IS '1-based parser page anchor';

COMMENT ON COLUMN chunks.text IS 'Parsed chunk text';

COMMENT ON COLUMN chunks.id IS 'Snowflake ID';

COMMENT ON COLUMN chunks.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN chunks.created_at IS 'Created time';

COMMENT ON COLUMN chunks.updated_at IS 'Updated time';

COMMENT ON COLUMN conversations.knowledge_base_id IS 'Immutable knowledge base ID';

COMMENT ON COLUMN conversations.title IS 'Conversation title';

COMMENT ON COLUMN conversations.id IS 'Snowflake ID';

COMMENT ON COLUMN conversations.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN conversations.created_at IS 'Created time';

COMMENT ON COLUMN conversations.updated_at IS 'Updated time';

COMMENT ON COLUMN datasets.name IS 'Dataset name';

COMMENT ON COLUMN datasets.description IS 'Dataset description';

COMMENT ON COLUMN datasets.id IS 'Snowflake ID';

COMMENT ON COLUMN datasets.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN datasets.created_at IS 'Created time';

COMMENT ON COLUMN datasets.updated_at IS 'Updated time';

COMMENT ON COLUMN documents.knowledge_base_id IS 'Knowledge base ID';

COMMENT ON COLUMN documents.filename IS 'Original safe filename';

COMMENT ON COLUMN documents.file_sha256 IS 'PDF hash';

COMMENT ON COLUMN documents.status IS 'Processing state';

COMMENT ON COLUMN documents.stage IS 'Processing stage';

COMMENT ON COLUMN documents.error IS 'Sanitized failure';

COMMENT ON COLUMN documents.page_count IS 'PDF page count';

COMMENT ON COLUMN documents.chunk_count IS 'Indexed chunk count';

COMMENT ON COLUMN documents.markdown IS 'Parsed Markdown';

COMMENT ON COLUMN documents.id IS 'Snowflake ID';

COMMENT ON COLUMN documents.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN documents.created_at IS 'Created time';

COMMENT ON COLUMN documents.updated_at IS 'Updated time';

COMMENT ON COLUMN eval_items.run_id IS 'Run ID';

COMMENT ON COLUMN eval_items.question_id IS 'Original question ID';

COMMENT ON COLUMN eval_items.question IS 'Frozen question';

COMMENT ON COLUMN eval_items.reference_answer IS 'Frozen reference';

COMMENT ON COLUMN eval_items.answerable IS 'Frozen answerability';

COMMENT ON COLUMN eval_items.evidence IS 'Frozen evidence';

COMMENT ON COLUMN eval_items.method IS 'Method';

COMMENT ON COLUMN eval_items.status IS 'Item state';

COMMENT ON COLUMN eval_items.error IS 'Generation error';

COMMENT ON COLUMN eval_items.result_payload IS 'Answer + source snapshots';

COMMENT ON COLUMN eval_items.metrics IS 'Deterministic metric results';

COMMENT ON COLUMN eval_items.judgment IS 'Automatic judge result';

COMMENT ON COLUMN eval_items.judge_error IS 'Missing judgment reason';

COMMENT ON COLUMN eval_items.attempts IS 'Generation attempts';

COMMENT ON COLUMN eval_items.judge_attempts IS 'Judge attempts';

COMMENT ON COLUMN eval_items.attempt_history IS 'Append-only failed attempt audit';

COMMENT ON COLUMN eval_items.id IS 'Snowflake ID';

COMMENT ON COLUMN eval_items.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN eval_items.created_at IS 'Created time';

COMMENT ON COLUMN eval_items.updated_at IS 'Updated time';

COMMENT ON COLUMN eval_runs.name IS 'Run name';

COMMENT ON COLUMN eval_runs.dataset_id IS 'Dataset ID';

COMMENT ON COLUMN eval_runs.knowledge_base_id IS 'Knowledge base ID';

COMMENT ON COLUMN eval_runs.status IS 'Run state';

COMMENT ON COLUMN eval_runs.methods IS 'Frozen methods';

COMMENT ON COLUMN eval_runs.judge_enabled IS 'Paid judge explicitly enabled';

COMMENT ON COLUMN eval_runs.total IS 'Question-method pairs';

COMMENT ON COLUMN eval_runs.completed IS 'Completed answers';

COMMENT ON COLUMN eval_runs.failed IS 'Failed answers';

COMMENT ON COLUMN eval_runs.config IS 'Immutable experiment snapshot';

COMMENT ON COLUMN eval_runs.summary IS 'Metric aggregates';

COMMENT ON COLUMN eval_runs.error IS 'Sanitized run error';

COMMENT ON COLUMN eval_runs.id IS 'Snowflake ID';

COMMENT ON COLUMN eval_runs.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN eval_runs.created_at IS 'Created time';

COMMENT ON COLUMN eval_runs.updated_at IS 'Updated time';

COMMENT ON COLUMN jobs.job_type IS 'parse/chat/evaluate';

COMMENT ON COLUMN jobs.resource_id IS 'Target resource ID';

COMMENT ON COLUMN jobs.status IS 'Queue state';

COMMENT ON COLUMN jobs.params IS 'Job parameters';

COMMENT ON COLUMN jobs.error IS 'Sanitized error';

COMMENT ON COLUMN jobs.id IS 'Snowflake ID';

COMMENT ON COLUMN jobs.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN jobs.created_at IS 'Created time';

COMMENT ON COLUMN jobs.updated_at IS 'Updated time';

COMMENT ON COLUMN knowledge_bases.name IS 'Display name';

COMMENT ON COLUMN knowledge_bases.description IS 'Description';

COMMENT ON COLUMN knowledge_bases.chunk_size IS 'Chunk character target';

COMMENT ON COLUMN knowledge_bases.chunk_overlap IS 'Overlap characters';

COMMENT ON COLUMN knowledge_bases.embedding_model IS 'Immutable embedding model';

COMMENT ON COLUMN knowledge_bases.embedding_dimensions IS 'Immutable embedding dimensions';

COMMENT ON COLUMN knowledge_bases.version IS 'Incremented when index changes';

COMMENT ON COLUMN knowledge_bases.id IS 'Snowflake ID';

COMMENT ON COLUMN knowledge_bases.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN knowledge_bases.created_at IS 'Created time';

COMMENT ON COLUMN knowledge_bases.updated_at IS 'Updated time';

COMMENT ON COLUMN messages.conversation_id IS 'Conversation ID';

COMMENT ON COLUMN messages.role IS 'user or assistant';

COMMENT ON COLUMN messages.content IS 'Visible message';

COMMENT ON COLUMN messages.status IS 'Generation state';

COMMENT ON COLUMN messages.stage IS 'Generation stage';

COMMENT ON COLUMN messages.error IS 'Sanitized failure';

COMMENT ON COLUMN messages.citations IS 'Verified source snapshots';

COMMENT ON COLUMN messages.contexts IS 'Retrieved context snapshots';

COMMENT ON COLUMN messages.method IS 'Retrieval strategy';

COMMENT ON COLUMN messages.timing IS 'Stage timings in ms';

COMMENT ON COLUMN messages.usage IS 'Provider returned usage';

COMMENT ON COLUMN messages.id IS 'Snowflake ID';

COMMENT ON COLUMN messages.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN messages.created_at IS 'Created time';

COMMENT ON COLUMN messages.updated_at IS 'Updated time';

COMMENT ON COLUMN questions.dataset_id IS 'Dataset ID';

COMMENT ON COLUMN questions.question IS 'Question';

COMMENT ON COLUMN questions.reference_answer IS 'Reference, never indexed';

COMMENT ON COLUMN questions.answerable IS 'Answerable from corpus';

COMMENT ON COLUMN questions.evidence IS 'Document/page/quote gold evidence';

COMMENT ON COLUMN questions.review_status IS 'Human review state';

COMMENT ON COLUMN questions.id IS 'Snowflake ID';

COMMENT ON COLUMN questions.tenant_id IS 'Server-owned workspace';

COMMENT ON COLUMN questions.created_at IS 'Created time';

COMMENT ON COLUMN questions.updated_at IS 'Updated time';
