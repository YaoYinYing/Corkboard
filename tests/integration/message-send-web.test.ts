import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, type RequestLogEntry } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { hashSecret } from "../../src/auth/credentials.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { sha256Hex } from "../../src/domain/digest.ts";
import { AppError } from "../../src/domain/errors.ts";
import {
  authorizeMessageSend,
  authorizeSessionSend,
  resolveSessionSendPrincipal,
} from "../../src/service/auth.ts";
import { sendMessage } from "../../src/service/messages.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import type { SqlDatabase, SqlTransaction, SqlValue } from "../../src/storage/db.ts";
import { startServer } from "../../src/platforms/node/main.ts";
import {
  createServiceFixture,
  ALL_SCOPES,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
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

async function withApp(t: {
  after(fn: () => void): void;
}, logger?: (entry: RequestLogEntry) => void): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return {
    fx,
    app: createApp(fx.deps, {
      loginRateLimit: { perMinute: 600, burst: 100 },
      ...(logger === undefined ? {} : { logger }),
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

async function loginAsWithCsrf(
  app: App,
  email: string,
  password: string,
): Promise<{ cookie: string; csrf: string }> {
  const form = await call(app, "/login");
  assert.equal(form.status, 200);
  const loginCsrf = cookieValue(form.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
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
  const cookies = response.headers.getSetCookie();
  const session = cookieValue(cookies, SESSION_COOKIE_NAME);
  const csrf = cookieValue(cookies, CSRF_COOKIE_NAME);
  assert.ok(session);
  assert.ok(csrf);
  const cookie =
    SESSION_COOKIE_NAME + "=" + session + "; " + CSRF_COOKIE_NAME + "=" + csrf;
  return { cookie, csrf };
}

function postForm(
  app: App,
  path: string,
  cookie: string | undefined,
  fields: ReadonlyArray<readonly [string, string]>,
  headers: Record<string, string> = {},
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of fields) body.append(name, value);
  return call(app, path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
      ...headers,
    },
    body: body.toString(),
  });
}

async function getPage(
  app: App,
  path: string,
  cookie: string,
): Promise<{ status: number; html: string; response: Response }> {
  const response = await call(app, path, { headers: { cookie } });
  return { status: response.status, html: await response.text(), response };
}

function idempotencyKeyFrom(html: string): string {
  const match = /name="idempotency_key" value="([^"]+)"/.exec(html);
  assert.ok(match, "compose form must carry an idempotency key");
  return match[1] ?? "";
}

async function createProjectAccount(fx: ServiceFixture): Promise<void> {
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addProject("proj_a", "acct_a");
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
}

async function loginProjectAccount(app: App): Promise<{ cookie: string; csrf: string }> {
  return loginAsWithCsrf(app, "a@example.test", "account a secret");
}

async function committedMessages(
  fx: ServiceFixture,
  projectId = "proj_a",
): Promise<Array<{ id: string; seq: number; sender_speaker_id: string; summary: string }>> {
  return fx.db.all<{ id: string; seq: number; sender_speaker_id: string; summary: string }>(
    `SELECT id, seq, sender_speaker_id, summary FROM messages
      WHERE project_id = ? AND seq IS NOT NULL ORDER BY seq ASC`,
    [projectId],
  );
}

async function writeRowCounts(fx: ServiceFixture): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of ["messages", "idempotency_keys", "body_objects", "audit_events"]) {
    const row = await fx.db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    counts[table] = row?.n ?? 0;
  }
  return counts;
}

function sendFields(
  csrf: string,
  idempotencyKey: string,
  overrides: Record<string, string> = {},
): Array<readonly [string, string]> {
  const base: Record<string, string> = {
    csrf_token: csrf,
    idempotency_key: idempotencyKey,
    speaker_id: "spk_a",
    summary: "Dashboard summary",
    text: "Dashboard body",
    type: "note",
    language: "en",
    reply_to_id: "",
    body_expires_at: "",
    ...overrides,
  };
  return Object.entries(base);
}

