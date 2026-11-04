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
| `src/auth/` | Credential hashing, bearer authentication, (later) sessions/OAuth |
| `src/storage/` | `SqlDatabase` port and SQLite/D1 adapters |
| `src/storage/blobs/` | `BlobStore` port and local/R2 adapters |
| `src/crypto/` | AES-256-GCM envelope, key provider, AAD |
| `src/app/` | Platform-neutral HTTP handlers using Web `Request`/`Response` |
| `src/platforms/node/` | `node:http` adapter, lifecycle, CLI |
| `src/platforms/workers/` | Worker entrypoint (planned) |
| `src/mcp/` | MCP tools over the same service layer (planned) |

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
index for existing databases, and the audit `detail` column.

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

## Deliberate deferments

WebSockets/presence, agent launchers, file reservations, true E2EE, per-project
tables, KV as authoritative storage, and arbitrary execution are out of scope. New
features require their own acceptance criteria.
