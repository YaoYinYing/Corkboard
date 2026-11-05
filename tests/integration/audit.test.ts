import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { AppError } from "../../src/domain/errors.ts";
import {
  boundAuditDetail,
  MAX_AUDIT_DETAIL_CHARS,
} from "../../src/service/audit.ts";
import {
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  registerClient,
  revokeOAuthToken,
  s256Challenge,
} from "../../src/service/oauth.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  loginAccount,
  revokeSession,
} from "../../src/service/sessions.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

const BASE = "https://corkboard.test";
const EMAIL = "audit@example.test";
const PASSWORD = "audit password";
const REDIRECT_URI = "https://client.example/cb";
const CLIENT_NAME = "Audit Client";

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

async function addPasswordAccount(fx: ServiceFixture): Promise<void> {
  await fx.addAccount("acct_a");
  await fx.db.run("UPDATE accounts SET email = ?, password_hash = ? WHERE id = ?", [
    EMAIL,
    await hashPassword(PASSWORD),
    "acct_a",
  ]);
  await fx.addSpeaker("spk_a", "acct_a");
  await fx.addProject("proj_a", "acct_a");
  await fx.addMembership("proj_a", "spk_a", ["message.read", "message.send"]);
}

function formBody(fields: Record<string, string | readonly string[]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") params.set(name, value);
    else for (const item of value) params.append(name, item);
  }
  return params.toString();
}

function cookieHeader(sessionToken: string, csrfToken: string): string {
  return `${SESSION_COOKIE_NAME}=${sessionToken}; ${CSRF_COOKIE_NAME}=${csrfToken}`;
}

test("session and OAuth lifecycle events are recorded as sanitized metadata", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx);
  const app = createApp(fx.deps, {
    publicBaseUrl: BASE,
    loginRateLimit: { perMinute: 600, burst: 100 },
  });

  const login = await loginAccount(fx.deps, { email: EMAIL, password: PASSWORD });
  const cookies = cookieHeader(login.token, login.csrfToken);

  // Registration success and a rejected registration.
  const registered = await call(app, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [REDIRECT_URI],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registered.status, 201);
  const clientId = ((await registered.json()) as { client_id: string }).client_id;
  assert.match(clientId, /^cb_cli_/);

  const rejected = await call(app, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: CLIENT_NAME, redirect_uris: ["http://evil.example"] }),
  });
  assert.equal(rejected.status, 400);

  // Authorization page renders the signed consent form; parse its HMAC.
  const verifier = "v".repeat(43);
  const challenge = await s256Challenge(verifier);
  const authorizeQuery = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "audit-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: BASE,
    scope: "message.read message.send",
  });
  const authorize = await call(app, `/oauth/authorize?${authorizeQuery.toString()}`, {
    headers: { cookie: cookies },
  });
  assert.equal(authorize.status, 200);
  const authorizeHtml = await authorize.text();
  const signature = /name="request_signature" value="([^"]*)"/.exec(authorizeHtml)?.[1];
  assert.ok(signature);

  const consentFields = {
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    state: "audit-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: BASE,
    requested_scope: "message.read message.send",
    request_signature: signature,
    speaker_id: "spk_a",
    project_id: "proj_a",
  };
  const consentHeaders = {
    "content-type": "application/x-www-form-urlencoded",
    cookie: cookies,
    [CSRF_HEADER_NAME]: login.csrfToken,
  };

  const denied = await call(app, "/oauth/consent", {
    method: "POST",
    headers: consentHeaders,
    body: formBody({ ...consentFields, decision: "deny" }),
  });
  assert.equal(denied.status, 200);

  const allowed = await call(app, "/oauth/consent", {
    method: "POST",
    headers: consentHeaders,
    body: formBody({
      ...consentFields,
      decision: "allow",
      scope: ["message.read", "message.send"],
    }),
  });
  assert.equal(allowed.status, 200, await allowed.clone().text());
  const code = new URL(
    ((await allowed.json()) as { redirect_to: string }).redirect_to,
  ).searchParams.get("code");
  assert.ok(code);

  // A failed exchange is audited without any token or code value.
  const badExchange = await call(app, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      client_id: clientId,
      code: "cb_oac_" + "A".repeat(43),
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  assert.equal(badExchange.status, 400);

  const exchange = await call(app, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }),
  });
  assert.equal(exchange.status, 200, await exchange.clone().text());
  const tokens = (await exchange.json()) as { access_token: string; refresh_token: string };
  assert.match(tokens.access_token, /^cb_oat_/);
  assert.match(tokens.refresh_token, /^cb_ort_/);

  const refreshed = await call(app, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    }),
  });
  assert.equal(refreshed.status, 200, await refreshed.clone().text());
  const rotated = (await refreshed.json()) as { refresh_token: string };

  // Revoke the current refresh token, then reuse the retired one.
  const revoked = await call(app, "/oauth/revoke", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({ client_id: clientId, token: rotated.refresh_token }),
  });
  assert.equal(revoked.status, 200);

  const reused = await call(app, "/oauth/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
    }),
  });
  assert.equal(reused.status, 400);

  const signOut = await call(app, "/api/v1/session", {
    method: "DELETE",
    headers: { cookie: cookies, [CSRF_HEADER_NAME]: login.csrfToken },
  });
  assert.equal(signOut.status, 204);

  // A uniform invalid-credentials failure has no actor.
  await assert.rejects(
    loginAccount(fx.deps, { email: EMAIL, password: "wrong password" }),
    (error: unknown) => error instanceof AppError && error.code === "UNAUTHENTICATED",
  );

  const events = await fx.db.all<{
    operation: string;
    outcome: string;
    actor_account_id: string | null;
    detail: string | null;
  }>("SELECT operation, outcome, actor_account_id, detail FROM audit_events");

  const has = (operation: string, outcome: string): boolean =>
    events.some((event) => event.operation === operation && event.outcome === outcome);

  assert.ok(has("session.login", "success"));
  assert.ok(has("session.login", "failure"));
  assert.ok(has("session.logout", "success"));
  assert.ok(has("oauth.client.register", "success"));
  assert.ok(has("oauth.client.register", "failure"));
  assert.ok(has("oauth.consent", "success"));
  assert.ok(has("oauth.consent", "denied"));
  assert.ok(has("oauth.token.issue", "success"));
  assert.ok(has("oauth.token.issue", "failure"));
  assert.ok(has("oauth.refresh.reuse", "detected"));
  assert.ok(has("oauth.revoke", "success"));

  const loginSuccess = events.find(
    (event) => event.operation === "session.login" && event.outcome === "success",
  );
  assert.equal(loginSuccess?.actor_account_id, "acct_a");
  assert.deepEqual(JSON.parse(loginSuccess?.detail ?? "{}"), { mechanism: "password" });

  const loginFailure = events.find(
    (event) => event.operation === "session.login" && event.outcome === "failure",
  );
  assert.equal(loginFailure?.actor_account_id, null);
  assert.deepEqual(JSON.parse(loginFailure?.detail ?? "{}"), { reason: "invalid_credentials" });

  const consent = events.find(
    (event) => event.operation === "oauth.consent" && event.outcome === "success",
  );
  assert.deepEqual(JSON.parse(consent?.detail ?? "{}"), {
    client_id: clientId,
    project_id: "proj_a",
    speaker_id: "spk_a",
    scopes: ["message.read", "message.send"],
    decision: "allow",
  });

  // Sanitization: no credential, code, cookie, CSRF, password, email, client
  // name, or redirect URI anywhere in the audit rows.
  const serialized = JSON.stringify(events);
  for (const secret of [
    login.token,
    login.csrfToken,
    tokens.access_token,
    tokens.refresh_token,
    rotated.refresh_token,
    code ?? "",
    PASSWORD,
    EMAIL,
    CLIENT_NAME,
    REDIRECT_URI,
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
  for (const prefix of ["cb_oat_", "cb_ort_", "cb_oac_", "cb_sess_"]) {
    assert.equal(serialized.includes(prefix), false);
  }
  for (const event of events) {
    if (event.detail !== null) {
      assert.ok(event.detail.length <= MAX_AUDIT_DETAIL_CHARS);
    }
  }
});

