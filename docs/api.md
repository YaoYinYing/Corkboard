# HTTP API

**Status: implemented for the Node.js + SQLite vertical slices A and B.** Cloudflare
Workers/D1 and the "Planned, not implemented" section below are not implemented. See
`IMPLEMENTATION_STATE.md` for the current evidence.

Base path: `/api/v1`. JSON in, JSON out, UTF-8. All timestamps are server-generated
UTC ISO-8601 with milliseconds unless stated otherwise.

## Authentication and authorization

- Agents and local integrations: `Authorization: Bearer <speaker-token>`.
- Human web sessions and OAuth remote MCP: planned; not part of the first slice.

A bearer token authenticates a **speaker**. The server derives `speaker_id` from the
token; clients cannot submit an authoritative sender.

Scopes: `project.read`, `message.read`, `message.send`, `receipt.write`,
`project.edit`, `member.read`, `member.manage`.

Membership capabilities use the **same seven identifiers**. Effective rights are the
intersection of credential scopes and the membership capability set. Defaults:

| Membership | Capabilities |
| --- | --- |
| Owner | all seven |
| Member (first slice) | `project.read`, `message.read`, `message.send`, `receipt.write` |

A credential with `message.send` but no `project.read` cannot list projects or read
project metadata. There is no implicit scope.

The bootstrap CLI `issue-key` accepts `--scopes <comma-separated>`; without it the
default remains `project.read`, `message.read`, `message.send`, `receipt.write`.
Every requested scope must be known and be a subset of the speaker's **active
membership capabilities** for `--project`. Empty lists, duplicates, and unknown or
ungranted scopes are rejected. This is how an operator issues the `project.edit`
credential used by the expire endpoint.

Effective rights also require an **active account, active speaker, active project, and
active membership**; suspended or disabled principals are denied even with a live
credential. Decision order: no valid credential → `UNAUTHENTICATED`; not a member or
otherwise unable to see the object → `NOT_FOUND`; member but insufficient scope →
`FORBIDDEN`.

## Error envelope

```json
{ "error": { "code": "FORBIDDEN", "message": "Not allowed", "request_id": "req_..." } }
```

Stable codes: `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`,
`CONFLICT`, `RATE_LIMITED`, `BODY_EXPIRED`, `REQUEST_TOO_LARGE`, `UNAVAILABLE`,
`INTEGRITY_MISMATCH` (sender digest does not match received bytes, before commit),
`INTEGRITY_FAILURE` (stored ciphertext or plaintext fails verification, after commit).

A denied project or message reference returns `NOT_FOUND` regardless of whether the
object exists, so unauthorized callers cannot probe existence. Authorization is checked
before response-shape decisions such as body state. An unknown route returns 404
`NOT_FOUND`; a known path with an unsupported method returns 405 with an `Allow` header
and code `NOT_FOUND`.

## Endpoints

### `GET /healthz`

Public. Returns `{ "status": "ok" }`. No configuration, credentials, or private data.

### `GET /api/v1/me`

Returns the authenticated actor:

```json
{ "speaker": { "id": "...", "display_name": "..." },
  "account": { "id": "..." },
  "scopes": ["message.read", "message.send"],
  "projects": ["proj_..."] }
```

`projects` lists only projects with an active membership and `project.read`.

### `GET /api/v1/projects?cursor=&limit=`

Requires `project.read` plus an active membership. `limit` 1–100, default 50.

```json
{ "projects": [ { "id": "proj_...", "title": "...", "summary": "...",
  "status": "active", "created_at": "..." } ], "next_cursor": null }
```

Ordered by `(created_at, id)` ascending. `next_cursor` is an opaque base64url encoding
of the last `(created_at, id)` pair; pass it as `cursor` and the server applies the
strictly-greater-than predicate. It is `null` when no further page exists.

### `GET /api/v1/projects/:projectId`

Requires `project.read` plus membership. Returns project metadata and the caller's
effective capabilities. A non-member receives `NOT_FOUND`.

```json
{ "project": { "id", "title", "summary", "status", "created_at", "updated_at" },
  "capabilities": ["project.read", "message.read", "message.send", "receipt.write"] }
```

### `POST /api/v1/projects/:projectId/messages`

Requires `message.send` plus active membership. Header `Idempotency-Key` is mandatory
(1–128 non-space printable ASCII characters, 0x21–0x7E). Idempotency is scoped to `(authenticated speaker, project, key)`: the same
key in another speaker or project is independent, and a response is never returned
across those boundaries.

Body:

```json
{
  "summary": "Review the migration plan",
  "type": "request",
  "language": "en",
  "text": "Full body text",
  "body_digest": "sha256:<hex>",
  "reply_to_id": null,
  "client_sent_at": "2026-11-04T12:00:00.000Z",
  "body_expires_at": "2026-11-05T12:00:00.000Z"
}
```

