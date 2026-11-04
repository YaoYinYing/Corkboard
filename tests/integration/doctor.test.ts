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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { authenticateBearer, type ServiceDeps } from "../../src/service/auth.ts";
import {
  formatDoctorReport,
  runDoctor,
  type DoctorReport,
} from "../../src/service/doctor.ts";
import { markRead, sendMessage } from "../../src/service/messages.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import {
  openSqliteDatabase,
  openSqliteDatabaseReadOnly,
} from "../../src/storage/db.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const sourceCli = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));
const builtCli = join(repoRoot, "dist", "scripts", "corkboard.js");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(
  cli: string,
  args: string[],
  env: Record<string, string>,
): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [cli, ...args], {
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
  const dir = mkdtempSync(join(tmpdir(), "corkboard-doctor-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function validKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

function keyEnv(): Record<string, string> {
  return {
    CORKBOARD_ROOT_KEY: validKey(),
    CORKBOARD_CREDENTIAL_PEPPER: validKey(),
  };
}

function withoutCorkboardEnv(env: Record<string, string>): Record<string, string> {
  const copy: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const name of [
    "CORKBOARD_ROOT_KEY",
    "CORKBOARD_CREDENTIAL_PEPPER",
    "CORKBOARD_DATA_DIR",
  ]) {
    delete copy[name];
  }
  return { ...copy, ...env };
}

const SUMMARY = "TOP-SECRET-SUMMARY";
const BODY = "TOP-SECRET-BODY";
const KEY_A = "A".repeat(20);

interface SeedOptions {
  expiredState?: string | null;
  missingReferencedKey?: boolean;
  orphanKey?: string;
  stuckCount?: number;
}

async function seed(dataDir: string, options: SeedOptions): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  const timestamp = "2026-11-03T12:00:00.000Z";
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      ["acct_1", "owner@example.test", timestamp],
    );
    await db.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      ["spk_1", "acct_1", "Speaker", timestamp],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at) VALUES (?, ?, ?, 'active', 3, ?)",
      ["proj_1", "acct_1", "Ops", timestamp],
    );
    await db.run(
      "INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at) VALUES (?, ?, '[]', ?)",
      ["proj_1", "spk_1", timestamp],
    );
    await db.run(
      "INSERT INTO credentials (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at) VALUES (?, ?, ?, ?, '[]', ?)",
      ["cred_1", "spk_1", "cb_prefix000", "verifier", timestamp],
    );
    await db.run(
      "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
      ["cred_1", "proj_1", timestamp],
    );

    await db.run(
      "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, ?, ?, 'ready', ?)",
      ["obj_ready", "proj_1", KEY_A, timestamp],
    );
    await db.run(
      `INSERT INTO messages
         (id, project_id, seq, sender_speaker_id, summary, type, language,
          received_at, committed_at, body_state, body_object_id)
       VALUES (?, ?, 1, ?, ?, 'request', 'en', ?, ?, 'ready', ?)`,
      ["msg_ready", "proj_1", "spk_1", SUMMARY, timestamp, timestamp, "obj_ready"],
    );
    await db.run(
      "INSERT INTO message_receipts (message_id, speaker_id, read_at) VALUES (?, ?, ?)",
      ["msg_ready", "spk_1", timestamp],
    );

    if (options.expiredState !== undefined) {
      await db.run(
        "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          "obj_expired",
          "proj_1",
          options.missingReferencedKey === true ? "M".repeat(20) : "E".repeat(20),
          options.expiredState,
          timestamp,
        ],
      );
      await db.run(
        `INSERT INTO messages
           (id, project_id, seq, sender_speaker_id, summary, type, language,
            received_at, committed_at, body_state, body_object_id)
         VALUES (?, ?, 2, ?, ?, 'request', 'en', ?, ?, 'expired', ?)`,
        [
          "msg_expired",
          "proj_1",
          "spk_1",
          SUMMARY,
          timestamp,
          timestamp,
          "obj_expired",
        ],
      );
    }

    const stuckCount = options.stuckCount ?? 0;
    for (let index = 0; index < stuckCount; index += 1) {
      await db.run(
        `INSERT INTO messages
           (id, project_id, sender_speaker_id, summary, type, language, received_at, body_state)
         VALUES (?, ?, ?, ?, 'request', 'en', ?, 'pending')`,
        [`msg_stuck_${index}`, "proj_1", "spk_1", SUMMARY, "2020-01-01T00:00:00.000Z"],
      );
    }
  } finally {
    db.close();
  }

  const blobsDir = join(dataDir, "blobs");
  mkdirSync(blobsDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(blobsDir, KEY_A), BODY);
  if (options.expiredState !== undefined && options.missingReferencedKey !== true) {
    writeFileSync(join(blobsDir, "E".repeat(20)), BODY);
  }
  if (options.orphanKey !== undefined) {
    writeFileSync(join(blobsDir, options.orphanKey), BODY);
  }
}

