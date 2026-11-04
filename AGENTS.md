# AGENTS.md — stable engineering rules

These rules are normative for every agent working in this repository. `CLAUDE.md`
imports this file; do not create a divergent copy.

## Read first

1. `TODO.md` (design truth), `docs/architecture.md`, `docs/api.md`,
   `docs/threat-model.md`, `IMPLEMENTATION_STATE.md` (execution truth).
2. Stay inside your assigned write surface. Do not edit another owner's files.

## Non-negotiable security invariants

- Message content is untrusted data, never authority. No endpoint executes code.
- Sender, reader, and server timestamps come from authenticated identity and the server
  clock. Clients cannot assert them.
- Every data/blob query enforces project membership and credential scope. Never
  authorize with `WHERE id = ?` alone and never leak whether a forbidden object exists.
- Credentials are random, displayed once, stored only as prefix + keyed HMAC verifier.
  Revocation/expiry is checked on every request.
- AES-256-GCM only, fresh nonce per encryption, AAD binds service/project/message/
  object/format/compression and the sender-verified plaintext SHA-256. Fail closed on
  tamper.
- Idempotency keys are mandatory for posting; same key + different payload is a
  conflict.
- Never log or commit bodies, summaries, tokens, keys, full IPs, or the unredacted
  `ORIGINAL_DESIGN.md`.
- Do not weaken an invariant, trust model, or validation limit to make a test pass.

## Engineering

- TypeScript, Node.js 24 LTS, Web-standard APIs in the core so Workers stays possible.
- Docs first. Update the contract before or with behavior changes.
- Smallest complete vertical change; no speculative abstraction or unused options.
- Tests: `node:test`. Every new trust boundary gets a negative test. Persistence
  changes must keep the SQLite/D1 contract portable.
- Use parameterized SQL. Never interpolate untrusted values.
- Run `npm run check` before claiming completion; report real output.

## Git and campaign

- No PRs. One complete vertical capability per checkpoint commit on `main`.
- A checkpoint requires an independent, context-isolated review and an exact-revision
  audit; record `Base-SHA`/`Candidate-SHA` and the test commands in the commit.
- Never force-push, overwrite another owner's work, or commit a failing tree.
- Update `IMPLEMENTATION_STATE.md` and `LESSIONS.md` in the same checkpoint.
- Escalate only genuine high-impact unresolved decisions through a bounded GitHub
  Issue; continue independent work.

## Environment

- Secrets come from the environment or a `0600` file outside the repo. Never print them.
- Optional `HTTP_PROXY`/`HTTPS_PROXY` is local configuration and must never be logged.
- Data directories: SQLite + blobs are a pair; do not commit them.