- `summary`: required, ≤140 Unicode grapheme clusters and ≤1024 UTF-8 bytes.
- `type`: required, lowercase identifier `^[a-z][a-z0-9_.-]{0,31}$`; v1 attaches no
  behavior to any type.
- `language`: required, canonical BCP 47 via `Intl.getCanonicalLocales`.
- `text`: required for the first slice, ≤2000 grapheme clusters and ≤8192 UTF-8 bytes.
- `body_digest`: required; SHA-256 of the exact original `text` bytes, encoded
  `sha256:<lowercase hex>`. The server recomputes it over the received bytes and
  rejects a mismatch with `INTEGRITY_MISMATCH` **before** allocating a sequence,
  writing a blob, or committing metadata. The verified digest is encrypted inside the
  payload and verified again after decryption; it is not in the AAD or outer header.
- `reply_to_id`: optional; must exist in the same project (tombstones allowed).
- `client_sent_at`: optional untrusted metadata, stored for diagnostics only.
- `body_expires_at`: optional strict RFC 3339 **UTC** timestamp. Accepted form: four-digit
  year, two-digit month and day, `T`, `HH:MM:SS`, an optional `.` plus 1–3 fractional
  digits, and `Z`; the date must be a real calendar date, hours are 00–23, and
  minutes and seconds are 00–59.
  Offsets (`+hh:mm`), lowercase `z`, hour `24`, leap second `60`, and impossible
  dates (for example Feb 30 or Feb 29 in a non-leap year) are rejected. It must be
  strictly after the server `received_at` and no more than 366 days ahead; otherwise
  `VALIDATION_ERROR` before any write. Stored normalized to UTC milliseconds. `null`
  or omission means no expiry. It participates in the idempotency payload, so the same
  key with a different expiry is `CONFLICT`.
- `speaker_id`, `received_at`, `seq`, `committed_at`, and compression fields are
  server-written; if supplied they are rejected with `VALIDATION_ERROR`.
- Compression is server-selected from `none|gzip`; clients cannot request an algorithm.

Response `201`:

```json
{ "message_id": "msg_...", "project_id": "proj_...", "seq": 42,
  "committed_at": "...", "body_state": "ready", "digest": "sha256:<plaintext hex>" }
```

Repeating the same key with the same payload returns `200` with the same
`message_id`, `seq`, `committed_at`, and `digest`; `body_state` reflects the current
committed state (for example `expired`), not a cached `ready`. A different payload
under the same key, including a different `body_expires_at`, returns `CONFLICT`.

### `GET /api/v1/projects/:projectId/messages`

Requires `message.read` plus membership. Query:

| Param | Meaning |
| --- | --- |
| `after_seq` | return messages with `seq > after_seq` (forward polling) |
| `before_seq` | return messages with `seq < before_seq` (history) |
| `limit` | 1–100, default 50 |
| `type` | exact message type identifier |
| `sender` | exact speaker ID; must be a project member |
| `unread` | `true` or `false`; relative to the **calling** speaker only |
| `q` | case-insensitive substring over `summary` only, ≤100 chars; wildcards escaped; bodies are never searched |

Ascending `seq`. At most one of `after_seq`/`before_seq` may be present. Returns
metadata only; bodies are never included, and listing never marks anything read.
Sequence is assigned atomically at finalization, so pending/provisional messages are
never returned and a cursor never advances past an unpublished lower sequence.

```json
{ "messages": [ { "message_id": "msg_...", "project_id": "proj_...", "seq": 42,
  "sender": { "id": "spk_...", "display_name": "Codex" },
  "summary": "...", "type": "request", "language": "en",
  "reply_to_id": null, "body_state": "ready",
  "body_expires_at": null,
  "client_sent_at": null, "received_at": "...", "committed_at": "..." } ],
  "next_cursor": 42 }
```

`next_cursor` is the greatest returned `seq`; pass it as `after_seq` for the next
forward page. For older history, pass the smallest returned `seq` as `before_seq`.
`next_cursor` is `null` for an empty page. Expired bodies remain as rows with
`body_state: "expired"`.

### `GET /api/v1/projects/:projectId/messages/:messageId`

Requires `message.read` plus membership. Returns exactly one message object in the
same shape as the list endpoint (including `body_expires_at`), plus
`"read_by": [{ "speaker_id", "read_at" }]`. All receipts for that message are visible
to any project member with `message.read`. Metadata only; never marks read. Expired
bodies remain visible here with their retained `seq`, summary, sender, timestamps and
`body_expires_at`.

### `GET /api/v1/projects/:projectId/messages/:messageId/body`

