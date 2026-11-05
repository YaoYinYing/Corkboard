import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, type RequestLogEntry } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { hashSecret } from "../../src/auth/credentials.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProject, sessionAccountPrincipal } from "../../src/service/auth.ts";
import { issueProjectCredential } from "../../src/service/speakers.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import type { SqlDatabase, SqlTransaction, SqlValue } from "../../src/storage/db.ts";
import { startServer } from "../../src/platforms/node/main.ts";
import { createServiceFixture, ALL_SCOPES, type ServiceFixture } from "../helpers/service-fixture.ts";

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
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

function postFormMulti(
  app: App,
  path: string,
  cookie: string | undefined,
  fields: ReadonlyArray<readonly [string, string]>,
): Promise<Response> {
  const body = new URLSearchParams();
  for (const [name, value] of fields) body.append(name, value);
  return call(app, path, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie === undefined ? {} : { cookie }),
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

function assertHardened(response: Response): void {
  assert.equal(response.headers.get("content-security-policy"), WEB_CSP);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
}

const TOKEN_RE = /\bcb_[A-Za-z0-9_-]{43}\b/;

function delegateDatabase(db: SqlDatabase, transaction: SqlDatabase["transaction"]): SqlDatabase {
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

// Simulates a membership removal landing after the service's pre-check but
// before its in-transaction re-read.
function withMembershipRemovedDuringTransaction(db: SqlDatabase): SqlDatabase {
  return delegateDatabase(db, (fn) =>
    db.transaction(async (tx) => {
      await tx.run(
        "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
        ["2026-11-03T12:30:00.000Z", "proj_a", "spk_a"],
      );
      return fn(tx);
    }),
  );
}

// Simulates a capability downgrade landing after the pre-check but before the
// in-transaction re-check.
function withCapabilityDowngradedDuringTransaction(db: SqlDatabase): SqlDatabase {
  return delegateDatabase(db, (fn) =>
    db.transaction(async (tx) => {
      await tx.run(
        "UPDATE project_memberships SET capabilities = ? WHERE project_id = ? AND speaker_id = ?",
        [JSON.stringify(["message.read"]), "proj_a", "spk_a"],
      );
      return fn(tx);
    }),
  );
}

// Forces the second write of the issuance transaction to fail so the rollback
// path is exercised deterministically.
function withFailingGrantInsert(db: SqlDatabase): SqlDatabase {
  const wrap = (target: SqlTransaction): SqlTransaction => ({
    all: <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> => target.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      target.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      sql.includes("INSERT INTO credential_project_grants")
        ? Promise.reject(new Error("injected grant insert failure"))
        : target.run(sql, params),
  });
  return delegateDatabase(db, (fn) => db.transaction((tx) => fn(wrap(tx))));
}

function sessionPrincipal(accountId: string) {
  return sessionAccountPrincipal({ sessionId: "sess_test", accountId });
}

async function credentialCount(fx: ServiceFixture): Promise<number> {
  return (await fx.db.all<{ id: string }>("SELECT id FROM credentials")).length;
}

async function basicSpeakerSetup(fx: ServiceFixture): Promise<void> {
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_b", "acct_a");
  await fx.addProject("proj_a", "acct_a");
  await fx.addProject("proj_b", "acct_a");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Alpha project", "proj_a"]);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Beta project", "proj_b"]);
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
  await fx.addMembership("proj_b", "spk_a", ["project.read", "message.read"]);
  await fx.addMembership("proj_a", "spk_b", ["project.read", "message.read"]);

  await addPasswordAccount(fx, "acct_d", "d@example.test", "account d secret");
  await fx.addSpeaker("spk_d", "acct_d");
  await fx.addProject("proj_d", "acct_d");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Foreign project", "proj_d"]);
  await fx.addMembership("proj_d", "spk_d", ALL_SCOPES);
}

