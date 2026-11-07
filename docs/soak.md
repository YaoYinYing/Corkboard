# Local load/soak harness

Status: bounded local harness for the shipped Node.js 24 + SQLite + local-blob
deployment. It is **not** a distributed load generator, a Cloudflare/D1/R2 test, a
long-running memory-leak soak, or a production rehearsal. `scripts/soak.ts` runs the
real `startServer` adapter against a fresh temporary installation and exits non-zero
when a correctness assertion fails.

`npm run check` does **not** run a soak. Only the fast report/argument unit test
(`tests/unit/soak.test.ts`) is part of the normal suite; latency numbers are
environment-dependent and must never gate CI.

## Commands

```sh
# bounded default profile (recorded at ~11 s on the reference machine)
npm run soak -- --profile quick

# extended profile (recorded at ~29 s): 1000 messages, 8 speakers, 100 expiries,
# 40 sustained over-limit requests, and 64 slow-upload chunks
npm run soak -- --profile full

# pure JSON on stdout (suppresses npm's own banner); human summary stays on stderr
npm run --silent soak -- --profile quick
```

The report is one JSON object on stdout; a short human summary is written to stderr.
Plain `npm run` prints its usual `> corkboard@...` banner before the script, so use
`--silent` or take the last stdout line when parsing. The harness writes nothing inside
the repository; the temporary installation is removed on exit.

Flags (defaults come from the profile):

| Flag | Meaning |
| --- | --- |
| `--profile quick\|full` | Scenario size preset; default `quick`. Slow-upload chunk count/delay are profile-only; the count flags below override the profile's corresponding counts |
| `--messages <n>` | Many-small-message count, 1–5000 |
| `--concurrency <n>` | Bound on in-flight HTTP requests within each bounded group, 1–64. The concurrent-speaker and metadata-search scenarios run in the same `Promise.all` group, so their combined in-flight requests can briefly exceed this bound |
| `--expiry-messages <n>` | Messages created with a future expiry and then expired, 1–1000 |
| `--rate-limit-requests <n>` | Rapid requests in the dedicated rate-limit server, 6–500 (minimum 6 so the fixed burst of 5 exposes both a `200` and a `429`) |
| `--base-sha <sha>` | Override the reported base revision (otherwise `git rev-parse HEAD`); must be 4–64 hexadecimal characters. The report does not mark that the value was overridden |

The four count flags replace the corresponding profile counts — messages and
concurrency in the send/list scenarios, expiry messages in `body_expiry`, and
rate-limit requests in `rate_limit_burst` — and are echoed in the reported `config`.
Speaker counts, prune backlog, samples, slow-upload size/timing, and latency guards
stay profile-defined and are not overridable.

| Profile | Small messages | Concurrency | Speakers × each | Expiry messages | Rate burst requests | Prune backlog | Slow upload | Observed duration |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `quick` | 200 | 8 | 4 × 10 | 20 | 12 | 25 | 8 chunks × 25 ms | ~11 s on the recorded machine |
| `full` | 1000 | 16 | 8 × 25 | 100 | 40 | 50 | 64 chunks × 50 ms | ~29 s on the recorded machine |

`full` is larger but bounded; it has no wall-clock stop or unbounded loop. Every
scenario uses a fixed request count. The slow-upload delay does not extend the total
scenario deadline: each slow request is still bounded by the 15 s transport timeout.

## What runs

`runSoak` creates an OS temporary directory (`mkdtemp` under `os.tmpdir()`, never the
repository or the primary data directory), writes a fresh random root key and
credential pepper, opens the real SQLite adapter (migrations apply), and inserts
synthetic accounts, speakers, projects, memberships, credentials and explicit
project grants. It then calls the real `startServer` on `127.0.0.1` with `PORT=0`
(ephemeral port) and drives it with `fetch` and, for slow bodies, `node:http`. Only
loopback traffic is generated.

Scenarios and their assertions:

