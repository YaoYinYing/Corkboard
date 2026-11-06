#!/usr/bin/env node
// Bootstrap CLI. Prints only ids, the secrets file path, or a one-time token —
// never key material, proxy configuration, or stored message content.
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, basename, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { generateSpeakerToken, hashSecret } from "../src/auth/credentials.ts";
import { hashPassword } from "../src/auth/password.ts";
import { SCOPES, type Scope } from "../src/domain/authz.ts";
import { normalizeEmail, validateLoginPassword } from "../src/domain/validation.ts";
import { startServer } from "../src/platforms/node/main.ts";
import {
  BackupError,
  BackupInspectError,
  RestoreError,
  createBackup,
  restoreBackup,
  verifyBackup,
} from "../src/service/backup.ts";
import { DoctorError, formatDoctorReport, runDoctor, sanitizeForTerminal } from "../src/service/doctor.ts";
import { expireDueBodies } from "../src/service/expiry.ts";
import {
  RETENTION_DEFAULT_GRACE_HOURS,
  pruneRetention,
  validateRetentionOptions,
} from "../src/service/retention.ts";
import { rotateSpeakerCredential } from "../src/service/speakers.ts";
import { LocalBlobStore } from "../src/storage/blobs/local.ts";
import { openSqliteDatabase, type SqlDatabase } from "../src/storage/db.ts";

const DEFAULT_CAPABILITIES: readonly Scope[] = [
  "project.read",
  "message.read",
  "message.send",
  "receipt.write",
];

