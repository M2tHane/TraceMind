CREATE TABLE IF NOT EXISTS memories (
	user_id VARCHAR(128) NOT NULL, 
	content TEXT NOT NULL, 
	category VARCHAR(30) NOT NULL, 
	tags JSONB DEFAULT '[]' NOT NULL, 
	importance INTEGER NOT NULL, 
	source VARCHAR(50) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	merged_into_id BIGINT, 
	attributes JSONB DEFAULT '{}' NOT NULL, 
	content_hash VARCHAR(64) NOT NULL, 
	embedding REAL[], 
	embedding_model VARCHAR(200) NOT NULL, 
	version INTEGER NOT NULL, 
	access_count INTEGER NOT NULL, 
	last_accessed_at TIMESTAMP WITH TIME ZONE, 
	expires_at TIMESTAMP WITH TIME ZONE, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE memories IS 'Per-user long-term memories';
COMMENT ON COLUMN memories.user_id IS 'Caller-supplied user identifier';
COMMENT ON COLUMN memories.content IS 'Memory text';
COMMENT ON COLUMN memories.category IS 'preference/profile/fact/goal/instruction/other';
COMMENT ON COLUMN memories.tags IS 'Free-form tags';
COMMENT ON COLUMN memories.importance IS '1 (low) to 5 (high)';
COMMENT ON COLUMN memories.source IS 'Writer: api/mcp/extract/merge';
COMMENT ON COLUMN memories.status IS 'active/merged/deleted';
COMMENT ON COLUMN memories.merged_into_id IS 'Merge target memory ID';
COMMENT ON COLUMN memories.attributes IS 'Caller metadata';
COMMENT ON COLUMN memories.content_hash IS 'Normalized content SHA-256';
COMMENT ON COLUMN memories.embedding IS 'Embedding vector';
COMMENT ON COLUMN memories.embedding_model IS 'Embedding identity model@dims';
COMMENT ON COLUMN memories.version IS 'Incremented on every content change';
COMMENT ON COLUMN memories.access_count IS 'Times returned by search';
COMMENT ON COLUMN memories.last_accessed_at IS 'Last search hit';
COMMENT ON COLUMN memories.expires_at IS 'Optional expiry';
COMMENT ON COLUMN memories.id IS 'Snowflake ID';
COMMENT ON COLUMN memories.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN memories.created_at IS 'Created time';
COMMENT ON COLUMN memories.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_memories_scope ON memories (tenant_id, user_id, status);
CREATE INDEX IF NOT EXISTS ix_memories_tenant_id ON memories (tenant_id);
CREATE TABLE IF NOT EXISTS memory_events (
	memory_id BIGINT NOT NULL, 
	user_id VARCHAR(128) NOT NULL, 
	action VARCHAR(20) NOT NULL, 
	before JSONB, 
	after JSONB, 
	actor VARCHAR(50) NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE memory_events IS 'Append-only memory audit trail';
COMMENT ON COLUMN memory_events.memory_id IS 'Memory ID';
COMMENT ON COLUMN memory_events.user_id IS 'Memory owner';
COMMENT ON COLUMN memory_events.action IS 'create/update/delete/merge/restore/purge';
COMMENT ON COLUMN memory_events.before IS 'State before change';
COMMENT ON COLUMN memory_events.after IS 'State after change';
COMMENT ON COLUMN memory_events.actor IS 'api/mcp/system';
COMMENT ON COLUMN memory_events.id IS 'Snowflake ID';
COMMENT ON COLUMN memory_events.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN memory_events.created_at IS 'Created time';
COMMENT ON COLUMN memory_events.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_memory_events_user_id ON memory_events (user_id);
CREATE INDEX IF NOT EXISTS ix_memory_events_memory ON memory_events (tenant_id, memory_id);
CREATE INDEX IF NOT EXISTS ix_memory_events_tenant_id ON memory_events (tenant_id);
CREATE TABLE IF NOT EXISTS tuning_runs (
	name VARCHAR(200) NOT NULL, 
	dataset_id BIGINT NOT NULL, 
	knowledge_base_id BIGINT NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	objective VARCHAR(50) NOT NULL, 
	candidates JSONB NOT NULL, 
	total INTEGER NOT NULL, 
	completed INTEGER NOT NULL, 
	failed INTEGER NOT NULL, 
	results JSONB NOT NULL, 
	leaderboard JSONB NOT NULL, 
	config JSONB NOT NULL, 
	error TEXT, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON COLUMN tuning_runs.name IS 'Run name';
COMMENT ON COLUMN tuning_runs.dataset_id IS 'Dataset ID';
COMMENT ON COLUMN tuning_runs.knowledge_base_id IS 'Knowledge base ID';
COMMENT ON COLUMN tuning_runs.status IS 'Run state';
COMMENT ON COLUMN tuning_runs.objective IS 'Ranking metric';
COMMENT ON COLUMN tuning_runs.candidates IS 'Named retrieval configurations';
COMMENT ON COLUMN tuning_runs.total IS 'Question-candidate pairs';
COMMENT ON COLUMN tuning_runs.completed IS 'Finished pairs';
COMMENT ON COLUMN tuning_runs.failed IS 'Failed pairs';
COMMENT ON COLUMN tuning_runs.results IS 'Per-candidate per-question metrics';
COMMENT ON COLUMN tuning_runs.leaderboard IS 'Candidates ranked by objective';
COMMENT ON COLUMN tuning_runs.config IS 'Frozen questions and service snapshot';
COMMENT ON COLUMN tuning_runs.error IS 'Sanitized run error';
COMMENT ON COLUMN tuning_runs.id IS 'Snowflake ID';
COMMENT ON COLUMN tuning_runs.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN tuning_runs.created_at IS 'Created time';
COMMENT ON COLUMN tuning_runs.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_tuning_runs_knowledge_base_id ON tuning_runs (knowledge_base_id);
CREATE INDEX IF NOT EXISTS ix_tuning_runs_dataset_id ON tuning_runs (dataset_id);
CREATE INDEX IF NOT EXISTS ix_tuning_runs_status ON tuning_runs (status);
CREATE INDEX IF NOT EXISTS ix_tuning_runs_tenant_id ON tuning_runs (tenant_id);
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS retrieval_config JSONB DEFAULT '{}' NOT NULL;
COMMENT ON COLUMN knowledge_bases.retrieval_config IS 'Default retrieval pipeline, e.g. from tuning';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_type VARCHAR(20) DEFAULT 'pdf' NOT NULL;
COMMENT ON COLUMN documents.source_type IS 'pdf/markdown/text';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS replaces_document_id BIGINT;
COMMENT ON COLUMN documents.replaces_document_id IS 'Document removed once this one is ready';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS retrieval_trace JSONB DEFAULT '{}' NOT NULL;
COMMENT ON COLUMN messages.retrieval_trace IS 'Pipeline config, queries and per-stage recall trace';
