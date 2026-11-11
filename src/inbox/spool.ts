// Durable, project-scoped local event spool for the polling bridge.
//
// This module owns only local storage: the versioned event record, atomic
// fsync'd writes, permissions, dedupe, bounded usage, consumers, and prune.
// It does not fetch, verify, or acknowledge anything on the server; that stays
// in scripts/poll.ts.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const EVENT_VERSION = 1;
export const SPOOL_VERSION = 1;
export const ACK_VERSION = 1;
export const DEFAULT_MAX_EVENTS = 10_000;
export const DEFAULT_MAX_BYTES = 64 << 20;
export const DEFAULT_MAX_EVENT_BYTES = 256 << 10;
export const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000;

const MAX_CONFIG_BYTES = 16 << 10;
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const EVENT_FILE = /^(\d{16})\.json$/;
const ACK_FILE = /^(\d{16})\.json$/;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

// The source tree and the compiled `dist/` tree have different depths, so walk
// up to the package marker instead of assuming a fixed number of parent
// segments. This keeps the outside-repository guard correct for the built CLI.
function findPackageRoot(start: string): string {
  let directory = start;
  for (;;) {
    const marker = join(directory, "package.json");
    if (existsSync(marker)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          (parsed as { name?: unknown }).name === "corkboard"
        ) {
          return directory;
        }
      } catch {
        // Not a readable package marker; keep walking.
      }
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("could not locate the Corkboard package root");
    }
    directory = parent;
  }
}

const REPO_ROOT = findPackageRoot(dirname(fileURLToPath(import.meta.url)));

export type InboxBodyState = "ready" | "expired";

export type InboxPayload =
  | { included: false }
  | { included: true; digest: string; path: string };

export interface InboxEventV1 {
  version: 1;
  project_id: string;
  seq: number;
  message_id: string;
  sender: { id: string; attribution: "server_authenticated" };
  body_state: InboxBodyState;
  summary: string;
  queued_at: string;
  payload: InboxPayload;
}

// Structural subset of scripts/poll.ts PollMessage, so this module has no
// dependency on the reference client.
export interface InboxMessageInput {
  projectId: string;
  messageId: string;
  seq: number;
  senderId: string;
  summary: string;
  bodyState: InboxBodyState;
}

export interface SpoolConfigV1 {
  version: 1;
  project_id: string;
  plaintext: boolean;
  created_at: string;
}

export interface InboxSpool {
  readonly root: string;
  readonly projectId: string;
  readonly plaintext: boolean;
  readonly eventsDir: string;
  readonly payloadsDir: string;
  readonly consumersDir: string;
  readonly tmpDir: string;
  readonly cursorPath: string;
  readonly maxEvents: number;
  readonly maxBytes: number;
  readonly maxEventBytes: number;
  readonly retentionMs: number;
}

export interface SpoolOptions {
  repoRoot?: string | undefined;
  maxEvents?: number | undefined;
  maxBytes?: number | undefined;
  maxEventBytes?: number | undefined;
  retentionMs?: number | undefined;
  now?: (() => Date) | undefined;
}

export interface PrepareSpoolOptions extends SpoolOptions {
  plaintext?: boolean | undefined;
}

export interface EnqueueOptions {
  token: string;
  now?: (() => Date) | undefined;
}

export interface ConsumerAckV1 {
  version: 1;
  consumer_id: string;
  project_id: string;
  acked_seq: number;
  updated_at: string;
}

export class InboxError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(exitCode: number, code: string, message: string) {
    super(message);
    this.name = "InboxError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function configError(message: string): InboxError {
  return new InboxError(2, "INBOX_CONFIG", message);
}

function unsafeError(message: string): InboxError {
  return new InboxError(3, "INBOX_UNSAFE", message);
}

function corruptError(message: string): InboxError {
  return new InboxError(3, "INBOX_CORRUPT", message);
}

function versionError(message: string): InboxError {
  return new InboxError(3, "INBOX_VERSION", message);
}

function crossProjectError(message: string): InboxError {
  return new InboxError(3, "INBOX_CROSS_PROJECT", message);
}

function conflictError(message: string): InboxError {
  return new InboxError(3, "INBOX_CONFLICT", message);
}

function tooLargeError(message: string): InboxError {
  return new InboxError(3, "INBOX_TOO_LARGE", message);
}

