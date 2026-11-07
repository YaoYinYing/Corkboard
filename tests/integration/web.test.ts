import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, type RequestLogEntry } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { sha256Hex } from "../../src/domain/digest.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProject, resolveSessionViewer } from "../../src/service/auth.ts";
import {
  getMessageBody,
  listMessages,
  markRead,
  sendMessage,
} from "../../src/service/messages.ts";
import { expireMessageBody } from "../../src/service/expiry.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
import { createProject } from "../../src/service/projects.ts";
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
}): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return {
    fx,
    app: createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } }),
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

async function loginFormCsrf(app: App): Promise<string> {
  const response = await call(app, "/login");
  assert.equal(response.status, 200);
  const csrf = cookieValue(response.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(csrf);
  return csrf;
}

function loginSubmit(
  app: App,
  csrf: string | undefined,
  fields: Record<string, string>,
  options: {
    path?: string;
    cookie?: string;
    contentType?: string;
    headers?: Record<string, string>;
  } = {},
): Promise<Response> {
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
    ...(options.headers ?? {}),
  };
  const cookie =
    options.cookie ?? (csrf === undefined ? undefined : `${WEB_LOGIN_CSRF_COOKIE}=${csrf}`);
  if (cookie !== undefined) headers.cookie = cookie;
  return call(app, options.path ?? "/login", {
    method: "POST",
    headers,
    body: form.toString(),
  });
}

async function loginAs(
  app: App,
  email: string,
  password: string,
  returnTo = "/",
): Promise<{ cookie: string; response: Response }> {
  const csrf = await loginFormCsrf(app);
  const response = await loginSubmit(app, csrf, {
    return_to: returnTo,
    login_csrf: csrf,
    email,
    password,
  });
  assert.equal(response.status, 303);
  const session = cookieValue(response.headers.getSetCookie(), SESSION_COOKIE_NAME);
  assert.ok(session);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}`,
    response,
  };
}

async function loginAsWithCsrf(
  app: App,
  email: string,
  password: string,
): Promise<{ cookie: string; csrf: string }> {
  const loginCsrf = await loginFormCsrf(app);
  const response = await loginSubmit(app, loginCsrf, {
    return_to: "/",
    login_csrf: loginCsrf,
    email,
    password,
  });
  assert.equal(response.status, 303);
  const cookies = response.headers.getSetCookie();
  const session = cookieValue(cookies, SESSION_COOKIE_NAME);
  const csrf = cookieValue(cookies, CSRF_COOKIE_NAME);
  assert.ok(session);
  assert.ok(csrf);
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

function postForm(
  app: App,
  path: string,
  cookie: string | undefined,
  fields: Record<string, string>,
): Promise<Response> {
  return call(app, path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: new URLSearchParams(fields).toString(),
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

async function send(
  fx: ServiceFixture,
  token: string,
  projectId: string,
  key: string,
  summary: string,
  text: string,
  replyToId: string | null = null,
): Promise<{ messageId: string; seq: number }> {
  const principal = await fx.authenticate(token);
  const bodyDigest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;
  return sendMessage(fx.deps, principal, projectId, key, {
    summary,
    type: "note",
    language: "en",
    text,
    bodyDigest,
    replyToId,
  });
}

async function sendTyped(
  fx: ServiceFixture,
  token: string,
  projectId: string,
  key: string,
  summary: string,
  text: string,
  type: string,
): Promise<{ messageId: string; seq: number }> {
  const principal = await fx.authenticate(token);
  const bodyDigest = `sha256:${await sha256Hex(new TextEncoder().encode(text))}`;
  return sendMessage(fx.deps, principal, projectId, key, {
    summary,
    type,
    language: "en",
    text,
    bodyDigest,
  });
}

// A second owned speaker in the same project, used for the sender filter.
async function addProjectSpeaker(
  fx: ServiceFixture,
  projectId: string,
  speakerId: string,
  accountId = "acct_a",
): Promise<{ token: string; credentialId: string }> {
  await fx.addSpeaker(speakerId, accountId);
  await fx.addMembership(projectId, speakerId, ALL_SCOPES);
  return fx.addCredential({ speakerId });
}

function messageSeqs(html: string): number[] {
  return [...html.matchAll(/class="seq">#(\d+)</g)].map((match) => Number(match[1]));
}

async function basicProject(
  fx: ServiceFixture,
  accountId = "acct_a",
  speakerId = "spk_a",
  projectId = "proj_a",
  email = "a@example.test",
  password = "correct horse",
): Promise<{ token: string; credentialId: string }> {
  await addPasswordAccount(fx, accountId, email, password);
  await fx.addSpeaker(speakerId, accountId);
  await fx.addProject(projectId, accountId);
  await fx.addMembership(projectId, speakerId, ALL_SCOPES);
  return fx.addCredential({ speakerId });
}

function assertHardened(response: Response): void {
  assert.equal(response.headers.get("content-security-policy"), WEB_CSP);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
}

test("dashboard lists authorized projects with escaped metadata and hardened headers", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  await fx.db.run("UPDATE projects SET title = ?, summary = ? WHERE id = ?", [
    `"><script>alert('project')</script>`,
    `summary & <b>bold</b> "quoted"`,
    "proj_a",
  ]);
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [
    `<img src=x onerror="alert(1)">`,
    "spk_a",
  ]);

  const { cookie } = await loginAs(app, "a@example.test", "correct horse");
  const page = await getPage(app, "/", cookie);
  assert.equal(page.status, 200);
  assertHardened(page.response);
  assert.match(page.html, /<html lang="en" dir="ltr">/);
  assert.ok(page.html.includes('href="/projects/proj_a"'));
  assert.ok(page.html.includes("&lt;script&gt;alert(&#39;project&#39;)&lt;/script&gt;"));
  assert.ok(page.html.includes("summary &amp; &lt;b&gt;bold&lt;/b&gt; &quot;quoted&quot;"));
  assert.ok(page.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.equal(page.html.includes("<script>alert"), false);
  assert.equal(page.html.includes("<img src=x"), false);
  assert.ok(page.html.includes("Active"));
  // Accessibility structure asserted in the committed HTML: skip link, banner,
  // labeled navigation, main landmark, and the current-language marker.
  assert.ok(page.html.includes('<a class="skip-link" href="#main">'));
  assert.ok(page.html.includes('<header class="site-header">'));
  assert.ok(page.html.includes('<nav aria-label="Language">'));
  assert.ok(page.html.includes('<main id="main" tabindex="-1">'));
  assert.ok(page.html.includes('lang="en" hreflang="en" aria-current="true"'));
  assert.ok(page.html.includes('lang="zh-Hans" hreflang="zh-Hans"'));
});

test("no eligible speaker, removed membership, and another account's project are uniform 404", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [
    "SECRET PROJECT TITLE",
    "proj_a",
  ]);
  const { messageId } = await send(fx, (await fx.addCredential({ speakerId: "spk_a" })).token, "proj_a", "k1", "s", "body");

  // No speaker at all.
  await addPasswordAccount(fx, "acct_none", "none@example.test", "none password");
  const none = await loginAs(app, "none@example.test", "none password");
  const noneTimeline = await getPage(app, "/projects/proj_a", none.cookie);
  assert.equal(noneTimeline.status, 404);
  assert.equal(noneTimeline.html.includes("SECRET PROJECT TITLE"), false);
  const noneBody = await getPage(
    app,
    `/projects/proj_a/messages/${messageId}/body`,
    none.cookie,
  );
  assert.equal(noneBody.status, 404);

  // A different account with its own project cannot see this one.
  await basicProject(fx, "acct_d", "spk_d", "proj_d", "d@example.test", "d password");
  const other = await loginAs(app, "d@example.test", "d password");
  const otherTimeline = await getPage(app, "/projects/proj_a", other.cookie);
  assert.equal(otherTimeline.status, 404);
  assert.equal(otherTimeline.html.includes("SECRET PROJECT TITLE"), false);
  // Filters, including malformed ones, never change a uniform unreadable 404.
  for (const query of [
    "?type=note&sender=spk_a&q=secret&unread=true",
    "?limit=0",
  ]) {
    const filtered = await getPage(app, `/projects/proj_a${query}`, other.cookie);
    assert.equal(filtered.status, 404, query);
    assert.equal(filtered.html.includes("SECRET PROJECT TITLE"), false, query);
  }
  const otherDashboard = await getPage(app, "/", other.cookie);
  assert.ok(otherDashboard.html.includes("proj_d"));
  assert.equal(otherDashboard.html.includes("SECRET PROJECT TITLE"), false);

  // Removed membership behaves like non-membership.
  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    ["2026-11-03T13:00:00.000Z", "proj_a", "spk_a"],
  );
  const removed = await loginAs(app, "a@example.test", "correct horse");
  const removedTimeline = await getPage(app, "/projects/proj_a", removed.cookie);
  assert.equal(removedTimeline.status, 404);
  assert.equal(removedTimeline.html.includes("SECRET PROJECT TITLE"), false);
});

