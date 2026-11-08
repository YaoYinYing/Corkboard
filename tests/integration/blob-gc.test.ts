import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));
const HOUR_MS = 60 * 60 * 1000;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-gc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function key(tag: string): string {
  return tag.padEnd(24, "0").slice(0, 24);
}

function writeBlob(blobDir: string, name: string, ageHours: number): string {
  const path = join(blobDir, name);
  writeFileSync(path, "ciphertext", { mode: 0o600 });
  const when = new Date(Date.now() - ageHours * HOUR_MS);
  utimesSync(path, when, when);
  return path;
}

async function seedRows(dataDir: string): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const timestamp = new Date(Date.now() - 48 * HOUR_MS).toISOString();
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES ('acct_1', 'owner@example.test', 'active', ?)",
      [timestamp],
    );
    await db.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES ('spk_1', 'acct_1', 'Speaker', 'active', ?)",
      [timestamp],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES ('proj_1', 'acct_1', 'Project', 'active', ?)",
      [timestamp],
    );
  } finally {
    db.close();
  }
}

async function addBodyObject(
  dataDir: string,
  id: string,
  storageKey: string,
  state: string | null,
): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    await db.run(
      `INSERT INTO body_objects (id, project_id, storage_key, state, created_at)
       VALUES (?, 'proj_1', ?, ?, ?)`,
      [id, storageKey, state, new Date(Date.now() - 48 * HOUR_MS).toISOString()],
    );
  } finally {
    db.close();
  }
}

async function addMessageAndReceipt(
  dataDir: string,
  bodyObjectId: string,
): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const timestamp = new Date(Date.now() - 48 * HOUR_MS).toISOString();
    await db.run(
      `INSERT INTO messages
         (id, project_id, seq, sender_speaker_id, summary, type, language,
          received_at, committed_at, body_state, body_object_id)
       VALUES ('msg_1', 'proj_1', 1, 'spk_1', 'summary', 'note', 'en', ?, ?, 'ready', ?)`,
      [timestamp, timestamp, bodyObjectId],
    );
    await db.run(
      "INSERT INTO message_receipts (message_id, speaker_id, read_at) VALUES ('msg_1', 'spk_1', ?)",
      [timestamp],
    );
  } finally {
    db.close();
  }
}

async function auditRows(dataDir: string): Promise<
  Array<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    project_id: string | null;
    request_id: string | null;
    operation: string;
    outcome: string;
    detail: string | null;
  }>
> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    return await db.all(
      `SELECT actor_account_id, actor_speaker_id, project_id, request_id,
              operation, outcome, detail
         FROM audit_events ORDER BY created_at, id`,
    );
  } finally {
    db.close();
  }
}

async function counts(dataDir: string): Promise<Record<string, number>> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const tables = ["messages", "message_receipts", "body_objects", "audit_events"];
    const result: Record<string, number> = {};
    for (const table of tables) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      result[table] = Number(row?.n ?? 0);
    }
    return result;
  } finally {
    db.close();
  }
}

function createBlobDir(dataDir: string): string {
  const blobDir = join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  return blobDir;
}

test("gc-blobs is a dry run by default and deletes nothing", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seedRows(dataDir);
  const blobDir = createBlobDir(dataDir);

  const orphan = key("orphan_old");
  const referenced = key("referenced_old");
  const recent = key("recent_unreferenced");
  writeBlob(blobDir, orphan, 48);
  writeBlob(blobDir, referenced, 48);
  writeBlob(blobDir, recent, 0);
  await addBodyObject(dataDir, "obj_ref", referenced, "ready");

  const result = run(["gc-blobs", "--json"], { CORKBOARD_DATA_DIR: dataDir });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    dryRun: true,
    graceHours: 24,
    limit: 1000,
    candidates: 1,
    deleted: 0,
    failed: 0,
    skippedRecent: 1,
    skippedReferenced: 1,
  });
  assert.equal(result.stdout.includes(orphan), false);

  for (const name of [orphan, referenced, recent]) {
    assert.equal(existsSync(join(blobDir, name)), true, `${name} must survive`);
  }
  assert.equal((await auditRows(dataDir)).length, 0, "dry run writes no audit row");
});