function diskError(message: string): InboxError {
  return new InboxError(1, "INBOX_DISK", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPrivateMode(info: { mode: number }, label: string): void {
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw unsafeError(`${label} must be private (mode 0700)`);
  }
}

function redactValue(value: string, secret: string): string {
  return secret === "" ? value : value.split(secret).join("[REDACTED]");
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value === undefined ? fallback : value;
}

// ---------------------------------------------------------------- paths

function assertOutsideRepository(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (inside) throw configError("spool directory must be outside the repository");
}

function resolveSpoolRoot(dir: string, repoRoot: string, create: boolean): string {
  const root = realpathSync(repoRoot);
  const absolute = resolve(dir);
  let existing;
  try {
    existing = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  let created = false;
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) throw unsafeError("spool directory must not be a symbolic link");
    if (!existing.isDirectory()) throw unsafeError("spool path must be a directory");
    assertOutsideRepository(realpathSync(absolute), root);
    assertPrivateMode(existing, "spool directory");
  } else {
    if (!create) throw configError("spool directory does not exist");
    // Resolve the nearest existing ancestor so a symlinked parent cannot point
    // the created directory back into the repository.
    let ancestor = dirname(absolute);
    const missing: string[] = [basename(absolute)];
    while (!existsSync(ancestor)) {
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (!statSync(ancestor).isDirectory()) throw configError("spool parent must be a directory");
    assertOutsideRepository(join(realpathSync(ancestor), ...missing), root);
    mkdirSync(absolute, { recursive: true, mode: 0o700 });
    created = true;
  }
  // Never chmod a pre-existing user-supplied directory (for example /tmp);
  // tighten only the directory this call created.
  if (created) chmodSync(absolute, 0o700);
  const resolved = realpathSync(absolute);
  assertOutsideRepository(resolved, root);
  return resolved;
}

// Create or validate one direct child directory. A symlinked, non-directory, or
// loosely permissioned pre-existing child fails closed; permissions are
// tightened only for a directory this call created.
function ensurePrivateDir(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (info !== undefined) {
    if (info.isSymbolicLink()) throw unsafeError("spool subdirectory must not be a symbolic link");
    if (!info.isDirectory()) throw unsafeError("spool subdirectory must be a directory");
    assertPrivateMode(info, "spool subdirectory");
    return;
  }
  mkdirSync(path, { recursive: false, mode: 0o700 });
  chmodSync(path, 0o700);
}

function safeConsumerId(consumerId: string): string {
  if (!SAFE_ID.test(consumerId) || consumerId === "." || consumerId === "..") {
    throw configError("consumer id must be 1-64 safe characters");
  }
  return consumerId;
}

function eventName(seq: number): string {
  return `${String(seq).padStart(16, "0")}.json`;
}

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------- safe reads

function readPrivateFile(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    throw unsafeError("spool file is not readable or is a symbolic link");
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw unsafeError("spool path must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw unsafeError("spool file must be private (mode 0600)");
    }
    if (info.size > maxBytes) throw tooLargeError("spool file exceeds its size bound");
    try {
      return readFileSync(fd, "utf8");
    } catch {
      throw unsafeError("spool file is not readable");
    }
  } finally {
    closeSync(fd);
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw corruptError(`${label} is not valid JSON`);
  }
}

// ---------------------------------------------------------------- atomic write

