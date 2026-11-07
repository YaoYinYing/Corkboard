#!/usr/bin/env node
// Executable disaster rehearsal for the self-hosted Node.js + SQLite + local
// blob deployment (TODO 411). Everything happens inside a fresh temporary
// directory tree that this process creates and removes. It never touches a real
// installation, never prints a secret, token, key, message body, or full path,
// and uses only the standard library plus the existing CLI/service code.
//
// The rehearsal is intentionally in-process for the service surface: it builds
// the same `createApp` router the Node adapter serves, so REST/MCP/cursor
// requests exercise real authentication, authorization, encryption and storage.
// The HTTP listener adapter itself is covered by the existing integration tests.
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ServiceDeps } from "../src/service/auth.ts";
import type { SqlDatabase, SqlTransaction, SqlValue } from "../src/storage/db.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = dirname(SCRIPT_DIR);
const SOURCE_RUN = import.meta.url.endsWith(".ts");
const CLI_PATH = join(SCRIPT_DIR, SOURCE_RUN ? "corkboard.ts" : "corkboard.js");
const SERVICE_ID = "corkboard";
const CLI_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;

type App = (request: Request) => Promise<Response>;

export interface RehearsalCheck {
  id: string;
  ok: true;
}

export interface RehearsalSummary {
  messages: number;
  receipts: number;
  audit_events: number;
  blobs: number;
  schema_version: number;
}

export interface RehearsalReport {
  ok: boolean;
  skipped?: boolean;
  reason?: string;
  checks: RehearsalCheck[];
  summary: RehearsalSummary;
  failed_check?: string;
  error?: string;
}

export const REQUIRED_CHECK_IDS = [
  "init-private",
  "seed-accounts",
  "seed-messages",
  "seed-receipts",
  "seed-audit",
  "backup-verify",
  "backup-excludes-secrets",
  "keys-backed-up-separately",
  "restored-secrets-file",
  "disaster-live-removed",
  "restore-verify",
  "doctor-clean",
  "restore-sequences",
  "restore-receipts",
  "restore-audit",
  "restore-body-decrypt",
  "restore-wrong-key-fails-closed",
  "restore-send-read",
  "audit-sanitized",
  "audit-not-tamper-evident",
  "cursor-from-scratch",
  "cursor-replay-no-duplicates",
  "cursor-binding",
  "revoke-rest-fails-closed",
  "revoke-mcp-fails-closed",
  "rotate-old-fails",
  "rotate-new-works",
  "interrupted-send-stuck-pending",
  "interrupted-send-temp-artifact-excluded",
  "interrupted-send-resume-single-commit",
  "cleanup-live-data-intact",
  "cleanup",
] as const;

interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

interface Installation {
  db: SqlDatabase & { close(): void };
  deps: ServiceDeps;
  app: App;
}

interface Snapshot {
  messageIds: string[];
  seqs: number[];
  receiptKeys: string[];
  auditCount: number;
  auditOperations: string[];
  nextSeq: number;
  blobCount: number;
}

interface RunState {
  checks: RehearsalCheck[];
  summary: RehearsalSummary;
  closers: Array<() => void>;
}

class RehearsalFailure extends Error {
  readonly checkId: string;

  constructor(checkId: string, message: string) {
    super(message);
    this.name = "RehearsalFailure";
    this.checkId = checkId;
  }
}

// ---------------------------------------------------------------- host / CLI

export function hostCapabilityIssue(): string | undefined {
  const major = Number(process.versions.node.split(".")[0]);
  if (!Number.isFinite(major) || major < 24) {
    return `Node.js >= 24 is required (found ${process.versions.node})`;
  }
  if (process.platform === "win32") {
    return "POSIX 0600/0700 file modes are required";
  }
  if (typeof globalThis.crypto?.subtle === "undefined") {
    return "WebCrypto (crypto.subtle) is required";
  }
  return undefined;
}

function redactOnce(text: string, secret: string): string {
  if (secret === "") return text;
  return text.split(secret).join("[REDACTED]");
}

// Redact longest values first so a token that contains a shorter candidate is
// removed whole. Exported for the unit test.
export function redactSensitive(text: string, secrets: readonly string[]): string {
  const ordered = [...new Set(secrets.filter((secret) => secret !== ""))].sort(
    (a, b) => b.length - a.length,
  );
  let output = text;
  for (const secret of ordered) output = redactOnce(output, secret);
  return output;
}

// The secrets file `init` writes is a sequence of KEY='value' lines. Only the
// three bootstrap variables are understood; anything else is ignored.
export function parseSecretsFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (line === "" || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals);
    let value = line.slice(equals + 1);
    if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
      value = value.slice(1, -1).replaceAll(`'\\''`, `'`);
    }
    values[key] = value;
  }
  return values;
}

function shellQuote(value: string): string {
  if (/[\r\n]/.test(value)) throw new RehearsalFailure("secrets-file", "invalid data path");
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function secretsFileContent(
  secrets: Readonly<Record<string, string>>,
  dataDir: string,
): string {
  return [
    `CORKBOARD_ROOT_KEY=${secrets.CORKBOARD_ROOT_KEY ?? ""}`,
    `CORKBOARD_CREDENTIAL_PEPPER=${secrets.CORKBOARD_CREDENTIAL_PEPPER ?? ""}`,
    `CORKBOARD_DATA_DIR=${shellQuote(dataDir)}`,
    "",
  ].join("\n");
}

// Only process settings needed to launch Node. Every inherited CORKBOARD_*
// value (including a real CORKBOARD_BOOTSTRAP_PASSWORD) and every other key
// variable is deliberately dropped before the CLI sees the environment.
const CHILD_ENV_KEYS = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TZ"] as const;

export function childEnv(
  overrides: Readonly<Record<string, string>>,
  parent: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of CHILD_ENV_KEYS) {
    const value = parent[key];
    if (value !== undefined) env[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) env[key] = value;
  return env;
}

function runCli(args: readonly string[], env: Readonly<Record<string, string>>): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: APP_ROOT,
      env: childEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: CliResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ status: -1, stdout, stderr });
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", () => finish({ status: -1, stdout, stderr }));
    child.on("close", (code) =>
      finish({ status: typeof code === "number" ? code : -1, stdout, stderr }),
    );
  });
}

// Test seam for the failure-path integration test. Read only by the parent
// process; childEnv never forwards it to a CLI.
const FORCED_FAILURE_AFTER = process.env.CORKBOARD_REHEARSAL_TEST_FAIL_AFTER;

