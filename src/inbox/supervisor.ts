// Supervised inbox follower: exclusive polling lock, durable operational
// status, bounded retry/backoff, and clean signal shutdown.
//
// This module does not fetch, verify, or acknowledge anything itself. Every
// poll pass reuses src/inbox/bridge.ts and scripts/poll.ts, so the #16
// receipt/cursor ordering and the reference client's validation are unchanged.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_INTERVAL_MS,
  PollError,
  redact,
} from "../../scripts/poll.ts";
import {
  InboxError,
  acknowledgedSeq,
  listEvents,
  prepareSpool,
  registeredConsumers,
  spoolUsage,
  type InboxSpool,
} from "./spool.ts";
import { runInbox, type RunInboxOptions } from "./bridge.ts";

export const SUPERVISOR_VERSION = 1;
export const SUPERVISOR_LOCK_FILE = "supervisor.lock";
export const SUPERVISOR_GUARD_DIR = "supervisor.guard";
export const SUPERVISOR_STATUS_FILE = "supervisor-status.json";
export const DEFAULT_RETRY_DELAY_MS = 1_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 60_000;
export const GUARD_STALE_MS = 30_000;

const MAX_STATE_BYTES = 64 << 10;
const MAX_BASE_URL_BYTES = 2_048;
const LOCK_INSTANCE = /^[0-9a-f]{16,64}$/;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export interface SupervisorLockRecordV1 {
  version: 1;
  instance: string;
  pid: number;
  boot_id: string | null;
  process_start: string | null;
  project_id: string;
  base_url: string;
  started_at: string;
}

export type SupervisorLockState = "absent" | "live" | "stale";
export type SupervisorLockStaleReason = "boot" | "process-gone" | "pid-reused";

export interface SupervisorLockInspection {
  state: SupervisorLockState;
  record?: SupervisorLockRecordV1;
  reason?: SupervisorLockStaleReason;
}

export type SupervisorState = "starting" | "running" | "degraded" | "stopped" | "failed";

export interface SupervisorConsumerStatus {
  id: string;
  acked_seq: number;
  pending: number;
}

export interface SupervisorStatusV1 {
  version: 1;
  project_id: string;
  state: SupervisorState;
  pid: number;
  started_at: string;
  updated_at: string;
  last_success_at: string | null;
  last_error: string | null;
  degraded: boolean;
  degraded_reason: string | null;
  stop_reason: string | null;
  passes: number;
  processed_total: number;
  after_seq: number;
  consumers: SupervisorConsumerStatus[];
  backlog: { events: number; bytes: number };
  lag: { pending_events: number; oldest_pending_age_ms: number | null };
  limits: { max_events: number; max_bytes: number };
}

export interface SupervisorOptions extends RunInboxOptions {
  retryDelayMs?: number | undefined;
  maxRetryDelayMs?: number | undefined;
}

export interface SupervisorResult {
  state: "stopped" | "degraded" | "failed";
  exitCode: number;
  passes: number;
  processed: number;
  afterSeq: number;
  status: SupervisorStatusV1 | null;
}

export interface SupervisorLockHandle {
  readonly record: SupervisorLockRecordV1;
  release(): void;
}

interface SupervisorCounters {
  state: SupervisorState;
  startedAt: string;
  lastSuccessAt: string | null;
  lastError: string | null;
  degradedReason: string | null;
  stopReason: string | null;
  passes: number;
  processedTotal: number;
  afterSeq: number;
}

// ---------------------------------------------------------------- identity

export type ProcessStartProbe =
  | { state: "ok"; value: string }
  | { state: "gone" }
  | { state: "unreadable" };

// Identity reads are injectable so the no-/proc and EACCES fail-closed paths
// are testable without requiring a live pathologically permissioned /proc.
export interface SupervisorIdentityProbe {
  bootId?: (() => string | null) | undefined;
  processStart?: ((pid: number) => ProcessStartProbe) | undefined;
  pidAlive?: ((pid: number) => boolean) | undefined;
}

