#!/usr/bin/env node
// One-shot, idempotent GitHub Issue/comment ingestion pass. Driven by the
// corkboard-issue-sync systemd user timer. Reads only; it never posts a reply.
// Issue/comment text is untrusted data: it is stored verbatim in the digest and
// is never executed, logged, or used to choose a command.
//
// Exactly-once key: (comment databaseId, updatedAt). The append-only digest is
// the source of truth for already-ingested keys, so a crash between the digest
// write and the cursor write cannot duplicate a record on the next pass.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const DEFAULT_ACCOUNT = "YaoYinYing";
export const DEFAULT_GH_BIN = "/usr/bin/gh";
export const STATE_DIR_NAME = "corkboard-issue-sync";
export const MAX_ISSUES = 50;
export const COMMENT_PAGE_SIZE = 100;
export const MAX_COMMENT_PAGES = 5;
// Re-read a small window before the stored cursor so a one-second-resolution
// updated_at cannot skip an edit; the digest key makes the overlap idempotent.
export const COMMENT_SINCE_OVERLAP_MS = 5_000;
export const MAX_GH_BUFFER = 32 << 20;
export const LOG_MAX_BYTES = 1 << 20;

export class StateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateError";
  }
}

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export class GhError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = "GhError";
    this.exitCode = exitCode;
  }
}

export interface SyncIssue {
  number: number;
  title: string;
  updatedAt: string;
  commentCount: number;
}

export interface CommentRecord {
  issue: number;
  commentId: number;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  body: string;
}

export interface IssueCursor {
  issueUpdatedAt: string;
  lastCommentUpdatedAt: string | null;
  ingested: number;
}

export interface SyncState {
  version: 1;
  account: string;
  repo: string;
  lastRunAt: string;
  issues: Record<string, IssueCursor>;
  totalIngested: number;
}

export interface StatePaths {
  dir: string;
  cursor: string;
  digest: string;
  lock: string;
  log: string;
}

export interface DigestLoad {
  text: string;
  records: CommentRecord[];
  keys: Set<string>;
}

export interface IngestionPlan {
  records: CommentRecord[];
  duplicates: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function commentKey(commentId: number, updatedAt: string): string {
  return `${commentId}#${updatedAt}`;
}

export function parseIssuesPayload(text: string): SyncIssue[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ParseError("gh api issues returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new ParseError("gh api issues did not return an array");
  const issues: SyncIssue[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) throw new ParseError("gh api issues entry is not an object");
    // The repository issues endpoint also returns pull requests; they are not Issues.
    if ("pull_request" in entry) continue;
    const number = entry.number;
    const title = entry.title;
    const updatedAt = entry.updated_at;
    const commentCount = entry.comments;
    if (!isNonNegativeInteger(number) || number === 0) {
      throw new ParseError("gh api issues entry has no valid number");
    }
    if (typeof title !== "string" || !isTimestamp(updatedAt) || !isNonNegativeInteger(commentCount)) {
      throw new ParseError("gh api issues entry is missing required fields");
    }
    issues.push({ number, title, updatedAt, commentCount });
  }
  return issues;
}

export function parseCommentsPayload(text: string, issue: number): CommentRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ParseError("gh api issue comments returned invalid JSON");
  }
  if (!Array.isArray(parsed)) throw new ParseError("gh api issue comments did not return an array");
  return parsed.map((entry) => {
    if (!isRecord(entry)) throw new ParseError("comment entry is not an object");
    const commentId = entry.id;
    const createdAt = entry.created_at;
    const updatedAt = entry.updated_at;
    if (!isNonNegativeInteger(commentId) || commentId === 0) {
      throw new ParseError("comment entry has no valid databaseId");
    }
    if (!isTimestamp(createdAt) || !isTimestamp(updatedAt) || typeof entry.body !== "string") {
      throw new ParseError("comment entry is missing required fields");
    }
    let author: string | null = null;
    if (entry.user !== null && entry.user !== undefined) {
      if (!isRecord(entry.user) || typeof entry.user.login !== "string") {
        throw new ParseError("comment entry has an invalid author");
      }
      author = entry.user.login;
    }
    return { issue, commentId, author, createdAt, updatedAt, body: entry.body };
  });
}

