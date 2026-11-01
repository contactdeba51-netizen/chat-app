-- migrate:no-transaction
-- Query-path indexes that are missing today. CONCURRENTLY keeps writes open;
-- the migration runner drops any invalid leftovers from an interrupted build
-- before re-running this file.

-- Chats are looked up with (user_one_id = $1 OR user_two_id = $1). The unique
-- pair index already covers the first half; the second needs its own.
CREATE INDEX CONCURRENTLY IF NOT EXISTS chats_user_two_direct_index
  ON chats (user_two_id) WHERE type = 'direct';

-- Presence/status audiences and account deletion resolve contacts backwards.
CREATE INDEX CONCURRENTLY IF NOT EXISTS contacts_contact_index
  ON contacts (contact_id) WHERE contact_id IS NOT NULL;

-- Block checks look in both directions.
CREATE INDEX CONCURRENTLY IF NOT EXISTS blocks_blocked_index
  ON blocks (blocked_id);

-- Locked/archived lookups filter preferences by account alone.
CREATE INDEX CONCURRENTLY IF NOT EXISTS chat_preferences_user_index
  ON chat_preferences (user_id);

-- The status feed filters one author within the last 24 hours.
CREATE INDEX CONCURRENTLY IF NOT EXISTS statuses_user_created_index
  ON statuses (user_id, created_at DESC);

-- Deleting a chat cascades through call history.
CREATE INDEX CONCURRENTLY IF NOT EXISTS call_logs_chat_index
  ON call_logs (chat_id);
