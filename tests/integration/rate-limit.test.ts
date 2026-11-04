import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, type CreateAppOptions } from "../../src/app/handlers.ts";
import {
  DEFAULT_RATE_LIMIT_BURST,
  DEFAULT_RATE_LIMIT_PER_MINUTE,
  RateLimiter,
  rateLimitConfigFromEnv,
} from "../../src/app/rate-limit.ts";
import { startServer } from "../../src/platforms/node/main.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

interface Actor {
  token: string;
  credentialId: string;
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
  return { token, credentialId };
}

async function withApp(
  t: { after(fn: () => void): void },
  options: CreateAppOptions = {},
): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return { fx, app: createApp(fx.deps, options) };
}

function mcpInitialize(app: App, token: string): Promise<Response> {
  return call(app, "/mcp", {
    method: "POST",
    token,
    headers: { accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "rate-limit-test", version: "1.0.0" },
      },
    },
  });
}

test("burst allows capacity, then 429 with Retry-After, and refills", async (t) => {
  let now = 1_000_000;
  const { fx, app } = await withApp(t, {
    rateLimit: { perMinute: 60, burst: 3 },
    rateLimitNow: () => now,
  });
  const actor = await addActor(fx, "burst");

  for (let index = 0; index < 3; index += 1) {
    const response = await call(app, "/api/v1/me", { token: actor.token });
    assert.equal(response.status, 200);
  }

  const limited = await call(app, "/api/v1/me", { token: actor.token });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(limited.headers.get("cache-control"), "no-store");
  const body = await jsonBody(limited);
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.match(body.error.request_id, /^req_/);

  // One token refills per second at 60/minute.
  now += 1000;
  const refilled = await call(app, "/api/v1/me", { token: actor.token });
  assert.equal(refilled.status, 200);
});

test("credentials have independent buckets", async (t) => {
  const { fx, app } = await withApp(t, {
    rateLimit: { perMinute: 60, burst: 1 },
    rateLimitNow: () => 1_000_000,
  });
  const a = await addActor(fx, "isolation_a");
  const b = await addActor(fx, "isolation_b");

  assert.equal((await call(app, "/api/v1/me", { token: a.token })).status, 200);
  assert.equal((await call(app, "/api/v1/me", { token: a.token })).status, 429);
  assert.equal((await call(app, "/api/v1/me", { token: b.token })).status, 200);
});

test("REST and MCP share the credential bucket; over-limit MCP creates no session", async (t) => {
  const { fx, app } = await withApp(t, {
    rateLimit: { perMinute: 60, burst: 1 },
    rateLimitNow: () => 1_000_000,
  });
  const a = await addActor(fx, "shared");
  const b = await addActor(fx, "shared_other");

  // REST consumes the only token for this credential.
  assert.equal((await call(app, "/api/v1/me", { token: a.token })).status, 200);

  const limited = await mcpInitialize(app, a.token);
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(limited.headers.get("cache-control"), "no-store");
  assert.equal(limited.headers.get("mcp-session-id"), null);
  const body = await jsonBody(limited);
  assert.equal(body.error.code, "RATE_LIMITED");
  assert.match(body.error.request_id, /^req_/);
  const raw = JSON.stringify(body);
  assert.equal(raw.includes(a.token), false);

  // A different credential is unaffected and can initialize a real session.
  const ok = await mcpInitialize(app, b.token);
  assert.equal(ok.status, 200);
  assert.notEqual(ok.headers.get("mcp-session-id"), null);
});

test("perMinute 0 disables limiting", async (t) => {
  const { fx, app } = await withApp(t, {
    rateLimit: { perMinute: 0, burst: 1 },
    rateLimitNow: () => 1_000_000,
  });
  const actor = await addActor(fx, "disabled");
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 200);
  }
});

