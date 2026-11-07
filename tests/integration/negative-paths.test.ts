// Negative permission and failure-path coverage that is not already exercised
// by the object-scope, scope-precedence, OAuth, MCP, backup, and expiry suites.
// Every request below goes through the real `createApp` router or the real
// service with the real SQLite adapter; failures are injected at one dependency
// boundary (the database handle or the blob store), never by mocking the code
// under test.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createApp } from "../../src/app/handlers.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { AppError } from "../../src/domain/errors.ts";
import type { ServiceDeps } from "../../src/service/auth.ts";
import { getMessage, markRead } from "../../src/service/messages.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

const MCP_URL = "http://corkboard.test/mcp";
const ENCODER = new TextEncoder();

interface Actor {
  accountId: string;
  speakerId: string;
  token: string;
}

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Pre-encoded request bytes for malformed-input probes. */
  bodyBytes?: Uint8Array;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | Uint8Array | undefined;
  if (options.bodyBytes !== undefined) {
    body = options.bodyBytes;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
  }
  return app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function appFetch(app: App): FetchLike {
  return async (url, init) => app(new Request(url, init));
}

async function withApp(
  t: { after(fn: () => void | Promise<void>): void },
  options: Parameters<typeof createApp>[1] = {},
): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return { fx, app: createApp(fx.deps, options) };
}

async function addActor(fx: ServiceFixture, name: string): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, token };
}

function concat(prefix: Uint8Array, byte: number, suffix: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
  bytes.set(prefix, 0);
  bytes[prefix.length] = byte;
  bytes.set(suffix, prefix.length + 1);
  return bytes;
}

function failingDatabase(message: string): ServiceDeps["db"] {
  const fail = async (): Promise<never> => {
    throw new Error(message);
  };
  return {
    exec: fail,
    all: fail,
    first: fail,
    run: fail,
    transaction: fail,
  } as unknown as ServiceDeps["db"];
}

