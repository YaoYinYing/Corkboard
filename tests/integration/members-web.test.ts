import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProject, sessionAccountPrincipal } from "../../src/service/auth.ts";
import {
  addProjectMember,
  listProjectMembers,
  removeProjectMember,
} from "../../src/service/projects.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import type { SqlDatabase, SqlValue } from "../../src/storage/db.ts";
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

// Fails after the service's transaction body has issued its writes, proving
// the membership and grant mutations roll back together.
function withRollbackAfterTransaction(db: SqlDatabase): SqlDatabase {
  return delegateDatabase(db, (fn) =>
    db.transaction(async (tx) => {
      await fn(tx);
      throw new Error("injected rollback after transaction body");
    }),
  );
}

async function memberSetup(fx: ServiceFixture): Promise<void> {
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await addPasswordAccount(fx, "acct_d", "d@example.test", "account d secret");
  // acct_e is a non-owner member holding project.edit: membership
  // administration must still be owner-only.
  await addPasswordAccount(fx, "acct_e", "e@example.test", "account e secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addSpeaker("spk_d", "acct_d");
  await fx.addSpeaker("spk_e", "acct_e");
  await fx.addProject("proj_a", "acct_a");
  await fx.addProject("proj_d", "acct_d");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Alpha project", "proj_a"]);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Foreign project", "proj_d"]);
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
  // A non-owner account with read access only: it can list the project but
  // must not reach the membership editor.
  await fx.addMembership("proj_a", "spk_b", ["project.read", "message.read"]);
  // A non-owner account with project.edit: without the ownership gate this
  // would pass the old capability check and reach the editor.
  await fx.addMembership("proj_a", "spk_e", ALL_SCOPES);
  await fx.addMembership("proj_d", "spk_d", ALL_SCOPES);
}

async function membershipRow(
  fx: ServiceFixture,
  projectId: string,
  speakerId: string,
): Promise<
  { capabilities: string; joined_at: string | null; removed_at: string | null } | undefined
> {
  return fx.db.first(
    "SELECT capabilities, joined_at, removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    [projectId, speakerId],
  );
}

test("owner lists members and adds an owned active speaker with explicit capabilities", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  await fx.addSpeaker("spk_c2", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const page = await getPage(app, "/projects/proj_a/members", cookie);
  assert.equal(page.status, 200);
  assertHardened(page.response);
  assert.match(page.html, /<html lang="en" dir="ltr">/);
  assert.ok(page.html.includes("Members"));
  assert.ok(page.html.includes("<code>spk_a</code>"));
  assert.ok(page.html.includes("<code>spk_b</code>"));
  assert.ok(page.html.includes("<code>project.edit</code>"));
  for (const scope of SCOPES) {
    assert.ok(page.html.includes(`name="scope" value="${scope}"`), scope);
  }
  assert.ok(page.html.includes('method="post" action="/projects/proj_a/members"'));
  assert.ok(
    page.html.includes('action="/projects/proj_a/members/spk_a/remove"'),
    "each active member has a remove form",
  );

  const added = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "message.read"],
    ["scope", "project.read"],
    ["scope", "message.read"],
  ]);
  assert.equal(added.status, 303);
  assert.equal(added.headers.get("location"), "/projects/proj_a/members");

  const row = await membershipRow(fx, "proj_a", "spk_c");
  assert.ok(row);
  assert.equal(row.removed_at, null);
  // Duplicates collapse and capabilities are stored in canonical order.
  assert.equal(row.capabilities, JSON.stringify(["project.read", "message.read"]));
  // Adding a membership creates no credential, grant, or implicit access.
  assert.equal(
    (await fx.db.all<{ id: string }>("SELECT id FROM credentials")).length,
    0,
  );
  assert.equal(
    (await fx.db.all<{ credential_id: string }>("SELECT credential_id FROM credential_project_grants"))
      .length,
    0,
  );

  const after = await getPage(app, "/projects/proj_a/members", cookie);
  assert.ok(after.html.includes("<code>spk_c</code>"));
  assert.ok(after.html.includes("<code>project.read</code>"));
  assert.ok(after.html.includes("<code>message.read</code>"));
  assert.equal(after.html.includes('value="spk_c"'), false, "the form resets after success");

  const audit = await fx.db.all<{ operation: string; detail: string | null }>(
    "SELECT operation, detail FROM audit_events WHERE operation = 'membership.grant'",
  );
  assert.equal(audit.length, 1);
  assert.ok(audit[0]?.detail?.includes("spk_c") === false);

  const chinese = await getPage(app, "/projects/proj_a/members?lang=zh", cookie);
  assert.equal(chinese.status, 200);
  assert.match(chinese.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(chinese.html.includes("成员"));
  assert.ok(chinese.html.includes("添加成员"));
  // Locale is preserved by both form actions and the post-success redirect.
  assert.ok(chinese.html.includes('action="/projects/proj_a/members?lang=zh"'));
  assert.ok(
    chinese.html.includes('action="/projects/proj_a/members/spk_a/remove?lang=zh"'),
  );
  const chineseAdd = await postFormMulti(app, "/projects/proj_a/members?lang=zh", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c2"],
    ["scope", "project.read"],
  ]);
  assert.equal(chineseAdd.status, 303);
  assert.equal(chineseAdd.headers.get("location"), "/projects/proj_a/members?lang=zh");
});

