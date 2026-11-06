# Acceptance report

**Version:** 1 (2026-11-05)

**Report revision:** v1, written against code head `e79d60e001e5ac6c6eee7f06e17a86aa48d16c4f`
(tree `4f8e1ac50553cfb24eb774843e12781b58e79408`) and committed as its own docs
checkpoint. This report commit is pending its own independent audit; the capability
commits it cites were audited.

**Load/soak amendment:** the load/soak rows below were updated by the bounded local
soak-harness slice on the dirty candidate tree based on
`a530693f479a7b8fbcc277f8cf367b81b466126d` (see [`soak.md`](./soak.md)). Its checkpoint
commit/tree is recorded in that commit's trailer; the rest of this report still cites
the revisions above. The harness is documented in [`soak.md`](./soak.md).

**Design truth:** `TODO.md` §6 (Phase 8 and the release gate) and §8 (vertical-slice
measure).

**Scope:** the shipped self-hosted Node.js 24 + SQLite + local-blob service. No
Cloudflare or ChatGPT Web capability is inferred from local behavior.

> **No production or staging deployment occurred, and no secret belonging to any real
> deployment was used.** Every executed check in this report ran locally against
> synthetic data and freshly generated throwaway keys in a temporary directory outside
> the repository. There is no production or staging URL, certificate, credential, or
> data set behind any claim below.

## Status legend

| Status | Meaning |
| --- | --- |
| **Verified locally** | Executed at this revision (or the named revision) on a local machine with the exact command shown. |
| **Verified in CI** | The named CI run executed the command set successfully. |
| **Verified externally** | Evidence exists outside this repository (browser capture, issue comment, prerelease asset) and is named exactly. It was not re-run for this report. |
| **Simulated only** | Exercised against a mock/in-process adapter, not a real external platform. |
| **Not implemented** | The capability does not exist in this tree. |
| **Untested** | Implemented or partially implemented but never executed in the required environment. |
| **Partially verified** | Some sub-parts are verified and others are absent or untested; the row text says which. |

The last two statuses extend the requested set because a real-browser artifact and
mixed criteria cannot truthfully be labelled "verified locally", "verified in CI",
"simulated only", "not implemented", or "untested". No criterion is marked "Simulated
only" because no mock platform was used to claim an acceptance result.

## Exact revisions

| Item | Revision | Tree | Evidence |
| --- | --- | --- | --- |
| Current head | `e79d60e001e5ac6c6eee7f06e17a86aa48d16c4f` | `4f8e1ac50553cfb24eb774843e12781b58e79408` | docs/state only; CI run `42128599334` success (push, workflow `ci`) |
| Blank message validation (slice AD) | `7812505` | `d0fb133c6d979fcd031eaae91939c22c9fe214ac` | CI run `42127147927` success; security + contract PASS on the tree (delta audits) |
| Dashboard message send (slice AC) | `2a17a75` | `4d5117f2cac9e367a1dfa79a4d9cea326a636160` | CI run `42109894286` success; security + contract PASS; real-browser evidence artifact |
| Service overview (slice AB) | `058e34f` | `4ae5dfa5b7a99e2f44b1eddb2da397ae92204194` | CI run `42091068724` success |
| Credential inventory/revocation (slice AA) | `dbb2a46` | `837ee765298a921eae5b2d9430cdf07c800e2bbc` | CI run `42073815812` success |
| Supply chain (slice Z) | `f7e62be` | `06f664e5bca840ce7719cdb5ff31daa5b85d9c51` | CI run `42055915268` success |
| Slice AC docs/state tail | `b26b2fa` | `8a98be4db51775f189a63068d6769c17f0f529ee` | docs/state only |

Real-browser artifact at `2a17a75`: GitHub Issue #6 comment `6670317820`, prerelease
asset channel `web-ui-evidence-2a17a75`. It is external evidence; it was not replayed
for this report. That capture surfaced the blank summary/text defect fixed by
`7812505`.

### UI changes after the `2a17a75` browser capture

`git diff --stat 2a17a75..e79d60e -- src/app/web.ts src/app/html.ts src/app/oauth.ts`
is empty: no dashboard markup, HTML policy, or OAuth page changed after the capture.