function readBootId(): string | null {
  try {
    const value = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function readProcessStart(pid: number): ProcessStartProbe {
  let stat: string;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ESRCH"
      ? { state: "gone" }
      : { state: "unreadable" };
  }
  const end = stat.lastIndexOf(")");
  if (end < 0) return { state: "unreadable" };
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  // fields[0] is field 3 (state); the starttime field is field 22.
  const start = fields[19];
  return start === undefined ? { state: "unreadable" } : { state: "ok", value: start };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

// ---------------------------------------------------------------- safe state I/O

function syncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readPrivateText(path: string, code: string, label: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new InboxError(3, code, `${label} is not readable or is a symbolic link`);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new InboxError(3, code, `${label} must be a regular file`);
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new InboxError(3, code, `${label} must be private (mode 0600)`);
    }
    if (info.size > MAX_STATE_BYTES) throw new InboxError(3, code, `${label} is too large`);
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function writePrivateJson(root: string, name: string, value: unknown): void {
  const temporary = join(
    root,
    `${name}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, join(root, name));
    syncDir(root);
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
    throw new InboxError(1, "INBOX_DISK", "supervisor state write failed");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInteger(value: unknown, min: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

// ---------------------------------------------------------------- lock records

function parseLockRecord(text: string, projectId: string): SupervisorLockRecordV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor lock is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.version !== SUPERVISOR_VERSION) {
    throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor lock has an unknown version");
  }
  if (parsed.project_id !== projectId) {
    throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor lock names another project");
  }
  if (
    typeof parsed.instance !== "string" ||
    !LOCK_INSTANCE.test(parsed.instance) ||
    !isSafeInteger(parsed.pid, 1) ||
    (parsed.boot_id !== null && typeof parsed.boot_id !== "string") ||
    (parsed.process_start !== null && typeof parsed.process_start !== "string") ||
    typeof parsed.base_url !== "string" ||
    parsed.base_url === "" ||
    Buffer.byteLength(parsed.base_url, "utf8") > MAX_BASE_URL_BYTES ||
    !isTimestamp(parsed.started_at)
  ) {
    throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor lock is malformed");
  }
  return {
    version: SUPERVISOR_VERSION,
    instance: parsed.instance,
    pid: parsed.pid,
    boot_id: parsed.boot_id,
    process_start: parsed.process_start,
    project_id: projectId,
    base_url: parsed.base_url,
    started_at: parsed.started_at,
  };
}

// ---------------------------------------------------------------- guard
//
// All canonical-lock mutation (create, stale reclaim, release) happens inside a
// single atomic guard directory. Without it, three parties can interleave:
// P1 reclaims stale R1 and links live R2; P2 (holding an old stale inspection)
// renames R2 aside; P3 links R3; P2's restore then conflicts and must not be
// allowed to unlink the record it moved. The guard serializes those sections.
//
// shortcut: the guard is serialized by (mkdir + owner-identity reclaim), not a
// kernel advisory lock. Reclaim requires the owner's (boot, pid, starttime)
// identity to be provably dead, so a live stopped/paused holder still blocks;
// only a missing/corrupt owner record falls back to GUARD_STALE_MS. Upgrade to
// flock/fcntl if multi-host or long critical sections are required.

interface GuardOwnerV1 {
  version: 1;
  instance: string;
  pid: number;
  boot_id: string | null;
  process_start: string | null;
  acquired_at: string;
}

interface GuardHandle {
  readonly owner: GuardOwnerV1;
  readonly ino: number;
  release(): void;
}

function guardPath(spool: InboxSpool): string {
  return join(spool.root, SUPERVISOR_GUARD_DIR);
}

function guardOwnerPath(dir: string): string {
  return join(dir, "owner.json");
}

// Bounded synchronous wait for a short critical section. No dependency and no
// event-loop yield, because lock acquisition is synchronous.
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readGuardOwner(dir: string): GuardOwnerV1 | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(guardOwnerPath(dir), "utf8"));
    if (
      !isRecord(parsed) ||
      parsed.version !== 1 ||
      typeof parsed.instance !== "string" ||
      !isSafeInteger(parsed.pid, 1) ||
      (parsed.boot_id !== null && typeof parsed.boot_id !== "string") ||
      (parsed.process_start !== null && typeof parsed.process_start !== "string")
    ) {
      return null;
    }
    return {
      version: 1,
      instance: parsed.instance,
      pid: parsed.pid,
      boot_id: parsed.boot_id,
      process_start: parsed.process_start,
      acquired_at: typeof parsed.acquired_at === "string" ? parsed.acquired_at : "",
    };
  } catch {
    return null;
  }
}

// null means the owner record is missing or corrupt; only then does age decide.
function guardOwnerIsDead(dir: string): boolean | null {
  const owner = readGuardOwner(dir);
  if (owner === null) return null;
  return classifyOwnerLiveness(owner, {}).state === "dead";
}

// Remove only the owner record this process wrote. A replaced guard or another
// holder's record is left untouched.
function removeOwnedGuard(dir: string, owner: GuardOwnerV1): void {
  const current = readGuardOwner(dir);
  if (current === null || current.instance !== owner.instance) return;
  try {
    unlinkSync(guardOwnerPath(dir));
  } catch {
    return;
  }
  try {
    rmdirSync(dir);
  } catch {
    // Not empty or already replaced.
  }
}

function reclaimStaleGuard(spool: InboxSpool, dir: string): boolean {
  const stale = join(
    spool.root,
    `${SUPERVISOR_GUARD_DIR}.stale-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    renameSync(dir, stale);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new InboxError(1, "INBOX_DISK", "supervisor guard reclaim failed");
  }
  // Re-classify the moved guard: a fresh live guard may have replaced the dead
  // one between the caller's inspection and the rename.
  const dead = guardOwnerIsDead(stale);
  let age = Number.POSITIVE_INFINITY;
  try {
    age = Date.now() - lstatSync(stale).mtimeMs;
  } catch {
    // Treat an unreadable moved guard as reclaimable only if the owner is dead.
  }
  const reclaimable = dead === true || (dead === null && age > GUARD_STALE_MS);
  if (!reclaimable) {
    // Put it back if possible; otherwise quarantine it and fail closed. Never
    // delete a guard whose owner may still be inside the section.
    if (!existsSync(dir)) {
      try {
        renameSync(stale, dir);
        return false;
      } catch {
        // Fall through to quarantine.
      }
    }
    const quarantine = join(
      spool.root,
      `${SUPERVISOR_GUARD_DIR}.quarantine-${process.pid}-${randomBytes(6).toString("hex")}`,
    );
    try {
      renameSync(stale, quarantine);
    } catch {
      // Leave it in place; it is not the canonical lock.
    }
    syncDir(spool.root);
    throw new InboxError(1, "INBOX_LOCKED", "supervisor guard reclaim conflict");
  }
  try {
    rmSync(stale, { recursive: true, force: true });
  } catch {
    // Leave it as an orphan; a later sweep removes a dead or old guard.
  }
  syncDir(spool.root);
  return true;
}

function acquireGuard(spool: InboxSpool): GuardHandle {
  const dir = guardPath(spool);
  const owner: GuardOwnerV1 = {
    version: 1,
    instance: randomBytes(16).toString("hex"),
    pid: process.pid,
    boot_id: readBootId(),
    process_start: (() => {
      const start = readProcessStart(process.pid);
      return start.state === "ok" ? start.value : null;
    })(),
    acquired_at: new Date().toISOString(),
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let ino: number;
    try {
      mkdirSync(dir, { mode: 0o700 });
      ino = lstatSync(dir).ino;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new InboxError(1, "INBOX_DISK", "supervisor guard create failed");
      }
      let info;
      try {
        info = lstatSync(dir);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw new InboxError(1, "INBOX_DISK", "supervisor guard stat failed");
      }
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor guard is not a directory");
      }
      const dead = guardOwnerIsDead(dir);
      // A live identity blocks regardless of age. Age decides only when the
      // owner record is missing or corrupt.
      if (dead === false || (dead === null && Date.now() - info.mtimeMs <= GUARD_STALE_MS)) {
        sleepSync(2);
        continue;
      }
      reclaimStaleGuard(spool, dir);
      continue;
    }
    try {
      chmodSync(dir, 0o700);
      // O_EXCL: never clobber another holder's owner record.
      const fd = openSync(
        guardOwnerPath(dir),
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, `${JSON.stringify(owner)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      chmodSync(guardOwnerPath(dir), 0o600);
      if (lstatSync(dir).ino !== ino) {
        removeOwnedGuard(dir, owner);
        continue;
      }
      return {
        owner,
        ino,
        release(): void {
          releaseGuard(spool, owner, ino);
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Remove only what this process wrote: a replaced guard or a foreign
      // owner record must survive.
      removeOwnedGuard(dir, owner);
      if (code === "ENOENT" || code === "EEXIST") {
        sleepSync(2);
        continue;
      }
      throw new InboxError(1, "INBOX_DISK", "supervisor guard create failed");
    }
  }
  throw new InboxError(1, "INBOX_LOCKED", "supervisor guard is busy");
}

function releaseGuard(spool: InboxSpool, owner: GuardOwnerV1, ino: number): void {
  const dir = guardPath(spool);
  let current: unknown;
  try {
    current = JSON.parse(readFileSync(guardOwnerPath(dir), "utf8"));
  } catch {
    return;
  }
  if (!isRecord(current) || current.version !== 1 || current.instance !== owner.instance) {
    return;
  }
  try {
    if (lstatSync(dir).ino !== ino) return;
  } catch {
    return;
  }
  try {
    unlinkSync(guardOwnerPath(dir));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new InboxError(1, "INBOX_DISK", "supervisor guard release failed");
  }
  try {
    rmdirSync(dir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY") {
      throw new InboxError(1, "INBOX_DISK", "supervisor guard release failed");
    }
  }
  syncDir(spool.root);
}

function withGuard<T>(spool: InboxSpool, fn: () => T): T {
  const guard = acquireGuard(spool);
  try {
    return fn();
  } finally {
    guard.release();
  }
}

// A tombstone is a lock record moved aside by a reclaimer. Remove it only when
// its owner is provably dead or it is older than GUARD_STALE_MS: a crash between
// rename and restore can leave a live record there.
function tombstoneReclaimable(
  path: string,
  projectId: string,
  probe: SupervisorIdentityProbe,
): boolean {
  let age = Number.POSITIVE_INFINITY;
  try {
    age = Date.now() - lstatSync(path).mtimeMs;
  } catch {
    return true;
  }
  if (age > GUARD_STALE_MS) return true;
  let record: SupervisorLockRecordV1 | null = null;
  try {
    const text = readPrivateText(path, "INBOX_LOCK_CORRUPT", "supervisor lock tombstone");
    if (text !== null) record = parseLockRecord(text, projectId);
  } catch {
    record = null;
  }
  // A corrupt tombstone is left for the age path above.
  return record !== null && classifyOwnerLiveness(record, probe).state === "dead";
}

// Sweep crash residue while holding the guard. A live canonical lock is never
// matched. Conflicted moved records are left in `.quarantine-*` for recovery.
function sweepOrphans(
  spool: InboxSpool,
  probe: SupervisorIdentityProbe = {},
): void {
  let changed = false;
  for (const entry of readdirSync(spool.root, { withFileTypes: true })) {
    const path = join(spool.root, entry.name);
    if (entry.name.startsWith(`${SUPERVISOR_LOCK_FILE}.stale-`)) {
      if (entry.isDirectory()) continue;
      if (!tombstoneReclaimable(path, spool.projectId, probe)) continue;
      try {
        unlinkSync(path);
        changed = true;
      } catch {
        // Already gone.
      }
      continue;
    }
    if (entry.name.startsWith(`${SUPERVISOR_GUARD_DIR}.stale-`)) {
      let info;
      try {
        info = lstatSync(path);
      } catch {
        continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) continue;
      const dead = guardOwnerIsDead(path);
      const old = Date.now() - info.mtimeMs > GUARD_STALE_MS;
      if (dead !== true && !(dead === null && old)) continue;
      try {
        rmSync(path, { recursive: true, force: true });
        changed = true;
      } catch {
        // Leave it; a later sweep retries.
      }
    }
  }
  if (changed) syncDir(spool.root);
}

function lockPath(spool: InboxSpool): string {
  return join(spool.root, SUPERVISOR_LOCK_FILE);
}

function tempPath(spool: InboxSpool, label: string): string {
  return join(
    spool.tmpDir,
    `${label}-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
}

// Move-then-verify (no read-then-unlink). Call only while holding the guard.
// A moved record is deleted only when its instance is exactly the stale record
// that was inspected; otherwise it is restored with linkSync. If restoration
// conflicts, the moved record is quarantined and kept for recovery; it is
// never unlinked.
function reclaimLock(
  spool: InboxSpool,
  expected: SupervisorLockRecordV1,
  afterMove?: (() => void) | undefined,
): boolean {
  const path = lockPath(spool);
  const tombstone = join(
    spool.root,
    `${SUPERVISOR_LOCK_FILE}.stale-${process.pid}-${randomBytes(6).toString("hex")}`,
  );
  try {
    renameSync(path, tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new InboxError(1, "INBOX_DISK", "supervisor lock reclaim failed");
  }
  // Test seam for the unsupported-writer restore-conflict path. Production
  // callers never pass it.
  afterMove?.();

  let moved: SupervisorLockRecordV1 | null = null;
  try {
    const text = readPrivateText(tombstone, "INBOX_LOCK_CORRUPT", "supervisor lock");
    if (text !== null) moved = parseLockRecord(text, spool.projectId);
  } catch {
    moved = null;
  }

  if (moved !== null && moved.instance === expected.instance) {
    try {
      unlinkSync(tombstone);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new InboxError(1, "INBOX_DISK", "supervisor lock reclaim failed");
      }
    }
    syncDir(spool.root);
    return true;
  }

  // The moved record was not verified as the inspected stale one. Restore it
  // without overwriting a canonical lock that appeared meanwhile.
  try {
    linkSync(tombstone, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // Never unlink an unverified moved record. Quarantine it for recovery.
      const quarantine = join(
        spool.root,
        `${SUPERVISOR_LOCK_FILE}.quarantine-${process.pid}-${randomBytes(6).toString("hex")}`,
      );
      try {
        renameSync(tombstone, quarantine);
      } catch {
        // Leave the tombstone in place instead.
      }
      syncDir(spool.root);
      throw new InboxError(
        1,
        "INBOX_LOCKED",
        "concurrent supervisor lock reclaim conflict; moved record quarantined",
      );
    }
    if (code !== "ENOENT") {
      // Leave the tombstone in place; it is not the canonical lock and may be
      // needed for recovery. A later start sweeps only `.stale-*` orphans.
      syncDir(spool.root);
      throw new InboxError(1, "INBOX_DISK", "supervisor lock restore failed");
    }
  }
  try {
    unlinkSync(tombstone);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new InboxError(1, "INBOX_DISK", "supervisor lock reclaim failed");
    }
  }
  syncDir(spool.root);
  return false;
}

// Test/operator primitive: serialized stale reclaim with an inspection that may
// predate another process's successful acquire.
export function reclaimStaleSupervisorLock(
  spool: InboxSpool,
  expected: SupervisorLockRecordV1,
  afterMove?: (() => void) | undefined,
): boolean {
  return withGuard(spool, () => reclaimLock(spool, expected, afterMove));
}

// A live identity, including a stopped/paused process, is never provably dead.
// An unreadable /proc identity with a responding PID also fails closed.
type OwnerLiveness =
  | { state: "live" }
  | { state: "dead"; reason: SupervisorLockStaleReason };

function classifyOwnerLiveness(
  owner: Pick<SupervisorLockRecordV1, "pid" | "boot_id" | "process_start">,
  probe: SupervisorIdentityProbe,
): OwnerLiveness {
  const bootId = (probe.bootId ?? readBootId)();
  if (owner.boot_id !== null && bootId !== null && owner.boot_id !== bootId) {
    return { state: "dead", reason: "boot" };
  }
  const readStart = probe.processStart ?? readProcessStart;
  const alive = probe.pidAlive ?? pidAlive;
  if (owner.process_start !== null) {
    const current = readStart(owner.pid);
    if (current.state === "gone") {
      return { state: "dead", reason: "process-gone" };
    }
    if (current.state === "unreadable") {
      if (!alive(owner.pid)) {
        return { state: "dead", reason: "process-gone" };
      }
      return { state: "live" };
    }
    if (current.value !== owner.process_start) {
      return { state: "dead", reason: "pid-reused" };
    }
    return { state: "live" };
  }
  // No process-start identity is available on this host. Fail closed while the
  // PID exists.
  if (!alive(owner.pid)) {
    return { state: "dead", reason: "process-gone" };
  }
  return { state: "live" };
}

export function inspectSupervisorLock(
  spool: InboxSpool,
  probe: SupervisorIdentityProbe = {},
): SupervisorLockInspection {
  const text = readPrivateText(lockPath(spool), "INBOX_LOCK_CORRUPT", "supervisor lock");
  if (text === null) return { state: "absent" };
  const record = parseLockRecord(text, spool.projectId);
  const liveness = classifyOwnerLiveness(record, probe);
  if (liveness.state === "live") return { state: "live", record };
  return { state: "stale", record, reason: liveness.reason };
}

// Write a complete 0600 record to a temp file, then hard-link it into place.
// linkSync is atomic and fails with EEXIST; a SIGKILL before the link leaves
// only a temp file in the swept tmp/ directory, never a partial lock.
function tryCreateLock(spool: InboxSpool, record: SupervisorLockRecordV1): boolean {
  const path = lockPath(spool);
  const temporary = tempPath(spool, `${SUPERVISOR_LOCK_FILE}.new`);
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      0o600,
    );
    try {
      writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    chmodSync(temporary, 0o600);
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
      // Never created.
    }
    if (error instanceof InboxError) throw error;
    throw new InboxError(1, "INBOX_DISK", "supervisor lock create failed");
  }
  try {
    linkSync(temporary, path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST" || code === "ENOENT") return false;
    throw new InboxError(1, "INBOX_DISK", "supervisor lock create failed");
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Already removed or raced with the tmp sweep.
    }
  }
  syncDir(spool.root);
  return true;
}

