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
import { OAUTH_ACCESS_PREFIX } from "../../src/service/oauth.ts";
import {
  grantOwnedSpeakerCredentialProject,
  issueProjectCredential,
  listOwnedSpeakerCredentials,
  revokeOwnedSpeakerCredential,
  revokeOwnedSpeakerCredentialProject,
} from "../../src/service/speakers.ts";
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

// Simulates the speaker's ownership being transferred away after the route's
// authorization check but before the revocation transaction re-reads it.
function withSpeakerReassignedDuringTransaction(db: SqlDatabase): SqlDatabase {
  return delegateDatabase(db, (fn) =>
    db.transaction(async (tx) => {
      await tx.run("UPDATE speakers SET owner_account_id = ? WHERE id = ?", [
        "acct_d",
        "spk_a",
      ]);
      return fn(tx);
    }),
  );
}

// Simulates an ownership transfer landing immediately before the first SELECT
// that matches `matches`, so the read path's independent owner-scoped queries
// are exercised without a snapshot.
function withOwnershipReassignedBefore(
  db: SqlDatabase,
  matches: (sql: string) => boolean,
): SqlDatabase {
  let reassigned = false;
  return {
    exec: (sql: string): Promise<void> => db.exec(sql),
    first: <T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined> =>
      db.first<T>(sql, params),
    all: async <T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> => {
      if (!reassigned && matches(sql)) {
        reassigned = true;
        await db.run("UPDATE speakers SET owner_account_id = ? WHERE id = ?", [
          "acct_d",
          "spk_a",
        ]);
      }
      return db.all<T>(sql, params);
    },
    run: (sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }> =>
      db.run(sql, params),
    transaction: (fn) => db.transaction(fn),
  };
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

test("credential inventory shows non-secret metadata and revokes idempotently", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const first = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read", "message.read"],
  });
  const second = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read"],
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
  });
  const expired = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read"],
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({ speakerId: "spk_a", scopes: ["project.read"] });
  // A corrupt stored expiry must never render as Active: authorization treats an
  // unparseable date as inactive, and the inventory mirrors that fail-closed rule.
  await fx.db.run("UPDATE credentials SET expires_at = ? WHERE id = ?", [
    "not-a-date",
    unknown.credentialId,
  ]);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  // The directory points at the inventory.
  const directory = await getPage(app, "/speakers", cookie);
  assert.equal(directory.status, 200);
  assert.ok(directory.html.includes('href="/speakers/spk_a/credentials"'));

  const page = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(page.status, 200);
  assertHardened(page.response);
  assert.ok(page.html.includes(`<code>${first.credentialId}</code>`));
  assert.ok(page.html.includes(`<code>${second.credentialId}</code>`));
  assert.ok(page.html.includes(`<code>${expired.credentialId}</code>`));
  assert.ok(page.html.includes(`<code>${unknown.credentialId}</code>`));
  assert.ok(page.html.includes("No expiry"));
  assert.ok(page.html.includes('datetime="2026-11-03T12:00:00.000Z"'));
  assert.ok(page.html.includes('datetime="2027-01-01T00:00:00.000Z"'));
  assert.ok(page.html.includes("Alpha project"));
  assert.ok(page.html.includes("Beta project"));
  assert.ok(page.html.includes("Active"));
  assert.ok(page.html.includes("Expired"));
  assert.ok(page.html.includes("Unknown"));

  // No token, public prefix, or verifier is selected or rendered.
  const stored = await fx.db.first<{ public_prefix: string; secret_verifier: string }>(
    "SELECT public_prefix, secret_verifier FROM credentials WHERE id = ?",
    [first.credentialId],
  );
  assert.ok(stored);
  for (const secret of [
    first.token,
    first.token.slice(12),
    stored.public_prefix,
    stored.secret_verifier,
  ]) {
    assert.equal(page.html.includes(secret), false);
  }

  const revoked = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${first.credentialId}/revoke`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get("location"), "/speakers/spk_a/credentials");
  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [first.credentialId],
  );
  assert.equal(row?.revoked_at, "2026-11-03T12:00:00.000Z");
  const revokedAt = row?.revoked_at;

  // Grants and the credential row survive a soft revocation.
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [first.credentialId],
  );
  assert.deepEqual(grants.map((grant) => grant.project_id).sort(), ["proj_a", "proj_b"]);
  assert.equal(
    (await fx.db.all("SELECT id FROM credentials WHERE id = ?", [first.credentialId])).length,
    1,
  );

  const audits = await fx.db.all<{
    operation: string;
    outcome: string;
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    detail: string | null;
  }>(
    "SELECT operation, outcome, actor_account_id, actor_speaker_id, detail FROM audit_events WHERE operation = 'credential.revoke'",
  );
  assert.equal(audits.length, 1);
  assert.equal(audits[0]?.outcome, "success");
  assert.equal(audits[0]?.actor_account_id, "acct_a");
  assert.equal(audits[0]?.actor_speaker_id, "spk_a");
  assert.deepEqual(JSON.parse(audits[0]?.detail ?? "{}"), {
    credential_id: first.credentialId,
    source: "dashboard",
  });
  assert.equal(JSON.stringify(audits).includes(first.token), false);
  assert.equal(JSON.stringify(audits).includes(stored.secret_verifier), false);

  // The revoked token no longer authenticates.
  await assert.rejects(
    fx.authenticate(first.token),
    (error: unknown) => error instanceof AppError && error.code === "UNAUTHENTICATED",
  );

  const after = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.ok(after.html.includes("Revoked"));
  assert.equal(after.html.includes(`/credentials/${first.credentialId}/revoke`), false);
  assert.ok(after.html.includes(`/credentials/${second.credentialId}/revoke`));

  // A repeat submit is a no-op: same redirect, same timestamp, one audit row.
  // Stay inside the 30-minute session idle window.
  fx.setNow(new Date("2026-11-03T12:10:00.000Z"));
  const again = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${first.credentialId}/revoke`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), "/speakers/spk_a/credentials");
  const repeated = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [first.credentialId],
  );
  assert.equal(repeated?.revoked_at, revokedAt);
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation = 'credential.revoke'",
      )
    ).length,
    1,
  );
});

