CREATE TABLE IF NOT EXISTS users (
	username VARCHAR(64) NOT NULL, 
	display_name VARCHAR(100) NOT NULL, 
	role VARCHAR(20) NOT NULL, 
	password_hash VARCHAR(300) NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	must_change_password BOOLEAN NOT NULL, 
	last_login_at TIMESTAMP WITH TIME ZONE, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE users IS 'Workbench accounts managed by administrators';
COMMENT ON COLUMN users.username IS 'Login name, lowercase';
COMMENT ON COLUMN users.display_name IS 'Display name';
COMMENT ON COLUMN users.role IS 'admin/employee';
COMMENT ON COLUMN users.password_hash IS 'scrypt$N$r$p$salt$hash';
COMMENT ON COLUMN users.status IS 'active/disabled';
COMMENT ON COLUMN users.must_change_password IS 'Force a new password at next login';
COMMENT ON COLUMN users.last_login_at IS 'Last successful login';
COMMENT ON COLUMN users.id IS 'Snowflake ID';
COMMENT ON COLUMN users.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN users.created_at IS 'Created time';
COMMENT ON COLUMN users.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_users_tenant_id ON users (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_username ON users (tenant_id, username);
CREATE INDEX IF NOT EXISTS ix_users_status ON users (status);
CREATE TABLE IF NOT EXISTS user_sessions (
	user_id BIGINT NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE NOT NULL, 
	last_seen_at TIMESTAMP WITH TIME ZONE, 
	user_agent VARCHAR(300) NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE user_sessions IS 'Browser sessions, only the token hash is stored';
COMMENT ON COLUMN user_sessions.user_id IS 'Account ID';
COMMENT ON COLUMN user_sessions.token_hash IS 'SHA-256 of the session token';
COMMENT ON COLUMN user_sessions.expires_at IS 'Absolute expiry';
COMMENT ON COLUMN user_sessions.last_seen_at IS 'Last request';
COMMENT ON COLUMN user_sessions.user_agent IS 'Client user agent';
COMMENT ON COLUMN user_sessions.id IS 'Snowflake ID';
COMMENT ON COLUMN user_sessions.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN user_sessions.created_at IS 'Created time';
COMMENT ON COLUMN user_sessions.updated_at IS 'Updated time';
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_sessions_token ON user_sessions (token_hash);
CREATE INDEX IF NOT EXISTS ix_user_sessions_tenant_id ON user_sessions (tenant_id);
CREATE INDEX IF NOT EXISTS ix_user_sessions_user_id ON user_sessions (user_id);
CREATE TABLE IF NOT EXISTS api_tokens (
	user_id BIGINT NOT NULL, 
	name VARCHAR(100) NOT NULL, 
	prefix VARCHAR(16) NOT NULL, 
	token_hash VARCHAR(64) NOT NULL, 
	expires_at TIMESTAMP WITH TIME ZONE, 
	last_used_at TIMESTAMP WITH TIME ZONE, 
	revoked_at TIMESTAMP WITH TIME ZONE, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE api_tokens IS 'Personal access tokens for MCP and API clients';
COMMENT ON COLUMN api_tokens.user_id IS 'Account ID';
COMMENT ON COLUMN api_tokens.name IS 'Token label';
COMMENT ON COLUMN api_tokens.prefix IS 'Visible token prefix';
COMMENT ON COLUMN api_tokens.token_hash IS 'SHA-256 of the token';
COMMENT ON COLUMN api_tokens.expires_at IS 'Optional expiry';
COMMENT ON COLUMN api_tokens.last_used_at IS 'Last use';
COMMENT ON COLUMN api_tokens.revoked_at IS 'Revocation time';
COMMENT ON COLUMN api_tokens.id IS 'Snowflake ID';
COMMENT ON COLUMN api_tokens.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN api_tokens.created_at IS 'Created time';
COMMENT ON COLUMN api_tokens.updated_at IS 'Updated time';
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_tokens_token ON api_tokens (token_hash);
CREATE INDEX IF NOT EXISTS ix_api_tokens_tenant_id ON api_tokens (tenant_id);
CREATE INDEX IF NOT EXISTS ix_api_tokens_user_id ON api_tokens (user_id);
CREATE TABLE IF NOT EXISTS query_logs (
	user_id BIGINT, 
	username VARCHAR(64) NOT NULL, 
	source VARCHAR(20) NOT NULL, 
	action VARCHAR(20) NOT NULL, 
	knowledge_base_id BIGINT, 
	kb_scope VARCHAR(20) NOT NULL, 
	query TEXT, 
	query_chars INTEGER NOT NULL, 
	method VARCHAR(200) NOT NULL, 
	result_count INTEGER NOT NULL, 
	latency_ms INTEGER NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	error TEXT, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE query_logs IS 'Retrieval and answer requests, personal-library text is never stored';
COMMENT ON COLUMN query_logs.user_id IS 'Account ID';
COMMENT ON COLUMN query_logs.username IS 'Username snapshot';
COMMENT ON COLUMN query_logs.source IS 'chat/debug/mcp';
COMMENT ON COLUMN query_logs.action IS 'search/answer';
COMMENT ON COLUMN query_logs.knowledge_base_id IS 'Knowledge base';
COMMENT ON COLUMN query_logs.kb_scope IS 'platform/personal';
COMMENT ON COLUMN query_logs.query IS 'Question text, NULL for personal libraries';
COMMENT ON COLUMN query_logs.query_chars IS 'Question length';
COMMENT ON COLUMN query_logs.method IS 'Pipeline summary';
COMMENT ON COLUMN query_logs.result_count IS 'Returned chunks or citations';
COMMENT ON COLUMN query_logs.latency_ms IS 'End-to-end latency';
COMMENT ON COLUMN query_logs.status IS 'ok/error';
COMMENT ON COLUMN query_logs.error IS 'Sanitized error';
COMMENT ON COLUMN query_logs.id IS 'Snowflake ID';
COMMENT ON COLUMN query_logs.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN query_logs.created_at IS 'Created time';
COMMENT ON COLUMN query_logs.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_query_logs_created ON query_logs (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS ix_query_logs_tenant_id ON query_logs (tenant_id);
CREATE INDEX IF NOT EXISTS ix_query_logs_user_id ON query_logs (user_id);
CREATE INDEX IF NOT EXISTS ix_query_logs_knowledge_base_id ON query_logs (knowledge_base_id);
CREATE TABLE IF NOT EXISTS mcp_call_logs (
	user_id BIGINT, 
	username VARCHAR(64) NOT NULL, 
	token_id BIGINT, 
	transport VARCHAR(20) NOT NULL, 
	tool VARCHAR(64) NOT NULL, 
	arguments JSONB DEFAULT '{}' NOT NULL, 
	status VARCHAR(20) NOT NULL, 
	error TEXT, 
	latency_ms INTEGER NOT NULL, 
	id BIGINT NOT NULL, 
	tenant_id BIGINT NOT NULL, 
	created_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	updated_at TIMESTAMP WITH TIME ZONE DEFAULT now() NOT NULL, 
	PRIMARY KEY (id)
);
COMMENT ON TABLE mcp_call_logs IS 'MCP tool calls, arguments are reduced to non-content metadata';
COMMENT ON COLUMN mcp_call_logs.user_id IS 'Account ID';
COMMENT ON COLUMN mcp_call_logs.username IS 'Username snapshot';
COMMENT ON COLUMN mcp_call_logs.token_id IS 'API token used';
COMMENT ON COLUMN mcp_call_logs.transport IS 'http/stdio';
COMMENT ON COLUMN mcp_call_logs.tool IS 'Tool name';
COMMENT ON COLUMN mcp_call_logs.arguments IS 'Identifiers and sizes only';
COMMENT ON COLUMN mcp_call_logs.status IS 'ok/error';
COMMENT ON COLUMN mcp_call_logs.error IS 'Tool error message';
COMMENT ON COLUMN mcp_call_logs.latency_ms IS 'Tool latency';
COMMENT ON COLUMN mcp_call_logs.id IS 'Snowflake ID';
COMMENT ON COLUMN mcp_call_logs.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN mcp_call_logs.created_at IS 'Created time';
COMMENT ON COLUMN mcp_call_logs.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_mcp_call_logs_tool ON mcp_call_logs (tool);
CREATE INDEX IF NOT EXISTS ix_mcp_call_logs_user_id ON mcp_call_logs (user_id);
CREATE INDEX IF NOT EXISTS ix_mcp_call_logs_tenant_id ON mcp_call_logs (tenant_id);
CREATE INDEX IF NOT EXISTS ix_mcp_call_logs_created ON mcp_call_logs (tenant_id, created_at);
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'platform' NOT NULL;
COMMENT ON COLUMN knowledge_bases.scope IS 'platform/personal';
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS owner_id BIGINT;
COMMENT ON COLUMN knowledge_bases.owner_id IS 'Creator, owner of a personal library';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS uploaded_by BIGINT;
COMMENT ON COLUMN documents.uploaded_by IS 'Uploader account';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_status VARCHAR(20) DEFAULT 'approved' NOT NULL;
COMMENT ON COLUMN documents.review_status IS 'approved/pending/rejected';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
COMMENT ON COLUMN documents.reviewed_by IS 'Reviewer account';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMP WITH TIME ZONE;
COMMENT ON COLUMN documents.reviewed_at IS 'Review time';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS review_note TEXT DEFAULT '' NOT NULL;
COMMENT ON COLUMN documents.review_note IS 'Reviewer note';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS owner_id BIGINT;
COMMENT ON COLUMN conversations.owner_id IS 'Owning account';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'personal' NOT NULL;
COMMENT ON COLUMN memories.scope IS 'platform/personal';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS created_by BIGINT;
COMMENT ON COLUMN memories.created_by IS 'Author account';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
COMMENT ON COLUMN memories.reviewed_by IS 'Approver of a platform memory';
COMMENT ON COLUMN memories.user_id IS 'Namespace: platform or user:<account id>';
COMMENT ON COLUMN memories.status IS 'active/pending/rejected/merged/deleted';
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_scope ON knowledge_bases (scope);
CREATE INDEX IF NOT EXISTS ix_knowledge_bases_owner_id ON knowledge_bases (owner_id);
CREATE INDEX IF NOT EXISTS ix_documents_uploaded_by ON documents (uploaded_by);
CREATE INDEX IF NOT EXISTS ix_documents_review_status ON documents (review_status);
CREATE INDEX IF NOT EXISTS ix_conversations_owner_id ON conversations (owner_id);
