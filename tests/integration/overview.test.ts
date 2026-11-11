import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import type { Scope } from "../../src/domain/authz.ts";
import { sha256Hex } from "../../src/domain/digest.ts";
import { AppError } from "../../src/domain/errors.ts";
import {
  getAccountOverview,
  OVERVIEW_CREDENTIAL_LIMIT,
} from "../../src/service/overview.ts";
import { writeAudit } from "../../src/service/audit.ts";
import { sendMessage } from "../../src/service/messages.ts";
import { expireMessageBody } from "../../src/service/expiry.ts";
import { sessionAccountPrincipal } from "../../src/service/auth.ts";
import type { SqlValue } from "../../src/storage/db.ts";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../../src/service/sessions.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import { startServer } from "../../src/platforms/node/main.ts";
import {
  ALL_SCOPES,
  createServiceFixture,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;

function call(app: App, path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): Promise<Response> {
  return app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator) === name) {
      return pair.slice(separator + 1);
    }
  }
  return undefined;
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

async function loginAs(
  app: App,
  email: string,
  password: string,
): Promise<{ cookie: string }> {
  const page = await call(app, "/login");
  assert.equal(page.status, 200);
  const loginCsrf = cookieValue(page.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(loginCsrf);
  const response = await call(app, "/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${WEB_LOGIN_CSRF_COOKIE}=${loginCsrf}`,
    },
    body: new URLSearchParams({
      return_to: "/",
      login_csrf: loginCsrf,
      email,
      password,
    }).toString(),
  });
  assert.equal(response.status, 303);
  const session = cookieValue(response.headers.getSetCookie(), SESSION_COOKIE_NAME);
  assert.ok(session);
  return { cookie: `${SESSION_COOKIE_NAME}=${session}` };
}

async function send(
  fx: ServiceFixture,
  token: string,
  projectId: string,
  key: string,
  summary: string,
  text: string,
): Promise<{ messageId: string; seq: number }> {
  const principal = await fx.authenticate(token);
  return sendMessage(fx.deps, principal, projectId, key, {
    summary,
    type: "note",
    language: "en",
    text,
    bodyDigest: `sha256:${await sha256Hex(new TextEncoder().encode(text))}`,
  });
}

async function seedTenant(
  fx: ServiceFixture,
  accountId: string,
  email: string,
  speakerId: string,
  projectId: string,
  title: string,
  capabilities: readonly Scope[] = ALL_SCOPES,
): Promise<{ token: string; credentialId: string }> {
  await addPasswordAccount(fx, accountId, email, "correct horse battery");
  await fx.addSpeaker(speakerId, accountId);
  await fx.addProject(projectId, accountId);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [title, projectId]);
  await fx.addMembership(projectId, speakerId, capabilities);
  return fx.addCredential({ speakerId });
}

function ownerPrincipal(accountId: string) {
  return sessionAccountPrincipal({ sessionId: "sess_test", accountId });
}

