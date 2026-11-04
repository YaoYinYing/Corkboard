import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const PROCESSES = 4;
const MESSAGES_PER_PROCESS = 3;
const CHILD_TIMEOUT_MS = 10_000;
const TEST_TIMEOUT_MS = 30_000;
const PROJECT_ID = "proj_mp";
const SPEAKER_ID = "spk_mp";
const CREDENTIAL_ID = "cred_mp";
const MEMBER_SCOPES = ["project.read", "message.read", "message.send", "receipt.write"];

interface ChildResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runChild(script: string, env: Record<string, string>): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      action();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() => reject(new Error(`child did not exit within ${CHILD_TIMEOUT_MS}ms`)));
    }, CHILD_TIMEOUT_MS);
    child.once("error", (error) => finish(() => reject(error)));
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("exit", (code) => finish(() => resolve({ code: code ?? 1, stdout, stderr })));
  });
}

test(
  "independent processes share one SQLite file without duplicate or lost messages",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const root = mkdtempSync(join(tmpdir(), "corkboard-multiprocess-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, "corkboard.sqlite");

  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const { token } = generateSpeakerToken();
  const stamp = new Date().toISOString();

  // Provision the shared installation once, then close the parent connection so
  // every writer below is an independent process.
  const provisioning = await openSqliteDatabase(dbPath);
  try {
    await provisioning.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      ["acct_mp", "mp@example.test", stamp],
    );
    await provisioning.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      [SPEAKER_ID, "acct_mp", "mp", stamp],
    );
    await provisioning.run(
      "INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at) VALUES (?, ?, ?, 'active', 0, ?)",
      [PROJECT_ID, "acct_mp", "multi-process", stamp],
    );
    await provisioning.run(
      "INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at) VALUES (?, ?, ?, ?)",
      [PROJECT_ID, SPEAKER_ID, JSON.stringify(MEMBER_SCOPES), stamp],
    );
    await provisioning.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, revoked_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
      [
        CREDENTIAL_ID,
        SPEAKER_ID,
        token.slice(0, 12),
        await hashSecret(token, pepper),
        JSON.stringify(MEMBER_SCOPES),
        stamp,
      ],
    );
    await provisioning.run(
      "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
      [CREDENTIAL_ID, PROJECT_ID, stamp],
    );
  } finally {
    provisioning.close();
  }

  const moduleUrl = (relative: string): string =>
    pathToFileURL(join(repoRoot, relative)).href;
  const script = `
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openSqliteDatabase } from ${JSON.stringify(moduleUrl("src/storage/db.ts"))};
import { LocalBlobStore } from ${JSON.stringify(moduleUrl("src/storage/blobs/local.ts"))};
import { keyProviderFromEnv } from ${JSON.stringify(moduleUrl("src/crypto/keys.ts"))};
import { authenticateBearer } from ${JSON.stringify(moduleUrl("src/service/auth.ts"))};
import { sendMessage } from ${JSON.stringify(moduleUrl("src/service/messages.ts"))};

const dataDir = process.env.CORKBOARD_DATA_DIR ?? "";
const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
const deps = {
  db,
  blobs: new LocalBlobStore(join(dataDir, "blobs")),
  keys: await keyProviderFromEnv(process.env),
  pepper: new Uint8Array(Buffer.from(process.env.CORKBOARD_CREDENTIAL_PEPPER ?? "", "base64")),
  serviceId: "corkboard",
  now: () => new Date(),
};
const principal = await authenticateBearer(
  deps,
  "Bearer " + (process.env.CORKBOARD_TEST_TOKEN ?? ""),
);
const projectId = process.env.CORKBOARD_TEST_PROJECT ?? "";
const processId = process.env.CORKBOARD_TEST_PROCESS ?? "";
const results = await Promise.all(
  Array.from({ length: ${MESSAGES_PER_PROCESS} }, (_, index) => {
    const text = "proc-" + processId + "-message-" + index;
    return sendMessage(deps, principal, projectId, "key-" + processId + "-" + index, {
      summary: text,
      type: "request",
      language: "en",
      text,
      bodyDigest: "sha256:" + createHash("sha256").update(text).digest("hex"),
    });
  }),
);
console.log(JSON.stringify(results.map((result) => result.seq)));
db.close();
`;

  const baseEnv: Record<string, string> = {
    ...process.env,
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_ROOT_KEY: Buffer.from(rootKey).toString("base64"),
    CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(pepper).toString("base64"),
    CORKBOARD_TEST_TOKEN: token,
    CORKBOARD_TEST_PROJECT: PROJECT_ID,
  };
  const children = await Promise.all(
    Array.from({ length: PROCESSES }, (_, index) =>
      runChild(script, {
        ...baseEnv,
        CORKBOARD_TEST_PROCESS: String(index),
      }),
    ),
  );
  for (const child of children) {
    assert.equal(child.code, 0, child.stderr);
    // Tokens never reach stdout/stderr.
    assert.equal(child.stdout.includes(token), false);
    assert.equal(child.stderr.includes(token), false);
  }

  const reportedSeqs = children.flatMap(
    (child) => JSON.parse(child.stdout.trim()) as number[],
  );
  const expectedSeqs = Array.from(
    { length: PROCESSES * MESSAGES_PER_PROCESS },
    (_, index) => index + 1,
  );
  assert.deepEqual([...reportedSeqs].sort((a, b) => a - b), expectedSeqs);

  const verify = await openSqliteDatabase(dbPath);
  try {
    const rows = await verify.all<{ id: string; seq: number }>(
      "SELECT id, seq FROM messages WHERE project_id = ? ORDER BY seq",
      [PROJECT_ID],
    );
    assert.equal(rows.length, expectedSeqs.length);
    assert.equal(new Set(rows.map((row) => row.id)).size, expectedSeqs.length);
    assert.deepEqual(rows.map((row) => row.seq), expectedSeqs);

    const keys = await verify.all<{ key: string; status: string; message_id: string }>(
      "SELECT key, status, message_id FROM idempotency_keys WHERE project_id = ?",
      [PROJECT_ID],
    );
    assert.equal(keys.length, expectedSeqs.length);
    assert.equal(new Set(keys.map((row) => row.key)).size, expectedSeqs.length);
    assert.ok(keys.every((row) => row.status === "completed"));

    const lost = await verify.all<{ key: string }>(
      `SELECT k.key FROM idempotency_keys k
         LEFT JOIN messages m ON m.id = k.message_id
        WHERE k.project_id = ? AND (m.id IS NULL OR m.seq IS NULL)`,
      [PROJECT_ID],
    );
    assert.deepEqual(lost, []);

    const project = await verify.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = ?",
      [PROJECT_ID],
    );
    assert.equal(project?.next_seq, expectedSeqs.length);

    const integrity = await verify.all<{ integrity_check: string }>("PRAGMA integrity_check");
    assert.deepEqual(integrity, [{ integrity_check: "ok" }]);

    const blobs = readdirSync(join(dataDir, "blobs")).filter(
      (name) => !name.startsWith(".tmp-"),
    );
    assert.equal(blobs.length, expectedSeqs.length);
  } finally {
    verify.close();
  }
  },
);
