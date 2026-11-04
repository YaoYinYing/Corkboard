-- Corkboard schema, migration 001.
-- One shared schema for SQLite and D1; no table-per-project DDL.
-- IDs are opaque TEXT, timestamps ISO-8601 TEXT, sequence numbers INTEGER.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  external_subject TEXT,
  email_verified_at TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT NOT NULL REFERENCES accounts (id),
  title TEXT NOT NULL,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  next_seq INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS project_tags (
  project_id TEXT NOT NULL REFERENCES projects (id),
  tag TEXT NOT NULL,
  UNIQUE (project_id, tag)
);

CREATE TABLE IF NOT EXISTS speakers (
  id TEXT PRIMARY KEY NOT NULL,
  owner_account_id TEXT REFERENCES accounts (id),
  display_name TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS project_memberships (
  project_id TEXT NOT NULL REFERENCES projects (id),
  speaker_id TEXT NOT NULL REFERENCES speakers (id),
  capabilities TEXT NOT NULL, -- JSON array of capability identifiers
  joined_at TEXT,
  removed_at TEXT,
  UNIQUE (project_id, speaker_id)
);

CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY NOT NULL,
  speaker_id TEXT NOT NULL REFERENCES speakers (id),
  public_prefix TEXT NOT NULL,
  secret_verifier TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL
);

-- A provisional (pending) message has no seq. The single finalize UPDATE sets
-- seq, body_state and body_object_id together; see trg_messages_publish.
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id),
  seq INTEGER,
  sender_speaker_id TEXT NOT NULL REFERENCES speakers (id),
  summary TEXT NOT NULL,
  type TEXT NOT NULL,
  language TEXT NOT NULL,
  reply_to_id TEXT REFERENCES messages (id),
  client_sent_at TEXT,
  received_at TEXT NOT NULL,
  committed_at TEXT,
  body_state TEXT NOT NULL CHECK (body_state IN ('pending', 'ready', 'expired', 'failed')),
  body_object_id TEXT REFERENCES body_objects (id),
  body_expires_at TEXT,
  UNIQUE (project_id, seq),
  CHECK (body_state <> 'pending' OR seq IS NULL),
  CHECK (
    body_state <> 'ready'
    OR (seq IS NOT NULL AND body_object_id IS NOT NULL AND committed_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS message_receipts (
  message_id TEXT NOT NULL REFERENCES messages (id),
  speaker_id TEXT NOT NULL REFERENCES speakers (id),
  read_at TEXT NOT NULL,
  UNIQUE (message_id, speaker_id)
);

CREATE TABLE IF NOT EXISTS body_objects (
  id TEXT PRIMARY KEY NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (id),
  storage_key TEXT UNIQUE,
  cipher_alg TEXT,
  key_version TEXT,
  nonce TEXT,
  compression TEXT,
  plaintext_length INTEGER,
  cipher_length INTEGER,
  ciphertext_digest TEXT,
  state TEXT,
  created_at TEXT NOT NULL
);

-- message_id deliberately has no FK: the idempotency row is inserted before
-- the provisional message (post protocol step 3 precedes step 5), so a
-- reference constraint would reject the insert-before-message order.
CREATE TABLE IF NOT EXISTS idempotency_keys (
  speaker_id TEXT NOT NULL REFERENCES speakers (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  key TEXT NOT NULL,
  payload_digest TEXT,
  message_id TEXT,
  status TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (speaker_id, project_id, key)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY NOT NULL,
  actor_account_id TEXT,
  actor_speaker_id TEXT,
  project_id TEXT,
  operation TEXT,
  outcome TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS service_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_messages_project_seq
  ON messages (project_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_project_sender_seq
  ON messages (project_id, sender_speaker_id, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_project_type_seq
  ON messages (project_id, type, seq DESC);
CREATE INDEX IF NOT EXISTS idx_messages_project_received_at
  ON messages (project_id, received_at);
CREATE INDEX IF NOT EXISTS idx_messages_project_body_state_seq
  ON messages (project_id, body_state, seq);
CREATE INDEX IF NOT EXISTS idx_message_receipts_speaker_message
  ON message_receipts (speaker_id, message_id);
CREATE INDEX IF NOT EXISTS idx_project_memberships_speaker_project
  ON project_memberships (speaker_id, project_id);
CREATE INDEX IF NOT EXISTS idx_credentials_public_prefix
  ON credentials (public_prefix);

-- Atomicity contract for finalizeMessage. This trigger runs inside the same
-- UPDATE statement that publishes body_state='ready'; it advances
-- projects.next_seq and completes the matching idempotency key without an
-- interactive transaction or D1 batch. Port it to D1 unchanged.
CREATE TRIGGER IF NOT EXISTS trg_messages_publish
AFTER UPDATE OF body_state ON messages
WHEN NEW.body_state = 'ready' AND OLD.body_state = 'pending'
BEGIN
  UPDATE projects SET next_seq = MAX(next_seq, NEW.seq) WHERE id = NEW.project_id;
  UPDATE idempotency_keys
     SET status = 'completed',
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE message_id = NEW.id
     AND speaker_id = NEW.sender_speaker_id
     AND project_id = NEW.project_id;
END;
