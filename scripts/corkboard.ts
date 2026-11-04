#!/usr/bin/env node
// Bootstrap CLI. Prints only ids, the secrets file path, or a one-time token —
// never key material, proxy configuration, or stored message content.
import { realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { scryptSync } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateSpeakerToken, hashSecret } from "../src/auth/credentials.ts";
import { SCOPES, type Scope } from "../src/domain/authz.ts";
import { startServer } from "../src/platforms/node/main.ts";
import { openSqliteDatabase, type SqlDatabase } from "../src/storage/db.ts";

const DEFAULT_CAPABILITIES: readonly Scope[] = [
  "project.read",
  "message.read",
  "message.send",
  "receipt.write",
];

const OPTIONS = {
  "data-dir": { type: "string" },
  force: { type: "boolean" },
  email: { type: "string" },
  account: { type: "string" },
  title: { type: "string" },
  summary: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  project: { type: "string" },
  speaker: { type: "string" },
  credential: { type: "string" },
  owner: { type: "boolean" },
  "expires-at": { type: "string" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function randomId(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

function dataDirFromEnv(): string {
  return requireValue(process.env.CORKBOARD_DATA_DIR, "CORKBOARD_DATA_DIR");
}

function pepperFromEnv(): Uint8Array {
  const raw = requireValue(process.env.CORKBOARD_CREDENTIAL_PEPPER, "CORKBOARD_CREDENTIAL_PEPPER");
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.length !== 32) {
    throw new Error("CORKBOARD_CREDENTIAL_PEPPER must be base64-encoded 32 bytes");
  }
  return bytes;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = scryptSync(password, salt, 64);
  return `scrypt$${Buffer.from(salt).toString("base64")}$${hash.toString("base64")}`;
}

function normalizeEmail(raw: string): string {
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error("--email is not a valid email");
  return email;
}

async function withDb<T>(fn: (db: SqlDatabase) => Promise<T>): Promise<T> {
  const dir = dataDirFromEnv();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  const db = await openSqliteDatabase(join(dir, "corkboard.sqlite"));
  try {
    return await fn(db);
  } finally {
    db.close();
  }
}

// CLI audit rows are sanitized: identifiers and operation only, no content.
async function insertAudit(
  db: SqlDatabase,
  input: {
    operation: string;
    speakerId: string;
    accountId: string | null;
    projectId: string | null;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_events
       (id, actor_account_id, actor_speaker_id, project_id, operation, outcome, request_id, created_at)
     VALUES (?, ?, ?, ?, ?, 'success', NULL, ?)`,
    [
      randomId("evt_"),
      input.accountId,
      input.speakerId,
      input.projectId,
      input.operation,
      new Date().toISOString(),
    ],
  );
}

async function speakerAccount(db: SqlDatabase, speakerId: string): Promise<string | null> {
  const row = await db.first<{ owner_account_id: string | null }>(
    "SELECT owner_account_id FROM speakers WHERE id = ?",
    [speakerId],
  );
  if (row === undefined) throw new Error(`speaker not found: ${speakerId}`);
  return row.owner_account_id;
}

async function initCommand(values: Values): Promise<void> {
  const dataDir = requireValue(values["data-dir"], "--data-dir");
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);

  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const file = join(dataDir, "secrets.env");
  const content = [
    `CORKBOARD_ROOT_KEY=${Buffer.from(rootKey).toString("base64")}`,
    `CORKBOARD_CREDENTIAL_PEPPER=${Buffer.from(pepper).toString("base64")}`,
    `CORKBOARD_DATA_DIR=${shellQuote(dataDir)}`,
    "",
  ].join("\n");

  try {
    await writeFile(file, content, { mode: 0o600, flag: values.force ? "w" : "wx" });
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      throw new Error(`${file} exists; use --force to overwrite`);
    }
    throw error;
  }
  await chmod(file, 0o600);
  console.log(file);
}

async function bootstrapOwnerCommand(values: Values): Promise<void> {
  const email = normalizeEmail(requireValue(values.email, "--email"));
  const accountId = randomId("acct_");
  // Never accept the password in argv; only the environment is read.
  const password = process.env.CORKBOARD_BOOTSTRAP_PASSWORD;
  const passwordHash =
    password === undefined || password === "" ? null : hashPassword(password);
  await withDb((db) =>
    db.run(
      `INSERT INTO accounts (id, email, password_hash, status, created_at)
       VALUES (?, ?, ?, 'active', ?)`,
      [accountId, email, passwordHash, new Date().toISOString()],
    ),
  );
  console.log(accountId);
}

async function createProjectCommand(values: Values): Promise<void> {
  const accountId = requireValue(values.account, "--account");
  const title = requireValue(values.title, "--title");
  const projectId = randomId("proj_");
  await withDb((db) =>
    db.run(
      `INSERT INTO projects (id, owner_account_id, title, summary, status, next_seq, created_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?)`,
      [projectId, accountId, title, values.summary ?? null, new Date().toISOString()],
    ),
  );
  console.log(projectId);
}

async function createSpeakerCommand(values: Values): Promise<void> {
  const accountId = requireValue(values.account, "--account");
  const name = requireValue(values.name, "--name");
  const speakerId = randomId("spk_");
  await withDb((db) =>
    db.run(
      `INSERT INTO speakers (id, owner_account_id, display_name, description, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      [speakerId, accountId, name, values.description ?? null, new Date().toISOString()],
    ),
  );
  console.log(speakerId);
}

async function addMemberCommand(values: Values): Promise<void> {
  const projectId = requireValue(values.project, "--project");
  const speakerId = requireValue(values.speaker, "--speaker");
  const capabilities = values.owner ? SCOPES : DEFAULT_CAPABILITIES;
  await withDb(async (db) => {
    await db.run(
      `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
       VALUES (?, ?, ?, ?)`,
      [projectId, speakerId, JSON.stringify(capabilities), new Date().toISOString()],
    );
    await insertAudit(db, {
      operation: "membership.grant",
      speakerId,
      accountId: await speakerAccount(db, speakerId),
      projectId,
    });
  });
  console.log(
    values.owner
      ? `owner membership added: ${projectId} ${speakerId}`
      : `membership added: ${projectId} ${speakerId}`,
  );
}

async function removeMemberCommand(values: Values): Promise<void> {
  const projectId = requireValue(values.project, "--project");
  const speakerId = requireValue(values.speaker, "--speaker");
  await withDb(async (db) => {
    const removed = await db.run(
      `UPDATE project_memberships SET removed_at = ?
        WHERE project_id = ? AND speaker_id = ? AND removed_at IS NULL`,
      [new Date().toISOString(), projectId, speakerId],
    );
    if (removed.changes === 0) throw new Error("active membership not found");
    await insertAudit(db, {
      operation: "membership.remove",
      speakerId,
      accountId: await speakerAccount(db, speakerId),
      projectId,
    });
  });
  console.log(`membership removed: ${projectId} ${speakerId}`);
}

async function revokeKeyCommand(values: Values): Promise<void> {
  const credentialId = requireValue(values.credential, "--credential");
  await withDb(async (db) => {
    const credential = await db.first<{ speaker_id: string }>(
      "SELECT speaker_id FROM credentials WHERE id = ?",
      [credentialId],
    );
    if (credential === undefined) throw new Error(`credential not found: ${credentialId}`);
    await db.run(
      "UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      [new Date().toISOString(), credentialId],
    );
    await insertAudit(db, {
      operation: "credential.revoke",
      speakerId: credential.speaker_id,
      accountId: await speakerAccount(db, credential.speaker_id),
      projectId: null,
    });
  });
  console.log(`credential revoked: ${credentialId}`);
}

async function issueKeyCommand(values: Values): Promise<void> {
  const speakerId = requireValue(values.speaker, "--speaker");
  const projectId = requireValue(values.project, "--project");

  let expiresAt: string | null = null;
  const rawExpiry = values["expires-at"];
  if (rawExpiry !== undefined) {
    const parsed = new Date(rawExpiry);
    if (Number.isNaN(parsed.getTime())) throw new Error("--expires-at must be an ISO timestamp");
    expiresAt = parsed.toISOString();
  }

  const pepper = pepperFromEnv();

  await withDb(async (db) => {
    const membership = await db.first<{ present: number }>(
      `SELECT 1 AS present
         FROM project_memberships m
         JOIN projects p ON p.id = m.project_id
         JOIN speakers s ON s.id = m.speaker_id
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL
          AND p.status = 'active' AND s.status = 'active' AND a.status = 'active'`,
      [projectId, speakerId],
    );
    if (membership === undefined) {
      throw new Error("an active project membership is required to issue a key");
    }

    const { token, publicPrefix } = generateSpeakerToken();
    const credentialId = randomId("cred_");
    await db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialId,
        speakerId,
        publicPrefix,
        await hashSecret(token, pepper),
        JSON.stringify(DEFAULT_CAPABILITIES),
        expiresAt,
        new Date().toISOString(),
      ],
    );
    await insertAudit(db, {
      operation: "credential.issue",
      speakerId,
      accountId: await speakerAccount(db, speakerId),
      projectId,
    });
    console.log(token);
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: true,
    options: OPTIONS,
  });
  const command = positionals[0];
  switch (command) {
    case "init":
      return initCommand(values);
    case "bootstrap-owner":
      return bootstrapOwnerCommand(values);
    case "create-project":
      return createProjectCommand(values);
    case "create-speaker":
      return createSpeakerCommand(values);
    case "add-member":
      return addMemberCommand(values);
    case "remove-member":
      return removeMemberCommand(values);
    case "issue-key":
      return issueKeyCommand(values);
    case "revoke-key":
      return revokeKeyCommand(values);
    case "serve":
      await startServer();
      return;
    default:
      throw new Error(
        "usage: corkboard.ts <init|bootstrap-owner|create-project|create-speaker|add-member|remove-member|issue-key|revoke-key|serve> [options]; set CORKBOARD_BOOTSTRAP_PASSWORD in the environment (never argv) for an owner password",
      );
  }
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((error: unknown) => {
    console.error(`corkboard: ${error instanceof Error ? error.message : "command failed"}`);
    process.exit(1);
  });
}