test("non-owners, unknown projects, and foreign projects are the uniform 404 before body parsing", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const readOnly = await loginAsWithCsrf(app, "b@example.test", "account b secret");
  const editor = await loginAsWithCsrf(app, "e@example.test", "account e secret");

  // Mutation proof: acct_e's speaker is a non-owner member holding
  // project.edit (and every other scope). If the owner predicate were replaced
  // by the old project.edit check, these requests would return 200 instead of
  // 404. acct_b is a read-only non-owner; both must be uniformly hidden.
  for (const other of [readOnly, editor]) {
    for (const [method, path, body] of [
      ["GET", "/projects/proj_a/members", undefined],
      ["POST", "/projects/proj_a/members", "not=form"],
      ["POST", "/projects/proj_a/members/spk_a/remove", "not=form"],
    ] as const) {
      const response = await call(app, path, {
        method,
        headers: { cookie: other.cookie },
        ...(body === undefined
          ? {}
          : {
              headers: { cookie: other.cookie, "content-type": "application/json" },
              body,
            }),
      });
      assert.equal(response.status, 404, `${method} ${path}`);
      const html = await response.text();
      assert.ok(html.includes("The requested page is not available."), `${method} ${path}`);
      assert.equal(html.includes("Alpha project"), false, `${method} ${path}`);
      // The locale switch echoes the request path, so path identifiers may
      // appear; no member name or project title is rendered.
      assert.equal(html.includes(">spk_a<") || html.includes("member-0-name"), false);
    }
  }

  // A valid project.edit member still cannot add a member or mint anything.
  await fx.addSpeaker("spk_e2", "acct_e");
  const editorAdd = await postFormMulti(app, "/projects/proj_a/members", editor.cookie, [
    ["csrf_token", editor.csrf],
    ["speaker_id", "spk_e2"],
    ["scope", "message.send"],
  ]);
  assert.equal(editorAdd.status, 404);
  assert.equal(await membershipRow(fx, "proj_a", "spk_e2"), undefined);
  assert.equal(
    (await fx.db.all<{ id: string }>("SELECT id FROM credentials")).length,
    0,
  );

  for (const path of ["/projects/proj_d/members", "/projects/proj_missing/members"]) {
    const response = await getPage(app, path, owner.cookie);
    assert.equal(response.status, 404, path);
  }

  // Unauthenticated requests still redirect to login.
  const anonymous = await call(app, "/projects/proj_a/members");
  assert.equal(anonymous.status, 303);
  assert.equal(
    anonymous.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/projects/proj_a/members")}`,
  );

  assert.equal((await membershipRow(fx, "proj_a", "spk_a"))?.removed_at, null);
});

