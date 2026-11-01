-- Links from chat content to media metadata. The legacy /uploads URL columns
-- stay in place and keep working, so this migration is additive and reversible
-- by deployment (old code simply ignores the new columns).

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;
ALTER TABLE statuses
  ADD COLUMN IF NOT EXISTS media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS avatar_media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;
ALTER TABLE chats
  ADD COLUMN IF NOT EXISTS avatar_media_id UUID REFERENCES media_objects(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS messages_media_index
  ON messages (media_id) WHERE media_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS statuses_media_index
  ON statuses (media_id) WHERE media_id IS NOT NULL;
