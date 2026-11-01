-- Cleanup bookkeeping and resumable job state. Deleting a storage object can
-- fail (network, credentials), so failures are recorded and retried later
-- instead of silently orphaning bytes.

ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS delete_requested_at TIMESTAMPTZ;
ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS delete_error TEXT;
ALTER TABLE media_objects
  ADD COLUMN IF NOT EXISTS delete_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS media_objects_pending_delete_index
  ON media_objects (delete_requested_at) WHERE delete_requested_at IS NOT NULL;

-- Backfill and verification scripts checkpoint here so a re-run resumes
-- instead of starting over (important on restart-prone hosts).
CREATE TABLE IF NOT EXISTS media_job_state (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