test("a session viewer can read but can never authorize a write scope", async (t) => {
  const { fx } = await withApp(t);
  const credential = await basicProject(fx);
  const message = await send(
    fx,
    credential.token,
    "proj_a",
    "viewer-read",
    "viewer summary",
    "viewer body",
  );
  const session = { sessionId: "sess_test", accountId: "acct_a" };
  const viewer = await resolveSessionViewer(fx.deps, session, "proj_a", "message.read");
  assert.deepEqual([...viewer.scopes], ["message.read"]);

  const access = await authorizeProject(fx.deps, viewer, "proj_a", "message.read");
  // The membership has every capability, but the session rights are only the
  // requested read. markRead's receipt.write check must therefore fail.
  assert.deepEqual([...access.rights], ["message.read"]);
  assert.deepEqual([...access.capabilities], ["message.read"]);

  // Read paths still work.
  assert.equal((await listMessages(fx.deps, viewer, "proj_a")).messages.length, 1);
  assert.equal(
    (await getMessageBody(fx.deps, viewer, "proj_a", message.messageId)).text,
    "viewer body",
  );

  await assert.rejects(
    markRead(fx.deps, viewer, "proj_a", message.messageId),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    expireMessageBody(fx.deps, viewer, "proj_a", message.messageId),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    sendMessage(fx.deps, viewer, "proj_a", "viewer-write", {
      summary: "summary",
      type: "note",
      language: "en",
      text: "text",
      bodyDigest: `sha256:${"0".repeat(64)}`,
    }),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    authorizeProject(fx.deps, viewer, "proj_a", "message.send"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    resolveSessionViewer(fx.deps, session, "proj_a", "message.send"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
});

test("revoked, expired, and suspended sessions redirect to normalized login", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);

  const revoked = await loginAs(app, "a@example.test", "correct horse");
  await fx.db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ?", [
    "2026-11-03T13:00:00.000Z",
    "acct_a",
  ]);
  const revokedPage = await getPage(app, "/projects/proj_a?lang=zh", revoked.cookie);
  assert.equal(revokedPage.status, 303);
  assert.equal(
    revokedPage.response.headers.get("location"),
    "/login?return_to=%2Fprojects%2Fproj_a%3Flang%3Dzh&lang=zh",
  );
  assert.equal(revokedPage.response.headers.get("cache-control"), "no-store");
  assert.equal(revokedPage.response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(revokedPage.response.headers.get("referrer-policy"), "no-referrer");

  const expired = await loginAs(app, "a@example.test", "correct horse");
  await fx.db.run("UPDATE sessions SET expires_at = ? WHERE account_id = ?", [
    "2026-11-03T11:00:00.000Z",
    "acct_a",
  ]);
  assert.equal((await getPage(app, "/", expired.cookie)).status, 303);

  const suspended = await loginAs(app, "a@example.test", "correct horse");
  await fx.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", ["acct_a"]);
  assert.equal((await getPage(app, "/", suspended.cookie)).status, 303);
});

test("timeline is ascending, carries metadata and receipts, omits bodies, and shows tombstones", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [
    "Alice & Co",
    "spk_a",
  ]);
  const first = await send(fx, credential.token, "proj_a", "k1", "first <summary>", "TIMELINE-BODY-MUST-NOT-APPEAR", null);
  const second = await send(fx, credential.token, "proj_a", "k2", "second", "second body", null);
  await send(fx, credential.token, "proj_a", "k3", "third", "third body", first.messageId);
  await markRead(fx.deps, await fx.authenticate(credential.token), "proj_a", first.messageId);

  const { cookie } = await loginAs(app, "a@example.test", "correct horse");
  const page = await getPage(app, "/projects/proj_a", cookie);
  assert.equal(page.status, 200);
  assertHardened(page.response);
  assert.ok(page.html.includes("first &lt;summary&gt;"));
  const positions = ["first &lt;summary&gt;", "second", "third"].map((text) =>
    page.html.indexOf(text),
  );
  assert.ok(positions.every((position) => position >= 0));
  assert.ok(positions[0]! < positions[1]! && positions[1]! < positions[2]!);
  assert.ok(page.html.includes("Alice &amp; Co"));
  assert.ok(page.html.includes(`href="#msg-${first.messageId}">#1</a>`));
  assert.ok(page.html.includes("UTC"));
  assert.ok(page.html.includes(`Read by`));
  assert.ok(page.html.includes("Alice &amp; Co"));
  assert.equal(page.html.includes("TIMELINE-BODY-MUST-NOT-APPEAR"), false);

  // The tombstone keeps metadata but loses its reveal link.
  await fx.expireMessage(second.messageId);
  const tombstoned = await getPage(app, "/projects/proj_a", cookie);
  assert.ok(tombstoned.html.includes("This message body has expired."));
  assert.equal(
    tombstoned.html.includes(`/messages/${second.messageId}/body`),
    false,
  );
  assert.ok(tombstoned.html.includes(`/messages/${first.messageId}/body`));
});

test("timeline pagination reuses the API bounds and keeps ascending order", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  for (let index = 1; index <= 3; index += 1) {
    await send(fx, credential.token, "proj_a", `k${index}`, `summary ${index}`, `body ${index}`);
  }
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const limited = await getPage(app, "/projects/proj_a?limit=1", cookie);
  assert.equal(limited.status, 200);
  assert.equal((limited.html.match(/class="message"/g) ?? []).length, 1);

  const older = await getPage(app, "/projects/proj_a?before_seq=2", cookie);
  assert.equal(older.status, 200);
  assert.ok(older.html.includes("summary 1"));
  assert.equal(older.html.includes("summary 2"), false);
  assert.equal(older.html.includes("summary 3"), false);

  const newer = await getPage(app, "/projects/proj_a?after_seq=1", cookie);
  assert.equal(newer.status, 200);
  assert.equal(newer.html.includes("summary 1"), false);
  assert.ok(newer.html.includes("summary 2"));
  assert.ok(newer.html.includes("summary 3"));

  for (const query of ["limit=0", "limit=101", "after_seq=abc", "after_seq=1&before_seq=2"]) {
    const bad = await getPage(app, `/projects/proj_a?${query}`, cookie);
    assert.equal(bad.status, 400, query);
  }
});

test("timeline filters by type, sender, summary substring, and unread with reflected state", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const otherSpeaker = await addProjectSpeaker(fx, "proj_a", "spk_b");
  const first = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "f1",
    "Alpha release note",
    "body one",
    "note",
  );
  const second = await sendTyped(
    fx,
    otherSpeaker.token,
    "proj_a",
    "f2",
    "Beta request",
    "body two",
    "request",
  );
  const third = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "f3",
    "Gamma ALPHA follow-up",
    "body three",
    "note",
  );
  await markRead(fx.deps, await fx.authenticate(credential.token), "proj_a", first.messageId);

  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const notes = await getPage(app, "/projects/proj_a?type=note", cookie);
  assert.equal(notes.status, 200);
  assert.deepEqual(messageSeqs(notes.html), [first.seq, third.seq]);
  assert.ok(notes.html.includes("Alpha release note"));
  assert.equal(notes.html.includes("Beta request"), false);
  assert.ok(notes.html.includes("Active filters"));
  assert.ok(notes.html.includes("<code>note</code>"));
  assert.ok(notes.html.includes("Clear filters"));

  const bySender = await getPage(app, "/projects/proj_a?sender=spk_b", cookie);
  assert.deepEqual(messageSeqs(bySender.html), [second.seq]);
  assert.ok(bySender.html.includes("Beta request"));
  assert.ok(bySender.html.includes("<code>spk_b</code>"));

  // SQLite LIKE is ASCII case-insensitive, matching the REST contract.
  for (const query of ["alpha", "ALPHA"]) {
    const search = await getPage(app, `/projects/proj_a?q=${query}`, cookie);
    assert.deepEqual(messageSeqs(search.html), [first.seq, third.seq], query);
    assert.ok(search.html.includes(`name="q" type="search" maxlength="100" value="${query}"`));
  }

  const unread = await getPage(app, "/projects/proj_a?unread=true", cookie);
  assert.deepEqual(messageSeqs(unread.html), [second.seq, third.seq]);
  assert.equal(unread.html.includes("Alpha release note"), false);
  // The REST meaning of unread=false is "has a receipt for this viewer". It is
  // an active filter, not an absent one.
  const readToo = await getPage(app, "/projects/proj_a?unread=false", cookie);
  assert.deepEqual(messageSeqs(readToo.html), [first.seq]);
  assert.ok(readToo.html.includes("Read only"));
  assert.ok(readToo.html.includes("Clear filters"));

  const combined = await getPage(
    app,
    "/projects/proj_a?type=note&q=alpha&unread=true",
    cookie,
  );
  assert.deepEqual(messageSeqs(combined.html), [third.seq]);

  // The body-only term must never match: q is a summary search.
  const bodyOnly = await getPage(app, "/projects/proj_a?q=body%20two", cookie);
  assert.equal(bodyOnly.status, 200);
  assert.deepEqual(messageSeqs(bodyOnly.html), []);
  assert.ok(bodyOnly.html.includes("No messages match these filters."));

  // A tombstone retains metadata and still matches metadata filters.
  await fx.expireMessage(first.messageId);
  const tombstone = await getPage(app, "/projects/proj_a?type=note&q=alpha", cookie);
  assert.ok(tombstone.html.includes("Alpha release note"));
  assert.ok(tombstone.html.includes("This message body has expired."));
  assert.equal(tombstone.html.includes(`/messages/${first.messageId}/body`), false);
});

