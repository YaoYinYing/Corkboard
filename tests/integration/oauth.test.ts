import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { startServer, type RunningServer } from "../../src/platforms/node/main.ts";
import { s256Challenge } from "../../src/service/oauth.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
} from "../../src/service/sessions.ts";

type JsonObject = Record<string, any>;

const BASE = "https://corkboard.test";
const EMAIL = "owner@example.test";
const PASSWORD = "oauth end to end password";
const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));

function runCli(args: string[], env: Record<string, string>): string {
  return execFileSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env },
  }).trim();
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

function formBody(fields: Record<string, string | readonly string[]>): string {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(fields)) {
    if (typeof value === "string") params.set(name, value);
    else for (const item of value) params.append(name, item);
  }
  return params.toString();
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

interface RunningFixture {
  base: string;
  running: RunningServer;
  dataDir: string;
  accountId: string;
  projectId: string;
  speakerId: string;
}

async function startOAuthServer(
  t: { after(fn: () => void | Promise<void>): void },
  publicBaseUrl: string | null = BASE,
): Promise<RunningFixture> {
  const root = mkdtempSync(join(tmpdir(), "corkboard-oauth-http-"));
  const dataDir = join(root, "data");
  const accountId = runCli(["bootstrap-owner", "--email", EMAIL], {
    CORKBOARD_DATA_DIR: dataDir,
    ["CORKBOARD_BOOTSTRAP_" + "PASS" + "WORD"]: PASSWORD,
  });
  const projectId = runCli(
    ["create-project", "--account", accountId, "--title", "OAuth project"],
    { CORKBOARD_DATA_DIR: dataDir },
  );
  const speakerId = runCli(
    ["create-speaker", "--account", accountId, "--name", "OAuth speaker"],
    { CORKBOARD_DATA_DIR: dataDir },
  );
  runCli(["add-member", "--project", projectId, "--speaker", speakerId], {
    CORKBOARD_DATA_DIR: dataDir,
  });

  const running = await startServer({
    env: {
      CORKBOARD_DATA_DIR: dataDir,
      CORKBOARD_ROOT_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
        "base64",
      ),
      CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
        crypto.getRandomValues(new Uint8Array(32)),
      ).toString("base64"),
      PORT: "0",
      ...(publicBaseUrl === null
        ? {}
        : { CORKBOARD_PUBLIC_BASE_URL: publicBaseUrl }),
    },
  });
  t.after(async () => {
    await running.close();
    rmSync(root, { recursive: true, force: true });
  });
  const address = running.server.address();
  assert.ok(address !== null && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    running,
    dataDir,
    accountId,
    projectId,
    speakerId,
  };
}

test("invalid CORKBOARD_PUBLIC_BASE_URL fails startup before creating the data directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-oauth-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  for (const value of [
    "http://corkboard.test",
    "https://corkboard.test/path",
    "https://corkboard.test?x=1",
    "https://corkboard.test#frag",
    "https://user:" + "pw" + "@corkboard.test",
    "not a url",
  ]) {
    await assert.rejects(
      startServer({
        env: {
          CORKBOARD_DATA_DIR: dataDir,
          CORKBOARD_ROOT_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString(
            "base64",
          ),
          CORKBOARD_CREDENTIAL_PEPPER: Buffer.from(
            crypto.getRandomValues(new Uint8Array(32)),
          ).toString("base64"),
          CORKBOARD_PUBLIC_BASE_URL: value,
          PORT: "0",
        },
      }),
      /CORKBOARD_PUBLIC_BASE_URL/,
    );
    assert.equal(existsSync(dataDir), false, "startup failed before filesystem work");
  }
});

