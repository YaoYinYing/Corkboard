import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const entrypointSource = join(repoRoot, "scripts", "docker-entrypoint.sh");
const SENTINEL = "corkboard-entrypoint-sentinel-6b1f0c";
const skip = process.platform !== "linux" ? "requires Linux (stat -c)" : false;

interface Fixture {
  root: string;
  secretsFile: string;
  script: string;
}

// Executes the real entrypoint logic with only its fixed container path
// redirected to a temp directory, so /run/secrets is not needed.
function fixture(
  t: { after(fn: () => void): void },
  contents: string | null,
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "corkboard-entrypoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const secretsFile = join(root, "corkboard.env");
  const script = join(root, "docker-entrypoint.sh");
  const source = readFileSync(entrypointSource, "utf8");
  const marker = "SECRETS_FILE=/run/secrets/corkboard.env";
  assert.equal(
    source.split(marker).length - 1,
    1,
    "entrypoint path constant changed; update this test",
  );
  writeFileSync(script, source.replace(marker, `SECRETS_FILE='${secretsFile}'`), {
    mode: 0o755,
  });
  if (contents !== null) writeFileSync(secretsFile, contents);
  return { root, secretsFile, script };
}

function run(script: string) {
  return spawnSync("/bin/sh", [script, "true"], { encoding: "utf8" });
}

function assertRejected(
  result: ReturnType<typeof run>,
  secretsFile: string,
): void {
  assert.notEqual(result.status, 0);
  assert.ok(
    result.stderr.includes(secretsFile),
    `stderr should name ${secretsFile}: ${result.stderr}`,
  );
  assert.ok(!result.stdout.includes(SENTINEL));
  assert.ok(!result.stderr.includes(SENTINEL));
}

test("an absent secrets file is allowed for init", { skip }, (t) => {
  const { script } = fixture(t, null);
  const result = run(script);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("a 0600 regular file is sourced without printing contents", { skip }, (t) => {
  const { secretsFile, script } = fixture(t, `CORKBOARD_ROOT_KEY=${SENTINEL}\n`);
  chmodSync(secretsFile, 0o600);
  const result = run(script);
  assert.equal(result.status, 0);
  assert.ok(!result.stdout.includes(SENTINEL));
  assert.ok(!result.stderr.includes(SENTINEL));
});

test("a 0644 file is refused without printing contents", { skip }, (t) => {
  const { secretsFile, script } = fixture(t, `CORKBOARD_ROOT_KEY=${SENTINEL}\n`);
  chmodSync(secretsFile, 0o644);
  const result = run(script);
  assertRejected(result, secretsFile);
  assert.match(result.stderr, /mode must be exactly 600/);
  assert.match(result.stderr, /644/);
});

test("a directory at the secrets path is refused", { skip }, (t) => {
  const { secretsFile, script } = fixture(t, null);
  mkdirSync(secretsFile);
  const result = run(script);
  assertRejected(result, secretsFile);
  assert.match(result.stderr, /readable regular file/);
});

test("a symlink at the secrets path is refused", { skip }, (t) => {
  const { root, secretsFile, script } = fixture(t, null);
  const target = join(root, "target.env");
  writeFileSync(target, `CORKBOARD_ROOT_KEY=${SENTINEL}\n`, { mode: 0o600 });
  chmodSync(target, 0o600);
  symlinkSync(target, secretsFile);
  const result = run(script);
  assertRejected(result, secretsFile);
  assert.match(result.stderr, /not a symlink/);
});

test("a broken symlink at the secrets path is refused", { skip }, (t) => {
  const { root, secretsFile, script } = fixture(t, null);
  symlinkSync(join(root, "missing.env"), secretsFile);
  const result = run(script);
  assertRejected(result, secretsFile);
  assert.match(result.stderr, /not a symlink/);
});

test(
  "an unreadable regular file is refused",
  { skip: skip || process.getuid?.() === 0 },
  (t) => {
    const { secretsFile, script } = fixture(
      t,
      `CORKBOARD_ROOT_KEY=${SENTINEL}\n`,
    );
    chmodSync(secretsFile, 0o600);
    chmodSync(secretsFile, 0o000);
    const result = run(script);
    assertRejected(result, secretsFile);
    assert.match(result.stderr, /readable regular file/);
  },
);
