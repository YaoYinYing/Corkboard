# LESSIONS.md

Campaign learnings. Spelling is intentional per the original request. Keep entries
actionable and prune stale ones.

## 2026-11-07 — a readiness probe needs a read-only sentinel, not a write

- **Failure avoided:** the R2 adapter omitted `checkReady` because R2 has no
  store-level probe, so the Worker `/readyz` reported ready after a D1-only check.
  The tempting fixes are both wrong: `put` a health object (mutates a private bucket
  and can fail on a read-only credential) or `list` the bucket (scans). The smallest
  side-effect-free probe is one `head` of a reserved sentinel key: absent is healthy,
  present is healthy, and a rejection is the only failure.
- **Reproducer:** `tests/contract/blobs.test.ts` "r2: checkReady heads the reserved
  sentinel once and never writes"; the Worker test injects `failOn("head")` and
  asserts the minimal `503 {"status":"unavailable"}` with no bucket/key detail.
- **Prevents:** readiness that silently skips a configured dependency, and probes
  that create, delete, or scan objects to prove liveness.
- **Remove when:** the platform exposes a documented side-effect-free bucket
  readiness primitive.

## 2026-11-07 — a negative UI claim can outlive the UI

- **Failure avoided:** `docs/acceptance-report.md` said "Receipts UI — Not implemented;
  Receipts are API-only" and `docs/runbook.md` said "No receipt UI" long after the
  project timeline began rendering per-message read receipts (`listReadReceipts` and
  the `renderTimeline` receipt block in `src/app/web.ts`). A reader would have
  concluded the capability did not exist, and a checkbox pass could have repeated the
  false claim.
- **Reproducer:** `grep -rn "Receipts are API-only\|No receipt UI" docs/` before the
  fix; `grep -rn "listReadReceipts\|readReceiptsLabel" src/app/web.ts` plus the
  `tests/integration/web.test.ts` "Read by" assertion show the capability shipped.
- **Fix:** Correct both current-state claims to describe the timeline display and the
  absence of a separate receipt-administration UI. Historical slice records stay as
  records of their time; only current-state claims were rewritten.
- **Prevents:** A docs-only audit "confirming" a false negative, and users or agents
  bypassing an existing UI capability because the docs deny it.
- **Remove when:** Current-state capability claims are generated from the route/feature
  inventory or a test-linked registry instead of being hand-maintained.

## 2026-11-07 — a silent auditor is not a reviewing auditor

- **What happened:** a resumed security auditor went idle for more than thirty minutes
  with a 1.4 MB transcript, no completion notification, and no verdict. Waiting on it
  would have stalled the checkpoint indefinitely.
- **Rule:** treat a long-idle auditor as failed. Ask once for a current verdict, then
  stop it and hand the exact tree to a fresh context-isolated reviewer; a partial
  "new assertions are genuine" line is not an audit result and must not be recorded as
  one. Keep the delta narrow so a replacement audit is cheap.
- **Prevents:** a checkpoint waiting on a dead process, or a partial message being
  mistaken for PASS.
- **Remove when:** the harness reports subagent liveness/terminal states reliably.

## 2026-11-07 — MCP retries survive a restart as new messages

- **Failure avoided:** Corkboard derives MCP idempotency from the session id, JSON-RPC
  id, type and project. A restart invalidates the session (old id → 404 `-32001`), so a
  blind retry of a send that may already have committed arrives as a new request and
  can create a second message.
- **Rule:** after any MCP session loss, read state (list) before resending, or send a
  deliberately distinct intent with its own idempotency semantics; never "retry" an
  uncertain send by reusing the same request id in a new session.
- **Prevents:** duplicate committed messages after a restart that the client reports as
  a clean retry.
- **Remove when:** MCP idempotency is bound to a client-supplied, session-independent key.

## 2026-11-07 — a 0600 directory is an unreadable evidence set

- **Failure avoided:** the dogfooding evidence directory was created `0600` (no execute
  bit), so five published transcript files could not be read or stat'ed and the
  secret-scan and review of exactly those files were impossible.
- **Rule:** evidence directories are `0700`, files `0600`; after publishing, exercise
  the published artifacts the way a reviewer will (read them) instead of trusting the
  producer's scan.
- **Prevents:** a "verified" evidence bundle with unreadable members.
- **Remove when:** the harness validates published-artifact readability automatically.

## 2026-11-07 — an accurate outcome can hide an inaccurate mechanism

- **What happened:** a fix note said malformed UTF-8 was "normalized by the platform
  parser" and a revert-check note said each probe was "a complete request whose only
  defect is the malformed byte". The outcomes were right (U+FFFD ends up stored; each
  decoder is load-bearing) but the mechanisms were wrong: `JSON.parse` preserves a lone
  surrogate and the replacement appears when the server UTF-8-encodes it, and two probes
  carry a second deliberate defect (a bogus digest, a missing `login_csrf`).
- **Why it matters:** auditors found the same wrong mechanism repeated in five files, so
  one imprecise sentence propagates into docs, TODO, state, and the commit message.
- **Rule:** when writing evidence, describe the mechanism that was observed, not the
  one that would explain the outcome; state the probe's actual shape (including other
  invalid fields) instead of an idealized "only defect" claim. Cite the platform call
  (`JSON.parse`, `TextEncoder`, SQLite) that performs the transformation.
- **Remove when:** docs quote a reproduced trace instead of a mechanism summary.
## 2026-11-07 — a non-fatal TextDecoder silently rewrites untrusted bytes

- **Failure avoided:** Request bodies were decoded with `new TextDecoder()`, whose
  default replaces malformed UTF-8 with U+FFFD. A body containing `0xff` inside a JSON
  string was accepted as valid text and only failed later if the digest happened to
  disagree; form routes could accept the replacement value outright. The server would
  then validate, store, or compare content the client never sent.
- **Reproducer:** POST a JSON body with `0xff` inside the `text` string, or a
  form-encoded login/OAuth body with `0xff` in a value. With a non-fatal decoder the
  JSON path reaches digest validation (`INTEGRITY_MISMATCH`) or succeeds when the
  digest is computed over the replacement text; the form paths reach credential
  validation. Neither is a decode-time rejection.
- **Fix:** Decode every request body this server parses itself with `new
  TextDecoder("utf-8", { fatal: true })` and map the decode failure to the route's
  validation error (`VALIDATION_ERROR` for API, the generic HTML `400` for dashboard
  forms, `invalid_request` for OAuth). Stored plaintext and envelope headers keep
  their own decoding; this rule is about the network trust boundary.
- **Prevents:** Silent content mutation at the input boundary and tests that pass
  because the malformed byte was replaced rather than rejected.
- **Caveat (still true after the fix):** the guarantee is over **raw request bytes**.
  `URLSearchParams` percent-decoding substitutes U+FFFD for `x=%FF`; a JSON
  `\uD800`-style surrogate escape is preserved by `JSON.parse` and becomes U+FFFD when
  the server UTF-8-encodes it. `POST /mcp` is decoded by the pinned MCP SDK transport,
  which is not strict. Say "raw request bytes on routes this server decodes", not
  "every body". A test for a strict decoder must also be a test that fails when the
  decoder is reverted: a probe whose request is already invalid (unknown client) passes
  either way, so verify by reverting the decoder and watching that test go red.
- **Remove when:** every request-body decoder is provably strict (for example a
  shared strict-body helper replaces the per-route decoders, including a strict
  pre-read in the MCP adapter).

## 2026-11-06 — a limiter after authentication still pays the authentication cost

- **Failure avoided:** The per-credential bucket was checked after the bearer
  credential SELECT, keyed HMAC verification, and unconditional `last_used_at`
  UPDATE. A compromised but over-limit key therefore kept causing serialized DB
  writes while the API reported `429`.
- **Reproducer:** Fill a credential's burst, advance the injected clock, then send one
  more request; the response is `429` but `last_used_at` still changes.
- **Rule:** Put the limiter in front of every expensive or state-changing step it is
  meant to bound. Derive a stable, bounded key from the presented credential (its
  public prefix) without a DB read or HMAC, make one bucket decision per request, and
  keep the map bounded and idle-evicted.
- **Prevents:** A "rate limited" response whose side effects still scale with request
  volume.
- **Remove when:** the authentication path has no mutable side effects and is cheap
  enough that limiting after it is indistinguishable.

## 2026-11-06 — moving a security mechanism invalidates every doc that names its key

- **Failure avoided:** The limiter moved before authentication and switched its key
  from the credential id to the presented token's public prefix, but five authoritative
  documents still said "after authentication", "keyed by credentialId", and
  "unauthenticated requests are not keyed". A contract audit blocked on the
  contradiction; the code was never wrong, the contract was.
- **Reproducer:** `grep -rn "credentialId\\|after authentication\\|not keyed" docs/`
  after changing `authenticate()`; every hit that describes the limiter is now stale.
- **Rule:** When a security mechanism's ordering, key, or trust boundary changes, treat
  every doc that names those details as part of the same change. State the new
  trade-off (here, bounded-map eviction means this is not volumetric control) rather
  than deleting the old caveat.
- **Prevents:** An implementation and its normative contract silently describing two
  different mechanisms.
- **Remove when:** mechanism ordering and keys are generated from one authoritative
  source that docs consume.