test("foreign and unknown speakers are rejected identically and no membership is written", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_inactive", "acct_a", "inactive");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const responses: string[] = [];
  for (const speakerId of ["spk_d", "spk_missing", "spk_inactive"]) {
    const response = await postFormMulti(app, "/projects/proj_a/members", cookie, [
      ["csrf_token", csrf],
      ["speaker_id", speakerId],
      ["scope", "project.read"],
    ]);
    assert.equal(response.status, 400, speakerId);
    const html = await response.text();
    assert.ok(html.includes('role="alert"'), speakerId);
    assert.ok(html.includes("Check the speaker ID and capabilities"), speakerId);
    responses.push(html.replaceAll(speakerId, "SPEAKER"));
  }
  // The response does not distinguish a foreign, missing, or inactive speaker.
  assert.equal(responses[1], responses[0]);
  assert.equal(responses[2], responses[0]);

  assert.equal(await membershipRow(fx, "proj_a", "spk_d"), undefined);
  assert.equal(await membershipRow(fx, "proj_a", "spk_missing"), undefined);
  assert.equal(await membershipRow(fx, "proj_a", "spk_inactive"), undefined);
});

test("duplicate active membership is rejected without changing capabilities", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const first = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "message.read"],
  ]);
  assert.equal(first.status, 303);

  const duplicate = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "project.read"],
    ["scope", "message.read"],
  ]);
  assert.equal(duplicate.status, 400);
  assert.ok((await duplicate.text()).includes("That speaker is already an active member."));

  const row = await membershipRow(fx, "proj_a", "spk_c");
  assert.equal(row?.capabilities, JSON.stringify(["message.read"]));
  assert.equal(row?.removed_at, null);
  const count = await fx.db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    ["proj_a", "spk_c"],
  );
  assert.equal(count?.count, 1);
});

test("unknown, empty, or malformed capability sets are rejected without a write", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const attempts: Array<{ name: string; fields: Array<[string, string]> }> = [
    { name: "unknown scope", fields: [["scope", "project.admin"]] },
    { name: "empty scope set", fields: [] },
    { name: "valid plus unknown", fields: [["scope", "project.read"], ["scope", "bogus"]] },
    { name: "duplicate speaker field", fields: [["speaker_id", "spk_c"], ["speaker_id", "spk_c"], ["scope", "project.read"]] },
    { name: "blank speaker id", fields: [["speaker_id", ""], ["scope", "project.read"]] },
  ];
  for (const attempt of attempts) {
    const response = await postFormMulti(app, "/projects/proj_a/members", cookie, [
      ["csrf_token", csrf],
      ...attempt.fields,
    ]);
    assert.equal(response.status, 400, attempt.name);
    assert.ok((await response.text()).includes('role="alert"'), attempt.name);
    assert.equal(await membershipRow(fx, "proj_a", "spk_c"), undefined, attempt.name);
  }
});