test("gc-blobs --apply deletes only old unreferenced regular files and audits once", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seedRows(dataDir);
  const blobDir = createBlobDir(dataDir);

  const orphan = key("orphan_old");
  const referenced = key("referenced_old");
  const recent = key("recent_unreferenced");
  writeBlob(blobDir, orphan, 48);
  writeBlob(blobDir, referenced, 48);
  writeBlob(blobDir, recent, 0);
  await addBodyObject(dataDir, "obj_ref", referenced, "ready");
  await addMessageAndReceipt(dataDir, "obj_ref");
  const before = await counts(dataDir);

  const first = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout.trim()), {
    dryRun: false,
    graceHours: 24,
    limit: 1000,
    candidates: 1,
    deleted: 1,
    failed: 0,
    skippedRecent: 1,
    skippedReferenced: 1,
  });
  assert.equal(first.stdout.includes(orphan), false);
  assert.equal(existsSync(join(blobDir, orphan)), false);
  assert.equal(existsSync(join(blobDir, referenced)), true);
  assert.equal(existsSync(join(blobDir, recent)), true);

  const audits = await auditRows(dataDir);
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    actor_account_id: null,
    actor_speaker_id: null,
    project_id: null,
    request_id: null,
    operation: "blob.orphan_prune",
    outcome: "success",
    detail: JSON.stringify({ graceHours: 24, limit: 1000, deleted: 1, failed: 0 }),
  });

  const after = await counts(dataDir);
  assert.equal(after.messages, before.messages);
  assert.equal(after.message_receipts, before.message_receipts);
  assert.equal(after.body_objects, before.body_objects);

  // A second run has nothing to delete and writes no further audit row.
  const second = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim()), {
    dryRun: false,
    graceHours: 24,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 1,
    skippedReferenced: 1,
  });
  assert.equal((await auditRows(dataDir)).length, 1);
});

test("gc-blobs ignores invalid names, directories, and symlinks", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobDir = createBlobDir(dataDir);

  writeBlob(blobDir, "not-a-valid-key!.txt", 48);
  const directoryKey = key("directory_as_key");
  mkdirSync(join(blobDir, directoryKey));
  const outside = join(root, "outside.txt");
  writeFileSync(outside, "outside");
  const symlinkKey = key("symlink_as_key");
  symlinkSync(outside, join(blobDir, symlinkKey));

  const result = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    dryRun: false,
    graceHours: 24,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
  });

  assert.equal(existsSync(join(blobDir, "not-a-valid-key!.txt")), true);
  assert.equal(existsSync(join(blobDir, directoryKey)), true);
  assert.equal(existsSync(join(blobDir, symlinkKey)), true);
  assert.equal(existsSync(outside), true);
  assert.equal((await auditRows(dataDir)).length, 0);
});

test("gc-blobs respects --limit and a rerun collects the remainder", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobDir = createBlobDir(dataDir);

  const names = [key("limit_orphan_1"), key("limit_orphan_2"), key("limit_orphan_3")];
  for (const name of names) writeBlob(blobDir, name, 48);

  const first = run([
    "gc-blobs",
    "--data-dir",
    dataDir,
    "--json",
    "--apply",
    "--limit",
    "2",
  ]);
  assert.equal(first.status, 0, first.stderr);
  const summary = JSON.parse(first.stdout.trim()) as Record<string, unknown>;
  assert.equal(summary.candidates, 2);
  assert.equal(summary.deleted, 2);
  assert.equal(summary.failed, 0);
  assert.equal(
    readdirSync(blobDir).filter((name) => names.includes(name)).length,
    1,
  );

  const second = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    (JSON.parse(second.stdout.trim()) as Record<string, unknown>).deleted,
    1,
  );
  assert.equal(
    readdirSync(blobDir).filter((name) => names.includes(name)).length,
    0,
  );
});