export function parseSyncState(text: string, account: string, repo: string): SyncState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new StateError("cursor is not valid JSON");
  }
  if (!isRecord(parsed)) throw new StateError("cursor is not an object");
  if (parsed.version !== 1) throw new StateError("cursor has an unsupported version");
  if (parsed.account !== account) throw new StateError("cursor belongs to a different account");
  if (parsed.repo !== repo) throw new StateError("cursor belongs to a different repository");
  if (!isTimestamp(parsed.lastRunAt) || !isNonNegativeInteger(parsed.totalIngested)) {
    throw new StateError("cursor is missing required fields");
  }
  if (!isRecord(parsed.issues)) throw new StateError("cursor issues field is invalid");
  const issues: Record<string, IssueCursor> = {};
  for (const [key, value] of Object.entries(parsed.issues)) {
    if (!/^\d+$/.test(key) || !isRecord(value)) throw new StateError("cursor issue entry is invalid");
    const issueUpdatedAt = value.issueUpdatedAt;
    const updated = value.lastCommentUpdatedAt;
    if (!isTimestamp(issueUpdatedAt) || !isNonNegativeInteger(value.ingested)) {
      throw new StateError("cursor issue entry is missing required fields");
    }
    if (updated !== null && !isTimestamp(updated)) {
      throw new StateError("cursor issue cursor is invalid");
    }
    issues[key] = { issueUpdatedAt, lastCommentUpdatedAt: updated, ingested: value.ingested };
  }
  return {
    version: 1,
    account,
    repo,
    lastRunAt: parsed.lastRunAt,
    issues,
    totalIngested: parsed.totalIngested,
  };
}

export function initialSyncState(account: string, repo: string): SyncState {
  return {
    version: 1,
    account,
    repo,
    lastRunAt: new Date(0).toISOString(),
    issues: {},
    totalIngested: 0,
  };
}

export function parseDigestRecord(line: string): CommentRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new StateError("digest contains a malformed line");
  }
  if (!isRecord(parsed)) throw new StateError("digest record is not an object");
  const issue = parsed.issue;
  const commentId = parsed.commentId;
  const updatedAt = parsed.updatedAt;
  if (
    !isNonNegativeInteger(issue) ||
    issue === 0 ||
    !isNonNegativeInteger(commentId) ||
    commentId === 0 ||
    !isTimestamp(parsed.createdAt) ||
    !isTimestamp(updatedAt) ||
    typeof parsed.body !== "string" ||
    (parsed.author !== null && typeof parsed.author !== "string")
  ) {
    throw new StateError("digest record is missing required fields");
  }
  return {
    issue,
    commentId,
    author: parsed.author,
    createdAt: parsed.createdAt,
    updatedAt,
    body: parsed.body,
  };
}

export function loadDigest(path: string): DigestLoad {
  assertNotSymlink(path, "digest");
  if (!existsSync(path)) return { text: "", records: [], keys: new Set() };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new StateError("digest is unreadable");
  }
  const records: CommentRecord[] = [];
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    const record = parseDigestRecord(line);
    records.push(record);
    keys.add(commentKey(record.commentId, record.updatedAt));
  }
  return { text, records, keys };
}

export function selectNewRecords(existing: Set<string>, incoming: CommentRecord[]): IngestionPlan {
  const records: CommentRecord[] = [];
  const pending = new Set<string>();
  let duplicates = 0;
  for (const record of incoming) {
    const key = commentKey(record.commentId, record.updatedAt);
    if (existing.has(key) || pending.has(key)) {
      duplicates += 1;
      continue;
    }
    pending.add(key);
    records.push(record);
  }
  records.sort((a, b) => {
    if (a.issue !== b.issue) return a.issue - b.issue;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    if (a.commentId !== b.commentId) return a.commentId - b.commentId;
    return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
  });
  return { records, duplicates };
}

export function resolveStatePaths(env: Record<string, string | undefined>): StatePaths {
  const xdg = env.XDG_STATE_HOME?.trim();
  const home = env.HOME?.trim() || homedir();
  const base = xdg && xdg.length > 0 ? xdg : join(home, ".local", "state");
  const dir = join(base, STATE_DIR_NAME);
  return {
    dir,
    cursor: join(dir, "cursor.json"),
    digest: join(dir, "digest.jsonl"),
    lock: join(dir, "lock"),
    log: join(dir, "issue-sync.log"),
  };
}

function lstatOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function assertNotSymlink(path: string, label: string): void {
  if (lstatOrNull(path)?.isSymbolicLink()) {
    throw new StateError(`${label} must not be a symbolic link`);
  }
}

export function ensureStateDir(dir: string): void {
  const existing = lstatOrNull(dir);
  if (existing !== null) {
    if (existing.isSymbolicLink()) {
      throw new StateError("state directory must not be a symbolic link");
    }
    if (!existing.isDirectory()) throw new StateError("state path is not a directory");
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
}

// Fail closed before any read or write can follow a link out of the state directory.
export function assertStatePathsSafe(paths: StatePaths): void {
  assertNotSymlink(paths.cursor, "cursor");
  assertNotSymlink(paths.digest, "digest");
  assertNotSymlink(paths.log, "log");
  assertNotSymlink(paths.lock, "lock");
}

export function atomicWriteFile(path: string, content: string, mode = 0o600): void {
  assertNotSymlink(path, "state file");
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    // Unlink the temp file on any failure, including a failed write/fsync.
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed or never created.
    }
    throw error;
  }
}

export function appendDigest(path: string, existingText: string, records: CommentRecord[]): void {
  if (records.length === 0) return;
  const prefix = existingText.length > 0 && !existingText.endsWith("\n") ? `${existingText}\n` : existingText;
  const appended = records.map((record) => JSON.stringify(record)).join("\n");
  atomicWriteFile(path, `${prefix}${appended}\n`);
}

export function writeCursor(path: string, state: SyncState): void {
  atomicWriteFile(path, `${JSON.stringify(state, null, 2)}\n`);
}

function readLockHolder(path: string): Record<string, unknown> {
  let holder: unknown;
  try {
    holder = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new LockError("lock file is malformed; remove it manually after checking for a running pass");
  }
  if (
    !isRecord(holder) ||
    !isNonNegativeInteger(holder.pid) ||
    holder.pid === 0 ||
    typeof holder.token !== "string" ||
    holder.token.length === 0
  ) {
    throw new LockError("lock file is malformed; remove it manually after checking for a running pass");
  }
  return holder;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireLock(path: string): () => void {
  assertNotSymlink(path, "lock");
  const token = randomBytes(16).toString("hex");
  const body = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token });
  const attempt = (): void => {
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  try {
    attempt();
  } catch {
    if (!existsSync(path)) throw new LockError("could not create lock file");
    const holder = readLockHolder(path);
    if (processAlive(holder.pid as number)) {
      throw new LockError(`another issue-sync pass is running (pid ${holder.pid})`);
    }
    // Move the inspected stale holder aside atomically before removing it. Another
    // process may replace the lock between the read and the rename, so reclaim only
    // when the renamed file still carries the token we inspected; never delete a
    // live holder.
    const reclaimed = `${path}.stale-${randomBytes(6).toString("hex")}`;
    try {
      renameSync(path, reclaimed);
    } catch {
      throw new LockError("could not reclaim the stale lock");
    }
    let moved: unknown;
    try {
      moved = JSON.parse(readFileSync(reclaimed, "utf8"));
    } catch {
      moved = null;
    }
    if (!isRecord(moved) || moved.token !== holder.token) {
      try {
        if (!existsSync(path)) renameSync(reclaimed, path);
      } catch {
        // Fail closed and leave the moved lock rather than delete a live holder.
      }
      throw new LockError("lock changed while reclaiming a stale holder");
    }
    try {
      unlinkSync(reclaimed);
    } catch {
      // The stale holder is already gone.
    }
    try {
      attempt();
    } catch {
      throw new LockError("another issue-sync pass acquired the lock");
    }
  }
  return () => {
    try {
      const holder: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isRecord(holder) && holder.token === token) unlinkSync(path);
    } catch {
      // Best effort: a missing or replaced lock is not ours to remove.
    }
  };
}

export function appendLog(path: string, message: string): void {
  const line = `${new Date().toISOString()} ${message}\n`;
  process.stderr.write(line);
  try {
    assertNotSymlink(path, "log");
    if (existsSync(path) && statSync(path).size >= LOG_MAX_BYTES) {
      assertNotSymlink(`${path}.1`, "rotated log");
      renameSync(path, `${path}.1`);
    }
    const fd = openSync(path, "a", 0o600);
    try {
      writeSync(fd, line);
    } finally {
      closeSync(fd);
    }
  } catch {
    process.stderr.write(`${new Date().toISOString()} warning: log file is unwritable\n`);
  }
}