// Provision through the real service so the "clean" counts reflect a message that
// was actually sent and read, including the blob written by LocalBlobStore.
async function seedSentAndRead(dataDir: string): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const timestamp = "2026-11-03T12:00:00.000Z";
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      ["acct_1", "owner@example.test", timestamp],
    );
    await db.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      ["spk_1", "acct_1", "Speaker", timestamp],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at) VALUES (?, ?, ?, 'active', 0, ?)",
      ["proj_1", "acct_1", "Ops", timestamp],
    );
    await db.run(
      "INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at) VALUES (?, ?, ?, ?)",
      ["proj_1", "spk_1", JSON.stringify(SCOPES), timestamp],
    );
    const { token } = generateSpeakerToken();
    await db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        "cred_1",
        "spk_1",
        token.slice(0, 12),
        await hashSecret(token, pepper),
        JSON.stringify(SCOPES),
        timestamp,
      ],
    );
    await db.run(
      "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
      ["cred_1", "proj_1", timestamp],
    );

    const deps: ServiceDeps = {
      db,
      blobs: new LocalBlobStore(join(dataDir, "blobs")),
      keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
      pepper,
      serviceId: "svc_test",
      now: () => new Date(timestamp),
    };
    const principal = await authenticateBearer(deps, `Bearer ${token}`);
    const sent = await sendMessage(deps, principal, "proj_1", "doctor-clean", {
      summary: SUMMARY,
      type: "request",
      language: "en",
      text: BODY,
      bodyDigest: `sha256:${createHash("sha256").update(BODY).digest("hex")}`,
    });
    await markRead(deps, principal, "proj_1", sent.messageId);
  } finally {
    db.close();
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// Add a multi-page probe table so page-level corruption is deterministic while
// doctor's real count queries still read intact pages.
async function seedProbeDatabase(dataDir: string): Promise<string> {
  await seedSentAndRead(dataDir);
  const dbPath = join(dataDir, "corkboard.sqlite");
  const db = await openSqliteDatabase(dbPath);
  try {
    await db.exec("CREATE TABLE doctor_probe (id INTEGER PRIMARY KEY, payload TEXT)");
    for (let index = 0; index < 200; index += 1) {
      await db.run("INSERT INTO doctor_probe (payload) VALUES (?)", [
        `probe-${index}-`.padEnd(180, "x"),
      ]);
    }
    await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  rmSync(`${dbPath}-wal`, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  return dbPath;
}

type CorruptOutcome = "ok" | "non-ok" | "throws" | "unreadable";

// Flip one byte and classify a fresh copy. The sqlite_master read must still
// work for the "throws" case to specifically exercise `PRAGMA integrity_check`.
function trialCorruption(
  original: Buffer,
  offset: number,
  scratchDir: string,
): CorruptOutcome {
  const candidate = Buffer.from(original);
  candidate[offset] = (candidate[offset] ?? 0) ^ 0xff;
  const path = join(scratchDir, "candidate.sqlite");
  writeFileSync(path, candidate);
  rmSync(`${path}-wal`, { force: true });
  rmSync(`${path}-shm`, { force: true });
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    try {
      db.prepare("SELECT name FROM sqlite_master WHERE type = ?").all("table");
    } catch {
      return "unreadable";
    }
    try {
      const rows = db.prepare("PRAGMA integrity_check").all() as Array<{
        integrity_check: string;
      }>;
      if (rows.length === 1 && rows[0]?.integrity_check === "ok") return "ok";
      return "non-ok";
    } catch {
      return "throws";
    }
  } finally {
    db.close();
  }
}

// Bounded deterministic search over the first 16 pages. The fixed schema/seed
// makes the same offsets reproduce; the bound keeps a bad seed from hanging.
function findCorruptions(
  dbPath: string,
  scratchDir: string,
): { report: Buffer; throws: Buffer } {
  const original = readFileSync(dbPath);
  let pageSize = original.readUInt16BE(16);
  if (pageSize === 1) pageSize = 65_536;
  if (pageSize < 512) pageSize = 4096;
  const start = pageSize;
  const end = Math.min(original.length, start + 16 * pageSize);
  let report: Buffer | undefined;
  let throws: Buffer | undefined;
  for (let offset = start; offset < end; offset += 1) {
    const outcome = trialCorruption(original, offset, scratchDir);
    if (outcome === "non-ok" && report === undefined) {
      const candidate = Buffer.from(original);
      candidate[offset] = (candidate[offset] ?? 0) ^ 0xff;
      report = candidate;
    } else if (outcome === "throws" && throws === undefined) {
      const candidate = Buffer.from(original);
      candidate[offset] = (candidate[offset] ?? 0) ^ 0xff;
      throws = candidate;
    }
    if (report !== undefined && throws !== undefined) break;
  }
  assert.ok(report, "found a deterministic non-ok integrity corruption");
  assert.ok(throws, "found a deterministic integrity_check throw");
  return { report, throws };
}

interface DoctorJson {
  schema_versions: {
    applied: number[];
    expected: number[];
    missing: number[];
    unexpected: Array<number | string>;
    complete: boolean;
  };
  key_presence: {
    root_key: boolean;
    credential_pepper: boolean;
    root_key_valid: boolean;
    credential_pepper_valid: boolean;
    key_version: string;
  };
  database: {
    integrity: string;
    counts: {
      messages: number;
      ready: number;
      pending: number;
      expired: number;
      failed: number;
      receipts: number;
      credentials: number;
      grants: number;
    } | null;
  } | null;
  blobs: {
    files: number;
    referenced: number | null;
    orphaned: number | null;
    missing: number | null;
    expired_pending_deletion: number | null;
    blob_dir_non_files: number;
  };
  provisional: {
    stuck_minutes: number;
    count: number | null;
    samples: Array<{ id: string; age_seconds: number }> | null;
  };
  issues: Array<{ code: string; count: number }>;
}

function parseJson(result: RunResult): DoctorJson {
  assert.equal(result.stdout.trim().split("\n").length, 1, "exactly one JSON object");
  return JSON.parse(result.stdout) as DoctorJson;
}

test("doctor reports a clean instance with a sent/read message", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    const env = withoutCorkboardEnv(keyEnv());
    const result = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--json"], env);
    assert.equal(result.status, 0, result.stderr);
    const report = parseJson(result);

    assert.deepEqual(report.schema_versions.applied, [1, 2]);
    assert.deepEqual(report.schema_versions.expected, [1, 2]);
    assert.deepEqual(report.schema_versions.missing, []);
    assert.equal(report.schema_versions.complete, true);
    assert.equal(report.key_presence.root_key, true);
    assert.equal(report.key_presence.credential_pepper, true);
    assert.equal(report.key_presence.root_key_valid, true);
    assert.equal(report.key_presence.credential_pepper_valid, true);
    assert.equal(report.key_presence.key_version, "v1");
    assert.equal(report.database?.integrity, "ok");
    assert.deepEqual(report.database?.counts, {
      messages: 1,
      ready: 1,
      pending: 0,
      expired: 0,
      failed: 0,
      receipts: 1,
      credentials: 1,
      grants: 1,
    });
    assert.deepEqual(report.blobs, {
      files: 1,
      referenced: 1,
      orphaned: 0,
      missing: 0,
      expired_pending_deletion: 0,
      blob_dir_non_files: 0,
    });
    assert.deepEqual(report.issues, []);
    assert.equal(report.provisional.count, 0);
    assert.deepEqual(report.provisional.samples, []);

    for (const secret of [SUMMARY, BODY, env.CORKBOARD_ROOT_KEY ?? ""]) {
      assert.equal(result.stdout.includes(secret), false, "no content or key material");
    }

    const human = runCli(sourceCli, ["doctor", "--data-dir", dataDir], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(
      human.stdout,
      /schema: applied 1,2; expected 1,2; missing none; unexpected none; complete/,
    );
    assert.match(human.stdout, /counts: messages 1 \(ready 1/);
    assert.match(human.stdout, /issues: none/);
    assert.equal(human.stdout.includes(SUMMARY), false);
    assert.equal(human.stdout.includes(BODY), false);
  })();
});

test("doctor reports orphan, missing, expired-pending and stuck rows with bounded samples", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const orphanKey = "O".repeat(20);
  return (async () => {
    await seed(dataDir, {
      expiredState: null,
      missingReferencedKey: true,
      orphanKey,
      stuckCount: 12,
    });
    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir, "--stuck-minutes", "1", "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 1, result.stderr);
    const report = parseJson(result);

    assert.equal(report.blobs.files, 2); // KEY_A and the orphan
    assert.equal(report.blobs.referenced, 2); // KEY_A and the missing "M" key
    assert.equal(report.blobs.orphaned, 1);
    assert.equal(report.blobs.missing, 1);
    assert.equal(report.blobs.expired_pending_deletion, 1);
    assert.equal(report.provisional.count, 12);
    assert.ok(report.provisional.samples !== null);
    assert.equal(report.provisional.samples.length, 10, "samples are bounded");
    for (const sample of report.provisional.samples) {
      assert.match(sample.id, /^msg_stuck_/);
      assert.ok(sample.age_seconds > 0);
    }

    const counts = new Map(report.issues.map((issue) => [issue.code, issue.count]));
    assert.equal(counts.get("BLOB_MISSING"), 1);
    assert.equal(counts.get("BLOB_ORPHANED"), 1);
    assert.equal(counts.get("EXPIRED_BLOB_PENDING"), 1);
    assert.equal(counts.get("STUCK_PENDING"), 12);
    assert.equal(counts.has("SCHEMA_INCOMPLETE"), false);
    assert.equal(result.stdout.includes(SUMMARY), false);
    assert.equal(result.stdout.includes(BODY), false);
  })();
});

