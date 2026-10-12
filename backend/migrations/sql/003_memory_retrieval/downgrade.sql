ALTER TABLE messages DROP COLUMN IF EXISTS retrieval_trace;
ALTER TABLE documents DROP COLUMN IF EXISTS replaces_document_id;
ALTER TABLE documents DROP COLUMN IF EXISTS source_type;
ALTER TABLE knowledge_bases DROP COLUMN IF EXISTS retrieval_config;
DROP TABLE IF EXISTS tuning_runs;
DROP TABLE IF EXISTS memory_events;
DROP TABLE IF EXISTS memories;