test("compose form lists only account-owned senders and renders en/zh labels", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addSpeaker("spk_readonly", "acct_a");
  await fx.addProject("proj_a", "acct_a");
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
  // A foreign account's speaker is a member with message.send: still not a
  // sender choice for acct_a.
  await fx.addMembership("proj_a", "spk_b", ALL_SCOPES);
  // An owned speaker without message.send is not a sender choice.
  await fx.addMembership("proj_a", "spk_readonly", ["project.read", "message.read"]);
  const { cookie } = await loginProjectAccount(app);

  const timeline = await getPage(app, "/projects/proj_a", cookie);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.html.includes('href="/projects/proj_a/messages/new"'));

  const form = await getPage(app, "/projects/proj_a/messages/new", cookie);
  assert.equal(form.status, 200);
  assert.equal(form.response.headers.get("content-security-policy"), WEB_CSP);
  assert.equal(form.response.headers.get("cache-control"), "no-store");
  assert.ok(form.html.includes('name="idempotency_key"'));
  assert.ok(form.html.includes('name="csrf_token"'));
  assert.ok(form.html.includes('<option value="spk_a"'));
  assert.equal(form.html.includes('value="spk_b"'), false);
  assert.equal(form.html.includes('value="spk_readonly"'), false);
  assert.ok(form.html.includes('name="speaker_id"'));
  assert.ok(form.html.includes('name="summary"'));
  assert.ok(form.html.includes('name="text"'));
  assert.ok(form.html.includes('name="type"'));
  assert.ok(form.html.includes('name="language"'));
  assert.ok(form.html.includes('name="reply_to_id"'));
  assert.ok(form.html.includes('name="body_expires_at"'));

  const chinese = await getPage(app, "/projects/proj_a/messages/new?lang=zh", cookie);
  assert.equal(chinese.status, 200);
  assert.match(chinese.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(chinese.html.includes("新建消息"));
  assert.ok(chinese.html.includes('action="/projects/proj_a/messages/new?lang=zh"'));
});

test("an unreadable project and an unknown project are the same uniform 404", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addProject("proj_b", "acct_b");
  await fx.addMembership("proj_b", "spk_b", ALL_SCOPES);
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  for (const path of ["/projects/proj_b/messages/new", "/projects/proj_missing/messages/new"]) {
    const page = await getPage(app, path, cookie);
    assert.equal(page.status, 404);
    assert.ok(page.html.includes("Not found"));
  }
});

test("a successful send redirects, commits as the selected speaker, and is visible in order", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  const { cookie, csrf } = await loginProjectAccount(app);

  const form = await getPage(app, "/projects/proj_a/messages/new", cookie);
  const firstKey = idempotencyKeyFrom(form.html);
  const sent = await postForm(app, "/projects/proj_a/messages/new", cookie, sendFields(csrf, firstKey));
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get("location"), "/projects/proj_a");

  const second = await postForm(
    app,
    "/projects/proj_a/messages/new?lang=zh",
    cookie,
    sendFields(csrf, idempotencyKeyFrom(
      (await getPage(app, "/projects/proj_a/messages/new?lang=zh", cookie)).html,
    ), { summary: "Second summary", text: "Second body" }),
  );
  assert.equal(second.status, 303);
  assert.equal(second.headers.get("location"), "/projects/proj_a?lang=zh");

  const messages = await committedMessages(fx);
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map((message) => message.seq), [1, 2]);
  assert.deepEqual(
    messages.map((message) => message.sender_speaker_id),
    ["spk_a", "spk_a"],
  );

  const timeline = await getPage(app, "/projects/proj_a", cookie);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.html.includes("Dashboard summary"));
  assert.ok(timeline.html.includes("Second summary"));
  const firstAt = timeline.html.indexOf("Dashboard summary");
  const secondAt = timeline.html.indexOf("Second summary");
  assert.ok(firstAt >= 0 && secondAt > firstAt, "timeline is in ascending server sequence");

  const body = await getPage(app, `/projects/proj_a/messages/${messages[0]?.id}/body`, cookie);
  assert.equal(body.status, 200);
  assert.ok(body.html.includes("Dashboard body"));
});

