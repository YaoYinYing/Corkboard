import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { inMemoryKeyProvider, keyProviderFromEnv } from "../../src/crypto/keys.ts";
import { AppError } from "../../src/domain/errors.ts";
import {
  authenticateBearer,
  authorizeProject,
  type ServiceDeps,
} from "../../src/service/auth.ts";
import { expireMessageBody } from "../../src/service/expiry.ts";
import { getMessageBody, sendMessage } from "../../src/service/messages.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
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

async function openDeps(
  dataDir: string,
  env: Record<string, string>,
): Promise<{ db: Awaited<ReturnType<typeof openSqliteDatabase>>; deps: ServiceDeps }> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  const deps: ServiceDeps = {
    db,
    blobs: new LocalBlobStore(join(dataDir, "blobs")),
    keys: await keyProviderFromEnv(env),
    pepper: new Uint8Array(Buffer.from(env.CORKBOARD_CREDENTIAL_PEPPER ?? "", "base64")),
    serviceId: "svc_test",
    now: () => new Date(),
  };
  return { db, deps };
}

test("init writes an isolated 0600 secrets file and refuses to reinitialize", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const secretsDir = join(root, "config", "corkboard");
  const secretsFile = join(secretsDir, "secrets.env");
  const first = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    secretsFile,
  ]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim(), secretsFile);
  assert.equal(first.stdout.includes("CORKBOARD_ROOT_KEY"), false);
  assert.equal(existsSync(join(dataDir, "secrets.env")), false);

  const content = readFileSync(secretsFile, "utf8");
  assert.equal(first.stdout.includes(content.trim()), false);
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(statSync(secretsDir).mode & 0o777, 0o700);
  assert.equal(statSync(dataDir).mode & 0o777, 0o700);

  const secrets = parseSecrets(content);
  assert.equal(Buffer.from(secrets.CORKBOARD_ROOT_KEY ?? "", "base64").length, 32);
  assert.equal(Buffer.from(secrets.CORKBOARD_CREDENTIAL_PEPPER ?? "", "base64").length, 32);
  assert.equal(secrets.CORKBOARD_DATA_DIR, dataDir);

  const refused = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    secretsFile,
  ]);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /exists/);
  assert.equal(readFileSync(secretsFile, "utf8"), content);

  // --force no longer exists: strict parsing rejects it before any write.
  const forced = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    secretsFile,
    "--force",
  ]);
  assert.notEqual(forced.status, 0);
  assert.match(forced.stderr, /Unknown option|--force/);
  assert.equal(readFileSync(secretsFile, "utf8"), content);
});

test("init defaults secrets outside the data directory under XDG_CONFIG_HOME", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const xdg = join(root, "xdg");
  const result = run(["init", "--data-dir", dataDir], {
    XDG_CONFIG_HOME: xdg,
    HOME: join(root, "home"),
  });
  assert.equal(result.status, 0, result.stderr);
  const secretsFile = join(xdg, "corkboard", "secrets.env");
  assert.equal(result.stdout.trim(), secretsFile);
  assert.equal(existsSync(join(dataDir, "secrets.env")), false);
  assert.equal(statSync(secretsFile).mode & 0o777, 0o600);
  assert.equal(statSync(join(xdg, "corkboard")).mode & 0o777, 0o700);
});

test("init refuses existing databases and in-data secrets paths without writing", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const secretsFile = join(root, "config", "secrets.env");

  // Reject a secrets path that resolves inside the data directory before any
  // mkdir or key generation.
  const inside = join(dataDir, "secrets.env");
  const rejected = run(["init", "--data-dir", dataDir, "--secrets-file", inside]);
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /outside the data directory/);
  assert.equal(existsSync(dataDir), false);

  // An existing database (even without a secrets file) blocks initialization.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const dbPath = join(dataDir, "corkboard.sqlite");
  writeFileSync(dbPath, "existing");
  const blocked = run(["init", "--data-dir", dataDir, "--secrets-file", secretsFile]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /existing installation/);
  assert.equal(existsSync(secretsFile), false);
  assert.equal(readFileSync(dbPath, "utf8"), "existing");
});

