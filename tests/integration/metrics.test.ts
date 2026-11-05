import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createApp,
  type CreateAppOptions,
  type RequestLogEntry,
} from "../../src/app/handlers.ts";
import {
  LATENCY_BUCKETS_MS,
  MetricsRegistry,
  metricsAuthorized,
  metricsConfigFromEnv,
} from "../../src/app/metrics.ts";
import { startServer, type RunningServer } from "../../src/platforms/node/main.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

// Test fixtures only; not deployment secrets. Each value is long enough to pass
// the documented minimum and is never written to a file or printed.
const METRICS_TOKEN = "metrics-test-token".padEnd(32, "x");
const WRONG_TOKEN = "wrong-metrics-token".padEnd(32, "y");

interface Actor {
  accountId: string;
  speakerId: string;
  credentialId: string;
  token: string;
}

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) body = JSON.stringify(options.body);
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

function metricsCall(app: App, token?: string): Promise<Response> {
  return call(app, "/metrics", token === undefined ? {} : { token });
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

async function addActor(fx: ServiceFixture, name: string): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token, credentialId } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, credentialId, token };
}

async function withApp(
  t: { after(fn: () => void): void },
  options: CreateAppOptions = {},
): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return { fx, app: createApp(fx.deps, options) };
}

async function startMetricsServer(
  t: { after(fn: () => void | Promise<void>): void },
  metricsToken: string,
): Promise<{ base: string; running: RunningServer }> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-metrics-server-"));
  const running = await startServer({
    env: {
      CORKBOARD_DATA_DIR: join(dir, "data"),
      CORKBOARD_ROOT_KEY: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      CORKBOARD_METRICS_TOKEN: metricsToken,
      PORT: "0",
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

function rawMcp(
  app: App,
  body: unknown,
  options: { token: string; sessionId?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    authorization: `Bearer ${options.token}`,
  };
  if (options.sessionId !== undefined) headers["mcp-session-id"] = options.sessionId;
  return app(new Request("http://localhost/mcp", { method: "POST", headers, body: JSON.stringify(body) }));
}

async function mcpSession(app: App, token: string): Promise<string> {
  const response = await rawMcp(
    app,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "metrics-test", version: "1.0.0" },
      },
    },
    { token },
  );
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId !== null && sessionId.length > 0);
  return sessionId;
}

function mcpTool(app: App, token: string, sessionId: string, id: number): Promise<Response> {
  return rawMcp(
    app,
    {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "corkboard_whoami", arguments: {} },
    },
    { token, sessionId },
  );
}

test("metrics is disabled by default: missing and wrong tokens both 404", async (t) => {
  const { app } = await withApp(t);

  for (const options of [{}, { token: METRICS_TOKEN }]) {
    const response = await metricsCall(app, options.token);
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    const body = await jsonBody(response);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
    assert.equal(body.error.code, "NOT_FOUND");
  }

  // Method is irrelevant while disabled: it still looks like an unknown route.
  const post = await call(app, "/metrics", {
    method: "POST",
    token: METRICS_TOKEN,
  });
  assert.equal(post.status, 404);
});

test("direct createApp treats empty/whitespace tokens as disabled and rejects short tokens", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());

  for (const token of ["", "   ", "\t\n"]) {
    const app = createApp(fx.deps, { metricsToken: token });
    const response = await metricsCall(app, METRICS_TOKEN);
    assert.equal(response.status, 404);
    assert.equal((await jsonBody(response)).error.code, "NOT_FOUND");
  }

  assert.throws(
    () => createApp(fx.deps, { metricsToken: "x".repeat(31) }),
    /CORKBOARD_METRICS_TOKEN must be at least 32 characters/,
  );
});