export function acquireSupervisorLock(
  spool: InboxSpool,
  options: {
    baseUrl: string;
    now?: (() => Date) | undefined;
    probe?: SupervisorIdentityProbe | undefined;
  },
): SupervisorLockHandle {
  const now = options.now ?? (() => new Date());
  const probe = options.probe ?? {};
  const start = (probe.processStart ?? readProcessStart)(process.pid);
  const record: SupervisorLockRecordV1 = {
    version: SUPERVISOR_VERSION,
    instance: randomBytes(16).toString("hex"),
    pid: process.pid,
    boot_id: (probe.bootId ?? readBootId)(),
    process_start: start.state === "ok" ? start.value : null,
    project_id: spool.projectId,
    base_url: options.baseUrl,
    started_at: now().toISOString(),
  };
  let swept = false;
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const acquired = withGuard(spool, () => {
      if (!swept) {
        sweepOrphans(spool, probe);
        swept = true;
      }
      if (tryCreateLock(spool, record)) return true;
      const inspection = inspectSupervisorLock(spool, probe);
      if (inspection.state === "absent") return false;
      if (inspection.state === "live") {
        throw new InboxError(
          1,
          "INBOX_LOCKED",
          `supervisor already running for this spool (pid ${inspection.record?.pid ?? "?"})`,
        );
      }
      if (inspection.record !== undefined) reclaimLock(spool, inspection.record);
      return false;
    });
    if (acquired) {
      return {
        record,
        release(): void {
          withGuard(spool, () => {
            reclaimLock(spool, record);
          });
        },
      };
    }
  }
  throw new InboxError(1, "INBOX_LOCKED", "could not acquire the supervisor lock");
}