test("unread=false is an active read-only filter with a filtered empty state", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const message = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "r1",
    "Only unread message",
    "body",
    "note",
  );
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const none = await getPage(app, "/projects/proj_a?unread=false", cookie);
  assert.equal(none.status, 200);
  assert.deepEqual(messageSeqs(none.html), []);
  assert.ok(none.html.includes("Read only"));
  assert.ok(none.html.includes("Active filters"));
  assert.ok(none.html.includes("Clear filters"));
  assert.ok(none.html.includes("No messages match these filters."));
  assert.equal(none.html.includes("No messages yet."), false);

  await markRead(fx.deps, await fx.authenticate(credential.token), "proj_a", message.messageId);
  const matched = await getPage(app, "/projects/proj_a?unread=false", cookie);
  assert.deepEqual(messageSeqs(matched.html), [message.seq]);
  assert.ok(matched.html.includes("Read only"));
});

test("summary search ignores body text, escapes reflected input, and rejects malformed filters", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "s1",
    "Visible summary",
    "BODYONLYTERM secret",
    "note",
  );
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const bodyOnly = await getPage(app, "/projects/proj_a?q=BODYONLYTERM", cookie);
  assert.equal(bodyOnly.status, 200);
  assert.equal(bodyOnly.html.includes("Visible summary"), false);
  assert.ok(bodyOnly.html.includes("No messages match these filters."));

  const payload = `"><script>alert(1)</script>`;
  const xss = await getPage(
    app,
    `/projects/proj_a?q=${encodeURIComponent(payload)}`,
    cookie,
  );
  assert.equal(xss.status, 200);
  assert.equal(xss.html.includes("<script>alert(1)</script>"), false);
  assert.ok(xss.html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));

  for (const query of [
    "limit=0",
    "limit=101",
    "limit=abc",
    "after_seq=abc",
    "after_seq=1&before_seq=2",
    "unread=yes",
    "type=NOTVALID",
    `q=${"a".repeat(101)}`,
    "sender=spk_missing",
  ]) {
    const bad = await getPage(app, `/projects/proj_a?${query}`, cookie);
    assert.equal(bad.status, 400, query);
    assert.equal(bad.html.includes("<script"), false, query);
  }
});

// The filter form submits every control, so leaving Sender (or Type, search,
// limit, unread) empty produces a blank query value. Blank means "not set".
test("blank timeline filter values are absent, not invalid", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const first = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "blank1",
    "Blank first",
    "body one",
    "note",
  );
  const second = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "blank2",
    "Blank second",
    "body two",
    "request",
  );
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const expected = [first.seq, second.seq];
  for (const query of [
    "sender=",
    "type=",
    "q=",
    "limit=",
    "unread=",
    "after_seq=",
    "before_seq=",
    "type=&sender=&q=&limit=&unread=",
  ]) {
    const page = await getPage(app, `/projects/proj_a?${query}`, cookie);
    assert.equal(page.status, 200, query);
    assert.deepEqual(messageSeqs(page.html), expected, query);
    assert.ok(page.html.includes("No filters applied."), query);
    assert.equal(page.html.includes("Clear filters"), false, query);
  }

  // Whitespace-only is absent too. Non-blank values are never stripped, so
  // whitespace around an invalid identifier remains invalid below.
  for (const query of ["sender=%20%20", "type=%20", "q=%20%20", "limit=%20"]) {
    const page = await getPage(app, `/projects/proj_a?${query}`, cookie);
    assert.equal(page.status, 200, query);
    assert.deepEqual(messageSeqs(page.html), expected, query);
    assert.ok(page.html.includes("No filters applied."), query);
  }

  const blankSender = await getPage(app, "/projects/proj_a?sender=", cookie);
  assert.ok(
    blankSender.html.includes('id="filter-sender" name="sender" type="text" maxlength="128" value=""'),
  );

  // Blank handling must not loosen validation for supplied values.
  for (const query of [
    "sender=%20spk_a%20",
    "type=NOTVALID",
    "limit=0",
    "limit=abc",
    "unread=yes",
    "after_seq=abc",
    `q=${"a".repeat(101)}`,
  ]) {
    const bad = await getPage(app, `/projects/proj_a?${query}`, cookie);
    assert.equal(bad.status, 400, query);
  }
});

test("cursor paging is bounded forward and backward with no duplicate or skipped rows", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  for (let index = 1; index <= 5; index += 1) {
    await sendTyped(
      fx,
      credential.token,
      "proj_a",
      `p${index}`,
      `page ${index}`,
      `body ${index}`,
      "note",
    );
  }
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const firstPage = await getPage(app, "/projects/proj_a?limit=2", cookie);
  assert.deepEqual(messageSeqs(firstPage.html), [1, 2]);
  assert.ok(firstPage.html.includes("after_seq=2"));
  assert.equal(firstPage.html.includes("before_seq=3"), false);
  assert.ok(firstPage.html.includes("Jump to latest"));
  assert.ok(firstPage.html.includes("before_seq=9007199254740991"));

  const secondPage = await getPage(app, "/projects/proj_a?limit=2&after_seq=2", cookie);
  assert.deepEqual(messageSeqs(secondPage.html), [3, 4]);
  assert.ok(secondPage.html.includes("before_seq=3"));
  assert.ok(secondPage.html.includes("after_seq=4"));

  const thirdPage = await getPage(app, "/projects/proj_a?limit=2&after_seq=4", cookie);
  assert.deepEqual(messageSeqs(thirdPage.html), [5]);
  assert.equal(thirdPage.html.includes("after_seq=5"), false);
  assert.equal(thirdPage.html.includes("Jump to latest"), false);

  const latest = await getPage(
    app,
    "/projects/proj_a?limit=2&before_seq=9007199254740991",
    cookie,
  );
  assert.deepEqual(messageSeqs(latest.html), [4, 5]);
  assert.equal(latest.html.includes("Jump to latest"), false);
  assert.ok(latest.html.includes("before_seq=4"));

  const backward = await getPage(app, "/projects/proj_a?limit=2&before_seq=5", cookie);
  assert.deepEqual(messageSeqs(backward.html), [3, 4]);
  const oldest = await getPage(app, "/projects/proj_a?limit=2&before_seq=3", cookie);
  assert.deepEqual(messageSeqs(oldest.html), [1, 2]);

  // An empty page renders only the empty state plus jump-to-latest; it never
  // renders older/newer links.
  const pastEnd = await getPage(app, "/projects/proj_a?limit=2&after_seq=5", cookie);
  assert.equal(pastEnd.status, 200);
  assert.deepEqual(messageSeqs(pastEnd.html), []);
  assert.ok(pastEnd.html.includes("No messages yet."));
  assert.ok(pastEnd.html.includes("Jump to latest"));
  assert.equal(pastEnd.html.includes('rel="prev"'), false);
  assert.equal(pastEnd.html.includes('rel="next"'), false);

  // Walk backward from the latest page using its own cursors, which must not
  // repeat or skip rows.
  const backFromLatest = await getPage(app, "/projects/proj_a?limit=2&before_seq=4", cookie);
  assert.deepEqual(messageSeqs(backFromLatest.html), [2, 3]);
  const backToStart = await getPage(app, "/projects/proj_a?limit=2&before_seq=2", cookie);
  assert.deepEqual(messageSeqs(backToStart.html), [1]);

  assert.deepEqual(
    [
      ...messageSeqs(firstPage.html),
      ...messageSeqs(secondPage.html),
      ...messageSeqs(thirdPage.html),
    ],
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(
    [
      ...messageSeqs(backToStart.html),
      ...messageSeqs(backFromLatest.html),
      ...messageSeqs(latest.html),
    ],
    [1, 2, 3, 4, 5],
  );
});

