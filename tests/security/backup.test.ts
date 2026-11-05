import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  BACKUP_BLOB_DIR,
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  BackupError,
  BackupInspectError,
  RestoreError,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../../src/service/backup.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));
const NOW = "2026-11-03T12:00:00.000Z";
const REFERENCED_ZERO = "referencedZeroBlob_1234";
const ORPHAN = "orphanBlobKey_123456";

interface Fixture {
  root: string;
  dataDir: string;
  backupDir: string;
}

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-backup-sec-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function makeBackup(t: { after(fn: () => void): void }): Promise<Fixture> {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const blobsDir = join(dataDir, BACKUP_BLOB_DIR);
  mkdirSync(blobsDir, { mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      ["acct_1", "owner@example.test", NOW],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      ["proj_1", "acct_1", "Ops", NOW],
    );
    await db.run(
      "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, ?, ?, 'ready', ?)",
      ["body_1", "proj_1", REFERENCED_ZERO, NOW],
    );
  } finally {
    db.close();
  }
  writeFileSync(join(blobsDir, REFERENCED_ZERO), new Uint8Array());
  writeFileSync(join(blobsDir, ORPHAN), new Uint8Array([9, 8, 7]));
  const backupDir = join(root, "backup");
  await createBackup({ dataDir, outDir: backupDir });
  return { root, dataDir, backupDir };
}

function manifestPath(backupDir: string): string {
  return join(backupDir, BACKUP_MANIFEST_FILE);
}

function mutateManifest(backupDir: string, mutate: (manifest: Record<string, unknown>) => void): void {
  const manifest = JSON.parse(readFileSync(manifestPath(backupDir), "utf8")) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(manifestPath(backupDir), JSON.stringify(manifest));
}

function issueCodes(report: { issues: Array<{ code: string }> }): string[] {
  return report.issues.map((issue) => issue.code);
}

async function assertRestoreRefused(fixture: Fixture, target: string): Promise<void> {
  await assert.rejects(
    restoreBackup({ backupDir: fixture.backupDir, dataDir: target }),
    (error: unknown) =>
      error instanceof RestoreError && error.code === "RESTORE_VERIFY_FAILED",
  );
  assert.equal(existsSync(target), false);
}

test("database digest and size tampering fail verification and restore", async (t) => {
  for (const field of ["sha256", "size"] as const) {
    const fixture = await makeBackup(t);
    mutateManifest(fixture.backupDir, (manifest) => {
      const database = manifest.database as { size: number; sha256: string };
      if (field === "sha256") database.sha256 = "0".repeat(64);
      else database.size += 1;
    });
    const report = await verifyBackup({ backupDir: fixture.backupDir });
    assert.equal(report.ok, false);
    assert.ok(
      issueCodes(report).includes(
        field === "sha256" ? "BACKUP_DATABASE_DIGEST_MISMATCH" : "BACKUP_DATABASE_SIZE_MISMATCH",
      ),
      JSON.stringify(report.issues),
    );
    await assertRestoreRefused(fixture, join(fixture.root, `restored-${field}`));
  }
});

test("blob digest, size, and missing-file tampering fail verification and restore", async (t) => {
  for (const kind of ["sha256", "size", "missing"] as const) {
    const fixture = await makeBackup(t);
    let removed = "";
    mutateManifest(fixture.backupDir, (manifest) => {
      const blobs = manifest.blobs as Array<{ name: string; size: number; sha256: string }>;
      const first = blobs[0];
      assert.ok(first);
      if (kind === "sha256") first.sha256 = "f".repeat(64);
      else if (kind === "size") {
        first.size += 1;
        // Keep the manifest self-consistent so the per-file size check (not the
        // count check) is what rejects the backup.
        (manifest.counts as { blob_bytes: number }).blob_bytes += 1;
      } else removed = first.name;
    });
    if (kind === "missing") unlinkSync(join(fixture.backupDir, BACKUP_BLOB_DIR, removed));
    const report = await verifyBackup({ backupDir: fixture.backupDir });
    assert.equal(report.ok, false);
    const expected = {
      sha256: "BACKUP_BLOB_DIGEST_MISMATCH",
      size: "BACKUP_BLOB_SIZE_MISMATCH",
      missing: "BACKUP_BLOB_MISSING",
    }[kind];
    assert.ok(issueCodes(report).includes(expected), JSON.stringify(report.issues));
    await assertRestoreRefused(fixture, join(fixture.root, `restored-${kind}`));
  }
});

test("missing, malformed, and unsupported manifests are rejected", async (t) => {
  const missing = await makeBackup(t);
  unlinkSync(manifestPath(missing.backupDir));
  const missingReport = await verifyBackup({ backupDir: missing.backupDir });
  assert.deepEqual(issueCodes(missingReport), ["BACKUP_MANIFEST_MISSING"]);
  await assertRestoreRefused(missing, join(missing.root, "restored-missing"));

  const malformed = await makeBackup(t);
  writeFileSync(manifestPath(malformed.backupDir), "{not json");
  const malformedReport = await verifyBackup({ backupDir: malformed.backupDir });
  assert.deepEqual(issueCodes(malformedReport), ["BACKUP_MANIFEST_INVALID"]);

  const unsupported = await makeBackup(t);
  mutateManifest(unsupported.backupDir, (manifest) => {
    manifest.format_version = 2;
  });
  const unsupportedReport = await verifyBackup({ backupDir: unsupported.backupDir });
  assert.deepEqual(issueCodes(unsupportedReport), ["BACKUP_FORMAT_UNSUPPORTED"]);
});

