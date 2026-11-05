import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { redactPaths } from "../../scripts/corkboard.ts";

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
    // Enough rows to make page 3 a corruptible b-tree page in the snapshot.
    for (let index = 0; index < 300; index += 1) {
      await db.run(
        "INSERT INTO audit_events (id, operation, outcome, created_at) VALUES (?, 'test', 'success', ?)",
        [`evt_${index}`, NOW],
      );
    }
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

function refreshManifestDatabase(backupDir: string): void {
  const bytes = readFileSync(join(backupDir, BACKUP_DATABASE_FILE));
  mutateManifest(backupDir, (manifest) => {
    const database = manifest.database as { size: number; sha256: string };
    database.size = bytes.length;
    database.sha256 = createHash("sha256").update(bytes).digest("hex");
  });
}

function rewriteManifest(backupDir: string, manifest: Record<string, unknown>): void {
  writeFileSync(manifestPath(backupDir), JSON.stringify(manifest));
}

function readManifest(backupDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(manifestPath(backupDir), "utf8")) as Record<string, unknown>;
}

function stagingDirs(parent: string, targetName: string): string[] {
  return readdirSync(parent).filter((name) => name.startsWith(`.${targetName}.restore-`));
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
  assert.equal(missing.stdout.trim().split("\n").length, 1);
  const missingJson = JSON.parse(missing.stdout) as { ok: boolean; code: string };
  assert.equal(missingJson.ok, false);
  assert.equal(missingJson.code, "BACKUP_INSPECT_FAILED");
  assert.equal(missing.stderr.includes(fixture.root), false);

  const positional = runCli(["verify", "--backup", fixture.backupDir, "extra", "--json"]);
  assert.equal(positional.status, 2);
  assert.equal(positional.stdout.trim().split("\n").length, 1);
  const positionalJson = JSON.parse(positional.stdout) as { ok: boolean; code: string };
  assert.equal(positionalJson.ok, false);
  assert.equal(positionalJson.code, "USAGE_ERROR");

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

test("backup never creates source WAL sidecars and succeeds on a read-only source directory", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobsDir = join(dataDir, BACKUP_BLOB_DIR);
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  await db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    ["acct_1", "owner@example.test", NOW],
  );
  db.close();

  const before = readdirSync(dataDir).sort();
  assert.equal(before.includes(`${BACKUP_DATABASE_FILE}-wal`), false);
  assert.equal(before.includes(`${BACKUP_DATABASE_FILE}-shm`), false);

  chmodSync(dataDir, 0o500);
  chmodSync(blobsDir, 0o500);

  const outDir = join(root, "out");
  let summary;
  try {
    summary = await createBackup({ dataDir, outDir });
  } finally {
    chmodSync(dataDir, 0o700);
    chmodSync(blobsDir, 0o700);
  }
  assert.equal(summary.ok, true);

  assert.deepEqual(readdirSync(dataDir).sort(), before);
  assert.equal(existsSync(join(dataDir, `${BACKUP_DATABASE_FILE}-wal`)), false);
  assert.equal(existsSync(join(dataDir, `${BACKUP_DATABASE_FILE}-shm`)), false);
  assert.equal(existsSync(join(outDir, BACKUP_MANIFEST_FILE)), true);
});

test("backup refuses a lone WAL sidecar without creating another", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  db.close();
  writeFileSync(join(dataDir, `${BACKUP_DATABASE_FILE}-wal`), new Uint8Array());

  const outDir = join(root, "out");
  await assert.rejects(
    createBackup({ dataDir, outDir }),
    (error: unknown) => error instanceof BackupError && error.code === "BACKUP_SNAPSHOT_FAILED",
  );
  assert.equal(existsSync(outDir), false);
  assert.equal(existsSync(join(dataDir, `${BACKUP_DATABASE_FILE}-shm`)), false);
});

test("a manifest omitting a referenced blob is refused by verify and restore", async (t) => {
  const fixture = await makeBackup(t);
  mutateManifest(fixture.backupDir, (manifest) => {
    const blobs = manifest.blobs as Array<{ name: string; size: number }>;
    const removed = blobs.find((blob) => blob.name === REFERENCED_ZERO);
    assert.ok(removed);
    manifest.blobs = blobs.filter((blob) => blob.name !== REFERENCED_ZERO);
    const counts = manifest.counts as { blobs: number; blob_bytes: number };
    counts.blobs -= 1;
    counts.blob_bytes -= removed.size;
  });
  unlinkSync(join(fixture.backupDir, BACKUP_BLOB_DIR, REFERENCED_ZERO));

  const report = await verifyBackup({ backupDir: fixture.backupDir });
  assert.ok(issueCodes(report).includes("BACKUP_BLOB_REFERENCED_MISSING"), JSON.stringify(report.issues));
  await assertRestoreRefused(fixture, join(fixture.root, "restored-referenced"));
});