test("the sender must be an owned active speaker with message.send", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_foreign", "acct_b");
  await fx.addSpeaker("spk_no_send", "acct_a");
  await fx.addSpeaker("spk_inactive", "acct_a", "inactive");
  await fx.addSpeaker("spk_removed", "acct_a");
  await fx.addProject("proj_a", "acct_a");
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
  await fx.addMembership("proj_a", "spk_foreign", ALL_SCOPES);
  await fx.addMembership("proj_a", "spk_no_send", ["project.read", "message.read"]);
  await fx.addMembership("proj_a", "spk_inactive", ALL_SCOPES);
  await fx.addMembership("proj_a", "spk_removed", ALL_SCOPES);
  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    ["2026-11-03T12:00:00.000Z", "proj_a", "spk_removed"],
  );
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const form = await getPage(app, "/projects/proj_a/messages/new", cookie);
  const key = idempotencyKeyFrom(form.html);

  for (const speakerId of ["spk_foreign", "spk_no_send", "spk_inactive", "spk_removed", "spk_unknown"]) {
    const response = await postForm(
      app,
      "/projects/proj_a/messages/new",
      cookie,
      sendFields(csrf, key, { speaker_id: speakerId }),
    );
    assert.equal(response.status, 404, `${speakerId} must be the uniform 404`);
    const html = await response.text();
    assert.ok(html.includes("Not found"));
    assert.equal(html.includes("Dashboard body"), false);
  }
  assert.deepEqual(await committedMessages(fx), []);

  // An inactive account makes its owned speaker ineligible. Exercise the
  // service predicate directly so the `a.status = 'active'` clause is covered
  // (an HTTP login with a suspended account fails earlier and would be
  // vacuous).
  const ownPrincipal = await resolveSessionSendPrincipal(
    fx.deps,
    { sessionId: "sess_a", accountId: "acct_a" },
    "proj_a",
    "spk_a",
  );
  await fx.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", ["acct_a"]);
  await assert.rejects(
    authorizeSessionSend(fx.deps.db, ownPrincipal, "proj_a"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  assert.deepEqual(await committedMessages(fx), []);
});

test("a membership removed mid-request prevents publication", async (t) => {
  const { fx } = await withApp(t);
  await createProjectAccount(fx);
  const session = { sessionId: "sess_mid", accountId: "acct_a" };
  const principal = await resolveSessionSendPrincipal(fx.deps, session, "proj_a", "spk_a");
  const text = "Mid-request body";
  const digest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;

  let armed = true;
  const db: SqlDatabase = {
    exec: (sql: string): Promise<void> => fx.db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> => fx.db.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      fx.db.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      fx.db.run(sql, params),
    transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      const removeMembership = async (): Promise<void> => {
        await fx.db.run(
          "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
          ["2026-11-03T12:00:00.000Z", "proj_a", "spk_a"],
        );
      };
      if (!armed) return fx.db.transaction(fn);
      armed = false;
      // This wrapper removes the membership after the provisional row and blob
      // are written and before the publish transaction starts. The dedicated
      // session check inside that transaction must then abort the publish.
      return removeMembership().then(() => fx.db.transaction(fn));
    },
  };
  const wrapped = { ...fx.deps, db };

  await assert.rejects(
    sendMessage(wrapped, principal, "proj_a", "mid-key", {
      summary: "Mid summary",
      type: "note",
      language: "en",
      text,
      bodyDigest: digest,
    }),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  assert.deepEqual(await committedMessages(fx), []);
});

function delegateDatabase(
  db: SqlDatabase,
  transaction: SqlDatabase["transaction"],
): SqlDatabase {
  return {
    exec: (sql: string): Promise<void> => db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> => db.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      db.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      db.run(sql, params),
    transaction,
  };
}

