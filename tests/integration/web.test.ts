import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { sha256Hex } from "../../src/domain/digest.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProject, resolveSessionViewer } from "../../src/service/auth.ts";
import { sendMessage, markRead } from "../../src/service/messages.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
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
  options: { path?: string; cookie?: string; contentType?: string } = {},
): Promise<Response> {
  const form = new URLSearchParams(fields);
  const headers: Record<string, string> = {
    "content-type": options.contentType ?? "application/x-www-form-urlencoded",
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

test("a session viewer can never authorize a write scope", async (t) => {
  const { fx } = await withApp(t);
  await basicProject(fx);
  const session = { sessionId: "sess_test", accountId: "acct_a" };
  const viewer = await resolveSessionViewer(fx.deps, session, "proj_a", "message.read");
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