function check(
  state: RunState,
  id: string,
  condition: boolean,
  failureMessage?: string,
): void {
  if (!condition) throw new RehearsalFailure(id, failureMessage ?? "assertion failed");
  state.checks.push({ id, ok: true });
  if (FORCED_FAILURE_AFTER !== undefined && id === FORCED_FAILURE_AFTER) {
    throw new RehearsalFailure(id, "forced failure for the failure-path test");
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return false;
    throw error;
  }
}

async function modeOf(path: string): Promise<number> {
  return (await lstat(path)).mode & 0o777;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function randomTempArtifactName(): string {
  return `.tmp-${randomBytes(16).toString("hex")}`;
}

async function countRegularBlobs(blobDir: string): Promise<number> {
  try {
    const entries = await readdir(blobDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile()).length;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return 0;
    throw error;
  }
}

// ------------------------------------------------------------- service access

type ServiceModules = {
  backup: typeof import("../src/service/backup.ts");
  doctor: typeof import("../src/service/doctor.ts");
  messages: typeof import("../src/service/messages.ts");
  auth: typeof import("../src/service/auth.ts");
  local: typeof import("../src/storage/blobs/local.ts");
  db: typeof import("../src/storage/db.ts");
  keys: typeof import("../src/crypto/keys.ts");
  handlers: typeof import("../src/app/handlers.ts");
  poll: typeof import("./poll.ts");
};

async function loadModules(): Promise<ServiceModules> {
  return {
    backup: await import("../src/service/backup.ts"),
    doctor: await import("../src/service/doctor.ts"),
    messages: await import("../src/service/messages.ts"),
    auth: await import("../src/service/auth.ts"),
    local: await import("../src/storage/blobs/local.ts"),
    db: await import("../src/storage/db.ts"),
    keys: await import("../src/crypto/keys.ts"),
    handlers: await import("../src/app/handlers.ts"),
    poll: await import("./poll.ts"),
  };
}

function pepperFrom(env: Readonly<Record<string, string>>): Uint8Array {
  const raw = env.CORKBOARD_CREDENTIAL_PEPPER ?? "";
  const bytes = new Uint8Array(Buffer.from(raw, "base64"));
  if (bytes.length !== 32) throw new RehearsalFailure("secrets-file", "pepper is not 32 bytes");
  return bytes;
}

async function openInstallation(
  modules: ServiceModules,
  state: RunState,
  dataDir: string,
  env: Readonly<Record<string, string>>,
): Promise<Installation> {
  const db = await modules.db.openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  state.closers.push(() => {
    try {
      db.close();
    } catch {
      // Already closed or the directory was removed on failure.
    }
  });
  const deps: ServiceDeps = {
    db,
    blobs: new modules.local.LocalBlobStore(join(dataDir, "blobs")),
    keys: await modules.keys.keyProviderFromEnv(env),
    pepper: pepperFrom(env),
    serviceId: SERVICE_ID,
    now: () => new Date(),
  };
  return { db, deps, app: modules.handlers.createApp(deps) };
}

// Simulates a process that dies after the provisional write and before the
// finalize UPDATE. Only the publication statement fails; every other read and
// write reaches the real database.
function crashBeforeFinalize(
  db: SqlDatabase & { close(): void },
): SqlDatabase & { close(): void } {
  return {
    exec(sql: string): Promise<void> {
      return db.exec(sql);
    },
    all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return db.all<T>(sql, params);
    },
    first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> {
      if (sql.includes("UPDATE messages") && sql.includes("RETURNING seq")) {
        return Promise.reject(new Error("rehearsal: simulated process loss before finalize"));
      }
      return db.first<T>(sql, params);
    },
    run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> {
      return db.run(sql, params);
    },
    transaction<T>(fn: Parameters<SqlDatabase["transaction"]>[0]): Promise<T> {
      return db.transaction(fn as (tx: SqlTransaction) => Promise<T>);
    },
    close(): void {
      db.close();
    },
  };
}

async function snapshot(
  db: SqlDatabase & { close(): void },
  projectId: string,
  blobDir: string,
): Promise<Snapshot> {
  const messages = await db.all<{ id: string; seq: number }>(
    `SELECT id, seq FROM messages
      WHERE project_id = ? AND seq IS NOT NULL
      ORDER BY seq ASC`,
    [projectId],
  );
  const receipts = await db.all<{ message_id: string; speaker_id: string }>(
    `SELECT r.message_id, r.speaker_id
       FROM message_receipts r
       JOIN messages m ON m.id = r.message_id
      WHERE m.project_id = ?
      ORDER BY r.message_id ASC, r.speaker_id ASC`,
    [projectId],
  );
  const audit = await db.all<{ operation: string }>(
    "SELECT operation FROM audit_events ORDER BY id ASC",
  );
  const project = await db.first<{ next_seq: number }>(
    "SELECT next_seq FROM projects WHERE id = ?",
    [projectId],
  );
  return {
    messageIds: messages.map((row) => row.id),
    seqs: messages.map((row) => Number(row.seq)),
    receiptKeys: receipts.map((row) => `${row.message_id}:${row.speaker_id}`),
    auditCount: audit.length,
    auditOperations: audit.map((row) => row.operation),
    nextSeq: Number(project?.next_seq ?? 0),
    blobCount: await countRegularBlobs(blobDir),
  };
}

// ------------------------------------------------------------- HTTP request

interface CallOptions {
  method?: string;
  token?: string;
  body?: unknown;
  idempotencyKey?: string;
  headers?: Record<string, string>;
}

async function callApp(
  app: App,
  path: string,
  options: CallOptions = {},
): Promise<{ status: number; json: Record<string, unknown> | undefined }> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  if (options.idempotencyKey !== undefined) {
    headers.set("idempotency-key", options.idempotencyKey);
  }
  const response = await app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
  let json: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = await response.json();
    if (typeof parsed === "object" && parsed !== null) {
      json = parsed as Record<string, unknown>;
    }
  } catch {
    // Not every response is JSON; the status is enough for those assertions.
  }
  return { status: response.status, json };
}

function errorCodeOf(json: Record<string, unknown> | undefined): string | undefined {
  const error = json?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" ? code : undefined;
}

