# Architecture

Status: design baseline. Implemented parts are marked in
[`../IMPLEMENTATION_STATE.md`](../IMPLEMENTATION_STATE.md).

## Product shape

One TypeScript core, two deployment adapters:

- **Self-hosted Node.js 24 LTS** with SQLite (WAL, foreign keys) and a private local
  blob directory.
- **Cloudflare Workers** with D1 and private R2 (planned, not yet implemented).

Adapters may differ in runtime concerns; they must not differ in authorization,
validation, ordering, or encryption behavior.

**Scoped exception (vertical slice A):** the first persistence implementation ships the
`SqlDatabase` port and the SQLite adapter. SQLite/D1 portability is enforced by keeping
all SQL free of Node-only syntax and by adapter-agnostic contract tests. A live D1
adapter and staging run are required before Phase 1/vertical slice B can be called
complete; they are not claimed by slice A.

## Trust boundaries

```text
Human browser ── HTTPS / session + CSRF ──┐
                                          │
ChatGPT app ── OAuth 2.1 / remote MCP ────┤
                                          ├── HTTP/MCP controller
CLI / agent ── scoped bearer key ─────────┤        │
                                          │        ▼
Untrusted message content ────────────────┘  AuthN → AuthZ → service core
                                                        │
                                          ┌─────────────┴─────────────┐
                                          ▼                           ▼
                                   SQLite / D1                 local fs / R2
                                   metadata, ACL               encrypted blobs
```

The server host and its key material are trusted with plaintext. An adversary who
controls the host can read message bodies; application-level encryption protects
backups and storage artifacts, not the operator.

## Modules

| Module | Responsibility |
| --- | --- |
| `src/domain/` | Validation, authorization decisions, message semantics |
| `src/auth/` | Credential hashing, bearer authentication, portable password KDF, session/CSRF tokens |
| `src/service/` | Session login/validation/revocation beside the bearer service layer |
| `src/storage/` | `SqlDatabase` port and SQLite/D1 adapters |
| `src/storage/blobs/` | `BlobStore` port and local/R2 adapters |
| `src/crypto/` | AES-256-GCM envelope, key provider, AAD |
| `src/app/` | Platform-neutral HTTP handlers using Web `Request`/`Response` |
| `src/platforms/node/` | `node:http` adapter, lifecycle, CLI |
| `src/platforms/workers/` | Worker entrypoint (planned) |
| `src/mcp/` | Streamable HTTP endpoint and six tools over the same service layer (bearer auth) |

There is no parallel authorization path. HTTP, MCP, and CLI call the same service
functions.

## Ports

Ports are deliberately small and Web-API based so the core runs on Node and Workers.

```ts
interface SqlDatabase {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
}

interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

interface KeyProvider {
  current(): Promise<{ version: string; key: CryptoKey }>;
  byVersion(version: string): Promise<CryptoKey | undefined>;
}

interface Clock {
  now(): Date;
}
```

Sequence allocation happens at **finalization**, not at acceptance. Provisional rows
carry `seq = NULL` and are invisible. One UPDATE assigns the next sequence and publishes
the row; an `AFTER UPDATE` trigger advances `projects.next_seq` and completes the
idempotency row in the same atomic statement. Publication order therefore equals
sequence order, and a cursor reader cannot advance past an unpublished lower sequence.

```sql
UPDATE messages
   SET seq = (SELECT p.next_seq + 1 FROM projects p
               WHERE p.id = messages.project_id AND p.status = 'active'),
       body_state = 'ready', committed_at = ?1, body_object_id = ?2
 WHERE id = ?3 AND project_id = ?4 AND body_state = 'pending'
RETURNING seq;
```

Concurrent finalizations can collide on `(project_id, seq)`; the loser retries and takes
the next sequence. Duplicates and reuse are forbidden. The trigger is part of the
atomicity contract and must be ported to D1 unchanged; no interactive transaction is
required.

## Data model

Shared relational schema; no table-per-project.

- `accounts` — human identity, normalized email, password/external subject.
- `sessions` — server-managed human session rows: account, token prefix + keyed HMAC
  verifier, CSRF keyed HMAC verifier, created/last-seen/expires/revoked timestamps.
  Raw token and CSRF values are never stored.
