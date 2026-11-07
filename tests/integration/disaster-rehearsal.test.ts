import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { REQUIRED_CHECK_IDS } from "../../scripts/disaster-rehearsal.ts";

const script = fileURLToPath(new URL("../../scripts/disaster-rehearsal.ts", import.meta.url));
// Above the documented one-to-two-minute upper bound, so a run at the documented
// maximum cannot fail the suite.
const EXEC_TIMEOUT_MS = 180_000;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  elapsedMs: number;
}

function run(
  args: readonly string[],
  extraEnv: Readonly<Record<string, string>> = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    execFile(
      process.execPath,
      [script, ...args],
      {
        encoding: "utf8",
        timeout: EXEC_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, ...extraEnv },
      },
      (error, stdout, stderr) => {
        const status =
          error === null
            ? 0
            : typeof (error as { code?: unknown }).code === "number"
              ? ((error as { code: number }).code)
              : -1;
        resolve({
          status,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" ? stderr : "",
          elapsedMs: Date.now() - started,
        });
      },
    );
  });
}

// Each run gets its own TMPDIR, so a concurrent drill in another worktree cannot
// appear as a leak and the assertion covers only this run's directories.
async function makeTmp(t: { after(fn: () => void | Promise<void>): void }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "corkboard-rehearsal-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function parseJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.trim().split("\n").filter((line) => line !== "");
  assert.equal(lines.length, 1, "--json must emit exactly one object");
  return JSON.parse(lines[0] ?? "null") as Record<string, unknown>;
}

const POISONED_PARENT_ENV = {
  CORKBOARD_BOOTSTRAP_PASSWORD: "poison-password",
  CORKBOARD_ROOT_KEY: "poison-root",
  CORKBOARD_CREDENTIAL_PEPPER: "poison-pepper",
  CORKBOARD_DATA_DIR: "/definitely/not/used",
};

function assertNoSensitive(text: string, testTmp: string): void {
  assert.doesNotMatch(text, /CORKBOARD_ROOT_KEY/);
  assert.doesNotMatch(text, /CORKBOARD_CREDENTIAL_PEPPER/);
  assert.doesNotMatch(text, /CORKBOARD_BOOTSTRAP_PASSWORD/);
  assert.doesNotMatch(text, /CORKBOARD_REHEARSAL_TEST_FAIL_AFTER/);
  assert.doesNotMatch(text, /poison-/);
  assert.doesNotMatch(text, /Rehearsal synthetic body/);
  assert.doesNotMatch(text, /cb_[A-Za-z0-9_-]{20,}/);
  assert.doesNotMatch(text, /corkboard-rehearsal-/);
  assert.equal(text.includes(testTmp), false, "output contains the test temporary path");
}

test("disaster rehearsal passes end to end and cleans up every temp directory", async (t) => {
  const testTmp = await makeTmp(t);
  const result = await run(["--json"], { TMPDIR: testTmp, ...POISONED_PARENT_ENV });
  const report = parseJsonLine(result.stdout);
  if (report.skipped === true) {
    t.skip(String(report.reason ?? "host lacks required capabilities"));
    return;
  }
  assert.equal(result.status, 0, `rehearsal failed: ${result.stdout}${result.stderr}`);
  assert.ok(result.elapsedMs < EXEC_TIMEOUT_MS, `rehearsal exceeded its bound: ${result.elapsedMs}ms`);
  assert.equal(report.ok, true);

  const checks = report.checks as Array<{ id: string; ok: boolean }>;
  const ids = new Set(checks.filter((check) => check.ok).map((check) => check.id));
  for (const required of REQUIRED_CHECK_IDS) {
    assert.ok(ids.has(required), `missing rehearsal check: ${required}`);
  }
  const summary = report.summary as {
    messages: number;
    receipts: number;
    audit_events: number;
    blobs: number;
    schema_version: number;
  };
  assert.ok(summary.messages >= 3, "rehearsal seeded too few messages");
  assert.ok(summary.receipts >= 3, "rehearsal recorded too few receipts");
  assert.ok(summary.audit_events > 0, "rehearsal recorded no audit rows");
  assert.ok(summary.blobs >= 3, "rehearsal stored too few blobs");
  assert.ok(summary.schema_version > 0, "rehearsal did not record a schema version");

  assertNoSensitive(`${result.stdout}\n${result.stderr}`, testTmp);
  // The child must create and remove its own temp directories beneath TMPDIR,
  // even though the parent environment carried poisoned CORKBOARD_* values.
  assert.deepEqual(await readdir(testTmp), [], "rehearsal left temporary directories behind");
});

test("a forced mid-drill failure exits non-zero, redacts, and still cleans up", async (t) => {
  const testTmp = await makeTmp(t);
  const result = await run(["--json"], {
    TMPDIR: testTmp,
    CORKBOARD_REHEARSAL_TEST_FAIL_AFTER: "seed-messages",
    ...POISONED_PARENT_ENV,
  });
  const report = parseJsonLine(result.stdout);
  if (report.skipped === true) {
    t.skip(String(report.reason ?? "host lacks required capabilities"));
    return;
  }
  assert.equal(result.status, 1, "forced failure must exit non-zero");
  assert.equal(report.ok, false);
  assert.equal(report.failed_check, "seed-messages");
  assert.equal(report.error, "forced failure for the failure-path test");
  assert.ok(Array.isArray(report.checks) && report.checks.length > 0);

  assertNoSensitive(`${result.stdout}\n${result.stderr}`, testTmp);
  assert.deepEqual(await readdir(testTmp), [], "failed rehearsal left temporary directories behind");
});

test("disaster rehearsal documents its usage without running", async () => {
  const result = await run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: node scripts\/disaster-rehearsal\.ts/);
  assert.match(result.stdout, /Never prints secrets/);
  assert.match(result.stdout, /exactly one JSON object/);
});
