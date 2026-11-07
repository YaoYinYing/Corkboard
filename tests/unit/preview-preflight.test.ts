import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  PreflightError,
  parseCliArgs,
  readCredentialFile,
  readPasswordFile,
  runPreflight,
  type PreflightOptions,
} from "../../scripts/preview-preflight.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";

const TOKEN = `cb_${"a".repeat(43)}`;
const REVOKED_TOKEN = `cb_${"b".repeat(43)}`;
const NONMEMBER_TOKEN = `cb_${"c".repeat(43)}`;
const PROJECT = "proj_preflight";
const SPEAKER_ID = "spk_preflight";
const ACCOUNT_ID = "acct_preflight";
const MESSAGE_ID = "msg_preflight";
const SESSION_MARKER = "session-cookie-value-marker";
const CSRF_MARKER = "csrf-cookie-value-marker";
const BODY_MARKER = "response-body-marker";

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function digest(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function writePrivate(dir: string, name: string, value: string, mode = 0o600): string {
  const path = join(dir, name);
  writeFileSync(path, value);
  chmodSync(path, mode);
  return path;
}

function optionsFor(dir: string): PreflightOptions {
  return {
    baseUrl: "https://preview.example",
    project: PROJECT,
    credentialFile: writePrivate(dir, "credential", `${TOKEN}\n`),
    revokedCredentialFile: writePrivate(dir, "revoked", `${REVOKED_TOKEN}\n`),
    nonmemberCredentialFile: writePrivate(dir, "nonmember", `${NONMEMBER_TOKEN}\n`),
    login: "owner@example.test",
    passwordFile: writePrivate(dir, "password", "correct horse battery staple\n"),
  };
}

// Fake server that mirrors the documented success shapes and carries obvious
// markers in every cookie, body, and URL-adjacent value so a leak is visible.
interface FetchOptions {
  sessionCookieName?: string;
  csrfCookieName?: string;
  nonmemberCode?: string;
  healthz?: () => Response;
}

function successfulFetch(options: FetchOptions = {}): FetchLike {
  const sessionCookieName = options.sessionCookieName ?? SESSION_COOKIE_NAME;
  const csrfCookieName = options.csrfCookieName ?? CSRF_COOKIE_NAME;
  const nonmemberCode = options.nonmemberCode ?? "NOT_FOUND";
  let sends = 0;
  let sentText = "";
  return async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization");
    const path = url.pathname;

    if (path === "/healthz") return options.healthz?.() ?? json(200, { status: "ok" });
    if (path === "/readyz") return json(200, { status: "ready" });
    if (path === "/api/v1/me") {
      if (authorization === `Bearer ${REVOKED_TOKEN}`) {
        return json(401, { error: { code: "UNAUTHENTICATED" } });
      }
      if (authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: { code: "UNAUTHENTICATED" } });
      }
      return json(200, {
        speaker: { id: SPEAKER_ID, display_name: "Preview speaker" },
        account: { id: ACCOUNT_ID },
        scopes: ["project.read", "message.read", "message.send", "receipt.write"],
        projects: [PROJECT],
      });
    }
    if (path === `/api/v1/projects/${PROJECT}`) {
      if (authorization === `Bearer ${NONMEMBER_TOKEN}`) {
        return json(404, { error: { code: nonmemberCode } });
      }
      return json(200, { project: { id: PROJECT } });
    }
    if (path === `/api/v1/projects/${PROJECT}/messages` && method === "GET") {
      return json(200, { messages: [], next_cursor: null, leak: BODY_MARKER });
    }
    if (path === `/api/v1/projects/${PROJECT}/messages` && method === "POST") {
      const payload = JSON.parse(String(init?.body)) as {
        text: string;
        body_digest: string;
      };
      if (payload.text.endsWith("conflict probe")) {
        return json(409, { error: { code: "CONFLICT", message: BODY_MARKER } });
      }
      sentText = payload.text;
      sends += 1;
      return json(sends === 1 ? 201 : 200, {
        message_id: MESSAGE_ID,
        project_id: PROJECT,
        seq: 7,
        committed_at: "2026-11-06T12:00:00.000Z",
        body_state: "ready",
        digest: payload.body_digest,
        leak: BODY_MARKER,
      });
    }
    if (path === `/api/v1/projects/${PROJECT}/messages/${MESSAGE_ID}/body`) {
      return json(200, {
        message_id: MESSAGE_ID,
        text: sentText,
        compression: "none",
        digest: digest(sentText),
        leak: BODY_MARKER,
      });
    }
    if (path === `/api/v1/projects/${PROJECT}/messages/${MESSAGE_ID}/read`) {
      return json(200, {
        message_id: MESSAGE_ID,
        speaker_id: SPEAKER_ID,
        read_at: "2026-11-06T12:00:01.000Z",
        leak: BODY_MARKER,
      });
    }
    if (path === "/api/v1/session" && method === "POST") {
      const headers = new Headers();
      headers.append(
        "set-cookie",
        `${sessionCookieName}=${SESSION_MARKER}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`,
      );
      headers.append(
        "set-cookie",
        `${csrfCookieName}=${CSRF_MARKER}; Path=/; Secure; SameSite=Strict; Max-Age=43200`,
      );
      return new Response(JSON.stringify({ account: { id: ACCOUNT_ID } }), {
        status: 200,
        headers,
      });
    }
    if (path === "/api/v1/session" && method === "DELETE") {
      if (headers.get("x-csrf-token") !== CSRF_MARKER) {
        return json(403, { error: { code: "FORBIDDEN" } });
      }
      return new Response(null, { status: 204 });
    }
    return json(404, { error: { code: "NOT_FOUND" } });
  };
}