test("filters preserve the locale and the page stays CSS-only and responsive", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const first = await sendTyped(
    fx,
    credential.token,
    "proj_a",
    "l1",
    "locale one",
    "body",
    "note",
  );
  await sendTyped(fx, credential.token, "proj_a", "l2", "locale two", "body", "note");
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const zh = await getPage(app, "/projects/proj_a?lang=zh&type=note&limit=1", cookie);
  assert.equal(zh.status, 200);
  assertHardened(zh.response);
  assert.match(zh.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(zh.html.includes("筛选"));
  assert.ok(zh.html.includes("当前筛选"));
  assert.ok(zh.html.includes("时间线"));
  assert.ok(zh.html.includes('name="lang" value="zh"'));
  const nextHref = /<a rel="next" href="([^"]+)"/.exec(zh.html)?.[1] ?? "";
  assert.ok(nextHref.includes("lang=zh"));
  assert.ok(nextHref.includes("after_seq=1"));

  const fallback = await getPage(app, "/projects/proj_a?lang=fr&q=locale", cookie);
  assert.match(fallback.html, /<html lang="en" dir="ltr">/);
  assert.ok(fallback.html.includes("Filters"));

  const projects = await getPage(app, "/", cookie);
  assert.equal(projects.status, 200);
  const body = await getPage(
    app,
    `/projects/proj_a/messages/${first.messageId}/body`,
    cookie,
  );
  assert.equal(body.status, 200);
  const error = await getPage(app, "/projects/proj_a?limit=0", cookie);
  assert.equal(error.status, 400);
  const login = await call(app, "/login");
  assert.equal(login.status, 200);

  const pages = [
    { name: "login", html: await login.text() },
    { name: "project list", html: projects.html },
    { name: "timeline", html: zh.html },
    { name: "timeline fallback", html: fallback.html },
    { name: "message body", html: body.html },
    { name: "error", html: error.html },
  ];
  for (const { name, html } of pages) {
    assert.ok(
      html.includes('<meta name="viewport" content="width=device-width, initial-scale=1">'),
      name,
    );
    assert.ok(html.includes('<link rel="stylesheet" href="/static/app.css">'), name);
    assert.equal(html.includes("<script"), false, name);
    assert.equal(html.includes("<style"), false, name);
    assert.equal(/ style=/.test(html), false, name);
    assert.equal(/ on[a-z]+=/.test(html), false, name);
  }
  for (const label of [
    "filter-type",
    "filter-sender",
    "filter-q",
    "filter-unread",
    "filter-limit",
  ]) {
    assert.ok(zh.html.includes(`<label for="${label}">`), label);
    assert.ok(zh.html.includes(`id="${label}"`), label);
  }

  const cssResponse = await call(app, "/static/app.css");
  assert.equal(cssResponse.status, 200);
  const css = await cssResponse.text();
  assert.ok(css.includes("@media (max-width: 40rem)"));
  assert.ok(css.includes("@media (min-width: 48rem)"));
  assert.match(css, /h1[^{]*\{[^}]*overflow-wrap: anywhere;/);
  assert.equal(css.includes("@import"), false);
  assert.equal(css.includes("url("), false);
});

test("served stylesheet defines the design tokens and no external CSS", async (t) => {
  const { app } = await withApp(t);
  const response = await call(app, "/static/app.css");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(response.headers.get("content-security-policy"), WEB_CSP);
  const css = await response.text();

  const tokens: Record<string, string> = {
    surface: "#fbfaf7",
    "surface-raised": "#ffffff",
    "surface-muted": "#f2eee8",
    ink: "#1c1917",
    "ink-muted": "#5b544c",
    border: "#8a837a",
    brand: "#1f4e46",
    "brand-ink": "#ffffff",
    accent: "#8a4b1f",
    danger: "#a11d3c",
    focus: "#0b5cad",
    link: "#0b5cad",
    success: "#2f6b3a",
    "space-1": "4px",
    "space-2": "8px",
    "space-3": "12px",
    "space-4": "16px",
    "space-6": "24px",
    "space-8": "32px",
    "radius-sm": "4px",
    "radius-md": "8px",
    "radius-lg": "12px",
    "font-sans": 'system-ui, -apple-system, "Segoe UI", sans-serif',
    "font-mono": "ui-monospace, SFMono-Regular, Menlo, monospace",
  };
  for (const [name, value] of Object.entries(tokens)) {
    assert.ok(css.includes(`--${name}: ${value};`), `--${name}`);
  }

  const dark = css.slice(css.indexOf("@media (prefers-color-scheme: dark)"));
  assert.ok(dark.includes("color-scheme: dark;"));
  for (const [name, value] of Object.entries({
    surface: "#141210",
    "surface-raised": "#1d1a17",
    "surface-muted": "#272320",
    ink: "#f4efe7",
    "ink-muted": "#c9c2b7",
    border: "#7d766c",
    brand: "#8fd3c3",
    "brand-ink": "#10201c",
    accent: "#e6a371",
    danger: "#f4a6b4",
    focus: "#9ccbff",
    link: "#a8d1ff",
    success: "#a9d9b0",
  })) {
    assert.ok(dark.includes(`--${name}: ${value};`), `dark --${name}`);
  }

  // The CSP allows one same-origin stylesheet only. Token definitions hold the
  // palette literals; every other colour-bearing declaration must resolve
  // through a custom property, and no line may use a hex/rgb/hsl literal.
  const colorProperty =
    /^(?:color|background|background-color|border[a-z-]*|outline|fill|stroke|box-shadow|text-shadow)$/;
  const colorKeyword = /^(?:none|transparent|currentcolor|inherit)$/i;
  for (const line of css.split("\n")) {
    if (/^\s*--[a-z0-9-]+:/.test(line)) continue;
    assert.equal(/#[0-9a-fA-F]{3,8}/.test(line), false, line);
    assert.equal(/\brgba?\s*\(/i.test(line), false, line);
    assert.equal(/\bhsla?\s*\(/i.test(line), false, line);
    for (const declaration of line.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)/gi)) {
      const property = (declaration[1] ?? "").toLowerCase();
      if (!colorProperty.test(property)) continue;
      const value = (declaration[2] ?? "").trim();
      assert.ok(
        value.includes("var(") || colorKeyword.test(value),
        `${property}: ${value} must use a token variable`,
      );
    }
  }
  assert.equal(css.includes("@import"), false);
  assert.equal(css.includes("url("), false);
  assert.equal(css.includes("<style"), false);
});

test("body reveal returns escaped plaintext in a pre element and safe failures", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const message = await send(
    fx,
    credential.token,
    "proj_a",
    "k1",
    "body summary",
    `<script>alert("body")</script> & "quoted"`,
  );
  await basicProject(fx, "acct_d", "spk_d", "proj_d", "d@example.test", "d password");
  const other = await loginAs(app, "d@example.test", "d password");

  const { cookie } = await loginAs(app, "a@example.test", "correct horse");
  const revealed = await getPage(
    app,
    `/projects/proj_a/messages/${message.messageId}/body`,
    cookie,
  );
  assert.equal(revealed.status, 200);
  assertHardened(revealed.response);
  assert.ok(revealed.html.includes("<pre class=\"body-text\""));
  assert.ok(revealed.html.includes("&lt;script&gt;alert(&quot;body&quot;)&lt;/script&gt; &amp; &quot;quoted&quot;"));
  assert.equal(revealed.html.includes('<script>alert("body")</script>'), false);

  const denied = await getPage(
    app,
    `/projects/proj_a/messages/${message.messageId}/body`,
    other.cookie,
  );
  assert.equal(denied.status, 404);
  assert.equal(denied.html.includes("&lt;script&gt;alert"), false);
  assert.equal(denied.html.includes('<script>alert("body")</script>'), false);

  const wrongProject = await getPage(
    app,
    `/projects/proj_d/messages/${message.messageId}/body`,
    cookie,
  );
  assert.equal(wrongProject.status, 404);

  await fx.expireMessage(message.messageId);
  const expired = await getPage(
    app,
    `/projects/proj_a/messages/${message.messageId}/body`,
    cookie,
  );
  assert.equal(expired.status, 410);
  assert.equal(expired.html.includes("&lt;script&gt;alert"), false);
  assert.equal(expired.html.includes('<script>alert("body")</script>'), false);
});

test("i18n defaults to English, selects Chinese, falls back safely, and preserves the path", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  const english = await getPage(app, "/", cookie);
  assert.match(english.html, /<html lang="en" dir="ltr">/);
  assert.ok(english.html.includes("Projects"));
  assert.ok(english.html.includes('href="/?lang=zh"'));

  const chinese = await getPage(app, "/?lang=zh", cookie);
  assert.match(chinese.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(chinese.html.includes("项目"));
  assert.ok(chinese.html.includes("成员"));
  assert.ok(chinese.html.includes('href="/?lang=en"'));

  const fallback = await getPage(app, "/?lang=fr", cookie);
  assert.match(fallback.html, /<html lang="en" dir="ltr">/);
  assert.ok(fallback.html.includes("Projects"));

  const timeline = await getPage(app, "/projects/proj_a?lang=zh", cookie);
  assert.ok(timeline.html.includes("时间线"));
  assert.ok(timeline.html.includes('href="/projects/proj_a?lang=en"'));
});

test("duplicate leading slashes never produce scheme-relative navigation links", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");

  for (const [path, expected] of [
    ["//", 'href="/?lang=zh"'],
    ["//projects/proj_a", 'href="/projects/proj_a?lang=zh"'],
  ] as const) {
    const page = await getPage(app, path, cookie);
    assert.equal(page.status, 200, path);
    assert.equal(page.html.includes('href="//'), false, path);
    assert.ok(page.html.includes(expected), path);
  }
});