test("doctor counts a deleted expired body as clean and never follows blob symlinks", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const outside = join(root, "outside.bin");
  writeFileSync(outside, BODY);
  return (async () => {
    await seed(dataDir, { expiredState: "deleted" });
    const linkedKey = "S".repeat(20);
    symlinkSync(outside, join(dataDir, "blobs", linkedKey));
    // A regular file whose name is not an opaque key is ignored, not parsed.
    writeFileSync(join(dataDir, "blobs", "not-a-valid-key"), BODY);

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir, "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 0, result.stderr);
    const report = parseJson(result);
    assert.equal(report.blobs.files, 2, "the symlink is not counted as a blob file");
    assert.equal(report.blobs.blob_dir_non_files, 1);
    assert.equal(report.blobs.orphaned, 0);
    assert.equal(report.blobs.expired_pending_deletion, 0, "deleted state is clean");
    assert.deepEqual(report.issues, []);
    assert.equal(result.stdout.includes(BODY), false);
  })();
});

test("doctor does not create a data directory or initialize an absent database", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "absent");
  const env = withoutCorkboardEnv(keyEnv());

  const missing = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--json"], env);
  assert.equal(missing.status, 1, missing.stderr);
  assert.equal(existsSync(dataDir), false, "the data directory is not created");
  const missingReport = parseJson(missing);
  assert.equal(missingReport.database, null);
  assert.ok(missingReport.issues.some((issue) => issue.code === "SCHEMA_INCOMPLETE"));
  assert.equal(missingReport.blobs.referenced, null, "not measured, not zero");
  assert.equal(missingReport.provisional.count, null, "not measured, not zero");
  assert.equal(missingReport.provisional.samples, null);

  // Key material is reported only as presence/shape booleans.
  const invalidPepper = ["not", "a", "real", "key"].join("-");
  const noKeys = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--json"], {
    ...withoutCorkboardEnv({}),
    CORKBOARD_ROOT_KEY: "",
    CORKBOARD_CREDENTIAL_PEPPER: invalidPepper,
  });
  assert.equal(noKeys.status, 1);
  const noKeysReport = parseJson(noKeys);
  assert.equal(noKeysReport.key_presence.root_key, false);
  assert.equal(noKeysReport.key_presence.credential_pepper, true);
  assert.equal(noKeysReport.key_presence.root_key_valid, false);
  assert.equal(noKeysReport.key_presence.credential_pepper_valid, false);
  assert.equal(
    noKeysReport.issues.find((issue) => issue.code === "KEY_MISSING")?.count,
    2,
  );
  assert.equal(noKeys.stdout.includes(invalidPepper), false);

  // An existing empty directory must stay empty: no database is initialized.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const empty = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--json"], env);
  assert.equal(empty.status, 1, empty.stderr);
  assert.equal(existsSync(join(dataDir, "corkboard.sqlite")), false);
  assert.deepEqual(readdirSync(dataDir), []);
  const emptyReport = parseJson(empty);
  assert.equal(emptyReport.database, null);
  assert.ok(emptyReport.issues.some((issue) => issue.code === "SCHEMA_INCOMPLETE"));
});