- `b26b2fa` — docs/state only.
- `7812505` — behavior-only: message summary/text validation wrappers in
  `src/domain/validation.ts` and the service/MCP call path. The dashboard re-renders the
  existing escaped validation error; no UI markup or route changed. Its dashboard
  rejection and no-write behavior is covered by
  `tests/integration/message-send-web.test.ts`; it was **not** re-captured in a browser.
- `e79d60e` — docs/state only.

No other UI slice after `2a17a75` exists. Therefore no post-capture UI change lacks
browser evidence; the only post-capture behavior change is test-covered and behavior-only.

## §6 Phase 8 and release gate

| Criterion (TODO §6 / release gate) | Status | Exact command or artifact |
| --- | --- | --- |
| Automated secret scan, dependency audit, pinned reproducible build, license/notice report, SBOM | **Verified in CI** (reproducible build locally on the unpushed candidate) | CI run `42055915268` (slice Z) ran `npm run secret-scan`, `secret-scan:history`, `licenses`, `typecheck`, `test`, `build`, `sbom`, upload `reports/`, and `npm audit`. `.github/workflows/ci.yml` now also runs `npm run build:repro` after `npm run build`; that step was verified locally on the `repro-build` candidate (exit 0, 104 files) but has not yet run in CI because the candidate is unpushed. Locally `npm run check` also passed at this revision. |
| Fresh independent security review of current head and exact deployment artifacts | **Partially verified** | Each capability checkpoint through `7812505` records security PASS + contract PASS on an exact tree in `IMPLEMENTATION_STATE.md`. There are **no deployment artifacts** to review because no deployment exists. This docs tree is pending its own independent audit. |
| Load/soak: many small messages, slow uploads, 10 MiB boundaries, search, concurrent speakers, quota abuse, cleanup backlog | **Verified locally** (implemented scope; gaps below) | `npm run soak -- --profile quick` exit 0 on the dirty candidate tree based on `a530693` (see [`soak.md`](./soak.md)): 319 requests, 261 synthetic messages, 0 integrity failures, 0 unexpected 5xx, 0 network errors, 0 replay duplicates. Covered: 200 small messages; 4 concurrent speakers (40 messages, 16 cross-speaker replies); 8192-byte text accepted and 8193 rejected; summary search and ascending cursor pages; 20 injected-clock body expiries (`20` blobs deleted); real `expire-bodies`/`prune` CLI (25 backdated sessions pruned, all 261 messages unchanged); a 30/minute burst-5 server producing 7 documented `429 RATE_LIMITED` responses; and rejected no/invalid/revoked/missing-grant/non-member attempts. **Not covered:** slow uploads (the API accepts bounded JSON only, no streaming upload path), 10 MiB attachments (not implemented), quota abuse (no quotas implemented), D1/Workers/R2, TLS/reverse proxy, and multi-process. See [`soak.md`](./soak.md). |
| Disaster rehearsal: recreate DB/ciphertext/key backups, audit integrity, resync cursors, revoke credentials, recover after interrupted deployment | **Untested** | Backup/verify/restore are implemented and locally tested (see below), but no rehearsal against a recreated host/keys was executed. Audit integrity is not cryptographically sealed. |
| TLS, CSP/CORS, cookie policy, abuse rate limits, resource quotas, privacy notices, retention, incident procedure | **Partially verified** | CSP and cookie policy are implemented and asserted in tests; the CSP header was observed locally (`default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`). Per-credential rate limits and login limits are implemented (process-local). **TLS deployment was not executed** (example only). CORS is not enabled. No CORS, quota, privacy-notice, or formal retention-policy artifact exists beyond `docs/security-operations.md` and this runbook. |
| Versioned operator runbook and final acceptance report stating production/staging/simulated status | **Delivered, pending audit** | [`runbook.md`](./runbook.md) v2 and this report v1. Neither claims production or staging verification. |

**Release gate:** no open P0/critical-high security finding is recorded through
`7812505`. Backend contract, live-browser dashboard evidence, local OAuth/MCP write,
backup/restore, bounded local load/soak (text-only implemented scope), and negative
permission tests have exact-revision evidence. The gate is **not met for a public
beta** because ChatGPT Web write, D1/Workers/R2, slow uploads and 10 MiB attachment
boundaries, quota abuse, disaster rehearsal, key rotation, multi-process operation, and
a real TLS deployment remain absent or untested.

