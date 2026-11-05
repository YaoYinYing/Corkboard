import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import {
  BACKUP_BLOB_DIR,
  BACKUP_DATABASE_FILE,
  BACKUP_MANIFEST_FILE,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../../src/service/backup.ts";
import { authenticateBearer, type Principal, type ServiceDeps } from "../../src/service/auth.ts";
import { getMessageBody, sendMessage } from "../../src/service/messages.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));
const NOW = "2026-11-03T12:00:00.000Z";

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
  const dir = mkdtempSync(join(tmpdir(), "corkboard-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

interface Installation {
  dataDir: string;
  deps: ServiceDeps & { db: ServiceDeps["db"] & { close(): void } };
  principal: Principal;
  token: string;
  messageIds: string[];
  close(): void;
}

async function seed(dataDir: string): Promise<Installation> {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const deps: ServiceDeps = {
    db,
    blobs: new LocalBlobStore(join(dataDir, BACKUP_BLOB_DIR)),
    keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
    pepper,
    serviceId: "svc_test",
    now: () => new Date(NOW),
  };
  const token = generateSpeakerToken().token;
  const publicPrefix = token.slice(0, 12);
  await db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    ["acct_1", "owner@example.test", NOW],
  );
  await db.run(
    "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    ["spk_1", "acct_1", "Speaker", NOW],
  );
  await db.run(
    "INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at) VALUES (?, ?, ?, 'active', 0, ?)",
    ["proj_1", "acct_1", "Ops", NOW],
  );
  await db.run(
    "INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at) VALUES (?, ?, ?, ?)",
    ["proj_1", "spk_1", JSON.stringify([...SCOPES]), NOW],
  );
  await db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    ["cred_1", "spk_1", publicPrefix, await hashSecret(token, pepper), JSON.stringify([...SCOPES]), NOW],
  );
  await db.run(
    "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
    ["cred_1", "proj_1", NOW],
  );

  const principal = await authenticateBearer(deps, `Bearer ${token}`);
  const bodies = ["body-one", "body-two"];
  const messageIds: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const sent = await sendMessage(deps, principal, "proj_1", `idem-${index}`, {
      summary: `summary-${index}`,
      type: "request",
      language: "en",
      text: body,
      bodyDigest: digest(body),
    });
    messageIds.push(sent.messageId);
  }
  // Orphan blob and zero-byte value are copied exactly even though no message
  // references them.
  await deps.blobs.put("orphanBlobKey_123456", new Uint8Array([1, 2, 3]));
  await deps.blobs.put("zeroByteBlobKey_12345", new Uint8Array());

  return {
    dataDir,
    deps: deps as Installation["deps"],
    principal,
    token,
    messageIds,
    close(): void {
      db.close();
    },
  };
}

async function tableCounts(dataDir: string): Promise<Record<string, number>> {
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  try {
    const counts: Record<string, number> = {};
    for (const table of ["accounts", "projects", "speakers", "messages", "body_objects", "audit_events"]) {
      const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
      counts[table] = Number(row?.n ?? 0);
    }
    return counts;
  } finally {
    db.close();
  }
}