test("doctor exits 2 with a stable message and no stack for invalid arguments", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const env = withoutCorkboardEnv(keyEnv());

  const invalidNumber = runCli(
    sourceCli,
    ["doctor", "--data-dir", dataDir, "--stuck-minutes", "nope"],
    env,
  );
  assert.equal(invalidNumber.status, 2);
  assert.match(invalidNumber.stderr, /--stuck-minutes/);
  assert.equal(/^\s+at /m.test(invalidNumber.stderr), false, "no stack trace");

  const unknown = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--fix"], env);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /Unknown option|--fix/);

  const extra = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "extra"], env);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /no positional arguments/);

  const fileAsDir = join(root, "file");
  writeFileSync(fileAsDir, "not a directory");
  const notDir = runCli(sourceCli, ["doctor", "--data-dir", fileAsDir], env);
  assert.equal(notDir.status, 2);
  assert.match(notDir.stderr, /not a directory/);
  assert.equal(/^\s+at /m.test(notDir.stderr), false, "no stack trace");
});

test("doctor only reads the database and blob directory", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    const dbPath = join(dataDir, "corkboard.sqlite");
    const dbHash = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    const blobNames = readdirSync(join(dataDir, "blobs"));
    assert.equal(blobNames.length, 1);
    const blobPath = join(dataDir, "blobs", blobNames[0] ?? "");
    const blobHash = createHash("sha256").update(readFileSync(blobPath)).digest("hex");
    const dirBefore = readdirSync(dataDir).sort();

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir, "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 0, result.stderr);

    assert.deepEqual(readdirSync(dataDir).sort(), dirBefore, "no files created");
    assert.equal(
      createHash("sha256").update(readFileSync(dbPath)).digest("hex"),
      dbHash,
      "database bytes unchanged",
    );
    assert.equal(
      createHash("sha256").update(readFileSync(blobPath)).digest("hex"),
      blobHash,
      "blob bytes unchanged",
    );
  })();
});

