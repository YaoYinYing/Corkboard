# Attachments: API and threat-model proposal

Status: **analysis only, decision-gated.** This document was written under the
non-mutating scope of Issue #22. It does not implement transport, add runtime
components, or add tests, and it does not select a candidate on the maintainer's
behalf. Issue #5 is the authority gate for binding/AAD/lifecycle; Issue #21 is the
destructive-GC prerequisite. Candidate A is presented as a **recommendation**, not a
decision. No attachment route, table, or crypto branch exists at this tree.

Scope: one project-scoped binary attachment capability carried beside message text.
Non-goals match Issue #22: no public unauthenticated sharing, no third-party links as
authority, no HTML/SVG rendering, no execution of received files, no root-key rotation.

## 1. Verified current state

| Fact | Evidence |
| --- | --- |
| AES-256-GCM, fresh 96-bit nonce, AAD is canonical sorted-key JSON over `compression, format_version, message_id, object_id, project_id, service_id`; `format_version` is `v1`. | `src/crypto/envelope.ts` (`buildAad`, `parseHeader`) |
| The plaintext SHA-256 is sealed in the `CBPT1` frame inside the ciphertext; a separate ciphertext SHA-256 is verified before decryption; failures throw `IntegrityError`. | `src/crypto/envelope.ts` (`sealBody`, `openBody`, `parseFrame`) |
| AAD compression is `none|gzip`; gunzip is bounded by the declared plaintext length plus frame overhead. | `src/crypto/envelope.ts` (`gunzipBounded`) |
| `BlobStore` is `put/get/delete` over opaque keys; local keys are 16-128 `[A-Za-z0-9_-]`; local files are `0600` in a `0700` directory, written atomically. | `src/storage/blobs.ts`, `src/storage/blobs/local.ts` |
| `body_objects` stores project id, storage key, algorithm, key version, nonce, compression, lengths, ciphertext digest, and state. Every application object query is project-scoped (operator GC, backup and doctor scans are global). | `migrations/001_init.sql`, `src/service/messages.ts` |
| The HTTP request cap is 64 KiB; there is no upload, multipart, HTTP request decompression, or attachment surface. | `src/app/handlers.ts` (`MAX_REQUEST_BODY_BYTES`), `docs/api.md` |
| Backup bounds every blob at 16 KiB (`MAX_TEXT_BYTES * 2`), total blobs at 1 GiB, manifest at 8 MiB/100,000 entries, and cross-checks `body_objects.storage_key`. | `src/service/backup.ts`, `docs/architecture.md` |
| Orphan GC is operator-run (dry-run by default; `--apply` deletes), grace-only, and makes a row-less file older than the 24 h default grace eligible for deletion; the grace is explicitly a timing margin, not a correctness proof. | `src/service/blob-gc.ts`, Issue #21 |
| Authorization is credential scope intersect membership capabilities plus an explicit credential-project grant, re-evaluated before durable effects; no cache. | `docs/api.md`, `docs/authorization.md`, `src/domain/authz.ts` |

