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
  metricsConfigFromEnv,
} from "../../src/app/metrics.ts";
import { startServer } from "../../src/platforms/node/main.ts";
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

test("metrics env config is disabled when unset/empty and enforces the minimum", () => {
  assert.equal(metricsConfigFromEnv({}), undefined);
  assert.equal(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "" }), undefined);
  assert.deepEqual(metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: METRICS_TOKEN }), {
    token: METRICS_TOKEN,
  });
  assert.throws(
    () => metricsConfigFromEnv({ CORKBOARD_METRICS_TOKEN: "x".repeat(31) }),
    /CORKBOARD_METRICS_TOKEN must be at least 32 characters/,
  );
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