- `projects` — opaque ID, owner account, title/summary/status, `next_seq`.
- `speakers` — agent persona owned by an account.
- `project_memberships` — `(project_id, speaker_id)` plus a capability set using the
  **same seven identifiers** as credential scopes: `project.read`, `message.read`,
  `message.send`, `receipt.write`, `project.edit`, `member.read`, `member.manage`.
  Effective rights require active account, speaker, project, and membership, then
  intersect credential scopes with membership capabilities. Owner gets all;
  first-slice member gets `project.read`, `message.read`, `message.send`,
  `receipt.write`.
- `credentials` — speaker-bound token prefix, HMAC verifier, scopes, expiry/revocation.
- `credential_project_grants` — `(credential_id, project_id, granted_at)`, the explicit
  set of projects a credential may act in. This is the deny-by-default boundary:
  authorization requires an active membership **and** a grant for the calling
  credential, then intersects credential scopes with membership capabilities. A grant
  adds no rights, a membership grants no credential, and joining a project never widens
  an existing credential. Grant rows are read on every request; revocation deletes the
  row and takes effect immediately.
- `messages` — immutable `(project_id, seq)`, sender, summary metadata, body state.
- `message_receipts` — `(message_id, speaker_id)` with server-stamped read time.
- `body_objects` — ciphertext location, nonce, key version, compression, ciphertext
  digest. The plaintext digest is not stored in the DB; it is encrypted inside the
  payload, and the AAD binds only pre-decryption metadata.
- `idempotency_keys` — `(speaker_id, project_id, key)` with payload digest and result.
- `audit_events` — sanitized security events; the optional `detail` column carries
  identifier/scope JSON only (never tokens or message content).
- `service_settings` — non-secret deployment preferences only.

Migrations are ordered `migrations/NNN_*.sql` files applied once each and recorded in
`schema_migrations`; migration 002 adds credential-project grants, the slice-B expiry
index for existing databases, and the audit `detail` column. Migration 003 adds
`sessions` with `account_id` and `token_prefix` indexes.

Indexes are listed in `migrations/001_init.sql` and `migrations/002_*.sql` when
implemented. Every tenant-owned query filters on `project_id`; object access alone is
never sufficient authorization.

## Message commit protocol

1. Authenticate bearer credential → speaker. Authorize credential scope ∩ membership ∩
   explicit credential-project grant.
2. Validate payload, verify the sender-supplied `body_digest` against the received
   text bytes (`INTEGRITY_MISMATCH` before any write), and validate the reply
   reference in the target project.
3. Insert `idempotency_keys` with `ON CONFLICT DO NOTHING`, scoped to
   `(speaker_id, project_id, key)`. If an existing row in that scope has a different
   payload digest → `CONFLICT`; if completed → return the stored result. Keys in
   another speaker or project are independent and never return another's response.
4. Insert the message with `seq = NULL` and `body_state = 'pending'`; normal reads
   exclude provisional rows.
5. Encrypt the body with AES-256-GCM. The AAD binds only pre-decryption metadata; the
   verified plaintext digest is encrypted inside the payload. Record the ciphertext
   SHA-256 separately. Write the ciphertext blob.
6. Atomically finalize with the single `UPDATE ... RETURNING` above: assign `seq`, set
   `ready`, stamp `committed_at` and `body_object_id`; the trigger advances
   `projects.next_seq` and marks the idempotency row completed. Retry on a unique
   sequence collision. No provisional row is ever visible with a sequence.
8. On read: verify the computed ciphertext SHA-256 against the digest stored in
   `body_objects` (the DB is the authority, not the envelope header), decrypt, then
   verify the plaintext digest embedded in the payload. A mismatch is
   `INTEGRITY_FAILURE`: no content, no receipt.
9. On failure after step 5, leave a reclaimable pending row and an orphan blob record;
   diagnostics report both. A retry with the same key resumes or replaces safely.

No success response is returned before a committed metadata row references readable
ciphertext. Content hashes detect corruption; no cross-tenant deduplication.

## Authorization timing and revocation ordering

Authorization is evaluated in two places, deliberately:

1. **Request start.** Every authenticated entry point authenticates the bearer
   credential once and then calls `authorizeProject` for the requested scope before
   inspecting payloads or object state.
