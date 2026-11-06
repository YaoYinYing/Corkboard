# Dependency audit, licenses and SBOM

Corkboard is MIT-licensed. This page defines the bounded supply-chain checks:
dependency audit, a license/notice report, and a CycloneDX SBOM. None of them is a
vulnerability guarantee or a substitute for review of the exact installed tree.

The committed `package-lock.json` and Node.js 24 LTS (`.nvmrc`) are the pinning
baseline. CI installs with `npm ci --ignore-scripts`; no lifecycle scripts run during
install.

## Commands

| Command | Network | Writes | Purpose |
| --- | --- | --- | --- |
| `npm run audit` | **yes** (npm advisory database) | nothing | `npm audit --audit-level=high`; fails on high/critical advisories |
| `npm run licenses` | no (after install) | `reports/licenses.txt`, `reports/licenses.json` | Declared licenses for every `package-lock.json` dependency entry, runtime/dev labeled, flagged when missing, unknown, or non-permissive |
| `npm run sbom` | no (after install) | `reports/sbom.cdx.json` | CycloneDX JSON from npm's built-in `npm sbom` |
| `npm run build:repro` | no | two temporary output directories (removed on normal completion or failure) | Runs the shared `scripts/build.ts` definition used by `npm run build` twice and compares a SHA-256 manifest; exits nonzero on any difference |
| `npm run check` | no | `reports/licenses.*` | Secret scans, the license scan, typecheck, and tests, each invoked directly |

`reports/` is git-ignored and must be generated on demand. Do not commit a stale
report. All commands exit nonzero on failure; the license scan also exits `1` when it
flags an entry (the report is still written) and `build:repro` exits `1` on a manifest
difference and `2` on a build or manifest failure.

`npm run check` includes the license scan because it is offline and deterministic
given the lockfile and installed tree. It does **not** include `npm audit`, which
requires the registry. CI runs `npm run audit` as a separate step.

No package script resolves `node`, `tsc`, or `npm` through `PATH`. Every script
starts with `"${npm_node_execpath:?npm_node_execpath is not set - run via npm}"`,
the absolute Node binary npm puts in the script environment; an unset variable exits
nonzero with that message. `scripts/build.ts` (used by `npm run build` and the
reproducibility proof) invokes the compiler as `process.execPath` +
`node_modules/typescript/lib/tsc.js`, the same binary `$npm_node_execpath` names under
`npm run`, and the test runner as `$npm_node_execpath --test`. `audit` calls
`scripts/npm-audit.ts`, which runs
`process.execPath` + `npm_execpath` with `audit --audit-level=high`, propagates npm's
exit status, and fails closed (exit `2`) when `npm_execpath` is unset. The contract
and integration tests that build `dist` invoke npm as `process.execPath` +
`npm_execpath`, not `npm_execpath` alone. This prevents a dependency-provided `node`,
`tsc`, or `npm` shim in `node_modules/.bin` from making the checks exit `0` without
running.

The scan is **lockfile-driven**: it iterates every `node_modules/` entry in
`package-lock.json`, whether or not that package is present in the installed tree.
For each entry it prefers the `license`/`licenses` declaration in
`node_modules/<path>/package.json`; if that file is unreadable or yields no usable
license string, it falls back to the `license` field recorded in the lock entry. An
unusable declaration is an empty/whitespace string, an empty array, an object without
a string `type` (for example `{url}`), or `{"type": 123}`. A package absent from
`node_modules` is therefore still reported from lock metadata, and a lock entry with
no usable declaration anywhere is `missing`. The legacy object form
`{"type": "MIT", "url": "..."}` and `licenses` arrays are reduced to their string
types. Lock paths containing `..`, absolute paths, or empty segments are rejected
with exit `2` rather than read.

### License policy

