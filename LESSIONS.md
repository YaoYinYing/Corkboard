# LESSIONS.md

Campaign learnings. Spelling is intentional per the original request. Keep entries
actionable and prune stale ones.

## 2026-11-05 — Revocation is not rotation, and a credential ID is not speaker-wide authority

- **Failure avoided:** A dashboard credential list invites three mistakes: gating it
  on `project.edit`/membership (a delegated capability would become credential
  administration), accepting any credential ID the signed-in account owns (so a
  credential of another speaker could be revoked through the wrong path), and
  describing revoke-then-issue as "rotation". All three misstate the authority or the
  operation.
- **Decision:** Inventory and revocation require `speakers.owner_account_id` = the
  session account (active account), with a uniform `404` for foreign/unknown
  speakers and for credential IDs not belonging to the path speaker. The listing
  selects only ID, timestamps, revoked state, and grant rows; the token, prefix, and
  verifier are never selected or rendered. Revocation is a soft `revoked_at`
  assignment that retains the row and grants, is idempotent, and audits one
  `credential.revoke` row only for the transition that actually happened.
  Revoke-then-issue through the existing issuance flow is the documented replacement
  path; **no atomic rotation is claimed**.
- **Reproducer / test:** `tests/integration/speakers-web.test.ts` covers a non-owner
  and a same-account different-speaker credential ID (both uniform `404`, no state
  change), CSRF failure, bearer-principal rejection at the service boundary,
  idempotent repeat with one audit row, revoked-session redirects, and an
  adapter-level POST proving the Node body gate includes the new route. Removing the
  `speaker_id = ?` predicate or the owner predicate makes these fail.
- **Prevents:** Privilege escalation through delegated project capabilities,
  cross-speaker revocation by ID guessing, rendering a one-time secret in an
  inventory, duplicate audit rows for no-ops, and buying a rotation guarantee the
  system does not have.
- **Remove when:** Credential administration gets a reviewed delegated role, or an
  atomic rotate/overlap operation with its own audited contract is implemented.

## 2026-11-05 — A once-only secret belongs in the POST response, not in redirect state

- **Failure avoided:** The obvious redirect-after-POST pattern has nowhere to put a
  credential that must never be in a URL, cookie, hidden field, session store, or
  database column. Storing it in any of those would turn a one-time display into a
  durable or replayable secret; putting it in the `Location` query would leak it to
  history, proxies, and logs.
- **Decision:** Dashboard issuance returns the display page directly as the `200`
  response to `POST /speakers/:speakerId/key`, with `Cache-Control: no-store` and the
  strict CSP. The raw token exists only in that response body and the intended
  recipient's process; only its public prefix and keyed HMAC verifier are stored. A
  re-submit is a new credential, not recovery.
- **Reproducer / test:** Issue a credential, capture the token from the POST body, then
  GET `/speakers`, GET the form again, and read every credential row and request log;
  none may contain the token. A Node-adapter HTTP test proves the POST body survives
  the real server path.
- **Prevents:** Redirect URLs, caches, browser history, application logs, or database
  dumps becoming the recovery path for a credential that is supposed to be unrecoverable.
- **Remove when:** The product intentionally provides a credential vault with an
  explicit, audited reveal policy; that is a different security design, not a UI tweak.

## 2026-11-04 — Snapshot enumeration must skip only provable writer artifacts