test("overview counts only the account's authorized projects and credential states", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const a = await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  const b = await seedTenant(fx, "acct_b", "b@example.test", "spk_b", "proj_b", "Bravo");

  const ready = await send(fx, a.token, "proj_a", "a-1", "Ready one", "body one");
  await send(fx, a.token, "proj_a", "a-2", "Ready two", "body two");
  const expired = await send(fx, a.token, "proj_a", "a-3", "Expired one", "body three");
  await fx.expireMessage(expired.messageId);
  const foreign = await send(fx, b.token, "proj_b", "b-1", "Foreign", "foreign body");
  await fx.expireMessage(foreign.messageId);
  await fx.db.run("UPDATE messages SET body_state = 'expired' WHERE id = ?", [
    ready.messageId,
  ]);

  // A provisional row with no sequence, as the send protocol leaves it.
  await fx.db.run(
    `INSERT INTO messages
       (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, body_state)
     VALUES ('msg_pending', 'proj_a', NULL, 'spk_a', 'Pending', 'note', 'en', ?, 'pending')`,
    [fx.deps.now().toISOString()],
  );

  // Distinct credential states for the account's owned speaker.
  await fx.addCredential({ speakerId: "spk_a" });
  await fx.addCredential({
    speakerId: "spk_a",
    expiresAt: new Date("2026-11-02T00:00:00.000Z"),
  });
  await fx.addCredential({
    speakerId: "spk_a",
    revokedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET expires_at = 'not-a-date' WHERE id = ?", [
    unknown.credentialId,
  ]);
  // Another tenant's credential must not be counted.
  await fx.addCredential({ speakerId: "spk_b" });

  await writeAudit(fx.deps, {
    operation: "credential.issue",
    outcome: "success",
    actorAccountId: "acct_a",
    projectId: "proj_a",
  });
  await writeAudit(fx.deps, {
    operation: "foreign.event",
    outcome: "success",
    actorAccountId: "acct_b",
    projectId: "proj_b",
  });

  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  assert.deepEqual(
    overview.projects.map((project) => project.id),
    ["proj_a"],
  );
  assert.equal(overview.projects[0]?.title, "Alpha");
  assert.deepEqual(overview.projects[0]?.messages, {
    ready: 1,
    pending: 1,
    expired: 2,
  });
  const stored = await fx.db.first<{ bytes: number | null }>(
    `SELECT COALESCE(SUM(cipher_length), 0) AS bytes
       FROM body_objects WHERE project_id = 'proj_a' AND storage_key IS NOT NULL`,
  );
  assert.equal(overview.projects[0]?.storageBytes, Number(stored?.bytes ?? 0));
  assert.deepEqual(overview.totals, {
    ready: 1,
    pending: 1,
    expired: 2,
    storageBytes: Number(stored?.bytes ?? 0),
  });
  assert.deepEqual(overview.credentials, {
    active: 2,
    expired: 1,
    revoked: 1,
    unknown: 1,
  });
  assert.deepEqual(
    overview.auditEvents.map((event) => event.operation),
    ["credential.issue"],
  );
  assert.equal(overview.projectsTruncated, false);
  assert.equal(overview.credentialsTruncated, false);
});

test("overview rejects a bearer principal", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const a = await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  const bearer = await fx.authenticate(a.token);
  await assert.rejects(
    getAccountOverview(fx.deps, bearer),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});

test("overview returns empty states for an account with no projects", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx, "acct_empty", "empty@example.test", "correct horse battery");
  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_empty"));
  assert.deepEqual(overview.projects, []);
  assert.deepEqual(overview.totals, {
    ready: 0,
    pending: 0,
    expired: 0,
    storageBytes: 0,
  });
  assert.deepEqual(overview.credentials, {
    active: 0,
    expired: 0,
    revoked: 0,
    unknown: 0,
  });
  assert.deepEqual(overview.auditEvents, []);
  assert.equal(overview.credentialsTruncated, false);
});

test("overview bounds the readable project set to 100 and reports truncation", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx, "acct_many", "many@example.test", "correct horse battery");
  await fx.addSpeaker("spk_many", "acct_many");
  for (let index = 0; index < 101; index += 1) {
    const projectId = `proj_${String(index).padStart(3, "0")}`;
    await fx.addProject(projectId, "acct_many");
    await fx.addMembership(projectId, "spk_many", ["project.read"]);
    fx.setNow(new Date(Date.parse(fx.deps.now().toISOString()) + 1000));
  }
  // Record every bound-parameter count. D1 allows at most 100 per query, and the
  // audit chunks stay well below it even with the full project set.
  const calls: Array<{ sql: string; count: number }> = [];
  const originalAll = fx.deps.db.all.bind(fx.deps.db);
  fx.deps.db.all = ((sql: string, params?: readonly SqlValue[]) => {
    calls.push({ sql, count: params?.length ?? 0 });
    return originalAll(sql, params);
  }) as typeof fx.deps.db.all;

  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_many"));
  assert.equal(overview.projects.length, 100);
  assert.equal(overview.projectsTruncated, true);
  assert.ok(calls.length > 0);
  for (const call of calls) assert.ok(call.count <= 100, call.sql);
  const auditChunks = calls.filter(
    (call) =>
      call.sql.includes("FROM audit_events") &&
      call.sql.includes("project_id IN"),
  );
  assert.equal(auditChunks.length, 3);
  for (const chunk of auditChunks) assert.ok(chunk.count <= 49, chunk.sql);
});