test("speaker directory is owner-only and a key issue is explicit, scoped, and displayed once", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const directory = await getPage(app, "/speakers", cookie);
  assert.equal(directory.status, 200);
  assertHardened(directory.response);
  assert.match(directory.html, /<html lang="en" dir="ltr">/);
  assert.ok(directory.html.includes("Alpha project"));
  assert.ok(directory.html.includes("Beta project"));
  assert.ok(directory.html.includes("<code>spk_a</code>"));
  assert.ok(directory.html.includes("<code>spk_b</code>"));
  assert.ok(directory.html.includes('href="/speakers/spk_a/key"'));
  // Another account's speaker and project never appear, even as a name.
  assert.equal(directory.html.includes("spk_d"), false);
  assert.equal(directory.html.includes("Foreign project"), false);
  assert.equal(directory.html.includes("proj_d"), false);

  const form = await getPage(app, "/speakers/spk_a/key", cookie);
  assert.equal(form.status, 200);
  assertHardened(form.response);
  assert.ok(form.html.includes('method="post" action="/speakers/spk_a/key"'));
  assert.ok(form.html.includes('name="csrf_token"'));
  assert.ok(form.html.includes('name="project" value="proj_a"'));
  assert.ok(form.html.includes('name="project" value="proj_b"'));
  for (const scope of SCOPES) {
    assert.ok(form.html.includes(`name="scope" value="${scope}"`), scope);
  }
  assert.ok(form.html.includes("<legend>Projects</legend>"));
  assert.ok(form.html.includes("<legend>Scopes</legend>"));

  const issued = await postFormMulti(app, "/speakers/spk_a/key", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
    ["scope", "message.read"],
  ]);
  assert.equal(issued.status, 200);
  assert.equal(issued.headers.get("location"), null);
  assertHardened(issued);
  const html = await issued.text();
  const token = TOKEN_RE.exec(html)?.[0];
  assert.ok(token, "the POST response must show the credential once");
  assert.ok(html.includes("Copy this credential now."));
  assert.equal(html.match(new RegExp(TOKEN_RE, "g"))?.length, 1);

  const [credential] = await fx.db.all<{
    id: string;
    speaker_id: string;
    public_prefix: string;
    secret_verifier: string;
    scope_json: string;
    expires_at: string | null;
  }>(
    "SELECT id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at FROM credentials",
  );
  assert.ok(credential);
  assert.equal(credential.speaker_id, "spk_a");
  assert.equal(credential.scope_json, JSON.stringify(["project.read", "message.read"]));
  assert.equal(credential.expires_at, null);
  assert.equal(token.slice(0, 12), credential.public_prefix);
  assert.equal(credential.secret_verifier, await hashSecret(token, fx.deps.pepper));
  assert.notEqual(credential.secret_verifier, token);
  // Only the selected project gets a grant, and the raw token is not stored.
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [credential.id],
  );
  assert.deepEqual(grants.map((grant) => grant.project_id), ["proj_a"]);
  const stored = await fx.db.all<Record<string, unknown>>("SELECT * FROM credentials");
  assert.equal(JSON.stringify(stored).includes(token), false);

  // The issued credential authenticates as the speaker and only reaches the
  // selected project with the selected scopes.
  const principal = await fx.authenticate(token);
  assert.equal(principal.speakerId, "spk_a");
  assert.deepEqual([...principal.scopes], ["project.read", "message.read"]);
  await authorizeProject(fx.deps, principal, "proj_a", "message.read");
  for (const [projectId, scope] of [
    ["proj_a", "message.send"],
    ["proj_b", "message.read"],
  ] as const) {
    await assert.rejects(
      authorizeProject(fx.deps, principal, projectId, scope),
      (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
      `${projectId} ${scope}`,
    );
  }

  // Reopening the directory or the form never shows the token again.
  for (const path of ["/speakers", "/speakers/spk_a/key", "/"]) {
    const page = await getPage(app, path, cookie);
    assert.equal(page.status, 200, path);
    assert.equal(page.html.includes(token), false, path);
    assert.equal(page.html.includes(token.slice(0, 12)), false, path);
  }

  // The directory is per-account in both directions.
  const other = await loginAsWithCsrf(app, "d@example.test", "account d secret");
  const otherDirectory = await getPage(app, "/speakers", other.cookie);
  assert.equal(otherDirectory.status, 200);
  assert.ok(otherDirectory.html.includes("spk_d"));
  assert.ok(otherDirectory.html.includes("Foreign project"));
  assert.equal(otherDirectory.html.includes("spk_a"), false);
  assert.equal(otherDirectory.html.includes("Alpha project"), false);
});