## 2026-11-06 — a receipt is an assertion about content, so fetch the content first

- **Failure avoided:** The reference poller passed list metadata to a no-op callback,
  called `mark_read`, and advanced its cursor without ever fetching the body. It
  therefore asserted "content was fetched" for content it had not retrieved.
- **Reproducer:** Run the default client over a project with one ready message; the
  server records a receipt and the cursor advances, yet no `GET .../body` occurs.
- **Fix:** Consumption is explicit (`--consume` or a programmatic callback). Before any
  receipt the client fetches the body under the existing request context/deadline and
  1 MiB streamed cap, requires the exact `message_id` and a canonical `sha256:` digest,
  and recomputes the SHA-256 over the UTF-8 `text`. Only then does it invoke the
  consumer, and acknowledge/advance only after the callback returns and `mark_read`
  confirms. The default pass observes one metadata page and writes nothing.
- **Prevents:** Treating "listed" as "delivered", and a durable cursor that records
  unverified progress past messages the client never read.
- **Remove when:** the receipt endpoint itself accepts and verifies proof of content
  retrieval bound to the acknowledgment.

## 2026-11-06 — document the shipped adapter's error shape, not just the core's

- **Failure avoided:** The runbook said an oversized `POST /mcp` returns JSON-RPC
  `-32000` "Payload Too Large". The shipped Node adapter buffers the body under the
  64 KiB cap and returns the standard Corkboard `413 REQUEST_TOO_LARGE` envelope before
  the core (and its MCP SDK transport) sees the request.
- **Rule:** When an adapter pre-processes a request (body caps, auth, routing), document
  and cite the shipped path; state the core-direct behavior separately.
- **Prevents:** Client authors coding to an error shape the deployment never emits.
- **Remove when:** Adapters share one request/limit layer with the core.

## 2026-11-06 — a reverse-proxy example is code and needs the same review

- **Failure avoided:** The first nginx example redirected with `$host` (an open redirect
  and attacker-controlled Host), forwarded `$host` into the application's same-origin
  check, blocked HTTP-01 ACME under a blanket 301, and enabled `includeSubDomains` in
  the example while the prose said not to.
- **Rule:** Pin the canonical host in the redirect and `proxy_set_header Host`, reject
  unknown Hosts with a default-server block, keep the ACME challenge route, send HSTS
  only from the 443 vhost, and state tool-version prerequisites (`http2 on;` needs
  nginx >= 1.25.1).
- **Prevents:** Copy-pasted "hardening" that enables host-header abuse or breaks
  certificate renewal.
- **Remove when:** Proxy configuration is generated and validated by a tested tool.

## 2026-11-06 — a header claim is per response helper, and a cross-link claim is a test

- **Failure avoided:** Documentation said "HTML pages carry `X-Frame-Options`", but the
  dashboard helper (`src/app/html.ts`) and the OAuth helper (`src/app/oauth.ts`) are
  separate constructors; only the dashboard sets XFO. It also claimed incident-response
  links from files that had none, and a status row kept naming the previous remote head.
- **Rule:** Scope shared-sounding security claims to the exact helper and page set, and
  treat every "linked from X" statement as a grep check against X. Prefer citing the
  source constant and the test that asserts it. Re-verify remote/base SHAs before
  recording them.
- **Test:** `grep -n "X-Frame-Options" src/app/*.ts docs/*.md` and
  `grep -n "incident-response.md" docs/*.md README.md`; the contract audit found both
  gaps.
- **Prevents:** A security property credited to pages that do not implement it, and
  navigation claims that silently rot.
- **Remove when:** Response construction is centralized and docs lint links/claims.

## 2026-11-06 — "configured" hardening must name the layer that provides it

- **Failure avoided:** A hardening checklist can be ticked by documenting only what the
  app serves, leaving readers to assume the app terminates TLS, limits IPs, or offers
  CORS. Those are proxy responsibilities here, and an unstated boundary becomes a
  deployment gap.
- **Rule:** For each clause (TLS, HSTS, per-IP limits, CORS, privacy contact), state
  whether it is application behavior, an authoritative proxy configuration, or
  operator-defined, and test only what the app owns. Keep the negative claim explicit
  ("no `Access-Control-*` headers", "no TLS listener", "no client IP stored").
- **Test:** `tests/integration/cors.test.ts` asserts the negative CORS claim on
  representative routes; the TLS/per-IP/contact clauses cite the runbook and privacy
  docs rather than pretending to be code.
- **Prevents:** A checkbox that implies protection the deployed system does not have.
- **Remove when:** Deployment validation can observe proxy and application behavior
  together.

## 2026-11-06 — a readiness probe must not borrow a lazily repairing accessor

- **Failure avoided:** `LocalBlobStore.get`, `put`, and `delete` call `#ensureDir`,
  which creates the blob directory. A readiness check implemented by reusing one of
  those would heal the very failure it is meant to report, so a missing directory
  would return `200 ready` after the probe silently recreated it.
- **Rule:** Readiness uses a separate non-mutating check (`stat` + `access`, no
  `mkdir`) and treats perfect absence as unavailable.
- **Test:** `tests/integration/readiness.test.ts` removes the directory and asserts
  `503 {"status":"unavailable"}` and that the probe did not recreate it (an existing
  directory is the separate `200` case).
- **Prevents:** A false "ready" from a probe whose own side effect repairs the
  dependency.
- **Remove when:** The blob port exposes an accessor whose documented contract is
  explicitly mutation-free and every backend implements it.

## 2026-11-06 — a checkbox is a claim; cite the evidence or leave it open

- **Failure avoided:** A reconciliation pass is tempted to tick a TODO box whose
  headline feature exists while a bundled clause does not (for example an AAD detail,
  a readiness endpoint, or an attachment path), or to treat a docs claim as executable
  evidence.
- **Rule:** Check a box only when every clause has a named test, doc section, or pushed
  commit, and record that citation in the `IMPLEMENTATION_STATE.md` reconciliation
  section. Leave a bundled item unchecked rather than weakening its wording, and name
  the missing clause.
- **Prevents:** Campaign state that overstates coverage and hides an unimplemented
  surface behind a green headline.
- **Remove when:** CI can map every TODO box to a required executable evidence artifact.

## 2026-11-06 — a durable scheduler needs the digest, not the cursor, as its dedupe truth

- **Failure avoided:** A one-shot Issue sync that used only a "last seen timestamp"
  cursor would miss a comment edited later or a comment whose page arrived out of
  order. A cursor written before the append would lose an ingested record on a crash;
  a cursor written after the append would re-ingest it if the append were not durable.
- **Reproducer:** With two comments sharing a `createdAt` but edited in the reverse
  order, timestamp-only cursors skip one. Killing the process between the digest
  append and the cursor rename reproduces the crash window.
- **Fix:** The append-only `digest.jsonl` is the source of truth. Records are keyed by
  `(comment databaseId, updatedAt)`; every pass rebuilds the seen set from the digest
  and writes the cursor afterwards with an atomic temp+rename. The cursor is
  observability, not dedupe state. A malformed digest or cursor fails closed instead
  of silently forgetting keys.
- **Test:** `tests/unit/issue-sync.test.ts` covers repeat passes, edits under a new
  `updatedAt`, in-batch duplicates, malformed digest/cursor, and lock exclusion.
- **Prevents:** Duplicate Issue ingestion after a crash or a restarted session, and
  missed edits that arrive out of order.
- **Remove when:** GitHub offers a monotonic per-comment version that can be trusted
  as the sole cursor without a local digest.

## 2026-11-06 — send only documented query parameters, and tie incremental reads to the durable dedupe store

- **Failure (query shape):** the pass sent `sort=updated&direction=desc` to the
  issue-comments endpoint, which documents only `since`/`per_page`/`page`. GitHub
  ignored the unsupported parameters and returned ascending comment-id order, so an
  issue with more than 500 comments kept returning its oldest 500 and a newly appended
  comment was never ingested while the pass still exited `0`.
- **Failure (read window):** Issue-comment `since` paging was derived from
  `cursor.json`'s `lastCommentUpdatedAt`, but the digest is the dedupe source of
  truth. Deleting a corrupt digest therefore left a stale cursor bounding the request:
  only comments newer than `lastCommentUpdatedAt - 5s` were re-queued, older history
  was silently skipped, and the pass still exited `0` while the recovery docs promised
  a full re-ingest. A global "digest is empty" check was also insufficient: an issue
  with no digest record inherited a stale `since` whenever another issue still had
  records. Separately, a page-cap partial read appended its records, so the next pass
  trusted a cursor for a range that had never been covered and exited `0`.
- **Reproducer:** point a fake `gh` at the pass and assert the comment query shape; it
  must contain only `per_page`/`page` (plus `since` when a real digest backs that
  issue) and no `sort`/`direction`. For the read window, seed a cursor with
  `lastCommentUpdatedAt` and either no `digest.jsonl` or a 0-byte one; the request
  carried `since` and only newer comments were ingested. For the partial read, give a
  first-sight issue 501 comments and observe its 500 fetched records in the digest.
