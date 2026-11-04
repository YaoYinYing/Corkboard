-- Corkboard schema, migration 002.
-- Credentials are now explicitly bound to the projects they may act in.
-- A membership is not a grant: both an active membership and a grant row are
-- required on every project-scoped request.

CREATE TABLE IF NOT EXISTS credential_project_grants (
  credential_id TEXT NOT NULL REFERENCES credentials (id),
  project_id TEXT NOT NULL REFERENCES projects (id),
  granted_at TEXT NOT NULL,
  PRIMARY KEY (credential_id, project_id)
);

CREATE INDEX IF NOT EXISTS idx_credential_project_grants_project
  ON credential_project_grants (project_id);

-- Slice-B debt: existing v1 databases never received this index because it was
-- only added to the fresh 001 file. IF NOT EXISTS makes it safe for both.
CREATE INDEX IF NOT EXISTS idx_messages_body_state_expires
  ON messages (body_state, body_expires_at);

-- Sanitized audit metadata (identifiers and scope/project lists only).
ALTER TABLE audit_events ADD COLUMN detail TEXT;
