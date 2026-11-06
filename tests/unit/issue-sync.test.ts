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
  const since = query.get("since");
  const sinceMs = since === null ? null : Date.parse(since);
  const all = comments[issue] ?? [];
  const selected = (sinceMs === null ? all : all.filter((comment) => Date.parse(comment.updated_at) > sinceMs))
    .slice()
    .sort((a, b) => a.id - b.id);
  out(JSON.stringify(selected.slice((page - 1) * perPage, page * perPage)));
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
    "repos/owner/repo/issues/9/comments?per_page=100&page=1",
  ]);
  assert.equal(calls.length, 4);
  // The issue-comments endpoint documents only since/per_page/page.
  for (const call of calls.filter((entry) => (entry[1] ?? "").includes("/comments?"))) {
    assert.equal(call.join(" ").includes("sort="), false);
    assert.equal(call.join(" ").includes("direction="), false);
  }
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

function restComment(id: number, updatedAt: string, body = "synthetic non-secret body") {
  return {
    id,
    user: { login: "maintainer" },
    created_at: updatedAt,
    updated_at: updatedAt,
    body,
  };
}

function digestLine(issue: number, comment: ReturnType<typeof restComment>): string {
  return JSON.stringify({
    issue,
    commentId: comment.id,
    author: comment.user.login,
    createdAt: comment.created_at,
    updatedAt: comment.updated_at,
    body: comment.body,
  });
}

function commentQueries(log: string): string[] {
  return readGhLog(log)
    .filter((call) => call[0] === "api" && (call[1] ?? "").includes("/comments?"))
    .map((call) => call[1] as string);
}

function assertNoUnsupportedCommentParams(log: string): void {
  for (const query of commentQueries(log)) {
    assert.equal(query.includes("sort="), false, query);
    assert.equal(query.includes("direction="), false, query);
  }
}

function seedState(
  home: string,
  comments: ReturnType<typeof restComment>[],
  lastCommentUpdatedAt: string,
): string {
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  writeCursor(join(stateDir, "cursor.json"), {
    ...initialSyncState("maintainer", "owner/repo"),
    lastRunAt: "2026-01-01T00:00:00Z",
    totalIngested: comments.length,
    issues: {
      "9": {
        issueUpdatedAt: lastCommentUpdatedAt,
        lastCommentUpdatedAt,
        ingested: comments.length,
      },
    },
  });
  writeFileSync(
    join(stateDir, "digest.jsonl"),
    `${comments.map((comment) => digestLine(9, comment)).join("\n")}\n`,
  );
  return stateDir;
}

