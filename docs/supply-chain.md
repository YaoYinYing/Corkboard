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
| `npm run check` | no | `reports/licenses.*` | Secret scans, the license scan, typecheck, and tests |

`reports/` is git-ignored and must be generated on demand. Do not commit a stale
report. All three commands exit nonzero on failure; the license scan also exits `1`
when it flags an entry (the report is still written).

`npm run check` includes the license scan because it is offline and deterministic
given the lockfile and installed tree. It does **not** include `npm audit`, which
requires the registry. CI runs `npm run audit` as a separate step.

The scan is **lockfile-driven**: it iterates every `node_modules/` entry in
`package-lock.json`, whether or not that package is present in the installed tree.
For each entry it prefers the `license`/`licenses` declaration in
`node_modules/<path>/package.json`; if that file is unreadable or declares no
license, it falls back to the `license` field recorded in the lock entry. A package
absent from `node_modules` is therefore still reported from lock metadata, and a lock
entry with no declaration anywhere is `missing`. Lock paths containing `..`, absolute
paths, or empty segments are rejected with exit `2` rather than read.

### License policy

The allowlist for automatic acceptance is MIT-compatible:
`0BSD`, `Apache-2.0`, `BlueOak-1.0.0`, `BSD-2-Clause`, `BSD-3-Clause`, `CC0-1.0`,
`ISC`, `MIT`, and `Unlicense`, including simple `AND`/`OR` SPDX expressions composed
only of those identifiers.

- `notice`: a recognized reciprocal license (for example GPL, LGPL, AGPL, MPL, EPL,
  CDDL, CC-BY-SA) is present. Do not redistribute without the required notice and a
  review.
- `missing`: no `license`/`licenses` declaration is readable in
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

## CI

`.github/workflows/ci.yml` runs, in order: `npm ci --ignore-scripts`, the staged and
history secret scans, `npm run licenses`, typecheck, tests, `npm run build`,
`npm run sbom`, upload of `reports/` as the `supply-chain-reports` artifact, and
finally `npm run audit` (network-dependent). The upload step uses a commit-pinned
version of the standard GitHub artifact action.

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
- The lockfile pins integrity hashes; there is no automated update bot, no
  reproducible-build proof, and no review of upstream release provenance here.
