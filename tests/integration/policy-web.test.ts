import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { WEB_CSP } from "../../src/app/html.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import { AppError } from "../../src/domain/errors.ts";
import { authorizeProjectOwner } from "../../src/service/projects.ts";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../../src/service/sessions.ts";
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

// Returns the `<tr>` containing the given text, so a scope cell can be counted
// inside one member's row rather than across the whole document.
function rowContaining(html: string, marker: string): string {
  const rows = html.split("</tr>");
  const row = rows.find((candidate) => candidate.includes(marker));
  assert.ok(row, `no row contains ${marker}`);
  return row;
}

// The membership table is the one with the `policy-caption` caption.
function memberTableHtml(html: string): string {
  const start = html.indexOf('<caption id="policy-caption"');
  assert.ok(start >= 0, "member table caption is present");
  const end = html.indexOf("</table>", start);
  assert.ok(end > start);
  return html.slice(start, end);
}

function credentialTableHtml(html: string): string {
  const start = html.indexOf('<caption id="policy-credentials-heading"');
  assert.ok(start >= 0, "credential table caption is present");
  const end = html.indexOf("</table>", start);
  assert.ok(end > start);
  return html.slice(start, end);
}

async function policySetup(fx: ServiceFixture): Promise<void> {
  await addPasswordAccount(fx, "acct_a", "a@example.test", "account a secret");
  await addPasswordAccount(fx, "acct_b", "b@example.test", "account b secret");
  await addPasswordAccount(fx, "acct_e", "e@example.test", "account e secret");
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addSpeaker("spk_b", "acct_b");
  await fx.addSpeaker("spk_e", "acct_e");
  await fx.addProject("proj_a", "acct_a");
  await fx.addProject("proj_b", "acct_b");
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Alpha project", "proj_a"]);
  await fx.db.run("UPDATE projects SET title = ? WHERE id = ?", ["Foreign project", "proj_b"]);
  await fx.addMembership("proj_a", "spk_a", ALL_SCOPES);
  await fx.addMembership("proj_a", "spk_b", ["project.read", "message.read"]);
  // A non-owner member holding project.edit: the policy page must still be 404.
  await fx.addMembership("proj_a", "spk_e", ALL_SCOPES);
  await fx.addMembership("proj_b", "spk_b", ALL_SCOPES);
}

