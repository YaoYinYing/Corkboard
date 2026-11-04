-- Corkboard schema, migration 003.
-- Human account sessions. The browser holds the opaque token and CSRF value;
-- the database stores only a public prefix and keyed HMAC verifiers.

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts (id),
  token_prefix TEXT NOT NULL,
  token_verifier TEXT NOT NULL,
  csrf_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sessions_account
  ON sessions (account_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token_prefix
  ON sessions (token_prefix);
