# Security operations

Status: implemented for the Node.js 24 + SQLite self-hosted deployment (vertical
slices A and B, plus the human account session slice). Cloudflare-specific steps are
planned.

## Secrets and keys

The server needs two independent secrets plus one configuration path:

| Name | Kind | Purpose | Format |
| --- | --- | --- | --- |
| `CORKBOARD_ROOT_KEY` | secret | AES-256-GCM root key version `v1` | 32 random bytes, base64 |
| `CORKBOARD_CREDENTIAL_PEPPER` | secret | HMAC-SHA256 key for speaker-token verifiers, idempotency payload digests, and session/CSRF verifiers | 32 random bytes, base64 |
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
  it is never accepted on argv and never printed. New hashes use portable
  PBKDF2-HMAC-SHA-256 (600,000 iterations, 16-byte random salt, 32-byte output) stored
  as `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`. The Node server
  also verifies legacy `scrypt$` hashes written by earlier bootstrap builds; unknown
  formats fail closed. No password, hash, or session value is logged.
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

### Revocation ordering

Credential revocation, grant deletion, membership removal, and message expiry are read
from storage on every authorization decision; there is no authorization cache. Every
path authorizes at request start, and the four paths with a durable effect or a
plaintext return re-evaluate immediately before that effect:

- **Send.** `message.send` is re-authorized before the finalization `UPDATE` that
  assigns `seq`. If access was revoked, no sequence is allocated and no message is
  published; the provisional row/blob is reclaimable, and a retry with the same
  idempotency key after an explicit re-grant resumes normally.
- **Read receipt.** `message.read` is re-authorized and `receipt.write` re-checked
  immediately before the receipt `INSERT`. A revoked caller creates no receipt.
- **Body fetch.** `message.read` is re-authorized after decryption and immediately
  before the plaintext response. A revoked caller receives no content and causes no
  integrity audit or receipt.
- **Expiry.** `project.edit` is re-authorized immediately before the conditional
  `ready → expired` UPDATE and before the already-expired repair path (audit retry and
  ciphertext deletion). A revoked caller performs no transition and deletes no
  ciphertext.

Message list, metadata, `/me`, and project enumeration write nothing and are authorized
at request start only. CLI cleanup commands act as the operator, not on behalf of a
bearer principal.

Final re-checks use `authorizeProject` semantics: a credential revoked mid-request
yields `FORBIDDEN` (the principal authenticated at request start); a membership removed
mid-request, or a grant whose membership is no longer active, yields `NOT_FOUND`. A
credential already revoked before authentication yields `UNAUTHENTICATED`.

This is a bounded window, not atomic revocation. A revocation that commits after the
final re-check but before the atomic SQL statement (or before the plaintext response is
written) is not prevented; no stronger guarantee is claimed. See
`docs/architecture.md`.

### Membership and grant CLI semantics

- Re-running `add-member` on an **active** membership is a no-op: it does not change
  capabilities or `joined_at` and writes no grant audit row. Only a membership with
  `removed_at` set is reactivated, and reactivation may replace its capability set.
  This prevents a non-owner re-run from silently downgrading an owner membership.
- `remove-member` deletes that speaker's grants for the project. It writes the
  `credential.project.revoke` audit row only when at least one grant was actually
  deleted; `membership.remove` is always audited.

## Human account sessions

- **HTTPS is mandatory.** Session and CSRF cookies are `Secure`; the session cookie is
  named `__Host-corkboard_session`, which requires `Secure`, `Path=/`, and no `Domain`
  attribute. Serve Corkboard only through a TLS reverse proxy. A client cannot obtain or
  use a session over plain HTTP in a conforming browser.
- **Cookie split.** The session cookie is `HttpOnly; Secure; SameSite=Strict; Path=/`.
  The separate `corkboard_csrf` cookie is `Secure; SameSite=Strict; Path=/` and
  intentionally readable by same-origin script so the client can send its value in the
  `X-CSRF-Token` header for `DELETE /api/v1/session`. Do not make the session cookie
  script-readable or relax `SameSite` without a new threat review.
