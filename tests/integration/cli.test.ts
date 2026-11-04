import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { AppError } from "../../src/domain/errors.ts";
import {
  authenticateBearer,
  authorizeProject,
  type ServiceDeps,
} from "../../src/service/auth.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));

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
  const dir = mkdtempSync(join(tmpdir(), "corkboard-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function parseSecrets(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match === null) continue;
    const key = match[1] ?? "";
    let value = match[2] ?? "";
    if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("'\\''", "'");
    }
    values[key] = value;
  }
  return values;
}

test("init writes a 0600 secrets file and prints only its path", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const first = run(["init", "--data-dir", dataDir]);
  assert.equal(first.status, 0, first.stderr);
  const file = join(dataDir, "secrets.env");
  assert.equal(first.stdout.trim(), file);
  assert.equal(first.stdout.includes("CORKBOARD_ROOT_KEY"), false);

  const content = readFileSync(file, "utf8");
  assert.equal(first.stdout.includes(content.trim()), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);

  const secrets = parseSecrets(content);
  assert.equal(Buffer.from(secrets.CORKBOARD_ROOT_KEY ?? "", "base64").length, 32);
  assert.equal(Buffer.from(secrets.CORKBOARD_CREDENTIAL_PEPPER ?? "", "base64").length, 32);
  assert.equal(secrets.CORKBOARD_DATA_DIR, dataDir);

  const refused = run(["init", "--data-dir", dataDir]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exists/);
  assert.equal(readFileSync(file, "utf8"), content);

  const forced = run(["init", "--data-dir", dataDir, "--force"]);
  assert.equal(forced.status, 0, forced.stderr);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.notEqual(readFileSync(file, "utf8"), content);
});

test("bootstrap commands produce usable ids and a token that authenticates", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const pepper = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const password = "correct horse battery";
  const env = {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_CREDENTIAL_PEPPER: pepper,
    CORKBOARD_BOOTSTRAP_PASSWORD: password,
  };

  const owner = run(
    ["bootstrap-owner", "--email", "Owner@Example.TEST"],
    env,
  );
  assert.equal(owner.status, 0, owner.stderr);
  assert.equal(owner.stdout.includes(password), false);
  const accountId = owner.stdout.trim();
  assert.match(accountId, /^acct_/);

  // Passwords are environment-only; argv is rejected by strict parsing.
  const argvPassword = run(
    ["bootstrap-owner", "--email", "other@example.test", "--password", password],
    env,
  );
  assert.notEqual(argvPassword.status, 0);
  assert.equal(argvPassword.stdout.includes(password), false);
  assert.equal(argvPassword.stderr.includes(password), false);

  const project = run(
    ["create-project", "--account", accountId, "--title", "Ops", "--summary", "Shared ops"],
    env,
  );
  assert.equal(project.status, 0, project.stderr);
  const projectId = project.stdout.trim();
  assert.match(projectId, /^proj_/);

  const speaker = run(
    ["create-speaker", "--account", accountId, "--name", "Codex", "--description", "agent"],
    env,
  );
  assert.equal(speaker.status, 0, speaker.stderr);
  const speakerId = speaker.stdout.trim();
  assert.match(speakerId, /^spk_/);

  const member = run(["add-member", "--project", projectId, "--speaker", speakerId], env);
  assert.equal(member.status, 0, member.stderr);
  assert.match(member.stdout, new RegExp(projectId));
  assert.match(member.stdout, new RegExp(speakerId));

  const key = run(["issue-key", "--speaker", speakerId, "--project", projectId], env);
  assert.equal(key.status, 0, key.stderr);
  const token = key.stdout.trim();
  assert.match(token, /^cb_[A-Za-z0-9_-]{43}$/);
  assert.equal(key.stdout.trim().split("\n").length, 1);

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const account = await db.first<{ email: string; password_hash: string | null }>(
      "SELECT email, password_hash FROM accounts WHERE id = ?",
      [accountId],
    );
    assert.equal(account?.email, "owner@example.test");
    assert.match(account?.password_hash ?? "", /^scrypt\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);

    const membership = await db.first<{ capabilities: string }>(
      "SELECT capabilities FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, speakerId],
    );
    assert.deepEqual(JSON.parse(membership?.capabilities ?? "[]"), [
      "project.read",
      "message.read",
      "message.send",
      "receipt.write",
    ]);

    const deps: ServiceDeps = {
      db,
      blobs: new MemoryBlobStore(),
      keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
      pepper: new Uint8Array(Buffer.from(pepper, "base64")),
      serviceId: "svc_test",
      now: () => new Date(),
    };
    const principal = await authenticateBearer(deps, `Bearer ${token}`);
    assert.equal(principal.speakerId, speakerId);
    assert.equal(principal.accountId, accountId);
    assert.deepEqual(
      [...principal.scopes].sort(),
      ["message.read", "message.send", "project.read", "receipt.write"],
    );
  } finally {
    db.close();
  }

  const secondSpeaker = run(["create-speaker", "--account", accountId, "--name", "Reviewer"], env);
  assert.equal(secondSpeaker.status, 0, secondSpeaker.stderr);
  const ownerMember = run(
    ["add-member", "--project", projectId, "--speaker", secondSpeaker.stdout.trim(), "--owner"],
    env,
  );
  assert.equal(ownerMember.status, 0, ownerMember.stderr);
  assert.match(ownerMember.stdout, /owner membership added/);

  const db2 = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const ownerMembership = await db2.first<{ capabilities: string }>(
      "SELECT capabilities FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, secondSpeaker.stdout.trim()],
    );
    assert.equal(JSON.parse(ownerMembership?.capabilities ?? "[]").length, 7);
  } finally {
    db2.close();
  }
});