- **Fix:** use documented parameters only (`since`/`per_page`/`page`). Choose the read
  window per issue from the durable store: only an issue with at least one digest
  record may use its cursor as a `since` bound; an issue with no digest record is read
  from the beginning even when other issues have records. The post-pass cursor write
  rebuilds timestamps from what was actually ingested. A bounded pass that reaches the
  page cap with a full final page does not append that issue's fetched records (they
  would make the next pass trust an incompletely covered range), still appends
  complete issues' records, writes no cursor, and exits `6`.
- **Test:** `tests/unit/issue-sync.test.ts` covers the exact comment query shape (no
  `sort`/`direction`), a 501-comment issue with a cursor, an edited older comment,
  a first-sight incomplete issue (its records stay out of the digest while a complete
  issue's records are appended), absent and 0-byte digests with a stale cursor (no
  `since`, all comments ingested, exit `0`, rewritten cursor), and per-issue first
  sight when another issue has digest records.
- **Prevents:** undocumented parameters silently producing a truncated descending
  window, recovery paths that report success while permanently skipping history, and
  a partial page-cap read seeding a cursor that hides the uncovered range.
- **Remove when:** the comments endpoint documents a reliable sort/order parameter, or
  the cursor no longer bounds a network read and the read window and the dedupe store
  are the same durable artifact.

## 2026-11-06 — discovery ordering and bodies are separate from ingestion

- **Failure avoided:** `gh issue list --state all --limit 50` does not state its
  ordering and, with `--json number,title,updatedAt,comments`, materializes every
  comment body into the fixed `gh` output buffer. A 32 MiB buffer can then overflow
  before the bounded per-issue comment pages are ever read, and "50 issues" was not
  provably the most recently updated window.
- **Reproducer / test:** Point a fake `gh` at the pass and assert the exact discovery
  invocation. The committed full-pass test requires
  `api repos/owner/repo/issues?state=all&sort=updated&direction=desc&per_page=50`
  and asserts the discovery arguments contain neither `comments` nor `--json`.
  Removing `sort=updated` makes the test fail (mutation-checked).
- **Fix:** Discovery is the REST issues endpoint, updated-descending, with a numeric
  `comments` count (`updated_at`/`comments` fields); pull-request records in that
  response are filtered out. Bodies are fetched only through the existing bounded
  `repos/<repo>/issues/<n>/comments?per_page=100&page=N` paging. A 60 s
  per-`gh` timeout plus `TimeoutStartSec=15min` bounds wall time.
- **Prevents:** An unordered window, buffer overflow on large comment histories, and
  a discovery call that silently ingests stale or duplicate pages.
- **Remove when:** a single GraphQL/REST query can return the ordered issue window
  and per-issue comment counts without bodies, with a documented pagination bound.

## 2026-11-06 — reclaiming a stale lock must never unlink blindly

- **Failure avoided:** The first reclaim path read the lock, checked the PID, and
  called `unlink(path)`; a different process could have replaced the stale lock with
  a live one between the check and the unlink, so the pass would delete a live lock
  and allow overlapping ingestion. The same pass also followed symlinked state paths
  and could leak a temp file when `write`/`fsync` failed.
- **Fix:** Reclaim renames the inspected lock to a unique `.stale-*` name, then reads
  the renamed file and proceeds only if it still carries the inspected token; on a
  mismatch it restores the file when the path is free and fails closed. A live lock
  is never deleted. The state directory and cursor/digest/log/lock paths are
  `lstat`ed and symlinks are rejected; `atomicWriteFile` wraps open/write/fsync/
  rename in one catch that unlinks the temp file.
- **Test:** `tests/unit/issue-sync.test.ts` covers stale-PID reclaim (new token,
  no `.stale-*` residue, release removes the lock), live-lock survival, symlinked
  state dir/cursor/log with sentinel files unchanged, and temp-file cleanup on a
  failed write and a failed rename.
- **Prevents:** Two concurrent passes after a crash, writing through a symlink
  outside the state directory, and accumulating `.tmp-*` files after a failed pass.
- **Remove when:** the platform offers an atomic compare-and-swap lock primitive and
  filesystem containment, rather than lstat/rename conventions.

## 2026-11-06 — systemd rate-limits successful one-shot starts too

- **Failure:** A `Type=oneshot` service with `StartLimitBurst=3` and
  `StartLimitIntervalSec=30min` refused the fourth manual start inside two minutes
  ("start of the service was attempted too often") even though all three previous
  runs exited `0`. Successful one-shot starts count toward the limit.
- **Reproducer:** `systemctl --user start corkboard-issue-sync.service` three times,
  then a fourth within the interval; the fourth fails before `ExecStart`.
- **Fix:** Do not put a start-rate limit on a timer-driven one-shot that the operator
  may also run manually. The hourly timer plus `Persistent=true` is the retry
  mechanism; a failure stays visible in `status`/journal. Recover with
  `systemctl --user reset-failed <unit>` if a limit was ever configured.
- **Prevents:** A correct sync pass being blocked by an earlier success, and an
  auto-restart storm hidden behind a rate limit.
- **Remove when:** systemd stops counting successful starts, or the unit gains a
  genuinely different retry design.

## 2026-11-06 — rotation must copy stored grants, not re-derive them

- **Failure avoided:** A `rotate-key` built as "revoke, then call `issue-key` with the
  same projects and scopes" is not atomic (a crash between the two leaves no usable
  credential) and can widen or narrow access if it re-derives the project list or
  scopes instead of copying them. A default of `expires_at = NULL` would silently
  extend a finite credential's lifetime, and a default that silently copied a
  near-expiry timestamp without saying so would surprise the operator.
- **Reproducer:** With one credential granted only to project A and scopes
  `project.read,message.read`, a re-issue path that uses the speaker's current
  memberships would also reach project B after a later `add-member`; the copied-grant
  path leaves B denied. Rotating without an explicit expiry on a credential expiring
  in one hour shows the choice.
- **Fix:** `rotate-key` reads the old row and its grants inside one
  `BEGIN IMMEDIATE` transaction, inserts the replacement credential and exactly those
  grant rows, then sets the old `revoked_at` in the same transaction. Failures roll
  back all three writes. Unknown/revoked/expired/inactive-principal credentials are
  rejected before any write. OAuth-issued access credentials are rejected too: a
  replacement row would drop the `oauth_token_clients` association and bypass refresh
  rotation/revocation, so those stay on the OAuth flow. Without `--expires-at`, the old `expires_at` is copied
  exactly (including `NULL`), and the reference docs state that a near-expiry key stays
  near expiry unless a future `--expires-at` is passed.
- **Test:** `tests/integration/cli.test.ts` "rotate-key atomically replaces a
  credential with identical scopes and grants" (old token 401, new token accepted only
  on the two granted projects, audit has no token/prefix/verifier), plus rejection,
  rollback, expiry-default (including `NULL` staying `NULL`), OAuth/invalid-stored-
  expiry/inactive-owner, and concurrent-double-rotation tests. Injected triggers on
  grant insert and old-row revocation prove the old token remains active after a
  failed rotation; the concurrent test proves `BEGIN IMMEDIATE` serializes the pair
  so exactly one replacement commits.
- **Prevents:** Non-atomic replacement, silent privilege widening through membership
  re-derivation, accidental lifetime extension, and orphan credentials/grants.
- **Remove when:** issuance and rotation share a documented replacement primitive that
  copies stored authorization exactly, or a D1 adapter provides the read snapshot this
  read-then-write transaction needs.

## 2026-11-05 — reject symlinked secrets and test shell boundaries against the real script

- **Failure avoided:** `[ -e ]` follows symlinks, so a secrets path that was a
  symlink to a `0600` file passed the regular-file and mode checks; a broken
  symlink looked absent and was allowed. A quickstart that creates the secrets
  directory as a non-UID-1000 account (`install -d -m 0700`) leaves the container
  identity unable to traverse or write it.
- **Fix:** check `[ -L ]` before `[ -e ]` and fail closed; document "regular file,
  not a symlink". Create the directory as `1000:1000` with traversable ancestors,
  using `/srv` rather than a private home for the non-UID-1000 case.
- **Test:** `tests/unit/docker-entrypoint.test.ts` copies the real
  `scripts/docker-entrypoint.sh` and redirects only its fixed path constant to a
  temp directory, then executes it. It covers absent, `0600`, `0644`, directory,
  symlink, broken symlink, and unreadable inputs, and asserts a sentinel value
  never appears in stdout/stderr. Removing the mode check makes it fail.
- **Prevents:** symlink substitution of the secrets file and silent regressions in
  the entrypoint boundary.
- **Remove when:** the entrypoint is replaced by Compose `secrets:` with
  equivalent guarantees, or the negative suite is ported to the replacement.

## 2026-11-05 — re-check provenance when registry access is intermittent

- **Failure:** Docker checkpoint text claimed the real `node:24` base had never been
  pulled and that every recorded output came from a locally assembled stand-in
  (`node:22-bookworm-slim` + host Node 24.22.1 + npm 10.9.9). That was wrong: the
  official `node:24` image was present locally, with Node 24.22.2, npm 11.19.1,
  Debian bookworm, and digest
  `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`; the
  retained build layers show the recorded runs used it. Intermittent registry
  timeouts made the wrong attribution plausible, and it was almost shipped in the
  docs, state, and a commit trailer.
