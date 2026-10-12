CREATE TABLE IF NOT EXISTS model_profiles (
    name VARCHAR(200) NOT NULL,
    model VARCHAR(200) NOT NULL,
    protocol VARCHAR(30) NOT NULL,
    base_url VARCHAR(1000) NOT NULL,
    api_key_ciphertext TEXT NOT NULL,
    is_default BOOLEAN NOT NULL,
    enabled BOOLEAN NOT NULL,
    is_deleted BOOLEAN NOT NULL,
    max_tokens INTEGER NOT NULL,
    timeout_seconds INTEGER NOT NULL,
    json_mode BOOLEAN NOT NULL,
    id BIGINT NOT NULL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
COMMENT ON TABLE model_profiles IS 'Tenant-scoped model profiles';
COMMENT ON COLUMN model_profiles.name IS 'Display name';
COMMENT ON COLUMN model_profiles.model IS 'Provider model ID';
COMMENT ON COLUMN model_profiles.protocol IS 'Wire protocol';
COMMENT ON COLUMN model_profiles.base_url IS 'Validated HTTP endpoint';
COMMENT ON COLUMN model_profiles.api_key_ciphertext IS 'Encrypted write-only credential';
COMMENT ON COLUMN model_profiles.is_default IS 'Default chat profile';
COMMENT ON COLUMN model_profiles.enabled IS 'Available for new messages';
COMMENT ON COLUMN model_profiles.is_deleted IS 'Archived profile';
COMMENT ON COLUMN model_profiles.max_tokens IS 'Maximum output tokens';
COMMENT ON COLUMN model_profiles.timeout_seconds IS 'Request timeout seconds';
COMMENT ON COLUMN model_profiles.json_mode IS 'Native JSON mode for OpenAI protocols';
COMMENT ON COLUMN model_profiles.id IS 'Snowflake ID';
COMMENT ON COLUMN model_profiles.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN model_profiles.created_at IS 'Created time';
COMMENT ON COLUMN model_profiles.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_model_profiles_tenant_id ON model_profiles (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_model_profiles_default ON model_profiles (tenant_id) WHERE is_default AND NOT is_deleted;

CREATE TABLE IF NOT EXISTS service_configurations (
    config JSONB NOT NULL,
    secrets_ciphertext JSONB NOT NULL,
    id BIGINT NOT NULL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT now() NOT NULL
);
COMMENT ON TABLE service_configurations IS 'Tenant service settings and bootstrap marker';
COMMENT ON COLUMN service_configurations.config IS 'Service settings grouped by service';
COMMENT ON COLUMN service_configurations.secrets_ciphertext IS 'Encrypted credentials keyed by service';
COMMENT ON COLUMN service_configurations.id IS 'Snowflake ID';
COMMENT ON COLUMN service_configurations.tenant_id IS 'Server-owned workspace';
COMMENT ON COLUMN service_configurations.created_at IS 'Created time';
COMMENT ON COLUMN service_configurations.updated_at IS 'Updated time';
CREATE INDEX IF NOT EXISTS ix_service_configurations_tenant_id ON service_configurations (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_service_configurations_tenant ON service_configurations (tenant_id);

ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS index_config JSONB DEFAULT '{}' NOT NULL;
COMMENT ON COLUMN knowledge_bases.index_config IS 'Frozen embedding endpoint and vector store identity';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_profile_id BIGINT;
COMMENT ON COLUMN messages.model_profile_id IS 'Selected model profile ID';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_snapshot JSONB DEFAULT '{}' NOT NULL;
COMMENT ON COLUMN messages.model_snapshot IS 'Public model identity, never credentials';
CREATE INDEX IF NOT EXISTS ix_messages_model_profile_id ON messages (model_profile_id);
