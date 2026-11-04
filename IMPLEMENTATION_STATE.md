# Implementation state

Execution truth for the Corkboard campaign. Design truth is `TODO.md`; this file records
what is actually implemented, verified, and next. It is updated in the same checkpoint
as the work it describes.

## Current status

| Field | Value |
| --- | --- |
| Phase | 0 — bootstrap and sensitive-data hygiene |
| Status | Bootstrap implemented at this tree; **initial checkpoint pending commit** |
| Branch | `main` |
| Base SHA | none (initial commit) |
| Review | Exact-tree security + docs review required before the checkpoint; results recorded in the commit trailer |
| Next milestone | Vertical slice A: storage, crypto, identity, HTTP (Phases 1–3, thin Phase 4) |

At the time this file was written, `git log` was empty by design: this is the initial
checkpoint candidate. Do not treat later phases as verified until their checkpoints
exist.

## Environment

- Node.js 24.22.1 (LTS line), npm 11.19.1, `.nvmrc` = 24.
- Package manager: npm with committed `package-lock.json`.
- Test runner: `node:test`; typecheck: strict `tsc`; `lint` currently aliases
  `typecheck` (ESLint deferred; no extra dependency yet).
- SQLite: `node:sqlite` built-in (planned; no native dependency).
- HTTP core: Web `Request`/`Response`; `node:http` adapter for self-hosting. Hono not
  pinned.
- Crypto: WebCrypto AES-256-GCM and HMAC (planned).
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
| 2026-11-03 | License deferred, safe default = no license file | Maintainer decision; tracked as an open question |
| 2026-11-03 | Campaign protocol revision pinned to REvoCompute `8cdf41a5` | Exact source record; adaptations documented |

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
| Key/secret bootstrap implementation | **Pending** (Phase 2); provisioning documented, scanner in place |
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
- The verified plaintext digest is bound into the AES-GCM AAD and carried inside the
  authenticated envelope. A separate ciphertext SHA-256 is stored for storage-integrity
  verification.
- Every body read verifies the ciphertext digest, decrypts, then verifies the plaintext
  digest. Any mismatch returns `INTEGRITY_FAILURE`, returns no content, creates no read
  receipt, and is audited.
- Status: **contract documented; implementation pending** in vertical slice A. Lessons
  will be recorded in `LESSIONS.md` with the implementation evidence.

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
   `ciphertext_digest` column; the plaintext digest lives only in the sealed
   envelope/AAD, not as an unauthenticated DB copy.
2. AES-256-GCM envelope with digest-bound AAD + local blob store + tamper/failure
   tests; sender `body_digest` verification; secret bootstrap CLI.
3. Credential/speaker auth + authorization service + active-status policy + negative
   tests (spoofing, revocation, cross-project).
4. HTTP handlers + Node server + integration tests (send/list/body/read/replay),
   including concurrent sequence allocation and idempotent retries.
5. Independent security review and exact-revision audit before each checkpoint.
6. D1/R2 adapter and live staging test before Phase 1/vertical slice B completion.

## Open questions

- License choice (maintainer).
- Cloudflare Workers/D1/R2 live staging (later; not blocking local slice).
- ChatGPT plan write capability (Phase 5; external).

## Slot ledger

| Slot | Assignment | Status |
| --- | --- | --- |
| Commander | this session | active (bootstrap/integration) |
| Feature owners | to be spawned after bootstrap checkpoint | idle |
| Security/audit | used for bootstrap; to be re-run per checkpoint | idle |

## Known limitations

- No human web session or OAuth yet.
- No server/CLI/migrations yet (planned interface only).
- No attachments, expiry worker, rate limiting, or MCP.
- No Workers adapter.
- Server-readable encryption only; not E2EE.
- `lint` is strict typecheck; no separate linter.