test("foreign and unknown speakers are uniform 404 and the owner check gates issuance", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const other = await loginAsWithCsrf(app, "d@example.test", "account d secret");
  const before = await credentialCount(fx);

  // If the owned-speaker query dropped `owner_account_id = ?`, these requests
  // would return 200 and issue a credential for another account's speaker.
  for (const path of ["/speakers/spk_a/key"]) {
    const form = await getPage(app, path, other.cookie);
    assert.equal(form.status, 404, path);
    // The page is the generic error page; it renders no speaker data or form.
    assert.ok(form.html.includes("The requested page is not available."), path);
    assert.equal(form.html.includes("Issue credential"), false, path);
    assert.equal(form.html.includes("<legend>"), false, path);
  }
  const foreignPost = await postFormMulti(app, "/speakers/spk_a/key", other.cookie, [
    ["csrf_token", other.csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(foreignPost.status, 404);
  assert.equal(await credentialCount(fx), before);

  // An unreadable speaker stays 404 even for a malformed body because
  // authorization precedes body parsing.
  const foreignJson = await call(app, "/speakers/spk_a/key", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: other.cookie },
    body: "not json",
  });
  assert.equal(foreignJson.status, 404);

  // An unknown speaker is the same 404 for its owner.
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  for (const speakerId of ["spk_missing", ""]) {
    const path = speakerId === "" ? "/speakers/%20/key" : `/speakers/${speakerId}/key`;
    const page = await getPage(app, path, owner.cookie);
    assert.equal(page.status, 404, path);
  }
  const unknownPost = await postFormMulti(app, "/speakers/spk_missing/key", owner.cookie, [
    ["csrf_token", owner.csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(unknownPost.status, 404);
  assert.equal(await credentialCount(fx), before);
});

test("unauthenticated speaker routes redirect to the normalized login form", async (t) => {
  const { app } = await withApp(t);
  for (const [path, method] of [
    ["/speakers", "GET"],
    ["/speakers/spk_a/key", "GET"],
    ["/speakers/spk_a/key", "POST"],
  ] as const) {
    const response = await call(app, path, {
      method,
      ...(method === "POST"
        ? {
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: "project=proj_a",
          }
        : {}),
    });
    assert.equal(response.status, 303, `${method} ${path}`);
    assert.equal(
      response.headers.get("location"),
      `/login?return_to=${encodeURIComponent(path)}`,
      `${method} ${path}`,
    );
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("credential issuance requires the session double-submit CSRF check", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const sessionOnly = cookie.split("; ")[0];

  const attempts: Array<{ name: string; fields: Array<[string, string]> }> = [
    {
      name: "missing",
      fields: [["project", "proj_a"], ["scope", "project.read"]],
    },
    {
      name: "wrong",
      fields: [["csrf_token", "A".repeat(43)], ["project", "proj_a"], ["scope", "project.read"]],
    },
  ];
  for (const attempt of attempts) {
    const response = await postFormMulti(app, "/speakers/spk_a/key", cookie, attempt.fields);
    assert.equal(response.status, 400, attempt.name);
    const html = await response.text();
    assert.ok(html.includes('role="alert"'), attempt.name);
    assert.ok(html.includes("The form expired."), attempt.name);
    assert.equal(html.includes("Copy this credential now."), false, attempt.name);
  }

  // Missing CSRF cookie while the hidden value matches the session is still a
  // failure: the double submit needs both halves.
  const noCookie = await postFormMulti(app, "/speakers/spk_a/key", sessionOnly, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(noCookie.status, 400);

  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const explicit = await call(app, "/speakers/spk_a/key", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        ...headers,
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        project: "proj_a",
        scope: "project.read",
      }).toString(),
    });
    assert.equal(explicit.status, 400, JSON.stringify(headers));
    assert.ok((await explicit.text()).includes("The form expired."));
  }

  // A matching cookie/form pair that is not bound to the session row is
  // rejected as well.
  const unbound = "unbound-double-submit-value";
  const unboundResponse = await call(app, "/speakers/spk_a/key", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${sessionOnly}; ${CSRF_COOKIE_NAME}=${unbound}`,
    },
    body: new URLSearchParams({
      csrf_token: unbound,
      project: "proj_a",
      scope: "project.read",
    }).toString(),
  });
  assert.equal(unboundResponse.status, 400);
  assert.ok((await unboundResponse.text()).includes("The form expired."));

  assert.equal(await credentialCount(fx), 0);
  assert.equal(
    (await fx.db.all<{ project_id: string }>("SELECT project_id FROM credential_project_grants")).length,
    0,
  );
});

test("invalid, foreign, or non-member project selections are rejected without a write", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  await fx.addProject("proj_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  for (const projects of [
    ["proj_d"], // another account's project
    ["proj_missing"], // unknown project
    ["proj_c"], // active project, but spk_a has no membership
    ["proj_a", "proj_d"], // one valid plus one foreign
    [], // nothing selected
  ]) {
    const fields: Array<[string, string]> = [
      ["csrf_token", csrf],
      ["scope", "project.read"],
    ];
    for (const project of projects) fields.push(["project", project]);
    const response = await postFormMulti(app, "/speakers/spk_a/key", cookie, fields);
    assert.equal(response.status, 400, JSON.stringify(projects));
    const html = await response.text();
    assert.ok(html.includes('role="alert"'), JSON.stringify(projects));
    assert.ok(html.includes("Check the selected projects and scopes"), JSON.stringify(projects));
    assert.equal(html.includes("Copy this credential now."), false, JSON.stringify(projects));
  }

  assert.equal(await credentialCount(fx), 0);
  assert.equal(
    (await fx.db.all<{ project_id: string }>("SELECT project_id FROM credential_project_grants")).length,
    0,
  );
});

test("a scope must be present in every selected project's active membership", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_r", "r@example.test", "scope secret");
  await fx.addSpeaker("spk_r", "acct_r");
  await fx.addProject("proj_read", "acct_r");
  await fx.addProject("proj_send", "acct_r");
  await fx.addMembership("proj_read", "spk_r", ["project.read", "message.read"]);
  await fx.addMembership("proj_send", "spk_r", ["project.read", "message.read", "message.send"]);
  const { cookie, csrf } = await loginAsWithCsrf(app, "r@example.test", "scope secret");

  const attempts: Array<{ projects: string[]; scopes: string[] }> = [
    { projects: ["proj_read"], scopes: ["message.send"] },
    { projects: ["proj_read", "proj_send"], scopes: ["message.send"] },
    { projects: ["proj_send"], scopes: ["project.read", "member.manage"] },
    { projects: ["proj_send"], scopes: ["not-a-scope"] },
    { projects: ["proj_send"], scopes: [] },
  ];
  for (const attempt of attempts) {
    const fields: Array<[string, string]> = [["csrf_token", csrf]];
    for (const project of attempt.projects) fields.push(["project", project]);
    for (const scope of attempt.scopes) fields.push(["scope", scope]);
    const response = await postFormMulti(app, "/speakers/spk_r/key", cookie, fields);
    assert.equal(response.status, 400, JSON.stringify(attempt));
    assert.ok((await response.text()).includes("Check the selected projects and scopes"));
  }
  assert.equal(await credentialCount(fx), 0);

  // A scope present in the selected project is accepted, and the credential
  // carries exactly the requested capability set.
  const accepted = await postFormMulti(app, "/speakers/spk_r/key", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_send"],
    ["scope", "message.send"],
    ["scope", "project.read"],
  ]);
  assert.equal(accepted.status, 200);
  const token = TOKEN_RE.exec(await accepted.text())?.[0];
  assert.ok(token);
  const credential = await fx.db.first<{ scope_json: string; speaker_id: string }>(
    "SELECT scope_json, speaker_id FROM credentials",
  );
  assert.deepEqual(credential, {
    scope_json: JSON.stringify(["project.read", "message.send"]),
    speaker_id: "spk_r",
  });
  const principal = await fx.authenticate(token);
  await authorizeProject(fx.deps, principal, "proj_send", "message.send");
  await assert.rejects(
    authorizeProject(fx.deps, principal, "proj_read", "message.read"),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});

test("inactive owned speakers are listed with status but cannot issue", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  await fx.addSpeaker("spk_off", "acct_a", "inactive");
  await fx.addMembership("proj_a", "spk_off", ALL_SCOPES);
  // A project only the inactive speaker belongs to: the directory must not
  // advertise it, because authorization would deny that speaker.
  await fx.addProject("proj_off", "acct_a");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [
    "Off-only project",
    "proj_off",
  ]);
  await fx.addMembership("proj_off", "spk_off", ALL_SCOPES);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const directory = await getPage(app, "/speakers", cookie);
  assert.ok(directory.html.includes("<code>spk_off</code>"));
  assert.ok(directory.html.includes("Inactive"));
  assert.equal(directory.html.includes("Off-only project"), false);
  assert.equal(directory.html.includes("proj_off"), false);
  assert.ok(directory.html.includes("No active projects."));
  assert.equal(directory.html.includes('href="/speakers/spk_off/key"'), false);

  assert.equal((await getPage(app, "/speakers/spk_off/key", cookie)).status, 404);
  const response = await postFormMulti(app, "/speakers/spk_off/key", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(response.status, 404);
  assert.equal(await credentialCount(fx), 0);
});

test("a membership removed between validation and write rolls the issuance back", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const deps = {
    ...fx.deps,
    db: withMembershipRemovedDuringTransaction(fx.deps.db),
  };
  await assert.rejects(
    issueProjectCredential(deps, sessionPrincipal("acct_a"), "spk_a", {
      projectIds: ["proj_a"],
      scopes: ["project.read"],
    }),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION_ERROR",
  );
  assert.equal(await credentialCount(fx), 0);
  assert.equal(
    (await fx.db.all<{ project_id: string }>("SELECT project_id FROM credential_project_grants")).length,
    0,
  );
  // The injected removal ran inside the issuance transaction, so the rollback
  // restored the membership as well.
  const membership = await fx.db.first<{ removed_at: string | null }>(
    "SELECT removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    ["proj_a", "spk_a"],
  );
  assert.equal(membership?.removed_at, null);
});

test("a capability downgraded between validation and write rolls the issuance back", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const deps = {
    ...fx.deps,
    db: withCapabilityDowngradedDuringTransaction(fx.deps.db),
  };
  // The pre-check sees project.read in the membership; the injected transaction
  // removes it just before the re-read. Without the in-transaction scope check
  // this call would succeed and persist a credential/grant.
  await assert.rejects(
    issueProjectCredential(deps, sessionPrincipal("acct_a"), "spk_a", {
      projectIds: ["proj_a"],
      scopes: ["project.read"],
    }),
    (error: unknown) => error instanceof AppError && error.code === "VALIDATION_ERROR",
  );
  assert.equal(await credentialCount(fx), 0);
  assert.equal(
    (await fx.db.all<{ project_id: string }>("SELECT project_id FROM credential_project_grants")).length,
    0,
  );
  // The injected downgrade ran inside the rolled-back transaction.
  const membership = await fx.db.first<{ capabilities: string }>(
    "SELECT capabilities FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    ["proj_a", "spk_a"],
  );
  assert.deepEqual(JSON.parse(membership?.capabilities ?? "[]"), [...ALL_SCOPES]);
});

test("a failed grant insert rolls the credential back", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const deps = { ...fx.deps, db: withFailingGrantInsert(fx.deps.db) };
  await assert.rejects(
    issueProjectCredential(deps, sessionPrincipal("acct_a"), "spk_a", {
      projectIds: ["proj_a"],
      scopes: ["project.read"],
    }),
    /injected grant insert failure/,
  );
  assert.equal(await credentialCount(fx), 0);
  assert.equal(
    (await fx.db.all<{ project_id: string }>("SELECT project_id FROM credential_project_grants")).length,
    0,
  );
});

test("the directory escapes stored labels and duplicate selections collapse", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const displayName = `<img src=x onerror="alert(1)">`;
  const projectTitle = `"><script>alert('project')</script>`;
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [displayName, "spk_a"]);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", [projectTitle, "proj_a"]);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const directory = await getPage(app, "/speakers", cookie);
  assert.equal(directory.html.includes(displayName), false);
  assert.equal(directory.html.includes(projectTitle), false);
  assert.ok(directory.html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
  assert.ok(directory.html.includes("&quot;&gt;&lt;script&gt;alert(&#39;project&#39;)&lt;/script&gt;"));
  assert.equal(directory.html.includes("<script"), false);

  // Duplicate project and scope fields are collapsed to one grant/scope.
  const issued = await postFormMulti(app, "/speakers/spk_a/key", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["project", "proj_a"],
    ["scope", "project.read"],
    ["scope", "project.read"],
  ]);
  assert.equal(issued.status, 200);
  assert.ok(TOKEN_RE.test(await issued.text()));
  const [credential] = await fx.db.all<{ id: string; scope_json: string }>(
    "SELECT id, scope_json FROM credentials",
  );
  assert.ok(credential);
  assert.equal(credential.scope_json, JSON.stringify(["project.read"]));
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [credential.id],
  );
  assert.deepEqual(grants.map((grant) => grant.project_id), ["proj_a"]);
});

test("a 40-project issuance records every grant and a bounded audit detail", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_bulk", "bulk@example.test", "bulk secret");
  await fx.addSpeaker("spk_bulk", "acct_bulk");
  const projectIds = Array.from(
    { length: 40 },
    (_, index) => `proj_bulk_${String(index).padStart(2, "0")}`,
  );
  for (const projectId of projectIds) {
    await fx.addProject(projectId, "acct_bulk");
    await fx.addMembership(projectId, "spk_bulk", ["project.read"]);
  }
  const { cookie, csrf } = await loginAsWithCsrf(app, "bulk@example.test", "bulk secret");

  const fields: Array<[string, string]> = [
    ["csrf_token", csrf],
    ["scope", "project.read"],
  ];
  for (const projectId of projectIds) fields.push(["project", projectId]);
  const issued = await postFormMulti(app, "/speakers/spk_bulk/key", cookie, fields);
  assert.equal(issued.status, 200);
  assert.ok(TOKEN_RE.test(await issued.text()));

  const credential = await fx.db.first<{ id: string }>("SELECT id FROM credentials");
  assert.ok(credential);
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [credential.id],
  );
  assert.equal(grants.length, 40);
  assert.deepEqual(
    new Set(grants.map((grant) => grant.project_id)),
    new Set(projectIds),
  );

  const audit = await fx.db.first<{ detail: string }>(
    "SELECT detail FROM audit_events WHERE operation = 'credential.issue'",
  );
  assert.ok(audit);
  const detail = JSON.parse(audit.detail) as {
    projects: string[];
    project_count: number;
    scopes: string[];
  };
  assert.equal(detail.project_count, 40);
  assert.equal(detail.projects.length, 32);
  assert.deepEqual(detail.projects, projectIds.slice(0, 32));
  assert.deepEqual(detail.scopes, ["project.read"]);
});