test("a concurrent publication is a successful replay with no duplicate", async (t) => {
  const { fx } = await withApp(t);
  await createProjectAccount(fx);
  const session = { sessionId: "sess_replay", accountId: "acct_a" };
  const principal = await resolveSessionSendPrincipal(fx.deps, session, "proj_a", "spk_a");
  const text = "Concurrent publication body";
  const digest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;

  let armed = true;
  const db = delegateDatabase(fx.db, async (fn) => {
    if (!armed) return fx.db.transaction(fn);
    armed = false;
    // Simulate a concurrent finalize after the provisional write: publish the
    // pending row ourselves, then run the session publication, whose conditional
    // UPDATE now matches zero rows. The post-commit reload must treat the ready
    // row as a successful replay and not create a second message.
    const pending = await fx.db.first<{
      id: string;
      project_id: string;
      body_object_id: string | null;
    }>(
      "SELECT id, project_id, body_object_id FROM messages WHERE body_state = 'pending' LIMIT 1",
    );
    assert.ok(pending !== undefined && pending.body_object_id !== null);
    await fx.db.run(
      `UPDATE messages
          SET seq = (SELECT p.next_seq + 1 FROM projects p WHERE p.id = messages.project_id AND p.status = 'active'),
              body_state = 'ready', committed_at = ?, body_object_id = ?
        WHERE id = ? AND project_id = ? AND body_state = 'pending'`,
      [fx.deps.now().toISOString(), pending.body_object_id, pending.id, pending.project_id],
    );
    return fx.db.transaction(fn);
  });
  const wrapped = { ...fx.deps, db };

  const result = await sendMessage(wrapped, principal, "proj_a", "replay-race-key", {
    summary: "Concurrent summary",
    type: "note",
    language: "en",
    text,
    bodyDigest: digest,
  });
  assert.equal(result.seq, 1);
  assert.equal(result.queueToCommitMs, undefined);
  const rows = await committedMessages(fx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.seq, 1);

  // A plain retry now takes the ordinary idempotency replay path.
  const replay = await sendMessage(fx.deps, principal, "proj_a", "replay-race-key", {
    summary: "Concurrent summary",
    type: "note",
    language: "en",
    text,
    bodyDigest: digest,
  });
  assert.equal(replay.seq, 1);
  assert.equal((await committedMessages(fx)).length, 1);
});