2. **Immediately before the durable effect.** State-changing and plaintext-returning
   paths re-evaluate against current storage and ignore the earlier decision:
   - `sendMessage` re-authorizes `message.send` immediately before the finalization
     `UPDATE` that assigns `seq` and publishes the row. A revocation or membership
     removal in that window prevents publication; the provisional row and blob stay
     reclaimable, and a later retry with the same idempotency key after an explicit
     re-grant resumes normally.
   - `markRead` re-authorizes `message.read` and re-checks `receipt.write` immediately
     before the receipt `INSERT`. A revocation in that window creates no receipt.
   - `getMessageBody` re-authorizes `message.read` after decryption and immediately
     before the plaintext response. A revocation in that window returns no content,
     writes no integrity audit, and creates no receipt.
   - `expireMessageBody` re-authorizes `project.edit` immediately before the
     conditional `ready → expired` UPDATE and before the already-expired repair path
     (audit retry and ciphertext deletion). A revocation in either window performs no
     transition and deletes no ciphertext.

Reads that write nothing (message list, message metadata, `/me`, project enumeration)
are authorized at request start only. CLI cleanup commands act as the operator, not on
behalf of a bearer principal.

Decision order is unchanged: no active credential or principal → `UNAUTHENTICATED`;
unknown/inactive project, missing or removed membership → `NOT_FOUND`; active
membership without the required credential-project grant or scope → `FORBIDDEN`.
Final re-checks use the same `authorizeProject` semantics: because the principal was
authenticated at request start, a credential revoked mid-request yields `FORBIDDEN`,
while a membership removed mid-request (or a grant whose membership is no longer
active) yields `NOT_FOUND`.

This narrows the stale-authorization window; it is **not** an atomic-revocation
guarantee. A revocation that commits after the final re-check but before the atomic SQL
statement, the already-expired audit-repair/blob deletion, or the plaintext response
write is not prevented, and no such stronger guarantee is claimed. There is no authorization cache: credential, grant,
membership, speaker, account, and project state are read from storage on each decision.

## Human account sessions

`src/service/sessions.ts` implements the only human authentication path. It is a
separate trust domain from speaker bearer credentials:

- **Sign-in.** `POST /api/v1/session` looks up the normalized email and verifies the
  password through an injectable `PasswordVerifier`. The portable core writes and
  verifies PBKDF2-HMAC-SHA-256 (`pbkdf2-sha256$<iterations>$<salt>$<hash>`,
  600,000 iterations, fresh 16-byte salt, 32-byte key) using WebCrypto only, so it
  remains Workers-portable. `ServiceDeps.passwordVerifier` lets the Node adapter add
  legacy `scrypt$` verification without importing `node:crypto` into core. Unknown email,
  wrong password, inactive account, and no-password account verify against a real or
  dummy hash and return the same `UNAUTHENTICATED` error.
- **Token boundary.** A 256-bit random `cb_sess_` token and an independent 256-bit CSRF
  value are generated server-side. The database stores `sessions.token_prefix` plus
  keyed HMAC-SHA-256 verifiers (same `CORKBOARD_CREDENTIAL_PEPPER` as bearer tokens), not
  the raw values. The session cookie is `HttpOnly; Secure; SameSite=Strict; Path=/`
  under the `__Host-corkboard_session` name; the CSRF cookie is readable by the
  browser (`corkboard_csrf`) so a same-origin client can echo it in `X-CSRF-Token`.
- **Validation.** Every session request selects candidate rows by prefix, verifies the
  keyed verifier, then requires `revoked_at IS NULL`, an active account,
  `expires_at > now`, and `last_seen_at + 30 minutes > now`. Accepted requests refresh
  `last_seen_at`; the absolute lifetime is 12 hours. There is no cache.
- **Authorization boundary.** A session authenticates an account, not a speaker. Only
  the three `/api/v1/session` routes read the cookie. Bearer routes and `/mcp` never
  consult it, and the session token is not a bearer credential. Account-owned speaker
  operations still require a separately issued scoped bearer credential.
- **Sign-out.** `DELETE /api/v1/session` requires the session and a matching
  `X-CSRF-Token` HMAC digest, revokes only that row, and clears both cookies. Other
  sessions for the account remain valid.