function withoutDir(): string {
  return mkdtempSync(join(tmpdir(), "corkboard-preflight-"));
}

test("base-url must be https or loopback http and origin-only", () => {
  for (const base of [
    "https://preview.example",
    "https://preview.example:8443",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
    "http://[::1]:8787",
  ]) {
    assert.equal(
      parseCliArgs([
        "--base-url",
        base,
        "--credential-file",
        "/tmp/credential",
        "--project",
        PROJECT,
      ]).baseUrl,
      new URL(base).origin,
    );
  }
  for (const base of [
    "http://preview.example",
    "http://0.0.0.0:8787",
    "https://" + "user:password" + "@preview.example",
    "https://preview.example/api",
    "https://preview.example/?a=1",
    "https://preview.example/#fragment",
    "not-a-url",
  ]) {
    assert.throws(
      () =>
        parseCliArgs([
          "--base-url",
          base,
          "--credential-file",
          "/tmp/credential",
          "--project",
          PROJECT,
        ]),
      PreflightError,
    );
  }
});

test("required options, unknown options, and login pairing are rejected", () => {
  assert.throws(() => parseCliArgs([]), PreflightError);
  assert.throws(
    () => parseCliArgs(["--base-url", "https://preview.example", "--project", PROJECT]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
      ]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
        "--project",
        "bad project",
      ]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
        "--project",
        PROJECT,
        "--unknown",
        "x",
      ]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
        "--project",
        PROJECT,
        "positional",
      ]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
        "--project",
        PROJECT,
        "--login",
        "owner@example.test",
      ]),
    PreflightError,
  );
  assert.throws(
    () =>
      parseCliArgs([
        "--base-url",
        "https://preview.example",
        "--credential-file",
        "/tmp/credential",
        "--project",
        PROJECT,
        "--password-file",
        "/tmp/password",
      ]),
    PreflightError,
  );
});