function writePrivateAtomic(dir: string, tmpDir: string, name: string, payload: string): void {
  const target = join(dir, name);
  const temporary = join(tmpDir, `${name}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  let fd: number | undefined;
  try {
    fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW, 0o600);
    try {
      // writeFileSync over a descriptor loops over partial writes; a bare
      // writeSync could short-write and still be renamed as complete.
      writeFileSync(fd, payload);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    syncDir(dir);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Never created or already renamed.
    }
    if (error instanceof InboxError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOSPC" || code === "EDQUOT") {
      throw diskError("spool has no space left");
    }
    throw diskError("spool write failed; no complete record was written");
  }
}

function clearTemporary(tmpDir: string): void {
  for (const entry of readdirSync(tmpDir, { withFileTypes: true })) {
    const path = join(tmpDir, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      throw unsafeError("spool tmp directory contains an unexpected directory");
    }
    try {
      unlinkSync(path);
    } catch {
      // Another process removed it; single-writer spools only.
    }
  }
}

const ACK_TEMP = /\.json\.tmp-[^/]*$/;

// Every acknowledgement directory that belongs to a registered consumer (one
// that has an `acks/` directory). A bare consumer directory is ignored.
function ackDirectories(spool: InboxSpool): string[] {
  const directories: string[] = [];
  for (const entry of readdirSync(spool.consumersDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafeError("consumer entry must not be a symbolic link");
    if (!entry.isDirectory()) continue;
    if (!SAFE_ID.test(entry.name) || entry.name === "." || entry.name === "..") continue;
    const consumerPath = join(spool.consumersDir, entry.name);
    const consumerInfo = lstatSync(consumerPath);
    if (!consumerInfo.isDirectory()) throw unsafeError("consumer path must be a directory");
    assertPrivateMode(consumerInfo, "consumer directory");
    const dir = join(consumerPath, "acks");
    let info;
    try {
      info = lstatSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw unsafeError("acknowledgement directory must not be a symbolic link");
    }
    if (!info.isDirectory()) throw unsafeError("acknowledgement path must be a directory");
    assertPrivateMode(info, "acknowledgement directory");
    directories.push(dir);
  }
  return directories;
}

// Ack temps live beside their ack files so a consumer never touches the
// single-writer `tmp/` directory. A crash there must not grow the spool without
// bound, so bridge start sweeps them (single-writer startup assumption).
function clearConsumerTemporaries(spool: InboxSpool): void {
  for (const dir of ackDirectories(spool)) {
    let removed = false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw unsafeError("acknowledgement temp path must not be a symbolic link");
      }
      if (!entry.isFile() || !ACK_TEMP.test(entry.name)) continue;
      try {
        unlinkSync(join(dir, entry.name));
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw diskError("acknowledgement temp cleanup failed");
        }
      }
    }
    if (removed) syncDir(dir);
  }
}

function consumerTemporaryBytes(spool: InboxSpool): number {
  let bytes = 0;
  for (const dir of ackDirectories(spool)) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw unsafeError("acknowledgement temp path must not be a symbolic link");
      }
      if (!entry.isFile() || !ACK_TEMP.test(entry.name)) continue;
      bytes += lstatSync(join(dir, entry.name)).size;
    }
  }
  return bytes;
}

// ---------------------------------------------------------------- config

function parseConfig(text: string): SpoolConfigV1 {
  const parsed = parseJson(text, "spool configuration");
  if (!isRecord(parsed)) throw corruptError("spool configuration is malformed");
  if (parsed.version !== SPOOL_VERSION) throw versionError("unknown spool configuration version");
  if (typeof parsed.project_id !== "string" || parsed.project_id === "") {
    throw corruptError("spool configuration has no project id");
  }
  if (typeof parsed.plaintext !== "boolean") {
    throw corruptError("spool configuration has no plaintext mode");
  }
  return {
    version: SPOOL_VERSION,
    project_id: parsed.project_id,
    plaintext: parsed.plaintext,
    created_at: typeof parsed.created_at === "string" ? parsed.created_at : "",
  };
}

function buildSpool(
  root: string,
  config: SpoolConfigV1,
  options: SpoolOptions,
): InboxSpool {
  const eventsDir = join(root, "events");
  const payloadsDir = join(root, "payloads");
  const consumersDir = join(root, "consumers");
  const tmpDir = join(root, "tmp");
  ensurePrivateDir(eventsDir);
  ensurePrivateDir(consumersDir);
  ensurePrivateDir(tmpDir);
  if (config.plaintext) ensurePrivateDir(payloadsDir);
  return {
    root,
    projectId: config.project_id,
    plaintext: config.plaintext,
    eventsDir,
    payloadsDir,
    consumersDir,
    tmpDir,
    cursorPath: join(root, "cursor.json"),
    maxEvents: positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS),
    maxBytes: positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES),
    maxEventBytes: positiveInteger(options.maxEventBytes, DEFAULT_MAX_EVENT_BYTES),
    retentionMs: positiveInteger(options.retentionMs, DEFAULT_RETENTION_MS),
  };
}

export function prepareSpool(
  dir: string,
  projectId: string,
  options: PrepareSpoolOptions = {},
): InboxSpool {
  if (
    typeof projectId !== "string" ||
    projectId === "" ||
    projectId.length > 256 ||
    projectId.includes("\0")
  ) {
    throw configError("project id is required");
  }
  const root = resolveSpoolRoot(dir, options.repoRoot ?? REPO_ROOT, true);
  const configPath = join(root, "spool.json");
  ensurePrivateDir(join(root, "tmp"));
  let config: SpoolConfigV1;
  if (existsSync(configPath)) {
    config = parseConfig(readPrivateFile(configPath, MAX_CONFIG_BYTES));
    if (config.project_id !== projectId) {
      throw crossProjectError("spool is bound to a different project");
    }
    if (options.plaintext !== undefined && config.plaintext !== options.plaintext) {
      throw configError("spool plaintext mode cannot change after creation");
    }
  } else {
    const now = options.now ?? (() => new Date());
    config = {
      version: SPOOL_VERSION,
      project_id: projectId,
      plaintext: options.plaintext === true,
      created_at: now().toISOString(),
    };
    writePrivateAtomic(
      root,
      join(root, "tmp"),
      "spool.json",
      `${JSON.stringify(config)}\n`,
    );
  }
  const spool = buildSpool(root, config, options);
  clearTemporary(spool.tmpDir);
  clearConsumerTemporaries(spool);
  return spool;
}

export function openSpool(dir: string, options: SpoolOptions = {}): InboxSpool {
  const root = resolveSpoolRoot(dir, options.repoRoot ?? REPO_ROOT, false);
  const configPath = join(root, "spool.json");
  if (!existsSync(configPath)) throw configError("spool is not initialized");
  const config = parseConfig(readPrivateFile(configPath, MAX_CONFIG_BYTES));
  return buildSpool(root, config, options);
}

// ---------------------------------------------------------------- events

function parsePayloadRef(value: unknown): InboxPayload {
  if (!isRecord(value) || typeof value.included !== "boolean") {
    throw corruptError("event payload reference is malformed");
  }
  if (!value.included) return { included: false };
  if (typeof value.digest !== "string" || !SHA256_DIGEST.test(value.digest)) {
    throw corruptError("event payload digest is malformed");
  }
  if (typeof value.path !== "string" || !/^payloads\/\d{16}\.json$/.test(value.path)) {
    throw corruptError("event payload path is malformed");
  }
  return { included: true, digest: value.digest, path: value.path };
}

function parseEvent(text: string, projectId: string): InboxEventV1 {
  const parsed = parseJson(text, "event");
  if (!isRecord(parsed)) throw corruptError("event record is malformed");
  if (parsed.version !== EVENT_VERSION) throw versionError("unknown event version");
  if (parsed.project_id !== projectId) throw crossProjectError("event belongs to another project");
  const seq = parsed.seq;
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= 0) {
    throw corruptError("event has an invalid seq");
  }
  if (typeof parsed.message_id !== "string" || parsed.message_id === "") {
    throw corruptError("event has no message id");
  }
  if (
    !isRecord(parsed.sender) ||
    typeof parsed.sender.id !== "string" ||
    parsed.sender.id === "" ||
    parsed.sender.attribution !== "server_authenticated"
  ) {
    throw corruptError("event has no authenticated sender attribution");
  }
  if (parsed.body_state !== "ready" && parsed.body_state !== "expired") {
    throw corruptError("event has an invalid message state");
  }
  if (
    typeof parsed.summary !== "string" ||
    typeof parsed.queued_at !== "string" ||
    !Number.isFinite(Date.parse(parsed.queued_at))
  ) {
    throw corruptError("event metadata is malformed");
  }
  return {
    version: EVENT_VERSION,
    project_id: projectId,
    seq,
    message_id: parsed.message_id,
    sender: { id: parsed.sender.id, attribution: "server_authenticated" },
    body_state: parsed.body_state,
    summary: parsed.summary,
    queued_at: parsed.queued_at,
    payload: parsePayloadRef(parsed.payload),
  };
}

function expectedEvent(spool: InboxSpool, message: InboxMessageInput, token: string): InboxEventV1 {
  return {
    version: EVENT_VERSION,
    project_id: spool.projectId,
    seq: message.seq,
    message_id: redactValue(message.messageId, token),
    sender: { id: redactValue(message.senderId, token), attribution: "server_authenticated" },
    body_state: message.bodyState,
    summary: redactValue(message.summary, token),
    queued_at: "",
    payload: { included: false },
  };
}

interface PayloadFileV1 {
  version: 1;
  project_id: string;
  seq: number;
  message_id: string;
  digest: string;
  text: string;
}

function bodyDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function parsePayloadFile(text: string, projectId: string): PayloadFileV1 {
  const parsed = parseJson(text, "payload");
  if (!isRecord(parsed)) throw corruptError("payload record is malformed");
  if (parsed.version !== EVENT_VERSION) throw versionError("unknown payload version");
  if (parsed.project_id !== projectId) throw crossProjectError("payload belongs to another project");
  if (typeof parsed.seq !== "number" || !Number.isSafeInteger(parsed.seq) || parsed.seq <= 0) {
    throw corruptError("payload has an invalid seq");
  }
  if (
    typeof parsed.message_id !== "string" ||
    parsed.message_id === "" ||
    typeof parsed.text !== "string"
  ) {
    throw corruptError("payload fields are malformed");
  }
  if (typeof parsed.digest !== "string" || !SHA256_DIGEST.test(parsed.digest)) {
    throw corruptError("payload digest is malformed");
  }
  return {
    version: EVENT_VERSION,
    project_id: projectId,
    seq: parsed.seq,
    message_id: parsed.message_id,
    digest: parsed.digest,
    text: parsed.text,
  };
}

function assertSameEvent(
  existing: InboxEventV1,
  expected: InboxEventV1,
  seq: number,
): void {
  if (existing.message_id !== expected.message_id) {
    throw conflictError(`seq ${seq} was already queued with a different message id`);
  }
  if (existing.sender.id !== expected.sender.id) {
    throw conflictError(`seq ${seq} was already queued with a different sender`);
  }
  if (existing.summary !== expected.summary) {
    throw conflictError(`seq ${seq} was already queued with different metadata`);
  }
}

function countUsage(spool: InboxSpool): { events: number; bytes: number } {
  let events = 0;
  let bytes = 0;
  const scan = (dir: string, suffix: string): number => {
    let found = 0;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw unsafeError("spool contains a symbolic link");
      if (!entry.isFile() || !entry.name.endsWith(suffix)) continue;
      const path = join(dir, entry.name);
      const info = lstatSync(path);
      bytes += info.size;
      found += 1;
    }
    return found;
  };
  events += scan(spool.eventsDir, ".json");
  if (spool.plaintext) scan(spool.payloadsDir, ".json");
  for (const entry of readdirSync(spool.tmpDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink() || !entry.isFile()) throw unsafeError("spool tmp contains an unsafe entry");
    bytes += lstatSync(join(spool.tmpDir, entry.name)).size;
  }
  // Crashed acknowledgement writes live in consumer ack directories; count them
  // against the byte cap until the next bridge start sweeps them.
  bytes += consumerTemporaryBytes(spool);
  return { events, bytes };
}

function listEventFiles(spool: InboxSpool): Array<{ seq: number; path: string }> {
  const files: Array<{ seq: number; path: string }> = [];
  for (const entry of readdirSync(spool.eventsDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafeError("spool contains a symbolic link");
    if (!entry.isFile()) continue;
    const match = EVENT_FILE.exec(entry.name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw corruptError("spool contains an invalid event file name");
    }
    files.push({ seq, path: join(spool.eventsDir, entry.name) });
  }
  files.sort((a, b) => a.seq - b.seq);
  return files;
}

export function enqueueEvent(
  spool: InboxSpool,
  message: InboxMessageInput,
  body: string | null,
  options: EnqueueOptions,
): InboxEventV1 {
  if (message.projectId !== spool.projectId) {
    throw crossProjectError("message belongs to a different project than the spool");
  }
  if (!Number.isSafeInteger(message.seq) || message.seq <= 0) {
    throw unsafeError("message has an invalid seq");
  }
  if (typeof message.messageId !== "string" || message.messageId === "") {
    throw unsafeError("message has no valid message id");
  }
  if (typeof message.senderId !== "string" || message.senderId === "") {
    throw unsafeError("message has no valid sender");
  }
  if (message.bodyState !== "ready" && message.bodyState !== "expired") {
    throw unsafeError("message has an invalid body state");
  }
  if (typeof message.summary !== "string") {
    throw unsafeError("message has malformed summary metadata");
  }
  if (message.bodyState === "expired" && body !== null) {
    throw unsafeError("an expired message cannot carry plaintext");
  }

  const now = options.now ?? (() => new Date());
  const expected = expectedEvent(spool, message, options.token);
  expected.queued_at = now().toISOString();

  const name = eventName(message.seq);
  const eventPath = join(spool.eventsDir, name);

  if (existsSync(eventPath)) {
    const existing = parseEvent(readPrivateFile(eventPath, spool.maxEventBytes), spool.projectId);
    if (existing.seq !== message.seq) {
      throw corruptError(`event file for seq ${message.seq} names a different seq`);
    }
    assertSameEvent(existing, expected, message.seq);
    if (existing.body_state === "expired") {
      if (existing.payload.included) {
        throw corruptError(`expired event for seq ${message.seq} carries a payload`);
      }
    } else if (spool.plaintext) {
      if (!existing.payload.included) {
        // A plaintext spool's ready event always has a payload; an event
        // without one is a corrupt record, not a metadata-only variant.
        throw corruptError(`event for seq ${message.seq} has no plaintext payload`);
      }
      const payload = parsePayloadFile(
        readPrivateFile(
          join(spool.root, existing.payload.path),
          spool.maxEventBytes,
        ),
        spool.projectId,
      );
      if (payload.seq !== existing.seq || payload.message_id !== existing.message_id) {
        throw corruptError(`payload for seq ${message.seq} is inconsistent`);
      }
      if (body !== null && bodyDigest(body) !== payload.digest) {
        throw conflictError(`body for seq ${message.seq} conflicts with the queued payload`);
      }
    }
    return existing;
  }

  let payload: InboxPayload = { included: false };
  let payloadSerialized: string | undefined;
  if (spool.plaintext && message.bodyState === "ready") {
    if (body === null) throw unsafeError("a ready message has no verified body");
    const digest = bodyDigest(body);
    const payloadName = eventName(message.seq);
    const record: PayloadFileV1 = {
      version: EVENT_VERSION,
      project_id: spool.projectId,
      seq: message.seq,
      message_id: expected.message_id,
      digest,
      text: body,
    };
    payloadSerialized = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(payloadSerialized, "utf8") > spool.maxEventBytes) {
      throw tooLargeError("payload exceeds the event size bound");
    }
    payload = { included: true, digest, path: `payloads/${payloadName}` };
  }

  const event: InboxEventV1 = { ...expected, payload };
  const serialized = `${JSON.stringify(event)}\n`;
  const eventBytes = Buffer.byteLength(serialized, "utf8");
  const payloadBytes =
    payloadSerialized === undefined ? 0 : Buffer.byteLength(payloadSerialized, "utf8");
  if (eventBytes > spool.maxEventBytes) {
    throw tooLargeError("event exceeds the event size bound");
  }

  // A crash between the payload rename and the event rename leaves an orphan
  // payload that usage already counts; do not charge it twice.
  const payloadName = eventName(message.seq);
  const payloadPath = join(spool.payloadsDir, payloadName);
  const payloadAlreadyPresent = payloadSerialized !== undefined && existsSync(payloadPath);
  const addedBytes = eventBytes + (payloadAlreadyPresent ? 0 : payloadBytes);
  const usage = countUsage(spool);
  if (usage.events + 1 > spool.maxEvents || usage.bytes + addedBytes > spool.maxBytes) {
    pruneSpool(spool, { force: true, now });
    const after = countUsage(spool);
    if (after.events + 1 > spool.maxEvents || after.bytes + addedBytes > spool.maxBytes) {
      throw new InboxError(
        1,
        "INBOX_BACKPRESSURE",
        `spool is at capacity for seq ${message.seq}; cursor unchanged`,
      );
    }
  }
  if (payloadSerialized !== undefined) {
    if (payloadAlreadyPresent) {
      const existing = parsePayloadFile(
        readPrivateFile(payloadPath, spool.maxEventBytes),
        spool.projectId,
      );
      if (
        existing.seq !== message.seq ||
        existing.message_id !== expected.message_id ||
        !payload.included ||
        existing.digest !== payload.digest
      ) {
        throw conflictError(`payload for seq ${message.seq} conflicts with the queued event`);
      }
    } else {
      writePrivateAtomic(spool.payloadsDir, spool.tmpDir, payloadName, payloadSerialized);
    }
  }
  writePrivateAtomic(spool.eventsDir, spool.tmpDir, name, serialized);
  return event;
}

export function listEvents(spool: InboxSpool): InboxEventV1[] {
  return listEventFiles(spool).map(({ seq, path }) => {
    const event = parseEvent(readPrivateFile(path, spool.maxEventBytes), spool.projectId);
    if (event.seq !== seq) {
      throw corruptError("event file name does not match its seq");
    }
    return event;
  });
}

export function readPayload(spool: InboxSpool, event: InboxEventV1): string {
  if (!spool.plaintext) throw configError("spool has no plaintext payloads");
  if (!event.payload.included) throw configError("event has no plaintext payload");
  if (event.project_id !== spool.projectId) throw crossProjectError("event belongs to another project");
  if (event.payload.path !== `payloads/${eventName(event.seq)}`) {
    throw unsafeError("event payload path does not match its seq");
  }
  const payload = parsePayloadFile(
    readPrivateFile(join(spool.root, event.payload.path), spool.maxEventBytes),
    spool.projectId,
  );
  if (
    payload.seq !== event.seq ||
    payload.message_id !== event.message_id ||
    payload.digest !== event.payload.digest
  ) {
    throw conflictError(`payload for seq ${event.seq} does not match its event`);
  }
  if (bodyDigest(payload.text) !== payload.digest) {
    throw conflictError(`payload for seq ${event.seq} failed digest verification`);
  }
  return payload.text;
}

// ---------------------------------------------------------------- consumers

function consumerDir(spool: InboxSpool, consumerId: string): string {
  return join(spool.consumersDir, safeConsumerId(consumerId));
}

function acksDir(spool: InboxSpool, consumerId: string): string {
  return join(consumerDir(spool, consumerId), "acks");
}

function parseAck(text: string, consumerId: string, projectId: string): ConsumerAckV1 {
  const parsed = parseJson(text, "acknowledgement");
  if (!isRecord(parsed)) throw corruptError("acknowledgement is malformed");
  if (parsed.version !== ACK_VERSION) throw versionError("unknown acknowledgement version");
  if (parsed.consumer_id !== consumerId) {
    throw corruptError("acknowledgement names a different consumer");
  }
  if (parsed.project_id !== projectId) {
    throw crossProjectError("acknowledgement belongs to another project");
  }
  const acked = parsed.acked_seq;
  if (typeof acked !== "number" || !Number.isSafeInteger(acked) || acked < 0) {
    throw corruptError("acknowledgement has an invalid seq");
  }
  return {
    version: ACK_VERSION,
    consumer_id: consumerId,
    project_id: projectId,
    acked_seq: acked,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
  };
}

function zeroAck(consumerId: string, projectId: string): ConsumerAckV1 {
  return {
    version: ACK_VERSION,
    consumer_id: consumerId,
    project_id: projectId,
    acked_seq: 0,
    updated_at: "",
  };
}

// Acknowledgements are one immutable file per acknowledged seq. Readers take
// the maximum, so a stale concurrent writer can add a lower file but can never
// regress the watermark. Files below the maximum are best-effort cleanup.
function readAckFiles(spool: InboxSpool, consumerId: string): ConsumerAckV1[] {
  const id = safeConsumerId(consumerId);
  let info;
  try {
    info = lstatSync(consumerDir(spool, id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InboxError(3, "INBOX_NOT_FOUND", "consumer is not registered");
    }
    throw error;
  }
  if (info.isSymbolicLink()) throw unsafeError("consumer directory must not be a symbolic link");
  if (!info.isDirectory()) throw unsafeError("consumer path must be a directory");
  assertPrivateMode(info, "consumer directory");

  const dir = acksDir(spool, id);
  let dirInfo;
  try {
    dirInfo = lstatSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new InboxError(3, "INBOX_NOT_FOUND", "consumer is not registered");
    }
    throw error;
  }
  if (dirInfo.isSymbolicLink()) throw unsafeError("acknowledgement directory must not be a symbolic link");
  if (!dirInfo.isDirectory()) throw unsafeError("acknowledgement path must be a directory");
  assertPrivateMode(dirInfo, "acknowledgement directory");

  const acks: ConsumerAckV1[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafeError("acknowledgement must not be a symbolic link");
    if (entry.isDirectory()) {
      throw corruptError("acknowledgement directory contains an unexpected directory");
    }
    if (!entry.isFile()) continue;
    const match = ACK_FILE.exec(entry.name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (!Number.isSafeInteger(seq) || seq <= 0) {
      throw corruptError("acknowledgement has an invalid file name");
    }
    const ack = parseAck(
      readPrivateFile(join(dir, entry.name), MAX_CONFIG_BYTES),
      id,
      spool.projectId,
    );
    if (ack.acked_seq !== seq) {
      throw corruptError("acknowledgement file name does not match its seq");
    }
    acks.push(ack);
  }
  return acks;
}

export function registerConsumer(spool: InboxSpool, consumerId: string): ConsumerAckV1 {
  const id = safeConsumerId(consumerId);
  ensurePrivateDir(consumerDir(spool, id));
  ensurePrivateDir(acksDir(spool, id));
  // A registered consumer with no acknowledgement file is conservative: it
  // counts as seq 0, so pruning holds instead of throwing.
  return consumerAck(spool, id);
}

export function consumerAck(spool: InboxSpool, consumerId: string): ConsumerAckV1 {
  const id = safeConsumerId(consumerId);
  const acks = readAckFiles(spool, id);
  if (acks.length === 0) return zeroAck(id, spool.projectId);
  let best = acks[0] as ConsumerAckV1;
  for (const ack of acks) {
    if (ack.acked_seq > best.acked_seq) best = ack;
  }
  return best;
}

export function acknowledgedSeq(spool: InboxSpool, consumerId: string): number {
  return consumerAck(spool, consumerId).acked_seq;
}

export function pendingEvents(
  spool: InboxSpool,
  consumerId: string,
  limit = 100,
): InboxEventV1[] {
  if (!Number.isSafeInteger(limit) || limit < 1) throw configError("limit must be positive");
  const after = acknowledgedSeq(spool, consumerId);
  return listEvents(spool)
    .filter((event) => event.seq > after)
    .slice(0, limit);
}

function cleanupAcks(dir: string, keep: number): void {
  let removed = false;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafeError("acknowledgement must not be a symbolic link");
    if (!entry.isFile()) continue;
    const match = ACK_FILE.exec(entry.name);
    if (match === null) continue;
    const seq = Number(match[1]);
    if (seq >= keep) continue;
    try {
      unlinkSync(join(dir, entry.name));
      removed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw diskError("acknowledgement cleanup failed");
      }
    }
  }
  if (removed) syncDir(dir);
}

export function ackEvent(
  spool: InboxSpool,
  consumerId: string,
  seq: number,
): ConsumerAckV1 {
  const id = safeConsumerId(consumerId);
  if (!Number.isSafeInteger(seq) || seq <= 0) throw configError("seq must be positive");
  const ack = consumerAck(spool, id);
  if (seq <= ack.acked_seq) return ack;
  if (seq !== ack.acked_seq + 1) {
    throw new InboxError(
      3,
      "INBOX_OUT_OF_ORDER",
      `acknowledgement would skip unacknowledged events before seq ${seq}`,
    );
  }
  const path = join(spool.eventsDir, eventName(seq));
  if (!existsSync(path)) throw new InboxError(3, "INBOX_NOT_FOUND", `event ${seq} does not exist`);
  const event = parseEvent(readPrivateFile(path, spool.maxEventBytes), spool.projectId);
  if (event.seq !== seq) throw corruptError(`event file for seq ${seq} names a different seq`);

  const dir = acksDir(spool, id);
  ensurePrivateDir(dir);
  const name = eventName(seq);
  const target = join(dir, name);
  const record: ConsumerAckV1 = {
    version: ACK_VERSION,
    consumer_id: id,
    project_id: spool.projectId,
    acked_seq: seq,
    updated_at: new Date().toISOString(),
  };
  if (existsSync(target)) {
    const existing = parseAck(readPrivateFile(target, MAX_CONFIG_BYTES), id, spool.projectId);
    if (existing.acked_seq !== seq) {
      throw corruptError("acknowledgement file name does not match its seq");
    }
  } else {
    writePrivateAtomic(dir, dir, name, `${JSON.stringify(record)}\n`);
  }
  cleanupAcks(dir, seq);
  // Re-read the maximum so a concurrent higher acknowledgement is never
  // reported as a smaller one.
  return consumerAck(spool, id);
}

function registeredConsumers(spool: InboxSpool): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(spool.consumersDir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw unsafeError("consumer entry must not be a symbolic link");
    if (!entry.isDirectory()) continue;
    if (!SAFE_ID.test(entry.name) || entry.name === "." || entry.name === "..") {
      throw corruptError("consumer directory has an unsafe name");
    }
    // A consumer is registered only once its `acks/` directory exists. A bare
    // directory left by an interrupted registration is ignored, so pruning does
    // not fail on a consumer that cannot have acknowledged anything.
    let acksInfo;
    try {
      acksInfo = lstatSync(join(spool.consumersDir, entry.name, "acks"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (acksInfo.isSymbolicLink()) {
      throw unsafeError("acknowledgement directory must not be a symbolic link");
    }
    if (!acksInfo.isDirectory()) throw unsafeError("acknowledgement path must be a directory");
    ids.push(entry.name);
  }
  ids.sort();
  return ids;
}

export interface PruneOptions {
  force?: boolean | undefined;
  now?: (() => Date) | undefined;
}

// Remove only events every registered consumer has acknowledged. `force`
// ignores the retention window for backpressure; it never removes an
// unacknowledged event.
export function pruneSpool(spool: InboxSpool, options: PruneOptions = {}): number {
  const consumers = registeredConsumers(spool);
  if (consumers.length === 0) return 0;
  let minAck = Number.POSITIVE_INFINITY;
  for (const consumerId of consumers) {
    minAck = Math.min(minAck, acknowledgedSeq(spool, consumerId));
  }
  if (minAck === Number.POSITIVE_INFINITY) return 0;
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  let removed = 0;
  for (const { seq, path } of listEventFiles(spool)) {
    if (seq > minAck) break;
    const event = parseEvent(readPrivateFile(path, spool.maxEventBytes), spool.projectId);
    if (event.seq !== seq) throw corruptError("event file name does not match its seq");
    if (options.force !== true && nowMs - Date.parse(event.queued_at) < spool.retentionMs) {
      continue;
    }
    if (event.payload.included) {
      // Delete the event first. A crash before the payload unlink leaves a
      // harmless orphan payload, which the replay path can reuse and the sweep
      // below can reap; the reverse order could leave an event naming a
      // missing payload.
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw diskError("spool event cleanup failed");
        }
      }
      syncDir(spool.eventsDir);
      try {
        unlinkSync(join(spool.root, event.payload.path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw diskError("spool payload cleanup failed");
        }
      }
      syncDir(spool.payloadsDir);
    } else {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw diskError("spool event cleanup failed");
        }
      }
      syncDir(spool.eventsDir);
    }
    removed += 1;
  }
  if (spool.plaintext) {
    // Reap payloads left by a crash between the event and payload unlinks.
    for (const entry of readdirSync(spool.payloadsDir, { withFileTypes: true })) {
      if (entry.isFile() && !entry.isSymbolicLink()) {
        const match = EVENT_FILE.exec(entry.name);
        if (match === null || Number(match[1]) > minAck) continue;
        if (existsSync(join(spool.eventsDir, entry.name))) continue;
        try {
          unlinkSync(join(spool.payloadsDir, entry.name));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw diskError("spool payload cleanup failed");
          }
        }
      }
    }
    syncDir(spool.payloadsDir);
  }
  return removed;
}

export function spoolUsage(spool: InboxSpool): { events: number; bytes: number } {
  return countUsage(spool);
}