test("manifest path traversal and unsafe blob names are rejected", async (t) => {
  for (const name of ["../escape", "nested/blob", ".", "..", "a\\b", ""]) {
    const fixture = await makeBackup(t);
    mutateManifest(fixture.backupDir, (manifest) => {
      const blobs = manifest.blobs as Array<{ name: string }>;
      if (blobs[0] !== undefined) blobs[0].name = name;
    });
    const report = await verifyBackup({ backupDir: fixture.backupDir });
    assert.equal(report.ok, false);
    assert.ok(issueCodes(report).includes("BACKUP_MANIFEST_INVALID"), `${name}: ${JSON.stringify(report.issues)}`);
    await assertRestoreRefused(fixture, join(fixture.root, `restored-${encodeURIComponent(name)}`));
  }
});

test("unlisted files at the top level and in the blob directory are rejected", async (t) => {
  const top = await makeBackup(t);
  writeFileSync(join(top.backupDir, "extra.txt"), "extra");
  const topReport = await verifyBackup({ backupDir: top.backupDir });
  assert.ok(issueCodes(topReport).includes("BACKUP_FILE_UNEXPECTED"));

  const blob = await makeBackup(t);
  writeFileSync(join(blob.backupDir, BACKUP_BLOB_DIR, "unlistedBlob_1234567"), "extra");
  const blobReport = await verifyBackup({ backupDir: blob.backupDir });
  assert.ok(issueCodes(blobReport).includes("BACKUP_FILE_UNEXPECTED"));
});

test("symlinked blob files are never followed and fail verification", async (t) => {
  const fixture = await makeBackup(t);
  const outside = join(fixture.root, "outside.bin");
  writeFileSync(outside, "outside");
  const blobName = readdirSync(join(fixture.backupDir, BACKUP_BLOB_DIR))[0];
  assert.ok(blobName);
  const blobPath = join(fixture.backupDir, BACKUP_BLOB_DIR, blobName);
  unlinkSync(blobPath);
  symlinkSync(outside, blobPath);
  const report = await verifyBackup({ backupDir: fixture.backupDir });
  assert.equal(report.ok, false);
  assert.ok(issueCodes(report).includes("BACKUP_ENTRY_INVALID"), JSON.stringify(report.issues));
  await assertRestoreRefused(fixture, join(fixture.root, "restored-symlink"));
});

test("backup rejects symlink and non-file blob entries and removes the partial output", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobsDir = join(dataDir, BACKUP_BLOB_DIR);
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  db.close();
  writeFileSync(join(blobsDir, "regularBlobKey_12345"), "data");
  symlinkSync(join(root, "missing-target"), join(blobsDir, "symlinkBlobKey_1234"));
  const outDir = join(root, "out");
  await assert.rejects(
    createBackup({ dataDir, outDir }),
    (error: unknown) =>
      error instanceof BackupError && error.code === "BACKUP_BLOB_ENTRY_INVALID",
  );
  assert.equal(existsSync(outDir), false);
});

test("restore refuses a symlinked target, including a dangling one", async (t) => {
  const fixture = await makeBackup(t);
  const realTarget = join(fixture.root, "real-target");
  mkdirSync(realTarget, { mode: 0o700 });
  const link = join(fixture.root, "linked-target");
  symlinkSync(realTarget, link);
  await assert.rejects(
    restoreBackup({ backupDir: fixture.backupDir, dataDir: link }),
    (error: unknown) => error instanceof RestoreError && error.code === "RESTORE_TARGET_SYMLINK",
  );
  assert.deepEqual(readdirSync(realTarget), []);

  const dangling = join(fixture.root, "dangling-target");
  symlinkSync(join(fixture.root, "does-not-exist"), dangling);
  await assert.rejects(
    restoreBackup({ backupDir: fixture.backupDir, dataDir: dangling }),
    (error: unknown) => error instanceof RestoreError && error.code === "RESTORE_TARGET_SYMLINK",
  );
});

test("verify reports cannot-inspect as an inspection error, not an issue list", async (t) => {
  const root = tempDir(t);
  await assert.rejects(
    verifyBackup({ backupDir: join(root, "absent") }),
    (error: unknown) => error instanceof BackupInspectError,
  );
  const realBackup = await makeBackup(t);
  const linked = join(root, "linked-backup");
  symlinkSync(realBackup.backupDir, linked);
  await assert.rejects(
    verifyBackup({ backupDir: linked }),
    (error: unknown) => error instanceof BackupInspectError,
  );
});

test("CLI verify exits 2 for an uninspectable backup and 1 for tampering", async (t) => {
  const fixture = await makeBackup(t);
  const missing = runCli(["verify", "--backup", join(fixture.root, "nope"), "--json"]);
  assert.equal(missing.status, 2);

  mutateManifest(fixture.backupDir, (manifest) => {
    (manifest.database as { sha256: string }).sha256 = "0".repeat(64);
  });
  const tampered = runCli(["verify", "--backup", fixture.backupDir, "--json"]);
  assert.equal(tampered.status, 1);
  assert.equal(tampered.stdout.trim().split("\n").length, 1);
  const report = JSON.parse(tampered.stdout) as { ok: boolean; issues: Array<{ code: string }> };
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === "BACKUP_DATABASE_DIGEST_MISMATCH"));

  const restoreRun = runCli(["restore", "--backup", fixture.backupDir, "--data-dir", join(fixture.root, "restored"), "--json"]);
  assert.equal(restoreRun.status, 1);
  assert.equal(restoreRun.stdout.trim().split("\n").length, 1);
  const restoreJson = JSON.parse(restoreRun.stdout) as { ok: boolean; code: string };
  assert.equal(restoreJson.ok, false);
  assert.equal(restoreJson.code, "RESTORE_VERIFY_FAILED");
  assert.equal(existsSync(join(fixture.root, "restored")), false);
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[]): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { status: failure.status ?? -1, stdout: failure.stdout ?? "", stderr: failure.stderr ?? "" };
  }
}
