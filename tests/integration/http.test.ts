import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, MAX_REQUEST_BODY_BYTES, type RequestLogEntry } from "../../src/app/handlers.ts";
import {
  BodyTooLargeError,
  readCappedBody,
  startServer,
  type RunningServer,
} from "../../src/platforms/node/main.ts";
import type { ServiceDeps } from "../../src/service/auth.ts";
import {
  ALL_SCOPES,
  createServiceFixture,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

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
  rawBody?: string;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body);
  }
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
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

function payload(text: string, overrides: Record<string, unknown> = {}): JsonObject {
  return {
    summary: text,
    type: "request",
    language: "en",
    text,
    body_digest: digestOf(text),
    ...overrides,
  };
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

async function withApp(
  t: { after(fn: () => void): void },
): Promise<{ fx: ServiceFixture; deps: ServiceDeps; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return { fx, deps: fx.deps, app: createApp(fx.deps) };
}

function assertHardeningHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
}

test("healthz is public, minimal, and hardened", async (t) => {
  const { app } = await withApp(t);
  const response = await call(app, "/healthz");
  assert.equal(response.status, 200);
  assertHardeningHeaders(response);
  assert.deepEqual(await jsonBody(response), { status: "ok" });
});

async function startTestServer(
  t: { after(fn: () => void | Promise<void>): void },
  env: Record<string, string> = {},
): Promise<{ base: string; running: RunningServer }> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-server-"));
  const running = await startServer({
    env: {
      CORKBOARD_DATA_DIR: join(dir, "data"),
      CORKBOARD_ROOT_KEY: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      PORT: "0",
      ...env,
    },
  });
  t.after(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const address = running.server.address();
  assert.ok(address !== null && typeof address === "object");
  return { base: `http://127.0.0.1:${address.port}`, running };
}

test("node server binds loopback and adapts HTTP to the Web handlers", async (t) => {
  const { base, running } = await startTestServer(t);
  const address = running.server.address();
  assert.ok(address !== null && typeof address === "object");
  assert.equal(address.address, "127.0.0.1");

  const response = await fetch(`${base}/healthz`, { headers: { connection: "close" } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { status: "ok" });
});

test("chunked bodies over 64 KiB return 413 without full buffering", async (t) => {
  const { base } = await startTestServer(t);

  // The cap helper stops consuming once the limit is crossed.
  let consumed = 0;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    const chunk = new Uint8Array(8 * 1024);
    for (let index = 0; index < 100; index += 1) {
      consumed += chunk.length;
      yield chunk;
    }
  }
  await assert.rejects(
    readCappedBody(chunks(), MAX_REQUEST_BODY_BYTES),
    (error: unknown) => error instanceof BodyTooLargeError,
  );
  assert.ok(consumed <= MAX_REQUEST_BODY_BYTES + 8 * 1024);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("x".repeat(60 * 1024)));
      controller.enqueue(encoder.encode("y".repeat(10 * 1024)));
      controller.close();
    },
  });
  const response = await fetch(`${base}/api/v1/projects/proj_1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "chunked" },
    body: stream,
    duplex: "half",
  });
  assert.equal(response.status, 413);
  assertHardeningHeaders(response);
  const body = await jsonBody(response);
  assert.equal(body.error.code, "REQUEST_TOO_LARGE");
  assert.match(body.error.request_id, /^req_[A-Za-z0-9_-]+$/);

  // A declared Content-Length over the cap is rejected before reading.
  const declared = await fetch(`${base}/api/v1/projects/proj_1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "declared" },
    body: new Uint8Array(70 * 1024),
  });
  assert.equal(declared.status, 413);
  assert.equal((await jsonBody(declared)).error.code, "REQUEST_TOO_LARGE");

  // A route that needs no body is rejected without consuming the stream.
  const ignored = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("z".repeat(70 * 1024)));
      controller.close();
    },
  });
  const health = await fetch(`${base}/healthz`, {
    method: "POST",
    body: ignored,
    duplex: "half",
  });
  assert.equal(health.status, 405);
});