test("overview excludes expiry-deleted storage using independently known bytes", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const a = await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  const first = await send(fx, a.token, "proj_a", "a-1", "First", "first body");
  const second = await send(fx, a.token, "proj_a", "a-2", "Second", "second body");

  const bytesFor = (messageId: string) =>
    fx.db.first<{ cipher_length: number }>(
      `SELECT b.cipher_length
         FROM messages m JOIN body_objects b ON b.id = m.body_object_id
        WHERE m.id = ?`,
      [messageId],
    );
  const firstBytes = await bytesFor(first.messageId);
  const secondBytes = await bytesFor(second.messageId);
  assert.ok(firstBytes !== undefined && secondBytes !== undefined);
  assert.ok(firstBytes.cipher_length > 0 && secondBytes.cipher_length > 0);

  // Real expiry path: transition to `expired` and delete the ciphertext row.
  const principal = await fx.authenticate(a.token);
  await expireMessageBody(fx.deps, principal, "proj_a", first.messageId);
  const deleted = await fx.db.first<{ count: number }>(
    `SELECT COUNT(*) AS count FROM body_objects
      WHERE project_id = ? AND storage_key IS NULL`,
    ["proj_a"],
  );
  assert.equal(deleted?.count, 1);

  // A reference-before-write failure leaves a row with no message and no file.
  // It must not inflate stored bytes.
  await fx.db.run(
    `INSERT INTO body_objects
       (id, project_id, storage_key, cipher_length, state, created_at)
     VALUES ('obj_dangling', 'proj_a', ?, 999, 'ready', ?)`,
    ["D".repeat(20), "2026-11-03T12:00:00.000Z"],
  );

  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  assert.equal(overview.projects[0]?.storageBytes, secondBytes.cipher_length);
  assert.equal(overview.totals.storageBytes, secondBytes.cipher_length);
  assert.notEqual(firstBytes.cipher_length, secondBytes.cipher_length);
});

test("overview reports incomplete credential counts at the scan limit", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");

  // The seeded credential plus enough extra rows to exceed the hard limit.
  for (let index = 0; index <= OVERVIEW_CREDENTIAL_LIMIT; index += 1) {
    await fx.db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
       VALUES (?, 'spk_a', ?, 'verifier', ?, ?)`,
      [
        `cred_bulk_${String(index).padStart(4, "0")}`,
        `bulk${index}`,
        JSON.stringify(["message.read"]),
        fx.deps.now().toISOString(),
      ],
    );
  }
  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  assert.equal(overview.credentialsTruncated, true);
  const counted =
    overview.credentials.active +
    overview.credentials.expired +
    overview.credentials.revoked +
    overview.credentials.unknown;
  assert.equal(counted, OVERVIEW_CREDENTIAL_LIMIT);

  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  const html = await (await call(app, "/overview", { headers: { cookie } })).text();
  assert.ok(html.includes("counts cover the first 1000 credentials"));
});

test("overview counts exactly 1,000 credentials without reporting truncation", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");

  // The seeded credential plus 999 rows is exactly the 1,000-row count cap.
  for (let index = 0; index < OVERVIEW_CREDENTIAL_LIMIT - 1; index += 1) {
    await fx.db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
       VALUES (?, 'spk_a', ?, 'verifier', ?, ?)`,
      [
        `cred_edge_${String(index).padStart(4, "0")}`,
        `edge${index}`,
        JSON.stringify(["message.read"]),
        fx.deps.now().toISOString(),
      ],
    );
  }
  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  assert.equal(overview.credentialsTruncated, false);
  const counted =
    overview.credentials.active +
    overview.credentials.expired +
    overview.credentials.revoked +
    overview.credentials.unknown;
  assert.equal(counted, OVERVIEW_CREDENTIAL_LIMIT);
});

test("overview hides an account-actored foreign project id but keeps the event", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  await seedTenant(fx, "acct_b", "b@example.test", "spk_b", "proj_b", "Bravo");
  await writeAudit(fx.deps, {
    operation: "account.only",
    outcome: "success",
    actorAccountId: "acct_a",
    projectId: "proj_b",
  });

  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  const event = overview.auditEvents.find((row) => row.operation === "account.only");
  assert.ok(event !== undefined);
  assert.equal(event.projectId, null);
  assert.ok(event.createdAt !== "");

  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  const html = await (await call(app, "/overview", { headers: { cookie } })).text();
  assert.ok(html.includes("account.only"));
  assert.ok(!html.includes("proj_b"));
});

