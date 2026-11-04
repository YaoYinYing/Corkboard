# Threat model

Status: design baseline. Every invariant below must eventually map to an executable
test. Tests are named in `tests/security/` as they land.

## Assets

Message plaintext; root keys and credential verifiers; project membership; replay
history; audit records; administrative privilege; availability; metadata privacy.

## Adversaries

- Unauthenticated internet clients.
- One compromised or revoked speaker key.
- A malicious or prompt-injected agent posting messages.
- A revoked collaborator retaining old tokens.
- A malicious upload (compressed bomb, active HTML, traversal path).
- A compromised storage bucket or backup.
- The server operator/host (explicitly trusted with plaintext).

## Trust assumptions and limits

- The server holds decryption keys and can read plaintext. **This is not E2EE.**
- Speaker identity is credential identity. A parent and subagent that share a bearer
  secret are indistinguishable; OS-level isolation or external signing is required for
  a hard attribution boundary.
- Client timestamps are untrusted metadata. Only server `received_at`/`committed_at`
  are authoritative.
- TLS, secret-manager storage, and host hardening are deployment responsibilities
  documented in `security-operations.md`.
- IP headers are trusted only behind a verified proxy; IP is never returned in message
  APIs.

## Security invariants (executable gates)

1. Unauthenticated requests never observe project/message metadata or body, except
   intentionally public, non-sensitive service metadata.
2. Every data query and blob read enforces project access; `WHERE id = ?` alone is
   never sufficient.
3. Sender, reader and server timestamps are derived from the authenticated identity and
   server clock. Client-submitted sender/timestamp overrides are rejected or ignored.
4. Unknown, revoked, expired, or scope-insufficient credentials cannot read or write.
   Credential management is audited.
5. A ciphertext blob alone cannot reveal the body without the key; modified ciphertext
   or AAD fails closed.
6. Repeated idempotency keys cannot create duplicate committed messages; a different
   payload under the same key is a conflict.
7. Concurrent posts receive unique per-project sequences at atomic finalization; no
   provisional row is published with a sequence, and replay returns committed records
   in cursor order without skipping a published lower sequence.
8. An expired/tombstoned body cannot be fetched, but retained metadata is visible only
   to authorized project members. A receipt requires both `message.read` and
   `receipt.write` and cannot acknowledge a pending, expired, corrupt, or inaccessible
   body.
9. Uploaded bytes are bounded, validated, and never executed. No attachment-to-command
   path exists.
10. No endpoint authorizes code execution; message text cannot change platform
    authorization.
11. Message integrity is end-to-end verified: the sender-supplied SHA-256 must match
    the received original bytes before any write, sequence allocation, or idempotency
    record (`INTEGRITY_MISMATCH` otherwise); the
    plaintext digest is encrypted inside the payload and verified after decryption (the
    AAD binds only pre-decryption metadata); a separate ciphertext
    SHA-256 is verified before decryption. Stored-content mismatch fails closed
    (`INTEGRITY_FAILURE`) with no content and no read receipt.

## Human account sessions (slice I)

A session authenticates an account to three routes only. It is **not** a speaker
credential and grants no project, message, MCP, or administrative authority.

- **Session fixation.** The server always generates a new 256-bit session token at
  sign-in and the client cannot supply a session id. A pre-existing cookie value is
  ignored and replaced. Tokens are not accepted in query parameters or response bodies.
- **CSRF.** The session cookie is `SameSite=Strict`, which blocks cross-site form and
  fetch attachment in modern browsers, and every state-changing session request
  (`DELETE /api/v1/session`) additionally requires `X-CSRF-Token` matching an
  independent random value delivered in the `corkboard_csrf` cookie. The header is
  compared as a keyed HMAC digest at fixed length; a cross-origin client that cannot
  read the CSRF cookie cannot construct the header. Login (the only unauthenticated
  state-changing route) requires `Content-Type: application/json`, which a simple
  cross-site form or `text/plain` post cannot send; no CORS is enabled, so an
  `application/json` cross-origin request cannot skip a preflight. There are no other
  cookie-authenticated state-changing routes. A missing/wrong session is `401` before
  the CSRF check, so the two failures are distinguishable (`401` vs `403`) but neither
  reveals account data.
- **Enumeration and timing.** Unknown email, wrong password, inactive account, and an
  account without a password hash all return the same `401 UNAUTHENTICATED`. When there
  is no stored hash the password is verified against a dummy PBKDF2 hash, so the KDF
  work is comparable. A per-email login bucket (keyed by a digest, not the address) is
  checked before account lookup, so rate-limit behavior does not depend on existence.
  Absolute timing equality is not claimed: PBKDF2 work is similar but not bit-for-bit
  identical across the legacy `scrypt$` Node path, and DB lookup time varies.
- **Cookie theft.** The session cookie is `HttpOnly`, so page script cannot read it;
  `Secure` prevents transmission over plaintext HTTP; the `__Host-` name prefix forbids
  `Domain` scope and requires `Path=/`. The CSRF cookie is intentionally readable by
  same-origin script. Neither raw value is written to the database, response bodies,
  non-`Set-Cookie` headers, logs, or audit rows; only keyed verifiers are stored. The
  login response necessarily carries both raw values in `Set-Cookie` headers, which is
  how the browser receives them. TLS termination is a deployment requirement.
- **Revocation and expiry limits.** Sign-out revokes only the presented row, so other
  devices stay signed in (the operator can revoke all rows directly). Sessions have a
  30-minute idle timeout and a 12-hour absolute lifetime, and an inactive account is
  rejected on every request. A stolen token is usable until expiry/revocation; there is
  no per-request re-authentication factor or device binding. Expired/revoked rows are
  not automatically purged, but an expired row cannot authenticate.
- **Password storage.** PBKDF2-HMAC-SHA-256 with 600,000 iterations, a 16-byte random
  salt, and a 32-byte output. The iteration count is stored with the hash so it can be
  raised later. Legacy `scrypt$` hashes are accepted only by the Node adapter and are
  never written; an unknown format fails closed. Password input is capped at 1024 UTF-8
  bytes to bound KDF work.
- **Logging.** Request logs contain method, path, status, duration, and actor IDs only.
  They never include `Cookie`, `Authorization`, `X-CSRF-Token`, passwords, session
  tokens, CSRF values, or email addresses.
- **Login abuse.** The per-email limiter is process-local: separate processes and
  Workers isolates enforce their own buckets, and a restart clears them. Per-IP and
  volumetric controls remain the reverse proxy's responsibility.

## Attack cases to cover

Cross-project `message_id` guessing; sender spoofing in HTTP/MCP parameters; forged
`CF-Connecting-IP`; key leakage via logs; stale OAuth tokens; JWT claims used as
authorization; prompt injection asking for shell execution; SQL injection; XSS; SSRF;
path traversal; gzip bombs; multipart overflow; duplicate retry races; blob write
succeeded while DB failed; DB committed while blob is absent; unauthorized receipt
writes; membership removed during body fetch; concurrent `seq` allocation; cross-tenant
replay filters; key rotation/restore; active HTML attachments; OAuth redirect/PKCE and
refresh replay; CSRF/session fixation; CDN credential downgrade; sender digest
forgery or omission; bit-flipped ciphertext; AAD/digest substitution across
project/message/object; truncated or swapped blob.

## First-slice coverage intent

The first vertical slice must prove, at minimum: cross-project isolation; credential
authentication and revocation; sender derivation; idempotent retries; concurrent
sequence allocation; ordered replay including tombstones; receipt authorization;
ciphertext tamper failure; sender-digest mismatch rejection before commit; and
expired-body behavior.
