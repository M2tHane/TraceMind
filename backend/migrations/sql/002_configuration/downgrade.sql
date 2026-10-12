DROP INDEX IF EXISTS ix_messages_model_profile_id;
ALTER TABLE messages DROP COLUMN IF EXISTS model_snapshot;
ALTER TABLE messages DROP COLUMN IF EXISTS model_profile_id;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS index_config;
DROP TABLE IF EXISTS service_configurations;
DROP TABLE IF EXISTS model_profiles;