test("startServer treats a whitespace-only metrics token as disabled", async (t) => {
  const { base } = await startMetricsServer(t, "   ");

  const metrics = await fetch(`${base}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  assert.equal(metrics.status, 404);
  assert.equal(((await metrics.json()) as JsonObject).error.code, "NOT_FOUND");
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});

test("speaker tokens and query values cannot authorize metrics; refusals are identical", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const actor = await addActor(fx, "speaker_metrics");
  const disabledApp = createApp(fx.deps);
  const enabledApp = createApp(fx.deps, { metricsToken: METRICS_TOKEN });

  const responses = [
    await metricsCall(disabledApp, METRICS_TOKEN),
    await metricsCall(enabledApp),
    await metricsCall(enabledApp, WRONG_TOKEN),
    await metricsCall(enabledApp, actor.token),
    await call(enabledApp, `/metrics?token=${encodeURIComponent(METRICS_TOKEN)}`),
  ];

  const normalizedBodies: JsonObject[] = [];
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(response.headers.get("www-authenticate"), null);
    const body = await jsonBody(response);
    assert.deepEqual(Object.keys(body.error).sort(), ["code", "message", "request_id"]);
    assert.match(body.error.request_id, /^req_/);
    normalizedBodies.push({ error: { code: body.error.code, message: body.error.message } });
  }
  for (const body of normalizedBodies) assert.deepEqual(body, normalizedBodies[0]);
});

test("adversarial unknown paths collapse to one label without IDs or queries", async (t) => {
  const { app } = await withApp(t, { metricsToken: METRICS_TOKEN });
  const queryValue = "query" + "-value";
  const paths = [
    `/nope/proj_secret?token=${queryValue}`,
    "/api/v1/projects/proj_secret/messages/msg_secret/body/extra",
    "/api/v1/projects/proj_secret/messages/msg_secret/unknown-action",
    "/api/v1/proj_secret/%2e%2e/encoded-segment",
  ];
  for (const path of paths) {
    assert.equal((await call(app, path)).status, 404);
  }

  const snapshot = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  // The snapshot request itself is recorded after the snapshot is built.
  assert.deepEqual(snapshot.routes, [{ route: "unknown", count: paths.length }]);
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    "proj_secret",
    "msg_secret",
    queryValue,
    "%2e",
    "encoded-segment",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `snapshot leaked ${forbidden}`);
  }
});

test("metricsAuthorized hashes and compares fixed-length values", async () => {
  assert.equal(await metricsAuthorized(`Bearer ${METRICS_TOKEN}`, METRICS_TOKEN), true);
  assert.equal(await metricsAuthorized(`Bearer ${WRONG_TOKEN}`, METRICS_TOKEN), false);
  assert.equal(await metricsAuthorized(`Bearer ${"x".repeat(100_000)}`, METRICS_TOKEN), false);
  assert.equal(await metricsAuthorized(`bearer ${METRICS_TOKEN}`, METRICS_TOKEN), false);
  assert.equal(await metricsAuthorized(null, METRICS_TOKEN), false);
});

test("enabled metrics requires the exact bearer token and never echoes it", async (t) => {
  const entries: RequestLogEntry[] = [];
  const { app } = await withApp(t, {
    metricsToken: METRICS_TOKEN,
    logger: (entry) => entries.push(entry),
  });

  assert.equal((await metricsCall(app)).status, 404);
  assert.equal((await metricsCall(app, WRONG_TOKEN)).status, 404);
  assert.equal((await metricsCall(app, METRICS_TOKEN.slice(0, -1))).status, 404);
  const lowercaseScheme = await call(app, "/metrics", {
    headers: { authorization: `bearer ${METRICS_TOKEN}` },
  });
  assert.equal(lowercaseScheme.status, 404);

  const response = await metricsCall(app, METRICS_TOKEN);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  const raw = await response.text();
  assert.equal(raw.includes(METRICS_TOKEN), false);
  assert.equal(raw.includes(WRONG_TOKEN), false);
  const snapshot = JSON.parse(raw) as JsonObject;
  assert.deepEqual(Object.keys(snapshot).sort(), [
    "errors",
    "latency_ms",
    "queue_to_commit_ms",
    "requests",
    "routes",
    "statuses",
  ]);

  // The request log carries no token either.
  const logged = JSON.stringify(entries);
  assert.equal(logged.includes(METRICS_TOKEN), false);
  assert.equal(logged.includes(WRONG_TOKEN), false);
  assert.equal(entries.some((entry) => entry.path === "/metrics"), true);
});

test("counters cover REST success/error, 429, and MCP initialize/tool requests", async (t) => {
  const { fx, app } = await withApp(t, {
    metricsToken: METRICS_TOKEN,
    rateLimit: { perMinute: 60, burst: 4 },
    rateLimitNow: () => 1_000_000,
  });
  const actor = await addActor(fx, "counters");
  await fx.addProject("proj_counters", actor.accountId);
  await fx.addMembership("proj_counters", actor.speakerId);

  // Four allowed authenticated requests: one success, one error, MCP init, MCP tool.
  assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 200);
  const missing = await call(app, "/api/v1/projects/proj_missing", { token: actor.token });
  assert.equal(missing.status, 404);
  const sessionId = await mcpSession(app, actor.token);
  const tool = await mcpTool(app, actor.token, sessionId, 2);
  assert.equal(tool.status, 200);

  // The bucket is now empty; the fifth authenticated request is 429.
  const limited = await call(app, "/api/v1/me", { token: actor.token });
  assert.equal(limited.status, 429);
  assert.equal((await jsonBody(limited)).error.code, "RATE_LIMITED");

  const snapshot = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  assert.deepEqual(snapshot.requests, { total: 5 });
  const routes = new Map<string, number>(
    (snapshot.routes as JsonObject[]).map((row) => [row.route as string, row.count as number]),
  );
  assert.equal(routes.get("/api/v1/me"), 2);
  assert.equal(routes.get("/api/v1/projects/:projectId"), 1);
  assert.equal(routes.get("/mcp"), 2);
  for (const route of routes.keys()) {
    assert.equal(route.includes("proj_missing"), false);
    assert.equal(route.includes("proj_counters"), false);
    assert.equal(route.includes("msg_"), false);
  }

  const statuses = new Map<number, number>(
    (snapshot.statuses as JsonObject[]).map((row) => [row.status as number, row.count as number]),
  );
  assert.deepEqual([...statuses.entries()].sort(([a], [b]) => a - b), [
    [200, 3],
    [404, 1],
    [429, 1],
  ]);

  const errors = new Map<string, number>(
    (snapshot.errors as JsonObject[]).map((row) => [row.code as string, row.count as number]),
  );
  assert.equal(errors.get("NOT_FOUND"), 1);
  assert.equal(errors.get("RATE_LIMITED"), 1);

  assert.equal(snapshot.latency_ms.count, 5);
  const buckets = snapshot.latency_ms.buckets as JsonObject[];
  assert.equal(buckets.length, LATENCY_BUCKETS_MS.length + 1);
  assert.equal(buckets[buckets.length - 1]?.le_ms, null);
  assert.equal(buckets[buckets.length - 1]?.count, 5);
});

test("queue-to-commit buckets are cumulative and boundary-deterministic", () => {
  const registry = new MetricsRegistry();
  const samples = [0, 5, 6, 25, 26, 10000, 10001];
  for (const sample of samples) registry.recordQueueToCommit(sample);

  const snapshot = registry.snapshot();
  assert.equal(snapshot.requests.total, 0);
  assert.equal(snapshot.queue_to_commit_ms.count, samples.length);
  assert.equal(
    snapshot.queue_to_commit_ms.sum,
    samples.reduce((sum, value) => sum + value, 0),
  );
  assert.deepEqual(
    snapshot.queue_to_commit_ms.buckets.map((bucket) => bucket.le_ms),
    [...LATENCY_BUCKETS_MS, null],
  );
  assert.deepEqual(
    snapshot.queue_to_commit_ms.buckets.map((bucket) => bucket.count),
    [2, 4, 5, 5, 5, 5, 5, 5, 5, 6, 7],
  );

  // Negative and non-finite samples cannot corrupt the cumulative buckets.
  registry.recordQueueToCommit(-1);
  registry.recordQueueToCommit(Number.NaN);
  assert.equal(registry.snapshot().queue_to_commit_ms.count, samples.length + 1);
});

test("queue-to-commit records real finalizations only and starts empty", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  // A ticking server clock produces a non-zero provisional-to-commit delay.
  let tick = 0;
  const base = Date.parse("2026-11-03T12:00:00.000Z");
  fx.deps.now = () => new Date(base + (tick += 1000));
  const app = createApp(fx.deps, { metricsToken: METRICS_TOKEN });
  const actor = await addActor(fx, "queue");
  await fx.addProject("proj_queue", actor.accountId);
  await fx.addMembership("proj_queue", actor.speakerId);

  const empty = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  assert.deepEqual(empty.queue_to_commit_ms, {
    count: 0,
    sum: 0,
    buckets: [...LATENCY_BUCKETS_MS.map((le_ms) => ({ le_ms, count: 0 })), { le_ms: null, count: 0 }],
  });

  const payload = {
    summary: "queue sample",
    type: "request",
    language: "en",
    text: "queue sample body",
    body_digest: `sha256:${await sha256("queue sample body")}`,
  };
  const first = await call(app, "/api/v1/projects/proj_queue/messages", {
    method: "POST",
    token: actor.token,
    headers: { "idempotency-key": "queue-1" },
    body: payload,
  });
  assert.equal(first.status, 201);

  // Replaying the same idempotency key is not a second finalization.
  const replay = await call(app, "/api/v1/projects/proj_queue/messages", {
    method: "POST",
    token: actor.token,
    headers: { "idempotency-key": "queue-1" },
    body: payload,
  });
  assert.equal(replay.status, 200);

  const sessionId = await mcpSession(app, actor.token);
  const mcpSend = await rawMcp(
    app,
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "corkboard_send_message",
        arguments: {
          project_id: "proj_queue",
          summary: "mcp queue sample",
          type: "request",
          language: "en",
          text: "mcp queue body",
        },
      },
    },
    { token: actor.token, sessionId },
  );
  assert.equal(mcpSend.status, 200);

  const snapshot = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  const queue = snapshot.queue_to_commit_ms as JsonObject;
  assert.equal(queue.count, 2);
  assert.equal(queue.sum > 0, true);
  const buckets = queue.buckets as JsonObject[];
  assert.equal(buckets.length, LATENCY_BUCKETS_MS.length + 1);
  assert.equal(buckets[buckets.length - 1]?.le_ms, null);
  assert.equal(buckets[buckets.length - 1]?.count, queue.count);
  for (let index = 1; index < buckets.length; index += 1) {
    assert.ok((buckets[index]?.count as number) >= (buckets[index - 1]?.count as number));
  }
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [payload.summary, payload.text, "proj_queue", actor.token]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test("latency buckets are cumulative and boundary-deterministic", () => {
  const registry = new MetricsRegistry();
  const samples = [0, 5, 6, 25, 26, 10000, 10001];
  for (const sample of samples) {
    registry.recordRequest("/healthz", 200, undefined, sample);
  }

  const snapshot = registry.snapshot();
  assert.equal(snapshot.requests.total, samples.length);
  assert.equal(snapshot.latency_ms.count, samples.length);
  assert.equal(snapshot.latency_ms.sum, samples.reduce((sum, value) => sum + value, 0));

  // Cumulative `le` counts: 5ms includes 0 and 5; 25ms also includes 6 and 25,
  // and the final `+Inf` bucket includes everything above 10000.
  const expected = [2, 4, 5, 5, 5, 5, 5, 5, 5, 6, 7];
  assert.deepEqual(
    snapshot.latency_ms.buckets.map((bucket) => bucket.count),
    expected,
  );
  assert.deepEqual(
    snapshot.latency_ms.buckets.map((bucket) => bucket.le_ms),
    [...LATENCY_BUCKETS_MS, null],
  );
});

test("injected clock makes app-level latency buckets deterministic", async (t) => {
  const times = [1000, 1007, 2000, 2030, 3000, 3000];
  const { app } = await withApp(t, {
    metricsToken: METRICS_TOKEN,
    metricsNow: () => times.shift() ?? 3000,
  });

  assert.equal((await call(app, "/healthz")).status, 200);
  assert.equal((await call(app, "/healthz")).status, 200);

  const snapshot = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  // The snapshot excludes the request that produced it.
  assert.equal(snapshot.latency_ms.count, 2);
  assert.equal(snapshot.latency_ms.sum, 37);
  const counts = (snapshot.latency_ms.buckets as JsonObject[]).map(
    (bucket) => bucket.count as number,
  );
  assert.deepEqual(counts, [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
});

test("snapshot contains no content, tokens, or object IDs and totals agree", async (t) => {
  const { fx, app } = await withApp(t, { metricsToken: METRICS_TOKEN });
  const actor = await addActor(fx, "privacy");
  await fx.addProject("proj_private_123", actor.accountId);
  await fx.addMembership("proj_private_123", actor.speakerId);

  const summary = "hidden metric summary";
  const text = "hidden metric body";
  const sent = await call(app, "/api/v1/projects/proj_private_123/messages", {
    method: "POST",
    token: actor.token,
    headers: { "idempotency-key": "metrics-privacy" },
    body: {
      summary,
      type: "request",
      language: "en",
      text,
      body_digest: `sha256:${await sha256(text)}`,
    },
  });
  assert.equal(sent.status, 201);
  const messageId = (await jsonBody(sent)).message_id as string;
  assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 200);

  const snapshot = await jsonBody(await metricsCall(app, METRICS_TOKEN));
  const serialized = JSON.stringify(snapshot);
  for (const forbidden of [
    actor.token,
    actor.token.slice(3),
    METRICS_TOKEN,
    summary,
    text,
    "proj_private_123",
    actor.speakerId,
    actor.accountId,
    actor.credentialId,
    messageId,
  ]) {
    assert.equal(serialized.includes(forbidden), false, `snapshot leaked ${forbidden}`);
  }

  const total = snapshot.requests.total as number;
  const sum = (rows: JsonObject[], key: string): number =>
    rows.reduce((accumulator, row) => accumulator + (row[key] as number), 0);
  assert.equal(sum(snapshot.routes as JsonObject[], "count"), total);
  assert.equal(sum(snapshot.statuses as JsonObject[], "count"), total);
  assert.equal(sum(snapshot.errors as JsonObject[], "count") <= total, true);
  assert.equal(snapshot.latency_ms.count, total);
  const buckets = snapshot.latency_ms.buckets as JsonObject[];
  assert.equal(buckets[buckets.length - 1]?.count, total);
  for (let index = 1; index < buckets.length; index += 1) {
    assert.ok((buckets[index]?.count as number) >= (buckets[index - 1]?.count as number));
  }
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

test("metrics env config is disabled when unset/empty/whitespace and enforces the minimum", () => {
  assert.equal(metricsConfigFromEnv({}), undefined);
  assert.equal(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "" }), undefined);
  assert.equal(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "   " }), undefined);
  assert.equal(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "\t\n" }), undefined);
  assert.deepEqual(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: METRICS_TOKEN }), {
    token: METRICS_TOKEN,
  });
  assert.throws(
    () => metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "x".repeat(31) }),
    /CORKBOARD_METRICS_TOKEN must be at least 32 characters/,
  );
});

test("adapter-level 413 is counted once under the fixed route label", async (t) => {
  const { base } = await startMetricsServer(t, METRICS_TOKEN);

  // A declared body over 64 KiB is rejected by the adapter before the core.
  const response = await fetch(`${base}/api/v1/projects/proj_secret/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "adapter-413",
    },
    body: new Uint8Array(70 * 1024),
  });
  assert.equal(response.status, 413);
  assert.equal(((await response.json()) as JsonObject).error.code, "REQUEST_TOO_LARGE");

  const metrics = await fetch(`${base}/metrics`, {
    headers: { authorization: `Bearer ${METRICS_TOKEN}` },
  });
  assert.equal(metrics.status, 200);
  const snapshot = (await metrics.json()) as JsonObject;
  assert.deepEqual(snapshot.requests, { total: 1 });
  assert.deepEqual(snapshot.routes, [
    { route: "/api/v1/projects/:projectId/messages", count: 1 },
  ]);
  assert.deepEqual(snapshot.statuses, [{ status: 413, count: 1 }]);
  assert.deepEqual(snapshot.errors, [{ code: "REQUEST_TOO_LARGE", count: 1 }]);
  assert.equal(JSON.stringify(snapshot).includes("proj_secret"), false);
});

test("a too-short metrics token fails startup before creating the data directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-metrics-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");

  await assert.rejects(
    startServer({
      env: {
        CORKBOARD_DATA_DIR: dataDir,
        CORKBOARD_METRICS_TOKEN: "too-short",
      },
    }),
    /CORKBOARD_METRICS_TOKEN must be at least 32 characters/,
  );
  assert.equal(existsSync(dataDir), false);
});

test("/metrics and healthz do not consume credential rate-limit buckets", async (t) => {
  const { fx, app } = await withApp(t, {
    metricsToken: METRICS_TOKEN,
    rateLimit: { perMinute: 60, burst: 1 },
    rateLimitNow: () => 1_000_000,
  });
  const actor = await addActor(fx, "operator");

  for (let index = 0; index < 5; index += 1) {
    assert.equal((await metricsCall(app, METRICS_TOKEN)).status, 200);
    assert.equal((await call(app, "/healthz")).status, 200);
  }

  assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 200);
  assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 429);
  // Operator access still works after the credential bucket is exhausted.
  assert.equal((await metricsCall(app, METRICS_TOKEN)).status, 200);
});
