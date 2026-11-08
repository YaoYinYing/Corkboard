# Disaster rehearsal

**Applies to:** the self-hosted Node.js 24 + SQLite + local-blob implementation in
this repository. The D1 and R2 adapters pass their shared contracts against structural
doubles, and a Worker entrypoint exists and is exercised against those doubles with
standard `Request`/`Response`; there is no live Workers/workerd run, no Cloudflare
bindings, no wrangler configuration or migration application, and no deployment, so
the live D1/R2 variants of this procedure are inapplicable and are not simulated or
claimed.

**Script:** [`scripts/disaster-rehearsal.ts`](../scripts/disaster-rehearsal.ts)
**Related:** [`runbook.md`](./runbook.md) §6.1, [`incident-response.md`](./incident-response.md)
§Recovery, [`security-operations.md`](./security-operations.md),
[`deployments.md`](./deployments.md).

This is an executable, self-contained drill. It creates a fresh temporary directory
tree, initializes a synthetic installation in it, exercises backup/restore and the
recovery procedures, and removes every temporary directory it created, including on
failure. It never reads or writes a real installation and never prints a secret,
token, key, message body, or full temporary path.

## How to run

```sh
# source (Node.js type stripping)
node scripts/disaster-rehearsal.ts

# after `npm run build`
node dist/scripts/disaster-rehearsal.js

# machine-readable: exactly one JSON object on stdout
node scripts/disaster-rehearsal.ts --json

# list the procedure without running it
node scripts/disaster-rehearsal.ts --help
```

The script uses only the standard library and existing service/CLI code. There is no
new dependency. It takes roughly ten seconds on the development host and is bounded
by a 60-second timeout per CLI command; a full run should complete in one to two
minutes on a slower host. The integration test allows 180 seconds, above that upper
bound, so a run at the documented maximum cannot fail the suite. `npm run check`
includes unit tests of its redaction, secrets-file, and child-environment helpers and
integration tests that run the whole drill plus a forced mid-drill failure.

If the host cannot provide the required capabilities (Node.js < 24, POSIX `0600`/`0700`
file modes, WebCrypto, or `node:sqlite`), the script exits `0` as a skip. Without
`--json` it prints `disaster-rehearsal: SKIP: <reason>`; with `--json` it prints
exactly one object `{ok:false, skipped:true, reason, checks:[], summary}`. It does not
fail a host that is honestly unable to run the drill; a skipped run is not evidence
of recovery.

## What the drill does

Each numbered step records one or more named checks. Without `--json`, a successful
run prints `[ok] <check>` lines and a final `PASS` line; a failed run prints a final
`FAIL` line (completed checks are available in the `--json` object). With `--json`, stdout
is exactly one object: `{ok:true, checks, summary}` on success, or
`{ok:false, checks, summary, failed_check?, error}` on failure, with no human line.

1. **Private initialization.** `init` creates the data directory `0700` and a `0600`
   secrets file outside it. The script asserts both modes and that the synthetic
   root key and credential pepper are distinct 32-byte values. The secrets file and
   all key material are outside the repository.
2. **Synthetic provisioning and traffic.** The CLI provisions an owner account, two
   projects, two speakers, memberships, and three credentials that all use the
   default four member capabilities and differ only in their project grants; the
   service API sends messages, computes and verifies body digests, and
   writes read receipts. Audit rows come from the real credential/membership paths.
   The script asserts contiguous sequences, one receipt per `(message, speaker)`, and
   the expected sanitized audit operations.
3. **Backup and verify.** The CLI takes a database+blob backup and verifies it. The
   script asserts the manifest is internally consistent, the directory contains only
   `manifest.json`, `corkboard.sqlite`, and `blobs/`, the client cursor file is not in
   the backup, and no scanned backup byte contains the root key, pepper, any issued
   token, or any message body. A copy of the secrets file is made separately with
   mode `0600`; keys are never part of the data pair.
4. **Disaster and restore.** The script removes only the temporary live data
   directory, restores the verified backup into a new empty directory, verifies the
   backup again, and runs `doctor` against the restored directory. It then asserts
   that sequences, receipts, and audit operations are unchanged, every original body
   still decrypts with the separately backed-up keys and matches its digest, and the
   restored application router answers `/me`, send, list, and body read. It also
   tries a **different** root key and asserts the read fails closed with
   `INTEGRITY_FAILURE`, proving the data pair alone is insufficient.
5. **Audit integrity within the stated limit.** Audit rows are asserted to be
   sanitized: no body, token, key, or pepper appears in an operation or detail.
   `audit_events` has no hash/signature column and no trigger. The script then
   performs a direct database `UPDATE` of one audit row, observes that the rewrite is
   undetected, and reverts it. This is the honest guarantee: audit rows are
   metadata-only and bounded, but they are **not tamper-evident against an operator
   with database write access**. Absence of a row is not proof that nothing happened,
   and audit writes are fail-open (see the runbook).