Two consequences follow. First, an attachment uploaded before its message exists cannot
put `message_id` in its AAD without deferring encryption or re-encrypting later. Second,
any new blob lifecycle must respect the unresolved `put`-before-row GC race (#21).

## 2. Candidate comparison and recommendation

| Dimension | A: two-phase pending upload | B: single-step bounded multipart |
| --- | --- | --- |
| Transport | `POST /api/v1/projects/:id/attachments` (one bounded opaque file per request), then `POST /api/v1/projects/:id/messages` with `attachment_ids` | One multipart `POST /api/v1/projects/:id/messages` carrying text plus 1-N file parts |
| When the message id is known | After upload; not in pre-association AAD | Before encryption, so `message_id` can be in AAD |
| New durable state | Pending attachment row, lease/expiry, upload idempotency | No pending state; partial request cleanup only |
| Send-path change | Add `attachment_ids` validation/claim to the existing send path | Replace/extend send parsing with a multipart parser and per-part streaming |
| Retry and crash recovery | Upload retries are per file and idempotent; association joins the message idempotency record | A retry re-sends the whole multipart body; a crash mid-parse has partial-blob cleanup and all-or-nothing association |
| Attack surface | Existing JSON plus one bounded binary sink; no multipart parser | Multipart boundary/header/part-count/size parsing before or while authorizing |
| MCP / tool callers | Natural: tools accept attachment IDs, never bytes | Still needs a separate HTTP upload path, because a model tool argument must not carry 10 MiB of Base64 |
| AAD | New attachment-purpose AAD without `message_id`; association is DB state | Can include `message_id` directly |
| Cleanup | Abandoned leases require safe expiry and #21-hardened deletion | No abandoned-upload lease, but partial/crashed request blobs still need GC |
| D1 portability | Needs a conditional claim plus message publish; the D1 batch cannot branch on affected rows | Same multi-row atomicity concern inside one larger request |
| Operational cost | Lease tuning, doctor reporting, cleanup runbook, two round trips | Larger proxy/body caps, parser limits, more expensive retries |
| Failure isolation | A bad file is rejected before any message exists | A bad part fails the whole send after bytes have been streamed |

**Recommendation (non-binding): Candidate A.** It gives a bounded, dedicated binary
transport, keeps the existing send path's JSON/idempotency shape, avoids adding a
multipart parser to the trust boundary, isolates per-file failures, and matches the
Issue #22 rule that API/MCP sends reference authorized attachments by ID. B still needs
a separate upload surface for MCP/tool callers, so it does not actually avoid A's
endpoint in the product. A's costs are real: pending state, lease expiry, cleanup, and
the #21 dependency. If the maintainer requires `message_id` inside the attachment AAD,
A must either defer encryption until association (buffering or decrypt/re-encrypt, a
material cost) or B becomes the cleaner fit.

Candidate C (defer, keep text-only) adds no code and remains a valid maintainer choice;
it is not otherwise analyzed here because the requested comparison is A versus B.

## 3. Limits, content policy, and streaming

All values below are proposed defaults for the first slice; the maintainer selects the
final numbers in #5.

| Control | Proposed bound | Rationale |
| --- | --- | --- |
| Per attachment | 10 MiB plaintext | `TODO.md` item 82 |
| Files per message | 4 | Bounded count; no aggregate surprise |
| Aggregate per message | 40 MiB | 4 x 10 MiB |
| Upload request body | 10 MiB + 64 KiB overhead | Fixed request overhead and margin; sealing happens server-side |
| Files per upload request (A) | 1 | Keeps the binary sink and idempotency unambiguous |
| Download range requests | None in first slice | Decrypt must verify the whole blob first; 10 MiB is bounded |
| HTTP request `Content-Encoding` | Reject anything but identity | No request decompression path |
| Archive extraction | None | ZIP/PDB are opaque bytes, never expanded or executed |

**Type detection and MIME.** The server detects the type from leading bytes and stores
only its own detection; the client `Content-Type`, extension, and filename are hints,
never authority. A declared type that disagrees with detection is rejected
(`VALIDATION_ERROR`). Extensions are not used to decide safety. Proposed first class:
PNG and JPEG raster images only (fixed magic; WebP after a RIFF length/structure check,
and PDF/CSV/PDB/ZIP as separate later proposals). CSV/text has no magic, so it cannot be
proven by sniffing and should wait for a text-specific proposal. Empty files are
rejected; the 10 MiB cap is enforced while streaming, not from `Content-Length` alone.

**Filename.** Sanitize to a basename, strip path separators, control characters, CR/LF,
quotes, and leading dots; cap the length; use the sanitized value only in
`Content-Disposition`. It is never a storage key or path. Store the server-detected MIME
and the sanitized name as metadata.

**Streaming and memory.** Uploading is streamed into the sealing path under the per-file
cap, but `BlobStore.put` takes a `Uint8Array` and WebCrypto AES-GCM needs the whole
buffer, so one upload costs roughly 30–40 MiB of peak transient memory (plaintext,
frame, ciphertext and the assembled envelope); measure before fixing the concurrency
bound. Bound concurrent uploads per process and at the proxy. The current proxy
cap (1 MiB) and app cap (64 KiB) must be raised for this route only; that is an
operations change, not part of this proposal.

**Compression and decompression.** Use `compression: none` for attachments in the first
slice. The listed formats are already compressed, and the envelope's `gzip` path exists
for text-like payloads. On read, the existing bounded gunzip (declared plaintext length
plus frame overhead) fails closed on expansion. HTTP request decompression remains
unsupported; ZIP expansion is never performed, so archive bombs are not reachable in the
first slice.

**Image sanitization and previews.** Previews stay off: no decode, thumbnail, transcode,
inline `<img>`, SVG rendering, or document preview in the first slice. Raster files are
stored as original opaque bytes inside the envelope and served only as downloads. That
means the original's embedded metadata (for example EXIF/GPS) reaches authorized
downloaders unchanged; if stripping is required, it needs a separate sanitization
proposal (bounded decoder with dimension/pixel limits, re-encode to a canonical format,
strip metadata, serve the sanitized copy from a sandboxed origin). SVG, HTML, XHTML, XML,
JavaScript, and CSS are never on the allowlist, and an allowlisted magic prefix must
never be treated as permission to serve content inline.

## 4. Encryption purpose and AAD versioning

The existing `v1` AAD must remain byte-for-byte unchanged so every stored text-only
message stays decryptable. Add a separate attachment purpose rather than broadening
`v1`:

- **Envelope header:** `v: 2` with the same `CB01` outer frame, `CBPT1` plaintext frame,
  AES-256-GCM, fresh 96-bit nonce, ciphertext digest verified before decryption, and the
  plaintext SHA-256 sealed inside the payload. `key_version` is unchanged; key rotation
  remains #13.
- **Attachment AAD:** canonical sorted-key JSON
  `{ attachment_id, compression, format_version: "v2", object_id, project_id, purpose: "attachment", service_id }`.
  `message_id` is deliberately absent because it does not exist at upload.
- **Cross-purpose safety:** the text opener accepts only `v: 1`; the attachment opener
  accepts only `v: 2`. Presenting a `v2` attachment to the text path, a `v1` text body to
  the attachment path, or changing `purpose`, `project_id`, `object_id`,
  `attachment_id`, `service_id`, `format_version`, or `compression` in the AAD fails
  closed (`EnvelopeFormatError`/`INTEGRITY_FAILURE`, no content).
- **Association is database state, not ciphertext.** AAD is immutable after upload. The
  attachment row records `message_id` at claim time; every API path checks project,
  message, state, and authorization in SQL. A database/operator attacker who rewrites
  that association is outside the application threat boundary, as with other stored
  metadata; cross-project or forged-ID API attempts are denied.
- **Explicit exception.** `AGENTS.md` says AAD binds service/project/message/object/
  format/compression. The attachment AAD necessarily omits `message_id`. Issue #5 must
  record that this exception is approved. If it is not, A must seal at association time
  instead of upload time, or B must be chosen.

## 5. Lifecycle, tenancy, idempotency, and revocation (A path)

This section describes the proposed contract; no endpoint or state machine is
implemented here.

**States:** `uploading` (row reserved, bytes not yet complete), `pending` (complete,
leased, unattached), `attached` (claimed by one committed message), `abandoned`
(lease expired), `expired`/`deleted` (content reclaimed). Pending/uploading rows are
invisible to message list/get.

**Upload ordering.** Authenticate and authorize first; reserve an opaque
`attachment_id`/`object_id` and storage key in an `uploading` row **before** writing the
blob, so GC's referenced-key set already contains the key; stream and seal under the
size cap; `BlobStore.put`; then finalize `uploading -> pending` with one conditional
UPDATE that requires the row still be `uploading`, same speaker, same project, and
`lease_expires_at > now`. Zero rows means the lease was lost; delete the just-written
blob best-effort and fail without publishing. A crash after the row and before the blob
leaves a referenced-but-missing row that download fails closed on and cleanup reclaims.

**Lease and abandoned cleanup.** Proposed lease: 1 hour after row creation. A resumed
upload after lease expiry cannot finalize (the conditional UPDATE fails), so cleanup
cannot race a live writer into publishing. Cleanup eligibility begins only after lease
expiry plus a clock-skew/safety margin; it is operator-run, bounded, idempotent, and
audited, and it deletes the row and content only through the #21-hardened path. `doctor`
reports stuck `uploading`/`pending` rows and lease age, never content.

**#21 dependency.** The current GC proves nothing about a writer paused past the grace
window; grace alone is not a correctness proof. No destructive cleanup of pending
uploads, and no destructive GC run concurrent with accepting writes, is authorized
until Issue #21 records a fencing/lease handshake or an offline-only destructive design
that covers attachment writers as well as message sends.

**Association.** `POST /messages` accepts bounded `attachment_ids`. Validate at request
start and re-validate at publication: each ID exists in the same project, was uploaded
by the authenticating speaker (proposed; #5 decides), is `pending`, has an unexpired
lease, is not duplicated in the request, and keeps the file-count and aggregate caps.
Claim each row to `attached` with the new `message_id`, and publish the message in the
same transaction. Any failure leaves neither the message published nor a partial claim.
The D1 batch adapter cannot branch on an in-transaction affected-row count, so the
atomic-claim strategy is a #5 implementation decision; SQLite can roll back, D1 needs a
write-only batch or a pre-claim plus idempotent recovery.

**Idempotency.** Upload requires an `Idempotency-Key` scoped to
`(speaker, project, key)` in a dedicated record, independent of message idempotency.
Same key and same plaintext digest/size returns the same attachment; same key with
different bytes is `CONFLICT`; a key whose row is abandoned stays a conflict until
cleanup, after which reuse is a new upload. Message association includes the ordered
attachment IDs and their verified digests in the message idempotency payload digest, so
the same message key with a different attachment set is `CONFLICT`.

**Tenant/project binding.** The project is the tenant boundary; there is no separate
tenant table. Every attachment row and query carries `project_id`; upload, association,
list, and download all require it, and no lookup authorizes on `WHERE id = ?` alone. The
AAD also binds `service_id` and `project_id`. Opaque IDs and storage keys are locators,
never capabilities.

**Revocation and expiry.** Credential revocation, membership removal, project disable,
and grant removal are re-read on every request; there is no cache, so a revoked caller
cannot finish an upload, associate, list, or download. On message body expiry, its
attachments become non-downloadable and their ciphertext is reclaimed with the same
two-stage, retryable transition as the body; retained metadata is limited to what the
message tombstone already exposes. Per-attachment revocation is not part of the first
slice.

**No deduplication.** Content hashes detect corruption only; do not deduplicate across
messages or tenants, because that can leak equality.

## 6. Authorization at every phase

| Phase | Required authority | Failure behavior |
| --- | --- | --- |
| Upload and upload finalize | Active credential + active membership + explicit credential-project grant + `message.send` (proposed reuse; a new scope is a #5 decision) | `UNAUTHENTICATED` / `NOT_FOUND` / `FORBIDDEN` exactly as existing paths |
| Association/claim | Same as send, re-checked inside publication; attachment same project and (proposed) same uploader speaker | One uniform `NOT_FOUND` for a foreign/unknown/expired/claimed attachment; the message is not published |
| List | `message.read` plus membership/grant; only attachments of committed messages in that project | Pending/uploading/foreign IDs never appear; uniform `NOT_FOUND` |
| Download | `message.read` plus membership/grant, re-authorized after integrity verification and before bytes are returned; message ready and attachment attached to it | `NOT_FOUND` for foreign/unknown/forged; `BODY_EXPIRED` for expired; `INTEGRITY_FAILURE` for tamper, with no content |
| Cleanup | Operator only, never a bearer principal | No API exposure |

Possession of an attachment ID, object ID, or storage key never authorizes anything. The
download route is nested (`/api/v1/projects/:projectId/messages/:messageId/attachments/:attachmentId`)
so the server can scope the SQL by all three. Foreign, removed, unknown, and
wrong-project objects return the same shape the other routes use, so existence is not
disclosed.

## 7. Download serving policy

Serve every attachment as `Content-Type: application/octet-stream` with
`Content-Disposition: attachment; filename="<sanitized>"; filename*=UTF-8''<encoded>`,
`X-Content-Type-Options: nosniff`, `Cache-Control: no-store`,
`Content-Security-Policy: sandbox; default-src 'none'; frame-ancestors 'none'`,
`X-Frame-Options: DENY`, and `Referrer-Policy: no-referrer`. Never use `inline`, never
serve `text/html`, `application/xhtml+xml`, or `image/svg+xml`, never redirect to a
storage URL, never reveal a storage key, and do not support byte ranges in the first
slice. Even an allowlisted raster type is a download, not a render.

## 8. Backup, restore, and GC expectations

SQLite and blobs remain a pair. Attachments extend the pair, not the model:

- Pending and attached attachments are included in a backup. `verify` must cross-check
  `attachment_objects.storage_key` the way it already checks `body_objects`; a
  referenced-but-missing attachment blob is a backup failure.
- `MAX_BACKUP_BLOB_BYTES` (16 KiB) must be raised above the new per-attachment cap
  before attachments ship; the 1 GiB total, 8 MiB manifest, and 100,000-entry bounds must
  be revisited together.
- An `uploading` row can transiently reference a blob that has not been written yet.
  Either require upload quiescence for a backup, or add a narrowly scoped, documented
  exemption for `uploading` rows; do not silently weaken the referenced-blob check.
- Restore verifies digests and schema, keeps encrypted bytes only, and never needs key
  material. Leases are clock-based, so after restore an expired pending row is
  abandoned under the normal rule; restore itself deletes nothing.
- Orphan GC must see attachment storage keys in its referenced set, and destructive
  attachment cleanup must use the #21-hardened mechanism.

## 9. Adversarial cases and non-mutating contract vectors

These are documented specifications for tests to be written after #5. They do not add a
route or execute anything.

| # | Vector | Expected result |
| --- | --- | --- |
| 1 | Upload in project P1, then send in P2 with that `attachment_id` | Uniform `NOT_FOUND`; no message, no claim |
| 2 | Forged/random attachment or object ID | `NOT_FOUND`; no existence leak |
| 3 | Attachment ID belonging to another speaker or project | `NOT_FOUND`; no claim and no metadata echo (under the proposed same-uploader rule) |
| 4 | Decrypt attachment with text AAD, wrong project, wrong object, or wrong attachment id | `INTEGRITY_FAILURE`/format error; no plaintext |
| 5 | Open `v2` as text or `v1` as attachment; change `purpose`/`format_version` | Fail closed before decryption |
| 6 | Truncated ciphertext, missing GCM tag, or cut upload stream | Upload never becomes `pending`; `INTEGRITY_FAILURE`/request error; no message |
| 7 | Declared or chunked upload above 10 MiB; more than 4 files; aggregate above 40 MiB | `REQUEST_TOO_LARGE`/`VALIDATION_ERROR`; no partial state |
| 8 | PNG/JPEG declared or named `.png` but HTML/SVG bytes | `VALIDATION_ERROR`; nothing stored |
| 9 | Declared `image/svg+xml`, `text/html`, or an XML/script polyglot | Rejected; never allowlisted; downloads are `octet-stream` + `nosniff` |
| 10 | Filename `../x`, `a/b`, CR/LF, quotes, or overlong name | Sanitized metadata only; no path traversal, no header injection |
| 11 | Credential revoked before upload/association/download; membership removed; project disabled | `UNAUTHENTICATED`/`FORBIDDEN`/`NOT_FOUND` per existing order; no write, no content |
| 12 | Abandoned upload never associated | Remains invisible; after lease + margin, operator cleanup removes row and blob idempotently; `doctor` reports it |
| 13 | Association retry with same message key and same payload | One message, one claim, same response |
| 14 | Association retry with same message key and different attachment set | `CONFLICT`; no second message |
| 15 | Same attachment ID listed twice, or claimed by a second message | Validation error or uniform `NOT_FOUND`; exactly one owner |
| 16 | Download after the message body expired | `BODY_EXPIRED`; no bytes, no receipt |
| 17 | Bit-flipped ciphertext, swapped ciphertext between objects, missing blob | `INTEGRITY_FAILURE`; no bytes, no partial render |
| 18 | DB committed but blob absent after a crash | `INTEGRITY_FAILURE`; no ready-looking success |
| 19 | HTTP `Content-Encoding: gzip`; envelope gzip expansion past the declared bound; nested ZIP | Rejected/bounded; no extraction, no decompression of the request |
| 20 | Revocation between blob write and finalize/association | Finalize/claim conditions fail closed; no publication; blob reclaimable |
| 21 | Backup/restore with pending and attached attachments | Digest/verify passes for the pair; leases expire normally; no keys in backup |
| 22 | Cross-project list/read attempt | Project-scoped query returns nothing; no attachment metadata from another project |
| 23 | MCP tool call with Base64/bytes in an argument | Strict schema rejects it; tools reference IDs only |

## 10. Blocked on Issue #5: decisions the maintainer must make

No attachment code may be merged until these are recorded. This document does not
decide them.

1. **Candidate A, B, or C.** A is recommended above; C (defer) is still valid.
2. **AAD contract.** Approve a new `v2` attachment purpose with the fields in section 4,
   including the deliberate omission of `message_id`. If `message_id` must be bound,
   either A seals only at association time (with the re-encryption/buffering cost) or B
   is required. Also decide whether a distinct envelope magic is preferred over the
   shared `CB01` frame with `v: 2`.
3. **Association authority.** Reuse `message.send`/`message.read`, or add attachment
   scopes. Decide whether only the uploading speaker may attach, or any member with
   `message.send`.
4. **Lifecycle.** Approve the pending table/states, lease duration, safety margin,
   idempotency scoping, and whether cleanup is operator-run only or scheduled.
5. **Limits and first file class.** Confirm 10 MiB, 4 files, 40 MiB aggregate, the
   allowlist (proposed PNG/JPEG only), and whether PDF/CSV/PDB/WebP/ZIP are later
   proposals.
6. **Expiry semantics.** Confirm that message body expiry denies and reclaims its
   attachments, and what attachment metadata survives the tombstone.
7. **Compression.** Confirm `none` for attachments in the first slice, or the exact
   conditions for server-selected gzip.
8. **Serving.** Confirm download-only `application/octet-stream` with no inline previews
   and no ranges.
9. **Association atomicity on D1.** Choose the write-only batch or pre-claim/recovery
   design, because the D1 adapter cannot branch on affected-row counts.
10. **#21 prerequisite.** Record the safety invariant that permits destructive cleanup
    of abandoned uploads and any GC concurrent with writers. Until then, no destructive
    cleanup is authorized.
11. **Backup bounds.** Approve raising the per-blob cap and the handling of transient
    `uploading` rows in `verify`.
12. **MCP surface.** Confirm that MCP/tool arguments carry attachment IDs only and
    whether upload is HTTP-only or also exposed as a tool.

**What changes between A and B:** A adds a pending attachment table, an upload endpoint,
leases, and abandonment cleanup; its AAD omits `message_id`; association must be atomic
with message publication; and #21 gates destructive cleanup. B removes pending state and
the lease, embeds attachment fields in the single send request, can bind `message_id` in
AAD, requires a bounded multipart parser and much larger send-request caps, makes
retries re-send all bytes, still needs a separate upload path for MCP/tool callers, and
still needs safe cleanup for crashed partial requests.

## 11. Gaps not verified here

- No live D1, R2, Workers, or wrangler execution exists; D1 atomic-claim behavior is
  reasoned from the documented batch adapter limits, not tested.
- `BlobStore` has no streaming or listing API (`put` takes a full `Uint8Array`), so the
  10 MiB memory bound and concurrent-upload cap are design assumptions.
- There is no image decoder, sanitizer, or multipart parser in the repository; their
  behavior and resource limits are not measured.
- There is no per-project storage quota; the existing rate limit is request-rate denial,
  not a storage bound.
- Issue #21 is open and its final invariant is unknown, so attachment cleanup cannot be
  claimed safe yet.
- The exact `verify` treatment of extra/orphan entries and whether the manifest's
  per-blob cap can be raised without other format changes were not re-read for this
  proposal beyond `src/service/backup.ts` and `docs/architecture.md`.