| Scenario | What it exercises | Correctness assertions |
| --- | --- | --- |
| `small_messages` | Bounded-concurrency sends of many small messages, then the same project paginated with two different page sizes | Every send returned `201`; `seq` is contiguous `1..n` with no duplicate or gap; both page sizes return the created set in the same order; replaying the same idempotency key returns `200` with the same `message_id` and creates no duplicate row |
| `boundary` | The boundaries the API actually exposes: 8192/8193-byte text, 64 KiB/64 KiB + 1 JSON request bodies, 140/141-grapheme summaries, 1024/1032-byte summaries | `201` for each accepted boundary and `400 VALIDATION_ERROR` / `413 REQUEST_TOO_LARGE` for each rejected one; exactly the accepted messages are stored; the report records `ten_mib_applicable: false` with the reason |
| `slow_upload` | `node:http` chunked request bodies written one chunk per delay: 8192-byte text, 8193-byte text, and exactly 64 KiB of valid JSON | The accepted body is `201`, its response digest matches, and a body `GET` returns the exact text and digest; the over-text body ends in `400 VALIDATION_ERROR` and adds no row; the exact 64 KiB body is `201`; exactly two messages are stored |
| `concurrent_speakers` | 4/8 speakers exchanging messages in parallel, with replies to another speaker's seed | All expected messages created; reply references retained; the shared project `seq` is contiguous; a speaker granted only this project gets `404 NOT_FOUND` for another project's list and body |
| `metadata_search_pagination` | Full `after_seq` pagination plus four `q=` searches (token, literal `%`, literal `_`, no-hit empty result) run while the concurrent-speaker phase is in flight; `q` cases at 100 and 101 characters | Every listed row appears once in ascending order; each search returns exactly the expected id set (LIKE wildcards are escaped); the non-empty no-hit token returns zero rows; `q` at 100 chars is `200` and at 101 is `400 VALIDATION_ERROR` |
| `unauthorized_revoked` | No credential, invalid credential, revoked credential, member without a grant, non-member; revoked send | `401 UNAUTHENTICATED` (no/invalid/revoked), `403 FORBIDDEN` (no grant), `404 NOT_FOUND` (non-member); the revoked send adds no listed (seq-visible) message |
| `body_expiry` | Future-expiry messages, injected-clock `expireDueBodies`, then body/list checks | All due messages expired, all ciphertext blobs deleted, zero failures; body fetch is `410 BODY_EXPIRED`; metadata survives as `expired` |
| `operator_cleanup` | Prunable backlog built through supported routes: real sign-in/sign-out creates one revoked session per synthetic account; expiry messages were created through `POST /messages` and drained by the injected-clock `expireDueBodies` service; then real `expire-bodies`, `prune --grace-hours 0` twice, and `doctor --json` on the temporary installation | All logins/logouts succeed; `expire-bodies` exits `0` with zero failures and no pending expiry rows; `prune` deletes the backlog and a second run deletes `0`; no sessions remain; doctor exits `0` with `integrity: ok`, complete schema, `0` missing/orphaned/expired-pending blobs, `0` stuck provisional rows and no issues; message counts and contiguous sequences are unchanged |
| `rate_limit_burst` | A second server on the temp installation with 1/minute, burst 5; the refill allowance is measured from elapsed time, not assumed. Sustained over-limit `GET`s from one credential, then one over-limit `POST /messages` with its own idempotency key, then a second credential | Only `200`/`429` from the burst `GET`s; every `429 RATE_LIMITED` has an integer `Retry-After` in 1–120; the limited count is bounded by burst plus measured refill: `floor((burst_elapsed + post_gap + post_duration) × per_minute / 60000)` when the POST was sent, and only the burst window when it was skipped pre-send; the POST's `429` expectation is asserted only when that measured window is shorter than one refill interval; if the window could refill a token, a `201` is tolerated as a legitimate write and the probe is reported as skipped, but any other non-`429` status still fails; when it returns `429`, the message and `body_objects` row counts must be unchanged; another credential still gets `200` and sends exactly one message with the expected next `seq` |
| `sequence_integrity` | Final database read across all five synthetic projects | Every project's `seq` set is contiguous from `1` with no duplicate or gap |
| global | Every HTTP response | No `INTEGRITY_*` code, no unexpected `5xx`, no network/timeout error, no `429` outside the rate-limit scenario |

The expiry service is the same `expireDueBodies` the CLI calls, using its injectable
clock 10 minutes ahead; `expire-bodies`, `prune` and `doctor` then run through the real
operator CLI (`scripts/corkboard.ts`) against the same temporary database. The revoked
sessions and the expiry backlog exist only in that temporary installation.

