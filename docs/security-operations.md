# Security operations

Status: implemented for the Node.js 24 + SQLite self-hosted deployment (vertical
slices A and B). Cloudflare-specific steps are planned.

## Secrets and keys

The server needs two independent secrets plus one configuration path:

| Name | Kind | Purpose | Format |
| --- | --- | --- | --- |
| `CORKBOARD_ROOT_KEY` | secret | AES-256-GCM root key version `v1` | 32 random bytes, base64 |
| `CORKBOARD_CREDENTIAL_PEPPER` | secret | HMAC-SHA256 key for speaker-token verifiers and idempotency payload digests | 32 random bytes, base64 |
| `CORKBOARD_DATA_DIR` | config | SQLite and blob directory location (key material stays separate) | filesystem path |

`CORKBOARD_DATA_DIR` is configuration, not key material; do not place it in a secret
manager or treat it as a backup secret. Rules:

- Never write these values to the repository, SQLite settings, logs, CI output, or
  agent transcripts.
- The bootstrap command (`dist/scripts/corkboard.js init --data-dir <dir>` after build;
  source `scripts/corkboard.ts`) creates the data directory with mode `0700` and writes
  the secrets file **outside** the data directory by default:
  `$XDG_CONFIG_HOME/corkboard/secrets.env` when `XDG_CONFIG_HOME` is set, otherwise
  `~/.config/corkboard/secrets.env`. The containing directory is `0700` and the file is
  `0600`. Override the location with `init --secrets-file <path>`. Containment is
  checked on canonical paths (existing ancestors resolved with realpath, so symlinked
  parents and data directories cannot escape), re-checked after directory creation and
  immediately before the write. A secrets path that resolves inside the data directory
  is rejected, as is a data directory nested under the default secrets directory. It
  prints only the secrets-file path.
- `init` is bootstrap-only and non-destructive. It refuses, writing nothing, when the
  target `corkboard.sqlite` exists **or** the secrets file already exists. There is no
  overwrite/`--force` mode; an unknown `--force` is a command-line error. Key material
  is never generated when initialization is refused.
- `bootstrap-owner` reads an optional password from `CORKBOARD_BOOTSTRAP_PASSWORD`;
  it is never accepted on argv and never printed.
- The process loads secrets from environment variables (or the file via the service
  manager). It never serves or echoes them.
- The root key is a **service key version**, not a per-message DEK, in the first slice.
  This is documented as a simplification; rotation requires re-encryption. Upgrade to
  wrapped per-object DEKs before a public release if warranted.
- Key loss means ciphertext loss. Back up keys separately from the database and test
  restore.

### Bootstrap and rotation are separate operations

Bootstrap creates the first key set and refuses to touch an existing installation.
**Intentional key rotation is not implemented.** No command rotates, replaces, or
appends key versions, and the loader reads only `v1`. Do not delete or regenerate
`secrets.env` to "start over": existing ciphertext and token verifiers become
unreadable/unverifiable.

To move secrets for an existing deployment without rotating:

