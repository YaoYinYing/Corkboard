-- Corkboard schema, migration 004.
-- OAuth 2.1 authorization-server core for MCP linking. Public clients only
-- (RFC 7591, token_endpoint_auth_method=none); no client secret exists.
-- Authorization codes and refresh tokens are stored as a public prefix plus a
-- keyed HMAC verifier, never plaintext. Access tokens reuse the credentials
-- table so every existing bearer authorization check applies unchanged.

CREATE TABLE IF NOT EXISTS oauth_clients (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  redirect_uris_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  account_id TEXT NOT NULL REFERENCES accounts (id),
  speaker_id TEXT NOT NULL REFERENCES speakers (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  scopes_json TEXT NOT NULL,
  code_prefix TEXT NOT NULL,
  code_verifier_hash TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  resource TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  id TEXT PRIMARY KEY NOT NULL,
  family_id TEXT NOT NULL,
  client_id TEXT NOT NULL REFERENCES oauth_clients (client_id),
  credential_id TEXT NOT NULL REFERENCES credentials (id),
  token_prefix TEXT NOT NULL,
  token_verifier TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  rotated_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_status
  ON oauth_clients (status);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_prefix
  ON oauth_authorization_codes (code_prefix);
CREATE INDEX IF NOT EXISTS idx_oauth_authorization_codes_client
  ON oauth_authorization_codes (client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_prefix
  ON oauth_refresh_tokens (token_prefix);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_family
  ON oauth_refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_tokens_credential
  ON oauth_refresh_tokens (credential_id);
