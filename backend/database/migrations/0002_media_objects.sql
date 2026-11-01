-- Durable media metadata. Bytes live in object storage (local disk in
-- development, Cloudflare R2 in production); this table is the source of truth
-- for ownership, quota accounting, and link revocation.

CREATE TABLE IF NOT EXISTS media_objects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
  kind VARCHAR(16) NOT NULL CHECK (kind IN ('avatar', 'chat', 'status')),
  storage_provider VARCHAR(16) NOT NULL CHECK (storage_provider IN ('local', 'r2')),
  bucket TEXT,
  object_key TEXT NOT NULL UNIQUE,
  legacy_url TEXT UNIQUE,
  mime_type VARCHAR(100) NOT NULL,
  byte_size BIGINT NOT NULL CHECK (byte_size > 0),
  checksum_sha256 CHAR(64),
  width INTEGER,
  height INTEGER,
  status VARCHAR(16) NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'pending_delete', 'deleted')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

-- Quota checks aggregate by owner and by owner over the last day.
CREATE INDEX IF NOT EXISTS media_objects_owner_created_index
  ON media_objects (owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS media_objects_kind_index
  ON media_objects (kind);
CREATE INDEX IF NOT EXISTS media_objects_ready_index
  ON media_objects (owner_id) WHERE deleted_at IS NULL;