- **Reproducer:** `docker image inspect node:24` showed the official image, its Node
  and npm versions, and that digest; `docker pull node:24@sha256:01d5...` resolved to
  the same image.
- **Fix:** Pin that digest in both Dockerfile stages, rebuild, re-run the full smoke
  on the pinned base, and correct every provenance sentence. The durable lesson is
  narrower: because registry access was intermittent, provenance claims must be
  re-checked against the local image and digest before they are published.
- **Prevents:** Publishing evidence whose base image, npm version, or Debian layer is
  attributed to the wrong image.
- **Remove when:** Docker provenance is captured directly in CI from the pinned digest.

## 2026-11-05 — `docker compose run -v` cannot relax a service's read-only bind

- **Failure avoided:** The one-shot `init` needs to create the secrets file in the same
  host directory the running service mounts read-only. `docker compose run --rm -v
  "$DIR:/run/secrets" ...` looks like a per-run override, but it did not replace the
  service's `:ro` bind: the container kept the read-only mount and `touch
  /run/secrets/x` failed with `Read-only file system`.
- **Reproducer:** A service whose only `/run/secrets` mount is `type: bind, read_only:
  true`, then `docker compose run --rm -v DIR:/run/secrets IMAGE sh -c 'touch
  /run/secrets/x'`.
- **Fix:** Keep the service mount read-only and mount the same host directory at a
  second, unused target read-write for the one-shot command
  (`-v DIR:/run/secrets-rw`, `--secrets-file /run/secrets-rw/corkboard.env`). The file
  appears on the host and the service reads it through the original read-only mount.
- **Also confirmed:** Docker initializes an empty named volume from the image path,
  preserving that directory's ownership and mode. Creating `/data` as `1000:1000`
  mode `0700` in the image lets a non-root container write the volume without a host
  `chown`.
- **Prevents:** A documented init path that only works with a writable secrets mount,
  and data-volume instructions that require root-owned host setup.
- **Remove when:** Compose replaces a service's bind on a same-target `run -v`, or the
  CLI can read the secrets file directly.

## 2026-11-05 — A global option can parse successfully and still be ignored

- **Failure avoided:** The CLI's option table is global, so `--data-dir` parses for every
  command. But the in-database provisioning commands (`bootstrap-owner`,
  `create-project`, `create-speaker`, `add-member`, `remove-member`, `issue-key`,
  `grant-key-project`, `revoke-key-project`, `revoke-key`) never read
  `values["data-dir"]`; they call `withDb` with no override, which requires
  `CORKBOARD_DATA_DIR` in the environment. An operator who runs
  `bootstrap-owner --data-dir /var/lib/corkboard` gets either a `CORKBOARD_DATA_DIR is
  not set` error or, worse, silently provisions a different directory that happens to be
  in the environment. The CLI also has no `--help`; `--help` is an unknown option.
- **Decision:** The runbook states the required environment export for provisioning
  commands, shows `--data-dir` only for `init`, `expire-bodies`, `prune`, `doctor`,
  `backup`, and `restore`, and says to confirm flags against the no-argument usage line
  and the source, not a presumed `--help`.
- **Reproducer / test:** Source a secrets file with `CORKBOARD_DATA_DIR` removed, then
  run `bootstrap-owner --email x@example.test --data-dir <dir>`; it fails with
  `CORKBOARD_DATA_DIR is required` rather than using `<dir>`. `node
  dist/scripts/corkboard.js --help` exits `1` with `Unknown option '--help'`.
- **Prevents:** Writing operational instructions from the global option table instead
  of each command's actual code path, and presenting a silently ignored flag as working.
- **Remove when:** The CLI gives each command its own option set (or rejects
  command-inapplicable options) and implements `--help`.

## 2026-11-05 — A length limit is not a content rule; blank text passes both grapheme and byte caps

