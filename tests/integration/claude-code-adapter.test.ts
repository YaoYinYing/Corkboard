import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  ackEvent,
  enqueueEvent,
  openSpool,
  prepareSpool,
  type InboxSpool,
} from "../../src/inbox/spool.ts";
import {
  consumerIdForSession,
  main,
  readState,
} from "../../scripts/claude-code-adapter.ts";

const SCRIPT = fileURLToPath(new URL("../../scripts/claude-code-adapter.ts", import.meta.url));
const PROJECT = "proj_test";
const TOKEN = "sk-canary-7f3a9";

interface Fixture {
  root: string;
  spool: InboxSpool;
  settingsPath: string;
  runtime: string;
}

function fixture(t: { after(fn: () => void): void }, plaintext = false): Fixture {
  const root = mkdtempSync(join(tmpdir(), "corkboard-cc-adapter-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const spool = prepareSpool(join(root, "spool"), PROJECT, { plaintext });
  const settingsDir = join(root, "project", ".claude");
  mkdirSync(settingsDir, { recursive: true, mode: 0o700 });
  const settingsPath = join(settingsDir, "settings.local.json");
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        permissions: { allow: ["Bash(ls)"] },
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "echo keep-me" }],
            },
          ],
        },
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  const runtime = join(root, "claude-fake");
  writeFileSync(runtime, '#!/bin/sh\necho "2.1.310 (Claude Code)"\n', { mode: 0o755 });
  chmodSync(runtime, 0o755);
  return { root, spool, settingsPath, runtime };
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], input = "", env: Record<string, string> = {}): RunResult {
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", SCRIPT, ...args],
    {
      input,
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, CORKBOARD_APIKEY: "", ...env },
    },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function hookInput(event: string, sessionId: string, source?: string): string {
  return JSON.stringify({
    session_id: sessionId,
    hook_event_name: event,
    cwd: "/tmp",
    ...(source === undefined ? {} : { source }),
  });
}

function enqueue(
  spool: InboxSpool,
  seq: number,
  summary: string,
  body: string | null = null,
): void {
  enqueueEvent(
    spool,
    {
      projectId: PROJECT,
      messageId: `msg_${seq}`,
      seq,
      senderId: "spk_synthetic_sender",
      summary,
      bodyState: "ready",
    },
    body,
    { token: TOKEN, now: () => new Date("2026-11-11T12:00:00.000Z") },
  );
}

function additionalContext(result: RunResult): string | null {
  if (result.stdout.trim() === "") return null;
  const parsed = JSON.parse(result.stdout) as {
    hookSpecificOutput?: { additionalContext?: string };
  };
  return parsed.hookSpecificOutput?.additionalContext ?? null;
}

test("install/uninstall/status preserve unrelated settings and never add permissions", (t) => {
  const fx = fixture(t);
  const install = run([
    "install",
    "--spool-dir",
    fx.spool.root,
    "--project",
    PROJECT,
    "--allow-unbound",
    "--settings",
    fx.settingsPath,
    "--runtime",
    fx.runtime,
  ]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /mode=async-rewake/);

  const settings = JSON.parse(readFileSync(fx.settingsPath, "utf8")) as {
    permissions: unknown;
    hooks: Record<string, Array<{ hooks: Array<{ command: string; asyncRewake?: boolean }> }>>;
  };
  assert.deepEqual(settings.permissions, { allow: ["Bash(ls)"] });
  assert.ok(settings.hooks.PreToolUse);
  assert.equal(settings.hooks.PreToolUse[0]?.hooks[0]?.command, "echo keep-me");
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.ok(settings.hooks.Stop);
  assert.equal(settings.hooks.Stop[0]?.hooks[0]?.asyncRewake, true);

  const status = run([
    "status",
    "--spool-dir",
    fx.spool.root,
    "--settings",
    fx.settingsPath,
    "--runtime",
    fx.runtime,
    "--json",
  ]);
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout) as {
    async_rewake: boolean;
    mode: string;
    hooks_installed: boolean;
    settings_error: string | null;
  };
  assert.equal(report.async_rewake, true);
  assert.equal(report.mode, "async-rewake");
  assert.equal(report.hooks_installed, true);
  assert.equal(report.settings_error, null);

  const uninstall = run([
    "uninstall",
    "--spool-dir",
    fx.spool.root,
    "--settings",
    fx.settingsPath,
  ]);
  assert.equal(uninstall.status, 0, uninstall.stderr);
  assert.match(uninstall.stdout, /removed=3/);
  const after = JSON.parse(readFileSync(fx.settingsPath, "utf8")) as {
    permissions: unknown;
    hooks: Record<string, unknown>;
  };
  assert.deepEqual(after.permissions, { allow: ["Bash(ls)"] });
  assert.deepEqual(Object.keys(after.hooks), ["PreToolUse"]);
});