test("login requires a matching double-submit CSRF value and rejects unsafe return_to", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);

  const form = await call(app, "/login");
  assert.equal(form.status, 200);
  assertHardened(form);
  const formHtml = await form.text();
  assert.ok(formHtml.includes('name="login_csrf"'));
  assert.ok(formHtml.includes('name="return_to"'));
  assert.ok(formHtml.includes('<label for="email">'));
  assert.ok(formHtml.includes('<label for="password">'));

  const csrf = cookieValue(form.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(csrf);

  const missing = await loginSubmit(app, undefined, {
    return_to: "/",
    email: "a@example.test",
    password: "correct horse",
  });
  assert.equal(missing.status, 400);
  assert.equal(cookieValue(missing.headers.getSetCookie(), SESSION_COOKIE_NAME), undefined);

  const wrong = await loginSubmit(app, "wrong-value", {
    return_to: "/",
    login_csrf: "different-value",
    email: "a@example.test",
    password: "correct horse",
  });
  assert.equal(wrong.status, 400);
  assert.equal(cookieValue(wrong.headers.getSetCookie(), SESSION_COOKIE_NAME), undefined);

  const wrongType = await loginSubmit(
    app,
    csrf,
    {
      return_to: "/",
      login_csrf: csrf,
      email: "a@example.test",
      password: "correct horse",
    },
    { contentType: "application/json" },
  );
  assert.equal(wrongType.status, 400);

  for (const unsafe of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    `/${"a".repeat(2049)}`,
    "/\r\nLocation: https://evil.example",
  ]) {
    const response = await loginSubmit(app, csrf, {
      return_to: unsafe,
      login_csrf: csrf,
      email: "a@example.test",
      password: "correct horse",
    });
    assert.equal(response.status, 400, unsafe);
    assert.equal(response.headers.get("location"), null, unsafe);
    assert.equal(
      cookieValue(response.headers.getSetCookie(), SESSION_COOKIE_NAME),
      undefined,
      unsafe,
    );
  }

  const badPassword = await loginSubmit(app, csrf, {
    return_to: "/",
    login_csrf: csrf,
    email: "a@example.test",
    password: "wrong password",
  });
  assert.equal(badPassword.status, 401);
  assert.equal(
    cookieValue(badPassword.headers.getSetCookie(), SESSION_COOKIE_NAME),
    undefined,
  );

  const ok = await loginSubmit(app, csrf, {
    return_to: "/projects/proj_a?x=1#fragment",
    login_csrf: csrf,
    email: "a@example.test",
    password: "correct horse",
  });
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), "/projects/proj_a?x=1");
  const setCookies = ok.headers.getSetCookie();
  assert.ok(cookieValue(setCookies, SESSION_COOKIE_NAME));
  assert.ok(cookieValue(setCookies, CSRF_COOKIE_NAME));
  assert.ok(setCookies.some((cookie) => cookie.startsWith(`${WEB_LOGIN_CSRF_COOKIE}=;`)));
});

test("an unauthenticated long URL redirects to a bounded same-origin login form", async (t) => {
  const { app } = await withApp(t);
  const longQuery = `x=${"a".repeat(3000)}`;
  const original = await call(app, `/projects/proj_a?${longQuery}`);
  assert.equal(original.status, 303);
  const location = original.headers.get("location");
  assert.ok(location);
  assert.ok(location.startsWith("/login?return_to=%2Fprojects%2Fproj_a"));
  assert.equal(location.includes("a".repeat(3000)), false);
  assert.equal(new URL(location, "http://localhost").origin, "http://localhost");

  // The bounded Location must be accepted by the login page, not rejected by
  // its own return_to validator.
  const form = await call(app, location);
  assert.equal(form.status, 200);
  assertHardened(form);
  assert.ok((await form.text()).includes('name="login_csrf"'));
});