test("the built CLI runs doctor against a real data directory", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    // Build unconditionally so this cannot pass against stale dist output.
    execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    const result = runCli(
      builtCli,
      ["doctor", "--data-dir", dataDir, "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 0, result.stderr);
    const report = parseJson(result);
    assert.equal(report.database?.counts?.messages, 1);
    assert.deepEqual(report.issues, []);
  })();
});

test("doctor reports a non-ok integrity check and exits 2 when it throws", (t) => {
  const root = tempDir(t);
  const env = withoutCorkboardEnv(keyEnv());
  return (async () => {
    const baseDir = join(root, "base");
    const dbPath = await seedProbeDatabase(baseDir);
    const scratch = join(root, "scratch");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const corruptions = findCorruptions(dbPath, scratch);

    // Non-ok pragma result: a report with DATABASE_INTEGRITY_FAILED, exit 1.
    const reportDir = join(root, "report-data");
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(reportDir, "corkboard.sqlite"), corruptions.report);
    const reportResult = runCli(
      sourceCli,
      ["doctor", "--data-dir", reportDir, "--json"],
      env,
    );
    assert.equal(reportResult.status, 1, reportResult.stderr);
    const report = parseJson(reportResult);
    assert.notEqual(report.database?.integrity, "ok");
    const issue = report.issues.find(
      (item) => item.code === "DATABASE_INTEGRITY_FAILED",
    );
    assert.ok(issue, "DATABASE_INTEGRITY_FAILED is reported");
    assert.ok((issue?.count ?? 0) >= 1);
    assert.equal(reportResult.stdout.includes(SUMMARY), false);
    assert.equal(reportResult.stdout.includes(BODY), false);
    assert.equal(reportResult.stdout.includes("\u001b"), false, "no raw ESC");
    assert.equal(existsSync(join(reportDir, "corkboard.sqlite-wal")), false);
    assert.equal(existsSync(join(reportDir, "corkboard.sqlite-shm")), false);

    // A pragma that throws cannot produce a report: exit 2, stable message.
    const throwDir = join(root, "throw-data");
    mkdirSync(throwDir, { recursive: true, mode: 0o700 });
    writeFileSync(join(throwDir, "corkboard.sqlite"), corruptions.throws);
    const throwResult = runCli(
      sourceCli,
      ["doctor", "--data-dir", throwDir, "--json"],
      env,
    );
    assert.equal(throwResult.status, 2);
    assert.match(throwResult.stderr, /cannot read the database read-only/);
    assert.equal(/^\s+at /m.test(throwResult.stderr), false, "no stack trace");
  })();
});

test("doctor treats every migration table as required", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    const dbPath = join(dataDir, "corkboard.sqlite");
    const db = await openSqliteDatabase(dbPath);
    try {
      await db.exec("DROP TABLE audit_events");
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir, "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 1, result.stderr);
    const report = parseJson(result);
    assert.deepEqual(report.schema_versions.missing, [], "all migration versions applied");
    assert.equal(report.schema_versions.complete, false, "a core table is missing");
    assert.equal(report.database?.integrity, "ok");
    assert.equal(report.database?.counts, null);
    assert.ok(
      report.issues.some((issue) => issue.code === "SCHEMA_INCOMPLETE"),
      "SCHEMA_INCOMPLETE covers a missing core table",
    );
  })();
});