The allowlist for automatic acceptance is MIT-compatible:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`,
`ISC`, `MIT`, and `Unlicense`, including simple `AND`/`OR` SPDX expressions composed
only of those identifiers.

- `notice`: a recognized reciprocal license (for example GPL, LGPL, AGPL, MPL, EPL,
  CDDL, CC-BY-SA) is present. Do not redistribute without the required notice and a
  review.
- `missing`: no string or `{type}` `license`/`licenses` declaration is readable in
  `node_modules/<pkg>/package.json` and the lock entry has none either.
- `unknown`: an unparsed or unrecognized declaration, including `SEE LICENSE IN ...`
  and proprietary strings.

A flagged dependency blocks `npm run check` (exit `1`) until the package is removed or
replaced, or the allowlist in `scripts/license-report.ts` is deliberately changed in a
reviewed commit. There is no per-run exception flag or suppression list.

### SBOM

`npm run sbom` requires npm >= 9.6 (Node 24 ships npm 11) and an installed tree; it
reports an error if `node_modules` is missing. The script runs the installed npm CLI
through `process.execPath` + `npm_execpath` and fails closed if `npm_execpath` is
unset; it never resolves `npm` through `PATH`, which `npm run` prepends with
`node_modules/.bin`. The output is CycloneDX 1.5 JSON with the root component named
from `package.json` (npm otherwise derives the display name from the working
directory). The CycloneDX serial number and timestamp change on every run, so the
file is an artifact, not a reproducible build input.

npm applies its own component selector and deduplicates by `name@version`, so
repeated install paths collapse and dev/optional entries follow npm's selector
rather than the license report's lockfile listing. Use the license report when the
runtime/dev split matters.

If `npm sbom` is unavailable, the documented fallback requires network:

```sh
npx --yes @cyclonedx/cyclonedx-npm --output-file reports/sbom.cdx.json
```

The fallback is not used by CI because npm 11 provides the command.

### Reproducible build proof

`npm run build:repro` runs `scripts/reproducible-build.ts`, a Node-stdlib,
network-free check. It calls `scripts/build.ts` twice — the same shared definition
`npm run build` executes — into two sibling temporary output directories. That
definition compiles with `tsc -p tsconfig.build.json --outDir <dir>` through the same
Node binary and copies `migrations/` into the output directory, so the proof and the
real build cannot drift into different steps. It canonicalizes each output tree as
sorted relative POSIX path + SHA-256 of file bytes and compares the two manifests.
Exit `0` means every path and digest match; exit `1` prints the differing paths only
(never file contents); exit `2` means a build or manifest step failed, including an
empty output tree. The temporary parent is removed in a `finally` block. The manifest
is capped at 10,000 files and each compiler run has a 120 s timeout.

The `finally` cleanup covers normal completion and a thrown build or manifest failure.
There is no signal handler, and `execFileSync` blocks the event loop, so SIGINT,
SIGTERM, SIGKILL, or a process crash can leave the random `0700` `mkdtemp` directory
under the system temporary directory. It contains only build output, never secrets.

Both output directories are siblings at the same depth because `tsconfig.build.json`
enables `sourceMap: true`, and a `.js.map` `sources` entry is the relative path from
the map to the source file. Changing the output-directory depth changes those entries,
so a naive two-directory comparison can report a false difference.

**Scope.** The proof covers the TypeScript emit (`.js`, `.js.map`) plus the copied
`migrations/` files for the same working tree, operating system and toolchain, using
the Node binary that launched the script (Node 24.22.1 at this checkpoint) and the
TypeScript version pinned in `package-lock.json` (5.9.3). It excludes filesystem
mtimes, permissions, ownership, and directory metadata; only file bytes are compared.

**Limits.** It does not prove bit-identical Docker images. The `Dockerfile` pins the
base image by digest and `npm ci` pins dependency tarballs by lockfile integrity, but
image layers carry their own build metadata and the container's toolchain and filesystem
are separate from the host. It also does not prove cross-OS, cross-Node,
cross-TypeScript, or cross-output-path reproducibility, and it does not compare the
installed `node_modules` tree, the license report, or the SBOM (the CycloneDX serial
number and timestamp are intentionally per-run). The sibling temporary directories are
not byte-identical to a `dist/` build because `dist` sits at a different depth and
therefore emits different relative `sources` values; the proof is that two identical
invocations are deterministic, not that a differently located build is.

**Evidence (2026-11-06, Node 24.22.1, TypeScript 5.9.3).** `npm run build:repro` exited
`0` with `two builds produced identical manifests (104 files, sha256)` in about 5 s.
`tests/supply-chain/reproducible-build.test.ts` covers identical builds, a one-byte
change, an extra/missing file, creation-order independence, sorted manifest
path/digest canonicalization, an empty output tree, a symlinked output entry, the file
cap, temporary-directory cleanup on success and build failure, and the CLI exit `0`/
`1`/`2` paths. CI runs the proof after `npm run build`.

## CI

`.github/workflows/ci.yml` runs, in order: `npm ci --ignore-scripts`, the staged and
history secret scans, `npm run licenses`, typecheck, tests, `npm run build`,
`npm run build:repro`, `npm run sbom`, upload of `reports/` as the
`supply-chain-reports` artifact, and finally `npm run audit` (network-dependent). The
upload step uses a commit-pinned version of the standard GitHub artifact action.

Running the license scan before tests means a dependency whose declared license
changed fails the job with the package name and status rather than only in the
artifact.

## Known limits

- `npm audit` depends on the registry advisory database and on npm's mapping of
  advisories to versions; it is not exhaustive and unavailable air-gapped. Offline
  runs are not attempted, and a missing network is a failed step in CI, never a pass.
- The license report trusts declared package metadata, whether from the installed
  `package.json` or the lock-entry fallback. It does not read license texts, generate
  a NOTICE file, scan vendored or non-registry files, or validate SPDX expression
  syntax beyond the token check above.
- Runtime/dev is taken from the lockfile's `dev`/`devOptional` flags, not from a
  second resolver. Optional platform-specific packages not installed on this host are
  reported from the lock entry as well.
- The SBOM reflects the installed tree and lockfile. It has no signature, provenance
  attestation, or vulnerability data, and npm's default component selection and
  `name@version` deduplication apply.
- The lockfile pins integrity hashes; there is no automated update bot and no review
  of upstream release provenance here. `npm run build:repro` proves determinism of the
  TypeScript emit and copied migrations only, under the scope and limits above; it is
  not a Docker-image reproducibility proof.
- The `$npm_node_execpath` guard removes PATH shadowing by `node`/`tsc`/`npm` bins
  from dependency packages. It still trusts the npm installation and the Node binary
  npm itself was started with; a compromised or misconfigured npm/node installation
  is outside this boundary. Every package script now requires a POSIX `sh`:
  `${npm_node_execpath:?...}` and `$npm_node_execpath` use POSIX parameter
  expansion that Windows `cmd.exe` does not implement, so `npm run` fails there
  unless a POSIX script-shell is configured. CI runs `ubuntu-latest`.
- The secret scans (`scripts/secret-scan.ts`, `scripts/history-secret-scan.ts`)
  still invoke `git` through `PATH`, so a dependency-declared `git` bin under
  `node_modules/.bin` could shadow it under `npm run`. This is recorded debt outside
  the `node`/`tsc`/`npm` guard.