- **Login CSRF.** `POST /api/v1/session` requires `Content-Type: application/json`
  (parameters allowed) and rejects other media types before parsing. A simple
  cross-site form or `text/plain` post cannot satisfy this, and no CORS is enabled, so a
  browser cannot send `application/json` cross-origin without a preflight. The HTML
  `POST /login` route instead requires a `login_csrf` hidden field matching the
  `HttpOnly; Secure; SameSite=Lax` `corkboard_web_login` cookie, compared as SHA-256
  digests. There is no Origin allowlist; the session cookie's `SameSite=Strict` covers
  subsequent requests.
- **What a session can do.** Read the signed-in account (`GET /api/v1/session`), sign
  out (`DELETE`), and open the read-only HTML dashboard, where it is resolved to an
  owned speaker's active membership for `project.read`/`message.read`. It cannot call
  the `/api/v1` data routes, send, mark read, expire, or call MCP, and it is not
  accepted as a bearer token. Speaker write operations still require a separately
  issued scoped credential.
- **Lifetime and revocation.** A session expires after **12 hours absolute** and after
  **30 minutes idle** (refreshed lazily by accepted `GET /api/v1/session` requests;
  `DELETE` validates and revokes without refreshing). Sign-out sets
  `revoked_at` for that row only and clears the cookies; other sessions stay valid.
  Revoking an account/session directly in SQL takes effect on the next request because
  no authorization cache exists.
- **Storage.** Only `sessions.token_prefix`, an HMAC verifier of the session token, and
  an HMAC verifier of the CSRF value are stored, all keyed by
  `CORKBOARD_CREDENTIAL_PEPPER` (no new secret). Raw tokens and CSRF values exist only
  in the browser cookies.
- **Cleanup.** There is no automatic session-row purge. The supported way to remove
  unusable rows is the operator-run `prune` command (see **Retention and pruning**):
  after a 24-hour default grace it deletes revoked, absolutely expired, and idle-expired
  sessions in bounded batches. Expired/revoked rows are inert for authentication because
  validation rejects them. Do not delete session rows by hand unless `prune` is
  unavailable; a manual delete immediately invalidates that session. Backups containing
  session rows are not authentication material without the pepper.
- **Abuse control.** Login attempts are limited per SHA-256 digest of the normalized
  email to 10/minute with burst 5, process-local, returning `429` + `Retry-After`.
  Addresses are not retained in the limiter. Unknown, wrong-password, inactive, and
  no-password failures are uniform `401`. Apply per-IP and volumetric limits at the
  reverse proxy; the application does not trust or read forwarding headers.

OAuth 2.1/PKCE is implemented as an authorization-server core in slice J (see
[`oauth.md`](./oauth.md)); ChatGPT Web account linking, registration, email
verification, and password reset are not implemented. Do not describe a session as OAuth
or as authority to act as a speaker.

## Read-only web dashboard

- **TLS and cookies.** The dashboard uses the same `Secure`, `HttpOnly`, `__Host-`
  session cookie and `corkboard_csrf` cookie. Serve it only through the TLS reverse
  proxy; do not terminate TLS and expose the origin over plain HTTP.
- **Caching.** Every HTML page is `Cache-Control: no-store`, `Referrer-Policy:
  no-referrer`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
  sends the strict CSP `default-src 'none'; style-src 'self'; form-action 'self';
  base-uri 'none'; frame-ancestors 'none'`. Do not add a shared cache or strip these
  headers at the proxy. The only static asset is the constant same-origin
  `/static/app.css`; there are no third-party resources.
- **Content rendering.** All stored metadata and decrypted bodies are escaped
  server-side. Bodies appear only on explicit body requests inside `<pre>`. Never
  add a Markdown renderer, HTML preview, inline event handler, or third-party
  script to these pages without a new threat review.