test("SessionStart reports the oldest pending event once, then dedupes", (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, `Please review ${TOKEN}`);
  enqueue(fx.spool, 2, "Second message");

  const first = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-alpha", "startup"),
  );
  assert.equal(first.status, 0, first.stderr);
  const context = additionalContext(first);
  assert.ok(context);
  assert.match(context, /^CORKBOARD_NOTICE_V1 /);
  assert.match(context, /"seq":1/);
  assert.match(context, /"pending":2/);
  assert.match(context, /"body_included":false/);
  assert.match(context, /"summary_included":false/);
  assert.match(context, /not an instruction, not authorization/);
  assert.equal(context.includes(TOKEN), false);
  assert.equal(context.includes("Please review"), false);
  assert.equal(context.includes('"summary"'), false);

  // The next prompt surfaces the next pending event, not a repeat of seq 1.
  const second = run(
    ["hook", "user-prompt-submit", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("UserPromptSubmit", "sess-alpha"),
  );
  assert.equal(second.status, 0, second.stderr);
  assert.match(additionalContext(second) ?? "", /"seq":2/);

  // Once every event has been announced, later prompts stay quiet.
  const third = run(
    ["hook", "user-prompt-submit", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("UserPromptSubmit", "sess-alpha"),
  );
  assert.equal(third.status, 0, third.stderr);
  assert.equal(additionalContext(third), null);
});

test("Stop monitor exits 2 with a fixed notice and does not repeat it", (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, "First");
  // Consume seq 1 via a session start so the monitor is tested on a new event.
  run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-stop"),
  );
  enqueue(fx.spool, 2, "Second");

  const first = run(
    [
      "hook",
      "stop",
      "--spool-dir",
      fx.spool.root,
      "--project",
      PROJECT,
      "--wait-seconds",
      "1",
    ],
    hookInput("Stop", "sess-stop"),
  );
  assert.equal(first.status, 2, first.stderr);
  assert.match(first.stderr, /^CORKBOARD_NOTICE_V1 /);
  assert.match(first.stderr, /"seq":2/);

  const started = Date.now();
  const second = run(
    [
      "hook",
      "stop",
      "--spool-dir",
      fx.spool.root,
      "--project",
      PROJECT,
      "--wait-seconds",
      "1",
    ],
    hookInput("Stop", "sess-stop"),
  );
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.stderr.trim(), "");
  assert.ok(Date.now() - started >= 900, "monitor should wait before giving up");
});

test("resume re-announces unacknowledged events and acknowledgement stops it", (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, "Needs a reply");

  const first = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-recover", "startup"),
  );
  assert.match(additionalContext(first) ?? "", /"seq":1/);

  // A resumed/restarted session must not lose a notice it may never have read.
  const resumed = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-recover", "resume"),
  );
  assert.match(additionalContext(resumed) ?? "", /"seq":1/);

  const spool = openSpool(fx.spool.root);
  ackEvent(spool, consumerIdForSession("sess-recover"), 1);
  const afterAck = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-recover", "resume"),
  );
  assert.equal(additionalContext(afterAck), null);
});