test("missing or invalid credentials return 401 with WWW-Authenticate", async (t) => {
  const { app } = await withApp(t);
  for (const token of [undefined, "cb_" + "A".repeat(43)]) {
    const response = await call(app, "/api/v1/me", token === undefined ? {} : { token });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    assertHardeningHeaders(response);
    const body = await jsonBody(response);
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.match(body.error.request_id, /^req_[A-Za-z0-9_-]+$/);
  }
});

test("/me reports the speaker, account, actual scopes and readable projects", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");

  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  await fx.addProject("proj_2", alice.accountId);
  await fx.addMembership("proj_2", alice.speakerId, ["message.send"]);
  await fx.addProject("proj_3", alice.accountId, "suspended");
  await fx.addMembership("proj_3", alice.speakerId);

  const response = await call(app, "/api/v1/me", { token: alice.token });
  assert.equal(response.status, 200);
  assertHardeningHeaders(response);
  const body = await jsonBody(response);
  assert.deepEqual(body.speaker, { id: "spk_alice", display_name: "spk_alice" });
  assert.deepEqual(body.account, { id: "acct_alice" });
  assert.deepEqual(body.scopes, ALL_SCOPES);
  assert.deepEqual(body.projects, ["proj_1"]);

  const { token: limited } = await fx.addCredential({
    id: "cred_alice_send_only",
    speakerId: alice.speakerId,
    scopes: ["message.send"],
  });
  const limitedBody = await jsonBody(await call(app, "/api/v1/me", { token: limited }));
  assert.deepEqual(limitedBody.scopes, ["message.send"]);
  assert.deepEqual(limitedBody.projects, []);
});

test("project list paginates by (created_at, id) with an opaque cursor", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  for (const id of ["proj_a", "proj_b", "proj_c"]) {
    await fx.addProject(id, alice.accountId);
    await fx.addMembership(id, alice.speakerId);
  }

  const first = await call(app, "/api/v1/projects?limit=2", { token: alice.token });
  assert.equal(first.status, 200);
  const firstBody = await jsonBody(first);
  assert.deepEqual(
    firstBody.projects.map((project: JsonObject) => project.id),
    ["proj_a", "proj_b"],
  );
  assert.equal(firstBody.projects[0].title, "proj_a");
  assert.equal(typeof firstBody.next_cursor, "string");

  const second = await call(
    app,
    `/api/v1/projects?limit=2&cursor=${encodeURIComponent(firstBody.next_cursor)}`,
    { token: alice.token },
  );
  const secondBody = await jsonBody(second);
  assert.deepEqual(
    secondBody.projects.map((project: JsonObject) => project.id),
    ["proj_c"],
  );
  assert.equal(secondBody.next_cursor, null);

  for (const limit of ["0", "101", "abc", "-1"]) {
    const response = await call(app, `/api/v1/projects?limit=${limit}`, { token: alice.token });
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR");
  }

  const { token: sendOnly } = await fx.addCredential({
    id: "cred_alice_send_only",
    speakerId: alice.speakerId,
    scopes: ["message.send"],
  });
  const forbidden = await call(app, "/api/v1/projects", { token: sendOnly });
  assert.equal(forbidden.status, 403);
  assert.equal((await jsonBody(forbidden)).error.code, "FORBIDDEN");
});

test("project detail returns metadata and effective capabilities", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId, [
    "project.read",
    "message.read",
    "message.send",
  ]);

  const response = await call(app, "/api/v1/projects/proj_1", { token: alice.token });
  assert.equal(response.status, 200);
  assertHardeningHeaders(response);
  const body = await jsonBody(response);
  assert.deepEqual(body.project, {
    id: "proj_1",
    title: "proj_1",
    summary: null,
    status: "active",
    created_at: "2026-11-03T12:00:00.000Z",
    updated_at: null,
  });
  assert.deepEqual(body.capabilities, ["project.read", "message.read", "message.send"]);
});

test("send requires an Idempotency-Key", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const response = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    body: payload("no key"),
  });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
});