- **Failure:** Real-browser evidence at `2a17a75` (Issue #6) showed a message whose
  summary and body were only spaces committed successfully on every surface. The
  shared validators checked only grapheme counts and UTF-8 byte caps, so a
  whitespace-only value satisfied "1–140" and "1–2000". Project titles were already
  protected by a separate blank check, which hid the gap for message content.
- **Fix:** Message summary and text are checked by message-specific wrappers,
  `validateMessageSummary`/`validateMessageText`, which call the length-only
  `validateSummary`/`validateText` and then reject a blank value with
  `VALIDATION_ERROR` ("summary must not be blank" / "text must not be blank").
  Blank means only Unicode `White_Space` and/or `Default_Ignorable_Code_Point`
  characters, so it covers ordinary whitespace plus NBSP, NEL, ideographic space,
  ZWSP, ZWJ/ZWNJ, word joiner, variation selectors, and BOM; any character outside
  those categories makes the value non-blank (for example U+2800, non-whitespace
  controls, or a
  lone combining mark). The check runs in addition to, and after, the existing
  length checks, so an over-limit blank value still reports the length error first.
  Values are rejected, never trimmed or normalized; internal spaces and newlines
  remain valid and stored as entered. Because REST, MCP, and the dashboard all call
  `sendMessage`, one change covers every surface. The wrappers are deliberately
  message-only: project title/summary keep their base `trim()`-based behavior and
  `validateSummary` stays length-only. The service validates before its
  replay/resume decision, so a historically blank payload cannot be replayed with
  its old key.
- **Reproducer / test:** Unit tests cover spaces/tabs/newlines-only values plus
  NBSP, U+3000, U+FEFF, NEL U+0085, ZWSP U+200B, and an all-default-ignorable
  string, assert the grapheme and UTF-8 byte errors take precedence (a
  U+E0100 selector run is one grapheme but 8196 bytes), and assert a lone combining
  mark and U+2800 are accepted. A project-metadata test pins the base behavior:
  ZWSP-only title/summary remain accepted, a `trim()`-blank title reports the title
  field, and a `trim()`-blank summary is `NULL`. REST, MCP, and dashboard POST tests
  reject blank message values and capture message/idempotency/blob/audit counts
  before and after to prove no write; acceptance tests send `"a b"` and multi-line
  content through REST, MCP, and the dashboard.
- **Prevents:** Treating a size bound as a required-content rule, equating "blank"
  with ASCII spaces only, calling the rule visual-blank detection (it is a
  Unicode-category test), and leaking a message rule into project metadata by reusing
  a shared length validator.
- **Remove when:** A shared content-policy helper covers every text field and the
  per-validator check becomes redundant.

## 2026-11-05 — A tenant aggregate must start from the authorized row set, not from a global count

- **Failure avoided:** An overview page invites `SELECT COUNT(*) FROM projects` or
  process-global traffic/error counters. Either would disclose another tenant's
  existence or volume, and a per-tenancy claim built on a global number is simply
  false. The same page also invites rendering `audit_events.detail`, which is
  sanitized by convention but is not needed for a summary and can grow with future
  call sites.
- **Decision:** Derive the project set from the existing session `listProjects`
  (the same readable, non-removed membership set as the dashboard), bound it to the
  API maximum, and aggregate message counts/storage/audit rows only over those IDs.
  Budget queries: one grouped message aggregate, one grouped storage aggregate, one
  credential-state read, one account-actored audit read (`LIMIT 20`), and one audit
  read per ≤49-project chunk (up to four queries at the 100-project cap), merged and
  deduplicated by event `id` then re-sorted. Audit selects only `id` (the internal
  dedup key, never rendered), `created_at`, `operation`, `outcome`, and `project_id`,
  and hides a project ID outside the authorized set. Chunking keeps the audit queries
  at ≤49 parameters, and no query exceeds D1's 100-parameter limit; the literal
  `LIMIT 20` also avoids a bound parameter
  there. Credential states reuse `credentialState` from the
  inventory instead of re-deriving revoked/expired/unknown. Where no per-tenant
  source exists (traffic, errors), say so; never substitute a global metric.
- **Reproducer / test:** Seed two tenants with projects, messages, credentials, and
  audit rows; log in as one and assert the other tenant's title, project ID,
  operation, and credential do not appear, and that an audit `detail` value never
  reaches the page. `tests/integration/overview.test.ts` also covers the 20-event
  cap, empty states, en/zh, bearer rejection, revoked-session redirect, and the real
  Node adapter path.
- **Prevents:** Cross-tenant disclosure through aggregates, presenting global
  process metrics as tenant data, and audit-detail leakage into a summary page.
- **Remove when:** A tenant-scoped traffic/error counter exists with its own
  authenticated contract, or the overview moves to a reviewed analytics service with
  the same isolation tests.

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
  selects non-secret metadata (ID, timestamps, revoked state, scope identifiers, and
  grant rows); the token, prefix, and verifier are never selected or rendered, and
  the inventory page renders neither the prefix nor the scope identifiers. Revocation
  is a soft `revoked_at`
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

## 2026-11-05 — read authorization is not a send authorization

- **Failure:** Recycling the dashboard's `authorizeProject` session branch for
  message send would have required adding `message.send` to the branch that every
  read/edit route uses. The branch deliberately returns only the requested scope and
  refuses send/receipt/member capabilities; widening it would let any future session
  route that asks for `message.send` inherit send authority.
- **Fix:** A dedicated `authorizeSessionSend` path re-checks the selected speaker's
  ownership, active account/speaker/project, non-removed membership, and
  `message.send` capability. `sendMessage` dispatches to it only when
  `sessionViewer === true`; bearer principals keep their existing decision. The
  publication path folds the session check into the finalize `UPDATE`.
- **Prevents:** A read-viewer principal authorizing a write, and a bearer credential
  entering a session-only write path.
- **Remove when:** There is one reviewed policy engine that expresses every actor,
  scope, and resource relation without per-route branches, with tests proving the
  session read branch still cannot write.

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

## 2026-11-05 — git only parses the last contiguous trailer block

- **Failure:** A checkpoint message with a multi-line `Tests:` value whose
  continuation lines are unindented, or a blank line
  between `Tree-SHA` and `Co-Authored-By`, silently breaks `%(trailers)` and
  `git interpret-trailers`. The human-readable trailers were present, but tooling and
  the independent audit could not read them, so the exact-revision checkpoint gate
  was not machine-verifiable. Recent pushed commits (`f7e62be`, `dbb2a46`,
  `1dfa284`) share the defect; `058e34f` and later parse cleanly.
- **Reproducer:** `git log -1 --format='%(trailers:key=Tree-SHA,valueonly)' <commit>`
  returns empty when the trailer paragraph is interrupted by an unindented
  continuation line or a blank line before `Co-Authored-By`.
- **Fix:** Keep `Base-SHA`, `Candidate-SHA`, `Tree-SHA`, `Tests`, and
  `Co-Authored-By` in ONE final paragraph with single-line values; put prose above a
  blank line. Verify with `%(trailers:key=Tree-SHA,valueonly)` before pushing.
- **Prevents:** A checkpoint whose provenance looks present in prose but is invisible
  to tooling, and a re-audit loop over a mechanical formatting defect.
- **Remove when:** CI enforces the trailer schema on every pushed commit.

## 2026-11-05 — a byte cap can hide behind the grapheme cap

- **Failure:** The first 8 KiB text-boundary plan used `"x".repeat(8192)`. That
  payload is rejected by the 2000-grapheme rule first, so it never exercises the
  8192-byte branch; a soak asserting only "rejected" would have passed while
  testing the wrong limit. Assuming at most four UTF-8 bytes per grapheme (as the
  first plan did), 2000 graphemes reach only 8000 bytes, so the byte cap looks
  unreachable; wider clusters such as a pair of regional indicators are 8 bytes.
- **Reproducer:** `"x".repeat(8192)` returns `VALIDATION_ERROR` for graphemes; 1024
  flag clusters (two regional indicators, 8 bytes, one grapheme) are 8192 bytes and
  1024 graphemes and are accepted; adding one ASCII byte makes 8193 bytes and is
  rejected by the byte cap.
- **Fix:** Build boundary text from a single grapheme that is wider than one byte.
  `scripts/soak.ts` exports `maxBoundaryText`/`overBoundaryText`, and the unit test
  asserts both the byte and grapheme counts.
- **Prevents:** A boundary test that passes by tripping a different validator than
  the one it claims to cover.
- **Remove when:** Validation has a documented single length limit, or a byte-first
  ordering that makes the two limits independently reachable.

## 2026-11-05 — a parsed flag is not a wired flag

- **Failure:** `parseSoakArgs` validated `--messages`, `--concurrency`,
  `--expiry-messages` and `--rate-limit-requests`, and the unit test asserted the
  parsed config, but `runSoak` read only `PROFILE_PLANS[config.profile]`. Every override
  was silently ignored. Separately, `startServer` installs process-wide `SIGINT`/
  `SIGTERM` handlers that call `process.exit(0)`, so signalling a failing soak run
  could still exit 0.
- **Reproducer:** `node scripts/soak.ts --profile quick --messages 3 --concurrency 1
  --expiry-messages 1 --rate-limit-requests 6` still reported 200/8/20/12; `SIGINT` on
  a `--profile full` run exited 0.
- **Fix:** Merge the four flags over the profile in one `effectivePlan(config)` helper
  and test the merged plan, not only parsing; register harness-owned signal handlers
  immediately after the temp directory exists and exit `130`/`143`.
- **Prevents:** Flags that look supported because parsing passes, and a library signal
  handler masking the runner's failure exit code.
- **Remove when:** Soak config has no separate parse/apply boundary, or the server stops
  installing process-wide signal handlers.

## 2026-11-05 — a CLI eligibility rule is not automatically a dashboard rule

- **Failure:** The CLI `grant-key-project` requires only an active speaker
  membership for the grant. Mirroring that rule alone in the dashboard would offer
  and allow a project the session account cannot read: a speaker can be an active
  member of a project while no speaker owned by that account has `project.read`
  there (for example a membership carrying only `message.read` or `message.send`).
  The form would advertise a project the human cannot inspect, and the write would
  succeed without any account-read authority behind it.
- **Reproducer:** project P, speaker S owned by account A is an active member with
  only `message.read`, and no other A-owned speaker is a member. The CLI predicate
  passes, but `resolveSessionViewer(A, P, "project.read")` is `NOT_FOUND`. The slice
  test `credential grant routes deny foreign, unreadable, and ineligible targets
  uniformly` covers this (proj_c) and the inverse case (proj_e: account-readable via
  another speaker, but the target speaker is not a member).
- **Fix:** The dashboard candidate set is the speaker's active memberships
  intersected with the account-readable project set; the write transaction re-reads
  both predicates, and every ineligible target is the uniform `404`. The UI hint and
  `docs/web-ui.md` state the rule.
- **Prevents:** A grant form that reveals or grants into a project the account cannot
  read, and a hidden authorization widening behind a UI convenience.
- **Remove when:** one exported authorization helper serves both the CLI and the
  dashboard and its predicate is documented as the grant rule.

## 2026-11-05 — "CLI-only" is a false claim when no CLI path exists

- **Failure:** the grant-UI candidate said rotation and expiry selection "remain
  CLI-only" while the CLI has no rotate command or service path. It also implied
  that grant add and remove re-check the same predicates: removal deliberately
  checks only speaker ownership/status and credential state so a stale grant stays
  removable after membership loss. The D1 read-then-write debt list omitted the two
  grant callbacks and the add route's `?grant=added|exists` outcome, which depends
  on an in-transaction `changes` count a batch-emulated D1 result cannot supply.
- **Reproducer:** `grep -n "rotate" scripts/corkboard.ts` and the CLI usage
  string list no rotate command; the acceptance report and runbook already
  stated rotation is unimplemented; `tests/integration/speakers-web.test.ts`
  test "a stale grant remains removable after the speaker loses the project
  membership" seeds a grant, removes the speaker's membership, asserts add is
  the uniform `404`, then asserts remove returns `303`, deletes the grant row,
  and writes a `credential.project.revoke` audit.
- **Fix:** say rotation is unimplemented in every surface (revoke-then-issue is the
  replacement), name per-credential expiry selection as CLI-only at issuance, and
  state dashboard message-expiry management as unimplemented (body expiry on send
  is the only expiry UI). Restrict the membership/read re-check claim to add and
  state the remove rule explicitly. List grant add/remove in every current D1 debt
  enumeration with the `changes`-count caveat.
- **Prevents:** documentation that promises an operator action that would fail, and
  a security review that assumes symmetric authorization where asymmetry is the
  intended behavior.
- **Superseded (2026-11-06):** an atomic rotate path now exists
  (`rotate-key` / `rotateSpeakerCredential`); the rotation half of this entry's
  removal condition is met and the stale claim is pruned. The D1 half remains open.
- **Remove when (remaining):** a D1 adapter documents how it supplies snapshot reads
  and affected-row counts for read-then-write callbacks.

## 2026-11-06 — a rejected dangling reference is not a missing-object read test

- **Failure:** TODO 334 listed "missing object" next to the crypto negatives, and the
  only committed "missing" coverage was a schema contract test proving that a
  `messages.body_object_id` foreign key rejects a reference to a nonexistent
  `body_objects` row. That proves the FK works, not that a committed message whose
  ciphertext has disappeared fails closed at the service read path. The ready-message
  path could have returned content or skipped the receipt guard and the FK test would
  still pass.
- **Reproducer:** delete a committed message's blob through `BlobStore.delete` while
  leaving its `body_objects` row and `ready` state. Before this checkpoint no service
  or HTTP test asserted `INTEGRITY_FAILURE`, no receipt, and failure audits for that
  state. A scratch mutation that returns empty plaintext instead of failing closed now
  fails `a missing ciphertext blob on a committed message fails closed with no content
  or receipt` with "Missing expected rejection".
- **Fix:** add the service-level test that starts from a real `sendMessage` result,
  deletes only the ciphertext with the supported storage port, keeps metadata
  list-visible as `ready`, and asserts both `getMessageBody` and `markRead` reject with
  `INTEGRITY_FAILURE`, write no receipt, and audit `message.body.read` /
  `message.receipt.write` as failures. The FK contract test stays as schema evidence.
- **Prevents:** treating "the foreign key rejects it" as proof of runtime fail-closed
  behavior, and a missing-object regression hiding behind green crypto/FK tests.
- **Remove when:** a storage lifecycle API can deterministically remove a committed
  object row (with its message transition) and the test covers that branch too.

## 2026-11-06 — a durable cursor follows confirmation, not intent

- **Failure:** an at-least-once poller can silently lose a message if it advances its
  durable `after_seq` cursor when it *sends* `mark_read` (or after processing) rather
  than after the server's confirmed outcome (a receipt or a definitive
  `410 BODY_EXPIRED` tombstone). A lost response leaves the client unsure
  whether the server recorded the receipt; advancing would skip the message forever.
  The same reference client also risks leaking its bearer credential if it prints an
  untrusted summary verbatim: a hostile or buggy message can echo the token back into
  a terminal or log.
