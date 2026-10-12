DELETE FROM memory_events WHERE user_id = 'platform';
DELETE FROM memories WHERE user_id = 'platform';
COMMENT ON COLUMN memories.user_id IS 'Owner namespace user:<account id>';
COMMENT ON COLUMN memories.scope IS 'Always personal';
COMMENT ON COLUMN memories.reviewed_by IS 'Unused legacy review column';
COMMENT ON COLUMN memories.status IS 'active/merged/deleted';
COMMENT ON COLUMN jobs.job_type IS 'parse/chat/evaluate/tune/consolidate';
CREATE TABLE IF NOT EXISTS memory_consolidation_runs (
	started_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	finished_at TIMESTAMP WITH TIME ZONE, 
	status VARCHAR(20) NOT NULL, 
	trigger VARCHAR(20) NOT NULL, 
	users_processed INTEGER NOT NULL, 
	memories_merged INTEGER NOT NULL, 
	memories_archived INTEGER NOT NULL, 
	error TEXT, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE memory_consolidation_runs IS 'Scheduled and manual LLM memory consolidation runs';
COMMENT ON COLUMN memory_consolidation_runs.started_at IS 'Run start';
COMMENT ON COLUMN memory_consolidation_runs.finished_at IS 'Run end';
COMMENT ON COLUMN memory_consolidation_runs.status IS 'running/completed/failed';
COMMENT ON COLUMN memory_consolidation_runs.trigger IS 'schedule/manual';
COMMENT ON COLUMN memory_consolidation_runs.users_processed IS 'Users consolidated';
COMMENT ON COLUMN memory_consolidation_runs.memories_merged IS 'Source memories merged away';
COMMENT ON COLUMN memory_consolidation_runs.memories_archived IS 'Low-value memories soft-deleted';
COMMENT ON COLUMN memory_consolidation_runs.error IS 'Sanitized failure summary';
COMMENT ON COLUMN memory_consolidation_runs.id IS 'Snowflake ID';
COMMENT ON COLUMN memory_consolidation_runs.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN memory_consolidation_runs.created_at IS 'Created time';
COMMENT ON COLUMN memory_consolidation_runs.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_memory_consolidation_runs_tenant_id ON memory_consolidation_runs (tenant_id);
CREATE INDEX IF NOT EXISTS ix_memory_consolidation_runs_started ON memory_consolidation_runs (tenant_id, started_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_memory_consolidation_running ON memory_consolidation_runs (tenant_id) WHERE status = 'running';