- **Sign-in CSRF and redirects.** `POST /login` is form-encoded, requires the
  double-submit `login_csrf` value, and accepts only a same-origin path in
  `return_to` (absolute/scheme-relative URLs, backslashes, control characters, and
  over-long values are rejected). The login form shares the per-email-digest rate
  limiter and returns an HTML `429` with `Retry-After`.
- **Logging.** Dashboard requests never log bodies, summaries, tokens, cookies,
  CSRF values, email addresses, or full IPs. Project/message identifiers in the path
  are not written into metrics labels; see `docs/web-ui.md`.
- **Trust domain.** The dashboard derives a viewer only from active, non-removed
  memberships of speakers owned by the account and calls the existing read service
  functions. A project without a qualifying membership is a uniform `404`. The
  `sessionViewer` flag is set in code only, never from request input.
- **Limits.** There are no write actions, so there is no dashboard state-changing
  CSRF surface. The dashboard does not add registration, recovery, or
  administrative capability.

## OAuth 2.1 authorization server

- **Configuration.** `CORKBOARD_PUBLIC_BASE_URL` must be an `https` origin with no
  path, query, fragment, username, or password. An invalid value fails startup
  before the data directory is created, opened, or chmodded; the error never includes
  the value. Unset/empty disables OAuth with a fixed `503`; existing bearer routes are
  unaffected. The value is public configuration, not a secret.
- **No API key or client secret.** Dynamic registration creates public clients only
  (`token_endpoint_auth_method=none`). Do not add a client secret, shared API key, or
  `CORKBOARD_APIKEY` to an OAuth request, consent page, token response, or prompt.
- **Token storage.** Authorization codes and refresh tokens are random 256-bit values
  stored as a public prefix plus a keyed HMAC-SHA-256 verifier under the existing
  `CORKBOARD_CREDENTIAL_PEPPER` (no new secret). Access tokens are ordinary
  `credentials` rows with `cb_oat_` tokens, consented scopes, and one project grant.
  Raw codes, refresh tokens, and access tokens exist only in transit/responses; none
  is logged.
- **Lifetimes.** Authorization code 5 minutes and single-use; access token 1 hour;
  refresh token 30 days per rotation. Refresh rotates both values and replaces the
  access credential's prefix/verifier/expiry; a reused rotated/revoked refresh token
  revokes the family and credential.
- **Consent.** Only `message.read` and `message.send` can be delegated. The consent
  endpoint requires the session cookie and `X-CSRF-Token` and re-reads ownership,
  membership, project state, and capabilities. It can never grant `project.edit`,
  member scopes, `receipt.write`, or another project's speaker.
- **Revocation.** `POST /oauth/revoke` returns `200` for a well-formed, non-abusive
  request; above the process-local global revoke bucket it returns `429`.
  Revoking a refresh token revokes its family and credential; revoking an OAuth access
  token revokes the credential and its families. A normal speaker token is ignored.
  Take effect on the next request; there is no authorization cache. To revoke every
  session of a client, revoke each refresh token or the underlying credential by id,
  or disable the account/speaker/membership.
- **Rate limits.** Registration is 10/minute (burst 5, global process-local key),
  token exchange 60/minute (burst 20, keyed by `client_id`), and revocation 60/minute
  (burst 20, global process-local key, checked after body parsing). These are
  additional denial only, reset on restart, and are not distributed. Per-IP controls
  remain the reverse proxy's job.
- **Headers and pages.** Every OAuth response is `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`. HTML pages have no inline JavaScript, no
  third-party resources, escaped values, and the CSP documented in `oauth.md`.