test("login rejects cross-site fetch metadata and duplicate CSRF fields with the retry page", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx, "acct_a", "spk_a", "proj_a", "a@example.test", "known-login-secret");
  const csrf = await loginFormCsrf(app);
  const fields = {
    return_to: "/",
    login_csrf: csrf,
    email: "a@example.test",
    password: "known-login-secret",
  };

  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const response = await loginSubmit(app, csrf, fields, { headers });
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.ok((await response.text()).includes("The sign-in form expired"));
    assert.equal(
      cookieValue(response.headers.getSetCookie(), SESSION_COOKIE_NAME),
      undefined,
    );
  }

  const duplicate = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    duplicate.append(name, value);
  }
  duplicate.append("login_csrf", csrf);
  const duplicateResponse = await call(app, "/login", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${WEB_LOGIN_CSRF_COOKIE}=${csrf}`,
    },
    body: duplicate.toString(),
  });
  assert.equal(duplicateResponse.status, 400);
  assert.ok((await duplicateResponse.text()).includes("The sign-in form expired"));
  assert.equal(
    cookieValue(duplicateResponse.headers.getSetCookie(), SESSION_COOKIE_NAME),
    undefined,
  );

  // A matching origin and same-origin fetch metadata still authenticate.
  const accepted = await loginSubmit(app, csrf, fields, {
    headers: { origin: "http://localhost", "sec-fetch-site": "same-origin" },
  });
  assert.equal(accepted.status, 303);

  // An opaque/null Origin is not a usable assertion; the double-submit value
  // still authenticates. Headless Chrome sends this for a script-submitted form.
  const opaque = await loginSubmit(app, csrf, fields, { headers: { origin: "null" } });
  assert.equal(opaque.status, 303);
});

test("listing parses capabilities instead of substring matching", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_m", "m@example.test", "malformed-secret");
  await fx.addSpeaker("spk_m", "acct_m");
  await fx.addProject("proj_m", "acct_m");
  // Contains the exact '"project.read"' token as a substring but is not JSON;
  // the old instr() filter would have listed this project.
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_m", "spk_m", 'not-json "project.read" not-json', "2026-11-03T12:00:00.000Z"],
  );

  const { cookie } = await loginAs(app, "m@example.test", "malformed-secret");
  const dashboard = await getPage(app, "/", cookie);
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.html.includes("proj_m"), false);
  assert.ok(dashboard.html.includes("No projects are available for this account."));
  assert.equal((await getPage(app, "/projects/proj_m", cookie)).status, 404);
});

test("per-read capabilities gate listing, timeline, and body with uniform 404", async (t) => {
  const { fx, app } = await withApp(t);

  // project.read only: listed, but the timeline and body are uniform 404.
  await addPasswordAccount(fx, "acct_r", "r@example.test", "read only");
  await fx.addSpeaker("spk_r", "acct_r");
  await fx.addProject("proj_r", "acct_r");
  await fx.addMembership("proj_r", "spk_r", ["project.read"]);
  const readOnly = await loginAs(app, "r@example.test", "read only");
  const readDashboard = await getPage(app, "/", readOnly.cookie);
  assert.ok(readDashboard.html.includes("proj_r"));
  assert.equal((await getPage(app, "/projects/proj_r", readOnly.cookie)).status, 404);
  assert.equal(
    (await getPage(app, "/projects/proj_r/messages/msg_any/body", readOnly.cookie)).status,
    404,
  );

  // message.read/send but no project.read: timeline/body work by direct URL,
  // but the project is not listed because the listing capability is
  // project.read. message.send is only so this fixture can create the body.
  await addPasswordAccount(fx, "acct_w", "w@example.test", "message only");
  await fx.addSpeaker("spk_w", "acct_w");
  await fx.addProject("proj_w", "acct_w");
  await fx.addMembership("proj_w", "spk_w", ["message.read", "message.send"]);
  const messageOnly = await fx.addCredential({ speakerId: "spk_w" });
  const sent = await send(fx, messageOnly.token, "proj_w", "msg-only", "summary", "body");
  const messageCookie = await loginAs(app, "w@example.test", "message only");
  const messageDashboard = await getPage(app, "/", messageCookie.cookie);
  assert.equal(messageDashboard.html.includes("proj_w"), false);
  assert.equal((await getPage(app, "/projects/proj_w", messageCookie.cookie)).status, 200);
  assert.equal(
    (
      await getPage(
        app,
        `/projects/proj_w/messages/${sent.messageId}/body`,
        messageCookie.cookie,
      )
    ).status,
    200,
  );

  // No read capability: listing empty and every project read is 404.
  await addPasswordAccount(fx, "acct_n", "n@example.test", "no read");
  await fx.addSpeaker("spk_n", "acct_n");
  await fx.addProject("proj_n", "acct_n");
  await fx.addMembership("proj_n", "spk_n", ["message.send"]);
  const none = await loginAs(app, "n@example.test", "no read");
  const noneDashboard = await getPage(app, "/", none.cookie);
  assert.ok(noneDashboard.html.includes("No projects are available for this account."));
  assert.equal((await getPage(app, "/projects/proj_n", none.cookie)).status, 404);
});

test("timeline and body GETs create no receipts and mutate no message tables", async (t) => {
  const { fx, app } = await withApp(t);
  const credential = await basicProject(fx);
  const message = await send(
    fx,
    credential.token,
    "proj_a",
    "no-write",
    "read-only summary",
    "read-only body",
  );
  const counts = async () => ({
    messages: (await fx.db.all<{ id: string }>("SELECT id FROM messages")).length,
    receipts: (await fx.db.all<{ message_id: string }>("SELECT message_id FROM message_receipts"))
      .length,
    bodies: (await fx.db.all<{ id: string }>("SELECT id FROM body_objects")).length,
    audit: (await fx.db.all<{ id: string }>("SELECT id FROM audit_events")).length,
  });
  // Login itself writes a `session.login` audit row; capture counts after it so
  // this test isolates the read-only page GETs under test.
  const { cookie } = await loginAs(app, "a@example.test", "correct horse");
  const before = await counts();

  assert.equal((await getPage(app, "/projects/proj_a", cookie)).status, 200);
  assert.equal(
    (
      await getPage(
        app,
        "/projects/proj_a?type=note&q=read-only&unread=true&limit=10",
        cookie,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await getPage(
        app,
        `/projects/proj_a/messages/${message.messageId}/body`,
        cookie,
      )
    ).status,
    200,
  );

  const after = await counts();
  assert.deepEqual(after, before);
  assert.equal(after.receipts, 0);
});

test("the Node adapter buffers the login form body and serves the full page flow over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-web-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const rootKey = crypto.getRandomValues(new Uint8Array(32));
  const email = "http@example.test";
  const password = "http password";
  const now = "2026-11-03T12:00:00.000Z";
  const { token, publicPrefix } = generateSpeakerToken();
  const credentialId = "cred_http";

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
  await db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [credentialId, "spk_http", publicPrefix, await hashSecret(token, pepper), JSON.stringify(SCOPES), now],
  );
  await db.run(
    `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
     VALUES (?, ?, ?)`,
    [credentialId, "proj_http", now],
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

  const bodyText = "HTTP body <safe>";
  const digest = `sha256:${await sha256Hex(new TextEncoder().encode(bodyText))}`;
  const sent = await fetch(`${base}/api/v1/projects/proj_http/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": "http-key-1",
      connection: "close",
    },
    body: JSON.stringify({
      summary: "HTTP summary",
      type: "note",
      language: "en",
      text: bodyText,
      body_digest: digest,
    }),
  });
  assert.equal(sent.status, 201);
  const sentBody = (await sent.json()) as { message_id: string };

  const loginPage = await fetch(`${base}/login`, { headers: { connection: "close" } });
  assert.equal(loginPage.status, 200);
  const loginCsrf = cookieValue(loginPage.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(loginCsrf);
  const form = new URLSearchParams({
    return_to: "/",
    login_csrf: loginCsrf,
    email,
    password,
  });
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${WEB_LOGIN_CSRF_COOKIE}=${loginCsrf}`,
      connection: "close",
    },
    body: form.toString(),
  });
  assert.equal(login.status, 303, "the adapter must buffer the POST /login body");
  assert.equal(login.headers.get("location"), "/");
  const session = cookieValue(login.headers.getSetCookie(), SESSION_COOKIE_NAME);
  assert.ok(session);
  const cookie = `${SESSION_COOKIE_NAME}=${session}`;

  const dashboard = await fetch(`${base}/`, { headers: { cookie, connection: "close" } });
  assert.equal(dashboard.status, 200);
  const dashboardHtml = await dashboard.text();
  assert.ok(dashboardHtml.includes("HTTP Project"));
  assert.ok(dashboardHtml.includes("HTTP Speaker"));

  const timeline = await fetch(`${base}/projects/proj_http`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(timeline.status, 200);
  const timelineHtml = await timeline.text();
  assert.ok(timelineHtml.includes("HTTP summary"));

  const revealed = await fetch(
    `${base}/projects/proj_http/messages/${sentBody.message_id}/body`,
    { headers: { cookie, connection: "close" } },
  );
  assert.equal(revealed.status, 200);
  const revealedHtml = await revealed.text();
  assert.ok(revealedHtml.includes("HTTP body &lt;safe&gt;"));

  const chinese = await fetch(`${base}/?lang=zh`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(chinese.status, 200);
  assert.ok((await chinese.text()).includes("项目"));
});

test("the Node adapter buffers dashboard project form bodies for create and edit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-web-forms-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const email = "forms@example.test";
  const password = "forms password";
  const now = "2026-11-03T12:00:00.000Z";

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  await db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["acct_forms", email, await hashPassword(password), now],
  );
  await db.run(
    `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["spk_forms", "acct_forms", "Forms Speaker", now],
  );
  await db.run(
    `INSERT INTO projects (id, owner_account_id, title, summary, status, next_seq, created_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?)`,
    ["proj_forms", "acct_forms", "Existing Project", "Before edit", now],
  );
  await db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_forms", "spk_forms", JSON.stringify(SCOPES), now],
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
  const formType = "application/x-www-form-urlencoded";

  // Sign in over HTTP so the request goes through the adapter, not createApp.
  const loginPage = await fetch(`${base}/login`, { headers: { connection: "close" } });
  assert.equal(loginPage.status, 200);
  const loginCsrf = cookieValue(loginPage.headers.getSetCookie(), WEB_LOGIN_CSRF_COOKIE);
  assert.ok(loginCsrf);
  const login = await fetch(`${base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": formType,
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
  const cookie = `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`;

  const postForm = (
    path: string,
    fields: Record<string, string>,
  ): Promise<Response> =>
    fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": formType, cookie, connection: "close" },
      body: new URLSearchParams(fields).toString(),
    });
  const getPage = async (path: string): Promise<{ status: number; html: string }> => {
    const response = await fetch(`${base}${path}`, {
      headers: { cookie, connection: "close" },
    });
    return { status: response.status, html: await response.text() };
  };

  // Create: the adapter must carry the form body to the handler.
  const created = await postForm("/projects", {
    csrf_token: csrf,
    title: "HTTP Created",
    summary: "Created through the adapter",
  });
  assert.equal(created.status, 303, "the adapter must buffer the POST /projects body");
  const location = created.headers.get("location");
  assert.ok(location);
  assert.match(location, /^\/projects\/proj_[A-Za-z0-9_-]+$/);
  assert.equal((await getPage(location)).status, 200);
  assert.ok((await getPage("/")).html.includes("HTTP Created"));

  // Edit: the same predicate covers POST /projects/:projectId.
  const updated = await postForm("/projects/proj_forms", {
    csrf_token: csrf,
    title: "HTTP Edited",
    summary: "Edited through the adapter",
  });
  assert.equal(updated.status, 303, "the adapter must buffer the POST /projects/:id body");
  assert.equal(updated.headers.get("location"), "/projects/proj_forms");
  assert.ok((await getPage("/projects/proj_forms")).html.includes("HTTP Edited"));

  // Missing or wrong CSRF stays the handler's safe 400 form-expired page.
  for (const fields of [
    { title: "Missing CSRF" },
    { csrf_token: "A".repeat(43), title: "Wrong CSRF" },
  ]) {
    const rejected = await postForm("/projects", fields);
    assert.equal(rejected.status, 400);
    assert.ok((await rejected.text()).includes("The form expired."));
  }

  // Chunked bodies have no Content-Length, so only a buffering adapter can
  // enforce the cap. Before the fix the body was dropped and the handler saw
  // an empty form instead of an oversized request.
  const encoder = new TextEncoder();
  const chunked = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("csrf_token=" + csrf + "&title="));
      controller.enqueue(encoder.encode("x".repeat(70 * 1024)));
      controller.close();
    },
  });
  const oversizedChunked = await fetch(`${base}/projects`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, cookie, connection: "close" },
    body: chunked,
    duplex: "half",
  });
  assert.equal(oversizedChunked.status, 413);
  assert.equal(
    ((await oversizedChunked.json()) as { error: { code: string } }).error.code,
    "REQUEST_TOO_LARGE",
  );

  const oversizedDeclared = await fetch(`${base}/projects`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, cookie, connection: "close" },
    body: new Uint8Array(70 * 1024),
  });
  assert.equal(oversizedDeclared.status, 413);
  assert.equal(
    ((await oversizedDeclared.json()) as { error: { code: string } }).error.code,
    "REQUEST_TOO_LARGE",
  );

  // Unauthenticated body-bearing POSTs keep the handler's login redirect.
  for (const path of ["/projects", "/projects/proj_forms"]) {
    const anonymousForm = new URLSearchParams({ title: "Anonymous" }).toString();
    const anonymous = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": formType, connection: "close" },
      body: anonymousForm,
    });
    assert.equal(anonymous.status, 303);
    assert.equal(
      anonymous.headers.get("location"),
      `/login?return_to=${encodeURIComponent(path)}`,
    );
  }
});

test("an authenticated account creates a project and the owner can edit it", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_c", "c@example.test", "create secret");
  await fx.addSpeaker("spk_c", "acct_c");
  const { cookie, csrf } = await loginAsWithCsrf(app, "c@example.test", "create secret");

  const form = await getPage(app, "/projects/new", cookie);
  assert.equal(form.status, 200);
  assertHardened(form.response);
  assert.ok(form.html.includes('name="csrf_token"'));
  assert.ok(form.html.includes('method="post" action="/projects"'));
  assert.ok(form.html.includes('<label for="project-title">'));
  assert.ok(form.html.includes('<label for="project-summary">'));
  assert.ok(form.html.includes('<a href="/">Cancel</a>'));

  const chinese = await getPage(app, "/projects/new?lang=zh", cookie);
  assert.equal(chinese.status, 200);
  assert.match(chinese.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(chinese.html.includes("新建项目"));
  assert.ok(chinese.html.includes('method="post" action="/projects?lang=zh"'));

  const countRows = async (table: string): Promise<number> =>
    (await fx.db.all<{ id: number }>(`SELECT 1 AS id FROM ${table}`)).length;
  const before = {
    speakers: await countRows("speakers"),
    credentials: await countRows("credentials"),
    grants: await countRows("credential_project_grants"),
  };

  const created = await postForm(app, "/projects", cookie, {
    csrf_token: csrf,
    title: "Created project",
    summary: "Created summary",
  });
  assert.equal(created.status, 303);
  const location = created.headers.get("location");
  assert.ok(location);
  assert.match(location, /^\/projects\/proj_[A-Za-z0-9_-]+$/);
  const projectId = location.slice("/projects/".length);

  const membership = await fx.db.first<{ capabilities: string }>(
    "SELECT capabilities FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    [projectId, "spk_c"],
  );
  assert.ok(membership);
  assert.deepEqual([...JSON.parse(membership.capabilities)].sort(), [...SCOPES].sort());
  // Create writes the project and owner membership only; no speaker,
  // credential, or credential-to-project grant is created implicitly.
  assert.deepEqual(
    {
      speakers: await countRows("speakers"),
      credentials: await countRows("credentials"),
      grants: await countRows("credential_project_grants"),
    },
    before,
  );

  const dashboard = await getPage(app, "/", cookie);
  assert.equal(dashboard.status, 200);
  assert.ok(dashboard.html.includes("Created project"));
  assert.ok(dashboard.html.includes("Created summary"));
  assert.ok(dashboard.html.includes('href="/projects/new"'));

  const timeline = await getPage(app, location, cookie);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.html.includes("Created project"));
  assert.ok(timeline.html.includes(`href="/projects/${projectId}/edit"`));
  // Create is linked from the dashboard, not from the timeline.
  assert.equal(timeline.html.includes('href="/projects/new"'), false);

  const edit = await getPage(app, `/projects/${projectId}/edit`, cookie);
  assert.equal(edit.status, 200);
  assertHardened(edit.response);
  assert.ok(edit.html.includes('value="Created project"'));
  assert.ok(edit.html.includes("Created summary"));

  const updated = await postForm(app, `/projects/${projectId}`, cookie, {
    csrf_token: csrf,
    title: "Edited project",
    summary: "Edited summary",
  });
  assert.equal(updated.status, 303);
  assert.equal(updated.headers.get("location"), `/projects/${projectId}`);
  const row = await fx.db.first<{ title: string; summary: string | null }>(
    "SELECT title, summary FROM projects WHERE id = ?",
    [projectId],
  );
  assert.deepEqual(row, { title: "Edited project", summary: "Edited summary" });

  const localizedCreate = await postForm(app, "/projects?lang=zh", cookie, {
    csrf_token: csrf,
    title: "本地化创建",
  });
  assert.equal(localizedCreate.status, 303);
  const localizedLocation = localizedCreate.headers.get("location");
  assert.ok(localizedLocation);
  assert.match(localizedLocation, /^\/projects\/proj_[A-Za-z0-9_-]+\?lang=zh$/);
});

test("project create requires an active owned speaker and writes nothing otherwise", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_ns", "ns@example.test", "no speaker secret");
  const { cookie, csrf } = await loginAsWithCsrf(app, "ns@example.test", "no speaker secret");
  const response = await postForm(app, "/projects", cookie, {
    csrf_token: csrf,
    title: "No owner",
  });
  assert.equal(response.status, 400);
  assert.ok((await response.text()).includes('role="alert"'));
  assert.equal((await fx.db.all<{ id: string }>("SELECT id FROM projects")).length, 0);
});

// Failure injection for the second insert of project creation. The wrapper
// applies inside a transaction as well, so the test is meaningful on both the
// sequential and transactional implementations.
function withFailingMembershipInsert(db: SqlDatabase): SqlDatabase {
  const wrap = (target: SqlTransaction): SqlTransaction => ({
    all: <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> =>
      target.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      target.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      sql.includes("INSERT INTO project_memberships")
        ? Promise.reject(new Error("injected owner-membership insert failure"))
        : target.run(sql, params),
  });
  return {
    exec: (sql: string): Promise<void> => db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> =>
      db.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      db.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      wrap(db).run(sql, params),
    transaction: <T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> =>
      db.transaction((tx) => fn(wrap(tx))),
  };
}

test("a failed owner-membership insert rolls the project back", async (t) => {
  const { fx } = await withApp(t);
  await addPasswordAccount(fx, "acct_atomic", "atomic@example.test", "atomic secret");
  await fx.addSpeaker("spk_atomic", "acct_atomic");
  const deps = { ...fx.deps, db: withFailingMembershipInsert(fx.deps.db) };
  const principal = {
    credentialId: "cred_atomic",
    speakerId: "spk_atomic",
    accountId: "acct_atomic",
    scopes: new Set(SCOPES),
    sessionViewer: true as const,
  };

  await assert.rejects(
    createProject(deps, principal, { title: "Atomic create", summary: null }),
    /injected owner-membership insert failure/,
  );

  // No active project may exist without the owner membership: a rolled-back
  // create leaves neither row, not an invisible orphan project.
  assert.deepEqual(await fx.db.all("SELECT id FROM projects"), []);
  assert.deepEqual(await fx.db.all("SELECT project_id FROM project_memberships"), []);
});

test("create assigns the owner membership to the deterministic first owned speaker", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_two", "two@example.test", "two speakers");
  await fx.db.run(
    `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["spk_later", "acct_two", "Later", "2026-11-03T12:00:00.000Z"],
  );
  await fx.db.run(
    `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["spk_first", "acct_two", "First", "2026-11-03T11:00:00.000Z"],
  );
  const { cookie, csrf } = await loginAsWithCsrf(app, "two@example.test", "two speakers");

  const created = await postForm(app, "/projects", cookie, {
    csrf_token: csrf,
    title: "Two speakers",
  });
  assert.equal(created.status, 303);
  const location = created.headers.get("location");
  assert.ok(location);
  const projectId = location.slice("/projects/".length);
  const memberships = await fx.db.all<{ speaker_id: string; capabilities: string }>(
    "SELECT speaker_id, capabilities FROM project_memberships WHERE project_id = ?",
    [projectId],
  );
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0]?.speaker_id, "spk_first");
  assert.deepEqual([...JSON.parse(memberships[0]?.capabilities ?? "[]")].sort(), [...SCOPES].sort());
});

test("project update redirects after POST and persists a cleared summary", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "correct horse");

  const updated = await postForm(app, "/projects/proj_a", cookie, {
    csrf_token: csrf,
    title: "Owner title",
    summary: "   ",
  });
  assert.equal(updated.status, 303);
  assert.equal(updated.headers.get("location"), "/projects/proj_a");

  const row = await fx.db.first<{ title: string; summary: string | null; updated_at: string | null }>(
    "SELECT title, summary, updated_at FROM projects WHERE id = ?",
    ["proj_a"],
  );
  assert.equal(row?.title, "Owner title");
  assert.equal(row?.summary, null);
  assert.ok(row?.updated_at);

  const localized = await postForm(app, "/projects/proj_a?lang=zh", cookie, {
    csrf_token: csrf,
    title: "本地化标题",
    summary: "本地化说明",
  });
  assert.equal(localized.status, 303);
  assert.equal(localized.headers.get("location"), "/projects/proj_a?lang=zh");

  const dashboard = await getPage(app, "/", cookie);
  assert.ok(dashboard.html.includes("本地化标题"));
});

test("project write forms require a matching double-submit CSRF value", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "correct horse");
  const before = await fx.db.first<{ title: string }>(
    "SELECT title FROM projects WHERE id = ?",
    ["proj_a"],
  );
  const projectCount = async (): Promise<number> =>
    (await fx.db.all<{ id: string }>("SELECT id FROM projects")).length;

  const missing = await postForm(app, "/projects/proj_a", cookie, { title: "Hijacked" });
  assert.equal(missing.status, 400);
  const missingHtml = await missing.text();
  assert.ok(missingHtml.includes('role="alert"'));
  assert.ok(missingHtml.includes("The form expired"));

  const wrong = await postForm(app, "/projects/proj_a", cookie, {
    csrf_token: "wrong-value",
    title: "Hijacked",
  });
  assert.equal(wrong.status, 400);

  const noCookie = await postForm(app, "/projects/proj_a", cookie.split("; ")[0], {
    csrf_token: csrf,
    title: "Hijacked",
  });
  assert.equal(noCookie.status, 400);

  const crossSite = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      origin: "https://evil.example",
    },
    body: new URLSearchParams({ csrf_token: csrf, title: "Hijacked" }).toString(),
  });
  assert.equal(crossSite.status, 400);

  const crossSiteFetch = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
      "sec-fetch-site": "cross-site",
    },
    body: new URLSearchParams({ csrf_token: csrf, title: "Hijacked" }).toString(),
  });
  assert.equal(crossSiteFetch.status, 400);

  // A matching cookie/form pair is still rejected when it is not the session's
  // CSRF value: the double submit is only the outer check.
  const sessionOnly = cookie.split("; ")[0];
  const unboundValue = "unbound-double-submit-value";
  const unbound = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${sessionOnly}; ${CSRF_COOKIE_NAME}=${unboundValue}`,
    },
    body: new URLSearchParams({ csrf_token: unboundValue, title: "Hijacked" }).toString(),
  });
  assert.equal(unbound.status, 400);
  assert.ok((await unbound.text()).includes("The form expired"));

  const after = await fx.db.first<{ title: string }>(
    "SELECT title FROM projects WHERE id = ?",
    ["proj_a"],
  );
  assert.deepEqual(after, before);

  const countBeforeCreate = await projectCount();
  const createMissing = await postForm(app, "/projects", cookie, {
    title: "Should not exist",
  });
  assert.equal(createMissing.status, 400);
  assert.equal(await projectCount(), countBeforeCreate);
});

