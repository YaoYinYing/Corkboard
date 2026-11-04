import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomBase64url } from "../../src/auth/credentials.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { createApp } from "../../src/app/handlers.ts";
import type { CreateAppOptions } from "../../src/app/handlers.ts";
import type { Scope } from "../../src/domain/authz.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../../src/service/sessions.ts";
import { s256Challenge } from "../../src/service/oauth.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

const BASE = "https://corkboard.test";
const REDIRECT = "https://client.example/callback";
const LOCAL_REDIRECT = "http://127.0.0.1:49152/callback";
const EMAIL = "owner@example.test";
const PASSWORD = "owner password";
const MCP_URL = "http://corkboard.test/mcp";

interface Setup {
  fx: ServiceFixture;
  app: App;
  clientId: string;
  cookies: string[];
}

function call(app: App, path: string, options: {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
  contentType?: string;
} = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  let body: string | undefined;
  if (options.rawBody !== undefined) {
    body = options.rawBody;
    headers.set("content-type", options.contentType ?? "application/json");
  } else if (options.body !== undefined) {
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

function formCall(
  app: App,
  path: string,
  form: URLSearchParams | string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(app, path, {
    method: "POST",
    rawBody: form.toString(),
    contentType: "application/x-www-form-urlencoded",
    headers,
  });
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function cookieValue(cookies: readonly string[], name: string): string | undefined {
  for (const cookie of cookies) {
    const pair = cookie.split(";")[0] ?? "";
    const separator = pair.indexOf("=");
    if (separator > 0 && pair.slice(0, separator) === name) return pair.slice(separator + 1);
  }
  return undefined;
}

function cookieHeader(cookies: readonly string[]): string {
  return cookies
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "")
    .join("; ");
}

async function registerClient(
  app: App,
  overrides: Record<string, unknown> = {},
): Promise<{ status: number; body: JsonObject }> {
  const response = await call(app, "/oauth/register", {
    method: "POST",
    body: {
      client_name: "Test client",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...overrides,
    },
  });
  return { status: response.status, body: await jsonBody(response) };
}

async function setup(
  t: { after(fn: () => void | Promise<void>): void },
  options: CreateAppOptions = {},
  capabilities: readonly Scope[] = ["project.read", "message.read", "message.send", "receipt.write"],
): Promise<Setup> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_owner");
  await fx.db.run("UPDATE accounts SET email = ?, password_hash = ? WHERE id = ?", [
    EMAIL,
    await hashPassword(PASSWORD),
    "acct_owner",
  ]);
  await fx.addSpeaker("spk_owner", "acct_owner");
  await fx.addProject("proj_1", "acct_owner", "active");
  await fx.addMembership("proj_1", "spk_owner", capabilities);

  const app = createApp(fx.deps, {
    publicBaseUrl: BASE,
    loginRateLimit: { perMinute: 600, burst: 100 },
    oauthRegisterRateLimit: { perMinute: 600, burst: 100 },
    oauthTokenRateLimit: { perMinute: 600, burst: 100 },
    ...options,
  });
  const registered = await registerClient(app);
  assert.equal(registered.status, 201);
  const clientId = registered.body.client_id as string;
  const cookies = await login(app);
  return { fx, app, clientId, cookies };
}

async function login(app: App): Promise<string[]> {
  const response = await call(app, "/api/v1/session", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD },
  });
  assert.equal(response.status, 200);
  return response.headers.getSetCookie();
}

interface AuthorizeParams {
  clientId: string;
  redirectUri?: string;
  scope?: string;
  state?: string;
  challenge?: string;
  method?: string;
  resource?: string;
  speakerId?: string;
  projectId?: string;
  verifier?: string;
}

async function authorization(
  params: AuthorizeParams,
): Promise<{ url: string; verifier: string; challenge: string; state: string }> {
  const verifier = params.verifier ?? randomBase64url(32);
  const challenge = params.challenge ?? (await s256Challenge(verifier));
  const state = params.state ?? "state-123";
  const query = new URLSearchParams({
    response_type: "code",
    client_id: params.clientId,
    redirect_uri: params.redirectUri ?? REDIRECT,
    state,
    code_challenge: challenge,
    code_challenge_method: params.method ?? "S256",
    resource: params.resource ?? BASE,
  });
  if (params.scope !== undefined) query.set("scope", params.scope);
  if (params.speakerId !== undefined) query.set("speaker_id", params.speakerId);
  if (params.projectId !== undefined) query.set("project_id", params.projectId);
  return { url: `/oauth/authorize?${query.toString()}`, verifier, challenge, state };
}

async function getAuthorize(app: App, url: string, cookies?: readonly string[]): Promise<Response> {
  return call(app, url, {
    ...(cookies === undefined ? {} : { headers: { cookie: cookieHeader(cookies) } }),
  });
}

function hiddenValue(html: string, name: string): string | null {
  const match = new RegExp(
    `<input type="hidden" name="${name}" value="([^"]*)">`,
  ).exec(html);
  return match === null ? null : (match[1] ?? "");
}

function consentForm(input: {
  clientId: string;
  state: string;
  challenge: string;
  scopes?: readonly string[];
  speakerId?: string;
  projectId?: string;
  decision?: string;
  redirectUri?: string;
  resource?: string;
  requestedScope?: string;
  requestSignature?: string;
}): URLSearchParams {
  const form = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri ?? REDIRECT,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
    resource: input.resource ?? BASE,
    requested_scope: input.requestedScope ?? "message.read message.send",
    speaker_id: input.speakerId ?? "spk_owner",
    project_id: input.projectId ?? "proj_1",
    decision: input.decision ?? "allow",
  });
  if (input.requestSignature !== undefined) {
    form.set("request_signature", input.requestSignature);
  }
  for (const scope of input.scopes ?? ["message.read", "message.send"]) {
    form.append("scope", scope);
  }
  return form;
}