- **Cleanup.** Expired/rotated OAuth rows are rejected on use but are not purged
  automatically. The operator-run `prune` command removes consumed/expired codes,
  expired/revoked/rotated refresh rows, orphan associations, and OAuth credentials
  after a default 24-hour grace (see **Retention and pruning**). An expired-but-not-
  revoked access credential with a live refresh row can still be refreshed and remains
  revocable until that refresh row ages out past grace; a revoked credential cannot be
  refreshed (the attempt returns `invalid_grant` and revokes the family) but its rows
  are retained until `prune`. The credential, association, and grants are then deleted
  together. Deleting a refresh row invalidates that chain; deleting a credential row
  makes its access token unauthenticated.

## MCP transport

- `/mcp` requires the same scoped `Authorization: Bearer cb_...` credential as REST.
  Authentication happens before any MCP protocol handling or session creation; a
  missing/invalid credential receives `401` and no session id.
- The bearer token is never passed to the SDK, tool result, log, or audit. The SDK does
  receive the sanitized request (URL, body, non-credential headers) plus the derived
  principal (speaker, account, credential id, scopes). Before a request reaches the
  SDK, the adapter clones it and removes `Authorization`, `Proxy-Authorization`, and
  `Cookie`; the `requestInfo.headers` exposed to tool handlers therefore contains no
  credential material. A regression test observes the
  handler context and asserts those headers are absent.
- Sessions are in-memory, process-local, bound to the initializing credential, and lost
  on restart. Another credential's session id is `404`, including for `DELETE` (the
  owner's session survives). The registry is capped at 1024 sessions with
  least-recently-used eviction and a lazy 30-minute idle TTL swept on the next
  authenticated `/mcp` request; eviction closes the transport/server. There is no
  cross-process persistence. `/mcp` shares the per-credential rate-limit bucket with
  REST, and an over-limit request returns HTTP `429 RATE_LIMITED` before any session is
  created.
- Every `/mcp` response, including SDK JSON and protocol errors, carries
  `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- Every tool reuses the service authorization path and per-request credential/grant/
  membership/revocation checks. Tool arguments cannot set sender, timestamps,
  `body_digest`, or `idempotency_key`.
- The send adapter derives the idempotency key from the session id, JSON-RPC request id
  and its string/number type,
  and project id. A same-id retry is idempotent; a different payload is `CONFLICT`; a
  client retry with a new JSON-RPC id can duplicate the message and is documented as a
  client responsibility in [`mcp.md`](./mcp.md).
- Tool errors expose only a stable code (`FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
  `BODY_EXPIRED`, `INTEGRITY_FAILURE`, `UNAVAILABLE`, and so on). They never include
  service messages, stacks, bodies, summaries, or tokens.
- `POST /mcp` uses the 64 KiB request cap. `GET` returns `405` (no server-initiated
  SSE); `DELETE` terminates a session. No WebSocket transport exists.
- OAuth 2.1 access tokens are ordinary scoped `credentials` rows, so `/mcp` accepts
  them through the same authentication path. ChatGPT Web installation/linking and
  conversation-level tool invocation are not implemented. Do not place a token in a
  model prompt or chat message; local clients read it from their own
  environment/configuration.

## Database and blobs

- SQLite: WAL, `foreign_keys=ON`, `busy_timeout` set. Database file and blob directory
  are readable only by the service user (`0700` directories, `0600` files).
- **Production mode verifies these modes instead of assuming them.** Production is
  selected by `NODE_ENV=production` or by the explicit `CORKBOARD_REQUIRE_PRIVATE_FS=1`.
  Paths are normalized (`resolve`, so trailing separators, `.` and `..` cannot disguise
  a symlink) before any check. Before creating, chmodding, or opening anything, startup
  rejects a symlinked data directory, blob directory, database file, or `-wal`/`-shm`
  sidecar, so a rejected redirect leaves its target untouched. After opening it checks,
  and refuses to listen when it cannot confirm:
  - the data directory and blob directory exist, are directories, are not symbolic
    links, and have mode `0700`;
  - the database file and its existing `-wal`/`-shm` sidecars are regular files, not
    symbolic links, with mode `0600`;
  - every blob file has mode `0600`;
  - the blob directory contains no symbolic links or non-file entries.

  The error names the path and expected mode; it never includes key material, tokens,
  or message content. Outside production the existing best-effort tightening remains,
  and startup does not fail on modes. A symlinked data or blob directory is rejected in
  production so a mount or redirect cannot silently change where plaintext-adjacent
  state is written.