test("unauthenticated project write routes redirect to the login form", async (t) => {
  const { app } = await withApp(t);

  for (const [path, method] of [
    ["/projects/new", "GET"],
    ["/projects", "POST"],
    ["/projects/proj_a", "POST"],
    ["/projects/proj_a/edit", "GET"],
  ] as const) {
    const response = await call(app, path, {
      method,
      ...(method === "POST"
        ? {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "title=x",
          }
        : {}),
    });
    assert.equal(response.status, 303, `${method} ${path}`);
    const location = response.headers.get("location");
    assert.ok(location);
    assert.ok(location.startsWith("/login?return_to=%2Fprojects"), `${method} ${path}`);
    assert.equal(new URL(location, "http://localhost").origin, "http://localhost");
  }
});

test("foreign, unknown, and non-owner project edit/update are uniform 404", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  await basicProject(fx, "acct_d", "spk_d", "proj_d", "d@example.test", "d secret");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [
    "SECRET OWNER TITLE",
    "proj_a",
  ]);

  // Foreign account: the project exists but is indistinguishable from a miss.
  const other = await loginAsWithCsrf(app, "d@example.test", "d secret");
  for (const path of ["/projects/proj_a/edit", "/projects/proj_missing/edit"]) {
    const page = await getPage(app, path, other.cookie);
    assert.equal(page.status, 404, path);
    assert.equal(page.html.includes("SECRET OWNER TITLE"), false, path);
  }
  const foreignUpdate = await postForm(app, "/projects/proj_a", other.cookie, {
    csrf_token: other.csrf,
    title: "Stolen",
  });
  assert.equal(foreignUpdate.status, 404);
  // Authorization precedes body parsing: a malformed body changes nothing.
  const foreignJson = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: other.cookie },
    body: "not json",
  });
  assert.equal(foreignJson.status, 404);

  // An active member without project.edit is a 404 on the owner-only routes,
  // while the read-only timeline remains available.
  await addPasswordAccount(fx, "acct_m", "m@example.test", "member secret");
  await fx.addSpeaker("spk_m", "acct_m");
  await fx.addMembership("proj_a", "spk_m", [
    "project.read",
    "message.read",
    "message.send",
    "receipt.write",
  ]);
  const member = await loginAsWithCsrf(app, "m@example.test", "member secret");
  const memberTimeline = await getPage(app, "/projects/proj_a", member.cookie);
  assert.equal(memberTimeline.status, 200);
  // The timeline renders the edit link only for a project.edit viewer.
  assert.equal(memberTimeline.html.includes('href="/projects/proj_a/edit"'), false);
  const memberEdit = await getPage(app, "/projects/proj_a/edit", member.cookie);
  assert.equal(memberEdit.status, 404);
  assert.equal(memberEdit.html.includes("SECRET OWNER TITLE"), false);
  const memberUpdate = await postForm(app, "/projects/proj_a", member.cookie, {
    csrf_token: member.csrf,
    title: "Member edit",
  });
  assert.equal(memberUpdate.status, 404);

  const row = await fx.db.first<{ title: string }>(
    "SELECT title FROM projects WHERE id = ?",
    ["proj_a"],
  );
  assert.deepEqual(row, { title: "SECRET OWNER TITLE" });
});