- **Reproducer:** `tests/unit/poll.test.ts` "an uncertain mark_read is retried with
  the same request and reprocesses on restart" runs three failed attempts for seq 1,
  asserts the cursor file did not advance, then runs a second pass from seq 0 and
  asserts the consumer saw seq 1 twice. "the credential is never printed, logged, or
  placed in a URL" returns a summary containing the token and asserts stdout/stderr
  and every request URL exclude it.
- **Fix:** a message's cursor advance is written after `POST .../read` returns `200`
  naming the requested `message_id` and the `/me` speaker. The sole other advance is
  the definitive `410 BODY_EXPIRED` tombstone, which can never produce a receipt.
  Network/`429`/`5xx` retries repeat the identical idempotent POST; any other
  definitive rejection, or an exhausted retry, leaves the cursor unchanged. Cursor
  replacement is an atomic `0600` temp-file + fsync + rename bind to
  `(project_id, speaker_id)`. Every emitted line is redacted, with raw fields redacted
  before JSON/terminal escaping; `--show-summary` prints metadata only. Dedupe on
  `message_id`/`(project_id, seq)` is documented as consumer-owned.
- **Prevents:** treating a sent request as a committed acknowledgement, losing a
  message across a crash or lost response, and leaking a credential through untrusted
  message metadata.
- **Remove when:** the consumer's acknowledgement and its durable cursor are one
  storage transaction owned by the consumer, rather than an ordered pair of a remote
  idempotent POST and a local cursor file.

## 2026-11-06 — an abort lifetime that ends at headers does not bound a body

- **Failure:** The first polling client cleared its request timeout/abort
  controller in `finally` as soon as `fetch()` resolved headers, then called
  `response.json()`. A server that sent headers and stalled the body could hang the
  client forever past the documented 15-second deadline, and the parsed body had no
  byte cap. The same applied to error-body parsing.
- **Reproducer:** `tests/unit/poll.test.ts` "a stalled response body is aborted at
  the request deadline" returns a stream that never ends; the client rejects with
  `TIMEOUT` at a 30 ms deadline. "a signal during a body read stops the client
  without advancing" aborts mid-stream and asserts a clean stop. "an oversized body
  fails closed, including an error body" proves the cap for a success and an error
  response.
- **Fix:** Keep the scoped controller and timer live until the body is fully
  consumed, and stream every body through a hard 1 MiB cap. Aborting the controller
  cancels the stream, so a stalled body rejects. `Content-Length` is never trusted;
  identity, list, `mark_read` success, and error bodies all use the same reader.
- **Prevents:** A header-then-stall server holding a client forever and unbounded
  response materialization.
- **Remove when:** the runtime supplies a body-read deadline/limit primitive with
  equivalent semantics and the client delegates to it.

## 2026-11-06 — redact before escaping, and never interpolate an unescaped server code

- **Failure:** Server-derived `error.code` values were interpolated into stderr
  without terminal escaping, so a hostile server could inject ESC/control sequences
  into an operator's terminal. Escaping first would also break redaction of a
  credential that itself contains control characters, because the escaped form no
  longer matches the raw credential.
- **Reproducer:** `tests/unit/poll.test.ts` "server error codes are redacted and
  terminal-escaped" returns an error code containing ESC and the token, then asserts
  stderr has no raw ESC, includes the `\u001b` escape, and contains `[REDACTED]`.
  "control and bidirectional summary characters are escaped in output" checks the
  summary path, and "a control-character credential echoed in a summary is redacted"
  proves raw-field redaction happens before escaping.
- **Fix:** Redact raw field values before JSON/terminal escaping, then sanitize the
  assembled line again at the output boundary. Line-level redaction after escaping is
  insufficient: escaping hides a credential that contains a control character from the
  redactor. A second test echoes a control-character credential in a summary and
  asserts the printable prefix and the raw control character are absent.
- **Prevents:** Terminal escape injection through server metadata and credential
  leakage through an escaped spelling.
- **Remove when:** one shared output sink enforces redact-then-escape for every log
  and terminal write.

## 2026-11-06 — an unacknowledgeable tombstone must not wedge the cursor

- **Failure:** An at-least-once poller that refuses to advance on `410 BODY_EXPIRED`
  wedges forever: the server can never create a receipt for an expired body, so every
  restart retries the same message and re-invokes the consumer.
- **Reproducer:** `tests/unit/poll.test.ts` "a body GET 410 BODY_EXPIRED advances
  without a receipt while other body GET failures do not" returns `410 BODY_EXPIRED`
  and asserts the cursor advances; the same test asserts `401`/`403`/`404`, `429`, and
  other definitive failures do not advance. A separate test, "a mark_read 410
  BODY_EXPIRED after a verified body advances without a receipt", covers the
  body-fetch-succeeds / `mark_read`-expiry race.
- **Fix:** Treat only the server's definitive `410` + `BODY_EXPIRED` as a consumed
  metadata tombstone: log an escaped status, advance the cursor, and create no
  receipt. Any other rejection or transient failure keeps the cursor unchanged.
- **Prevents:** One expired row permanently blocking a project, and silently skipping
  a message whose acknowledgement might still succeed.
- **Remove when:** the service offers an explicit "unreadable tombstone" outcome or a
  consumer-owned transactional cursor that records the decision.

## 2026-11-06 — trailer SHAs have types; verify the type before committing

- **Failure:** The pushed docs/state tail `3a03613` recorded `Tree-SHA:
  6b40b94afa11b3563ea1804cff6eb8ae29ed9951` and `Candidate-SHA:
  d33409df9398a422f81590b107310e53ada6a116`. Both nine-hex prefixes look alike, but
  the tree is `d33409d…` and `6b40b94…` is the pre-amend candidate commit. The tail
  cannot be corrected in place without a forbidden force-push.
- **Reproducer:** `git log -1 --format=%B 3a03613 | git interpret-trailers --parse`
  shows the swapped fields; `git rev-parse 3a03613^{tree}` returns `d33409d…` while
  `git cat-file -t 6b40b94` returns `commit`, and `git rev-parse 6b40b94^{tree}` is
  also `d33409d…`.
- **Fix:** Record an explicit correction note with both correct values and leave the
  pushed commit untouched. Going forward, verify each trailer's type before
  committing: `git write-tree` / `git rev-parse HEAD^{tree}` for `Tree-SHA`,
  `git write-tree` output for a staged tree, and `git rev-parse HEAD` before a
  message-only amend for `Candidate-SHA`; check `git cat-file -t <sha>` when a value
  could be either.
- **Prevents:** Swapping a tree hash and a commit hash in a trailer, and discovering
  it only after the commit is pushed and immutable under the campaign's no-force-push
  rule.
- **Remove when:** a local commit hook or release script validates that `Tree-SHA`
  names a tree and `Candidate-SHA` names a commit with that same tree.

## 2026-11-06 — source maps make the output directory's depth part of the artifact

- **Failure avoided:** A "compile twice into two temporary directories and diff"
  proof looks path-independent, but `tsconfig.build.json` emits source maps. Each
  `.js.map` `sources` entry is the relative path from the map to the source file, so
  equal inputs compiled into `/tmp/x/a/` and `/tmp/x/deep/nested/` produce different
  maps. A naive harness reports a false non-reproducibility, or a false pass if both
  runs happen to share one directory.
- **Reproducer:** Compile with `tsc -p tsconfig.build.json --outDir /tmp/t/shallow`
  and `--outDir /tmp/t/deep/nested`; any `.js.map` differs in `sources`
  (`../../../../…` versus `../../../../../…`) with no source change.
- **Fix:** `scripts/reproducible-build.ts` puts the two output directories as siblings
  at the same depth under one temporary parent and compares only those.
  `docs/supply-chain.md` scopes the proof to the same output depth and states that a
  `dist/` build is not byte-identical to the temporary builds.
- **Prevents:** Claiming byte reproducibility across output locations, or failing a
  deterministic build because the comparison harness itself moved the output.
- **Remove when:** the build stops emitting path-bearing files (for example
  `sourceMap: false` or a fixed `sourceRoot`) or the proof normalizes paths explicitly.

## 2026-11-06 — a proof that re-implements the build measures the re-implementation

- **Failure avoided:** The first reproducibility harness duplicated the real build
  steps (`tsc -p tsconfig.build.json` plus a `cpSync` of `migrations/`) instead of
  calling them. A later change to `npm run build` could then leave the proof green
  while the shipped build differed, and documentation calling it "the real build
  invocation" would be false.
- **Reproducer:** Compare `package.json`'s `build` command with the harness's private
  commands after changing one of them; the strings drift with no failing test.