test("overview escapes project titles and audit operation/outcome", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [
    '<script>alert("title")</script>',
    "proj_a",
  ]);
  await fx.db.run(
    `INSERT INTO audit_events
       (id, actor_account_id, project_id, operation, outcome, created_at)
     VALUES ('evt_escape', 'acct_a', 'proj_a', ?, ?, ?)`,
    [
      '<script>alert("operation")</script>',
      '<script>alert("outcome")</script>',
      fx.deps.now().toISOString(),
    ],
  );

  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  const response = await call(app, "/overview", { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;operation&quot;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;outcome&quot;)&lt;/script&gt;"));
});

test("overview bounds audit events to 20 and never selects detail", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  for (let index = 0; index < 25; index += 1) {
    await writeAudit(fx.deps, {
      operation: `event.${index}`,
      outcome: "success",
      actorAccountId: "acct_a",
      projectId: "proj_a",
      detail: { secret: "TOP-SECRET-DETAIL" },
    });
    // Make ordering deterministic regardless of identical millisecond stamps.
    fx.setNow(new Date(Date.parse(fx.deps.now().toISOString()) + 1000));
  }
  const overview = await getAccountOverview(fx.deps, ownerPrincipal("acct_a"));
  assert.equal(overview.auditEvents.length, 20);
  const serialized = JSON.stringify(overview);
  assert.ok(!serialized.includes("TOP-SECRET-DETAIL"));
  assert.ok(!serialized.includes("detail"));
});

test("overview requires a session and rejects non-GET requests", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });

  const anonymous = await call(app, "/overview");
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/login?return_to=%2Foverview");

  // A bearer credential is not a session cookie.
  const bearerOnly = await call(app, "/overview", {
    headers: { authorization: "Bearer cb_something" },
  });
  assert.equal(bearerOnly.status, 303);

  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  const post = await call(app, "/overview", {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "x=1",
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("overview page renders en/zh, links from the dashboard, and shows empty states", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx, "acct_empty", "empty@example.test", "correct horse battery");
  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "empty@example.test", "correct horse battery");
  // Sign-in itself writes an account-scoped audit event; clear it to exercise
  // the page's audit empty state.
  await fx.db.run("DELETE FROM audit_events");

  const dashboard = await call(app, "/", { headers: { cookie } });
  assert.equal(dashboard.status, 200);
  assert.ok((await dashboard.text()).includes("Service overview"));

  const english = await call(app, "/overview", { headers: { cookie } });
  assert.equal(english.status, 200);
  assert.equal(english.headers.get("cache-control"), "no-store");
  const html = await english.text();
  assert.ok(html.includes("Service overview"));
  assert.ok(html.includes("Readable projects"));
  assert.ok(html.includes("No projects are available for this account."));
  assert.ok(html.includes("No recent audit events."));
  assert.ok(html.includes("Traffic and error summaries are not available"));

  const chinese = await call(app, "/overview?lang=zh", { headers: { cookie } });
  assert.equal(chinese.status, 200);
  const zhHtml = await chinese.text();
  assert.ok(zhHtml.includes('lang="zh-Hans"'));
  assert.ok(zhHtml.includes("服务概览"));
  assert.ok(zhHtml.includes("暂无最近审计事件"));
  assert.ok(zhHtml.includes("流量与错误摘要"));
});