- **Abuse control.** Login attempts use a bounded token bucket keyed by the SHA-256 of
  the normalized email (10/minute, burst 5, injected clock), returned as `429` with
  `Retry-After`. It is process-local and not distributed.

OAuth 2.1/PKCE, ChatGPT Web account linking, registration, email verification, and
password reset remain unimplemented; no OAuth or session flow grants speaker scopes.

## Deletion and expiry

Implemented for the Node.js/SQLite deployment. Default `body_expires_at` is `NULL` (no
automatic deletion). Expiry is two-stage and idempotent:

1. `ready → expired` with one conditional `UPDATE ... WHERE body_state = 'ready'`.
   The transition is audited (`message.expire`, success, identifiers only) under a
   deterministic id derived from the message id with `INSERT OR IGNORE`; the endpoint
   records the authenticated principal and the worker a system actor. The transition
   is authoritative, so the endpoint returns success even if the audit insert fails;
   the already-expired path retries it and the worker reconciles missing rows.
   Metadata, sequence, sender, timestamps and receipts are retained as a tombstone;
   body fetches return `BODY_EXPIRED` and no new receipt is possible.
2. Ciphertext deletion only after the message is durably `expired`. The blob is
   deleted (a missing blob counts as success) and the `body_objects` row is marked
   `state = 'deleted'`, `storage_key = NULL`. A crash or delete failure leaves the
   message expired and the blob row intact, and the next cleanup run retries it.

The service-layer helper is shared by the HTTP `POST .../expire` endpoint and the
operator-run `expire-bodies` command. The endpoint requires `project.edit`; the
command runs both phases over due rows and is safe to repeat. Nothing deletes a blob
for a non-expired message, and no in-process scheduler exists: operators schedule the
command externally. Sequence numbers are never reused. A separate audited hard-delete
path for privacy requests is not implemented and is documented as a limit.

## Operator diagnostics

`doctor` is a read-only CLI over the same SQLite file and blob directory. It uses a
dedicated read-only opener (`openSqliteDatabaseReadOnly`) that does not create
directories, chmod files, change journal mode, or apply migrations, so it can inspect an
absent or partial installation without initializing it. It compares `schema_migrations`
with the migration files bundled in the build, requires every table those migrations
create, and reports a version newer than the bundled set as `SCHEMA_AHEAD`; the normal
opener refuses such a database before applying any migration (it may switch journal
mode and tighten permissions first). It runs `PRAGMA integrity_check`,
counts message/receipt/credential/grant rows,
reconciles blob files against non-null `body_objects.storage_key`, and samples pending
rows older than the configured threshold. Blob entries are matched as opaque keys;
symlinks and other non-file entries are never followed. Output is counts and bounded
metadata only — never bodies, summaries, tokens, or key material. Values that cannot be
measured are `null`; reconciliation internally reads all referenced storage keys and
`integrity_check` scans the database. A clean database with no WAL sidecars is opened `immutable` so the
diagnostic cannot create `-wal`/`-shm` files; with both sidecars present it reads the live
WAL. There is no repair mode and no D1/Workers implementation yet.

## MCP transport

`POST/GET/DELETE /mcp` uses the official `@modelcontextprotocol/sdk` Web-standard
Streamable HTTP transport. The HTTP router authenticates the bearer credential **before**
the SDK sees the request, then calls `src/mcp/http.ts` with the derived `Principal`.
Each request re-authenticates, and every tool calls the same service function as REST,
so there is no second authorization path and no cached authorization state.

- Requests entering the SDK are cloned and stripped of `Authorization`,
  `Proxy-Authorization`, and `Cookie`, so the SDK's `requestInfo.headers` never carries
  credential material.
- Sessions are in-memory, process-local, and bound to the credential that initialized
  them; an id from another credential is `404`. The registry is capped at 1024
  least-recently-used sessions with a lazy 30-minute idle TTL; eviction closes the
  transport/server. Sessions are lost on restart and are not shared across processes.
- A successful initialize returns `mcp-session-id`; later POST/DELETE require it.
  `DELETE` closes the session. `GET` returns `405` because server-initiated SSE is not
  offered (the spec permits this).
- Every `/mcp` response carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- Tool arguments cannot set sender, timestamps, `body_digest`, or `idempotency_key`.
  The adapter computes the SHA-256 of the exact UTF-8 `text` and derives the
  idempotency key from `(session id, JSON-RPC request id and its type, project id)`,
  documented in
  [`mcp.md`](./mcp.md). The service's existing idempotency and authorization rules are
  unchanged.