- **Fix:** `scripts/build.ts` is the single definition of the production build
  (`compileProject` + `copyMigrations`). `npm run build` runs it and
  `scripts/reproducible-build.ts` imports it, so the proof cannot compile a different
  pipeline.
- **Prevents:** A green reproducibility check for a build that is not the one shipped.
- **Remove when:** the build system emits a manifest or command definition that both
  paths consume directly.

## 2026-11-06 — an atomic predicate must include the principal it authenticated with

- **Failure avoided:** The session-send publication `UPDATE` carried the speaker,
  account, project, and membership predicate but not the `sessions` row. A logout or
  session revocation landing after request authentication and before finalization
  could therefore still publish a message. Separately, an idempotency replay loaded
  the recorded message by id alone; a row repointed out of band at another speaker's
  message returned that speaker's metadata instead of failing closed.
- **Reproducer:** With an injected blob-store seam, revoke the session after `put`
  and before finalization; the old predicate committed the row. Repoint
  `idempotency_keys.message_id` at a same-project message owned by another speaker
  and re-send the same key/payload; the old replay path returned it.
- **Fix:** Fold the active session row (revoked/absolute-expiry/idle/account status)
  into `FINALIZE_SESSION_SQL`, carried by a server-set `Principal.sessionId`; and
  compare `messages.sender_speaker_id` with the authenticated speaker before any
  idempotency replay or resume.
- **Prevents:** A "fail closed" claim that covers storage state but omits the session
  or credential that authorized the request, and replay paths that trust a stored
  object id without re-checking ownership.
- **Remove when:** a single authorization object is bound into every atomic write and
  every replay lookup, so these predicates cannot drift apart.

## 2026-11-06 — a preview override must replace, not append, the base port and volume lists

- **Failure avoided:** Compose merges most sequences by appending. An override that
  only adds a preview port or volume leaves the base production port, data volume, or
  secrets bind in the merged stack, so a "preview" can publish or mount production
  objects. The base `${CORKBOARD_SECRETS_DIR:?}` also fails interpolation before the
  merge even when the override would replace it.
- **Reproducer:** `docker compose -f compose.yaml -f compose.preview.yaml config`
  without `!override` shows both `127.0.0.1:8787` and the preview port (or the
  production volume), and interpolation fails when only the preview variable is set.
- **Fix:** `compose.preview.yaml` uses service-level `ports: !override` and
  `volumes: !override`, plus top-level `volumes: !override`, with a distinct Compose
  project name, explicit preview volume name, and required preview secrets directory.
  The operator procedure points `CORKBOARD_SECRETS_DIR` at the preview path solely so
  the base file interpolates; the override discards that mount.
- **Prevents:** A preview inheriting production port publishing, data, or secrets, and
  a reviewer having to infer isolation from a merged file that still contains both.
- **Remove when:** the base compose is parameterized so an override cannot inherit
  production values, or Compose offers a merge mode that replaces sequences by
  default.

## 2026-11-06 — a "never print the secret" example needs a scan and an error-path test

- **Failure avoided:** An integration example can pass review while a copied
  credential literal, a literal after `Bearer `, or an unredacted error path leaks
  the key later. Examples also drift when they copy the reference client instead of
  importing it.
- **Reproducer:** Add a `cb_`-shaped literal or a literal bearer value to any file
  under `examples/`, or make `safeErrorMessage` return `error.message` without
  redaction; the scan and helper tests fail respectively.
- **Fix:** `tests/unit/agent-integration.test.ts` runs the repository's
  `findSecrets` over the example directory plus a literal-bearer check, and tests
  environment-only loading and error redaction; `poll-consume.ts` imports
  `scripts/poll.ts` rather than reimplementing the list/body/receipt/cursor loop.
- **Prevents:** A credential leaked through example content or output, and an
  example that no longer demonstrates the shipped poller.
- **Remove when:** examples are generated from a single credential-safe template
  whose output is scanned automatically.
## 2026-11-06 — a persisted cursor binds identities, not a data directory

- **Failure avoided:** A disaster rehearsal can easily "prove" cursor resync by
  replaying from zero and then assert the stored cursor still works, without checking
  what actually binds it. The durable cursor contains `project_id`, `speaker_id`, and
  `after_seq`; it contains no data-directory path. After a restore into a new
  directory the same identities make the old cursor valid, and reusing it for another
  project or speaker must be rejected rather than silently trusted. A rehearsal that
  seeded with a test-only `serviceId` would also fail to decrypt restored bodies
  because the service id is bound into the body AAD, so the drill must use the
  production `corkboard` service id and the separately backed-up key material.
- **Reproducer:** Write a cursor for `(project A, speaker A)`, then `loadCursorState`
  it as `(project B, speaker A)` or `(project A, speaker B)`; the parser rejects it.
  Seed a body with `svc_test` and read it with `corkboard`; decryption fails closed.
- **Rule:** Assert the binding that exists, not a path that does not. Rehearse
  from-scratch `after_seq` replay, no duplicate receipts on re-replay, same-identity
  cursor acceptance, and cross-project/speaker rejection. Use the production service
  id and the real key pair in every restore read.
- **Prevents:** A recovery drill that silently trusts a stale cursor or reports a
  false body-decryption failure caused by a test-only encryption context.
- **Remove when:** the cursor format carries an installation identifier and the
  service id/key version is derived from persisted, restorable state rather than a
  constant plus the supplied key.
## 2026-11-06 — a load test must probe the limits the service actually exposes