test("restore re-checks referenced blobs against staged bytes and cleans staging", async (t) => {
  const fixture = await makeBackup(t);
  const target = join(fixture.root, "target");
  await assert.rejects(
    restoreBackup({
      backupDir: fixture.backupDir,
      dataDir: target,
      hooks: {
        async afterCopy(stagingDir: string): Promise<void> {
          const db = new DatabaseSync(join(stagingDir, BACKUP_DATABASE_FILE));
          try {
            db.prepare(
              "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, 'proj_1', ?, 'ready', ?)",
            ).run("body_staged_missing", "absentBlobKey_123456", NOW);
          } finally {
            db.close();
          }
        },
      },
    }),
    (error: unknown) =>
      error instanceof RestoreError && error.code === "RESTORE_BLOB_REFERENCED_MISSING",
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(stagingDirs(fixture.root, "target"), []);
});

test("restore cleans staging after a mid-copy failure", async (t) => {
  const fixture = await makeBackup(t);
  const target = join(fixture.root, "copy-target");
  await assert.rejects(
    restoreBackup({
      backupDir: fixture.backupDir,
      dataDir: target,
      hooks: {
        async afterVerify(): Promise<void> {
          unlinkSync(join(fixture.backupDir, BACKUP_BLOB_DIR, ORPHAN));
        },
      },
    }),
    (error: unknown) => error instanceof RestoreError && error.code === "RESTORE_COPY_MISMATCH",
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(stagingDirs(fixture.root, "copy-target"), []);
});

test("backup refuses a schema newer than bundled and a missing referenced blob", async (t) => {  const root = tempDir(t);
  const aheadDir = join(root, "ahead");
  mkdirSync(aheadDir, { mode: 0o700 });
  const aheadDb = await openSqliteDatabase(join(aheadDir, BACKUP_DATABASE_FILE));
  await aheadDb.run(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (999, ?)",
    [NOW],
  );
  aheadDb.close();
  const aheadOut = join(root, "ahead-out");
  await assert.rejects(
    createBackup({ dataDir: aheadDir, outDir: aheadOut }),
    (error: unknown) => error instanceof BackupError && error.code === "BACKUP_SCHEMA_AHEAD",
  );
  assert.equal(existsSync(aheadOut), false);

  const missingDir = join(root, "missing");
  mkdirSync(missingDir, { mode: 0o700 });
  const missingDb = await openSqliteDatabase(join(missingDir, BACKUP_DATABASE_FILE));
  await missingDb.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    ["acct_1", "owner@example.test", NOW],
  );
  await missingDb.run(
    "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ["proj_1", "acct_1", "Ops", NOW],
  );
  await missingDb.run(
    "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, ?, ?, 'ready', ?)",
    ["body_1", "proj_1", "absentBlobKey_123456", NOW],
  );
  missingDb.close();
  const missingOut = join(root, "missing-out");
  await assert.rejects(
    createBackup({ dataDir: missingDir, outDir: missingOut }),
    (error: unknown) =>
      error instanceof BackupError && error.code === "BACKUP_BLOB_REFERENCED_MISSING",
  );
  assert.equal(existsSync(missingOut), false);
});

test("verify rejects a schema mismatch and a schema newer than bundled", async (t) => {
  const mismatch = await makeBackup(t);
  mutateManifest(mismatch.backupDir, (manifest) => {
    manifest.schema_version = 3;
  });
  const mismatchReport = await verifyBackup({ backupDir: mismatch.backupDir });
  assert.ok(issueCodes(mismatchReport).includes("BACKUP_SCHEMA_MISMATCH"), JSON.stringify(mismatchReport.issues));

  const ahead = await makeBackup(t);
  const aheadDb = new DatabaseSync(join(ahead.backupDir, BACKUP_DATABASE_FILE));
  try {
    aheadDb.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (999, ?)").run(NOW);
  } finally {
    aheadDb.close();
  }
  refreshManifestDatabase(ahead.backupDir);
  mutateManifest(ahead.backupDir, (manifest) => {
    manifest.schema_version = 999;
  });
  const aheadReport = await verifyBackup({ backupDir: ahead.backupDir });
  assert.ok(issueCodes(aheadReport).includes("BACKUP_SCHEMA_AHEAD"), JSON.stringify(aheadReport.issues));
  await assertRestoreRefused(ahead, join(ahead.root, "restored-ahead"));
});

test("restore refuses a staged schema newer than the build and cleans staging", async (t) => {
  const fixture = await makeBackup(t);
  const target = join(fixture.root, "schema-target");
  await assert.rejects(
    restoreBackup({
      backupDir: fixture.backupDir,
      dataDir: target,
      hooks: {
        async afterCopy(stagingDir: string): Promise<void> {
          const db = new DatabaseSync(join(stagingDir, BACKUP_DATABASE_FILE));
          try {
            db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (999, ?)").run(NOW);
          } finally {
            db.close();
          }
        },
      },
    }),
    (error: unknown) =>
      error instanceof RestoreError && error.code === "RESTORE_SCHEMA_UNSUPPORTED",
  );
  assert.equal(existsSync(target), false);
  assert.deepEqual(stagingDirs(fixture.root, "schema-target"), []);
});

test("verify distinguishes an unreadable database from an integrity failure", async (t) => {
  const unreadable = await makeBackup(t);
  const unreadablePath = join(unreadable.backupDir, BACKUP_DATABASE_FILE);
  const unreadableSize = statSync(unreadablePath).size;
  writeFileSync(unreadablePath, Buffer.alloc(unreadableSize, 0x41));
  refreshManifestDatabase(unreadable.backupDir);
  const unreadableReport = await verifyBackup({ backupDir: unreadable.backupDir });
  assert.ok(
    issueCodes(unreadableReport).includes("BACKUP_DATABASE_UNREADABLE"),
    JSON.stringify(unreadableReport.issues),
  );

  const corrupted = await makeBackup(t);
  const corruptedPath = join(corrupted.backupDir, BACKUP_DATABASE_FILE);
  // Build a controlled multi-page database so a b-tree page corruption is
  // reproducible; the VACUUM output's page layout is not guaranteed.
  rmSync(corruptedPath, { force: true });
  const controlled = new DatabaseSync(corruptedPath);
  try {
    controlled.exec("PRAGMA journal_mode=DELETE");
    controlled.exec("PRAGMA page_size=4096");
    controlled.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
    const insert = controlled.prepare("INSERT INTO t(v) VALUES (?)");
    for (let index = 0; index < 400; index += 1) insert.run(`x${index}`);
  } finally {
    controlled.close();
  }
  const original = readFileSync(corruptedPath);
  // SQLite page layout varies, so find a b-tree page corruption that makes
  // `PRAGMA integrity_check` return errors (rather than failing to open).
  const candidates: number[] = [];
  for (let page = 2; page <= 8; page += 1) {
    for (const offset of [8, 20, 64]) candidates.push((page - 1) * 4096 + offset);
  }
  let integrityReported = false;
  for (const offset of candidates) {
    if (offset + 4 > original.length) continue;
    const bytes = Buffer.from(original);
    bytes.writeUInt32BE(0xffffffff, offset);
    writeFileSync(corruptedPath, bytes);
    refreshManifestDatabase(corrupted.backupDir);
    const report = await verifyBackup({ backupDir: corrupted.backupDir });
    if (issueCodes(report).includes("BACKUP_DATABASE_INTEGRITY_FAILED")) {
      integrityReported = true;
      break;
    }
  }
  assert.ok(integrityReported, "no page corruption produced an integrity_check failure");
});

test("restore refuses a target inside the backup and backup refuses an output inside the source", async (t) => {
  const fixture = await makeBackup(t);
  await assert.rejects(
    restoreBackup({
      backupDir: fixture.backupDir,
      dataDir: join(fixture.backupDir, "inside"),
    }),
    (error: unknown) =>
      error instanceof RestoreError && error.code === "RESTORE_TARGET_INSIDE_BACKUP",
  );

  await assert.rejects(
    createBackup({ dataDir: fixture.dataDir, outDir: join(fixture.dataDir, "backup-inside") }),
    (error: unknown) => error instanceof BackupError && error.code === "BACKUP_OUT_INSIDE_SOURCE",
  );
  assert.equal(existsSync(join(fixture.dataDir, "backup-inside")), false);
});

test("backup and verify bound per-file and total blob bytes before hashing", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "sparse-data");
  const blobsDir = join(dataDir, BACKUP_BLOB_DIR);
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  db.close();
  const sparsePath = join(blobsDir, "sparseBlobKey_123456");
  writeFileSync(sparsePath, new Uint8Array());
  truncateSync(sparsePath, 1024 ** 4);
  const outDir = join(root, "sparse-out");
  await assert.rejects(
    createBackup({ dataDir, outDir }),
    (error: unknown) => error instanceof BackupError && error.code === "BACKUP_BLOB_TOO_LARGE",
  );
  assert.equal(existsSync(outDir), false);

  const perFile = await makeBackup(t);
  mutateManifest(perFile.backupDir, (manifest) => {
    const blobs = manifest.blobs as Array<{ size: number }>;
    const first = blobs[0];
    assert.ok(first);
    const previous = first.size;
    first.size = 20000;
    (manifest.counts as { blob_bytes: number }).blob_bytes += 20000 - previous;
  });
  const perFileReport = await verifyBackup({ backupDir: perFile.backupDir });
  assert.ok(issueCodes(perFileReport).includes("BACKUP_FILE_TOO_LARGE"), JSON.stringify(perFileReport.issues));

  const total = await makeBackup(t);
  const manifest = readManifest(total.backupDir);
  const entryCount = 65537;
  const entrySize = 16 * 1024;
  manifest.blobs = Array.from({ length: entryCount }, (_, index) => ({
    name: `blob_${index.toString().padStart(6, "0")}`,
    size: entrySize,
    sha256: "0".repeat(64),
  }));
  manifest.counts = { blobs: entryCount, blob_bytes: entryCount * entrySize };
  rewriteManifest(total.backupDir, manifest);
  const totalReport = await verifyBackup({ backupDir: total.backupDir });
  assert.ok(
    issueCodes(totalReport).includes("BACKUP_TOTAL_BYTES_EXCEEDED"),
    JSON.stringify(totalReport.issues.slice(0, 5)),
  );
});