test("doctor rejects symlinked WAL sidecars without following them", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const walTarget = join(root, "wal-target");
  const shmTarget = join(root, "shm-target");
  writeFileSync(walTarget, "wal-target-bytes");
  writeFileSync(shmTarget, "shm-target-bytes");
  return (async () => {
    await seedSentAndRead(dataDir);
    const dbPath = join(dataDir, "corkboard.sqlite");
    symlinkSync(walTarget, `${dbPath}-wal`);
    symlinkSync(shmTarget, `${dbPath}-shm`);

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 2);
    assert.match(result.stderr, /sidecar is not a regular file/);
    assert.equal(/^\s+at /m.test(result.stderr), false, "no stack trace");
    assert.equal(readFileSync(walTarget, "utf8"), "wal-target-bytes");
    assert.equal(readFileSync(shmTarget, "utf8"), "shm-target-bytes");
  })();
});

test("doctor reads a live uncheckpointed WAL without changing DB/WAL/blob bytes", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    const dbPath = join(dataDir, "corkboard.sqlite");
    const writer = await openSqliteDatabase(dbPath);
    try {
      const liveKey = "L".repeat(20);
      const timestamp = new Date().toISOString();
      await writer.run(
        "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?, ?, ?, 'ready', ?)",
        ["obj_live", "proj_1", liveKey, timestamp],
      );
      await writer.run(
        `INSERT INTO messages
           (id, project_id, seq, sender_speaker_id, summary, type, language,
            received_at, committed_at, body_state, body_object_id)
         VALUES (?, ?, 2, ?, ?, 'request', 'en', ?, ?, 'ready', ?)`,
        ["msg_live", "proj_1", "spk_1", SUMMARY, timestamp, timestamp, "obj_live"],
      );
      const liveBlob = join(dataDir, "blobs", liveKey);
      writeFileSync(liveBlob, BODY);

      assert.equal(existsSync(`${dbPath}-wal`), true);
      assert.equal(existsSync(`${dbPath}-shm`), true);
      const before = {
        db: sha256File(dbPath),
        wal: sha256File(`${dbPath}-wal`),
        blob: sha256File(liveBlob),
      };

      const result = runCli(
        sourceCli,
        ["doctor", "--data-dir", dataDir, "--json"],
        withoutCorkboardEnv(keyEnv()),
      );
      assert.equal(result.status, 0, result.stderr);
      const report = parseJson(result);
      assert.equal(report.database?.counts?.messages, 2, "uncheckpointed WAL row is visible");
      assert.equal(report.database?.counts?.ready, 2);
      assert.deepEqual(report.issues, []);

      assert.equal(sha256File(dbPath), before.db, "database bytes unchanged");
      assert.equal(sha256File(`${dbPath}-wal`), before.wal, "WAL bytes unchanged");
      assert.equal(sha256File(liveBlob), before.blob, "blob bytes unchanged");
      assert.equal(result.stdout.includes(SUMMARY), false);
    } finally {
      writer.close();
    }
  })();
});

test("doctor does not apply migration 002 to a v1 database", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const env = withoutCorkboardEnv(keyEnv());
  return (async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(dataDir, "corkboard.sqlite");
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(readFileSync(join(repoRoot, "migrations", "001_init.sql"), "utf8"));
      legacy
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
        .run(new Date().toISOString());
    } finally {
      legacy.close();
    }

    const result = runCli(sourceCli, ["doctor", "--data-dir", dataDir, "--json"], env);
    assert.equal(result.status, 1, result.stderr);
    const report = parseJson(result);
    assert.deepEqual(report.schema_versions.applied, [1]);
    assert.deepEqual(report.schema_versions.missing, [2]);
    assert.equal(report.schema_versions.complete, false);
    assert.ok(report.issues.some((issue) => issue.code === "SCHEMA_INCOMPLETE"));

    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const versions = after
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      assert.deepEqual(versions.map((row) => row.version), [1], "migration 002 was not applied");
      const tables = after
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential_project_grants'",
        )
        .all();
      assert.equal(tables.length, 0);
    } finally {
      after.close();
    }
    assert.equal(existsSync(`${dbPath}-wal`), false);
    assert.equal(existsSync(`${dbPath}-shm`), false);
  })();
});

