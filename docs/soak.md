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
# default quick profile (bounded, typically a few seconds locally)
npm run soak -- --profile quick

# full profile
npm run soak -- --profile full

# pure JSON on stdout (suppresses npm's own banner); human summary stays on stderr
npm run --silent soak -- --profile quick
```

The report is one JSON object on stdout; a short human summary is written to stderr.
Plain `npm run` prints its usual `> corkboard@...` banner before the script, so use
`--silent` or take the last stdout line when parsing. The harness writes no files and
leaves no data directory behind.

Flags (defaults come from the profile):

| Flag | Meaning |
| --- | --- |
| `--profile quick\|full` | Scenario size preset; default `quick` |
| `--messages <n>` | Many-small-message count, 1–5000 |
| `--concurrency <n>` | Bounded in-flight HTTP requests, 1–64 |
| `--expiry-messages <n>` | Messages created with a future expiry and then expired, 1–1000 |
| `--rate-limit-requests <n>` | Rapid requests in the dedicated rate-limit server, 1–500 |
| `--base-sha <sha>` | Override the reported base revision (otherwise `git rev-parse HEAD`) |

| Profile | Small messages | Concurrency | Speakers × each | Expiry messages | Rate burst requests | Prune backlog | Observed quick duration |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `quick` | 200 | 8 | 4 × 10 | 20 | 12 | 25 | ~1.6 s on the recorded machine |
| `full` | 1000 | 16 | 8 × 25 | 100 | 20 | 50 | not recorded here |

`full` is larger but bounded; it has no wall-clock stop or unbounded loop. Every
scenario uses a fixed request count.

## What runs

`runSoak` creates an OS temporary directory (`mkdtemp` under `os.tmpdir()`, never the
repository or the primary data directory), writes a fresh random root key and
credential pepper, opens the real SQLite adapter (migrations apply), and inserts
synthetic accounts, speakers, projects, memberships, credentials and explicit
project grants. It then calls the real `startServer` on `127.0.0.1` with `PORT=0`
(ephemeral port) and drives it with `fetch`. Only loopback traffic is generated.

Scenarios and their assertions:

| Scenario | What it exercises | Correctness assertions |
| --- | --- | --- |
| `small_messages` | Bounded-concurrency sends of many small messages | Every send returned `201`; all created messages list in strictly ascending unique `seq`; replaying the same idempotency key returns `200` with the same `message_id` and creates no duplicate row |
| `boundary` | 8192-byte text accepted, 8193-byte text rejected | `201` then `400 VALIDATION_ERROR`; exactly one message stored |
| `concurrent_speakers` | 4/8 speakers exchanging messages, with replies to another speaker's seed | All expected messages created; reply references retained; the project lists in ascending unique `seq` |
| `metadata_search_pagination` | Summary search (`q=`) and `after_seq` cursor pages while the concurrent-speaker phase runs | All rows returned exactly once in ascending order; page cursors advance and terminate; search hits match the planted count |
| `unauthorized_revoked` | No credential, invalid credential, revoked credential, member without a grant, non-member; revoked send | `401 UNAUTHENTICATED` (no/invalid/revoked), `403 FORBIDDEN` (no grant), `404 NOT_FOUND` (non-member); the revoked send writes nothing |
| `body_expiry` | Future-expiry messages, injected-clock `expireDueBodies`, then body/list checks | All due messages expired, all ciphertext blobs deleted, zero failures; body fetch is `410 BODY_EXPIRED`; metadata survives as `expired` |
| `operator_cleanup` | Real `expire-bodies` and `prune` CLI commands on the temporary installation | Both exit `0`; `expire-bodies` reports zero failures; `prune` deletes the backdated revoked-session backlog; message counts are unchanged |
| `rate_limit_burst` | A second server on the temp installation with 30/minute, burst 5 | At least one `200` and one `429 RATE_LIMITED` with integer `Retry-After >= 1`; no other status |
| global | Every HTTP response | No `INTEGRITY_*` code, no unexpected `5xx`, no network/timeout error, no `429` outside the rate-limit scenario |

The expiry service is the same `expireDueBodies` the CLI calls, using its injectable
clock 10 minutes ahead; `prune` and a follow-up `expire-bodies` are then executed
through the real operator CLI (`scripts/corkboard.ts`) against the same temporary
database. The backdated backlog exists only in that temporary installation.

## Reading the report

The JSON object has `format: "corkboard-soak"`, `version: 1`, the profile, base
revision and `dirty` flag, node/platform/arch/cpu counts, resolved config, and:

- `scenarios.<name>.requests`, `statuses`, `error_codes`, `latency_ms`
  (`count`, `p50`, `p95`, `max` in milliseconds), and scenario-specific `details`.
- `correctness.passed` / `correctness.failures`: the load-bearing result. Exit code is
  `1` for any failure and `0` otherwise.
- `thresholds`: coarse latency guards. `environment_dependent` is always `true`.
  A breach is recorded in `breaches` but does **not** change the exit code, because a
  slow or contended machine is not a correctness failure.
- `summary`: request count, messages created, integrity failures, unexpected `5xx`,
  network errors, rate-limited responses, and replay duplicates.

Percentiles use the nearest-rank method. Latency samples are client-observed HTTP
durations and include scheduling, JSON serialization and local SQLite work; compare
them only across runs on the same machine.

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
command:      npm run soak -- --profile quick
exit:         0
started_at:   2026-11-06T01:03:23.589Z
duration_ms:  1648.3
base_sha:     a530693f479a7b8fbcc277f8cf367b81b466126d
dirty:        true   (the checkpoint commit was not yet created; only this slice's files differed)
node:         v24.22.1
platform:     linux x64, 40 cpus
```