test("the last owner membership cannot be removed, but another owner membership permits removal", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  // Neither of these owner-account memberships satisfies the guarantee: one
  // lacks project.edit and the other's speaker is inactive.
  await fx.addSpeaker("spk_limited", "acct_a");
  await fx.addSpeaker("spk_inactive", "acct_a", "inactive");
  for (const [speakerId, capabilities] of [
    ["spk_limited", ["project.read"]],
    ["spk_inactive", ALL_SCOPES],
  ] as const) {
    await fx.db.run(
      `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
       VALUES (?, ?, ?, ?)`,
      ["proj_a", speakerId, JSON.stringify(capabilities), "2026-11-03T12:00:00.000Z"],
    );
  }
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const refused = await postFormMulti(app, "/projects/proj_a/members/spk_a/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(refused.status, 400);
  assert.ok((await refused.text()).includes("The last owner membership cannot be removed."));
  assert.equal((await membershipRow(fx, "proj_a", "spk_a"))?.removed_at, null);

  // Give the owner account a second membership, then the first may be removed.
  const added = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ...ALL_SCOPES.map((scope): [string, string] => ["scope", scope]),
  ]);
  assert.equal(added.status, 303);
  const allowed = await postFormMulti(app, "/projects/proj_a/members/spk_a/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(allowed.status, 303);
  assert.ok((await membershipRow(fx, "proj_a", "spk_a"))?.removed_at);

  // Removing the now-last owner membership is refused again.
  const last = await postFormMulti(app, "/projects/proj_a/members/spk_c/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(last.status, 400);
  assert.equal((await membershipRow(fx, "proj_a", "spk_c"))?.removed_at, null);

  // A non-owner membership may still be removed while an owner remains.
  const nonOwner = await postFormMulti(app, "/projects/proj_a/members/spk_b/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(nonOwner.status, 303);
  assert.ok((await membershipRow(fx, "proj_a", "spk_b"))?.removed_at);
});

test("the list shows only active memberships in joined order", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_removed", "acct_a");
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at, removed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "proj_a",
      "spk_removed",
      JSON.stringify(["project.read"]),
      "2026-11-03T11:59:00.000Z",
      "2026-11-03T11:59:30.000Z",
    ],
  );
  for (const [speakerId, joinedAt] of [
    ["spk_a", "2026-11-03T12:03:00.000Z"],
    ["spk_b", "2026-11-03T12:01:00.000Z"],
    ["spk_e", "2026-11-03T12:02:00.000Z"],
  ] as const) {
    await fx.db.run(
      "UPDATE project_memberships SET joined_at = ? WHERE project_id = ? AND speaker_id = ?",
      [joinedAt, "proj_a", speakerId],
    );
  }
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/projects/proj_a/members", cookie);
  assert.equal(page.status, 200);
  assert.equal(page.html.includes("spk_removed"), false, "removed rows are not listed");
  const order = ["spk_b", "spk_e", "spk_a"].map((id) =>
    page.html.indexOf(`<code>${id}</code>`),
  );
  assert.ok(order.every((index) => index >= 0));
  assert.ok(order[0]! < order[1]! && order[1]! < order[2]!, "ordered by joined_at");
});

test("concurrent removal of the last two manageable owner memberships keeps one", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_a", "spk_c", JSON.stringify(ALL_SCOPES), "2026-11-03T12:00:00.000Z"],
  );
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const [first, second] = await Promise.all([
    postFormMulti(app, "/projects/proj_a/members/spk_a/remove", cookie, [
      ["csrf_token", csrf],
    ]),
    postFormMulti(app, "/projects/proj_a/members/spk_c/remove", cookie, [
      ["csrf_token", csrf],
    ]),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [303, 400]);
  const conflict = first.status === 400 ? first : second;
  assert.ok((await conflict.text()).includes("The last owner membership cannot be removed."));

  const owners = await fx.db.all<{ speaker_id: string; capabilities: string; removed_at: string | null }>(
    `SELECT m.speaker_id, m.capabilities, m.removed_at
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
      WHERE m.project_id = ? AND s.owner_account_id = ? AND s.status = 'active'`,
    ["proj_a", "acct_a"],
  );
  const manageable = owners.filter(
    (owner) =>
      owner.removed_at === null &&
      (JSON.parse(owner.capabilities) as string[]).includes("project.edit"),
  );
  assert.equal(manageable.length, 1, "exactly one manageable owner membership remains");
});

test("removing a membership deletes its project grants so a reactivated credential cannot revive", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const added = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "project.read"],
    ["scope", "message.read"],
  ]);
  assert.equal(added.status, 303);

  const { token, credentialId } = await fx.addCredential({
    speakerId: "spk_c",
    scopes: ["project.read", "message.read"],
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const principal = await fx.authenticate(token);
  await authorizeProject(fx.deps, principal, "proj_a", "project.read");

  // spk_c is owned by the project owner account, so it is an owner membership;
  // spk_a remains, which permits this removal.
  const removed = await postFormMulti(app, "/projects/proj_a/members/spk_c/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(removed.status, 303);
  assert.ok((await membershipRow(fx, "proj_a", "spk_c"))?.removed_at);

  const grants = await fx.db.all<{ credential_id: string }>(
    "SELECT credential_id FROM credential_project_grants WHERE project_id = ? AND credential_id = ?",
    ["proj_a", credentialId],
  );
  assert.equal(grants.length, 0, "removal deletes the speaker's grants for the project");
  await assert.rejects(
    authorizeProject(fx.deps, principal, "proj_a", "project.read"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );

  // Re-adding restores access only through a new explicit grant; the old
  // credential does not regain the project because its grant stayed deleted.
  // It also creates a fresh joined_at and stores the newly submitted set.
  fx.setNow(new Date("2026-11-03T12:10:00.000Z"));
  const readded = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "receipt.write"],
    ["scope", "project.read"],
  ]);
  assert.equal(readded.status, 303);
  const reactivated = await membershipRow(fx, "proj_a", "spk_c");
  assert.equal(reactivated?.removed_at, null);
  assert.equal(reactivated?.joined_at, "2026-11-03T12:10:00.000Z");
  assert.equal(reactivated?.capabilities, JSON.stringify(["project.read", "receipt.write"]));
  const grantsAfter = await fx.db.all<{ credential_id: string }>(
    "SELECT credential_id FROM credential_project_grants WHERE project_id = ? AND credential_id = ?",
    ["proj_a", credentialId],
  );
  assert.equal(grantsAfter.length, 0);
  await assert.rejects(
    authorizeProject(fx.deps, principal, "proj_a", "project.read"),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );

  const operations = await fx.db.all<{ operation: string }>(
    "SELECT operation FROM audit_events WHERE operation IN ('membership.remove', 'credential.project.revoke') ORDER BY operation",
  );
  assert.deepEqual(
    operations.map((row) => row.operation),
    ["credential.project.revoke", "membership.remove"],
  );
});