test("doctor reports SCHEMA_AHEAD when the database has a newer version", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seedSentAndRead(dataDir);
    const dbPath = join(dataDir, "corkboard.sqlite");
    const db = await openSqliteDatabase(dbPath);
    try {
      await db.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        [99, new Date().toISOString()],
      );
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir, "--json"],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 1, result.stderr);
    const report = parseJson(result);
    assert.deepEqual(report.schema_versions.applied, [1, 2, 99]);
    assert.deepEqual(report.schema_versions.unexpected, [99]);
    assert.deepEqual(report.schema_versions.missing, []);
    assert.equal(report.schema_versions.complete, false);
    const codes = report.issues.map((issue) => issue.code);
    assert.ok(codes.includes("SCHEMA_AHEAD"), "SCHEMA_AHEAD is reported");
    assert.equal(codes.includes("SCHEMA_INCOMPLETE"), false);
    assert.equal(report.database?.counts, null, "ahead schema counts are not trusted");
  })();
});

test("opening a newer database refuses without applying migrations", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const dbPath = join(dataDir, "corkboard.sqlite");
    const legacy = new DatabaseSync(dbPath);
    try {
      legacy.exec(readFileSync(join(repoRoot, "migrations", "001_init.sql"), "utf8"));
      const insert = legacy.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      );
      insert.run(1, new Date().toISOString());
      insert.run(99, new Date().toISOString());
      legacy.exec("PRAGMA journal_mode = WAL");
      legacy.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      legacy.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    await assert.rejects(
      openSqliteDatabase(dbPath),
      (error: unknown) =>
        error instanceof Error &&
        /newer than this server supports/.test(error.message),
    );

    // Migration 002 must not have been applied after the refusal.
    const after = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const versions = after
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number }>;
      assert.deepEqual(
        versions.map((row) => row.version),
        [1, 99],
        "no migration row was added",
      );
      const tables = after
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential_project_grants'",
        )
        .all();
      assert.equal(tables.length, 0, "migration 002 was not applied");
    } finally {
      after.close();
    }
  })();
});

