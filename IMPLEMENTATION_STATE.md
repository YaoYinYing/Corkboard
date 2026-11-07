# Implementation state

Execution truth for the Corkboard campaign. Design truth is `TODO.md`; this file records
what is actually implemented, verified, and next. It is updated in the same checkpoint
as the work it describes.

## Current status

| Field | Value |
| --- | --- |
| Phase | 0 complete; vertical slices A–R implemented and pushed (slice O `f06c4ac`, UI design tokens `58e548f`, observability `48c52bc`); slice-S filter fix pushed as `704d115`; dashboard project create/edit (slice T) at `f1b13c9`; backup in-progress-temp snapshot fix (slice U, Issue #7) at `01538a0`; dashboard form adapter fix (slice V) merged at `4b1ba53`; Issue #8 atomic project creation (slice W) pushed on `origin/main` at `0f81877` (tree `b7a1653`); speaker directory and project-scoped credential issuance (slice X) pushed on `main` at `15cdf62` (tree `3260e71`); project membership editor (slice Y) at `48b5a86`/state `5ca3067`, audit fix `4110a43` (tree `31d84ac`), final docs/tests `499a772` on `main`; supply-chain audit/license/SBOM (slice Z) pushed on `main` at `f7e62be` (tree `06f664e`); the docs/state amendment is `1dfa284` (tree `bc6a82b`), which was `origin/main` before slice AA; dashboard credential inventory and revocation (slice AA) pushed on `main` at `dbb2a46` (tree `837ee76`); authorized account service overview (slice AB) pushed on `main` at `058e34f` (tree `4ae5dfa`), with the docs/state tail `30cf884` as `origin/main`; dashboard message send (slice AC) pushed on `main` at `2a17a75` (tree `4d5117f`); the slice-AC docs/state tail `b26b2fa` (tree `8a98be4`) precedes slice AD; blank message summary/text rejection (slice AD) pushed on `main` at `7812505` (tree `d0fb133`); Phase 8 operator runbook and acceptance report (docs deliverable) pushed on `main` at `a95e156` (tree `feec245`); bounded local load/soak harness (slice AE) pushed on `main` at `fcaf6a0` (tree `a6a121f`); local Docker Compose installation (TODO 368 local half) pushed on `main` at `6a50a71` (tree `4f7fffc`); dashboard credential project-grant editing (slice AF) pushed on `main` at `ee9606a` (tree `720c8c8`); atomic CLI credential rotation (slice AG) pushed on `main` at `e9065c1` (tree `0071dc6`); durable issue-sync timer pushed on `main` at `bf88c03` (tree `4a9271a`); missing-object/uncertain-retry/authorization-matrix security hardening pushed at `f39890f` with its docs/state tail `7747c93`; Issue #9 issue-comment paging fix (`since` + incomplete-scan exit `6`) pushed on `main` at `a4d6a85` (tree `b3cc95c`); at-least-once polling client (TODO 380) pushed on `main` at `534b5bf` (tree `9cb33d3`); read-only project policy matrix (TODO 388) pushed on `main` at `7322232` (tree `692e034`); self-hosted readiness probe (TODO 360) pushed on `main` at `39499ae` (tree `3e3527e`), with the docs/state tail `2a8ab88` (tree `d2aaa15`); reproducible-build manifest proof (TODO 407) pushed on `main` at `b2e89d3` (tree `40cb763`); release-hardening documentation/CORS test (TODO 411) pushed on `main` at `e59f367` (tree `4ae315d`); TODO 409 review remediation (`review-remediation` branch, base `959ce37` (tree `67734ba`); candidate commit `3187501` (tree `191549a`), amended in place with the final tree in the `Tree-SHA` trailer) covers the pre-auth rate limiter, OAuth grant widening, bounded `client_sent_at`, same-origin web hrefs, loopback-only poll HTTP, deployment doc drift, and secret-scan worktree/oversize gaps; not pushed |
| Last pushed checkpoint | `origin/main` is `349dc40b5cf4f4d94fadfc69eb3c433731f868cb` (tree `9201b770b82fa8befb6308811c5f0cf397054fc7`): operator `prune` writes one sanitized `retention.prune` audit row per deleting run (fail-open after commit), with prune audit semantics reconciled across docs and state (branch `prune-audit`, base `4a69f78`), audited candidate `15d6c65` on the same tree. Full security audit PASS-WITH-P2 at `2c5a107`, full contract audit PASS; docs/state correction deltas and the closure audit on tree `9201b77` returned security PASS + contract PASS. CI run `42408793482` succeeded. |
| Pushed-trailer correction | `3a03613`'s trailer fields are swapped: it records `Tree-SHA: 6b40b94afa11b3563ea1804cff6eb8ae29ed9951` (actually the pre-amend candidate commit) and `Candidate-SHA: d33409df9398a422f81590b107310e53ada6a116` (actually the tree). The correct values are tree `d33409df9398a422f81590b107310e53ada6a116` and pre-amend candidate commit `6b40b94afa11b3563ea1804cff6eb8ae29ed9951`. The docs/state-only tail content and both commits are unchanged; history was not rewritten because force-pushing is forbidden. |
| Branch | `origin/main` at `349dc40` (operator prune audit, tree `9201b77`). No local feature branch holds unmerged reviewed work. |
| Reviews | Phase 0: security PASS + contract PASS. Slice A: security PASS + contract PASS on tree `048065f`. Slices B–D: security PASS + contract PASS on trees `2bfaa9b`, `8ffff4a`, `bcc6a73`. Slice E: security PASS + contract PASS on tree `31a542a`; id-type fix PASS on tree `30e9267`. Slice F: security PASS + contract PASS on tree `66bc243`. Slice G: security PASS + contract PASS on tree `52bf6b7`. Slice H: security PASS + contract PASS on tree `f45a3b4`. Slice I: first audits BLOCKED on tree `b62879c` (Node adapter dropped the login body and collapsed `Set-Cookie`); fixed tree `cc8df35` security PASS + contract PASS. Slice J: first tree `bfea35c` PASS with P2s; fix tree `f321891` contract-BLOCKED (code-only tokens could not be revoked); final code tree `a439df4` security PASS + contract PASS, with a docs/state-only tail `4867ed0`. Slice I CI: runs 41889142173 and 41889225438 both success. Slice J CI: runs for `aac6f2e` and `e076129` both success. Slice K: first tree `0a6e649` security-BLOCKED (prune stripped an OAuth ownership association while a live refresh row could still revive the credential); fix tree `9c5991e` security PASS + contract PASS; final tree `1a5d207` security PASS + contract PASS (delta audits) with remaining docs/state P2s corrected here. Slice K CI: runs for `f0e43d3` and `7df76f7` both success. Slice L: first tree `905d2cb` security PASS + contract PASS with P2s (session viewer carried write capabilities; unbounded login redirect; docs/test gaps); fixed tree `5ea2439` security PASS + contract PASS (delta audits), with docs/state P2 wording corrected here. Slice L CI: runs for `45e5637` and `0d3f34b` both success. Slice M: first audit on final tree `ea34f5d` security PASS + contract PASS with four P2s (`unread=false` state, pager-doc empty-page wording, `h1` wrapping, `hasMore` non-serialization tests); fixed tree `aaab817` security PASS + contract PASS (delta audits). Slice N: first audit on tree `782ef11` contract PASS with six P2s, security BLOCKED on one P1 (backup created source WAL sidecars); fix tree `116cbb6` security PASS + contract PASS; final tree `e45dcdf` security PASS + contract PASS (delta audits), with low-severity redaction/JSON docs P2s recorded as debt and docs corrected here. Slice M CI: runs for `47c5af8` and `57df294` both success. Slice Z: first audits on tree `2b7e38e` returned security BLOCKED (P1: `sbom.ts` resolved `npm` through `PATH`, which `npm run` prepends with `node_modules/.bin`; P2: lock paths were checked only with `startsWith("node_modules/")`) and contract BLOCKED (missing `Tree-SHA` trailer, lockfile-driven scan and lock fallback undocumented, CLI exit-code tests absent). Fixes were reviewed at tree `3c05987`: security PASS + contract PASS. A residual security round removed bare `npm` from the `check`/`audit` chain, made absolute/traversal lock keys exit `2`, handled legacy `{type}` license objects, and routed the two pre-existing `dist`-build test helpers through `process.execPath` + `npm_execpath`. A contract audit then BLOCKED the same shim class via bare `node`/`tsc` in package scripts; all scripts now use `$npm_node_execpath` with a fail-closed `${npm_node_execpath:?...}` guard, and `tsc` is `node_modules/typescript/lib/tsc.js`. The final `Tree-SHA` is in the final commit trailer. Final audits on tree `06f664e` (commit `f7e62be`) returned **security PASS + contract PASS** with three non-blocking P2s (POSIX-only scripts understated by "as before"; `git` still PATH-resolved in the secret scans; the shim test's `tsc` assertion is static, not functional). Fast-forwarded and pushed on `origin/main`; CI run 42055915268 success. Slice AA: first candidate `fcd9d23` (tree `afb54d1`) had security PASS on the code but security BLOCK on a false Candidate-SHA and contract BLOCK on stale contract docs (README, api, architecture, threat-model, web-ui, security-operations); fix tree `4b3a712` passed security but was contract-BLOCKED because the inventory GET used the write transaction (`BEGIN IMMEDIATE`) against the documented D1 batch port; final tree `837ee76` security PASS + contract PASS (delta audits). Pushed on `origin/main` at `dbb2a46`; CI run 42073815812 success. Remaining P2s: the transaction-contract docs still describe a single write-only `transaction()` caller (recorded as debt). Slice AB: first tree `9b2c72d` (tree `9419a1c`) security PASS + contract BLOCK (stale "only per-project count surface" claims); fix tree `244bbe2` (tree `e01cffb`) security PASS + contract BLOCK (remaining "no audit read API/UI" statements and the TODO count-surface claim); final tree `4ae5dfa` security PASS + contract PASS (delta audits), with three wording P2s corrected in this tail (architecture "only read" scope, credential rows returned vs scanned, LESSIONS bound-parameter wording). Pushed on `origin/main` at `058e34f`; CI run 42091068724 success. Slice AC: round 1 `06e072f` (tree `c7847be`) security PASS + contract BLOCK (read-then-write publication against the D1 write-only port; contradictory session-authority docs); round 2 `7a0ae29` (tree `f8108b2`) security PASS with contract BLOCKs (overbroad "every caller write-only" claim, stale state bullet); round 3 `fa9147b` (tree `26774c6`) security PASS + contract PASS; hardening round tree `4d5117f` (commit `2a17a75`) security PASS + contract PASS adds the sender-bound finalize predicate. Remaining P2s: no bearer-statement mismatch negative test, and `commitBody`'s provisional body-object UPDATE is not sender-scoped under out-of-band idempotency tampering (row remains pending/invisible; DB-write access required) — recorded as debt. Pushed on `origin/main` at `2a17a75`; CI run 42109894286 success. Slice AD: first candidate `de225e9` (tree `964cf6c`) security PASS + contract PASS (P2s only); the contract audit then BLOCKed `66a55fd` on the project-metadata scope leak (security PASS); final tree `d0fb133` (commit `7812505`) resolved the scope by restoring base project validators and adding message-only wrappers, and returned security PASS + contract PASS (delta audits). Pushed on `origin/main` at `7812505`; CI run 42127147927 success; Issue #6 fix comment posted. Phase 8 docs: first tree `b06d748` (tree `4ad768b`) contract BLOCK (false "no CI run" row, five false "no browser capture" rows, four runbook precision defects); fix tree `13c2fc9` PASS with two asset-citation nits; final tree `feec245` (commit `a95e156`) delta PASS. Pushed on `origin/main`; CI run 42136790858 success. Slice AE: first candidate `57dbf3b` (tree `d362183`) security BLOCK + contract BLOCK (count flags were parsed but never applied; the in-process server's `SIGINT`/`SIGTERM` handler could override a failure with exit `0`); fix tree `a6a121f` (commit `fcaf6a0`) security PASS + contract PASS with non-blocking P2s recorded in the slice section. Pushed on `origin/main`; CI run 42149213699 success. Docker Compose local installation (TODO 368 local half): first tree `63eaca8`/`9555019` security BLOCK + contract BLOCK (unqualified "reproducible" against an unpinned, then-unverified base; missing container hardening and secrets-mode enforcement); second tree `11e214d`/`1c4f7d3` security PASS + contract BLOCK (provenance caveat itself false; real base had been pulled and used); third tree `bf0f6d1`/`0938feb` security PASS + contract PASS but the follow-up test tree `26274b3`/`7a15c82` FAILED `npm run check` (secret-scan false positive in the quickstart; the recorded exit 0 was false); final tree `4f7fffc` passed security + contract and a real `npm run check` with secret/history scans green. Pushed on `origin/main` at `6a50a71`; CI run 42172499324 success. Slice AF: first audits on tree `9d069c9` returned security PASS with S-P2s and contract BLOCK on one P1 (false "rotation remains CLI-only" claims) plus overbroad add/remove re-check docs and an incomplete D1 read-then-write debt list; the fix tree corrects those docs, adds the remove-route CSRF negative test and the stale-grant removal-after-membership-loss test, and records the grant callbacks in the debt; final tree `720c8c8` security PASS + contract PASS (delta audits; one message-only trailer-contiguity fix followed). Pushed on `origin/main` at `ee9606a`; CI run 42185637549 success. Slice AG: first tree `f5765b4` (commit `efc40fe`) security PASS with P2s and contract BLOCK (rotation missing from two normative D1 debt lists, stale origin/main refs, runbook/deployments omissions); fix tree `b873502` (commit `6f1c8f6`) rejected OAuth-issued credentials, added expiry/concurrency/owner tests, and corrected the docs; a precision round at tree `0071dc6` split the OAuth guard test per marker, fixed marker wording, marked the satisfied lesson, and labeled the manual smoke non-reproducible. Final tree security PASS + contract PASS (delta audits). Pushed on `origin/main` at `e9065c1`; CI run 42202110269 success. Issue-sync: audited candidate `7b5f9ee`; pushed on `origin/main` at `bf88c03` (tree `4a9271a`); CI run 42219197589 success; Issue #9 comment `6685044973` posted, and Issue #9 remains OPEN because a literal Commander restart was not demonstrated. Security-hardening checkpoint (TODO 334/344/381): security PASS + contract PASS, followed by a docs-only delta audit PASS on tree `e98ccba` (the token-exchange `resource` wording now says the check applies when the request presents one; RFC 8707 makes it optional). Pushed on `origin/main` at `f39890f` (tree `e98ccba`); CI run 42234602066 success. Debt: the missing-object test removes the ciphertext blob; a `body_objects` row cannot be deleted while foreign keys are on, so the row-absent branch remains exercised only by code inspection; the retry test drives `createApp` behind a loopback socket rather than the full `startServer` lifecycle/CLI stack. Issue #9 paging checkpoint (Issue #9, no TODO item): round 1 tree `f8f84fb` (commit `486cfc4`) was security BLOCK on the digest-deletion under-read P1 plus contract BLOCK on the `Branch` row P1; round 2 tree `8c259cf` (commit `a109644`) was security PASS with two recovery P2s and contract BLOCK on the `Candidate branch` row P1 plus the empty-digest test P2; the final code tree `3410d53` (commit `926c382`) was security PASS, with the per-issue first-sight and do-not-ingest-incomplete fixes probe-verified across two passes, and the final tree `b3cc95c` (candidate `e30f330`) passed the contract doc delta. Pushed on `origin/main` at `a4d6a85`; CI run 42247813848 success; Issue #9 comment `6689286890` posted. Debt: the no-silent-success retry property is probe-verified but not a committed second-pass test, and the exact 5 s overlap constant is unasserted. Slice AH (TODO 380 polling client): first tree `bdc3d49` was security BLOCK (body reads outside the deadline/abort, uncapped) with contract PASS and P2s; fix tree `47f4712` was security PASS with residual P2s and contract BLOCK (README/TODO acknowledgement-only wording, exit-table integrity-failure classification, pre-escape redaction); final tree `9cb33d3` (candidate `cd1b79e`) was security PASS + contract PASS. Pushed on `origin/main` at `534b5bf`; CI run 42265698250 success. Debt: race/path-swap coverage is inspection-only, an embedder-supplied sleep may ignore the signal (the CLI default is abortable), and the integration test uses `createApp` behind a loopback socket rather than the full `startServer` lifecycle. Slice AI (TODO 388 policy matrix): first tree `9b6dc31` (commit `442751c`) was security PASS with three P2s and contract BLOCK (stale origin/main rows, false `scope_json` claim, stale architecture enumerations); fix tree `a4479cf` (commit `83ba4fc`) was security PASS with one test-strength P2 and contract BLOCK on the remaining `docs/security-operations.md` claim; final squashed tree `692e034` (candidate `16f4e27`) was contract PASS with security applying byte-for-byte, and a missing-colon trailer syntax defect in the pre-squash message was corrected. Pushed on `origin/main` at `7322232`; CI run 42277606959 success. Debt: the dedicated owned-speaker-cap test is masked by the credential-row cap (removing the `.slice` alone does not fail it), and one inventory read per considered owned speaker is accepted amplification. Slice AJ (TODO 360 readiness): first tree `1ce462a` (commit `02747fa`) was security PASS with three P2 test-strength notes and contract BLOCK on the checkpoint row's missing per-run counts; the count fix on tree `3e3527e` (candidate `69f9100`) passed the contract delta with code/tests/docs byte-identical. Pushed on `origin/main` at `39499ae`; CI run 42283303074 success. Debt: the unauthenticated probe has no timeout/rate limit (bounded by `PRAGMA busy_timeout` and delegated to the reverse proxy), the rate-limit-bucket and non-directory-guard properties are test-strength gaps, and Docker/Worker readiness is untested. Slice AK (TODO 407 reproducible build): first tree `665f85b` (commit `6b427f0`) was security PASS with four P2s and contract BLOCK (stale slice-Z claim, overclaimed invocation, stale origin/main rows); the shared-build-definition tree `b9789a9` (commit `57a26fd`) was security PASS with two P2s and contract BLOCK on the stale Dockerfile comment; final tree `40cb763` (candidate `3b1fd9c`) got security PASS (exit-status and silent-failure fixes probe-verified) and contract PASS. Pushed on `origin/main` at `b2e89d3`; CI run 42295914205 success, including the new `build:repro` step. Debt: no committed regression test drives `scripts/build.ts`'s own entry path; SIGINT/SIGKILL can still leave a 0700 temp dir; the proof is scoped to this OS/toolchain/output depth and is not a Docker-image reproducibility claim. Slice AL (TODO 411 hardening docs): first tree `2096101` (commit `e11d330`) was security-blocked only because the owner's amendment changed the worktree mid-audit (content P2s: nginx Host/open-redirect/ACME/HSTS, privacy inventory, XFO/Referrer scoping, MCP 413 shape) and contract-BLOCKed (stale origin/main rows, retention contradiction, missing cross-links, XFO overclaim, deployments nesting); fix tree `febb551` (commit `5930643`) was security PASS with residuals and contract BLOCK on the MCP 413 adapter-vs-core wording and a privacy cross-link; final tree `12b3156` (commit `c7778fe`) passed both, then two docs-only deltas (`b8f0557`, `4ae315d`) removed the riskier session DELETE advice and fixed the revocation wording, each with security + contract PASS. Pushed on `origin/main` at `e59f367` (tree `4ae315d`); CI for that SHA concluded success (run ID redacted in this environment). Debt: TLS/HSTS/ciphers and per-IP limits are proxy configuration, not executed; there is no per-project storage quota and attachments remain blocked; no account-disable/root-key rotation exists; one minor wording nuance remains around per-project membership removal. Slice AM (TODO 352 adversarial probes): first tree `08d3ec1` (commit `1b495e0`) security PASS with four P2s and contract BLOCK (JWT evidence overclaim, stale `origin/main` rows, unstated timestamp-format dependency); second tree `becca32d` (commit `206feef`) security delta PASS with two residual P2s and contract BLOCK on one introduced false `Date.parse` claim (B4); final tree `c2244ab` (commit `6c527df`) security delta PASS + contract delta PASS. Labels used in the checkpoint row: B4 the false `Date.parse` claim; N1 the non-canonical-vs-unparseable timestamp wording; N2 the "unused transitive" `jose` phrasing; N3 the pre-recorded-Candidate-SHA process gap. Pushed on `origin/main` at `5e6bccf`; CI concluded success (run ID redacted in this environment). Debt: the `julianday` fail-closed guarantee is verified on the local SQLite engine only (D1 unexecuted); the session account-status clause is not isolable from the speaker-owner status check; and the new probes use direct database mutation, which is outside the API trust model. Issue #10 (polling receipt semantics): first tree `71116cb` (commit `fd08525`) security PASS with no findings and contract BLOCK on missing loopback integration evidence for the issue's failure/restart/default acceptance criteria plus stale `origin/main` rows, a renamed-test citation, and lost client coverage of the `mark_read` 410 race; final tree `f8401c2` (commit `f499342`, candidate `f499342`) security delta PASS and contract delta PASS, which judged HTTP-layer interception for the two synthetic `/body` failures acceptable because the un-intercepted success ordering test runs the real `createApp` body handler. Pushed on `origin/main` at `da6eba9`; CI concluded success (run ID redacted in this environment). Debt: no live-D1 run; the synthetic body-failure responses bypass the real body route; a cursor-write failure after a confirmed receipt can leave the cursor already replaced (documented in `docs/polling.md`), which is a documented at-least-once boundary, not a security defect. TODO 409 fresh-review remediation: the independent review ran at `959ce37` (no P0/P1; both report sets recorded in this file and the slice section); first candidate tree `191549a` (commit `3187501`) was security PASS with P3s and contract BLOCK on five rate-limit docs that still described the old post-auth `credentialId` keying; amended tree `c93d2bf` (commit `90351e5`) was contract delta PASS with a security BLOCK on two remaining "public prefix never selected" sentences and one state overstatement; final docs-only tree `d8b1bb3` (commit `b236635`, candidate `b236635`) was contract delta PASS and the security PASS on code carried forward unchanged. Pushed on `origin/main` at `5a310d1`; CI concluded success (run ID redacted in this environment). Debt: bounded-map eviction churn is accepted and documented; duplicate secret-scan findings for a secret in both index and worktree; no `git cat-file -s` precheck for index blobs; session/dashboard per-credential limiting, OAuth endpoint limiter ordering, history-scan runtime, systemd hardening, container readiness healthcheck, and CI Docker/nginx validation remain open. Private-preview deployment package: first tree `bdae822` (commit `a973d2e`) was security PASS with one P2 (unbounded preflight response read) and contract BLOCK (false baseline paragraph, missing Issue #11 reference, non-member check accepting any 404); second tree `63b6389` (commit `aeca486`) closed those but was contract BLOCK on procedure ordering and a stale base record; final tree `fbf73fe` (commit `d63e728`, candidate `d63e728`) returned security delta PASS (no P1/P2) and contract delta PASS. Pushed on `origin/main` at `f1845b6`; CI concluded success (run ID redacted in this environment). Nothing was deployed, and no browser, TLS, backup, or ChatGPT result is claimed. Debt: `localhost` name-based plaintext trust and minor preflight presentation nits. Codex CLI / Claude Code skill examples: first tree `d866b10` (commit `65374be`) was security PASS with P3s and contract PASS with a P2 on TODO numbering; amended tree `ef93903` (commit `35d310d`) was contract delta PASS but security delta BLOCK on the repository-root computation (`../../../` instead of `../../`), which rejected the documented default inbox; final tree `31a87c9` (commit `25f5ff2`, candidate `25f5ff2`) returned security delta PASS and contract delta PASS. Pushed on `origin/main` at `045ba2d`; CI concluded success (run ID redacted). No real Codex/Claude session or ChatGPT interoperability is claimed. Debt: the home-inbox test writes under the real `$HOME/.local/state` and leaves an empty parent, and `chmod 0700` applies to any operator-chosen inbox directory. TODO 411 disaster rehearsal: first tree `e7f2729` (commit `a1d188f`) was security PASS with two P2s and contract PASS with two P2s; amended tree `126f006` (commit `98bb50c`) returned security delta PASS and contract delta PASS; the rebased final tree `fe91cd3` (commit `4b99252`, candidate `4b99252`) returned security delta PASS and contract delta PASS, with only state-conflict and mode-specific doc/test-skip changes versus the audited tree. Pushed on `origin/main` at `5d25c1b`; CI concluded success (run ID redacted). The drill is executed against synthetic temp data only; production-host, real power-loss, TLS/proxy/container, D1/R2, key rotation, offsite custody, and RPO/RTO remain unexecuted. Load/soak coverage (TODO 410 bullet): first tree `e91f55e` (commit `14925de`) was security PASS with P3s and contract PASS with P3s; amended tree `7c260ee` (commit `b4118c7`) was contract delta PASS but security delta BLOCK on the POST gate ignoring the POST duration; rebased tree `2ce203a` (commit `fe40803`) passed both deltas, and the final rebased tree `3b34c4f` (commit `0e25e8a`, candidate `0e25e8a`) returned security delta PASS and contract delta PASS after the `201`-only tolerance and the corrected evidence count. Pushed on `origin/main` at `fbeaddf`; CI concluded success (run ID redacted). Coverage includes many small messages, slow chunked bodies, true 64 KiB/8 KiB/grapheme/byte boundaries, metadata search, concurrent speakers, rate-limit abuse with a real over-limit POST, and cleanup backlog; 10 MiB is recorded as structurally inapplicable because no upload/attachment route exists (Issue #5). Debt: D1/Workers/R2, TLS/proxy execution, OAuth/MCP/dashboard load, multi-process limiter aggregation, and long-duration memory soak are unexercised Negative-path coverage: security PASS and contract PASS on tree `894c6fe` (candidate `58f0f1c`), delta-confirmed; CI `42364059259` success. Dashboard expiry: security PASS and contract PASS on tree `0fa481b` (candidate `37e839e`); CI `42376352247` success. Dashboard rotation: security PASS and contract PASS on tree `d0d415a` (candidate `0e300b2`); CI `42387131642` success. TODO/receipts reconciliation: security PASS and contract PASS on tree `225558d` (candidate `28be6ae`); CI `42396434333` success. Prune audit: full security PASS-WITH-P2 (no P0/P1) and contract PASS on tree `1afd9c27`; docs/state corrections delta-audited on trees `8485415a`, `8a5c4a92`, and `9201b77`, with closure security PASS + contract PASS on `9201b77` (candidate `15d6c65`). CI `42408793482` success. |
| Next milestone | Root-key/pepper rotation with re-encryption (TODO 333) is the largest remaining security-relevant capability and the next candidate slice; per-message hard deletion needs a product/backup-policy decision and remains an Issue question, as does the MCP listening choice in Issue #12. D1/R2/Workers parity, the private preview, and ChatGPT Web remain blocked on infrastructure (Issue #11). |
| Candidate branch | `prune-audit` landed on `main` as `349dc40` (audited candidate `15d6c65`, tree `9201b77`). No unreviewed candidate remains. |

## Checkpoint history

| Commit | Tree | Capability | Reviews |
| --- | --- | --- | --- |
| 916b873 | `225558d` | TODO/receipts documentation reconciliation (branch `todo-reconcile`, base `264fb29`, docs-only): checked exactly one TODO box (335, local opaque blob storage: 0700 directory, 0600 `wx` temp file with atomic rename, opaque key validation, no blob route, local-only caveat) and appended an explicit reason to all 31 left unchecked, including the newly listed hard-impersonation-boundary item 351. Corrected the stale "Receipts UI — Not implemented / API-only" acceptance rows and the runbook "No receipt UI" to the implemented timeline read-receipt display while keeping the absence of a receipt-administration UI. No code, test, dependency, or workflow change. | Security PASS + contract PASS on candidate `28be6ae` (same tree); CI `42396434333` success. |
| 2e7ca3a | `d0d415a` | Dashboard credential rotation (branch `dashboard-rotate`, base `b699fb3`): a CSRF-protected rotate form for an active, non-OAuth credential of an active owned speaker; the POST resolves the account-owned inventory before parsing the form, passes the session account to `rotateSpeakerCredential`, and the service re-checks ownership inside its `BEGIN IMMEDIATE` transaction (optional `expectedOwnerAccountId`; the CLI omits it). The replacement token is shown once in a `no-store` 200; scopes, grants, and exact expiry are preserved and the old row is revoked with one sanitized `credential.rotate` audit row. Docs reconciled across api/web-ui/runbook/threat-model/security-operations/authorization/docker/acceptance-report/README. 13 files. | Security PASS + contract PASS on candidate `0e300b2` (same tree); CI `42387131642` success. |
| cef3c5e | `0fa481b` | Dashboard message-body expiry action (branch `dashboard-expiry`, base `9e4dc59`): the timeline renders a CSRF-protected expiry form for a ready body only when a `project.edit` viewer is resolved; the POST route authorizes before parsing the form, reuses the existing CSRF checks, and calls the unchanged `expireMessageBody`, so the single sanitized `message.expire` audit row, idempotent repeat, REST 200 JSON contract, and absence of new scope/policy/hard delete are preserved. 5 files; tests cover success/tombstone, non-owner editor, non-member, foreign message, authorization-before-parse, missing/wrong/duplicate CSRF, cross-origin, GET 405, idempotency, sanitized audit, control omission. | Security PASS + contract PASS on candidate `37e839e` (same tree); CI `42376352247` success. |
| 999ae74 | `894c6fe` | Negative permission and failure-path coverage (branch `negative-coverage`, base `60bafd17290d367b7e18849c79d000c86e51c4ee`): audits the committed suites against every project/session/OAuth/MCP authorization predicate and adds `tests/integration/negative-paths.test.ts` (6 tests) for malformed cursors/query parameters, sanitized persistence failure, blob-write failure plus same-key resume, invalid UTF-8 request bodies (with a fatal-decoder root fix in `src/app/handlers.ts`, `web.ts`, and `oauth.ts`; the SDK-decoded `/mcp` body and platform percent/escape normalization are documented exceptions, not covered), inactive principal/project bearer denial, and corrupt idempotency rows. SQLite is the only executed backend; the D1 contract test remains explicitly skipped, so "both backends" is recorded as structurally inapplicable, not passed. Audit verdicts, commands, and the recorded limitations are in the slice section. | Security PASS + contract PASS on candidate `58f0f1c` (same tree); CI `42364059259` success. |
| this checkpoint | commit trailer `Tree-SHA` | "Provide Codex CLI and Claude Code skill examples" (local Codex CLI / Claude Code integration examples): `examples/agent-integration/` adds `poll-consume.ts` (imports `scripts/poll.ts` and adds only an `onMessage` callback that writes verified, credential-redacted bodies to a private `0600` inbox before the poller's `mark_read`/cursor advance), `send.ts` (environment-only `CORKBOARD_APIKEY`, caller-supplied `Idempotency-Key`, poller-style deadline and 1 MiB streamed cap), `lib.ts` (env-only loading and error redaction), a Claude Code `SKILL.md`, and a Codex CLI `config.toml.example` + `AGENTS.md.example` + shell invocation; `tests/unit/agent-integration.test.ts` scans the examples with `findSecrets` plus a literal-bearer check and covers env-only loading, whitespace rejection, error redaction, inbox redaction/atomicity/privacy, and send oversize/timeout paths. Additive only: no application authorization, crypto, poller behavior, schema, dependency, or runtime-server change. Local examples only; no real Codex/Claude Code session and no ChatGPT integration is claimed. | Independent security and contract delta audits returned PASS on tree `31a87c9` after the repo-root/inbox corrections; both earlier rounds recorded. Pushed at `045ba2d`; audited candidate `25f5ff2` (same tree); CI concluded success (run ID redacted) |
| this checkpoint | commit trailer `Tree-SHA` | TODO 411 disaster rehearsal (no runtime/authorization/crypto change). `scripts/disaster-rehearsal.ts` runs entirely in fresh temp directories and removes them even on failure. It initializes a synthetic `0700` data dir plus `0600` secrets outside the repo; seeds accounts/projects/speakers/credentials (CLI) and messages/receipts (service); takes and verifies a database+blob backup, asserting keys/tokens/bodies are absent and keys are copied separately; removes only the temporary live dir and restores into a new empty dir, then verifies, runs `doctor`, and asserts sequences/receipts/sanitized audit rows survive, bodies decrypt with the separately backed-up keys and match digests, a wrong root key fails closed with `INTEGRITY_FAILURE`, and the restored application router answers `/me`, send, list, and body read; asserts audit rows are sanitized but not tamper-evident (no hash/signature/trigger; a direct rewrite is observed and reverted); replays `after_seq` from scratch with ordered delivery and no duplicate receipts, and rejects a stored cursor for a different project/speaker (binding is project+speaker, not a data-dir path); revokes a credential (`revoke-key`, REST/MCP `401 UNAUTHENTICATED`) and rotates another (`rotate-key`; old fails, replacement works, revoked rotation rejected); simulates an interrupted send/finalize by injecting a failure immediately before the finalize `UPDATE` after the provisional writes, separately synthesizes an in-progress `.tmp-<32 hex>` writer artifact, asserts `doctor --stuck-minutes 0` reports `STUCK_PENDING`, asserts a fresh verified backup excludes the artifact but still lists every committed blob, resumes the same idempotency key to exactly one commit, and runs `expire-bodies`/`prune` without corrupting committed data. `tests/unit/disaster-rehearsal.test.ts` and `tests/integration/disaster-rehearsal.test.ts` cover redaction/secrets parsing, child-environment scrubbing, the full drill (about 11 s), and a forced mid-drill failure (cleanup, non-zero exit, redacted output); `docs/disaster-rehearsal.md` states what is and is not proven and is linked from the runbook and incident response. Limits are recorded in TODO 411: synthetic small data; in-process fault injection, not a real crash/power loss; an interrupted migration/upgrade is not simulated; in-process router, not the listener/TLS/proxy; D1/R2, key/pepper rotation, and offsite key custody are inapplicable or unexercised; audit is not tamper-evident. | Security and contract delta audits returned PASS on the rebased exact tree `fe91cd3` (the disaster script and unit test are byte-identical to the earlier PASSed tree; only state-conflict resolution and mode-specific doc/test-skip changes were added). Pushed at `5d25c1b`; audited candidate `4b99252` (same tree); CI concluded success (run ID redacted) |
| this checkpoint | commit trailer `Tree-SHA` | Load/soak coverage for the Phase 8 bullet "many small messages, slow uploads, 10 MiB boundaries, metadata search, concurrent speakers, quota abuse and cleanup backlog", on branch `soak-coverage`, base `f1bf4f6b5638d9c9d6175b29c7614fc0d33dff21`. Extends the existing `scripts/soak.ts` harness (no parallel tool, no dependency): small-message contiguity plus two-page-size pagination stability; chunked slow uploads (8192-byte text verified by body `GET`, 8193-byte text deterministic `400`, exactly 64 KiB streamed JSON `201`); real boundary probes (64 KiB request cap, 8192-byte text, 140/141 graphemes, 1024/1032 summary bytes) with 10 MiB recorded structurally inapplicable because attachments are blocked by Issue #5, the app caps bodies at 64 KiB and the documented proxy cap is 1 MiB; four bounded `q=` searches (literal `%`/`_`, empty result, 100/101-character bound) during concurrent load; parallel speakers with contiguous shared `seq` and cross-project `404` isolation; sustained over-limit traffic yielding bounded `429 RATE_LIMITED` + `Retry-After`, an over-limit `POST /messages` whose `429` expectation is gated on the measured burst+gap+POST window being shorter than one refill interval (only a `201` after a possible refill is tolerated as skipped; any other non-`429` fails), and which leaves message and `body_objects` rows unchanged when it is `429`, and a second credential that still sends; and a prunable backlog built through real sign-in/sign-out plus expiry-eligible messages, with the expiry backlog drained by the real `expireDueBodies` service and the documented `expire-bodies`, two `prune` runs and `doctor` showing no remaining backlog with integrity/count/sequence assertions. The `dirty` report field is now `null` with `dirty_reason` when the `git status` probe fails instead of claiming a clean tree. Docs updated in `docs/soak.md`, `docs/acceptance-report.md`, `TODO.md`, state, and LESSIONS | `npm run check` exit 0 (696 tests: 695 pass, 1 skipped live-D1, 0 fail; secret/history/license scans green); `npm run build` exit 0; `npm run soak -- --profile quick` exit 0 (10.6 s, 401 requests, 267 messages, 0 integrity/5xx/network failures, 0 duplicates); `npm run soak -- --profile full` exit 0 (28.6 s, 1659 requests, 1307 messages). | Security and contract delta audits returned PASS on the rebased exact tree `3b34c4f` (the `201`-only tolerance, skipped-path allowance, and corrected 696/695 evidence count were verified; no other code changed). Pushed at `fbeaddf`; audited candidate `0e25e8a` (same tree); CI concluded success (run ID redacted) |
| this checkpoint | commit trailer `Tree-SHA` | Private-preview deployment package (no runtime/authorization/crypto change). `compose.preview.yaml` merges with the base file and uses `!override` for ports/volumes plus a distinct Compose project, explicit preview data-volume name, required preview secrets directory, and `127.0.0.1:${CORKBOARD_PREVIEW_PORT}:8787`; it inherits the read-only rootfs, `cap_drop: ALL`, `no-new-privileges`, non-root UID/GID, healthcheck, and stop signal. `docs/preview-deployment.md` gives the operator procedure: fresh `init` into a `0600` file outside the repository; synthetic owner/member/outsider accounts, projects, and credentials; an issued-then-revoked credential; a valid non-member credential; TLS reverse-proxy Option A (source-IP allowlist that does not intercept machine clients) and Option B (Cloudflare Access scoped to browser paths with explicit `/mcp`, OAuth token/registration/revocation, discovery, and bearer-REST bypasses; not a blanket front); loopback/firewall expectations; an acceptance checklist (image ID, secret mode/owner, hardening, loopback, TLS, proxy limits, `/healthz`, `/readyz`, cookie flags, CSRF, non-member 404, issuance/revocation, send/list/body/receipt/replay/conflict, restart persistence, backup/verify/restore, browser/manual gaps); rollback/decommission confined to the preview project and exact volume; and known limitations. `scripts/preview-preflight.ts` is a credential-safe, no-new-dependency HTTP preflight with `--base-url` (https or loopback origin only), `--credential-file` (regular `0600`, never printed), `--project`, optional revoked/nonmember credential files, and optional `--login`/`--password-file`; it checks health/ready, unauthenticated `401`, `/me` binding, list, deterministic send, body, receipt, replay, `409` conflict, revoked `401`, non-member `404` with exact `error.code = NOT_FOUND`, login cookie flags for the exact `SESSION_COOKIE_NAME`, and CSRF negative/positive, reading every response with a 1 MiB cap and printing only pass/fail and statuses with no token, cookie, body, or URL. `tests/unit/preview-preflight.test.ts` covers argument/file validation, the full pass path, redaction of a fetch error carrying the token, and fail-closed status/binding failures with an injected fetch. `npm run preview-preflight` follows the existing operator-script pattern. Rebased onto `0cd5ffc` (tree `bb8270e`), the docs/state tail that records the TODO 409 review-remediation checkpoint `5a310d1` (tree `d8b1bb3`) as independently audited and pushed; `da6eba9` remains the latest audited CI-passing code checkpoint before that remediation. **Nothing was deployed; host, domain/DNS, TLS, tester allowlist, and credentials are maintainer-supplied.** Results and blockers are tracked in Issue #11, `[Preview] Restricted private-preview deployment — status and blockers`. | `npm run check` exit 0 (673 tests: 672 pass, 1 skipped live-D1, 0 fail; secret scan ok, history scan ok, license scan 98 dependencies with 0 flagged); `npm run build` exit 0; built CLI config smoke exits `2` for missing/invalid arguments as documented; `CORKBOARD_PREVIEW_PORT=18787 CORKBOARD_PREVIEW_SECRETS_DIR="$PREVIEW_ROOT/secrets" CORKBOARD_SECRETS_DIR="$PREVIEW_ROOT/secrets" docker compose -f compose.yaml -f compose.preview.yaml config` exit 0 with only the preview volume, preview secrets bind, loopback port, and inherited hardening. No deployment, browser pass, TLS pass, backup rehearsal, or ChatGPT interoperability claim. Independent security and contract delta audits returned PASS on tree `fbf73fe` (security PASS with no P1/P2 after the 1 MiB cap and exact cookie-name fixes; contract PASS after the rebase to `0cd5ffc` and the §5.1 ordering fix). Pushed at `f1845b6`; audited candidate `d63e728` (same tree); CI concluded success (run ID redacted) |
| this checkpoint | commit trailer `Tree-SHA` | TODO 409 fresh-review remediation: pre-authentication bearer rate limiting keyed by the parsed token's public prefix (no credential SELECT/HMAC/`last_used_at` write when over limit), OAuth-issued credentials rejected for grant widening by the service, dashboard, and `grant-key-project` CLI via one shared predicate, bounded RFC 3339 `client_sent_at`, same-origin link normalization for duplicate leading slashes, cleartext-HTTP rejection for non-loopback pollers, `--ignore-scripts` install docs, a pinned SBOM fallback, corrected acceptance-report artifact claims, and secret-scan worktree/stat-before-read coverage. Docs updated wherever the limiter order/key, prefix selection, OAuth widening, `client_sent_at`, polling TLS, install, and scan behavior is described | Security audit PASS with P3s (pre-auth limiter meets the no-DB-work-when-limited requirement; host-check tricks, OAuth predicate, validation, link normalization, and scan fail-closed properties verified); contract audit BLOCKed the first tree on five stale rate-limit docs, then PASSed the final docs-only tree. Final exact-tree verdicts: security PASS, contract PASS. Pushed at `5a310d1`; candidate `b236635` (same tree); CI concluded success (run ID redacted). `npm run check` exit 0 (663 tests: 662 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0 |
| this checkpoint | commit trailer `Tree-SHA` | Issue #10 (polling receipt semantics): the reference poller now fetches and verifies `GET /api/v1/projects/:projectId/messages/:messageId/body` before any `mark_read`. It checks that `message_id` exactly matches the listed row, requires a canonical `sha256:<64 lowercase hex>` digest, recomputes SHA-256 over the UTF-8 `text` with `node:crypto`, and on success passes the metadata plus verified plaintext to `onMessage(message, body)`. Consumption is explicit: `--consume` or a programmatic callback; the default CLI is metadata observation only (one bounded page, optional `--show-summary`, no body fetch, no receipt, no cursor write, and an emitted `consumed=0, no body fetched, no receipt, cursor unchanged` line). Acknowledge and advance the durable cursor only after the callback returns and `mark_read` is confirmed, or after a definitive body `410 BODY_EXPIRED` tombstone (escaped status line, no receipt). Body `401`/`403`/`404` exit `2`; `5xx`/network/timeout exit `1`; a malformed contract or `410` without `BODY_EXPIRED` exits `3`; a digest mismatch is `INTEGRITY_FAILURE` exit `3`; a callback throw is `PROCESS_FAILED` exit `1`; all leave no receipt and no cursor advance. Body text and digest are never printed or logged; the existing request context/deadline and 1 MiB capped streaming read are reused, with no new HTTP machinery, dependency, schema, migration, or service-layer import. Docs: `docs/polling.md` (flow, receipt rule, `--consume`, failure table), `docs/api.md`, `README.md`, `TODO.md`, state, and LESSIONS | Pushed on `origin/main` at `da6eba9`; audited candidate `f499342` (same tree); CI concluded success (run ID redacted in this environment). Both exact-revision audits returned PASS: the security audit found no blocking/P1/P2 issues, and the contract audit judged the HTTP-layer interception of the two synthetic `/body` failures acceptable because the un-intercepted ordering test exercises the real `createApp` body handler. `npm run check` exit 0 (655 tests: 654 pass, 1 skipped live-D1, 0 fail; secret and history scans ok, license scan 98 dependencies with 0 flagged); `npm run build` exit 0. New unit coverage: transport-observed (injected-fetch) body-`GET`-before-receipt order; default CLI observation creates zero receipts and leaves the cursor bytes unchanged; body `401`/`403`/`404`/`429`/`5xx`/non-`BODY_EXPIRED` 410 failures; malformed/wrong-message/missing-field/non-canonical-digest/digest-mismatch; callback failure; body-fetch-succeeds / `mark_read`-410 expiry race; body cap, deadline, and signal abort; body/digest/credential redaction. Integration coverage over the real `createApp` loopback path asserts server-observed request order and verified plaintext, plus body-`GET` failure, digest mismatch, callback failure, restart-dedup after a persisted cursor, and default-observation no-receipt/no-cursor cases |
| this checkpoint | commit trailer `Tree-SHA` | Slice AM (TODO 352): adversarial probe suite. `tests/security/adversarial-probes.test.ts` drives the real `createApp` router in-process across object-level unknown/foreign IDs (project, message, body, receipt, credential, membership, audit), JWT-shaped/`alg:none` rejection with a scoped `src/` import scan, direct-dependency scan, and a lockfile assertion that the transitive `jose` is reachable only through `@modelcontextprotocol/sdk`; it is never imported by `src/` and never loaded by application auth code (the SDK's optional client auth-extensions module may import it); idempotency ownership (per-speaker/project, same-key conflict, out-of-band tamper fail-closed); injected credential/membership/session revocation and session account rebinding, inactive account, absolute expiry, idle expiry, and an unparseable expiry timestamp between blob write and publication; spoofed identity/time/sequence fields in REST, MCP, web forms, and OAuth consent; hostile Host/forwarded/override/duplicate headers, Origin/`Sec-Fetch-Site`, content-type confusion, percent-encoded CRLF; and SQL/path/prototype/oversize/deep-JSON/HTML injection. Two hardening fixes: the session-send finalize `UPDATE` now includes the active session row using portable `julianday()` timestamp comparisons (unparseable values fail closed), and idempotency replay rejects a record pointing at another speaker's message with `NOT_FOUND`. Docs: threat-model matrix/results/non-applicable items, authorization and API contracts, TODO 352, state, and LESSIONS. No dependency, migration, or schema change | Security delta audit PASS on `1b495e0` (P2s) and PASS on `206feef` (P2s); contract audit BLOCK on `1b495e0` (JWT overclaim, stale `origin/main` rows, timestamp claim) and BLOCK on `206feef` (B4 false `Date.parse` claim). Those findings plus N1 (non-canonical-vs-unparseable timestamp wording), N2 ("unused transitive" `jose` phrasing), and N3 (pre-recorded Candidate-SHA) were folded; the final exact-revision delta audits on tree `c2244ab` returned security PASS + contract PASS. Pushed on `origin/main` at `5e6bccf`; audited candidate `6c527df` (same tree); CI concluded success (run ID redacted in this environment). `npm run check` exit 0 (644 tests: 643 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0 |
| this checkpoint | commit trailer `Tree-SHA` | TODO 411 hardening configuration: documentation and cheap tests, no runtime feature. `docs/runbook.md` §3.1 is the authoritative nginx TLS example (HTTP→HTTPS redirect, TLS 1.2/1.3 ciphers, HSTS, `limit_req`/`limit_conn`, 1 MiB proxy body cap) and states the app is `node:http`-only, binds loopback, does not read forwarding headers, and requires HTTPS because cookies are `Secure`/`__Host-`. §3.2 records the served CSP and hardening headers, explicit no-CORS policy, cookie flags/lifetimes, rate-limit defaults/knobs/keying/429, and request/field quotas including blocked attachments and the absence of a per-project storage quota. New `docs/privacy.md` enumerates stored data, sanitized logs, no IP/third-party processing, operator access, retention/expiry, backups, and operator-defined contact. New `docs/incident-response.md` covers severity, operator-defined notification (no on-call claim), credential/grant revocation and service stop, no supported project-disable or root-key/pepper rotation, evidence preservation, backup/verify/restore recovery, and state/lessons updates. `docs/api.md`, `docs/deployments.md`, `docs/security-operations.md`, `docs/docker.md`, `docs/acceptance-report.md`, and `README.md` are cross-linked/corrected. `tests/integration/cors.test.ts` asserts no `Access-Control-*` headers on public, authenticated, HTML, login, unknown, and MCP-preflight routes. Cookie flags were already asserted by `tests/security/session.test.ts`; no duplicate test added | Contract audit BLOCKed `e11d330` on documentation accuracy (five P1 plus three non-blocking); the security audit found no P0/P1 but added P2s (nginx canonical Host/redirect/ACME/HSTS; privacy inventory; MCP header/413 scoping; CORS test). Delta contract audit then BLOCKed `5930643` on two accuracy issues (MCP 413 adapter-vs-core distinction; false privacy-link claim) and delta security PASSed with residuals (nginx catch-all TLS protocols/ciphers; privacy project/credential timestamps and refresh-row wording; stolen-session restart/SQL caveat; HSTS wording and Docker link; OAuth CORS coverage). This amendment folded all findings, re-ran the gates, and passed security and contract delta audits on the exact final tree; `Candidate-SHA` records the pre-amend commit with the same tree. Pushed on `origin/main` at `e59f367`; CI for that SHA concluded success (run ID redacted in this environment). `npm run check` exit 0 (624 tests: 623 pass, 1 skipped live-D1, 0 fail; secret scan ok, history scan ok across 162 commits, license scan 98 dependencies with 0 flagged); `npm run build` exit 0; `npm run secret-scan` exit 0 |
| this checkpoint | commit trailer `Tree-SHA` | TODO 407 remaining clause: reproducible-build proof. `scripts/build.ts` is now the single definition of the production build (`compileProject` runs `node_modules/typescript/lib/tsc.js -p tsconfig.build.json --outDir <dir>`; `copyMigrations` copies `migrations/`); `npm run build` calls it and `scripts/copy-migrations.ts` is removed. `scripts/reproducible-build.ts` (Node stdlib only, no network, no dependency) calls the same `scripts/build.ts` definition twice into two sibling temporary directories and compares sorted relative POSIX path + SHA-256 manifests. Identical non-empty trees exit `0`; a difference prints only the differing paths and exits `1`; a build or manifest failure, including an empty output tree, exits `2`. The temporary parent is removed in `finally` on normal completion and thrown failures; there is no signal handler and `execFileSync` blocks the event loop, so SIGINT/SIGTERM/SIGKILL or a crash can leave the random `0700` directory. Bounded at 10,000 files and 120 s per compile; non-regular output entries fail closed. `npm run build:repro` is wired into CI after `npm run build`. Tests cover identical output, a byte change, extra/missing files, creation-order independence, sorted canonicalization, empty output, a symlinked entry, the file cap, cleanup, and CLI exit `0`/`1`/`2`. `docs/supply-chain.md` records the procedure, the same-tree/OS/toolchain/config/output-depth scope, byte-only comparison without mtimes, and the limits (not a Docker-image proof; the Docker digest pin and `npm ci` lockfile are separate artifacts; `sourceMap: true` makes relative `sources` depth-sensitive). `TODO.md` item 407 is checked with the existing scan/audit/license/SBOM evidence. No application runtime, schema, migration, or dependency change | Base `2a8ab8817e7ee40408fa6d4877d1ff9332171cc0`; audited candidate `3b1fd9c2b4922a8024165a8ef17252fce0dd6d7b` (same tree `40cb763`); security PASS + contract PASS on the final tree (three delta rounds); pushed on `origin/main` at `b2e89d3`; CI run 42295914205 success; the prior candidate `6b427f0` was contract-BLOCKed and security-PASSed with four P2s, and this amendment folds those findings with an independent re-audit PENDING; `npm run check` exit 0 (623 tests: 622 pass, 1 skipped live-D1, 0 fail; secret scan ok, history scan ok across 160 commits, license scan 98 dependencies with 0 flagged); `npm run build` exit 0; `npm run secret-scan` exit 0; `npm run build:repro` exit 0 (two identical manifests, 104 files, Node 24.22.1 / TypeScript 5.9.3) |
| this checkpoint | commit trailer `Tree-SHA` | Slice AJ (TODO 360 readiness clause): public, unauthenticated `GET /readyz` in `src/app/handlers.ts`. Each request runs one bounded SQLite statement (`SELECT 1`) and a non-mutating blob-store check: `LocalBlobStore.checkReady` stats the directory, requires it to be a directory, and checks read/write/search access without creating it, scanning contents, or running an integrity check; `MemoryBlobStore` is always ready. Both pass → `200 {"status":"ready"}`; either throws or the database is closed → `503 {"status":"unavailable"}`. Neither body carries details, paths, versions, credentials, or private data, and both use the shared `json()` hardening headers (`Cache-Control: no-store`). The route is before authentication and API routing, so it creates no session/audit row, consumes no rate-limit bucket, and matches `/healthz` method behavior (`GET` only; `HEAD`/other methods `405 Allow: GET`). `routeLabelFor` gains a fixed `/readyz` label so metrics do not fold it into `unknown`. No dependency, migration, or schema change | Base `73222321f854e090e8c1e3b5ccc829080fb46ea2`; `tests/integration/readiness.test.ts` covers real SQLite + temp directories: ready `200` with exact body and headers, closed database `503`, missing local directory `503`, non-directory blob path `503`, existing local directory `200`, in-memory backend `200`, no secret/path leakage, unauthenticated access with no session or audit rows, non-API routing, `405` matching `/healthz`, and the distinct metrics label. Tests: `npm run check` exit 0 (609 tests: 608 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0. Audit: security PASS with P2 test-strength notes; contract audit BLOCKed `02747fa` on this row's missing per-run counts, which were added and delta-PASSed on candidate `69f9100`; pushed on `origin/main` at `39499ae`; CI run 42283303074 success. |
| `7322232` | `692e034` | Slice AI (TODO 388 policy-matrix clause): read-only, project-owner-only `GET /projects/:projectId/policy` in `src/app/web.ts`, linked from the timeline for the owning account. It renders active members against the seven `SCOPES` columns with textual granted/not-granted cells and a capability summary (bounded to 100 members), plus the session account's owned-speaker credentials holding a grant on the project (bounded to 100 speakers considered and 100 rows), showing credential ID, derived state, and stored scope identifiers. `authorizeProjectOwner` (re-read by `listProjectMembers`) gates the page; credential rows come from `listOwnedSpeakers`/`listOwnedSpeakerCredentials`, whose ownership/active-account predicates repeat per read. A non-owner member (even with `project.edit`), foreign/unknown/inactive project, inactive owning account, and unauthenticated/bearer-only request fail closed (uniform `404`, login redirect, or owner-predicate `NOT_FOUND` for a bearer). No form, CSRF surface, write, migration, dependency, or token/prefix/verifier rendering. The inventory service now also returns non-secret scope identifiers for the matrix; its page does not render them. When the 100-speaker credential bound is reached with no matching row, the empty state says the search covered only the first 100 owned speakers instead of claiming no grant exists | Base `8db3a82ad769df537ab530b3bc8da009a49b71c9`; contract audit BLOCKed `442751c` and security PASSed it with overlapping P2s; this amendment folds all findings in (origin/main and `scope_json`/LESSIONS/architecture doc corrections; truncated-empty caveat with a test; credential speaker/row bound tests), security PASS on `442751c` with P2s and on `83ba4fc` delta; contract BLOCKed `442751c`; this amendment plus the final `docs/security-operations.md` correction was squashed to a single commit on base `8db3a82` (candidate `16f4e27`, tree `692e034`) and passed security (code/tests byte-identical to `83ba4fc`) and contract delta audits; the pre-squash message's missing-colon trailers were corrected and `git interpret-trailers --parse` now yields all five; pushed on `origin/main` at `7322232`; CI run 42277606959 success; `npm run check` exit 0 (602 tests: 601 pass, 1 skipped live-D1, 0 fail; the new file contributes 14); `npm run build` exit 0; `npm run secret-scan` exit 0; mutation check: raising the three policy caps to 100000 fails the four member/credential truncation tests. Debt: the page performs one inventory read per considered owned speaker (up to 100); the bounded amplification is accepted and documented in `docs/web-ui.md`, not a scan-cost guarantee. Test-strength debt: the dedicated owned-speaker-cap test does not fail if the `.slice` bound is removed (its 101st speaker also carries a grant, so the credential-row cap masks it); the other two cap tests and the truncated-empty test do kill their mutations |
| this checkpoint | commit trailer `Tree-SHA` | Slice AH (TODO 380): at-least-once agent polling client. `scripts/poll.ts` reads a scoped bearer credential from `CORKBOARD_APIKEY` or a regular `0600` file (never printed, URL-embedded, or logged; every emitted line is redacted before terminal escaping), binds the cursor to the `/me` speaker and project, polls bounded `GET .../messages?after_seq=&limit=` pages, fails closed on malformed rows, foreign `project_id`, non-increasing `seq`, an oversized page, or a `next_cursor` that disagrees with the rows, treats summaries as untrusted metadata (no-op default; `--show-summary` only), and makes an explicit idempotent `POST .../read` with up to three attempts for network/`429`/`5xx`, validating the returned `message_id`/`speaker_id`. The request deadline covers the whole response: every body (identity, list, mark-read success, and error bodies) is streamed through a 1 MiB hard cap and aborted past it, so a stalled body cannot outlive the 15 s deadline and `Content-Length` is never trusted. A confirmed `200` advances the cursor; a definitive `410 BODY_EXPIRED` is consumed as a metadata tombstone without a receipt and also advances, while `401`/`403`/`404`, exhausted `5xx` retries, and other `410`s do not. Cursor replacement is atomic `0600` (temp + fsync + rename + directory fsync); on POSIX, token and cursor reads use `O_NOFOLLOW` + `fstat` with the mode checks (Windows may lack `O_NOFOLLOW` and skips the mode check). `--once`, `limit`/`--max-pages` bounds, abortable retry/backoff and between-pass sleeps, `SIGINT`/`SIGTERM` clean stop, and documented exit codes; identity `429`/`5xx` is a transient exit. On partial failure the last durable cursor is reused, so messages are reprocessed at least once; dedupe is consumer-owned. `docs/polling.md` records the contract, cap, expiry behavior, and server non-guarantees; linked from `README.md` and `docs/mcp.md`. No dependency, schema, migration, or runtime-server change | Security PASS + contract PASS on the final tree (three delta rounds: `04ba60b` security BLOCK on body-read timeout/cap with contract PASS and P2s; `b13c2e2` security PASS with residual P2s and contract BLOCK on README/TODO and exit-table contradictions; `534b5bf` final PASS from both); audited candidate `cd1b79e689239ae677974a01b333d26b6e1875c6`; pushed on `origin/main` at `534b5bf`; CI run 42265698250 success. Tests: `tests/unit/poll.test.ts` (cursor only after a confirmed `mark_read` or a definitive `410 BODY_EXPIRED`; rejected/uncertain does not advance; stalled body aborts at the deadline; signal during a body read stops; cap+1 fails for success and error bodies; `410 BODY_EXPIRED` advances while `401`/`403`/`404`, a `410` without `BODY_EXPIRED`, and exhausted `5xx` do not; wrong `message_id`/`speaker_id`; non-increasing `seq`; oversized page; same-message retries and numeric `Retry-After`; abort during retry backoff and between-pass sleeps; identity `5xx`; redacted/escaped error codes and a control-character credential echoed in a summary; loose/symlink/malformed/wrong-project cursor and symlink token) and `tests/integration/poll.test.ts` (real `createApp` over loopback: two bounded pages → three `mark_read` receipts → cursor 3; an idle second pass adds nothing) |
| this checkpoint | commit trailer `Tree-SHA` | Issue #9 fix: `scripts/issue-sync.ts` reads issue comments with the documented `since` parameter instead of unsupported `sort`/`direction`. With a stored per-issue `lastCommentUpdatedAt` it requests `since` = that time minus a 5-second overlap and relies on GitHub's default ascending comment-id order; a first-sight issue reads from the beginning without `since`; the first-sight decision is per issue (only issues with at least one digest record use `since`). A bounded pass that reaches `MAX_COMMENT_PAGES` with a full final page cannot prove coverage: it does not append that issue's fetched records to the digest (only complete issues' records are appended), writes no cursor for the whole pass, logs `status=incomplete issues=<n,...>`, and exits the new code `6`. Unit tests use a fake `gh` that ignores `sort`/`direction`, honors `since`, returns ascending comment ids, and applies `per_page`/`page`; they cover a new comment on a 501-comment issue via the cursor window (ingested once, no unsupported params), an edited older comment (once after edit, not duplicated on the next run), a first-sight 501-comment issue (exit `6`, no cursor, `status=incomplete`, no digest records for that issue while a complete issue's records are kept), an empty 0-byte digest with a stale cursor (same no-`since` full re-read as absent), and per-issue first sight when another issue has digest records. Security-audit P1 and P2s fixed: the digest is per-issue truth, so any issue without a digest record is read from the beginning even when other issues have records; absent and 0-byte digests therefore re-ingest history instead of inheriting a stale `since`; an incomplete page-cap read is not ingested, so it cannot seed a cursor that hides the uncovered range. Contract-audit P2s: the Bounds section scopes the appended-comment guarantee to `since` windows within the cap, notes a >cap window exits `6`, and records the visibility-lag risk; LESSIONS records both the documented-parameters and dedupe-truth lessons; the Branch row is corrected to `7747c93`/`9ae16b4`, the `Candidate branch` row names this unpushed candidate, and the Reviews row records both audit rounds. No write path, dependency, or schema change. Debt: the "a second pass keeps exiting 6 without silently succeeding" property is probe-verified by the audits but not asserted by a committed test, and the exact 5-second overlap constant is unasserted (a 0 s mutation fails the tests, a 1 s mutation passes) | Base `7747c93e384ddc6274df5273aa5467064dd650de`; Candidate-SHA `e30f330844f6b27d5c4af289420036e355037a0e`; security PASS on the code tree `3410d53` (delta audits; two recovery P2 residuals fixed and probe-verified) and contract PASS on the final tree `b3cc95c` (docs/state-only delta); pushed on `origin/main` at `a4d6a85`; CI run 42247813848 success; `npm run check` exit 0 (562 tests: 561 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0 |
| `f39890f` | `e98ccba` | Security hardening (TODO 334/344/381): a committed missing-object test starts from a ready message, removes the ciphertext through `BlobStore.delete`, and asserts `INTEGRITY_FAILURE` with no content, no receipt, and failure audits; an uncertain-acceptance retry test runs the real `createApp` handler behind a loopback `node:http` server, commits the first POST, destroys the socket before the response, then retries with the same `Idempotency-Key` (same `message_id`/`seq`, different payload `CONFLICT`, one message/blob/key row); `docs/authorization.md` records the actor/resource matrix and exact bearer/session/owner/OAuth predicates, including non-existent roles. No dependency, migration, schema, or CI change | Base `981c76173e7423a9140177012541ea00a246880e`; Candidate-SHA `f717e6ee5ce4a1eb39c7d2fee2cbd95d2fe84a10`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (556 tests: 555 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0; mutation check: returning empty content instead of failing closed in a scratch copy makes `a missing ciphertext blob on a committed message fails closed with no content or receipt` fail with "Missing expected rejection"; pushed on `origin/main` at `f39890f`; CI run 42234602066 success |
| `bf88c03` | `4a9271a` | Durable GitHub Issue sync (Issue #9): `scripts/issue-sync.ts` (Node 24 stdlib only, `--experimental-strip-types`) performs one bounded read pass — `gh api user` must equal `YaoYinYing` before any state write, then REST discovery `gh api "repos/<owner>/<repo>/issues?state=all&sort=updated&direction=desc&per_page=50"` (pull requests filtered after the 50-record window, numeric comment count only; issue bodies present in the REST response are unused and the discovery response contains no comment bodies) plus bounded `gh api` comment paging; appends new/edited comments exactly once to an append-only JSONL digest keyed by `(databaseId, updatedAt)`, with a versioned per-account/repo cursor, `0600` files in a `0700` state dir under `${XDG_STATE_HOME:-$HOME/.local/state}/corkboard-issue-sync/`, atomic temp+rename+fsync writes (temp unlinked on any failure), symlink rejection for the state dir and cursor/digest/log/lock paths, an atomic stale-lock reclaim that never deletes a live lock, fail-closed malformed state/digest handling, and a 1 MiB-rotated log. It never posts/replies, never logs bodies or credentials, and uses no network beyond `gh`. Installed as the systemd user timer `corkboard-issue-sync.timer` (`OnCalendar=*-*-* *:38:00`, `Persistent=true`, `AccuracySec=1min`; service `Type=oneshot`, `TimeoutStartSec=15min`, 60 s per `gh` call, absolute Node/script paths, clean journal output, no auto-restart). Templates in `ops/systemd/`; docs in `docs/issue-sync.md`; hermetic unit tests cover exactly-once, edits, REST payload/PR filtering, exact discovery arguments/order, symlink rejection, stale-lock reclaim, temp-file cleanup, state-failure logging, malformed cursor/digest/payloads, modes, and locking. Limitation: 50 issues and 5x100 comments/issue per pass; same-second duplicate edit keys; reads/queues only — the interactive Commander posts replies | Base `779eea2`; pushed on `origin/main` at `bf88c03` (tree `4a9271abe9096247ac960bb272b0be825b9d064b`); audited candidate `7b5f9ee`; CI run 42219197589 success; `npm run check` exit 0 (554 tests: 553 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0; live timer `enabled`/`active`, `Persistent=yes`; manual probe runs ingested probe `6683115223` 1 then 0 (19 duplicates), digest occurrences=1; autonomous timer run at `LastTrigger 2026-11-06 03:38:00 PST` completed `03:38:54 PST` with `Result=success`/`ExecMainStatus=0`, ingested=0/duplicates=19, probe occurrences=1, next elapse `04:38:00 PST`; `daemon-reexec` is a systemd manager reexec, not a Commander restart |
| `e9065c1` | `0071dc6` | Slice AG: atomic CLI credential rotation — `rotate-key --credential <id> [--expires-at <RFC3339>]` backed by `rotateSpeakerCredential`. Rejects unknown/revoked/expired/inactive-speaker/inactive-owner credentials and OAuth-issued `cb_oat_`/association credentials with no writes; copies the old scopes and current project grants exactly; inserts the replacement, copies grants, and soft-revokes the old row in one `BEGIN IMMEDIATE` transaction with full rollback on failure; preserves the old expiry (including `NULL`) by default; prints only the new token once; audits `credential.rotate` with bounded project IDs and no secrets. No dashboard view, dependency, migration, or schema change | Base `a174377f452a7d3ef7cbffbd597e33a4ced1734b`; security PASS + contract PASS on tree `0071dc6`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (531 tests: 530 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0; per-condition OAuth mutation checks; pushed on `origin/main` at `e9065c1`; CI run 42202110269 success |
| `ee9606a` | `720c8c8` | Slice AF: dashboard credential project-grant editing — `POST /speakers/:speakerId/credentials/:credentialId/grants` and `.../grants/remove`, session-only (no bearer), double-submit CSRF plus fetch-metadata, 64 KiB body cap, Node adapter buffering. The inventory renders an add form (speaker's active, account-readable projects) and per-grant remove forms only for **active credentials of active speakers**; revoked/expired/unparseable/inactive-speaker credentials are read-only and the service returns uniform `404` for them. Add requires account-owned active speaker, that speaker's active credential, the CLI `activeMembershipCapabilities` membership predicate, and account `project.read` access, all re-read in one `SqlDatabase.transaction`; existing grants are idempotent (`?grant=exists`, no duplicate audit). Remove uses the CLI `revoke-key-project` SQL and returns the same `303`/`?grant=removed` whether or not a row existed (no existence leak; audit only on a real deletion). Sanitized `credential.project.grant`/`credential.project.revoke` audits; en/zh. Remove deliberately re-checks only speaker ownership/status and credential state, not membership or account read access, so a stale grant stays removable after membership loss. At this checkpoint rotation was unimplemented in every surface (revoke-then-issue was the replacement; slice AG later adds atomic CLI rotation), per-credential expiry selection exists only as the CLI `issue-key --expires-at` option at issuance, and dashboard message-expiry management is unimplemented (the compose form's optional body-expiry field is the only expiry UI). Debt: both grant callbacks are read-then-write and join the pre-existing D1 read-snapshot debt; the add route's `?grant=added\|exists` outcome depends on the in-transaction `changes` count from `INSERT OR IGNORE`, which a batch-emulated D1 result cannot supply | Base `317ffa0b44ae9361462aea7ea5900081d7704635`; pushed on `origin/main` at `ee9606a` (tree `720c8c8`); CI run 42185637549 success; final tree security PASS + contract PASS after the rotation/remove-wording/D1-debt fixes, the remove-route CSRF test, the stale-grant removal test, and a message-only trailer-contiguity fix; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (523 tests: 522 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan` exit 0; debt: no real-browser capture for the grant UI, and the stale-grant remove test keeps account read access via a second speaker, so a read-loss remove variant is untested |
| `6a50a71` | `4f7fffc` | Docker Compose local installation (TODO 368 local half): multi-stage `Dockerfile` on `node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9` (build with dev dependencies and `npm run build`; runtime `npm ci --omit=dev --ignore-scripts`, `dist` with `dist/migrations`, fixed non-root `1000:1000`, `/data` `0700`, `STOPSIGNAL SIGTERM`, `/healthz` healthcheck, no secrets), `.dockerignore`, one-service `compose.yaml` (named data volume, read-only secrets-directory bind, loopback publish, `restart: unless-stopped`, healthcheck, non-secret env only), `scripts/docker-entrypoint.sh` (absence allowed; a present path must be a readable regular file, not a symlink, with mode exactly `0600`; Linux-only negative suite `tests/unit/docker-entrypoint.test.ts`), and `docs/docker.md` (quickstart with UID-1000/ancestor-traversal-safe directory creation, non-destructive `init` through a second read-write mount, first-owner bootstrap, UID/volume ownership, secret handling, persistence/restart, backup/restore, ports/TLS, single-process limits, upgrade/rollback, explicit Workers/D1/R2 gap). Docs links added; TODO item 368 stays unchecked because the Worker half is unimplemented. No application `src/` runtime, dependency, migration, or CI change (the container entrypoint script changed) | Base `341c9ad72ee5356f56dbb093cc01095b4c0f8ff8`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (516 tests: 515 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `CORKBOARD_SECRETS_DIR=... docker compose config` exit 0; `docker compose build` exit 0 on pinned `node:24@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9` (image `sha256:bf75542fa9692170726ea7ebb8f95a8d3ecbbac6853f375a247483de1234e68b`; first 5 layers match the pinned base); first `init` exit 0, second exit 1 with unchanged secrets; secrets mode `0644` rejected, `0600` accepted, absence allowed, and `serve` without keys exit 1; `up -d --wait` healthy and `/healthz` `{"status":"ok"}`; `id` = `uid=1000(node) gid=1000(node)`; `/data` `700`, DB `600`, `/data/blobs` `700`; `ReadonlyRootfs=true`, `CapDrop=["ALL"]`, `no-new-privileges:true`, secrets bind `RW=false`, `/app` and `/run/secrets` writes fail `Read-only file system`, `/tmp` writable; secret key names absent from config/inspect/image; bootstrapped owner and project rows survived restart; `down -v` removed the stack with no residue; real base verified: Node 24.22.2, npm 11.19.1, Debian 12.15 |
| `fcaf6a0` | `a6a121f` | `scripts/soak.ts` plus `npm run soak` (not part of `npm run check`) runs the real `startServer` on an ephemeral loopback port against a temporary installation outside the repository with synthetic principals. Profiles `quick` (default) and `full`, plus bounded count flags. Scenarios: many small messages with same-key replay; concurrent speakers exchanging replies; the 8192-byte text cap accepted and 8193 rejected; summary search plus ascending cursor pagination; no/invalid/revoked/missing-grant/non-member rejection; injected-clock body expiry with blob deletion and a real `expire-bodies` CLI rerun; a real `prune` CLI over a backdated revoked-session backlog (messages unchanged); and a dedicated 30/minute burst-5 server producing the documented `429 RATE_LIMITED` responses with `Retry-After`. One JSON report on stdout (counts, status/error classes, p50/p95/max) plus a short stderr summary; any `INTEGRITY_*`, unexpected 5xx, network/timeout, duplicate, ordering, or authorization assertion failure exits non-zero. Coarse latency guards are environment-dependent and non-fatal. `docs/soak.md` documents scope, commands, report fields, thresholds, evidence, safety, and gaps. The only default-suite addition is a fast argument/percentile/threshold/boundary unit test. No dependency, migration, or runtime behavior change. Attachments/10 MiB, slow uploads, quotas, D1/Workers/R2, TLS, and multi-process are not covered | Base `a530693f479a7b8fbcc277f8cf367b81b466126d`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (509 tests: 508 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run soak -- --profile quick` exit 0 (319 requests, 261 messages created, 0 integrity failures, 0 unexpected 5xx, 0 network errors, 0 replay duplicates, 7 expected 429s; 25 sessions pruned; all 261 messages unchanged); synthetic data and throwaway keys in a temp directory only; no production data or real secret used |
| this checkpoint | commit trailer `Tree-SHA` | Docs (Phase 8): versioned operator runbook and acceptance report. `docs/runbook.md` v1 (dated 2026-11-05) covers prerequisites, secrets/data separation, `init` and provisioning, serving/stop/health, reverse-proxy TLS example, credential issuance/inventory/revocation and rotation limits, REST/MCP/dashboard send, idempotency, body expiry/`expire-bodies`/`prune`, backup/verify/restore and disaster recovery, `doctor`, incident response, audit-read limits, known limits, and sequential-migration upgrade/rollback. `docs/acceptance-report.md` v1 maps TODO §6 Phase 8, the release gate, and §8 measures to Verified locally / Verified in CI / Verified externally / Simulated only / Not implemented / Untested, with exact revisions (`e79d60e` head, `2a17a75` UI browser evidence, `7812505` blank validation), CI run IDs, and explicit no-production/no-staging/no-real-secret statements. Both are linked from `docs/deployments.md` and `README.md`; no runtime, test, migration, or package change | Base `e79d60e001e5ac6c6eee7f06e17a86aa48d16c4f`; contract audit BLOCKed the first tree `b06d748` (tree `4ad768b`) on a false "no CI run" row, five false "no browser capture" rows, and four runbook precision defects; fixed tree `13c2fc9` PASSed with two asset-citation nits; final tree `feec245` (commit `a95e156`) delta PASS; security review not applicable beyond document secrecy (secret scan passes); pushed on `origin/main` at `a95e156`; CI run 42136790858 success; all cited commands exist in `scripts/corkboard.ts` and were checked against the built CLI; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (502 tests: 501 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; synthetic temp-directory smoke exercised init/provisioning/serve/REST send/replay/conflict/body/list/prune/expire-bodies/doctor/backup/verify/restore and init refusals, with no token or key printed; no production or staging deployment and no real secret used |
| this checkpoint | commit trailer `Tree-SHA` | Slice AD: reject blank message summary and text at the message-send layer — new message-only `validateMessageSummary`/`validateMessageText` wrappers call the restored length-only `validateSummary`/`validateText`, then reject a value consisting only of Unicode `White_Space` and/or `Default_Ignorable_Code_Point` characters with `VALIDATION_ERROR`; the check runs after the grapheme/byte checks so limit errors keep precedence; any character outside those categories makes it non-blank (U+2800, non-whitespace controls, lone combining marks are accepted); non-blank internal spaces/newlines stay valid and are never trimmed or normalized; project title/summary keep their base `trim()`-based behavior and `validateSummary` stays length-only; the service validates before its replay/resume decision, so a historically blank payload cannot be replayed with its old key; docs state the exact rule and replay edge; domain, REST, MCP, and dashboard tests assert rejection (including Unicode blank cases) and no writes, project-metadata regression tests pin the unchanged behavior, and `"a b"`/multi-line acceptance remains | Base `b26b2faa9ae12ee4b128bafc88b5b98770c0d5a9`; finding from real-browser evidence at `2a17a75` (Issue #6); audit round 1 PASSed on candidate `de225e9` (tree `964cf6c`), then the contract audit BLOCKed the project-metadata scope leak on `66a55fd`; final tree `d0fb133` (commit `7812505`) security PASS + contract PASS (delta audits); pushed on `origin/main`; Issue #6 fix comment posted; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (502 tests: 501 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0 |
| this checkpoint | commit trailer `Tree-SHA` | Slice AC: dashboard message send — `GET`/`POST /projects/:projectId/messages/new`, sender select restricted to active account-owned speakers with an active membership carrying `message.send`, summary/text/type/language, optional same-project reply and optional RFC 3339 body expiry, server-computed digest, per-render hidden idempotency key (same payload replays, different payload `409`), session CSRF/fetch-metadata and 64 KiB adapter buffering, uniform `404` for unreadable project/foreign or ineligible speaker, `303` to the timeline; dedicated `authorizeSessionSend`/`authorizeMessageSend` path (never `authorizeProject`'s read branch); the session predicate is folded into the one write-only, result-independent finalize `UPDATE`, and the outcome is inferred only from the post-commit row (ready/expired = success/replay; pending/missing = uniform `404`) | Base `30cf884c080184ccdf7a01e6123c5a70283b432f`; round-1 audits on `06e072f`/`c7847be` were security PASS and contract BLOCK; round-2 on `7a0ae29`/`f8108b2` was security PASS with only contract-accuracy BLOCKs; round-3 on `fa9147b`/`26774c6` passed both audits, and the hardening tree `4d5117f` (commit `2a17a75`) binds the sender into both finalize statements and adds the tampered-idempotency test; security PASS + contract PASS on tree `4d5117f`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (496 tests: 495 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; pushed on `origin/main` at `2a17a75` |
| `df99e90` | `0459cfb` | Phase 0 docs, toolchain, secret hygiene | security PASS; contract PASS |
| `b5c421d` | `048065f` | Vertical slice A: encrypted messaging, ordered replay, REST API, CLI | security PASS; contract PASS |
| `7b5a63b` | `2bfaa9b` | Vertical slice B: body expiry tombstones, audited expiry endpoint, cleanup worker | security PASS; contract PASS |
| `0052909` | `8ffff4a` | Vertical slice C: credential-project grants, safe bootstrap, transactional migrations | security PASS; contract PASS |
| `17caa65` | `bcc6a73` | Vertical slice D: revocation re-checks, multi-process evidence, fail-closed filesystem | security PASS; contract PASS |
| `57d769b` | `31a542a` | Vertical slice E: bearer-authenticated MCP Streamable HTTP tools | security PASS; contract PASS |
| `4216af6` | `30e9267` | Issue #4 fix: typed JSON-RPC ids in MCP idempotency | security PASS; contract PASS |
| `1fa8876` | `66bc243` | Vertical slice F: read-only operator diagnostics (`doctor`) | security PASS; contract PASS |
| `3d3dc25` | `52bf6b7` | Vertical slice G: per-credential REST/MCP rate limiting | security PASS; contract PASS |
| `5d0ae9f` | `f45a3b4` | Vertical slice H: metrics token hardening, fixed-length comparison, adapter recording isolation | security PASS; contract PASS |
| `9a4f6c5` | `cc8df35` | Vertical slice I: human account sessions (PBKDF2 login, cookie + CSRF, revocation) | security PASS; contract PASS |
| `aac6f2e` | `4867ed0` | Vertical slice J: OAuth 2.1 authorization server (discovery, DCR, PKCE, consent, rotation, revocation) | security PASS; contract PASS on code tree `a439df4`; docs-only tail |
| `691eca2` | `6f403f7` | Vertical slice K: operator-run bounded session/OAuth retention (`prune`) | superseded by later K commits |
| `31ac9fb` | `e6fbd45` | Slice K security audit fixes: retain OAuth ownership with a live refresh row, bound grace to the Date range, add regression/exact-boundary tests | superseded by final K commit |
| `f0e43d3` | `1a5d207` | Slice K final: retention plus docs/validation/test corrections | security PASS; contract PASS (delta on `1a5d207`) |
| `43d1937` | `d6fae0b` | Vertical slice L: read-only human web dashboard (en/zh, session-derived viewer, server-rendered, explicit body reveal) | superseded by final L commit |
| `45e5637` | `5ea2439` | Slice L final: read-only session viewer rights, bounded login redirect, parsed capability listing, docs/test corrections | security PASS; contract PASS (delta on `5ea2439`) |
| `a4a6ef3` | `c733ab9` | Vertical slice M: dashboard metadata filters, summary search, cursor replay, responsive layout, en/zh | superseded by final M commit |
| `47c5af8` | `aaab817` | Slice M final: active read-only filter state, pager/empty-state docs, `h1` wrapping, `hasMore` non-serialization tests | security PASS; contract PASS (delta on `aaab817`) |
| `78a3408` | `782ef11` | Vertical slice N: operator backup/verify/restore for SQLite DB + blobs | superseded by final N commit |
| `8410b37` | `116cbb6` | Slice N audit fixes: immutable/read-only snapshot without source sidecars, restore manifest reuse, byte caps, CLI JSON/redaction | superseded by final N commit |
| `c2aec6a` | `e45dcdf` | Slice N final: pre-snapshot DB cap, bounded listings, redaction/sanitization, mid-stream digest cap, docs | security PASS; contract PASS (delta on `e45dcdf`) |
| `f06c4ac` | `496e9ae` | Vertical slice O: sanitized authentication/OAuth lifecycle audit events | security PASS; contract PASS (two independent audits) |
| `4a8bde8` | `dd59cff` | Vertical slice R: queue-to-commit histogram and authorized per-project counts (audited candidate, replayed onto `58e548f`) | audits PASS; P2 fixes squashed as `48c52bc` (tree `dba3fab`) on `origin/main` |
| `704d115` | `7a13790` | Slice S: dashboard filter blank-value fix; blank/whitespace-only values are absent for `type`, `sender`, `limit`, `unread`, and both cursors instead of `400`; `q=` was already tolerated; non-blank validation is unchanged | pushed on `origin/main` (tree `7a13790e6585a608fddbad71ec6fa24ec7446689`); evidence: GitHub Issue #6, real browser at `58e548f`; regression test `blank timeline filter values are absent, not invalid`; `npm ci` exit 0; `npm run check` exit 0 (392 tests: 391 pass, 1 skipped live-D1); `npm run build` exit 0 |
| this checkpoint | commit trailer | Slice T: dashboard project create/edit (`GET /projects/new`, `POST /projects`, `GET /projects/:projectId/edit`, `POST /projects/:projectId`), session double-submit CSRF, owner-only `project.edit`, en/zh forms, 303 redirects | independent review PENDING; `npm ci` exit 0; `npm run check` exit 0 (402 tests: 401 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; on `slice-admin`, not pushed |
| this checkpoint | commit trailer | Issue #7: backup snapshot excludes documented in-progress `.tmp-<32 lowercase hex>` blob entries instead of copying them or failing when a concurrent writer renames them away; a non-regular entry with a temp name and every other entry still fail closed; verify remains strict about temp entries in a backup directory; docs state the exact rule, including that excluded temps still count toward the 100,000-entry enumeration cap | on `slice-backup-flake`, not pushed; independent review PASS (security zero findings; contract PASS with doc/test P2s addressed); reproduction before fix: 8/8 `createBackup` attempts failed with `BACKUP_BLOB_ENTRY_INVALID` on `.tmp-*` entries, after fix: 0/400; deterministic integration test (`documented in-progress temp blobs are excluded from the snapshot`, fails on base with `blobs` 5 vs 4) and security test (temp-named symlink rejected); renamed-away race branch covered by the out-of-tree concurrency reproducer, not a committed deterministic test; `npm ci` exit 0; `npm run check` exit 0 twice (404 tests: 403 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0 |
| this checkpoint | commit trailer | Slice V: Node adapter buffers dashboard project form POST bodies (`POST /projects`, `POST /projects/:projectId`) via `isWebPath`; HTTP-level create/edit/CSRF/oversize/auth tests through `startServer` | independent review PENDING; Base-SHA `01538a0c78d553bdc36ab20a8769dfa5b9894e48`; `npm ci` exit 0; `npm run check` exit 0 (405 tests: 404 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; merged at `4b1ba53`; evidence: GitHub Issue #6 comment 6653112857 |
| this checkpoint | commit trailer | Slice W, Issue #8: project creation writes the project and its owner membership in one SQLite `BEGIN IMMEDIATE` transaction, so a failed second insert or a pre-commit crash leaves neither row | Base `4b1ba53`; failure-injection test `a failed owner-membership insert rolls the project back` fails on base `01538a0` (orphan active project) and passes here; contract covers commit, rollback on the failing second insert, and concurrent serialization; `npm ci` exit 0; `npm run check` exit 0 (407 tests: 406 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; pushed on `origin/main` at `0f81877` (tree `b7a1653`); D1 batch semantics documented but not implemented or verified |
| pre-squash `21a5fdf` + state tail `24cebb3` | `46f1e62` | Slice X pre-squash evidence: dashboard speaker directory (`GET /speakers`), explicit project-scoped credential issuance (`GET/POST /speakers/:speakerId/key`), owner-only uniform 404, session CSRF, in-transaction membership re-check, one-time `no-store` display | Base `0f81877`; independent review PASS on `24cebb3`; `npm ci` exit 0; `npm run check` exit 0 (417 tests: 416 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; superseded by the squashed checkpoint row below |
| this checkpoint | commit-trailer `Tree-SHA` | Slice X final squashed capability: the same directory and issuance plus the in-transaction membership **and scope** re-check, 100-project cap, bounded `credential.issue` audit (`project_count` + up to 32 IDs), response-body logging correction, and README/architecture corrections | Base `0f81877`; was local pre-push on `slice-speakers`, then pushed as `15cdf62` (tree `3260e71`); `npm ci` exit 0; `npm run check` exit 0 (423 tests: 422 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; no rotation/revocation/grant-editor/expiry UI (issuance and revocation have CLI commands; rotation is unimplemented; per-credential expiry is set at CLI issuance); D1/R2 parity and a real-browser pass remain unverified |
| `bf79cd0` | `f7c516a` | Slice L audit fixes: read-only session rights/scopes, bounded login redirect, parsed capability listing, fetch-metadata and duplicate-CSRF handling, negative/no-mutation/a11y tests | superseded by final L commit |
| this checkpoint | commit-trailer `Tree-SHA` | Slice Y: dashboard per-project membership editor — `GET`/`POST /projects/:projectId/members`, `POST /projects/:projectId/members/:speakerId/remove`; **project-owner-only** (not `project.edit`) with uniform `404`, explicit seven-scope capability set (owner may grant any), account-owned active speaker rule, duplicate conflict, manageable-owner removal refusal, grant deletion with membership removal, in-transaction ownership re-validation, adapter-level POST tests, en/zh | Base `15cdf62717626a07ccbe52c243f895a60064e298`; pushed on `origin/main` at `499a772` (tree `fe60450`); security-audit P1 (owner gate) and P2/docs corrections in the fix commit; `npm ci` exit 0; `npm run check` exit 0 (440 tests: 439 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; D1/R2 parity remains unverified; cross-account provisioning, invitation/acceptance, bulk editing, credential rotation/revocation, and grant editing are not implemented or CLI-only |
| `a4a6ef3` | `c733ab9` | Vertical slice M: dashboard metadata filters, summary-only search, bounded cursor replay, responsive CSS-only layout | superseded by final M commit |
| `a5bb688` | `dbb72be` | Slice M audit P2 fixes: read-only `unread=false` state, pager empty-page docs/test, `h1` overflow wrapping, `hasMore` non-serialization tests | superseded by final M commit |
| this checkpoint | commit-trailer `Tree-SHA` | Slice Z: lockfile-driven license/notice report (runtime/dev labeled, missing/unknown/non-permissive flagged; legacy `{type}` objects handled; absolute/traversal lock keys exit `2`), CycloneDX SBOM via the installed npm CLI (never PATH), license scan in `npm run check`, `check`/`audit` chain direct `$npm_node_execpath` commands and an npm wrapper instead of bare `node`/`tsc`/`npm`, CI runs license scan + SBOM + uploads `reports/`, network `npm audit` stays separate, legacy `{type}` objects handled and absolute/traversal lock keys exit `2` | Base `499a772620d2caa3f0eb3f8a224fac9bfef47d10`; feature commit `09eb061` (tree `2b7e38e`); first audits BLOCKED on `2b7e38e`, fixes PASSED at tree `3c05987`; residual rounds then removed bare `npm` and bare `node`/`tsc`; final audits on tree `06f664e` PASS (security + contract) with three non-blocking P2s; pushed on `origin/main` at `f7e62be`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (455 tests: 454 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run licenses` exit 0 (98 dependencies: 95 runtime, 3 dev; 0 flagged; 4,284-byte text, 18,711-byte JSON); `npm run sbom` exit 0 (95 components, root `corkboard@0.0.0`, 107,828 bytes); `npm run audit` exit 0 (0 vulnerabilities); executable `node_modules/.bin/{npm,node,tsc}` shims were proven not to run during `npm run check` |
| this checkpoint | commit trailer `Tree-SHA` | Slice AB: authorized account service overview — `GET /overview` behind the session dashboard and linked from the project list. Reuses `listProjects`/`sessionAccountPrincipal` (the readable set, bounded to 100 with a truncation note); per-project ready/pending/expired counts from one grouped parameterized aggregate; stored `body_objects.cipher_length` sums excluding expiry-deleted blobs; owned-speaker credential active/expired/revoked/unknown counts reusing the inventory `credentialState` derivation; 20 newest account/project-scoped audit rows selecting `id` (internal dedup key, never rendered), `created_at`, `operation`, `outcome`, and `project_id` (never `detail`, bodies, tokens, prefixes, verifiers, emails, or IPs), queried in ≤49-project chunks with a literal `LIMIT 20` to stay under D1's 100-bound-parameter cap and merged/deduplicated/sorted in JS; credential state query returns at most 1,001 rows (`LIMIT 1001`) for the overflow check and counts the first 1,000, with an explicit en/zh "counts incomplete" state above 1,000; the limit bounds result size, not scan work. Read-only for project/message/credential/audit data; the shared authenticated-page `sessions.last_seen_at` refresh still applies. No CSRF form, no new dependency. Traffic and error summaries are explicitly unavailable because the schema has no per-tenant source; no global metrics are shown. en/zh labels and empty states. Debt: `body_objects(project_id)`, `audit_events(actor_account_id, created_at)`, `audit_events(project_id, created_at)`, `credentials(speaker_id)`, and `speakers(owner_account_id)` remain unindexed, so the row caps bound result size, not table work; indexes need measured SQLite/D1 query plans. Pushed on `origin/main` at `058e34f` (tree `4ae5dfa`); security PASS + contract PASS on tree `4ae5dfa` (delta audits) | Base `892417d5272bb764af2e8aa99a7686a592879343`; `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (481 tests: 480 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; branch `worktree-agent-a2f6d2da7b7d1d1e0`, pushed |
| this checkpoint | commit-trailer `Tree-SHA` | Slice AA: dashboard credential inventory and revocation — `GET /speakers/:speakerId/credentials` lists only non-secret metadata (credential ID, created, expiry, active/expired/revoked/unknown state, project grants) for an account-owned speaker; `POST /speakers/:speakerId/credentials/:credentialId/revoke` soft-revokes with `revoked_at`, keeps grants and the row, is idempotent, audits sanitized `credential.revoke`, and `303`s back; account-owner-only with uniform `404`, speaker-scoped credential IDs, session double-submit CSRF, in-transaction ownership re-check, bearer-principal rejection, en/zh, Node adapter body coverage. Rotation is explicitly not implemented; revoke-then-issue is the replacement path | Base `1dfa2849094d8085ae67deeb74973e70421f5b86`; pushed on `origin/main` at `dbb2a46` (tree `837ee76`); security PASS + contract PASS on tree `837ee76` (delta audits); `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (466 tests: 465 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0 |

## Preview deployment package (2026-11-06)

- **Baseline:** based on `0cd5ffc` (tree `bb8270e`), the docs/state tail that
  records the TODO 409 review-remediation checkpoint `5a310d1` (tree `d8b1bb3`) as
  independently audited and pushed. `da6eba9` remains the latest audited
  CI-passing code checkpoint before the remediation.
- **Package:** `compose.preview.yaml`, `docs/preview-deployment.md`,
  `scripts/preview-preflight.ts`, `tests/unit/preview-preflight.test.ts`, and the
  `preview-preflight` npm script. No application authorization, crypto, dependency,
  schema, migration, or runtime-server change.
- **Status:** **nothing was deployed.** No public infrastructure, DNS record,
  certificate, real secret, browser pass, TLS pass, backup rehearsal, or ChatGPT
  interoperability result exists.
- **Blocker:** host, domain/DNS, TLS certificate, authorized tester list, and the
  preview owner/credential files are maintainer-supplied. The package stops at the
  boundary in `docs/preview-deployment.md` §11.
- **Tracking:** Issue #11, `[Preview] Restricted private-preview deployment —
  status and blockers`, is the place for results and blockers; this record does not
  duplicate its content.
- **Debt (not fixed here):** `localhost` name-based plaintext trust (a hosts-file
  entry can redirect the name; use numeric loopback when unambiguous), and any
  remaining preflight presentation/reporting nits. The preflight response body is
  capped at 1 MiB and the non-member check requires `404` + `error.code =
  NOT_FOUND`.
- **Next:** on a supplied host, run `docs/preview-deployment.md` §2–§8 in order and
  record the exact revision, image ID, host, and command output.

## GitHub Issue coordination

| Field | Value |
| --- | --- |
| Authenticated account | `YaoYinYing` (verified with `gh api user`) |
| Pending P0 Issues | none; #2 and #3 fixed by `2ab5e75` (merged as `0052909`) and closed with test/audit evidence |
| Last pushed checkpoint | `origin/main` is `349dc40b5cf4f4d94fadfc69eb3c433731f868cb` (tree `9201b770b82fa8befb6308811c5f0cf397054fc7`): operator `prune` writes one sanitized `retention.prune` audit row per deleting run (fail-open after commit), with prune audit semantics reconciled across docs and state (branch `prune-audit`, base `4a69f78`), audited candidate `15d6c65` on the same tree. Full security audit PASS-WITH-P2 at `2c5a107`, full contract audit PASS; docs/state correction deltas and the closure audit on tree `9201b77` returned security PASS + contract PASS. CI run `42408793482` succeeded. |
| Scheduler | durable systemd user timer `corkboard-issue-sync.timer` at local `:38` (America/Los_Angeles), `Persistent=true`, `AccuracySec=1min`; `enabled` + `active`, manager `Linger=yes`; service `corkboard-issue-sync.service` runs one bounded `scripts/issue-sync.ts` pass (`TimeoutStartSec=15min`, 60 s per `gh` call), exits, and does not post replies. State/cursor/digest/logs: `${XDG_STATE_HOME:-$HOME/.local/state}/corkboard-issue-sync/`; journal tag `corkboard-issue-sync`. The unit templates embed this host's absolute Node/checkout/HOME paths and are not portable. The former session-scoped CronCreate job `8ef0de4e` was cancelled by the Commander at approximately `2026-11-06T11:41Z`; this timer is now the only durable scheduler. Issue #9 remains open (comment `6685044973` posted; a literal Commander restart was not demonstrated) |
| Status | Issue #9 open (durable GitHub Issue sync checkpoint pushed at `bf88c03`, tree `4a9271a`; audited candidate `7b5f9ee`; CI run 42219197589 success; comment `6685044973` posted; a literal Commander restart was not demonstrated; the comment-paging P2 is fixed at `a4d6a85` with comment `6689286890` and CI run 42247813848 success); no pending P0 findings |

## TODO reconciliation (2026-11-06)

Boxes checked in this docs checkpoint, with the evidence that satisfies the full
clause. Items evaluated and left unchecked in this pass are listed below.

| TODO item | Evidence |
| --- | --- |
| 319 | `tests/helpers/temp-db.ts` scenario `100 same-process concurrent finalizations get unique contiguous seqs and retry` (exactly 100 concurrent finalizations, including injected transient unique failures and retries; run by `tests/contract/storage.test.ts`); `tests/integration/messages.test.ts` `a pending resend verifies the blob before publishing and stays reclaimable` covers failed-upload/resume; server-generated `proj_`/`msg_`/`obj_` IDs in `src/service/projects.ts` and `src/service/messages.ts`; atomic `trg_messages_publish` trigger in `migrations/001_init.sql` |
| 320 | `tests/integration/messages.test.ts` `client-supplied sender and server-owned fields are ignored`, `reply_to_id must exist in the same project`, and the send project-authorization tests at `:142`/`:170`; `tests/unit/validation.test.ts` `type follows the documented identifier pattern`, `language is canonicalized as a single BCP 47 tag`, and summary/text tests; `sendMessage` stamps `receivedAt` from `deps.now().toISOString()` |
| 321 | `tests/integration/messages.test.ts` `authorization precedes payload validation and sender-digest verification` asserts unchanged `next_seq` and no message, idempotency, or body-object row on `INTEGRITY_MISMATCH`; `tests/unit/validation.test.ts` `verifySenderDigest accepts the matching UTF-8 digest and rejects mismatches` |
| 331 | `docs/architecture.md` body-commit/encryption steps; `docs/security-operations.md` AES-256-GCM, fresh 96-bit nonce, and AAD-scope statement; `src/crypto/envelope.ts` (CB01, nonce) and `src/crypto/keys.ts` (WebCrypto AES-GCM); `tests/security/crypto.test.ts` `uses a distinct nonce for every seal` and `builds an env key provider...` |
| 358 | `docs/api.md` endpoint, schema, stable-error, request-ID, limit, pagination, rate-limit, and security-header contract; `tests/integration/http.test.ts` request IDs, `413`, and `nosniff`; `tests/integration/rate-limit.test.ts` `429`/`Retry-After`; pagination tests in `tests/integration/messages.test.ts` |
| 364 | `tests/integration/metrics.test.ts` queue-to-commit histogram and fixed metrics; `tests/integration/project-stats.test.ts` authorized per-project counts; `tests/integration/http.test.ts` `request logging is sanitized and never carries query values or content`; `docs/api.md` metrics/stats sections |
| 412 | `docs/runbook.md` v2 (2026-11-06); `docs/acceptance-report.md` v1 with the production/staging/simulated status legend and explicit no-deployment statement |
| 444 | `docs/campaign.md` commit-based protocol; the Phase row and checkpoint history identify the implemented slices, and the state records the next milestone |
| 445 | Contract/architecture docs were updated with the behavior in the checkpoint commits, and the Reviews row records the contract audits that closed stale-doc findings |
| 446 | Checkpoint history rows and `docs/acceptance-report.md` §8 describe end-to-end vertical behaviors (for example slices A, AC, AF, AG), not scaffolding-only changes |
| 448 | Commit trailers `Base-SHA`/`Tree-SHA`/`Tests` and the checkpoint-state rows record exact revisions and per-run test counts |
| 449 | `scripts/secret-scan.ts` and `scripts/history-secret-scan.ts` run in `npm run check`; `docs/supply-chain.md`; slice-Z and later checkpoint rows record scan results and diff review |
| 407 | `scripts/reproducible-build.ts` runs the shared `scripts/build.ts` definition used by `npm run build` (tsc `-p tsconfig.build.json --outDir <temp>`, then the migrations copy) twice into sibling temporary output directories and compares sorted relative-path + SHA-256 manifests; `npm run build:repro` exits 0 on two identical builds (104 files; Node 24.22.1 / TypeScript 5.9.3), exits 1 with paths only on a difference, exits 2 on build/manifest failure or an empty output tree, and removes the temporary parent on normal completion or a thrown failure; `tests/supply-chain/reproducible-build.test.ts` covers identical output, a one-byte change, extra/missing files, creation-order independence, sorted manifest canonicalization, empty output, a symlinked entry, the file cap, cleanup on success/failure, and CLI exit 0/1/2; CI runs it after `npm run build`. Existing clauses: secret scans in `npm run check`/CI, `npm run audit` in CI, `npm run licenses`, and `npm run sbom` with the `supply-chain-reports` upload. `docs/supply-chain.md` records scope and limits (same OS/toolchain/config/output depth and file bytes only; a signal or crash can leave a 0700 temp directory; not a Docker-image reproducibility claim) |
| 411 | Hardening documented and tested where cheap, with no new runtime feature. **TLS:** `docs/runbook.md` §3.1 is the single authoritative nginx example (HTTP→HTTPS redirect, TLS 1.2/1.3 ciphers, HSTS, `limit_req`/`limit_conn`, 1 MiB proxy body cap above the app's 64 KiB cap) and states the app is `node:http` with no TLS listener, binds loopback by default, does not read forwarding headers, and requires HTTPS because session/CSRF cookies are `Secure` and the session cookie is `__Host-`. **CSP/CORS:** `src/app/html.ts` `WEB_CSP` plus `X-Frame-Options: DENY`, `src/app/responses.ts` `no-store`/`nosniff`/`no-referrer`; CORS explicitly disabled with no preflight handler, asserted by `tests/integration/cors.test.ts` on public, authenticated, HTML, login, unknown, and MCP-preflight routes. **Cookies:** `src/app/cookies.ts` and `src/service/sessions.ts`; exact flags/lifetimes documented in runbook §3.2 and asserted in `tests/security/session.test.ts`. **Rate limits:** `src/app/rate-limit.ts` per-credential REST+MCP 120/min burst 30 with `CORKBOARD_RATE_LIMIT_PER_MINUTE`/`_BURST`, login 10/min burst 5, OAuth buckets; process-local/bounded, `429`+`Retry-After`; per-IP delegated to the proxy. **Quotas:** 64 KiB body cap (`src/app/handlers.ts`, `oauth.ts`, `web.ts`, `mcp/http.ts`), text/summary/list/expiry limits (`src/domain/validation.ts`), attachments not implemented; documented in runbook §3.2 and `docs/api.md`. **Privacy:** `docs/privacy.md` (stored tables, ciphertext/metadata split, sanitized logs, no client IP storage or third-party processing, operator access/contact). **Retention:** no default body expiry; operator `expire-bodies` (500) tombstone; operator `prune` for session/OAuth (24 h grace, 1000); unbounded audit; backups not rewritten (`docs/privacy.md`, `docs/deployments.md#retention-and-pruning`, runbook §5.4). **Incident response:** `docs/incident-response.md` (severity, operator-defined notification without an on-call claim, revocation/service-stop containment, no project-disable or root-key/pepper rotation, evidence, backup/verify/restore recovery, state/lessons updates). Clauses satisfied by documentation/proxy configuration only: TLS termination, HSTS/ciphers/redirect, per-IP and volumetric limits, and the operator contact in the privacy/incident docs |
| 452 | `IMPLEMENTATION_STATE.md` `Next milestone` selects the next work; `docs/campaign.md` records the Commander yield rule |
| 479 | `.gitignore` excludes the unredacted `ORIGINAL_DESIGN.md`; `docs/original-design-redacted.md` banner; committed `docs/architecture.md`, `docs/threat-model.md`, `docs/api.md`, `docs/security-operations.md`, and `docs/deployments.md`; secret-scan tests |
| 482 | `tests/integration/messages.test.ts` `send -> list -> body -> read receipt roundtrip`, `same key with the same payload returns the same message`, and `a pending resend verifies the blob before publishing and stays reclaimable`; `tests/integration/persistence-processes.test.ts`; `tests/integration/cli.test.ts` reopen/decrypt |
| 334 | `tests/integration/messages.test.ts` `a missing ciphertext blob on a committed message fails closed with no content or receipt` starts from a ready/committed message, deletes its ciphertext through the supported `BlobStore.delete`, keeps the `body_objects` row, and asserts `INTEGRITY_FAILURE` from both the body read and the receipt write, no receipt, and failure audit operations `message.body.read`/`message.receipt.write`; wrong-project/ID/key and modified-ciphertext negatives remain in `tests/security/crypto.test.ts` |
| 344 | `docs/authorization.md` (linked from `docs/architecture.md`, `docs/security-operations.md`, and `README.md`) lists actors, the seven scope identifiers, the exact bearer and session project predicates, session-send and project-owner predicates, account/speaker/credential administration, and OAuth delegation; it records that no platform-admin role exists and that `member.read`/`member.manage` are declared but unenforced |
| 352 | `tests/security/adversarial-probes.test.ts` (20 tests: 15 top-level probes plus five session-predicate subtests against the real `createApp` router) covers every clause: object-level unknown/foreign project, message, receipt, credential, membership, and audit references across REST, MCP, and dashboard routes with uniform non-member `NOT_FOUND` and the documented member-without-grant `FORBIDDEN`; JWT-shaped/`alg:none` rejection plus a direct-dependency and `src/` import scan (no application JWT exists, so this is rejection not validation; the MCP SDK's transitive `jose` is pinned by a lockfile reachability assertion; it is never imported by `src/` and never loaded by application auth code (the SDK's optional client auth-extensions module may import it)); per-speaker/per-project idempotency ownership with fail-closed out-of-band tamper handling; injected credential/membership/session revocation between authentication and publication; spoofed sender/account/timestamp/sequence fields in REST, MCP, web, and OAuth consent; hostile Host/forwarded/override/duplicate/absurd headers, Origin/`Sec-Fetch-Site`, content-type confusion, CRLF paths, and raw CR/LF headers; and SQL/path/prototype/oversize/deep-JSON/HTML injection. `docs/threat-model.md` "Adversarial probe matrix" records results, citations, and non-applicable items. Two minimal hardening fixes: the session-send finalize `UPDATE` now includes the active session row, and an idempotency replay whose recorded message belongs to another speaker fails closed with `NOT_FOUND` |
| 381 | `tests/integration/http.test.ts` `a lost send response retried with the same Idempotency-Key yields exactly one message` runs the real `createApp` handler behind a loopback `node:http` server that commits the first POST then destroys the socket (the response is captured before the loss); the identical retry returns the same `message_id`/`seq`, a different payload under the same key returns `CONFLICT`, and exactly one message, body object, and idempotency row remain |

Left unchecked in this pass because a clause is unmet: 332 (the plaintext digest is
deliberately not in the AAD), 337 (the
previously-compressed-file clause needs an attachment path), 408 (current head
and deployment artifacts not reviewed), 450/451 (slice
T/V review records are PENDING and completed branches remain local), and 484 (some
historical checkpoint rows do not record an exact-head independent review).
The negative permission/failure-path clause was subsequently covered for the only
executed backend (SQLite) on branch `negative-coverage`; the absent D1 backend is
recorded as a caveat there rather than as a pass. No independent review of that
branch is pre-recorded.

The `981c761` TODO-reconciliation push (tree `6b3e5b6`) was verified with
`git ls-remote`. CI status for that revision was **not retrievable** at the time:
GitHub API calls failed with TLS handshake timeouts. No CI success is claimed for it.

Do not treat later phases as verified until their checkpoints exist.

## TODO reconciliation (2026-11-07) — checkbox audit and stale receipt claims

Docs-only slice on branch `todo-reconcile`, based on
`264fb29d85d0805030b6646d7373d68079f3ec12`. No application, test, dependency, or
workflow file changed. No independent audit is claimed for this candidate.

**Checked (1 TODO box).** `335` (private opaque blob storage): evidence class
source + tests + prior checkpoint. `src/storage/blobs/local.ts` creates a `0700`
directory and `0600` temp file with an atomic rename, `src/storage/blobs.ts` validates
opaque keys, and no blob/fileserver route exists;
`tests/security/filesystem-permissions.test.ts` covers modes/symlinks and
`tests/integration/cli.test.ts` sends and decrypts a body through `LocalBlobStore`.
Scope caveat recorded in `TODO.md`: local adapter only; no R2.

**Left unchecked (30 boxes).** A short reason is appended to every unchecked item in
`TODO.md`. Groups and the missing clause:

- D1/Workers/R2 absent or unexecuted: 317, 318, 322, 325, 362, 368, 482, 485. 317 has
  all listed tables plus WAL/foreign keys but D1 compatibility is asserted, not run
  (`tests/contract/storage.test.ts` skips D1); 322 also lacks orphan-blob garbage
  collection (`doctor` only reports `BLOB_ORPHANED`).
- ChatGPT Web absent or untested: 378, 379, 380, 384.
- Attachments/registration absent: 336, 346.
- No staging or production environment (separate deployment secrets are policy only):
  311.
- Root-key/pepper rotation and deletion behavior absent: 333.
- Hard impersonation boundary absent: 351 (no credential broker or OS-level
  separation; the documented threat limitation stands).
- Project deletion absent (operator `prune` audit row superseded by the later
  prune-audit slice): 349.
- Service overview lacks per-tenant traffic/error summaries and admin operations: 393.
- P2 optional features absent: 401–405 (405 is a standing constraint, deliberately
  open).
- Process/audit items not satisfied for this candidate: 452, 453, 486.
- Deliberate design divergence recorded rather than weakening the item: 332 (the
  plaintext digest is sealed inside the CBPT1 payload and the AAD binds only
  pre-decryption metadata, per §2/§4).
- 337 is implemented for text bodies but the "previously compressed files" clause
  needs an attachment/file path (same conclusion as the 2026-11-06 pass).
- 369 has a complete local Compose installation but no Worker deploy docs.

**Stale current-state claims corrected.** `docs/acceptance-report.md` had two
"Receipts UI — Not implemented / Receipts are API-only" rows, and `docs/runbook.md`
said "No receipt UI". The project timeline has rendered per-message read receipts
through `listReadReceipts` (`src/app/web.ts`, `renderTimeline`) and
`tests/integration/web.test.ts` (`timeline is ascending, carries metadata and
receipts, omits bodies, and shows tombstones`) asserts the "Read by" label and reader
display name. Both files now state the implemented timeline display and the absence of
a separate receipt-administration UI. Historical slice records above were not
rewritten.

**Commands run (isolated worktree; `npm ci --ignore-scripts` was needed to install the
lockfile first).**

- `npm run check` — exit 0; secret scan, history scan over 187 commits, license
  report, strict typecheck, and tests. **711 tests: 710 pass, 0 fail, 1 skipped**
  (live-D1 contract skip).
- `npm run build` — exit 0.

`Base-SHA: 264fb29d85d0805030b6646d7373d68079f3ec12`. Final candidate
`28be6ae` (tree `225558d`) was independently audited: **security PASS** (docs-only
scope proven by an empty protected-path diff; checked-item blob claims and unchecked
reasons verified against source and tests; no secrets; no overstated protection) and
**contract PASS** (all 31 unchecked items now enumerated including item 351; receipts
correction accurate; trailers, tree, and counts exact). CI run `42396434333` succeeded.
`Tests: npm run check` (711 tests: 710 pass, 1 skipped); `npm run build` exit 0.

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

## Vertical slice C — credential-project grants and safe bootstrap (implemented at this tree)

Closes the two P0 findings from Issues #2 and #3. Candidate tree, not yet audited or
pushed.

- Migration 002 adds `credential_project_grants (credential_id, project_id,
  granted_at)` with a `project_id` index, the slice-B `(body_state, body_expires_at)`
  index (so existing v1 databases receive it), and a nullable
  `audit_events.detail` column. `src/storage/db.ts` now reads ordered
  `migrations/NNN_*.sql` files, applies unapplied versions, and records each in
  `schema_migrations`; the module-relative (`dist/migrations`) and cwd fallbacks are
  retained. Each pending migration runs in `BEGIN IMMEDIATE` with its version insert in
  the same transaction, so a crash rolls the SQL back and concurrent upgraders
  serialize instead of hitting a duplicate-column ALTER. A definitive v1 database is
  upgraded in regression tests, including simulated crash and concurrent-upgrade tests.
- Authorization is deny-by-default per credential. `authorizeProject` re-reads the
  credential and requires an explicit grant after the active project/membership/
  speaker/account checks. A valid credential with an active membership but no grant is
  `FORBIDDEN`; unknown/inactive project or missing/removed membership stays
  `NOT_FOUND`. All message, body, receipt, expiry, project-detail, and enumeration
  paths use this same function. Membership alone, account ownership, and newly joined
  projects confer nothing, and a grant adds no scope.
- `GET /api/v1/me` and `GET /api/v1/projects` apply the same grant predicate inline
  (not via `authorizeProject`) and omit ungranted projects. Grant revocation is read on
  every request, so it applies to an already-authenticated principal on the next call.
  `remove-member` deletes that speaker's grants for the project, so re-adding the
  membership cannot revive an old credential without an explicit re-grant.
- CLI: `issue-key` accepts one or more `--project` occurrences, rejects zero and
  duplicates, validates an active membership and scope subset for every project,
  inserts the credential then one grant per project, and on any later failure deletes
  grants, then the credential, preserving the original error; no token is printed
  before all writes succeed. `grant-key-project` requires an active membership and
  inserts `INSERT OR IGNORE`; `revoke-key-project` errors when the grant is absent.
  Both audit `credential.project.grant`/`credential.project.revoke`. `remove-member`
  deletes the speaker's grants for the project and audits the revocation. Issuance
  audit rows carry sanitized JSON `detail` with granted project IDs and the scope list.
  No token, key, or content is stored.
- `init` is bootstrap-only: `--force` is removed (strict parsing rejects it), and init
  refuses — writing nothing and generating no keys — when `corkboard.sqlite` exists in
  the data directory or the secrets file exists. Containment is enforced on canonical
  paths (existing ancestors resolved with `realpathSync`), re-checked after directory
  creation and immediately before the write, so symlinked parents/data directories and
  a data directory nested under the secrets directory are rejected. The default secrets
  path is `$XDG_CONFIG_HOME/corkboard/secrets.env`, else
  `~/.config/corkboard/secrets.env`, with the directory `0700` and file `0600`;
  `--secrets-file` overrides it. Only the secrets path is printed. Rotation remains
  unimplemented and is documented as separate from bootstrap.
- Expiry audit actor/repair fixes: an already-expired endpoint retry and worker
  reconciliation write the deterministic row with a system actor (null account and
  speaker); the initial endpoint transition may keep the authenticated principal. A
  phase-1 audit failure repaired by phase 3 in the same worker run is not counted in
  `failures`.
- Tests: 164 total, 163 pass, 1 skipped (live D1 marker). New coverage includes v1→v2
  migration and the missing index/detail column, crash-rollback and concurrent-upgrader
  migrations, deny-by-default at the service layer, A-only/B-only grants, no widening
  on a new membership, grant-only without membership (`NOT_FOUND`), enumeration
  filtering, immediate grant revocation, CLI multi-project issuance and scope
  rejection, grant/audit-failure rollback (no credential, grant, or token), membership
  removal deleting grants, init non-destruction (including `--force` as an unknown
  option), default secrets isolation, symlinked containment escapes, in-data secrets
  rejection, and token authentication plus body decryption surviving a refused
  reinitialization.

## Vertical slice D — revocation ordering, process evidence, fail-closed filesystem (candidate)

- **Authorization timing.** `docs/architecture.md`, `docs/api.md`, and
  `docs/security-operations.md` now state the exact contract: request-start
  authorization for every path; final re-authorization immediately before the durable
  effect for send finalization, receipt insert, expiry transition/repair, and plaintext
  body return; request-start only for reads with no write. A revocation landing after
  the final re-check and before the atomic SQL statement is explicitly not prevented.
  Mid-request re-check errors follow `authorizeProject`: a mid-request credential
  revocation is `FORBIDDEN`, a membership removal is `NOT_FOUND`, and a
  request-start revocation remains `UNAUTHENTICATED`.
- **Final re-checks.** `sendMessage` calls `authorizeProject(..., "message.send")` in
  `publish` immediately before `finalizeMessage`, so a mid-flight revocation allocates
  no `seq` and leaves only the documented reclaimable pending row/blob; a same-key retry
  after re-grant resumes. `markRead` re-authorizes `message.read` and re-checks
  `receipt.write` immediately before the receipt INSERT. `getMessageBody` re-authorizes
  `message.read` after decryption and before returning plaintext. `expireMessageBody`
  re-authorizes `project.edit` immediately before the conditional `ready → expired`
  UPDATE and before the already-expired repair path (audit retry and ciphertext
  deletion), so a mid-request revocation performs no transition and deletes no
  ciphertext. No duplicate authorization logic exists; all four reuse
  `authorizeProject`.
- **Independent-process persistence evidence.** `tests/integration/persistence-processes.test.ts`
  provisions one SQLite file, closes the parent connection, and runs four independent
  Node processes, each sending three messages concurrently in the same project. It
  asserts contiguous unique `seq` 1–12, unique message ids, one completed idempotency
  row per key, no idempotency row without a committed message, `next_seq = 12`,
  `PRAGMA integrity_check = ok`, and one blob per message.
- **Fail-closed filesystem.** `src/storage/permissions.ts` exports
  `requiresPrivateFilesystem` (`NODE_ENV=production` or
  `CORKBOARD_REQUIRE_PRIVATE_FS=1`), `assertNoPrivateFilesystemRedirects`, and
  `verifyPrivateFilesystem`. Paths are normalized with `resolve` before `lstat`, so
  trailing separators, `.` and `..` cannot disguise a symlink. Production startup
  rejects symlinked data/blob directories, the database file, and its `-wal`/`-shm`
  sidecars before any `mkdir`/`chmod`/open, so a rejected redirect leaves the target
  untouched; after opening it requires `0700` directories and `0600` regular
  database/sidecar/blob files and throws before listening. Outside production the
  previous best-effort behavior remains. Tests cover normal and deliberately wrong
  modes, trailing-slash and DB/WAL symlinks, non-production behavior, untouched
  targets, and real production-mode `startServer`.
- **Slice-C audit debt cleared.** `add-member` updates capabilities only for a removed
  membership (`DO UPDATE ... WHERE removed_at IS NOT NULL`) and treats an active
  re-run as a no-op with no extra audit row. `init` uses `lstatSync` so a dangling or
  real `corkboard.sqlite` symlink counts as an existing installation. `/me` and project
  enumeration are asserted to drop a project immediately after grant revocation and
  membership removal. `remove-member` writes `credential.project.revoke` only when a
  grant was deleted. `init` rejects a data-directory path containing a newline before
  writing `secrets.env`.
- Tests: 187 total, 186 pass, 1 skipped (live D1 marker). `npm run check` and
  `npm run build` pass.

## Vertical slice E — bearer MCP Streamable HTTP (candidate)

- **Dependency.** `@modelcontextprotocol/sdk` pinned exactly to `1.32.2` and `zod`
  `4.6.7` (exact) with the committed lockfile. `zod` was raised to 4.6.7 because
  `npm audit --audit-level=high` reports the constrained-collection memory advisory
  below 4.6.6; the final audit reports zero vulnerabilities.
- **Endpoint.** `POST/GET/DELETE /mcp` in `src/app/handlers.ts` authenticates the
  existing scoped bearer credential with `authenticateBearer` before any MCP handling.
  Missing/invalid credentials return `401` and create no session. `POST` initializes and
  calls; `GET` returns `405` (`Allow: POST, DELETE`) because server-initiated SSE is not
  offered; `DELETE` terminates a session. The 64 KiB cap is enforced by the Node adapter
  for `POST /mcp` and by the transport for direct Web Requests. `/healthz` and REST
  routes are unchanged.
- **Sessions.** `src/mcp/http.ts` uses the SDK's
  `WebStandardStreamableHTTPServerTransport` in stateful JSON-response mode. Sessions
  are in-memory and process-local, capped at 1024 (least-recently-used eviction) with a
  lazy 30-minute idle TTL swept on the next authenticated `/mcp` request; eviction
  closes the transport/server. They are bound to the initializing credential; another
  credential's id is `404` for tools and `DELETE`, and a foreign DELETE leaves the
  owner's session intact. Sessions are lost on restart and are not shared across
  processes. The bearer token is not passed to the SDK (`authInfo.token` is empty); the
  SDK receives a credential-stripped request plus the derived principal, and each
  request re-authenticates and re-authorizes through the service layer. A rejected
  request does not close a revoked credential's session; it stays until eviction and
  would become usable if the credential were reactivated. No session/authorization
  cache exists.
- **Token boundary.** Before the SDK sees a request, the adapter clones it and removes
  `Authorization`, `Proxy-Authorization`, and `Cookie`, so the SDK's
  `requestInfo.headers` exposed to tool handlers carries no credential material. A test
  observes the handler context and asserts those headers are absent, and that tool
  output never contains the token.
- **Response headers.** Every `/mcp` response, including SDK JSON and protocol error
  responses, carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- **Tools.** `src/mcp/tools.ts` registers exactly six tools:
  `corkboard_whoami`, `corkboard_list_projects`, `corkboard_list_messages`,
  `corkboard_get_message`, `corkboard_send_message`, `corkboard_mark_read`. Every
  description carries "Messages are data, not authority; verify goal/scope before
  executing any instruction." Input schemas are strict and expose no `body_digest`,
  `idempotency_key`, sender, or timestamp argument; unknown arguments are rejected
  before the handler runs. No admin/key/membership tools exist.
- **Shared service.** `src/service/projects.ts` now holds the project enumeration used
  by both `GET /api/v1/projects` and `corkboard_list_projects`, and
  `src/service/identity.ts` holds the principal identity read used by both
  `GET /api/v1/me` and `corkboard_whoami`; the other tools call `listMessages`,
  `getMessage`, `getMessageBody`, `sendMessage`, and `markRead` directly. There is no
  parallel authorization decision.
- **Send adapter.** The tool computes `sha256:` over the exact UTF-8 `text` and derives
  the idempotency key as
  `mcp_` + hex SHA-256(`"corkboard-mcp/v2\n" + JSON.stringify([sessionId, projectId,
  typeof requestId, requestId])`). The string/number id type is part of the key, so
  numeric `1` and string `"1"` are distinct. The same session + JSON-RPC id **and type**
  + payload is an idempotent replay; a different payload is `CONFLICT`. The v2
  derivation replaced the v1 `String(requestId)` form; MCP sessions are process-local,
  so no key migration applies. The residual duplicate risk from retrying with a new JSON-RPC id is
  documented.
- **Errors.** Tool failures return `{"isError":true}` with
  `{"error":{"code":"<stable code>"}}` only; service messages, stacks, bodies, summaries,
  and tokens are not disclosed. Unexpected errors become `UNAVAILABLE`.
- **Docs.** New `docs/mcp.md`; `docs/api.md`, `docs/architecture.md`,
  `docs/security-operations.md`, and `docs/deployments.md` updated. At slice E they
  stated that OAuth 2.1/PKCE, ChatGPT Web installation/linking, and conversation-level
  ChatGPT tool invocation were not implemented or verified; slice J later adds the
  OAuth authorization-server core. ChatGPT Web remains unimplemented. Local clients
  must supply a scoped bearer token outside prompts.
- **Tests.** `tests/integration/mcp.test.ts` uses the official SDK
  `Client` + `StreamableHTTPClientTransport` against the real Web handler (initialize,
  tools/list, tools/call, session header, DELETE). It covers exact six-tool exposure and
  absent forbidden arguments, unauthenticated/invalid-token `401` with no session,
  scope/grant denial, the full whoami/list/send/list/get/body/mark-read flow, cross-
  project `NOT_FOUND`, ungranted `FORBIDDEN`, expired `BODY_EXPIRED`, same-request-id
  idempotency, changed-payload `CONFLICT`, cross-credential session `404`, `GET` `405`,
  `DELETE`, the 64 KiB cap, and schema rejection of client-supplied digest/idempotency
  arguments. Existing REST tests are unchanged.
- **Post-audit hardening (re-audited and PASSED on final tree `31a542a`; initial
  audits PASSED `2a8b80c`).** Corrected the false claim that
  the SDK could not see the bearer token: requests are now cloned with
  `Authorization`, `Proxy-Authorization`, and `Cookie` removed before
  `transport.handleRequest`, and a test observes the handler context. Added the bounded
  LRU/30-minute-idle session registry, cache headers on every `/mcp` response, foreign
  `DELETE` survival, revoked/expired-credential rejection on an existing session,
  cross-session idempotency, and an injected-clock TTL test. `whoami` now uses the same
  identity read as `/api/v1/me`.
- Tests: 201 total, 200 pass, 1 skipped (live D1 marker). `npm run check`, `npm run
  build`, and a built-server MCP smoke pass. Not yet independently audited or pushed.

## Vertical slice F — read-only operator diagnostics (candidate)

- **Command.** `doctor [--data-dir <dir>] [--stuck-minutes N] [--json]` in
  `scripts/corkboard.ts` (built as `dist/scripts/corkboard.js`), also honoring
  `CORKBOARD_DATA_DIR`. `--json` prints exactly one object; otherwise the same fields are
  printed as short lines. No arguments are accepted positionally.
- **Read-only open.** `src/storage/db.ts` exports `openSqliteDatabaseReadOnly` and
  `expectedMigrationVersions`. The read-only opener never creates the data directory,
  chmods, switches journal mode, or applies migrations. A clean WAL database without
  sidecars is opened `immutable` so no `-wal`/`-shm` files are created; with both
  sidecars present it reads the live WAL. A lone sidecar, or a symlinked/non-regular
  sidecar, is rejected as a crash/redirect state rather than repaired or followed; the
  data directory is `resolve()`-normalized and a symlinked data directory or database
  path is rejected, so trailing `/`, `//`, and `/.` cannot disguise a redirect. A live
  read may rewrite the existing `-shm` coordination bytes; database and blob content are
  unchanged. The sidecar check is not a lock, so a concurrent checkpoint can recreate a
  sidecar between check and open and the first read may need a retry.
- **Schema newer than the server.** `applyMigrations` reads every applied version before
  the migration loop and throws `SchemaTooNewError` when any applied version exceeds the
  highest bundled version, so the server/CLI refuses an installation from a newer build
  before applying any migration. Normal startup may still switch journal mode and
  tighten file permissions before the refusal; no schema migration or row is applied.
  Doctor reports the same condition as `SCHEMA_AHEAD` with
  `unexpected` versions and `complete: false` (exit `1`); non-positive/non-integer rows
  are defensively treated as unexpected.
- **Report.** `src/service/doctor.ts` reports: applied/expected/missing/unexpected schema
  versions and completeness against every table created by the bundled migrations
  (`expectedSchemaTables`); `CORKBOARD_ROOT_KEY` and `CORKBOARD_CREDENTIAL_PEPPER`
  presence plus 32-byte base64 shape (booleans only) and key version `v1`;
  `PRAGMA integrity_check`; message/ready/pending/expired/failed, receipt, credential and
  grant counts; blob file, referenced, orphaned, missing, expired-pending-deletion and
  non-file counts; the configurable stuck-pending count with at most ten ID/age samples;
  and stable issue codes (`SCHEMA_INCOMPLETE`, `SCHEMA_AHEAD`,
  `DATABASE_INTEGRITY_FAILED`, `BLOB_MISSING`, `BLOB_ORPHANED`, `EXPIRED_BLOB_PENDING`,
  `STUCK_PENDING`, `KEY_MISSING`). Unmeasurable values are `null`, not zero. A non-ok
  integrity result still produces a report (counts/blobs null where unreadable, exit 1);
  only open/schema-read failures that prevent a report exit 2. Human output sanitizes
  DB-derived controls (C0/C1, DEL) so sample IDs and integrity text cannot drive the
  terminal.
- **Safety.** An absent data directory or database reports `database: null` and
  `SCHEMA_INCOMPLETE` without initialization and exits `1`; only an existing but
  unreadable/non-directory/symlinked path exits `2`. Symlinks and non-file blob entries
  are never followed (counted as `blob_dir_non_files`); invalid-named regular files are
  ignored. No query selects summaries or bodies, and no key/token/secret value is
  selected or printed. Exit `0` clean, `1` issues, `2` inspection impossible (invalid
  arguments, symlinked/unreadable/non-directory data path, database path not a regular
  file including a symlink, busy/locked database, inconsistent/symlinked WAL sidecars)
  with a stable message and no stack trace. Output is bounded, but reconciliation reads
  all referenced storage keys internally, `integrity_check` scans the database, and the
  version lists grow with `schema_migrations` rows.
- **Tests.** New `tests/integration/doctor.test.ts` covers a clean sent/read instance,
  orphan/missing/expired-pending/stuck counts with bounded samples, symlink
  non-following and invalid names, absent directory/database non-initialization with
  null "not measured" values, invalid arguments and no-stack exit 2, byte-for-byte
  read-only behavior, deterministic non-ok and throwing integrity corruption, a partial
  report when counts fail after a non-ok integrity result, a missing core table,
  symlinked WAL sidecars, a live uncheckpointed WAL with unchanged DB/WAL/blob hashes, a
  v1-only database proving migration 002 is not applied, `SCHEMA_AHEAD` for version 99,
  startup refusal for version 99 without applying migration 002, normalized trailing-form
  symlink rejection, control-character sanitization, locked-database and unreadable-
  directory exit 2, and an unconditional rebuild before the built-CLI run.
- **Tests/commands.** 220 total, 219 pass, 1 skipped (live D1 marker). `npm run check`
  and `npm run build` pass. A built-CLI smoke against a seeded directory reported the
  expected orphan/missing/expired/stuck counts, exit 1, no content/key output, and
  created no data-directory files.
- **Limitations.** No destructive repair/fix mode, no backup-integrity verification, and
  no D1/Workers equivalent. `PRAGMA integrity_check` is SQLite-specific, a live read may
  rewrite `-shm` coordination bytes, sidecar detection has a narrow check/open TOCTOU,
  and an integrity check that cannot run exits `2` instead of reporting.

## Vertical slice B — body expiry and tombstone (implemented at this tree)

- `POST /messages` accepts optional `body_expires_at`: strict RFC 3339 UTC `Z`
  timestamps only (real calendar date, hours 00–23, seconds 00–59, optional 1–3
  fractional digits; offsets, hour 24, leap second 60, and impossible dates rejected).
  It must be strictly after server `received_at` and at most 366 days ahead; otherwise
  `VALIDATION_ERROR` before any write. It is part of the idempotency payload digest,
  so the same key with a different expiry is `CONFLICT`. A committed replay returns
  the same `message_id`/`seq`/`committed_at`/`digest`; `body_state` reflects the
  current committed state. Note: adding `bodyExpiresAt` to the canonical payload means
  pre-release idempotency rows created before this change are not replay-compatible
  (no upgrade guarantee yet).
- List and single-message metadata include `body_expires_at`.
- `POST /projects/:projectId/messages/:messageId/expire` requires `project.edit` plus
  membership; non-member/removed → `NOT_FOUND`, member without scope → `FORBIDDEN`,
  pending/failed/unknown → `NOT_FOUND`, already expired → idempotent `200`. One
  conditional `ready → expired` transition per row, then best-effort ciphertext
  deletion. The transition is authoritative: the endpoint returns `200` even if the
  audit insert fails. Audit rows use a deterministic id derived from the message id
  with `INSERT OR IGNORE`; the endpoint records the authenticated principal and the
  worker records a system actor (null account/speaker). The already-expired endpoint
  path retries the insert; the worker reconciles any still-missing rows.
- Service helper `deleteExpiredBodyBlob` deletes ciphertext only for expired messages
  and marks `body_objects.state = 'deleted'`, `storage_key = NULL`; a missing blob
  counts as success.
- `expire-bodies [--limit N]` (default 500, 1–5000) runs both phases: mark due rows
  expired, then delete blobs for expired/undeleted objects, then reconcile missing
  audit rows. `examined` counts **distinct** messages, so a row in both phase 1 and
  phase 2 is counted once. Per-row failures are counted and do not stop the run; one
  JSON summary line is printed and the process exits non-zero when `failures > 0`.
  Safe to repeat and after crashes.
- `issue-key --scopes <comma-separated>` issues a narrower credential; the default
  remains the four member capabilities. Empty, duplicate, unknown, or not-granted
  scopes (not a subset of the speaker's active membership capabilities) are rejected.
- Read races: the receipt INSERT requires `body_state = 'ready'` and reports
  `BODY_EXPIRED` if a concurrent expiry won; the body-open path reports
  `BODY_EXPIRED` (without an integrity audit) when expiry cleaned the object after the
  route's state check.
- Expiry requires an external scheduler: there is no in-process timer or daemon. The
  server only enforces an explicit endpoint; the operator schedules the command.
- Tests: 147 total, 146 pass, 1 skipped (live D1 marker): strict timestamp validation,
  tombstone metadata, fetch/receipt denial plus retention of existing receipts,
  endpoint authorization/state ordering, concurrent transition, expiry/read races,
  audit repair/reconciliation, worker due/orphan/unexpired behavior and distinct
  examined counts, the due-query index plan, CLI scopes and failure exit, and wire-up.
- Commands executed: `npm run check`, `npm run build`, and a temp-data-directory CLI
  smoke (`init` → service send with near expiry → `expire-bodies` → body fetch fails,
  metadata survives).

## Vertical slice G — per-credential rate limiting (implemented at this tree)

- **Core limiter.** `src/app/rate-limit.ts` is a Web-standard token bucket with an
  injected clock (`now`, `maxKeys`, `idleMs` options). `RateLimitConfig` holds
  `perMinute` and `burst`; `rateLimitConfigFromEnv` parses
  `CORKBOARD_RATE_LIMIT_PER_MINUTE` (integer `>= 0`, `0` disables) and
  `CORKBOARD_RATE_LIMIT_BURST` (integer 1–1000) and throws a clear error on empty,
  signed, fractional, non-numeric, or out-of-range values. Defaults are 120/minute with
  burst 30.
- **Placement.** `createApp` builds one `RateLimiter` per app. `authenticate()` checks
  it immediately after `authenticateBearer` resolves the `Principal`, so every
  authenticated `/api/v1/...` and `/mcp` request is keyed by `credentialId` before body
  parsing, handler work, or MCP session creation. `/healthz` and unauthenticated
  requests never reach the check. REST and MCP share the same bucket.
- **429 contract.** An exhausted bucket throws `RateLimitError` (an `AppError` with code
  `RATE_LIMITED` and `retryAfterSeconds >= 1`). The normal error envelope is returned
  with `Retry-After`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and
  a `request_id`; no token, body, summary, or session id is included. Over-limit MCP
  requests get this HTTP envelope before the SDK runs and no `mcp-session-id`.
- **Memory bounds.** Buckets are capped at 10,000 entries; the oldest entry is evicted
  when a new credential arrives at the cap, and an entry untouched for 2 minutes is swept
  (time-gated to at most once per idle window). Behaviour is deterministic with the
  injected clock.
- **Startup.** `startServer` parses the limiter configuration before creating, opening,
  or chmodding the data directory, so invalid values fail startup with the variable name
  and leave the filesystem untouched. `0` disables limiting entirely.
- **Docs.** `docs/api.md` (rate-limit contract and error), `docs/security-operations.md`
  (process-local, reverse-proxy per-IP limits, no secret logging), `docs/architecture.md`,
  `docs/deployments.md` (env table/example), and `docs/mcp.md` (429 before session) are
  updated. Nothing claims distributed or global limiting.
- **Tests.** New `tests/integration/rate-limit.test.ts` (9 tests) covers burst capacity
  and refill with `Retry-After`, per-credential isolation, REST/MCP shared bucket and
  no-session 429, `0` disable, env defaults/invalid/bounds, startup refusal before
  filesystem creation, no token/body disclosure, healthz and unauthenticated requests
  unkeyed, bounded-map/idle eviction, and constructor bounds. Existing suites are
  unchanged.
- **Limitations.** Limits are process-local and per credential; they are not shared
  across processes or Workers isolates and reset on restart. There is no per-IP limiting
  in the application (bearer tokens are 256-bit; reverse proxy handles unauthenticated
  and volumetric abuse). The Node adapter still reads an in-cap body before the core
  runs, so a rate-limited request's bytes reach the adapter but are never parsed by the
  application.

## Vertical slice H — structured request metrics (implemented and pushed)

- **Registry.** `src/app/metrics.ts` is a Web-standard, dependency-free, in-memory
  registry. It records total requests, fixed route labels, HTTP status counts, stable
  error codes from the Corkboard response envelope (including `RATE_LIMITED`), and
  request duration in cumulative buckets at 5, 25, 50, 100, 250, 500, 1000, 2500, 5000,
  and 10000 ms plus `+Inf`. Snapshot arrays are sorted and the final bucket equals the
  latency count.
- **Fixed cardinality.** `routeLabelFor` maps path shape to `/healthz`, `/mcp`,
  `/metrics`, the `/api/v1` templates with `:projectId`/`:messageId` placeholders, or
  `unknown`. Raw pathnames, query strings, object IDs, bodies, summaries, tokens,
  speaker/account IDs, and IPs are never stored. `/mcp` counts every transport HTTP
  request under one label; tool names and arguments are not read.
- **Operator endpoint.** `GET /metrics` is disabled by default. Unset, empty, and
  whitespace-only `CORKBOARD_METRICS_TOKEN` values return the ordinary unknown-route
  `404`; any other configured token must be at least 32 characters at both env parsing
  and `createApp` construction (a shorter value throws a fixed, value-free error; the
  env parser runs before the data directory is created, opened, chmodded, or migrated).
  Authentication is header-only: exactly `Authorization: Bearer <token>`; `?token=` is
  ignored. Both values are SHA-256 digested and compared at fixed length without an
  early exit. Missing, wrong, and non-operator speaker tokens return the same `404`
  status, envelope, and security headers. Responses carry `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`. Documented timing caveat: enabled requests with a
  `Bearer` header hash while disabled requests do not, so timing may reveal the enabled
  state even though status/body are identical.
- **Instrumentation.** `createApp` records every response it produces, including
  successes, application errors, `429 RATE_LIMITED`, and `/mcp`. The Node adapter
  records only pre-core rejections (64 KiB body rejection and pre-response 503) with the
  same fixed labels; every adapter `recordRequest` is wrapped so metrics can never
  prevent or alter a response, and a failure while writing an already-recorded core
  response is not counted as an extra 503. Auth/authz/error ordering is unchanged.
  `/metrics` does not authenticate a speaker and never touches the per-credential
  limiter.
- **Docs.** `docs/api.md` (shape, auth, labels, limitations), `docs/architecture.md`,
  `docs/security-operations.md`, `docs/deployments.md` (env table and operator usage),
  `docs/mcp.md`, `TODO.md` (implemented subset only), and `LESSIONS.md` are updated.
- **Tests.** New `tests/integration/metrics.test.ts` (15 tests) covers disabled
  404 behavior, direct-construction and env normalization of empty/whitespace tokens and
  rejection of sub-minimum tokens, whitespace disabled through `startServer`, exact
  token auth with no echo/log and identical disabled/wrong/speaker-token/query refusals,
  fixed-length digest auth, REST success/error/429 and MCP initialize/tool counters with
  fixed labels, adversarial unknown paths collapsing to one `unknown` label, adapter
  413 recording under the fixed route label, deterministic bucket boundaries (direct
  registry and injected app clock), no content/ID/token leakage with consistent totals,
  env parsing and startup refusal before filesystem creation, and no rate-limit bucket
  consumption by `/metrics` or `/healthz`.
- **Limitations.** Metrics are process-local in memory: they reset on restart, are not
  shared across processes or Workers isolates, and have no persistence or history.
  There are no per-project authorized views and no queue-to-commit histogram in that
  slice; latency is HTTP request duration only. (Both are added by slice R below.)
  Disabling the endpoint stops neither counting nor memory
  use (the registry is bounded by the fixed label/status/error sets).

## Vertical slice I — human account sessions (implemented and pushed)

- **Scope.** An owner account with a password can sign in, read its session, use the
  session on the session routes, and sign out. Registration, email verification,
  password reset, OAuth 2.1/PKCE (added later by slice J), ChatGPT integration, a
  web UI, speaker impersonation, and dashboard endpoints are not part of this slice. A
  session authenticates an account and never a speaker: bearer routes and `/mcp` do not
  consult it, and the session token is not a bearer credential.
- **Migration 003.** `sessions(id, account_id REFERENCES accounts, token_prefix,
  token_verifier, csrf_verifier, created_at, last_seen_at, expires_at, revoked_at)` with
  `account_id` and `token_prefix` indexes. Applies on a fresh database and on a
  migration-002 database; the normal opener records version 3 atomically.
- **Password KDF port.** New hashes are portable PBKDF2 via WebCrypto:
  `pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>`, 600,000 iterations,
  fresh 16-byte salt, 32-byte derived key, fixed-length hex comparison.
  `ServiceDeps.passwordVerifier` is the injectable port; core defaults to the portable
  verifier. The Node adapter adds legacy `scrypt$<salt>$<hash>` verification with
  `timingSafeEqual`; it is never written, and unknown formats fail closed. The CLI
  bootstrap now writes PBKDF2.
- **Tokens and CSRF.** `cb_sess_` + 43 base64url chars (256 random bits) and an
  independent 256-bit CSRF value. The database stores the token's first 16 characters
  and keyed HMAC-SHA-256 verifiers for both values under the existing credential pepper;
  no new secret. Cookies: `__Host-corkboard_session` (`HttpOnly; Secure; SameSite=Strict;
  Path=/; Max-Age=43200`) and `corkboard_csrf` (`Secure; SameSite=Strict; Path=/;
  Max-Age=43200`, readable). `DELETE` requires a matching `X-CSRF-Token`; comparison is
  a fixed-length digest via `digestsEqual`.
- **Lifetime and validity.** Absolute 12 hours, idle 30 minutes since `last_seen_at`,
  refreshed lazily on accepted session requests. Revoked, expired, idle-expired,
  unknown, or inactive-account sessions are uniform `401 UNAUTHENTICATED`. No
  authorization cache.
- **Endpoints.** `POST /api/v1/session` requires `Content-Type: application/json`
  (parameters allowed) before parsing; other media types are `VALIDATION_ERROR`.
  Credential failures are uniform `401` for unknown email, wrong password, inactive
  account, and no-password account; unknown/no-password verify a dummy PBKDF2 hash.
  `GET /api/v1/session` returns the account only. `DELETE /api/v1/session` revokes one
  row, clears cookies, and returns `204`. `Set-Cookie` is emitted only on success.
  Session-route `401`s carry no `WWW-Authenticate` header (bearer routes keep `Bearer`).
- **Login abuse control.** Separate process-local token bucket keyed by the SHA-256 of
  the normalized email: 10/minute with burst 5, injected clock, `429 RATE_LIMITED` with
  `Retry-After`. The address is never retained in the limiter. Not distributed.
- **Logging.** Request logs remain method/path/status/duration/actor only; `Cookie`,
  `X-CSRF-Token`, passwords, tokens, CSRF values, and emails are not logged.
- **Docs.** `api.md`, `architecture.md`, `threat-model.md`, `security-operations.md`,
  `deployments.md`, `TODO.md` (completed Phase 3 subset only), and `LESSIONS.md` updated.
- **Post-audit adapter fixes.** The Node adapter includes `POST /api/v1/session` in
  `needsBody`, so the JSON login body reaches the core. Response writing reads
  `Headers.getSetCookie()` and passes the array to `setHeader("set-cookie", ...)`, so
  login emits two raw `Set-Cookie` lines and logout clears both instead of one
  comma-joined value. Login also requires `application/json` to block simple cross-site
  form/text posts (no CORS is enabled).
- **Tests.** New `tests/security/session.test.ts` and
  `tests/integration/sessions.test.ts`; the latter starts a real `startServer()` and
  drives login → read → logout → replay, asserting two raw `Set-Cookie` lines at the
  Node HTTP layer. Migration expectations in the storage contract, doctor,
  built-adapter, and CLI tests updated. Login-shape/content-type, bearer-header-ignored,
  suspended-after-login, `__Host-`, and bootstrap password-cap tests added. Full-suite
  counts are recorded in the checkpoint commit trailer.
- **Limitations.** Login limiting is process-local; absolute timing indistinguishability
  is not claimed (especially vs. the Node-only scrypt path). Session rows are not
  automatically purged (slice K adds only the explicit operator `prune` command). No
  browser UI, registration,
  recovery, OAuth, or speaker delegation exists.

## Vertical slice J — OAuth 2.1 authorization-server core (implemented and pushed)

- **Scope.** A signed-in human account can authorize a dynamically registered public
  client to act as one selected speaker in one selected project with only
  `message.read` and/or `message.send`. The client completes authorization code + PKCE
  (S256), exchanges the code for a short-lived `cb_oat_` access token, uses it on the
  existing REST/MCP APIs, refreshes with rotation, and revokes. No API key or client
  secret exists in the flow. The ChatGPT Web plugin installation/sharing experience and
  conversation-level ChatGPT invocation are not implemented or verified.
- **Migration 004.** `oauth_clients`, `oauth_authorization_codes`,
  `oauth_refresh_tokens`, and `oauth_token_clients` with foreign keys and lookup
  indexes. Registered `grant_types`/`response_types` are persisted; each code records
  the issuing `session_id`; `oauth_token_clients` records which public client owns an
  access credential even when no refresh row exists. Codes and refresh tokens are
  stored only as a public prefix plus a keyed HMAC verifier; no plaintext token, code,
  verifier, or client secret is stored. The migration was revised in place before any
  release and was never on `origin/main`; no supported installation has the pre-fix v4
  shape, and such an unreleased database must be recreated rather than upgraded.
  Applies on a fresh database and on a migration-003 database.
- **Client registration.** `POST /oauth/register` accepts bounded JSON, public clients
  only (`token_endpoint_auth_method=none`), 1–10 exact absolute HTTPS redirect URIs
  (loopback HTTP allowed for `127.0.0.1`/`localhost`), bounded `client_name`, and
  consistent `grant_types`/`response_types`. It returns snake_case registered metadata
  and an opaque `client_id`; unknown metadata is ignored. Registration is limited to
  10/minute (burst 5, process-local global key).
- **Authorization and consent.** `GET /oauth/authorize` requires the session cookie and
  validates client, exact redirect, `response_type=code`, S256 PKCE, resource = the
  configured base URL, bounded state, and a subset of `message.read`/`message.send`.
  Invalid redirects render HTML `400` and never redirect. Signed-out browsers get an
  escaped, strict-CSP sign-in form (no inline script) that posts to `/oauth/signin`; a
  double-submit `HttpOnly; Secure; SameSite=Lax` cookie plus hidden field blocks login
  CSRF, and the handler uses the same `loginAccount` service and cookies as
  `POST /api/v1/session`. The consent page lists only speakers owned by the signed-in
  account with an active membership whose capabilities contain every requested scope.
  `POST /oauth/consent` requires the session and `X-CSRF-Token`, re-reads client,
  redirect, ownership, account/speaker/project status, membership, and capabilities,
  and issues a 5-minute single-use code. The form's mandatory `requested_scope` and
  `request_signature` are verified against a server HMAC of every authorization-request
  field (including the issuing session id) before the selected scopes are checked as a
  subset, so a consent POST cannot add or misdeclare a scope or replay another
  session's form. Deny redirects `access_denied` with no code. OAuth can never grant
  `project.edit`, member scopes, or `receipt.write`.
- **Token endpoint.** Form-encoded only. Authorization code exchange verifies the exact
  client, registered redirect, resource, PKCE S256 (keyed HMAC over code + challenge at
  fixed length), code expiry, and single use via a conditional `UPDATE`, then
  re-checks consent and re-reads all status/membership state. Success returns a
  1-hour `cb_oat_` access token and a 30-day `cb_ort_` refresh token with
  `token_type=Bearer`, `expires_in`, and `scope`. A client registered without the
  `refresh_token` grant receives no refresh token and cannot use the refresh grant.
  The code exchange also verifies that its issuing session is still active. Refresh
  rotates the refresh row and replaces the underlying credential's
  prefix/verifier/expiry, retiring the previous access token immediately; reuse of a
  rotated/revoked row revokes the family and credential. Scope cannot widen. Token
  exchange is limited to 60/minute (burst 20, process-local, keyed by `client_id`)
  plus a global 300/minute (burst 60) endpoint bucket so rotating `client_id` cannot
  bypass limiting.
- **No second authorization path.** Access tokens are ordinary `credentials` rows with
  one `credential_project_grants` row, so `authenticateBearer` and the service
  authorization layer are unchanged. Revocation, expiry, membership/grant removal, and
  scope checks take effect on the next REST/MCP request.
- **Revocation.** `POST /oauth/revoke` is RFC 7009 form-encoded and always returns
  `200` for a well-formed request: unknown tokens, wrong clients, and ordinary speaker
  tokens are no-ops. A refresh token revokes its family and credential; an OAuth access
  token revokes the credential and families for the matching client, using the durable
  `oauth_token_clients` association so code-only clients are revocable too. A global
  process-local limiter (60/minute, burst 20) returns `429` only above the limit.
- **Configuration.** `CORKBOARD_PUBLIC_BASE_URL` must be a plain `https` origin. Unset
  disables every OAuth route with a fixed `503`; invalid fails startup before the data
  directory is created/opened/chmodded. Discovery, issuer, and `resource` all derive
  from that origin.
- **Pages/headers.** Both HTML pages fully escape values, have no inline JavaScript and
  no third-party resources, and use
  `default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self';
  base-uri 'none'; frame-ancestors 'none'`. The consent form submits through the
  constant same-origin `/oauth/client.js` to add the CSRF header. Every OAuth response
  is `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`.
- **Metrics/logging.** Fixed route labels for the OAuth paths; no client IDs, scopes,
  codes, tokens, cookies, CSRF values, or form bodies are logged or used as labels.
- **Tests.** New `tests/security/oauth.test.ts` (31 tests) and
  `tests/integration/oauth.test.ts` (5 tests through real `startServer()`), plus
  migration 004 contract coverage for fresh and 003→004 databases. Coverage includes
  redirect mismatch/open redirect, PKCE wrong/missing/replay, code expiry/replay and
  binding to client/redirect/resource/account/speaker/project/membership/issuing
  session (including absolute and idle expiry), consent without session/CSRF,
  mandatory signed `requested_scope` with forged/missing/subset escalation rejected
  and cross-session replay rejected, scope escalation
  (`project.edit`/member scopes), another account's speaker/project, invalid DCR
  metadata and oversized/duplicate redirects plus redirect count/length boundaries,
  code-only grant registration behavior, discovery secrecy, access-token use on REST
  and MCP with exact scopes, refresh rotation and reuse revocation, RFC 7009
  no-oracle behavior including a no-op speaker token and code-only access-token
  revocation, injected-clock per-client and global rate limits plus revocation
  limiting, DB-only verifier storage, log secrecy, HTML escaping/CSP, fixed
  metrics labels, `return_to` control-character rejection, content-type enforcement,
  and an end-to-end HTTP flow.
- **Limitations.** Process-local OAuth registration, per-client, global token, and
  revocation buckets. Concurrent refresh with the same token races and may revoke the
  family. Codes/refresh rows are not automatically purged; slice K adds the explicit
  operator `prune`. No CORS, JWT/OIDC,
  implicit/client-credentials/device flows, consent management UI, or admin OAuth
  endpoints. ChatGPT Web, D1/Workers, and real browser verification remain
  external/unverified. Independent review passed on code tree `a439df4`.

## Vertical slice K — operator-driven session/OAuth retention (implemented and pushed)

- **Scope.** One explicit CLI command, `prune`, idempotently deletes only definitely
  unusable session and OAuth rows after a grace period. There is no timer, scheduler,
  or automatic deletion. It never deletes messages, receipts, blobs/body objects,
  audit events, speaker `cb_` credentials, or any token/credential still usable at the
  run time.
- **Service.** `src/service/retention.ts` exposes `pruneRetention({db, now}, {graceHours,
  limit})` with an injected clock, default grace **24 hours**, default per-table
  `limit` **1000** (bounds 1–10000), and imports `SESSION_IDLE_MS` from `sessions.ts`
  rather than duplicating it. Eligibility: sessions revoked/absolutely expired/idle
  past grace; authorization codes consumed or expired past grace; refresh tokens
  expired/revoked/rotated past grace; `oauth_token_clients` rows whose credential is
  gone, or revoked/expired past grace with no remaining refresh row (never a
  still-valid credential or one with a live refresh row); OAuth access
  credentials with an association, revoked/expired past grace, and no remaining
  refresh row. Associated `credential_project_grants` are removed with the credential.
- **Transaction and concurrency.** All deletes run in one `BEGIN IMMEDIATE` transaction
  in FK-safe order (codes → refresh tokens → grants/associations → OAuth credentials →
  sessions), each artifact table bounded by `limit`; grants are removed with their
  credential and are not counted separately. The eligible OAuth credential ids are captured
  under the write lock while the association still exists, then deleted with
  conditional predicates, so a speaker credential can never be classified as OAuth and
  a concurrent run cannot widen the set. A delete failure rolls back and exits
  non-zero (the later prune-audit slice adds a fail-open audit insert after commit).
  A second run deletes nothing extra once eligible rows are exhausted; while the
  per-table `limit` truncated a run, a rerun continues deleting up to the limit.
- **CLI.** `prune --data-dir <dir> [--grace-hours N] [--limit N] [--json]` also accepts
  `CORKBOARD_DATA_DIR`. Invalid grace/limit reuse the service validation and are
  rejected **before** the directory is created or the database opened. Exit `0`
  success, `1` failed/rolled back (the later prune-audit slice adds: `1` also means
  deletions committed but the audit insert failed), `2` usage/config. `--json` prints exactly one
  summary line `{graceHours, limit, sessions, authorizationCodes, refreshTokens,
  tokenClients, oauthCredentials}`; without it, short count lines. No row contents,
  tokens, or emails are printed.
- **Docs.** `docs/security-operations.md` (policy, grace rationale, never-deleted set,
  daily schedule), `docs/deployments.md` (command/options/exit codes), 
  `docs/architecture.md` (retention section and delete order), `docs/oauth.md` (row
  lifecycle), and the completed TODO sub-item. No HTTP surface was added, so
  `docs/api.md` is unchanged.
- **Audit fixes (P1/P2).** Association cleanup is orphan-only: a revoked/expired
  credential with a live refresh row keeps its `oauth_token_clients` association and
  grants, so refresh and RFC 7009 access-token revocation still work. Once the refresh
  row is pruned past grace, the credential, association, and grants are deleted
  together. `validateRetentionOptions` bounds grace to the representable JavaScript
  `Date` range **minus the session idle window**, so an accepted value cannot overflow
  the idle cutoff for a normal clock and an overflowing `--grace-hours` is rejected
  before the database is opened (exit 2). Regression tests cover the full refresh →
  revoke → prune sequence, grace-0 exact boundaries (exactly at cutoff deleted, 1 ms
  younger retained), and per-table limits for refresh rows, associations (including
  orphan cleanup), and OAuth credentials.
- **Tests.** New `tests/integration/retention.test.ts` (12 service tests with an
  injected clock) and `tests/integration/retention-cli.test.ts` (5 real-process CLI
  tests). Coverage includes active/just-inside/just-over grace boundaries per class,
  idle expiry, consumed/expired codes, rotated/revoked/expired refresh rows, orphan and
  live associations, the refresh-row blocker, `cb_` credential protection, per-table
  limits and no-op rerun, injected rollback, untouched message/receipt/blob/audit
  tables, input validation before writes, real temp-directory `--json` counts, exit
  codes, pre-open bounds and overflow rejection, and output secrecy.
- **Tests run.** `npm ci`, `npm run check` (321 tests: 320 pass, 1 pre-existing skip
  for the live D1 marker), and `npm run build`. Exact counts are recorded in the
  checkpoint commit trailer.
- **Limitations.** The command is Node/SQLite-only (it uses the local
  `BEGIN IMMEDIATE` runner; a D1 adapter would need a batch equivalent). A credential
  blocked from deletion by a still-live refresh row keeps its `oauth_token_clients`
  association and grants, so refresh and RFC 7009 revocation remain effective; the
  credential, association, and grants are deleted together once the refresh row ages
  out past grace. There is no automatic scheduling and no audit row is written for
  prune (superseded: the prune-audit slice appends one row per deleting run).
  No blob/message/audit deletion is added. Independent review passed on security
  and contract for trees `9c5991e` and `1a5d207`; the remaining audit P2s were
  documentation/state wording corrected in this checkpoint.

## Vertical slice L — read-only human dashboard (candidate)

- **Scope.** Server-rendered pages for `/login`, `/`, `/projects/:projectId`, and
  `/projects/:projectId/messages/:messageId/body`, plus the constant
  `/static/app.css`. English default and Simplified Chinese via `?lang=zh`. No
  project/message/membership/credential/receipt write, edit, key, expiry, or admin
  action; no SPA, frontend dependency, client script, or inline style. The only
  writes are the session row inserted by `POST /login` and `sessions.last_seen_at`
  bookkeeping on authenticated page requests.
- **Authorization.** The session authenticates an account. `resolveSessionViewer`
  selects active, non-removed memberships of speakers owned by that account in the
  target project, intersects them with `project.read` or `message.read`, and builds
  the normal `Principal` shape with `sessionViewer: true`. `authorizeProject` has a
  session branch that re-checks project, membership, speaker ownership, and account
  state, requires the requested scope in parsed capabilities, and returns **only
  that read scope** as the principal's `scopes` and the result's
  `rights`/`capabilities`; it never creates or consults a credential or grant. The
  branch permits only `project.read`/`message.read`, so a session viewer cannot
  authorize a write even if misrouted, and `markRead`'s `receipt.write` check fails.
  Union across owned
  speakers means "at least one owned speaker grants the capability". Unreadable
  projects, removed memberships, foreign projects, and no eligible speaker are a
  uniform `404`; revoked/expired/suspended sessions redirect to `/login`.
- **Rendering and security.** `src/app/html.ts` owns the single `escapeHtml` boundary
  and the strict CSP (`default-src 'none'; style-src 'self'; form-action 'self';
  base-uri 'none'; frame-ancestors 'none'`). Every dynamic value is escaped; bodies
  appear only in `<pre>` after explicit reveal through the existing verified decrypt
  path. Pages are `no-store`, `nosniff`, `no-referrer`, and `X-Frame-Options: DENY`.
  Login is a form-encoded double-submit CSRF flow with same-origin-only
  `return_to`, an over-long-URL-safe redirect, and a `Sec-Fetch-Site`/`Origin`
  host check as defense in depth. Duplicate or mismatched CSRF fields return the
  expired-form retry page. No message content or token is logged.
- **i18n and accessibility.** en/zh catalogs cover every string; `lang` is `en` or
  `zh-Hans` with `dir="ltr"`; dates use `Intl.DateTimeFormat` in UTC; the visible
  switch preserves the path. Skip link, header, labeled nav, `main` focus target, and
  language `aria-current` are asserted in committed DOM tests. Heading hierarchy,
  description lists, text (not color-only) state, and visible focus are implemented in
  markup/CSS but verified by inspection, not committed tests. No automated axe audit
  has been run and no WCAG conformance level is claimed.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (339 tests: 338 pass, 1
  pre-existing skip for the live D1 marker); `npm run build` exit 0. New tests cover
  eligible/removed/foreign authorization, uniform 404, revoked/expired/suspended
  sessions, the read-only rights/scopes guard (`markRead`, `sendMessage`, expiry),
  per-read capability denial on listing/timeline/body, parsed-capability listing
  (including a malformed substring match), XSS in titles/summaries/display
  names/bodies, CSP and hardening headers including `X-Frame-Options`, CSRF,
  duplicate-CSRF and fetch-metadata rejection, bounded long-URL redirects,
  `return_to` rejection, i18n fallback and path preservation, ascending
  sequence/pagination bounds/tombstones/read receipts, body reveal and safe failure
  pages, no receipt/table mutation on read GETs, and a real HTTP flow through
  `startServer`.
- **Audit fixes.** Security P2s: session viewer rights are only the requested read
  scope; an over-long unauthenticated URL produces a bounded login redirect; the
  session project listing parses capabilities instead of substring matching; login
  also rejects cross-site fetch metadata. Contract P2s: docs qualify the only
  writes (login session row and `sessions.last_seen_at`), document the duplicate-CSRF
  retry page and the OAuth consent state change, add committed accessibility DOM
  assertions without claiming axe/WCAG conformance, add per-capability and
  no-mutation negative tests, and record the real pushed base `7df76f7`.
- **Browser evidence.** A local headless Chrome CDP run (outside the repository; the
  harness is deleted) was rerun after the audit fixes. It observed: login page
  `lang=en` with a CSRF form; successful
  sign-in to `/`; project list showing the project and member name; timeline order
  "First smoke message | Second smoke message" with reply and read-receipt labels;
  two body links; the first body rendered as text in a `PRE` (`hello <world> &
  "quoted"`); clicking the Chinese switch changed the document to `lang=zh-Hans`,
  showed the Chinese timeline label, and preserved the body path. The CDP-driven
  `form.submit()` sent `Origin: null`; that is treated as no fetch-metadata
  assertion and the double-submit CSRF still authenticates. This is local Chrome
  evidence, not Workers/D1 or an exact-revision independent review.
- **Limitations.** Read-only only; the project list is capped at 100 with no UI
  pager; no filters, search, replay scrubber, attachments, previews, or image
  rendering; no project/speaker/membership/credential management or registration/
  recovery; no Workers/D1 UI parity; no client-side navigation. Independent review
  is PENDING.

## Vertical slice M — dashboard filters, summary search, replay, responsive layout (candidate `a4a6ef3`, tree `c733ab9`; audit-fix candidate `a5bb688`, tree `dbb72be`)

- **Scope.** Extends only the existing read-only `/projects/:projectId` timeline
  with server-rendered, no-JavaScript metadata filters (`type`, `sender`,
  `unread`), summary-only search (`q`), bounded cursors (`after_seq`,
  `before_seq`, `limit`), previous/next and "jump to latest" links, an active
  filter state with a clear link, and a CSS-only responsive layout. No new route,
  mutation, receipt write, admin action, frontend dependency, client script, or
  inline style.
- **Query reuse.** The page parses the same identifiers and bounds as the REST
  message list and passes them unchanged to the existing `listMessages`.
  `sender` is an exact speaker ID validated against active project membership;
  `q` is a case-insensitive summary substring capped at 100 characters with
  escaped wildcards and never touches encrypted bodies; `unread` uses the same
  receipt subquery and the deterministic session viewer speaker. Malformed or
  out-of-range values return the safe `400`; an unreadable project returns the
  uniform `404` before filter parsing. `lang` is preserved in the form and every
  pager link.
- **Replay.** `listMessages` now fetches one extra row and returns an internal
  `hasMore` boolean; the pager uses it to omit links at the end while REST and
  MCP continue to serialize only their existing fields. Previous/next clear the
  opposite cursor; "jump to latest" uses `before_seq=Number.MAX_SAFE_INTEGER`.
  All navigation is link-driven and bounded by the validated `limit`.
- **Layout and i18n.** The stylesheet adds a wrapping filter grid, a
  single-column stacked message layout below `40rem`, and a table-like metadata
  grid at or above `48rem`, with a 1rem page gutter and `overflow-wrap` on long
  values. New en/zh strings cover labels, hints, active state, empty results,
  pagination, and reset. Labels use `for`/`id` pairs; focus indicators include
  inputs and buttons.
- **Security.** Reflected filter values are escaped in text and attribute
  positions; a `"><script>` payload test confirms no executable markup. There is
  no body search, no new SQL path, no new mutation, no change to CSP/headers, and
  query values are not logged. Filtered GETs are asserted not to change message,
  receipt, body, or audit counts.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (344 tests: 343 pass, 1
  pre-existing skip for the live D1 marker); `npm run build` exit 0. New tests
  cover every filter and combination, ASCII case-insensitivity, empty results,
  invalid values and limit bounds, forward/backward cursor chains with no
  duplicate or skipped rows, exact-limit `hasMore`, tombstones under filters,
  summary-only search with a body-only term, reflected-XSS escaping, active
  state/reset rendering, `unread=false` as an active read-only filter with a
  filtered empty state, locale preservation and zh strings, unknown-locale
  fallback, uniform 404 with filters and malformed filters, no receipt/table
  mutation on filtered GETs, no inline style/script, viewport meta and
  responsive stylesheet assertions, the empty-page jump-only pager behavior,
  `h1` overflow wrapping, `hasMore` absent from REST and MCP list payloads, and
  the real `startServer()` HTTP flow.
- **Browser evidence.** A temporary local headless Chrome/CDP run outside the
  repository observed: `/login` in English with CSRF and labels; successful form
  sign-in to `/`; the project list; the timeline with three summaries and the
  labeled filter form; `?type=note` showing only the two notes with
  "Active filters: Type: note" and a clear link; `?q=alpha` showing only the
  matching summary with `alpha` reflected in the input; `?limit=1` followed by
  next (`#2`), previous (`#1`), and jump-to-latest (`#3`) links; and
  `?lang=zh&type=note` with `lang=zh-Hans`, `dir=ltr`, `筛选`, and the Chinese
  active-filter line. At a 375px emulated viewport, `scrollWidth` equaled
  `innerWidth` (no horizontal scroll), body padding was 16px, and the page had
  zero `<script>`, zero `<style>`, and zero inline style attributes. This is
  local Chrome evidence, not an exact-revision independent review.
- **Audit P2 fixes (first independent audit on final tree `ea34f5d`: security
  PASS, contract PASS).** `unread=false` is now an active filter with a distinct
  "Read only"/"仅已读" state, clear link, and filtered empty state; the pager
  documentation distinguishes non-empty link behavior from the empty-page
  jump-only behavior; `h1` joins the `overflow-wrap: anywhere` selectors so long
  unbroken project titles cannot overflow; and REST/MCP tests assert the
  internal `hasMore` probe never appears in serialized list payloads.
- **Limitations.** Search is summary-only; there is no body search, full-text
  index, ranking, date filter, time scrubber, or cross-project search. The
  sender filter requires an exact speaker ID and offers no member picker.
  Unread is tied to the deterministic session viewer speaker. Replay is bounded
  links, not infinite scroll. An `after_seq` page infers older rows from a
  non-zero cursor; a filter that matched no earlier row can therefore show one
  "older" link to an empty page (bounded and filter-preserving). Search case
  folding is the ASCII-only SQLite `LIKE` behavior. No Workers/D1 parity,
  automated axe/WCAG audit, or touch-device matrix is claimed. Independent
  security and contract review is PENDING.

## Vertical slice N — operator backup and verified restore (implemented and pushed)

- **Scope.** Adds three Node/SQLite operator commands and one service module
  (`src/service/backup.ts`): `backup --data-dir --out [--json]`,
  `verify --backup [--json]`, and `restore --backup --data-dir [--json]`. No
  scheduler, remote/cloud upload, backup encryption beyond the existing ciphertext,
  key export, rotation, overwrite/`--force`, D1/Workers path, or production deployment.
- **Snapshot and blob policy.** `backup` opens the source database read-only and uses
  SQLite `VACUUM INTO`, producing one consistent standalone database without
  `-wal`/`-shm` sidecars; writers are not blocked for the blob copy. Every regular file
  in `blobs` is then copied exactly (orphans included, opaque names preserved,
  `0600`); directories, symlinks, devices, and other non-file entries are rejected and
  the partial output is removed. The source is opened read-only: no database/blob
  content is modified, and a source with no WAL sidecars is opened `immutable=1` so
  backup creates no `-wal`/`-shm` (a live read with both sidecars present may touch the
  existing `-shm`).
- **Manifest.** `manifest.json` format `corkboard-backup` version `1` records
  `created_at` UTC, database file/size/SHA-256, sorted blob names/sizes/SHA-256,
  counts, and the highest applied schema version. It is bounded (8 MiB, 100,000 blob
  entries), validates blob names as plain basenames, and contains no keys, tokens,
  emails, bodies, or absolute paths. Output directory `0700`, files `0600`; existing
  `--out` refused.
- **Verification.** `verify` checks manifest schema/version/bounds, required and
  unexpected files, non-file/symlink rejection, every size and SHA-256, runs
  `PRAGMA integrity_check` on the snapshot read-only (only after its digest matches),
  rejects schema newer than the bundled migrations or a schema/manifest mismatch, and
  cross-checks every non-null `body_objects.storage_key` against the manifest. Stable
  `BACKUP_*` codes; exit `0` clean, `1` issues, `2` cannot inspect.
- **Restore.** Verifies first, then requires an absent or empty non-symlinked target
  outside the backup directory. Copies database and blobs into a `0700` temporary
  sibling, re-hashes each file against the manifest, repeats integrity and schema
  checks, and atomically renames the staging directory into place. A failure removes
  staging and leaves no partial install; existing files are never overwritten and no
  secrets or keys are read or written.
- **CLI conventions.** Usage/config failures exit `2` before filesystem work (including
  missing required flags and parse errors); runtime/validation failures exit `1`.
  `--json` prints exactly one object on stdout, including `{ok:false,code,...}`
  failures; human output is short lines. No body, token, key, email, or absolute path
  is printed.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (reported in the checkpoint
  trailer with exact counts); `npm run build` exit 0. New integration tests cover a
  full seed → backup → verify → restore → decrypt round trip, counts and DB digest,
  modes, empty installation, orphan/zero-byte blobs, concurrent writer snapshot
  integrity/sequence invariants, and one-line JSON/exit codes. Security tests cover
  database and blob digest/size tampering, missing/malformed/unsupported manifests,
  path-traversal blob names, missing/extra files, symlinked blob entries (never
  followed), backup rejection of source symlinks with output cleanup, symlinked and
  dangling restore targets, non-empty target with database/blob bytes untouched, and CLI
  exit `2` versus `1`.
- **Audit fixes (first independent audit on tree `782ef11`: contract PASS with six P2s,
  security BLOCKED on one P1).** Backup now uses the diagnostics sidecar policy
  (`immutable=1` with no sidecars, refuse lone/non-regular sidecars), so it creates no
  `-wal`/`-shm` and works on a read-only source directory. Restore uses the single
  inspection result's manifest and re-runs the referenced-blob cross-check against the
  staged DB. Backup rejects a schema newer than bundled and a missing referenced blob.
  Per-file (16 KiB) and total (1 GiB) blob bounds are enforced from metadata before
  hashing/copying; the source database (16 GiB) is checked before `VACUUM INTO` and
  again after. CLI `--json` emits one failure object on exit-2 and
  unexpected paths, stderr paths are redacted, and extra positionals are rejected.
  Tests cover every previously missing negative code plus staging cleanup, and the
  concurrent-writer test asserts actual writer progress across the backup window.
  Documentation states the Node-only operator boundary and the `-shm` caveat.
- **Final re-audit P2 fixes (both re-audits of tree `116cbb6` PASS, no P0/P1).** The
  source database size is `lstat`-checked before `VACUUM INTO` so an oversized source is
  never copied into `--out`; path redaction covers quoted paths with spaces; verify
  listings use `opendir` with the 100,000-entry cap and `BACKUP_ENTRY_LIMIT_EXCEEDED`;
  human output replaces control bytes with `?` (JSON escapes C0 only, not DEL/C1);
  `digestFile`
  enforces its byte cap mid-stream; docs qualify JSON failure codes, cap ordering, and
  the attachment-driven 16 KiB revisit.
- **Limitations.** The post-snapshot blob copy can miss a blob deleted by a concurrent
  expiry in that window; `verify`'s reference cross-check detects it, and a quiesced
  backup gives a byte-exact pair. `VACUUM INTO` can temporarily slow the source while
  reading, and a live WAL read may touch existing `-shm` coordination bytes (it never
  creates sidecars). The implementation is Node-only. No scheduling, remote storage,
  backup-level encryption, key handling, point-in-time recovery, overwrite mode, or
  D1/Workers equivalent. Independent security and contract review is PENDING.

## Vertical slice O — sanitized authentication/OAuth audit events (merged at `f06c4ac`, tree `496e9ae`)

- **Checkpoint.** Merged on `main` as `f06c4aca864c9bf25dd821ad4251cfe7b48bf12a`
  (tree `496e9aed1e06dffd43a39d3aafa2b878e1df35b8`), based on
  `42e4ddccdbbf25521112045363b1fea27fa099ea`. Both independent audits PASS (security
  and contract). Verification at that tree: `npm ci` exit 0, `npm run check` exit 0
  (379 tests, 378 pass, 1 skipped live-D1), `npm run build` exit 0. CI succeeded after
  push. The commit trailer records the stale pre-final `Candidate-SHA: 550d02e5...`;
  that commit and `f06c4ac` share tree `496e9ae...`, so the audited tree is the pushed
  tree.

- **Write path.** New `src/service/audit.ts` provides `writeAudit`/`boundAuditDetail`.
  It reuses the existing `audit_events` table and `detail` column (no migration),
  parameterized SQL, random `evt_` ids, and fail-open inserts (errors swallowed, never
  logged) so audit failure cannot change an external response or authorization outcome.
- **Events.** `session.login` success/failure (`invalid_credentials`, `rate_limited`),
  `session.logout`, `oauth.client.register` success/failure, `oauth.consent`
  success/denied, `oauth.token.issue` success/failure for code exchange and refresh,
  `oauth.refresh.reuse` detected, and `oauth.revoke` success when ownership is proven.
  Rows carry actor/project ids, public client id, internal credential id, sorted scopes,
  grant type, and bounded constant reasons. No token, code, cookie, CSRF value,
  password/hash, email, client name, redirect URI, raw IP, body, or path is recorded.
  `detail` strings/arrays and the serialized document are capped; oversized detail is
  dropped. Revocation is not audited for no-op/unknown tokens, avoiding an oracle.
- **Boundaries.** At the time of slice O there was no audit read API/UI; that
  statement is now superseded by the session-only `GET /overview` summary read (at
  most 20 sanitized rows; no retention/rotation/deletion, `prune` still never deletes
  audit rows; no authorization path consults audit data). No new table and no
  authorization change. No audit call site passes a request id, so `request_id`
  remains null for these events.
- **Tests.** `tests/integration/audit.test.ts` asserts each event, uniform failure
  details, the sanitization denylist, bounded detail, rate-limited login, and that an
  injected audit-insert failure leaves login, token issuance, revocation, and logout
  successful. The full suite passes (379 tests: 378 pass, 1 skipped). Independent
  security and contract review PASS on tree `496e9ae`.
- **Remaining P2 debt (tracked, unfixed).** No audit row on a no-op or wrong-client
  revocation; `request_id` is null and unasserted; rate-limited audit paths for OAuth
  sign-in and HTML login are untested; rate-limited register/token failures are
  untested; access-token revoke audit is untested; consent-denied detail is unasserted;
  unknown/inactive-account audit-row uniformity is unasserted (response uniformity is
  tested); consent audit fail-open is uncovered (register fail-open is covered);
  fail-open audit can suppress rows; `audit_events` is unbounded.

## Design-system checkpoint (slice P) — web design-system contract (branch `slice-p-final`)

- **Checkpoint.** Branch `slice-p-final` is one squashed checkpoint commit based on
  `55bd96e28f013dc79f934eae760eb7ff5415b167`. It was pushed as `9a3d389` (tree
  `0ff2142`) and is part of `origin/main`; the shipped runtime is untouched.
- **Files added.** `designs/corkboard-design-system/` with `project/design-system.json`,
  `project/tokens.json` (light/dark color, type, 4px spacing, radius, shadow),
  `project/README.md` brand book, and static previews plus READMEs for `Cover`, `Login`,
  `ProjectList`, `Timeline`, `Filters`, and `MessageBody`; plus
  `docs/decisions/0001-web-design-system.md`.
- **Audit.** Independent security and contract audits PASS on tree `00135db`
  (pre-squash commit `214ef4b`). Their provenance, CSP, and contrast P2s were corrected
  in pre-squash fixup `b7d91b0`; the sample-data and state-wording items are corrected
  in this checkpoint. This squashed checkpoint is re-audited before push.
- **Verification.** `artifact.mjs check` problems 0; `npm ci` exit 0; `npm run check`
  exit 0 (secret scan, history-secret-scan ok — count varies with refs, typecheck,
  380 tests: 379 pass, 1 skipped live-D1); `npm run build` exit 0.
- **Boundary.** No `src/`, test, migration, schema, or runtime change. `src/app/web.ts`
  still serves system colors; the previews show the intended token contract, not the
  current shipped rendering.
- **Follow-up obligations for the application phase.** Compile tokens into one
  same-origin stylesheet served under the fixed CSP (`default-src 'none';
  style-src 'self'`), never inline `<style>` or `style=`; keep the system font stacks;
  implement `prefers-color-scheme` and/or server-rendered `data-theme`; the 3px focus
  outline with 2px offset; the 60rem measure; and real-browser verification of light
  and dark, focus visibility, 320px layout, and both locales.

## Web design-token application (slice Q) — dashboard consumes the design system (branch `slice-ui-final`)

- **Checkpoint.** Original pre-rebase branch `slice-ui-tokens` commit
  `0d9c661ad39df1f96e24160f1b7c75904a529d42` (tree
  `f83c87caa2836b7f9799e034710ad212b33ff432`) applied the tokens. That work was
  replayed and squashed onto `main`
  `4e1bf8764af319263e3d2b31f553265eeac16712` as one checkpoint commit;
  `src/app/web.ts` is byte-identical between the original and the replay; the
  test file gains the palette and inline-style guard extensions in this replay.
  The checkpoint commit trailer carries the final Base-SHA and
  Tree-SHA. The original branch commit is not an ancestor of the checkpoint.
  Pushed as `58e548f` (tree `09e3153`); it was `origin/main` at that checkpoint.
- **CSS.** `WEB_CSS` in `src/app/web.ts` defines the light palette as CSS custom
  properties on `:root`, overrides the palette under
  `@media (prefers-color-scheme: dark)` with `color-scheme: dark`, and defines the
  4px spacing scale (`--space-1` to `--space-8`), 4/8/12px radii, and the
  `--font-sans`/`--font-mono` system stacks from `tokens.json`. Rules use the
  variables; literal hex values are limited to the token definitions.
- **Rules applied.** 3px `--focus` outline with 2px offset; `--brand` button fill
  with `--brand-ink` text; `.error` danger rail; tombstone and active-filter
  `--border` rails; `--success` only with the word "Active"; 60rem measure with a
  `--space-4` gutter.
- **Serving and CSP.** No route or header change: `/static/app.css` is the same
  same-origin constant under `default-src 'none'; style-src 'self'`. No inline
  `<style>` or `style=`, script, `@import`, `url()`, or external font.
- **Behavior.** Only presentational markup additions: `class="status"` on the
  project status value and `class="error"` on the generic safe-error alert. Routes,
  handlers, authorization, data, and logging are unchanged.
- **Tests.** A new integration test asserts every light/dark colour token, the
  spacing and radius tokens, both font stacks, the negative CSP constraints, and that
  no literal hex appears outside a token definition. Verification: `npm ci` exit 0;
  `npm run check` exit 0 (381 tests: 380 pass, 1 skipped live-D1); `npm run build`
  exit 0.
- **Browser evidence.** Real-browser visual evidence for checkpoint
  `58e548f` is published in GitHub Issue #6 with its prerelease asset channel.
  That evidence surfaced the blank `sender=` timeline filter defect, fixed by
  the slice-S replay candidate `b4666e2` (squashed into the slice-S checkpoint).
  Beyond it, light/dark appearance, 320px layout, focus visibility,
  and both locales are asserted from the stylesheet and DOM only; no automated
  browser matrix is claimed.

## Vertical slice R — queue-to-commit histogram and authorized per-project counts (candidate `4a8bde8`, tree `dd59cff`)

- **Checkpoint.** Feature commit `18d53d4` (tree `5cb629b`) was replayed onto the UI
  checkpoint `58e548f` (tree `09e3153`) as `4a8bde8` (tree `dd59cff`); the feature
  commit applied cleanly, and its original message retains the original Base-SHA.
  Independent security and contract audits PASS on the replayed candidate. Their P2
  items are fixed here: member-without-grant and `failed`-row stats tests, a
  concurrent same-key finalization-winner test, and state/doc corrections. This
  squash checkpoint is based on `58e548f`; the commit trailer carries the final
  Base-SHA and Tree-SHA. Not pushed.
- **Queue-to-commit.** `MetricsRegistry.recordQueueToCommit` adds one label-free
  sample per message finalized by this process: `committed_at − received_at`, i.e.
  provisional creation (`seq = NULL`) to finalization (`seq` assigned), clamped at
  zero. It uses the same fixed cumulative buckets (5/25/50/100/250/500/1000/2500/
  5000/10000 ms + `+Inf`) as request latency and appears as `queue_to_commit_ms` in
  the existing operator-only `GET /metrics` snapshot. Idempotent replays are not
  samples: the service returns the delay only when that request performed the
  finalization (`publish` reports `finalized`), and both the REST send handler and
  the MCP send tool record it best-effort. Non-finite samples are ignored.
- **Authorized per-project counts.** New
  `GET /api/v1/projects/:projectId/stats` calls `getProjectStats`, which runs the
  existing `project.read` service authorization (active membership, explicit
  credential grant, scope). It returns `{ project_id, messages: { ready, pending,
  expired }, unread }`: committed ready rows, provisional `seq IS NULL` pending rows,
  committed expired tombstones, and committed ready/expired messages with no receipt
  from the calling speaker. The SQL is project-scoped and parameterized and selects
  no content. An unknown project and a project the caller is not a member of share the
  same `404 NOT_FOUND`; an active member without a grant gets `FORBIDDEN`, matching
  project detail. The route is read-only and has the fixed metrics label
  `/api/v1/projects/:projectId/stats`.
- **Docs.** `docs/api.md` (snapshot field and stats endpoint), `docs/architecture.md`,
  `docs/security-operations.md` (operator snapshot and authorized counts),
  `TODO.md` (observability sub-item closed), and `LESSIONS.md`.
- **Tests.** New `tests/integration/project-stats.test.ts` (7 tests: empty state,
  ready/pending/expired/per-speaker unread and project scoping, member-without-grant
  `FORBIDDEN`, `failed`-row exclusion, foreign/unknown/unauthenticated non-enumeration
  with uniform 404, no-content plus read-only methods, and fixed route label).
  `tests/integration/metrics.test.ts` adds cumulative bucket-boundary and
  empty-state/replay-exclusion/MCP-recording tests; the idempotent-replay service
  test now asserts the replay omits the timing field, and a concurrent same-key send
  test asserts exactly one response carries the queue sample with exactly one message.
- **Verification.** Squashed tree: `npm ci` exit 0; `npm run check` exit 0 (secret
  scan, history scan, typecheck, 391 tests: 390 pass, 1 skipped live-D1, 0 fail);
  `npm run build` exit 0.
- **Limitations.** The histogram is process-local and resets on restart; a
  finalization performed by another process is not observed. The stats endpoint is a
  current-row snapshot (not time-windowed), counts project rows so its cost grows with
  project size, and is not wired into the dashboard UI. D1 remains unexecuted.

## Vertical slice T — dashboard project create/edit (base `704d115`)

- **Checkpoint.** One squashed checkpoint on `slice-admin`, based on `704d115`. Not
  pushed. Independent review PENDING. The commit trailer records the final `Tree-SHA`;
  both audits passed on the pre-squash combined tree and the P2 doc/test fixes are
  included here.
- **Scope.** Adds four server-rendered routes: `GET /projects/new`, `POST /projects`,
  `GET /projects/:projectId/edit`, and `POST /projects/:projectId`. The forms use the
  existing account-session authentication, the 64 KiB form-body limit, the session
  `corkboard_csrf` cookie plus a hidden field (double submit), the same
  `Sec-Fetch-Site`/`Origin` checks as login, and `303` redirect-after-POST to the
  project timeline. English and Simplified Chinese strings and token-only CSS are
  included. The dashboard links to the create form and the timeline links to the edit
  form for owners. There is still no inline script or style.
- **Create authorization and writes.** Create requires an active session account with
  at least one active owned speaker. The service inserts the project with
  `owner_account_id` set to the session account and inserts an owner membership (all
  seven capabilities) for the deterministic first active owned speaker
  (`created_at ASC, id ASC`, the same ordering as `resolveSessionViewer`). This is what
  makes the project visible and editable. It creates no speaker, credential, or
  credential-to-project grant. An account with no active owned speaker gets the safe
  invalid-request form error and no project is written.
- **Edit/update authorization.** The handler resolves a session viewer for
  `project.edit` before reading the body, then `getProjectForEdit`/`updateProject`
  re-authorize `project.edit` at the service layer. This is the same owner capability
  that guards message expiry. Unknown, foreign, and non-owner-member projects are the
  uniform `404`; the read timeline remains available to an ordinary member.
  `authorizeSessionProject` now permits `project.edit` and additionally requires
  `principal.scopes.has(scope)`, so a viewer resolved for `message.read` cannot use the
  branch to authorize the owner path. It still never authorizes `message.send`,
  `receipt.write`, `member.read`, or `member.manage`.
- **Validation and rendering.** `validateProjectTitle` and `validateProjectSummary`
  reuse the existing summary bounds (1–140 graphemes, ≤1024 UTF-8 bytes); titles are
  required and non-blank, and a blank summary stores `NULL`. Validation lives in the
  service; the route maps `VALIDATION_ERROR` to a safe form error. Invalid or
  duplicate `title`/`summary` fields re-render HTTP `400` with an escaped
  `role="alert"` error summary and the entered values; a duplicate `csrf_token` is
  rejected earlier as the "form expired" page. Internal validation text and SQL are
  never rendered. Project metadata is escaped in the form, dashboard, and timeline.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (secret scan, history scan,
  typecheck, 402 tests: 401 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0.
  New integration tests cover create/edit happy paths, visibility, the dashboard
  create link and the absence of a timeline create link, `?lang=zh` redirect
  preservation, owner membership capabilities and deterministic first-speaker
  selection, no implicit speaker/credential/grant creation, cleared summary,
  CSRF missing/wrong/no-cookie/cross-origin/`Sec-Fetch-Site`/unbound-matching-pair
  failures with no write, unauthenticated redirects, uniform 404 for
  foreign/unknown/non-owner projects (including authorization before body parsing),
  create without an owned speaker, duplicate title/summary/`csrf_token` handling,
  invalid fields with escaped preservation, XSS-safe rendering, oversized bodies,
  and HTML that exposes no session token or credential content while request logs
  carry no content or CSRF value.
- **Limitations.** At this slice there is no speaker creation, credential management,
  grant editor, membership editor, project deletion, or status change in this UI; the
  per-project membership editor was added later by slice Y. Create used two
  sequential inserts at this slice; Issue #8 makes it atomic (see the Issue #8 section
  below). The owner role is the `project.edit` membership capability, not a separate
  role column. An account with no active owned speaker cannot create a project here.
  Cloudflare/D1 parity and a real-browser visual pass for the new forms remain
  unexecuted; visual evidence is a separate step.

## Vertical slice V — Node adapter dashboard form bodies (base `01538a0`)

- **Checkpoint.** This checkpoint on `slice-adapter-final`; not pushed.
  Independent review PENDING.
- **Bug and evidence.** The shipped Node adapter's body predicate omitted the
  dashboard project form routes. `toWebRequest` built a body-less `Request` for
  `POST /projects` and `POST /projects/:projectId`, the handlers read an empty
  form, and the missing `csrf_token` produced `400` "The form expired.". This was
  observed in the real-browser capture documented in GitHub Issue #6 comment
  6653112857. The in-process `createApp` web tests passed because they bypass the
  adapter; this repeats the earlier `POST /login` adapter bug.
- **Fix.** For `POST`, the predicate now buffers when `isWebPath` recognizes the
  path. The web router owns the dashboard route set, so project create/edit and
  any later dashboard form are covered without a second list. `GET`, `HEAD`, and
  `DELETE` remain unbuffered; the 64 KiB cap, declared-length pre-check, and
  streaming overflow behavior are unchanged, and non-web routes keep the existing
  allowlist.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (secret scan, history
  scan, typecheck, 405 tests: 404 pass, 1 skipped live-D1, 0 fail); `npm run build`
  exit 0. The new test starts the real `startServer` and signs in over HTTP, then
  asserts create `303` plus dashboard visibility, edit `303` plus the updated
  timeline, missing/wrong CSRF `400`, chunked and declared oversized bodies `413`
  `REQUEST_TOO_LARGE`, and unauthenticated create/edit `303` to
  `/login?return_to=...`. Reverting the predicate in a throwaway worktree made
  the create assertion fail with `400 !== 303`; the fixed tree passes. A manual
  check (`node dist/src/platforms/node/main.js` on a real socket, not a committed
  test) returned create `303`, edit `303`, dashboard visibility, and the no-CSRF
  `400` form-expired page.
- **Coverage gap closed.** Handler-level tests are not adapter coverage. Form
  routes need at least one test that enters through `startServer` and sends the
  body over a real socket.
- **Limitations.** `isWebPath` also names GET-only dashboard pages; a POST to one
  of those is still rejected by the web router's method check, but its body is now
  buffered up to the cap instead of left unread. No dashboard form posts to those
  paths.

## Issue #8 — atomic project creation (slice W, base `4b1ba53`)

- **Checkpoint.** One squashed commit on `slice-atomic-final`, replaying candidate
  `60b33d3` (tree `a3bb8a5`) onto `4b1ba53`. Not pushed; independent review pending.
  The commit trailer records `Base-SHA`, `Candidate-SHA`, and the final `Tree-SHA`.
- **Design.** The `SqlDatabase` port gains `transaction<T>(fn)`. The callback receives a
  statement-only `SqlTransaction` handle (`all`/`first`/`run`) with no `exec` and no
  nested `transaction`. The SQLite adapter issues `BEGIN IMMEDIATE`, commits only when
  the callback resolves, and rolls back on any throw; the callback cannot issue
  transaction control. Statements are queued on the connection, so a statement from
  another `transaction()` caller waits instead of joining an open transaction; the
  CLI-only manual `exec` transaction in retention is the exception noted in Limits. A
  crash before commit is rolled
  back by SQLite WAL recovery. `createProject` performs the project and owner-membership
  inserts inside one transaction. No speaker, credential, or credential-project grant is
  created implicitly.
- **Failure injection.** `a failed owner-membership insert rolls the project back`
  wraps the second insert to throw and asserts no project and no membership remain. It
  fails on base `01538a0` with one orphan active project (evidence captured; the
  replayed code is identical) and passes on this tree. The shared contract adds commit,
  rollback-on-second-insert, and concurrent-transaction serialization scenarios for
  SQLite; the D1 contract test stays skipped because no adapter exists.
- **Docs.** `web-ui.md`, `api.md`, `architecture.md`, `threat-model.md`, and
  `security-operations.md` drop the non-atomic caveat and describe the transaction
  guarantee, the statement-only handle, and the single-connection serialization.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (secret scan, history scan,
  typecheck, 407 tests: 406 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0.
- **Limits.** D1 has no interactive transaction and no adapter ships here; a future D1
  adapter must buffer the write-only callback and submit it as one `batch()` and pass
  the shared contract. That path is documented but unverified. The in-process queue is
  per connection; cross-process writers rely on SQLite's own locking, and `BEGIN
  IMMEDIATE` can still surface `SQLITE_BUSY` under sustained writer contention after the
  5-second busy timeout (no retry is added for create). The queue guarantee is scoped
  to `transaction()` callers: the CLI-only retention path opens a manual `BEGIN
  IMMEDIATE` through `exec`, so a concurrent `transaction()` on the same connection
  while it is open fails with `cannot start a transaction within a transaction`
  (not reachable in the shipped server). A transaction callback that
  issues statements through the root handle instead of the supplied `tx` would wait
  behind its own transaction; the handle is the only documented and tested usage.

## Vertical slice X — speaker directory and project-scoped credential issuance (base `0f81877`)

- **Checkpoint.** Pre-squash feature `21a5fdf` (tree `c467080`) plus state tail
  `24cebb3` (tree `46f1e62`) were audited as PASS (417 tests). The combined review
  fixes (in-transaction scope re-check, inactive-speaker grants, audit bound, docs)
  are included in the final squashed commit on `slice-speakers` (423 tests; its
  `Tree-SHA` is in the commit trailer), based on `0f81877`. Not pushed.
- **Scope.** Adds `GET /speakers` and `GET`/`POST /speakers/:speakerId/key` to the
  server-rendered dashboard. The directory is account-scoped in SQL
  (`speakers.owner_account_id = <session account>`) and shows each owned speaker's ID,
  display name, status, and active project grants. The form lists active projects and
  the union of their capabilities. POST requires explicit project and scope
  selection; every scope must already be a capability of the speaker's active
  membership in every selected project (the `issue-key` CLI rule). Unknown, foreign,
  inactive, and non-member projects and unknown/insufficient scopes return the HTML
  `400` form error with `role="alert"` and write nothing.
- **Owner and CSRF boundary.** The service resolves the speaker with
  `WHERE id = ? AND owner_account_id = ?` plus active speaker/account checks before
  the body is parsed; foreign, unknown, and inactive speakers are a uniform `404`.
  The POST uses the existing session-cookie double-submit (`corkboard_csrf` + hidden
  `csrf_token`), constant-time digest comparison, and `Sec-Fetch-Site`/`Origin`
  checks. The 64 KiB form cap is unchanged. A committed negative test logs in as
  another account and asserts `404` plus no new credential, so removing the owner
  predicate fails the suite.
- **Issuance.** Reuses `generateSpeakerToken`/`hashSecret`: a fresh 256-bit `cb_`
  token with only a 12-character public prefix and keyed HMAC verifier stored. The
  credential row and one `credential_project_grants` row per selected project are
  written in one `transaction`, and the transaction re-reads every selected membership
  with `removed_at IS NULL` plus active speaker/project/account checks and re-checks
  every requested scope against it before either insert. A membership removed or deactivated after the fast
  pre-check fails the transaction and rolls the whole issuance back. Membership is
  never converted into a grant, so an unselected project is denied even when the
  speaker belongs to it. Selections are capped at 100 projects. `expires_at` is `NULL`
  because this UI has no expiry control. A sanitized `credential.issue` audit event
  records the actor account, speaker, at most 32 project IDs, `project_count` (the
  true selected count), and scope names only; it never records the token, prefix, or
  verifier.
- **One-time display.** The raw token is returned only in the `200` POST body, which
  is `Cache-Control: no-store` with the strict CSP. It is never placed in a redirect,
  URL, cookie, hidden field, session state, database column, or application log. A
  later GET of the directory or form contains no token. Because the token is not kept
  in state, the POST is not redirected; re-submitting it creates a different
  credential rather than recovering the earlier one.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (secret scan, history scan,
  typecheck, 423 tests: 422 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0.
  New integration tests cover the owner directory and happy path, cross-account
  isolation, foreign/unknown/inactive speaker `404` (including authorization before
  body parsing), unauthenticated redirects, CSRF missing/wrong/no-cookie/cross-origin/
  unbound-pair failures, invalid/foreign/non-member project selection, per-project
  scope restrictions, membership removal injected between validation and the write
  (rollback leaves no credential/grant), a capability downgrade injected between
  validation and the transaction (the in-transaction scope re-check rolls it back;
  removing that re-check makes the test fail), a forced grant-insert failure (rollback
  leaves no credential), directory escaping of display names and project titles, duplicate
  project/scope collapse, a 40-project issuance (40 grants; audit `project_count` 40
  with 32 IDs), rejection above 100 projects, inactive-speaker grants not rendered,
  once-only display, no token in logs/subsequent HTML/database, en/zh rendering with
  no script or inline style, and the Node adapter's HTTP form body path through
  `startServer`.
- **Limitations.** No credential listing, rotation, revocation, or grant-editing UI;
  issuance and revocation are CLI commands, rotation is unimplemented, and there is no
  dashboard expiry selection, speaker creation, or membership editor. The directory shows active project grants only, not existing credentials or
  prefixes, and renders no grants for inactive speakers (matching authorization). D1/R2
  parity and a real-browser visual pass are unexecuted.

## Vertical slice Y — project membership editor (base `15cdf62`)

- **Checkpoint.** Slice-Y feature/state commits `48b5a86` and `5ca3067`, plus the
  security-audit fix commit `4110a43` (tree `31d84ac`), finally pushed on
  `origin/main` as `499a772` (tree `fe60450`), based on
  `15cdf62717626a07ccbe52c243f895a60064e298`. The P1 owner gate and P2
  corrections are included. Review is not claimed here.
- **Scope.** Adds `GET /projects/:projectId/members`,
  `POST /projects/:projectId/members`, and
  `POST /projects/:projectId/members/:speakerId/remove` to the server-rendered
  dashboard. The list shows every non-removed membership with speaker ID, display
  name (or ID), capability codes in canonical order, joined date, a remove form, and
  an add form. English and Simplified Chinese render; `?lang=zh` is preserved by form
  actions and the `303` redirects. No client script or inline style is added.
- **Authorization (audit P1 fix).** Membership administration is
  **project-owner-only**, not `project.edit`. The signed-in account must equal
  `projects.owner_account_id`, and the project and account must be active; a
  non-owner member holding `project.edit` is denied. That member could otherwise add
  a speaker with `message.send` and mint a bearer credential for it. Unknown, foreign,
  non-owner, and inactive projects are the uniform `404`, checked before any POST body
  is parsed. The write functions re-read ownership inside the transaction. Both POSTs
  require the session double-submit (`corkboard_csrf` + exactly one hidden
  `csrf_token`), the `Sec-Fetch-Site`/`Origin` checks, and the 64 KiB body cap. The
  Node adapter buffers these bodies through the shared `isWebPath` predicate, and
  adapter-level `startServer` tests cover add, remove, oversize, and unauthenticated
  redirects.
- **Add.** The service requires one `speaker_id` and an explicit, non-empty subset of
  the seven capability identifiers; unknown values reject the request and duplicate
  values collapse in canonical order. The project owner may grant any of the seven,
  including capabilities the owner's own membership does not carry. Only an active
  speaker owned by the signed-in owner account (with an active account) may be added;
  a foreign, unknown, inactive, or other-account speaker is the same HTML `400` form
  error and writes nothing, so the form is not an account/speaker oracle. An active
  duplicate is a `CONFLICT` rendered as `400` without changing capabilities. A
  previously removed membership is reactivated with the submitted capabilities and a
  fresh `joined_at`; no grant is restored. Adding never creates a credential or
  credential grant (asserted in tests).
- **Remove.** The service soft-deletes the membership and deletes every
  `credential_project_grants` row for that speaker and project, mirroring the CLI
  `remove-member`. Re-adding therefore cannot revive an old credential. The exact
  last-owner rule (audit P2 fix): a **manageable** owner membership is a non-removed
  membership whose speaker is owned by `projects.owner_account_id`, where the speaker
  and owning account are active and the capabilities include `project.edit`.
  Removing the last manageable owner membership is refused; inactive owner speakers
  and owner memberships lacking `project.edit` neither count nor are protected.
  Removal may target any active (non-removed) membership, including another
  account's speaker; an already removed row returns `NOT_FOUND`.
  `membership.remove` is always audited; `credential.project.revoke` is audited only
  when a grant was actually deleted.
- **Transactions.** Both writes use one `SqlDatabase.transaction` and re-read project
  ownership and the active account inside it. Remove also re-reads the target
  membership and manageable-owner count inside the transaction. An injected failure
  after the transaction body rolls back both the membership mutation and the grant
  deletion. Two concurrent removals of the last two manageable owner memberships
  serialize to one `303` and one `400`, leaving exactly one.
- **Tests run.** `npm ci` exit 0; `npm run check` exit 0 (see the checkpoint row for
  the exact counts); `npm run build` exit 0. New
  `tests/integration/members-web.test.ts` covers: owner list/add happy path with
  canonical capability storage, no credential/grant rows, and audit; a non-owner
  member with **project.edit** (mutation proof for the owner gate) plus a read-only
  member getting uniform `404` on list/add/remove; foreign/unknown/inactive speaker
  responses identical after normalizing the echoed input; duplicate conflict without
  capability change; unknown/empty/mixed scope, duplicate field, and blank speaker
  rejection; last-owner refusal including inactive/limited owner memberships that do
  not count, and two-manageable-owner removal; active-only ordering; concurrent
  last-owner removal; grant deletion plus reactivation with fresh `joined_at` and
  submitted capabilities, then re-add denial through `FORBIDDEN` (credential cannot
  revive); CSRF missing/wrong/no-cookie/cross-origin/unbound-pair failures;
  oversized `413`; injected post-transaction rollback for add and remove;
  display-name escaping; en/zh actions and redirect; method `405`; the
  `startServer` adapter flow; owner-with-no-membership and owner-with-only-a-limited-
  own-membership service paths (add/remove with no caller-rights cap); and rejection
  of a bearer principal by the ownership check.
- **Limitations.** The dashboard owner may add only their own active speakers;
  cross-account **addition/provisioning** of another account's speakers remains
  CLI-only, while removal may target any active (non-removed) membership and an
  already removed row returns `NOT_FOUND`. Invitation/acceptance, bulk
  editing, and capability presets are not implemented (no CLI command). Credential
  revocation and per-credential grant editing remain CLI-only; rotation is
  unimplemented. The add form
  submits one speaker at a time. The pre-existing CLI `grant-key-project`
  membership-check/insert race is recorded as residual risk in
  `docs/security-operations.md`; it grants no access while the membership is removed
  but can leave a stale grant that revives on reactivation. D1/R2 parity and a
  real-browser visual pass are unexecuted.

## Vertical slice Z — dependency audit, license report, and SBOM (base `499a772`)

- **Checkpoint.** Feature commit `09eb061` (tree `2b7e38e`) plus the audit-fix
  commits, based on `499a772620d2caa3f0eb3f8a224fac9bfef47d10`; final commit
  `f7e62be` (tree `06f664e`), fast-forwarded and pushed on `origin/main`.
- **Audit outcome.** The first independent audits on tree `2b7e38e` returned
  **security BLOCKED** and **contract BLOCKED**; the fixes were re-reviewed at tree
  `3c05987` as **security PASS + contract PASS**. A final residual round then removed
  bare `npm` from the `check`/`audit` chain, rejected absolute/traversal lock keys,
  handled legacy `{type}` license objects, and routed two pre-existing test build
  helpers through `process.execPath` + `npm_execpath`. A contract audit then
  BLOCKED the same shim class via bare `node`/`tsc`: package scripts now start with
  `"${npm_node_execpath:?npm_node_execpath is not set - run via npm}"`, invoke
  `$npm_node_execpath --test`, and run
  `$npm_node_execpath node_modules/typescript/lib/tsc.js`; `npm_node_execpath` is an
  absolute Node path supplied by npm, so `node_modules/.bin/node`/`tsc` cannot
  intercept it. Final audits on tree `06f664e` returned **security PASS + contract
  PASS** with three non-blocking P2s, recorded below.
  - Security P1: `scripts/sbom.ts` executed `npm` resolved through `PATH`, which
    `npm run` prepends with `node_modules/.bin`, so a dependency `npm` shim could
    forge the report. It now runs `process.execPath` + `npm_execpath` and fails
    closed when `npm_execpath` is unset.
  - Security residual: `package.json` `check`/`audit` also called bare `npm`, so a
    shim could make them exit `0` without running. `check` now chains `node`, `tsc`,
    and `node --test` directly; `audit` calls `scripts/npm-audit.ts`, which uses the
    same `process.execPath` + `npm_execpath` pattern. Two pre-existing tests that ran
    `npm run build` now use `npm_execpath` too; a `node_modules/.bin/npm` shim was
    executed before this fix and is not executed after it.
  - Security P2: `scripts/license-report.ts` accepted any lock key beginning with
    `node_modules/`, so `..` or an absolute path could escape the repository. Keys
    with absolute/traversal/empty segments are now rejected with exit `2`, and the
    reader resolves and verifies the file stays under `<root>/node_modules`.
  - Contract: `Tree-SHA` trailer, lockfile-driven/fallback documentation, legacy
    object-form license handling, and CLI exit-code/report-writing tests.
- **Scope.** Adds `npm run licenses` (`scripts/license-report.ts`) and
  `npm run sbom` (`scripts/sbom.ts`), adds the license scan to `npm run check`, and
  documents the policy and limits in `docs/supply-chain.md`. `package-lock.json`
  remains the pinning baseline; CI still installs with `npm ci --ignore-scripts`.
- **Automated now.** The license scan is lockfile-driven: it iterates every
  `node_modules/` entry in `package-lock.json`, prefers the installed package's
  `license`/`licenses` declaration, and falls back to the lock entry when that metadata
  is unreadable or absent. It labels runtime/dev from the lock's `dev`/`devOptional`
  flags, accepts simple SPDX `AND`/`OR` expressions composed only of `0BSD`,
  `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`, `ISC`,
  `MIT`, and `Unlicense`, handles legacy `{"type": "..."}` objects and `licenses`
  arrays, and exits `1` on `notice`/`missing`/`unknown` entries (exit `2` for an
  unreadable/unsafe lockfile). It writes stable
  `reports/licenses.txt` and `reports/licenses.json`; `reports/` is git-ignored. The
  SBOM invokes the installed npm CLI explicitly (never through `PATH`), runs npm's
  built-in CycloneDX generator after install, writes `reports/sbom.cdx.json`, and
  works offline from the installed tree and lockfile. No package script resolves
  `node`, `tsc`, or `npm` through `PATH`: every script uses `$npm_node_execpath` with
  a fail-closed `${npm_node_execpath:?...}` guard, and the audit wrapper propagates
  npm's exit status and fails closed without `npm_execpath`. CI runs the license scan
  and SBOM, uploads `reports/`, and keeps `npm run audit` (`--audit-level=high`) as a
  separate network-dependent step.
- **Counts at this tree.** 98 lockfile dependency entries (95 runtime, 3 dev),
  0 flagged; report sizes 4,284 bytes (text) and 18,711 bytes (JSON); SBOM 95
  components (unique `name@version`; three repeated install paths collapse),
  107,828 bytes, root `corkboard@0.0.0`. Repeated runs produce identical license
  files; the SBOM differs only in its CycloneDX `serialNumber` and
  `metadata.timestamp`.
- **Documented, not automated.** The vulnerability audit depends on the npm registry
  advisory database and is not part of the offline `npm run check`. The license report
  trusts declared metadata (installed or lock fallback) and does not produce a NOTICE
  file or scan license texts. The SBOM has no signature, provenance attestation, or
  vulnerability data and follows npm's selector/deduplication. There is no update bot
  and no reproducible-build proof at this slice-Z tree; the later
  `scripts/reproducible-build.ts` proof is scoped in `docs/supply-chain.md`. The
  `$npm_node_execpath` guard closes PATH
  shadowing by dependency `node`/`tsc`/`npm` bins but still trusts the npm installation
  and the Node binary npm was started with, plus a POSIX `sh`.
- **Recorded P2 debt.** The scripts now require a POSIX `sh` (disclosed in
  `docs/supply-chain.md`); `scripts/secret-scan.ts` and
  `scripts/history-secret-scan.ts` still resolve `git` through `PATH`, so a
  dependency-declared `git` bin could shadow it under `npm run`; and the committed
  shim test's `tsc` assertion is static (its command never invokes `tsc`), so `tsc`
  non-execution rests on the static script check.
- **Tests run.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (455 tests:
  454 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run licenses`
  exit 0; `npm run sbom` exit 0; `npm run audit` exit 0 (0 vulnerabilities).
  `tests/supply-chain/license-report.test.ts` covers classification, expression
  parsing, legacy object-form declarations, unusable-declaration lock fallback,
  missing/notice/unknown flagging, dev labeling, ordering, unreadable metadata, and
  traversal/absolute lock-path rejection. `license-report-cli.test.ts` exercises
  `main()` exit `0`/`1`/`2` and report writing in a temp repository.
  `sbom.test.ts`, `npm-audit.test.ts`, and `npm-node-shim.test.ts` prove fake
  `npm`/`node`/`tsc` bins in `node_modules/.bin` are not executed, root-name
  normalization, status propagation, and fail-closed behavior without
  `npm_execpath`/`npm_node_execpath`. A static test asserts every package script uses
  `npm_node_execpath` and contains no bare `node`, `tsc`, or `npm`. An executable repo
  `node_modules/.bin/{node,tsc}` shim pair during `npm run check` left no markers and
  the check passed (exit 0).

## Vertical slice AA — dashboard credential inventory and revocation (base `1dfa284`)

- **Scope.** Adds `GET /speakers/:speakerId/credentials` and
  `POST /speakers/:speakerId/credentials/:credentialId/revoke` to the
  server-rendered dashboard, plus a per-speaker inventory link in `/speakers`. The
  inventory renders only non-secret metadata: credential ID, created time, expiry
  (or "No expiry"), derived active/expired/revoked/unknown state (revocation wins
  over expiry; an unparseable stored expiry is "Unknown", never "Active"), and
  project grants (title and ID). The speaker, credential, and grant reads are three
  independent parameterized SELECTs, each repeating the owner/active-account
  predicate; there is no read-snapshot claim, and an ownership transfer between
  reads can only make a later read return empty, never add foreign rows. It never
  selects or renders the token, public prefix, verifier, or `scope_json`. Dashboard,
  CLI, and OAuth-issued credentials are all ordinary `credentials` rows and all
  appear; revoking an OAuth access credential also blocks refresh because the
  refresh path re-reads `revoked_at` (refresh rows are not deleted here).
- **Authority.** Account-owner-only, like the speaker directory and membership
  editor: `speakers.owner_account_id` must equal the session account, and the owning
  account must be active. A foreign or unknown speaker is the uniform `404`; an
  unauthenticated request is redirected to `/login`; the service rejects any
  non-session principal, so a bearer credential cannot list or revoke. The speaker
  status is not required to be active (inactive speakers are already listed; their
  credentials are already denied by authorization). The POST resolves the owned
  speaker and inventory before parsing the body and re-reads ownership and the active
  account inside the write transaction, so a transfer after the route check aborts
  without a revocation.
- **Revocation semantics.** `revokeOwnedSpeakerCredential` sets
  `credentials.revoked_at` once with `... WHERE id = ? AND speaker_id = ?
  AND revoked_at IS NULL`, inside one `SqlDatabase.transaction`; grants and the
  credential row are retained, matching CLI `revoke-key`. The credential must belong
  to the path speaker: a credential ID from another speaker (owned or foreign) or an
  unknown ID is the same `NOT_FOUND` and changes nothing. A repeat call is an
  idempotent no-op (same `303`, unchanged timestamp, no duplicate audit row). A
  successful transition writes one sanitized `credential.revoke` event with the actor
  account, speaker, and non-secret credential ID. The route uses the session
  double-submit (`corkboard_csrf` plus one hidden `csrf_token`), the
  `Sec-Fetch-Site`/`Origin` checks, and the 64 KiB cap; CSRF failure re-renders the
  inventory with `400` and writes nothing. The Node adapter buffers the new POST
  through `isWebPath`.
- **Rotation at this slice.** This is revocation, not an atomic rotate. The dashboard
  replacement path is the existing issuance flow (`POST /speakers/:speakerId/key`),
  which creates a new credential and grants. (Atomic CLI `rotate-key` is implemented
  in slice AG; the dashboard still has no rotation view.) Per-credential grant
  editing and expiry selection remain CLI-only. Documented in `web-ui.md` and
  `security-operations.md`.
- **Tests.** `tests/integration/speakers-web.test.ts` adds: inventory metadata,
  no token/prefix/verifier rendering, directory link, soft revoke retaining grants
  and row, sanitized audit, token invalidation, idempotent repeat, owner-only and
  cross-speaker uniform `404` with no state change, CSRF missing/wrong/duplicate/
  cookie-less/cross-origin, revoke POST over 64 KiB (`413`) and wrong
  `Content-Type` (`400`) with no write, `405` on the new paths, unknown-speaker
  `GET` (`404`), inactive owning account (service `NOT_FOUND`, no write; the HTTP
  session redirect is the existing inactive-account behavior), inactive owned
  speaker (manageable), foreign speaker with malformed and oversized bodies (`404`
  before body semantics), an unparseable expiry rendered "Unknown", bearer service
  rejection and cookie-less HTTP redirect,
  in-transaction ownership re-check rollback, ownership transfer injected between
  the speaker and credential SELECTs (zero credential rows) and between the
  credential and grant SELECTs (credentials without grants, never foreign rows),
  revoked-session redirects, en/zh
  rendering, and an adapter-level `startServer` POST-body test. Service functions are
  covered directly where the HTTP layer cannot supply a bearer principal.
- **Limitations.** Inventory is Node/SQLite-only and unbounded per speaker (no
  pagination); rotation/overlap, grant editing, expiry selection, bulk revocation,
  and automatic cleanup remain absent. D1/R2 parity and a real-browser pass are
  unexecuted. Independent security and contract review is PENDING.

## Vertical slice AC — dashboard message send (base `30cf884`, pushed at `2a17a75`)

- **Scope.** `GET`/`POST /projects/:projectId/messages/new` as a server-rendered,
  no-JavaScript compose form and send path for a signed-in account. The form fields
  are the sender speaker, summary, body text, type, language, an optional same-project
  reply-to message ID, and an optional body-expiry timestamp. The timeline links to
  the form only when the account owns at least one eligible sender. No message-expiry
  listing/management/cleanup UI, receipts, dashboard credential rotation, or admin
  action is added.
- **Sender policy.** A session may send only as a speaker where
  `speakers.owner_account_id` is the session account, the account/speaker/project are
  active, the membership is non-removed, and its parsed capabilities include
  `message.send`. The stored sender is the selected speaker. This uses a dedicated
  `authorizeSessionSend`/`authorizeMessageSend` path, not `authorizeProject`'s
  session branch (which continues to permit only `project.read`, `message.read`, and
  `project.edit`). Bearer principals keep the existing credential/grant decision and
  cannot enter the session path. Foreign speakers, inactive speakers/accounts,
  removed memberships, and speakers lacking `message.send` are the uniform `404`,
  as is an unreadable/unknown project.
- **Send reuse.** The route calls the existing `sendMessage`: server-computed
  plaintext SHA-256, existing validation limits, idempotency, blob write, provisional
  row, and atomic finalization. A per-render hidden `idempotency_key` repeats on a
  validation retry; same payload replays with no duplicate and different payload is
  `409` with a fresh key on the re-render. The route resolves the readable project
  before parsing the body and applies the standard session double-submit CSRF,
  `Sec-Fetch-Site`/`Origin`, `application/x-www-form-urlencoded`, and 64 KiB body
  limits. The Node adapter buffers the new POST because `isWebPath` names it.
- **Mid-request re-check.** For a session send, the publication callback is
  **write-only and result-independent**: `finalizeSessionMessage` issues one
  conditional `UPDATE` whose `EXISTS` clause carries the whole session predicate
  (account-owned active speaker, active account/speaker/project, non-removed
  membership, stored `message.send`), performs no SELECT, and its affected-row count
  is never observed (a buffered D1 batch cannot return it). Both finalize statements
  (bearer and session) also bind `sender_speaker_id = ?` to the authenticated
  principal, so neither can publish a pending row belonging to another speaker. The outcome is inferred
  only by reloading after commit: an already-committed `ready`/`expired` row is
  success or the existing replay/resume case; a still-pending or missing row is the
  uniform `NOT_FOUND` with no committed message/audit state (the provisional row and
  blob remain reclaimable). `instr(capabilities, '"message.send"')` is the quoted
  stored-JSON test, equivalent to the strict parser for application-written arrays;
  the strict entry check remains the gate for malformed/non-array JSON. Bearer sends
  keep the existing pre-statement re-authorization. Only project creation and the
  session publication are write-only, result-independent `transaction()` callers;
  credential issuance, credential rotation, credential revocation, membership
  add/remove, and credential grant add/remove are read-then-write and remain D1 debt.
  Rotation reads the source credential row and grants, then inserts the replacement,
  copies the grants, and revokes the old row. The publication retry backoff sleeps while the transaction is open,
  which would hold a write lock across retries on a multi-connection adapter.
- **Success/failure.** Success is a `303` to `/projects/:projectId` (preserving
  `?lang=zh`) and the message is visible in ascending `seq`. Validation failures
  re-render `400` with the same key and escaped values; conflicts re-render `409` with
  a fresh key. CSRF/content-type/size/validation failures perform no
  message/idempotency/blob/audit writes; the shared authenticated-page
  `sessions.last_seen_at` refresh still applies.
  Summaries and bodies never enter request logs or audit detail.
- **Tests.** New `tests/integration/message-send-web.test.ts` (15 tests) covers the
  eligible-sender list and en/zh labels, uniform 404 for unreadable/unknown/inactive
  projects and foreign/inactive/removed/no-`message.send` speakers, an inactive
  session account through `authorizeSessionSend`, success ordering/visibility and
  body reveal, membership removal between provisional write and publication,
  a concurrent publication replayed with no duplicate
  (`a concurrent publication is a successful replay with no duplicate`), an atomic
  project deactivation with no committed row
  (`deactivating the project during a session send prevents publication`), a
  tampered idempotency record pointing at another speaker's pending row, a
  matching-speaker publish, accepted/stored positive body expiry and same-project
  reply, duplicate form fields,
  a missing session, a missing CSRF cookie, a wrong CSRF value, and cross-site fetch
  metadata, wrong content type,
  oversized body, invalid summary/text/type/language/expiry and cross-project reply,
  idempotent replay and same-key conflict, escaped XSS-shaped summary/text, bearer
  rejection and dedicated branch refusal, log/audit secrecy, and the real Node
  adapter flow.
- **Commands.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (496 tests:
  495 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0.

## Slice AD — blank message summary and text rejection (base `b26b2fa`, pushed at `7812505`)

- **Finding.** Real-browser evidence at `2a17a75` (Issue #6) showed that a summary
  and body consisting only of spaces was accepted and committed. The shared
  validators counted graphemes and UTF-8 bytes, so whitespace-only values passed on
  every surface (`validateProjectTitle` already rejected blank titles separately).
- **Rule.** Message summary and text are validated by message-only
  `validateMessageSummary`/`validateMessageText` wrappers. They call the length-only
  `validateSummary`/`validateText` (restored to their base behavior) and then reject
  a blank value with `VALIDATION_ERROR` and the messages "summary must not be blank"
  and "text must not be blank". Blank means only Unicode `White_Space` and/or
  `Default_Ignorable_Code_Point` characters; this covers ordinary whitespace plus
  NBSP, NEL, ideographic space, ZWSP, ZWJ/ZWNJ, word joiner, variation selectors, and
  BOM. Any character outside those categories makes the value non-blank (U+2800,
  non-whitespace controls, and a lone combining mark are accepted). The check is in addition to, and
  after, the existing grapheme and byte checks, so the existing limit errors keep
  their order. Non-blank content, including internal spaces and newlines, remains
  valid and is returned unchanged; values are rejected, not trimmed or normalized.
  Because REST, MCP, and the dashboard form all reach `sendMessage`, the message rule
  applies uniformly, with no surface-specific copy or limit change. Project
  title/summary keep their base behavior: `validateSummary` stays length-only,
  `validateProjectTitle` rejects only `trim()`-blank values with the title field, and
  `validateProjectSummary` stores a `trim()`-blank summary as `NULL`; length-valid
  metadata such as ZWSP-only is preserved. The service validates before its
  replay/resume decision, so a message committed with blank content before this rule
  existed cannot be replayed with its old key (400); the same-key replay guarantee
  applies only to payloads valid under current validation.
- **Tests.** Domain unit tests cover spaces/tabs/newlines-only message summary and
  text plus NBSP, U+3000, U+FEFF, NEL U+0085, ZWSP U+200B, and an
  all-default-ignorable string; assert the 141-grapheme and 2001-grapheme errors take
  precedence, and that a U+E0100 selector run (one grapheme, 8196 bytes) reports the
  UTF-8 byte cap; and assert a lone combining mark and U+2800 are accepted. A
  project-metadata test pins the base behavior for ZWSP-only title/summary,
  `trim()`-blank title, and `trim()`-blank summary. REST, MCP, and dashboard POST
  tests reject blank message summary and text (including a Unicode blank case); the
  REST, MCP, and dashboard tests capture message/idempotency/blob/audit counts before
  and assert they are unchanged, and the dashboard re-renders escaped. REST, MCP, and
  dashboard acceptance tests send `a b` and multi-line content.
- **Commands.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (502 tests:
  501 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0. Audit round 1 PASSed
  on the first candidate `de225e9` (tree `964cf6c`); the contract audit then BLOCKed
  `66a55fd` on the project-metadata scope leak (security PASS). The final tree
  `d0fb133` (commit `7812505`) restores base project validators, adds the message-only
  wrappers, and passed security + contract audits (delta); pushed on `origin/main`.
  Issue #6 fix comment posted.

## Slice AE — bounded local load/soak harness (base `a530693`)

- **Capability.** `scripts/soak.ts` and `npm run soak` run the shipped Node/SQLite adapter
  (`startServer`) on `127.0.0.1` with `PORT=0` and a `mkdtemp` installation outside the
  repository. Synthetic accounts/speakers/projects/memberships/credentials/grants are
  provisioned directly in the temp database; all measured behavior goes through real
  HTTP. `quick` is the default profile; `full` is larger but still bounded. The four
  count flags override the profile counts in the merged plan used by every scenario and
  reported as `config`; profile-only sizing (speakers, prune backlog, samples, guards)
  stays profile-defined. `--rate-limit-requests` has a minimum of 6 because the fixed
  burst of 5 must expose both a `200` and a `429`. The harness is deliberately not part
  of `npm run check`.
- **Scenarios and assertions.** Many small messages (200/1000) with bounded concurrency
  and same-key replay; 4/8 concurrent speakers exchanging replies; 8192-byte UTF-8 text
  accepted and 8193 rejected; summary-only search plus `after_seq` cursor pages while
  the speaker phase runs; no/invalid/revoked/missing-grant/non-member attempts (401/
  403/404) with no revoked write; future-expiry messages expired by the real
  `expireDueBodies` service with an injected clock (blobs deleted, bodies `410
  BODY_EXPIRED`, metadata retained), then a real `expire-bodies` CLI rerun and a real
  `prune --grace-hours 0` over a backdated revoked-session backlog; and a second server
  with 30/minute burst 5 producing documented `429 RATE_LIMITED` responses with
  `Retry-After`. Every created message is checked in ascending unique `seq`; any
  `INTEGRITY_*`, unexpected 5xx, network/timeout error, duplicate, ordering failure, or
  authorization mismatch exits non-zero.
- **Report.** One JSON object on stdout (`format`, profile, base SHA/dirty, resolved
  config, per-scenario statuses/error codes/latency p50/p95/max/details, correctness,
  non-fatal thresholds, totals) and a short human summary on stderr. Percentiles use
  nearest rank. Coarse p95 guards are documented as environment-dependent; a breach is
  recorded but does not fail correctness.
- **Safety.** Temp directory outside the repo removed on exit; harness-owned
  `SIGINT`/`SIGTERM` handlers remove it and exit `130`/`143`, so the server library's
  process-wide handlers cannot overwrite a failure code. Synthetic content only; freshly
  generated throwaway root key/pepper passed only to the in-process server; no bodies,
  summaries, tokens, headers, or full IPs in the report; responses are streamed against
  the 16 MiB cap instead of buffered whole; `--base-sha` is hex-validated before it is
  echoed; loopback only. The server's stdout request log is silenced so it cannot
  corrupt the JSON. Known debt: `git` is PATH-resolved for base/dirty metadata; a
  host without `git` on PATH reports `base_sha: unknown` and, fail-open, `dirty:
  false`; an unrecognized argument echoes raw argv (operator-controlled input) without
  the control-character scrub used on other failures; the added unit test exercises
  `effectivePlan` but not the `runSoak` call site, so reverting the wiring would not fail
  it; `revoked_writes` is reported as a literal `0` while the assertion counts only
  seq-visible messages, so a provisional (`seq IS NULL`) orphan would be missed; a
  `--base-sha` override is not marked in the report.
- **Evidence.** Two independent audits on tree `a6a121f`: security PASS and contract
  PASS (five non-blocking P2s recorded as debt above).
- **Evidence.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (509 tests: 508
  pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run soak -- --profile
  quick` exit 0: 319 requests, 261 messages, 0 integrity failures, 0 unexpected 5xx, 0
  network errors, 0 replay duplicates, 7 expected 429s, 25 sessions pruned, messages
  unchanged. Exact per-scenario numbers and interpretation caveats are in
  [`docs/soak.md`](docs/soak.md).
- **Not covered.** Attachments/10 MiB and slow uploads (text-only JSON API), quotas,
  long-duration memory soak, D1/Workers/R2, TLS/reverse proxy, OAuth/MCP/dashboard
  load, and multi-process aggregation. Attachments are not faked.

## Load/soak test coverage — many small messages, slow uploads, 10 MiB boundaries, metadata search, concurrent speakers, quota abuse and cleanup backlog (branch `soak-coverage`, base `f1bf4f6`)

Status: implemented on `soak-coverage`; independent review and exact-revision audit
pending. Extends the existing `scripts/soak.ts` harness (no parallel tool) and keeps
the default `quick` profile bounded to fixed request counts.

- **Many small messages.** Bounded-concurrency sends; every project's `seq` is checked
  for contiguous allocation (no gap/duplicate), and the project is paginated with two
  different page sizes that must return the created set in the same order. Same-key
  replay still returns the same message without a duplicate row.
- **Slow uploads.** A raw `node:http` chunked request writes one chunk per delay. The
  accepted 8192-byte text body is `201`, and its body `GET` must return the exact text
  and digest; an 8193-byte text body streams fully and ends in a deterministic `400
  VALIDATION_ERROR` with no write; exactly 64 KiB of valid JSON streamed slowly is
  `201`. There is no application upload deadline; the harness's 15 s client timeout is
  the only bound, and proxy slow-client limits remain a documented proxy concern.
- **10 MiB boundaries.** Structurally inapplicable: attachments are blocked by Issue
  #5 and there is no upload route. The harness probes the real boundaries instead —
  64 KiB/64 KiB + 1 request bodies (`201`/`413 REQUEST_TOO_LARGE`), 8192/8193 text
  bytes, 140/141 summary graphemes, 1024/1032 summary bytes — and records
  `ten_mib_applicable: false` with the reason (64 KiB app cap; documented 1 MiB proxy
  cap). No endpoint was invented and no 10 MiB payload is sent.
- **Metadata search.** Four bounded `q=` searches run while the concurrent-speaker
  phase is in flight: a token, literal `%`, literal `_` (LIKE wildcards are escaped)
  and a no-hit empty result; exact id sets are asserted, as is the 100/101-character
  validation bound.
- **Concurrent speakers.** Parallel sends from multiple credentials; the shared
  project `seq` is contiguous, replies retain their references, and a speaker granted
  only that project gets `404 NOT_FOUND` for another project's list and body.
- **Quota abuse.** Sustained over-limit traffic on a 1/minute burst-5 server must be
  bounded `429 RATE_LIMITED` with an integer `Retry-After` in 1–120. The limited
  count is bounded by burst plus `floor(measured_elapsed_ms × per_minute / 60000)`
  refill, so a slow-but-correct host is not failed by an assumed request speed. One
  over-limit request is a real `POST /messages` with its idempotency key. Its `429`
  expectation is asserted only when the measured total window (burst elapsed + gap
  before the POST + the POST's own duration) is shorter than one refill interval. If
  that window could refill a token, only a `201` is tolerated as a legitimate write
  and the probe is reported as `over_limit_post_skipped`; any other non-`429` status
  still fails. When it returns `429`, the message and `body_objects` row counts must
  be unchanged. The limited-count bound uses the full window only when the POST was
  sent; when it was skipped pre-send, the post-gap/post-duration do not count. A second
  credential still gets `200` and exactly one send with the next `seq`. This reuses the
  documented process-local limiter; there is no storage quota in the service.
- **Cleanup backlog.** The backlog is built through supported calls: future-expiry
  messages via `POST /messages`, then real sign-in/sign-out through
  `POST`/`DELETE /api/v1/session` for one revoked session per synthetic account. The
  expiry backlog is drained by the real `expireDueBodies` service with an injected
  clock; the documented `expire-bodies` CLI is then re-run (zero failures, no pending
  expiry rows), `prune --grace-hours 0` runs twice, and `doctor --json` runs.
  Assertions: second prune deletes `0`, no sessions remain, doctor reports
  `integrity: ok`, complete schema, `0` missing/orphaned/expired-pending blobs, `0`
  stuck provisional rows and no issues, and message counts/contiguous sequences are
  unchanged.
- **Report and profiles.** `quick` (200 messages, 4 speakers, 20 expiries, 12
  rate-limit requests, 25 sessions, 8×25 ms slow upload) completed in 10.6 s on the
  rebased candidate before the final amend, with 401 requests, 267 messages, 0 integrity/5xx/network
  failures and 0 duplicates. `full` (1000 messages, 8 speakers, 100 expiries, 40
  rate-limit requests, 50 sessions, 64×50 ms slow upload) completed in 28.6 s with
  1659 requests and 1307 messages, also passing. Percentiles are reported, not
  asserted beyond the existing coarse environment-dependent guards. Unit tests cover
  the new boundary text, padded-JSON byte counting, contiguity math, profile
  selection and bounded concurrency/failure propagation (the in-flight cap test
  asserts that concurrency was actually exercised).
- **Evidence.** `npm run check` exit 0 (696 tests: 695 pass, 1 skipped live-D1, 0
  fail; secret/history/license scans green); `npm run build` exit 0; `npm run soak --
  --profile quick` exit 0; `npm run soak -- --profile full` exit 0. Exact per-scenario
  numbers are in [`docs/soak.md`](docs/soak.md). No audit PASS is recorded here.
- **Not covered.** D1/Workers/R2, TLS/reverse proxy execution (including 1 MiB body
  cap and slow-client timeouts), OAuth/MCP/dashboard/browser load, a per-project
  storage quota (none exists), multi-process limiter aggregation, and long-duration
  memory/heap soak.

## Docker Compose local installation (TODO 368 local half, 2026-11-05)

- **Deliverables.** `Dockerfile` is a two-stage build on the official
  `node:24-bookworm-slim` image pinned by digest
  (`sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`,
  Node 24.22.2 / npm 11.19.1 / Debian bookworm).
  The build stage installs with `npm ci --ignore-scripts` and runs `npm run build`;
  the runtime stage installs with `npm ci --omit=dev --ignore-scripts` and contains
  only `dist` (including `dist/migrations`), production `node_modules`, package
  metadata, and the entrypoint. It runs as fixed non-root `1000:1000`, creates `/data`
  `0700` (an empty named volume inherits that ownership and mode on first use), exposes
  `8787`, checks `GET /healthz`, and uses `STOPSIGNAL SIGTERM`. No secrets or
  repository data are copied. `.dockerignore` excludes git metadata, dependencies,
  build output, reports, tests/docs, local data, secret patterns, and local
  registry/package-manager auth config (`.npmrc`, `.netrc`, `.yarnrc*`, `.yarn`,
  `.pnpm-store`, `auth.json`, `.config`). Both stages pin the base digest.
- **Compose.** `compose.yaml` defines one `corkboard` service with the named
  `corkboard-data` volume at `/data`, a read-only bind of the operator's
  `CORKBOARD_SECRETS_DIR` at `/run/secrets`, loopback-only publication of `8787`,
  `restart: unless-stopped`, the same healthcheck, and only non-secret environment
  values. The service also runs with `read_only: true`, `cap_drop: [ALL]`,
  `no-new-privileges:true`, and a bounded `/tmp` tmpfs, so only `/data` and `/tmp` are
  writable. `scripts/docker-entrypoint.sh` tolerates an absent
  `/run/secrets/corkboard.env` so `init` can create it; when present it must be a
  readable regular file, not a symlink (including a broken symlink), with mode
  exactly `0600`, and any other mode or symlink fails closed with an error naming
  the path and mode but never file contents. It then execs the
  requested command, so provisioning commands receive the keys and
  `CORKBOARD_DATA_DIR` without `env_file` or secrets in `Config.Env`; `serve` still
  fails closed when required keys are missing.
- **Init and bootstrap.** The one-shot `init` uses the service plus a second
  read-write mount of the same host directory:
  `docker compose run --rm -v "$CORKBOARD_SECRETS_DIR:/run/secrets-rw" corkboard node
  dist/scripts/corkboard.js init --data-dir /data --secrets-file
  /run/secrets-rw/corkboard.env`. It creates the `0600` secrets file and a second run
  refuses (exit `1`, file unchanged). There is no admin-user command: the first
  account is `bootstrap-owner`, and owner authority comes from account ownership and
  `add-member --owner`. `docs/docker.md` documents the full flow.
- **Docs.** New `docs/docker.md` covers quickstart, init, first-owner bootstrap,
  non-root volume ownership, secret handling, health, persistence/restart proof,
  backup/restore, ports/TLS, process-local limits, upgrade/rollback, and the explicit
  Workers/D1/R2 gap. `docs/deployments.md`, `docs/runbook.md`, and `README.md` link to
  it.
- **Provenance correction (2026-11-05 follow-up).** Earlier state, docs, lessons,
  and commit trailers claimed the real `node:24` base had never been pulled and that
  every output came from a locally assembled stand-in. That was false.
  `docker image inspect node:24@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`
  shows the official image (Node 24.22.2, npm 11.19.1,
  Debian bookworm, digest
  `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`);
  pulling `node:24@sha256:01d5...` resolved to the same image, and the retained
  build layers from the 20:18-20:19 run are layers of that image. Registry timeouts
  were real but recovered; the provenance was recorded wrongly and is corrected
  here. The durable lesson is that provenance claims must be re-checked while
  registry access is intermittent.
- **Pinned rebuild (2026-11-05 follow-up).** Both Dockerfile stages now use
  `node:24@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`.
  Verification of that base: `docker pull` by exact digest reported "Image is up to
  date"; `node -v` = `v24.22.2`, `npm -v` = `11.19.1`, `/etc/debian_version` =
  `12.15`. A fresh default BuildKit `docker compose build` succeeded and produced
  image
  `sha256:bf75542fa9692170726ea7ebb8f95a8d3ecbbac6853f375a247483de1234e68b`; the
  image's first 5 layers are exactly the pinned base's 5 layers (prefix match),
  confirming the real base was used.
- **Secrets-boundary negative tests (2026-11-05 follow-up).** `tests/unit/docker-entrypoint.test.ts`
  runs the real entrypoint logic (only its fixed `/run/secrets` path is redirected
  to a temp directory outside the repository) under `npm run check` on Linux. It
  covers: absent file accepted (needed for `init`), `0600` regular file accepted
  without printing contents, `0644` rejected with the path and mode but no contents,
  directory rejected, symlink and broken symlink rejected, and an unreadable
  regular file rejected (skipped when the test process has UID 0). The entrypoint
  now checks `[ -L ]` before `[ -e ]`, so a broken symlink cannot be mistaken for
  an absent file. In a scratch copy outside the repository, removing the mode check
  makes the `0644` test fail (6 pass, 1 fail), confirming the test guards the
  boundary.
- **Evidence (fresh, pinned real base).** `npm ci --ignore-scripts` exit 0;
  `npm run check` exit 0 (516 tests: 515 pass, 1 skipped live-D1, 0 fail);
  `npm run build` exit 0; `CORKBOARD_SECRETS_DIR=... docker compose config` exit 0
  (shows `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges:true`, `/tmp`
  tmpfs, `user: 1000:1000`, loopback `127.0.0.1:8787:8787`, and the read-only
  secrets bind); `docker compose build` exit 0 (image
  `sha256:bf75542fa9692170726ea7ebb8f95a8d3ecbbac6853f375a247483de1234e68b`); first
  `init` exit 0 and printed only the secrets path (host file `0600 1000:1000`); the
  second `init` exit 1 with unchanged secrets (same SHA-256); entrypoint mode `0644`
  rejected exit 1 with
  `docker-entrypoint: /run/secrets/corkboard.env mode must be exactly 600 (found 644)`,
  `0600` accepted exit 0, an absent file accepted exit 0, and `serve` without keys
  exited 1 with `CORKBOARD_ROOT_KEY is not set`; `up -d --wait` reached healthy and
  `/healthz` returned `{"status":"ok"}`; `id` =
  `uid=1000(node) gid=1000(node) groups=1000(node)`; `/data` `700`, DB `600`,
  `/data/blobs` `700`; inspect showed `ReadonlyRootfs=true`, `CapDrop=["ALL"]`,
  `SecurityOpt=["no-new-privileges:true"]`, `Privileged=false`; the secrets bind was
  `RW=false` and writes to it and `/app` failed `Read-only file system` while `/tmp`
  was writable; secret key names were absent from `docker compose config`,
  `docker inspect`, and the image config; a bootstrapped owner (`acct_...`) and
  project (`proj_...`) both returned `{ n: 1 }` after restart; `docker compose down
  -v` removed the stack with 0 containers, volumes, and networks left; temporary
  directories and `corkboard:local` were removed. The local pinned base image was
  left in place.
- **Pushed and reviewed.** Security PASS + contract PASS on tree `4f7fffc`; three
  earlier rounds were blocked (the unpinned/unverified base with missing container
  hardening; a false provenance caveat; and a secret-scan false positive that made
  the recorded `npm run check` exit 0 untrue), and the final tree passed the full
  gate with the secret and history scans green. Pushed on `main` as
  `6a50a71`; CI run 42172499324 success. Remaining non-blocking P2 debt: the `0600`
  unit test asserts acceptance, not that the file was actually sourced; only `0644`
  exercises the mode check (an unreadable `0000` file is rejected earlier);
  `docker compose config` cannot enforce that the secrets path is absolute or
  outside the repository (documented discipline); the
  non-UID-1000 quickstart requires `sudo`, which is not listed as a prerequisite.
- **Claim scope.** The deliverable is a **local Docker Compose installation** with a
  digest-pinned base, not a claim of a production/staging deployment or CI coverage.
  TODO item 368 stays unchecked because the Cloudflare Worker/D1/R2 half is absent.
- **Not implemented.** The Cloudflare Worker/D1/R2 deployment half has no adapter and
  was not attempted; TODO item 368 remains unchecked. Docker steps are not in CI.

## Slice AF — dashboard credential project-grant editing (base `317ffa0`)

- **Surface.** `GET /speakers/:speakerId/credentials` now extends the account-owned
  inventory with each credential's stored project grants, an add-grant form listing
  only the speaker's active projects that the account can read, and a remove form per
  existing grant. Forms are rendered only for an **active credential of an active
  speaker**; revoked, expired, unparseable-expiry, and inactive-speaker credentials
  are read-only (no add/remove forms) and the service rejects grant edits on them
  with the uniform `404`, so a crafted POST cannot bypass the UI.
- **Routes.** `POST /speakers/:speakerId/credentials/:credentialId/grants` (one
  `project_id`) and `POST /speakers/:speakerId/credentials/:credentialId/grants/remove`.
  Both are session-only (the dashboard never reads `Authorization`; the service
  rejects non-session principals with `FORBIDDEN`), use the session double-submit
  `corkboard_csrf` plus exactly one hidden `csrf_token` and the
  `Sec-Fetch-Site`/`Origin` checks, accept only
  `application/x-www-form-urlencoded`, and enforce the 64 KiB cap. The Node adapter
  buffers these paths through `isWebPath` (HTTP test included). Success redirects
  `303` to the inventory preserving `?lang=zh`, with a non-sensitive
  `?grant=added|exists|removed` status marker.
- **Authorization.** The account must own the speaker and be active; the credential
  must belong to that speaker and be unrevoked/unexpired; adding also requires the
  speaker's active membership under the CLI `activeMembershipCapabilities` predicate
  and account `project.read` access (at least one active owned speaker with
  `project.read` in the project). Ownership, credential state, membership, and read
  access are re-read inside one `SqlDatabase.transaction`. Every ineligible target
  (unknown/foreign/non-member/unreadable/inactive project, foreign speaker, foreign
  credential) is the same `404` page. Adding an existing grant is idempotent and
  writes no duplicate audit; removing a missing grant returns the same `303` with no
  audit and no existence signal.
- **Audit and secrets.** A real add/remove writes one sanitized
  `credential.project.grant`/`credential.project.revoke` row with actor account,
  actor speaker, project ID, non-secret credential ID, and source; no token, prefix,
  verifier, scope content, or body is selected or rendered. The inventory still
  selects only non-secret credential columns.
- **Limits and debt.** Dashboard credential rotation and message-expiry management
  remain unimplemented; atomic CLI rotation is implemented (`rotate-key`).
  Per-credential expiry
  selection exists only at CLI issuance/rotation; grant editing is one
  project per request. The new
  grant/remove writes read inside their transaction, joining the pre-existing D1
  read-snapshot debt documented for credential issuance, credential rotation,
  credential revocation, membership edits, and grant add/remove. Rotation reads the
  source credential row and grants, then inserts the replacement, copies the grants,
  and revokes the old row. D1/R2 parity and a real-browser capture for this slice are unexecuted.
- **Evidence.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (523 tests:
  522 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan`
  exit 0. The new integration
  tests cover add/remove and DB/audit effects, idempotent add, missing removal, foreign
  speaker, foreign credential, revoked/expired/unknown/inactive-speaker read-only,
  non-member and unreadable projects, stale-grant removal after the speaker's
  membership is removed (add is the uniform `404`, remove `303` with a
  `credential.project.revoke` audit), CSRF on both add and remove (a rejected remove
  leaves the grant and audit state intact), bearer rejection, the 64 KiB cap, method
  and media-type boundaries, localization, and Node-adapter body buffering.

## Slice AG — atomic CLI credential rotation (base `a174377`)

- **Surface.** New operator CLI `rotate-key --credential <id> [--expires-at <RFC3339>]`
  backed by `rotateSpeakerCredential` in `src/service/speakers.ts`. No dashboard
  route, dependency, migration, or schema change. The CLI prints only the new token,
  once, in the same format as `issue-key`; the old token, prefix, and verifier are
  never read out.
- **Semantics.** The old credential must exist, be unrevoked and unexpired, and belong
  to an active speaker with an active owner account; otherwise the command fails
  with no writes. OAuth-issued access credentials are identified by their `cb_oat_`
  token prefix or an `oauth_token_clients` association (their credential IDs are
  `cred_oat_*`), not by the ID string; they are rejected with no writes, because a
  replacement would drop the OAuth client association, and use the OAuth
  refresh/revocation flow instead. The replacement keeps the same speaker, exactly the old credential's
  known scopes, and exactly its current `credential_project_grants` rows. New
  credential + copied grants + old-row `revoked_at` are written in one
  `SqlDatabase.transaction` (`BEGIN IMMEDIATE`), so a grant/insert failure leaves the
  old credential active and a revocation failure rolls back the replacement. The old
  row's grants are retained (soft revocation, matching `revoke-key`). Access is never
  widened: scopes and grants are copied, not recomputed.
- **Expiry default.** Without `--expires-at`, the replacement keeps the old
  credential's exact `expires_at`, including `NULL` (no expiry). This never silently
  extends or shortens lifetime; a near-expiry credential stays near expiry unless the
  operator passes a future `--expires-at`. An explicit value must parse and be in the
  future, otherwise the command rejects before any write. There is no CLI flag to
  clear an expiry.
- **Audit.** One sanitized `credential.rotate` row with actor account, actor speaker,
  `project_id` only when there is exactly one grant, up to 32 project IDs plus the true
  `project_count`, scopes, and the old/new credential IDs. No token, prefix, verifier,
  or body. The audit write is fail-open and follows the committed transaction, matching
  the other service credential audits.
- **Tests.** `tests/integration/cli.test.ts` covers six rotation integration tests:
  happy path (old token 401/`UNAUTHENTICATED`, new token accepted on both granted
  projects, ungranted project still `FORBIDDEN`, identical scopes/grants/expiry, audit
  shape and no secrets); unknown/revoked/expired/inactive-speaker/past-expiry/
  unparseable-`--expires-at` rejection with no writes; injected grant-write and
  old-row-revocation failures roll back fully while the old token keeps working;
  default-preserved vs explicit future expiry plus `NULL` expiry staying `NULL`;
  OAuth-issued credential rejection split into independent cases (a lone `cb_oat_`
  token prefix with no association, and a lone `oauth_token_clients` association with
  a normal `cb_` prefix), invalid stored-expiry rejection, and inactive-owner
  rejection with no writes; and concurrent double rotation producing exactly one
  replacement, one active credential, and a revoked old row.
- **Evidence.** `npm ci --ignore-scripts` exit 0; `npm run check` exit 0 (531 tests:
  530 pass, 1 skipped live-D1, 0 fail); `npm run build` exit 0; `npm run secret-scan`
  exit 0; removing only the OAuth prefix check fails the prefix-only case and removing
  only the association check fails the association-only case, each in a scratch copy.
- **Pushed and reviewed.** Security PASS + contract PASS on tree `0071dc6`,
  after fixes for OAuth-issued credential rejection, complete D1 debt lists, the
  runbook/CLI reference, and independently split OAuth guard tests with per-condition
  mutation proof. Pushed on `main` at `e9065c1`; CI run 42202110269 success.
- **Debt and TODO.** There is no dashboard rotation view and no D1 adapter; OAuth
  credentials are intentionally rejected rather than migrated. The rotation transaction is read-then-write, joining the existing
  D1 read-snapshot debt documented in `docs/architecture.md` and `src/storage/db.ts`.
  TODO 347 stays unchecked: this slice completes credential rotation, but the line also
  bundles 256-bit creation/verifier/once-only display (already implemented) and the
  emergency project-disable path (unimplemented). D1/R2 parity and a real-browser pass
  for a rotation UI are external gaps; there is no rotation UI.

## Slice AM — adversarial probe suite (TODO 352, candidate on `adversarial-probes`)

Status: implemented, independently audited, and pushed at `5e6bccf` (tree `c2244ab`,
audited candidate `6c527df`); CI concluded success. Base `f8ed99a` (clean
`origin/main`).

- New `tests/security/adversarial-probes.test.ts` adds 20 tests (15 top-level probes
  and five session-predicate subtests) against the real `createApp` router: no mocks
  of routing, services, or authorization. It
  covers object-level unknown/foreign ids for project, message, body, receipt,
  credential, membership, and audit objects across REST, MCP, and dashboard routes;
  JWT non-applicability (two JWT-shaped tokens rejected on every auth surface, plus
  a `src/` import/use scan and direct-dependency scan; the MCP SDK's transitive
  `jose` is pinned by a lockfile reachability assertion, never imported by `src/` and
  never loaded by application auth code (the SDK's optional client auth-extensions
  module may import it)); idempotency scoping and tamper
  behavior; injected credential, membership, and session revocation between
  authentication/blob write and publication; spoofed identity/time/sequence fields in
  REST, MCP, web forms, and OAuth consent; hostile Host/forwarded/override/duplicate
  headers, Origin/`Sec-Fetch-Site`, content-type confusion, percent-encoded CRLF, and
  raw CR/LF rejection; and SQL/path/prototype/oversize/deep-JSON/HTML injection.
- Two minimal runtime fixes found by the probes. (1) `FINALIZE_SESSION_SQL` now
  includes an active-session-row `EXISTS` predicate (not revoked, absolute-expiry and
  idle bounds, active account) so a session revoked after request authentication
  cannot publish. `Principal` gained the server-set `sessionId`; the session
  resolvers populate it and `authorizeSessionSend` requires it. (2) `replayOrResume`
  now rejects an idempotency record whose message belongs to another speaker with the
  uniform `NOT_FOUND`, instead of returning that message's metadata or resuming its
  row; this state requires database write access and is not API-reachable.
- Existing negative tests were strengthened, not weakened: the synthetic session
  principals in `tests/integration/message-send-web.test.ts` now insert a real
  `sessions` row so the new atomic predicate is observable.
- Docs: `docs/threat-model.md` "Adversarial probe matrix" (results, citations, and
  non-applicable items); `docs/authorization.md` session-send predicate and TOCTOU/idempotency
  limits; `docs/api.md` no-JWT statement and tampered-replay behavior.
- Evidence: `npm run check` exit 0 (644 tests: 643 pass, 1 skipped live-D1, 0 fail),
  `npm run build` exit 0, `npm run secret-scan` exit 0 (`secret-scan: ok`).
- Limits recorded in the matrix: no application JWT exists (a transitive `jose` ships
  with the MCP SDK; it is never imported by `src/` and never loaded by application auth
  code, though the SDK's optional client auth-extensions module may import it); no
  receipt-by-id, audit-by-id, sort, or upload surface exists; HTTP request
  decompression and multipart parsing do not exist (the stored-envelope gzip path is
  separate); per-IP/proxy trust is deployment-only; no constant-time claim; the
  bearer revocation window after the final re-check and before its `UPDATE` remains
  open and is not simulated as passing.

## TODO 409 review remediation (branch `review-remediation`, base `959ce37`)

Status: implemented, independently audited, and pushed at `5a310d1` (tree `d8b1bb3`,
candidate `b236635`); CI concluded success. The fresh independent review ran at
`959ce37` (tree `67734ba`)
with no P0/P1 and produced the P2/P3/deployment findings below. The candidate SHA is
this checkpoint's `Candidate-SHA` trailer (left `pending` on the amended commit); the
final tree is the `Tree-SHA` trailer.

- **P2 rate-limit placement.** Bearer requests are limited before authentication,
  keyed by the parsed token's stable public prefix. The limiter remains bounded and
  idle-evicted, and there is one bucket decision per request (the post-auth check is
  folded in). An over-limit request returns the same `429 RATE_LIMITED` +
  `Retry-After` without the credential SELECT, HMAC verification, or
  `last_used_at` UPDATE. Malformed/absent/non-`Bearer`/duplicate/too-short values are
  unkeyed and still fail `401 UNAUTHENTICATED`; an unknown well-formed token below the
  limit fails the same way. Authoritative contracts (`docs/api.md`,
  `docs/architecture.md`, `docs/runbook.md`, `docs/security-operations.md`,
  `docs/mcp.md`) now describe the pre-auth key/order and the bounded-map eviction
  trade-off.
- **P3 OAuth consent widening.** `grantOwnedSpeakerCredentialProject` now selects the
  `cb_oat_` prefix and `oauth_token_clients` association and rejects OAuth-issued
  credentials with the same shared predicate/message as `rotateSpeakerCredential`.
  The operator CLI `grant-key-project` uses the same shared predicate and rejects the
  row with the same message. The inventory exposes `oauthIssued` (selecting
  `public_prefix` only to derive that flag, never rendering or logging it); the
  dashboard hides the add-grant form while grant removal and whole-credential
  revocation remain available. Documented in `docs/oauth.md`,
  `docs/authorization.md`, and `docs/api.md`.
- **P3 `client_sent_at` amplification.** `validateClientSentAt` requires a real
  RFC 3339/ISO 8601 timestamp (calendar-valid date, `Z` or `±HH:MM`, optional 1–9
  fractional digits) of at most 64 characters, retains the value unchanged, and
  rejects oversized/malformed/non-string values with `VALIDATION_ERROR` before any
  write. It remains untrusted diagnostic metadata; the server clock is authoritative.
  Documented in `docs/api.md`.
- **P3 protocol-relative web links.** `hrefWithParams` collapses only duplicate
  leading slashes so language-switch, pager, and jump links remain same-origin;
  interior paths are unchanged.
- **Deployment F2.** `parseBaseUrl` rejects cleartext `http:` unless the host is
  `127.0.0.1`, `::1`, or `localhost`; HTTPS is always accepted.
  `docs/polling.md` states the rule.
- **Deployment F1/F4/F9 docs.** `docs/deployments.md` uses
  `npm ci --ignore-scripts`; `docs/supply-chain.md` replaces the unpinned SBOM
  fallback with `@cyclonedx/cyclonedx-npm@6.0.1` and states honestly that it requires
  network and is not lockfile-consistent; `docs/acceptance-report.md` is marked as of
  its `e79d60e` revision, no longer claims there are no deployment artifacts, and
  names the existing `Dockerfile`, `compose.yaml`, and `ops/systemd/*` artifacts as
  independently unreviewed.
- **Deployment F5/F6 secret scan.** Every worktree/untracked read is stat'ed first and
  an oversized file fails closed without being read; tracked files are scanned in
  both the staged index blob and the worktree, so an unstaged secret is caught. The
  staged-index scan, history scan, and existing findings are unchanged.

Tests added/extended: `tests/integration/rate-limit.test.ts` (over-limit makes no
`last_used_at` change, another credential is unaffected, unknown token still 401);
`tests/integration/speakers-web.test.ts` (OAuth grant rejected at the service and a
crafted dashboard POST with no row/audit, form hidden, ordinary credential still
works); `tests/integration/cli.test.ts` (`grant-key-project` rejects an OAuth row with
no grant write while the ordinary credential grant succeeds); `tests/unit/validation.test.ts` and `tests/integration/messages.test.ts`
(`client_sent_at` oversized/malformed/impossible-date rejection and retained valid
value); `tests/integration/web.test.ts` (double-slash requests produce same-origin
links); `tests/unit/poll.test.ts` (loopback HTTP accepted, non-loopback HTTP rejected,
HTTPS accepted); `tests/security/secret-scan-cli.test.ts` (oversized untracked file
fails closed unread; unstaged tracked-worktree secret caught).

Recorded debt (explicitly out of scope): session/dashboard per-credential rate
limiting (P3-1), OAuth endpoint limiter ordering (P3-4), runtime history scan (F7),
systemd hardening (F11), container readiness healthcheck (F8), CI Docker/nginx
validation, bounded-map eviction churn (unauthenticated junk prefixes can reset a
bucket; the documented trade-off is accepted for this process-local limiter),
duplicate secret-scan findings when a secret is present in both the index and the
worktree, and no `git cat-file -s` precheck before reading a staged index blob.

Evidence: `npm run check` exit 0 (secret scans, license report, typecheck, 663 tests:
662 pass, 1 skipped live-D1, 0 fail) and `npm run build` exit 0 at the candidate tree.

## Agent integration examples ("Provide Codex CLI and Claude Code skill examples", branch `agent-skill-examples`, base `4241ec7`)

Status: implemented on branch `agent-skill-examples`; the commit trailers record the
tree and candidate. Independent review and the exact-revision audit are **PENDING**
and this slice must not be described as audited until the coordinator records them.

TODO line-number labels in this file drift as `TODO.md` edits shift lines; the
stable bullet title above is authoritative. This slice is not the earlier polling
slice that used a numeric label.

- **Deliverable:** `examples/agent-integration/` contains a Claude Code
  `claude-code/SKILL.md`; a Codex CLI `codex/config.toml.example`,
  `codex/AGENTS.md.example`, and `codex/README.md` shell invocation; `poll-consume.ts`;
  `send.ts`; and `lib.ts`. Both agent examples treat message content as untrusted
  data, forbid rendering the credential, and require a distinct key per agent.
- **Credential handling:** `lib.ts` reads `CORKBOARD_APIKEY` from the environment
  only and applies the poller's non-empty/no-whitespace rule before any request.
  The examples reject argv delivery, never print the key, and redact it on every
  error path; raw transport errors are replaced with the fixed `unexpected failure`.
  Documentation shows each key stored in its own `0600` file outside the repository
  and exported into the environment, uses explicit `issue-key --scopes`
  (`message.read,receipt.write` for polling, `message.send` for sending) instead of
  the broader default, and names the operator `revoke-key`/`rotate-key` commands. No
  registration endpoint or committed credential is introduced; the examples are
  scanned by the repository secret scan.
- **Full loop:** `poll-consume.ts` imports `run`, `parseBaseUrl`, `redact`,
  `redactAndEscape`, and the limit constants from `scripts/poll.ts`. It adds only an
  `onMessage` callback: it writes each digest-verified body to a private inbox
  (`<cursor-dir>/inbox`, `0700`, one `0600` file per `seq`) and emits a status line
  without content. Every persisted field, including `message_id`/`sender_id`, is
  credential-redacted. Inbox writes use a fsynced temp file and atomic rename, so a
  partial write is never mistaken for delivery; an existing complete target is not
  overwritten by an at-least-once replay. The inbox path is validated (including
  against symlinks) before it is created, must resolve outside the repository, and
  is then chmodded `0700`. The reference poller still owns list `after_seq`, body fetch and digest
  verification, explicit `mark_read`, and the atomic durable cursor; no list URL,
  receipt endpoint, or cursor writer is duplicated.
- **Send:** `send.ts` reads the credential from the environment, computes
  `body_digest` over the exact UTF-8 text, sends a caller-generated
  `Idempotency-Key`, and prints only status/message id/seq. It reuses the poller's
  exported `timeoutSignal`/`readCappedBody` for one request-and-body deadline and a
  1 MiB streamed cap, and neither the key nor the text is printed.
- **Tests:** `tests/unit/agent-integration.test.ts` (9 tests) scans every file under
  `examples/agent-integration/` with `findSecrets` and a literal-bearer regex;
  asserts environment-only loading with whitespace rejection and error redaction
  (including the fixed fallback for a raw undici-style error); asserts the consume
  example imports the reference poller and contains no list URL or receipt endpoint;
  covers inbox field redaction, no-overwrite, stale-temp, failed-write, `0700`
  tightening, outside-repository rejection, the production-computed repository root
  against the default `$HOME/.local/state` inbox, a symlinked inbox path, and
  complete writes; and covers send's oversize-body exit `3` and request timeout
  exit `1` without echoing the credential.
- **Non-claims:** local examples only. No real Codex CLI or Claude Code session was
  executed, and no ChatGPT integration, OAuth linking, or conversation-level tool
  invocation is claimed. Runtime smoke used a synthetic loopback HTTP fixture
  (not committed): consume advanced the cursor to `seq` 1 and wrote one inbox file;
  send returned `201`.

Evidence: `npm run check` exit 0 (secret scans, license report, typecheck,
682 tests: 681 pass, 1 skipped live-D1, 0 fail), `npm run build` exit 0, and
`npm run build:repro` exit 0.

## Negative permission and failure paths (branch `negative-coverage`, base `60bafd1`)

Scope: audit the existing suites against the authorization predicates and failure
paths, then add only the missing negative tests. Every new request uses the real
`createApp` router or the real service with the real SQLite adapter. Faults are
injected at one dependency boundary (`deps.db` or `deps.blobs`), never by mocking the
function under test. No application behavior changed except the fatal-UTF-8 fix
described below.

### Existing coverage found (nearest committed test)

| Required denial/failure class | Existing evidence |
| --- | --- |
| Project-scoped unknown object / foreign project | `tests/security/adversarial-probes.test.ts:509`, `:562`; `tests/integration/http.test.ts:511`; `tests/integration/messages.test.ts:197` |
| Member without the required scope | `tests/integration/messages.test.ts:225`, `:879`; `tests/integration/project-stats.test.ts:170`; `tests/integration/web.test.ts:358` |
| Removed membership | `tests/integration/messages.test.ts:904`; `tests/integration/web.test.ts:306`; `tests/integration/message-send-web.test.ts:389` |
| Revoked/expired credential | `tests/integration/messages.test.ts:486`; `tests/integration/mcp.test.ts:872` |
| Credential grant removed | `tests/security/project-grants.test.ts:16`, `:141`, `:190`; `tests/integration/messages.test.ts:944`; `tests/integration/expiry.test.ts:1004` |
| Missing/expired/revoked session | `tests/security/session.test.ts:398`; `tests/integration/web.test.ts:414`; `tests/integration/overview.test.ts:577` |
| Missing/wrong CSRF | `tests/integration/web.test.ts:1093`, `:1206`, `:1933`; `tests/integration/members-web.test.ts:643`; `tests/integration/message-send-web.test.ts:622`; `tests/integration/speakers-web.test.ts:458`, `:1225` |
| Cross-origin form post | `tests/security/adversarial-probes.test.ts:1245`; `tests/integration/cors.test.ts:27` |
| Inactive account (session) | `tests/security/session.test.ts:357`; `tests/integration/policy-web.test.ts:328`; `tests/integration/speakers-web.test.ts:1743` |
| Session-send authorization | `tests/integration/message-send-web.test.ts:334`, `:389`, `:512`, `:545`, `:905`; `tests/security/adversarial-probes.test.ts:838`, `:882` |
| OAuth wrong PKCE/redirect/used/expired code/unknown client | `tests/security/oauth.test.ts:661`, `:710` |
| OAuth refresh reuse | `tests/security/oauth.test.ts:829` |
| OAuth scope escalation | `tests/security/oauth.test.ts:590`, `:863` |
| MCP foreign ids / spoofed arguments / foreign session / insufficient scope | `tests/integration/mcp.test.ts:229`, `:370`, `:543`; `tests/security/adversarial-probes.test.ts:1525` |
| Missing/corrupt blob | `tests/integration/messages.test.ts:619`, `:656`, `:705`; `tests/integration/http.test.ts:1025` |
| Digest mismatch | `tests/integration/http.test.ts:581`; `tests/integration/messages.test.ts:302` |
| DB write failure rollback | `tests/integration/members-web.test.ts:732`; `tests/integration/speakers-web.test.ts:716`; `tests/integration/web.test.ts:1844`; `tests/integration/retention.test.ts:772`; `tests/integration/cli.test.ts:1058`, `:1849` |
| Backup/cursor corruption | `tests/security/backup.test.ts:135`-`:771`; `tests/unit/poll.test.ts:910` |
| Oversized/deep input | `tests/integration/http.test.ts:600`; `tests/security/adversarial-probes.test.ts:1442`; `tests/integration/members-web.test.ts:711`; `tests/integration/speakers-web.test.ts:1658` |

### Gaps filled by `tests/integration/negative-paths.test.ts`

1. Malformed opaque project cursors (non-base64, non-JSON, wrong field types) and
   message query parameters (`after_seq`/`before_seq` together, `limit` out of
   range) return `VALIDATION_ERROR` on REST. MCP returns the same stable tool error
   for the cursor and for the mutually-exclusive bounds pair; values the tool input
   schema itself rejects (a negative seq, `limit: 0`) raise the SDK's internal
   `McpError(-32602)`, surfaced as a tool-result error (`isError: true`, HTTP 200);
   no schema-level case is claimed here. No
   prior test exercised the cursor decoder's negative path.
2. An unexpected persistence error (injected at `deps.db`) maps to a sanitized
   `503 UNAVAILABLE` JSON envelope on API and MCP, and a generic `500` HTML page on
   dashboard routes; the injected message never reaches the response. Prior coverage
   proved transaction rollbacks, not app-level error mapping.
3. A blob-write failure returns a sanitized `503`, publishes nothing, leaves the
   provisional idempotency row, and the same key/payload resumes to exactly one
   message and one blob. Prior tests covered a failed blob *verification* and
   mid-request revocation, not a failed blob *write* plus the route-level retry.
4. Invalid UTF-8 in JSON, dashboard-form, and OAuth-form bodies is rejected before
   validation or writes. **Root fix:** request-body `TextDecoder`s in
   `src/app/handlers.ts`, `src/app/web.ts`, and `src/app/oauth.ts` are now
   `{ fatal: true }`; non-fatal decoding previously replaced malformed bytes with
   U+FFFD and could accept content the client did not send. Reverting each decoder
   alone fails the test: JSON reaches `INTEGRITY_MISMATCH`, the dashboard form is
   rejected with the `400` `loginExpired` retry page (fresh login cookie set where
   the strict path sets none), and OAuth reaches `invalid_grant`. The probes are not clean-room minimal —
   the JSON body carries a deliberately invalid digest and the login form no
   `login_csrf` — but each assertion is sensitive to its decoder reverting. The
   guarantee is over **raw request bytes on routes this server decodes**:
   `URLSearchParams` percent-decoding (`x=%FF`) substitutes U+FFFD, and a JSON
   lone-surrogate escape (`"\ud800"`) is preserved by `JSON.parse` and becomes
   U+FFFD when the server UTF-8-encodes it; both are normalization outside the
   raw-byte rule. `POST /mcp` is decoded by the pinned SDK transport (see
   `docs/mcp.md`). `docs/api.md` and `docs/mcp.md` record that scope, and
   `docs/oauth.md` the OAuth form error shapes.
5. Inactive account, inactive speaker, and inactive project states fail closed on
   bearer surfaces (401 `UNAUTHENTICATED` for the principal, 404 `NOT_FOUND` for the
   project) with no writes; the project disappears from listing.
6. Corrupt idempotency rows with a missing payload digest or missing message id
   return `UNAVAILABLE` and never mint a second message.

### D1 caveat (explicit)

SQLite (`src/storage/sqlite.ts` over built-in `node:sqlite`) is the only persistence
backend in this tree. There is no D1 or R2 adapter in `src/storage` or
`src/platforms`, and the shared storage contract's D1 scenario is deliberately
skipped at `tests/contract/storage.test.ts:24` with the reason "External gap: no D1
adapter, Cloudflare runtime, or credentials in this environment". The "both backends
if persistence affected" part of the clause is therefore **structurally
inapplicable**, not passed: no second backend was simulated, and the pre-existing D1
transaction-contract debt (read-then-write callbacks, in-transaction affected-row
counts) is unchanged.

### Commands

`npm run check` exit 0 (secret scan, history scan, license report, strict typecheck,
`702` tests: `701` pass, `1` skipped D1 contract scenario, `0` fail) and
`npm run build` exit 0. Branch `negative-coverage`, base
`60bafd17290d367b7e18849c79d000c86e51c4ee`.

### Independent audits (final)

- **Security audit — PASS** on candidate `58f0f1c` (tree `894c6fe`), after an
  amendment cycle that fixed two P2s and several P3 accuracy defects. Verified by
  revert-and-restore that each of the three strict decoders is load-bearing: reverting
  one alone makes its assertion fail (`INTEGRITY_MISMATCH` for JSON, the `400`
  `loginExpired` page with a fresh login cookie for the dashboard form, `invalid_grant`
  for OAuth).
- **Contract audit — PASS** on the same candidate/tree. The MCP claim is now scoped to
  probeable behavior: cursor and the mutually-exclusive bounds pair return the stable
  `VALIDATION_ERROR` tool error, while schema-invalid values raise the SDK's internal
  `McpError(-32602)` surfaced as a tool-result error. All 67 coverage-table citations
  resolve to test start lines or their bodies.
- **Amendments:** two doc/test-comment amendments were required and each re-audited as
  a delta; the final commit `999ae74` carries `Candidate-SHA: 58f0f1c` and the same
  tree `894c6fe`. Recorded audit commands: `npm run check` (702 tests: 701 pass, 1
  skipped D1 contract, 0 fail), `npm run build`, `npm run build:repro`,
  `npm run test:contract` (26: 25 pass, 1 D1 skip), and
  `node --test tests/integration/negative-paths.test.ts` (6 pass).
- **Known limitation recorded, not fixed:** the `/mcp` JSON-RPC body is decoded by the
  pinned SDK transport with a non-fatal decoder (documented in `docs/mcp.md`, with the
  adapter-level strict pre-read named as the upgrade). Percent-encoded form values and
  JSON lone-surrogate escapes still normalize to U+FFFD outside the raw-byte rule.

## MCP dogfooding — Commander as a real MCP client (2026-11-07, Issue #12)

Isolated loopback instance from `main` `c8b4068` (feature tree `894c6fe`), data
directory and `0600` secrets under `/tmp`, `HOST=127.0.0.1`, synthetic speaker and two
projects (one with no membership). Credential carried only the four narrow scopes and
reached the client through `${CORKBOARD_APIKEY}` header expansion in an external
`--mcp-config`; no tracked file changed.

Observed with the installed Claude Code CLI `2.1.310` in headless mode: registered
server, `initialize` 200 with session id, `tools/list` with six tools, and
agent-initiated `whoami`/`list_projects`/`list_messages`/`send_message`/`get_message`/
`mark_read` (send committed seq 1, one receipt). Denial on the no-membership project
returned `isError=true` `NOT_FOUND`; a revoked credential produced HTTP 401
`UNAUTHENTICATED` with no tool call; after a restart the old session id returned 404
`-32001` and a new run reconnected, sent one distinct-intent message (seq 3), and
created no duplicate; a prompt-injection fixture was labeled untrusted and not
followed. Server-side state matched: 3 messages, 1 receipt, one revoked and one active
credential.

Independent verification (separate context-isolated reviewer) returned
VERIFIED-WITH-CAVEATS after opening every screenshot, decrypting the blobs to check
synthetic content and integrity, matching the calls to the client's own session
transcripts, and scanning for secrets (0 hits). It found one publication-blocking
defect — the raw-transcript directory was `0600`, hence unreadable — which was fixed
to `0700` and re-scanned before the screenshots and report were published to the
Issue; a leftover headless Chrome process was stopped.

Limitations: the exercised runtime is a fresh headless process of the installed
client, not the long-running interactive session (this process cannot register a new
MCP server without a restart); `claude mcp add --scope local` was not exercised; the
host routes the CLI to a non-Anthropic model, so tool-call behaviour is the real
client's but model choice is host configuration; the Web UI login for the screenshot
used a directly written password hash; sessions are in-memory, so a blind send retry
after a restart can duplicate and the reconnect case used a distinct intent.

## Dashboard message-body expiry (branch `dashboard-expiry`, base `9e4dc59`)

Scope: add the missing dashboard action for an existing administrative capability.
The REST route already performed `POST /api/v1/projects/:projectId/messages/:messageId/expire`;
this slice adds the server-rendered timeline control and its POST route.

- `GET /projects/:projectId` renders one CSRF-protected expiry form per **ready**
  message only when `resolveSessionViewer(..., "project.edit")` succeeds. The same
  resolution already gates the edit link, so the control is omitted for a member
  without `project.edit`; the timeline remains readable.
- `POST /projects/:projectId/messages/:messageId/expire` authenticates the session,
  resolves the `project.edit` viewer **before** reading the form, applies the existing
  double-submit + `Sec-Fetch-Site`/`Origin` CSRF checks, then calls the existing
  `expireMessageBody` unchanged. The service re-authorizes `project.edit`
  immediately before the conditional transition. The dashboard resolves a session
  `project.edit` viewer and REST resolves a bearer principal, so the decision
  procedures differ by principal class; both require `project.edit` and both
  re-authorize in the same service, and the slice adds no scope or capability.
- The service's existing `INSERT OR IGNORE` `message.expire` audit row is the only
  audit write. The route adds none, and the response is `303` back to the timeline.
  Already-expired bodies are idempotent and keep one audit row. No default policy,
  automatic rotation, hard delete, or cleanup behavior changed.
- Dashboard tests use the real `createApp` and SQLite fixture: success and tombstone,
  member without `project.edit`, a non-owner editor with `project.edit`, non-member,
  foreign message, authorization-before-parse with a non-form body, missing/wrong/
  duplicate CSRF, missing CSRF cookie, cross-origin fetch metadata, `GET` 405,
  already-expired idempotency, sanitized audit contents, and omission of the control.

Commands: `npm run check` exit 0 (secret scan ok; history scan ok over 181 commits;
license report 98 dependencies, 0 flagged; strict typecheck; **705 tests: 704 pass,
0 fail, 1 skipped D1 contract**); `npm run build` exit 0;
`node --test tests/integration/web.test.ts` 38 pass.

Limitations: the control is on the timeline only; the standalone body-reveal page
remains read-only. There is no expiry-timestamp editor, no expiry listing beyond the
per-message state, and no dashboard cleanup worker. Real-browser acceptance was
performed at `299ff86` (Issue #6 comment, prerelease `web-ui-evidence-299ff86`): Chrome
156 via Playwright on desktop 1440×900 and mobile 390×844, a real click that expired
one body and left the other ready, and a read-only member whose rendered page contains
no expiry control; 30/30 DOM assertions passed, with the 303 response, `body_state`
transition, and single sanitized audit row recorded alongside the images.

### Independent audits (final)

- **Security PASS** on candidate `37e839e` (tree `0fa481b`). Confirmed `src` is
  byte-identical to the earlier audited candidate; authorization runs before form
  parsing (mutation to parse-first fails the non-member `text/plain` case with
  `400` instead of `404`); owner-only gating mutation fails the non-owner editor case
  with `404` instead of `303`; duplicate CSRF, cross-origin metadata, GET `405`,
  idempotent repeat, and the single sanitized `message.expire` row were re-probed; the
  REST route still returns `200` JSON and no scope/capability/policy/hard-delete
  behavior changed.
- **Contract PASS** on the same candidate/tree. Trailers are contiguous and exact,
  `git diff --check` is clean, five files changed with `docs/api.md` untouched, and the
  documented test counts and scenario list match the executed suite (`npm run check`
  705 tests: 704 pass, 1 skipped D1 contract, 0 fail; `web.test.ts` 38 pass;
  `npm run build` exit 0).

## Dashboard credential rotation (branch `dashboard-rotate`, base `b699fb3`)

Scope: expose the existing atomic rotation capability in the dashboard inventory.
`rotateSpeakerCredential` already backed `rotate-key`; this slice adds the
CSRF-protected form and its POST route and adds an optional `expectedOwnerAccountId`
ownership re-check to the service (scopes and capability model unchanged).

- The inventory renders a rotate form only for an **active**, non-OAuth credential of an
  **active owned** speaker. Revoked, expired, unparseable-expiry, inactive-speaker, and
  OAuth-issued credentials stay read-only with no form and answer the uniform 404 on
  POST.
- `POST /speakers/:speakerId/credentials/:credentialId/rotate` authenticates the
  session, loads the account-owned speaker inventory **before** parsing the form,
  requires the credential id to be present in that speaker's inventory with active
  state and a non-OAuth credential, then applies the shared double-submit and
  fetch-metadata CSRF checks and calls `rotateSpeakerCredential` with the session
  account as `expectedOwnerAccountId`. The service re-checks that ownership inside the
  `BEGIN IMMEDIATE` transaction; a speaker that changes hands between the inventory
  read and the write is `NOT_FOUND`, so the displaced owner cannot mint a token.
- The response reuses the issuance page's show-once pattern: the replacement token
  appears once in a `no-store` `200`, with a notice that the old credential is revoked
  and the token will not be shown again. The token is never placed in the URL, a
  redirect, a cookie, the audit row, or a log.
- The service's single sanitized `credential.rotate` audit row is the only audit write;
  scopes, grants, and the exact prior `expires_at` (including `NULL`) are preserved.

Tests use the real `createApp` and SQLite fixture: form eligibility and count, success
with the old token rejected and the new token working, expiry/grants preserved, exactly
one sanitized audit row, repeat submission refused, revoked/expired/unparseable/
inactive-speaker/OAuth credentials read-only and `404` on POST, foreign/removed-owner/
unknown ids the uniform 404, missing/wrong CSRF plus cross-origin refused with no
rotation, and an ownership transfer forced immediately before the write transaction
(yields `404` with no new credential, no revocation, and no audit row). An inactive
account invalidates the session and redirects to `/login`, matching other dashboard
writes.

Documentation reconciliation in the same change: `docs/web-ui.md` gains the rotation
section, and current-state claims in `README.md`, `docs/api.md`, `docs/runbook.md`,
`docs/threat-model.md`, `docs/security-operations.md`, `docs/authorization.md`,
`docs/docker.md`, and `docs/acceptance-report.md` that said the dashboard had no
rotation view (and that
message-expiry management was unimplemented) were corrected to the implemented
behavior. Historical slice rows are left as records of their time.

Commands: `npm run check` exit 0 (secret scan, history scan over 184 commits, license
report, strict typecheck; **711 tests: 710 pass, 0 fail, 1 skipped D1 contract**) and
`npm run build` exit 0; the touched suite `tests/integration/speakers-web.test.ts` is
41 pass.

Limitations: no per-credential expiry selection in the UI (rotation preserves the
existing expiry); OAuth-issued credentials are deliberately excluded because the
service rejects them; role separation remains account ownership rather than a separate
administrator role. Real-browser acceptance was performed at `ebed0d9` (Issue #6
comment, prerelease `web-ui-evidence-ebed0d9`): headed Chrome desktop and mobile
inventory captures, a real click producing the one-time token page with the token
pixel-redacted, old-token 401 / new-token 200, the DB transition and single sanitized
audit row, and the repeat-POST 404. A GET to the POST route is the documented 405.

### Independent audits (final)

- **Security PASS** on candidate `0e300b2` (tree `d0d415a`). The ownership guard was
  proven load-bearing (removing it makes the forced-transfer test return `200` instead
  of `404`) and the OAuth POST assertion proven (removing the handler check yields
  `500` instead of `404`); the CLI caller still omits `expectedOwnerAccountId`, so
  operator behavior is unchanged. `git diff 4ad7bd4..0e300b2 -- src tests` is empty:
  the final docs delta does not touch the audited source.
- **Contract PASS** on the same candidate/tree after two amendment cycles that removed
  every stale "no rotation view / CLI-only" current-state claim, corrected the OAuth
  grant-remove wording, added the `api.md` rotate row, and fixed two statements that
  still claimed the service was unchanged. Historical slice rows are retained as
  records of their time.
- **Documented fail-closed edges:** two concurrent rotate POSTs can both pass the
  inventory pre-check; the loser fails without a second credential or audit row and is
  currently surfaced as a generic `500`. An ownership transfer to an *inactive* account
  during the same window likewise surfaces as `500` rather than `404` (an inactive
  owner is already excluded from every dashboard inventory). Neither leaks existence
  nor mints a credential; both are documented in `docs/web-ui.md`.

## Audited manual cleanup (branch `prune-audit`, base `4a69f78`)

Scope: close the "manual cleanup" audit clause of TODO 349 for the operator `prune`
command, without changing what it deletes.

- After the bounded deletion transaction commits, `pruneRetention` writes exactly one
  sanitized `retention.prune` audit row when at least one row was deleted. The detail
  carries only `graceHours`, `limit`, and the per-table counts
  (`sessions`, `authorizationCodes`, `refreshTokens`, `tokenClients`,
  `oauthCredentials`); actor columns stay null, matching the expiry worker's system
  actor. No ids, tokens, prefixes, verifiers, session ids, IPs, or free text.
- A zero-deletion run writes no audit row (avoids unbounded noise), documented in the
  runbook.
- Audit failure is fail-open and explicit: deletions remain committed,
  `summary.auditFailed` is set, the CLI prints the full summary first and then warns on
  stderr with exit 1. `writeAudit` now reports whether it wrote, so callers can
  distinguish a swallowed failure from success; existing callers ignore the value and
  keep their previous behavior.
- Documented limits: audit rows are not tamper-evident; a crash after `COMMIT` and
  before the audit insert loses that row (no reconciliation, unlike message expiry);
  `audit_events` is never pruned by this command; no scheduled execution and no
  project deletion.

Tests use the real SQLite adapter and a trigger that makes the audit insert fail: one
sanitized row with exact counts for a deleting run, none for a zero run, deletions kept
plus `auditFailed`/exit 1 on failure, and an expanded untouched-object check
(messages, receipts, body objects, usable credentials, and pre-existing audit rows).

Commands: `npm run check` exit 0 (secret scan, history scan over 189 commits, license
report 98 dependencies, strict typecheck; **715 tests: 714 pass, 0 fail, 1 skipped D1
contract**), `npm run build` exit 0, targeted retention suites 21 pass.

Audits: the full security audit on tree `1afd9c27` returned PASS-WITH-P2 (no P0/P1;
two prune docs still described all-or-nothing behavior) and the full contract audit
returned PASS. Corrections to `docs/architecture.md`, `docs/oauth.md`,
`docs/runbook.md`, `docs/security-operations.md`, and `IMPLEMENTATION_STATE.md` were
delta-audited on trees `8485415a`, `8a5c4a92`, and `9201b77`; the closure audit on
`9201b770b82f` returned security PASS + contract PASS and declared the documentation
sweep closed. Voided sibling candidates `2c5a107`, `fa00932`, `544a156`, and `0c1835e`
share base `4a69f78` and are not ancestors of the pushed commit. No code changed after
the full audits.

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

Commands executed for the slice-O P2 fix tree: `npm ci` exit 0, `npm run check` exit 0
(secret scan, history scan, typecheck, 380 tests: 379 pass, 1 skipped live-D1), and
`npm run build` exit 0. Review verdicts are recorded in this file; commit trailers are
immutable and carry only the `Base-SHA`/`Candidate-SHA`/`Tree-SHA` values present when
written (`f06c4ac` still says review PENDING).

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
| Key/secret bootstrap implementation | Done (`init` writes secrets outside the data directory, dir `0700`/file `0600`, refuses to overwrite or touch an existing DB, prints path only) |
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
- Missing-object coverage removes the ciphertext blob through `BlobStore.delete`. A
  `body_objects` row deletion is rejected by the enabled foreign key while the ready
  message references it, so the row-absent guard is not exercised by a committed test;
  a corrupt/out-of-band database could still reach it.
- The uncertain-acceptance test uses `createApp` over a loopback `node:http` socket and
  simulates response loss by destroying that socket after the handler commits. It does
  not exercise the full `startServer` lifecycle, a reverse proxy, or a real network
  partition.
- `q` case-insensitivity inherits SQLite `LIKE` (ASCII only).
- Expiry cleanup is an operator-run command with no in-process scheduler; deployments
  must schedule `expire-bodies` externally. No hard-delete/admin erasure path exists;
  expiry retains metadata and does not rewrite backups.
- Slice-B P2 debt resolved in slice C: migration 002 adds the
  `(body_state, body_expires_at)` index to existing databases and `issue-key` persists
  the granted scope/project set in the sanitized audit `detail` column; expiry audit
  retries/reconciliation now use a system actor and repaired failures are not
  double-counted. Remaining slice-B debt: worker orphan/audit passes scan the growing
  expired population; a body fetch that passes its state check immediately before
  expiry may still return the already-decrypted content.
- Slice-C limitations: credential issuance does not use the
  `SqlDatabase.transaction()` helper, so `issue-key` compensates in application code
  (grants first, then credential) on any grant or audit failure; a process crash
  before compensation leaves a grantless credential (denied by default, revocable). Migration 002 does not
  backfill grants, so pre-release credentials lose project access until explicitly
  granted. Grant editing is available in the dashboard for active credentials of
  active speakers (membership plus account read access, in-transaction re-check);
  the dashboard also has a project-owner-only
  membership editor, and the CLI membership commands remain.
  Key rotation remains unimplemented.
- Test-fixture note: `tests/helpers/service-fixture.ts` auto-grants existing
  memberships/credentials by default so legacy service and HTTP tests keep exercising
  scope/membership logic. Grant-specific tests set `autoGrantMemberships: false` /
  `grantExistingCredentials: false` and grant explicitly; the authoritative
  deny-by-default coverage lives in `tests/security/project-grants.test.ts`.
- Slice-C audit debt resolved in slice D: re-running `add-member` on an active
  membership is a no-op (it cannot downgrade/widen or rewrite `joined_at`); a real or
  dangling `corkboard.sqlite` symlink counts as an existing installation; `/me` and
  project-list enumeration are asserted to drop access immediately after grant
  revocation and membership removal; `remove-member` audits grant revocation only when
  grants were deleted; `init` rejects newlines in the data-directory path.
  Remaining: CLI mutations and their audits are separate statements, so a failure
  between them can lose the audit row (authorization still denies by default).
- Revocation re-checks narrow but do not eliminate TOCTOU. A revocation that commits
  after the final re-check but before the atomic SQL statement (send finalization,
  receipt INSERT, expiry UPDATE), after the re-check but before the already-expired
  audit-repair/blob-delete path, or before the plaintext response is written is not
  prevented. No atomic-revocation guarantee is claimed. `getMessageBody` can also still
  return a body that expires immediately after its state check, as recorded under
  slice B.
- Slice-F limitations: `doctor` is report-only with no repair/fix mode; it does not
  verify backup integrity and has no D1/Workers implementation (`PRAGMA
  integrity_check` is SQLite-specific). It fetches referenced storage keys internally
  to reconcile blobs but prints only counts and bounded samples; version lists grow with
  `schema_migrations` rows. An integrity check that cannot run (corrupt/unreadable file)
  exits 2 rather than producing a report, while a non-ok result reports with unmeasured
  fields null. A live read may rewrite `-shm`, and sidecar detection has a narrow
  check/open TOCTOU. The normal opener now refuses a database migrated by a newer
  server; doctor only reports `SCHEMA_AHEAD`. Audit P2 debt: `SCHEMA_AHEAD` also covers
  out-of-set/hostile version rows rather than only versions above the bundled maximum;
  each unexpected version value is printed at full length (tampered DB can enlarge
  output); unsafe/non-integer version rows are refused or reported inconsistently; a
  symlinked ancestor of the data directory is not canonicalized (final component only);
  doctor's key-shape check is stricter than the server's lenient base64 decoder; the
  newer-schema refusal may switch journal mode/tighten permissions before refusing.
- Production filesystem verification covers directories and files present at startup;
  WAL/SHM sidecars are checked when present and are created `0600` by the adapter. It
  does not detect a mode change made by another privileged process after startup.
- Slice-D audit P2 debt: canonical checks cover final path components only (an
  ancestor-directory symlink is not rejected); the check-to-open TOCTOU remains; the
  symlinked `-shm` case lacks a committed test; `init` on a symlinked `--data-dir`
  follows and chmods the target (secrets are not written there, and `serve` rejects it);
  metadata-only reads remain request-start-only by design; a bounded `..` filesystem
  test variant is still missing.
- Bearer-authenticated MCP is implemented locally. Human account sessions are
  implemented and pushed as slice I: sign-in, session read, and sign-out only. Slice J
  adds the OAuth 2.1 authorization-server core (public dynamic clients, PKCE, consent,
  rotating refresh, revocation); the ChatGPT Web installation/linking experience and
  conversation-level ChatGPT tool invocation remain unimplemented and unverified. A
  session cannot act as a speaker credential; an OAuth access token is a speaker
  credential, not a session.
- Slice-J audit debt (non-blocking): OAuth registration, per-client,
  global token-exchange, and revocation limits are process-local and reset on restart;
  `oauth_clients` rows still grow without bound (`prune` covers expired/consumed codes,
  rotated/expired refresh rows, and `oauth_token_clients`, not registered clients);
  concurrent refresh with the same token can revoke a family; the consent form has no
  nonce, so a same-session replay can mint multiple codes with identical rights
  (codes remain single-use and PKCE-bound); the revoke bucket is global and checked
  after body parsing, so anonymous bucket exhaustion can delay revocation; the
  consent form requires JavaScript to send the CSRF header (a `<noscript>` notice is
  shown); no CORS, JWT/OIDC, introspection, consent-management UI, or admin
  OAuth endpoints; the sign-in handler is a second HTTP entry to `loginAccount` (the
  `/api/v1/session` JSON/content-type rule itself is unchanged); OAuth
  consent/code/token/revocation events are not written to `audit_events` in this
  slice; D1/Workers and real ChatGPT/browser behavior are unverified.
- Slice-K audit debt (non-blocking): `BEGIN IMMEDIATE` has no D1 batch equivalent, so
  `prune` is Node/SQLite-only; there is no scheduler, and there is no audit row by
  design (superseded: the prune-audit slice appends one `retention.prune` row when a
  run deletes rows);
  `oauth_clients` rows are not pruned; the user-facing out-of-range grace error still
  says "representable date range" although the accepted bound is
  `MAX_DATE_MS - SESSION_IDLE_MS`; the exact accepted boundary is probe-verified but not
  committed as a test; a database pruned by the unreleased pre-fix branch (never on
  `origin/main`) could hold an association-less OAuth credential that this prune cannot
  classify and would need a one-time repair.
- Slice-L audit debt (non-blocking): the dashboard is read-only, Node/SQLite-only, and
  has no pager beyond a 100-project cap, filters/search/replay/attachments, or
  automated axe/WCAG audit; browser evidence is local headless Chrome, not an
  independent cross-browser run. `listSessionProjects` still fetches all of an account's
  memberships and paginates in JavaScript; it remains unbounded and needs a SQL bound.
  The login
  double-submit cookie is path-scoped rather than `__Host-`, so the CSRF guarantee
  assumes a single registrable domain; `Origin: null` and the scheme are treated as
  "no assertion" and rely on `Sec-Fetch-Site` plus the double-submit value; the host
  comparison assumes the reverse proxy preserves `Host`.
- Slice-M audit debt (non-blocking): summary search uses SQLite `LIKE` (ASCII-only case
  folding, in-project scan, no index); `sender` requires an exact speaker id and has no
  member picker; `unread=false` is URL-reachable but not a form control; an `after_seq`
  page infers the older link and can land once on an empty page; browser/responsive
  evidence remains local headless Chrome prose, not an exact-revision artifact; no
  axe/WCAG audit or D1/Workers parity.
- Slice-N audit debt (non-blocking): path redaction is heuristic — a quoted path whose
  own name contains the delimiter quote (e.g. `o'brien`) can leak a fragment, though
  full absolute paths with spaces/non-ASCII are redacted; JSON output escapes C0
  controls but not DEL/C1 while human output substitutes `?`; the `lstat`-to-`VACUUM
  INTO` size check retains a narrow TOCTOU window (the post-snapshot check deletes an
  oversized output); mid-stream `digestFile` growth, the source-side 100,000-entry cap,
  and the top-level listing cap were audit-probe-verified but have no committed
  negative tests; the source-to-blob-copy race can miss a concurrently expired blob
  (backup now fails closed and `verify` detects it); the 16 KiB per-blob cap must be
  revisited before attachments raise the body cap; the operator module is Node/SQLite
  only (no D1/Workers). The integrity test at `tests/security/backup.test.ts` was
  rewritten from fd-level corruption to a controlled multi-page database so it no
  longer depends on on-disk page layout — a test-only robustness change, not a
  behavior change. A code comment in `scripts/corkboard.ts` still says JSON escaping
  covers all control bytes; the docs above state the C0-only guarantee.
- HTTP adapter caps declared and chunked bodies at 64 KiB and binds loopback by default;
  unconsumed request streams on non-body routes are drained by Node, so concurrent large
  unauthenticated uploads still add memory pressure. A reverse-proxy body limit remains
  recommended.
- `language` lacks a tight length cap beyond the request-body limit, so an
  authenticated sender can still inflate that stored/echoed metadata.
  `client_sent_at` is now bounded to 64 characters and validated as an RFC 3339
  timestamp.
- Node timeout enforcement is quantized by the default 30s connection-check interval.
- Adapter-generated 413s bypass the request logger; `revoke-key` audits success even if
  the credential was already revoked.
- Two truly concurrent first sends with the same key may both answer `201`, but return
  the same message; replay inherits the committed body state.
- Project listing uses `instr` over app-written capability JSON for pagination.
- Engineered for D1 but only SQLite is executed; D1 trigger/RETURNING/error behavior is
  unverified.
- Human account sessions are implemented. Slice L adds a read-only browser dashboard
  (project list, timeline, explicit body reveal, en/zh) on the same session auth. The
  OAuth core (slice J) adds sign-in/consent pages; ChatGPT Web is not implemented.
- Slice-G audit debt: idle/LRU eviction resets a bucket to full burst, which can exceed
  the configured sustained rate when `burst > 2 * perMinute` (non-default config);
  authentication/verification work and unauthenticated requests are not rate limited;
  the Node adapter buffers an in-cap body before auth/limit; pre-auth 404/405 routes are
  not counted. Limits are per-process and reset on restart.
- Slice-H audit debt (P2, non-blocking): `normalizeMetricsToken` decides
  disabled from the trimmed value but measures the raw string, so a ≥32-character
  value with edge whitespace is accepted with that whitespace as part of the secret
  (operator-only; a proxy that trims header edge whitespace would make it unusable);
  the adapter's non-413 pre-core failure records `UNAVAILABLE` but writes a bare `503`
  without the standard error envelope or security headers, while the API doc describes
  counters as carrying envelope-extracted codes; the `docs/deployments.md` environment
  row says "unset/empty disables" and omits whitespace-only; no test injects a throwing
  `MetricsRegistry.recordRequest` to prove the original response is preserved on the
  core and adapter recording paths. Metrics remain process-local and reset on restart.
- Slice-R audit debt (non-blocking): the queue-to-commit histogram is process-local and
  observes only finalizations performed by this process; it resets on restart and is
  not aggregated across processes. Its samples use wall-clock `received_at`/
  `committed_at`, so a server clock adjustment can produce a clamped zero or an
  inflated sample. The authorized stats endpoint counts current rows (its cost grows
  with project size), is not time-windowed, and is not wired into the dashboard UI.
  D1 execution remains unverified; the stats SQL avoids SQLite-only functions but has
  no D1 runtime test.
- No attachments. Per-credential rate limiting is implemented but process-local; it is
  not distributed/global, is not shared across processes or Workers isolates, and
  per-IP limiting remains delegated to the reverse proxy. MCP session state is in-memory/process-local
  (1024-session LRU cap, lazy 30-minute idle TTL) with no cross-process/Workers sharing;
  a restart drops sessions. A rejected request does not close a revoked credential's
  session; it remains until eviction and can be reused if the credential is reactivated.
- Slice-E audit debt: `withoutCredentials` relies on `Request.clone()` mutability and is
  not Workers-portable (Workers is unimplemented; would need headers-copy construction);
  the cap-eviction test does not distinguish LRU from FIFO; the header test does not
  assert a benign sentinel survives; cache headers on 401/404/405/DELETE/413 and the
  Node-adapter MCP 413 envelope are manually verified but not all committed as tests;
  the global 1024-session cap lets one credential evict another's session (availability
  only); `SessionEntry.sessionId` is dead; the MCP 413-before-auth ordering exception on
  oversized unauthenticated POSTs needs explicit docs/tests.
- Slice-AA audit debt (non-blocking): the per-speaker credential inventory is
  unbounded (no pagination) and lists every ordinary credential, including
  OAuth-issued access credentials; revocation blocks their refresh through the
  credential's `revoked_at` but does not delete `oauth_refresh_tokens` rows (the
  operator `prune` handles them later). Dashboard expiry selection and bulk
  revocation remain unimplemented; dashboard rotation and the operator CLI
  `rotate-key` share one atomic service, and per-credential expiry selection is
  CLI-only. Per-credential grant add/remove is
  implemented (slice AF) and inherits the read-inside-transaction D1 debt below. The `credential.revoke` audit row is
  written after the revocation transaction commits and is fail-open, so a crash or
  audit-insert failure between commit and audit loses the row while the revocation
  still takes effect (the pre-existing audit-sink rule; no behavior change here).
  D1/R2 parity and a real-browser pass are unexecuted. Transaction-contract truth
  (recorded in `docs/architecture.md`, `docs/security-operations.md`, and
  `src/storage/db.ts`): only project creation (two inserts) and session message-send
  publication (one conditional `UPDATE` carrying its authorization predicate) are
  write-only, result-independent callbacks that a D1 adapter can submit as one
  `batch()` with no callback-visible results. Credential issuance, credential
  rotation, credential revocation, membership add/remove, and credential grant
  add/remove read inside their transactions (`tx.first`/`assertProjectOwner`) before
  writing; rotation reads the source credential row and grants, then inserts the
  replacement, copies the grants, and revokes the old row. They are
  **pre-existing debt** for D1 because they need a documented read-snapshot strategy
  that does not exist. The grant add route's `?grant=added|exists` outcome also
  depends on the in-transaction `changes` count from `INSERT OR IGNORE`, which a
  batch-emulated D1 result cannot supply.
  Bearer message sends re-check immediately before the statement without wrapping it.
  Project title/summary edits use one `UPDATE`, not `transaction()`. Debt: the
  session publication retry backoff sleeps while the transaction is open, which would
  hold a write lock across retries on a future multi-connection adapter.
- Slice-AC audit debt (non-blocking, defense-in-depth): the bearer `FINALIZE_SQL`
  sender-mismatch rejection has no dedicated negative storage-contract test (the
  session statement is covered end-to-end by the tampered-idempotency test), and
  `commitBody`'s provisional `UPDATE messages SET body_object_id = ?` is not
  sender-scoped. Under out-of-band tampering with `idempotency_keys.message_id`, the
  provisional pointer can change on another speaker's pending row, but the
  sender-bound finalize predicate prevents publication and the row stays
  pending/invisible/reclaimable; reaching it requires direct database write access.
  Session sends produce no queue-to-commit histogram sample (the web route never
  recorded one; REST/MCP bearer sends are unchanged). Message-expiry listing,
  expiry-timestamp editing, and cleanup UI remain unimplemented (the dashboard can
  expire one ready body), as does credential rotation. D1/R2 parity and a
  real-browser pass for this slice are
  unexecuted.
- Bounded local soak only (`scripts/soak.ts`): one Node/SQLite process, text bodies
  only. It does not cover attachments/10 MiB, slow uploads, quotas, long-duration
  memory behavior, D1/Workers/R2, TLS/proxy, or multi-process aggregation. Latency
  numbers are machine-dependent and non-gating.
- No Workers adapter.
- Slice-I audit debt (P2, non-blocking): login rate limiting is process-local and keyed
  by email digest (an attacker who knows an address can consume that bucket); failure
  timing is comparable but not identical across PBKDF2 and the Node-only legacy scrypt
  path; session rows are never purged automatically (the explicit slice-K `prune`
  command is operator-run); there is no UI, registration, email verification,
  password reset, OAuth, or speaker delegation. The adapter body-buffering and multi-`Set-Cookie` defects found by the
  first audit are fixed in `9a4f6c5`; session-route 401s no longer send a Bearer
  challenge while bearer-route 401s still do. Re-audit test gaps: no committed
  adapter-level 65,536/65,537-byte login boundary test, no positive test for
  `application/json` with parameters (behavior probed correct), and the `/api/v1/session`
  metrics label is untested. Legacy `scrypt$` accounts remain distinguishable by
  response timing from unknown emails; rehash-on-login or a fixed PBKDF2 step would
  close it. Rotating emails bypasses the per-email login bucket (CPU pressure), and a
  known address can be locked out; per-IP controls remain the reverse proxy's job.
- Server-readable encryption only; not E2EE.
- `lint` is strict typecheck; no separate linter.
- Request-body UTF-8 strictness covers raw bytes on the routes this server decodes
  (`/api/v1`, dashboard forms, `/oauth/*`). Three documented normalization exceptions
  remain: `POST /mcp` is decoded by the pinned MCP SDK transport with a non-fatal
  decoder, `URLSearchParams` percent-decoding substitutes U+FFFD for `x=%FF`, and a
  JSON lone-surrogate escape is preserved by `JSON.parse` and becomes U+FFFD when the
  server encodes it. Substituted values are compared exactly, so none of them widens
  authorization; the upgrade is a strict pre-read in the MCP
  adapter (or an upstream SDK change) and a percent/escape-strict form parser.
- The negative-path suite does not assert schema-level MCP argument rejection: a
  negative seq or `limit: 0` raises the SDK's internal `McpError(-32602)`, which the
  SDK surfaces as a tool-result error (HTTP 200, `isError: true`) instead of the
  Corkboard `VALIDATION_ERROR` envelope. Only cursor and semantic (service-level)
  violations are asserted.

## Checkpoint (2026-11-07) — emergency project disable (TODO 347)

Branch `project-disable`, base `0441d351884a6ab32c49307cfede8bcb16ead930`. Implements
the remaining clause of TODO 347: an operator-only local `disable-project --project
<id>` / `enable-project --project <id>` pair that flips `projects.status` between
`active` and `disabled`. No schema migration was needed (`projects.status` is free-form
TEXT with a default; `migrations/001_init.sql`). No HTTP, dashboard, or MCP route was
added. Paths that authorize access to project data already require
`p.status = 'active'`, so a disabled project fails closed as uniform `NOT_FOUND` for
bearer REST send/read/body/receipt, MCP tools (same service functions), dashboard
session resolution and timeline, and owner/member editors; project listings omit the
project, indistinguishable from an inaccessible project. The dashboard
credential inventory and OAuth consent candidate listing omit a disabled project rather
than exposing it. Two corrections followed independent audit: the
dashboard credential-grant inventory now also filters `p.status = 'active'` so a
disabled project's id/title is hidden, and OAuth authorization-code issuance denies a
disabled project and an unknown project with the same non-enumerable `FORBIDDEN` rather
than `NOT_FOUND`. Credential revocation, atomic rotation, and grant removal remain
available while a project is disabled through the CLI and service/POST paths so
containment can proceed; the dashboard inventory omission hides its remove-grant
control.

Semantics: unknown project exits 1 with `corkboard: project not found: <id>` on stderr
and empty stdout; a repeat transition
succeeds as a no-op (`project already disabled` / `project already enabled`) and writes
no audit row; each actual transition writes exactly one sanitized system-actor audit
row (`project.disable` / `project.enable`, null account and speaker, project id in
`project_id`, null `detail`) through the shared `writeAudit` helper. The status update
commits before the audit insert; an insert failure prints a stderr warning, exits 1,
and does not roll back the containment action (the same authoritative-transition policy
as `prune`, documented in `docs/security-operations.md`). Re-enabling restores access
for existing credentials and sessions because nothing is revoked.

Evidence: `tests/integration/cli.test.ts` `disable-project hides every project path
until enable-project restores it` exercises the real CLI, real SQLite adapter, audit
shape/count, unknown project, idempotency, uniform `NOT_FOUND` for
send/read/receipt/dashboard-session, project-listing omission, OAuth consent-candidate
omission, dashboard credential-inventory hide/restore, and re-enable restore; `disable-project keeps the committed transition and exits 1 when its
audit insert fails` covers the fail-open audit policy with a trigger; and
`tests/integration/audit.test.ts` asserts disabled/unknown OAuth code-issuance parity.
Docs updated:
`docs/incident-response.md` item 5, `docs/runbook.md` §2.6 plus command lists, known
limits, and §7.2; `docs/deployments.md` command table; `docs/security-operations.md`
audit coverage. TODO 347 is checked; TODO 413's stale "no supported project-disable"
phrase is corrected. No API behavior changed; `docs/api.md` wording reconciled.
