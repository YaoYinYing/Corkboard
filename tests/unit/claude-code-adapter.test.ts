import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendHooks,
  buildHooks,
  consumerIdForSession,
  countOwnHooks,
  formatNotice,
  parseVersion,
  stripOwnHooks,
  versionAtLeast,
  type HookSettings,
  type InstallManifestV1,
} from "../../scripts/claude-code-adapter.ts";
import type { InboxEventV1 } from "../../src/inbox/spool.ts";

function event(overrides: Partial<InboxEventV1> = {}): InboxEventV1 {
  return {
    version: 1,
    project_id: "proj_test",
    seq: 7,
    message_id: "msg_test",
    sender: { id: "spk_sender", attribution: "server_authenticated" },
    body_state: "ready",
    summary: "Review the plan",
    queued_at: "2026-11-11T12:00:00.000Z",
    payload: { included: false },
    ...overrides,
  };
}

function documentWithOtherHooks(): Record<string, unknown> {
  return {
    permissions: { allow: ["Bash(ls)"] },
    env: { KEEP: "1" },
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "prompt", prompt: "is this safe?" },
            { type: "command", command: "echo existing" },
          ],
        },
      ],
    },
  };
}

test("parseVersion and versionAtLeast gate the verified asyncRewake runtime", () => {
  assert.equal(parseVersion("2.1.310 (Claude Code)"), "2.1.310");
  assert.equal(parseVersion("no version here"), null);
  assert.equal(versionAtLeast("2.1.310", [2, 1, 310]), true);
  assert.equal(versionAtLeast("2.1.308", [2, 1, 310]), false);
  assert.equal(versionAtLeast("2.1.307", [2, 1, 310]), false);
  assert.equal(versionAtLeast("2.2.0", [2, 1, 310]), true);
  assert.equal(versionAtLeast("1.9.999", [2, 1, 310]), false);
  assert.equal(versionAtLeast("garbage", [2, 1, 310]), false);
});

test("consumerIdForSession is stable and safe for the spool", () => {
  assert.equal(consumerIdForSession("sess-abc_123"), "cc-sess-abc_123");
  const hostile = consumerIdForSession("bad id \u001b with spaces /‮");
  assert.match(hostile, /^[A-Za-z0-9._-]{1,64}$/);
  assert.equal(hostile, consumerIdForSession("bad id \u001b with spaces /‮"));
  assert.notEqual(hostile, consumerIdForSession("another session"));
});