test("owner sees exactly the active members, scopes, and granted credential rows", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  await fx.addSpeaker("spk_cred", "acct_a");
  await fx.addSpeaker("spk_removed", "acct_a");
  await fx.db.run(
    `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at, removed_at)
     VALUES (?, ?, ?, ?, ?)`,
    [
      "proj_a",
      "spk_removed",
      JSON.stringify(ALL_SCOPES),
      "2026-11-03T11:59:00.000Z",
      "2026-11-03T11:59:30.000Z",
    ],
  );
  const granted = await fx.addCredential({
    id: "cred_granted",
    speakerId: "spk_cred",
    scopes: ["project.read", "message.read"],
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const revoked = await fx.addCredential({
    id: "cred_revoked",
    speakerId: "spk_cred",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
    revokedAt: new Date("2026-11-03T11:00:00.000Z"),
  });
  const expired = await fx.addCredential({
    id: "cred_expired",
    speakerId: "spk_cred",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
    expiresAt: new Date("2026-11-03T11:00:00.000Z"),
  });
  // Owned by the session account but not granted on this project: not listed.
  await fx.addCredential({
    id: "cred_ungranted",
    speakerId: "spk_a",
    autoGrantMemberships: false,
    grantProjects: ["proj_b"],
  });
  // A foreign account's speaker with a grant on this project: never listed.
  await fx.addCredential({
    id: "cred_foreign",
    speakerId: "spk_b",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });

  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/projects/proj_a/policy", cookie);
  assert.equal(page.status, 200);
  assertHardened(page.response);
  assert.match(page.html, /<html lang="en" dir="ltr">/);
  assert.ok(page.html.includes("<h1>Project policy</h1>"));
  assert.ok(page.html.includes('<table class="policy-table">'));
  assert.ok(
    page.html.includes(
      '<caption id="policy-caption">Active members and their scopes in this project</caption>',
    ),
  );
  assert.ok(page.html.includes('<th scope="col">Member</th>'));
  for (const scope of SCOPES) {
    assert.ok(
      page.html.includes(`<th scope="col"><code>${scope}</code></th>`),
      `scope column ${scope}`,
    );
  }

  const members = memberTableHtml(page.html);
  assert.equal((members.match(/scope="row"/g) ?? []).length, 3, "exactly three active members");
  assert.ok(members.includes("<code>spk_a</code>"));
  assert.ok(members.includes("<code>spk_b</code>"));
  assert.ok(members.includes("<code>spk_e</code>"));
  assert.equal(members.includes("<code>spk_removed</code>"), false);

  const ownerRow = rowContaining(members, "<code>spk_a</code>");
  assert.equal((ownerRow.match(/class="policy-granted"/g) ?? []).length, SCOPES.length);
  assert.equal((ownerRow.match(/class="policy-denied"/g) ?? []).length, 0);

  const readRow = rowContaining(members, "<code>spk_b</code>");
  assert.equal((readRow.match(/class="policy-granted"/g) ?? []).length, 2);
  assert.equal((readRow.match(/class="policy-denied"/g) ?? []).length, SCOPES.length - 2);
  // The capability summary repeats the codes in the final column.
  assert.ok(readRow.includes("<code>project.read</code>"));
  assert.ok(readRow.includes("<code>message.read</code>"));
  assert.equal(readRow.includes("<code>message.send</code>"), false);

  // No write surface: the read-only page renders no form and no CSRF value.
  assert.equal(page.html.includes("<form"), false);
  assert.equal(page.html.includes("csrf_token"), false);

  // Granted credential rows show the non-secret identifier, scopes, and state.
  for (const credential of [granted, revoked, expired]) {
    assert.ok(page.html.includes(`<code>${credential.credentialId}</code>`), credential.credentialId);
  }
  assert.equal(page.html.includes(granted.token), false, "the raw token is never rendered");
  assert.equal(page.html.includes(revoked.token), false);
  assert.equal(page.html.includes(expired.token), false);
  assert.ok(page.html.includes("Revoked"));
  assert.ok(page.html.includes("Expired"));
  assert.ok(page.html.includes("Active"));
  // The credential's scope ceiling is shown for the granted credential.
  const credentialRow = rowContaining(page.html, "<code>cred_granted</code>");
  assert.ok(credentialRow.includes("<code>project.read</code>"));
  assert.ok(credentialRow.includes("<code>message.read</code>"));
  assert.ok(credentialRow.includes("<code>spk_cred</code>"));

  // Ungranted and foreign credentials never appear.
  assert.equal(page.html.includes("cred_ungranted"), false);
  assert.equal(page.html.includes("cred_foreign"), false);
  // No credential secret beyond the non-secret metadata.
  assert.equal(page.html.includes("public_prefix"), false);
  assert.equal(page.html.includes("secret_verifier"), false);

  // The project timeline links only the owner to the matrix.
  const timeline = await getPage(app, "/projects/proj_a", cookie);
  assert.equal(timeline.status, 200);
  assert.ok(timeline.html.includes('href="/projects/proj_a/policy"'));
  const readOnly = await loginAsWithCsrf(app, "b@example.test", "account b secret");
  const nonOwnerTimeline = await getPage(app, "/projects/proj_a", readOnly.cookie);
  assert.equal(nonOwnerTimeline.status, 200);
  assert.equal(nonOwnerTimeline.html.includes("/projects/proj_a/policy"), false);
  const editor = await loginAsWithCsrf(app, "e@example.test", "account e secret");
  const editorTimeline = await getPage(app, "/projects/proj_a", editor.cookie);
  assert.equal(editorTimeline.status, 200);
  assert.equal(editorTimeline.html.includes("/projects/proj_a/policy"), false);

  // Chinese labels and preserved language on the back link.
  const chinese = await getPage(app, "/projects/proj_a/policy?lang=zh", cookie);
  assert.equal(chinese.status, 200);
  assert.match(chinese.html, /<html lang="zh-Hans" dir="ltr">/);
  assert.ok(chinese.html.includes("项目策略"));
  assert.ok(chinese.html.includes("已授予"));
  assert.ok(chinese.html.includes("未授予"));
  assert.ok(chinese.html.includes('href="/projects/proj_a?lang=zh"'));
});

test("every non-owner authorization failure is the uniform 404", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const readOnly = await loginAsWithCsrf(app, "b@example.test", "account b secret");
  const editor = await loginAsWithCsrf(app, "e@example.test", "account e secret");

  // A read-only non-owner and a non-owner holding project.edit are both hidden.
  for (const other of [readOnly, editor]) {
    const page = await getPage(app, "/projects/proj_a/policy", other.cookie);
    assert.equal(page.status, 404);
    assert.ok(page.html.includes("The requested page is not available."));
    assert.equal(page.html.includes("Alpha project"), false);
    assert.equal(page.html.includes("policy-caption"), false);
  }

  // Foreign, unknown, and inactive projects are the same 404.
  for (const path of ["/projects/proj_b/policy", "/projects/proj_missing/policy"]) {
    const page = await getPage(app, path, owner.cookie);
    assert.equal(page.status, 404, path);
  }
  await fx.db.run("UPDATE projects SET status = 'inactive' WHERE id = ?", ["proj_a"]);
  const inactive = await getPage(app, "/projects/proj_a/policy", owner.cookie);
  assert.equal(inactive.status, 404);
});