export function clearStaleSupervisorLock(
  spool: InboxSpool,
  probe: SupervisorIdentityProbe = {},
): "absent" | "cleared" | "live" {
  return withGuard(spool, () => {
    const inspection = inspectSupervisorLock(spool, probe);
    if (inspection.state === "absent") return "absent";
    if (inspection.state === "live") return "live";
    if (inspection.record !== undefined && reclaimLock(spool, inspection.record)) {
      return "cleared";
    }
    return inspectSupervisorLock(spool, probe).state === "live" ? "live" : "absent";
  });
}

// Explicit operator recovery for a corrupt lock (`stop --force`). Never called
// for a live or merely stale record.
export function forceClearSupervisorLock(spool: InboxSpool): boolean {
  // `stop --force` must recover a corrupt lock even when the guard path itself
  // is corrupt (a file or symlink), which the ordinary guard acquisition
  // rejects. A real directory is a live guard and is left to acquireGuard.
  const guard = guardPath(spool);
  try {
    const info = lstatSync(guard);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      rmSync(guard, { force: true });
      syncDir(spool.root);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return withGuard(spool, () => {
    const path = lockPath(spool);
    let info;
    try {
      info = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new InboxError(3, "INBOX_LOCK_CORRUPT", "supervisor lock is not a regular file");
    }
    unlinkSync(path);
    syncDir(spool.root);
    return true;
  });
}

// ---------------------------------------------------------------- status records

export function readCursorAfterSeq(spool: InboxSpool, baseUrl?: string): number | null {
  try {
    const text = readPrivateText(
      join(spool.root, "cursor.json"),
      "INBOX_CORRUPT",
      "cursor file",
    );
    if (text === null) return 0;
    const parsed: unknown = JSON.parse(text);
    if (
      isRecord(parsed) &&
      parsed.version === 1 &&
      parsed.project_id === spool.projectId &&
      (baseUrl === undefined || parsed.base_url === baseUrl) &&
      isSafeInteger(parsed.after_seq, 0)
    ) {
      return parsed.after_seq;
    }
  } catch {
    // Status must not mask the poller's own cursor error; report the last
    // successfully observed cursor instead.
  }
  return null;
}

function buildStatus(
  spool: InboxSpool,
  counters: SupervisorCounters,
  token: string,
  now: () => Date,
): SupervisorStatusV1 {
  const events = listEvents(spool);
  const consumers = registeredConsumers(spool).map((id) => {
    const acked = acknowledgedSeq(spool, id);
    const pending = events.reduce((count, event) => (event.seq > acked ? count + 1 : count), 0);
    return { id: redact(id, token), acked_seq: acked, pending };
  });
  const pendingEvents = events.filter((event) =>
    consumers.some((consumer) => event.seq > consumer.acked_seq),
  );
  const oldest = pendingEvents[0];
  const usage = spoolUsage(spool);
  return {
    version: SUPERVISOR_VERSION,
    project_id: spool.projectId,
    state: counters.state,
    pid: process.pid,
    started_at: counters.startedAt,
    updated_at: now().toISOString(),
    last_success_at: counters.lastSuccessAt,
    last_error: counters.lastError,
    degraded: counters.state === "degraded",
    degraded_reason: counters.degradedReason,
    stop_reason: counters.stopReason,
    passes: counters.passes,
    processed_total: counters.processedTotal,
    after_seq: counters.afterSeq,
    consumers,
    backlog: { events: usage.events, bytes: usage.bytes },
    lag: {
      pending_events:
        consumers.length === 0
          ? 0
          : Math.max(...consumers.map((consumer) => consumer.pending)),
      oldest_pending_age_ms:
        oldest === undefined
          ? null
          : Math.max(0, now().getTime() - Date.parse(oldest.queued_at)),
    },
    limits: { max_events: spool.maxEvents, max_bytes: spool.maxBytes },
  };
}

function parseStatus(text: string, projectId: string): SupervisorStatusV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InboxError(3, "INBOX_CORRUPT", "supervisor status is not valid JSON");
  }
  const states = new Set(["starting", "running", "degraded", "stopped", "failed"]);
  if (
    !isRecord(parsed) ||
    parsed.version !== SUPERVISOR_VERSION ||
    parsed.project_id !== projectId ||
    typeof parsed.state !== "string" ||
    !states.has(parsed.state) ||
    !isSafeInteger(parsed.pid, 1) ||
    !isTimestamp(parsed.started_at) ||
    !isTimestamp(parsed.updated_at) ||
    !(parsed.last_success_at === null || isTimestamp(parsed.last_success_at)) ||
    !(parsed.last_error === null || (typeof parsed.last_error === "string" && ERROR_CODE.test(parsed.last_error))) ||
    typeof parsed.degraded !== "boolean" ||
    !(parsed.degraded_reason === null || (typeof parsed.degraded_reason === "string" && ERROR_CODE.test(parsed.degraded_reason))) ||
    !(parsed.stop_reason === null ||
      parsed.stop_reason === "signal" ||
      parsed.stop_reason === "once" ||
      parsed.stop_reason === "lock-lost") ||
    !isSafeInteger(parsed.passes, 0) ||
    !isSafeInteger(parsed.processed_total, 0) ||
    !isSafeInteger(parsed.after_seq, 0) ||
    !Array.isArray(parsed.consumers) ||
    !isRecord(parsed.backlog) ||
    !isSafeInteger(parsed.backlog.events, 0) ||
    !isSafeInteger(parsed.backlog.bytes, 0) ||
    !isRecord(parsed.lag) ||
    !isSafeInteger(parsed.lag.pending_events, 0) ||
    !(parsed.lag.oldest_pending_age_ms === null || isSafeInteger(parsed.lag.oldest_pending_age_ms, 0)) ||
    !isRecord(parsed.limits) ||
    !isSafeInteger(parsed.limits.max_events, 1) ||
    !isSafeInteger(parsed.limits.max_bytes, 1)
  ) {
    throw new InboxError(3, "INBOX_CORRUPT", "supervisor status is malformed");
  }
  const consumers: SupervisorConsumerStatus[] = [];
  for (const entry of parsed.consumers) {
    if (
      !isRecord(entry) ||
      typeof entry.id !== "string" ||
      entry.id === "" ||
      !isSafeInteger(entry.acked_seq, 0) ||
      !isSafeInteger(entry.pending, 0)
    ) {
      throw new InboxError(3, "INBOX_CORRUPT", "supervisor status consumer is malformed");
    }
    consumers.push({ id: entry.id, acked_seq: entry.acked_seq, pending: entry.pending });
  }
  return {
    version: SUPERVISOR_VERSION,
    project_id: projectId,
    state: parsed.state as SupervisorState,
    pid: parsed.pid,
    started_at: parsed.started_at,
    updated_at: parsed.updated_at,
    last_success_at: parsed.last_success_at,
    last_error: parsed.last_error,
    degraded: parsed.degraded,
    degraded_reason: parsed.degraded_reason,
    stop_reason: parsed.stop_reason,
    passes: parsed.passes,
    processed_total: parsed.processed_total,
    after_seq: parsed.after_seq,
    consumers,
    backlog: { events: parsed.backlog.events, bytes: parsed.backlog.bytes },
    lag: {
      pending_events: parsed.lag.pending_events,
      oldest_pending_age_ms: parsed.lag.oldest_pending_age_ms,
    },
    limits: {
      max_events: parsed.limits.max_events,
      max_bytes: parsed.limits.max_bytes,
    },
  };
}

