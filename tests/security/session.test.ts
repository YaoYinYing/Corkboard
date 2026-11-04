import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createApp,
  type CreateAppOptions,
  type RequestLogEntry,
} from "../../src/app/handlers.ts";
import {
  DUMMY_PASSWORD_HASH,
  PASSWORD_HASH_BYTES,
  PASSWORD_KDF_ITERATIONS,
  PASSWORD_KDF_NAME,
  PASSWORD_SALT_BYTES,
  hashPassword,
  verifyPasswordHash,
} from "../../src/auth/password.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_PREFIX_LENGTH,
} from "../../src/service/sessions.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
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

async function withApp(
  t: { after(fn: () => void): void },
  options: CreateAppOptions = {},
): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return {
    fx,
    app: createApp(fx.deps, {
      // Tests that assert 429 inject their own small limiter.
      loginRateLimit: { perMinute: 600, burst: 100 },
      ...options,
    }),
  };
}

async function addPasswordAccount(
  fx: ServiceFixture,
  id: string,
  email: string,
  password: string,
  status = "active",
): Promise<void> {
  await fx.db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, email, await hashPassword(password), status, "2026-11-03T12:00:00.000Z"],
  );
}

function login(app: App, email: string, password: string): Promise<Response> {
  return call(app, "/api/v1/session", {
    method: "POST",
    body: { email, password },
  });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const [pair] = cookie.split(";");
    const separator = (pair ?? "").indexOf("=");
    if (separator <= 0) continue;
    if ((pair ?? "").slice(0, separator) === name) {
      return (pair ?? "").slice(separator + 1);
    }
  }
  return undefined;
}

function sessionToken(cookies: readonly string[]): string {
  const token = cookieValue(cookies, SESSION_COOKIE_NAME);
  assert.ok(token, "session cookie present");
  return token;
}

function csrfToken(cookies: readonly string[]): string {
  const token = cookieValue(cookies, CSRF_COOKIE_NAME);
  assert.ok(token, "csrf cookie present");
  return token;
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "")
    .join("; ");
}

async function loginCookies(app: App, email: string, password: string): Promise<string[]> {
  const response = await login(app, email, password);
  assert.equal(response.status, 200);
  return setCookies(response);
}

function hasAttribute(cookie: string, attribute: string): boolean {
  return cookie
    .split(";")
    .slice(1)
    .some((part) => part.trim().toLowerCase() === attribute.toLowerCase());
}

// --- Password KDF -----------------------------------------------------------

test("password hashes use the documented PBKDF2 format", async () => {
  const stored = await hashPassword("correct horse battery");
  const parts = stored.split("$");
  assert.equal(parts.length, 4);
  assert.equal(parts[0], PASSWORD_KDF_NAME);
  assert.equal(Number(parts[1]), PASSWORD_KDF_ITERATIONS);
  assert.equal(atob(parts[2] ?? "").length, PASSWORD_SALT_BYTES);
  assert.equal(atob(parts[3] ?? "").length, PASSWORD_HASH_BYTES);
  // A fresh salt makes two hashes of the same password different.
  assert.notEqual(stored, await hashPassword("correct horse battery"));
});

test("password verification round-trips and rejects wrong or unknown formats", async () => {
  const stored = await hashPassword("secret value");
  assert.equal(await verifyPasswordHash("secret value", stored), true);
  assert.equal(await verifyPasswordHash("wrong value", stored), false);
  assert.equal(await verifyPasswordHash("secret value", "scrypt$c2FsdA==$aGFzaA=="), false);
  assert.equal(await verifyPasswordHash("secret value", "unknown$1$a$b"), false);
  assert.equal(
    await verifyPasswordHash("secret value", `${ PASSWORD_KDF_NAME }$notanumber$a$b`),
    false,
  );
  // The dummy verifier performs real PBKDF2 work and never matches.
  assert.equal(await verifyPasswordHash("anything", DUMMY_PASSWORD_HASH), false);
});

// --- Session cookies and storage -------------------------------------------