async function consent(
  setup: Setup,
  form: URLSearchParams,
  headers: Record<string, string> = {},
): Promise<Response> {
  return formCall(setup.app, "/oauth/consent", form, {
    cookie: cookieHeader(setup.cookies),
    [CSRF_HEADER_NAME]: cookieValue(setup.cookies, CSRF_COOKIE_NAME) ?? "",
    ...headers,
  });
}

async function obtainCode(
  setup: Setup,
  options: {
    scope?: string;
    scopes?: readonly string[];
    speakerId?: string;
    projectId?: string;
    redirectUri?: string;
    resource?: string;
    clientId?: string;
  } = {},
): Promise<{ code: string; verifier: string; state: string; clientId: string }> {
  const clientId = options.clientId ?? setup.clientId;
  const auth = await authorization({
    clientId,
    ...(options.scope === undefined ? {} : { scope: options.scope }),
    ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
    ...(options.resource === undefined ? {} : { resource: options.resource }),
  });
  const page = await getAuthorize(setup.app, auth.url, setup.cookies);
  assert.equal(page.status, 200);
  // Use the server-rendered hidden fields so the request signature matches the
  // authorization request actually shown in the consent page.
  const html = await page.text();
  const requestSignature = hiddenValue(html, "request_signature");
  const requestedScope = hiddenValue(html, "requested_scope");
  assert.ok(requestSignature);
  const response = await consent(
    setup,
    consentForm({
      clientId,
      state: auth.state,
      challenge: auth.challenge,
      ...(requestedScope === null ? {} : { requestedScope }),
      requestSignature,
      ...(options.scopes === undefined ? {} : { scopes: options.scopes }),
      ...(options.speakerId === undefined ? {} : { speakerId: options.speakerId }),
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.redirectUri === undefined ? {} : { redirectUri: options.redirectUri }),
      ...(options.resource === undefined ? {} : { resource: options.resource }),
    }),
  );
  assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
  const body = await jsonBody(response);
  const redirect = new URL(body.redirect_to);
  const code = redirect.searchParams.get("code");
  assert.ok(code);
  return { code, verifier: auth.verifier, state: auth.state, clientId };
}

async function token(
  app: App,
  fields: Record<string, string>,
): Promise<{ status: number; body: JsonObject; headers: Headers }> {
  const form = new URLSearchParams(fields);
  const response = await formCall(app, "/oauth/token", form);
  return { status: response.status, body: await jsonBody(response), headers: response.headers };
}

async function exchange(setup: Setup, code: { code: string; verifier: string }, overrides: Record<string, string> = {}): Promise<{ status: number; body: JsonObject }> {
  const result = await token(setup.app, {
    grant_type: "authorization_code",
    client_id: setup.clientId,
    code: code.code,
    redirect_uri: REDIRECT,
    code_verifier: code.verifier,
    resource: BASE,
    ...overrides,
  });
  return { status: result.status, body: result.body };
}

async function refresh(setup: Setup, refreshToken: string, overrides: Record<string, string> = {}): Promise<{ status: number; body: JsonObject }> {
  const result = await token(setup.app, {
    grant_type: "refresh_token",
    client_id: setup.clientId,
    refresh_token: refreshToken,
    ...overrides,
  });
  return { status: result.status, body: result.body };
}