test("send rejects whitespace-only summary and text but accepts internal whitespace", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const rejected = [
    { key: "blank-summary-key", body: payload("body", { summary: " \t\n " }) },
    { key: "blank-text-key", body: payload("\r\n\t ", { summary: "summary" }) },
    { key: "ignorable-summary-key", body: payload("body", { summary: "\u200b" }) },
    { key: "ignorable-text-key", body: payload("\ufeff", { summary: "summary" }) },
  ];
  for (const { key, body } of rejected) {
    const response = await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": key },
      body,
    });
    assert.equal(response.status, 400);
    assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR");
  }
  // A rejected payload writes no message, idempotency record, blob, or audit row.
  for (const table of ["messages", "idempotency_keys", "body_objects", "audit_events"]) {
    const row = await fx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    assert.equal(row?.n, 0, table);
  }

  // Non-blank internal spaces and newlines remain valid and are stored as entered.
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["a b", "a b"],
    ["line1\nline2", "line1\nline2"],
  ];
  for (const [index, [summary, text]] of accepted.entries()) {
    const response = await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": `valid-whitespace-${index}` },
      body: payload(text, { summary }),
    });
    assert.equal(response.status, 201, JSON.stringify({ summary, text }));
  }
  const stored = await fx.db.all<{ summary: string }>(
    "SELECT summary FROM messages ORDER BY seq ASC",
  );
  assert.deepEqual(
    stored.map((row) => row.summary),
    ["a b", "line1\nline2"],
  );
});

test("send, list, get, body and read roundtrip", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const text = "hello over http";
  const sent = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "key-1" },
    body: payload(text),
  });
  assert.equal(sent.status, 201);
  assertHardeningHeaders(sent);
  const sentBody = await jsonBody(sent);
  assert.match(sentBody.message_id, /^msg_/);
  assert.equal(sentBody.project_id, "proj_1");
  assert.equal(sentBody.seq, 1);
  assert.equal(sentBody.body_state, "ready");
  assert.equal(sentBody.digest, digestOf(text));
  assert.match(sentBody.committed_at, /^\d{4}-\d{2}-\d{2}T/);
  const messageId = sentBody.message_id as string;

  const replay = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "key-1" },
    body: payload(text),
  });
  assert.equal(replay.status, 200);
  assert.equal((await jsonBody(replay)).message_id, messageId);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);

  const list = await call(app, "/api/v1/projects/proj_1/messages", { token: alice.token });
  assert.equal(list.status, 200);
  const listBody = await jsonBody(list);
  assert.equal(listBody.next_cursor, 1);
  assert.equal(listBody.messages.length, 1);
  // The HTML pager's internal probe must never reach the REST contract.
  assert.equal("hasMore" in listBody, false);
  assert.deepEqual(Object.keys(listBody).sort(), ["messages", "next_cursor"]);
  const listed = listBody.messages[0];
  assert.deepEqual(listed.sender, { id: "spk_alice", display_name: "spk_alice" });
  assert.equal(listed.message_id, messageId);
  assert.equal(listed.body_state, "ready");
  assert.equal(listed.reply_to_id, null);
  assert.equal("text" in listed, false);

  const detail = await call(app, `/api/v1/projects/proj_1/messages/${messageId}`, {
    token: alice.token,
  });
  assert.equal((await jsonBody(detail)).read_by.length, 0);

  const body = await call(app, `/api/v1/projects/proj_1/messages/${messageId}/body`, {
    token: alice.token,
  });
  assert.equal(body.status, 200);
  assert.deepEqual(await jsonBody(body), {
    message_id: messageId,
    text,
    compression: "none",
    digest: digestOf(text),
  });

  const read = await call(app, `/api/v1/projects/proj_1/messages/${messageId}/read`, {
    method: "POST",
    token: alice.token,
  });
  assert.equal(read.status, 200);
  const readBody = await jsonBody(read);
  assert.equal(readBody.message_id, messageId);
  assert.equal(readBody.speaker_id, "spk_alice");
  assert.match(readBody.read_at, /^\d{4}-\d{2}-\d{2}T/);

  const afterRead = await call(app, `/api/v1/projects/proj_1/messages/${messageId}`, {
    token: alice.token,
  });
  assert.deepEqual((await jsonBody(afterRead)).read_by, [
    { speaker_id: "spk_alice", read_at: readBody.read_at },
  ]);
});