test("more than 100 selected projects are rejected before any membership lookup", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const fields: Array<[string, string]> = [
    ["csrf_token", csrf],
    ["scope", "project.read"],
  ];
  for (let index = 0; index < 101; index += 1) {
    fields.push(["project", `proj_over_${index}`]);
  }
  const response = await postFormMulti(app, "/speakers/spk_a/key", cookie, fields);
  assert.equal(response.status, 400);
  assert.ok((await response.text()).includes("Check the selected projects and scopes"));
  assert.equal(await credentialCount(fx), 0);
});

test("issued tokens never reach request logs, later HTML, or the database", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const entries: RequestLogEntry[] = [];
  const app = createApp(fx.deps, {
    loginRateLimit: { perMinute: 600, burst: 100 },
    logger: (entry) => entries.push(entry),
  });
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const issued = await postFormMulti(app, "/speakers/spk_a/key", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(issued.status, 200);
  const token = TOKEN_RE.exec(await issued.text())?.[0];
  assert.ok(token);

  const logs = JSON.stringify(entries);
  assert.equal(logs.includes(token), false);
  assert.equal(logs.includes(token.slice(0, 12)), false);
  assert.equal(logs.includes(csrf), false);
  assert.ok(logs.includes("/speakers/spk_a/key"));

  const rows = await fx.db.all<Record<string, unknown>>("SELECT * FROM credentials");
  const serialized = JSON.stringify(rows);
  assert.equal(serialized.includes(token), false);
  assert.equal(serialized.includes(token.slice(12)), false);

  for (const path of ["/speakers", "/speakers/spk_a/key", "/", "/?lang=zh"]) {
    const page = await getPage(app, path, cookie);
    assert.equal(page.html.includes(token), false, path);
  }
});

