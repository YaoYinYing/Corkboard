# Implementation state

Execution truth for the Corkboard campaign. Design truth is `TODO.md`; this file records
what is actually implemented, verified, and next. It is updated in the same checkpoint
as the work it describes.

## Current status

| Field | Value |
| --- | --- |
| Phase | 0 complete; **vertical slices A and B implemented** (slice B checkpoint pending) |
| Checkpoint | Slice A `b5c421d` (audited tree `048065f`); slice B candidate on branch `slice-b-expiry` |
| Branch | `main` (slice A); `slice-b-expiry` (slice B, not pushed) |
| Reviews | Phase 0: security PASS + contract PASS. Slice A: security PASS + contract PASS on tree `048065f`. Slice B: pending independent audit |
| Next milestone | D1/R2 parity and Phase 5 (MCP/OAuth/ChatGPT Web plugin) |

## Checkpoint history

| Commit | Tree | Capability | Reviews |
| --- | --- | --- | --- |
| `df99e90` | `0459cfb` | Phase 0 docs, toolchain, secret hygiene | security PASS; contract PASS |
| `b5c421d` | `048065f` | Vertical slice A: encrypted messaging, ordered replay, REST API, CLI | security PASS; contract PASS |

Do not treat later phases as verified until their checkpoints exist.

## Environment

- Node.js 24.22.1 (LTS line), npm 11.19.1, `.nvmrc` = 24.
- Package manager: npm with committed `package-lock.json`.
- Test runner: `node:test`; typecheck: strict `tsc`; `lint` currently aliases
  `typecheck` (ESLint deferred; no extra dependency yet).
- SQLite: `node:sqlite` built-in (no native dependency).
- HTTP core: Web `Request`/`Response`; `node:http` adapter for self-hosting. Hono not
  pinned.
- Crypto: WebCrypto AES-256-GCM and HMAC.
- CI: `.github/workflows/ci.yml` runs secret scan (staged index + untracked files and
  full history), typecheck,
  tests, build, and `npm audit`; actions pinned to commit SHAs; credentials not
  persisted.

## Decisions

| Date | Decision | Reason |
| --- | --- | --- |
| 2026-11-03 | npm + Node 24 LTS | Requested Node ecosystem; supported LTS |
| 2026-11-03 | `node:sqlite`, `node:test`, WebCrypto | Zero native/runtime dependencies for the first slice |
| 2026-11-03 | Unredacted `ORIGINAL_DESIGN.md` stays untracked; redacted copy committed | Line 160 contains proxy credentials; public repo must not receive them |
| 2026-11-03 | CLI bootstrap before web sessions | First slice needs a human authorization path without a UI |
| 2026-11-03 | One versioned service root key (no per-object DEK) for the first slice | Simplicity; rotation documented; upgrade before public release if warranted |
| 2026-11-03 | Live D1 adapter deferred to vertical slice B; SQLite first | Slice A proves the product on Node; D1 must pass the same contract before Phase 1 is complete |
| 2026-11-03 | License: MIT | Maintainer decision recorded in issue #1 |
| 2026-11-03 | Campaign protocol revision pinned to REvoCompute `8cdf41a5` | Exact source record; adaptations documented |

## Vertical slice A — implemented at this tree

The Node.js/SQLite local product now works end-to-end:

- Migration 001 with atomic ordered-replay finalization (`seq` NULL until publish,
  one UPDATE + trigger advances `next_seq`, publishes `ready`, completes idempotency);
  lifecycle CHECKs, FKs, WAL/foreign keys, D1-compatible SQL.
- AES-256-GCM envelope with metadata-only AAD, CBPT1 plaintext frame carrying the
  sender-verified SHA-256, ciphertext digest verified against the DB before decrypt;
  local private blob store with atomic writes and 0700/0600 permissions.
- Seven-scope authorization with active account/speaker/project/membership checks,
  removed-membership denial, scoped speaker credentials (prefix + HMAC verifier),
  prefix-collision-safe lookup, revocation/expiry.
- Message service: send (digest before any write, idempotency scoped to speaker/
  project/key), list/replay with filters and cursor, metadata, verified body fetch,
  receipts requiring `message.read` + `receipt.write` and a valid body.
- HTTP API per `docs/api.md`, Node server, and bootstrap CLI (`init`,
  `bootstrap-owner`, `create-project`, `create-speaker`, `add-member`, `issue-key`,
  `serve`).
