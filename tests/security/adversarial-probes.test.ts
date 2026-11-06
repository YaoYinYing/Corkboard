// TODO 352 adversarial probes. Every probe drives the real platform-neutral
// `createApp` router in-process; no route, service, or authorization path is
// mocked. The matrix and its known limits are documented in
// docs/threat-model.md ("Adversarial probe matrix").
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createApp, type RequestLogEntry } from "../../src/app/handlers.ts";
import { WEB_LOGIN_CSRF_COOKIE } from "../../src/app/cookies.ts";
import { hashPassword } from "../../src/auth/password.ts";
import { s256Challenge } from "../../src/service/oauth.ts";
import {
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../../src/service/sessions.ts";
import {
  ALL_SCOPES,
  createServiceFixture,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;
type HeaderPairs = [string, string][];

const FORM = "application/x-www-form-urlencoded";
const OAUTH_BASE = "https://corkboard.test";
const OAUTH_REDIRECT = "https://client.example/cb";

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  headerPairs?: HeaderPairs;
  body?: string;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  for (const [name, value] of options.headerPairs ?? []) headers.append(name, value);
  if (options.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function payload(text: string, overrides: Record<string, unknown> = {}): JsonObject {
  return {
    summary: text,
    type: "note",
    language: "en",
    text,
    body_digest: digestOf(text),
    ...overrides,
  };
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

function formBody(fields: Record<string, string | readonly string[]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") params.set(name, value);
    else for (const item of value) params.append(name, item);
  }
  return params.toString();
}

interface Actor {
  accountId: string;
  speakerId: string;
  token: string;
  credentialId: string;
}

async function addActor(fx: ServiceFixture, name: string): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token, credentialId } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, token, credentialId };
}

async function addPasswordActor(
  fx: ServiceFixture,
  name: string,
  password: string,
): Promise<Actor> {
  await fx.db.run(
    `INSERT INTO accounts (id, email, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', ?)`,
    [
      `acct_${name}`,
      `${name}@example.test`,
      await hashPassword(password),
      "2026-11-03T12:00:00.000Z",
    ],
  );
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token, credentialId } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, token, credentialId };
}

async function addProject(
  fx: ServiceFixture,
  projectId: string,
  owner: Actor,
  members: readonly Actor[],
): Promise<void> {
  await fx.addProject(projectId, owner.accountId);
  for (const member of members) await fx.addMembership(projectId, member.speakerId);
}

async function withFixture(t: {
  after(fn: () => void): void;
}): Promise<ServiceFixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return fx;
}

