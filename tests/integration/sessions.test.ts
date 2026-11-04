import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { scryptSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApp, type CreateAppOptions } from "../../src/app/handlers.ts";
import {
  PASSWORD_KDF_NAME,
  hashPassword,
} from "../../src/auth/password.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import { nodePasswordVerifier } from "../../src/platforms/node/password.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_NAME,
  SESSION_IDLE_MS,
  SESSION_PREFIX_LENGTH,
} from "../../src/service/sessions.ts";
import type { ServiceDeps } from "../../src/service/auth.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));

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
): Promise<void> {
  await fx.db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    [id, email, await hashPassword(password), "2026-11-03T12:00:00.000Z"],
  );
}

function login(app: App, email: string, password: string): Promise<Response> {
  return call(app, "/api/v1/session", { method: "POST", body: { email, password } });
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return undefined;
}

function sessionToken(cookies: readonly string[]): string {
  const token = cookieValue(cookies, SESSION_COOKIE_NAME);
  assert.ok(token);
  return token;
}

function csrfToken(cookies: readonly string[]): string {
  const token = cookieValue(cookies, CSRF_COOKIE_NAME);
  assert.ok(token);
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

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-session-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(args: string[], env: Record<string, string>): void {
  execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });
}

async function openDeps(dataDir: string): Promise<{ db: Awaited<ReturnType<typeof openSqliteDatabase>>; deps: ServiceDeps }> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  const deps: ServiceDeps = {
    db,
    blobs: new MemoryBlobStore(),
    keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
    pepper: crypto.getRandomValues(new Uint8Array(32)),
    serviceId: "svc_test",
    now: () => new Date(),
  };
  return { db, deps };
}

test("bootstrap owner password signs in, reads the session, logs out, and cannot be replayed", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  const password = "bootstrap owner password";
  run(["bootstrap-owner", "--email", "Owner@Example.TEST"], {
    CORKBOARD_DATA_DIR: dataDir,
    CORKBOARD_BOOTSTRAP_PASSWORD: password,
  });

  const { db, deps } = await openDeps(dataDir);
  t.after(() => db.close());
  const app = createApp(deps, { loginRateLimit: { perMinute: 600, burst: 100 } });

  const account = await db.first<{ id: string; password_hash: string | null }>(
    "SELECT id, password_hash FROM accounts WHERE email = ?",
    ["owner@example.test"],
  );
  assert.ok(account);
  assert.match(account.password_hash ?? "", new RegExp(`^${ PASSWORD_KDF_NAME }\\$`));

  const loginResponse = await login(app, "owner@example.test", password);
  assert.equal(loginResponse.status, 200);
  assert.deepEqual(await jsonBody(loginResponse), {
    account: { id: account.id, email: "owner@example.test" },
  });
  const cookies = setCookies(loginResponse);
  const headers = { cookie: cookieHeader(cookies) };

  const current = await call(app, "/api/v1/session", { headers });
  assert.equal(current.status, 200);
  assert.deepEqual(await jsonBody(current), {
    account: { id: account.id, email: "owner@example.test" },
  });

  const logout = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { ...headers, [CSRF_HEADER_NAME]: csrfToken(cookies) },
  });
  assert.equal(logout.status, 204);

  const reuse = await call(app, "/api/v1/session", { headers });
  assert.equal(reuse.status, 401);
  const replayLogout = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { ...headers, [CSRF_HEADER_NAME]: csrfToken(cookies) },
  });
  assert.equal(replayLogout.status, 401);

  const rows = await db.all<{ revoked_at: string | null }>("SELECT revoked_at FROM sessions");
  assert.equal(rows.length, 1);
  assert.notEqual(rows[0]?.revoked_at, null);
});