test("login issues exactly two hardened cookies and no secret in the body", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_cookie", "cookie@example.test", "cookie password");

  const response = await login(app, "Cookie@Example.TEST", "cookie password");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const text = await response.clone().text();
  assert.deepEqual(JSON.parse(text), { account: { id: "acct_cookie", email: "cookie@example.test" } });

  const cookies = setCookies(response);
  assert.equal(cookies.length, 2);
  const sessionCookie = cookies.find((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`));
  const csrfCookie = cookies.find((cookie) => cookie.startsWith(`${CSRF_COOKIE_NAME}=`));
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);

  for (const cookie of [sessionCookie, csrfCookie]) {
    assert.ok(hasAttribute(cookie, "Secure"));
    assert.ok(hasAttribute(cookie, "SameSite=Strict"));
    assert.ok(hasAttribute(cookie, "Path=/"));
    assert.ok(hasAttribute(cookie, `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`));
  }
  assert.ok(hasAttribute(sessionCookie, "HttpOnly"));
  assert.equal(hasAttribute(csrfCookie, "HttpOnly"), false);

  const token = sessionToken(cookies);
  assert.match(token, /^cb_sess_[A-Za-z0-9_-]{43}$/);
  assert.match(csrfToken(cookies), /^[A-Za-z0-9_-]{43}$/);
  assert.equal(text.includes("cookie password"), false);
  assert.equal(text.includes(token), false);
  assert.equal(text.includes(csrfToken(cookies)), false);
});

test("the database stores only prefix and HMAC verifiers", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_store", "store@example.test", "store password");
  const cookies = await loginCookies(app, "store@example.test", "store password");
  const token = sessionToken(cookies);
  const csrf = csrfToken(cookies);

  const row = await fx.db.first<Record<string, unknown>>("SELECT * FROM sessions");
  assert.ok(row);
  assert.equal(row.account_id, "acct_store");
  assert.equal(row.token_prefix, token.slice(0, SESSION_PREFIX_LENGTH));
  assert.match(String(row.token_verifier), /^[0-9a-f]{64}$/);
  assert.match(String(row.csrf_verifier), /^[0-9a-f]{64}$/);
  assert.equal(row.revoked_at, null);
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(csrf), false);
  assert.equal(serialized.includes("store password"), false);
});

// --- Failure uniformity -----------------------------------------------------

test("unknown email, wrong password, inactive account and no-password account are uniform", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_active", "active@example.test", "right password");
  await addPasswordAccount(fx, "acct_off", "off@example.test", "right password", "suspended");
  await fx.addAccount("acct_nohash");
  await fx.db.run("UPDATE accounts SET email = ? WHERE id = ?", [
    "nohash@example.test",
    "acct_nohash",
  ]);

  const attempts: Array<[string, string]> = [
    ["missing@example.test", "any password"],
    ["active@example.test", "wrong password"],
    ["off@example.test", "right password"],
    ["nohash@example.test", "any password"],
  ];
  for (const [email, password] of attempts) {
    const response = await login(app, email, password);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("set-cookie"), null);
    const body = await jsonBody(response);
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.equal(body.error.message, "Authentication required");
  }
  assert.equal((await fx.db.all("SELECT id FROM sessions")).length, 0);
});

test("unknown and no-password accounts still run the verifier against the dummy hash", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_spy", "spy@example.test", "spy password");
  await fx.addAccount("acct_spy_nohash");
  await fx.db.run("UPDATE accounts SET email = ? WHERE id = ?", [
    "spynohash@example.test",
    "acct_spy_nohash",
  ]);

  const seen: string[] = [];
  fx.deps.passwordVerifier = async (_password: string, stored: string): Promise<boolean> => {
    seen.push(stored);
    return false;
  };

  assert.equal((await login(app, "unknown@example.test", "pw")).status, 401);
  assert.equal(seen[0], DUMMY_PASSWORD_HASH);

  assert.equal((await login(app, "spynohash@example.test", "pw")).status, 401);
  assert.equal(seen[1], DUMMY_PASSWORD_HASH);

  assert.equal((await login(app, "spy@example.test", "wrong")).status, 401);
  assert.notEqual(seen[2], DUMMY_PASSWORD_HASH);
  assert.match(seen[2] ?? "", new RegExp(`^${ PASSWORD_KDF_NAME }\\$`));
});

// --- Session validity -------------------------------------------------------

test("unknown, expired, idle and revoked sessions are rejected", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_valid", "valid@example.test", "valid password");
  const now = new Date("2026-11-03T12:00:00.000Z");
  fx.setNow(now);

  const unknown = "cb_sess_" + "A".repeat(43);
  const unknownResponse = await call(app, "/api/v1/session", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${unknown}` },
  });
  assert.equal(unknownResponse.status, 401);
  assert.equal((await jsonBody(unknownResponse)).error.code, "UNAUTHENTICATED");

  const cases: Array<[string, (sessionId: string) => Promise<void>]> = [
    [
      "expired",
      async () => {
        await fx.db.run("UPDATE sessions SET expires_at = ?", [now.toISOString()]);
      },
    ],
    [
      "idle boundary",
      async () => {
        await fx.db.run("UPDATE sessions SET last_seen_at = ?", [
          new Date(now.getTime() - SESSION_IDLE_MS).toISOString(),
        ]);
      },
    ],
    [
      "revoked",
      async () => {
        await fx.db.run("UPDATE sessions SET revoked_at = ?", [now.toISOString()]);
      },
    ],
  ];

  for (const [name, mutate] of cases) {
    const cookies = await loginCookies(app, "valid@example.test", "valid password");
    await mutate("");
    const response = await call(app, "/api/v1/session", {
      headers: { cookie: cookieHeader(cookies) },
    });
    assert.equal(response.status, 401, name);
    assert.equal((await jsonBody(response)).error.code, "UNAUTHENTICATED", name);
  }

  // One millisecond inside the idle window is still accepted and refreshes it.
  const fresh = await loginCookies(app, "valid@example.test", "valid password");
  await fx.db.run("UPDATE sessions SET last_seen_at = ?", [
    new Date(now.getTime() - SESSION_IDLE_MS + 1).toISOString(),
  ]);
  const inside = await call(app, "/api/v1/session", {
    headers: { cookie: cookieHeader(fresh) },
  });
  assert.equal(inside.status, 200);
  const refreshed = await fx.db.first<{ last_seen_at: string }>(
    "SELECT last_seen_at FROM sessions WHERE token_prefix = ?",
    [sessionToken(fresh).slice(0, SESSION_PREFIX_LENGTH)],
  );
  assert.equal(refreshed?.last_seen_at, now.toISOString());
});