test("init canonicalizes symlinked data dirs and secrets parents", (t) => {
  const root = tempDir(t);
  const realData = join(root, "real-data");
  mkdirSync(realData, { recursive: true, mode: 0o700 });
  const linkedData = join(root, "linked-data");
  symlinkSync(realData, linkedData, "dir");

  // A symlinked data directory still blocks a secrets file inside its target.
  const throughLink = run([
    "init",
    "--data-dir",
    linkedData,
    "--secrets-file",
    join(realData, "secrets.env"),
  ]);
  assert.notEqual(throughLink.status, 0);
  assert.match(throughLink.stderr, /outside the data directory/);
  assert.equal(existsSync(join(realData, "secrets.env")), false);

  // A symlinked secrets parent that resolves inside the data directory is
  // rejected even though the lexical path looks outside.
  const nested = join(realData, "nested");
  mkdirSync(nested, { recursive: true, mode: 0o700 });
  const linkedNested = join(root, "linked-nested");
  symlinkSync(nested, linkedNested, "dir");
  const throughParent = run([
    "init",
    "--data-dir",
    realData,
    "--secrets-file",
    join(linkedNested, "secrets.env"),
  ]);
  assert.notEqual(throughParent.status, 0);
  assert.match(throughParent.stderr, /outside the data directory/);
  assert.equal(existsSync(join(nested, "secrets.env")), false);
});

test("init rejects a data directory inside the default secrets directory", (t) => {
  const root = tempDir(t);
  const xdg = join(root, "xdg");
  const dataDir = join(xdg, "corkboard", "data");
  const result = run(["init", "--data-dir", dataDir], {
    XDG_CONFIG_HOME: xdg,
    HOME: join(root, "home"),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /secrets directory/);
  assert.equal(existsSync(dataDir), false);
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
  const init = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    join(root, "secrets.env"),
  ]);
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

test("issue-key --scopes grants a project.edit key that can expire a body", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const pepper = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const env = {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_CREDENTIAL_PEPPER: pepper,
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
  const owner = run(
    ["add-member", "--project", projectId, "--speaker", speakerId, "--owner"],
    env,
  );
  assert.equal(owner.status, 0, owner.stderr);

  const editKey = run(
    [
      "issue-key",
      "--speaker",
      speakerId,
      "--project",
      projectId,
      "--scopes",
      "project.edit",
    ],
    env,
  );
  assert.equal(editKey.status, 0, editKey.stderr);
  const editToken = editKey.stdout.trim();
  const defaultKey = run(["issue-key", "--speaker", speakerId, "--project", projectId], env);
  assert.equal(defaultKey.status, 0, defaultKey.stderr);
  const defaultToken = defaultKey.stdout.trim();

  // Unknown, duplicate, and empty scope lists are rejected.
  for (const [scopes, message] of [
    ["project.edit,bogus", /unknown scope/],
    ["project.edit,project.edit", /duplicate scope/],
    ["", /comma-separated/],
  ] as const) {
    const rejected = run(
      ["issue-key", "--speaker", speakerId, "--project", projectId, "--scopes", scopes],
      env,
    );
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, message);
  }

  // A non-owner member cannot receive a scope its membership does not grant.
  const memberSpeaker = run(
    ["create-speaker", "--account", accountId, "--name", "Member"],
    env,
  ).stdout.trim();
  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", memberSpeaker], env).status,
    0,
  );
  const notGranted = run(
    [
      "issue-key",
      "--speaker",
      memberSpeaker,
      "--project",
      projectId,
      "--scopes",
      "project.edit",
    ],
    env,
  );
  assert.notEqual(notGranted.status, 0);
  assert.match(notGranted.stderr, /not granted/);

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const rows = await db.all<{ scope_json: string }>(
      "SELECT scope_json FROM credentials WHERE speaker_id = ?",
      [speakerId],
    );
    assert.ok(
      rows.some((row) => JSON.stringify(JSON.parse(row.scope_json)) === '["project.edit"]'),
      "the --scopes credential stores exactly the requested set",
    );

    const deps: ServiceDeps = {
      db,
      blobs: new LocalBlobStore(join(dataDir, "blobs")),
      keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
      pepper: new Uint8Array(Buffer.from(pepper, "base64")),
      serviceId: "svc_test",
      now: () => new Date(),
    };
    const sendPrincipal = await authenticateBearer(deps, `Bearer ${defaultToken}`);
    const editPrincipal = await authenticateBearer(deps, `Bearer ${editToken}`);
    assert.deepEqual([...editPrincipal.scopes], ["project.edit"]);

    const text = "cli expiry body";
    const sent = await sendMessage(deps, sendPrincipal, projectId, "cli-expiry", {
      summary: "cli expiry",
      type: "request",
      language: "en",
      text,
      bodyDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    });

    // A CLI token without project.edit is FORBIDDEN.
    await assert.rejects(
      expireMessageBody(deps, sendPrincipal, projectId, sent.messageId),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );

    const expired = await expireMessageBody(deps, editPrincipal, projectId, sent.messageId);
    assert.deepEqual(expired, { messageId: sent.messageId, bodyState: "expired" });
    await assert.rejects(
      getMessageBody(deps, sendPrincipal, projectId, sent.messageId),
      (error: unknown) => error instanceof AppError && error.code === "BODY_EXPIRED",
    );
  } finally {
    db.close();
  }
});