test("malformed project cursors and message parameters are validation failures", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const encoded = (value: string): string =>
    Buffer.from(value, "utf8").toString("base64url");
  const badCursors = [
    "@@@",
    encoded("null"),
    encoded("[]"),
    encoded(JSON.stringify({ created_at: 1, id: "proj_1" })),
    encoded(JSON.stringify({ created_at: "2026-01-01T00:00:00.000Z" })),
  ];
  for (const cursor of badCursors) {
    const response = await call(
      app,
      `/api/v1/projects?cursor=${encodeURIComponent(cursor)}`,
      { token: alice.token },
    );
    assert.equal(response.status, 400, cursor);
    assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR", cursor);
  }

  // Route-level query validation must map to the same stable code the service
  // uses, before any storage read.
  for (const query of [
    "after_seq=1&before_seq=2",
    "after_seq=-1",
    "before_seq=-1",
    "limit=0",
    "limit=101",
  ]) {
    const response = await call(
      app,
      `/api/v1/projects/proj_1/messages?${query}`,
      { token: alice.token },
    );
    assert.equal(response.status, 400, query);
    assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR", query);
  }

  // MCP shares the same cursor parser; a denied cursor is a stable tool error,
  // not a transport failure.
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${alice.token}` } },
    fetch: appFetch(app),
  });
  const client = new Client({ name: "negative-paths", version: "1.0.0" });
  await client.connect(transport);
  t.after(() => client.close());
  const result = (await client.callTool({
    name: "corkboard_list_projects",
    arguments: { cursor: "@@@" },
  })) as JsonObject;
  assert.equal(result["isError"], true);
  assert.equal(result["content"]?.[0]?.type, "text");
  assert.deepEqual(JSON.parse(result["content"][0].text), {
    error: { code: "VALIDATION_ERROR" },
  });

  // Message query parameters are validated by the service, so a semantically
  // invalid pair reaches it and maps to the same stable tool error. Values the
  // tool input schema itself rejects (a negative seq, `limit: 0`) raise the
  // SDK's internal McpError(-32602), surfaced as a tool-result error before the
  // service runs.
  const combined = (await client.callTool({
    name: "corkboard_list_messages",
    arguments: { project_id: "proj_1", after_seq: 1, before_seq: 2 },
  })) as JsonObject;
  assert.equal(combined["isError"], true);
  assert.deepEqual(JSON.parse(combined["content"][0].text), {
    error: { code: "VALIDATION_ERROR" },
  });
});

test("unexpected persistence failures are sanitized on API, HTML, and MCP surfaces", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const email = "web@example.test";
  const password = "correct horse battery";
  await fx.db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["acct_web", email, await hashPassword(password), fx.deps.now().toISOString()],
  );
  const login = await call(app, "/api/v1/session", {
    method: "POST",
    body: { email, password },
  });
  assert.equal(login.status, 200);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";")[0] ?? "")
    .filter((value) => value !== "")
    .join("; ");
  assert.equal((await call(app, "/", { headers: { cookie } })).status, 200);
  assert.equal((await call(app, "/api/v1/projects", { token: alice.token })).status, 200);

  // Inject a failure at the one shared persistence boundary. No route-specific
  // mock: the router, authentication, and service code all run unchanged.
  fx.deps.db = failingDatabase("injected persistence failure");

  const api = await call(app, "/api/v1/projects", { token: alice.token });
  assert.equal(api.status, 503);
  const apiText = await api.text();
  assert.equal(JSON.parse(apiText).error.code, "UNAVAILABLE");
  assert.equal(apiText.includes("injected persistence failure"), false);

  const page = await call(app, "/", { headers: { cookie } });
  assert.equal(page.status, 500);
  const html = await page.text();
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(html.includes("injected persistence failure"), false);
  assert.equal(html.includes("stack"), false);

  const mcp = await call(app, "/mcp", {
    method: "POST",
    token: alice.token,
    headers: { accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "negative-paths", version: "1.0.0" },
      },
    },
  });
  assert.equal(mcp.status, 503);
  const mcpText = await mcp.text();
  assert.equal(mcpText.includes("injected persistence failure"), false);
});

test("a blob write failure leaves no committed message and the same key resumes once", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const base = fx.deps.blobs;
  let failNextPut = true;
  fx.deps.blobs = {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      if (failNextPut) {
        failNextPut = false;
        throw new Error("injected blob write failure");
      }
      await base.put(key, bytes);
    },
    get: (key: string) => base.get(key),
    delete: (key: string) => base.delete(key),
  };

  const request = {
    method: "POST" as const,
    token: alice.token,
    headers: { "idempotency-key": "blob-fail" },
    body: {
      summary: "held back",
      type: "note",
      language: "en",
      text: "body survives the retry",
      body_digest: digestOf("body survives the retry"),
    },
  };
  const first = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(first.status, 503);
  assert.equal((await first.text()).includes("injected blob write failure"), false);

  // The provisional idempotency row remains; nothing is published or visible.
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 0);
  const record = await fx.db.first<{ message_id: string | null; status: string }>(
    "SELECT message_id, status FROM idempotency_keys WHERE key = ?",
    ["blob-fail"],
  );
  assert.equal(record?.status, "pending");
  assert.ok(record?.message_id);

  const principal = await fx.authenticate(alice.token);
  await assert.rejects(
    getMessage(fx.deps, principal, "proj_1", record.message_id ?? ""),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    markRead(fx.deps, principal, "proj_1", record.message_id ?? ""),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );

  // Restore the store and retry with the same key and payload: the documented
  // resume path commits exactly once.
  fx.deps.blobs = base;
  // The route sees the recorded key and reports a replay (200), not a new
  // commit, even though the first attempt never published a message.
  const retry = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(retry.status, 200);
  const retryBody = await jsonBody(retry);
  assert.equal(retryBody.message_id, record.message_id);
  assert.equal(retryBody.seq, 1);

  const replay = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(replay.status, 200);
  assert.equal((await jsonBody(replay)).message_id, retryBody.message_id);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 1);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 1);
});

test("invalid UTF-8 request bodies are rejected before validation or writes", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  // A non-fatal decoder would replace the 0xff byte with U+FFFD and accept a
  // message the client never sent. The malformed byte is inside a JSON string.
  const apiBytes = concat(
    ENCODER.encode(
      '{"summary":"utf8","type":"note","language":"en","text":"',
    ),
    0xff,
    ENCODER.encode(`","body_digest":"sha256:${"0".repeat(64)}"}`),
  );
  const api = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: {
      "idempotency-key": "invalid-utf8",
      "content-type": "application/json",
    },
    bodyBytes: apiBytes,
  });
  assert.equal(api.status, 400);
  assert.equal((await jsonBody(api)).error.code, "VALIDATION_ERROR");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 0);

  const loginBytes = concat(
    ENCODER.encode("email=web@example.test&password="),
    0xff,
    new Uint8Array(),
  );
  const login = await call(app, "/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    bodyBytes: loginBytes,
  });
  assert.equal(login.status, 400);
  assert.equal(login.headers.get("set-cookie"), null);
  assert.equal((await fx.db.all("SELECT id FROM sessions")).length, 0);

  // A complete refresh request whose token value carries a malformed byte. With a
  // strict decoder the body is refused at decode time (`invalid_request`); with a
  // non-fatal one the value keeps the `cb_ort_` prefix, fails the length guard, and
  // reaches the grant handler as `invalid_grant`. The assertion below therefore
  // fails without the fix.
  const oauthApp = createApp(fx.deps, { publicBaseUrl: "https://corkboard.test" });
  const tokenBytes = concat(
    ENCODER.encode(
      "client_id=cb_cli_unknown&grant_type=refresh_token&refresh_token=cb_ort_",
    ),
    0xff,
    new Uint8Array(),
  );
  const token = await call(oauthApp, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    bodyBytes: tokenBytes,
  });
  assert.equal(token.status, 400);
  assert.deepEqual(await jsonBody(token), { error: "invalid_request" });
  assert.equal(
    (await fx.db.all("SELECT id FROM oauth_authorization_codes")).length,
    0,
  );
});