test("membership writes require the session double-submit CSRF check", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const sessionOnly = cookie.split("; ")[0];

  const attempts: Array<{ name: string; fields: Array<[string, string]> }> = [
    { name: "missing", fields: [["speaker_id", "spk_c"], ["scope", "project.read"]] },
    { name: "wrong", fields: [["csrf_token", "A".repeat(43)], ["speaker_id", "spk_c"], ["scope", "project.read"]] },
  ];
  for (const attempt of attempts) {
    const response = await postFormMulti(app, "/projects/proj_a/members", cookie, attempt.fields);
    assert.equal(response.status, 400, attempt.name);
    assert.ok((await response.text()).includes("The form expired."), attempt.name);
  }

  const noCookie = await postFormMulti(app, "/projects/proj_a/members", sessionOnly, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "project.read"],
  ]);
  assert.equal(noCookie.status, 400);

  for (const headers of [
    { origin: "https://evil.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "same-site" },
  ]) {
    const response = await call(app, "/projects/proj_a/members", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        ...headers,
      },
      body: new URLSearchParams({
        csrf_token: csrf,
        speaker_id: "spk_c",
        scope: "project.read",
      }).toString(),
    });
    assert.equal(response.status, 400, JSON.stringify(headers));
    assert.ok((await response.text()).includes("The form expired."));
  }

  const unbound = "unbound-double-submit-value";
  const unboundResponse = await call(app, "/projects/proj_a/members", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `${sessionOnly}; ${CSRF_COOKIE_NAME}=${unbound}`,
    },
    body: new URLSearchParams({
      csrf_token: unbound,
      speaker_id: "spk_c",
      scope: "project.read",
    }).toString(),
  });
  assert.equal(unboundResponse.status, 400);

  // Removal has the same requirement.
  const remove = await postFormMulti(app, "/projects/proj_a/members/spk_b/remove", cookie, []);
  assert.equal(remove.status, 400);
  assert.equal((await membershipRow(fx, "proj_a", "spk_b"))?.removed_at, null);
  assert.equal(await membershipRow(fx, "proj_a", "spk_c"), undefined);
});

test("oversized membership bodies are rejected without a write", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const response = await call(app, "/projects/proj_a/members", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie,
    },
    body: `csrf_token=${encodeURIComponent(csrf)}&speaker_id=spk_c&scope=${"a".repeat(70_000)}`,
  });
  assert.equal(response.status, 413);
  const html = await response.text();
  assert.ok(html.includes('role="alert"'));
  assert.equal(html.includes("a".repeat(1000)), false);
  assert.equal(await membershipRow(fx, "proj_a", "spk_c"), undefined);
});