test("invalid project input re-renders the form with escaped values and no write", async (t) => {
  const { fx, app } = await withApp(t);
  await basicProject(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "correct horse");

  for (const fields of [
    { title: "", summary: "keep me" },
    { title: "   ", summary: "" },
    { title: "a".repeat(141), summary: "" },
    { title: "valid", summary: "b".repeat(141) },
  ]) {
    const response = await postForm(app, "/projects/proj_a", cookie, {
      csrf_token: csrf,
      ...fields,
    });
    assert.equal(response.status, 400, JSON.stringify(fields).slice(0, 40));
    const html = await response.text();
    assert.ok(html.includes('role="alert"'), "error summary");
    assert.ok(html.includes("Check the project details"), "localized error");
    assert.ok(html.includes(`value="${fields.title}"`), "title preserved");
    assert.ok(html.includes(`>${fields.summary}</textarea>`), "summary preserved");
    assert.equal(html.includes("<script>alert"), false);
  }

  const duplicateBody =
    new URLSearchParams({ csrf_token: csrf, title: "one", summary: "" }).toString() +
    "&title=two";
  const duplicate = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: duplicateBody,
  });
  assert.equal(duplicate.status, 400);

  const duplicateSummaryBody =
    new URLSearchParams({ csrf_token: csrf, title: "valid", summary: "one" }).toString() +
    "&summary=two";
  const duplicateSummary = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: duplicateSummaryBody,
  });
  assert.equal(duplicateSummary.status, 400);
  assert.ok((await duplicateSummary.text()).includes("Check the project details"));

  const duplicateCsrfBody =
    new URLSearchParams({ csrf_token: csrf, title: "valid", summary: "" }).toString() +
    `&csrf_token=${encodeURIComponent(csrf)}`;
  const duplicateCsrf = await call(app, "/projects/proj_a", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: duplicateCsrfBody,
  });
  assert.equal(duplicateCsrf.status, 400);
  assert.ok((await duplicateCsrf.text()).includes("The form expired"));

  const row = await fx.db.first<{ title: string }>(
    "SELECT title FROM projects WHERE id = ?",
    ["proj_a"],
  );
  assert.deepEqual(row, { title: "proj_a" });

  // Valid input is still escaped everywhere it is rendered.
  const xssTitle = `"><script>alert(1)</script>`;
  const xssSummary = `<b>summary</b> & "quoted"`;
  const accepted = await postForm(app, "/projects/proj_a", cookie, {
    csrf_token: csrf,
    title: xssTitle,
    summary: xssSummary,
  });
  assert.equal(accepted.status, 303);
  const edit = await getPage(app, "/projects/proj_a/edit", cookie);
  assert.ok(edit.html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(edit.html.includes("&lt;b&gt;summary&lt;/b&gt; &amp; &quot;quoted&quot;"));
  assert.equal(edit.html.includes("<script>alert(1)</script>"), false);
  const dashboard = await getPage(app, "/", cookie);
  assert.equal(dashboard.html.includes("<script>alert(1)</script>"), false);
});

test("oversized project form bodies fail safely without a write", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_o", "o@example.test", "oversize secret");
  await fx.addSpeaker("spk_o", "acct_o");
  const { cookie, csrf } = await loginAsWithCsrf(app, "o@example.test", "oversize secret");

  const response = await call(app, "/projects", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: `csrf_token=${encodeURIComponent(csrf)}&title=${"a".repeat(70_000)}`,
  });
  assert.equal(response.status, 413);
  const html = await response.text();
  assert.ok(html.includes('role="alert"'));
  assert.equal(html.includes("a".repeat(1000)), false);

  const projects = await fx.db.all<{ id: string }>("SELECT id FROM projects");
  assert.equal(projects.length, 0);
});

test("project write HTML exposes no session token or credential content and logs carry no content or CSRF value", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const entries: RequestLogEntry[] = [];
  const app = createApp(fx.deps, {
    loginRateLimit: { perMinute: 600, burst: 100 },
    logger: (entry) => entries.push(entry),
  });
  await addPasswordAccount(fx, "acct_l", "l@example.test", "log secret");
  await fx.addSpeaker("spk_l", "acct_l");
  const { cookie, csrf } = await loginAsWithCsrf(app, "l@example.test", "log secret");

  const title = "SECRET-TITLE-<b>";
  const summary = "SECRET-SUMMARY-CONTENT";
  const created = await postForm(app, "/projects", cookie, {
    csrf_token: csrf,
    title,
    summary,
  });
  assert.equal(created.status, 303);
  const projectId = created.headers.get("location")?.slice("/projects/".length);
  assert.ok(projectId);

  for (const path of [
    "/projects/new",
    "/",
    `/projects/${projectId}/edit`,
    `/projects/${projectId}`,
  ]) {
    const page = await getPage(app, path, cookie);
    assert.equal(page.status, 200, path);
    const sessionToken = cookie.slice(
      `${SESSION_COOKIE_NAME}=`.length,
      cookie.indexOf(";"),
    );
    assert.equal(page.html.includes(sessionToken), false, path);
    assert.equal(page.html.includes("log secret"), false, path);
  }

  const edit = await getPage(app, `/projects/${projectId}/edit`, cookie);
  assert.ok(edit.html.includes("SECRET-TITLE-&lt;b&gt;"));
  assert.equal(edit.html.includes("SECRET-TITLE-<b>"), false);

  const logs = JSON.stringify(entries);
  for (const forbidden of [title, summary, csrf, "l@example.test", "log secret"]) {
    assert.equal(logs.includes(forbidden), false, forbidden);
  }
  assert.ok(logs.includes("/projects"));
});