test("a new comment on a 501-comment issue is ingested once via the since window", () => {
  const existing = Array.from({ length: 501 }, (_, index) =>
    restComment(
      1000 + index,
      `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    ),
  );
  const appended = restComment(2000, "2026-01-01T01:00:00Z");
  const lastExisting = existing[existing.length - 1]?.updated_at;
  assert.ok(lastExisting !== undefined);

  const fake = installFakeGh({
    issues: [{ number: 9, title: "issue nine", updated_at: "2026-01-02T00:00:00Z", comments: 502 }],
    comments: { 9: [...existing, appended] },
  });
  const home = join(root, "since-home");
  const stateDir = seedState(home, existing, lastExisting);
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const firstQueries = commentQueries(fake.log);
  assert.equal(firstQueries.length, 1);
  assert.equal(firstQueries[0]?.includes("since="), true);
  assert.equal(firstQueries[0]?.includes("page=1"), true);
  assertNoUnsupportedCommentParams(fake.log);

  const digest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(digest.length, 502);
  assert.equal(digest.filter((line) => JSON.parse(line).commentId === 2000).length, 1);
  const cursor = JSON.parse(readFileSync(join(stateDir, "cursor.json"), "utf8"));
  assert.equal(cursor.issues["9"].lastCommentUpdatedAt, appended.updated_at);

  assert.equal(main(env), 0);
  const digestAfterRetry = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(digestAfterRetry.length, 502);
  assert.equal(digestAfterRetry.filter((line) => JSON.parse(line).commentId === 2000).length, 1);
  assert.match(
    readFileSync(join(stateDir, "issue-sync.log"), "utf8"),
    /ingested=0 duplicates=1 total=502/,
  );
  assertNoUnsupportedCommentParams(fake.log);
});

test("an edited older comment is ingested once and not duplicated on the next run", () => {
  const original = restComment(1001, "2026-01-01T00:00:00Z", "original body");
  const untouched = restComment(1002, "2026-01-09T00:00:00Z");
  const edited = { ...original, updated_at: "2026-01-11T00:00:00Z", body: "edited body" };

  const fake = installFakeGh({
    issues: [{ number: 9, title: "issue nine", updated_at: "2026-01-11T00:00:00Z", comments: 2 }],
    comments: { 9: [edited, untouched] },
  });
  const home = join(root, "edit-home");
  const stateDir = seedState(home, [original, untouched], "2026-01-10T00:00:00Z");
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const firstDigest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(firstDigest.length, 3);
  assert.equal(
    firstDigest.filter((line) => {
      const record = JSON.parse(line);
      return record.commentId === 1001 && record.updatedAt === edited.updated_at;
    }).length,
    1,
  );
  assertNoUnsupportedCommentParams(fake.log);

  assert.equal(main(env), 0);
  const secondDigest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(secondDigest.length, 3);
  assert.equal(
    secondDigest.filter((line) => {
      const record = JSON.parse(line);
      return record.commentId === 1001 && record.updatedAt === edited.updated_at;
    }).length,
    1,
  );
  assert.match(
    readFileSync(join(stateDir, "issue-sync.log"), "utf8"),
    /ingested=0 duplicates=1 total=3/,
  );
  assertNoUnsupportedCommentParams(fake.log);
});

test("a first-sight issue that hits the page cap exits 6 without a cursor", () => {
  const existing = Array.from({ length: 501 }, (_, index) =>
    restComment(
      1000 + index,
      `2026-01-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}Z`,
    ),
  );
  const complete = [restComment(2001, "2026-01-01T00:00:00Z"), restComment(2002, "2026-01-01T00:00:01Z")];
  const fake = installFakeGh({
    issues: [
      { number: 9, title: "issue nine", updated_at: "2026-01-02T00:00:00Z", comments: 501 },
      { number: 10, title: "issue ten", updated_at: "2026-01-02T00:00:00Z", comments: 2 },
    ],
    comments: { 9: existing, 10: complete },
  });
  const home = join(root, "incomplete-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 6);
  assert.equal(existsSync(join(stateDir, "cursor.json")), false);
  const log = readFileSync(join(stateDir, "issue-sync.log"), "utf8");
  assert.match(log, /status=incomplete issues=9/);
  assert.equal(log.includes("status=ok"), false);

  // The incomplete issue's fetched pages must not seed the digest; the complete
  // issue's records in the same pass still do.
  const digest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n").map(
    (line) => JSON.parse(line) as { issue: number },
  );
  assert.deepEqual(digest.map((record) => record.issue), [10, 10]);

  const queries = commentQueries(fake.log);
  const issue9 = queries.filter((query) => query.startsWith("repos/owner/repo/issues/9/comments?"));
  const issue10 = queries.filter((query) => query.startsWith("repos/owner/repo/issues/10/comments?"));
  assert.deepEqual(
    issue9.map((query) => new URLSearchParams(query.split("?")[1]).get("page")),
    ["1", "2", "3", "4", "5"],
  );
  assert.deepEqual(
    issue10.map((query) => new URLSearchParams(query.split("?")[1]).get("page")),
    ["1"],
  );
  assert.equal(issue9[0]?.includes("since="), false);
  assert.equal(issue10[0]?.includes("since="), false);
  assertNoUnsupportedCommentParams(fake.log);
});

test("an absent digest ignores a stale cursor since and re-ingests history", () => {
  const comments = [
    restComment(1001, "2026-01-01T00:00:00Z"),
    restComment(1002, "2026-01-02T00:00:00Z"),
  ];
  const fake = installFakeGh({
    issues: [{ number: 9, title: "issue nine", updated_at: "2026-01-10T00:00:00Z", comments: 2 }],
    comments: { 9: comments },
  });
  const home = join(root, "no-digest-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  writeCursor(join(stateDir, "cursor.json"), {
    ...initialSyncState("maintainer", "owner/repo"),
    lastRunAt: "2026-01-09T00:00:00Z",
    totalIngested: 2,
    issues: {
      "9": {
        issueUpdatedAt: "2026-01-09T00:00:00Z",
        lastCommentUpdatedAt: "2026-01-10T00:00:00Z",
        ingested: 2,
      },
    },
  });
  assert.equal(existsSync(join(stateDir, "digest.jsonl")), false);
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const queries = commentQueries(fake.log);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.includes("since="), false);
  assertNoUnsupportedCommentParams(fake.log);

  const digest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(digest.length, 2);
  const cursor = JSON.parse(readFileSync(join(stateDir, "cursor.json"), "utf8"));
  assert.equal(cursor.issues["9"].ingested, 2);
  assert.equal(cursor.issues["9"].lastCommentUpdatedAt, "2026-01-02T00:00:00Z");
});

test("an empty digest file ignores a stale cursor since and re-ingests history", () => {
  const comments = [
    restComment(1001, "2026-01-01T00:00:00Z"),
    restComment(1002, "2026-01-02T00:00:00Z"),
  ];
  const fake = installFakeGh({
    issues: [{ number: 9, title: "issue nine", updated_at: "2026-01-10T00:00:00Z", comments: 2 }],
    comments: { 9: comments },
  });
  const home = join(root, "empty-digest-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  writeCursor(join(stateDir, "cursor.json"), {
    ...initialSyncState("maintainer", "owner/repo"),
    lastRunAt: "2026-01-09T00:00:00Z",
    totalIngested: 2,
    issues: {
      "9": {
        issueUpdatedAt: "2026-01-09T00:00:00Z",
        lastCommentUpdatedAt: "2026-01-10T00:00:00Z",
        ingested: 2,
      },
    },
  });
  writeFileSync(join(stateDir, "digest.jsonl"), "");
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const queries = commentQueries(fake.log);
  assert.equal(queries.length, 1);
  assert.equal(queries[0]?.includes("since="), false);
  assertNoUnsupportedCommentParams(fake.log);

  const digest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n");
  assert.equal(digest.length, 2);
  const cursor = JSON.parse(readFileSync(join(stateDir, "cursor.json"), "utf8"));
  assert.equal(cursor.issues["9"].ingested, 2);
  assert.equal(cursor.issues["9"].lastCommentUpdatedAt, "2026-01-02T00:00:00Z");
});

test("an issue with no digest record is first sight even when another issue has records", () => {
  const nineComment = restComment(1001, "2026-01-02T00:00:00Z");
  const tenComment = restComment(2001, "2026-01-01T00:00:00Z");
  const fake = installFakeGh({
    issues: [
      { number: 9, title: "issue nine", updated_at: "2026-01-10T00:00:00Z", comments: 1 },
      { number: 10, title: "issue ten", updated_at: "2026-01-10T00:00:00Z", comments: 1 },
    ],
    comments: { 9: [nineComment], 10: [tenComment] },
  });
  const home = join(root, "per-issue-first-sight-home");
  const stateDir = join(home, ".local", "state", "corkboard-issue-sync");
  mkdirSync(stateDir, { recursive: true });
  writeCursor(join(stateDir, "cursor.json"), {
    ...initialSyncState("maintainer", "owner/repo"),
    lastRunAt: "2026-01-09T00:00:00Z",
    totalIngested: 1,
    issues: {
      "9": {
        issueUpdatedAt: "2026-01-09T00:00:00Z",
        lastCommentUpdatedAt: "2026-01-10T00:00:00Z",
        ingested: 1,
      },
      "10": {
        issueUpdatedAt: "2026-01-09T00:00:00Z",
        lastCommentUpdatedAt: "2026-01-10T00:00:00Z",
        ingested: 1,
      },
    },
  });
  writeFileSync(join(stateDir, "digest.jsonl"), `${digestLine(9, nineComment)}\n`);
  const env = {
    HOME: home,
    CORKBOARD_GH_BIN: fake.bin,
    CORKBOARD_ISSUE_SYNC_ACCOUNT: "maintainer",
  };

  assert.equal(main(env), 0);
  const queries = commentQueries(fake.log);
  const issue9 = queries.find((query) =>
    query.startsWith("repos/owner/repo/issues/9/comments?"),
  );
  const issue10 = queries.find((query) =>
    query.startsWith("repos/owner/repo/issues/10/comments?"),
  );
  assert.ok(issue9 !== undefined && issue10 !== undefined);
  assert.equal(issue9.includes("since="), true);
  assert.equal(issue10.includes("since="), false);
  assertNoUnsupportedCommentParams(fake.log);

  const digest = readFileSync(join(stateDir, "digest.jsonl"), "utf8").trim().split("\n").map(
    (line) => JSON.parse(line) as { issue: number; commentId: number },
  );
  assert.deepEqual(digest.map((record) => record.issue), [9, 10]);
  assert.equal(digest.some((record) => record.commentId === 2001), true);
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