test("overview never renders another tenant's project, audit row, or credential material", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const a = await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  await seedTenant(fx, "acct_b", "b@example.test", "spk_b", "proj_b", "Bravo");

  await send(fx, a.token, "proj_a", "a-1", "SECRET-SUMMARY", "SECRET-BODY");
  await writeAudit(fx.deps, {
    operation: "own.event",
    outcome: "success",
    actorAccountId: "acct_a",
    projectId: "proj_a",
    detail: { secret: "TOP-SECRET-DETAIL" },
  });
  await writeAudit(fx.deps, {
    operation: "foreign.event",
    outcome: "success",
    actorAccountId: "acct_b",
    projectId: "proj_b",
  });
  const prefix = a.token.slice(0, 12);
  assert.ok(a.token.length > 12);

  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  const response = await call(app, "/overview", { headers: { cookie } });
  assert.equal(response.status, 200);
  const html = await response.text();

  assert.ok(html.includes("Alpha"));
  assert.ok(html.includes("own.event"));
  assert.ok(!html.includes("Bravo"));
  assert.ok(!html.includes("proj_b"));
  assert.ok(!html.includes("foreign.event"));
  assert.ok(!html.includes("SECRET-SUMMARY"));
  assert.ok(!html.includes("SECRET-BODY"));
  assert.ok(!html.includes("TOP-SECRET-DETAIL"));
  assert.ok(!html.includes(a.token));
  assert.ok(!html.includes(prefix));
  assert.ok(!html.includes("cb_"));
});

test("overview renders at most 20 audit events and redirects a revoked session", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await seedTenant(fx, "acct_a", "a@example.test", "spk_a", "proj_a", "Alpha");
  const app = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie } = await loginAs(app, "a@example.test", "correct horse battery");
  // Keep the sign-in event out of the bounded window under test.
  await fx.db.run("DELETE FROM audit_events");
  for (let index = 0; index < 25; index += 1) {
    await writeAudit(fx.deps, {
      operation: `capped.event`,
      outcome: "success",
      actorAccountId: "acct_a",
      projectId: "proj_a",
    });
  }
  const page = await call(app, "/overview", { headers: { cookie } });
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.equal((html.match(/capped\.event/g) ?? []).length, 20);

  await fx.db.run("UPDATE sessions SET revoked_at = ?", [fx.deps.now().toISOString()]);
  const revoked = await call(app, "/overview", { headers: { cookie } });
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get("location"), "/login?return_to=%2Foverview");

  const second = await loginAs(app, "a@example.test", "correct horse battery");
  await fx.db.run("UPDATE sessions SET expires_at = ?", [
    new Date(fx.deps.now().getTime() - 1000).toISOString(),
  ]);
  const expired = await call(app, "/overview", { headers: { cookie: second.cookie } });
  assert.equal(expired.status, 303);
  assert.equal(expired.headers.get("location"), "/login?return_to=%2Foverview");
});

test("the Node adapter serves GET /overview over real HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-overview-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const email = "overview@example.test";
  const password = "overview password";
  const now = "2026-11-03T12:00:00.000Z";

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  await db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["acct_http", email, await hashPassword(password), now],
  );
  await db.run(
    `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["spk_http", "acct_http", "HTTP Speaker", now],
  );
  await db.run(
    `INSERT INTO projects (id, owner_account_id, title, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["proj_http", "acct_http", "HTTP Overview Project", now],
  );
  await db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_http", "spk_http", JSON.stringify(SCOPES), now],
  );
  db.close();

  const running = await startServer({
    env: {
      CORKBOARD_DATA_DIR: dataDir,
      CORKBOARD_ROOT_KEY: Buffer.from(rootKey).toString("base64"),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(pepper).toString("base64"),
      PORT: "0",
    },
  });
  t.after(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = running.server.address();
  assert.ok(address !== null && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;

  const anonymous = await fetch(`${base}/overview`, {
    redirect: "manual",
    headers: { connection: "close" },
  });
  assert.equal(anonymous.status, 303);
  assert.equal(anonymous.headers.get("location"), "/login?return_to=%2Foverview");

  const loginPage = await fetch(`${base}/login`, { headers: { connection: "close" } });
  const loginCsrf = cookieValue(loginPage.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(loginCsrf);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${WEB_LOGIN_CSRF_COOKIE}=${loginCsrf}`,
      connection: "close",
    },
    body: new URLSearchParams({
      return_to: "/",
      login_csrf: loginCsrf,
      email,
      password,
    }).toString(),
  });
  assert.equal(login.status, 303);
  const session = cookieValue(login.headers.getSetCookie(), SESSION_COOKIE_NAME);
  const csrf = cookieValue(login.headers.getSetCookie(), CSRF_COOKIE_NAME);
  assert.ok(session);
  assert.ok(csrf);

  const page = await fetch(`${base}/overview`, {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${session}`, connection: "close" },
  });
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("HTTP Overview Project"));
});