test("credential inventory and revocation are speaker-owner-scoped", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const aCred = await fx.addCredential({ speakerId: "spk_a" });
  const bCred = await fx.addCredential({ speakerId: "spk_b" });
  const dCred = await fx.addCredential({ speakerId: "spk_d" });
  const other = await loginAsWithCsrf(app, "d@example.test", "account d secret");

  // Another account cannot list or revoke account A's speaker credentials.
  assert.equal((await getPage(app, "/speakers/spk_a/credentials", other.cookie)).status, 404);
  const foreignPost = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${aCred.credentialId}/revoke`,
    other.cookie,
    [["csrf_token", other.csrf]],
  );
  assert.equal(foreignPost.status, 404);

  // The owner sees only the requested speaker's credentials.
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/speakers/spk_a/credentials", owner.cookie);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes(aCred.credentialId));
  assert.equal(page.html.includes(bCred.credentialId), false);
  assert.equal(page.html.includes(dCred.credentialId), false);
  assert.equal(page.html.includes("proj_d"), false);

  const otherPage = await getPage(app, "/speakers/spk_d/credentials", other.cookie);
  assert.equal(otherPage.status, 200);
  assert.ok(otherPage.html.includes(dCred.credentialId));

  // A credential ID from another speaker, owned or foreign, is the uniform 404.
  for (const credentialId of [bCred.credentialId, dCred.credentialId, "cred_missing"]) {
    const response = await postFormMulti(
      app,
      `/speakers/spk_a/credentials/${credentialId}/revoke`,
      owner.cookie,
      [["csrf_token", owner.csrf]],
    );
    assert.equal(response.status, 404, credentialId);
  }
  for (const credentialId of [aCred.credentialId, bCred.credentialId, dCred.credentialId]) {
    const row = await fx.db.first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM credentials WHERE id = ?",
      [credentialId],
    );
    assert.equal(row?.revoked_at, null, credentialId);
  }
});

test("credential revocation requires the session double-submit CSRF check", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const sessionOnly = cookie.split("; ")[0];
  const path = `/speakers/spk_a/credentials/${credential.credentialId}/revoke`;

  const attempts: Array<{ name: string; fields: Array<[string, string]>; useCookie: string | undefined }> = [
    { name: "missing", fields: [], useCookie: cookie },
    { name: "wrong", fields: [["csrf_token", "A".repeat(43)]], useCookie: cookie },
    {
      name: "duplicate",
      fields: [
        ["csrf_token", csrf],
        ["csrf_token", csrf],
      ],
      useCookie: cookie,
    },
    { name: "no cookie", fields: [["csrf_token", csrf]], useCookie: sessionOnly },
  ];
  for (const attempt of attempts) {
    const response = await postFormMulti(app, path, attempt.useCookie, attempt.fields);
    assert.equal(response.status, 400, attempt.name);
    assert.ok((await response.text()).includes("The form expired."), attempt.name);
  }

  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const response = await call(app, path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        ...headers,
      },
      body: new URLSearchParams({ csrf_token: csrf }).toString(),
    });
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.ok((await response.text()).includes("The form expired."));
  }

  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.revoke'")).length,
    0,
  );
});

test("bearer principals and cookie-less requests cannot administer credentials", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const target = await fx.addCredential({ speakerId: "spk_a" });
  const bearerCredential = await fx.addCredential({ speakerId: "spk_b" });
  const bearer = await fx.authenticate(bearerCredential.token);

  // The service boundary rejects a non-session principal even if a route were
  // miswired to pass one.
  await assert.rejects(
    listOwnedSpeakerCredentials(fx.deps, bearer, "spk_a"),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    revokeOwnedSpeakerCredential(fx.deps, bearer, "spk_a", target.credentialId),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );

  // The dashboard reads no Authorization header: a bearer-only request is an
  // unauthenticated browser session and is redirected to login.
  const response = await call(
    app,
    `/speakers/spk_a/credentials/${target.credentialId}/revoke`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${bearerCredential.token}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: "csrf_token=ignored",
    },
  );
  assert.equal(response.status, 303);
  assert.ok(response.headers.get("location")?.startsWith("/login?return_to="));

  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [target.credentialId],
  );
  assert.equal(row?.revoked_at, null);
});

test("ownership transferred during the revocation transaction aborts the write", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const deps = {
    ...fx.deps,
    db: withSpeakerReassignedDuringTransaction(fx.deps.db),
  };
  await assert.rejects(
    revokeOwnedSpeakerCredential(deps, sessionPrincipal("acct_a"), "spk_a", credential.credentialId),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
  // The injected ownership change ran inside the rolled-back transaction.
  const speaker = await fx.db.first<{ owner_account_id: string }>(
    "SELECT owner_account_id FROM speakers WHERE id = ?",
    ["spk_a"],
  );
  assert.equal(speaker?.owner_account_id, "acct_a");
});

test("ownership transfer between inventory reads yields no foreign rows", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const principal = sessionPrincipal("acct_a");

  // Transfer between the speaker SELECT and the credential SELECT: the
  // credential query is owner-scoped and returns zero rows. The speaker object
  // was read before the transfer, so it remains; no credential metadata leaks.
  const beforeCredential = withOwnershipReassignedBefore(
    fx.deps.db,
    (sql) => sql.includes("FROM credentials c"),
  );
  const noCredentials = await listOwnedSpeakerCredentials(
    { ...fx.deps, db: beforeCredential },
    principal,
    "spk_a",
  );
  assert.deepEqual(noCredentials.credentials, []);
  assert.equal(noCredentials.speaker.id, "spk_a");

  // Restore ownership, then transfer between the credential SELECT and the
  // grant SELECT: already-read credential metadata remains, but the later grant
  // read is empty. A later read set can only become empty, never wider.
  await fx.db.run("UPDATE speakers SET owner_account_id = ? WHERE id = ?", [
    "acct_a",
    "spk_a",
  ]);
  const beforeGrant = withOwnershipReassignedBefore(
    fx.deps.db,
    (sql) => sql.includes("credential_project_grants g"),
  );
  const noGrants = await listOwnedSpeakerCredentials(
    { ...fx.deps, db: beforeGrant },
    principal,
    "spk_a",
  );
  assert.deepEqual(
    noGrants.credentials.map((row) => row.id),
    [credential.credentialId],
  );
  assert.deepEqual(noGrants.credentials[0]?.projects, []);

  // The transfer is real: the old owner is now NOT_FOUND and the new owner sees
  // the same credential row.
  await assert.rejects(
    listOwnedSpeakerCredentials(fx.deps, principal, "spk_a"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  const newOwner = await listOwnedSpeakerCredentials(
    fx.deps,
    sessionPrincipal("acct_d"),
    "spk_a",
  );
  assert.deepEqual(
    newOwner.credentials.map((row) => row.id),
    [credential.credentialId],
  );
});

test("the credential inventory renders one rotate form only for activatable credentials", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const active = await fx.addCredential({ speakerId: "spk_a" });
  const revoked = await fx.addCredential({
    speakerId: "spk_a",
    revokedAt: new Date("2026-11-02T12:00:00.000Z"),
  });
  const expired = await fx.addCredential({
    speakerId: "spk_a",
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET expires_at = ? WHERE id = ?", [
    "not-a-date",
    unknown.credentialId,
  ]);
  // OAuth access credentials are managed by their client and cannot be rotated
  // through this surface; the prefix is the service's OAuth marker.
  const oauth = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET public_prefix = ? WHERE id = ?", [
    `${OAUTH_ACCESS_PREFIX}synthetic`,
    oauth.credentialId,
  ]);
  await fx.addSpeaker("spk_inactive", "acct_a", "inactive");
  const inactive = await fx.addCredential({ speakerId: "spk_inactive" });

  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(page.status, 200);
  assert.equal(
    page.html.split(`action="/speakers/spk_a/credentials/${active.credentialId}/rotate"`).length - 1,
    1,
  );
  // Exactly one rotate form on the page, carrying the session CSRF field.
  assert.equal(page.html.match(/\/credentials\/[^"]+\/rotate/g)?.length, 1);
  assert.ok(page.html.includes("Rotate credential"));
  for (const credential of [revoked, expired, unknown, oauth]) {
    assert.equal(
      page.html.includes(`/credentials/${credential.credentialId}/rotate`),
      false,
      credential.credentialId,
    );
  }

  const inactivePage = await getPage(app, "/speakers/spk_inactive/credentials", cookie);
  assert.equal(inactivePage.status, 200);
  assert.equal(
    inactivePage.html.includes(`/credentials/${inactive.credentialId}/rotate`),
    false,
  );
});

test("a speaker that changes hands between inventory and write cannot be rotated", async (t) => {
  const { fx } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read"],
  });
  const before = await credentialCount(fx);

  // Login through the normal app, then POST through an app whose database
  // transfers ownership immediately before the rotation transaction runs. This
  // models a transfer that lands after the handler resolved its inventory but
  // before the atomic write, which is the window the service must close.
  const loginApp = createApp(fx.deps, { loginRateLimit: { perMinute: 600, burst: 100 } });
  const { cookie, csrf } = await loginAsWithCsrf(loginApp, "a@example.test", "account a secret");
  const racingDb = new Proxy(fx.db, {
    get(target, property, receiver) {
      if (property === "transaction") {
        return async (fn: Parameters<SqlDatabase["transaction"]>[0]) => {
          await target.run("UPDATE speakers SET owner_account_id = ? WHERE id = ?", [
            "acct_d",
            "spk_a",
          ]);
          return target.transaction(fn);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as SqlDatabase;
  const racingApp = createApp(
    { ...fx.deps, db: racingDb },
    { loginRateLimit: { perMinute: 600, burst: 100 } },
  );

  const response = await postFormMulti(
    racingApp,
    `/speakers/spk_a/credentials/${credential.credentialId}/rotate`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(response.status, 404);
  assert.equal(await credentialCount(fx), before);
  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.rotate'")).length,
    0,
  );
});

test("credential rotation shows the replacement once, revokes the old token, and preserves expiry", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const expiresAt = new Date("2027-01-01T00:00:00.000Z");
  const old = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read", "message.read"],
    expiresAt,
  });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const path = `/speakers/spk_a/credentials/${old.credentialId}/rotate`;

  const response = await postFormMulti(app, path, cookie, [["csrf_token", csrf]]);
  assert.equal(response.status, 200);
  assertHardened(response);
  const html = await response.text();
  const replacementToken = html.match(TOKEN_RE)?.[0];
  assert.ok(replacementToken, "the POST response must show the replacement once");
  assert.notEqual(replacementToken, old.token);
  assert.equal(html.split(replacementToken).length - 1, 1);
  assert.equal(html.includes(old.token), false);
  assert.ok(
    html.includes("The previous credential is now revoked and can no longer authenticate."),
  );
  assert.ok(html.includes("It is shown only once and cannot be recovered."));
  // The token never appears in the URL or response headers.
  for (const [name, value] of response.headers) {
    assert.equal(value.includes(replacementToken), false, name);
  }

  const oldRow = await fx.db.first<{ revoked_at: string | null; expires_at: string | null }>(
    "SELECT revoked_at, expires_at FROM credentials WHERE id = ?",
    [old.credentialId],
  );
  assert.notEqual(oldRow?.revoked_at, null);
  assert.equal(oldRow?.expires_at, expiresAt.toISOString());

  const replacement = await fx.db.first<{
    id: string;
    expires_at: string | null;
    revoked_at: string | null;
    scope_json: string;
    speaker_id: string;
  }>(
    `SELECT id, expires_at, revoked_at, scope_json, speaker_id
       FROM credentials WHERE speaker_id = ? AND revoked_at IS NULL`,
    ["spk_a"],
  );
  assert.ok(replacement);
  assert.notEqual(replacement.id, old.credentialId);
  assert.equal(replacement.revoked_at, null);
  assert.equal(replacement.speaker_id, "spk_a");
  // The exact old expiry is preserved, not extended or shortened.
  assert.equal(replacement.expires_at, expiresAt.toISOString());
  assert.deepEqual(JSON.parse(replacement.scope_json), ["project.read", "message.read"]);

  const grantsFor = (credentialId: string): Promise<Array<{ project_id: string }>> =>
    fx.db.all<{ project_id: string }>(
      `SELECT project_id FROM credential_project_grants
        WHERE credential_id = ? ORDER BY project_id ASC`,
      [credentialId],
    );
  assert.deepEqual(
    (await grantsFor(replacement.id)).map((row) => row.project_id),
    (await grantsFor(old.credentialId)).map((row) => row.project_id),
  );
  assert.deepEqual(
    (await grantsFor(replacement.id)).map((row) => row.project_id).sort(),
    ["proj_a", "proj_b"],
  );

  // The old token is dead immediately; the replacement is a working credential.
  await assert.rejects(
    fx.authenticate(old.token),
    (error: unknown) => error instanceof AppError && error.code === "UNAUTHENTICATED",
  );
  const principal = await fx.authenticate(replacementToken);
  assert.equal(principal.speakerId, "spk_a");

  // Exactly the service's sanitized audit row: no token, prefix, or verifier.
  const audits = await fx.db.all<{ detail: string | null }>(
    "SELECT detail FROM audit_events WHERE operation = 'credential.rotate'",
  );
  assert.equal(audits.length, 1);
  const detail = JSON.parse(audits[0]?.detail ?? "{}") as {
    credential_id: string;
    new_credential_id: string;
    projects: string[];
    project_count: number;
    scopes: string[];
    expires_at: string | null;
  };
  assert.equal(detail.credential_id, old.credentialId);
  assert.equal(detail.new_credential_id, replacement.id);
  assert.deepEqual([...detail.projects].sort(), ["proj_a", "proj_b"]);
  assert.equal(detail.project_count, 2);
  assert.deepEqual([...detail.scopes].sort(), ["message.read", "project.read"]);
  assert.equal(detail.expires_at, expiresAt.toISOString());
  const auditText = JSON.stringify(audits);
  const stored = await fx.db.first<{ public_prefix: string; secret_verifier: string }>(
    "SELECT public_prefix, secret_verifier FROM credentials WHERE id = ?",
    [replacement.id],
  );
  assert.ok(stored);
  for (const secret of [
    old.token,
    replacementToken,
    stored.public_prefix,
    stored.secret_verifier,
  ]) {
    assert.equal(auditText.includes(secret), false);
  }

  // A repeat submission targets the now-revoked credential: uniform 404 with no
  // extra credential or audit row.
  const repeated = await postFormMulti(app, path, cookie, [["csrf_token", csrf]]);
  assert.equal(repeated.status, 404);
  assert.equal(
    (await fx.db.all("SELECT id FROM credentials WHERE speaker_id = ?", ["spk_a"])).length,
    2,
  );
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.rotate'")).length,
    1,
  );
});

test("non-activatable credentials show no rotate form and their POST is not-found", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const revoked = await fx.addCredential({
    speakerId: "spk_a",
    revokedAt: new Date("2026-11-02T12:00:00.000Z"),
  });
  const expired = await fx.addCredential({
    speakerId: "spk_a",
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET expires_at = ? WHERE id = ?", [
    "not-a-date",
    unknown.credentialId,
  ]);
  await fx.addSpeaker("spk_inactive", "acct_a", "inactive");
  const inactive = await fx.addCredential({ speakerId: "spk_inactive" });
  // An OAuth-issued credential is rejected on POST too, not only in rendering.
  const oauth = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET public_prefix = ? WHERE id = ?", [
    `${OAUTH_ACCESS_PREFIX}synthetic`,
    oauth.credentialId,
  ]);
  const before = await credentialCount(fx);

  const cases = [
    {
      path: `/speakers/spk_a/credentials/${revoked.credentialId}/rotate`,
      id: revoked.credentialId,
      revokedAt: "2026-11-02T12:00:00.000Z",
    },
    {
      path: `/speakers/spk_a/credentials/${expired.credentialId}/rotate`,
      id: expired.credentialId,
      revokedAt: null,
    },
    {
      path: `/speakers/spk_a/credentials/${unknown.credentialId}/rotate`,
      id: unknown.credentialId,
      revokedAt: null,
    },
    {
      path: `/speakers/spk_inactive/credentials/${inactive.credentialId}/rotate`,
      id: inactive.credentialId,
      revokedAt: null,
    },
    {
      path: `/speakers/spk_a/credentials/${oauth.credentialId}/rotate`,
      id: oauth.credentialId,
      revokedAt: null,
    },
  ];
  for (const testCase of cases) {
    const response = await postFormMulti(app, testCase.path, cookie, [["csrf_token", csrf]]);
    assert.equal(response.status, 404, testCase.id);
    const row = await fx.db.first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM credentials WHERE id = ?",
      [testCase.id],
    );
    assert.equal(row?.revoked_at, testCase.revokedAt, testCase.id);
  }
  assert.equal(await credentialCount(fx), before);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.rotate'")).length,
    0,
  );

  // An inactive account invalidates the session, matching every other dashboard
  // write route: the request is redirected to login and writes nothing.
  await fx.db.run("UPDATE accounts SET status = 'inactive' WHERE id = ?", ["acct_a"]);
  const active = await fx.addCredential({ speakerId: "spk_a" });
  const inactiveAccount = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${active.credentialId}/rotate`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(inactiveAccount.status, 303);
  assert.ok(inactiveAccount.headers.get("location")?.startsWith("/login?return_to="));
});