- The `init` bootstrap sentinel treats a `corkboard.sqlite` symlink, including a
  dangling one, as an existing installation and refuses to write. A data-directory path
  containing a newline or carriage return is rejected before the secrets file is
  written, so the `secrets.env` line cannot be split into a second assignment.
- Blobs are stored under random opaque keys, never served statically.
- Ciphertext is AES-256-GCM with a fresh 96-bit nonce per encryption. AAD binds only
  pre-decryption metadata: service ID, project ID, message ID, object ID, format
  version, and compression.
- Only the ciphertext SHA-256 is stored in the database. The sender-verified plaintext
  digest is encrypted inside the payload, never in the outer header or AAD. Reads
  verify the ciphertext digest, decrypt, then verify the embedded plaintext digest
  before returning any content; a mismatch creates no receipt. No cross-tenant
  deduplication.

### Read-only diagnostics

`doctor` is an operator diagnostic, not a repair tool. It opens the database with a
read-only connection: it does not create the data directory, chmod files, switch journal
mode, apply migrations, or modify rows. If the database file is absent it reports
`database: null` plus `SCHEMA_INCOMPLETE` and does not initialize an installation. A
clean WAL database with no sidecars is opened `immutable` so no `-wal`/`-shm` files are
created; with both sidecars present it reads the live WAL without creating files.
SQLite may rewrite the existing `-shm` coordination file during a live read, so database
and blob content are unchanged but `-shm` bytes may differ; authoritative orphan/missing
reconciliation should be run against a quiesced instance or retried. Sidecar detection is
not a lock: a concurrent checkpoint can recreate `-wal`/`-shm` between the check and the
open, so a first read may need a retry. A lone sidecar (crash-recovery state), a
symlinked or otherwise non-regular sidecar, a symlinked data directory, a database path
that is not a regular file (including a symlink), and a busy/locked database exit `2`
with a stable message instead of a stack trace. A **missing** data directory or database
is not exit 2: it reports `database: null` and `SCHEMA_INCOMPLETE` and exits `1`.

Output contains no message summaries, bodies, tokens, credential verifiers, key material,
or secret file contents. Key presence is reported only as booleans: whether
`CORKBOARD_ROOT_KEY` and `CORKBOARD_CREDENTIAL_PEPPER` are set, whether each has the
32-byte base64 shape, and the configured key version `v1`. The full values are never
printed or logged.

Blob reconciliation never follows symlinks. `blob_dir_non_files` counts non-file entries
(directories, symlinks, special files) and invalid-named regular files are ignored.
`orphaned` means a valid opaque blob-file name is not referenced by any non-null
`body_objects.storage_key`; `missing` means a referenced key has no regular file on disk;
`expired_pending_deletion` means an expired message's body object is not yet
`state = 'deleted'` (including `NULL`). These are reported as counts only. Output is
bounded (at most ten provisional IDs and ages), but reconciliation reads every referenced
storage key internally and `integrity_check` scans the database, and the
applied/unexpected version lists are proportional to `schema_migrations` rows. A tampered
database with a very large migration table can enlarge the report; normal installations
have one row per shipped migration. Values that cannot be measured because the schema or
database is unavailable are `null`, not zero; no content is selected.

A `schema_migrations` version newer than the highest bundled migration is reported as
`SCHEMA_AHEAD` with `complete: false` and exit `1`. The normal opener used by the server
and other CLI commands refuses such a database with a clear error **before applying any
migration**, so an older binary cannot write against a newer schema. Non-positive or
non-integer migration rows are treated defensively as unexpected/hostile rather than
silently ignored.

