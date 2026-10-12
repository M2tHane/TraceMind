ALTER TABLE memories ADD COLUMN IF NOT EXISTS scope VARCHAR(20) DEFAULT 'personal' NOT NULL;
COMMENT ON COLUMN memories.scope IS 'Always personal';
ALTER TABLE memories ADD COLUMN IF NOT EXISTS reviewed_by BIGINT;
COMMENT ON COLUMN memories.reviewed_by IS 'Unused legacy review column';