test("inactive accounts, speakers, and projects fail closed on bearer surfaces", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  assert.equal((await call(app, "/api/v1/me", { token: alice.token })).status, 200);

  // An inactive speaker or owning account invalidates the credential itself.
  for (const update of [
    ["speakers", alice.speakerId],
    ["accounts", alice.accountId],
  ] as const) {
    await fx.db.run(`UPDATE ${update[0]} SET status = 'inactive' WHERE id = ?`, [
      update[1],
    ]);
    for (const path of ["/api/v1/me", "/api/v1/projects"]) {
      const response = await call(app, path, { token: alice.token });
      assert.equal(response.status, 401, `${update[0]} ${path}`);
      assert.equal((await jsonBody(response)).error.code, "UNAUTHENTICATED");
    }
    await fx.db.run(`UPDATE ${update[0]} SET status = 'active' WHERE id = ?`, [
      update[1],
    ]);
  }
  assert.equal((await call(app, "/api/v1/me", { token: alice.token })).status, 200);

  // An inactive project is indistinguishable from an unknown one.
  await fx.db.run("UPDATE projects SET status = 'inactive' WHERE id = ?", ["proj_1"]);
  const list = await jsonBody(
    await call(app, "/api/v1/projects", { token: alice.token }),
  );
  assert.deepEqual(list.projects, []);
  for (const path of [
    "/api/v1/projects/proj_1",
    "/api/v1/projects/proj_1/stats",
    "/api/v1/projects/proj_1/messages",
  ]) {
    const response = await call(app, path, { token: alice.token });
    assert.equal(response.status, 404, path);
    assert.equal((await jsonBody(response)).error.code, "NOT_FOUND", path);
  }
  const send = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "inactive" },
    body: {
      summary: "no",
      type: "note",
      language: "en",
      text: "no",
      body_digest: digestOf("no"),
    },
  });
  assert.equal(send.status, 404);
  assert.equal((await jsonBody(send)).error.code, "NOT_FOUND");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);
});

test("corrupt idempotency rows fail closed with UNAVAILABLE and no duplicate message", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const request = {
    method: "POST" as const,
    token: alice.token,
    headers: { "idempotency-key": "corrupt" },
    body: {
      summary: "corruptible",
      type: "note",
      language: "en",
      text: "only once",
      body_digest: digestOf("only once"),
    },
  };
  const first = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(first.status, 201);
  const messageId = (await jsonBody(first)).message_id;
  const stored = await fx.db.first<{ payload_digest: string }>(
    "SELECT payload_digest FROM idempotency_keys WHERE key = ?",
    ["corrupt"],
  );
  assert.ok(stored?.payload_digest);

  // Missing columns are server-side corruption, not a replay: fail closed.
  await fx.db.run(
    "UPDATE idempotency_keys SET payload_digest = NULL WHERE key = ?",
    ["corrupt"],
  );
  const noDigest = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(noDigest.status, 503);
  assert.equal((await jsonBody(noDigest)).error.code, "UNAVAILABLE");

  await fx.db.run(
    "UPDATE idempotency_keys SET payload_digest = ?, message_id = NULL WHERE key = ?",
    [stored.payload_digest, "corrupt"],
  );
  const noMessage = await call(app, "/api/v1/projects/proj_1/messages", request);
  assert.equal(noMessage.status, 503);
  assert.equal((await jsonBody(noMessage)).error.code, "UNAVAILABLE");

  const messages = await fx.db.all<{ id: string }>("SELECT id FROM messages");
  assert.deepEqual(messages, [{ id: messageId }]);
});