test("expire-bodies exits non-zero when a blob delete fails", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  const timestamp = new Date().toISOString();
  const storageKey = "B".repeat(20);
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?1, ?2, 'active', ?3)",
      ["acct_failure", "failure@example.test", timestamp],
    );
    await db.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
      ["spk_failure", "acct_failure", "Failure", timestamp],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at) VALUES (?1, ?2, ?3, 'active', 1, ?4)",
      ["proj_failure", "acct_failure", "Failure", timestamp],
    );
    await db.run(
      "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?1, ?2, ?3, 'ready', ?4)",
      ["obj_failure", "proj_failure", storageKey, timestamp],
    );
    await db.run(
      `INSERT INTO messages
         (id, project_id, seq, sender_speaker_id, summary, type, language,
          received_at, committed_at, body_state, body_object_id)
       VALUES (?1, ?2, 1, ?3, 'summary', 'request', 'en', ?4, ?4, 'expired', ?5)`,
      ["msg_failure", "proj_failure", "spk_failure", timestamp, "obj_failure"],
    );
  } finally {
    db.close();
  }

  // A directory at the blob path makes unlink fail with a non-ENOENT error.
  mkdirSync(join(dataDir, "blobs", storageKey), { recursive: true, mode: 0o700 });

  const result = run(["expire-bodies", "--data-dir", dataDir]);
  assert.notEqual(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.trim()), {
    examined: 1,
    expired: 0,
    blobsDeleted: 0,
    failures: 1,
  });
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