test("foreign, removed-owner, and unknown rotation targets are the uniform 404", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const aCred = await fx.addCredential({ speakerId: "spk_a" });
  const bCred = await fx.addCredential({ speakerId: "spk_b" });
  const dCred = await fx.addCredential({ speakerId: "spk_d" });
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const before = await credentialCount(fx);

  const bodies: string[] = [];
  for (const path of [
    `/speakers/spk_d/credentials/${dCred.credentialId}/rotate`,
    `/speakers/spk_a/credentials/${bCred.credentialId}/rotate`,
    `/speakers/spk_a/credentials/${dCred.credentialId}/rotate`,
    `/speakers/spk_a/credentials/cred_missing/rotate`,
    `/speakers/spk_missing/credentials/${aCred.credentialId}/rotate`,
  ]) {
    const response = await postFormMulti(app, path, owner.cookie, [
      ["csrf_token", owner.csrf],
    ]);
    assert.equal(response.status, 404, path);
    bodies.push(await response.text());
  }
  // Identical main content: a forbidden and an unknown target are
  // indistinguishable. (The language switcher echoes the requested path.)
  const mains = bodies.map((body) => body.match(/<main[\s\S]*<\/main>/)?.[0]);
  for (const main of mains) assert.equal(main, mains[0]);

  for (const credential of [aCred, bCred, dCred]) {
    const row = await fx.db.first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM credentials WHERE id = ?",
      [credential.credentialId],
    );
    assert.equal(row?.revoked_at, null, credential.credentialId);
  }

  // Ownership transferred away after sign-in makes the speaker NOT_FOUND.
  await fx.db.run("UPDATE speakers SET owner_account_id = ? WHERE id = ?", [
    "acct_d",
    "spk_a",
  ]);
  const removed = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${aCred.credentialId}/rotate`,
    owner.cookie,
    [["csrf_token", owner.csrf]],
  );
  assert.equal(removed.status, 404);
  assert.equal(await credentialCount(fx), before);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.rotate'")).length,
    0,
  );
});

test("credential rotation requires the session double-submit CSRF check", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const sessionOnly = cookie.split("; ")[0];
  const path = `/speakers/spk_a/credentials/${credential.credentialId}/rotate`;

  const attempts: Array<{
    name: string;
    fields: Array<[string, string]>;
    useCookie: string | undefined;
  }> = [
    { name: "missing", fields: [], useCookie: cookie },
    { name: "wrong", fields: [["csrf_token", "A".repeat(43)]], useCookie: cookie },
    {
      name: "duplicate",
      fields: [
        ["csrf_token", csrf],
        ["csrf_token", csrf],
      ],
      useCookie: cookie,
    },
    { name: "no cookie", fields: [["csrf_token", csrf]], useCookie: sessionOnly },
  ];
  for (const attempt of attempts) {
    const response = await postFormMulti(app, path, attempt.useCookie, attempt.fields);
    assert.equal(response.status, 400, attempt.name);
    assert.ok((await response.text()).includes("The form expired."), attempt.name);
  }

  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const response = await call(app, path, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        ...headers,
      },
      body: new URLSearchParams({ csrf_token: csrf }).toString(),
    });
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.ok((await response.text()).includes("The form expired."));
  }

  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
  assert.equal(await credentialCount(fx), 1);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.rotate'")).length,
    0,
  );
});

test("revoked sessions are redirected from the credential routes", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  await fx.db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ?", [
    "2026-11-03T12:05:00.000Z",
    "acct_a",
  ]);

  const list = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(list.status, 303);
  assert.equal(
    list.response.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/speakers/spk_a/credentials")}`,
  );
  const revoke = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${credential.credentialId}/revoke`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(revoke.status, 303);
  assert.ok(revoke.headers.get("location")?.startsWith("/login?return_to="));
  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
});

test("credential inventory and revocation are localized", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  await fx.addCredential({
    speakerId: "spk_a",
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({ speakerId: "spk_a" });
  await fx.db.run("UPDATE credentials SET expires_at = ? WHERE id = ?", [
    "not-a-date",
    unknown.credentialId,
  ]);
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const directory = await getPage(app, "/speakers?lang=zh", cookie);
  assert.ok(directory.html.includes('href="/speakers/spk_a/credentials?lang=zh"'));

  const page = await getPage(app, "/speakers/spk_a/credentials?lang=zh", cookie);
  assert.equal(page.status, 200);
  assert.match(page.html, /<html lang="zh-Hans" dir="ltr">/);
  for (const text of [
    "凭证",
    "创建时间",
    "过期时间",
    "不过期",
    "项目授权",
    "撤销凭证",
    "已过期",
    "未知",
  ]) {
    assert.ok(page.html.includes(text), text);
  }
  assert.ok(page.html.includes('action="/speakers/spk_a/credentials/'));

  const revoked = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${credential.credentialId}/revoke?lang=zh`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(revoked.status, 303);
  assert.equal(revoked.headers.get("location"), "/speakers/spk_a/credentials?lang=zh");

  const after = await getPage(app, "/speakers/spk_a/credentials?lang=zh", cookie);
  assert.ok(after.html.includes("已撤销"));
  for (const html of [page.html, after.html]) {
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("<style"), false);
    assert.equal(/ style=/.test(html), false);
    assert.equal(/ on[a-z]+=/.test(html), false);
  }
});