## §8 vertical-slice measure

| Measure | Status | Evidence |
| --- | --- | --- |
| No duplicated authorized message on retry | **Verified locally** | `npm run check` at this revision: 502 tests, 501 pass, 1 skipped (live-D1 marker), 0 fail. Includes REST/MCP idempotent replay and same-key conflict tests; synthetic smoke observed `201` then replay `200`, changed payload `409`. |
| No cross-project disclosure | **Verified locally** | Negative permission/security tests in `npm run check` (uniform `NOT_FOUND`/`FORBIDDEN`, grant and membership checks). |
| Accurate speaker identity | **Verified locally** | Sender is derived server-side from the credential/session; tests cover forged/foreign sender rejection. |
| Committed messages replay after restart | **Verified locally** | Persistence and replay tests, including four independent Node processes writing contiguous `seq`. |
| Encrypted body decrypts for authorized members and fails closed on tampering | **Verified locally** | AES-256-GCM roundtrip and tamper tests in `npm run check`. |
| Admin can revoke/expire and audit | **Verified locally** | `revoke-key`, `expire-bodies`, dashboard soft revocation, and sanitized audit rows are implemented and tested. Audit insert is fail-open. |
| Exact run verified on both hosting targets | **Not implemented** | Only Node/SQLite exists. D1/Workers/R2 is an external gap (see below). |

## Backend, persistence, and operations

| Criterion | Status | Evidence |
| --- | --- | --- |
| Backend contract (REST + service) | **Verified locally + CI** | `npm run check` at `e79d60e` (executed for this report) and CI `42127147927` at `7812505`. Local result: 502 tests, 501 pass, 1 skip (live-D1), 0 fail. |
| Negative permission tests | **Verified locally + CI** | `tests/security/**` and integration denial tests inside `npm run check`; same CI run. |
| Exact-revision security/contract audits | **Verified for code checkpoints** | PASS verdicts with trees recorded in `IMPLEMENTATION_STATE.md` through `7812505` (`d0fb133`). This docs tree pending audit. |
| SQLite persistence | **Verified locally** | `npm run check`; four-process persistence test; synthetic smoke at this revision wrote, listed, and re-read a body. |
| Backup / verify / restore | **Verified locally** | `npm run check`; synthetic smoke at this revision ran `backup`, `verify` (`ok:true`), `restore` into a new directory, and `doctor` on the restored copy (exit `0`, 0 issues). |
| D1 adapter and Workers deployment | **Not implemented (external gap)** | No adapter ships; the one skipped test is the live-D1 marker. Local SQL is kept D1-compatible but unexecuted. |
| R2 blob store | **Not implemented (external gap)** | Local filesystem blob store only. |
| `doctor` read-only diagnostics | **Verified locally** | `npm run check`; smoke: `doctor --json` exit `0`, 0 issues. |
| Operator retention (`prune`) | **Verified locally** | `npm run check`; smoke: `prune --json` printed counts and deleted nothing on a clean installation. |
| Rate limiting | **Verified locally** | `npm run check`; process-local per credential, REST/MCP shared, `429` with `Retry-After`. |
| Metrics endpoint | **Verified locally** | `npm run check`; disabled unless `CORKBOARD_METRICS_TOKEN` (≥32 chars), process-local. |
| OAuth 2.1 authorization server | **Verified locally** | `npm run check`; discovery, DCR, PKCE, consent, rotating refresh, revocation tests. |
| MCP Streamable HTTP (bearer) | **Verified locally** | `npm run check`; official SDK client integration tests for the six tools. |
| Health and readiness | **Verified locally (self-hosted Node adapter); Docker/Worker readiness untested** | `GET /healthz` returns `{"status":"ok"}` (observed in smoke). `npm run check` covers public `GET /readyz`: `200 {"status":"ready"}` only when SQLite answers `SELECT 1` and the blob store check passes; closed SQLite, a missing local blob directory, and a non-directory blob path each yield `503 {"status":"unavailable"}` with no paths or driver details; the in-memory backend is always ready; `HEAD` is `405` like `/healthz`; the probe creates no session or audit row; metrics label `/readyz` separately. Docker/Worker readiness is not separately probed (the container healthcheck still uses `/healthz`). |
| Upgrade / migration behavior | **Verified locally** | `npm run check` covers fresh install, v1→v2→v3→v4, v2→v3, v3→v4, crash rollback, concurrent upgraders, and refusal of a newer schema. Production-sized upgrade and rollback not executed. |

