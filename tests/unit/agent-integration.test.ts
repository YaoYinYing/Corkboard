import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  AgentConfigError,
  requireApiKey,
  safeErrorMessage,
} from "../../examples/agent-integration/lib.ts";
import { main as sendMain } from "../../examples/agent-integration/send.ts";
import {
  REPO_ROOT,
  prepareInbox,
  writeInbox,
} from "../../examples/agent-integration/poll-consume.ts";
import { findSecrets } from "../../scripts/secret-scan.ts";
import type { PollMessage } from "../../scripts/poll.ts";

const EXAMPLE_ROOT = fileURLToPath(
  new URL("../../examples/agent-integration/", import.meta.url),
);

function exampleFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...exampleFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

// A literal after "Bearer " is a committed credential even if it does not match
// one of the scanner's vendor patterns.
const BEARER_LITERAL = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/;

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "corkboard-agent-example-"));
}

test("example files contain no credential-shaped literal", () => {
  const files = exampleFiles(EXAMPLE_ROOT);
  assert.ok(files.length > 0, "example directory is not empty");
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    assert.deepEqual(findSecrets(text), [], `${path} contains a credential-shaped literal`);
    assert.doesNotMatch(text, BEARER_LITERAL, `${path} contains a literal bearer value`);
  }
});

test("the credential helper reads only the environment and redacts on error", () => {
  const secret = `cb_${"a".repeat(43)}`;

  assert.equal(requireApiKey({ CORKBOARD_APIKEY: ` ${secret}\n` }), secret);
  const rejected: Array<Record<string, string>> = [
    {},
    { CORKBOARD_APIKEY: "" },
    { CORKBOARD_APIKEY: "   " },
    { CORKBOARD_APIKEY: "two values" },
    { CORKBOARD_APIKEY: `tab\tinside` },
  ];
  for (const env of rejected) {
    assert.throws(
      () => requireApiKey(env),
      (error: unknown) =>
        error instanceof AgentConfigError &&
        error.message.includes("CORKBOARD_APIKEY") &&
        !error.message.includes(secret) &&
        !error.message.includes("two values"),
    );
  }

  const rendered = safeErrorMessage(
    new AgentConfigError(`request failed with ${secret}`),
    secret,
  );
  assert.ok(!rendered.includes(secret), "the credential is not rendered");
  assert.ok(rendered.includes("[REDACTED]"), "the credential is redacted");
  // A raw transport/library error must never be surfaced.
  assert.equal(
    safeErrorMessage(new TypeError(`fetch failed after ${secret}`), secret),
    "unexpected failure",
  );
});

test("the consume example reuses the reference poller", () => {
  const source = readFileSync(join(EXAMPLE_ROOT, "poll-consume.ts"), "utf8");
  assert.match(source, /from "\.\.\/\.\.\/scripts\/poll\.ts"/);
  assert.match(source, /onMessage/);
  // The wrapper must not grow its own list URL or receipt endpoint.
  assert.doesNotMatch(source, /\/messages\?/);
  assert.doesNotMatch(source, /\/read/);
});

