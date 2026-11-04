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