test("backup, verify, and restore round-trip preserves ciphertext and metadata", async (t) => {
  const root = tempDir(t);
  const installation = await seed(join(root, "data"));
  installation.close();

  const backupDir = join(root, "backup");
  const summary = await createBackup({ dataDir: installation.dataDir, outDir: backupDir });
  assert.equal(summary.ok, true);
  assert.equal(summary.blobs, 4); // two bodies + orphan + zero-byte
  assert.equal(summary.schema_version, 4);

  const manifestText = readFileSync(join(backupDir, BACKUP_MANIFEST_FILE), "utf8");
  const manifest = JSON.parse(manifestText) as {
    format: string;
    format_version: number;
    database: { file: string; size: number; sha256: string };
    blobs: Array<{ name: string; size: number; sha256: string }>;
    counts: { blobs: number; blob_bytes: number };
    schema_version: number;
    created_at: string;
  };
  assert.equal(manifest.format, "corkboard-backup");
  assert.equal(manifest.format_version, 1);
  assert.equal(manifest.database.file, BACKUP_DATABASE_FILE);
  assert.equal(manifest.schema_version, 4);
  assert.equal(manifest.counts.blobs, manifest.blobs.length);
  assert.deepEqual(
    manifest.blobs.map((blob) => blob.name),
    [...manifest.blobs.map((blob) => blob.name)].sort(),
  );
  assert.equal(manifestText.includes(root), false);
  assert.equal(manifestText.includes("body-one"), false);
  assert.equal(manifestText.includes(installation.token), false);

  // New directory modes are private, files are 0600.
  assert.equal(statSync(backupDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(backupDir, BACKUP_MANIFEST_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(join(backupDir, BACKUP_DATABASE_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(join(backupDir, BACKUP_BLOB_DIR)).mode & 0o777, 0o700);
  for (const name of readdirSync(join(backupDir, BACKUP_BLOB_DIR))) {
    assert.equal(statSync(join(backupDir, BACKUP_BLOB_DIR, name)).mode & 0o777, 0o600);
  }

  const report = await verifyBackup({ backupDir });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.equal(report.issues.length, 0);
  assert.equal(report.schema_version, 4);
  assert.equal(report.blobs?.count, 4);

  const restoredDir = join(root, "restored");
  const restored = await restoreBackup({ backupDir, dataDir: restoredDir });
  assert.equal(restored.ok, true);
  assert.equal(statSync(restoredDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(restoredDir, BACKUP_DATABASE_FILE)).mode & 0o777, 0o600);
  assert.equal(statSync(join(restoredDir, BACKUP_BLOB_DIR)).mode & 0o777, 0o700);

  // The installed database is a byte-for-byte copy; opening it through the
  // normal opener below may switch journal mode and change the header.
  assert.equal(
    createHash("sha256")
      .update(readFileSync(join(restoredDir, BACKUP_DATABASE_FILE)))
      .digest("hex"),
    manifest.database.sha256,
  );

  const sourceCounts = await tableCounts(installation.dataDir);
  const restoredCounts = await tableCounts(restoredDir);
  assert.deepEqual(restoredCounts, sourceCounts);

  // Decrypt a restored body with the original keys and verify a read.
  const restoredDb = await openSqliteDatabase(join(restoredDir, BACKUP_DATABASE_FILE));
  try {
    const deps: ServiceDeps = {
      db: restoredDb,
      blobs: new LocalBlobStore(join(restoredDir, BACKUP_BLOB_DIR)),
      keys: installation.deps.keys,
      pepper: installation.deps.pepper,
      serviceId: "svc_test",
      now: () => new Date(NOW),
    };
    const principal = await authenticateBearer(deps, `Bearer ${installation.token}`);
    const body = await getMessageBody(deps, principal, "proj_1", installation.messageIds[0] ?? "");
    assert.equal(body.text, "body-one");
    assert.equal(body.digest, digest("body-one"));
  } finally {
    restoredDb.close();
  }
});

test("restore refuses a non-empty target and leaves the source untouched", async (t) => {
  const root = tempDir(t);
  const installation = await seed(join(root, "data"));
  installation.close();
  const backupDir = join(root, "backup");
  await createBackup({ dataDir: installation.dataDir, outDir: backupDir });

  const sourceBefore = createHash("sha256")
    .update(readFileSync(join(installation.dataDir, BACKUP_DATABASE_FILE)))
    .digest("hex");
  const target = join(root, "target");
  mkdirSync(target, { mode: 0o700 });
  const existing = join(target, "keep.txt");
  writeFileSync(existing, "keep");
  await assert.rejects(
    restoreBackup({ backupDir, dataDir: target }),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "RESTORE_TARGET_NOT_EMPTY",
  );
  assert.equal(readFileSync(existing, "utf8"), "keep");
  const sourceAfter = createHash("sha256")
    .update(readFileSync(join(installation.dataDir, BACKUP_DATABASE_FILE)))
    .digest("hex");
  assert.equal(sourceAfter, sourceBefore);
});

test("a backup of an empty database and blob set round-trips", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, BACKUP_DATABASE_FILE));
  db.close();

  const backupDir = join(root, "backup");
  const summary = await createBackup({ dataDir, outDir: backupDir });
  assert.equal(summary.blobs, 0);
  assert.equal(existsSync(join(backupDir, BACKUP_BLOB_DIR)), true);
  const report = await verifyBackup({ backupDir });
  assert.equal(report.ok, true, JSON.stringify(report.issues));

  const restoredDir = join(root, "restored");
  await restoreBackup({ backupDir, dataDir: restoredDir });
  const restoredDb = await openSqliteDatabase(join(restoredDir, BACKUP_DATABASE_FILE));
  const migrations = await restoredDb.all<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version",
  );
  restoredDb.close();
  assert.equal(migrations.length, 4);
});