- **Failure:** `createBackup` listed a `LocalBlobStore` `.tmp-<32 hex>` file and then
  failed with `BACKUP_BLOB_ENTRY_INVALID` when the writer's rename removed it before
  `lstat`/copy (GitHub Issue #7). Copying it while still present would also record a
  partial/temporary blob in the manifest as if it were complete.
- **Reproducer:** churn documented `.tmp-<32 hex>` files in `blobs` while calling
  `createBackup` in a loop; before the fix 8/8 attempts failed, after 0/400.
- **Fix:** exclude exactly `^\.tmp-[0-9a-f]{32}$` regular entries from snapshot
  enumeration (blob keys never contain `.`, so these cannot be committed blobs), while
  still rejecting a symlink/directory/device with that name and failing closed on every
  other entry. `verify` stays strict: a temp entry in a backup directory is still
  unexpected.
- **Prevents:** Flaky backups under a concurrent writer and manifests that claim an
  uncommitted temp file belongs to the consistent pair.
- **Remove when:** blob commits no longer stage a visible temp file inside `blobs`
  (for example, a staged directory plus an atomic rename).

Entry shape: date; surprising failure and root cause; minimal reproducer or test; fix;
prevented regression; when to remove the advice.

## 2026-11-04 — A narrow session viewer must check its own scopes, not only membership capabilities

- **Failure:** Extending the session-viewer authorization branch to permit
  `project.edit` let a viewer resolved for `message.read` reach the owner capability
  because the branch checked only the membership capability set. The existing
  "session viewer can read but can never authorize a write scope" test failed when
  `expireMessageBody` (which requires `project.edit`) stopped rejecting the read
  viewer.
- **Reproducer:** Resolve `resolveSessionViewer(..., "message.read")`, then call
  `authorizeProject(fx.deps, viewer, projectId, "project.edit")` or
  `expireMessageBody` with that viewer. Before the fix the membership's all-scope
  capability authorized the write; after the fix it is `NOT_FOUND`.
- **Fix:** `authorizeSessionProject` requires both the requested scope in the
  membership capabilities and `principal.scopes.has(scope)`. The resolver already
  returns exactly the requested scope, so the declared set is the viewer's real
  authority.
- **Prevents:** Privilege amplification from a narrowly resolved session viewer when
  a new scope is added to the branch.
- **Remove when:** session viewers are replaced by an explicit capability handle that
  cannot re-derive a broader scope from membership state.

## 2026-11-04 — A blank query value from a GET form is not invalid input

- **Failure:** The dashboard's filter form submits its blank text and number inputs
  when the user leaves them empty. The page forwarded every non-null query value to
  `listMessages`, whose validators correctly reject an empty speaker id, an empty
  type, and an empty/non-integer limit, so submitting with Sender blank returned the
  generic `400` page. `q=` was already tolerated because the service ignores an empty
  search.
- **Reproducer:** Seed a project, sign in, and open `/projects/:id?sender=` (also
  `type=`, `limit=`, `unread=`, `after_seq=`, `before_seq=`): `400` before the fix,
  unfiltered `200` after. `q=` was already `200` before the fix. Malformed non-blank
  values must still be `400`.
- **Fix:** Parse timeline values through one helper that maps `null` and
  whitespace-only values to absent before the strict validators run. Identifier and
  cursor values are not trimmed, so surrounding whitespace still fails validation;
  `q` is literal search text, so its whitespace is preserved. Do not change the REST
  list, where an explicitly empty parameter keeps its existing validation.
- **Prevents:** Visible blank form inputs turning "no filter" into invalid input while
  preserving rejection of real malformed values.
- **Remove when:** the filter controls stop submitting blank values, for example by
  omitting unset fields with a client script or a form contract that distinguishes
  absent from empty.

## 2026-11-04 — Retention must preserve the marker that proves a row is OAuth-issued

- **Failure pattern:** The only structural difference between an OAuth access credential
  and a `cb_` speaker credential is the `oauth_token_clients` association. Deleting the
  association before the credential (needed for the FK) would make the credential
  unclassifiable, and guessing from a `cb_oat_`/`cb_` prefix is probabilistic because a
  random speaker token can share the prefix.
- **Fix:** Inside one `BEGIN IMMEDIATE` transaction, capture the eligible OAuth
  credential ids while the association still exists, delete grants and associations,
  then delete each credential with a conditional predicate. Everything else deletes
  with its own `WHERE ... <= cutoff` predicate, so a rerun is a no-op and a concurrent
  run cannot widen the set. Never delete an association while any
  `oauth_refresh_tokens` row still references the credential: the association is what
  keeps RFC 7009 access-token revocation working and what lets refresh rotate the row;
  orphan-only cleanup runs separately. Import `SESSION_IDLE_MS` from `sessions.ts`
  instead of copying the idle window.
- **Prevents:** Deleting a speaker credential, breaking revocation or refresh for a
  live token, making a credential permanently unprunable, or leaving a
  non-deterministic set of rows between runs.
- **Remove when:** The schema gains an immutable credential kind/issuer column with its
  own index.

## 2026-11-04 — OAuth access tokens should be ordinary credentials

- **Failure pattern:** A second token table (or a JWT branch) for OAuth would duplicate
  `authenticateBearer`, project membership, grant, revocation, and expiry checks. The
  two paths drift, and OAuth silently gains a right the REST path denies.
- **Fix:** An approved consent creates one `credentials` row for the selected speaker
  with the consented scopes and one `credential_project_grants` row. Access tokens are
  `cb_oat_` + 256 bits verified by the existing prefix + keyed HMAC lookup. Refresh
  replaces that credential's prefix/verifier/expiry and retires the old access token.
  A second `oauth_refresh_tokens` table stores only the prefix and HMAC verifier for
  rotation/reuse detection.
- **Prevents:** A parallel authorization path and OAuth-only privilege widening.
- **Remove when:** Never; keep the single-authorization rule.

## 2026-11-04 — Bind the authorization code and PKCE challenge in one stored hash

- **Failure pattern:** The code table needs to verify both the random authorization
  code and the PKCE verifier, but a naive design stores them separately or trusts the
  submitted challenge. Missing either binding allows code guessing or PKCE bypass.
- **Fix:** Store `code_verifier_hash = HMAC(pepper, code + "\n" + S256(verifier))`.
  Lookup by the public code prefix, recompute from the presented code and verifier,
  and compare at fixed length. The raw code and verifier are never stored; one
  constant-time comparison proves both.
- **Prevents:** Stored-plaintext codes, PKCE downgrade, and code/verifier replay.
- **Remove when:** The schema gains separate audited verifier columns without
  weakening the binding.

## 2026-11-04 — A form-based consent flow still needs CSRF, and HTML needs a CSP

- **Failure pattern:** A server-rendered consent form cannot set `X-CSRF-Token`
  without script, but accepting a hidden CSRF field only would diverge from the session
  contract. Adding inline JavaScript to solve it weakens CSP and risks injection.
- **Fix:** Keep the session CSRF header and serve one constant same-origin script that
  reads the non-HttpOnly CSRF cookie and submits the form. CSP is
  `default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self';
  base-uri 'none'; frame-ancestors 'none'`. The sign-in form needs no script and uses a
  separate double-submit cookie. Escape every project/speaker/client/state value.
- **Prevents:** Consent CSRF, inline-script XSS, and CSP exceptions that hide future
  injection.
- **Remove when:** A framework provides nonce-based, non-inline form handling with the
  same headers.

## 2026-11-04 — The Node adapter must mirror core body and header behavior

- **Failure pattern:** Tests called `createApp` directly, so they stayed green while the
  Node adapter (a) never read `POST /api/v1/session` bodies and (b) collapsed two
  `Set-Cookie` values into one comma-joined header. Login was unusable through
  `serve`, and a browser received a corrupted cookie pair.
- **Fix:** `needsBody` lists every core POST route that parses JSON; response writing
  uses `Headers.getSetCookie()` and passes the array to `setHeader("set-cookie", ...)`
  while skipping `set-cookie` in `forEach`. An end-to-end `startServer` + `fetch` test
  covers login → session read → CSRF logout → replay, and a raw `node:http` assertion
  counts two `Set-Cookie` lines for login and logout.
- **Prevents:** Adapter/core drift that direct-handler tests cannot see.
- **Remove when:** A shared route manifest drives both routing and body buffering.

## 2026-11-04 — A human session is not a speaker credential

- **Failure pattern:** Reusing the bearer principal for browser cookies would let a
  logged-in account act as a speaker without a scoped credential and would bypass
  project membership/grant checks. Sharing one token format also lets a session value
  probe the bearer route.
- **Fix:** Sessions live in their own `sessions` table and service module. Only the
  three `/api/v1/session` routes read the cookie; bearer routes and `/mcp` never do.
  Sign-in issues a fresh server-generated token (no client-supplied session id), the
  database stores only a prefix plus keyed HMAC verifiers, and account authorization
  never substitutes for speaker scopes.
- **Also fixed while testing:** Verify unknown emails and no-password accounts against a
  dummy PBKDF2 hash so the uniform `401` is not an obvious timing oracle; key the login
  limiter by a hash of the normalized email so addresses are not retained; perform the
  CSRF check before touching `last_seen_at` so a forged state-changing request has no
  side effect.
- **Prevents:** Speaker impersonation from a browser session, session-token replay on
  bearer endpoints, CSRF-driven logout, and account enumeration by timing or rate-limit
  behavior.
- **Remove when:** OAuth or another delegated-identity layer replaces password sessions;
  keep the cookie/session vs. speaker-credential boundary rule.

## 2026-11-04 — Metrics need fixed labels and a nonexistent-looking disabled route

- **Failure pattern:** Recording raw pathnames or method strings lets any caller grow an
  in-memory metric map without bound and stores object IDs that may be sensitive.
  Returning `401`/`405` for a disabled or unauthenticated `/metrics` endpoint also
  discloses that the route exists, and skipping configuration validation until after
  the data directory is created leaves filesystem side effects for a rejected start.
- **Fix:** `routeLabelFor` reduces paths to a closed set of templates (`unknown` for
  everything else), `/mcp` is one label with no tool content, and error codes come only
  from the server-authored envelope. `metricsConfigFromEnv` runs beside the limiter
  parser before any filesystem work, and the endpoint returns the ordinary `404` for
  disabled, missing-token, and wrong-token requests; only a valid operator token can
  reach the method check.
- **Second failure pattern:** Env-only validation lets a direct `createApp` caller enable
  an empty/whitespace or sub-minimum token, and comparing raw strings leaks length and
  content through comparison time. Validate at both the env parser and the construction
  boundary (empty/whitespace disables; non-empty requires at least 32 characters), and
  SHA-256 both sides so the constant-time fold always compares fixed-length digests.
  Trim once and use the trimmed value for both the minimum-length check and the returned
  token; deciding "disabled" from the trimmed value but measuring the raw string lets
  edge whitespace satisfy the floor and become part of the secret. Document the
  remaining enabled-vs-disabled hashing-time caveat rather than claiming perfect
  indistinguishability (a later audit flagged the raw-string measurement as open P2 debt).
- **Prevents:** Unbounded metric cardinality, content/ID leakage, endpoint discovery,
  weak/directly constructed operator tokens, token-length timing inference, and startup
  that creates data before rejecting invalid metrics configuration.
- **Remove when:** Metrics move to a platform collector that enforces bounded labels and
  an authenticated, explicitly registered scrape endpoint before application startup.

## 2026-11-04 — Rate-limit after auth, and give REST and MCP one bucket

- **Failure pattern:** Limiting before authentication lets unauthenticated traffic
  consume or probe buckets, and separate REST/MCP limiters let one credential double its
  effective rate. Limiting after body parsing also spends the work the limit is meant to
  refuse, and an over-limit MCP `initialize` can still create a session.
- **Fix:** `authenticate()` runs the injected-clock token bucket immediately after
  `authenticateBearer` returns a `Principal`; `createApp` constructs a single
  `RateLimiter` shared by the REST routes and the MCP endpoint, keyed by `credentialId`.
  The bucket is checked before body parsing and before `mcp.handle`. `/healthz` and
  unauthenticated requests never reach it.
- **Prevents:** Unauthenticated bucket consumption, per-surface limit bypass, and
  side effects (sessions, handler work) from a request that is already over limit.
- **Remove when:** Limiting moves to a shared gateway that runs before the application
  and keys on a verified credential (still keep the 429 no-session test).

## 2026-11-04 — A “read-only” SQLite open can still create WAL sidecars

- **Failure:** `new DatabaseSync(path, { readOnly: true })` on a WAL-mode database whose
  `-shm`/`-wal` files are absent creates those sidecars. A diagnostic promised not to
  write to the data directory; creating files is a write.
- **Reproducer:** Create a WAL database, checkpoint and close it, delete `-wal`/`-shm`,
  open it read-only, and observe both files reappear (the DB bytes are unchanged).
- **Fix:** Read the 20-byte header; for WAL with no sidecars, open
  `file:<percent-encoded path>?immutable=1` (plus `readOnly`), which creates nothing and
  still rejects writes. If both sidecars exist, a read-only open reads the live WAL
  without creating files. A lone sidecar is a crash state and is rejected (exit 2)
  rather than repaired.
- **Prevents:** Diagnostics that silently mutate the installation they inspect, and
  stale reads from always using `immutable` while a live WAL holds committed data.
- **Remove when:** `node:sqlite` exposes a snapshot/backup read that neither writes nor
  ignores the WAL.

## 2026-11-04 — Passing the original Request to an SDK leaks credential headers

- **Failure:** The MCP adapter authenticated the bearer token, then handed the same
  `Request` to `transport.handleRequest`. The SDK copies request headers into the
  handler context (`extra.requestInfo.headers`), so the bearer token reached every tool
  handler even though documentation claimed it never did.
- **Reproducer:** An `onToolRequest` observer on the handler context printed an
  `authorization` key while the original request carried `Bearer ...`.
- **Fix:** Clone the request and delete `Authorization`, `Proxy-Authorization`, and
  `Cookie` before the transport sees it. Keep only the derived principal in
  `authInfo.extra`. Test the handler context and tool output for absence of the token.
- **Prevents:** Credential material entering an SDK, provider, or tool-visible context
  that does not need it. Applies to any library that echoes request headers.
- **Remove when:** The SDK offers an explicit context allowlist that excludes auth
  headers by construction (still keep the negative test).

## 2026-11-04 — JSON-RPC `1` and `"1"` are different ids

- **Failure:** MCP send idempotency used `String(requestId)`, collapsing numeric `1`
  and string `"1"` into one key. Two distinct requests in one session then collided:
  distinct payloads produced `CONFLICT`, identical payloads were misread as a replay.
- **Reproducer:** One MCP session, raw `corkboard_send_message` calls with `id: 1` and
  `id: "1"` and different text; the second was rejected as `CONFLICT`.
- **Fix:** v2 derivation over `JSON.stringify([sessionId, projectId, typeof requestId,
  requestId])`; tests assert distinct messages/seq for typed ids, replay for the same
  typed id, and `CONFLICT` for a changed payload.
- **Prevents:** Type-blind idempotency keys in JSON-RPC adapters.
- **Remove when:** JSON-RPC ids are canonicalized by the transport before the adapter.

## 2026-11-04 — JSON-RPC ids repeat across sessions, so MCP keys need the session

- **Failure:** Deriving an MCP send idempotency key from only the JSON-RPC request id and
  project lets two independent sessions of the same speaker both use id `1` for
  different payloads. The second send then fails `CONFLICT` even though it is unrelated.
- **Reproducer:** Initialize two sessions with one credential, call
  `corkboard_send_message` in the same project with JSON-RPC id `1` but different text;
  the second call conflicts.
- **Fix:** Include the server-issued session id in the derivation:
  `mcp_` + SHA-256(`"corkboard-mcp\n" + sessionId + "\n" + projectId + "\n" + requestId`).
  The service keeps its existing `(speaker, project, key)` scope and payload-digest
  conflict check.
- **Prevents:** Cross-session collisions while preserving same-session replay semantics.
  It does not prevent a client from duplicating a message by retrying with a new JSON-RPC
  id; that residual client responsibility is documented.
- **Remove when:** MCP sends carry an explicit client-owned idempotency token whose scope
  and retry semantics are part of the public contract (not expected for this API).

## 2026-11-04 — Authorize once, act later is a revocation window

- **Failure:** A request that passed authorization at start could still commit a
  message, write a receipt, or return plaintext after the credential, grant, or
  membership had been revoked mid-flight.
- **Reproducer:** Wrap the blob store so the grant/credential/membership is revoked
  between the initial `authorizeProject` and the finalize statement, receipt INSERT, or
  plaintext return; the operation previously succeeded.
- **Fix:** `sendMessage` re-authorizes `message.send` immediately before finalization,
  `markRead` re-authorizes `message.read` and `receipt.write` before the receipt INSERT,
  `getMessageBody` re-authorizes `message.read` after decryption before returning, and
  `expireMessageBody` re-authorizes `project.edit` before the destructive UPDATE and
  before the already-expired repair path. All reuse `authorizeProject`; reads with no
  write stay request-start-only.
- **Prevents:** Acting on stale access after revocation. It does not prevent a
  revocation landing after the final re-check and before the atomic SQL statement; no
  atomic-revocation guarantee is claimed.
- **Test note:** the interleavings are deterministic by wrapping `BlobStore.put/get` in
  `tests/integration/messages.test.ts` and `SqlDatabase.first` in
  `tests/integration/expiry.test.ts`.
- **Remove when:** Later versions use an authorization epoch checked inside the same
  atomic statement (not expected for SQLite/D1).

## 2026-11-04 — `existsSync` follows symlinks, so bootstrap can miss one

- **Failure:** `init` used `existsSync(corkboard.sqlite)`. A dangling symlink resolves
  to a missing target, so the sentinel returned false and initialization proceeded.
- **Reproducer:** Create `corkboard.sqlite` as a symlink to a nonexistent path, then run
  `init`; it generated keys instead of refusing.
- **Fix:** `lstatSync` (via `pathOrLinkExists`) treats any directory entry, including a
  dangling or real symlink, as an existing installation. The same guard covers the
  secrets path.
- **Prevents:** Bootstrap writing into an installation whose database path was
  redirected.
- **Remove when:** Initialization is replaced by an explicit migration/repair tool.

## 2026-11-04 — Re-running a membership grant must not rewrite active rights

- **Failure:** `add-member` used `ON CONFLICT DO UPDATE` unconditionally, so a non-owner
  re-run replaced an owner membership's capabilities and `joined_at`.
- **Reproducer:** `add-member --owner`, then `add-member` without `--owner`; the
  membership lost `member.manage`/`project.edit`.
- **Fix:** the conflict update is gated by
  `WHERE project_memberships.removed_at IS NOT NULL`; an active membership is a no-op
  with no second audit row. Only reactivation of a removed membership may replace
  capabilities.
- **Prevents:** Silent privilege downgrade (or widening) from a repeatable CLI command.
- **Remove when:** Membership management moves behind an explicit versioned update API.


## 2026-11-04 — A membership alone is not a credential grant

- **Failure:** Authorization intersected credential scopes with *any* active membership
  of the speaker, so a key issued for project A could read and send to project B when
  the speaker was also a member there.
- **Reproducer:** Issue a key with `--project A` for a speaker who is a member of A and
  B, then call a project-B message endpoint with that token. It succeeded.
- **Fix:** `credential_project_grants (credential_id, project_id)` plus a deny-by-default
  check in `authorizeProject` on every project-scoped path; project enumeration joins
  the calling credential's grants; CLI `grant-key-project`/`revoke-key-project`.
  Membership and grant are independent: a grant requires a membership, and a membership
  grants no credential.
- **Prevents:** Credential least-privilege failure and silent widening when the speaker
  joins another project.
- **Test note:** the shared fixture auto-grants memberships/credentials by default so
  legacy tests keep exercising scope/membership logic. Grant-specific tests must set
  `autoGrantMemberships: false` / `grantExistingCredentials: false` and grant
  explicitly.
- **Remove when:** Not expected; keep as a rule for OAuth delegated grants too.

## 2026-11-04 — Bootstrap must refuse, not overwrite

- **Failure:** `init --force` regenerated the root key and pepper over an existing
  database, making stored bodies unreadable and issued token verifiers invalid. Secrets
  also defaulted inside the data directory, coupling key backups to ciphertext backups.
- **Reproducer:** `init`, issue a token, send a message, then `init --force` and try to
  authenticate/decrypt with the same secrets bytes.
- **Fix:** Remove `--force`; refuse when the database or secrets file exists without
  generating keys; default secrets to `$XDG_CONFIG_HOME/corkboard/secrets.env` (or
  `~/.config/...`), reject in-data paths, create dir `0700`/file `0600`, and document
  rotation as a separate unimplemented operation. Regression tests assert unchanged
  bytes and continued decryption.
- **Prevents:** Irreversible local key loss and secret/data backup co-location.
- **Remove when:** A versioned, explicitly confirmed rotation command with re-encryption
  exists.



## 2026-11-04 — Fixtures that bypass provisioning hide unreachable features

- **Failure:** The expiry endpoint required `project.edit`, but `issue-key` could only
  mint the four default member scopes. Tests passed because the fixture constructed
  credentials with `ALL_SCOPES`, so the feature was unusable through the shipped CLI;
  a contract audit found it end-to-end.
- **Reproducer:** Follow the documented CLI bootstrap, then `POST .../expire` with the
  issued token — `403 FORBIDDEN`.
- **Fix:** `issue-key --scopes` (validated as a subset of membership capabilities), a
  CLI-to-HTTP end-to-end test using the real issuance path, and documented `--owner`.
- **Prevents:** Green unit tests over a capability no real caller can obtain.
- **Remove when:** Every feature has at least one end-to-end test through its public
  provisioning path.

## 2026-11-03 — Credential-bearing source must never reach public git

- **Failure:** The archival `ORIGINAL_DESIGN.md` contains a proxy URL with embedded
  credentials on line 160. A default `git add .` would publish it.
- **Reproducer:** `grep -qE '//[^/ ]+:[^@ ]+@' ORIGINAL_DESIGN.md && echo present || echo absent`
  (never omit `-q`; the value must not reach the terminal or an agent transcript).
- **Fix:** The unredacted file is written to `.gitignore`; a redacted copy is committed
  under `docs/`; CI runs `scripts/secret-scan.ts` over tracked files.
- **Prevents:** Secret leak in repository history that cannot be removed by a later
  commit.
- **Remove when:** The original is permanently stored in an access-controlled archive
  outside git and the local file no longer exists.

## 2026-11-04 — Sequence allocated before publication breaks ordered replay

- **Failure:** Provisional posts received a sequence before their body was ready. A later
  post could become ready first, so a cursor reader advanced past a lower sequence that
  was published afterwards and never saw it.
- **Reproducer:** Provision messages A and B, finalize B first, then list with
  `after_seq` and observe A appear behind the cursor.
- **Fix:** `messages.seq` is NULL until one atomic UPDATE publishes `ready`, assigns
  `seq = next_seq + 1`, advances `projects.next_seq` via trigger, and completes the
  idempotency row. Concurrent collisions retry; publication order equals sequence order.
- **Prevents:** Silent message loss for polling agents.
- **Remove when:** Finalization no longer uses provisional rows (not expected).

## 2026-11-04 — AAD cannot include a digest carried only inside ciphertext

- **Failure:** An envelope design bound the plaintext digest into the AAD while carrying
  that digest only inside the ciphertext, creating a circular dependency at decrypt time.
- **Fix:** AAD binds pre-decryption metadata only. The plaintext digest is encrypted
  inside the CBPT1 payload and verified after decryption; the DB stores only the
  ciphertext digest for storage-integrity verification.
- **Prevents:** Designs that expose the digest unauthenticated or cannot decrypt.
- **Remove when:** Never; keep as a design rule.

## 2026-11-04 — A membership row is not an active membership

- **Failure:** Authorization read `project_memberships` without filtering `removed_at`,
  so a removed collaborator kept project rights.
- **Reproducer:** Set `removed_at` on an otherwise-active membership and observe that
  effective rights still contained scopes.
- **Fix:** Membership removal is part of the effective-rights input and every membership
  query filters `removed_at IS NULL`; removed/non-member access is `NOT_FOUND`.
- **Prevents:** Revoked-access bypass.
- **Remove when:** Membership rows are physically deleted on removal (not the design).

## 2026-11-04 — A consent form must carry a signed authorization request

- **Failure:** The consent endpoint checked the selected scopes against
  `requested_scope` only when that form field was present. A CSRF-valid consent POST
  that omitted it could select a scope the authorization request never asked for.
- **Reproducer:** Authorize `message.read`, then POST consent with `message.send` and
  no `requested_scope`.
- **Fix:** The consent page carries `requested_scope` plus a keyed HMAC over the
  client, redirect, state, challenge, resource, and requested scope set. Consent
  requires both, verifies them, and only then checks the selection as a subset.
- **Prevents:** Scope escalation through a form the server cannot correlate with the
  original authorization request.
- **Remove when:** Authorization requests are persisted server-side with their scope.

## 2026-11-04 — An authorization code outlives the session that approved it

- **Failure:** Codes bound the account but not the issuing session, so an exchange
  still succeeded after the human signed out.
- **Reproducer:** Obtain a code, sign out with `DELETE /api/v1/session`, exchange it.
- **Fix:** `oauth_authorization_codes.session_id` records the approving session and
  exchange rejects a revoked/expired/idle-expired session before consuming the code.
- **Prevents:** A stolen code remaining usable after the user revokes their session.
- **Remove when:** Codes have an independent, equally strong approval lifetime bound.

## 2026-11-04 — Revocation ownership cannot depend on refresh rows

- **Failure:** Access-token revocation proved client ownership through
  `oauth_refresh_tokens`. A client registered only for `authorization_code` mints no
  refresh row, so revocation returned RFC 7009 success while leaving the credential
  valid.
- **Reproducer:** Register a code-only client, exchange a code, revoke the access
  token, and call the API with it.
- **Fix:** `oauth_token_clients` records the owning client for every minted access
  credential; revocation authorizes from that durable association.
- **Prevents:** Silent revocation failure for clients without refresh tokens.
- **Remove when:** Every OAuth credential always has a refresh family (not expected).

## 2026-11-04 — Compiled server could not find its migrations

- **Failure:** `db.ts` resolved the migration SQL relative to its module, so the built
  `dist/src/storage/db.js` looked for `dist/migrations/001_init.sql`, which `tsc` does
  not emit. The built server failed to open storage.
- **Reproducer:** `npm run build && node -e "import('./dist/src/storage/db.js')..."`.
- **Fix:** the build copies `migrations/` into `dist/migrations`, and the opener falls
  back to `process.cwd()/migrations`. A built-artifact test opens storage from a cwd
  without `migrations/`.
- **Prevents:** deployment failure that tests running from source would miss.
- **Remove when:** migrations are packaged or embedded as strings in the adapter.

## 2026-11-04 — The adapter buffers only routes it knows read a body

- **Failure:** `POST /login` was added as a form route, but the Node adapter's
  body gate listed only the existing POST routes, so the request reached the core
  with no body and every sign-in failed the CSRF check.
- **Reproducer:** Start `startServer()` and submit the dashboard login form.
- **Fix:** Add the single-segment `POST /login` route to the adapter's body gate and
  cover the full flow over real HTTP, not only through `createApp()`.
- **Prevents:** An HTML form that works in handler tests but cannot sign in through
  the only server adapter.
- **Remove when:** the adapter buffers bodies generically for every route that may
  read one (for example by content type), removing the allowlist.

## 2026-11-04 — A session viewer is not a credential

- **Failure:** Reusing `authorizeProject` for a session as if it were a speaker
  principal would have required inventing a credential and grant, or bypassing the
  grant check; either choice would misstate the trust model.
- **Reproducer:** Derive a viewer from an account-owned membership and call the
  bearer authorization path without a credential row.
- **Fix:** Mark session viewers with a code-set `sessionViewer: true` flag (never a
  credential-id prefix or request value), add an explicit branch that re-checks
  project, membership, speaker ownership, and account state, and authorize only
  `project.read`/`message.read` from the membership capabilities. The bearer path is
  unchanged.
- **Prevents:** Treating an account session as a speaker credential, granting write
  authority to a read-only surface, or discriminating on an operator-controllable id.
- **Remove when:** sessions are modeled as first-class principals with their own
  authorization port and a documented read-only capability set.

## 2026-11-04 — Capability denial on a session viewer must look like absence

- **Failure:** A member whose membership lacks the requested capability would get
  `FORBIDDEN`, which distinguishes an existing project from a missing or foreign one
  on the HTML surface.
- **Reproducer:** Give an account-owned speaker a membership without `message.read`
  and open the project timeline.
- **Fix:** `resolveSessionViewer` finds only memberships that already grant the read;
  the session authorization branch also returns `NOT_FOUND` when the capability is
  absent. The dashboard maps `FORBIDDEN` to the same uniform `404`.
- **Prevents:** Project-existence enumeration through the dashboard.
- **Remove when:** the product deliberately exposes discoverability separately from
  read authorization with a reviewed policy.

## 2026-11-04 — Read authority is not the membership capability set

- **Failure:** The session-viewer branch of `authorizeProject` returned the whole
  membership capability set as `rights`. A read path that also checks a write
  scope (`markRead`'s `receipt.write`) would have passed, contradicting the
  read-only dashboard guarantee.
- **Reproducer:** Derive a session viewer from a membership with every capability,
  then call `markRead`; the receipt scope check succeeded before the fix.
- **Fix:** The session branch requires the requested read scope in the parsed
  membership capabilities, but returns only that scope as the principal's
  `scopes` and the result's `rights`/`capabilities`. Tests assert `markRead`,
  `sendMessage`, and expiry are rejected while timeline/body reads still work.
- **Prevents:** A future dashboard write silently inheriting membership writes.
- **Remove when:** the session viewer becomes a first-class principal with its own
  read-only authorization port rather than a `Principal` reuse.

## 2026-11-04 — `Origin: null` is not a cross-origin assertion

- **Failure:** Login fetch-metadata validation rejected any `Origin` that did not
  parse as a URL. Headless Chrome's CDP-driven `form.submit()` sends
  `Origin: null`, so a otherwise-valid double-submit login returned 400.
- **Reproducer:** Submit the dashboard login form from `Runtime.evaluate` in
  headless Chrome and observe `Origin: null` and the expired-form page.
- **Fix:** Treat absent or `null` Origin as no assertion and fall back to the
  double-submit value; still reject a non-null Origin whose host differs and any
  cross-site `Sec-Fetch-Site`.
- **Prevents:** Breaking legitimate opaque-origin form posts while keeping the
  defense-in-depth check for real cross-origin requests.
- **Remove when:** every supported browser reliably supplies a usable
  `Sec-Fetch-Site` and the double-submit fallback is no longer needed.

## 2026-11-04 — Capability JSON must be parsed, not substring-matched

- **Failure:** The session project listing used `instr(capabilities,
  '"project.read"')`. A malformed or non-JSON capability string containing that
  substring listed a project whose timeline then returned 404 because the
  resolver parsed the same value to an empty scope set.
- **Reproducer:** Insert `not-json "project.read" not-json` as a membership
  capability and open the dashboard.
- **Fix:** Fetch the account's membership rows and use `parseScopeJson` for the
  `project.read` decision, deduplicating projects in deterministic order.
- **Prevents:** Listing/timeline inconsistency and a substring-based authorization
  bypass.
- **Remove when:** capabilities are stored in a parsed relational form rather than
  a JSON text column.

## 2026-11-04 — A full page does not prove another page exists

- **Failure:** The dashboard pager treated `rows.length === limit` as "there is
  another page". With exactly `limit` matching rows, or at a filter boundary, it
  rendered a Next link to an empty page, violating the bounded end-condition
  requirement.
- **Reproducer:** Seed exactly two matching messages, open
  `/projects/:id?limit=2`, and follow the rendered Next link; it returns an empty
  timeline.
- **Fix:** `listMessages` fetches one extra row and returns an internal
  `hasMore` flag while still returning exactly `limit` rows. The HTML pager uses
  it to omit the link. REST and MCP continue to serialize only `messages` and
  `next_cursor`, so their contract is unchanged; the service test asserts the
  exact-boundary case.
- **Prevents:** Dead-end pagination links and a misleading definition of "end".
- **Remove when:** the service exposes a cursor that carries its own end state
  and the pager no longer relies on a probe row.

## 2026-11-04 — `unread=false` is a filter, not the absence of one

- **Failure:** The page treated only `unread === true` as an active filter.
  `?unread=false` was correctly applied by `listMessages` (messages with a
  receipt), but the active-state line, clear link, and empty state ignored it,
  so a read-only result looked unfiltered and an empty one claimed "No messages
  yet."
- **Reproducer:** Open a project with no read messages and `?unread=false`; the
  page showed the unfiltered empty state and no clear link.
- **Fix:** `hasActiveFilters` and the state renderer treat every defined
  `unread` value as active, with separate "Unread only" and "Read only" labels.
  Tests cover both a zero-match and a matching read-only result.
- **Prevents:** A filter that changes the data but not the UI state.
- **Remove when:** the unread control becomes a three-way selector whose state
  is derived from one source instead of a true-only checkbox.

## 2026-11-04 — A byte-for-byte restore still needs the manifest's snapshot

- **Failure:** A database + blob copy taken without SQLite's online snapshot can
  capture a torn `-wal` state or omit recent commits; conversely, copying the
  sidecars into a restored directory can replay stale WAL frames against a database
  the snapshot already includes.
- **Reproducer:** Back up a live WAL installation by reading the main file while a
  writer commits, then restore with its old `-wal`/`-shm`; integrity or sequence
  invariants can fail.
- **Fix:** Use `VACUUM INTO` on a read-only connection to produce one standalone
  snapshot, never copy sidecars, and state the snapshot's highest
  `schema_migrations` version in the manifest. Verify the snapshot's digest before
  opening it, and refuse a schema newer than the running build.
- **Prevents:** Torn snapshots, stale-WAL replay, and restoring a newer schema into
  an older binary.
- **Remove when:** the deployment moves to a storage engine with a platform snapshot
  API and the D1/Workers path is implemented.

## 2026-11-04 — An audit sink must not become an oracle or an outage

- **Failure:** Authentication/OAuth lifecycle rows invite three easy mistakes:
  logging identifiers that are credential-like (session ids, codes, tokens), letting a
  failing audit insert change the login/token/revocation response, or recording a
  revocation no-op so the audit stream reveals token existence.
- **Reproducer:** Inject a trigger that aborts every `audit_events` insert and attempt
  login, token exchange, and revocation; a non-fail-open path returns an error even
  though the operation succeeded. Search the rows for a session token or authorization
  code and find it in a naive implementation.
- **Fix:** One shared `writeAudit` with parameterized SQL, bounded sanitized `detail`,
  random ids, and a swallowed/log-free insert; audit revocations only after ownership
  is proven; use uniform failure reasons and no actor for ambiguous login failures.
- **Prevents:** Audit failures becoming availability or authorization failures, secret
  leakage into security metadata, and an audit-derived existence oracle.
- **Remove when:** audit delivery moves to a durable queue that can report failures
  without affecting the request path, with its own retention and access controls.

## 2026-11-05 — Design source must name the revision it was cut from

- **Failure:** The design-system ADR recorded a base commit that was not the revision
  the design files were actually cut from, so the provenance claim could not be
  audited. The static previews were also described as "truthful renditions" while the
  shipped UI still uses system colors.
- **Fix:** Record the exact base and source commit/tree in the ADR, and state that
  previews demonstrate the intended token contract and DOM structure, not the current
  shipped rendering.
- **Prevents:** Unreviewable provenance and design documents that claim more than the
  product currently does.

## 2026-11-04 — Audit detail must not echo unvalidated request values

- **Failure:** The token-endpoint failure path copied the raw form `client_id` and
  `grant_type` into `audit_events.detail`. Bounding a string does not make an
  unauthenticated caller's text safe: it can carry control characters, forged
  token-like strings, or another client's id into security metadata.
- **Fix:** Record `grant_type` only when it is one of the supported literals and
  `client_id` only when it is syntactically valid and registered; otherwise omit it.
  Narrow the security docs to the code paths actually covered, because pre-dispatch
  token validation rejections throw before the audited block and are not recorded.
- **Prevents:** Attacker-controlled text and unverified identifiers in audit rows, and
  documentation that overstates audit coverage.
- **Remove when:** audit detail is assembled from typed, already-authorized values
  rather than raw request parameters.

## 2026-11-04 — Token CSS must keep literals in the token block and stay same-origin

- **Failure pattern:** Applying a design system invites inlining a `<style>` block or
  a `style=` attribute, importing a web font, or repeating palette hex values inside
  component rules. Each breaks the fixed CSP (`default-src 'none'; style-src
  'self'`) or lets the light/dark contract drift from `tokens.json`.
- **Reproducer:** Fetch `/static/app.css` and assert it defines every token custom
  property, contains no `@import` or `url(`, and has no hex literal outside a
  `--token: #...;` declaration. Assert the page has no `<style>`, `style=`, or script.
- **Fix:** Serve one token-driven same-origin stylesheet, keep the system font stacks,
  and override the palette under `prefers-color-scheme: dark` with `color-scheme` set
  in both themes.
- **Prevents:** CSP regressions, external font requests, and theme values that drift
  from the source tokens.
- **Remove when:** the design system ships a generated stylesheet with its own CSP and
  provenance checks.

## 2026-11-04 — A replay is not a new queue delay

- **Failure:** Recording queue-to-commit time on every `sendMessage` response makes an
  idempotent replay of an old message look like a delay as long as the message's age:
  `received_at` is re-read from the row while the replay's clock is current. The
  histogram then reports multi-day "queue" samples for a healthy service.
- **Reproducer:** Send with an idempotency key, advance the fixture clock, replay the
  same key and payload, and assert the queue histogram still has one sample. The
  service-level counterpart asserts the replay result omits `queueToCommitMs`.
- **Fix:** `publish` reports whether this call actually won the finalization; the delay
  is computed from the provisional row's `received_at` to the finalization
  `committed_at` only then. Both REST and MCP send paths feed the same registry.
- **Prevents:** Replays inflating latency/queue metrics and misleading capacity work.
- **Remove when:** Timing is emitted from a durable finalization record that already
  distinguishes the original commit from later reads.

## 2026-11-05 — A new web form route is also a Node adapter body route

- **Failure:** The dashboard project create/edit slice added `POST /projects` and
  `POST /projects/:projectId`, but the Node adapter's body predicate still listed
  only `/login`, OAuth, `/api/v1/session`, and message send. Over the shipped server
  the forms arrived body-less and the handlers returned `400` "The form expired.";
  in-process `createApp` tests stayed green. This repeats the `POST /login` failure
  recorded above, because the adapter allowlist and the router are separate lists.
- **Reproducer:** Start `startServer()`, sign in over HTTP, then submit the
  `POST /projects` form with a valid session CSRF. The committed HTTP-level test
  asserts `303` after the fix; the pre-fix `400` is the handler's empty-form path,
  because the body-less `Request` never reaches the adapter cap. The committed test
  covers the post-fix chunked/declared `413`; it does not run the pre-fix case.
- **Fix:** The body predicate asks `isWebPath` for POSTs, so every dashboard form
  route the web router knows is buffered. GET/HEAD/DELETE stay unbuffered, the
  64 KiB streaming cap is unchanged, and HTTP-level tests cover create, edit, CSRF
  failure, oversized bodies, and unauthenticated redirects.
- **Prevents:** Dashboard forms that pass handler tests but are unusable through
  the only shipped adapter.
- **Remove when:** Routing and body buffering share one route manifest, the same
  condition recorded for the earlier adapter lessons.

## 2026-11-05 — A two-write create needs one transaction, not a caveat

- **Failure:** `createProject` inserted the project and then its owner membership as
  two independent `run` calls. When the second failed, the request errored but the
  active project row persisted with no membership: invisible in the dashboard,
  uneditable, and with no ID the user could recover. Documenting the state as
  fail-closed debt did not make it recoverable (GitHub Issue #8).
- **Reproducer:** Wrap the database so the `INSERT INTO project_memberships` throws,
  call `createProject`, then assert `SELECT id FROM projects` is empty. On the base
  tree it returns the orphan; on the fixed tree it is empty.
- **Fix:** Add a narrow `SqlDatabase.transaction(fn)` port. The SQLite adapter uses
  `BEGIN IMMEDIATE`, commits on resolve, rolls back on throw, and hands the callback a
  statement-only handle so it cannot issue transaction control or nest. Both inserts
  run in that transaction. Statements are queued on the connection so a concurrent
  `transaction()` caller cannot join an open transaction; the CLI-only retention path
  opens a manual `BEGIN IMMEDIATE` through `exec` and is the documented exception
  (a concurrent `transaction()` there fails rather than joining).
- **Prevents:** Active projects without an owner membership, and any future multi-row
  invariant that "mostly works" but leaves partial state on the second write.
- **Remove when:** The storage layer can enforce the invariant in one declarative
  statement (for example a database-level trigger) or every adapter ships a verified
  transaction implementation.

## 2026-11-05 — Membership removal and grant deletion are one atomic rule

- **Failure:** Treating `project_memberships.removed_at` and
  `credential_project_grants` as independent writes lets a crash or a later statement
  failure leave a removed membership whose grants survive (or an active-looking grant
  for a removed member). Re-adding the membership then revives a credential the
  operator believed revoked, and the dashboard silently diverges from the CLI
  `remove-member`. Separately, an upsert that reactivates a membership on re-add would
  make an active duplicate silently change capabilities instead of rejecting it.
- **Reproducer:** Wrap `SqlDatabase.transaction` so it throws after the service's
  transaction body. Call the remove route, then assert `removed_at` is still `NULL`
  **and** the grant row is still present. On a split-write implementation the first
  write commits and the second is missing (or vice versa). Re-add the speaker and
  authenticate its old credential: a surviving grant yields `FORBIDDEN`-free access.
- **Fix:** One `transaction` performs the in-transaction `project.edit` re-check, the
  last-owner count, the soft delete, and the grant deletion; both writes roll back
  together. Add rejects an active duplicate as a conflict and only reactivates a
  removed row with the explicitly submitted capability set, restoring no grants.
- **Prevents:** Partial revocation state, credentials that revive on re-add, and a
  dashboard that does not match the CLI's grant-deletion contract.
- **Remove when:** A database-level constraint/trigger can enforce "no grant without
  an active membership" and grant deletion is expressed in the same statement, or
  every adapter ships a verified transaction implementation.

## 2026-11-05 — never resolve `npm` through `PATH` from an npm script

- **Failure:** `scripts/sbom.ts` called `execFileSync("npm", ...)`. `npm run`
  prepends `node_modules/.bin` to `PATH`, so a dependency-provided `npm` shim could
  run instead of the real CLI even with `npm ci --ignore-scripts`, forging the SBOM.
- **Reproducer:** Put an executable `npm` shim in `node_modules/.bin`, then run the
  script through `npm run` while `npm_execpath` is available; the shim runs before the
  fix. `tests/supply-chain/sbom.test.ts` pins the opposite outcome.
- **Fix:** Invoke `process.execPath` with `process.env.npm_execpath`, and exit `2` with
  a clear error when `npm_execpath` is unset. Never rely on a shell/PATH lookup for
  npm inside repository scripts, `package.json` script chains, or test helpers that
  spawn npm. Every package script now starts with
  `"${npm_node_execpath:?npm_node_execpath is not set - run via npm}"` and invokes
  `$npm_node_execpath`; `tsc` is `node_modules/typescript/lib/tsc.js`.
  `npm run audit` uses `scripts/npm-audit.ts`; the tests that build `dist` use
  `process.execPath` + `npm_execpath`. Guarding one runtime but leaving bare `node`
  or `tsc` in the same script chain only moves the shim target.
- **Prevents:** Dependency-controlled execution of the supply-chain tooling and forged
  reports.
- **Remove when:** Scripts no longer spawn npm, or a reviewed helper resolves the
  installed CLI path without consulting `PATH`.

## 2026-11-05 — `npm sbom` names the root from the working directory

- **Failure:** Running `npm sbom --sbom-format cyclonedx` inside a worktree named
  `corkboard-supply` emitted `metadata.component.name = "corkboard-supply"` while the
  purl and package metadata said `corkboard`. The display name therefore depends on
  the containing folder, so the same tree produces different SBOM identity.
- **Reproducer:** From a worktree whose directory name differs from `package.json`
  `name`, run `npm sbom --sbom-format cyclonedx` and compare
  `metadata.component.name` with `package.json`. npm (11.19.1) derives the root node
  name from the folder before falling back to the package name.
- **Fix:** `scripts/sbom.ts` rewrites the root component `name` and `version` from
  `package.json` before writing `reports/sbom.cdx.json`; the purl was already correct.
  The SBOM's `serialNumber` and `metadata.timestamp` remain per-run values and are
  documented as artifact-only, not reproducible build input.
- **Prevents:** An SBOM that identifies the project by an arbitrary worktree path.
- **Remove when:** npm derives the root component name from `package.json` first, or
  the SBOM is emitted by a generator that does. Keep the separate `npm run audit`
  step: advisory lookups need the registry, so they must not make the offline check
  fail or silently pass.

## 2026-11-05 — `project.edit` is not project administration

- **Failure:** Gating the membership editor on `project.edit` lets a non-owner
  member who holds that capability add its own speaker with `message.send`, then use
  the speaker-credential issuance UI to mint a bearer key. That converts a delegated
  project-metadata capability into durable bearer access the owner never granted.
  `TODO.md` requires project-owner authorization for membership admission.
- **Reproducer:** Give account B's speaker an active membership on account A's
  project with all seven capabilities including `project.edit`. Log in as B, POST
  `/projects/:id/members` adding B's second speaker with `message.send`, then POST
  `/speakers/:id/key`. Before the fix the add returns `303` and the key carries
  `message.send`; after it, all membership routes return the uniform `404` and no
  membership, credential, or grant is written.
- **Fix:** Membership list/add/remove require
  `projects.owner_account_id = session account` (active project and account), checked
  before the body is parsed and re-read in the write transaction. `project.edit`
  remains sufficient only for project metadata edit, not for membership or credential
  administration. The dashboard owner may grant any of the seven scopes because the
  authority is ownership, not the caller's own capability set.
- **Prevents:** Privilege escalation from a scoped project capability to bearer
  credentials, and cross-account speaker provisioning through the dashboard.
- **Remove when:** Membership administration has an explicit delegated role with a
  reviewed owner-equivalent policy and tests proving the delegation cannot mint
  broader credentials.

## 2026-11-05 — "as before" hid a new portability requirement

- **Failure:** Pinning every package script to `"${npm_node_execpath:?...}"` made
  the scripts POSIX-`sh`-only, because `cmd.exe` does not parse `${var:?}`. The
  supply-chain doc said "Scripts run through a POSIX `sh`, as before", which
  understates the change: the previous chains were also cmd.exe-compatible.
- **Fix:** The doc states the requirement as new, names the Windows failure, and
  notes CI runs `ubuntu-latest`. Two related limits are recorded as debt: the secret
  scans still resolve `git` through `PATH`, and the committed shim test's `tsc`
  assertion is static (its command never runs `tsc`).
- **Prevents:** Operators discovering a platform regression only in a Windows run,
  and readers assuming the documented boundary is broader than it is.
- **Remove when:** The scripts use a cross-platform wrapper (for example one Node
  entry script) and the secret scans invoke `git` by absolute path.

## 2026-11-05 — a write transaction is not a read-snapshot tool

- **Failure:** Wrapping the credential-inventory GET in `SqlDatabase.transaction`
  looked like a harmless way to make three related reads consistent. That helper is
  a documented **write** transaction: it issues `BEGIN IMMEDIATE`, and the D1
  emulation buffers the callback's writes for one `batch()`, which cannot return a
  read-only callback's results. The GET therefore violated the persistence port and
  took a write lock on a read path.
- **Reproducer:** Call `GET /speakers/:speakerId/credentials` with the D1 adapter
  contract emulated; the buffered transaction has no writes to submit and no way to
  yield the SELECT results. With SQLite, inspect the connection and see
  `BEGIN IMMEDIATE` held across three reads.
- **Fix:** Use three direct parameterized SELECTs, each repeating the
  owner/active-account predicate, so an ownership transfer can only shrink a later
  result set. Document that there is no snapshot claim. A real read-snapshot port
  (`BEGIN DEFERRED` plus a defined D1 strategy) does not exist and was not invented
  for one page.
- **Prevents:** A write lock and a portability break smuggled in as a consistency
  improvement, and false "in one transaction" documentation.
- **Remove when:** `SqlDatabase` gains a documented read-snapshot primitive with
  SQLite and D1 implementations and tests.