- **Failure avoided:** A checklist item named a 10 MiB boundary and a slow-upload
  path, but the service has no attachment/upload route (Issue #5) and caps every
  request body at 64 KiB. Building a fake endpoint or sending 10 MiB through the JSON
  API would have produced a green test for behavior the product cannot perform.
- **Reproducer:** Search the router for an upload/attachment route and the body
  reader for its cap; both are absent/64 KiB, while the documented reverse-proxy cap
  is 1 MiB. Repeating the checklist name would still not create either path.
- **Fix:** Probe the real boundaries (64 KiB request cap, 8192-byte text, summary
  grapheme/byte caps) and record the 10 MiB clause as structurally inapplicable with
  the exact reason in the report and docs. Implement slow uploads by streaming a
  valid chunked body under the real cap through the real adapter.
- **Prevents:** Soak reports that claim coverage for unimplemented features, and
  endpoints invented only to satisfy a test list.
- **Remove when:** an attachment/upload route ships; then replace the
  inapplicability record with a real 10 MiB boundary scenario.

## 2026-11-07 — auditing a committed deletion is fail-open by construction

- **Failure avoided:** an audit row written after the deletion transaction commits can
  be lost by a crash or a failed insert, and retrying the cleanup cannot recover the
  counts. Silently returning success would make a destructive operator action look
  audited when it is not.
- **Rule:** when the destructive effect must not be undone by an audit failure, write
  the audit after commit, surface the failure (a flag in the summary plus a CLI warning
  and non-zero exit), and document that crash-after-commit can lose the row. Do not
  move the audit inside the transaction to "fix" it; that turns an audit outage into a
  failed cleanup.
- **Prevents:** an operator believing every cleanup is recorded, or a cleanup rollback
  caused by the audit table being unavailable.
- **Remove when:** cleanup writes a durable intent row before the transaction and a
  reconciliation pass completes it.

## 2026-11-07 — an operator service has no principal to re-check

- **Failure avoided:** the dashboard resolved the owned speaker inventory, then called
  the operator-oriented `rotateSpeakerCredential`, which re-checks that the owner is
  non-null and active but not that it is the *session* account. A speaker ownership
  transfer landing between the inventory read and the `BEGIN IMMEDIATE` transaction
  let the displaced owner mint a replacement token for a speaker they no longer owned.
- **Reproducer:** wrap `deps.db` so `transaction` transfers `speakers.owner_account_id`
  before executing the rotation; the dashboard POST returned 200 and issued a credential
  until the service took an `expectedOwnerAccountId`.
- **Rule:** a dashboard write that calls a CLI/operator service must pass the session
  account (or an explicit authorized wrapper) and have the service re-check it *inside*
  the write transaction. Sibling services (`revokeOwnedSpeakerCredential`,
  `grantOwnedSpeakerCredentialProject`) already do this; a pre-body inventory read is
  not an in-transaction check.
- **Prevents:** cross-account token issuance across a TOCTOU window, with the audit row
  attributed to the new owner.
- **Remove when:** operator services take a principal and every dashboard caller passes
  it, instead of per-service expected-owner parameters.

## 2026-11-07 — a dashboard write must resolve its own write principal

- **Failure avoided:** The timeline already resolves a `message.read` session viewer
  and reuses it for the page. Passing that principal to `expireMessageBody` would
  fail closed with `NOT_FOUND`, because the session branch returns only the scope it
  was resolved for and never widens a read viewer into `project.edit`. Reusing the
  read viewer would also hide the real authorization decision inside a confusing
  denial rather than test it.
- **Reproducer:** Resolve `resolveSessionViewer(..., "message.read")` and call
  `expireMessageBody` with it; it rejects. Resolve `project.edit`, then call the same
  function; it transitions once and audits once.
- **Rule:** Each dashboard write resolves the viewer for the exact scope it writes,
  after the page's read authorization, and then calls the existing service. The
  service must still re-authorize before the durable effect; the route does not
  trust the viewer it just built.
- **Prevents:** A dashboard control whose visibility and action use different
  authority, or a "fix" that widens the read viewer's scope set to make the action
  work.
- **Remove when:** the session viewer carries a membership-derived capability set
  that the service re-checks per write, instead of one pre-resolved scope.

## 2026-11-07 — audit the transition, not the invocation

- **Failure avoided:** auditing every `disable-project`/`enable-project` invocation
  would make an idempotent no-op look like a second containment action in incident
  evidence, and auditing before the update would record events that never happened.
- **Reproducer:** run `disable-project` twice; a naive implementation writes two
  `project.disable` rows even though only one status change occurred.
- **Rule:** an operator transition that may be a no-op audits only when the guarded
  `UPDATE ... WHERE status = <source>` changed a row, and the durable change is
  authoritative: insert the sanitized row after the update and, on insert failure,
  warn and exit non-zero rather than rolling back a containment action.
- **Prevents:** duplicated or phantom audit evidence and a failed audit sink silently
  undoing an emergency containment step.
- **Remove when:** transitions and audit rows are written atomically in one
  transaction with a retryable outbox, so no committed transition can lack its row.

## 2026-11-07 — a shaped double proves the adapter, not the platform

- **Failure avoided:** replacing the skipped D1 contract with a run against a
  D1-shaped SQLite double could be reported as "D1 support", while real Cloudflare
  D1, wrangler-applied migrations, R2, and Workers remain unexecuted.
- **Rule:** name the double at the contract call site and in every doc/state claim:
  the D1 adapter passes the shared contract over a SQLite-backed D1-shaped double.
  Keep live-D1 TODO clauses unchecked. The batch-emulated adapter must fail closed on
  reads inside a transaction and on a callback return value; do not invent a result
  to make a read-then-write caller pass.
- **Prevents:** a skipped contract becoming a passing mock while live-execution
  boxes are checked, and a batch adapter silently returning fake affected-row counts
  that callers start depending on.
- **Remove when:** a live D1 staging run executes the same contract and
  wrangler-applied migrations.

## 2026-11-07 — a blob double proves byte handling, not R2

- **Failure avoided:** an in-memory R2-shaped bucket can make the adapter look
  "R2-ready" while the real binding, Worker runtime, probes, and deployment remain
  unexecuted.
- **Rule:** name the structural double at the contract call site and in every doc,
  state, or TODO claim. Keep live R2/Workers boxes unchecked and keep the adapter out
  of production selection until a real staging run passes the same contract. Do not
  invent a `checkReady` probe for R2; `head`/`list` need a sentinel object or a scan,
  so document the omission and the readiness gap instead.
- **Prevents:** a passing mock reported as platform support and a readiness route that
  silently reports ready without touching R2.
- **Remove when:** a live R2 staging run executes the same blob contract and a
  sentinel-object readiness probe is implemented and exercised.
- **Superseded (2026-11-07):** the "do not invent a `checkReady` probe" clause is
  superseded by the sentinel-readiness lesson at the top of this file: the adapter now
  issues one `head` of a reserved sentinel key (connectivity/permission only, no object
  creation). The live-R2/Workers half of the remove-when condition is still
  unexecuted, so the rule against reporting doubles as live support still stands.

## 2026-11-07 — a wired entrypoint still proves only the wiring

- **Failure avoided:** calling a Worker module "Workers support" because its `fetch`
  handler runs against D1/R2 doubles would hide that real bindings, workerd, wrangler
  migrations, and a deployment are untested — and could let a legacy `scrypt$` login
  look verifiable on Workers when only the Node adapter has that verifier.
- **Rule:** name the doubles and the runtime gap in the file, tests, docs, state, and
  TODO. Keep the entrypoint Web-standard (`node:`-free), reuse the core parsers
  instead of shimming `Buffer`, fail closed on password formats the runtime cannot
  verify, and return a secret-free `503` for configuration errors. Do not cache a
  failed app build; let the next request retry.
- **Prevents:** a local handler test being reported as platform verification, a
  secret leaking through a startup error, and an isolate staying permanently broken
  after a transient config fix.
- **Remove when:** a live Workers staging run executes the same flow against real D1
  and R2 bindings with wrangler-applied migrations.

## 2026-11-07 — never run mutating reviewers concurrently on one worktree

- **Failure observed:** the security and contract auditors ran mutation tests at the
  same time in the same worktree. One auditor transiently saw the other's mutated
  source — a temporary 503-leaking rewrite in `src/platforms/workers/main.ts` — and
  reverted it to the HEAD blob before completing. The committed tree was unaffected
  (verified against the record commit), but the review evidence was briefly ambiguous.
- **Rule:** mutation-based or otherwise source-writing reviews must be serialized, or
  each run in its own worktree. Do not start a second mutating reviewer against a
  worktree another reviewer is editing; read-only reviewers may run concurrently.
- **Prevents:** reviewers auditing a source state neither the author nor HEAD produced,
  and transient security regressions being mistaken for committed behavior.
- **Remove when:** reviews run in isolated worktrees by construction, so no mutation
  can reach another reviewer's source.

## 2026-11-07 — injected double failures prove fail-closed mapping, not platform faults

- **Failure avoided:** treating a structural double's injected `put`/`get`/`batch`/
  query rejection as evidence that live D1/R2, a network partition, or two isolated
  deployments fail safely. The double proves the application's error mapping,
  atomicity guarantees of the port, and recovery of its own in-process state; it does
  not reproduce binding retries, workerd isolate recycling, partial network effects,
  or cross-environment behavior.
- **Rule:** keep failure injection in the doubles, assert HTTP status/envelope, DB
  rows, R2 call logs, absence of plaintext/tokens/driver text, and a successful retry
  after `clearFailure`; record "live D1/R2, real network/OS faults, and two isolated
  deployment environments remain unexecuted" in the runbook, acceptance report, state,
  and TODO reason. Where the port supports it, inject at a buffered statement index
  inside the transaction so the proof is rollback of already-executed work rather than
  batch-entry rejection, and assert clear-injection recovery for each readiness
  dependency (D1 and R2), not one path standing in for both.
- **Remove when:** a staging run injects comparable faults against real Cloudflare D1
  and R2 (or the operating system) in two isolated environments and observes the same
  fail-closed and recovery behavior.

## 2026-11-07 — blob GC must follow the real write order, not the assumed one

- **Failure avoided:** documenting (or reasoning from) "the `body_objects` row is
  inserted before the blob" when `commitBody` actually writes the ciphertext first and
  inserts the row second. A GC that trusted the assumed order would call a fresh,
  row-less file an orphan immediately and could delete an in-flight send's ciphertext.
- **Rule:** a destructive filesystem sweeper must be justified by the code's actual
  ordering, and its grace window is a timing margin, not a proof of impossibility: a
  send stalled longer than grace between the blob write and the row insert can lose
  its blob and fail reads permanently. Read the referenced-key set once, skip recent
  files before considering them, ignore invalid names/symlinks/non-regular entries, and
  report per-file successes and failures without claiming a transaction or rollback the
  filesystem cannot provide.
- **Remove when:** the send path changes to insert metadata before the blob and that
  ordering is asserted by a test, at which point this rationale must be revisited.

## 2026-11-08 — a deployment package is not a deployment, and trust is part of the route

The preview package was "ready" for two days while the actual deployment still had no TLS route:
the Tailscale account could not issue certificates, no public DNS/ACME host existed, and the
existing Cloudflare tunnel was remotely managed and unverifiable. A CI-green package plus a
Compose file did not answer "can an authorized tester open the UI over HTTPS?".
- **Rule:** a release campaign proves the deployment on the real endpoint, including its TLS
  trust chain and the tester's path to it, before calling it live. Prefer an already-authorized
  private network (a tailnet) over inventing public DNS or purchasing certificates, and treat a
  private CA as a real cost: every tester must install the trust anchor.
- **Rule:** keep the origin loopback-only and bind the terminator to the private interface, not
  to `0.0.0.0`; verify with `ss` and a TLS probe, not by assumption. Report the exact missing
  prerequisite (here: HTTPS certificates for the tailnet) as one maintainer action.
- **Remove when:** the tailnet issues publicly trusted certificates for the node (then the
  private-CA disclosure disappears), or the preview moves to a public hostname with ACME.

## 2026-11-09 — the edge added last bypasses the proxy hardened first

A Cloudflare tunnel route was pointed straight at the application's loopback port. The nginx
vhost's TLS, redirects, unknown-host rejection and rate limits did not apply to that path, and
the public hostname answered plaintext HTTP with `200` and no redirect: only the app's own
limits and `Secure` cookies remained.
- **Rule:** when an edge route is added or discovered, verify scheme redirect, access policy,
  rate limits and Host handling on that route itself. A hardened origin proxy does not cover a
  tunnel that targets the app directly.
- **Rule:** `Secure` cookies protect the browser session but do not protect bearer tokens from a
  client that uses `http://`. Require an edge-level HTTPS redirect and test it with a plaintext
  request, not by reading the configuration.
- **Remove when:** the Cloudflare route enforces Always Use HTTPS, a scoped Access policy and
  rate limits, or all traffic is forced through the checked proxy.