export function readSupervisorStatus(spool: InboxSpool): SupervisorStatusV1 | null {
  const text = readPrivateText(
    join(spool.root, SUPERVISOR_STATUS_FILE),
    "INBOX_CORRUPT",
    "supervisor status",
  );
  if (text === null) return null;
  return parseStatus(text, spool.projectId);
}

function writeSupervisorStatus(
  spool: InboxSpool,
  counters: SupervisorCounters,
  token: string,
  now: () => Date,
): SupervisorStatusV1 {
  const status = buildStatus(spool, counters, token, now);
  writePrivateJson(spool.root, SUPERVISOR_STATUS_FILE, status);
  return status;
}

// ---------------------------------------------------------------- run loop

function classifySupervisorError(error: unknown): {
  code: string;
  exitCode: number;
  fatal: boolean;
} {
  if (error instanceof InboxError) {
    return { code: error.code, exitCode: error.exitCode, fatal: error.exitCode !== 1 };
  }
  if (error instanceof PollError) {
    return { code: error.code, exitCode: error.exitCode, fatal: error.exitCode !== 1 };
  }
  // A raw cursor-write filesystem error and unexpected local failures are
  // retried; durable replay is safe because the cursor did not advance.
  return { code: "SUPERVISOR_RETRY", exitCode: 1, fatal: false };
}