function numberField(json: Record<string, unknown> | undefined, name: string): number | undefined {
  const value = json?.[name];
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function stringField(json: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = json?.[name];
  return typeof value === "string" ? value : undefined;
}

async function credentialIdForToken(
  db: SqlDatabase & { close(): void },
  token: string,
): Promise<string> {
  const prefix = token.slice(0, 12);
  const row = await db.first<{ id: string }>(
    `SELECT id FROM credentials
      WHERE public_prefix = ?
      ORDER BY created_at DESC, rowid DESC
      LIMIT 1`,
    [prefix],
  );
  if (row === undefined) throw new RehearsalFailure("seed-accounts", "credential row missing");
  return row.id;
}

// ------------------------------------------------------------------ rehearsal

export async function runRehearsal(state: RunState): Promise<void> {
  const modules = await loadModules();
  let tempRoot: string | undefined;
  let failure: unknown;
  try {
    tempRoot = await mkdtemp(join(tmpdir(), "corkboard-rehearsal-"));
    await chmod(tempRoot, 0o700);
    await rehearse(modules, state, tempRoot);
  } catch (error) {
    // A filesystem/service error may embed the temporary path. The report must
    // not expose it, and it must never expose key material or a body.
    const message = error instanceof Error ? error.message : "rehearsal failed";
    const safe = redactSensitive(message, tempRoot === undefined ? [] : [tempRoot]);
    failure =
      error instanceof RehearsalFailure
        ? new RehearsalFailure(error.checkId, safe)
        : new Error(safe);
  } finally {
    for (const close of [...state.closers].reverse()) close();
    if (tempRoot !== undefined) {
      await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  const removed = tempRoot === undefined || !(await pathExists(tempRoot));
  if (failure !== undefined) {
    if (!removed) {
      throw new RehearsalFailure("cleanup", "temporary directory could not be removed");
    }
    throw failure;
  }
  check(state, "cleanup", removed, "temporary directory was removed even after success");
}

async function rehearse(
  modules: ServiceModules,
  state: RunState,
  tempRoot: string,
): Promise<void> {
  const dataDir = join(tempRoot, "data");
  const secretsFile = join(tempRoot, "secrets", "secrets.env");
  const backupDir = join(tempRoot, "backup");
  const keyBackupFile = join(tempRoot, "key-backup", "secrets.env");
  const restoredDir = join(tempRoot, "restored");
  const restoredSecretsFile = join(tempRoot, "restored-secrets", "secrets.env");
  const cursorDir = join(tempRoot, "client");
  const cursorPath = join(cursorDir, "cursor.json");
  const resyncCursorPath = join(cursorDir, "resync-cursor.json");

  // 1. Initialize a private installation with synthetic keys outside the repo.
  const init = await runCli(["init", "--data-dir", dataDir, "--secrets-file", secretsFile], {});
  check(state, "init-private", init.status === 0, "init failed");
  check(state, "init-private", (await modeOf(dataDir)) === 0o700, "data directory is not 0700");
  check(state, "init-private", (await modeOf(secretsFile)) === 0o600, "secrets file is not 0600");
  const secretEnv = parseSecretsFile(await readFile(secretsFile, "utf8"));
  const rootKey = secretEnv.CORKBOARD_ROOT_KEY ?? "";
  const pepper = secretEnv.CORKBOARD_CREDENTIAL_PEPPER ?? "";
  check(
    state,
    "init-private",
    Buffer.from(rootKey, "base64").length === 32 &&
      Buffer.from(pepper, "base64").length === 32,
    "synthetic key material is not 32 bytes",
  );
  check(state, "init-private", rootKey !== pepper, "root key and pepper are identical");
  const env: Record<string, string> = {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_ROOT_KEY: rootKey,
    CORKBOARD_CREDENTIAL_PEPPER: pepper,
  };

  // 2. Seed accounts, projects, speakers, credentials, messages, receipts, audit.
  const owner = await runCli(["bootstrap-owner", "--email", "owner@example.test"], env);
  check(state, "seed-accounts", owner.status === 0, "bootstrap-owner failed");
  const accountId = owner.stdout.trim();
  check(state, "seed-accounts", accountId.startsWith("acct_"), "account id missing");

  const projectOne = (
    await runCli(
      ["create-project", "--account", accountId, "--title", "Rehearsal One"],
      env,
    )
  ).stdout.trim();
  const projectTwo = (
    await runCli(
      ["create-project", "--account", accountId, "--title", "Rehearsal Two"],
      env,
    )
  ).stdout.trim();
  const speakerOne = (
    await runCli(
      ["create-speaker", "--account", accountId, "--name", "Rehearsal Speaker One"],
      env,
    )
  ).stdout.trim();
  const speakerTwo = (
    await runCli(
      ["create-speaker", "--account", accountId, "--name", "Rehearsal Speaker Two"],
      env,
    )
  ).stdout.trim();
  check(
    state,
    "seed-accounts",
    projectOne.startsWith("proj_") &&
      projectTwo.startsWith("proj_") &&
      speakerOne.startsWith("spk_") &&
      speakerTwo.startsWith("spk_"),
    "project or speaker provisioning failed",
  );
  for (const [project, speaker] of [
    [projectOne, speakerOne],
    [projectOne, speakerTwo],
    [projectTwo, speakerOne],
  ] as const) {
    const added = await runCli(["add-member", "--project", project, "--speaker", speaker], env);
    check(state, "seed-accounts", added.status === 0, "add-member failed");
  }

  const issued = async (projects: readonly string[]): Promise<string> => {
    const args = ["issue-key", "--speaker", speakerOne];
    for (const project of projects) args.push("--project", project);
    const result = await runCli(args, env);
    check(state, "seed-accounts", result.status === 0, "issue-key failed");
    const token = result.stdout.trim();
    check(
      state,
      "seed-accounts",
      token.startsWith("cb_") && token.length > 20,
      "issued token is malformed",
    );
    return token;
  };
  const tokenMain = await issued([projectOne, projectTwo]);
  const tokenRevoked = await issued([projectOne]);
  const tokenRotated = await issued([projectOne]);

  const live = await openInstallation(modules, state, dataDir, env);
  const credentialRevoked = await credentialIdForToken(live.db, tokenRevoked);
  const credentialRotated = await credentialIdForToken(live.db, tokenRotated);
  const principalMain = await modules.auth.authenticateBearer(live.deps, `Bearer ${tokenMain}`);

  const bodies = [
    "Rehearsal synthetic body alpha.",
    "Rehearsal synthetic body beta.",
    "Rehearsal synthetic body gamma.",
  ];
  const messageIds: string[] = [];
  for (const [index, text] of bodies.entries()) {
    const sent = await modules.messages.sendMessage(
      live.deps,
      principalMain,
      projectOne,
      `rehearsal-seed-${index}`,
      {
        summary: `Rehearsal synthetic summary ${index}`,
        type: "request",
        language: "en",
        text,
        bodyDigest: digestOf(text),
      },
    );
    messageIds.push(sent.messageId);
  }
  check(state, "seed-messages", messageIds.length === bodies.length, "seed messages missing");
  check(
    state,
    "seed-messages",
    messageIds.every((id, index) =>
      id.length > 0 && id !== messageIds[(index + 1) % messageIds.length],
    ),
    "seed message ids are not distinct",
  );
  for (const messageId of messageIds) {
    const receipt = await modules.messages.markRead(
      live.deps,
      principalMain,
      projectOne,
      messageId,
    );
    check(state, "seed-receipts", receipt.speakerId === speakerOne, "receipt speaker mismatch");
  }
  const liveSnapshot = await snapshot(live.db, projectOne, join(dataDir, "blobs"));
  check(
    state,
    "seed-messages",
    liveSnapshot.seqs.length === bodies.length &&
      liveSnapshot.seqs.every((seq, index) => seq === index + 1),
    "message sequences are not contiguous",
  );
  check(
    state,
    "seed-receipts",
    liveSnapshot.receiptKeys.length === bodies.length,
    "receipt count does not match messages",
  );
  check(
    state,
    "seed-audit",
    liveSnapshot.auditOperations.includes("credential.issue") &&
      liveSnapshot.auditOperations.includes("membership.grant"),
    "expected sanitized audit operations are missing",
  );

  // The cursor is client state. It survives the disaster because it is outside
  // the data directory; the server keeps no cursor.
  const liveReplay = await modules.poll.pollPass({
    baseUrl: "http://localhost",
    token: tokenMain,
    projectId: projectOne,
    speakerId: speakerOne,
    cursorPath,
    afterSeq: 0,
    consume: true,
    fetchImpl: async (input, init) => live.app(new Request(input, init)),
  });
  check(
    state,
    "cursor-from-scratch",
    liveReplay.processed === bodies.length,
    "live cursor replay processed the wrong number of messages",
  );
  check(
    state,
    "cursor-replay-no-duplicates",
    (await snapshot(live.db, projectOne, join(dataDir, "blobs"))).receiptKeys.length ===
      bodies.length,
    "live cursor replay duplicated a receipt",
  );
  const storedCursorText = await readFile(cursorPath, "utf8");
  live.db.close();
  state.closers.pop();

  // 3. Take and verify a database+blob backup. Key material is not in it.
  const backupRun = await runCli(
    ["backup", "--data-dir", dataDir, "--out", backupDir, "--json"],
    env,
  );
  check(state, "backup-verify", backupRun.status === 0, "backup failed");
  const verifyRun = await runCli(["verify", "--backup", backupDir, "--json"], env);
  check(state, "backup-verify", verifyRun.status === 0, "verify failed");
  const manifest = JSON.parse(
    await readFile(join(backupDir, "manifest.json"), "utf8"),
  ) as {
    blobs: Array<{ name: string }>;
    counts: { blobs: number; blob_bytes: number };
    schema_version: number;
    database: { sha256: string };
  };
  check(
    state,
    "backup-verify",
    manifest.counts.blobs === manifest.blobs.length && manifest.counts.blobs >= bodies.length,
    "manifest blob count is inconsistent",
  );
  const topLevel = await readdir(backupDir);
  check(
    state,
    "backup-verify",
    topLevel.every((name) => name === "manifest.json" || name === "corkboard.sqlite" || name === "blobs"),
    "backup contains an unexpected entry",
  );
  check(
    state,
    "backup-excludes-secrets",
    !(await pathExists(join(backupDir, "cursor.json"))),
    "a client cursor was included in the backup",
  );
  const forbidden = [rootKey, pepper, tokenMain, tokenRevoked, tokenRotated, ...bodies];
  const leaks: string[] = [];
  for (const file of await walkFiles(backupDir)) {
    const bytes = await readFile(file);
    for (const value of forbidden) {
      if (value !== "" && bytes.includes(Buffer.from(value, "utf8"))) leaks.push(basename(file));
    }
  }
  check(
    state,
    "backup-excludes-secrets",
    leaks.length === 0,
    "backup contains a secret or message body",
  );
  await mkdir(dirname(keyBackupFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(keyBackupFile), 0o700);
  await copyFile(secretsFile, keyBackupFile);
  await chmod(keyBackupFile, 0o600);
  check(
    state,
    "keys-backed-up-separately",
    (await modeOf(keyBackupFile)) === 0o600,
    "key backup is not 0600",
  );
  const keyEnv = parseSecretsFile(await readFile(keyBackupFile, "utf8"));
  check(
    state,
    "keys-backed-up-separately",
    keyEnv.CORKBOARD_ROOT_KEY === rootKey && keyEnv.CORKBOARD_CREDENTIAL_PEPPER === pepper,
    "key backup does not round-trip",
  );

  // 4. Disaster: remove only the temporary live data directory, then restore
  // into a new empty directory using the separately backed-up key material.
  await rm(dataDir, { recursive: true, force: true });
  check(state, "disaster-live-removed", !(await pathExists(dataDir)), "live data was not removed");
  await mkdir(dirname(restoredSecretsFile), { recursive: true, mode: 0o700 });
  await chmod(dirname(restoredSecretsFile), 0o700);
  await writeFile(
    restoredSecretsFile,
    secretsFileContent(keyEnv, restoredDir),
    { mode: 0o600, flag: "wx" },
  );
  await chmod(restoredSecretsFile, 0o600);
  // Use the new secrets file itself, not the in-memory copy: this proves the
  // restored installation reads the separately backed-up key material from the
  // `0600` file that points at the new data directory.
  const writtenSecrets = parseSecretsFile(await readFile(restoredSecretsFile, "utf8"));
  check(
    state,
    "restored-secrets-file",
    (await modeOf(restoredSecretsFile)) === 0o600 &&
      writtenSecrets.CORKBOARD_DATA_DIR === restoredDir &&
      writtenSecrets.CORKBOARD_ROOT_KEY === rootKey &&
      writtenSecrets.CORKBOARD_CREDENTIAL_PEPPER === pepper,
    "the restored secrets file is not a private copy of the backed-up keys",
  );
  const restoredEnv: Record<string, string> = {
    CORKBOARD_DATA_DIR: writtenSecrets.CORKBOARD_DATA_DIR ?? restoredDir,
    CORKBOARD_ROOT_KEY: writtenSecrets.CORKBOARD_ROOT_KEY ?? "",
    CORKBOARD_CREDENTIAL_PEPPER: writtenSecrets.CORKBOARD_CREDENTIAL_PEPPER ?? "",
  };

  const restoreRun = await runCli(
    ["restore", "--backup", backupDir, "--data-dir", restoredDir, "--json"],
    restoredEnv,
  );
  check(state, "restore-verify", restoreRun.status === 0, "restore failed");
  const reverify = await runCli(["verify", "--backup", backupDir, "--json"], restoredEnv);
  check(state, "restore-verify", reverify.status === 0, "post-restore verify failed");
  const doctorBefore = await runCli(
    ["doctor", "--data-dir", restoredDir, "--json"],
    restoredEnv,
  );
  const doctorReport = JSON.parse(doctorBefore.stdout) as {
    issues: Array<{ code: string }>;
    schema_versions: { complete: boolean };
    database: { integrity: string; counts: { messages: number; receipts: number } } | null;
  };
  check(
    state,
    "doctor-clean",
    doctorBefore.status === 0 &&
      doctorReport.issues.length === 0 &&
      doctorReport.schema_versions.complete &&
      doctorReport.database?.integrity === "ok",
    "doctor reported issues after restore",
  );

  const restored = await openInstallation(modules, state, restoredDir, restoredEnv);
  const restoredSnapshot = await snapshot(
    restored.db,
    projectOne,
    join(restoredDir, "blobs"),
  );
  check(
    state,
    "restore-sequences",
    JSON.stringify(restoredSnapshot.seqs) === JSON.stringify(liveSnapshot.seqs),
    "message sequences changed across restore",
  );
  check(
    state,
    "restore-receipts",
    JSON.stringify(restoredSnapshot.receiptKeys) === JSON.stringify(liveSnapshot.receiptKeys),
    "receipts changed across restore",
  );
  check(
    state,
    "restore-audit",
    restoredSnapshot.auditCount === liveSnapshot.auditCount &&
      JSON.stringify(restoredSnapshot.auditOperations) ===
        JSON.stringify(liveSnapshot.auditOperations),
    "audit rows changed across restore",
  );
  const restoredPrincipal = await modules.auth.authenticateBearer(
    restored.deps,
    `Bearer ${tokenMain}`,
  );
  for (const [index, messageId] of messageIds.entries()) {
    const body = await modules.messages.getMessageBody(
      restored.deps,
      restoredPrincipal,
      projectOne,
      messageId,
    );
    check(
      state,
      "restore-body-decrypt",
      body.text === bodies[index] && body.digest === digestOf(bodies[index] ?? ""),
      `restored body ${index} did not decrypt or match its digest`,
    );
  }

  // The database+blob pair alone is insufficient: a different root key fails
  // closed and creates no plaintext.
  const wrongKeyDeps: ServiceDeps = {
    ...restored.deps,
    keys: await modules.keys.inMemoryKeyProvider(randomBytes(32)),
  };
  let wrongKeyCode: string | undefined;
  try {
    await modules.messages.getMessageBody(
      wrongKeyDeps,
      restoredPrincipal,
      projectOne,
      messageIds[0] ?? "",
    );
  } catch (error) {
    wrongKeyCode = (error as { code?: unknown }).code as string | undefined;
  }
  check(
    state,
    "restore-wrong-key-fails-closed",
    wrongKeyCode === "INTEGRITY_FAILURE",
    "a different root key did not fail closed",
  );

  // The restored service answers send/read through the real application router.
  const me = await callApp(restored.app, "/api/v1/me", { token: tokenMain });
  check(state, "restore-send-read", me.status === 200, "restored /me failed");
  const postRestoreText = "Rehearsal synthetic body after restore.";
  const sentAfterRestore = await callApp(
    restored.app,
    `/api/v1/projects/${projectOne}/messages`,
    {
      method: "POST",
      token: tokenMain,
      idempotencyKey: "rehearsal-after-restore",
      body: {
        summary: "Rehearsal summary after restore",
        type: "request",
        language: "en",
        text: postRestoreText,
        body_digest: digestOf(postRestoreText),
      },
    },
  );
  const newSeq = numberField(sentAfterRestore.json, "seq");
  check(
    state,
    "restore-send-read",
    (sentAfterRestore.status === 201 || sentAfterRestore.status === 200) &&
      newSeq !== undefined &&
      newSeq === liveSnapshot.nextSeq + 1,
    "restored send did not allocate the next sequence",
  );
  const newMessageId = stringField(sentAfterRestore.json, "message_id");
  const restoreBody = await callApp(
    restored.app,
    `/api/v1/projects/${projectOne}/messages/${newMessageId ?? ""}/body`,
    { token: tokenMain },
  );
  check(
    state,
    "restore-send-read",
    restoreBody.status === 200 &&
      stringField(restoreBody.json, "text") === postRestoreText &&
      stringField(restoreBody.json, "digest") === digestOf(postRestoreText),
    "restored read did not return the expected body",
  );
  const listAfterRestore = await callApp(
    restored.app,
    `/api/v1/projects/${projectOne}/messages?after_seq=0`,
    { token: tokenMain },
  );
  const listed = Array.isArray(listAfterRestore.json?.messages)
    ? (listAfterRestore.json.messages as Array<{ seq?: unknown }>)
    : [];
  check(
    state,
    "restore-send-read",
    listAfterRestore.status === 200 &&
      listed.length >= bodies.length + 1 &&
      listed.every(
        (row, index) =>
          typeof row.seq === "number" &&
          (index === 0 || (listed[index - 1]?.seq as number) < row.seq),
      ),
    "restored list is not ordered",
  );

  // 5. Audit rows are sanitized, but not tamper-evident to database write access.
  const auditRows = await restored.db.all<{
    id: string;
    operation: string;
    outcome: string;
    detail: string | null;
  }>("SELECT id, operation, outcome, detail FROM audit_events ORDER BY id ASC");
  const secretValues = [
    rootKey,
    pepper,
    tokenMain,
    tokenRevoked,
    tokenRotated,
    ...bodies,
    postRestoreText,
  ];
  const auditLeak = auditRows.some(
    (row) =>
      (row.detail !== null && redactSensitive(row.detail, secretValues) !== row.detail) ||
      redactSensitive(row.operation, secretValues) !== row.operation,
  );
  check(
    state,
    "audit-sanitized",
    !auditLeak &&
      auditRows.some((row) => row.operation === "credential.issue") &&
      auditRows.some((row) => row.operation === "membership.grant"),
    "audit rows contain a secret or body, or expected operations are missing",
  );

  // There is no hash, signature column, or trigger on audit_events. A direct
  // write therefore rewrites history undetected: this is the stated limit.
  const auditColumns = await restored.db.all<{ name: string }>(
    "PRAGMA table_info(audit_events)",
  );
  const auditTriggers = await restored.db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'",
  );
  check(
    state,
    "audit-not-tamper-evident",
    !auditColumns.some((column) =>
      /hash|digest|signature|mac|hmac/i.test(column.name),
    ) && auditTriggers.length === 0,
    "audit_events unexpectedly gained an integrity mechanism",
  );
  const firstAudit = auditRows[0];
  if (firstAudit === undefined) throw new RehearsalFailure("audit-not-tamper-evident", "no audit rows");
  restored.db.close();
  state.closers.pop();
  const tamperDb = await modules.db.openSqliteDatabase(join(restoredDir, "corkboard.sqlite"));
  try {
    await tamperDb.run(
      "UPDATE audit_events SET operation = 'rehearsal.tampered' WHERE id = ?",
      [firstAudit.id],
    );
    const tampered = await tamperDb.first<{ operation: string }>(
      "SELECT operation FROM audit_events WHERE id = ?",
      [firstAudit.id],
    );
    check(
      state,
      "audit-not-tamper-evident",
      tampered?.operation === "rehearsal.tampered",
      "direct audit rewrite was not observable",
    );
    await tamperDb.run("UPDATE audit_events SET operation = ? WHERE id = ?", [
      firstAudit.operation,
      firstAudit.id,
    ]);
    const reverted = await tamperDb.first<{ operation: string }>(
      "SELECT operation FROM audit_events WHERE id = ?",
      [firstAudit.id],
    );
    check(
      state,
      "audit-not-tamper-evident",
      reverted?.operation === firstAudit.operation,
      "the audit revert did not restore the original operation",
    );
  } finally {
    tamperDb.close();
  }

  // Reopen for the remaining phases.
  const afterAudit = await openInstallation(modules, state, restoredDir, restoredEnv);

  // 6. Resync cursors from scratch after restore, prove ordered delivery and no
  // duplicate receipts, and prove the stored cursor is project+speaker bound.
  const replaySeqs: number[] = [];
  const replay = await modules.poll.run({
    baseUrl: "http://localhost",
    token: tokenMain,
    projectId: projectOne,
    cursorPath: resyncCursorPath,
    consume: true,
    once: true,
    fetchImpl: async (input, init) => afterAudit.app(new Request(input, init)),
    onMessage: async (message) => {
      replaySeqs.push(message.seq);
    },
  });
  const expectedCount = Number(
    (
      await afterAudit.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE project_id = ? AND seq IS NOT NULL",
        [projectOne],
      )
    )?.n ?? 0,
  );
  check(
    state,
    "cursor-from-scratch",
    replay.processed === expectedCount &&
      replaySeqs.length === expectedCount &&
      replaySeqs.every((seq, index) => index === 0 || (replaySeqs[index - 1] ?? 0) < seq),
    "from-scratch replay was not complete, ordered, or correctly counted",
  );
  const afterReplay = await snapshot(afterAudit.db, projectOne, join(restoredDir, "blobs"));
  check(
    state,
    "cursor-replay-no-duplicates",
    afterReplay.receiptKeys.length === expectedCount &&
      new Set(afterReplay.receiptKeys).size === afterReplay.receiptKeys.length,
    "replay duplicated a receipt",
  );
  const replayAgain = await modules.poll.run({
    baseUrl: "http://localhost",
    token: tokenMain,
    projectId: projectOne,
    cursorPath: resyncCursorPath,
    consume: true,
    once: true,
    fetchImpl: async (input, init) => afterAudit.app(new Request(input, init)),
    onMessage: async () => undefined,
  });
  const afterSecondReplay = await snapshot(
    afterAudit.db,
    projectOne,
    join(restoredDir, "blobs"),
  );
  check(
    state,
    "cursor-replay-no-duplicates",
    replayAgain.processed === 0 &&
      JSON.stringify(afterSecondReplay.receiptKeys) === JSON.stringify(afterReplay.receiptKeys),
    "a replayed cursor processed rows again or added receipts",
  );

  const resyncText = await readFile(resyncCursorPath, "utf8");
  const bound = modules.poll.parseCursorState(resyncText, projectOne, speakerOne);
  let wrongProjectRejected = false;
  let wrongSpeakerRejected = false;
  try {
    modules.poll.parseCursorState(resyncText, projectTwo, speakerOne);
  } catch {
    wrongProjectRejected = true;
  }
  try {
    modules.poll.parseCursorState(resyncText, projectOne, speakerTwo);
  } catch {
    wrongSpeakerRejected = true;
  }
  const storedOldCursor = modules.poll.parseCursorState(
    storedCursorText,
    projectOne,
    speakerOne,
  );
  check(
    state,
    "cursor-binding",
    bound.project_id === projectOne &&
      bound.speaker_id === speakerOne &&
      wrongProjectRejected &&
      wrongSpeakerRejected &&
      storedOldCursor.after_seq === liveSnapshot.seqs.at(-1),
    "a stored cursor was accepted for a different project/speaker or lost its position",
  );

  // 7. Revoke a compromised credential; rotate another. Both are checked on the
  // next REST and MCP request. The replacement works; the old token does not.
  const revoke = await runCli(["revoke-key", "--credential", credentialRevoked], restoredEnv);
  check(state, "revoke-rest-fails-closed", revoke.status === 0, "revoke-key failed");
  const revokedRest = await callApp(afterAudit.app, "/api/v1/me", {
    token: tokenRevoked,
  });
  check(
    state,
    "revoke-rest-fails-closed",
    revokedRest.status === 401 && errorCodeOf(revokedRest.json) === "UNAUTHENTICATED",
    "revoked credential was not rejected by REST",
  );
  const revokedMcp = await callApp(afterAudit.app, "/mcp", {
    method: "POST",
    token: tokenRevoked,
    headers: { accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "rehearsal", version: "1.0.0" },
      },
    },
  });
  check(
    state,
    "revoke-mcp-fails-closed",
    revokedMcp.status === 401 && errorCodeOf(revokedMcp.json) === "UNAUTHENTICATED",
    "revoked credential was not rejected by MCP",
  );

  const rotate = await runCli(["rotate-key", "--credential", credentialRotated], restoredEnv);
  check(state, "rotate-new-works", rotate.status === 0, "rotate-key failed");
  const replacementToken = rotate.stdout.trim();
  check(
    state,
    "rotate-old-fails",
    replacementToken.startsWith("cb_") && replacementToken !== tokenRotated,
    "rotation did not return a distinct token",
  );
  const oldAfterRotate = await callApp(afterAudit.app, "/api/v1/me", {
    token: tokenRotated,
  });
  check(
    state,
    "rotate-old-fails",
    oldAfterRotate.status === 401 && errorCodeOf(oldAfterRotate.json) === "UNAUTHENTICATED",
    "the rotated-away token still authenticates",
  );
  const newAfterRotate = await callApp(afterAudit.app, "/api/v1/me", {
    token: replacementToken,
  });
  check(
    state,
    "rotate-new-works",
    newAfterRotate.status === 200 &&
      typeof newAfterRotate.json?.speaker === "object" &&
      newAfterRotate.json.speaker !== null,
    "the replacement token does not authenticate",
  );
  const rotateRevoked = await runCli(
    ["rotate-key", "--credential", credentialRevoked],
    restoredEnv,
  );
  check(
    state,
    "rotate-old-fails",
    rotateRevoked.status !== 0,
    "rotating an already-revoked credential unexpectedly succeeded",
  );

  // 8. Interrupted send/finalize (not a migration or upgrade): the provisional
  // write survives, the process dies before finalize, the drill separately
  // synthesizes an in-progress `.tmp-*` writer artifact, and a restart resumes
  // the same idempotency key exactly once.
  afterAudit.db.close();
  state.closers.pop();
  const interruptedKey = "rehearsal-interrupted-send";
  const interruptedText = "Rehearsal synthetic body interrupted.";
  const interruptedDb = await modules.db.openSqliteDatabase(
    join(restoredDir, "corkboard.sqlite"),
  );
  const faulty = crashBeforeFinalize(interruptedDb);
  const oldNow = Date.now() - 2 * 60 * 60 * 1000;
  const faultyDeps: ServiceDeps = {
    db: faulty,
    blobs: new modules.local.LocalBlobStore(join(restoredDir, "blobs")),
    keys: await modules.keys.keyProviderFromEnv(restoredEnv),
    pepper: pepperFrom(restoredEnv),
    serviceId: SERVICE_ID,
    now: () => new Date(oldNow),
  };
  const faultyPrincipal = await modules.auth.authenticateBearer(
    faultyDeps,
    `Bearer ${tokenMain}`,
  );
  let interruptedError: string | undefined;
  try {
    await modules.messages.sendMessage(
      faultyDeps,
      faultyPrincipal,
      projectOne,
      interruptedKey,
      {
        summary: "Rehearsal summary interrupted",
        type: "request",
        language: "en",
        text: interruptedText,
        bodyDigest: digestOf(interruptedText),
      },
    );
  } catch (error) {
    interruptedError = error instanceof Error ? error.message : "";
  }
  faulty.close();
  check(
    state,
    "interrupted-send-stuck-pending",
    interruptedError === "rehearsal: simulated process loss before finalize",
    "the injected finalize failure did not surface exactly",
  );

  const inspect = await modules.db.openSqliteDatabase(join(restoredDir, "corkboard.sqlite"));
  let interruptedMessageId: string;
  try {
    const idempotency = await inspect.first<{
      message_id: string | null;
      status: string;
    }>(
      "SELECT message_id, status FROM idempotency_keys WHERE speaker_id = ? AND project_id = ? AND key = ?",
      [speakerOne, projectOne, interruptedKey],
    );
    const pending = await inspect.first<{
      id: string;
      seq: number | null;
      body_state: string;
      body_object_id: string | null;
    }>(
      `SELECT id, seq, body_state, body_object_id FROM messages
        WHERE sender_speaker_id = ? AND project_id = ? AND body_state = 'pending'`,
      [speakerOne, projectOne],
    );
    interruptedMessageId = pending?.id ?? "";
    const pendingObject = await inspect.first<{ storage_key: string }>(
      "SELECT storage_key FROM body_objects WHERE id = ? AND project_id = ?",
      [pending?.body_object_id ?? "", projectOne],
    );
    check(
      state,
      "interrupted-send-stuck-pending",
      idempotency?.status === "pending" &&
        idempotency.message_id === interruptedMessageId &&
        pending?.seq === null &&
        pending.body_state === "pending" &&
        pending.body_object_id !== null &&
        typeof pendingObject?.storage_key === "string",
      "partial write did not leave a reclaimable pending row",
    );
  } finally {
    inspect.close();
  }

  const doctorStuck = await runCli(
    ["doctor", "--data-dir", restoredDir, "--stuck-minutes", "0", "--json"],
    restoredEnv,
  );
  const stuckReport = JSON.parse(doctorStuck.stdout) as {
    issues: Array<{ code: string; count: number }>;
  };
  check(
    state,
    "interrupted-send-stuck-pending",
    doctorStuck.status === 1 &&
      stuckReport.issues.some((issue) => issue.code === "STUCK_PENDING") &&
      !stuckReport.issues.some(
        (issue) =>
          issue.code === "BLOB_MISSING" ||
          issue.code === "DATABASE_INTEGRITY_FAILED" ||
          issue.code === "BLOB_ORPHANED",
      ),
    "doctor did not report the stuck pending row cleanly",
  );

  const committedBlobNames = (
    await readdir(join(restoredDir, "blobs"), { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && !entry.name.startsWith(".tmp-"))
    .map((entry) => entry.name)
    .sort();
  const artifactName = randomTempArtifactName();
  await writeFile(join(restoredDir, "blobs", artifactName), randomBytes(16), { mode: 0o600 });
  const interruptedBackup = join(tempRoot, "interrupted-backup");
  const interruptedBackupRun = await runCli(
    ["backup", "--data-dir", restoredDir, "--out", interruptedBackup, "--json"],
    restoredEnv,
  );
  check(
    state,
    "interrupted-send-temp-artifact-excluded",
    interruptedBackupRun.status === 0,
    "backup with an in-progress artifact failed",
  );
  const interruptedManifest = JSON.parse(
    await readFile(join(interruptedBackup, "manifest.json"), "utf8"),
  ) as { blobs: Array<{ name: string }> };
  const manifestBlobNames = interruptedManifest.blobs.map((blob) => blob.name).sort();
  check(
    state,
    "interrupted-send-temp-artifact-excluded",
    !manifestBlobNames.includes(artifactName),
    "the in-progress writer artifact was included in a backup",
  );
  // The artifact is not a reason to lose real blobs: the manifest must still
  // list every committed blob on disk.
  check(
    state,
    "interrupted-send-temp-artifact-excluded",
    committedBlobNames.length > 0 &&
      JSON.stringify(manifestBlobNames) === JSON.stringify(committedBlobNames),
    "the artifact-free snapshot omitted committed blobs",
  );
  const interruptedVerify = await runCli(
    ["verify", "--backup", interruptedBackup, "--json"],
    restoredEnv,
  );
  check(
    state,
    "interrupted-send-temp-artifact-excluded",
    interruptedVerify.status === 0,
    "the artifact-free snapshot did not verify",
  );
  await rm(join(restoredDir, "blobs", artifactName), { force: true });

  const resume = await openInstallation(modules, state, restoredDir, restoredEnv);
  const resumePrincipal = await modules.auth.authenticateBearer(
    resume.deps,
    `Bearer ${tokenMain}`,
  );
  const preResumeNext = Number(
    (
      await resume.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?",
        [projectOne],
      )
    )?.next_seq ?? 0,
  );
  const resumed = await modules.messages.sendMessage(
    resume.deps,
    resumePrincipal,
    projectOne,
    interruptedKey,
    {
      summary: "Rehearsal summary interrupted",
      type: "request",
      language: "en",
      text: interruptedText,
      bodyDigest: digestOf(interruptedText),
    },
  );
  const replayed = await modules.messages.sendMessage(
    resume.deps,
    resumePrincipal,
    projectOne,
    interruptedKey,
    {
      summary: "Rehearsal summary interrupted",
      type: "request",
      language: "en",
      text: interruptedText,
      bodyDigest: digestOf(interruptedText),
    },
  );
  const postResumeNext = Number(
    (
      await resume.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?",
        [projectOne],
      )
    )?.next_seq ?? 0,
  );
  const duplicateRows = await resume.db.first<{ n: number }>(
    "SELECT COUNT(*) AS n FROM messages WHERE id = ?",
    [interruptedMessageId],
  );
  check(
    state,
    "interrupted-send-resume-single-commit",
    resumed.messageId === interruptedMessageId &&
      replayed.messageId === interruptedMessageId &&
      resumed.seq === preResumeNext + 1 &&
      replayed.seq === resumed.seq &&
      postResumeNext === preResumeNext + 1 &&
      Number(duplicateRows?.n ?? 0) === 1,
    "resume committed a duplicate or allocated the wrong sequence",
  );
  const resumedBody = await modules.messages.getMessageBody(
    resume.deps,
    resumePrincipal,
    projectOne,
    interruptedMessageId,
  );
  check(
    state,
    "interrupted-send-resume-single-commit",
    resumedBody.text === interruptedText && resumedBody.digest === digestOf(interruptedText),
    "the resumed body does not decrypt",
  );

  const expire = await runCli(
    ["expire-bodies", "--data-dir", restoredDir, "--limit", "500"],
    restoredEnv,
  );
  check(
    state,
    "cleanup-live-data-intact",
    expire.status === 0 && JSON.parse(expire.stdout).failures === 0,
    "expire-bodies failed while cleaning",
  );
  const prune = await runCli(["prune", "--data-dir", restoredDir, "--json"], restoredEnv);
  check(
    state,
    "cleanup-live-data-intact",
    prune.status === 0,
    "prune failed while cleaning",
  );
  const finalSnapshot = await snapshot(resume.db, projectOne, join(restoredDir, "blobs"));
  const originalPlusRestored = bodies.length + 1 + 1; // seed + post-restore + resumed
  check(
    state,
    "cleanup-live-data-intact",
    finalSnapshot.seqs.length === originalPlusRestored &&
      finalSnapshot.receiptKeys.length >= bodies.length &&
      finalSnapshot.blobCount >= bodies.length,
    "cleanup changed committed messages, receipts, or blobs",
  );
  for (const [index, messageId] of messageIds.entries()) {
    const body = await modules.messages.getMessageBody(
      resume.deps,
      resumePrincipal,
      projectOne,
      messageId,
    );
    check(
      state,
      "cleanup-live-data-intact",
      body.text === bodies[index],
      "cleanup corrupted a committed body",
    );
  }
  const doctorFinal = await runCli(
    ["doctor", "--data-dir", restoredDir, "--json"],
    restoredEnv,
  );
  check(
    state,
    "cleanup-live-data-intact",
    doctorFinal.status === 0 && JSON.parse(doctorFinal.stdout).issues.length === 0,
    "doctor did not return to a clean state",
  );
  resume.db.close();
  state.closers.pop();

  state.summary = {
    messages: finalSnapshot.seqs.length,
    receipts: finalSnapshot.receiptKeys.length,
    audit_events: finalSnapshot.auditCount,
    blobs: finalSnapshot.blobCount,
    schema_version: manifest.schema_version,
  };
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkFiles(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// ---------------------------------------------------------------------- main

function emptySummary(): RehearsalSummary {
  return { messages: 0, receipts: 0, audit_events: 0, blobs: 0, schema_version: 0 };
}

function emitSkip(json: boolean, reason: string): void {
  if (json) {
    const report: RehearsalReport = {
      ok: false,
      skipped: true,
      reason,
      checks: [],
      summary: emptySummary(),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    return;
  }
  process.stdout.write(`disaster-rehearsal: SKIP: ${reason}\n`);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const json = argv.includes("--json");
  if (argv.includes("--help")) {
    process.stdout.write(
      [
        "Usage: node scripts/disaster-rehearsal.ts [--json]",
        "",
        "Runs the TODO 411 disaster rehearsal entirely in temporary directories:",
        "init, seed, backup/verify, destroy, restore, verify, doctor, audit limits,",
        "cursor resync, revoke/rotate, interrupted send/finalize recovery, and cleanup.",
        "Prints counts only. Never prints secrets, keys, tokens, or message bodies.",
        "With --json, stdout is exactly one JSON object for success, skip, or failure.",
        "",
      ].join("\n"),
    );
    return 0;
  }
  const issue = hostCapabilityIssue();
  if (issue !== undefined) {
    emitSkip(json, issue);
    return 0;
  }
  try {
    await import("node:sqlite");
  } catch {
    emitSkip(json, "node:sqlite is unavailable");
    return 0;
  }

  const state: RunState = {
    checks: [],
    summary: emptySummary(),
    closers: [],
  };
  try {
    await runRehearsal(state);
  } catch (error) {
    for (const close of [...state.closers].reverse()) {
      try {
        close();
      } catch {
        // Best effort on the failure path.
      }
    }
    const failure = error instanceof RehearsalFailure ? error : undefined;
    const safe =
      error instanceof Error ? error.message : "rehearsal failed";
    if (json) {
      const report: RehearsalReport = {
        ok: false,
        checks: state.checks,
        summary: state.summary,
        error: safe,
        ...(failure === undefined ? {} : { failed_check: failure.checkId }),
      };
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(`disaster-rehearsal: FAIL: ${safe}\n`);
    }
    return 1;
  }
  const report: RehearsalReport = {
    ok: true,
    checks: state.checks,
    summary: state.summary,
  };
  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const check of state.checks) {
      process.stdout.write(`[ok] ${check.id}\n`);
    }
    const s = state.summary;
    process.stdout.write(
      `counts: messages ${s.messages}, receipts ${s.receipts}, ` +
        `audit_events ${s.audit_events}, blobs ${s.blobs}, schema v${s.schema_version}\n`,
    );
    process.stdout.write(`disaster-rehearsal: PASS (${state.checks.length} checks)\n`);
  }
  return 0;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