6. **Cursor resynchronization.** The server keeps no client cursor. The script
   replays from scratch (`after_seq` from `0`) after restore, asserts ordered
   strictly increasing delivery, and asserts that receipt rows are still one per
   `(message, speaker)` and do not grow on a second replay. A cursor stored before
   the disaster is accepted for the same project and speaker, and is rejected when
   presented for a different project or speaker. The binding is
   `project_id + speaker_id`; the cursor has no data-directory field and is not
   silently trusted across installations with different identities.
7. **Revoke and rotate.** The script revokes a compromised credential with
   `revoke-key` and asserts REST and MCP both fail closed with HTTP `401` and
   `UNAUTHENTICATED` on the next request. It rotates a different credential with
   `rotate-key`, asserts the old token fails and the replacement authenticates, and
   asserts rotating an already-revoked credential is rejected.
8. **Interrupted send/finalize (not a migration or upgrade).** A fault-injected
   service deps object dies immediately before the finalize `UPDATE`, after the
   ciphertext blob, `body_objects` row, idempotency row, and provisional message row
   are already committed. The script asserts the pending row and blob reference
   exist and `doctor --stuck-minutes 0` reports `STUCK_PENDING`. It then separately
   synthesizes an in-progress `.tmp-<32 hex>` writer artifact (the injected failure
   does not leave one): a backup taken then excludes that artifact, still lists every
   committed blob, and verifies. A restart (a normal deps
   object) reuses the same idempotency key and payload: it publishes exactly once,
   allocates one sequence, returns the same message id on a second retry, and the
   resumed body decrypts. `expire-bodies` and `prune` then run without corrupting
   committed data, and `doctor` returns clean.
9. **Cleanup.** Every temporary directory created by the drill is removed in a
   `finally` block even when an assertion fails. The successful run also records a
   cleanup check.

## What this proves

- A verified database+blob backup can be restored into a new directory and the
  restored service can decrypt and serve known bodies with the separately backed-up
  root key.
- Sequences, receipts, and sanitized audit rows survive that round trip.
- A wrong root key fails closed instead of returning plaintext.
- Client cursors can be rebuilt with `after_seq`, at-least-once replay does not
  duplicate receipts, and a cursor is bound to a project+speaker pair.
- Revocation is enforced on the next REST and MCP request; rotation revokes the old
  token and produces a working replacement.
- The documented partial-write recovery works: a pending row is reclaimable by the
  same idempotency key, no duplicate is committed, `doctor` reports the stuck row,
  and cleanup preserves committed data.
- The audit guarantee, and its exact limit, are asserted rather than implied.

## What it does NOT prove

- **Not production data or production scale.** It uses a few synthetic messages in a
  temporary directory, not a production-sized database, disk pressure, or a real
  backup medium.
- **Not a real host or process crash.** The interrupted send/finalize step injects a
  failure immediately before finalization in-process. It does not kill the OS,
  corrupt SQLite pages, lose a disk, or exercise power-loss durability. SQLite WAL
  durability under a real crash remains a platform/driver property, not something this
  script can establish.
- **Not a network listener, TLS, proxy, or container drill.** The service surface is
  the in-process `createApp` router (the same router the Node adapter serves). Listener
  behavior has separate tests; TLS termination and reverse-proxy limits are documented
  in the runbook and preview checklist but remain unexecuted; cookie flags and
  container hardening have their own tests/documentation.
- **Not live D1, Workers, or R2.** The D1 and R2 adapters exist and pass their shared
  contracts against structural doubles, and the Worker entrypoint runs against those
  doubles with standard `Request`/`Response`; no live Workers/workerd run, Cloudflare
  binding, wrangler migration application, deployment, or live D1/R2 fault injection
  is made or claimed. `/readyz` on the Worker probes D1 and R2; R2 readiness is a head
  of a reserved sentinel key (connectivity/permission only, no object creation).
- **Not root-key or pepper rotation.** Neither rotation is implemented. The script
  restores the same key set; regenerating it would make ciphertext unrecoverable.
- **Not offsite key custody.** The "separate" key backup is a second file in the same
  temporary tree. Real deployments must store it on separate protected media.
- **Not audit tamper-evidence.** Direct database write access can rewrite audit rows
  undetected; the script demonstrates and reverts exactly that.
- **Not multi-process or concurrency behavior.** It is one process at a time and does
  not test multi-writer contention, rate-limit aggregation, or multi-process sessions.
- **Not OAuth, attachments, expiry-driven data loss, or real-user traffic.** Those
  paths have separate coverage; attachments are not implemented.
- **Not a recovery-point or recovery-time objective.** No RPO/RTO is measured or
  promised.

## Operator use

Run the drill as a scheduled or pre-release exercise, and after changing backup,
restore, credential, or migration behavior. Treat a skipped drill as untested. Keep
the real secrets file, key backup, and data directory out of the rehearsal: the script
always creates its own temporary tree and never touches an operator's data directory
or secrets file. A production
rehearsal with the operator's real backup and a scratch host is still the stronger
proof described in [`runbook.md`](./runbook.md) §6.1; this script makes the synthetic
half repeatable and cheap.