// The canonical lock is the ownership proof. If another process replaced it
// (a stale reclaimer moved and restored it, or an unsupported actor wrote it),
// this process stops at the next pass boundary instead of polling alongside it.
// A reclaimer's rename window can make the lock briefly absent, so re-read with
// a short jitter before declaring it lost.
function ownsCanonicalLock(spool: InboxSpool, instance: string): boolean {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const inspection = inspectSupervisorLock(spool);
    if (inspection.state === "live" && inspection.record?.instance === instance) {
      return true;
    }
    if (attempt < 3) sleepSync(10);
  }
  return false;
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function retryDelay(failures: number, options: SupervisorOptions): number {
  const base = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const max = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const exponent = Math.min(Math.max(failures - 1, 0), 16);
  const capped = Math.min(max, base * 2 ** exponent);
  return Math.floor(capped * (1 + Math.random() * 0.2));
}

export async function runSupervisor(options: SupervisorOptions): Promise<SupervisorResult> {
  if (options.consumerIds.length === 0) {
    throw new InboxError(2, "INBOX_CONFIG", "at least one consumer is required");
  }
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? sleepWithSignal;
  // Bootstrap without sweeping: a concurrent start must not clear another
  // live supervisor's temp files before it fails closed on the lock.
  const spool = prepareSpool(options.spoolDir, options.projectId, {
    plaintext: options.plaintext === true,
    maxEvents: options.maxEvents,
    maxBytes: options.maxBytes,
    maxEventBytes: options.maxEventBytes,
    retentionMs: options.retentionMs,
    repoRoot: options.repoRoot,
    now,
    sweep: false,
  });
  const lock = acquireSupervisorLock(spool, { baseUrl: options.baseUrl, now });
  const startedAt = now().toISOString();
  let passes = 0;
  let processedTotal = 0;
  let afterSeq = readCursorAfterSeq(spool, options.baseUrl) ?? 0;
  let lastSuccessAt: string | null = null;
  let lastError: string | null = null;
  let degradedReason: string | null = null;
  let failureStreak = 0;
  let lastStatus: SupervisorStatusV1 | null = null;

  const write = (state: SupervisorState, stopReason: string | null): void => {
    try {
      lastStatus = writeSupervisorStatus(
        spool,
        {
          state,
          startedAt,
          lastSuccessAt,
          lastError,
          degradedReason,
          stopReason,
          passes,
          processedTotal,
          afterSeq,
        },
        options.token,
        now,
      );
    } catch {
      // Status is operational metadata. A failed write (for example a full
      // disk) must not acknowledge data or mask the poller's own failure; the
      // next attempt or the operator's `status` observes the gap.
    }
  };

  write("starting", null);
  try {
    for (;;) {
      if (options.signal?.aborted) {
        write("stopped", "signal");
        return {
          state: "stopped",
          exitCode: 0,
          passes,
          processed: processedTotal,
          afterSeq,
          status: lastStatus,
        };
      }
      if (!ownsCanonicalLock(spool, lock.record.instance)) {
        const cursor = readCursorAfterSeq(spool, options.baseUrl);
        if (cursor !== null) afterSeq = cursor;
        lastError = "LOCK_LOST";
        degradedReason = null;
        write("stopped", "lock-lost");
        return {
          state: "stopped",
          exitCode: 0,
          passes,
          processed: processedTotal,
          afterSeq,
          status: lastStatus,
        };
      }
      try {
        const result = await runInbox({ ...options, once: true });
        passes += 1;
        processedTotal += result.processed;
        afterSeq = result.afterSeq;
        failureStreak = 0;
        lastError = null;
        degradedReason = null;
        if (result.stopped) {
          write("stopped", "signal");
          return {
            state: "stopped",
            exitCode: 0,
            passes,
            processed: processedTotal,
            afterSeq,
            status: lastStatus,
          };
        }
        lastSuccessAt = now().toISOString();
        write("running", null);
        if (options.once === true) {
          write("stopped", "once");
          return {
            state: "stopped",
            exitCode: 0,
            passes,
            processed: processedTotal,
            afterSeq,
            status: lastStatus,
          };
        }
        await sleep(options.intervalMs ?? DEFAULT_INTERVAL_MS, options.signal);
      } catch (error) {
        if (options.signal?.aborted) {
          // fetchIdentity runs before pollPass's STOPPED handling. A stop there
          // (or during a cursor write) is a clean stop after durable state, not
          // a fatal PollError exit 0.
          const cursor = readCursorAfterSeq(spool, options.baseUrl);
          if (cursor !== null) afterSeq = cursor;
          write("stopped", "signal");
          return {
            state: "stopped",
            exitCode: 0,
            passes,
            processed: processedTotal,
            afterSeq,
            status: lastStatus,
          };
        }
        passes += 1;
        const failure = classifySupervisorError(error);
        lastError = failure.code;
        const cursor = readCursorAfterSeq(spool, options.baseUrl);
        if (cursor !== null) afterSeq = cursor;
        if (failure.fatal) {
          degradedReason = null;
          write("failed", null);
          return {
            state: "failed",
            exitCode: failure.exitCode,
            passes,
            processed: processedTotal,
            afterSeq,
            status: lastStatus,
          };
        }
        degradedReason = failure.code;
        write("degraded", null);
        if (options.once === true) {
          return {
            state: "degraded",
            exitCode: failure.exitCode,
            passes,
            processed: processedTotal,
            afterSeq,
            status: lastStatus,
          };
        }
        failureStreak += 1;
        await sleep(retryDelay(failureStreak, options), options.signal);
      }
    }
  } finally {
    lock.release();
  }
}