test("env configuration defaults, bounds, and invalid values", () => {
  assert.deepEqual(rateLimitConfigFromEnv({}), {
    perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
    burst: DEFAULT_RATE_LIMIT_BURST,
  });
  assert.deepEqual(rateLimitConfigFromEnv({ CORKBOARD_RATE_LIMIT_PER_MINUTE: "0" }), {
    perMinute: 0,
    burst: DEFAULT_RATE_LIMIT_BURST,
  });
  assert.deepEqual(
    rateLimitConfigFromEnv({
      CORKBOARD_RATE_LIMIT_PER_MINUTE: "1",
      CORKBOARD_RATE_LIMIT_BURST: "1",
    }),
    { perMinute: 1, burst: 1 },
  );
  assert.deepEqual(
    rateLimitConfigFromEnv({
      CORKBOARD_RATE_LIMIT_PER_MINUTE: "600",
      CORKBOARD_RATE_LIMIT_BURST: "1000",
    }),
    { perMinute: 600, burst: 1000 },
  );

  for (const raw of ["-1", "1.5", "abc", "", " 5", "1e3"]) {
    assert.throws(
      () => rateLimitConfigFromEnv({ CORKBOARD_RATE_LIMIT_PER_MINUTE: raw }),
      /CORKBOARD_RATE_LIMIT_PER_MINUTE must be an integer 0-/,
    );
  }
  for (const raw of ["0", "1001", "-1", "abc", ""]) {
    assert.throws(
      () => rateLimitConfigFromEnv({ CORKBOARD_RATE_LIMIT_BURST: raw }),
      /CORKBOARD_RATE_LIMIT_BURST must be an integer 1-1000/,
    );
  }
});

test("invalid limiter env fails startup before creating the data directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-ratelimit-startup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  await assert.rejects(
    startServer({
      env: {
        CORKBOARD_DATA_DIR: dataDir,
        CORKBOARD_RATE_LIMIT_BURST: "0",
      },
    }),
    /CORKBOARD_RATE_LIMIT_BURST must be an integer 1-1000/,
  );
  assert.equal(existsSync(dataDir), false);
});

test("429 discloses no secret or content; healthz and unauthenticated calls are not keyed", async (t) => {
  const { fx, app } = await withApp(t, {
    rateLimit: { perMinute: 60, burst: 1 },
    rateLimitNow: () => 1_000_000,
  });
  const actor = await addActor(fx, "leak");

  // Unauthenticated attempts never create or consume a credential bucket.
  for (let index = 0; index < 5; index += 1) {
    const response = await call(app, "/api/v1/me");
    assert.equal(response.status, 401);
  }

  assert.equal((await call(app, "/api/v1/me", { token: actor.token })).status, 200);
  const limited = await call(app, "/api/v1/me", { token: actor.token });
  assert.equal(limited.status, 429);
  const text = await limited.text();
  assert.equal(text.includes(actor.token), false);
  assert.equal(text.toLowerCase().includes("bearer"), false);
  const parsed = JSON.parse(text) as JsonObject;
  assert.deepEqual(Object.keys(parsed.error).sort(), ["code", "message", "request_id"]);
  assert.equal(parsed.error.code, "RATE_LIMITED");
  assert.equal(parsed.error.message, "Too many requests");

  assert.equal((await call(app, "/healthz")).status, 200);
});

test("bucket map stays bounded and evicts idle entries", () => {
  let now = 1_000_000;
  const limited = new RateLimiter(
    { perMinute: 60, burst: 1 },
    { now: () => now, maxKeys: 2, idleMs: 1000 },
  );

  assert.equal(limited.check("a").allowed, true);
  assert.equal(limited.check("b").allowed, true);
  // More credentials than the cap are accepted, but the map does not grow.
  for (const key of ["c", "d", "e"]) {
    assert.equal(limited.check(key).allowed, true);
  }
  assert.equal(limited.size, 2);

  // Idle entries are swept on a later call once the idle window has elapsed.
  now += 1000;
  assert.equal(limited.check("f").allowed, true);
  assert.equal(limited.size, 1);

  // Disabled limiting tracks nothing.
  const disabled = new RateLimiter({ perMinute: 0, burst: 1 }, { now: () => now });
  assert.equal(disabled.check("a").allowed, true);
  assert.equal(disabled.size, 0);
});

test("limiter constructor rejects out-of-range configuration", () => {
  assert.throws(() => new RateLimiter({ perMinute: -1, burst: 1 }), /perMinute/);
  assert.throws(() => new RateLimiter({ perMinute: 60, burst: 0 }), /burst/);
  assert.throws(() => new RateLimiter({ perMinute: 60, burst: 1001 }), /burst/);
  assert.throws(
    () => new RateLimiter({ perMinute: 60, burst: 1 }, { maxKeys: 0 }),
    /maxKeys/,
  );
  assert.throws(
    () => new RateLimiter({ perMinute: 60, burst: 1 }, { idleMs: 0 }),
    /idleMs/,
  );
});
