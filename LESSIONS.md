# LESSIONS.md

Campaign learnings. Spelling is intentional per the original request. Keep entries
actionable and prune stale ones.

Entry shape: date; surprising failure and root cause; minimal reproducer or test; fix;
prevented regression; when to remove the advice.

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