function rest(app: App, path: string, token: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}): Promise<Response> {
  return call(app, path, {
    method: options.method ?? "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.method === "POST" ? { "idempotency-key": randomBase64url(18) } : {}),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}

function appFetch(app: App): FetchLike {
  return async (url, init) => app(new Request(url, init));
}

async function mcpClient(app: App, accessToken: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
    fetch: appFetch(app),
  });
  const client = new Client({ name: "oauth-test", version: "1.0.0" });
  await client.connect(transport);
  return client;
}

test("discovery documents advertise the configured endpoints without secrets", async (t) => {
  const { app } = await setup(t);
  const resource = await call(app, "/.well-known/oauth-protected-resource");
  assert.equal(resource.status, 200);
  assert.equal(resource.headers.get("cache-control"), "no-store");
  assert.equal(resource.headers.get("x-content-type-options"), "nosniff");
  const resourceBody = await jsonBody(resource);
  assert.equal(resourceBody.resource, BASE);
  assert.deepEqual(resourceBody.authorization_servers, [BASE]);
  assert.deepEqual(resourceBody.scopes_supported, ["message.read", "message.send"]);

  const server = await call(app, "/.well-known/oauth-authorization-server");
  assert.equal(server.status, 200);
  const body = await jsonBody(server);
  assert.equal(body.issuer, BASE);
  assert.equal(body.authorization_endpoint, `${BASE}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${BASE}/oauth/token`);
  assert.equal(body.registration_endpoint, `${BASE}/oauth/register`);
  assert.equal(body.revocation_endpoint, `${BASE}/oauth/revoke`);
  assert.deepEqual(body.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(body.response_types_supported, ["code"]);
  assert.deepEqual(body.grant_types_supported, ["authorization_code", "refresh_token"]);
  assert.deepEqual(body.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("OAuth routes are disabled with a fixed 503 when no base URL is configured", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const app = createApp(fx.deps);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
  ]) {
    const response = await call(app, path);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
  const register = await call(app, "/oauth/register", {
    method: "POST",
    body: { client_name: "x", redirect_uris: [REDIRECT] },
  });
  assert.equal(register.status, 503);
});

test("dynamic registration validates redirect URIs and metadata", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const app = createApp(fx.deps, {
    publicBaseUrl: BASE,
    oauthRegisterRateLimit: { perMinute: 600, burst: 100 },
  });

  const invalid = [
    { redirect_uris: [] },
    { redirect_uris: ["https://client.example/cb#fragment"] },
    { redirect_uris: ["http://client.example/cb"] },
    { redirect_uris: ["https://user:" + "pw" + "@client.example/cb"] },
    { redirect_uris: ["/relative"] },
    { redirect_uris: [REDIRECT, REDIRECT] },
    { redirect_uris: [REDIRECT], client_name: "" },
    { redirect_uris: [REDIRECT], client_name: "x".repeat(101) },
    { redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic" },
    { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] },
    { redirect_uris: [REDIRECT], response_types: ["token"] },
  ];
  for (const overrides of invalid) {
    const result = await registerClient(app, overrides);
    assert.equal(result.status, 400, JSON.stringify(overrides));
    assert.deepEqual(result.body, { error: "invalid_client_metadata" });
  }

  const plain = await call(app, "/oauth/register", {
    method: "POST",
    rawBody: "client_name=Test",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(plain.status, 400);

  const loopback = await registerClient(app, {
    redirect_uris: [LOCAL_REDIRECT, "http://localhost/callback"],
  });
  assert.equal(loopback.status, 201);
  assert.deepEqual(loopback.body.redirect_uris, [LOCAL_REDIRECT, "http://localhost/callback"]);
  assert.equal(loopback.body.token_endpoint_auth_method, "none");
  assert.ok(typeof loopback.body.client_id === "string");
  assert.equal(JSON.stringify(loopback.body).includes("secret"), false);
});

test("authorization requires a signed-in session and renders a strict-CSP sign-in page", async (t) => {
  const { app, clientId } = await setup(t);
  const auth = await authorization({ clientId });
  const page = await getAuthorize(app, auth.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /form-action 'self'/);
  assert.equal(csp.includes("unsafe-inline"), false);
  const html = await page.text();
  assert.match(html, /action="\/oauth\/signin"/);
  assert.match(html, /name="return_to"/);
  assert.equal(html.includes("code="), false);
  // The sign-in form carries a short-lived double-submit cookie.
  const cookies = page.headers.getSetCookie();
  assert.ok(cookieValue(cookies, "corkboard_oauth_login"));
  assert.match(cookies.join("\n"), /HttpOnly/);
  assert.match(cookies.join("\n"), /SameSite=Lax/);

  const signedIn = await getAuthorize(app, auth.url, await login(app));
  assert.equal(signedIn.status, 200);
  assert.match(await signedIn.text(), /data-oauth-consent/);
});

test("redirect URI mismatch and open redirect attempts never redirect", async (t) => {
  const { app, clientId } = await setup(t);
  const auth = await authorization({ clientId });

  for (const redirectUri of [
    "https://evil.example/callback",
    "https://client.example/other",
    "https://client.example/callback#fragment",
    "http://client.example/callback",
  ]) {
    const url = auth.url.replace(
      encodeURIComponent(REDIRECT),
      encodeURIComponent(redirectUri),
    );
    const response = await getAuthorize(app, url);
    assert.equal(response.status, 400, redirectUri);
    assert.equal(response.headers.get("location"), null);
  }

  // A registered redirect is used for a standards error response.
  const badResponseType = `${auth.url.replace("response_type=code", "response_type=token")}`;
  const errorRedirect = await getAuthorize(app, badResponseType);
  assert.equal(errorRedirect.status, 302);
  const location = new URL(errorRedirect.headers.get("location") ?? "");
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("error"), "unsupported_response_type");
  assert.equal(location.searchParams.get("state"), auth.state);
});

test("PKCE, resource, and scope errors are rejected at authorization", async (t) => {
  const { app, clientId } = await setup(t);
  const cases: Array<{ overrides: Partial<AuthorizeParams>; error: string }> = [
    { overrides: { challenge: "short" }, error: "invalid_request" },
    { overrides: { method: "plain" }, error: "invalid_request" },
    { overrides: { resource: "https://other.example" }, error: "invalid_target" },
    { overrides: { scope: "message.read project.edit" }, error: "invalid_scope" },
    { overrides: { scope: "member.manage" }, error: "invalid_scope" },
  ];
  for (const { overrides, error } of cases) {
    const auth = await authorization({ clientId, ...overrides });
    const response = await getAuthorize(app, auth.url);
    assert.equal(response.status, 302, JSON.stringify(overrides));
    const location = new URL(response.headers.get("location") ?? "");
    assert.equal(location.searchParams.get("error"), error);
  }

  // No scope parameter defaults to both supported scopes.
  const defaults = await authorization({ clientId });
  const page = await getAuthorize(app, defaults.url, await login(app));
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /value="message\.read" checked/);
  assert.match(html, /value="message\.send" checked/);
});

test("consent requires the session and CSRF header and writes nothing on failure", async (t) => {
  const setupValue = await setup(t);
  const auth = await authorization({ clientId: setupValue.clientId });
  const form = consentForm({
    clientId: setupValue.clientId,
    state: auth.state,
    challenge: auth.challenge,
  });

  const noSession = await formCall(setupValue.app, "/oauth/consent", form);
  assert.equal(noSession.status, 401);

  const noCsrf = await formCall(setupValue.app, "/oauth/consent", form, {
    cookie: cookieHeader(setupValue.cookies),
  });
  assert.equal(noCsrf.status, 403);

  const wrongCsrf = await consent(setupValue, form, { [CSRF_HEADER_NAME]: "wrong" });
  assert.equal(wrongCsrf.status, 403);

  const rows = await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes");
  assert.equal(rows.length, 0);
});

test("consent denial returns access_denied and never issues a code", async (t) => {
  const setupValue = await setup(t);
  const auth = await authorization({ clientId: setupValue.clientId });
  const form = new URLSearchParams({
    client_id: setupValue.clientId,
    redirect_uri: REDIRECT,
    state: auth.state,
    code_challenge: auth.challenge,
    code_challenge_method: "S256",
    resource: BASE,
    decision: "deny",
  });
  const response = await consent(setupValue, form);
  assert.equal(response.status, 200);
  const body = await jsonBody(response);
  const target = new URL(body.redirect_to as string);
  assert.equal(target.searchParams.get("error"), "access_denied");
  assert.equal(target.searchParams.get("state"), auth.state);
  assert.equal(target.searchParams.get("code"), null);
  assert.equal(
    (await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length,
    0,
  );
});

test("oversized registration metadata is rejected before parsing", async (t) => {
  const setupValue = await setup(t);
  const oversized = JSON.stringify({
    client_name: "x".repeat(70 * 1024),
    redirect_uris: [REDIRECT],
  });
  const response = await call(setupValue.app, "/oauth/register", {
    method: "POST",
    rawBody: oversized,
    contentType: "application/json",
  });
  assert.equal(response.status, 413);
});

test("consent cannot escalate scope or select another account's speaker or project", async (t) => {
  const setupValue = await setup(t);
  await setupValue.fx.addAccount("acct_other");
  await setupValue.fx.addSpeaker("spk_other", "acct_other");
  await setupValue.fx.addProject("proj_other", "acct_other");
  await setupValue.fx.addMembership("proj_other", "spk_other", [
    "message.read",
    "message.send",
  ]);
  const auth = await authorization({ clientId: setupValue.clientId });
  const page = await getAuthorize(setupValue.app, auth.url, setupValue.cookies);
  assert.equal(page.status, 200);
  const html = await page.text();
  const requestSignature = hiddenValue(html, "request_signature");
  assert.ok(requestSignature);

  const escalation = await consent(
    setupValue,
    consentForm({
      clientId: setupValue.clientId,
      state: auth.state,
      challenge: auth.challenge,
      requestSignature,
      scopes: ["message.read", "project.edit"],
    }),
  );
  assert.equal(escalation.status, 400);
  assert.equal((await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length, 0);

  const foreignSpeaker = await consent(
    setupValue,
    consentForm({
      clientId: setupValue.clientId,
      state: auth.state,
      challenge: auth.challenge,
      requestSignature,
      speakerId: "spk_other",
      projectId: "proj_other",
    }),
  );
  assert.equal(foreignSpeaker.status, 403);
  assert.equal((await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length, 0);

  const foreignProject = await consent(
    setupValue,
    consentForm({
      clientId: setupValue.clientId,
      state: auth.state,
      challenge: auth.challenge,
      requestSignature,
      speakerId: "spk_owner",
      projectId: "proj_other",
    }),
  );
  assert.equal(foreignProject.status, 403);
  assert.equal((await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length, 0);
});

test("consent cannot grant a scope the membership does not hold", async (t) => {
  const setupValue = await setup(t, {}, ["message.read"]);
  const auth = await authorization({ clientId: setupValue.clientId, scope: "message.read message.send" });
  const page = await getAuthorize(setupValue.app, auth.url, setupValue.cookies);
  // No candidate can grant both scopes, so the consent page is not offered.
  assert.equal(page.status, 403);

  const sendOnly = await authorization({ clientId: setupValue.clientId, scope: "message.send" });
  const denied = await getAuthorize(setupValue.app, sendOnly.url, setupValue.cookies);
  assert.equal(denied.status, 403);
  assert.equal((await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length, 0);
});

test("code exchange requires the exact client, redirect, PKCE verifier, and resource", async (t) => {
  const setupValue = await setup(t);
  const code = await obtainCode(setupValue);

  const wrongClient = await exchange(setupValue, code, { client_id: "cb_cli_unknown" });
  assert.equal(wrongClient.status, 400);
  assert.deepEqual(wrongClient.body, { error: "invalid_grant" });

  const wrongRedirect = await exchange(setupValue, code, { redirect_uri: "https://client.example/other" });
  assert.equal(wrongRedirect.status, 400);
  assert.deepEqual(wrongRedirect.body, { error: "invalid_grant" });

  const wrongVerifier = await exchange(setupValue, { code: code.code, verifier: randomBase64url(32) });
  assert.equal(wrongVerifier.status, 400);
  assert.deepEqual(wrongVerifier.body, { error: "invalid_grant" });

  const wrongResource = await exchange(setupValue, code, { resource: "https://other.example" });
  assert.equal(wrongResource.status, 400);

  const missingVerifier = await token(setupValue.app, {
    grant_type: "authorization_code",
    client_id: setupValue.clientId,
    code: code.code,
    redirect_uri: REDIRECT,
  });
  assert.equal(missingVerifier.status, 400);
  assert.deepEqual(missingVerifier.body, { error: "invalid_request" });

  const otherGrant = await token(setupValue.app, {
    grant_type: "client_credentials",
    client_id: setupValue.clientId,
  });
  assert.equal(otherGrant.status, 400);
  assert.deepEqual(otherGrant.body, { error: "unsupported_grant_type" });

  // Failed attempts above do not consume the code; the exact verifier succeeds.
  const accepted = await exchange(setupValue, code);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  assert.equal(accepted.body.token_type, "Bearer");
  assert.equal(accepted.body.expires_in, 3600);
  assert.equal(accepted.body.scope, "message.read message.send");
  assert.match(accepted.body.access_token, /^cb_oat_/);
  assert.match(accepted.body.refresh_token, /^cb_ort_/);

  const replay = await exchange(setupValue, code);
  assert.equal(replay.status, 400);
  assert.deepEqual(replay.body, { error: "invalid_grant" });
});

test("codes expire and exchange revalidates account, speaker, project, and membership", async (t) => {
  const setupValue = await setup(t);
  const start = new Date("2026-11-03T12:00:00.000Z");

  const expired = await obtainCode(setupValue);
  setupValue.fx.setNow(new Date(start.getTime() + 6 * 60 * 1000));
  assert.deepEqual((await exchange(setupValue, expired)).body, { error: "invalid_grant" });
  setupValue.fx.setNow(start);

  const suspended = await obtainCode(setupValue);
  await setupValue.fx.db.run("UPDATE accounts SET status = 'suspended' WHERE id = 'acct_owner'");
  assert.equal((await exchange(setupValue, suspended)).status, 400);
  await setupValue.fx.db.run("UPDATE accounts SET status = 'active' WHERE id = 'acct_owner'");

  const inactiveSpeaker = await obtainCode(setupValue);
  await setupValue.fx.db.run("UPDATE speakers SET status = 'inactive' WHERE id = 'spk_owner'");
  assert.equal((await exchange(setupValue, inactiveSpeaker)).status, 400);
  await setupValue.fx.db.run("UPDATE speakers SET status = 'active' WHERE id = 'spk_owner'");

  const inactiveProject = await obtainCode(setupValue);
  await setupValue.fx.db.run("UPDATE projects SET status = 'inactive' WHERE id = 'proj_1'");
  assert.equal((await exchange(setupValue, inactiveProject)).status, 400);
  await setupValue.fx.db.run("UPDATE projects SET status = 'active' WHERE id = 'proj_1'");

  const removedMembership = await obtainCode(setupValue);
  await setupValue.fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = 'proj_1' AND speaker_id = 'spk_owner'",
    [new Date().toISOString()],
  );
  assert.equal((await exchange(setupValue, removedMembership)).status, 400);
});

test("access tokens use REST and MCP with exactly the consented scopes", async (t) => {
  // Read-only consent.
  const readSetup = await setup(t);
  const readCode = await obtainCode(readSetup, { scopes: ["message.read"] });
  const readToken = (await exchange(readSetup, readCode)).body.access_token as string;

  const list = await rest(readSetup.app, "/api/v1/projects/proj_1/messages", readToken);
  assert.equal(list.status, 200);

  const send = await rest(readSetup.app, "/api/v1/projects/proj_1/messages", readToken, {
    method: "POST",
    body: {
      summary: "denied",
      type: "request",
      language: "en",
      text: "denied",
      body_digest: `sha256:${"0".repeat(64)}`,
    },
  });
  assert.equal(send.status, 403);

  const me = await rest(readSetup.app, "/api/v1/me", readToken);
  assert.equal(me.status, 200);
  const meBody = await jsonBody(me);
  assert.deepEqual(meBody.scopes, ["message.read"]);
  assert.deepEqual(meBody.projects, []);
  // OAuth tokens only hold message.* scopes, so project listing is forbidden.
  assert.equal((await rest(readSetup.app, "/api/v1/projects", readToken)).status, 403);

  // Send-only consent.
  const sendSetup = await setup(t);
  const sendCode = await obtainCode(sendSetup, { scopes: ["message.send"] });
  const sendToken = (await exchange(sendSetup, sendCode)).body.access_token as string;

  const deniedList = await rest(sendSetup.app, "/api/v1/projects/proj_1/messages", sendToken);
  assert.equal(deniedList.status, 403);

  const { createHash } = await import("node:crypto");
  const text = "hello over oauth";
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const posted = await rest(sendSetup.app, "/api/v1/projects/proj_1/messages", sendToken, {
    method: "POST",
    body: { summary: "oauth", type: "request", language: "en", text, body_digest: digest },
  });
  assert.equal(posted.status, 201);
  const postedBody = await jsonBody(posted);
  assert.equal(typeof postedBody.seq, "number");

  const client = await mcpClient(sendSetup.app, sendToken);
  try {
    const tools = (await client.listTools()) as JsonObject;
    assert.equal(tools.tools.length, 6);
    const result = (await client.callTool({
      name: "corkboard_list_messages",
      arguments: { project_id: "proj_1" },
    })) as JsonObject;
    assert.equal(result.isError, true);
    assert.match(((result.content as JsonObject[])[0]?.text as string) ?? "", /"code":"FORBIDDEN"/);
  } finally {
    await client.close();
  }
});

test("refresh rotates both tokens, and a reused refresh token revokes the family and credential", async (t) => {
  const setupValue = await setup(t);
  const code = await obtainCode(setupValue);
  const first = (await exchange(setupValue, code)).body;
  const firstAccess = first.access_token as string;
  const firstRefresh = first.refresh_token as string;

  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", firstAccess)).status, 200);

  const rotated = await refresh(setupValue, firstRefresh);
  assert.equal(rotated.status, 200);
  const secondAccess = rotated.body.access_token as string;
  const secondRefresh = rotated.body.refresh_token as string;
  assert.notEqual(secondAccess, firstAccess);
  assert.notEqual(secondRefresh, firstRefresh);
  assert.equal(rotated.body.scope, "message.read message.send");

  // Rotating the credential's verifier invalidates the old access token.
  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", firstAccess)).status, 401);
  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", secondAccess)).status, 200);

  // Reuse detection revokes the whole family and the credential.
  const reuse = await refresh(setupValue, firstRefresh);
  assert.equal(reuse.status, 400);
  assert.deepEqual(reuse.body, { error: "invalid_grant" });
  assert.equal((await refresh(setupValue, secondRefresh)).status, 400);
  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", secondAccess)).status, 401);

  const reason = await setupValue.fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = (SELECT credential_id FROM oauth_refresh_tokens LIMIT 1)",
  );
  assert.notEqual(reason?.revoked_at, null);
});

test("refresh refuses broader scopes and revoked membership", async (t) => {
  const setupValue = await setup(t);
  const code = await obtainCode(setupValue, { scopes: ["message.read"] });
  const body = (await exchange(setupValue, code)).body;
  const refreshToken = body.refresh_token as string;

  const broadened = await refresh(setupValue, refreshToken, {
    scope: "message.read message.send",
  });
  assert.equal(broadened.status, 400);
  assert.deepEqual(broadened.body, { error: "invalid_scope" });

  const sameScope = await refresh(setupValue, refreshToken, { scope: "message.read" });
  assert.equal(sameScope.status, 200);

  await setupValue.fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = 'proj_1' AND speaker_id = 'spk_owner'",
    [new Date().toISOString()],
  );
  const denied = await refresh(setupValue, sameScope.body.refresh_token as string);
  assert.equal(denied.status, 400);
  assert.deepEqual(denied.body, { error: "invalid_grant" });
});

test("revocation always answers 200 and revokes only the matching client's token", async (t) => {
  const setupValue = await setup(t);
  const other = await registerClient(setupValue.app, {
    client_name: "Other",
    redirect_uris: ["https://other.example/cb"],
  });
  assert.equal(other.status, 201);

  const code = await obtainCode(setupValue);
  const body = (await exchange(setupValue, code)).body;
  const access = body.access_token as string;
  const refreshToken = body.refresh_token as string;

  const unknown = await formCall(
    setupValue.app,
    "/oauth/revoke",
    new URLSearchParams({ token: "cb_ort_unknown", client_id: setupValue.clientId }),
  );
  assert.equal(unknown.status, 200);

  const wrongClient = await formCall(
    setupValue.app,
    "/oauth/revoke",
    new URLSearchParams({ token: refreshToken, client_id: other.body.client_id as string }),
  );
  assert.equal(wrongClient.status, 200);
  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", access)).status, 200);

  const revoked = await formCall(
    setupValue.app,
    "/oauth/revoke",
    new URLSearchParams({ token: refreshToken, client_id: setupValue.clientId }),
  );
  assert.equal(revoked.status, 200);
  assert.equal((await rest(setupValue.app, "/api/v1/projects/proj_1/messages", access)).status, 401);
  assert.equal((await refresh(setupValue, refreshToken)).status, 400);

  // A fresh consent can be revoked by presenting the access token instead.
  const secondCode = await obtainCode(setupValue);
  const second = (await exchange(setupValue, secondCode)).body;
  const revokeAccess = await formCall(
    setupValue.app,
    "/oauth/revoke",
    new URLSearchParams({
      token: second.access_token as string,
      client_id: setupValue.clientId,
    }),
  );
  assert.equal(revokeAccess.status, 200);
  assert.equal(
    (await rest(setupValue.app, "/api/v1/projects/proj_1/messages", second.access_token as string)).status,
    401,
  );
  assert.equal((await refresh(setupValue, second.refresh_token as string)).status, 400);
});

test("registration and token exchange are rate limited with an injected clock", async (t) => {
  let now = 0;
  const setupValue = await setup(t, {
    oauthRegisterRateLimit: { perMinute: 1, burst: 2 },
    oauthTokenRateLimit: { perMinute: 1, burst: 1 },
    oauthRateLimitNow: () => now,
  });

  const first = await registerClient(setupValue.app);
  assert.equal(first.status, 201);
  const limited = await registerClient(setupValue.app);
  assert.equal(limited.status, 429);

  const code = await obtainCode(setupValue);
  const firstToken = await exchange(setupValue, code);
  assert.equal(firstToken.status, 200);
  const code2 = await obtainCode(setupValue);
  const limitedToken = await exchange(setupValue, code2);
  assert.equal(limitedToken.status, 429);

  now += 61_000;
  const afterRefill = await registerClient(setupValue.app, {
    redirect_uris: ["https://client.example/after"],
  });
  assert.equal(afterRefill.status, 201);
});

test("codes, tokens, and CSRF values are absent from logs and stored only as verifiers", async (t) => {
  const logs: string[] = [];
  const setupValue = await setup(t, {
    logger: (entry) => logs.push(JSON.stringify(entry)),
  });
  const code = await obtainCode(setupValue);
  const body = (await exchange(setupValue, code)).body;
  const refreshResult = await refresh(setupValue, body.refresh_token as string);
  assert.equal(refreshResult.status, 200);

  const access = body.access_token as string;
  const refreshToken = body.refresh_token as string;
  const newAccess = refreshResult.body.access_token as string;
  const newRefresh = refreshResult.body.refresh_token as string;

  const logText = logs.join("\n");
  for (const secret of [code.code, access, refreshToken, newAccess, newRefresh, code.verifier]) {
    assert.equal(logText.includes(secret), false, "a secret reached the request log");
  }

  const codeRow = await setupValue.fx.db.first<Record<string, unknown>>(
    "SELECT * FROM oauth_authorization_codes",
  );
  assert.ok(codeRow);
  assert.equal(String(codeRow.code_prefix), code.code.slice(0, 12));
  assert.notEqual(String(codeRow.code_verifier_hash), code.code);
  assert.equal(JSON.stringify(codeRow).includes(code.code), false);
  assert.equal(JSON.stringify(codeRow).includes(code.verifier), false);
  assert.equal(JSON.stringify(codeRow).includes(await s256Challenge(code.verifier)), false);

  const refreshRows = await setupValue.fx.db.all<Record<string, unknown>>(
    "SELECT * FROM oauth_refresh_tokens ORDER BY created_at ASC",
  );
  assert.ok(refreshRows.length >= 2);
  assert.equal(JSON.stringify(refreshRows).includes(refreshToken), false);
  assert.equal(JSON.stringify(refreshRows).includes(newRefresh), false);

  const credentials = await setupValue.fx.db.all<Record<string, unknown>>(
    "SELECT * FROM credentials WHERE id LIKE 'cred_oat_%'",
  );
  assert.equal(credentials.length, 1);
  assert.equal(JSON.stringify(credentials).includes(access), false);
  assert.equal(JSON.stringify(credentials).includes(newAccess), false);
});

test("consent HTML escapes project and speaker names and sets a strict CSP", async (t) => {
  const setupValue = await setup(t);
  const hostile = `<script>alert("x")</script><img src=x onerror=alert(1)>`;
  await setupValue.fx.db.run("UPDATE projects SET title = ? WHERE id = 'proj_1'", [hostile]);
  await setupValue.fx.db.run("UPDATE speakers SET display_name = ? WHERE id = 'spk_owner'", [
    hostile,
  ]);

  const auth = await authorization({ clientId: setupValue.clientId });
  const page = await getAuthorize(setupValue.app, auth.url, setupValue.cookies);
  assert.equal(page.status, 200);
  const csp = page.headers.get("content-security-policy") ?? "";
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);
  assert.equal(csp.includes("unsafe-inline"), false);
  const html = await page.text();
  assert.equal(html.includes(hostile), false);
  assert.equal(html.includes("<script>alert"), false);
  assert.equal(html.includes("<img src=x"), false);
  assert.match(html, /&lt;script&gt;alert/);
  assert.match(html, /&lt;img src=x/);
  assert.match(html, /src="\/oauth\/client\.js"/);
  // The only inline-looking script tag is the external client script.
  const scriptTags = [...html.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scriptTags.length, 1);
  assert.match(scriptTags[0] ?? "", /src="\/oauth\/client\.js"/);
});

test("consent requires a signed requested scope and rejects an added scope", async (t) => {
  const setupValue = await setup(t);
  const auth = await authorization({ clientId: setupValue.clientId, scope: "message.read" });
  const page = await getAuthorize(setupValue.app, auth.url, setupValue.cookies);
  assert.equal(page.status, 200);
  const html = await page.text();
  const signature = hiddenValue(html, "request_signature");
  assert.ok(signature);
  assert.equal(hiddenValue(html, "requested_scope"), "message.read");

  const fields = {
    client_id: setupValue.clientId,
    redirect_uri: REDIRECT,
    state: auth.state,
    code_challenge: auth.challenge,
    code_challenge_method: "S256",
    resource: BASE,
    speaker_id: "spk_owner",
    project_id: "proj_1",
    decision: "allow",
  };

  // No requested_scope at all: cannot infer the request from client input.
  const missing = new URLSearchParams(fields);
  missing.set("request_signature", signature);
  missing.append("scope", "message.read");
  missing.append("scope", "message.send");
  assert.equal((await consent(setupValue, missing)).status, 400);

  // Forged requested_scope without a matching signature.
  const forged = new URLSearchParams(fields);
  forged.set("requested_scope", "message.read message.send");
  forged.set("request_signature", signature);
  forged.append("scope", "message.read");
  forged.append("scope", "message.send");
  assert.equal((await consent(setupValue, forged)).status, 400);

  // A wholly fabricated signature over the broadened set is also rejected.
  const fabricated = new URLSearchParams(fields);
  fabricated.set("requested_scope", "message.read message.send");
  fabricated.set("request_signature", "0".repeat(64));
  fabricated.append("scope", "message.read");
  fabricated.append("scope", "message.send");
  assert.equal((await consent(setupValue, fabricated)).status, 400);

  assert.equal(
    (await setupValue.fx.db.all("SELECT id FROM oauth_authorization_codes")).length,
    0,
  );
});

test("a code-only client receives and can use no refresh token", async (t) => {
  const setupValue = await setup(t);
  const codeOnly = await registerClient(setupValue.app, {
    client_name: "Code only",
    grant_types: ["authorization_code"],
  });
  assert.equal(codeOnly.status, 201);
  const clientId = codeOnly.body.client_id as string;

  const code = await obtainCode(setupValue, { clientId });
  const exchanged = await exchange(setupValue, code, { client_id: clientId });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  assert.equal("refresh_token" in exchanged.body, false);

  const attempted = await token(setupValue.app, {
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: "cb_ort_unknown",
  });
  assert.equal(attempted.status, 400);
  assert.deepEqual(attempted.body, { error: "unauthorized_client" });
});

test("an authorization code dies with the session that issued it", async (t) => {
  const setupValue = await setup(t);
  const code = await obtainCode(setupValue);

  const logout = await call(setupValue.app, "/api/v1/session", {
    method: "DELETE",
    headers: {
      cookie: cookieHeader(setupValue.cookies),
      [CSRF_HEADER_NAME]: cookieValue(setupValue.cookies, CSRF_COOKIE_NAME) ?? "",
    },
  });
  assert.equal(logout.status, 204);
  assert.equal((await exchange(setupValue, code)).status, 400);
  assert.deepEqual((await exchange(setupValue, code)).body, { error: "invalid_grant" });
});

test("sign-in return_to rejects control characters without creating a session", async (t) => {
  const setupValue = await setup(t);
  const auth = await authorization({ clientId: setupValue.clientId });
  const page = await getAuthorize(setupValue.app, auth.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  const loginCsrf = hiddenValue(html, "login_csrf");
  assert.ok(loginCsrf);
  const loginCookies = cookieHeader(page.headers.getSetCookie());
  const sessionsBefore = (
    await setupValue.fx.db.all("SELECT id FROM sessions")
  ).length;

  const response = await formCall(
    setupValue.app,
    "/oauth/signin",
    new URLSearchParams({
      return_to: "/oauth/authorize?x=\r\nSet-Cookie: cb_sess_evil",
      login_csrf: loginCsrf,
      email: EMAIL,
      password: PASSWORD,
    }),
    { cookie: loginCookies },
  );
  assert.equal(response.status, 400);
  assert.notEqual(response.status, 503);
  assert.equal(
    (await setupValue.fx.db.all("SELECT id FROM sessions")).length,
    sessionsBefore,
  );
});

test("the token endpoint has a global bucket that rotating client_id cannot bypass", async (t) => {
  let now = 0;
  const setupValue = await setup(t, {
    oauthTokenRateLimit: { perMinute: 600, burst: 100 },
    oauthTokenGlobalRateLimit: { perMinute: 1, burst: 2 },
    oauthRateLimitNow: () => now,
  });

  const attempt = (clientId: string) =>
    token(setupValue.app, {
      grant_type: "authorization_code",
      client_id: clientId,
      code: "cb_oac_unknown",
      redirect_uri: REDIRECT,
      code_verifier: randomBase64url(32),
    });

  assert.equal((await attempt("cb_cli_rotating_1")).status, 400);
  assert.equal((await attempt("cb_cli_rotating_2")).status, 400);
  assert.equal((await attempt("cb_cli_rotating_3")).status, 429);

  now += 61_000;
  assert.equal((await attempt("cb_cli_rotating_4")).status, 400);
});

test("revocation ignores a speaker token without revoking it", async (t) => {
  const setupValue = await setup(t);
  const credential = await setupValue.fx.addCredential({
    speakerId: "spk_owner",
    scopes: ["message.read"],
    autoGrantMemberships: true,
  });

  const revoked = await formCall(
    setupValue.app,
    "/oauth/revoke",
    new URLSearchParams({ token: credential.token, client_id: setupValue.clientId }),
  );
  assert.equal(revoked.status, 200);
  assert.equal(
    (await rest(setupValue.app, "/api/v1/projects/proj_1/messages", credential.token)).status,
    200,
  );
});

test("OAuth routes record fixed metric labels", async (t) => {
  const { MetricsRegistry } = await import("../../src/app/metrics.ts");
  const metrics = new MetricsRegistry();
  const setupValue = await setup(t, { metrics });

  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/client.js",
  ]) {
    assert.ok((await call(setupValue.app, path)).status > 0);
  }
  for (const path of [
    "/oauth/register",
    "/oauth/signin",
    "/oauth/consent",
    "/oauth/token",
    "/oauth/revoke",
  ]) {
    assert.ok((await formCall(setupValue.app, path, new URLSearchParams())).status > 0);
  }
  assert.ok((await call(setupValue.app, "/oauth/authorize")).status > 0);

  const labels = new Set(metrics.snapshot().routes.map((entry) => entry.route));
  for (const label of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/signin",
    "/oauth/consent",
    "/oauth/token",
    "/oauth/revoke",
    "/oauth/client.js",
  ]) {
    assert.ok(labels.has(label as never), `missing metric label ${label}`);
  }
});

test("redirect URI count and length boundaries are enforced", async (t) => {
  const setupValue = await setup(t);
  const uriAt = (length: number): string => {
    const prefix = "https://client.example/";
    return prefix + "a".repeat(length - prefix.length);
  };

  const ten = Array.from({ length: 10 }, (_, index) => uriAt(100 + index));
  assert.equal((await registerClient(setupValue.app, { redirect_uris: ten })).status, 201);

  const eleven = Array.from({ length: 11 }, (_, index) => uriAt(100 + index));
  assert.equal((await registerClient(setupValue.app, { redirect_uris: eleven })).status, 400);

  assert.equal(uriAt(2048).length, 2048);
  assert.equal(
    (await registerClient(setupValue.app, { redirect_uris: [uriAt(2048)] })).status,
    201,
  );
  assert.equal(
    (await registerClient(setupValue.app, { redirect_uris: [uriAt(2049)] })).status,
    400,
  );
});

test("OAuth endpoints enforce their content types", async (t) => {
  const setupValue = await setup(t);
  const auth = await authorization({ clientId: setupValue.clientId });
  const form = consentForm({
    clientId: setupValue.clientId,
    state: auth.state,
    challenge: auth.challenge,
  });

  const consentJson = await call(setupValue.app, "/oauth/consent", {
    method: "POST",
    body: Object.fromEntries(form),
    headers: {
      cookie: cookieHeader(setupValue.cookies),
      [CSRF_HEADER_NAME]: cookieValue(setupValue.cookies, CSRF_COOKIE_NAME) ?? "",
    },
  });
  assert.equal(consentJson.status, 400);

  const tokenJson = await call(setupValue.app, "/oauth/token", {
    method: "POST",
    body: { grant_type: "authorization_code" },
  });
  assert.equal(tokenJson.status, 400);
  assert.deepEqual(await jsonBody(tokenJson), { error: "invalid_request" });

  const revokeJson = await call(setupValue.app, "/oauth/revoke", {
    method: "POST",
    body: { token: "x", client_id: "y" },
  });
  assert.equal(revokeJson.status, 400);
  assert.deepEqual(await jsonBody(revokeJson), { error: "invalid_request" });

  const registerForm = await call(setupValue.app, "/oauth/register", {
    method: "POST",
    rawBody: "client_name=Test",
    contentType: "application/x-www-form-urlencoded",
  });
  assert.equal(registerForm.status, 400);
  assert.deepEqual(await jsonBody(registerForm), { error: "invalid_client_metadata" });
});