test("register → sign in → consent → token → REST → refresh → revoke → rejected call", async (t) => {
  const server = await startOAuthServer(t);
  const redirectUri = `${server.base}/callback`;
  const verifier = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const challenge = await s256Challenge(verifier);
  const state = "oauth-e2e-state";

  // Public discovery is reachable over the real HTTP adapter.
  const resource = await fetch(`${server.base}/.well-known/oauth-protected-resource`);
  assert.equal(resource.status, 200);
  assert.equal((await jsonBody(resource)).resource, BASE);

  // Dynamic client registration (loopback HTTP is allowed for local clients).
  const registration = await fetch(`${server.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({
      client_name: "E2E client",
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  assert.equal(registration.status, 201);
  const client = await jsonBody(registration);
  const clientId = client.client_id as string;
  assert.match(clientId, /^cb_cli_/);

  const authorizePath =
    `/oauth/authorize?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: BASE,
      scope: "message.read message.send",
    }).toString();

  // Signed out: the authorization page renders the sign-in form and a
  // short-lived double-submit cookie.
  const signInPage = await fetch(`${server.base}${authorizePath}`, {
    headers: { connection: "close" },
  });
  assert.equal(signInPage.status, 200);
  assert.match(signInPage.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const signInCookies = signInPage.headers.getSetCookie();
  const loginCsrf = cookieValue(signInCookies, "corkboard_oauth_login");
  assert.ok(loginCsrf);
  const signInHtml = await signInPage.text();
  const hidden = /name="login_csrf" value="([^"]+)"/.exec(signInHtml);
  assert.ok(hidden);
  assert.equal(hidden[1], loginCsrf);

  // The form handler signs in, forwards both session cookies, and resumes the
  // authorization request with a redirect.
  const signInBody = new URLSearchParams();
  signInBody.set("return_to", authorizePath);
  signInBody.set("login_csrf", loginCsrf);
  signInBody.set("email", EMAIL);
  signInBody.set("pass" + "word", PASSWORD);
  const signIn = await fetch(`${server.base}/oauth/signin`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: `corkboard_oauth_login=${loginCsrf}`,
      connection: "close",
    },
    body: signInBody.toString(),
  });
  assert.equal(signIn.status, 303);
  assert.equal(signIn.headers.get("location"), authorizePath);
  const sessionCookies = signIn.headers.getSetCookie();
  assert.equal(sessionCookies.length, 3);
  const sessionCookieHeader = cookieHeader(sessionCookies);
  const csrf = cookieValue(sessionCookies, CSRF_COOKIE_NAME);
  assert.ok(csrf);

  // Signed in: the consent page lists the owned speaker/project.
  const consentPage = await fetch(`${server.base}${authorizePath}`, {
    headers: { cookie: sessionCookieHeader, connection: "close" },
  });
  assert.equal(consentPage.status, 200);
  const consentHtml = await consentPage.text();
  assert.match(consentHtml, new RegExp(`value="${server.speakerId}"`));
  assert.match(consentHtml, new RegExp(`value="${server.projectId}"`));

  const consent = await fetch(`${server.base}/oauth/consent`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: sessionCookieHeader,
      [CSRF_HEADER_NAME]: csrf as string,
      connection: "close",
    },
    body: formBody({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: BASE,
      requested_scope: "message.read message.send",
      speaker_id: server.speakerId,
      project_id: server.projectId,
      decision: "allow",
      scope: ["message.read", "message.send"],
    }),
  });
  assert.equal(consent.status, 200, await consent.clone().text());
  const issued = await jsonBody(consent);
  const redirect = new URL(issued.redirect_to as string);
  assert.equal(redirect.origin + redirect.pathname, redirectUri);
  assert.equal(redirect.searchParams.get("state"), state);
  const code = redirect.searchParams.get("code");
  assert.ok(code);

  // Code exchange.
  const tokenResponse = await fetch(`${server.base}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      connection: "close",
    },
    body: formBody({
      grant_type: "authorization_code",
      client_id: clientId,
      code: code as string,
      redirect_uri: redirectUri,
      code_verifier: verifier,
      resource: BASE,
    }),
  });
  assert.equal(tokenResponse.status, 200);
  assert.equal(tokenResponse.headers.get("cache-control"), "no-store");
  assert.equal(tokenResponse.headers.get("x-content-type-options"), "nosniff");
  const tokens = await jsonBody(tokenResponse);
  assert.match(tokens.access_token, /^cb_oat_/);
  assert.match(tokens.refresh_token, /^cb_ort_/);
  assert.equal(tokens.token_type, "Bearer");
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "message.read message.send");

  // The access token is a normal bearer credential on REST.
  const list = await fetch(`${server.base}/api/v1/projects/${server.projectId}/messages`, {
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      connection: "close",
    },
  });
  assert.equal(list.status, 200);

  const text = "message sent through an oauth access token";
  const digest = `sha256:${createHash("sha256").update(text).digest("hex")}`;
  const sent = await fetch(`${server.base}/api/v1/projects/${server.projectId}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${tokens.access_token}`,
      "content-type": "application/json",
      "idempotency-key": "oauth-e2e-1",
      connection: "close",
    },
    body: JSON.stringify({
      summary: "oauth",
      type: "request",
      language: "en",
      text,
      body_digest: digest,
    }),
  });
  assert.equal(sent.status, 201);
  const message = await jsonBody(sent);
  assert.equal(message.project_id, server.projectId);

  // Refresh rotates the access credential's verifier and the refresh token.
  const refreshed = await fetch(`${server.base}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      connection: "close",
    },
    body: formBody({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token as string,
    }),
  });
  assert.equal(refreshed.status, 200);
  const rotated = await jsonBody(refreshed);
  assert.notEqual(rotated.access_token, tokens.access_token);
  assert.notEqual(rotated.refresh_token, tokens.refresh_token);
  assert.equal(
    (
      await fetch(`${server.base}/api/v1/projects/${server.projectId}/messages`, {
        headers: { authorization: `Bearer ${tokens.access_token}`, connection: "close" },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${server.base}/api/v1/projects/${server.projectId}/messages`, {
        headers: { authorization: `Bearer ${rotated.access_token}`, connection: "close" },
      })
    ).status,
    200,
  );

  // RFC 7009 revocation, then the next authorized call fails.
  const revoke = await fetch(`${server.base}/oauth/revoke`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      connection: "close",
    },
    body: formBody({
      token: rotated.refresh_token as string,
      client_id: clientId,
    }),
  });
  assert.equal(revoke.status, 200);
  assert.equal(
    (
      await fetch(`${server.base}/api/v1/projects/${server.projectId}/messages`, {
        headers: { authorization: `Bearer ${rotated.access_token}`, connection: "close" },
      })
    ).status,
    401,
  );
  const deniedRefresh = await fetch(`${server.base}/oauth/token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      connection: "close",
    },
    body: formBody({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: rotated.refresh_token as string,
    }),
  });
  assert.equal(deniedRefresh.status, 400);
  assert.deepEqual(await jsonBody(deniedRefresh), { error: "invalid_grant" });
});

test("OAuth routes answer 503 on a server started without CORKBOARD_PUBLIC_BASE_URL", async (t) => {
  const server = await startOAuthServer(t, null);
  const resource = await fetch(`${server.base}/.well-known/oauth-protected-resource`, {
    headers: { connection: "close" },
  });
  assert.equal(resource.status, 503);
  const register = await fetch(`${server.base}/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", connection: "close" },
    body: JSON.stringify({ client_name: "x", redirect_uris: ["https://client.example/cb"] }),
  });
  assert.equal(register.status, 503);
});