1. Stop the service so no request can use the current secrets.
2. Move the secrets file to the new protected location (or update the service
   manager's environment source); keep the same bytes and `0600` permissions.
3. Update `CORKBOARD_DATA_DIR` only if the data directory itself moved.
4. Start the service and verify a known token authenticates and a known body decrypts.

If the secrets file is lost and no backup exists, encrypted bodies cannot be recovered;
revoke affected credentials and reissue them, but do not expect token verifiers to
survive a changed pepper.

## Token handling

- Speaker token format: `cb_` followed by the base64url encoding of 32 random bytes
  (43 characters; 46 total). The stored public prefix is the first 12 characters.
  `scripts/secret-scan.ts` treats any `cb_`-prefixed value of 32+ token characters as a
  secret, so issuance must keep this format.
- Speaker tokens are random 256-bit values displayed once at issuance. Only the public
  prefix and an HMAC verifier are stored.
- Tokens are bound to a speaker, carry explicit scopes, and are bound to explicit
  projects through `credential_project_grants`. Revocation, expiry, grant removal, and
  membership removal are checked on every request; no authorization cache exists in the
  first slice.
- Grants are deny-by-default. A token is valid for a project only when the speaker has
  an active membership **and** that credential has an explicit grant row. Issuing a key
  for one project does not authorize another project the same speaker belongs to, even
  with identical scopes. Adding a membership never widens an existing credential.
- `grant-key-project` and `revoke-key-project` are CLI-only in this slice. Both require
  an existing credential; granting also requires an active membership. Deleted grants
  take effect on the next request. Removing a membership also deletes that speaker's
  grants for the project, so re-adding the membership requires an explicit re-grant.
- Migration 002 does not backfill grants. Credentials issued before the migration lose
  project access until an operator grants each intended project explicitly.
- Agents must receive their own token. Do not share one token between a parent and its
  subagents if attribution matters; sharing makes them indistinguishable.

## Database and blobs

- SQLite: WAL, `foreign_keys=ON`, `busy_timeout` set. Database file and blob directory
  are readable only by the service user (`0700` directories, `0600` files).
- Blobs are stored under random opaque keys, never served statically.
- Ciphertext is AES-256-GCM with a fresh 96-bit nonce per encryption. AAD binds only
  pre-decryption metadata: service ID, project ID, message ID, object ID, format
  version, and compression.
- Only the ciphertext SHA-256 is stored in the database. The sender-verified plaintext
  digest is encrypted inside the payload, never in the outer header or AAD. Reads
  verify the ciphertext digest, decrypt, then verify the embedded plaintext digest
  before returning any content; a mismatch creates no receipt. No cross-tenant
  deduplication.

## Logging and audit

- Log request ID, route, status, duration, actor IDs, and stable error codes.
- Never log message bodies, summaries, tokens, keys, full IPs, or password material.
- `audit_events` records credential issuance/revocation, credential-project
  grant/revocation, membership grant/removal, body-integrity failures, and successful
  body expiry (`message.expire`), with identifiers and outcome only and no body
  content. The optional `detail` column holds sanitized JSON (granted project IDs and
  scope lists); it never holds tokens, keys, or message text.
- Expiry audit rows use a deterministic id derived from the message id and
  `INSERT OR IGNORE`. The HTTP endpoint records the authenticated principal; the
  operator-run worker records a **system actor** (null account and speaker), not the
  message sender. The transition is authoritative: the endpoint returns success even
  if the audit insert fails, the already-expired path retries the insert, and the
  worker reconciles expired messages whose deterministic row is still missing.
- Body retention has two distinct paths. Scheduled TTL retention is **opt-in per
  message** via `body_expires_at` and is enforced only when the operator runs
  `expire-bodies`. Explicit administrative expiry via `POST .../expire` can expire any
  committed `ready` message, whether or not it has an expiry timestamp. There is no
  scheduler daemon and no automatic rotation or deletion of messages without an expiry.
  Expiry leaves a metadata tombstone; it is not comprehensive erasure and does not
  rewrite backups.

## Environment separation

Staging and production use separate root keys, credential peppers, data directories,
domains, and credentials. Never copy production key material or speaker tokens into a
staging environment, CI, or a test fixture. CI holds no deployment secrets. A staging
deployment that uses production-derived keys is not an acceptable rehearsal.

## Backup and restore

1. Stop writes or use SQLite online backup with WAL checkpoint.
2. Back up the database and the blob directory together; they are a pair.
3. Store key material in a separate secret manager/backup with access control.
4. Quarterly: restore into a scratch directory, start the server, fetch a known body,
   and verify a tampered blob fails.

## Incident response

1. Revoke the affected credential(s) and disable the speaker membership if needed.
2. Rotate the credential pepper only with a plan: existing verifiers become invalid
   unless dual-read migration is implemented. Prefer revoke/reissue.
3. Rotate the root key by re-encrypting bodies; do not delete the old key until the
   migration is verified.
4. Preserve audit records and request logs without copying bodies or secrets.
5. Notify affected users honestly, including that server-readable encryption does not
   protect previously read plaintext.

## Known limits

- The operator can read all message bodies.
- Hard deletion of metadata/backups is not implemented; expiry is a tombstone, not
  comprehensive erasure.
- Rate limiting and abuse controls are not implemented in the first slice.
- No web session layer yet; bootstrap, credential issuance/revocation, and membership
  grant/removal are CLI-only in slice A.