test("a rejected reinitialization leaves keys, tokens and ciphertext usable", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const secretsFile = join(root, "config", "secrets.env");
  const init = run(["init", "--data-dir", dataDir, "--secrets-file", secretsFile]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(secretsFile, "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(
    ["bootstrap-owner", "--email", "owner@example.test"],
    env,
  ).stdout.trim();
  const projectId = run(
    ["create-project", "--account", accountId, "--title", "Ops"],
    env,
  ).stdout.trim();
  const speakerId = run(
    ["create-speaker", "--account", accountId, "--name", "Codex"],
    env,
  ).stdout.trim();
  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", speakerId, "--owner"], env).status,
    0,
  );
  const token = run(["issue-key", "--speaker", speakerId, "--project", projectId], env)
    .stdout.trim();
  assert.match(token, /^cb_/);

  const text = "survives reinitialization";
  let firstDb;
  try {
    const opened = await openDeps(dataDir, env);
    firstDb = opened.db;
    const principal = await authenticateBearer(opened.deps, `Bearer ${token}`);
    const sent = await sendMessage(opened.deps, principal, projectId, "reinit-key", {
      summary: "reinit",
      type: "request",
      language: "en",
      text,
      bodyDigest: `sha256:${createHash("sha256").update(text).digest("hex")}`,
    });
    const body = await getMessageBody(opened.deps, principal, projectId, sent.messageId);
    assert.equal(body.text, text);

    // Reinitialization is refused because the database exists. A different
    // secrets path must not be created, and the original bytes stay identical.
    const before = readFileSync(secretsFile, "utf8");
    const otherSecrets = join(root, "other", "secrets.env");
    const refused = run(["init", "--data-dir", dataDir, "--secrets-file", otherSecrets]);
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /existing installation/);
    assert.equal(existsSync(otherSecrets), false);
    assert.equal(readFileSync(secretsFile, "utf8"), before);

    const forced = run([
      "init",
      "--data-dir",
      dataDir,
      "--secrets-file",
      secretsFile,
      "--force",
    ]);
    assert.notEqual(forced.status, 0);
    assert.equal(readFileSync(secretsFile, "utf8"), before);
  } finally {
    firstDb?.close();
  }

  // The original key material still authenticates the token and decrypts.
  const reopened = await openDeps(dataDir, env);
  try {
    const principal = await authenticateBearer(reopened.deps, `Bearer ${token}`);
    assert.equal(principal.speakerId, speakerId);
    const messages = await reopened.db.all<{ id: string }>(
      "SELECT id FROM messages WHERE project_id = ?",
      [projectId],
    );
    assert.equal(messages.length, 1);
    const body = await getMessageBody(
      reopened.deps,
      principal,
      projectId,
      messages[0]?.id ?? "",
    );
    assert.equal(body.text, text);
  } finally {
    reopened.db.close();
  }
});