- Tests: 127 total, 126 pass, 1 skipped (live D1 marker). `npm run check` and
  `npm run build` pass; build copies migrations into `dist/`.

## Vertical slice B — body expiry and tombstone (implemented at this tree)

- `POST /messages` accepts optional `body_expires_at`: RFC 3339 with offset,
  normalized to UTC, strictly after server `received_at`, at most 366 days ahead;
  otherwise `VALIDATION_ERROR` before any write. It is part of the idempotency payload
  digest, so the same key with a different expiry is `CONFLICT`. A committed replay
  returns the original result even after expiry.
- List and single-message metadata include `body_expires_at`.
- `POST /projects/:projectId/messages/:messageId/expire` requires `project.edit` plus
  membership; non-member/removed → `NOT_FOUND`, member without scope → `FORBIDDEN`,
  pending/failed/unknown → `NOT_FOUND`, already expired → idempotent `200`. One
  conditional `ready → expired` transition per row, audited as `message.expire`
  success with identifiers only, then best-effort ciphertext deletion.
- Service helper `deleteExpiredBodyBlob` deletes ciphertext only for expired messages
  and marks `body_objects.state = 'deleted'`, `storage_key = NULL`; a missing blob
  counts as success.
- `expire-bodies [--limit N]` (default 500, 1–5000) runs both phases: mark due rows
  expired, then delete blobs for expired/undeleted objects. Per-row failures are
  counted and do not stop the run; one JSON summary line is printed and the process
  exits non-zero when `failures > 0`. Safe to repeat and after crashes.
- Expiry requires an external scheduler: there is no in-process timer or daemon. The
  server only enforces an explicit endpoint; the operator schedules the command.
- Tests: 138 total, 137 pass, 1 skipped (live D1 marker): validation, tombstone
  metadata, fetch/receipt denial plus retention of existing receipts, endpoint
  authorization/state ordering, concurrent transition, worker due/orphan/unexpired
  behavior, and CLI wiring.
- Commands executed: `npm run check`, `npm run build`, and a temp-data-directory CLI
  smoke (`init` → service send with near expiry → `expire-bodies` → body fetch fails,
  metadata survives).

## Implemented and verified at this tree

- [x] Repository hygiene: `.gitignore` excludes the unredacted archive, secrets, keys,
  data, dependencies, and build output.
- [x] Redacted public archival copy with an archival banner; unredacted file is ignored,
  untracked, and absent from git history by check.
- [x] Architecture, threat model, API, security operations, deployments, and campaign
  contract docs; none claim unimplemented behavior.
- [x] Strict TypeScript toolchain, lockfile, build, `node:test` suite.
- [x] Secret scanning of staged blobs + untracked files, plus full-history scan; fails
  closed on git errors, unreadable files, and oversized files.
- [x] CI with pinned actions, read-only permissions, history scan, build, and audit.
- [x] `AGENTS.md`, `CLAUDE.md` (imports `AGENTS.md`, no divergent copy), this state
  file, `LESSIONS.md`.
- [x] Audit report schema and issue escalation format in `docs/campaign.md`.

Commands executed at the candidate tree: `npm install`, `npm run secret-scan`,
`npm run secret-scan:history`, `npm run typecheck`, `npm test`, `npm run build`.
When this candidate is committed, the checkpoint commit trailer will record the exact
candidate SHA and review verdicts.

## Phase 0 gate checklist

| Gate item | Status |
| --- | --- |
| Target repository empty/current before first commit | Verified empty |
| Unredacted archive not committed; redacted labeled copy | Done; history scan enforces |
| Architecture/threat model/API/operations/deployment docs | Done |
| AGENTS/CLAUDE/state/lessons/campaign contract | Done |
| Node LTS and package manager pinned; lint/typecheck/test/build/audit scripts | Done (`lint` = strict typecheck for now) |
| Clean install from upstream, not a mirror | Done via npm registry |
| Checkpoint and audit report schema | Done |
| Key/secret bootstrap implementation | Done (`init` writes 0700 dir + 0600 secrets.env; prints path only) |
| Branch protection / serialized integrator discipline | Policy documented; branch protection not configured |
| Staging/prod secret separation | Documented; no deployment yet |

Phase 0 is not complete until the first checkpoint commit exists and the key/secret
bootstrap lands with Phase 2. The bootstrap commit is intentionally limited to docs and
tooling so the gate is auditable.