test("deactivating the project during a session send prevents publication", async (t) => {
  const { fx } = await withApp(t);
  await createProjectAccount(fx);
  const session = { sessionId: "sess_project_status", accountId: "acct_a" };
  const principal = await resolveSessionSendPrincipal(fx.deps, session, "proj_a", "spk_a");
  const text = "Deactivated project body";
  const digest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;

  let armed = true;
  const db = delegateDatabase(fx.db, async (fn) => {
    if (!armed) return fx.db.transaction(fn);
    armed = false;
    // Deactivate after the provisional write and before the publication
    // transaction; the conditional UPDATE must match zero rows.
    await fx.db.run("UPDATE projects SET status = 'inactive' WHERE id = ?", ["proj_a"]);
    return fx.db.transaction(fn);
  });
  const wrapped = { ...fx.deps, db };

  await assert.rejects(
    sendMessage(wrapped, principal, "proj_a", "project-status-key", {
      summary: "Deactivated summary",
      type: "note",
      language: "en",
      text,
      bodyDigest: digest,
    }),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  assert.deepEqual(await committedMessages(fx), []);
});

test("a tampered idempotency record cannot publish another speaker's row", async (t) => {
  const { fx } = await withApp(t);
  await createProjectAccount(fx);
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addMembership("proj_a", "spk_b", ALL_SCOPES);
  const session = { sessionId: "sess_tamper", accountId: "acct_a" };
  const principal = await resolveSessionSendPrincipal(fx.deps, session, "proj_a", "spk_a");

  // A pending row that belongs to another speaker, with an idempotency record
  // for the session's speaker pointing at it out-of-band.
  const pendingId = "msg_other_speaker_pending";
  const now = fx.deps.now().toISOString();
  await fx.db.run(
    `INSERT INTO messages
       (id, project_id, seq, sender_speaker_id, summary, type, language, reply_to_id,
        client_sent_at, received_at, committed_at, body_state, body_object_id, body_expires_at)
     VALUES (?, ?, NULL, ?, ?, 'note', 'en', NULL, NULL, ?, NULL, 'pending', NULL, NULL)`,
    [pendingId, "proj_a", "spk_b", "Other speaker pending", now],
  );

  const summary = "Tampered summary";
  const text = "Tampered record body";
  const bodyDigest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;
  const canonical = JSON.stringify({
    bodyDigest,
    bodyExpiresAt: null,
    clientSentAt: null,
    language: "en",
    replyToId: null,
    summary,
    text,
    type: "note",
  });
  const payloadDigest = `hmac-sha256:${await hashSecret(canonical, fx.deps.pepper)}`;
  await fx.db.run(
    `INSERT INTO idempotency_keys
       (speaker_id, project_id, key, payload_digest, message_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    ["spk_a", "proj_a", "tampered-key", payloadDigest, pendingId, now, now],
  );

  await assert.rejects(
    sendMessage(fx.deps, principal, "proj_a", "tampered-key", {
      summary,
      type: "note",
      language: "en",
      text,
      bodyDigest,
    }),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  assert.deepEqual(await committedMessages(fx), []);
  const other = await fx.db.first<{ seq: number | null; body_state: string }>(
    "SELECT seq, body_state FROM messages WHERE id = ?",
    [pendingId],
  );
  assert.equal(other?.body_state, "pending");
  assert.equal(other?.seq, null);

  // The same speaker can still publish its own row.
  const okText = "Normal body";
  const okDigest = `sha256:${await sha256Hex(new TextEncoder().encode(okText))}`;
  const ok = await sendMessage(fx.deps, principal, "proj_a", "normal-key-after-tamper", {
    summary: "Normal summary",
    type: "note",
    language: "en",
    text: okText,
    bodyDigest: okDigest,
  });
  assert.equal(ok.seq, 1);
  const committed = await committedMessages(fx);
  assert.equal(committed.length, 1);
  assert.equal(committed[0]?.sender_speaker_id, "spk_a");
});

test("CSRF, content-type, and size failures write nothing", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  const { cookie, csrf } = await loginProjectAccount(app);
  const form = await getPage(app, "/projects/proj_a/messages/new", cookie);
  const key = idempotencyKeyFrom(form.html);

  const missing = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields("", key),
  );
  assert.equal(missing.status, 400);

  const wrong = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields("wrong-token", key),
  );
  assert.equal(wrong.status, 400);

  const crossSite = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields(csrf, key),
    { "sec-fetch-site": "cross-site" },
  );
  assert.equal(crossSite.status, 400);

  const wrongType = await call(app, "/projects/proj_a/messages/new", {
    method: "POST",
    headers: { "content-type": "text/plain", cookie },
    body: "summary=x",
  });
  assert.equal(wrongType.status, 400);

  const oversized = await call(app, "/projects/proj_a/messages/new", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: "text=" + "a".repeat(65 * 1024),
  });
  assert.equal(oversized.status, 413);

  assert.deepEqual(await committedMessages(fx), []);
});

test("invalid message fields re-render safely and write nothing", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addProject("proj_b", "acct_b");
  await fx.addMembership("proj_b", "spk_b", ALL_SCOPES);
  const { cookie, csrf } = await loginProjectAccount(app);
  // An existing committed message in another project is a valid reply target
  // only there.
  const other = await fx.addCredential({ speakerId: "spk_b" });
  const otherPrincipal = await fx.authenticate(other.token);
  const otherText = "Other project body";
  const otherMessage = await sendMessage(fx.deps, otherPrincipal, "proj_b", "other-key", {
    summary: "Other project message",
    type: "note",
    language: "en",
    text: otherText,
    bodyDigest: `sha256:${await sha256Hex(new TextEncoder().encode(otherText))}`,
  });

  const form = await getPage(app, "/projects/proj_a/messages/new", cookie);
  const key = idempotencyKeyFrom(form.html);
  const writesBefore = await writeRowCounts(fx);
  const invalidCases: Array<Record<string, string>> = [
    { summary: "" },
    { summary: "   " },
    { summary: "\t\n" },
    { summary: "\u200b" },
    { summary: "x".repeat(141) },
    { text: "" },
    { text: "   " },
    { text: "\r\n\t" },
    { text: "\ufeff" },
    { type: "Not Valid" },
    { language: "not a language" },
    { body_expires_at: "not-a-timestamp" },
    { body_expires_at: "2020-01-01T00:00:00Z" },
    { body_expires_at: "2030-01-01T00:00:00Z" },
    { reply_to_id: otherMessage.messageId },
  ];
  for (const overrides of invalidCases) {
    const response = await postForm(
      app,
      "/projects/proj_a/messages/new",
      cookie,
      sendFields(csrf, key, overrides),
    );
    assert.equal(response.status, 400, JSON.stringify(overrides));
    const html = await response.text();
    assert.ok(html.includes('role="alert"'));
    // The submitted key is repeated so an unchanged retry stays idempotent.
    assert.equal(idempotencyKeyFrom(html), key);
  }
  assert.deepEqual(await committedMessages(fx), []);
  assert.deepEqual(await writeRowCounts(fx), writesBefore);

  // The same payload with the same key is idempotent; a different payload with
  // the same key is a conflict.
  const first = await postForm(app, "/projects/proj_a/messages/new", cookie, sendFields(csrf, key));
  assert.equal(first.status, 303);
  const replay = await postForm(app, "/projects/proj_a/messages/new", cookie, sendFields(csrf, key));
  assert.equal(replay.status, 303);
  const committed = await committedMessages(fx);
  assert.equal(committed.length, 1);

  const conflict = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields(csrf, key, { summary: "Different summary" }),
  );
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.ok(conflictHtml.includes('role="alert"'));
  // The re-render carries a fresh key so the corrected message can be sent.
  assert.notEqual(idempotencyKeyFrom(conflictHtml), key);
  assert.equal((await committedMessages(fx)).length, 1);
});

test("non-blank internal spaces and newlines send and are stored as entered", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  const { cookie, csrf } = await loginProjectAccount(app);
  const composePath = "/projects/proj_a/messages/new";
  const accepted: ReadonlyArray<readonly [string, string]> = [
    ["a b", "a b"],
    ["line1\nline2", "line1\nline2"],
  ];
  for (const [summary, text] of accepted) {
    const form = await getPage(app, composePath, cookie);
    const key = idempotencyKeyFrom(form.html);
    const response = await postForm(
      app,
      composePath,
      cookie,
      sendFields(csrf, key, { summary, text }),
    );
    assert.equal(response.status, 303, JSON.stringify({ summary, text }));
  }
  // Values are stored as entered; they are never trimmed or normalized.
  const committed = await committedMessages(fx);
  assert.deepEqual(
    committed.map((message) => message.summary),
    ["a b", "line1\nline2"],
  );
});

test("project status, positive expiry/reply, and boundary form failures", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  await fx.addProject("proj_off", "acct_a");
  await fx.addMembership("proj_off", "spk_a", ALL_SCOPES);
  const { cookie, csrf } = await loginProjectAccount(app);
  const composePath = "/projects/proj_a/messages/new";

  // An inactive project is not readable and cannot be a send target.
  await fx.db.run("UPDATE projects SET status = 'inactive' WHERE id = ?", ["proj_off"]);
  assert.equal((await getPage(app, "/projects/proj_off/messages/new", cookie)).status, 404);
  const inactivePost = await postForm(
    app,
    "/projects/proj_off/messages/new",
    cookie,
    sendFields(csrf, "web_inactive_key_1"),
  );
  assert.equal(inactivePost.status, 404);
  assert.deepEqual(await committedMessages(fx, "proj_off"), []);

  // A valid future expiry within the window is accepted and stored normalized.
  const validExpiry = await postForm(
    app,
    composePath,
    cookie,
    sendFields(csrf, "web_expiry_key_1", {
      summary: "Expiry summary",
      text: "Expiry body",
      body_expires_at: "2026-12-01T00:00:00Z",
    }),
  );
  assert.equal(validExpiry.status, 303);
  const expiryRows = await fx.db.all<{ id: string; body_expires_at: string | null }>(
    "SELECT id, body_expires_at FROM messages WHERE project_id = ? AND seq IS NOT NULL ORDER BY seq ASC",
    ["proj_a"],
  );
  assert.equal(expiryRows.length, 1);
  assert.equal(expiryRows[0]?.body_expires_at, "2026-12-01T00:00:00.000Z");
  const firstId = expiryRows[0]?.id ?? "";

  // A reply to a committed message in the same project is accepted.
  const validReply = await postForm(
    app,
    composePath,
    cookie,
    sendFields(csrf, "web_reply_key_1", {
      summary: "Reply summary",
      text: "Reply body",
      reply_to_id: firstId,
    }),
  );
  assert.equal(validReply.status, 303);
  const replyRow = await fx.db.first<{ reply_to_id: string | null }>(
    "SELECT reply_to_id FROM messages WHERE project_id = ? AND summary = ?",
    ["proj_a", "Reply summary"],
  );
  assert.equal(replyRow?.reply_to_id, firstId);
  assert.equal((await committedMessages(fx)).length, 2);

  // A duplicated form field is malformed and writes nothing.
  const duplicate = await postForm(app, composePath, cookie, [
    ["csrf_token", csrf],
    ["idempotency_key", "web_duplicate_key_1"],
    ["speaker_id", "spk_a"],
    ["summary", "one"],
    ["summary", "two"],
    ["text", "duplicate body"],
    ["type", "note"],
    ["language", "en"],
    ["reply_to_id", ""],
    ["body_expires_at", ""],
  ]);
  assert.equal(duplicate.status, 400);
  assert.equal((await committedMessages(fx)).length, 2);

  // No session cookie: the web route redirects to sign-in.
  const noSession = await postForm(
    app,
    composePath,
    undefined,
    sendFields(csrf, "web_no_session_key_1"),
  );
  assert.equal(noSession.status, 303);
  assert.match(noSession.headers.get("location") ?? "", /^\/login\?/);

  // Session present but the CSRF double-submit cookie absent.
  const sessionOnlyCookie = cookie.split(";")[0] ?? "";
  const noCsrfCookie = await postForm(
    app,
    composePath,
    sessionOnlyCookie,
    sendFields(csrf, "web_no_csrf_key_1", {
      summary: "No CSRF summary",
      text: "No CSRF body",
    }),
  );
  assert.equal(noCsrfCookie.status, 400);
  assert.equal((await committedMessages(fx)).length, 2);
});

test("XSS-shaped summary and text are escaped in the re-rendered form", async (t) => {
  const { fx, app } = await withApp(t);
  await createProjectAccount(fx);
  const { cookie, csrf } = await loginProjectAccount(app);
  const key = idempotencyKeyFrom(
    (await getPage(app, "/projects/proj_a/messages/new", cookie)).html,
  );
  const response = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields(csrf, key, {
      summary: `<script>alert('s')</script>`,
      text: `<img src=x onerror="alert('t')">`,
      type: "BAD TYPE",
    }),
  );
  assert.equal(response.status, 400);
  const html = await response.text();
  assert.equal(html.includes("<script>alert('s')</script>"), false);
  assert.equal(html.includes('<img src=x onerror="alert'), false);
  assert.ok(html.includes("&lt;script&gt;alert(&#39;s&#39;)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;img src=x onerror="));
  assert.deepEqual(await committedMessages(fx), []);
});

test("sessions cannot send as another account's speaker and bearers cannot use the path", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addProject("proj_b", "acct_b");
  await fx.addMembership("proj_b", "spk_b", ALL_SCOPES);
  const { token } = await fx.addCredential({ speakerId: "spk_b" });

  const bearer = await fx.authenticate(token);
  // The dedicated branch refuses a bearer principal outright.
  await assert.rejects(
    authorizeSessionSend(fx.deps.db, bearer, "proj_b"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  // A bearer still uses the ordinary credential/grant decision.
  const access = await authorizeMessageSend(fx.deps, bearer, "proj_b");
  assert.ok(access.rights.has("message.send"));

  // A session for acct_a cannot resolve acct_b's speaker, even though that
  // speaker exists on a project the session cannot read.
  await assert.rejects(
    resolveSessionSendPrincipal(
      fx.deps,
      { sessionId: "sess_a", accountId: "acct_a" },
      "proj_b",
      "spk_b",
    ),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );

  const anonymous = await call(app, "/projects/proj_b/messages/new", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: "summary=x",
  });
  assert.equal(anonymous.status, 303);
  assert.match(anonymous.headers.get("location") ?? "", /^\/login\?/);
  assert.deepEqual(await committedMessages(fx), []);
});

test("message content never reaches request logs or audit detail", async (t) => {
  const entries: RequestLogEntry[] = [];
  const { fx, app } = await withApp(t, (entry) => entries.push(entry));
  await createProjectAccount(fx);
  const { cookie, csrf } = await loginProjectAccount(app);
  const key = idempotencyKeyFrom(
    (await getPage(app, "/projects/proj_a/messages/new", cookie)).html,
  );
  const summary = "Log-secret summary";
  const text = "Log-secret body value";
  const response = await postForm(
    app,
    "/projects/proj_a/messages/new",
    cookie,
    sendFields(csrf, key, { summary, text }),
  );
  assert.equal(response.status, 303);

  const serialized = JSON.stringify(entries);
  assert.equal(serialized.includes(summary), false);
  assert.equal(serialized.includes(text), false);
  assert.equal(serialized.includes(key), false);
  assert.equal(serialized.includes("account a secret"), false);
  const audit = await fx.db.all<{ detail: string | null }>(
    "SELECT detail FROM audit_events",
  );
  const auditText = JSON.stringify(audit);
  assert.equal(auditText.includes(summary), false);
  assert.equal(auditText.includes(text), false);
});

test("the real Node adapter accepts the compose POST and shows the message", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-message-send-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const email = "http@example.test";
  const password = "http send secret";
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
    `INSERT INTO projects (id, owner_account_id, title, summary, status, next_seq, created_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?)`,
    ["proj_http", "acct_http", "HTTP Project", "Served over HTTP", now],
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
      CORKBOARD_ROOT_KEY: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
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

  const loginPage = await fetch(`${base}/login`, { headers: { connection: "close" } });
  assert.equal(loginPage.status, 200);
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
  const cookie =
    SESSION_COOKIE_NAME + "=" + session + "; " + CSRF_COOKIE_NAME + "=" + csrf;

  const formPage = await fetch(`${base}/projects/proj_http/messages/new`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(formPage.status, 200);
  const formHtml = await formPage.text();
  const key = idempotencyKeyFrom(formHtml);

  const sent = await fetch(`${base}/projects/proj_http/messages/new`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      connection: "close",
    },
    body: new URLSearchParams({
      csrf_token: csrf,
      idempotency_key: key,
      speaker_id: "spk_http",
      summary: "HTTP compose summary",
      text: "HTTP compose body",
      type: "note",
      language: "en",
      reply_to_id: "",
      body_expires_at: "",
    }).toString(),
  });
  assert.equal(sent.status, 303, "the adapter must buffer the compose POST body");
  assert.equal(sent.headers.get("location"), "/projects/proj_http");

  const timeline = await fetch(`${base}/projects/proj_http`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(timeline.status, 200);
  const timelineHtml = await timeline.text();
  assert.ok(timelineHtml.includes("HTTP compose summary"));
  assert.ok(timelineHtml.includes("#1"));
});