test("sessions have independent read positions and no cross-session ack", (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, "For both sessions");

  const alpha = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-alpha"),
  );
  const beta = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-beta"),
  );
  assert.match(additionalContext(alpha) ?? "", /"seq":1/);
  assert.match(additionalContext(beta) ?? "", /"seq":1/);

  const spool = openSpool(fx.spool.root);
  ackEvent(spool, consumerIdForSession("sess-alpha"), 1);
  const betaAgain = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-beta", "resume"),
  );
  // Beta did not acknowledge, so its resumed session still gets its notice.
  assert.match(additionalContext(betaAgain) ?? "", /"seq":1/);
});

test("hostile identifiers are escaped and message text/plaintext never leak", (t) => {
  const fx = fixture(t, true);
  const codepoints = [0x1b, 0x202e, 0x2028, 0x2029, 0x061c, 0x2060, 0x180e, 0xfff9, 0xe0041];
  const hostile = "IGNORE_ALL" + String.fromCodePoint(...codepoints);
  enqueueEvent(
    fx.spool,
    {
      projectId: PROJECT,
      messageId: `msg_${hostile}${"A".repeat(9000)}`,
      seq: 1,
      senderId: `spk_${hostile}`,
      summary: `SUMMARY_CANARY ${hostile}`,
      bodyState: "ready",
    },
    `BODY_CANARY_${"B".repeat(10)}`,
    { token: TOKEN, now: () => new Date("2026-11-11T12:00:00.000Z") },
  );
  const result = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("SessionStart", "sess-hostile"),
  );
  const context = additionalContext(result) ?? "";
  for (const codepoint of codepoints) {
    assert.equal(context.includes(String.fromCodePoint(codepoint)), false, `raw U+${codepoint.toString(16)}`);
  }
  assert.match(context, /u\{2028\}/);
  assert.match(context, /u\{e0041\}/);
  assert.match(context, /"summary_included":false/);
  assert.equal(context.includes("SUMMARY_CANARY"), false);
  assert.equal(context.includes("BODY_CANARY"), false);
  assert.ok(context.length <= 4000);

  const status = run([
    "status",
    "--spool-dir",
    fx.spool.root,
    "--settings",
    fx.settingsPath,
    "--json",
  ]);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes("BODY_CANARY"), false);
  assert.equal(status.stdout.includes("SUMMARY_CANARY"), false);
});

test("a project mismatch fails closed with no notice", (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, "Secret");
  const result = run(
    ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", "proj_other"],
    hookInput("SessionStart", "sess-wrong"),
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("CORKBOARD_NOTICE"), false);
});

test("an unsupported runtime installs the documented fallback hooks", (t) => {
  const fx = fixture(t);
  writeFileSync(fx.runtime, '#!/bin/sh\necho "2.1.200 (Claude Code)"\n', { mode: 0o755 });
  chmodSync(fx.runtime, 0o755);
  enqueue(fx.spool, 1, "Fallback message");

  const install = run([
    "install",
    "--spool-dir",
    fx.spool.root,
    "--project",
    PROJECT,
    "--allow-unbound",
    "--settings",
    fx.settingsPath,
    "--runtime",
    fx.runtime,
  ]);
  assert.equal(install.status, 0, install.stderr);
  assert.match(install.stdout, /mode=fallback/);
  assert.match(install.stdout, /idle wake is unavailable/);

  const settings = JSON.parse(readFileSync(fx.settingsPath, "utf8")) as {
    hooks: Record<string, unknown>;
  };
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.UserPromptSubmit);
  assert.equal(settings.hooks.Stop, undefined);

  const result = run(
    ["hook", "user-prompt-submit", "--spool-dir", fx.spool.root, "--project", PROJECT],
    hookInput("UserPromptSubmit", "sess-fallback"),
  );
  assert.match(additionalContext(result) ?? "", /"seq":1/);
});