test("an oversized source database is rejected before the snapshot writes output", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "oversized-db");
  mkdirSync(dataDir, { mode: 0o700 });
  const sourcePath = join(dataDir, BACKUP_DATABASE_FILE);
  writeFileSync(sourcePath, new Uint8Array());
  truncateSync(sourcePath, 16 * 1024 ** 3 + 1);
  const outDir = join(root, "oversized-out");
  await assert.rejects(
    createBackup({ dataDir, outDir }),
    (error: unknown) =>
      error instanceof BackupError && error.code === "BACKUP_DATABASE_TOO_LARGE",
  );
  assert.equal(existsSync(outDir), false);
});

test("redacts quoted absolute paths including embedded spaces and controls", () => {
  const message = "EACCES: permission denied, mkdir '/home/x/My Secret Project/out'";
  const redacted = redactPaths(message);
  assert.equal(redacted.includes("Secret Project"), false);
  assert.equal(redacted.includes("/home/x"), false);
  assert.ok(redacted.includes("<path>"));
  assert.equal(
    redactPaths("open /home/x/plain/out failed").includes("/home/x"),
    false,
  );
  assert.equal(
    redactPaths('open "/home/x/Two Words/out" failed').includes("Two Words"),
    false,
  );
});

test("CLI stderr redacts a generic error path containing spaces", { skip: process.getuid?.() === 0 }, async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  db.close();
  const parent = join(root, "My Secret Project");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o500);
  try {
    const run = runCli([
      "backup",
      "--data-dir",
      dataDir,
      "--out",
      join(parent, "out"),
      "--json",
    ]);
    assert.equal(run.status, 1);
    assert.equal(run.stderr.includes("Secret Project"), false);
    assert.equal(run.stderr.includes(root), false);
    assert.ok(run.stderr.includes("<path>"), run.stderr);
    const failure = JSON.parse(run.stdout) as { ok: boolean; code: string };
    assert.equal(failure.ok, false);
    assert.equal(failure.code, "BACKUP_FAILED");
  } finally {
    chmodSync(parent, 0o700);
  }
});

test("verify bounds directory listings and reports an entry-limit issue", async (t) => {
  const fixture = await makeBackup(t);
  const blobDir = join(fixture.backupDir, BACKUP_BLOB_DIR);
  for (let index = 0; index <= 100_000; index += 1) {
    writeFileSync(join(blobDir, `overflow_${index}`), new Uint8Array());
  }
  const report = await verifyBackup({ backupDir: fixture.backupDir });
  assert.equal(report.ok, false);
  assert.ok(
    issueCodes(report).includes("BACKUP_ENTRY_LIMIT_EXCEEDED"),
    JSON.stringify(report.issues.slice(0, 5)),
  );
});

test("human verify output escapes control bytes in unexpected filenames", async (t) => {
  const fixture = await makeBackup(t);
  writeFileSync(
    join(fixture.backupDir, BACKUP_BLOB_DIR, "\u001b[31mevil"),
    new Uint8Array(),
  );
  const run = runCli(["verify", "--backup", fixture.backupDir]);
  assert.equal(run.status, 1);
  assert.equal(run.stdout.includes("\u001b"), false);
  assert.ok(run.stdout.includes("BACKUP_FILE_UNEXPECTED"), run.stdout);
});