test("the Node adapter buffers credential POST bodies over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-credentials-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const email = "http-credentials@example.test";
  const password = "http credentials secret";
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
    `INSERT INTO projects (id, owner_account_id, title, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["proj_http2", "acct_http", "HTTP Grant Project", now],
  );
  await db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_http", "spk_http", JSON.stringify(SCOPES), now],
  );
  await db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_http2", "spk_http", JSON.stringify(SCOPES), now],
  );
  await db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      "cred_http",
      "spk_http",
      "cb_http00000",
      "unused-test-verifier",
      JSON.stringify(["project.read"]),
      now,
    ],
  );
  await db.run(
    `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
     VALUES (?, ?, ?)`,
    ["cred_http", "proj_http", now],
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

  const inventory = await fetch(`${base}/speakers/spk_http/credentials`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(inventory.status, 200);
  assert.ok((await inventory.text()).includes("cred_http"));

  // The grant add/remove forms have the same buffering requirement; before the
  // adapter buffered web POSTs they arrived body-less and returned the 400
  // expired-form page.
  const granted = await fetch(
    `${base}/speakers/spk_http/credentials/cred_http/grants`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": formType, cookie, connection: "close" },
      body: new URLSearchParams({
        csrf_token: csrf,
        project_id: "proj_http2",
      }).toString(),
    },
  );
  assert.equal(granted.status, 303, "the adapter must buffer the grant add POST body");
  assert.equal(
    granted.headers.get("location"),
    "/speakers/spk_http/credentials?grant=added",
  );
  const grantRemoved = await fetch(
    `${base}/speakers/spk_http/credentials/cred_http/grants/remove`,
    {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": formType, cookie, connection: "close" },
      body: new URLSearchParams({
        csrf_token: csrf,
        project_id: "proj_http2",
      }).toString(),
    },
  );
  assert.equal(grantRemoved.status, 303, "the adapter must buffer the grant remove POST body");
  assert.equal(
    grantRemoved.headers.get("location"),
    "/speakers/spk_http/credentials?grant=removed",
  );

  // Before the adapter buffered this route the form would arrive body-less and
  // the CSRF check would return the 400 expired-form page.
  const revoked = await fetch(`${base}/speakers/spk_http/credentials/cred_http/revoke`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, cookie, connection: "close" },
    body: new URLSearchParams({ csrf_token: csrf }).toString(),
  });
  assert.equal(revoked.status, 303, "the adapter must buffer the credential revoke POST body");
  assert.equal(revoked.headers.get("location"), "/speakers/spk_http/credentials");

  const after = await fetch(`${base}/speakers/spk_http/credentials`, {
    headers: { cookie, connection: "close" },
  });
  assert.equal(after.status, 200);
  const afterHtml = await after.text();
  assert.ok(afterHtml.includes("Revoked"));
  assert.equal(afterHtml.includes("/credentials/cred_http/revoke"), false);
});

test("credential routes enforce method, media type, size, and unknown-speaker boundaries", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const revokePath = `/speakers/spk_a/credentials/${credential.credentialId}/revoke`;
  const oversized = "A".repeat(70_000);

  // Unknown and malformed speaker IDs are the uniform 404 before any body work.
  for (const speakerId of ["spk_missing", "%20"]) {
    assert.equal(
      (await getPage(app, `/speakers/${speakerId}/credentials`, cookie)).status,
      404,
      speakerId,
    );
  }
  assert.equal(
    (await postFormMulti(
      app,
      "/speakers/spk_missing/credentials/cred_x/revoke",
      cookie,
      [["csrf_token", csrf]],
    )).status,
    404,
  );

  // Only the documented methods are accepted on the new paths.
  const getRevoke = await call(app, revokePath, { headers: { cookie } });
  assert.equal(getRevoke.status, 405);
  assert.equal(getRevoke.headers.get("allow"), "POST");
  const postList = await postFormMulti(app, "/speakers/spk_a/credentials", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(postList.status, 405);
  assert.equal(postList.headers.get("allow"), "GET");
  for (const method of ["PUT", "DELETE"]) {
    const response = await call(app, revokePath, { method, headers: { cookie } });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST", method);
  }

  // A wrong media type and an over-cap body are rejected before any write.
  const json = await call(app, revokePath, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  assert.equal(json.status, 400);
  const tooLarge = await call(app, revokePath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: `csrf_token=${oversized}`,
  });
  assert.equal(tooLarge.status, 413);
  const row = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(row?.revoked_at, null);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'credential.revoke'")).length,
    0,
  );

  // A foreign speaker is 404 even for a malformed or oversized body: ownership
  // is resolved before the body is parsed.
  const other = await loginAsWithCsrf(app, "d@example.test", "account d secret");
  for (const [headers, body] of [
    [{ "content-type": "application/json" }, "{}"],
    [{ "content-type": "application/x-www-form-urlencoded" }, `csrf_token=${oversized}`],
  ] as const) {
    const response = await call(app, revokePath, {
      method: "POST",
      headers: { ...headers, cookie: other.cookie },
      body,
    });
    assert.equal(response.status, 404, headers["content-type"]);
  }
  const afterForeign = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(afterForeign?.revoked_at, null);
});

test("inactive owning accounts are denied and inactive owned speakers remain manageable", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({ speakerId: "spk_a" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  // Service boundary: an inactive owning account is NOT_FOUND, not a write.
  await fx.db.run("UPDATE accounts SET status = 'inactive' WHERE id = ?", ["acct_a"]);
  const principal = sessionPrincipal("acct_a");
  await assert.rejects(
    listOwnedSpeakerCredentials(fx.deps, principal, "spk_a"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  await assert.rejects(
    revokeOwnedSpeakerCredential(fx.deps, principal, "spk_a", credential.credentialId),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
  // The dashboard's existing session rule redirects an inactive account to login.
  assert.equal((await getPage(app, "/speakers/spk_a/credentials", cookie)).status, 303);
  const httpRevoke = await postFormMulti(app, `/speakers/spk_a/credentials/${credential.credentialId}/revoke`, cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(httpRevoke.status, 303);
  assert.ok(httpRevoke.headers.get("location")?.startsWith("/login?return_to="));
  const denied = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [credential.credentialId],
  );
  assert.equal(denied?.revoked_at, null);

  // An inactive owned speaker is still an ownership-manageable inventory: its
  // credentials are already denied by authorization, but the owner can revoke them.
  await fx.db.run("UPDATE accounts SET status = 'active' WHERE id = ?", ["acct_a"]);
  await fx.addSpeaker("spk_off", "acct_a", "inactive");
  const inactiveCredential = await fx.addCredential({ speakerId: "spk_off" });
  await fx.grantProject(inactiveCredential.credentialId, "proj_a");
  const page = await getPage(app, "/speakers/spk_off/credentials", cookie);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes(inactiveCredential.credentialId));
  // An inactive speaker's credentials are read-only for grant editing even when
  // the credential row itself is not revoked or expired.
  assert.equal(
    page.html.includes(`/credentials/${inactiveCredential.credentialId}/grants`),
    false,
  );
  for (const path of [
    `/speakers/spk_off/credentials/${inactiveCredential.credentialId}/grants`,
    `/speakers/spk_off/credentials/${inactiveCredential.credentialId}/grants/remove`,
  ]) {
    const denied = await postFormMulti(app, path, cookie, [
      ["csrf_token", csrf],
      ["project_id", "proj_a"],
    ]);
    assert.equal(denied.status, 404, path);
  }
  assert.equal(
    (
      await fx.db.all<{ credential_id: string }>(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [inactiveCredential.credentialId],
      )
    ).length,
    1,
  );
  const revoked = await postFormMulti(
    app,
    `/speakers/spk_off/credentials/${inactiveCredential.credentialId}/revoke`,
    cookie,
    [["csrf_token", csrf]],
  );
  assert.equal(revoked.status, 303);
  const inactiveRow = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [inactiveCredential.credentialId],
  );
  assert.ok(inactiveRow !== undefined, "the inactive speaker's credential row must exist");
  assert.equal(typeof inactiveRow.revoked_at, "string");
});

test("credential project grants can be added and removed by the owner", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read", "message.read"],
    autoGrantMemberships: false,
  });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const base = `/speakers/spk_a/credentials/${credential.credentialId}`;

  const before = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(before.status, 200);
  assertHardened(before.response);
  // The add form lists the speaker's active, account-readable projects only.
  assert.ok(before.html.includes(`action="${base}/grants"`));
  assert.ok(before.html.includes('<option value="proj_a">Alpha project (proj_a)</option>'));
  assert.ok(before.html.includes('<option value="proj_b">Beta project (proj_b)</option>'));
  assert.equal(before.html.includes('value="proj_d"'), false);
  assert.equal(before.html.includes(`action="${base}/grants/remove"`), false);
  assert.equal(before.html.includes("No project grants."), true);

  const added = await postFormMulti(app, `${base}/grants`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(added.status, 303);
  assert.equal(added.headers.get("location"), "/speakers/spk_a/credentials?grant=added");
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [credential.credentialId],
  );
  assert.deepEqual(grants.map((row) => row.project_id), ["proj_a"]);

  const grantAudits = await fx.db.all<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    project_id: string | null;
    detail: string | null;
  }>(
    "SELECT actor_account_id, actor_speaker_id, project_id, detail FROM audit_events WHERE operation = 'credential.project.grant'",
  );
  assert.equal(grantAudits.length, 1);
  assert.equal(grantAudits[0]?.actor_account_id, "acct_a");
  assert.equal(grantAudits[0]?.actor_speaker_id, "spk_a");
  assert.equal(grantAudits[0]?.project_id, "proj_a");
  assert.deepEqual(JSON.parse(grantAudits[0]?.detail ?? "{}"), {
    credential_id: credential.credentialId,
    projects: ["proj_a"],
    source: "dashboard",
  });

  const afterAdd = await getPage(
    app,
    "/speakers/spk_a/credentials?grant=added",
    cookie,
  );
  assert.ok(afterAdd.html.includes(`action="${base}/grants/remove"`));
  assert.ok(afterAdd.html.includes('name="project_id" value="proj_a"'));
  assert.ok(afterAdd.html.includes("Alpha project"));
  assert.ok(afterAdd.html.includes("Project grant added."));

  // Adding an existing grant is an idempotent no-op with a clear response and
  // no duplicate audit row.
  const again = await postFormMulti(app, `${base}/grants`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(again.status, 303);
  assert.equal(
    again.headers.get("location"),
    "/speakers/spk_a/credentials?grant=exists",
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    1,
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation = 'credential.project.grant'",
      )
    ).length,
    1,
  );

  // Removing a grant that does not exist returns the same 303 as a real
  // removal, changes nothing, and writes no audit row.
  const missing = await postFormMulti(app, `${base}/grants/remove`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_b"],
  ]);
  assert.equal(missing.status, 303);
  assert.equal(
    missing.headers.get("location"),
    "/speakers/spk_a/credentials?grant=removed",
  );
  assert.deepEqual(
    (
      await fx.db.all<{ project_id: string }>(
        "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).map((row) => row.project_id),
    ["proj_a"],
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation = 'credential.project.revoke'",
      )
    ).length,
    0,
  );

  const removed = await postFormMulti(app, `${base}/grants/remove`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(removed.status, 303);
  assert.equal(
    removed.headers.get("location"),
    "/speakers/spk_a/credentials?grant=removed",
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    0,
  );
  const revokeAudits = await fx.db.all<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    project_id: string | null;
    detail: string | null;
  }>(
    "SELECT actor_account_id, actor_speaker_id, project_id, detail FROM audit_events WHERE operation = 'credential.project.revoke'",
  );
  assert.equal(revokeAudits.length, 1);
  assert.equal(revokeAudits[0]?.actor_account_id, "acct_a");
  assert.equal(revokeAudits[0]?.actor_speaker_id, "spk_a");
  assert.equal(revokeAudits[0]?.project_id, "proj_a");
  assert.deepEqual(JSON.parse(revokeAudits[0]?.detail ?? "{}"), {
    credential_id: credential.credentialId,
    projects: ["proj_a"],
    source: "dashboard",
  });

  // Re-rendering after removal restores the add form and drops the remove form.
  const afterRemove = await getPage(
    app,
    "/speakers/spk_a/credentials?grant=removed",
    cookie,
  );
  assert.ok(afterRemove.html.includes(`action="${base}/grants"`));
  assert.equal(afterRemove.html.includes(`action="${base}/grants/remove"`), false);
  assert.ok(afterRemove.html.includes("Project grant removed."));
});

test("a stale grant remains removable after the speaker loses the project membership", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read", "message.read"],
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });
  // The membership removal leaves the existing grant behind.
  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    ["2026-11-03T12:30:00.000Z", "proj_a", "spk_a"],
  );
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const base = `/speakers/spk_a/credentials/${credential.credentialId}/grants`;

  // Add still requires a current membership, so the same owner gets the uniform
  // 404 even though proj_a remains account-readable through spk_b.
  const added = await postFormMulti(app, base, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(added.status, 404);
  assert.ok((await added.text()).includes("The requested page is not available."));
  assert.deepEqual(
    (
      await fx.db.all<{ project_id: string }>(
        "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).map((row) => row.project_id),
    ["proj_a"],
  );

  // Remove deliberately does not re-check membership or read access, so the
  // stale grant stays removable by the speaker's owner.
  const removed = await postFormMulti(app, `${base}/remove`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(removed.status, 303);
  assert.equal(
    removed.headers.get("location"),
    "/speakers/spk_a/credentials?grant=removed",
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    0,
  );
  const revokeAudits = await fx.db.all<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    project_id: string | null;
  }>(
    "SELECT actor_account_id, actor_speaker_id, project_id FROM audit_events WHERE operation = 'credential.project.revoke'",
  );
  assert.equal(revokeAudits.length, 1);
  assert.equal(revokeAudits[0]?.actor_account_id, "acct_a");
  assert.equal(revokeAudits[0]?.actor_speaker_id, "spk_a");
  assert.equal(revokeAudits[0]?.project_id, "proj_a");
});

test("credential grant routes deny foreign, unreadable, and ineligible targets uniformly", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  // proj_c: the speaker is an active member, but the account cannot read it
  // (no owned speaker has project.read there).
  await fx.addProject("proj_c", "acct_a");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["No-read project", "proj_c"]);
  await fx.addMembership("proj_c", "spk_a", ["message.read"], {
    grantExistingCredentials: false,
  });
  // proj_e: the account can read it through spk_b, but spk_a is not a member.
  await fx.addProject("proj_e", "acct_a");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Not spk_a project", "proj_e"]);
  await fx.addMembership("proj_e", "spk_b", ["project.read"], {
    grantExistingCredentials: false,
  });

  const credential = await fx.addCredential({
    speakerId: "spk_a",
    scopes: ["project.read", "message.read"],
    autoGrantMemberships: false,
  });
  const otherSpeakerCredential = await fx.addCredential({
    speakerId: "spk_b",
    scopes: ["project.read"],
    autoGrantMemberships: false,
  });
  const foreignCredential = await fx.addCredential({
    speakerId: "spk_d",
    scopes: ["project.read"],
    autoGrantMemberships: false,
  });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const base = `/speakers/spk_a/credentials/${credential.credentialId}`;

  const page = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes('value="proj_a"'));
  assert.ok(page.html.includes('value="proj_b"'));
  assert.equal(page.html.includes('value="proj_c"'), false);
  assert.equal(page.html.includes('value="proj_e"'), false);

  // Ineligible project: no active membership, account cannot read, or both.
  for (const projectId of ["proj_c", "proj_e", "proj_d"]) {
    const response = await postFormMulti(app, `${base}/grants`, cookie, [
      ["csrf_token", csrf],
      ["project_id", projectId],
    ]);
    assert.equal(response.status, 404, projectId);
    const html = await response.text();
    assert.ok(html.includes("The requested page is not available."), projectId);
  }
  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    0,
  );

  // A speaker owned by another account is the same 404 before any write.
  const other = await loginAsWithCsrf(app, "d@example.test", "account d secret");
  const foreignSpeaker = await postFormMulti(app, `${base}/grants`, other.cookie, [
    ["csrf_token", other.csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(foreignSpeaker.status, 404);
  assert.ok((await foreignSpeaker.text()).includes("The requested page is not available."));

  // A credential belonging to another speaker (same account or foreign account)
  // is NOT_FOUND for both add and remove.
  for (const credentialId of [
    otherSpeakerCredential.credentialId,
    foreignCredential.credentialId,
  ]) {
    for (const path of [
      `/speakers/spk_a/credentials/${credentialId}/grants`,
      `/speakers/spk_a/credentials/${credentialId}/grants/remove`,
    ]) {
      const response = await postFormMulti(app, path, cookie, [
        ["csrf_token", csrf],
        ["project_id", "proj_a"],
      ]);
      assert.equal(response.status, 404, path);
      assert.ok((await response.text()).includes("The requested page is not available."));
    }
  }
  assert.equal(
    (
      await fx.db.all("SELECT credential_id FROM credential_project_grants")
    ).length,
    0,
  );
});

test("revoked, expired, and unknown-expiry credentials are read-only for grant editing", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const revoked = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
    revokedAt: new Date("2026-11-01T00:00:00.000Z"),
  });
  const expired = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
    expiresAt: new Date("2026-01-01T00:00:00.000Z"),
  });
  const unknown = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
  });
  await fx.db.run("UPDATE credentials SET expires_at = ? WHERE id = ?", [
    "not-a-date",
    unknown.credentialId,
  ]);
  const active = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });
  for (const credentialId of [revoked.credentialId, expired.credentialId, unknown.credentialId]) {
    await fx.grantProject(credentialId, "proj_a");
  }
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const page = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(page.status, 200);
  for (const credentialId of [
    revoked.credentialId,
    expired.credentialId,
    unknown.credentialId,
  ]) {
    assert.equal(
      page.html.includes(`/credentials/${credentialId}/grants`),
      false,
      credentialId,
    );
  }
  assert.ok(page.html.includes(`/speakers/spk_a/credentials/${active.credentialId}/grants"`));
  assert.ok(
    page.html.includes(
      `/speakers/spk_a/credentials/${active.credentialId}/grants/remove`,
    ),
  );
  assert.equal(
    page.html.match(/Grant editing is available only for active credentials of active speakers\./g)?.length,
    3,
  );

  for (const credentialId of [
    revoked.credentialId,
    expired.credentialId,
    unknown.credentialId,
  ]) {
    const add = await postFormMulti(
      app,
      `/speakers/spk_a/credentials/${credentialId}/grants`,
      cookie,
      [
        ["csrf_token", csrf],
        ["project_id", "proj_b"],
      ],
    );
    assert.equal(add.status, 404, credentialId);
    const remove = await postFormMulti(
      app,
      `/speakers/spk_a/credentials/${credentialId}/grants/remove`,
      cookie,
      [
        ["csrf_token", csrf],
        ["project_id", "proj_a"],
      ],
    );
    assert.equal(remove.status, 404, credentialId);
    assert.deepEqual(
      (
        await fx.db.all<{ project_id: string }>(
          "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
          [credentialId],
        )
      ).map((row) => row.project_id),
      ["proj_a"],
    );
  }
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation IN ('credential.project.grant', 'credential.project.revoke')",
      )
    ).length,
    0,
  );
});