test("speaker pages and errors are localized and ship no inline script or style", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const directory = await getPage(app, "/speakers?lang=zh", cookie);
  assert.equal(directory.status, 200);
  assert.match(directory.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(directory.html.includes("说话者"));
  assert.ok(directory.html.includes("项目授权"));
  assert.ok(directory.html.includes("签发凭证"));

  const form = await getPage(app, "/speakers/spk_a/key?lang=zh", cookie);
  assert.equal(form.status, 200);
  assert.ok(form.html.includes("签发凭证"));
  assert.ok(form.html.includes("项目"));
  assert.ok(form.html.includes("权限范围"));
  assert.ok(form.html.includes('action="/speakers/spk_a/key?lang=zh"'));

  const invalid = await postFormMulti(app, "/speakers/spk_a/key?lang=zh", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(invalid.status, 400);
  const invalidHtml = await invalid.text();
  assert.ok(invalidHtml.includes('role="alert"'));
  assert.ok(invalidHtml.includes("请检查所选项目和权限范围后重试。"));

  const issued = await postFormMulti(app, "/speakers/spk_a/key?lang=zh", cookie, [
    ["csrf_token", csrf],
    ["project", "proj_a"],
    ["scope", "project.read"],
  ]);
  assert.equal(issued.status, 200);
  const issuedHtml = await issued.text();
  assert.ok(issuedHtml.includes("凭证已签发"));
  assert.ok(issuedHtml.includes("请立即复制此凭证。"));
  assert.ok(TOKEN_RE.test(issuedHtml));

  for (const [name, html] of [
    ["directory", directory.html],
    ["form", form.html],
    ["invalid", invalidHtml],
    ["issued", issuedHtml],
  ] as const) {
    assert.equal(html.includes("<script"), false, name);
    assert.equal(html.includes("<style"), false, name);
    assert.equal(/ style=/.test(html), false, name);
    assert.equal(/ on[a-z]+=/.test(html), false, name);
  }
});

test("the Node adapter buffers the speaker key POST body over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-speakers-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const email = "http-speaker@example.test";
  const password = "http speaker secret";
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
    ["proj_http", "acct_http", "HTTP Project", now],
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
      CORKBOARD_ROOT_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"),
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

  const loginPage = await fetch(`${base}/login`, { headers: { connection: "close" } });
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

  const directory = await fetch(`${base}/speakers`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(directory.status, 200);
  assert.ok((await directory.text()).includes("HTTP Speaker"));

  // Before the adapter buffered web POSTs this form arrived body-less and the
  // handler returned the 400 form-expired page.
  const issued = await fetch(`${base}/speakers/spk_http/key`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, cookie, connection: "close" },
    body: new URLSearchParams([
      ["csrf_token", csrf],
      ["project", "proj_http"],
      ["scope", "project.read"],
      ["scope", "message.read"],
    ]).toString(),
  });
  assert.equal(issued.status, 200, "the adapter must buffer the speaker key POST body");
  const issuedHtml = await issued.text();
  assert.ok(TOKEN_RE.test(issuedHtml));

  const formAgain = await fetch(`${base}/speakers/spk_http/key`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(formAgain.status, 200);
  assert.equal(TOKEN_RE.test(await formAgain.text()), false);
});