### The 10 MiB clause is structurally inapplicable

There is no attachment or upload endpoint: attachments are blocked by Issue #5. The
application caps every request body at **64 KiB**, message text at **8192 UTF-8
bytes**, and summaries at **140 graphemes / 1024 UTF-8 bytes**; the documented nginx
example caps proxied bodies at **1 MiB**. Those are the real boundaries and the
harness probes them. It does not invent an upload route, send 10 MiB through the JSON
API, or claim a 10 MiB test. The `boundary` report records `ten_mib_applicable:
false` and the exact reason.

### Slow uploads

The Node adapter has no upload-specific deadline: it buffers a POST body under the
same 64 KiB cap as any other request. The slow scenario therefore streams a valid body
one chunk per delay and asserts deterministic completion (or a deterministic
validation failure) with no corruption. The only bound on the client is the harness's
15 s per-request transport timeout; an actual deployment's slow-client timeout is a
reverse-proxy concern, not an application setting.

## Reading the report

The JSON object has `format: "corkboard-soak"`, `version: 1`, the profile, base
revision, `dirty` flag and `dirty_reason`, node/platform/arch/cpu counts, resolved
config (including `slow_upload_chunks`/`slow_upload_delay_ms`), and:

`dirty` is `true`/`false` only when `git status --porcelain` succeeded; when git or
the probe is unavailable it is `null` with `dirty_reason: "git status unavailable"`,
never a claimed-clean `false`.

- `scenarios.<name>.requests`, `statuses`, `error_codes`, `latency_ms`
  (`count`, `p50`, `p95`, `max` in milliseconds), and scenario-specific `details`.
- `correctness.passed` / `correctness.failures`: the load-bearing result. Exit code is
  `0` on pass, `1` on any correctness failure, `2` on invalid arguments, and `130`/`143`
  when the harness handles `SIGINT`/`SIGTERM`.
- `thresholds`: coarse latency guards. `environment_dependent` is always `true`.
  A breach is recorded in `breaches` but does **not** change the exit code, because a
  slow or contended machine is not a correctness failure.
- `summary`: request count, messages created, integrity failures, unexpected `5xx`,
  network errors, rate-limited responses, and replay duplicates.

Percentiles use the nearest-rank method. Latency samples are client-observed HTTP
durations and include scheduling, JSON serialization, local SQLite work, and (for
`slow_upload`) the deliberate chunk delays; compare them only across runs on the same
machine.

### Coarse latency guards

| Profile | Send p95 guard | List p95 guard |
| --- | --- | --- |
| `quick` | 5000 ms | 3000 ms |
| `full` | 15000 ms | 8000 ms |

These are deliberately loose smoke guards, not service-level objectives. They exist
to catch an order-of-magnitude regression, not to certify performance. They are
non-fatal by design and are never run by `npm run check`.

## Recorded local evidence

Representative `quick` run on the candidate working tree (all values are from the JSON
report; no token, body, summary, or IP is recorded):

```text
command:      npm run --silent soak -- --profile quick
exit:         0
started_at:   2026-11-07T07:56:50.676Z
duration_ms:  10564.2
base_sha:     69dac351825fdc770b31e309bf5fc7c457b36ce7
dirty:        false  (rebased candidate before the final amend)
node:         v24.22.1
platform:     linux x64, 40 cpus
```