test("inbox persistence redacts every field and never loses a failed write", () => {
  const dir = tempDir();
  try {
    const secret = `cb_${"b".repeat(43)}`;
    const message: PollMessage = {
      messageId: `msg_${secret}`,
      projectId: "proj_1",
      seq: 1,
      senderId: `spk_${secret}`,
      summary: `summary ${secret}`,
      bodyState: "ready",
    };
    const target = writeInbox(dir, message, `body ${secret}`, secret);
    const content = readFileSync(target, "utf8");
    assert.ok(!content.includes(secret), "the credential cannot reach the inbox file");
    assert.deepEqual(findSecrets(content), [], "no credential-shaped value is persisted");
    assert.ok(content.includes("[REDACTED]"));

    // An existing complete target is not overwritten by an at-least-once replay.
    writeInbox(dir, message, "replacement body", secret);
    assert.equal(readFileSync(target, "utf8"), content);

    // A partial temp file is never treated as delivered; the next pass writes a
    // complete target.
    const second: PollMessage = { ...message, messageId: "msg_2", seq: 2 };
    writeFileSync(join(dir, "2.json.tmp-stale"), "partial");
    const secondTarget = writeInbox(dir, second, "body 2", secret);
    assert.equal(JSON.parse(readFileSync(secondTarget, "utf8")).seq, 2);

    // A failed write throws, so the poller's callback fails and no receipt or
    // cursor advance can follow. No target appears.
    assert.throws(() => writeInbox(join(dir, "missing", "inbox"), second, "body", secret));
    assert.equal(existsSync(join(dir, "missing", "inbox", "2.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the inbox directory is private and must be outside the repository", () => {
  const root = tempDir();
  const outside = tempDir();
  try {
    const inside = join(root, "inbox");
    mkdirSync(inside);
    assert.throws(
      () => prepareInbox(inside, root),
      (error: unknown) =>
        error instanceof AgentConfigError && error.message.includes("outside the repository"),
    );

    mkdirSync(outside, { recursive: true });
    chmodSync(outside, 0o755);
    const resolved = prepareInbox(outside, root);
    assert.equal(statSync(resolved).mode & 0o777, 0o700);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the production repository root matches and the default home inbox is outside it", () => {
  // Independent computation: the test file is two levels below the repo root too.
  const testRepoRoot = fileURLToPath(new URL("../../", import.meta.url));
  assert.equal(realpathSync(REPO_ROOT), realpathSync(testRepoRoot));

  const rejected = join(
    REPO_ROOT,
    "examples",
    "agent-integration",
    `.test-inbox-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  assert.throws(
    () => prepareInbox(rejected, REPO_ROOT),
    (error: unknown) =>
      error instanceof AgentConfigError && error.message.includes("outside the repository"),
  );
  assert.equal(existsSync(rejected), false, "a rejected path creates nothing");

  const homeInbox = join(
    homedir(),
    ".local",
    "state",
    "corkboard",
    `agent-example-test-${process.pid}-${randomBytes(4).toString("hex")}`,
  );
  try {
    const resolved = prepareInbox(homeInbox, REPO_ROOT);
    assert.equal(realpathSync(homeInbox), resolved);
    assert.equal(statSync(homeInbox).mode & 0o777, 0o700);
  } finally {
    rmSync(homeInbox, { recursive: true, force: true });
  }
});

test("a symlinked inbox path is refused without following it", () => {
  const dir = tempDir();
  const target = join(dir, "target");
  const link = join(dir, "link");
  try {
    mkdirSync(target, { mode: 0o755 });
    chmodSync(target, 0o755);
    symlinkSync(target, link);
    assert.throws(
      () => prepareInbox(link, REPO_ROOT),
      (error: unknown) =>
        error instanceof AgentConfigError && error.message.includes("symbolic link"),
    );
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(statSync(target).mode & 0o777, 0o755, "chmod did not follow the symlink");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("send enforces the streamed response cap and redacts the credential", async () => {
  const secret = `cb_${"c".repeat(43)}`;
  let stdout = "";
  let stderr = "";
  const code = await sendMain(
    ["--summary", "summary", "--text", "text", "--idempotency-key", "key-1"],
    {
      CORKBOARD_APIKEY: secret,
      CORKBOARD_BASE_URL: "https://board.example",
      CORKBOARD_PROJECT_ID: "proj_1",
    },
    {
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2_048));
              controller.close();
            },
          }),
          { status: 201 },
        ),
      maxResponseBytes: 1_024,
      stdout: (line) => {
        stdout += line;
      },
      stderr: (line) => {
        stderr += line;
      },
    },
  );
  assert.equal(code, 3);
  assert.equal(stdout, "");
  assert.ok(!stderr.includes(secret));
  assert.match(stderr, /exceeded/);
});

test("send has a request/body deadline and does not surface a raw fetch error", async () => {
  const secret = `cb_${"d".repeat(43)}`;
  let stderr = "";
  const code = await sendMain(
    ["--summary", "summary", "--text", "text", "--idempotency-key", "key-1"],
    {
      CORKBOARD_APIKEY: secret,
      CORKBOARD_BASE_URL: "https://board.example",
      CORKBOARD_PROJECT_ID: "proj_1",
    },
    {
      fetchImpl: (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new TypeError(`aborted after ${secret}`)),
          );
        }),
      requestTimeoutMs: 10,
      stderr: (line) => {
        stderr += line;
      },
    },
  );
  assert.equal(code, 1);
  assert.match(stderr, /timed out/);
  assert.ok(!stderr.includes(secret));
});