test("a consistent snapshot under a concurrent writer passes integrity and sequence invariants", async (t) => {
  const root = tempDir(t);
  const installation = await seed(join(root, "data"));
  let sending = true;
  let index = 0;
  let completed = 0;
  const writer = (async () => {
    while (sending && index < 200) {
      index += 1;
      const text = `concurrent-${index}`;
      try {
        await sendMessage(
          installation.deps,
          installation.principal,
          "proj_1",
          `concurrent-${index}`,
          {
            summary: `concurrent-${index}`,
            type: "request",
            language: "en",
            text,
            bodyDigest: digest(text),
          },
        );
        completed += 1;
      } catch {
        // The writer is best-effort; the snapshot is what is asserted.
      }
      // Yield to I/O so the backup's async file work interleaves.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  })();

  const backupDir = join(root, "backup");
  const completedBefore = completed;
  const summary = await createBackup({ dataDir: installation.dataDir, outDir: backupDir });
  sending = false;
  await writer;
  installation.close();

  // The writer must actually have made progress across the backup window;
  // otherwise the concurrency claim is untested.
  assert.ok(
    completed > completedBefore,
    `writer made no progress across the backup (${completedBefore} -> ${completed})`,
  );
  assert.ok(summary.blobs >= 2);
  const report = await verifyBackup({ backupDir });
  assert.equal(report.ok, true, JSON.stringify(report.issues));

  const restoredDir = join(root, "restored");
  await restoreBackup({ backupDir, dataDir: restoredDir });
  const db = await openSqliteDatabase(join(restoredDir, BACKUP_DATABASE_FILE));
  try {
    const integrity = await db.all<{ integrity_check: string }>("PRAGMA integrity_check");
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
    const duplicates = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (
         SELECT project_id, seq FROM messages
          WHERE seq IS NOT NULL
          GROUP BY project_id, seq HAVING COUNT(*) > 1
       )`,
    );
    assert.equal(Number(duplicates?.n ?? 0), 0);
    const project = await db.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = 'proj_1'",
    );
    const maxSeq = await db.first<{ seq: number | null }>(
      "SELECT MAX(seq) AS seq FROM messages WHERE project_id = 'proj_1'",
    );
    assert.ok(Number(project?.next_seq ?? 0) >= Number(maxSeq?.seq ?? 0));
    const pendingPublished = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n FROM messages
        WHERE body_state = 'ready' AND (seq IS NULL OR body_object_id IS NULL)`,
    );
    assert.equal(Number(pendingPublished?.n ?? 0), 0);
  } finally {
    db.close();
  }
});

test("CLI backup, verify, and restore emit one JSON line and use stable exit codes", async (t) => {
  const root = tempDir(t);
  const installation = await seed(join(root, "data"));
  installation.close();

  const backupDir = join(root, "backup");
  const backupRun = run([
    "backup",
    "--data-dir",
    installation.dataDir,
    "--out",
    backupDir,
    "--json",
  ]);
  assert.equal(backupRun.status, 0, backupRun.stderr);
  assert.equal(backupRun.stdout.trim().split("\n").length, 1);
  const backupJson = JSON.parse(backupRun.stdout) as { ok: boolean; blobs: number };
  assert.equal(backupJson.ok, true);
  assert.equal(backupJson.blobs, 4); // two bodies + orphan + zero-byte
  assert.equal(backupRun.stdout.includes(root), false);

  const verifyRun = run(["verify", "--backup", backupDir, "--json"]);
  assert.equal(verifyRun.status, 0, verifyRun.stderr);
  assert.equal(verifyRun.stdout.trim().split("\n").length, 1);
  const verifyJson = JSON.parse(verifyRun.stdout) as { ok: boolean; issues: unknown[] };
  assert.equal(verifyJson.ok, true);
  assert.deepEqual(verifyJson.issues, []);

  const restoredDir = join(root, "restored");
  const restoreRun = run([
    "restore",
    "--backup",
    backupDir,
    "--data-dir",
    restoredDir,
    "--json",
  ]);
  assert.equal(restoreRun.status, 0, restoreRun.stderr);
  assert.equal(restoreRun.stdout.trim().split("\n").length, 1);
  const restoreJson = JSON.parse(restoreRun.stdout) as { ok: boolean; restored: boolean };
  assert.equal(restoreJson.ok, true);
  assert.equal(restoreJson.restored, true);
  assert.equal(existsSync(join(restoredDir, BACKUP_DATABASE_FILE)), true);

  // Usage failures exit 2 before touching the filesystem and still emit one
  // JSON object in --json mode.
  const missingOut = run(["backup", "--data-dir", installation.dataDir, "--json"]);
  assert.equal(missingOut.status, 2);
  assert.equal(missingOut.stdout.trim().split("\n").length, 1);
  assert.equal((JSON.parse(missingOut.stdout) as { code: string }).code, "USAGE_ERROR");
  const missingBackup = run(["verify", "--json"]);
  assert.equal(missingBackup.status, 2);
  const missingData = run(["restore", "--backup", backupDir, "--json"]);
  assert.equal(missingData.status, 2);

  // Existing output is refused and the source remains intact.
  const second = run(["backup", "--data-dir", installation.dataDir, "--out", backupDir, "--json"]);
  assert.equal(second.status, 1);
  const secondJson = JSON.parse(second.stdout) as { ok: boolean; code: string };
  assert.equal(secondJson.ok, false);
  assert.equal(secondJson.code, "BACKUP_OUT_EXISTS");
});