test("rate-limited login is audited uniformly", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx);
  const app = createApp(fx.deps, {
    loginRateLimit: { perMinute: 1, burst: 1 },
  });
  const body = JSON.stringify({ email: EMAIL, password: PASSWORD });
  const headers = { "content-type": "application/json" };

  const first = await call(app, "/api/v1/session", { method: "POST", headers, body });
  assert.equal(first.status, 200);
  const second = await call(app, "/api/v1/session", { method: "POST", headers, body });
  assert.equal(second.status, 429);

  const failure = await fx.db.first<{ outcome: string; actor_account_id: string | null; detail: string | null }>(
    `SELECT outcome, actor_account_id, detail FROM audit_events
      WHERE operation = 'session.login' AND outcome = 'failure'`,
  );
  assert.equal(failure?.actor_account_id, null);
  assert.deepEqual(JSON.parse(failure?.detail ?? "{}"), { reason: "rate_limited" });
});

test("an audit insert failure never changes login, token, revocation, or logout outcomes", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await addPasswordAccount(fx);
  await fx.db.exec(
    `CREATE TRIGGER fail_audit BEFORE INSERT ON audit_events
     BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
  );

  const login = await loginAccount(fx.deps, { email: EMAIL, password: PASSWORD });
  const session = await fx.db.first<{ id: string }>(
    "SELECT id FROM sessions WHERE account_id = 'acct_a' ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(session);

  const client = await registerClient(fx.deps, {
    clientName: CLIENT_NAME,
    redirectUris: [REDIRECT_URI],
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
  });
  const verifier = "w".repeat(43);
  const issued = await issueAuthorizationCode(fx.deps, {
    sessionId: session.id,
    accountId: "acct_a",
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    state: null,
    codeChallenge: await s256Challenge(verifier),
    resource: BASE,
    scopes: ["message.read"],
    speakerId: "spk_a",
    projectId: "proj_a",
  });
  const tokens = await exchangeAuthorizationCode(fx.deps, {
    clientId: client.clientId,
    redirectUri: REDIRECT_URI,
    code: issued.code,
    codeVerifier: verifier,
  });
  assert.ok(tokens.refresh_token);
  await revokeOAuthToken(fx.deps, {
    clientId: client.clientId,
    token: tokens.refresh_token,
  });
  await revokeSession(fx.deps, login.token, login.csrfToken);

  const remaining = await fx.db.all("SELECT id FROM audit_events");
  assert.equal(remaining.length, 0);
});

test("audit detail is bounded by construction", () => {
  const oversized = boundAuditDetail({
    reason: "x".repeat(1000),
    scopes: Array.from({ length: 100 }, () => "y".repeat(300)),
  });
  assert.equal(oversized, null);

  const bounded = boundAuditDetail({ reason: "x".repeat(1000) });
  assert.ok(bounded !== null);
  assert.ok(bounded.length <= MAX_AUDIT_DETAIL_CHARS);
  assert.equal(bounded.includes("x".repeat(201)), false);
});