function appFor(
  fx: ServiceFixture,
  options: { publicBaseUrl?: string; logger?: (entry: RequestLogEntry) => void } = {},
): App {
  return createApp(fx.deps, {
    loginRateLimit: { perMinute: 600, burst: 100 },
    ...(options.publicBaseUrl === undefined ? {} : { publicBaseUrl: options.publicBaseUrl }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
}

function bearerSend(
  app: App,
  token: string,
  projectId: string,
  key: string,
  text: string,
  overrides: Record<string, unknown> = {},
): Promise<Response> {
  return call(app, `/api/v1/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    token,
    headers: { "idempotency-key": key },
    body: JSON.stringify(payload(text, overrides)),
  });
}

interface SessionAuth {
  cookie: string;
  csrf: string;
}

async function loginSession(
  app: App,
  email: string,
  password: string,
): Promise<SessionAuth> {
  const response = await call(app, "/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(response.status, 200);
  const cookies = response.headers.getSetCookie();
  const session = cookieValue(cookies, SESSION_COOKIE_NAME);
  const csrf = cookieValue(cookies, CSRF_COOKIE_NAME);
  assert.ok(session, "session cookie");
  assert.ok(csrf, "csrf cookie");
  return {
    cookie: `${SESSION_COOKIE_NAME}=${session}; ${CSRF_COOKIE_NAME}=${csrf}`,
    csrf,
  };
}

function webPost(
  app: App,
  path: string,
  auth: SessionAuth,
  fields: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  return call(app, path, {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "content-type": FORM,
      ...extraHeaders,
    },
    body: formBody(fields),
  });
}

function webMain(html: string): string {
  const match = /<main[^>]*>([\s\S]*?)<\/main>/.exec(html);
  assert.ok(match, "main content");
  return match[1] ?? "";
}

async function rawPost(
  app: App,
  body: unknown,
  options: { token?: string; sessionId?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    ...(options.headers ?? {}),
  };
  if (options.token !== undefined) headers["authorization"] = `Bearer ${options.token}`;
  if (options.sessionId !== undefined) headers["mcp-session-id"] = options.sessionId;
  return call(app, "/mcp", { method: "POST", headers, body: JSON.stringify(body) });
}

async function mcpSession(app: App, token: string): Promise<string> {
  const response = await rawPost(
    app,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "adversarial-probe", version: "1.0.0" },
      },
    },
    { token },
  );
  assert.equal(response.status, 200);
  const sessionId = response.headers.get("mcp-session-id");
  assert.ok(sessionId);
  return sessionId;
}

async function rawTool(
  app: App,
  token: string,
  sessionId: string,
  id: number,
  name: string,
  args: JsonObject,
): Promise<JsonObject> {
  const response = await rawPost(
    app,
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    { token, sessionId },
  );
  return jsonBody(response);
}

function toolErrorCode(result: JsonObject): string {
  const toolResult = result["result"] as JsonObject;
  assert.equal(toolResult["isError"], true);
  const text = toolResult["content"]?.[0]?.text as string;
  const parsed = JSON.parse(text) as JsonObject;
  return parsed["error"]?.["code"] as string;
}

// Strict zod schemas are rejected by the MCP SDK itself, so the error text is
// the SDK's validation message rather than this service's JSON code envelope.
function assertToolSchemaRejection(result: JsonObject): void {
  const toolResult = result["result"] as JsonObject;
  assert.equal(toolResult["isError"], true);
  const text = toolResult["content"]?.[0]?.text as string;
  assert.match(text, /MCP error|validation|unrecognized|invalid/i);
}

function parseHidden(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  const pattern = /<input type="hidden" name="([^"]+)" value="([^"]*)">/g;
  for (const match of html.matchAll(pattern)) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) fields[name] = value;
  }
  return fields;
}

async function registerOAuthClient(app: App): Promise<string> {
  const response = await call(app, "/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Probe client",
      redirect_uris: [OAUTH_REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  });
  assert.equal(response.status, 201);
  return (await jsonBody(response))["client_id"] as string;
}

// Full consent flow with adversarial extra identity fields in the form. The
// issued access token's /me identity is the selected owned speaker/account.
async function oauthConsentWithSpoofedFields(
  app: App,
  auth: SessionAuth,
  clientId: string,
  speakerId: string,
  projectId: string,
): Promise<string> {
  const verifier =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const challenge = await s256Challenge(verifier);
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: OAUTH_REDIRECT,
    state: "probe-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: OAUTH_BASE,
    scope: "message.read",
  });
  const page = await call(app, `/oauth/authorize?${query.toString()}`, {
    headers: { cookie: auth.cookie },
  });
  assert.equal(page.status, 200);
  const hidden = parseHidden(await page.text());
  assert.ok(hidden["request_signature"], "signed consent request");

  const consent = await call(app, "/oauth/consent", {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      "x-csrf-token": auth.csrf,
      "content-type": FORM,
    },
    body: formBody({
      ...hidden,
      speaker_id: speakerId,
      project_id: projectId,
      decision: "allow",
      scope: "message.read",
      // Must all be ignored; only the session and stored ownership decide.
      account_id: "acct_evil",
      sender: "spk_evil",
      sender_id: "spk_evil",
      created_at: "1999-01-01T00:00:00.000Z",
      received_at: "1999-01-01T00:00:00.000Z",
      committed_at: "1999-01-01T00:00:00.000Z",
      seq: "999",
    }),
  });
  assert.equal(consent.status, 200);
  const redirectTo = (await jsonBody(consent))["redirect_to"] as string;
  const code = new URL(redirectTo).searchParams.get("code");
  assert.ok(code, "authorization code");

  const tokenResponse = await call(app, "/oauth/token", {
    method: "POST",
    headers: { "content-type": FORM },
    body: formBody({
      grant_type: "authorization_code",
      code,
      redirect_uri: OAUTH_REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const accessToken = (await jsonBody(tokenResponse))["access_token"] as string;
  assert.ok(accessToken?.startsWith("cb_oat_"));
  return accessToken;
}

// ---------------------------------------------------------------------------
// JWT clause: no application JWT auth path exists in this service.
// ---------------------------------------------------------------------------

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("no application JWT auth path exists; JWT-shaped and alg:none secrets are invalid credentials", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const jwtTokens = [
    // alg:none, admin and speaker claims.
    "eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.eyJzdWIiOiJzcGtfYWxpY2UiLCJhY2NvdW50X2lkIjoiYWNjdF9hbGljZSIsInJvbGUiOiJhZG1pbiIsInNjb3BlcyI6WyJwcm9qZWN0LnJlYWQiXX0.",
    // Typical HS256-shaped token with no verifier anywhere in the service.
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzcGtfYWxpY2UiLCJleHAiOjQxMDI0NDQ4MDB9.c2lnbmF0dXJlLXBsYWNlaG9sZGVy",
  ];

  for (const token of jwtTokens) {
    const me = await call(app, "/api/v1/me", { token });
    assert.equal(me.status, 401);
    assert.equal((await jsonBody(me))["error"]?.["code"], "UNAUTHENTICATED");

    const list = await call(app, "/api/v1/projects", { token });
    assert.equal(list.status, 401);

    const send = await bearerSend(app, token, "proj_1", "jwt-key", "jwt should not send");
    assert.equal(send.status, 401);

    const mcp = await rawPost(
      app,
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "jwt-probe", version: "1" } } },
      { token },
    );
    assert.equal(mcp.status, 401);

    const text = await (await call(app, "/api/v1/me", { token })).text();
    assert.equal(text.includes(token), false);
  }

  // A JWT-shaped session cookie is not a session either.
  const cookieResponse = await call(app, "/api/v1/session", {
    headers: { cookie: `${SESSION_COOKIE_NAME}=${jwtTokens[0]}` },
  });
  assert.equal(cookieResponse.status, 401);

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);

  // The scan is deliberately scoped: application source must not import or use a
  // JWT implementation, and package.json must not declare a direct JWT dependency.
  // `jose` is a transitive dependency of the MCP SDK, never imported by src/ or
  // loaded by application auth code (the SDK's optional client auth-extensions
  // module may import it); the lockfile assertion pins that reachability instead
  // of pretending it is absent.
  const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
  const packageJson = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as JsonObject;
  const dependencyNames = [
    ...Object.keys(packageJson["dependencies"] ?? {}),
    ...Object.keys(packageJson["devDependencies"] ?? {}),
  ];
  assert.equal(
    dependencyNames.some((name) => /jwt|jsonwebtoken|jose/i.test(name)),
    false,
    "package.json declares no direct JWT dependency",
  );
  for (const file of sourceFiles(join(repoRoot, "src"))) {
    const source = readFileSync(file, "utf8");
    assert.equal(
      /\b(jwt|jsonwebtoken|jose)\b/i.test(source),
      false,
      `JWT import/use in ${file}`,
    );
  }

  // Honest transitive fact, pinned: jose exists only because the MCP SDK requests
  // it. No other installed package declares it, and application auth never loads it.
  const lockfile = JSON.parse(
    readFileSync(join(repoRoot, "package-lock.json"), "utf8"),
  ) as JsonObject;
  const packages = (lockfile["packages"] ?? {}) as Record<string, JsonObject>;
  assert.ok(packages["node_modules/jose"], "transitive jose package is present");
  const joseRequesters = Object.entries(packages)
    .filter(([, pkg]) => {
      const declared = {
        ...(pkg["dependencies"] ?? {}),
        ...(pkg["optionalDependencies"] ?? {}),
        ...(pkg["peerDependencies"] ?? {}),
      };
      return Object.prototype.hasOwnProperty.call(declared, "jose");
    })
    .map(([path]) => path);
  assert.deepEqual(joseRequesters, ["node_modules/@modelcontextprotocol/sdk"]);
});

// ---------------------------------------------------------------------------
// Object-level access control
// ---------------------------------------------------------------------------

test("foreign and unknown project IDs are the same not-found across every bearer route", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_alice", alice, [alice]);
  await addProject(fx, "proj_bob", bob, [bob]);
  // Active membership without the explicit credential grant: FORBIDDEN, not
  // an existence leak to a non-member.
  await fx.addProject("proj_no_grant", alice.accountId);
  await fx.addMembership("proj_no_grant", alice.speakerId, ALL_SCOPES, {
    grantExistingCredentials: false,
  });

  const routes = (projectId: string): Array<[string, CallOptions]> => [
    [`/api/v1/projects/${projectId}`, { token: alice.token }],
    [`/api/v1/projects/${projectId}/stats`, { token: alice.token }],
    [`/api/v1/projects/${projectId}/messages`, { token: alice.token }],
    [
      `/api/v1/projects/${projectId}/messages`,
      { method: "POST", token: alice.token, headers: { "idempotency-key": "probe" }, body: JSON.stringify(payload("probe")) },
    ],
    [`/api/v1/projects/${projectId}/messages/msg_missing`, { token: alice.token }],
    [`/api/v1/projects/${projectId}/messages/msg_missing/body`, { token: alice.token }],
    [`/api/v1/projects/${projectId}/messages/msg_missing/read`, { method: "POST", token: alice.token }],
    [`/api/v1/projects/${projectId}/messages/msg_missing/expire`, { method: "POST", token: alice.token }],
  ];

  for (const projectId of ["proj_missing", "proj_bob"]) {
    for (const [path, options] of routes(projectId)) {
      const response = await call(app, path, options);
      assert.equal(response.status, 404, `${projectId} ${path}`);
      const body = await jsonBody(response);
      assert.equal(body["error"]?.["code"], "NOT_FOUND", `${projectId} ${path}`);
      assert.equal(body["error"]?.["message"], "Not found");
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.deepEqual(Object.keys(body["error"]).sort(), ["code", "message", "request_id"]);
    }
  }

  // The project list never reveals the foreign project.
  const list = await call(app, "/api/v1/projects", { token: alice.token });
  assert.equal(list.status, 200);
  assert.equal(JSON.stringify(await jsonBody(list)).includes("proj_bob"), false);

  // A member whose credential has no grant is the documented FORBIDDEN.
  const noGrant = await call(app, "/api/v1/projects/proj_no_grant", { token: alice.token });
  assert.equal(noGrant.status, 403);
  assert.equal((await jsonBody(noGrant))["error"]?.["code"], "FORBIDDEN");

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
});

test("foreign and unknown message, receipt and body references never cross project ids", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  await addProject(fx, "proj_2", bob, [bob, alice]);

  const one = await jsonBody(await bearerSend(app, alice.token, "proj_1", "one", "project one"));
  const two = await jsonBody(await bearerSend(app, bob.token, "proj_2", "two", "project two"));

  const oneId = one["message_id"] as string;
  const twoId = two["message_id"] as string;
  const foreignPairs: Array<{ projectId: string; messageId: string; token: string }> = [
    { projectId: "proj_2", messageId: oneId, token: bob.token },
    { projectId: "proj_1", messageId: twoId, token: alice.token },
    { projectId: "proj_2", messageId: "msg_missing", token: bob.token },
    { projectId: "proj_1", messageId: "msg_missing", token: alice.token },
  ];
  for (const { projectId, messageId, token } of foreignPairs) {
    for (const suffix of ["", "/body"]) {
      const response = await call(
        app,
        `/api/v1/projects/${projectId}/messages/${messageId}${suffix}`,
        { token },
      );
      assert.equal(response.status, 404);
      assert.equal((await jsonBody(response))["error"]?.["code"], "NOT_FOUND");
    }
    for (const suffix of ["read", "expire"]) {
      const response = await call(
        app,
        `/api/v1/projects/${projectId}/messages/${messageId}/${suffix}`,
        { method: "POST", token },
      );
      assert.equal(response.status, 404);
    }
  }

  // A receipt is addressed only through its message and caller; a foreign
  // message id creates no receipt and exposes no read_by entry.
  const missing = await call(app, `/api/v1/projects/proj_2/messages/${oneId}/read`, {
    method: "POST",
    token: alice.token,
  });
  assert.equal(missing.status, 404);

  const read = await call(app, `/api/v1/projects/proj_1/messages/${oneId}/read`, {
    method: "POST",
    token: bob.token,
  });
  assert.equal(read.status, 200);
  const detail = await jsonBody(
    await call(app, `/api/v1/projects/proj_1/messages/${oneId}`, { token: alice.token }),
  );
  assert.deepEqual(
    detail["read_by"].map((entry: JsonObject) => entry["speaker_id"]),
    [bob.speakerId],
  );
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 1);
});

test("credential, membership and audit identifiers are owner-scoped without a read oracle", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addPasswordActor(fx, "alice", "alice password");
  const bob = await addPasswordActor(fx, "bob", "bob password");
  await addProject(fx, "proj_alice", alice, [alice]);
  await addProject(fx, "proj_bob", bob, [bob]);
  const auth = await loginSession(app, "alice@example.test", "alice password");

  // Unknown and foreign speaker inventories are the same 404 body.
  const unknownSpeaker = await call(app, "/speakers/spk_missing/credentials", {
    headers: { cookie: auth.cookie },
  });
  const foreignSpeaker = await call(app, `/speakers/${bob.speakerId}/credentials`, {
    headers: { cookie: auth.cookie },
  });
  assert.equal(unknownSpeaker.status, 404);
  assert.equal(foreignSpeaker.status, 404);
  assert.equal(webMain(await unknownSpeaker.text()), webMain(await foreignSpeaker.text()));

  // Foreign/unknown credential revoke and grant removal change nothing.
  for (const credentialId of [bob.credentialId, "cred_missing"]) {
    const revoke = await webPost(
      app,
      `/speakers/${alice.speakerId}/credentials/${credentialId}/revoke`,
      auth,
      { csrf_token: auth.csrf },
    );
    assert.equal(revoke.status, 404);
    const remove = await webPost(
      app,
      `/speakers/${alice.speakerId}/credentials/${credentialId}/grants/remove`,
      auth,
      { csrf_token: auth.csrf, project_id: "proj_bob" },
    );
    assert.equal(remove.status, 404);
  }
  const bobCredential = await fx.db.first<{ revoked_at: string | null }>(
    "SELECT revoked_at FROM credentials WHERE id = ?",
    [bob.credentialId],
  );
  assert.equal(bobCredential?.revoked_at, null);

  // A foreign project cannot be granted even to an owned credential.
  const grant = await webPost(
    app,
    `/speakers/${alice.speakerId}/credentials/${alice.credentialId}/grants`,
    auth,
    { csrf_token: auth.csrf, project_id: "proj_bob" },
  );
  assert.equal(grant.status, 404);
  assert.equal(
    (
      await fx.db.first(
        "SELECT 1 AS present FROM credential_project_grants WHERE credential_id = ? AND project_id = ?",
        [alice.credentialId, "proj_bob"],
      )
    ),
    undefined,
  );

  // Membership ids: unknown removal is 404; a foreign speaker cannot be added.
  const remove = await webPost(
    app,
    "/projects/proj_alice/members/spk_missing/remove",
    auth,
    { csrf_token: auth.csrf },
  );
  assert.equal(remove.status, 404);
  const add = await webPost(app, "/projects/proj_alice/members", auth, {
    csrf_token: auth.csrf,
    speaker_id: bob.speakerId,
    scope: "message.read",
  });
  assert.equal(add.status, 400);
  assert.equal(
    (
      await fx.db.first("SELECT 1 AS present FROM project_memberships WHERE project_id = ? AND speaker_id = ?", [
        "proj_alice",
        bob.speakerId,
      ])
    ),
    undefined,
  );

  // There is no audit-object read route, and another account's audit event is
  // not rendered by the authorized overview.
  await fx.db.run(
    `INSERT INTO audit_events (id, actor_account_id, operation, outcome, created_at)
     VALUES ('evt_bob', ?, 'session.login', 'success', ?)`,
    [bob.accountId, fx.deps.now().toISOString()],
  );
  const auditObject = await call(app, "/api/v1/audit/evt_bob", { headers: { cookie: auth.cookie } });
  assert.equal(auditObject.status, 404);
  const overview = await call(app, "/overview", { headers: { cookie: auth.cookie } });
  assert.equal(overview.status, 200);
  assert.equal((await overview.text()).includes("evt_bob"), false);
});

// ---------------------------------------------------------------------------
// Idempotency ownership
// ---------------------------------------------------------------------------

test("idempotency keys never replay across speakers or projects, and a tampered row fails closed", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  await addProject(fx, "proj_2", alice, [alice, bob]);

  const a = await jsonBody(await bearerSend(app, alice.token, "proj_1", "shared", "same board"));
  const b = await jsonBody(await bearerSend(app, bob.token, "proj_1", "shared", "same board"));
  const c = await jsonBody(await bearerSend(app, alice.token, "proj_2", "shared", "same board"));
  assert.equal(new Set([a["message_id"], b["message_id"], c["message_id"]]).size, 3);
  assert.equal(JSON.stringify(b).includes(a["message_id"] as string), false);
  assert.equal(JSON.stringify(c).includes(a["message_id"] as string), false);

  // Same key + same payload replays; different payload conflicts.
  const replay = await bearerSend(app, alice.token, "proj_1", "shared", "same board");
  assert.equal(replay.status, 200);
  assert.equal((await jsonBody(replay))["message_id"], a["message_id"]);
  const conflict = await bearerSend(app, alice.token, "proj_1", "shared", "different board");
  assert.equal(conflict.status, 409);
  assert.equal((await jsonBody(conflict))["error"]?.["code"], "CONFLICT");

  const before = (await fx.db.all("SELECT id FROM messages")).length;
  // Defense in depth for server-side corruption: the idempotency row is not
  // writable through the API, but a row repointed at another speaker's message
  // must not replay that message's metadata or resume its row.
  await fx.db.run(
    "UPDATE idempotency_keys SET message_id = ? WHERE speaker_id = ? AND project_id = ? AND key = ?",
    [b["message_id"], alice.speakerId, "proj_1", "shared"],
  );
  const tampered = await bearerSend(app, alice.token, "proj_1", "shared", "same board");
  assert.equal(tampered.status, 404);
  const tamperedBody = await jsonBody(tampered);
  assert.equal(tamperedBody["error"]?.["code"], "NOT_FOUND");
  assert.equal(JSON.stringify(tamperedBody).includes(b["message_id"] as string), false);
  assert.equal(JSON.stringify(tamperedBody).includes("spk_bob"), false);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, before);
});

// ---------------------------------------------------------------------------
// Time-of-check windows
// ---------------------------------------------------------------------------

test("a credential revoked after authentication but before publication fails closed", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const base = fx.deps.blobs;
  let revoked = false;
  fx.deps.blobs = {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      await base.put(key, bytes);
      if (!revoked) {
        revoked = true;
        await fx.db.run("UPDATE credentials SET revoked_at = ? WHERE id = ?", [
          fx.deps.now().toISOString(),
          alice.credentialId,
        ]);
      }
    },
    get: (key: string) => base.get(key),
    delete: (key: string) => base.delete(key),
  };
  const app = appFor(fx);

  const response = await bearerSend(app, alice.token, "proj_1", "tor-cred", "must not publish");
  assert.equal(response.status, 403);
  assert.equal((await jsonBody(response))["error"]?.["code"], "FORBIDDEN");
  const committed = await fx.db.all("SELECT id FROM messages WHERE seq IS NOT NULL");
  assert.equal(committed.length, 0);
  const project = await fx.db.first<{ next_seq: number }>("SELECT next_seq FROM projects WHERE id = ?", [
    "proj_1",
  ]);
  assert.equal(project?.next_seq, 0);
});

test("a membership removed after authentication but before publication fails closed", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const base = fx.deps.blobs;
  let removed = false;
  fx.deps.blobs = {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      await base.put(key, bytes);
      if (!removed) {
        removed = true;
        await fx.db.run(
          "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
          [fx.deps.now().toISOString(), "proj_1", alice.speakerId],
        );
      }
    },
    get: (key: string) => base.get(key),
    delete: (key: string) => base.delete(key),
  };
  const app = appFor(fx);

  const response = await bearerSend(app, alice.token, "proj_1", "tor-member", "must not publish");
  assert.equal(response.status, 404);
  assert.equal((await jsonResponseCode(response)), "NOT_FOUND");
  assert.equal((await fx.db.all("SELECT id FROM messages WHERE seq IS NOT NULL")).length, 0);
});

async function jsonResponseCode(response: Response): Promise<string | undefined> {
  return (await jsonBody(response))["error"]?.["code"] as string | undefined;
}

test("a session revoked between send authorization and publication fails closed", async (t) => {
  const fx = await withFixture(t);
  const owner = await addPasswordActor(fx, "owner", "owner password");
  await addProject(fx, "proj_1", owner, [owner]);
  const auth = await loginSession(appFor(fx), "owner@example.test", "owner password");

  const base = fx.deps.blobs;
  let revoked = false;
  fx.deps.blobs = {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      await base.put(key, bytes);
      if (!revoked) {
        revoked = true;
        await fx.db.run("UPDATE sessions SET revoked_at = ? WHERE account_id = ?", [
          fx.deps.now().toISOString(),
          owner.accountId,
        ]);
      }
    },
    get: (key: string) => base.get(key),
    delete: (key: string) => base.delete(key),
  };
  const app = appFor(fx);

  const response = await webPost(app, "/projects/proj_1/messages/new", auth, {
    csrf_token: auth.csrf,
    idempotency_key: "session-tor",
    speaker_id: owner.speakerId,
    summary: "session revoked",
    text: "must not publish",
    type: "note",
    language: "en",
    reply_to_id: "",
    body_expires_at: "",
  });
  assert.equal(response.status, 404);
  assert.equal((await response.text()).includes("must not publish"), false);
  assert.equal((await fx.db.all("SELECT id FROM messages WHERE seq IS NOT NULL")).length, 0);
  const project = await fx.db.first<{ next_seq: number }>("SELECT next_seq FROM projects WHERE id = ?", [
    "proj_1",
  ]);
  assert.equal(project?.next_seq, 0);
});

test("the session publication predicate fails closed on account rebinding, inactive account, expiry and unparseable timestamps", async (t) => {
  const cases: Array<{
    label: string;
    key: string;
    mutate: (fx: ServiceFixture, owner: Actor) => Promise<void>;
  }> = [
    {
      label: "session account rebound out of band",
      key: "tor-rebind",
      mutate: async (fx, owner) => {
        await fx.addAccount("acct_other");
        await fx.db.run("UPDATE sessions SET account_id = ? WHERE account_id = ?", [
          "acct_other",
          owner.accountId,
        ]);
      },
    },
    {
      label: "session account deactivated out of band",
      key: "tor-inactive-account",
      mutate: async (fx, owner) => {
        await fx.db.run("UPDATE accounts SET status = 'suspended' WHERE id = ?", [
          owner.accountId,
        ]);
      },
    },
    {
      label: "session absolute expiry backdated out of band",
      key: "tor-absolute-expiry",
      mutate: async (fx, owner) => {
        await fx.db.run("UPDATE sessions SET expires_at = ? WHERE account_id = ?", [
          "2026-11-03T11:59:59.000Z",
          owner.accountId,
        ]);
      },
    },
    {
      label: "session idle window backdated out of band",
      key: "tor-idle-expiry",
      mutate: async (fx, owner) => {
        await fx.db.run("UPDATE sessions SET last_seen_at = ? WHERE account_id = ?", [
          "2026-11-03T11:00:00.000Z",
          owner.accountId,
        ]);
      },
    },
    {
      label: "session absolute expiry unparseable out of band",
      key: "tor-unparseable-expiry",
      mutate: async (fx, owner) => {
        await fx.db.run("UPDATE sessions SET expires_at = ? WHERE account_id = ?", [
          "not-a-timestamp",
          owner.accountId,
        ]);
      },
    },
  ];

  for (const probe of cases) {
    await t.test(probe.label, async (sub) => {
      const fx = await withFixture(sub);
      const owner = await addPasswordActor(fx, "owner", "owner password");
      await addProject(fx, "proj_1", owner, [owner]);
      const auth = await loginSession(appFor(fx), "owner@example.test", "owner password");

      const base = fx.deps.blobs;
      let armed = false;
      fx.deps.blobs = {
        async put(key: string, bytes: Uint8Array): Promise<void> {
          await base.put(key, bytes);
          if (!armed) {
            armed = true;
            await probe.mutate(fx, owner);
          }
        },
        get: (key: string) => base.get(key),
        delete: (key: string) => base.delete(key),
      };
      const app = appFor(fx);

      const response = await webPost(app, "/projects/proj_1/messages/new", auth, {
        csrf_token: auth.csrf,
        idempotency_key: probe.key,
        speaker_id: owner.speakerId,
        summary: "predicate probe",
        text: "must not publish",
        type: "note",
        language: "en",
        reply_to_id: "",
        body_expires_at: "",
      });
      assert.equal(response.status, 404, probe.label);
      assert.equal((await response.text()).includes("must not publish"), false, probe.label);

      // No published row, sequence, receipt, or ready body. The provisional
      // pending row and its blob remain as the documented reclaimable artifact.
      assert.equal(
        (await fx.db.all("SELECT id FROM messages WHERE seq IS NOT NULL")).length,
        0,
        probe.label,
      );
      assert.equal(
        (await fx.db.all("SELECT id FROM messages WHERE body_state = 'ready'")).length,
        0,
        probe.label,
      );
      assert.deepEqual(
        (await fx.db.all<{ body_state: string }>("SELECT body_state FROM messages")).map(
          (row) => row.body_state,
        ),
        ["pending"],
        probe.label,
      );
      const project = await fx.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?",
        ["proj_1"],
      );
      assert.equal(project?.next_seq, 0, probe.label);
      assert.equal(
        (await fx.db.all("SELECT message_id FROM message_receipts")).length,
        0,
        probe.label,
      );
      const objectCount = await fx.db.first<{ n: number }>(
        "SELECT COUNT(*) AS n FROM body_objects",
      );
      assert.equal(objectCount?.n, 1, probe.label);
      const pendingObjects = await fx.db.first<{ n: number }>(
        `SELECT COUNT(*) AS n FROM body_objects b
           JOIN messages m ON m.body_object_id = b.id
          WHERE m.body_state = 'pending'`,
      );
      assert.equal(pendingObjects?.n, 1, `${probe.label}: blob is unreachable from any published row`);
    });
  }
});

// ---------------------------------------------------------------------------
// Spoofed sender / account / timestamps
// ---------------------------------------------------------------------------

test("server identity wins over client sender, account, timestamp and sequence fields", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addPasswordActor(fx, "alice", "alice password");
  await addProject(fx, "proj_1", alice, [alice]);

  // REST: unknown extra identity fields are ignored; server values win.
  const accepted = await bearerSend(app, alice.token, "proj_1", "spoof-accepted", "server wins", {
    sender: "spk_evil",
    sender_id: "spk_evil",
    account_id: "acct_evil",
    created_at: "1999-01-01T00:00:00.000Z",
    body_state: "expired",
    client_sent_at: "1999-01-01T00:00:00.000Z",
  });
  assert.equal(accepted.status, 201);
  const acceptedBody = await jsonBody(accepted);
  assert.match(acceptedBody["committed_at"] as string, /^2026-11-03T12:00:00\.000Z$/);
  const stored = await fx.db.first<{
    sender_speaker_id: string;
    received_at: string;
    committed_at: string;
    body_state: string;
    client_sent_at: string | null;
  }>(
    "SELECT sender_speaker_id, received_at, committed_at, body_state, client_sent_at FROM messages WHERE id = ?",
    [acceptedBody["message_id"]],
  );
  assert.equal(stored?.sender_speaker_id, alice.speakerId);
  assert.equal(stored?.received_at, "2026-11-03T12:00:00.000Z");
  assert.equal(stored?.committed_at, "2026-11-03T12:00:00.000Z");
  assert.equal(stored?.body_state, "ready");
  // client_sent_at is retained as untrusted metadata, never as authority.
  assert.equal(stored?.client_sent_at, "1999-01-01T00:00:00.000Z");

  // Server-owned REST fields are rejected before any write.
  for (const field of ["speaker_id", "seq", "received_at", "committed_at", "compression"]) {
    const response = await bearerSend(app, alice.token, "proj_1", `forbid-${field}`, "no", {
      [field]: field === "seq" ? 99 : "x",
    });
    assert.equal(response.status, 400, field);
    assert.equal((await jsonBody(response))["error"]?.["code"], "VALIDATION_ERROR");
  }

  // MCP: strict tool schemas reject identity fields and do not reach the service.
  const session = await mcpSession(app, alice.token);
  const before = (await fx.db.all("SELECT id FROM messages")).length;
  for (const field of ["sender", "speaker_id", "account_id", "created_at", "seq"]) {
    const result = await rawTool(app, alice.token, session, 2, "corkboard_send_message", {
      project_id: "proj_1",
      summary: "spoof",
      type: "note",
      language: "en",
      text: "spoof",
      [field]: field === "seq" ? 99 : "spk_evil",
    });
    assertToolSchemaRejection(result);
  }
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, before);

  // Web form: fields outside the fixed form contract are ignored, including a
  // client-supplied digest, and the selected owned speaker is the sender.
  const auth = await loginSession(app, "alice@example.test", "alice password");
  const web = await webPost(app, "/projects/proj_1/messages/new", auth, {
    csrf_token: auth.csrf,
    idempotency_key: "web-spoof",
    speaker_id: alice.speakerId,
    summary: "web spoof",
    text: "web server wins",
    type: "note",
    language: "en",
    reply_to_id: "",
    body_expires_at: "",
    body_digest: digestOf("different bytes"),
    sender: "spk_evil",
    account_id: "acct_evil",
    created_at: "1999-01-01T00:00:00.000Z",
    seq: "999",
    received_at: "1999-01-01T00:00:00.000Z",
    committed_at: "1999-01-01T00:00:00.000Z",
  });
  assert.equal(web.status, 303);
  const webRow = await fx.db.first<{
    sender_speaker_id: string;
    received_at: string;
    committed_at: string;
  }>(
    "SELECT sender_speaker_id, received_at, committed_at FROM messages WHERE summary = 'web spoof'",
  );
  assert.equal(webRow?.sender_speaker_id, alice.speakerId);
  assert.equal(webRow?.received_at, "2026-11-03T12:00:00.000Z");
  assert.equal(webRow?.committed_at, "2026-11-03T12:00:00.000Z");

  // OAuth: extra identity fields in the consent form are ignored; the issued
  // token belongs to the session account's selected owned speaker.
  const oauthApp = appFor(fx, { publicBaseUrl: OAUTH_BASE });
  const clientId = await registerOAuthClient(oauthApp);
  const oauthAuth = await loginSession(oauthApp, "alice@example.test", "alice password");
  const accessToken = await oauthConsentWithSpoofedFields(
    oauthApp,
    oauthAuth,
    clientId,
    alice.speakerId,
    "proj_1",
  );
  const oauthMe = await call(oauthApp, "/api/v1/me", { token: accessToken });
  assert.equal(oauthMe.status, 200);
  const identity = await jsonBody(oauthMe);
  assert.deepEqual(identity["speaker"], { id: alice.speakerId, display_name: alice.speakerId });
  assert.deepEqual(identity["account"], { id: alice.accountId });
});

// ---------------------------------------------------------------------------
// Hostile headers
// ---------------------------------------------------------------------------

test("Host, forwarded, override, duplicate and absurd headers do not change identity or routing", async (t) => {
  const fx = await withFixture(t);
  const entries: RequestLogEntry[] = [];
  const app = appFor(fx, { logger: (entry) => entries.push(entry) });
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const baseline = await call(app, "/api/v1/projects/proj_1", { token: alice.token });
  const baselineBody = await jsonBody(baseline);
  assert.equal(baseline.status, 200);

  const hostileHeaders: Record<string, string> = {
    host: "evil.example",
    "x-forwarded-for": "203.0.113.9",
    "x-forwarded-proto": "http",
    "x-forwarded-host": "evil.example",
    forwarded: "for=203.0.113.9;proto=http;host=evil.example",
    "x-real-ip": "203.0.113.9",
    "cf-connecting-ip": "203.0.113.9",
    "x-http-method-override": "DELETE",
    "x-original-url": "/admin",
    "x-rewrite-url": "/admin",
    "x-forwarded-prefix": "/admin",
  };
  for (const [name, value] of Object.entries(hostileHeaders)) {
    const response = await call(app, "/api/v1/projects/proj_1", {
      token: alice.token,
      headers: { [name]: value },
    });
    assert.equal(response.status, 200, name);
    assert.deepEqual(await jsonBody(response), baselineBody, name);
    assert.equal(response.headers.get("x-powered-by"), null);
    for (const [, headerValue] of response.headers) {
      assert.equal(headerValue.includes(value), false, `${name} echoed`);
    }
  }
  assert.equal(JSON.stringify(entries).includes("203.0.113.9"), false);
  assert.equal(JSON.stringify(entries).includes("evil.example"), false);

  // Duplicate Authorization values are one invalid header, not two attempts.
  const duplicateAuth = await call(app, "/api/v1/me", {
    headerPairs: [
      ["authorization", `Bearer ${alice.token}`],
      ["authorization", "Bearer cb_duplicate"],
    ],
  });
  assert.equal(duplicateAuth.status, 401);
  assert.equal((await jsonBody(duplicateAuth))["error"]?.["code"], "UNAUTHENTICATED");

  // Absurd but bounded values never become a server error or a reflection.
  const absurd = await call(app, "/api/v1/me", {
    token: `Bearer ${"A".repeat(20_000)}`,
  });
  assert.equal(absurd.status, 401);
  assert.equal((await absurd.text()).includes("A".repeat(64)), false);

  // Duplicate Content-Length is a validation failure, not a body read.
  const duplicateLength = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headerPairs: [
      ["content-type", "application/json"],
      ["idempotency-key", "dup-length"],
      ["content-length", "10"],
      ["content-length", "10"],
    ],
    body: JSON.stringify(payload("duplicate length")),
  });
  assert.equal(duplicateLength.status, 400);
  assert.equal((await jsonBody(duplicateLength))["error"]?.["code"], "VALIDATION_ERROR");

  // Method override is ignored: a POST still posts.
  const overridden = await bearerSend(app, alice.token, "proj_1", "override", "still posts");
  assert.equal(overridden.status, 201);

  // Content-type confusion is rejected at the documented boundaries.
  const login = await call(app, "/api/v1/session", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify({ email: "alice@example.test", password: "x" }),
  });
  assert.equal(login.status, 400);

  // Percent-encoded CRLF/paths never split a header or reflect markup.
  const crlfPath = await call(app, "/api/v1/projects/proj%0D%0AX-Injected:%20yes", {
    token: alice.token,
  });
  assert.equal(crlfPath.status, 404);
  assert.equal(crlfPath.headers.get("x-injected"), null);
  assert.equal((await crlfPath.text()).includes("X-Injected"), false);

  // The HTTP platform refuses raw CR/LF header values before the app sees them.
  assert.throws(
    () =>
      new Request("http://localhost/healthz", {
        headers: { "x-probe": "a\r\nX-Injected: yes" },
      }),
    TypeError,
  );

  // OPTIONS remains a method error with no CORS headers.
  const options = await call(app, "/api/v1/projects/proj_1", { method: "OPTIONS" });
  assert.equal(options.status, 405);
  assert.equal(options.headers.get("access-control-allow-origin"), null);
});

test("cross-site Origin and fetch metadata are rejected on cookie forms", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx, { publicBaseUrl: OAUTH_BASE });
  const alice = await addPasswordActor(fx, "alice", "alice password");
  await addProject(fx, "proj_1", alice, [alice]);

  const loginCsrf = cookieValue(
    (await call(app, "/login")).headers.getSetCookie(),
    WEB_LOGIN_CSRF_COOKIE,
  );
  assert.ok(loginCsrf);
  const loginFields = formBody({
    return_to: "/",
    login_csrf: loginCsrf,
    email: "alice@example.test",
    password: "alice password",
  });

  for (const [name, value] of [
    ["sec-fetch-site", "cross-site"],
    ["sec-fetch-site", "same-site"],
    ["origin", "https://evil.example"],
  ] as Array<[string, string]>) {
    const response = await call(app, "/login", {
      method: "POST",
      headers: {
        "content-type": FORM,
        cookie: `${WEB_LOGIN_CSRF_COOKIE}=${loginCsrf}`,
        [name]: value,
      },
      body: loginFields,
    });
    assert.equal(response.status, 400, name);
    assert.equal(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)),
      false,
    );
  }

  // Referer is not consulted, and a same-origin/none fetch site is accepted.
  for (const headers of [
    { referer: "https://evil.example/attack" },
    { "sec-fetch-site": "none" },
    { origin: "http://localhost" },
  ]) {
    const response = await call(app, "/login", {
      method: "POST",
      headers: {
        "content-type": FORM,
        cookie: `${WEB_LOGIN_CSRF_COOKIE}=${loginCsrf}`,
        ...headers,
      },
      body: loginFields,
    });
    assert.equal(response.status, 303);
    assert.equal(
      response.headers.getSetCookie().some((cookie) => cookie.startsWith(`${SESSION_COOKIE_NAME}=`)),
      true,
    );
  }

  // A logged-in cross-site dashboard write is refused and writes nothing.
  const auth = await loginSession(app, "alice@example.test", "alice password");
  const crossSite = await webPost(
    app,
    "/projects/proj_1/messages/new",
    auth,
    {
      csrf_token: auth.csrf,
      idempotency_key: "cross-site",
      speaker_id: alice.speakerId,
      summary: "cross site",
      text: "must not write",
      type: "note",
      language: "en",
      reply_to_id: "",
      body_expires_at: "",
    },
    { "sec-fetch-site": "cross-site" },
  );
  assert.equal(crossSite.status, 400);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);

  // OAuth consent needs the session CSRF header; a hostile Origin does not
  // substitute for it.
  const consent = await call(app, "/oauth/consent", {
    method: "POST",
    headers: {
      cookie: auth.cookie,
      origin: "https://evil.example",
      "content-type": FORM,
    },
    body: formBody({ client_id: "x" }),
  });
  assert.equal(consent.status, 403);
  assert.equal((await jsonBody(consent))["error"]?.["code"], "FORBIDDEN");
});

// ---------------------------------------------------------------------------
// Injection, traversal, parsing bounds and rendered output
// ---------------------------------------------------------------------------

test("SQL metacharacters, traversal and filters stay parameterized", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  await addProject(fx, "proj_2", bob, [bob]);

  await bearerSend(app, alice.token, "proj_1", "wild-1", "100% done");
  await bearerSend(app, alice.token, "proj_1", "wild-2", "100_ done");
  await bearerSend(app, alice.token, "proj_1", "wild-3", "100x done");
  await bearerSend(app, bob.token, "proj_2", "foreign", "tenant two secret");

  for (const projectId of [
    "proj_1' OR '1'='1",
    "proj_1'; DROP TABLE messages;--",
    'proj_1" OR "1"="1',
    "../../etc/passwd",
  ]) {
    const encoded = encodeURIComponent(projectId);
    for (const path of [
      `/api/v1/projects/${encoded}`,
      `/api/v1/projects/${encoded}/messages`,
      `/api/v1/projects/${encoded}/stats`,
    ]) {
      const response = await call(app, path, { token: alice.token });
      assert.equal(response.status, 404, path);
      const text = await response.text();
      assert.equal(text.includes("SQL"), false);
      assert.equal(text.includes("proj_2"), false);
    }
  }
  // Tables still exist after the injection attempts.
  assert.equal((await fx.db.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'")).length, 1);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 4);

  for (const messageId of ["msg' OR '1'='1", "../../etc/passwd", "msg_x%00"]) {
    const encoded = encodeURIComponent(messageId);
    for (const suffix of ["", "/body"]) {
      const response = await call(app, `/api/v1/projects/proj_1/messages/${encoded}${suffix}`, {
        token: alice.token,
      });
      assert.equal(response.status, 404);
    }
  }

  // Wildcards are literal, and SQL-shaped filters are validation errors, not
  // query text. Neither ever widens the project scope.
  const percent = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages?q=100%25", { token: alice.token }),
  );
  assert.deepEqual(percent["messages"].map((m: JsonObject) => m["summary"]), ["100% done"]);
  const underscore = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages?q=100_", { token: alice.token }),
  );
  assert.deepEqual(underscore["messages"].map((m: JsonObject) => m["summary"]), ["100_ done"]);
  const sqlText = await jsonBody(
    await call(app, "/api/v1/projects/proj_1/messages?q=%27%20OR%201%3D1%20--", {
      token: alice.token,
    }),
  );
  assert.deepEqual(sqlText["messages"], []);
  const injectionType = await call(app, "/api/v1/projects/proj_1/messages?type=note%27%20OR%201%3D1--", {
    token: alice.token,
  });
  assert.equal(injectionType.status, 400);
  const injectionSender = await call(
    app,
    "/api/v1/projects/proj_1/messages?sender=spk_alice%27%20OR%201%3D1--",
    { token: alice.token },
  );
  assert.equal(injectionSender.status, 400);
  const foreignSender = await call(app, "/api/v1/projects/proj_1/messages?sender=spk_missing", {
    token: alice.token,
  });
  assert.equal(foreignSender.status, 400);

  // Prototype-pollution-shaped JSON is just ignored data; nothing reaches
  // Object.prototype and the server still owns the sender.
  const protoRaw = JSON.stringify(payload("prototype probe")).replace(
    /^\{/,
    '{"__proto__":{"polluted":"yes"},"constructor":{"prototype":{"polluted":"yes"}},',
  );
  const proto = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "proto" },
    body: protoRaw,
  });
  assert.equal(proto.status, 201);
  assert.equal(({} as JsonObject)["polluted"], undefined);
  assert.equal((Object.prototype as JsonObject)["polluted"], undefined);
  const protoRow = await fx.db.first<{ sender_speaker_id: string }>(
    "SELECT sender_speaker_id FROM messages WHERE summary = 'prototype probe'",
  );
  assert.equal(protoRow?.sender_speaker_id, alice.speakerId);

  // Oversized and deeply nested bodies are bounded, never a 500.
  const oversized = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "oversized" },
    body: JSON.stringify(payload("x".repeat(70_000))),
  });
  assert.equal(oversized.status, 413);
  const deep = await call(app, "/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "deep" },
    body: "[".repeat(20_000) + "]".repeat(20_000),
  });
  assert.equal(deep.status, 400);
  assert.equal((await jsonBody(deep))["error"]?.["code"], "VALIDATION_ERROR");
});

test("stored and reflected markup is escaped in every rendered surface", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addPasswordActor(fx, "alice", "alice password");
  await fx.addProject("proj_1", alice.accountId);
  await fx.addMembership("proj_1", alice.speakerId);
  await fx.db.run("UPDATE projects SET title = ?, summary = ? WHERE id = ?", [
    '<script>alert("title")</script>{{7*7}}',
    '"><img src=x onerror="alert(1)">',
    "proj_1",
  ]);
  await fx.db.run("UPDATE speakers SET display_name = ? WHERE id = ?", [
    '<svg onload="alert(2)">',
    alice.speakerId,
  ]);
  const hostileText = '<script>alert("body")</script> ${7*7} {{7*7}}';
  const sent = await jsonBody(
    await bearerSend(app, alice.token, "proj_1", "xss", "safe body", {
      summary: '<script>alert("summary")</script>',
      text: hostileText,
      body_digest: digestOf(hostileText),
    }),
  );
  assert.ok(sent["message_id"], "hostile message committed");

  const auth = await loginSession(app, "alice@example.test", "alice password");
  const timeline = await call(app, "/projects/proj_1", {
    headers: { cookie: auth.cookie },
  });
  assert.equal(timeline.status, 200);
  const html = await timeline.text();
  assert.equal(html.toLowerCase().includes("<script"), false);
  assert.equal(html.includes("<img"), false);
  assert.equal(html.includes("<svg"), false);
  assert.equal(html.includes("&lt;script&gt;alert(&quot;title&quot;)&lt;/script&gt;"), true);
  assert.equal(html.includes("{{7*7}}"), true);
  assert.equal(html.includes("&lt;script&gt;alert(&quot;summary&quot;)&lt;/script&gt;"), true);
  assert.match(timeline.headers.get("content-security-policy") ?? "", /default-src 'none'/);

  const reflected = await call(app, "/projects/proj_1?q=%3Cscript%3Ealert(3)%3C%2Fscript%3E", {
    headers: { cookie: auth.cookie },
  });
  assert.equal(reflected.status, 200);
  const reflectedHtml = await reflected.text();
  assert.equal(reflectedHtml.toLowerCase().includes("<script"), false);
  assert.equal(reflectedHtml.includes("&lt;script&gt;alert(3)&lt;/script&gt;"), true);

  const body = await call(app, `/projects/proj_1/messages/${sent["message_id"]}/body`, {
    headers: { cookie: auth.cookie },
  });
  assert.equal(body.status, 200);
  const bodyHtml = await body.text();
  assert.equal(bodyHtml.toLowerCase().includes("<script"), false);
  assert.equal(
    bodyHtml.includes("&lt;script&gt;alert(&quot;body&quot;)&lt;/script&gt; ${7*7} {{7*7}}"),
    true,
  );
});

// ---------------------------------------------------------------------------
// MCP object scope and session isolation
// ---------------------------------------------------------------------------

test("MCP rejects foreign ids, spoofed arguments and another credential's session", async (t) => {
  const fx = await withFixture(t);
  const app = appFor(fx);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice]);
  await addProject(fx, "proj_2", bob, [bob]);
  const sent = await jsonBody(await bearerSend(app, alice.token, "proj_1", "mcp", "mcp body"));

  const session = await mcpSession(app, alice.token);
  for (const [name, args] of [
    ["corkboard_list_messages", { project_id: "proj_2" }],
    ["corkboard_get_message", { project_id: "proj_2", message_id: sent["message_id"] }],
    ["corkboard_send_message", { project_id: "proj_2", summary: "x", type: "note", language: "en", text: "x" }],
    ["corkboard_mark_read", { project_id: "proj_2", message_id: sent["message_id"] }],
  ] as Array<[string, JsonObject]>) {
    const result = await rawTool(app, alice.token, session, 3, name, args);
    assert.equal(toolErrorCode(result), "NOT_FOUND", name);
  }
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);

  const bobSession = await mcpSession(app, bob.token);
  for (const [name, sid] of [
    ["other credential's session", bobSession],
    ["unknown session", "sess_unknown"],
  ] as Array<[string, string]>) {
    const response = await rawPost(
      app,
      { jsonrpc: "2.0", id: 4, method: "tools/list" },
      { token: alice.token, sessionId: sid },
    );
    assert.equal(response.status, 404, name);
    const body = await jsonBody(response);
    assert.equal(body["error"]?.["message"], "Session not found");
  }
});