test("an inactive owning account loses the session before the policy page", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  const owner = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  await fx.db.run("UPDATE accounts SET status = 'inactive' WHERE id = ?", ["acct_a"]);
  const page = await getPage(app, "/projects/proj_a/policy", owner.cookie);
  assert.equal(page.status, 303);
  assert.equal(
    page.response.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/projects/proj_a/policy")}`,
  );
});

test("unauthenticated and bearer-only requests redirect to login and never read Authorization", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  const { token } = await fx.addCredential({
    speakerId: "spk_a",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });

  const anonymous = await call(app, "/projects/proj_a/policy");
  assert.equal(anonymous.status, 303);
  assert.equal(
    anonymous.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/projects/proj_a/policy")}`,
  );

  // The dashboard never accepts a bearer credential; the header is ignored and
  // the request is treated as unauthenticated.
  const bearer = await call(app, "/projects/proj_a/policy", {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(bearer.status, 303);
  assert.equal(
    bearer.headers.get("location"),
    `/login?return_to=${encodeURIComponent("/projects/proj_a/policy")}`,
  );
});

test("inactive owned speakers do not hide their granted credentials", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  await fx.addSpeaker("spk_cred", "acct_a", "inactive");
  await fx.addCredential({
    id: "cred_inactive_speaker",
    speakerId: "spk_cred",
    scopes: ["message.read"],
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  // Speaker status is not an input to the owner predicate or the inventory, so
  // the page stays available and the credential remains visible with its state.
  const page = await getPage(app, "/projects/proj_a/policy", cookie);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes("cred_inactive_speaker"));
});

test("a hostile display name is escaped in the member and credential rows", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  await fx.addSpeaker("spk_cred", "acct_a");
  await fx.addCredential({
    id: "cred_xss",
    speakerId: "spk_cred",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const hostile = `"><script>alert(1)</script>&"`;
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [hostile, "spk_a"]);
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [hostile, "spk_cred"]);
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  const page = await getPage(app, "/projects/proj_a/policy", cookie);
  assert.equal(page.status, 200);
  assert.equal(page.html.includes("<script>alert(1)</script>"), false);
  assert.ok(page.html.includes("&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;"));
});

test("an owner project with no active members renders the empty state", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_owner", "owner@example.test", "owner secret");
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addProject("proj_empty", "acct_owner");
  const { cookie } = await loginAsWithCsrf(app, "owner@example.test", "owner secret");
  const page = await getPage(app, "/projects/proj_empty/policy", cookie);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes("This project has no active members."));
  assert.ok(page.html.includes("No credential owned by this account holds a grant on this project."));
  assert.equal(page.html.includes('<caption id="policy-caption"'), false);
});

test("the member list is bounded to 100 rows with an honest truncation note", async (t) => {  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_owner", "owner@example.test", "owner secret");
  await fx.addProject("proj_large", "acct_owner");
  for (let index = 0; index < 101; index += 1) {
    const speakerId = `spk_${String(index).padStart(3, "0")}`;
    await fx.addSpeaker(speakerId, "acct_owner");
    await fx.addMembership("proj_large", speakerId, ["project.read"]);
  }
  const { cookie } = await loginAsWithCsrf(app, "owner@example.test", "owner secret");
  const page = await getPage(app, "/projects/proj_large/policy", cookie);
  assert.equal(page.status, 200);
  const members = memberTableHtml(page.html);
  assert.equal((members.match(/scope="row"/g) ?? []).length, 100);
  assert.ok(page.html.includes("Only the first 100 active members are shown."));
  // The 101st member (ordered by joined_at then speaker id) is not rendered.
  assert.equal(page.html.includes("<code>spk_100</code>"), false);
});

test("a truncated credential search does not claim the account has no grant", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_owner", "owner@example.test", "owner secret");
  await fx.addProject("proj_none", "acct_owner");
  // More owned speakers than the page considers, none with a credential.
  for (let index = 0; index < 101; index += 1) {
    await fx.addSpeaker(`spk_${String(index).padStart(3, "0")}`, "acct_owner");
  }
  const { cookie } = await loginAsWithCsrf(app, "owner@example.test", "owner secret");
  const page = await getPage(app, "/projects/proj_none/policy", cookie);
  assert.equal(page.status, 200);
  assert.ok(
    page.html.includes(
      "No credential among the first 100 owned speakers holds a grant on this project.",
    ),
  );
  assert.equal(
    page.html.includes("No credential owned by this account holds a grant on this project."),
    false,
    "the absolute empty claim is false when the speaker list was truncated",
  );
});