## P0 amendment — message integrity (2026-11-03)

Mandatory amendment accepted after bootstrap. Contract is now in `TODO.md` §5/§6,
`docs/api.md`, `docs/architecture.md`, and `docs/threat-model.md`:

- Sender supplies `body_digest` = SHA-256 of the exact original bytes before
  compression/encryption. The server independently recomputes it and rejects a
  mismatch with `INTEGRITY_MISMATCH` before sequence allocation, blob write, or commit.
- The verified plaintext digest is encrypted inside the payload and verified after
  decryption; the AAD binds only pre-decryption metadata. A separate ciphertext SHA-256
  is stored for storage-integrity verification.
- Every body read verifies the ciphertext digest, decrypts, then verifies the plaintext
  digest. Any mismatch returns `INTEGRITY_FAILURE`, returns no content, creates no read
  receipt, and is audited.
- Status: **implemented and tested in vertical slice A** (sender digest verified
  before writes, CBPT1 embedded digest, DB-bound ciphertext digest, fail-closed reads,
  no receipt on failure). Lessons are recorded in `LESSIONS.md`.

## Design review follow-ups (2026-11-03, after checkpoint df99e90)

Contract corrections applied before affected implementation lands:

- **P0 ordered replay.** Provisional messages carry `seq = NULL` and are invisible.
  Sequence allocation, `ready` publication, and idempotency completion happen in one
  atomic UPDATE plus trigger at finalization, so publication order equals sequence
  order. Concurrency/crash-recovery tests are required; the shared contract is written
  to run on SQLite and a D1 adapter, with live D1 recorded as an external gap until the
  runtime exists.
- **P1 crypto envelope.** AAD binds only pre-decryption metadata. The verified plaintext
  SHA-256 is encrypted inside the payload and verified after decryption; it is not in
  the outer header or AAD. Ciphertext SHA-256 remains stored for storage integrity.
- **P1 MCP.** LLM-facing tool arguments no longer include `body_digest` or
  `idempotency_key`. The trusted MCP adapter computes/derives them from text and
  transport context; REST keeps mandatory independent verification.
- **P1 read receipts.** Requires both `message.read` and `receipt.write`; only a
  committed, integrity-verified body can be acknowledged. Receipts are client
  assertions. Pending/expired/corrupt/inaccessible bodies create no receipt.
- **License:** MIT, recorded in issue #1.

Owner candidates A (persistence) and B (crypto) were redirected with these corrections;
C (validation/auth) is unaffected except downstream service composition.

## Independent foundations review (2026-11-04)

A fresh reviewer audited the foundations tree and returned BLOCKED on one P1 plus
hardening P2s. Disposition:

- **P1 removed membership:** `removed_at` was never read, so removed collaborators kept
  rights. Fixed in authz and service membership queries; non-member access is
  `NOT_FOUND`. Regression test added.
- **P2 same-ID envelope substitution:** crypto now verifies the ciphertext digest
  against `body_objects.ciphertext_digest`, not only the envelope's own header.
- **P2 lifecycle integrity:** schema CHECKs for pending/ready sequence and body-object
  requirements; body-object FK; trigger idempotency completion scoped by speaker and
  project; `next_seq = MAX(next_seq, new_seq)`.
- **P2 built artifact:** migrations are copied into `dist/` and the DB opener has a
  working-directory fallback.
- **P2 unknown credential shape:** bearer lookup verifies every credential matching the
  public prefix instead of trusting the first row.
- **P2 idempotency payload digest:** intentionally an HMAC-SHA256 (pepper-keyed) digest
  of the canonical request input, used only for same-key conflict detection; it is not
  the message body digest and is scoped to `(speaker, project, key)`.
- **P2 provisional visibility:** every read path filters `body_state` and committed rows;
  a DB view is deferred.
- **External gap:** live D1 (trigger/`RETURNING`/error-shape) remains unverified; the
  shared contract has a skipped D1 marker. No Cloudflare runtime/credentials here.

These corrections are landing before the slice-A checkpoint; the exact integrated tree
will be re-audited.

## Product requirement — native ChatGPT Web plugin (2026-11-03)

Corkboard must provide a native ChatGPT Web plugin experience, not only local MCP for
coding agents. Contract is now in `TODO.md` Phase 5 and `docs/api.md` (OAuth/MCP
planned). Status: **planned for Phase 5; no code or live platform verification yet.**