test("issue-key records grants and grant/revoke take effect per request", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    join(root, "secrets.env"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const speakerId = run(["create-speaker", "--account", accountId, "--name", "Codex"], env)
    .stdout.trim();
  const projectA = run(["create-project", "--account", accountId, "--title", "A"], env)
    .stdout.trim();
  const projectB = run(["create-project", "--account", accountId, "--title", "B"], env)
    .stdout.trim();
  for (const project of [projectA, projectB]) {
    assert.equal(run(["add-member", "--project", project, "--speaker", speakerId], env).status, 0);
  }

  // Zero projects is rejected; duplicate occurrences are rejected.
  assert.notEqual(run(["issue-key", "--speaker", speakerId], env).status, 0);
  assert.notEqual(
    run(
      ["issue-key", "--speaker", speakerId, "--project", projectA, "--project", projectA],
      env,
    ).status,
    0,
  );

  const tokenA = run(
    ["issue-key", "--speaker", speakerId, "--project", projectA],
    env,
  ).stdout.trim();
  const { db, deps } = await openDeps(dataDir, env);
  try {
    const credential = await db.first<{ id: string }>(
      "SELECT id FROM credentials WHERE speaker_id = ?",
      [speakerId],
    );
    assert.ok(credential);
    const credentialA = credential.id;
    const grant = await db.first<{ project_id: string }>(
      "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
      [credentialA],
    );
    assert.equal(grant?.project_id, projectA);

    const principalA = await authenticateBearer(deps, `Bearer ${tokenA}`);
    await authorizeProject(deps, principalA, projectA, "project.read");
    await assert.rejects(
      authorizeProject(deps, principalA, projectB, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );

    // Enumeration excludes the ungranted project for both endpoints.
    const app = createApp(deps);
    const call = (path: string): Promise<Response> =>
      app(
        new Request(`http://localhost${path}`, {
          headers: { authorization: `Bearer ${tokenA}` },
        }),
      );
    const me = (await (await call("/api/v1/me")).json()) as { projects: string[] };
    assert.deepEqual(me.projects, [projectA]);
    const list = (await (await call("/api/v1/projects")).json()) as {
      projects: Array<{ id: string }>;
    };
    assert.deepEqual(
      list.projects.map((project) => project.id),
      [projectA],
    );

    // One invocation may grant several projects.
    const tokenAB = run(
      [
        "issue-key",
        "--speaker",
        speakerId,
        "--project",
        projectA,
        "--project",
        projectB,
      ],
      env,
    ).stdout.trim();
    const principalAB = await authenticateBearer(deps, `Bearer ${tokenAB}`);
    await authorizeProject(deps, principalAB, projectA, "project.read");
    await authorizeProject(deps, principalAB, projectB, "project.read");

    // A key granted only to B cannot reach A.
    const tokenB = run(
      ["issue-key", "--speaker", speakerId, "--project", projectB],
      env,
    ).stdout.trim();
    const principalB = await authenticateBearer(deps, `Bearer ${tokenB}`);
    await assert.rejects(
      authorizeProject(deps, principalB, projectA, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );

    // Joining a new project does not widen an existing credential.
    const projectC = run(["create-project", "--account", accountId, "--title", "C"], env)
      .stdout.trim();
    assert.equal(
      run(["add-member", "--project", projectC, "--speaker", speakerId], env).status,
      0,
    );
    await assert.rejects(
      authorizeProject(deps, principalA, projectC, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );
    const afterJoin = (await (await call("/api/v1/me")).json()) as {
      projects: string[];
    };
    assert.deepEqual(afterJoin.projects, [projectA]);

    // An explicit grant opens B, and an explicit revoke closes it on the very
    // next request.
    const granted = run(
      ["grant-key-project", "--credential", credentialA, "--project", projectB],
      env,
    );
    assert.equal(granted.status, 0, granted.stderr);
    await authorizeProject(deps, principalA, projectB, "project.read");

    const revoked = run(
      ["revoke-key-project", "--credential", credentialA, "--project", projectB],
      env,
    );
    assert.equal(revoked.status, 0, revoked.stderr);
    await assert.rejects(
      authorizeProject(deps, principalA, projectB, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );

    // Revoking an absent grant fails; granting a project the speaker has no
    // membership in fails.
    assert.notEqual(
      run(
        ["revoke-key-project", "--credential", credentialA, "--project", projectB],
        env,
      ).status,
      0,
    );
    const projectD = run(["create-project", "--account", accountId, "--title", "D"], env)
      .stdout.trim();
    assert.notEqual(
      run(
        ["grant-key-project", "--credential", credentialA, "--project", projectD],
        env,
      ).status,
      0,
    );

    // Audit rows are sanitized and carry the granted projects/scopes.
    const audits = await db.all<{ operation: string; detail: string | null }>(
      `SELECT operation, detail FROM audit_events
        WHERE operation IN ('credential.issue', 'credential.project.grant', 'credential.project.revoke')`,
    );
    const issued = audits.filter((row) => row.operation === "credential.issue");
    assert.ok(issued.length >= 3);
    const detail = issued.find((row) => row.detail?.includes(projectA));
    assert.ok(detail?.detail);
    const parsed = JSON.parse(detail.detail) as {
      projects: string[];
      scopes: string[];
    };
    assert.ok(parsed.projects.includes(projectA));
    assert.ok(parsed.scopes.includes("message.send"));
    const serialized = JSON.stringify(audits);
    assert.equal(serialized.includes(tokenA), false);
    assert.equal(serialized.includes(tokenAB), false);
    assert.equal(serialized.includes(tokenB), false);
    assert.ok(audits.some((row) => row.operation === "credential.project.grant"));
    assert.ok(audits.some((row) => row.operation === "credential.project.revoke"));
  } finally {
    db.close();
  }
});

test("issue-key rolls back credential and grants when a grant or audit write fails", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    join(root, "secrets.env"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const speakerId = run(["create-speaker", "--account", accountId, "--name", "Codex"], env)
    .stdout.trim();
  const projectId = run(["create-project", "--account", accountId, "--title", "Ops"], env)
    .stdout.trim();
  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", speakerId], env).status,
    0,
  );

  const counts = async (): Promise<{ credentials: number; grants: number }> => {
    const { db } = await openDeps(dataDir, env);
    try {
      return {
        credentials:
          (
            await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM credentials")
          )?.n ?? -1,
        grants:
          (
            await db.first<{ n: number }>(
              "SELECT COUNT(*) AS n FROM credential_project_grants",
            )
          )?.n ?? -1,
      };
    } finally {
      db.close();
    }
  };

  // A failing grant insert must remove the just-inserted credential.
  {
    const { db } = await openDeps(dataDir, env);
    try {
      await db.exec(
        `CREATE TRIGGER fail_grant BEFORE INSERT ON credential_project_grants
         BEGIN SELECT RAISE(ABORT, 'injected grant failure'); END`,
      );
    } finally {
      db.close();
    }
    const failed = run(
      ["issue-key", "--speaker", speakerId, "--project", projectId],
      env,
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /injected grant failure/);
    assert.equal(failed.stdout.includes("cb_"), false);
    assert.deepEqual(await counts(), { credentials: 0, grants: 0 });

    const { db: cleanup } = await openDeps(dataDir, env);
    try {
      await cleanup.exec("DROP TRIGGER fail_grant");
    } finally {
      cleanup.close();
    }
  }

  // A failing audit insert after grants must remove grants and credential.
  {
    const { db } = await openDeps(dataDir, env);
    try {
      await db.exec(
        `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
         WHEN NEW.operation = 'credential.issue'
         BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
      );
    } finally {
      db.close();
    }
    const failed = run(
      ["issue-key", "--speaker", speakerId, "--project", projectId],
      env,
    );
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /injected audit failure/);
    assert.equal(failed.stdout.includes("cb_"), false);
    assert.deepEqual(await counts(), { credentials: 0, grants: 0 });

    const { db: cleanup } = await openDeps(dataDir, env);
    try {
      await cleanup.exec("DROP TRIGGER fail_audit");
    } finally {
      cleanup.close();
    }
  }

  const succeeded = run(
    ["issue-key", "--speaker", speakerId, "--project", projectId],
    env,
  );
  assert.equal(succeeded.status, 0, succeeded.stderr);
  assert.match(succeeded.stdout.trim(), /^cb_/);
  assert.deepEqual(await counts(), { credentials: 1, grants: 1 });
});

test("multi-project issue-key rejects a scope missing from any membership before writing", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    join(root, "secrets.env"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const speakerId = run(["create-speaker", "--account", accountId, "--name", "Codex"], env)
    .stdout.trim();
  const ownerProject = run(
    ["create-project", "--account", accountId, "--title", "Owner"],
    env,
  ).stdout.trim();
  const memberProject = run(
    ["create-project", "--account", accountId, "--title", "Member"],
    env,
  ).stdout.trim();
  assert.equal(
    run(["add-member", "--project", ownerProject, "--speaker", speakerId, "--owner"], env)
      .status,
    0,
  );
  assert.equal(
    run(["add-member", "--project", memberProject, "--speaker", speakerId], env).status,
    0,
  );

  const rejected = run(
    [
      "issue-key",
      "--speaker",
      speakerId,
      "--project",
      ownerProject,
      "--project",
      memberProject,
      "--scopes",
      "project.edit",
    ],
    env,
  );
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /not granted/);
  assert.equal(rejected.stdout.includes("cb_"), false);

  const { db } = await openDeps(dataDir, env);
  try {
    assert.equal(
      (await db.first<{ n: number }>("SELECT COUNT(*) AS n FROM credentials"))?.n,
      0,
    );
    assert.equal(
      (
        await db.first<{ n: number }>(
          "SELECT COUNT(*) AS n FROM credential_project_grants",
        )
      )?.n,
      0,
    );
  } finally {
    db.close();
  }
});

test("remove-member deletes grants so re-adding does not revive a credential", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run([
    "init",
    "--data-dir",
    dataDir,
    "--secrets-file",
    join(root, "secrets.env"),
  ]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const speakerId = run(["create-speaker", "--account", accountId, "--name", "Codex"], env)
    .stdout.trim();
  const projectId = run(["create-project", "--account", accountId, "--title", "Ops"], env)
    .stdout.trim();
  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", speakerId], env).status,
    0,
  );
  const token = run(["issue-key", "--speaker", speakerId, "--project", projectId], env)
    .stdout.trim();

  const { db, deps } = await openDeps(dataDir, env);
  try {
    const credential = await db.first<{ id: string }>(
      "SELECT id FROM credentials WHERE speaker_id = ?",
      [speakerId],
    );
    assert.ok(credential);
    const principal = await authenticateBearer(deps, `Bearer ${token}`);
    await authorizeProject(deps, principal, projectId, "project.read");

    const removed = run(["remove-member", "--project", projectId, "--speaker", speakerId], env);
    assert.equal(removed.status, 0, removed.stderr);
    assert.equal(
      (await db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM credential_project_grants WHERE credential_id = ?",
        [credential.id],
      ))?.n,
      0,
    );

    const readded = run(["add-member", "--project", projectId, "--speaker", speakerId], env);
    assert.equal(readded.status, 0, readded.stderr);
    await assert.rejects(
      authorizeProject(deps, principal, projectId, "project.read"),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
    );

    assert.equal(
      run(
        ["grant-key-project", "--credential", credential.id, "--project", projectId],
        env,
      ).status,
      0,
    );
    await authorizeProject(deps, principal, projectId, "project.read");

    const audit = await db.first<{ detail: string | null }>(
      `SELECT detail FROM audit_events
        WHERE operation = 'credential.project.revoke' AND project_id = ?
        ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    assert.ok(audit?.detail?.includes("membership.remove"));
  } finally {
    db.close();
  }
});

test("re-running add-member does not change an active membership", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run(["init", "--data-dir", dataDir, "--secrets-file", join(root, "secrets.env")]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const speakerId = run(["create-speaker", "--account", accountId, "--name", "Codex"], env)
    .stdout.trim();
  const projectId = run(["create-project", "--account", accountId, "--title", "Ops"], env)
    .stdout.trim();

  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", speakerId, "--owner"], env).status,
    0,
  );
  const first = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  let before: { capabilities: string; joined_at: string; removed_at: string | null };
  try {
    before = (await first.first<typeof before>(
      "SELECT capabilities, joined_at, removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, speakerId],
    )) as typeof before;
    assert.equal(before.removed_at, null);
    assert.ok(before.capabilities.includes('"member.manage"'));
  } finally {
    first.close();
  }

  // A non-owner re-run must not downgrade the owner membership or rewrite
  // joined_at, and it writes no second grant audit row.
  const rerun = run(["add-member", "--project", projectId, "--speaker", speakerId], env);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /already active/);
  const second = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const after = await second.first<typeof before>(
      "SELECT capabilities, joined_at, removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, speakerId],
    );
    assert.deepEqual(after, before);
    const audits = await second.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE operation = 'membership.grant' AND project_id = ? AND actor_speaker_id = ?`,
      [projectId, speakerId],
    );
    assert.equal(audits[0]?.n, 1);
  } finally {
    second.close();
  }

  // Reactivation of a removed membership may still replace capabilities.
  assert.equal(
    run(["remove-member", "--project", projectId, "--speaker", speakerId], env).status,
    0,
  );
  assert.equal(
    run(["add-member", "--project", projectId, "--speaker", speakerId], env).status,
    0,
  );
  const third = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const reactivated = await third.first<{ capabilities: string; removed_at: string | null }>(
      "SELECT capabilities, removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, speakerId],
    );
    assert.equal(reactivated?.removed_at, null);
    assert.equal(reactivated?.capabilities.includes('"member.manage"'), false);
    assert.ok(reactivated?.capabilities.includes('"message.send"'));
  } finally {
    third.close();
  }
});

test("init treats a symlinked database path as an existing installation", (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const target = join(root, "missing-target");
  symlinkSync(target, join(dataDir, "corkboard.sqlite"));
  const secretsFile = join(root, "config", "secrets.env");

  const dangling = run(["init", "--data-dir", dataDir, "--secrets-file", secretsFile]);
  assert.notEqual(dangling.status, 0);
  assert.match(dangling.stderr, /existing installation|symbolic link/);
  assert.equal(existsSync(secretsFile), false);
  assert.equal(existsSync(target), false);

  // A symlink to a real file is rejected too, and the target is untouched.
  writeFileSync(target, "existing database");
  const linked = run(["init", "--data-dir", dataDir, "--secrets-file", secretsFile]);
  assert.notEqual(linked.status, 0);
  assert.match(linked.stderr, /existing installation|symbolic link/);
  assert.equal(existsSync(secretsFile), false);
  assert.equal(readFileSync(target, "utf8"), "existing database");
});

test("remove-member audits grant revocation only when grants were deleted", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const init = run(["init", "--data-dir", dataDir, "--secrets-file", join(root, "secrets.env")]);
  assert.equal(init.status, 0, init.stderr);
  const secrets = parseSecrets(readFileSync(join(root, "secrets.env"), "utf8"));
  const env: Record<string, string> = {
    ...process.env,
    ...secrets,
    CORKBOARD_DATA_DIR: dataDir,
  };

  const accountId = run(["bootstrap-owner", "--email", "owner@example.test"], env)
    .stdout.trim();
  const projectId = run(["create-project", "--account", accountId, "--title", "Ops"], env)
    .stdout.trim();
  const speakerNoKey = run(["create-speaker", "--account", accountId, "--name", "NoKey"], env)
    .stdout.trim();
  const speakerWithKey = run(["create-speaker", "--account", accountId, "--name", "WithKey"], env)
    .stdout.trim();
  for (const speaker of [speakerNoKey, speakerWithKey]) {
    assert.equal(
      run(["add-member", "--project", projectId, "--speaker", speaker], env).status,
      0,
    );
  }
  assert.equal(
    run(["issue-key", "--speaker", speakerWithKey, "--project", projectId], env).status,
    0,
  );

  assert.equal(
    run(["remove-member", "--project", projectId, "--speaker", speakerNoKey], env).status,
    0,
  );
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const noKeyRevocations = await db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE operation = 'credential.project.revoke' AND actor_speaker_id = ?`,
      [speakerNoKey],
    );
    assert.equal(noKeyRevocations[0]?.n, 0);
    const noKeyRemovals = await db.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE operation = 'membership.remove' AND actor_speaker_id = ?`,
      [speakerNoKey],
    );
    assert.equal(noKeyRemovals[0]?.n, 1);
  } finally {
    db.close();
  }

  assert.equal(
    run(["remove-member", "--project", projectId, "--speaker", speakerWithKey], env).status,
    0,
  );
  const after = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const keyRevocations = await after.all<{ n: number }>(
      `SELECT COUNT(*) AS n FROM audit_events
        WHERE operation = 'credential.project.revoke' AND actor_speaker_id = ?`,
      [speakerWithKey],
    );
    assert.equal(keyRevocations[0]?.n, 1);
  } finally {
    after.close();
  }
});

test("init rejects a data directory path containing a newline", (t) => {
  const root = tempDir(t);
  const badDir = join(root, "bad\nline");
  const secretsFile = join(root, "secrets.env");
  const result = run(["init", "--data-dir", badDir, "--secrets-file", secretsFile]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /newline/i);
  assert.equal(existsSync(badDir), false);
  assert.equal(existsSync(secretsFile), false);
});