test("OAuth-issued credentials reject grant additions and hide the add form", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const oauth = await fx.addCredential({
    id: "cred_oat_dashboard",
    speakerId: "spk_a",
    token: `cb_oat_${"A".repeat(40)}`,
    autoGrantMemberships: false,
    grantProjects: ["proj_a"],
  });
  const ordinary = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
  });

  // Service boundary: a crafted request is rejected with the same predicate and
  // message as rotation, and no grant row or audit is written.
  await assert.rejects(
    grantOwnedSpeakerCredentialProject(
      fx.deps,
      sessionPrincipal("acct_a"),
      "spk_a",
      oauth.credentialId,
      "proj_b",
    ),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === "FORBIDDEN" &&
      error.message.includes("OAuth-issued"),
  );
  assert.deepEqual(
    (
      await fx.db.all<{ project_id: string }>(
        "SELECT project_id FROM credential_project_grants WHERE credential_id = ? ORDER BY project_id",
        [oauth.credentialId],
      )
    ).map((row) => row.project_id),
    ["proj_a"],
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation = 'credential.project.grant'",
      )
    ).length,
    0,
  );

  // An ordinary speaker credential is unaffected.
  assert.equal(
    await grantOwnedSpeakerCredentialProject(
      fx.deps,
      sessionPrincipal("acct_a"),
      "spk_a",
      ordinary.credentialId,
      "proj_a",
    ),
    true,
  );

  // The dashboard exposes the OAuth flag, hides its add-grant form, and keeps
  // removal available; an ordinary active credential keeps its add form.
  const inventory = await listOwnedSpeakerCredentials(
    fx.deps,
    sessionPrincipal("acct_a"),
    "spk_a",
  );
  assert.equal(
    inventory.credentials.find((row) => row.id === oauth.credentialId)?.oauthIssued,
    true,
  );
  assert.equal(
    inventory.credentials.find((row) => row.id === ordinary.credentialId)?.oauthIssued,
    false,
  );

  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/speakers/spk_a/credentials", cookie);
  assert.equal(page.status, 200);
  assert.equal(
    page.html.includes(`/credentials/${oauth.credentialId}/grants"`),
    false,
  );
  assert.ok(
    page.html.includes(`/credentials/${oauth.credentialId}/grants/remove`),
  );
  assert.ok(
    page.html.includes(`/credentials/${ordinary.credentialId}/grants"`),
  );

  // A crafted POST still cannot widen the OAuth credential.
  const forged = await postFormMulti(
    app,
    `/speakers/spk_a/credentials/${oauth.credentialId}/grants`,
    cookie,
    [
      ["csrf_token", csrf],
      ["project_id", "proj_b"],
    ],
  );
  assert.equal(forged.status, 404);
  assert.equal(
    (
      await fx.db.all(
        "SELECT 1 FROM credential_project_grants WHERE credential_id = ? AND project_id = ?",
        [oauth.credentialId, "proj_b"],
      )
    ).length,
    0,
  );
});