test("credential and password files are private regular files, never symlinks", () => {
  const dir = withoutDir();
  try {
    const valid = writePrivate(dir, "valid", `${TOKEN}\n`);
    assert.equal(readCredentialFile(valid), TOKEN);

    const loose = writePrivate(dir, "loose", `${TOKEN}\n`, 0o644);
    assert.throws(() => readCredentialFile(loose), /0600/);

    const malformed = writePrivate(dir, "malformed", "not-a-token\n");
    assert.throws(() => readCredentialFile(malformed), /cb_ credential/);

    const link = join(dir, "link");
    symlinkSync(valid, link);
    assert.throws(() => readCredentialFile(link), /symbolic link/);

    assert.throws(() => readCredentialFile(join(dir, "missing")), PreflightError);

    const password = writePrivate(dir, "password", "  spaced password  \n");
    assert.equal(readPasswordFile(password), "  spaced password  ");
    const empty = writePrivate(dir, "empty", "\n");
    assert.throws(() => readPasswordFile(empty), PreflightError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight passes every check without printing secrets or bodies", async () => {
  const dir = withoutDir();
  try {
    const printed: string[] = [];
    const summary = await runPreflight(optionsFor(dir), {
      fetchImpl: successfulFetch(),
      print: (line) => printed.push(line),
    });
    assert.deepEqual(summary, { passed: 15, failed: 0 });
    const output = printed.join("\n");
    assert.match(output, /PASS healthz/);
    assert.match(output, /PASS readyz/);
    assert.match(output, /PASS unauthenticated_401/);
    assert.match(output, /PASS me_binding/);
    assert.match(output, /PASS list_messages/);
    assert.match(output, /PASS send_message/);
    assert.match(output, /PASS body_read/);
    assert.match(output, /PASS mark_read/);
    assert.match(output, /PASS replay/);
    assert.match(output, /PASS idempotency_conflict/);
    assert.match(output, /PASS revoked_credential_401/);
    assert.match(output, /PASS nonmember_404/);
    assert.match(output, /PASS login_cookie_flags/);
    assert.match(output, /PASS csrf_rejection/);
    assert.match(output, /PASS csrf_signout/);
    for (const secret of [TOKEN, REVOKED_TOKEN, NONMEMBER_TOKEN, SESSION_MARKER, CSRF_MARKER]) {
      assert.equal(output.includes(secret), false);
    }
    // No response body, request text, or URL with a secret is printed.
    assert.equal(output.includes(BODY_MARKER), false);
    assert.equal(output.includes("preflight synthetic message"), false);
    assert.equal(output.includes("preview.example"), false);
    assert.equal(output.includes("correct horse battery staple"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight fails closed and redacts a fetch error that carries the token", async () => {
  const dir = withoutDir();
  try {
    const printed: string[] = [];
    const summary = await runPreflight(optionsFor(dir), {
      fetchImpl: async () => {
        throw new Error(`connection failed for ${TOKEN}`);
      },
      print: (line) => printed.push(line),
    });
    assert.deepEqual(summary, { passed: 0, failed: 1 });
    assert.deepEqual(printed, ["FAIL healthz (network error)", "preflight: 0 passed, 1 failed"]);
    assert.equal(printed.join("\n").includes(TOKEN), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPreflight fails closed on an unexpected status and a wrong me binding", async () => {
  const dir = withoutDir();
  try {
    const fetchImpl: FetchLike = async (input, init) => {
      const path = new URL(String(input)).pathname;
      const authorization = new Headers(init?.headers).get("authorization");
      if (path === "/healthz") return json(200, { status: "ok" });
      if (path === "/readyz") return json(200, { status: "ready" });
      if (path === "/api/v1/me") {
        if (authorization === null) return json(401, { error: { code: "UNAUTHENTICATED" } });
        return json(200, {
          speaker: { id: SPEAKER_ID },
          account: { id: ACCOUNT_ID },
          scopes: ["message.read"],
          projects: [PROJECT],
        });
      }
      return json(404, { error: { code: "NOT_FOUND" } });
    };
    const printed: string[] = [];
    const base = optionsFor(dir);
    const summary = await runPreflight(
      {
        baseUrl: base.baseUrl,
        project: base.project,
        credentialFile: base.credentialFile,
      },
      { fetchImpl, print: (line) => printed.push(line) },
    );
    assert.deepEqual(summary, { passed: 3, failed: 1 });
    assert.match(printed.join("\n"), /FAIL me_binding \(credential lacks message scopes\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("non-member check requires error.code NOT_FOUND", async () => {
  const dir = withoutDir();
  try {
    const printed: string[] = [];
    const summary = await runPreflight(optionsFor(dir), {
      fetchImpl: successfulFetch({ nonmemberCode: "FORBIDDEN" }),
      print: (line) => printed.push(line),
    });
    assert.equal(summary.failed, 1);
    assert.match(printed.join("\n"), /FAIL nonmember_404 \(unexpected JSON\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login requires the exact session cookie name", async () => {
  const dir = withoutDir();
  try {
    const printed: string[] = [];
    const summary = await runPreflight(optionsFor(dir), {
      fetchImpl: successfulFetch({ sessionCookieName: "__Host-not-the-session-cookie" }),
      print: (line) => printed.push(line),
    });
    assert.ok(summary.failed >= 1);
    const output = printed.join("\n");
    assert.match(output, /FAIL login_cookie_flags \(missing session cookie\)/);
    assert.equal(output.includes(SESSION_MARKER), false);
    assert.equal(output.includes(CSRF_MARKER), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("login requires the exact CSRF cookie name", async () => {
  const dir = withoutDir();
  try {
    const printed: string[] = [];
    const summary = await runPreflight(optionsFor(dir), {
      fetchImpl: successfulFetch({ csrfCookieName: "not-the-csrf-cookie" }),
      print: (line) => printed.push(line),
    });
    assert.ok(summary.failed >= 1);
    const output = printed.join("\n");
    assert.match(output, /FAIL login_cookie_flags \(missing CSRF cookie\)/);
    assert.equal(output.includes(SESSION_MARKER), false);
    assert.equal(output.includes(CSRF_MARKER), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("oversized responses fail closed without printing their bodies", async () => {
  const cases: Array<[string, () => Response]> = [
    [
      "streamed",
      () =>
        new Response(
          JSON.stringify({ status: "ok", pad: "x".repeat((1 << 20) + 1) }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    ],
    [
      "declared",
      () =>
        ({
          status: 200,
          headers: new Headers([["content-length", String((1 << 20) + 1)]]),
          body: null,
        }) as unknown as Response,
    ],
  ];
  for (const [name, healthz] of cases) {
    const dir = withoutDir();
    try {
      const printed: string[] = [];
      const summary = await runPreflight(
        {
          baseUrl: "https://preview.example",
          project: PROJECT,
          credentialFile: writePrivate(dir, "credential", `${TOKEN}\n`),
        },
        { fetchImpl: successfulFetch({ healthz }), print: (line) => printed.push(line) },
      );
      assert.deepEqual(summary, { passed: 0, failed: 1 }, name);
      assert.deepEqual(
        printed,
        ["FAIL healthz (unexpected JSON)", "preflight: 0 passed, 1 failed"],
        name,
      );
      assert.equal(printed.join("\n").includes("x".repeat(64)), false, name);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});
