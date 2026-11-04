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

Atomic per-project sequence allocation uses one statement, so it needs no interactive
transaction (which D1 does not provide):

```sql
UPDATE projects SET next_seq = next_seq + 1
WHERE id = ?1 AND status = 'active'
RETURNING next_seq;
```

Gaps are acceptable after a failed post; duplicates and reuse are not.

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
- `messages` — immutable `(project_id, seq)`, sender, summary metadata, body state.
- `message_receipts` — `(message_id, speaker_id)` with server-stamped read time.
- `body_objects` — ciphertext location, nonce, key version, compression, ciphertext
  digest. The plaintext digest is not stored in the DB; it lives in the sealed
  envelope and the AEAD AAD.
- `idempotency_keys` — `(speaker_id, project_id, key)` with payload digest and result.
- `audit_events` — sanitized security events.
- `service_settings` — non-secret deployment preferences only.

Indexes are listed in `migrations/001_init.sql` when implemented. Every tenant-owned
query filters on `project_id`; object access alone is never sufficient authorization.

## Message commit protocol

1. Authenticate bearer credential → speaker. Authorize credential scope ∩ membership.
2. Validate payload, verify the sender-supplied `body_digest` against the received
   text bytes (`INTEGRITY_MISMATCH` before any write), and validate the reply
   reference in the target project.
3. Insert `idempotency_keys` with `ON CONFLICT DO NOTHING`, scoped to
   `(speaker_id, project_id, key)`. If an existing row in that scope has a different
   payload digest → `CONFLICT`; if completed → return the stored result. Keys in
   another speaker or project are independent and never return another's response.
4. Allocate `seq` with the atomic `UPDATE ... RETURNING` above.
5. Insert the message with `body_state = 'pending'`; normal reads exclude it.
6. Encrypt the body with AES-256-GCM. The AAD binds the verified plaintext digest,
   and the envelope carries it; record the ciphertext SHA-256 separately. Write the
   ciphertext blob.
7. Mark `body_objects` and the message `ready`, stamp `committed_at`, mark the
   idempotency row completed.
8. On read: verify the ciphertext digest, decrypt, then verify the AAD-bound
   plaintext digest. A mismatch is `INTEGRITY_FAILURE`: no content, no receipt.
9. On failure after step 5, leave a reclaimable pending row and an orphan blob record;
   diagnostics report both. A retry with the same key resumes or replaces safely.

No success response is returned before a committed metadata row references readable
ciphertext. Content hashes detect corruption; no cross-tenant deduplication.

## Deletion and expiry

Default `body_expires_at` is `NULL` (no automatic deletion). Expiry is two-stage:
`ready → expired` (body unfetchable, metadata retained) and then ciphertext deletion
with retries. Sequence numbers are never reused. A separate audited hard-delete path
for privacy requests is not part of the first slice and is documented as a limit.

## Deliberate deferments

WebSockets/presence, agent launchers, file reservations, true E2EE, per-project
tables, KV as authoritative storage, and arbitrary execution are out of scope. New
features require their own acceptance criteria.
