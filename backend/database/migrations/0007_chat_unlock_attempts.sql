-- Locked-chat PIN attempts were counted in process memory, so restarting the
-- server (or running more than one instance) reset the throttle. Persist the
-- sliding window per account and chat instead.

CREATE TABLE IF NOT EXISTS chat_unlock_attempts (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  PRIMARY KEY (user_id, chat_id)
);

-- Expired rows are harmless but no longer needed; this index lets a periodic
-- cleanup find them cheaply if one is ever added.
CREATE INDEX IF NOT EXISTS chat_unlock_attempts_window_idx ON chat_unlock_attempts (window_start);
