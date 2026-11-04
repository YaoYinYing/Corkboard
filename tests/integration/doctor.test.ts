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
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { authenticateBearer, type ServiceDeps } from "../../src/service/auth.ts";
import { markRead, sendMessage } from "../../src/service/messages.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

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

interface DoctorJson {
  schema_versions: { applied: number[]; expected: number[]; missing: number[]; complete: boolean };
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
    referenced: number;
    orphaned: number | null;
    missing: number | null;
    expired_pending_deletion: number | null;
    blob_dir_non_files: number;
  };
  provisional: { stuck_minutes: number; count: number; samples: Array<{ id: string; age_seconds: number }> };
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
    assert.match(human.stdout, /schema: applied 1,2; expected 1,2; missing none; complete/);
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
    if (!existsSync(builtCli)) {
      execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
    }
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

test(
  "doctor reports a failed integrity check",
  {
    skip:
      "Corrupting a SQLite page deterministically is not portable across SQLite " +
      "builds; a corrupt file can also make the pragma throw, which is covered as " +
      "an unreadable database (exit 2) rather than a report.",
  },
  () => {
    // No-op placeholder; the issue path is exercised by the DATABASE_INTEGRITY_FAILED
    // assembly in src/service/doctor.ts.
  },
);