test("grant edits require session CSRF, reject bearers, and enforce body and method limits", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
  });
  const bearerCredential = await fx.addCredential({ speakerId: "spk_b" });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const addPath = `/speakers/spk_a/credentials/${credential.credentialId}/grants`;
  const removePath = `${addPath}/remove`;

  // Service boundary: a bearer principal cannot administer grants.
  const bearerPrincipal = await fx.authenticate(bearerCredential.token);
  await assert.rejects(
    grantOwnedSpeakerCredentialProject(
      fx.deps,
      bearerPrincipal,
      "spk_a",
      credential.credentialId,
      "proj_a",
    ),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    revokeOwnedSpeakerCredentialProject(
      fx.deps,
      bearerPrincipal,
      "spk_a",
      credential.credentialId,
      "proj_a",
    ),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );

  // A wrong or missing hidden CSRF value re-renders the inventory with 400 and
  // performs no write.
  for (const fields of [
    [["csrf_token", "wrong"], ["project_id", "proj_a"]] as const,
    [["project_id", "proj_a"]] as const,
  ]) {
    const response = await postFormMulti(app, addPath, cookie, fields);
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes("The form expired. Please try again."));
  }
  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    0,
  );

  // The dashboard never reads an Authorization header: bearer-only requests are
  // an unauthenticated session and are redirected to login.
  const bearerResponse = await call(app, addPath, {
    method: "POST",
    headers: {
      authorization: `Bearer ${bearerCredential.token}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: `csrf_token=ignored&project_id=proj_a`,
  });
  assert.equal(bearerResponse.status, 303);
  assert.ok(bearerResponse.headers.get("location")?.startsWith("/login?return_to="));

  // Declared/observed bodies over 64 KiB are rejected before any write.
  const tooLarge = await call(app, addPath, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: `csrf_token=${"A".repeat(70_000)}`,
  });
  assert.equal(tooLarge.status, 413);

  // Unknown speakers are uniform 404 even for an oversized body because the
  // owned inventory is resolved before body parsing.
  const foreignOversized = await call(
    app,
    "/speakers/spk_missing/credentials/cred_x/grants",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie },
      body: `csrf_token=${"A".repeat(70_000)}`,
    },
  );
  assert.equal(foreignOversized.status, 404);

  // Method, media type, and duplicate-field boundaries.
  for (const path of [addPath, removePath]) {
    const get = await call(app, path, { headers: { cookie } });
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("allow"), "POST");
  }
  const json = await call(app, addPath, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: "{}",
  });
  assert.equal(json.status, 400);
  const duplicate = await postFormMulti(app, addPath, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
    ["project_id", "proj_b"],
  ]);
  assert.equal(duplicate.status, 400);

  assert.equal(
    (
      await fx.db.all(
        "SELECT credential_id FROM credential_project_grants WHERE credential_id = ?",
        [credential.credentialId],
      )
    ).length,
    0,
  );
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation IN ('credential.project.grant', 'credential.project.revoke')",
      )
    ).length,
    0,
  );
});

test("grant removal requires session CSRF and leaves the grant intact", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
  });
  await fx.db.run(
    `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
     VALUES (?, ?, ?)`,
    [credential.credentialId, "proj_a", "2026-01-01T00:00:00.000Z"],
  );
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const removePath = `/speakers/spk_a/credentials/${credential.credentialId}/grants/remove`;

  // A wrong or missing hidden CSRF value re-renders the inventory with 400 and
  // performs no removal, so the seeded grant survives.
  for (const fields of [
    [["csrf_token", "wrong"], ["project_id", "proj_a"]] as const,
    [["project_id", "proj_a"]] as const,
  ]) {
    const response = await postFormMulti(app, removePath, cookie, fields);
    assert.equal(response.status, 400);
    assert.ok((await response.text()).includes("The form expired. Please try again."));
  }
  const grants = await fx.db.all<{ project_id: string }>(
    "SELECT project_id FROM credential_project_grants WHERE credential_id = ?",
    [credential.credentialId],
  );
  assert.deepEqual(grants.map((row) => row.project_id), ["proj_a"]);
  assert.equal(
    (
      await fx.db.all(
        "SELECT id FROM audit_events WHERE operation = 'credential.project.revoke'",
      )
    ).length,
    0,
  );
});

test("credential project grant routes are localized", async (t) => {
  const { fx, app } = await withApp(t);
  await basicSpeakerSetup(fx);
  const credential = await fx.addCredential({
    speakerId: "spk_a",
    autoGrantMemberships: false,
  });
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const base = `/speakers/spk_a/credentials/${credential.credentialId}/grants`;

  const added = await postFormMulti(app, `${base}?lang=zh`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(added.status, 303);
  assert.equal(
    added.headers.get("location"),
    "/speakers/spk_a/credentials?lang=zh&grant=added",
  );
  const page = await getPage(
    app,
    "/speakers/spk_a/credentials?lang=zh&grant=added",
    cookie,
  );
  assert.equal(page.status, 200);
  assert.ok(page.html.includes("已添加项目授权。"));
  assert.ok(page.html.includes("授权项目"));
  assert.ok(page.html.includes('action="/speakers/spk_a/credentials/'));
  assert.ok(page.html.includes("/grants/remove?lang=zh"));

  const removed = await postFormMulti(app, `${base}/remove?lang=zh`, cookie, [
    ["csrf_token", csrf],
    ["project_id", "proj_a"],
  ]);
  assert.equal(removed.status, 303);
  assert.equal(
    removed.headers.get("location"),
    "/speakers/spk_a/credentials?lang=zh&grant=removed",
  );
  const after = await getPage(
    app,
    "/speakers/spk_a/credentials?lang=zh&grant=removed",
    cookie,
  );
  assert.ok(after.html.includes("已移除项目授权。"));
});