test("two sessions are independent and logout revokes only the presented one", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_two", "two@example.test", "two password");

  const first = await loginCookies(app, "two@example.test", "two password");
  const second = await loginCookies(app, "two@example.test", "two password");
  assert.notEqual(sessionToken(first), sessionToken(second));

  assert.equal(
    (await call(app, "/api/v1/session", { headers: { cookie: cookieHeader(first) } })).status,
    200,
  );
  assert.equal(
    (await call(app, "/api/v1/session", { headers: { cookie: cookieHeader(second) } })).status,
    200,
  );

  const logout = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { cookie: cookieHeader(first), [CSRF_HEADER_NAME]: csrfToken(first) },
  });
  assert.equal(logout.status, 204);

  assert.equal(
    (await call(app, "/api/v1/session", { headers: { cookie: cookieHeader(first) } })).status,
    401,
  );
  assert.equal(
    (await call(app, "/api/v1/session", { headers: { cookie: cookieHeader(second) } })).status,
    200,
  );
  const rows = await fx.db.all<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM sessions ORDER BY created_at ASC",
  );
  assert.equal(rows.filter((row) => row.revoked_at !== null).length, 1);
});

test("idle and absolute lifetime boundaries are enforced", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_time", "time@example.test", "time password");
  const start = new Date("2026-11-03T12:00:00.000Z");
  fx.setNow(start);

  const cookies = await loginCookies(app, "time@example.test", "time password");
  const headers = { cookie: cookieHeader(cookies) };

  fx.setNow(new Date(start.getTime() + SESSION_IDLE_MS - 1));
  assert.equal((await call(app, "/api/v1/session", { headers })).status, 200);

  // The accepted request above set last_seen to start + idle - 1.
  fx.setNow(new Date(start.getTime() + 2 * SESSION_IDLE_MS - 1));
  assert.equal((await call(app, "/api/v1/session", { headers })).status, 401);

  // Absolute lifetime applies even while the session is active.
  const reloginAt = new Date(start.getTime() + 2 * SESSION_IDLE_MS);
  fx.setNow(reloginAt);
  const absoluteCookies = await loginCookies(app, "time@example.test", "time password");
  const absoluteHeaders = { cookie: cookieHeader(absoluteCookies) };
  const absolutePrefix = sessionToken(absoluteCookies).slice(0, SESSION_PREFIX_LENGTH);
  const justBeforeAbsolute = new Date(reloginAt.getTime() + SESSION_ABSOLUTE_MS - 1);
  // Keep the session active so only the absolute lifetime can reject it.
  fx.setNow(justBeforeAbsolute);
  await fx.db.run("UPDATE sessions SET last_seen_at = ? WHERE token_prefix = ?", [
    justBeforeAbsolute.toISOString(),
    absolutePrefix,
  ]);
  assert.equal((await call(app, "/api/v1/session", { headers: absoluteHeaders })).status, 200);
  fx.setNow(new Date(reloginAt.getTime() + SESSION_ABSOLUTE_MS));
  assert.equal((await call(app, "/api/v1/session", { headers: absoluteHeaders })).status, 401);
});

test("legacy scrypt hashes verify only through the Node adapter", async (t) => {
  const { fx, app } = await withApp(t);
  const password = "legacy scrypt password";
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const legacy = `scrypt$${Buffer.from(salt).toString("base64")}$${scryptSync(
    password,
    salt,
    64,
  ).toString("base64")}`;
  await fx.db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["acct_legacy", "legacy@example.test", legacy, "2026-11-03T12:00:00.000Z"],
  );

  // The portable core fails closed on a format it does not write.
  assert.equal((await login(app, "legacy@example.test", password)).status, 401);
  assert.equal((await fx.db.all("SELECT id FROM sessions")).length, 0);

  fx.deps.passwordVerifier = nodePasswordVerifier;
  const accepted = await login(app, "legacy@example.test", password);
  assert.equal(accepted.status, 200);

  // Unknown formats stay closed even with the Node adapter.
  await fx.db.run("UPDATE accounts SET password_hash = ? WHERE id = ?", [
    "argon2$cost$salt$hash",
    "acct_legacy",
  ]);
  assert.equal((await login(app, "legacy@example.test", password)).status, 401);
});