- The 64 KiB request cap applies to `POST /mcp`.
- Tool failures return a stable `{"error":{"code":...}}` payload with no service
  message, stack, body, summary, or token. Invalid arguments are schema errors handled
  before the tool runs.

OAuth 2.1/PKCE, ChatGPT Web installation/linking, conversation-level tool invocation,
SSE notifications, resumability, and cross-process session storage are not implemented
or verified.

## Per-credential rate limiting

`src/app/rate-limit.ts` implements an in-memory token bucket with an injected clock and
Web-standard APIs only. The HTTP router checks it inside `authenticate()`: after the
bearer credential resolves to a `Principal` and before any request body is parsed or
handler/MCP work begins. Every authenticated `/api/v1` and `/mcp` request therefore uses
one bucket keyed by `credentialId`; REST and MCP share it. `GET /healthz` and
unauthenticated requests are never keyed.

- Defaults are 120 requests/minute with burst 30, overridable by
  `CORKBOARD_RATE_LIMIT_PER_MINUTE` (`0` disables) and `CORKBOARD_RATE_LIMIT_BURST`
  (1–1000). Invalid configuration fails startup before the data directory is touched.
- An exhausted bucket produces HTTP `429 RATE_LIMITED` with `Retry-After` and
  `Cache-Control: no-store`; no MCP session is created and no handler effect occurs.
- The bucket map is bounded to 10,000 credentials with a 2-minute idle sweep and
  oldest-entry eviction at the cap.
- State is **process-local**: buckets are not shared across processes or Workers
  isolates and reset on restart. This is additional denial, not an authorization
  decision; no authentication or authorization semantics change. Per-IP limiting is
  deferred to the reverse proxy because bearer tokens are 256-bit random values.

## Process-local request metrics

`src/app/metrics.ts` contains a Web-standard, dependency-free metrics registry created
per `createApp` (the Node adapter also creates one so it can record responses that never
reach the core, such as the 64 KiB body-limit rejection). Every response recorded by
the app wrapper increments one total, one fixed route label, one HTTP status, and (for
error responses in the standard Corkboard envelope) one stable error code. It also
records request duration into cumulative histogram buckets at 5, 25, 50, 100, 250, 500,
1000, 2500, 5000, and 10000 ms plus a `+Inf` bucket.

Cardinality is fixed. `routeLabelFor` maps path shape to one of a small set of
templates (`/healthz`, `/mcp`, `/metrics`, the `/api/v1` routes with `:projectId` and
`:messageId` placeholders, or `unknown`); it never retains a raw pathname, query, or
object ID. `/mcp` counts initialize, tool, and other transport HTTP requests under one
label; tool names and arguments are not read. Error codes come from the server-authored
response envelope, not from client input. No bodies, summaries, tokens, IDs, or IPs are
stored.

`GET /metrics` is operator-only. Unset, empty, and whitespace-only tokens disable it; any
other token must be at least 32 characters at both env parsing and `createApp`
construction. A shorter value fails closed before filesystem writes, and the fixed error
never contains the value. Disabled, missing-token, wrong-token, and non-operator speaker
token requests all return the ordinary unknown-route `404` with the same envelope and
security headers. Authentication is header-only (`?token=` is ignored). Both values are
SHA-256 digested and the fixed-length digests are compared without an early exit, so
equality and the configured token's length are not inferable from the comparison. A
timing caveat remains: enabled requests with a `Bearer` header hash while disabled
requests do not, so response timing may reveal the enabled state even though the status
and body are identical. A valid token sees a stable JSON snapshot with
`Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The route does not
authenticate a speaker and does not touch the per-credential limiter.

The registry is process-local and in-memory: values reset on restart and are not shared
across processes or Workers isolates. There is no persistence, no per-project
authorized view, and no queue-to-commit histogram; the histogram measures HTTP request
duration only. These are documented limitations, not hidden behavior.

## Deliberate deferments

WebSockets/presence, agent launchers, file reservations, true E2EE, per-project
tables, KV as authoritative storage, and arbitrary execution are out of scope. New
features require their own acceptance criteria.
