import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  GhError,
  LockError,
  ParseError,
  StateError,
  acquireLock,
  appendDigest,
  atomicWriteFile,
  commentKey,
  ensureStateDir,
  initialSyncState,
  loadDigest,
  main,
  parseCommentsPayload,
  parseDigestRecord,
  parseIssuesPayload,
  parseSyncState,
  resolveStatePaths,
  selectNewRecords,
  verifyAccount,
  writeCursor,
  type CommentRecord,
} from "../../scripts/issue-sync.ts";

const root = mkdtempSync(join(tmpdir(), "corkboard-issue-sync-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const base: CommentRecord = {
  issue: 9,
  commentId: 1001,
  author: "maintainer",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  body: "synthetic non-secret body",
};

test("a comment is ingested exactly once across repeat passes", () => {
  const first = selectNewRecords(new Set(), [base]);
  assert.equal(first.records.length, 1);
  assert.equal(first.duplicates, 0);

  const seen = new Set([commentKey(base.commentId, base.updatedAt)]);
  const second = selectNewRecords(seen, [base]);
  assert.equal(second.records.length, 0);
  assert.equal(second.duplicates, 1);
});

test("an edited comment is ingested once under its new updatedAt", () => {
  const seen = new Set([commentKey(base.commentId, base.updatedAt)]);
  const edited = { ...base, updatedAt: "2026-01-02T00:00:00Z", body: "edited body" };
  const plan = selectNewRecords(seen, [base, edited]);
  assert.deepEqual(
    plan.records.map((record) => record.updatedAt),
    ["2026-01-02T00:00:00Z"],
  );
  assert.equal(plan.duplicates, 1);

  const afterEdit = new Set([commentKey(edited.commentId, edited.updatedAt)]);
  assert.equal(selectNewRecords(afterEdit, [edited]).records.length, 0);
});

test("duplicates inside one fetched batch collapse to one record", () => {
  const plan = selectNewRecords(new Set(), [base, { ...base }]);
  assert.equal(plan.records.length, 1);
  assert.equal(plan.duplicates, 1);
});

test("the digest round-trips records and persists on disk", () => {
  const path = join(root, "digest-roundtrip.jsonl");
  appendDigest(path, "", [base]);
  const first = loadDigest(path);
  assert.equal(first.records.length, 1);
  assert.equal(first.keys.has(commentKey(base.commentId, base.updatedAt)), true);

  appendDigest(path, first.text, [{ ...base, commentId: 1002 }]);
  const second = loadDigest(path);
  assert.equal(second.records.length, 2);
  assert.match(readFileSync(path, "utf8"), /^\{/);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("a malformed digest fails closed", () => {
  const path = join(root, "digest-malformed.jsonl");
  atomicWriteFile(path, "{not-json}\n");
  assert.throws(() => loadDigest(path), StateError);
});

test("a failed atomic write removes its temporary file", () => {
  const target = join(root, "atomic-failed");
  assert.throws(() => atomicWriteFile(target, undefined as unknown as string));
  assert.deepEqual(
    readdirSync(root).filter((entry) => entry.startsWith("atomic-failed.tmp-")),
    [],
  );
});

test("a failed atomic rename removes its temporary file", () => {
  const target = join(root, "atomic-directory-target");
  mkdirSync(target);
  assert.throws(() => atomicWriteFile(target, "content"));
  assert.deepEqual(
    readdirSync(root).filter((entry) => entry.startsWith("atomic-directory-target.tmp-")),
    [],
  );
});

test("comment bodies stay data: JSONL escapes newlines and shell text", () => {
  const body = "line1\n$(touch /tmp/pwned) `id` ; rm -rf / ?";
  const line = JSON.stringify({ ...base, body });
  assert.equal(line.includes("\n"), false);
  assert.equal(parseDigestRecord(line).body, body);
});

interface FakeGhFixtures {
  login?: string;
  repo?: string;
  issues?: unknown[];
  comments?: Record<string, unknown[]>;
}

let fakeCount = 0;

function installFakeGh(fixtures: FakeGhFixtures = {}): { bin: string; log: string } {
  const id = `fake-gh-${fakeCount++}`;
  const bin = join(root, `${id}.sh`);
  const script = join(root, `${id}.cjs`);
  const log = join(root, `${id}.log.jsonl`);
  const login = fixtures.login ?? "maintainer";
  const repo = fixtures.repo ?? "owner/repo";
  const issues = fixtures.issues ?? [];
  const comments = fixtures.comments ?? {};
  const issuesQuery = `repos/${repo}/issues?state=all&sort=updated&direction=desc&per_page=50`;
  writeFileSync(
    script,
    `
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const login = ${JSON.stringify(login)};
const repo = ${JSON.stringify(repo)};
const issuesQuery = ${JSON.stringify(issuesQuery)};
const issues = ${JSON.stringify(issues)};
const comments = ${JSON.stringify(comments)};
const out = (value) => process.stdout.write(value + "\\n");
if (args[0] === "api" && args[1] === "user") { out(login); process.exit(0); }
if (args[0] === "repo" && args[1] === "view") { out(repo); process.exit(0); }
if (args[0] === "api" && args[1] === issuesQuery) { out(JSON.stringify(issues)); process.exit(0); }
const prefix = "repos/" + repo + "/issues/";
if (args[0] === "api" && typeof args[1] === "string" && args[1].startsWith(prefix) && args[1].includes("/comments?")) {
  const rest = args[1].slice(prefix.length);
  const issue = rest.slice(0, rest.indexOf("/comments?"));
  const query = new URLSearchParams(rest.split("?")[1]);
  const perPage = Number(query.get("per_page"));
  const page = Number(query.get("page") ?? "1");
  const all = comments[issue] ?? [];
  out(JSON.stringify(all.slice((page - 1) * perPage, page * perPage)));
  process.exit(0);
}
process.stderr.write("unexpected gh invocation\\n");
process.exit(1);
`,
    "utf8",
  );
  writeFileSync(
    bin,
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`,
    { mode: 0o755 },
  );
  return { bin, log };
}

function readGhLog(path: string): string[][] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as string[]);
}

test("the account check rejects a different authenticated account", () => {
  const matching = installFakeGh({ login: "maintainer" });
  assert.equal(verifyAccount(matching.bin, "maintainer"), "maintainer");
  const other = installFakeGh({ login: "someone-else" });
  assert.throws(() => verifyAccount(other.bin, "maintainer"), GhError);
});

test("a failed account check exits 2 before creating state", () => {
  const home = join(root, "auth-home");
  const fake = installFakeGh({ login: "someone-else" });
  const exit = main({
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  });
  assert.equal(exit, 2);
  assert.equal(existsSync(join(home, ".local", "state", "corkboard-issue-sync")), false);
});

test("a full pass uses updated-desc REST discovery, skips pull requests, and does not fetch bodies", () => {
  const fake = installFakeGh({
    issues: [
      { number: 9, title: "issue nine", updated_at: "2026-01-02T00:00:00Z", comments: 1 },
      { number: 10, title: "issue ten", updated_at: "2026-01-01T00:00:00Z", comments: 0 },
      {
        number: 11,
        title: "a pull request",
        updated_at: "2026-01-03T00:00:00Z",
        comments: 0,
        pull_request: { url: "https://example.test" },
      },
    ],
    comments: {
      9: [
        {
          id: 1001,
          user: { login: "maintainer" },
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T00:00:00Z",
          body: "synthetic non-secret body",
        },
      ],
    },
  });
  const home = join(root, "pass-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const calls = readGhLog(fake.log);
  assert.deepEqual(calls[0], ["api", "user", "--jq", ".login"]);
  assert.deepEqual(calls[1], [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]);
  assert.deepEqual(calls[2], [
    "api",
    "repos/owner/repo/issues?state=all&sort=updated&direction=desc&per_page=50",
  ]);
  assert.deepEqual(calls[3], [
    "api",
    "repos/owner/repo/issues/9/comments?per_page=100&page=1&sort=updated&direction=desc",
  ]);
  assert.equal(calls.length, 4);
  // The discovery call must not request or materialize comment bodies.
  assert.equal(calls[2].includes("comments"), false);
  assert.equal(calls[2].includes("--json"), false);

  const cursor = JSON.parse(readFileSync(join(stateDir, "cursor.json"), "utf8"));
  assert.deepEqual(Object.keys(cursor.issues), ["9", "10"]);
  assert.equal(cursor.totalIngested, 1);
  assert.equal(cursor.issues["9"].ingested, 1);
  assert.equal(cursor.issues["10"].ingested, 0);
  assert.equal(cursor.issues["11"], undefined);

  const digestLines = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(digestLines.length, 1);
  const digestLine = digestLines[0];
  assert.ok(digestLine !== undefined);
  assert.equal(JSON.parse(digestLine).commentId, 1001);

  const runLog = join(stateDir, "issue-sync.log");
  assert.match(
    readFileSync(runLog, "utf8"),
    /status=ok repo=owner\/repo issues=2 comments=1 ingested=1 duplicates=0 total=1/,
  );

  assert.equal(main(env), 0);
  assert.match(readFileSync(runLog, "utf8"), /ingested=0 duplicates=1 total=1/);
  assert.equal(readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("state failures are logged to the operational log", () => {
  const fake = installFakeGh();
  const home = join(root, "state-failure-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "cursor.json"), "{not-json}\n");

  const exit = main({
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  });
  assert.equal(exit, 4);
  assert.match(
    readFileSync(join(stateDir, "issue-sync.log"), "utf8"),
    /status=state-error detail=cursor is not valid JSON/,
  );
  assert.equal(existsSync(join(stateDir, "digest.jsonl")), false);
});

test("a symlinked state directory is rejected without writing through it", () => {
  const fake = installFakeGh();
  const home = join(root, "symlink-dir-home");
  const outside = join(root, "symlink-dir-outside");
  mkdirSync(outside, { recursive: true, mode: 0o700 });
  const stateParent = join(home, ".local", "state");
  mkdirSync(stateParent, { recursive: true });
  symlinkSync(outside, join(stateParent, "corkboard-issue-sync"), "dir");

  const exit = main({
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  });
  assert.equal(exit, 4);
  assert.deepEqual(readdirSync(outside), []);
});

test("a symlinked cursor is rejected without reading or writing through it", () => {
  const fake = installFakeGh();
  const home = join(root, "symlink-cursor-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  const outside = join(root, "symlink-cursor-outside.json");
  writeFileSync(outside, "sentinel");
  symlinkSync(outside, join(stateDir, "cursor.json"));

  const exit = main({
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  });
  assert.equal(exit, 4);
  assert.equal(readFileSync(outside, "utf8"), "sentinel");
  assert.equal(existsSync(join(stateDir, "digest.jsonl")), false);
  assert.match(
    readFileSync(join(stateDir, "issue-sync.log"), "utf8"),
    /status=state-error detail=cursor must not be a symbolic link/,
  );
});

test("a symlinked log is rejected without writing through it", () => {
  const fake = installFakeGh();
  const home = join(root, "symlink-log-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  const outside = join(root, "symlink-log-outside.log");
  writeFileSync(outside, "sentinel");
  symlinkSync(outside, join(stateDir, "issue-sync.log"));

  const exit = main({
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  });
  assert.equal(exit, 4);
  assert.equal(readFileSync(outside, "utf8"), "sentinel");
});

test("a malformed or foreign cursor fails closed", () => {
  assert.throws(() => parseSyncState("not-json", "maintainer", "owner/repo"), StateError);
  assert.throws(() => parseSyncState("{}", "maintainer", "owner/repo"), StateError);

  const state = initialSyncState("maintainer", "owner/repo");
  const text = JSON.stringify(state);
  assert.throws(() => parseSyncState(text, "other-account", "owner/repo"), StateError);
  assert.throws(() => parseSyncState(text, "maintainer", "owner/other"), StateError);
});

test("a cursor round-trips through an atomic 0600 write", () => {
  const path = join(root, "cursor.json");
  const state = {
    ...initialSyncState("maintainer", "owner/repo"),
    lastRunAt: "2026-01-02T00:00:00Z",
    totalIngested: 2,
    issues: {
      "9": {
        issueUpdatedAt: "2026-01-02T00:00:00Z",
        lastCommentUpdatedAt: "2026-01-02T00:00:00Z",
        ingested: 2,
      },
    },
  };
  writeCursor(path, state);
  assert.deepEqual(parseSyncState(readFileSync(path, "utf8"), "maintainer", "owner/repo"), state);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});

test("state directories are created 0700", () => {
  const dir = join(root, "state-dir");
  ensureStateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("issue and comment payloads reject malformed shapes", () => {
  assert.deepEqual(
    parseIssuesPayload(
      JSON.stringify([
        {
          number: 9,
          title: "t",
          updated_at: "2026-01-01T00:00:00Z",
          comments: 2,
        },
        {
          number: 12,
          title: "pr",
          updated_at: "2026-01-01T00:00:00Z",
          comments: 0,
          pull_request: { url: "https://example.test" },
        },
      ]),
    ),
    [{ number: 9, title: "t", updatedAt: "2026-01-01T00:00:00Z", commentCount: 2 }],
  );
  assert.throws(() => parseIssuesPayload("{}"), ParseError);
  assert.throws(
    () =>
      parseIssuesPayload(
        JSON.stringify([
          { number: 0, title: "t", updated_at: "2026-01-01T00:00:00Z", comments: 0 },
        ]),
      ),
    ParseError,
  );
  assert.throws(
    () =>
      parseIssuesPayload(
        JSON.stringify([{ number: 9, title: "t", updated_at: "x", comments: 0 }]),
      ),
    ParseError,
  );
  assert.throws(
    () =>
      parseIssuesPayload(
        JSON.stringify([
          { number: 9, title: "t", updated_at: "2026-01-01T00:00:00Z", comments: "2" },
        ]),
      ),
    ParseError,
  );

  const comment = {
    id: 1001,
    user: { login: "maintainer" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    body: "synthetic",
  };
  assert.deepEqual(parseCommentsPayload(JSON.stringify([comment]), 9), [
    { ...base, body: "synthetic" },
  ]);
  assert.throws(() => parseCommentsPayload("[]x", 9), ParseError);
  assert.throws(
    () => parseCommentsPayload(JSON.stringify([{ ...comment, body: null }]), 9),
    ParseError,
  );
  assert.throws(
    () => parseCommentsPayload(JSON.stringify([{ ...comment, user: { login: 5 } }]), 9),
    ParseError,
  );
});

test("the lock excludes a concurrent pass and is reacquirable", () => {
  const path = join(root, "sync.lock");
  const release = acquireLock(path);
  assert.throws(() => acquireLock(path), LockError);
  release();
  const releaseAgain = acquireLock(path);
  releaseAgain();
});

test("a stale lock from a dead process is reclaimed", () => {
  const path = join(root, "stale.lock");
  const dead = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(dead.pid !== undefined && dead.pid > 0);
  writeFileSync(
    path,
    JSON.stringify({ pid: dead.pid, startedAt: "2026-01-01T00:00:00Z", token: "stale-token" }),
    { mode: 0o600 },
  );

  const release = acquireLock(path);
  const holder = JSON.parse(readFileSync(path, "utf8")) as { token: string; pid: number };
  assert.notEqual(holder.token, "stale-token");
  assert.equal(holder.pid, process.pid);
  assert.deepEqual(
    readdirSync(root).filter((entry) => entry.startsWith("stale.lock.stale-")),
    [],
  );
  release();
  assert.equal(existsSync(path), false);
});

test("a live lock is never deleted during a failed acquisition", () => {
  const path = join(root, "live.lock");
  const release = acquireLock(path);
  const before = readFileSync(path, "utf8");
  assert.throws(() => acquireLock(path), LockError);
  assert.equal(readFileSync(path, "utf8"), before);
  release();
});

test("state paths follow XDG_STATE_HOME and fall back to HOME", () => {
  const xdg = resolveStatePaths({ XDG_STATE_HOME: "/tmp/xdg-state", HOME: "/tmp/home" });
  assert.equal(xdg.dir, "/tmp/xdg-state/corkboard-issue-sync");
  const fallback = resolveStatePaths({ HOME: "/tmp/home" });
  assert.equal(fallback.dir, "/tmp/home/.local/state/corkboard-issue-sync");
  assert.equal(fallback.digest, "/tmp/home/.local/state/corkboard-issue-sync/digest.jsonl");
});