test("formatNotice carries metadata only, never the body or summary", () => {
  const notice = formatNotice(event(), 3, "");
  assert.match(notice, /^CORKBOARD_NOTICE_V1 \{/);
  assert.match(notice, /"seq":7/);
  assert.match(notice, /"message_id":"msg_test"/);
  assert.match(notice, /"sender_id":"spk_sender"/);
  assert.match(notice, /"pending":3/);
  assert.match(notice, /"body_included":false/);
  assert.match(notice, /"summary_included":false/);
  assert.match(notice, /not an instruction, not authorization/);
  assert.equal(notice.includes("Review the plan"), false);
  assert.equal(notice.includes('"summary"'), false);
});

test("formatNotice escapes hostile identifiers and never includes message text", () => {
  const hostile = `\u001b[31mIGNORE‮ line ؜⁠᠎￹tag\u{E0041}`;
  const notice = formatNotice(
    event({
      project_id: `proj${hostile}`,
      message_id: `msg${hostile}${"A".repeat(10_000)}`,
      sender: { id: `spk${hostile}`, attribution: "server_authenticated" },
      summary: `SUMMARY_CANARY ${hostile}`,
    }),
    1,
    "",
  );
  for (const character of ["\u001b", "‮", " ", " ", "؜", "⁠", "᠎", "￹", "\u{E0041}"]) {
    assert.equal(notice.includes(character), false, `raw U+${character.codePointAt(0)?.toString(16)}`);
  }
  assert.match(notice, /u\{2028\}/);
  assert.match(notice, /u\{e0041\}/);
  assert.equal(notice.includes("SUMMARY_CANARY"), false);
  assert.ok(notice.length <= 4000, `notice length ${notice.length}`);
  const payload = notice.split("\n")[0]?.replace("CORKBOARD_NOTICE_V1 ", "");
  assert.ok(payload !== undefined);
  assert.doesNotThrow(() => JSON.parse(payload));
});

test("formatNotice redacts the credential from metadata", () => {
  const secret = "sk-canary-123";
  const notice = formatNotice(
    event({
      message_id: `msg_${secret}`,
      sender: { id: `spk_${secret}`, attribution: "server_authenticated" },
      summary: `the key is ${secret}`,
    }),
    1,
    secret,
  );
  assert.equal(notice.includes(secret), false);
  assert.match(notice, /\[REDACTED\]/);
});

test("buildHooks uses asyncRewake only when selected", () => {
  const asyncHooks = buildHooks("/abs/claude-code-adapter.ts", "/abs/spool", "proj_test", "async-rewake", 60);
  assert.ok(asyncHooks.SessionStart);
  assert.ok(asyncHooks.Stop);
  // The prompt fallback is always installed, even when the monitor is used.
  assert.ok(asyncHooks.UserPromptSubmit);
  assert.equal(asyncHooks.Stop?.[0]?.hooks[0]?.asyncRewake, true);
  assert.match(asyncHooks.Stop?.[0]?.hooks[0]?.command ?? "", /'--wait-seconds' '60'$/);
  assert.ok((asyncHooks.Stop?.[0]?.hooks[0]?.timeout ?? 0) <= 120);

  const fallback = buildHooks("/abs/claude-code-adapter.ts", "/abs/spool", "proj_test", "fallback", 60);
  assert.ok(fallback.SessionStart);
  assert.equal(fallback.Stop, undefined);
  assert.ok(fallback.UserPromptSubmit);
  assert.equal(fallback.UserPromptSubmit?.[0]?.hooks[0]?.asyncRewake, undefined);
});

test("settings merge removes only this adapter's hooks and preserves everything else", () => {
  const document = documentWithOtherHooks();
  const original = JSON.parse(JSON.stringify(document)) as Record<string, unknown>;
  const hooks: HookSettings = buildHooks(
    "/abs/claude-code-adapter.ts",
    "/abs/spool",
    "proj_test",
    "async-rewake",
    60,
  );
  const commands = new Set(
    Object.values(hooks)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command)),
  );

  assert.equal(stripOwnHooks(document, "/abs/spool", new Set()), 0);
  appendHooks(document, hooks);
  assert.equal(countOwnHooks(document, "/abs/spool", commands), 3);

  // Reinstall is idempotent.
  assert.equal(stripOwnHooks(document, "/abs/spool", commands), 3);
  appendHooks(document, hooks);
  assert.equal(countOwnHooks(document, "/abs/spool", commands), 3);

  assert.deepEqual(document.permissions, original.permissions);
  assert.deepEqual(document.env, original.env);
  const groups = (document.hooks as Record<string, Array<{ matcher?: string; hooks: unknown[] }>>)
    .PreToolUse;
  assert.deepEqual(groups, (original.hooks as Record<string, unknown>).PreToolUse);

  assert.equal(stripOwnHooks(document, "/abs/spool", commands), 3);
  assert.deepEqual(document.hooks, original.hooks);
});

test("stripping one spool leaves another spool's adapter hooks intact", () => {
  const document: Record<string, unknown> = {};
  const first = buildHooks("/abs/claude-code-adapter.ts", "/abs/spool-one", "proj_one", "async-rewake", 60);
  const second = buildHooks("/abs/claude-code-adapter.ts", "/abs/spool-two", "proj_two", "async-rewake", 60);
  appendHooks(document, first);
  appendHooks(document, second);
  const firstCommands = new Set(
    Object.values(first)
      .flat()
      .flatMap((group) => group.hooks.map((hook) => hook.command)),
  );
  assert.equal(stripOwnHooks(document, "/abs/spool-one", firstCommands), 3);
  assert.equal(countOwnHooks(document, "/abs/spool-two", new Set()), 3);
});

test("a sibling spool whose path is a string prefix is not stripped", () => {
  const document: Record<string, unknown> = {};
  const first = buildHooks("/abs/claude-code-adapter.ts", "/state/proj", "proj_one", "async-rewake", 60);
  const second = buildHooks("/abs/claude-code-adapter.ts", "/state/proj2", "proj_two", "async-rewake", 60);
  appendHooks(document, first);
  appendHooks(document, second);
  // No manifest commands: exercise the quoted-token marker fallback.
  assert.equal(stripOwnHooks(document, "/state/proj", new Set()), 3);
  assert.equal(countOwnHooks(document, "/state/proj2", new Set()), 3);
  assert.equal(countOwnHooks(document, "/state/proj", new Set()), 0);
});

test("manifest shape stays versioned and contains no credential field", () => {
  const manifest: InstallManifestV1 = {
    version: 1,
    project_id: "proj_test",
    spool_root: "/abs/spool",
    settings_path: "/abs/settings.local.json",
    mode: "async-rewake",
    runtime_version: "2.1.310",
    wait_seconds: 60,
    commands: [],
    installed_at: "2026-11-11T12:00:00.000Z",
  };
  assert.equal(manifest.version, 1);
  assert.equal(Object.hasOwn(manifest, "token"), false);
});