test("doctor reports integrity failure even when count queries throw", (t) => {
  const root = tempDir(t);
  return (async () => {
    const baseDir = join(root, "base");
    const dbPath = await seedProbeDatabase(baseDir);
    const scratch = join(root, "scratch");
    mkdirSync(scratch, { recursive: true, mode: 0o700 });
    const corruptions = findCorruptions(dbPath, scratch);

    const dataDir = join(root, "corrupt-data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const corruptPath = join(dataDir, "corkboard.sqlite");
    writeFileSync(corruptPath, corruptions.report);
    // The DB is genuinely corrupt (non-ok integrity). Inject a read failure for
    // the count query, because SQLite's COUNT(*) remains readable for every
    // byte-flip corruption we could reproduce deterministically.
    const real = await openSqliteDatabaseReadOnly(corruptPath);
    const failing: typeof real = {
      all: (sql, params) => {
        if (sql.includes("FROM messages")) return Promise.reject(new Error("count read failure"));
        return real.all(sql, params);
      },
      first: (sql, params) => {
        if (sql.includes("COUNT(*) AS messages")) {
          return Promise.reject(new Error("count read failure"));
        }
        return real.first(sql, params);
      },
      close: () => real.close(),
    };

    const report = await runDoctor({
      dataDir,
      stuckMinutes: 60,
      env: keyEnv(),
      openReadOnly: async () => failing,
    });
    assert.notEqual(report.database?.integrity, "ok");
    assert.equal(report.database?.counts, null);
    assert.equal(report.blobs.referenced, null);
    assert.equal(report.blobs.orphaned, null);
    assert.equal(report.blobs.missing, null);
    assert.equal(report.blobs.expired_pending_deletion, null);
    assert.equal(report.provisional.count, null);
    assert.equal(report.provisional.samples, null);
    assert.ok(
      report.issues.some((issue) => issue.code === "DATABASE_INTEGRITY_FAILED"),
    );
  })();
});

test("doctor normalizes and rejects symlinked data and database paths", (t) => {
  const root = tempDir(t);
  const realData = join(root, "real-data");
  return (async () => {
    await seedSentAndRead(realData);
    const linkedData = join(root, "linked-data");
    symlinkSync(realData, linkedData, "dir");
    const env = withoutCorkboardEnv(keyEnv());

    for (const suffix of ["/", "//", "/.", "///"]) {
      const result = runCli(
        sourceCli,
        ["doctor", "--data-dir", `${linkedData}${suffix}`, "--json"],
        env,
      );
      assert.equal(result.status, 2, `suffix ${JSON.stringify(suffix)}: ${result.stderr}`);
      assert.match(result.stderr, /symbolic link/);
    }

    // A symlinked database file is rejected as a non-regular path.
    const dbTarget = join(root, "db-target.sqlite");
    writeFileSync(dbTarget, readFileSync(join(realData, "corkboard.sqlite")));
    const dbLinkDir = join(root, "db-link-data");
    mkdirSync(dbLinkDir, { recursive: true, mode: 0o700 });
    symlinkSync(dbTarget, join(dbLinkDir, "corkboard.sqlite"));
    const dbLink = runCli(
      sourceCli,
      ["doctor", "--data-dir", dbLinkDir, "--json"],
      env,
    );
    assert.equal(dbLink.status, 2);
    assert.match(dbLink.stderr, /not a regular file \(including a symlink\)/);
  })();
});

test("doctor sanitizes control characters in DB-derived human output", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  return (async () => {
    await seed(dataDir, {});
    const dbPath = join(dataDir, "corkboard.sqlite");
    const db = await openSqliteDatabase(dbPath);
    try {
      await db.run(
        `INSERT INTO messages
           (id, project_id, sender_speaker_id, summary, type, language, received_at, body_state)
         VALUES (?, ?, ?, ?, 'request', 'en', ?, 'pending')`,
        [
          "msg_\u001b[31m\u0007\r\npending",
          "proj_1",
          "spk_1",
          SUMMARY,
          "2020-01-01T00:00:00.000Z",
        ],
      );
      await db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
    rmSync(`${dbPath}-wal`, { force: true });
    rmSync(`${dbPath}-shm`, { force: true });

    const result = runCli(
      sourceCli,
      ["doctor", "--data-dir", dataDir],
      withoutCorkboardEnv(keyEnv()),
    );
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout.includes("\u001b"), false, "no raw ESC");
    assert.equal(result.stdout.includes("\u0007"), false, "no raw BEL");
    assert.equal(result.stdout.includes("\r"), false, "no raw CR");
    assert.match(result.stdout, /msg_\?\[31m\?\?\?pending/);

    // Formatter-level: an integrity message with controls is sanitized too.
    const report: DoctorReport = {
      schema_versions: {
        applied: [1, 2],
        expected: [1, 2],
        missing: [],
        unexpected: [],
        complete: true,
      },
      key_presence: {
        root_key: true,
        credential_pepper: true,
        root_key_valid: true,
        credential_pepper_valid: true,
        key_version: "v1",
      },
      database: { integrity: "bad\u001b[31m\nnext", counts: null },
      blobs: {
        files: 0,
        referenced: null,
        orphaned: null,
        missing: null,
        expired_pending_deletion: null,
        blob_dir_non_files: 0,
      },
      provisional: { stuck_minutes: 60, count: null, samples: null },
      issues: [],
    };
    const human = formatDoctorReport(report).join("\n");
    assert.equal(human.includes("\u001b"), false);
    assert.equal(human.includes("\r"), false);
    assert.ok(human.includes("bad?[31m?next"), "control characters replaced");
  })();
});

test(
  "doctor exits 2 for a locked database",
  { skip: process.platform === "win32" },
  (t) => {
    const root = tempDir(t);
    const dataDir = join(root, "data");
    return (async () => {
      mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const dbPath = join(dataDir, "corkboard.sqlite");
      const db = new DatabaseSync(dbPath);
      try {
        db.exec(readFileSync(join(repoRoot, "migrations", "001_init.sql"), "utf8"));
        db.exec(
          readFileSync(
            join(repoRoot, "migrations", "002_credential_project_grants.sql"),
            "utf8",
          ),
        );
        const insert = db.prepare(
          "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        );
        insert.run(1, new Date().toISOString());
        insert.run(2, new Date().toISOString());
        db.exec("BEGIN EXCLUSIVE");
        const result = runCli(
          sourceCli,
          ["doctor", "--data-dir", dataDir],
          withoutCorkboardEnv(keyEnv()),
        );
        assert.equal(result.status, 2);
        assert.match(result.stderr, /database is busy or locked/);
        assert.equal(/^\s+at /m.test(result.stderr), false, "no stack trace");
      } finally {
        try {
          db.exec("ROLLBACK");
        } catch {
          // The lock may already be gone.
        }
        db.close();
      }
    })();
  },
);

test(
  "doctor exits 2 for an unreadable data directory",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  (t) => {
    const root = tempDir(t);
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    chmodSync(dataDir, 0o000);
    try {
      const result = runCli(
        sourceCli,
        ["doctor", "--data-dir", dataDir],
        withoutCorkboardEnv(keyEnv()),
      );
      assert.equal(result.status, 2);
      assert.match(result.stderr, /cannot read the data directory/);
      assert.equal(/^\s+at /m.test(result.stderr), false, "no stack trace");
    } finally {
      chmodSync(dataDir, 0o700);
    }
  },
);