const OPTIONS = {
  "data-dir": { type: "string" },
  out: { type: "string" },
  backup: { type: "string" },
  "secrets-file": { type: "string" },
  email: { type: "string" },
  account: { type: "string" },
  title: { type: "string" },
  summary: { type: "string" },
  name: { type: "string" },
  description: { type: "string" },
  project: { type: "string", multiple: true },
  speaker: { type: "string" },
  credential: { type: "string" },
  owner: { type: "boolean" },
  "expires-at": { type: "string" },
  scopes: { type: "string" },
  limit: { type: "string" },
  "grace-hours": { type: "string" },
  "stuck-minutes": { type: "string" },
  json: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function randomId(prefix: string): string {
  return `${prefix}${Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url")}`;
}

function requireValue(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
}

// --project is repeatable for issue-key; the single-project commands accept
// exactly one occurrence.
function singleProject(value: readonly string[] | undefined): string {
  if (value === undefined || value.length !== 1) {
    throw new Error("--project is required exactly once");
  }
  return requireValue(value[0], "--project");
}

function distinctProjects(value: readonly string[] | undefined): string[] {
  if (value === undefined || value.length === 0) {
    throw new Error("at least one --project is required");
  }
  const projects: string[] = [];
  for (const raw of value) {
    const project = requireValue(raw, "--project");
    if (projects.includes(project)) throw new Error(`duplicate --project: ${project}`);
    projects.push(project);
  }
  return projects;
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
  // A newline would split the env file into a bogus second assignment.
  if (/[\r\n]/.test(value)) {
    throw new Error("data directory path must not contain newlines");
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// A dangling symlink is still an existing path for bootstrap purposes: lstat
// sees the link even when existsSync (which follows it) returns false.
function pathOrLinkExists(target: string): boolean {
  try {
    lstatSync(target);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

function normalizeEmailArg(raw: string): string {
  return normalizeEmail(raw, "--email");
}

async function withDb<T>(fn: (db: SqlDatabase) => Promise<T>, dataDir?: string): Promise<T> {
  const dir = dataDir === undefined || dataDir === "" ? dataDirFromEnv() : dataDir;
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
// `detail` may carry JSON identifier/scope lists, never tokens or message text.
async function insertAudit(
  db: SqlDatabase,
  input: {
    operation: string;
    speakerId: string;
    accountId: string | null;
    projectId: string | null;
    detail?: string | null;
  },
): Promise<void> {
  await db.run(
    `INSERT INTO audit_events
       (id, actor_account_id, actor_speaker_id, project_id, operation, outcome, request_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, 'success', NULL, ?, ?)`,
    [
      randomId("evt_"),
      input.accountId,
      input.speakerId,
      input.projectId,
      input.operation,
      input.detail ?? null,
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

// The default keeps key material outside the data directory. XDG_CONFIG_HOME is
// honored when set, otherwise ~/.config.
function defaultSecretsFile(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  const base =
    configured !== undefined && configured !== ""
      ? configured
      : join(homedir(), ".config");
  return join(base, "corkboard", "secrets.env");
}

// Canonicalize a path that may not exist yet: resolve every existing ancestor
// with realpathSync (following symlinks), then append the unresolved remainder.
function canonicalPath(target: string): string {
  let current = resolve(target);
  const remainder: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    remainder.unshift(basename(current));
    current = parent;
  }
  const base = existsSync(current) ? realpathSync(current) : current;
  return remainder.length === 0 ? base : join(base, ...remainder);
}

function isInsideCanonical(parent: string, child: string): boolean {
  const parentPath = canonicalPath(parent);
  const childPath = canonicalPath(child);
  return childPath === parentPath || childPath.startsWith(`${parentPath}${sep}`);
}

// The secrets file must not live in the data directory, including through a
// symlinked parent or data dir. When the default secrets location is used, the
// data directory must also not live inside that secrets directory (collision).
// An explicit --secrets-file parent is operator-chosen and only the first rule
// applies.
function assertSecretsSeparated(
  dataDir: string,
  secretsFile: string,
  secretsIsDefault: boolean,
): void {
  if (isInsideCanonical(dataDir, secretsFile)) {
    throw new Error("--secrets-file must resolve outside the data directory");
  }
  if (secretsIsDefault && isInsideCanonical(dirname(secretsFile), dataDir)) {
    throw new Error("the data directory must not resolve inside the secrets directory");
  }
}

// Bootstrap only. Refuses to touch an existing installation: no key material is
// generated, no file is written, and there is no overwrite mode. Intentional
// key rotation is a separate, unimplemented operation (see docs/security-operations.md).
async function initCommand(values: Values): Promise<void> {
  const dataDir = requireValue(values["data-dir"], "--data-dir");
  if (/[\r\n]/.test(dataDir)) {
    throw new Error("--data-dir must not contain newlines");
  }
  const secretsOverride =
    values["secrets-file"] === undefined || values["secrets-file"] === ""
      ? undefined
      : values["secrets-file"];
  const secretsFile = secretsOverride ?? defaultSecretsFile();
  const secretsIsDefault = secretsOverride === undefined;

  assertSecretsSeparated(dataDir, secretsFile, secretsIsDefault);
  const databaseFile = join(dataDir, "corkboard.sqlite");
  // lstat also catches a dangling symlink, which existsSync would miss.
  if (pathOrLinkExists(databaseFile)) {
    throw new Error(
      `${databaseFile} exists or is a symbolic link; init refuses to modify an existing installation`,
    );
  }
  if (pathOrLinkExists(secretsFile)) {
    throw new Error(`${secretsFile} exists; refusing to overwrite existing secrets`);
  }

  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const secretsDir = dirname(secretsFile);
  await mkdir(secretsDir, { recursive: true, mode: 0o700 });
  await chmod(secretsDir, 0o700);

  // Re-check now that the paths exist: creation must not have been redirected
  // by a symlink introduced after the first check.
  assertSecretsSeparated(dataDir, secretsFile, secretsIsDefault);
  const databaseAfter = join(dataDir, "corkboard.sqlite");
  if (pathOrLinkExists(databaseAfter) || pathOrLinkExists(secretsFile)) {
    throw new Error(`${secretsFile} exists; refusing to overwrite existing secrets`);
  }

  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const content = [
    `CORKBOARD_ROOT_KEY=${Buffer.from(rootKey).toString("base64")}`,
    `CORKBOARD_CREDENTIAL_PEPPER=${Buffer.from(pepper).toString("base64")}`,
    `CORKBOARD_DATA_DIR=${shellQuote(dataDir)}`,
    "",
  ].join("\n");

  // Final canonical check immediately before the write.
  assertSecretsSeparated(dataDir, secretsFile, secretsIsDefault);
  try {
    await writeFile(secretsFile, content, { mode: 0o600, flag: "wx" });
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") {
      throw new Error(`${secretsFile} exists; refusing to overwrite existing secrets`);
    }
    throw error;
  }
  await chmod(secretsFile, 0o600);
  console.log(secretsFile);
}

async function bootstrapOwnerCommand(values: Values): Promise<void> {
  const email = normalizeEmailArg(requireValue(values.email, "--email"));
  const accountId = randomId("acct_");
  // Never accept the password in argv; only the environment is read.
  const password = process.env.CORKBOARD_BOOTSTRAP_PASSWORD;
  // Same cap as login: a longer password could never be submitted at sign-in.
  const passwordHash =
    password === undefined || password === ""
      ? null
      : await hashPassword(validateLoginPassword(password));
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
  const projectId = singleProject(values.project);
  const speakerId = requireValue(values.speaker, "--speaker");
  const capabilities = values.owner ? SCOPES : DEFAULT_CAPABILITIES;
  const changed = await withDb(async (db) => {
    // Only a removed membership may be reactivated. Re-running on an active
    // membership is a no-op, so it cannot silently downgrade or widen rights.
    const result = await db.run(
      `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (project_id, speaker_id) DO UPDATE SET
         capabilities = excluded.capabilities,
         joined_at = excluded.joined_at,
         removed_at = NULL
       WHERE project_memberships.removed_at IS NOT NULL`,
      [projectId, speakerId, JSON.stringify(capabilities), new Date().toISOString()],
    );
    if (result.changes === 0) return false;
    await insertAudit(db, {
      operation: "membership.grant",
      speakerId,
      accountId: await speakerAccount(db, speakerId),
      projectId,
    });
    return true;
  });
  if (!changed) {
    console.log(`membership already active: ${projectId} ${speakerId}`);
    return;
  }
  console.log(
    values.owner
      ? `owner membership added: ${projectId} ${speakerId}`
      : `membership added: ${projectId} ${speakerId}`,
  );
}

async function removeMemberCommand(values: Values): Promise<void> {
  const projectId = singleProject(values.project);
  const speakerId = requireValue(values.speaker, "--speaker");
  await withDb(async (db) => {
    const removed = await db.run(
      `UPDATE project_memberships SET removed_at = ?
        WHERE project_id = ? AND speaker_id = ? AND removed_at IS NULL`,
      [new Date().toISOString(), projectId, speakerId],
    );
    if (removed.changes === 0) throw new Error("active membership not found");
    // Removing a membership also removes that speaker's grants for the project,
    // so re-adding the membership cannot revive an old credential. Grants are
    // not restored automatically; they must be granted again explicitly.
    const grants = await db.run(
      `DELETE FROM credential_project_grants
        WHERE project_id = ?
          AND credential_id IN (SELECT id FROM credentials WHERE speaker_id = ?)`,
      [projectId, speakerId],
    );
    await insertAudit(db, {
      operation: "membership.remove",
      speakerId,
      accountId: await speakerAccount(db, speakerId),
      projectId,
    });
    // Audit a grant revocation only when a grant was actually deleted.
    if (grants.changes > 0) {
      await insertAudit(db, {
        operation: "credential.project.revoke",
        speakerId,
        accountId: await speakerAccount(db, speakerId),
        projectId,
        detail: JSON.stringify({ projects: [projectId], source: "membership.remove" }),
      });
    }
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

function parseIssuedScopes(raw: string | undefined): Scope[] {
  if (raw === undefined) return [...DEFAULT_CAPABILITIES];
  const parts = raw.split(",");
  if (parts.length === 0 || parts.some((part) => part === "")) {
    throw new Error("--scopes must be a comma-separated list of scopes");
  }
  const requested = new Set<Scope>();
  for (const part of parts) {
    if (!(SCOPES as readonly string[]).includes(part)) {
      throw new Error(`unknown scope: ${part}`);
    }
    const scope = part as Scope;
    if (requested.has(scope)) throw new Error(`duplicate scope: ${scope}`);
    requested.add(scope);
  }
  return SCOPES.filter((scope) => requested.has(scope));
}

// Active membership capabilities for the (project, speaker) pair, or undefined
// when any principal in the chain is missing/inactive.
async function activeMembershipCapabilities(
  db: SqlDatabase,
  projectId: string,
  speakerId: string,
): Promise<Set<Scope> | undefined> {
  const membership = await db.first<{ capabilities: string }>(
    `SELECT m.capabilities
       FROM project_memberships m
       JOIN projects p ON p.id = m.project_id
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL
        AND p.status = 'active' AND s.status = 'active' AND a.status = 'active'`,
    [projectId, speakerId],
  );
  if (membership === undefined) return undefined;

  let granted: unknown;
  try {
    granted = JSON.parse(membership.capabilities);
  } catch {
    granted = [];
  }
  return new Set(
    Array.isArray(granted)
      ? granted.filter(
          (value): value is Scope =>
            typeof value === "string" && (SCOPES as readonly string[]).includes(value),
        )
      : [],
  );
}

async function issueKeyCommand(values: Values): Promise<void> {
  const speakerId = requireValue(values.speaker, "--speaker");
  const projectIds = distinctProjects(values.project);
  const requestedScopes = parseIssuedScopes(values.scopes);

  let expiresAt: string | null = null;
  const rawExpiry = values["expires-at"];
  if (rawExpiry !== undefined) {
    const parsed = new Date(rawExpiry);
    if (Number.isNaN(parsed.getTime())) throw new Error("--expires-at must be an ISO timestamp");
    expiresAt = parsed.toISOString();
  }

  const pepper = pepperFromEnv();

  await withDb(async (db) => {
    for (const projectId of projectIds) {
      const allowed = await activeMembershipCapabilities(db, projectId, speakerId);
      if (allowed === undefined) {
        throw new Error(
          `an active project membership is required to issue a key: ${projectId}`,
        );
      }
      for (const scope of requestedScopes) {
        if (!allowed.has(scope)) {
          throw new Error(`scope not granted by the speaker's active membership: ${scope}`);
        }
      }
    }

    const { token, publicPrefix } = generateSpeakerToken();
    const credentialId = randomId("cred_");
    const createdAt = new Date().toISOString();
    let inserted = false;
    try {
      await db.run(
        `INSERT INTO credentials
           (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          credentialId,
          speakerId,
          publicPrefix,
          await hashSecret(token, pepper),
          JSON.stringify(requestedScopes),
          expiresAt,
          createdAt,
        ],
      );
      inserted = true;
      for (const projectId of projectIds) {
        await db.run(
          `INSERT OR IGNORE INTO credential_project_grants
             (credential_id, project_id, granted_at)
           VALUES (?, ?, ?)`,
          [credentialId, projectId, createdAt],
        );
      }
      await insertAudit(db, {
        operation: "credential.issue",
        speakerId,
        accountId: await speakerAccount(db, speakerId),
        projectId: projectIds.length === 1 ? (projectIds[0] ?? null) : null,
        detail: JSON.stringify({
          projects: projectIds,
          scopes: requestedScopes,
        }),
      });
    } catch (error) {
      // Credential issuance does not use the SqlDatabase transaction() helper;
      // it compensates explicitly: grants first, then the credential.
      // Cleanup failures must not replace the original error. A crash before
      // cleanup leaves a grantless credential, which is denied by default and
      // can be revoked; no token is printed until every write succeeds.
      if (inserted) {
        try {
          await db.run(
            "DELETE FROM credential_project_grants WHERE credential_id = ?",
            [credentialId],
          );
        } catch {
          // Best-effort compensation.
        }
        try {
          await db.run("DELETE FROM credentials WHERE id = ?", [credentialId]);
        } catch {
          // Best-effort compensation.
        }
      }
      throw error;
    }
    console.log(token);
  });
}

// Operator rotation: one transaction replaces an active credential with an
// identical-scope, identical-grant credential for the same speaker and revokes
// the old row. Prints only the new token, exactly like `issue-key`. Without
// --expires-at the old credential's exact expiry timestamp is preserved, so a
// near-expiry key stays near expiry; pass --expires-at to move it.
async function rotateKeyCommand(values: Values): Promise<void> {
  const credentialId = requireValue(values.credential, "--credential");
  const pepper = pepperFromEnv();
  const rotated = await withDb((db) =>
    rotateSpeakerCredential(
      { db, pepper, now: () => new Date() },
      { credentialId, expiresAt: values["expires-at"] },
    ),
  );
  console.log(rotated.token);
}

async function grantKeyProjectCommand(values: Values): Promise<void> {
  const credentialId = requireValue(values.credential, "--credential");
  const projectId = singleProject(values.project);
  await withDb(async (db) => {
    const credential = await db.first<{ speaker_id: string }>(
      "SELECT speaker_id FROM credentials WHERE id = ?",
      [credentialId],
    );
    if (credential === undefined) throw new Error(`credential not found: ${credentialId}`);
    if ((await activeMembershipCapabilities(db, projectId, credential.speaker_id)) === undefined) {
      throw new Error("an active project membership is required to grant a project");
    }
    const grantedAt = new Date().toISOString();
    await db.run(
      `INSERT OR IGNORE INTO credential_project_grants
         (credential_id, project_id, granted_at)
       VALUES (?, ?, ?)`,
      [credentialId, projectId, grantedAt],
    );
    await insertAudit(db, {
      operation: "credential.project.grant",
      speakerId: credential.speaker_id,
      accountId: await speakerAccount(db, credential.speaker_id),
      projectId,
      detail: JSON.stringify({ projects: [projectId] }),
    });
  });
  console.log(`project granted: ${credentialId} ${projectId}`);
}

async function revokeKeyProjectCommand(values: Values): Promise<void> {
  const credentialId = requireValue(values.credential, "--credential");
  const projectId = singleProject(values.project);
  await withDb(async (db) => {
    const credential = await db.first<{ speaker_id: string }>(
      "SELECT speaker_id FROM credentials WHERE id = ?",
      [credentialId],
    );
    if (credential === undefined) throw new Error(`credential not found: ${credentialId}`);
    const removed = await db.run(
      `DELETE FROM credential_project_grants
        WHERE credential_id = ? AND project_id = ?`,
      [credentialId, projectId],
    );
    if (removed.changes === 0) throw new Error("project grant not found");
    await insertAudit(db, {
      operation: "credential.project.revoke",
      speakerId: credential.speaker_id,
      accountId: await speakerAccount(db, credential.speaker_id),
      projectId,
      detail: JSON.stringify({ projects: [projectId] }),
    });
  });
  console.log(`project grant revoked: ${credentialId} ${projectId}`);
}

function parseExpiryLimit(raw: string | undefined): number {
  if (raw === undefined) return 500;
  if (!/^\d+$/.test(raw)) throw new Error("--limit must be an integer 1-5000");
  const value = Number(raw);
  if (value < 1 || value > 5000) throw new Error("--limit must be an integer 1-5000");
  return value;
}

// Usage/config failures exit 2; a failed run exits 1. Invalid values are
// rejected before the data directory is created or the database is opened.
class PruneCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PruneCliError";
  }
}

function parseGraceHours(raw: string | undefined): number {
  if (raw === undefined) return RETENTION_DEFAULT_GRACE_HOURS;
  if (raw === "" || !/^\d+(\.\d+)?$/.test(raw)) {
    throw new PruneCliError("--grace-hours must be a non-negative number");
  }
  try {
    return validateRetentionOptions({ graceHours: Number(raw) }).graceHours;
  } catch (error) {
    throw new PruneCliError(error instanceof Error ? error.message : "invalid --grace-hours");
  }
}

function parseRetentionLimit(raw: string | undefined): number {
  if (raw === undefined) return validateRetentionOptions().limit;
  if (!/^\d+$/.test(raw)) {
    throw new PruneCliError("--limit must be an integer 1-10000");
  }
  try {
    return validateRetentionOptions({ limit: Number(raw) }).limit;
  } catch (error) {
    throw new PruneCliError(error instanceof Error ? error.message : "invalid --limit");
  }
}

// Explicit, operator-run retention. No timer runs this; schedule it externally.
// Prints one JSON line with --json, otherwise short counts only. Never prints
// row contents, tokens, or emails.
async function pruneCommand(values: Values): Promise<void> {
  const graceHours = parseGraceHours(values["grace-hours"]);
  const limit = parseRetentionLimit(values.limit);
  const rawDir = values["data-dir"];
  const dir =
    rawDir === undefined || rawDir === ""
      ? process.env.CORKBOARD_DATA_DIR
      : rawDir;
  if (dir === undefined || dir === "") {
    throw new PruneCliError("--data-dir or CORKBOARD_DATA_DIR is required");
  }

  const summary = await withDb(
    (db) => pruneRetention({ db, now: () => new Date() }, { graceHours, limit }),
    dir,
  );
  if (values.json === true) {
    console.log(JSON.stringify(summary));
    return;
  }
  for (const line of [
    `grace-hours: ${summary.graceHours}`,
    `limit: ${summary.limit}`,
    `sessions deleted: ${summary.sessions}`,
    `authorization codes deleted: ${summary.authorizationCodes}`,
    `refresh tokens deleted: ${summary.refreshTokens}`,
    `token clients deleted: ${summary.tokenClients}`,
    `oauth credentials deleted: ${summary.oauthCredentials}`,
  ]) {
    console.log(line);
  }
}

// Operator-run cleanup: no in-process timer exists, so schedule this command
// externally. Prints exactly one JSON summary line.
async function expireBodiesCommand(values: Values): Promise<void> {
  const dataDir = values["data-dir"];
  const dir = dataDir === undefined || dataDir === "" ? dataDirFromEnv() : dataDir;
  const limit = parseExpiryLimit(values.limit);

  const summary = await withDb(async (db) => {
    const blobs = new LocalBlobStore(join(dir, "blobs"));
    return expireDueBodies({ db, blobs, now: () => new Date() }, { limit });
  }, dir);
  console.log(JSON.stringify(summary));
  if (summary.failures > 0) process.exitCode = 1;
}

// Doctor argument and data-access failures exit 2; a completed report with
// issues exits 1. Keeping this distinct lets callers/scripts tell "could not
// inspect" from "inspected and found problems".
class DoctorCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorCliError";
  }
}

const MAX_STUCK_MINUTES = 5_256_000; // ten years; keeps the threshold a valid date

function parseStuckMinutes(raw: string | undefined): number {
  if (raw === undefined) return 60;
  if (!/^\d+$/.test(raw)) {
    throw new DoctorCliError(
      `--stuck-minutes must be an integer between 0 and ${MAX_STUCK_MINUTES}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAX_STUCK_MINUTES) {
    throw new DoctorCliError(
      `--stuck-minutes must be an integer between 0 and ${MAX_STUCK_MINUTES}`,
    );
  }
  return value;
}

// Read-only diagnostics: no repair/fix mode, no migrations, no writes.
async function doctorCommand(values: Values, extraPositionals: number): Promise<void> {
  if (extraPositionals > 0) {
    throw new DoctorCliError("doctor accepts no positional arguments");
  }
  const rawDir = values["data-dir"];
  const dataDir =
    rawDir === undefined || rawDir === "" ? process.env.CORKBOARD_DATA_DIR : rawDir;
  if (dataDir === undefined || dataDir === "") {
    throw new DoctorCliError("--data-dir or CORKBOARD_DATA_DIR is required");
  }
  const stuckMinutes = parseStuckMinutes(values["stuck-minutes"]);
  let report;
  try {
    report = await runDoctor({ dataDir, stuckMinutes });
  } catch (error) {
    if (error instanceof DoctorError) throw new DoctorCliError(error.message);
    throw new DoctorCliError("doctor failed");
  }
  if (values.json === true) {
    console.log(JSON.stringify(report));
  } else {
    for (const line of formatDoctorReport(report)) console.log(line);
  }
  if (report.issues.length > 0) process.exitCode = 1;
}

// Backup/verify/restore argument failures exit 2 before touching the
// filesystem; validation findings and runtime refusals exit 1.
class BackupCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupCliError";
  }
}

function backupOption(value: string | undefined, name: string): string {
  if (value === undefined || value === "") {
    throw new BackupCliError(`${name} is required`);
  }
  return value;
}

// Operator-facing error text must not expose an absolute path (for example a
// temporary staging directory) on stderr. Quoted paths are replaced as a whole
// so spaces inside the path cannot leak the remainder.
export function redactPaths(message: string): string {
  return message
    .replace(/'[^']*\/[^']*'/g, "'<path>'")
    .replace(/"[^"]*\/[^"]*"/g, '"<path>"')
    .replace(/(?:\/[^\s"']+)+/g, "<path>");
}

function printCliFailure(code: string, message: string, json: boolean): void {
  if (json) console.log(JSON.stringify({ ok: false, code }));
  console.error(`corkboard: ${sanitizeForTerminal(redactPaths(message))}`);
}

function printVerifyIssues(report: {
  issues: Array<{ code: string; file?: string }>;
  issues_truncated: boolean;
}): void {
  const listed = report.issues
    .map((issue) => {
      const text = issue.file === undefined ? issue.code : `${issue.code}(${issue.file})`;
      // File names can be attacker-chosen; never let control bytes reach a
      // terminal in human output. JSON escaping already covers --json.
      return sanitizeForTerminal(text);
    })
    .join(", ");
  const suffix = report.issues_truncated ? ", ... (truncated)" : "";
  console.log(report.issues.length === 0 ? "issues: none" : `issues: ${listed}${suffix}`);
}

// Creates a consistent SQLite snapshot plus an exact copy of the blob
// directory into a new 0700 directory. Never writes to the source.
async function backupCommand(values: Values, extraPositionals: number): Promise<void> {
  if (extraPositionals > 0) throw new BackupCliError("backup accepts no positional arguments");
  const dataDir = backupOption(values["data-dir"], "--data-dir");
  const outDir = backupOption(values.out, "--out");
  const json = values.json === true;
  try {
    const summary = await createBackup({ dataDir, outDir });
    if (json) {
      console.log(JSON.stringify(summary));
      return;
    }
    console.log(`database: ${summary.database.file} (${summary.database.size} bytes, sha256:${summary.database.sha256})`);
    console.log(`blobs: ${summary.blobs} (${summary.blob_bytes} bytes)`);
    console.log(`schema: version ${summary.schema_version}`);
    console.log(`created_at: ${summary.created_at}`);
  } catch (error) {
    if (error instanceof BackupError) {
      printCliFailure(error.code, error.message, json);
      process.exitCode = 1;
      return;
    }
    printCliFailure("BACKUP_FAILED", error instanceof Error ? error.message : "backup failed", json);
    process.exitCode = 1;
  }
}

// Validates the manifest, every size/digest, required and unexpected entries,
// PRAGMA integrity_check, schema compatibility, and blob referential integrity.
async function verifyBackupCommand(values: Values, extraPositionals: number): Promise<void> {
  if (extraPositionals > 0) throw new BackupCliError("verify accepts no positional arguments");
  const backupDir = backupOption(values.backup, "--backup");
  const json = values.json === true;
  let report;
  try {
    report = await verifyBackup({ backupDir });
  } catch (error) {
    if (error instanceof BackupInspectError) {
      printCliFailure("BACKUP_INSPECT_FAILED", error.message, json);
      process.exitCode = 2;
      return;
    }
    printCliFailure("VERIFY_FAILED", error instanceof Error ? error.message : "verify failed", json);
    process.exitCode = 1;
    return;
  }
  if (json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(`ok: ${report.ok ? "yes" : "no"}`);
    console.log(
      `database: ${report.database === null ? "unavailable" : `${report.database.file} (${report.database.size} bytes)`}`,
    );
    console.log(
      `blobs: ${report.blobs === null ? "unavailable" : `${report.blobs.count} (${report.blobs.bytes} bytes)`}`,
    );
    console.log(`schema: ${report.schema_version === null ? "unavailable" : `version ${report.schema_version}`}`);
    printVerifyIssues(report);
  }
  if (!report.ok) process.exitCode = 1;
}

// Verifies first, then installs into a temporary sibling and renames it. The
// target must be absent or empty; nothing is ever overwritten.
async function restoreCommand(values: Values, extraPositionals: number): Promise<void> {
  if (extraPositionals > 0) throw new BackupCliError("restore accepts no positional arguments");
  const backupDir = backupOption(values.backup, "--backup");
  const dataDir = backupOption(values["data-dir"], "--data-dir");
  const json = values.json === true;
  try {
    const summary = await restoreBackup({ backupDir, dataDir });
    if (json) {
      console.log(JSON.stringify(summary));
      return;
    }
    console.log(`restored: schema version ${summary.schema_version}`);
    console.log(`database: ${summary.database.file} (${summary.database.size} bytes, sha256:${summary.database.sha256})`);
    console.log(`blobs: ${summary.blobs} (${summary.blob_bytes} bytes)`);
  } catch (error) {
    if (error instanceof BackupInspectError) {
      printCliFailure("BACKUP_INSPECT_FAILED", error.message, json);
      process.exitCode = 2;
      return;
    }
    if (error instanceof RestoreError) {
      if (json) {
        console.log(
          JSON.stringify({ ok: false, code: error.code, issues: error.issues }),
        );
      } else {
        console.error(`corkboard: ${sanitizeForTerminal(redactPaths(error.message))}`);
        for (const issue of error.issues) {
          const text = issue.file === undefined ? issue.code : `${issue.code}(${issue.file})`;
          console.error(sanitizeForTerminal(text));
        }
      }
      process.exitCode = 1;
      return;
    }
    printCliFailure("RESTORE_FAILED", error instanceof Error ? error.message : "restore failed", json);
    process.exitCode = 1;
  }
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
    case "rotate-key":
      return rotateKeyCommand(values);
    case "grant-key-project":
      return grantKeyProjectCommand(values);
    case "revoke-key-project":
      return revokeKeyProjectCommand(values);
    case "revoke-key":
      return revokeKeyCommand(values);
    case "expire-bodies":
      return expireBodiesCommand(values);
    case "prune":
      return pruneCommand(values);
    case "doctor":
      return doctorCommand(values, positionals.length - 1);
    case "backup":
      return backupCommand(values, positionals.length - 1);
    case "verify":
      return verifyBackupCommand(values, positionals.length - 1);
    case "restore":
      return restoreCommand(values, positionals.length - 1);
    case "serve":
      await startServer();
      return;
    default:
      throw new Error(
        "usage: corkboard.ts <init|bootstrap-owner|create-project|create-speaker|add-member|remove-member|issue-key|rotate-key|grant-key-project|revoke-key-project|revoke-key|expire-bodies|prune|doctor|backup|verify|restore|serve> [options]; backup accepts --data-dir and --out; verify accepts --backup; restore accepts --backup and --data-dir; all three accept --json; init accepts --data-dir and optional --secrets-file; issue-key accepts one or more --project and --scopes <comma-separated>; rotate-key accepts --credential and optional --expires-at (default preserves the old expiry); prune accepts --data-dir (or CORKBOARD_DATA_DIR), --grace-hours <N>, --limit <N>, and --json; doctor is read-only and accepts --data-dir, --stuck-minutes <N>, and --json; set CORKBOARD_BOOTSTRAP_PASSWORD in the environment (never argv) for an owner password",
      );
  }
}

// Best-effort command detection for the error handler, including when strict
// parsing rejects the arguments before the switch runs.
function argvCommand(args: readonly string[]): string | undefined {
  const stringOptions = new Set(
    Object.entries(OPTIONS)
      .filter(([, option]) => option.type === "string")
      .map(([name]) => `--${name}`),
  );
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--") return args[index + 1];
    if (stringOptions.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("--")) continue;
    if (!arg.startsWith("-")) return arg;
  }
  return undefined;
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
    const message = error instanceof Error ? error.message : "command failed";
    // Doctor reports inspection problems as exit 1; anything that prevents a
    // report (bad arguments, unreadable directory, busy/locked database) is 2.
    // Prune uses 2 only for usage/config errors; a failed run is 1.
    const command = argvCommand(process.argv.slice(2));
    const parseCode = (error as { code?: unknown }).code;
    const parseFailure =
      typeof parseCode === "string" && parseCode.startsWith("ERR_PARSE_ARGS");
    const backupCommandName =
      command === "backup" || command === "verify" || command === "restore";
    const exitCode =
      error instanceof DoctorCliError ||
      command === "doctor" ||
      error instanceof PruneCliError ||
      error instanceof BackupCliError ||
      ((command === "prune" || backupCommandName) && parseFailure)
        ? 2
        : 1;
    if (backupCommandName) {
      // Commands handle their own runtime failures; reaching here means a usage
      // error or an unexpected escape. JSON mode still gets one stdout object.
      if (process.argv.slice(2).includes("--json")) {
        const code =
          exitCode === 2
            ? "USAGE_ERROR"
            : command === "verify"
              ? "VERIFY_FAILED"
              : command === "restore"
                ? "RESTORE_FAILED"
                : "BACKUP_FAILED";
        console.log(JSON.stringify({ ok: false, code }));
      }
      console.error(`corkboard: ${sanitizeForTerminal(redactPaths(message))}`);
      process.exit(exitCode);
    }
    console.error(`corkboard: ${message}`);
    process.exit(exitCode);
  });
}