// --- CSRF -------------------------------------------------------------------

test("logout requires the session and a matching CSRF header", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_csrf", "csrf@example.test", "csrf password");
  const cookies = await loginCookies(app, "csrf@example.test", "csrf password");
  const headers = { cookie: cookieHeader(cookies) };

  const missing = await call(app, "/api/v1/session", { method: "DELETE", headers });
  assert.equal(missing.status, 403);
  assert.equal((await jsonBody(missing)).error.code, "FORBIDDEN");

  const wrong = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { ...headers, [CSRF_HEADER_NAME]: "wrong-csrf-value" },
  });
  assert.equal(wrong.status, 403);
  assert.equal((await jsonBody(wrong)).error.code, "FORBIDDEN");

  // A failed CSRF check does not revoke; the session still reads.
  assert.equal((await call(app, "/api/v1/session", { headers })).status, 200);

  // No session at all is UNAUTHENTICATED even with a CSRF header.
  const noSession = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { [CSRF_HEADER_NAME]: csrfToken(cookies) },
  });
  assert.equal(noSession.status, 401);

  const logout = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { ...headers, [CSRF_HEADER_NAME]: csrfToken(cookies) },
  });
  assert.equal(logout.status, 204);
  assert.equal(await logout.text(), "");
  const cleared = setCookies(logout);
  assert.equal(cleared.length, 2);
  for (const cookie of cleared) {
    assert.ok(hasAttribute(cookie, "Max-Age=0"));
    assert.ok(hasAttribute(cookie, "Secure"));
    assert.ok(hasAttribute(cookie, "SameSite=Strict"));
  }
  assert.equal((await call(app, "/api/v1/session", { headers })).status, 401);
});