Exit codes: `0` clean, `1` issues found (the stable codes are listed in
[`deployments.md`](./deployments.md)), `2` the inspection could not run. There is no
destructive repair/fix mode in this slice; do not "fix" an orphan by deleting files
without first confirming the database and backup state. `doctor` is SQLite/Node-specific
(`PRAGMA integrity_check`); the D1/Workers deployment has no equivalent yet.

## Logging and audit

- Log request ID, route, status, duration, and actor IDs. Log a stable error code only
  when the response uses the Corkboard JSON envelope; MCP tool-level failures are HTTP
  `200` with `isError: true` and are not logged as error codes.
- Never log message bodies, summaries, tokens, keys, full IPs, credential headers,
  `Cookie`, `X-CSRF-Token`, passwords or password hashes, session tokens, CSRF values,
  email addresses, MCP session ids, or password material.
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
- Session and OAuth artifact retention is **explicit and operator-run**. `prune`
  deletes only rows that are definitely unusable and have been so for at least a grace
  period (default **24 hours**, `--grace-hours`). There is no timer and no automatic
  deletion. Eligible rows are: sessions revoked, absolutely expired, or idle-expired
  past grace; consumed or expired authorization codes; expired, revoked, or rotated
  refresh tokens; `oauth_token_clients` associations whose credential is gone, or is
  revoked/expired past grace **and no refresh row references it**; and OAuth access
  credentials revoked/expired past grace with no remaining refresh-token row. A
  still-valid credential, refresh row, session, or association is never eligible.
- The grace period absorbs clock skew, a request already in flight when the boundary
  passes, and the ordinary delay before an operator run. A 24-hour grace with a **daily**
  schedule is the recommended policy. `--grace-hours 0` deletes at the boundary
  immediately and is intended for tests or an explicitly aggressive policy, not the
  default.
- `prune` never deletes messages, message receipts, body objects or blobs, audit
  events, speaker (`cb_`) credentials, or any token/credential that is still usable. It
  does not write audit rows (nothing is selected from the audit table). Deletes run in
  one `BEGIN IMMEDIATE` transaction in FK-safe order, bounded by `--limit` (default
  1000, 1–10000) per session/OAuth artifact table; an OAuth credential's
  `credential_project_grants` rows are removed with the credential and are not counted
  separately. A failure rolls everything back and the command can be run repeatedly.
  A credential blocked by a still-live refresh row is retained
  **together with its `oauth_token_clients` association and grants**, so refresh and
  RFC 7009 access-token revocation keep working. Once that refresh row itself ages out
  past grace, the credential, association, and grants are deleted together in the same
  run. The association is never removed while a refresh row still references the
  credential.

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

## Rate limiting and abuse controls

- Authenticated `/api/v1` and `/mcp` requests are limited per credential with an
  in-memory token bucket: default 120 requests/minute with burst 30. Configure with
  `CORKBOARD_RATE_LIMIT_PER_MINUTE` (`0` disables) and `CORKBOARD_RATE_LIMIT_BURST`
  (1–1000); invalid values stop startup. Limiting happens after authentication and
  before body parsing, so an over-limit request creates no MCP session and no handler
  effect.
- Limits are **process-local and not shared** across processes or Workers isolates.
  Each process enforces its own buckets; a restart resets them. This is not distributed
  rate limiting. If you run several processes, the effective aggregate limit is roughly
  the per-process limit times the process count.
- Tracked credentials are bounded (10,000); an entry idle for 2 minutes is evicted.
- Unauthenticated requests are not keyed. Bearer tokens are 256-bit random values, so
  token guessing is impractical; apply **per-IP connection/request limits, body-size
  limits, and volumetric abuse controls at the reverse proxy** instead. The application
  does not trust forwarding headers or enforce IP limits itself.
