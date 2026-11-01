-- Requires PostgreSQL 13 or newer (gen_random_uuid is built in).

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  bio VARCHAR(500) NOT NULL DEFAULT '',
  avatar_url TEXT,
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  presence_visible BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen_visible BOOLEAN NOT NULL DEFAULT TRUE,
  contact_permission VARCHAR(20) NOT NULL DEFAULT 'everyone' CHECK (contact_permission IN ('everyone', 'contacts', 'nobody')),
  reset_token_hash TEXT,
  reset_token_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_lower ON users (LOWER(email));

-- Phone-first accounts. Email stays required (needed for verification and recovery),
-- while the phone number is the login identity. Existing accounts keep working by email.
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_country CHAR(2);
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS findable_by_phone BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX IF NOT EXISTS users_phone_unique ON users (phone) WHERE phone IS NOT NULL;
UPDATE users SET email_verified_at = created_at WHERE email_verified_at IS NULL;


-- A chat is either a 1:1 conversation (user_one_id/user_two_id) or a group
-- (type = 'group', name + group_members). Upgrading an older database renames
-- direct_chats in place so existing messages, receipts, and preferences keep
-- their foreign keys.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'direct_chats')
     AND NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'chats') THEN
    ALTER TABLE direct_chats RENAME TO chats;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type VARCHAR(10) NOT NULL DEFAULT 'direct' CHECK (type IN ('direct', 'group')),
  user_one_id UUID REFERENCES users(id) ON DELETE CASCADE,
  user_two_id UUID REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(80),
  avatar_url TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS type VARCHAR(10) NOT NULL DEFAULT 'direct';
ALTER TABLE chats ADD COLUMN IF NOT EXISTS name VARCHAR(80);
ALTER TABLE chats ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE chats ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE chats ALTER COLUMN user_one_id DROP NOT NULL;
ALTER TABLE chats ALTER COLUMN user_two_id DROP NOT NULL;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS direct_chats_distinct_users;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS direct_chats_ordered_users;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS direct_chats_user_one_id_user_two_id_key;
ALTER TABLE chats DROP CONSTRAINT IF EXISTS chats_type_check;
ALTER TABLE chats ADD CONSTRAINT chats_type_check CHECK (type IN ('direct', 'group'));
CREATE UNIQUE INDEX IF NOT EXISTS chats_direct_pair_unique ON chats (user_one_id, user_two_id) WHERE type = 'direct';

CREATE TABLE IF NOT EXISTS group_members (
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user_index ON group_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL DEFAULT '',
  media_url TEXT,
  sticker TEXT,
  reply_to_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  forwarded_from_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  edited_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT messages_have_content CHECK (LENGTH(TRIM(body)) > 0 OR media_url IS NOT NULL OR sticker IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS messages_chat_created_index ON messages (chat_id, created_at DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delivered_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji VARCHAR(16) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS message_stars (
  message_id UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS blocks (
  blocker_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (blocker_id, blocked_id),
  CONSTRAINT blocks_distinct_users CHECK (blocker_id <> blocked_id)
);

CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reported_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason VARCHAR(80) NOT NULL,
  details VARCHAR(1000) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reports_distinct_users CHECK (reporter_id <> reported_id)
);

CREATE TABLE IF NOT EXISTS chat_preferences (
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  locked BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (chat_id, user_id)
);
ALTER TABLE chat_preferences ADD COLUMN IF NOT EXISTS lock_pin_hash TEXT;

-- Call history survives reloads and records missed/declined calls.
CREATE TABLE IF NOT EXISTS call_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  callee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID REFERENCES chats(id) ON DELETE CASCADE,
  type VARCHAR(10) NOT NULL,
  outcome VARCHAR(20) NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS call_logs_caller_index ON call_logs (caller_id, started_at DESC);
CREATE INDEX IF NOT EXISTS call_logs_callee_index ON call_logs (callee_id, started_at DESC);

CREATE TABLE IF NOT EXISTS statuses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text VARCHAR(500) NOT NULL DEFAULT '',
  media_url TEXT,
  media_type VARCHAR(100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS statuses_created_index ON statuses (created_at DESC);

-- Signups awaiting email verification. Nothing incomplete lands in users.
CREATE TABLE IF NOT EXISTS pending_signups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone VARCHAR(20) NOT NULL,
  country CHAR(2) NOT NULL,
  display_name VARCHAR(80) NOT NULL,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS pending_signups_phone_unique ON pending_signups (phone);
CREATE UNIQUE INDEX IF NOT EXISTS pending_signups_email_unique ON pending_signups (LOWER(email));

-- Phone-based address book entries, resolved to an account once that number registers.
CREATE TABLE IF NOT EXISTS contacts (
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  contact_id UUID REFERENCES users(id) ON DELETE SET NULL,
  display_name VARCHAR(80) NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (owner_id, phone)
);

-- Invitations for numbers that do not have an account yet.
CREATE TABLE IF NOT EXISTS phone_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inviter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  phone VARCHAR(20) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  consumed_at TIMESTAMPTZ,
  UNIQUE (inviter_id, phone)
);
CREATE INDEX IF NOT EXISTS phone_invites_pending_index ON phone_invites (phone) WHERE consumed_at IS NULL;