test("errors use the exact envelope and a fresh request id", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");

  const first = await call(app, "/api/v1/projects/proj_missing", { token: alice.token });
  const second = await call(app, "/api/v1/projects/proj_missing", { token: alice.token });
  assert.equal(first.status, 404);
  assertHardeningHeaders(first);
  const body = await jsonBody(first);
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
  assert.equal(body.error.code, "NOT_FOUND");
  assert.match(body.error.request_id, /^req_[A-Za-z0-9_-]+$/);

  const other = await jsonBody(second);
  assert.notEqual(body.error.request_id, other.error.request_id);
});

test("malformed JSON is a validation error", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const response = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "key-1" },
    rawBody: "{not json",
  });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).error.code, "VALIDATION_ERROR");
});

test("cross-project and non-member references are NOT_FOUND", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  await fx.addMembership("proj_1", bob.speakerId);
  await fx.addProject("proj_2", bob.accountId);
  await fx.addMembership("proj_2", bob.speakerId);

  const sent = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "key-1" },
      body: payload("project one only"),
    }),
  );

  // Alice is not a member of project two.
  const aliceDetail = await call(app, "/api/v1/projects/proj_2", { token: alice.token });
  assert.equal(aliceDetail.status, 404);
  assert.equal((await jsonBody(aliceDetail)).error.code, "NOT_FOUND");
  assert.equal(
    (await call(app, "/api/v1/projects/proj_2/messages", { token: alice.token })).status,
    404,
  );

  // Bob is a member of both, but the message belongs to project one.
  for (const path of [
    `/api/v1/projects/proj_2/messages/${sent.message_id}`,
    `/api/v1/projects/proj_2/messages/${sent.message_id}/body`,
  ]) {
    const response = await call(app, path, { token: bob.token });
    assert.equal(response.status, 404);
    assert.equal((await jsonBody(response)).error.code, "NOT_FOUND");
  }
  const read = await call(app, `/api/v1/projects/proj_2/messages/${sent.message_id}/read`, {
    method: "POST",
    token: bob.token,
  });
  assert.equal(read.status, 404);
});

test("client-supplied sender and seq are rejected", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const spoofed = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "spoof-1" },
    body: payload("spoof", { speaker_id: "spk_evil", seq: 99 }),
  });
  assert.equal(spoofed.status, 400);
  assert.equal((await jsonBody(spoofed)).error.code, "VALIDATION_ERROR");

  const compressed = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "spoof-2" },
    body: payload("compress", { compression: "gzip" }),
  });
  assert.equal(compressed.status, 400);
  assert.equal((await jsonBody(compressed)).error.code, "VALIDATION_ERROR");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
});

test("digest mismatch is rejected before any write", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const response = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "bad-digest" },
    body: payload("real bytes", { body_digest: digestOf("other bytes") }),
  });
  assert.equal(response.status, 400);
  assert.equal((await jsonBody(response)).error.code, "INTEGRITY_MISMATCH");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);
});

test("request bodies over 64 KiB are rejected with 413", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const oversized = JSON.stringify(payload("x".repeat(70 * 1024)));
  const response = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "too-big" },
    rawBody: oversized,
  });
  assert.equal(response.status, 413);
  assert.equal((await jsonBody(response)).error.code, "REQUEST_TOO_LARGE");
});

test("unknown routes are 404 and wrong methods are 405 with Allow", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const unknown = await call(app, "/api/v1/unknown", { token: alice.token });
  assert.equal(unknown.status, 404);
  assert.equal((await jsonBody(unknown)).error.code, "NOT_FOUND");

  const health = await call(app, "/healthz", { method: "POST" });
  assert.equal(health.status, 405);
  assert.equal(health.headers.get("allow"), "GET");
  assert.equal((await jsonBody(health)).error.code, "NOT_FOUND");

  const project = await call(app, "/api/v1/projects/proj_1", {
    method: "DELETE",
    token: alice.token,
  });
  assert.equal(project.status, 405);
  assert.equal(project.headers.get("allow"), "GET");

  const read = await call(app, "/api/v1/projects/proj_1/messages/msg_x/read", {
    token: alice.token,
  });
  assert.equal(read.status, 405);
  assert.equal(read.headers.get("allow"), "POST");
});