## Dashboard, localization, and browser evidence

| Criterion | Status | Evidence |
| --- | --- | --- |
| Dashboard login, projects, timeline, filters/search/replay, body reveal, en/zh | **Verified locally** | `npm run check` integration tests; real-browser evidence at `58e548f` (Issue #6) and at `2a17a75` (Issue #6 comment `6670317820`, prerelease `web-ui-evidence-2a17a75`). |
| Dashboard message send | **Verified externally + locally** | Browser capture at `2a17a75`; integration tests at `2a17a75`. The capture found a blank-content defect; fixed behavior-only at `7812505` and covered by tests, not re-captured. |
| Dashboard project create/edit | **Partially verified** | Integration tests in `npm run check`. Real-browser capture at `f1b13c9` (Issue #6 comment `6653112857`, tree `95755e2`): create/edit forms, edit link, mobile, zh, and dark. Submissions were broken in that capture and fixed at `4b1ba53` (Issue #6 comment `6654262331`); there is no successful current-head create/edit capture. |
| Speaker directory / credential issuance | **Verified externally + locally** | Integration tests in `npm run check`; real-browser capture at `15cdf62` (Issue #6 comment `6657401103`, tree `3260e71`): directory, issue form, success with a redacted token, validation error, mobile, zh, and dark (captures 1–10). Not re-captured after later UI slices. |
| Membership editor | **Verified externally + locally** | Integration tests in `npm run check`; real-browser captures at `499a772` (Issue #6 comment `6659644771`, tree `fe60450`) and `2a17a75` (Issue #6 comment `6670317820`, captures 11/18/23). |
| Credential inventory / soft revocation | **Verified externally + locally** | Integration tests in `npm run check`; real-browser capture at `2a17a75` (Issue #6 comment `6670317820`, captures 10/17, assets `2a17a75-desktop-en-credentials.png` and `2a17a75-desktop-zh-dark-credentials.png`). |
| Service overview | **Verified externally + locally** | Integration tests in `npm run check`; real-browser capture at `2a17a75` (Issue #6 comment `6670317820`, captures 8/9/16/22/25 and five overview-named assets, including `2a17a75-desktop-en-dark-overview.png` and `2a17a75-desktop-en-overview-full.png`). |
| Design tokens, dark mode, focus, 320px, both locales | **Partially verified** | Stylesheet/DOM assertions in `npm run check`; browser evidence at `58e548f` for the token slice. No automated browser matrix is claimed. |
| CSP, CSRF, XSS, stored injection | **Verified locally** | Integration/security tests; CSP header observed in smoke. |
| Message-expiry management UI | **Not implemented** | Only the compose form's optional `body_expires_at` field exists. |
| Receipts UI | **Not implemented** | Receipts are API-only. |
| Credential rotation | **CLI verified locally; no dashboard UI** | `rotate-key --credential <id>` atomically copies scopes/grants, issues a replacement, and revokes the old row in one transaction; `npm run check` integration tests cover old-token rejection, no widening, rollback, and sanitized audit. A manual CLI smoke was observed during implementation; it is not reproducible from the repository. The dashboard still has no rotation view (revoke-then-issue remains that path). Per-credential grant add/remove is implemented locally and covered by `npm run check`; no browser capture is claimed for it. |

## External acceptance and deferred work

| Criterion | Status | Evidence / limit |
| --- | --- | --- |
| ChatGPT Web plugin installation/connection | **Untested external acceptance** | Not inferred from local MCP. No ChatGPT account or plugin was used. |
| ChatGPT account linking and OAuth consent on a real account | **Untested external acceptance** | Local OAuth flow is tested; ChatGPT behavior is not. |
| Conversation-level ChatGPT tool invocation | **Untested external acceptance** | Local MCP SDK client is not evidence of ChatGPT tool invocation. |
| ChatGPT write-tool support by plan/workspace | **Untested external acceptance** | Must be tested on the intended subscription/workspace; a read-only or manual fallback would have to be documented if unavailable. |
| Attachments (≤10 MiB, upload/scan/preview) | **Not implemented** | Blocked on Issue #5; text bodies only. The backup 16 KiB blob cap is sized for the 8 KiB text body. |
| Key rotation (root key / pepper) | **Not implemented** | One root-key version `v1`; rotation requires re-encryption. Pepper rotation invalidates existing verifiers. |
| Credential rotation | **Verified locally (CLI); no dashboard UI** | `rotate-key` provides atomic replacement with identical scopes/grants and old-row revocation; covered by `npm run check` integration tests (old 401, new accepted, ungranted project still denied, no secrets in logs/audit). A manual CLI smoke was observed during implementation; it is not reproducible from the repository. Dashboard grant add/remove for active credentials of active speakers is implemented (see `web-ui.md`); a rotation view is not. |
| Load/soak | **Verified locally (implemented scope)** | `npm run soak -- --profile quick` exit 0 on the dirty candidate tree based on `a530693` (see [`soak.md`](./soak.md)): 319 requests, 261 messages, 0 integrity/5xx/network failures. Slow uploads, 10 MiB attachments, quotas, D1/R2, TLS and multi-process remain uncovered; see [`soak.md`](./soak.md). |
| Disaster rehearsal | **Untested** | No run; procedure documented in the runbook. |
| TLS deployment | **Untested** | Reverse-proxy example only; no certificate or proxy was exercised. |
| Multi-process deployment | **Untested** | A local four-process SQLite persistence test exists. Rate limits, metrics, and MCP sessions are process-local; no multi-process deployment was run. |
| Receipts UI, message-expiry management | **Not implemented** | See above. |

## Executed evidence for this report

All commands were run in the isolated worktree at
`e79d60e001e5ac6c6eee7f06e17a86aa48d16c4f`:

```text
npm ci --ignore-scripts   exit 0
npm run check             exit 0  (502 tests: 501 pass, 1 skipped live-D1, 0 fail)
npm run build             exit 0
```

Synthetic local smoke (temporary directory outside the repository, synthetic data,
freshly generated throwaway keys; no token or key printed):

```text
init --data-dir <tmp>/data --secrets-file <tmp>/config/secrets.env
bootstrap-owner / create-project / create-speaker / add-member / issue-key
serve  → GET /healthz {"status":"ok"}; CSP header observed on /login
POST message → 201; same key/payload → 200; same key/different payload → 409
GET list → 200; GET body → 200 (text matched the sent value); unauthenticated list → 401
prune --json; expire-bodies --data-dir  → summaries, no failures
doctor --json → exit 0, 0 issues
backup --json; verify --json (ok:true); restore --data-dir <new>; doctor on restored → exit 0, 0 issues
init against the existing installation → refused, exit 1
init with --secrets-file inside the data directory → refused, exit 1
```

CLI usage was confirmed from the no-argument usage line. The CLI has **no `--help`**
option; `--help` is rejected as an unknown option (exit `1`, or `2` for `doctor`), so
this report does not cite one.

## Open gaps and what would change this report

- A real ChatGPT Web acceptance run (install, link, consent, tool invocation, write) on
  the intended account/workspace.
- A live D1 + R2 staging deployment passing the shared contract and a two-client
  exchange.
- A longer/full soak, slow-upload and 10 MiB attachment boundaries, quota abuse, and
  multi-process/D1 deployments (the bounded `quick` scope is in [`soak.md`](./soak.md));
  a disaster rehearsal with recreated keys and backups; and a real TLS reverse-proxy
  deployment.
- Root-key/pepper (service-key) rotation; speaker credential rotation is now
  implemented as the CLI `rotate-key` (no dashboard UI).
- Browser re-capture of the dashboard after any future UI change. Until then, the
  `2a17a75` artifact is the last browser evidence; `7812505` is behavior-only.