- A `429` carries only `RATE_LIMITED`, a `request_id`, and `Retry-After`; no token,
  body, summary, or credential verifier is logged or returned. Request logs record the
  actor ids and stable error code already described under **Logging and audit**.

## Operator metrics endpoint

- `GET /metrics` is disabled unless `CORKBOARD_METRICS_TOKEN` is set. Unset, empty, and
  whitespace-only values disable it. The token is a secret: supply it through the
  environment or a `0600` secrets file, never argv, a URL, a log line, or a chat
  transcript. Any non-empty token must be at least 32 characters at both env parsing and
  `createApp` construction; a shorter value fails closed with a fixed message that never
  includes the value. The env parser runs before the data directory is created or
  opened. Rotate it by restarting with a new value.
- The endpoint requires exactly `Authorization: Bearer <token>` (query parameters are
  ignored). Both values are SHA-256 digested and the fixed-length digests are compared
  without an early exit, so token content and the configured token's length cannot be
  inferred from the comparison. Missing, wrong, and non-operator speaker tokens receive
  the ordinary unknown-route `404 NOT_FOUND`, not `401`/`403`, with the same body and
  security headers. The response does not echo the token and the request log never
  contains it.
- Timing caveat: the disabled path returns without hashing, while the enabled path with
  a `Bearer` header performs two SHA-256 operations before the same `404`. Response
  timing may reveal whether the endpoint is enabled; no status/body non-disclosure claim
  covers perfect timing indistinguishability, and no token content or length is
  exposed.
- The snapshot contains counters and timing only: total requests, fixed route labels,
  HTTP status counts, stable Corkboard error codes (including `RATE_LIMITED`), and
  cumulative latency buckets. It never contains bodies, summaries, tokens, keys,
  request/response bodies, query strings, raw pathnames, project/message/speaker/account
  IDs, or IPs. `/mcp` requests are counted under the `/mcp` label; tool names and
  arguments are not read.
- `GET /metrics` does not authenticate a speaker and is not keyed by the per-credential
  rate limiter; it neither consumes nor affects user buckets. Protect it with the token
  and network policy (bind to loopback or the reverse proxy); it is operator-only, not a
  public health endpoint.
- Metrics are **process-local and in-memory**. They reset on restart, are not shared
  across processes or Workers isolates, and have no persistence or history. Scrape each
  process separately; do not treat them as billable or audited records. There is no
  per-project authorized view and no queue-to-commit histogram in this slice.

## Known limits

- The operator can read all message bodies.
- Retention (`prune`) is explicit, operator-run, and Node/SQLite-only; it writes no
  audit row and never deletes blobs, messages, receipts, or audit events. A
  revoked/expired OAuth access credential that still has a live refresh row is retained
  with its `oauth_token_clients` association and grants (so refresh and RFC 7009
  revocation remain effective), and is deleted with them once the refresh row is
  pruned past grace. There is no automatic scheduling.
- Hard deletion of metadata/backups is not implemented; expiry is a tombstone, not
  comprehensive erasure.
- Rate limiting is per-process and per-credential; there is no distributed/global
  limiter and no application-level per-IP limiting (delegated to the reverse proxy).
- Metrics are per-process in-memory counters with no persistence, aggregation, or
  per-project views; the latency histogram is request duration, not queue-to-commit.
- Human sessions are implemented as server-side rows with 12-hour absolute / 30-minute
  idle expiry and per-session revocation. The OAuth 2.1 authorization-server core is
  implemented (dynamic public clients, PKCE, rotating refresh tokens, revocation), but
  the ChatGPT Web plugin experience is not implemented or verified. There is no browser
  UI beyond the OAuth sign-in/consent pages, registration, email verification, or
  password reset. Login rate limiting and outcome uniformity are bounded but not
  perfectly timing-equivalent across PBKDF2 and the Node-only legacy scrypt path.