test("tokens never appear in responses", async (t) => {  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  const sent = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "key-1" },
      body: payload("token check"),
    }),
  );

  const responses = await Promise.all([
    call(app, "/api/v1/me", { token: alice.token }),
    call(app, "/api/v1/projects", { token: alice.token }),
    call(app, "/api/v1/projects/proj_1", { token: alice.token }),
    call(app, "/api/v1/projects/proj_1/messages", { token: alice.token }),
    call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}`, { token: alice.token }),
    call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}/body`, { token: alice.token }),
    call(app, "/api/v1/projects/proj_1", { token: alice.token, method: "DELETE" }),
  ]);
  for (const response of responses) {
    const text = await response.text();
    assert.equal(text.includes(alice.token), false);
    assert.equal(text.includes(alice.token.slice(3)), false);
  }
});

test("request logging is sanitized and never carries query values or content", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const entries: RequestLogEntry[] = [];
  const app = createApp(fx.deps, { logger: (entry) => entries.push(entry) });
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const summary = "hidden summary";
  const text = "hidden body text";
  const sent = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "log-key" },
    body: payload(text, { summary }),
  });
  assert.equal(sent.status, 201);

  const query = "hidden search term";
  await call(
    app,
    `/api/v1/projects/proj_1/messages?q=${encodeURIComponent(query)}&limit=1`,
    { token: alice.token },
  );
  await call(app, "/healthz");
  await call(app, "/api/v1/me");
  await call(app, "/api/v1/projects/proj_missing", { token: alice.token });

  assert.equal(entries.length, 5);
  for (const entry of entries) {
    assert.match(entry.requestId, /^req_[A-Za-z0-9_-]+$/);
    assert.equal(typeof entry.durationMs, "number");
    assert.equal(entry.path.includes("?"), false);
    const serialized = JSON.stringify(entry);
    for (const secret of [alice.token, alice.token.slice(3), summary, text, query]) {
      assert.equal(serialized.includes(secret), false);
    }
  }

  const authenticated = entries[0];
  assert.equal(authenticated?.method, "POST");
  assert.equal(authenticated?.path, "/api/v1/projects/proj_1/messages");
  assert.equal(authenticated?.status, 201);
  assert.equal(authenticated?.errorCode, undefined);
  assert.equal(authenticated?.speakerId, alice.speakerId);
  assert.equal(authenticated?.accountId, alice.accountId);
  assert.equal(entries[1]?.path, "/api/v1/projects/proj_1/messages");

  const health = entries[2];
  assert.equal(health?.path, "/healthz");
  assert.equal(health?.speakerId, undefined);
  assert.equal(health?.accountId, undefined);

  const unauthenticated = entries[3];
  assert.equal(unauthenticated?.status, 401);
  assert.equal(unauthenticated?.errorCode, "UNAUTHENTICATED");
  assert.equal(unauthenticated?.speakerId, undefined);

  const missing = entries[4];
  assert.equal(missing?.status, 404);
  assert.equal(missing?.errorCode, "NOT_FOUND");
  assert.equal(missing?.speakerId, alice.speakerId);
});

test("read_by receipts are scoped to the message's project", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  for (const projectId of ["proj_1", "proj_2"]) {
    await fx.addProject(projectId, alice.accountId);
    await fx.addMembership(projectId, alice.speakerId);
    await fx.addMembership(projectId, bob.speakerId);
  }

  const sent1 = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "read-by-1" },
      body: payload("project one"),
    }),
  );
  const sent2 = await jsonBody(
    await call(app, "/api/v1/projects/proj_2/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "read-by-2" },
      body: payload("project two"),
    }),
  );

  // Direct rows model receipts that exist outside this request path.
  await fx.db.run(
    "INSERT INTO message_receipts (message_id, speaker_id, read_at) VALUES (?, ?, ?)",
    [sent1.message_id, "spk_alice", "2026-11-03T12:00:00.000Z"],
  );
  await fx.db.run(
    "INSERT INTO message_receipts (message_id, speaker_id, read_at) VALUES (?, ?, ?)",
    [sent2.message_id, "spk_bob", "2026-11-03T12:00:01.000Z"],
  );

  const first = await jsonBody(
    await call(app, `/api/v1/projects/proj_1/messages/${sent1.message_id}`, {
      token: bob.token,
    }),
  );
  assert.deepEqual(
    first.read_by.map((receipt: JsonObject) => receipt.speaker_id),
    ["spk_alice"],
  );

  const second = await jsonBody(
    await call(app, `/api/v1/projects/proj_2/messages/${sent2.message_id}`, {
      token: bob.token,
    }),
  );
  assert.deepEqual(
    second.read_by.map((receipt: JsonObject) => receipt.speaker_id),
    ["spk_bob"],
  );

  // A message in another project never resolves through this project scope.
  const crossProject = await call(
    app,
    `/api/v1/projects/proj_1/messages/${sent2.message_id}`,
    { token: bob.token },
  );
  assert.equal(crossProject.status, 404);
});