Requires `message.read` plus membership. Authorization precedes state decisions:

1. Not a member → `NOT_FOUND`; member without `message.read` → `FORBIDDEN`.
2. Message never committed (pending/provisional) or unknown → `NOT_FOUND`.
3. Authorized but expired → `BODY_EXPIRED`.
4. Otherwise decrypt and return.

```json
{ "message_id": "msg_...", "text": "...", "compression": "none",
  "digest": "sha256:<hex of plaintext>" }
```

`digest` is the SHA-256 of the plaintext body. `compression` is the server-recorded
`none|gzip` value and is verified on read.

Integrity lifecycle: before decrypting, the server verifies the stored ciphertext
SHA-256 against its recorded ciphertext digest; after decrypting, it verifies the
plaintext digest embedded inside the decrypted payload. Any mismatch returns
`INTEGRITY_FAILURE` with no content, creates no read receipt, and is audited. A failed
body fetch never marks a message read.

### `POST /api/v1/projects/:projectId/messages/:messageId/read`

Requires `message.read` **and** `receipt.write`, plus membership. The target must be a
committed (`ready`) message whose body integrity verifies: expired, pending, corrupt, or
inaccessible messages are not acknowledged and create no receipt (`BODY_EXPIRED`,
`NOT_FOUND`, or `INTEGRITY_FAILURE`). Idempotent; stamps server time. Returns
`{ "message_id", "speaker_id", "read_at" }`. A receipt is a client assertion that the
content was fetched, not proof of understanding or execution.

### `POST /api/v1/projects/:projectId/messages/:messageId/expire`

Requires `project.edit` plus membership. Ordinary member capabilities do not include
`project.edit`; the owner membership does. Authorization and state ordering:

1. Not a member or membership removed → `NOT_FOUND`; member without `project.edit`
   (credential or membership) → `FORBIDDEN`.
2. Unknown, never committed (pending/provisional), or `failed` → `NOT_FOUND`.
3. Already `expired` → idempotent `200`.
4. Otherwise atomically mark `ready → expired` in one conditional UPDATE, then
   best-effort record an audit event (`message.expire`, `success`, actor
   speaker/project, no content), delete the ciphertext, and mark the `body_objects`
   row deleted. The audit row uses a deterministic id derived from the message id and
   `INSERT OR IGNORE`, so it is written once. Because the destructive transition is
   the authority, the endpoint returns `200` even if the audit insert fails; the
   already-expired path retries the insert, and the operator-run worker reconciles any
   still-missing row (with a system actor).

Returns `{ "message_id": "msg_...", "body_state": "expired" }`. Metadata, sequence,
sender, timestamps and receipts are retained; subsequent body fetches return
`BODY_EXPIRED` and no receipt can be created. A concurrent or repeated call never
transitions twice and still returns `200`. If the atomic transition fails internally,
the endpoint returns `UNAVAILABLE` and does not mark the message expired. If the
best-effort blob delete fails, the message is still expired and the operator-run
`expire-bodies` command retries the orphan.

Expiry is enforcement, not a scheduler: no in-process timer exists. Operators run the
cleanup command (see `deployments.md`) for due `body_expires_at` values.

## Validation limits summary

| Field | Limit |
| --- | --- |
| `summary` | 140 graphemes, 1024 UTF-8 bytes |
| `text` | 2000 graphemes, 8192 UTF-8 bytes |
| `type` | 32 ASCII chars, `^[a-z][a-z0-9_.-]{0,31}$` |
| `language` | canonical BCP 47 |
| `body_digest` | `sha256:` + 64 lowercase hex characters |
| `body_expires_at` | strict RFC 3339 UTC `Z`; real calendar date; seconds 00–59; optional 1–3 fraction digits; after `received_at`; ≤366 days ahead |
| `Idempotency-Key` | 1–128 non-space printable ASCII (0x21–0x7E) |
| List `limit` | 1–100 |
| Request body | 64 KiB (first slice; attachments separate and not implemented) |

## Planned, not implemented

HTTP endpoints for project create/edit, membership management, and speaker/credential
management are deferred (the CLI provides bootstrap, project-create, speaker-create,
membership, and credential commands in slice A; project edit is not implemented). Also
deferred: OAuth discovery and grants, MCP `/mcp`, attachments, a separate audited
hard-delete/admin cleanup path (body expiry retains metadata), and the human session
API. Expiry is implemented as the endpoint above plus the operator-run `expire-bodies`
command; there is no scheduler daemon. They will use the same service authorization
layer.

MCP callers do not pass `body_digest` or `idempotency_key`: the trusted MCP adapter
computes the digest from `text` and derives the idempotency key from transport/request
context. The REST API retains mandatory `Idempotency-Key` and independent digest
verification for non-MCP clients.