| Scenario | Requests | Statuses | p50 / p95 / max (ms) | Key details |
| --- | --- | --- | --- | --- |
| `small_messages` | 210 | `200×10`, `201×200` | 20.9 / 32.4 / 66.4 | created 200, replayed 10, duplicates 0 |
| `boundary` | 2 | `201×1`, `400×1` | 2.3 / 10.8 / 10.8 | 8192 bytes accepted, 8193 rejected |
| `concurrent_speakers` | 42 | `200×2`, `201×40` | 16.5 / 24.9 / 26.2 | 4 speakers, 40 messages, 16 replies, listing page |
| `metadata_search_pagination` | 5 | `200×5` | 1.9 / 3.9 / 3.9 | 200 ordered rows in 2 full pages, 20 search hits |
| `unauthorized_revoked` | 6 | `401×4`, `403×1`, `404×1` | 1.1 / 1.4 / 1.4 | revoked send wrote 0 rows |
| `body_expiry` | 42 | `200×2`, `201×20`, `410×20` | 1.3 / 16.6 / 17.4 | 20 expired, 20 blobs deleted, 0 failures |
| `operator_cleanup` | 0 | — | — | CLI exit 0/0, 25 sessions pruned, 261 messages unchanged |
| `rate_limit_burst` | 12 | `200×5`, `429×7` | 1.2 / 20.3 / 20.3 | 7 rate-limited, `Retry-After` valid |

Totals: `319` requests, `261` messages created, `0` integrity failures, `0`
unexpected `5xx`, `0` network errors, `0` replay duplicates, `correctness.passed =
true`. Coarse guards were within limits (send p95 32.4 ms, list p95 3.9 ms). The
checkpoint commit's exact `Tree-SHA` is recorded in the commit trailer; the run
predates the commit, so `dirty` is `true`.

## What is not covered

- **Attachments and 10 MiB boundaries are not implemented.** This harness does not
  fake them. The only size boundary is the 8192-byte UTF-8 text cap (and its 2000
  grapheme companion), plus the 64 KiB JSON request cap.
- **No slow-upload/streaming scenario.** The API accepts bounded JSON bodies only;
  there is no multipart or chunked upload path to soak.
- **No Cloudflare Workers, D1, R2, or staging run.** Only the local SQLite adapter and
  local filesystem blobs are exercised.
- **No TLS, reverse proxy, or per-IP abuse controls.** Traffic is plain loopback.
  Rate limiting is process-local; multi-process aggregation is not tested.
- **No OAuth, MCP, dashboard, browser, or ChatGPT Web load.** Those surfaces are
  covered by their own tests, not by this harness.
- **No quota/disk-exhaustion or authorization-fuzzing scenario.** Quotas are not
  implemented; the negative cases here are a small fixed set.
- **No long-duration memory/heap soak.** The run is bounded to seconds; it does not
  detect slow leaks or multi-hour degradation.
- **Synthetic provisioning.** Principals are inserted directly into the temporary
  SQLite database; measured behavior is the real HTTP server. Expiry/prune use the
  real service/CLI paths but only on that temporary installation.

## Safety

- Temporary directory outside the repository; removed on normal exit (and by an
  `exit` hook). The primary data directory is never read or written.
- Synthetic names, bodies, accounts, and synthetic email addresses only.
- Freshly generated throwaway root key and pepper, passed only to the child server's
  environment; never printed, logged, or written to the report.
- No bodies, summaries, tokens, Authorization headers, cookies, or full IPs are
  recorded. The report contains counts, latency samples, status/error codes, and
  configuration only.
- The server's own JSON request log (stdout) is silenced during the run so it cannot
  corrupt the machine-readable report; the harness aggregates from client responses.
- No outbound network: the child server binds `127.0.0.1` on an ephemeral port.