// --- Cross-surface isolation ------------------------------------------------

test("a session never authenticates a bearer route or the MCP endpoint", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_iso", "iso@example.test", "iso password");
  const cookies = await loginCookies(app, "iso@example.test", "iso password");
  const headers = { cookie: cookieHeader(cookies) };

  for (const path of ["/api/v1/me", "/api/v1/projects"]) {
    const response = await call(app, path, { headers });
    assert.equal(response.status, 401, path);
  }
  const mcp = await call(app, "/mcp", {
    method: "POST",
    headers: { ...headers, accept: "application/json, text/event-stream" },
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "1" } },
    },
  });
  assert.equal(mcp.status, 401);
  assert.equal(mcp.headers.get("mcp-session-id"), null);

  // The session token is not a bearer credential either.
  const asBearer = await call(app, "/api/v1/me", {
    headers: { authorization: `Bearer ${sessionToken(cookies)}` },
  });
  assert.equal(asBearer.status, 401);
});

// --- Abuse control ----------------------------------------------------------

test("login attempts are limited per hashed email with Retry-After", async (t) => {
  let now = 1_000_000;
  const { fx, app } = await withApp(t, {
    loginRateLimit: { perMinute: 60, burst: 2 },
    loginRateLimitNow: () => now,
  });
  await addPasswordAccount(fx, "acct_limit", "limit@example.test", "limit password");

  for (let index = 0; index < 2; index += 1) {
    const response = await login(app, "limit@example.test", "wrong password");
    assert.equal(response.status, 401);
  }
  const limited = await login(app, "limit@example.test", "wrong password");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "1");
  assert.equal(limited.headers.get("set-cookie"), null);
  const text = await limited.text();
  assert.equal(text.includes("limit@example.test"), false);
  assert.equal((JSON.parse(text) as JsonObject).error.code, "RATE_LIMITED");

  // A different email has an independent bucket.
  assert.equal((await login(app, "other@example.test", "wrong")).status, 401);

  // One token refills per second at 60/minute.
  now += 1000;
  assert.equal((await login(app, "limit@example.test", "wrong password")).status, 401);
});

// --- Logging ----------------------------------------------------------------

test("request logs never contain cookies, CSRF, tokens, passwords or emails", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const entries: RequestLogEntry[] = [];
  const app = createApp(fx.deps, {
    logger: (entry) => entries.push(entry),
    loginRateLimit: { perMinute: 600, burst: 100 },
  });
  await addPasswordAccount(fx, "acct_log", "log@example.test", "log password");

  const response = await login(app, "log@example.test", "log password");
  assert.equal(response.status, 200);
  const cookies = setCookies(response);
  const token = sessionToken(cookies);
  const csrf = csrfToken(cookies);
  const headers = { cookie: cookieHeader(cookies) };
  assert.equal((await call(app, "/api/v1/session", { headers })).status, 200);
  assert.equal(
    (await call(app, "/api/v1/session", {
      method: "DELETE",
      headers: { ...headers, [CSRF_HEADER_NAME]: csrf },
    })).status,
    204,
  );

  assert.equal(entries.length, 3);
  const serialized = JSON.stringify(entries);
  for (const secret of ["log password", "log@example.test", token, csrf, "cookie"]) {
    assert.equal(serialized.includes(secret), false, secret);
  }
  for (const entry of entries) {
    assert.equal(entry.path, "/api/v1/session");
    assert.equal(entry.method === "POST" || entry.method === "GET" || entry.method === "DELETE", true);
  }
});

test("GET session returns only the account and never tokens", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_get", "get@example.test", "get password");
  const cookies = await loginCookies(app, "get@example.test", "get password");
  const response = await call(app, "/api/v1/session", {
    headers: { cookie: cookieHeader(cookies) },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.deepEqual(JSON.parse(text), { account: { id: "acct_get", email: "get@example.test" } });
  assert.equal(text.includes(sessionToken(cookies)), false);
  assert.equal(text.includes(csrfToken(cookies)), false);
});