test("send authorization precedes body parsing and writes", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  const carol = await addActor(fx, "carol");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  await fx.addMembership("proj_1", carol.speakerId, ["project.read", "message.read"]);

  const nonMemberMalformed = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: bob.token,
    headers: { "idempotency-key": "denied-1" },
    rawBody: "{not json",
  });
  assert.equal(nonMemberMalformed.status, 404);
  assert.equal((await jsonBody(nonMemberMalformed)).error.code, "NOT_FOUND");

  const nonMemberForbiddenField = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: bob.token,
    headers: { "idempotency-key": "denied-2" },
    body: payload("spoof", { seq: 9 }),
  });
  assert.equal(nonMemberForbiddenField.status, 404);
  assert.equal((await jsonBody(nonMemberForbiddenField)).error.code, "NOT_FOUND");

  const noScopeMalformed = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: carol.token,
    headers: { "idempotency-key": "denied-3" },
    rawBody: "{not json",
  });
  assert.equal(noScopeMalformed.status, 403);
  assert.equal((await jsonBody(noScopeMalformed)).error.code, "FORBIDDEN");

  const authorizedMalformed = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "allowed" },
    rawBody: "{not json",
  });
  assert.equal(authorizedMalformed.status, 400);
  assert.equal((await jsonBody(authorizedMalformed)).error.code, "VALIDATION_ERROR");

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);
});

test("duplicate idempotency key with a changed payload maps to CONFLICT", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);

  const first = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "conflict-key" },
    body: payload("first payload"),
  });
  assert.equal(first.status, 201);

  const second = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "conflict-key" },
    body: payload("second payload"),
  });
  assert.equal(second.status, 409);
  assert.equal((await jsonBody(second)).error.code, "CONFLICT");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
});

test("expired bodies map to BODY_EXPIRED at the route", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  const sent = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "expire-key" },
      body: payload("will expire"),
    }),
  );
  await fx.expireMessage(sent.message_id);

  const body = await call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}/body`, {
    token: alice.token,
  });
  assert.equal(body.status, 410);
  assert.equal((await jsonBody(body)).error.code, "BODY_EXPIRED");

  const read = await call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}/read`, {
    method: "POST",
    token: alice.token,
  });
  assert.equal(read.status, 410);
  assert.equal((await jsonBody(read)).error.code, "BODY_EXPIRED");
});

test("corrupt stored bodies map to INTEGRITY_FAILURE at the route", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  const sent = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages", {
      method: "POST",
      token: alice.token,
      headers: { "idempotency-key": "corrupt-key" },
      body: payload("tamper target"),
    }),
  );

  const object = await fx.db.first<{ storage_key: string }>(
    `SELECT b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.message_id],
  );
  assert.ok(object?.storage_key);
  const bytes = await fx.blobs.get(object.storage_key);
  assert.ok(bytes);
  const tampered = bytes.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  await fx.blobs.put(object.storage_key, tampered);

  const body = await call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}/body`, {
    token: alice.token,
  });
  assert.equal(body.status, 500);
  assert.equal((await jsonBody(body)).error.code, "INTEGRITY_FAILURE");

  const read = await call(app, `/api/v1/projects/proj_1/messages/${sent.message_id}/read`, {
    method: "POST",
    token: alice.token,
  });
  assert.equal(read.status, 500);
  assert.equal((await jsonBody(read)).error.code, "INTEGRITY_FAILURE");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});