test("install fails closed without a credential-bound cursor unless overridden", (t) => {
  const fx = fixture(t);
  const denied = run([
    "install",
    "--spool-dir",
    fx.spool.root,
    "--project",
    PROJECT,
    "--settings",
    fx.settingsPath,
    "--runtime",
    fx.runtime,
  ]);
  assert.equal(denied.status, 2, denied.stderr);
  assert.match(denied.stderr, /cursor\.json is absent/);
  const before = JSON.parse(readFileSync(fx.settingsPath, "utf8")) as {
    hooks: Record<string, unknown>;
  };
  assert.equal(before.hooks.Stop, undefined);
  assert.equal(before.hooks.SessionStart, undefined);

  const allowed = run([
    "install",
    "--spool-dir",
    fx.spool.root,
    "--project",
    PROJECT,
    "--allow-unbound",
    "--settings",
    fx.settingsPath,
    "--runtime",
    fx.runtime,
  ]);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /allow-unbound/);
});

test("a failed notice write does not advance notified_seq", async (t) => {
  const fx = fixture(t);
  enqueue(fx.spool, 1, "Retry me");
  const args = ["hook", "session-start", "--spool-dir", fx.spool.root, "--project", PROJECT];
  const env = { ...process.env, CORKBOARD_APIKEY: "" };
  const failed = await main(
    args,
    env,
    hookInput("SessionStart", "sess-epipe"),
    () => {
      throw new Error("EPIPE");
    },
  );
  assert.equal(failed, 0);
  const spool = openSpool(fx.spool.root);
  assert.equal(
    readState(spool, consumerIdForSession("sess-epipe"))?.notified_seq ?? 0,
    0,
  );

  const written: string[] = [];
  const delivered = await main(args, env, hookInput("SessionStart", "sess-epipe"), (text) => {
    written.push(text);
  });
  assert.equal(delivered, 0);
  assert.match(written.join(""), /CORKBOARD_NOTICE_V1/);
  assert.equal(readState(spool, consumerIdForSession("sess-epipe"))?.notified_seq, 1);
});

test("status reports other consumers when one state file is corrupt", (t) => {
  const fx = fixture(t);
  const root = join(fx.spool.root, "adapters", "claude-code");
  const stateDir = join(root, "state");
  mkdirSync(join(fx.spool.root, "adapters"), { recursive: true, mode: 0o700 });
  mkdirSync(root, { recursive: true, mode: 0o700 });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, "cc-good.json"),
    `${JSON.stringify({
      version: 1,
      consumer_id: "cc-good",
      project_id: PROJECT,
      notified_seq: 2,
      updated_at: "2026-11-11T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(join(stateDir, "cc-bad.json"), "{not json\n", { mode: 0o600 });

  const status = run(["status", "--spool-dir", fx.spool.root, "--settings", fx.settingsPath, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const report = JSON.parse(status.stdout) as {
    consumers_error: string | null;
    consumers: Array<{
      consumer_id: string;
      notified_seq: number | null;
      acked_seq: number | null;
      error: string | null;
    }>;
  };
  assert.equal(report.consumers_error, null);
  assert.equal(report.consumers.length, 2);
  const good = report.consumers.find((consumer) => consumer.consumer_id === "cc-good");
  const bad = report.consumers.find((consumer) => consumer.consumer_id === "cc-bad");
  assert.equal(good?.notified_seq, 2);
  assert.equal(good?.acked_seq, 0);
  assert.equal(bad?.error, "ADAPTER_CORRUPT");
});

test("status and install output redact a credential present in the environment", (t) => {
  const fx = fixture(t);
  const install = run(
    [
      "install",
      "--spool-dir",
      fx.spool.root,
      "--project",
      PROJECT,
      "--allow-unbound",
      "--settings",
      fx.settingsPath,
      "--runtime",
      fx.runtime,
    ],
    "",
    { CORKBOARD_APIKEY: TOKEN },
  );
  assert.equal(install.status, 0, install.stderr);
  assert.equal(install.stdout.includes(TOKEN), false);
  assert.equal(install.stderr.includes(TOKEN), false);

  const status = run(
    ["status", "--spool-dir", fx.spool.root, "--settings", fx.settingsPath, "--json"],
    "",
    { CORKBOARD_APIKEY: TOKEN },
  );
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout.includes(TOKEN), false);
  assert.equal(status.stderr.includes(TOKEN), false);
});