test("a failed transaction rolls back both the membership write and the grant deletion", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  await fx.addCredential({
    speakerId: "spk_b",
    scopes: ["project.read"],
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const app = createApp(
    { ...fx.deps, db: withRollbackAfterTransaction(fx.deps.db) },
    { loginRateLimit: { perMinute: 600, burst: 100 } },
  );
  const { cookie, csrf } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const added = await postFormMulti(app, "/projects/proj_a/members", cookie, [
    ["csrf_token", csrf],
    ["speaker_id", "spk_c"],
    ["scope", "project.read"],
  ]);
  assert.equal(added.status, 500);
  assert.equal(await membershipRow(fx, "proj_a", "spk_c"), undefined);

  const removed = await postFormMulti(app, "/projects/proj_a/members/spk_b/remove", cookie, [
    ["csrf_token", csrf],
  ]);
  assert.equal(removed.status, 500);
  assert.equal((await membershipRow(fx, "proj_a", "spk_b"))?.removed_at, null);
  const grants = await fx.db.all<{ credential_id: string }>(
    "SELECT credential_id FROM credential_project_grants WHERE project_id = ?",
    ["proj_a"],
  );
  assert.equal(grants.length, 1, "the grant deletion rolled back with the membership update");
});

test("member display names are escaped in the directory", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  await fx.addSpeaker("spk_c", "acct_a");
  const displayName = `"><script>alert(1)</script>&"`;
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [displayName, "spk_c"]);
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
     VALUES (?, ?, ?, ?)`,
    ["proj_a", "spk_c", JSON.stringify(["project.read"]), "2026-11-03T12:00:00.000Z"],
  );
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/projects/proj_a/members", cookie);
  assert.equal(page.status, 200);
  assert.equal(page.html.includes("<script>alert(1)</script>"), false);
  assert.ok(page.html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;"));
});

test("removal forms only accept POST and the editor keeps other routes intact", async (t) => {
  const { fx, app } = await withApp(t);
  await memberSetup(fx);
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const getRemove = await call(app, "/projects/proj_a/members/spk_b/remove", {
    headers: { cookie },
  });
  assert.equal(getRemove.status, 405);
  assert.equal(getRemove.headers.get("allow"), "POST");

  const putMembers = await call(app, "/projects/proj_a/members", {
    method: "PUT",
    headers: { cookie },
  });
  assert.equal(putMembers.status, 405);
  assert.equal(putMembers.headers.get("allow"), "GET, POST");

  const removal = await call(app, "/projects/proj_a/members/spk_b/remove", {
    method: "DELETE",
    headers: { cookie },
  });
  assert.equal(removal.status, 405);
});

test("project ownership alone permits membership changes without a caller membership or project.edit", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_owner");
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addSpeaker("spk_new", "acct_owner");
  await fx.addSpeaker("spk_limited", "acct_owner");
  await fx.addProject("proj_none", "acct_owner");
  await fx.addProject("proj_limited", "acct_owner");
  await fx.addMembership("proj_limited", "spk_limited", ["project.read"]);

  const principal = sessionAccountPrincipal({
    sessionId: "sess_owner",
    accountId: "acct_owner",
  });

  // Ownership with no membership at all: list, add (granting a scope the
  // caller does not hold), and remove all work.
  assert.deepEqual(await listProjectMembers(fx.deps, principal, "proj_none"), []);
  await addProjectMember(fx.deps, principal, "proj_none", {
    speakerId: "spk_new",
    capabilities: ["message.send"],
  });
  const noneMembers = await listProjectMembers(fx.deps, principal, "proj_none");
  assert.deepEqual(
    noneMembers.map((member) => [member.speakerId, member.capabilities]),
    [["spk_new", ["message.send"]]],
  );
  await removeProjectMember(fx.deps, principal, "proj_none", "spk_new");
  assert.deepEqual(await listProjectMembers(fx.deps, principal, "proj_none"), []);

  // The owner's only own membership is limited (project.read, no
  // project.edit), yet ownership still authorizes listing, adding a scope the
  // caller's membership lacks, and removal. There is no caller-rights cap.
  assert.deepEqual(
    (await listProjectMembers(fx.deps, principal, "proj_limited")).map(
      (member) => member.speakerId,
    ),
    ["spk_limited"],
  );
  await addProjectMember(fx.deps, principal, "proj_limited", {
    speakerId: "spk_new",
    capabilities: ["message.send", "receipt.write"],
  });
  const limitedMembers = await listProjectMembers(fx.deps, principal, "proj_limited");
  assert.ok(
    limitedMembers.some(
      (member) =>
        member.speakerId === "spk_new" &&
        member.capabilities.includes("message.send") &&
        member.capabilities.includes("receipt.write"),
    ),
  );
  await removeProjectMember(fx.deps, principal, "proj_limited", "spk_new");
  // The limited owner membership is not manageable, so it may be removed too.
  await removeProjectMember(fx.deps, principal, "proj_limited", "spk_limited");
  assert.deepEqual(await listProjectMembers(fx.deps, principal, "proj_limited"), []);
});

test("a bearer principal is rejected by the membership-editor ownership check", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_owner");
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addSpeaker("spk_other", "acct_owner");
  await fx.addProject("proj_a", "acct_owner");
  await fx.addMembership("proj_a", "spk_owner", ALL_SCOPES);
  const { token } = await fx.addCredential({
    speakerId: "spk_owner",
    scopes: ALL_SCOPES,
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const bearer = await fx.authenticate(token);
  assert.equal(bearer.sessionViewer, undefined);

  for (const action of [
    () => listProjectMembers(fx.deps, bearer, "proj_a"),
    () =>
      addProjectMember(fx.deps, bearer, "proj_a", {
        speakerId: "spk_other",
        capabilities: ["project.read"],
      }),
    () => removeProjectMember(fx.deps, bearer, "proj_a", "spk_owner"),
  ]) {
    await assert.rejects(
      action(),
      (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
    );
  }
  const ownerRows = await fx.db.all<{ removed_at: string | null }>(
    "SELECT removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
    ["proj_a", "spk_owner"],
  );
  assert.equal(ownerRows[0]?.removed_at, null);
  assert.equal(await membershipRow(fx, "proj_a", "spk_other"), undefined);
});

test("the Node adapter buffers membership form POSTs on the owner path over HTTP", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-members-http-"));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  const email = "members-http@example.test";
  const password = "members http secret";
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
    ["spk_http", "acct_http", "HTTP owner", now],
  );
  await db.run(
    `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    ["spk_http2", "acct_http", "HTTP added", now],
  );
  await db.run(
    `INSERT INTO projects (id, owner_account_id, title, summary, status, next_seq, created_at)
     VALUES (?, ?, ?, ?, 'active', 0, ?)`,
    ["proj_http", "acct_http", "HTTP project", "Members over HTTP", now],
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
  const formType = "application/x-www-form-urlencoded";

  // Sign in through the adapter, not createApp.
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
  const postForm = (path: string, fields: ReadonlyArray<readonly [string, string]>): Promise<Response> => {
    const body = new URLSearchParams();
    for (const [name, value] of fields) body.append(name, value);
    return fetch(`${base}${path}`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": formType, cookie, connection: "close" },
      body: body.toString(),
    });
  };

  const added = await postForm("/projects/proj_http/members", [
    ["csrf_token", csrf],
    ["speaker_id", "spk_http2"],
    ["scope", "project.read"],
    ["scope", "message.read"],
  ]);
  assert.equal(added.status, 303, "the adapter must buffer the members add body");
  assert.equal(added.headers.get("location"), "/projects/proj_http/members");

  const removed = await postForm("/projects/proj_http/members/spk_http2/remove", [
    ["csrf_token", csrf],
  ]);
  assert.equal(removed.status, 303, "the adapter must buffer the members remove body");
  assert.equal(removed.headers.get("location"), "/projects/proj_http/members");

  const oversized = await fetch(`${base}/projects/proj_http/members`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, cookie, connection: "close" },
    body: `csrf_token=${encodeURIComponent(csrf)}&speaker_id=spk_http2&scope=${"a".repeat(70_000)}`,
  });
  assert.equal(oversized.status, 413);

  const anonymous = await fetch(`${base}/projects/proj_http/members`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": formType, connection: "close" },
    body: "speaker_id=spk_http2&scope=project.read",
  });
  assert.equal(anonymous.status, 303);
  assert.equal(
    anonymous.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/projects/proj_http/members")}`,
  );
});