| Scenario | Requests | Statuses | p50 / p95 / max (ms) | Key details |
| --- | --- | --- | --- | --- |
| `small_messages` | 220 | `200×20`, `201×200` | 19.8 / 30.1 / 67.0 | created 200, contiguous seq, both page sizes match, 10 replays, 0 duplicates |
| `boundary` | 8 | `201×4`, `400×3`, `413×1` | 2.2 / 8.3 / 8.3 | text 8192/8193, request 65536/65537, summary 140/141 and 1024/1032; 10 MiB inapplicable |
| `slow_upload` | 4 | `200×1`, `201×2`, `400×1` | 208.0 / 222.3 / 222.3 | 8 chunks × 25 ms; body text/digest verified; 64 KiB streamed body accepted |
| `concurrent_speakers` | 44 | `200×2`, `201×40`, `404×2` | 18.2 / 25.1 / 38.9 | 4 speakers, 40 messages, 16 replies, contiguous, 2 isolation checks |
| `metadata_search_pagination` | 12 | `200×11`, `400×1` | 5.3 / 14.6 / 14.6 | 200 rows, 4 bounded searches including literal `%`/`_`, empty result, 100/101-char cases |
| `unauthorized_revoked` | 6 | `401×4`, `403×1`, `404×1` | 1.2 / 7.4 / 7.4 | revoked send added no listed message |
| `body_expiry` | 42 | `200×2`, `201×20`, `410×20` | 1.2 / 17.5 / 18.3 | 20 expired, 20 blobs deleted, 0 failures |
| `operator_cleanup` | 50 | `200×25`, `204×25` | 10.1 / 290.7 / 292.0 | 25 login/logout pairs; prune 25 then 0; doctor integrity ok, 0 issues; 266 messages unchanged |
| `rate_limit_burst` | 15 | `200×6`, `201×1`, `429×8` | 1.3 / 7.2 / 7.2 | 8 limited at 1/minute burst 5 (burst 26.4 ms + POST 1.2 ms, refill 0); rejected POST left message/body rows unchanged; other credential sent 1 survivor |
| `sequence_integrity` | 0 | — | — | 5 projects contiguous |

Totals: `401` requests, `267` messages created, `0` integrity failures, `0`
unexpected `5xx`, `0` network errors, `0` replay duplicates, `correctness.passed =
true`. Coarse guards were within limits (send p95 30.1 ms, list p95 14.6 ms). The
checkpoint commit's exact `Tree-SHA` is recorded in the commit trailer; this run was
on the clean rebased candidate before the final amend. The `full` profile also exited
`0` at `28607.9 ms` with `1659` requests, `1307` messages, `36` expected `429`s,
contiguous sequences and unchanged message counts.

## What is not covered

- **Attachments and 10 MiB boundaries are structurally inapplicable.** Attachments
  are blocked by Issue #5; the API has no upload route. The request body is capped at
  64 KiB and the documented proxy body cap is 1 MiB. The harness records this instead
  of faking the boundary (see above).
- **No Cloudflare Workers, D1, R2, or staging run.** Only the local SQLite adapter and
  local filesystem blobs are exercised.
- **No TLS, reverse proxy, or per-IP abuse controls.** Traffic is plain loopback.
  Rate limiting is process-local; multi-process aggregation is not tested. Proxy
  slow-client timeouts and body caps are not executed.
- **No OAuth, MCP, dashboard, browser, or ChatGPT Web load.** Those surfaces are
  covered by their own tests, not by this harness.
- **No per-project storage quota or disk-exhaustion scenario.** Quotas are not
  implemented; "quota abuse" here means the documented per-credential rate limiter,
  not a storage quota.
- **No long-duration memory/heap soak.** The run is bounded to seconds and does not
  detect slow leaks or multi-hour degradation.
- **Synthetic provisioning.** Principals and session accounts are inserted directly
  into the temporary SQLite database; session backlog is then created through the real
  sign-in/sign-out routes. Measured behavior is the real HTTP server. Expiry/prune/
  doctor use the real service/CLI paths but only on that temporary installation.

## Safety

- Temporary directory outside the repository; removed on normal exit (and by an
  `exit` hook). `SIGINT` exits `130` and `SIGTERM` exits `143`, removing the directory
  first. The primary data directory is never read or written.
- Synthetic names, bodies, accounts, and synthetic email addresses only. The synthetic
  session credential is generated at runtime and never printed or reported.
- Freshly generated throwaway root key and pepper, passed only to the in-process
  server configuration and the doctor subprocess environment; never printed, logged,
  or written to the report.
- No bodies, summaries, tokens, Authorization headers, cookies, or full IPs are
  recorded. The report contains counts, latency samples, status/error codes, and
  configuration only.
- The server's own JSON request log (stdout) is silenced during the run so it cannot
  corrupt the machine-readable report; the harness aggregates from client responses.
- No outbound network: the in-process server binds `127.0.0.1` on an ephemeral port.
