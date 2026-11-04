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

## Read-only human web dashboard (slice L)

The dashboard adds an HTML rendering surface, not a new authorization system. It
composes the slice-I session with the existing service authorization and has no
write actions.

- **Stored XSS through titles, summaries, or display names.** Project titles and
  summaries, speaker display names, message summaries, reply references, and read
  receipt names are all untrusted stored strings. Every value is HTML-escaped in
  text and attribute positions before rendering; there is no unescaped
  interpolation. Tests place `<script>`, quotes, and entities in each field and
  assert the escaped form appears and no executable markup does.
- **Stored XSS through message bodies.** Bodies are decrypted only on an explicit
  body request and rendered as escaped text inside `<pre>`. Message content is
  never interpreted as HTML, Markdown, or script, and never appears in the
  timeline.
- **Cross-site scripting policy.** Pages ship no script and no inline style. The
  CSP is `default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  so even an escaping defect has no script execution path, and only the fixed
  same-origin stylesheet can load. `X-Content-Type-Options: nosniff` prevents
  content sniffing.
- **CSRF on sign-in.** `POST /login` is form-encoded and requires a hidden
  `login_csrf` value matching an independent `HttpOnly; Secure; SameSite=Lax`
  cookie, compared as SHA-256 digests in constant time. A cross-site form cannot
  read the cookie and does not send it under `SameSite=Lax`. The route also rejects
  other content types. The only other cookie-authenticated state change remains
  `DELETE /api/v1/session` with its `X-CSRF-Token`.
- **Session fixation.** Sign-in always generates a new random session token and
  ignores any pre-existing session cookie value; the dashboard never accepts a
  session id from input.
- **Open redirect.** `return_to` must be a same-origin path. Absolute and
  scheme-relative URLs, backslashes, control characters, and long values are
  rejected; the emitted `Location` is re-derived from the URL parser, not echoed
  from the request.
- **Clickjacking.** `frame-ancestors 'none'` and `X-Frame-Options: DENY` stop the
  dashboard from being framed.
- **Enumeration and cross-account reads.** The viewer is derived only from active,
  non-removed memberships of speakers owned by the session account. A project
  without a qualifying membership is a uniform `404`, whether it is missing,
  foreign, removed, inactive, or capability-insufficient; body and receipt routes
  use the same rule. The session never authenticates a REST data route or `/mcp`.
- **Body reveal and integrity.** The body route calls the existing verified decrypt
  path, re-authorizes after decryption, and returns a generic error page on
  failure. It never returns ciphertext, partial plaintext, or an integrity error
  detail.
- **Caching and proxies.** Every HTML response is `Cache-Control: no-store` with
  `Referrer-Policy: no-referrer`. A shared proxy must not cache authenticated
  pages; the reverse proxy is still responsible for TLS and any per-IP control.
- **Logging.** Dashboard pages do not log bodies, summaries, tokens, cookies, CSRF
  values, email addresses, or full IPs. The request logger sees only the path,
  status, duration, and other metadata; dynamic project/message identifiers are not
  written into metrics labels.

## OAuth 2.1 delegated speaker grants (slice J)

OAuth issues a speaker-scoped bearer credential for one project; it is not a second
authorization system.

- **Redirect mismatch / open redirect.** The authorization endpoint accepts only an
  exact string match against a dynamically registered redirect URI. Unvalidated or
  mismatched URIs get an HTML `400` and are never used for an error redirect. Redirect
  URIs must be absolute HTTPS with no fragment or userinfo; plain HTTP is allowed only
  for `127.0.0.1`/`localhost` local clients.
- **Code interception.** PKCE S256 is mandatory. The stored `code_verifier_hash` is a
  keyed HMAC over the authorization code plus the S256 verifier output, compared at
  fixed length; an intercepted code is useless without the verifier, and a verifier
  without the code is useless. Codes are random 256-bit, expire in 5 minutes, and are
  consumed by one conditional `UPDATE`; replays are `invalid_grant`.
- **Consent CSRF.** `POST /oauth/consent` requires the account session cookie and the
  existing `X-CSRF-Token` header. The HTML form submits it through a constant
  same-origin script. Project, speaker, and scope authorization are re-read from
  storage; the form is never trusted.
- **Login CSRF / fixation.** The sign-in form uses a 256-bit double-submit value in
  an `HttpOnly; Secure; SameSite=Lax; Path=/oauth` cookie and a hidden field.
  Cross-site posts cannot read the value and do not send a Lax cookie on POST.
  Sign-in always creates a fresh server-generated session; client-supplied session
  ids are impossible.
- **Scope escalation.** Only `message.read` and `message.send` are accepted. The
  authorization endpoint rejects all other scopes, the consent page offers only those
  two, consent re-checks membership capabilities, and the token endpoint never broadens
  on refresh. OAuth cannot add a grant, membership, project, or administrative right.
- **Mix-up / wrong audience.** The `resource` must equal the configured public base
  URL, is stored with the code, and is re-checked at exchange. A code is bound to its
  client; an exchange with another client is `invalid_grant`.
- **Token replay and rotation.** Access tokens live 1 hour and are ordinary
  `credentials` rows. Refresh rotates the refresh token and the access credential's
  prefix/verifier/expiry, so the old access token fails on the next request. Reuse of
  a rotated or revoked refresh token revokes the whole family and credential.
- **Revocation.** RFC 7009 returns `200` for well-formed, non-abusive requests; above
  the process-local global revoke bucket it returns `429`. Unknown tokens and wrong
  client IDs are silent no-ops. Revoking a refresh family or an access token takes
  effect on the next REST/MCP request; there is no authorization cache.
- **Secrets and logging.** Codes, refresh/access tokens, cookies, CSRF values, client
  names, and scopes are not logged. The database stores prefix + keyed HMAC verifiers
  only. Known limit: concurrent refresh with the same token races and can revoke a
  family; clients must serialize refresh.
- **HTML/XSS.** Every value interpolated into the two pages is HTML-escaped; there is
  no inline script and no third-party resource. CSP is `default-src 'none';
  script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none';
  frame-ancestors 'none'`.

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