test("credential rows are capped at 100 with an honest truncation note", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_owner", "owner@example.test", "owner secret");
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addProject("proj_creds", "acct_owner");
  for (let index = 0; index < 101; index += 1) {
    await fx.addCredential({
      id: `cred_${String(index).padStart(3, "0")}`,
      speakerId: "spk_owner",
      grantProjects: ["proj_creds"],
      autoGrantMemberships: false,
    });
  }
  const { cookie } = await loginAsWithCsrf(app, "owner@example.test", "owner secret");
  const page = await getPage(app, "/projects/proj_creds/policy", cookie);
  assert.equal(page.status, 200);
  const table = credentialTableHtml(page.html);
  assert.equal((table.match(/scope="row"/g) ?? []).length, 100);
  assert.ok(page.html.includes("cred_000"));
  assert.equal(page.html.includes("cred_100"), false);
  assert.ok(
    page.html.includes(
      "Only the first 100 owned speakers are considered, and at most 100 credential rows are shown.",
    ),
  );
});

test("owned speakers considered for credentials are capped at 100 with a note", async (t) => {
  const { fx, app } = await withApp(t);
  await addPasswordAccount(fx, "acct_owner", "owner@example.test", "owner secret");
  await fx.addProject("proj_speakers", "acct_owner");
  for (let index = 0; index < 101; index += 1) {
    const suffix = String(index).padStart(3, "0");
    await fx.addSpeaker(`spk_${suffix}`, "acct_owner");
    await fx.addCredential({
      id: `cred_${suffix}`,
      speakerId: `spk_${suffix}`,
      grantProjects: ["proj_speakers"],
      autoGrantMemberships: false,
    });
  }
  const { cookie } = await loginAsWithCsrf(app, "owner@example.test", "owner secret");
  const page = await getPage(app, "/projects/proj_speakers/policy", cookie);
  assert.equal(page.status, 200);
  const table = credentialTableHtml(page.html);
  assert.equal((table.match(/scope="row"/g) ?? []).length, 100);
  // Only the first 100 owned speakers are read; the 101st speaker's credential
  // is outside the considered set.
  assert.ok(page.html.includes("cred_000"));
  assert.equal(page.html.includes("cred_100"), false);
  assert.ok(
    page.html.includes(
      "Only the first 100 owned speakers are considered, and at most 100 credential rows are shown.",
    ),
  );
});

test("the policy GET is read-only: no membership, credential, grant, or audit mutation", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  await fx.addSpeaker("spk_cred", "acct_a");
  await fx.addCredential({
    id: "cred_read_only",
    speakerId: "spk_cred",
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");

  const snapshot = async (): Promise<unknown> => ({
    memberships: await fx.db.all(
      "SELECT project_id, speaker_id, capabilities, joined_at, removed_at FROM project_memberships ORDER BY project_id, speaker_id",
    ),
    credentials: await fx.db.all(
      "SELECT id, speaker_id, expires_at, revoked_at, scope_json FROM credentials ORDER BY id",
    ),
    grants: await fx.db.all(
      "SELECT credential_id, project_id FROM credential_project_grants ORDER BY credential_id, project_id",
    ),
    audit: await fx.db.all(
      "SELECT id, operation, outcome, project_id FROM audit_events ORDER BY id",
    ),
    nextSeq: await fx.db.all("SELECT id, next_seq FROM projects ORDER BY id"),
  });
  const before = await snapshot();
  const page = await getPage(app, "/projects/proj_a/policy", cookie);
  assert.equal(page.status, 200);
  assert.deepEqual(await snapshot(), before);
});

test("the policy route is GET-only and rejects other methods", async (t) => {
  const { fx, app } = await withApp(t);
  await policySetup(fx);
  const { cookie } = await loginAsWithCsrf(app, "a@example.test", "account a secret");
  for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
    const response = await call(app, "/projects/proj_a/policy", {
      method,
      headers: { cookie },
    });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "GET", method);
  }
});

test("a bearer principal is rejected by the owner predicate itself", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_owner");
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addProject("proj_a", "acct_owner");
  await fx.addMembership("proj_a", "spk_owner", ALL_SCOPES);
  const { token } = await fx.addCredential({
    speakerId: "spk_owner",
    scopes: ALL_SCOPES,
    grantProjects: ["proj_a"],
    autoGrantMemberships: false,
  });
  const bearer = await fx.authenticate(token);
  await assert.rejects(
    authorizeProjectOwner(fx.deps, bearer, "proj_a"),
    (error: unknown) => error instanceof AppError && error.code === "NOT_FOUND",
  );
});