function runGh(ghBin: string, args: string[]): string {
  try {
    return execFileSync(ghBin, args, {
      encoding: "utf8",
      maxBuffer: MAX_GH_BUFFER,
      timeout: 60_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const status = isRecord(error) && typeof error.status === "number" ? error.status : 1;
    // Never surface gh stderr: it may carry the environment or a credential.
    throw new GhError(`gh command failed (exit ${status})`, status);
  }
}

export function verifyAccount(ghBin: string, expected: string): string {
  const login = runGh(ghBin, ["api", "user", "--jq", ".login"]);
  if (login !== expected) {
    throw new GhError("authenticated gh account does not match the configured maintainer account", 2);
  }
  return login;
}

interface FetchResult {
  issues: SyncIssue[];
  comments: CommentRecord[];
  incompleteIssues: number[];
}

// GitHub documents only since/per_page/page for issue comments and returns
// ascending comment-id order; sort/direction are unsupported and must not be sent.
function commentSince(previous: IssueCursor | undefined): string | null {
  const last = previous?.lastCommentUpdatedAt;
  if (!last) return null;
  const since = new Date(Date.parse(last) - COMMENT_SINCE_OVERLAP_MS);
  return since.toISOString().replace(/\.\d{3}Z$/, "Z");
}

function fetchAll(
  ghBin: string,
  repo: string,
  cursors: Record<string, IssueCursor>,
  cursoredIssues: ReadonlySet<number>,
): FetchResult {
  // Discovery uses the REST issues endpoint so ordering is explicitly
  // updated-desc. It returns a numeric comment count, not comment bodies:
  // requesting bodies here would materialize every comment inside the gh buffer.
  const discovery =
    `repos/${repo}/issues` +
    `?state=all&sort=updated&direction=desc&per_page=${MAX_ISSUES}`;
  const issues = parseIssuesPayload(runGh(ghBin, ["api", discovery]));
  const comments: CommentRecord[] = [];
  const incompleteIssues: number[] = [];
  for (const issue of issues) {
    if (issue.commentCount === 0) continue;
    // Only an issue backed by digest records may use its cursor as a read bound.
    const since = cursoredIssues.has(issue.number)
      ? commentSince(cursors[String(issue.number)])
      : null;
    let covered = false;
    for (let page = 1; page <= MAX_COMMENT_PAGES; page += 1) {
      const query =
        `repos/${repo}/issues/${issue.number}/comments` +
        `?per_page=${COMMENT_PAGE_SIZE}&page=${page}` +
        (since === null ? "" : `&since=${encodeURIComponent(since)}`);
      const batch = parseCommentsPayload(runGh(ghBin, ["api", query]), issue.number);
      comments.push(...batch);
      if (batch.length < COMMENT_PAGE_SIZE) {
        covered = true;
        break;
      }
    }
    // A full final page at the cap cannot prove the range was covered.
    if (!covered) incompleteIssues.push(issue.number);
  }
  return { issues, comments, incompleteIssues };
}

export interface SyncSummary {
  repo: string;
  issues: number;
  comments: number;
  ingested: number;
  duplicates: number;
  totalIngested: number;
}

function stateFailure(logPath: string, message: string): number {
  appendLog(logPath, `status=state-error detail=${message}`);
  return 4;
}

export function main(env: Record<string, string | undefined> = process.env): number {
  const account = env.CORKBOARD_ISSUE_SYNC_ACCOUNT?.trim() || DEFAULT_ACCOUNT;
  const ghBin = env.CORKBOARD_GH_BIN?.trim() || DEFAULT_GH_BIN;
  try {
    accessSync(ghBin, fsConstants.X_OK);
  } catch {
    process.stderr.write(`${new Date().toISOString()} ERROR gh executable is not available\n`);
    return 2;
  }

  // Auth check precedes every state write, including directory creation.
  try {
    verifyAccount(ghBin, account);
  } catch {
    process.stderr.write(`${new Date().toISOString()} ERROR gh account verification failed\n`);
    return 2;
  }

  const paths = resolveStatePaths(env);
  try {
    ensureStateDir(paths.dir);
  } catch {
    process.stderr.write(`${new Date().toISOString()} ERROR state directory is not writable\n`);
    return 4;
  }

  try {
    assertStatePathsSafe(paths);
  } catch (error) {
    const message = error instanceof StateError ? error.message : "state paths are unsafe";
    return stateFailure(paths.log, message);
  }

  let release: (() => void) | undefined;
  try {
    release = acquireLock(paths.lock);
  } catch (error) {
    const message = error instanceof LockError ? error.message : "lock acquisition failed";
    appendLog(paths.log, `status=lock-failed detail=${message}`);
    return 5;
  }

  try {
    const repo = runGh(ghBin, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
      throw new ParseError("repository name could not be determined");
    }

    let state: SyncState;
    if (existsSync(paths.cursor)) {
      let text: string;
      try {
        text = readFileSync(paths.cursor, "utf8");
      } catch {
        throw new StateError("cursor is unreadable");
      }
      state = parseSyncState(text, account, repo);
    } else {
      state = initialSyncState(account, repo);
    }
    const digest = loadDigest(paths.digest);

    // The digest is the dedupe source of truth. Only an issue with at least one
    // digest record may be bounded by its cursor `since`; every other issue is
    // first sight, so deleting a corrupt digest (or an issue that had no records)
    // re-queues history instead of skipping it behind a stale window.
    const cursoredIssues = new Set(digest.records.map((record) => record.issue));
    const fetched = fetchAll(ghBin, repo, state.issues, cursoredIssues);
    // A partial page-cap read must not seed the digest: those records would make
    // the next pass trust a cursor for a range that was never fully covered.
    const incomplete = new Set(fetched.incompleteIssues);
    const covered = fetched.comments.filter((record) => !incomplete.has(record.issue));
    const plan = selectNewRecords(digest.keys, covered);
    appendDigest(paths.digest, digest.text, plan.records);

    // Keep complete issues' records, but do not advance the cursor or report
    // success while any issue's range is unproven.
    if (fetched.incompleteIssues.length > 0) {
      appendLog(paths.log, `status=incomplete issues=${fetched.incompleteIssues.join(",")}`);
      return 6;
    }

    const allRecords = [...digest.records, ...plan.records];
    const ingestedByIssue = new Map<number, number>();
    const lastCommentByIssue = new Map<number, string>();
    for (const record of allRecords) {
      ingestedByIssue.set(record.issue, (ingestedByIssue.get(record.issue) ?? 0) + 1);
      const previous = lastCommentByIssue.get(record.issue);
      if (previous === undefined || record.updatedAt > previous) {
        lastCommentByIssue.set(record.issue, record.updatedAt);
      }
    }
    const issues: Record<string, IssueCursor> = { ...state.issues };
    for (const issue of fetched.issues) {
      const key = String(issue.number);
      const previous = state.issues[key];
      issues[key] = {
        issueUpdatedAt: issue.updatedAt,
        lastCommentUpdatedAt:
          lastCommentByIssue.get(issue.number) ?? previous?.lastCommentUpdatedAt ?? null,
        ingested: ingestedByIssue.get(issue.number) ?? previous?.ingested ?? 0,
      };
    }
    const nextState: SyncState = {
      version: 1,
      account,
      repo,
      lastRunAt: new Date().toISOString(),
      issues,
      totalIngested: allRecords.length,
    };
    writeCursor(paths.cursor, nextState);

    const summary: SyncSummary = {
      repo,
      issues: fetched.issues.length,
      comments: fetched.comments.length,
      ingested: plan.records.length,
      duplicates: plan.duplicates,
      totalIngested: allRecords.length,
    };
    appendLog(
      paths.log,
      `status=ok repo=${summary.repo} issues=${summary.issues} comments=${summary.comments}` +
        ` ingested=${summary.ingested} duplicates=${summary.duplicates}` +
        ` total=${summary.totalIngested}`,
    );
    return 0;
  } catch (error) {
    if (error instanceof GhError) {
      appendLog(paths.log, `status=gh-error exit=${error.exitCode}`);
      return 2;
    }
    if (error instanceof ParseError) {
      appendLog(paths.log, `status=parse-error detail=${error.message}`);
      return 3;
    }
    if (error instanceof StateError) {
      return stateFailure(paths.log, error.message);
    }
    appendLog(paths.log, "status=unexpected-error");
    return 1;
  } finally {
    release();
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  process.exitCode = main();
}