test("expire-bodies wires the cleanup command and accepts --data-dir", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run(["init", "--data-dir", dataDir]);
  assert.equal(init.status, 0, init.stderr);

  const empty = run(["expire-bodies", "--data-dir", dataDir]);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(
    empty.stdout.trim(),
    JSON.stringify({ examined: 0, expired: 0, blobsDeleted: 0, failures: 0 }),
  );
  assert.equal(empty.stdout.trim().split("\n").length, 1);

  const bounded = run(["expire-bodies", "--data-dir", dataDir, "--limit", "0"]);
  assert.notEqual(bounded.status, 0);
  assert.match(bounded.stderr, /limit/);

  const tooLarge = run(["expire-bodies", "--data-dir", dataDir, "--limit", "5001"]);
  assert.notEqual(tooLarge.status, 0);
  assert.match(tooLarge.stderr, /limit/);
});

test("issue-key rejects a speaker without an active membership", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const env = {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
      crypto.getRandomValues(new Uint8Array(32)),
    ).toString("base64"),
  };

  const owner = run(["bootstrap-owner", "--email", "owner@example.test"], env);
  assert.equal(owner.status, 0, owner.stderr);
  const accountId = owner.stdout.trim();
  const project = run(["create-project", "--account", accountId, "--title", "Ops"], env);
  const speaker = run(["create-speaker", "--account", accountId, "--name", "Codex"], env);
  assert.equal(project.status, 0, project.stderr);
  assert.equal(speaker.status, 0, speaker.stderr);

  const issued = run(
    ["issue-key", "--speaker", speaker.stdout.trim(), "--project", project.stdout.trim()],
    env,
  );
  assert.notEqual(issued.status, 0);
  assert.equal(issued.stdout.includes("cb_"), false);
  assert.match(issued.stderr, /active project membership/);
});

test("CLI audits sanitized actions and revocations take effect immediately", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const pepper = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const password = "bootstrap-only password";
  const env = {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_CREDENTIAL_PEPPER: pepper,
    CORKBOARD_BOOTSTRAP_PASSWORD: password,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env).stdout.trim();
  const projectId = run(
    ["create-project", "--account", accountId, "--title", "Ops"],
    env,
  ).stdout.trim();
  const speakerId = run(
    ["create-speaker", "--account", accountId, "--name", "Codex"],
    env,
  ).stdout.trim();
  const member = run(["add-member", "--project", projectId, "--speaker", speakerId], env);
  assert.equal(member.status, 0, member.stderr);
  const key = run(["issue-key", "--speaker", speakerId, "--project", projectId], env);
  assert.equal(key.status, 0, key.stderr);
  const token = key.stdout.trim();

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const deps: ServiceDeps = {
      db,
      blobs: new MemoryBlobStore(),
      keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
      pepper: new Uint8Array(Buffer.from(pepper, "base64")),
      serviceId: "svc_test",
      now: () => new Date(),
    };

    const credential = await db.first<{ id: string }>(
      "SELECT id FROM credentials WHERE speaker_id = ?",
      [speakerId],
    );
    assert.ok(credential);
    const revoked = run(["revoke-key", "--credential", credential.id], env);
    assert.equal(revoked.status, 0, revoked.stderr);
    assert.match(revoked.stdout, /credential revoked/);
    assert.equal(revoked.stdout.includes(token), false);
    await assert.rejects(
      authenticateBearer(deps, `Bearer ${token}`),
      (error: unknown) => error instanceof AppError && error.code === "UNAUTHENTICATED",
    );

    const secondSpeaker = run(
      ["create-speaker", "--account", accountId, "--name", "Reviewer"],
      env,
    ).stdout.trim();
    const owner = run(
      ["add-member", "--project", projectId, "--speaker", secondSpeaker, "--owner"],
      env,
    );
    assert.equal(owner.status, 0, owner.stderr);
    const secondKey = run(
      ["issue-key", "--speaker", secondSpeaker, "--project", projectId],
      env,
    );
    assert.equal(secondKey.status, 0, secondKey.stderr);
    const secondToken = secondKey.stdout.trim();
    const secondPrincipal = await authenticateBearer(deps, `Bearer ${secondToken}`);
    await authorizeProject(deps, secondPrincipal, projectId, "project.read");

    const removed = run(
      ["remove-member", "--project", projectId, "--speaker", secondSpeaker],
      env,
    );
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /membership removed/);
    assert.equal(removed.stdout.includes(secondToken), false);
    await assert.rejects(
      authorizeProject(deps, secondPrincipal, projectId, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
    );

    const audits = await db.all<Record<string, unknown>>(
      `SELECT actor_account_id, actor_speaker_id, project_id, operation, outcome,
              request_id, created_at
         FROM audit_events ORDER BY created_at ASC`,
    );
    const operations = audits.map((row) => row.operation);
    for (const operation of [
      "membership.grant",
      "credential.issue",
      "credential.revoke",
      "membership.remove",
    ]) {
      assert.ok(operations.includes(operation), `missing audit operation ${operation}`);
    }
    for (const row of audits) {
      assert.equal(row.request_id, null);
      assert.equal(row.outcome, "success");
    }
    const serialized = JSON.stringify(audits);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(secondToken), false);
    assert.equal(serialized.includes(pepper), false);
    assert.equal(serialized.includes(password), false);
  } finally {
    db.close();
  }
});