Required behavior:

- Install/connect from ordinary ChatGPT Web conversations; link a Corkboard account via
  OAuth 2.1 authorization code + PKCE.
- Fine-grained consent scoped to named projects and `message.read`/`message.send`.
- Send, retrieve and reply to messages. No API key may appear in conversation content
  or tool output.
- The REST API stays authoritative; remote MCP reuses the same service/authorization
  layer. Local Codex/Claude Code clients keep their own `CORKBOARD_APIKEY`.

Separate acceptance criteria, each recorded as verified/unavailable/untested against the
intended account/workspace: (a) plugin installation/connection, (b) account linking and
consent, (c) conversation-level tool invocation, (d) sharing/publishing feasibility.
Do not infer any of these from local MCP behavior or from another plan.

## Next eligible tasks

1. Migration 001 + `SqlDatabase` port + SQLite adapter + adapter-agnostic contract
   tests (D1 adapter deferred to slice B by recorded exception). Include a
   `ciphertext_digest` column; the plaintext digest lives only inside the encrypted
   payload, not as an unauthenticated DB copy.
2. AES-256-GCM envelope with metadata-only AAD and embedded plaintext digest + local
   blob store + tamper/failure
   tests; sender `body_digest` verification; secret bootstrap CLI.
3. Credential/speaker auth + authorization service + active-status policy + negative
   tests (spoofing, revocation, cross-project).
4. HTTP handlers + Node server + integration tests (send/list/body/read/replay),
   including concurrent sequence allocation and idempotent retries.
5. Independent security review and exact-revision audit before each checkpoint.
6. D1/R2 adapter and live staging test before Phase 1/vertical slice B completion.

## Open questions

- Cloudflare Workers/D1/R2 live staging (later; not blocking local slice).
- ChatGPT Web plugin plan capabilities: installation, linking, conversation tool
  invocation and sharing/publishing must each be tested on the intended workspace
  (Phase 5; external).

## Slot ledger

| Slot | Assignment | Status |
| --- | --- | --- |
| Commander | this session | active (integration/state) |
| Feature owner A | persistence + ordered-replay finalization | complete, integrated |
| Feature owner B | digest-bound envelope + blob stores | complete, integrated |
| Feature owner C | validation + credentials + authorization | complete, integrated |
| Feature owner D | credential-bound message service | complete, integrated |
| Feature owner E | HTTP API + Node server + CLI | complete, integrated |
| Security/audit | final exact-tree review | active after staging |

## Known limitations

- Scanner P2 edges: untracked symlinks are followed; intent-to-add fallback treats
  permission errors as absent; token families are high-signal, not exhaustive.
- Live D1/R2 is not implemented or tested; D1-specific trigger/RETURNING/error behavior
  is unverified. No Cloudflare credentials or staging binding are available here.
- Same-key concurrent sends can transiently orphan a blob/body-object row; messages and
  sequences stay unique, and the orphan is reclaimable.
- `q` case-insensitivity inherits SQLite `LIKE` (ASCII only).
- Expiry cleanup is an operator-run command with no in-process scheduler; deployments
  must schedule `expire-bodies` externally. No hard-delete/admin erasure path exists;
  expiry retains metadata and does not rewrite backups.
- No human web session, OAuth, MCP, or native ChatGPT plugin implementation yet.
- HTTP adapter caps declared and chunked bodies at 64 KiB and binds loopback by default;
  unconsumed request streams on non-body routes are drained by Node, so concurrent large
  unauthenticated uploads still add memory pressure. A reverse-proxy body limit remains
  recommended.
- `language` and `client_sent_at` lack tight length/format caps beyond the request-body
  limit; an authenticated sender can inflate stored/echoed metadata.
- Node timeout enforcement is quantized by the default 30s connection-check interval.
- Adapter-generated 413s bypass the request logger; `revoke-key` audits success even if
  the credential was already revoked.
- Two truly concurrent first sends with the same key may both answer `201`, but return
  the same message; replay inherits the committed body state.
- Project listing uses `instr` over app-written capability JSON for pagination.
- Engineered for D1 but only SQLite is executed; D1 trigger/RETURNING/error behavior is
  unverified.
- No human web session or OAuth yet.
- No attachments, rate limiting, or MCP.
- No Workers adapter.
- Server-readable encryption only; not E2EE.
- `lint` is strict typecheck; no separate linter.