test("gc-blobs treats every body_objects state as a reference", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seedRows(dataDir);
  const blobDir = createBlobDir(dataDir);

  const states: Array<string | null> = ["pending", "expired", "failed", "deleted", null];
  for (const [index, state] of states.entries()) {
    const name = key(`state_reference_${index}`);
    writeBlob(blobDir, name, 48);
    await addBodyObject(dataDir, `obj_state_${index}`, name, state);
  }

  const result = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim()) as Record<string, unknown>;
  assert.equal(summary.candidates, 0);
  assert.equal(summary.deleted, 0);
  assert.equal(summary.skippedReferenced, states.length);
  assert.equal(readdirSync(blobDir).length, states.length);
  assert.equal((await auditRows(dataDir)).length, 0);
});

test("gc-blobs keeps the summary and exits 1 when the audit insert fails", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobDir = createBlobDir(dataDir);
  const orphan = key("audit_fail_orphan");
  writeBlob(blobDir, orphan, 48);

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    await db.exec(
      `CREATE TRIGGER fail_blob_gc_audit BEFORE INSERT ON audit_events
       BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
    );
  } finally {
    db.close();
  }

  const result = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /blob GC audit event could not be written/);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    dryRun: false,
    graceHours: 24,
    limit: 1000,
    candidates: 1,
    deleted: 1,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
    auditFailed: true,
  });
  // The deletion stands; nothing is rolled back.
  assert.equal(existsSync(join(blobDir, orphan)), false);
  assert.equal((await auditRows(dataDir)).length, 0);
});

test("gc-blobs reports a delete failure and exits 1 without claiming rollback", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobDir = createBlobDir(dataDir);
  const orphan = key("delete_fail_orphan");
  writeBlob(blobDir, orphan, 48);

  chmodSync(blobDir, 0o500);
  try {
    const result = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
    assert.equal(result.status, 1, result.stderr);
    // Exact summary: no restoration/rollback claim field, only per-file counts.
    assert.deepEqual(JSON.parse(result.stdout.trim()), {
      dryRun: false,
      graceHours: 24,
      limit: 1000,
      candidates: 1,
      deleted: 0,
      failed: 1,
      skippedRecent: 0,
      skippedReferenced: 0,
    });
    assert.equal(existsSync(join(blobDir, orphan)), true);
    assert.equal((await auditRows(dataDir)).length, 0);
  } finally {
    chmodSync(blobDir, 0o700);
  }
});

test("gc-blobs honors a custom --grace-hours threshold", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const blobDir = createBlobDir(dataDir);
  const orphan = key("grace_orphan");
  writeBlob(blobDir, orphan, 2);

  const tooYoung = run([
    "gc-blobs",
    "--data-dir",
    dataDir,
    "--json",
    "--apply",
    "--grace-hours",
    "3",
  ]);
  assert.equal(tooYoung.status, 0, tooYoung.stderr);
  const guarded = JSON.parse(tooYoung.stdout.trim()) as Record<string, unknown>;
  assert.equal(guarded.graceHours, 3);
  assert.equal(guarded.deleted, 0);
  assert.equal(guarded.skippedRecent, 1);
  assert.equal(existsSync(join(blobDir, orphan)), true);

  const oldEnough = run([
    "gc-blobs",
    "--data-dir",
    dataDir,
    "--json",
    "--apply",
    "--grace-hours",
    "1",
  ]);
  assert.equal(oldEnough.status, 0, oldEnough.stderr);
  const collected = JSON.parse(oldEnough.stdout.trim()) as Record<string, unknown>;
  assert.equal(collected.graceHours, 1);
  assert.equal(collected.deleted, 1);
  assert.equal(collected.skippedRecent, 0);
  assert.equal(existsSync(join(blobDir, orphan)), false);
});

test("gc-blobs human output prints counts only", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seedRows(dataDir);
  const blobDir = createBlobDir(dataDir);
  const orphan = key("human_orphan");
  const referenced = key("human_referenced");
  writeBlob(blobDir, orphan, 48);
  writeBlob(blobDir, referenced, 48);
  await addBodyObject(dataDir, "obj_human", referenced, "ready");

  const result = run(["gc-blobs", "--data-dir", dataDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^mode: dry-run$/m);
  assert.match(result.stdout, /^orphan candidates: 1$/m);
  assert.match(result.stdout, /^deleted: 0$/m);
  assert.match(result.stdout, /^skipped referenced: 1$/m);
  assert.equal(result.stdout.includes(orphan), false);
  assert.equal(result.stdout.includes(dataDir), false);
});

test("gc-blobs dry run initializes a fresh data directory and writes no audit", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "fresh");
  assert.equal(existsSync(dataDir), false);

  const dry = run(["gc-blobs", "--data-dir", dataDir, "--json"]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.deepEqual(JSON.parse(dry.stdout.trim()), {
    dryRun: true,
    graceHours: 24,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
  });
  assert.equal(existsSync(dataDir), true);
  assert.equal(existsSync(join(dataDir, "corkboard.sqlite")), true);

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.ok(versions.length > 0, "dry run applies migrations");
  } finally {
    db.close();
  }
  assert.equal((await auditRows(dataDir)).length, 0);
  assert.equal(existsSync(join(dataDir, "blobs")), false);

  // A later --apply against the initialized directory behaves normally.
  const blobDir = createBlobDir(dataDir);
  const orphan = key("fresh_orphan");
  writeBlob(blobDir, orphan, 48);
  const applied = run(["gc-blobs", "--data-dir", dataDir, "--json", "--apply"]);
  assert.equal(applied.status, 0, applied.stderr);
  const summary = JSON.parse(applied.stdout.trim()) as Record<string, unknown>;
  assert.equal(summary.deleted, 1);
  assert.equal(existsSync(join(blobDir, orphan)), false);
  assert.equal((await auditRows(dataDir)).length, 1);
});

test("gc-blobs rejects a data-dir that is a regular file without leaking its path", (t) => {
  const root = tempDir(t);
  const dataPath = join(root, "not-a-directory");
  writeFileSync(dataPath, "x", { mode: 0o600 });

  const result = run(["gc-blobs", "--data-dir", dataPath, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(dataPath), false);
  assert.match(
    result.stderr,
    /data directory or database could not be opened or is not usable/,
  );
});

test("gc-blobs rejects a regular-file blobs path without leaking it", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const blobPath = join(dataDir, "blobs");
  writeFileSync(blobPath, "x", { mode: 0o600 });

  const result = run(["gc-blobs", "--data-dir", dataDir, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(blobPath), false);
  assert.equal(result.stderr.includes(dataDir), false);
  assert.match(
    result.stderr,
    /data directory or database could not be opened or is not usable/,
  );
});

test("gc-blobs rejects a symlinked blobs path without leaking it", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const outside = join(root, "outside-blobs");
  mkdirSync(outside);
  symlinkSync(outside, join(dataDir, "blobs"));

  const result = run(["gc-blobs", "--data-dir", dataDir, "--json"]);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes(dataDir), false);
  assert.equal(result.stderr.includes(outside), false);
  assert.match(
    result.stderr,
    /data directory or database could not be opened or is not usable/,
  );
});

test("gc-blobs rejects usage/config errors with exit 2 before creating the data dir", (t) => {
  const root = tempDir(t);
  const fresh = join(root, "never-created");

  for (const args of [
    ["gc-blobs", "--data-dir", fresh, "--grace-hours", "0"],
    ["gc-blobs", "--data-dir", fresh, "--grace-hours", "8761"],
    ["gc-blobs", "--data-dir", fresh, "--grace-hours", "1.5"],
    ["gc-blobs", "--data-dir", fresh, "--grace-hours", "NaN"],
    ["gc-blobs", "--data-dir", fresh, "--limit", "0"],
    ["gc-blobs", "--data-dir", fresh, "--limit", "10001"],
    ["gc-blobs", "--data-dir", fresh, "--unknown-option"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(fresh), false, "validation must run before any mkdir/open");

  const missing = run(["gc-blobs"], { CORKBOARD_DATA_DIR: "" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /data-dir|CORKBOARD_DATA_DIR/);
});
