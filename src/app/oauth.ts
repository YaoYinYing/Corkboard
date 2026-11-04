// OAuth 2.1 HTTP routes. Public discovery/registration/token/revocation live
// here beside two minimal HTML pages (sign-in and consent). All HTML is
// server-rendered and escaped; the only script is a constant same-origin file.
// Raw codes, tokens, cookies, and CSRF values are never logged.
import { randomBase64url } from "../auth/credentials.ts";
import { digestsEqual, sha256Hex } from "../domain/digest.ts";
import { AppError, RateLimitError } from "../domain/errors.ts";
import { normalizeEmail, validateLoginPassword } from "../domain/validation.ts";
import type { ServiceDeps } from "../service/auth.ts";
import {
  appendOAuthQuery,
  exchangeAuthorizationCode,
  findActiveClient,
  isOAuthScope,
  isValidState,
  isS256Challenge,
  issueAuthorizationCode,
  listConsentCandidates,
  OAUTH_SCOPES,
  parseAuthorizationRequest,
  parseOAuthScopeString,
  registerClient,
  revokeOAuthToken,
  rotateRefreshToken,
  scopeString,
  signAuthorizationRequest,
  validateClientRegistration,
  verifyAuthorizationRequestSignature,
  OAuthAuthorizeError,
  OAuthTokenError,
  type AuthorizationRequestSignatureInput,
  type ConsentCandidate,
  type OAuthScope,
} from "../service/oauth.ts";
import {
  CSRF_HEADER_NAME,
  authenticateSession,
  loginAccount,
  sessionTokenFromCookie,
  touchSession,
  validateSession,
  verifySessionCsrf,
  type SessionPrincipal,
} from "../service/sessions.ts";
import {
  clearedLoginCsrfCookie,
  csrfCookie,
  loginCsrfCookie,
  sessionCookie,
} from "./cookies.ts";
import type { RateLimiter } from "./rate-limit.ts";
import { json } from "./responses.ts";

const MAX_OAUTH_BODY_BYTES = 64 * 1024;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";
const LOGIN_CSRF_COOKIE = "corkboard_oauth_login";
const DECODER = new TextDecoder();
const ENCODER = new TextEncoder();
const HTML_CSP =
  "default-src 'none'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export interface OAuthRouteOptions {
  /** `undefined` disables every OAuth route with a fixed 503. */
  publicBaseUrl: string | undefined;
  registerLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
  /** Global token-endpoint bucket so rotating client_id cannot bypass limits. */
  tokenGlobalLimiter: RateLimiter;
}

export function isOAuthPath(segments: readonly string[]): boolean {
  if (segments.length === 2 && segments[0] === ".well-known") {
    return (
      segments[1] === "oauth-authorization-server" ||
      segments[1] === "oauth-protected-resource"
    );
  }
  return segments[0] === "oauth";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlResponse(
  status: number,
  body: string,
  extra: Record<string, string | readonly string[]> = {},
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": HTML_CSP,
  });
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") headers.set(name, value);
    else for (const item of value) headers.append(name, item);
  }
  return new Response(body, { status, headers });
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
</head>
<body>
<main>
<h1>${escapeHtml(title)}</h1>
${content}
</main>
</body>
</html>
`;
}

function htmlError(status: number, message: string): Response {
  return htmlResponse(
    status,
    page("Corkboard authorization", `<p role="alert">${escapeHtml(message)}</p>`),
  );
}

function oauthErrorResponse(status: number, error: string): Response {
  return json(status, { error });
}

function methodNotAllowed(allow: string): Response {
  return json(405, { error: "invalid_request" }, { allow });
}

function disabledResponse(): Response {
  return json(503, { error: { code: "UNAVAILABLE", message: "OAuth is not configured" } });
}

function cookieValue(header: string | null, name: string): string | undefined {
  if (header === null) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

function mediaType(request: Request): string {
  const raw = request.headers.get("content-type");
  return raw === null ? "" : (raw.split(";")[0] ?? "").trim().toLowerCase();
}

async function readBodyBytes(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppError("VALIDATION_ERROR", "Invalid Content-Length");
    }
    if (length > MAX_OAUTH_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_OAUTH_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");
  return bytes;
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (mediaType(request) !== "application/json") {
    throw new AppError("VALIDATION_ERROR", "Content-Type must be application/json");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(await readBodyBytes(request)));
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("VALIDATION_ERROR", "Malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("VALIDATION_ERROR", "Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

async function readForm(request: Request): Promise<URLSearchParams> {
  if (mediaType(request) !== FORM_MEDIA_TYPE) {
    throw new OAuthTokenError("invalid_request");
  }
  return new URLSearchParams(DECODER.decode(await readBodyBytes(request)));
}

function singleTokenParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new OAuthTokenError("invalid_request");
  return values[0] ?? null;
}

function singleFormParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new AppError("VALIDATION_ERROR", `Duplicate ${name}`);
  return values[0] ?? null;
}

function redirectOAuthError(
  redirectUri: string,
  error: string,
  state: string | null,
): Response {
  const target = appendOAuthQuery(redirectUri, {
    error,
    ...(state === null ? {} : { state }),
  });
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function signInPage(
  status: number,
  returnTo: string,
  message?: string,
): { response: Response; loginCsrf: string } {
  // Double-submit value: the hidden field and the HttpOnly SameSite=Lax cookie
  // must match. A cross-site form post cannot read the cookie and, with Lax,
  // the cookie is not sent on the POST.
  const loginCsrf = randomBase64url(32);
  const alert =
    message === undefined ? "" : `<p role="alert">${escapeHtml(message)}</p>\n`;
  const body = page(
    "Sign in to Corkboard",
    `${alert}<form method="post" action="/oauth/signin">
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<input type="hidden" name="login_csrf" value="${escapeHtml(loginCsrf)}">
<p><label for="email">Email</label><br>
<input id="email" name="email" type="email" autocomplete="username" required></p>
<p><label for="password">Password</label><br>
<input id="password" name="password" type="password" autocomplete="current-password" required></p>
<p><button type="submit">Sign in</button></p>
</form>`,
  );
  return {
    response: htmlResponse(status, body, { "set-cookie": loginCsrfCookie(loginCsrf) }),
    loginCsrf,
  };
}

function consentPage(
  clientId: string,
  redirectUri: string,
  clientName: string,
  request: {
    codeChallenge: string;
    resource: string;
    scopes: OAuthScope[];
    state: string | null;
    speakerId: string | null;
    projectId: string | null;
    requestSignature: string;
  },
  candidates: readonly ConsentCandidate[],
  accountEmail: string,
): Response {
  const speakers = new Map<string, string>();
  const projects = new Map<string, string>();
  for (const candidate of candidates) {
    speakers.set(candidate.speakerId, candidate.speakerName);
    projects.set(candidate.projectId, candidate.projectTitle);
  }
  const options = (entries: Map<string, string>, selected: string | null): string =>
    [...entries.entries()]
      .sort((left, right) => left[1].localeCompare(right[1]) || left[0].localeCompare(right[0]))
      .map(
        ([id, label]) =>
          `<option value="${escapeHtml(id)}"${id === selected ? " selected" : ""}>${escapeHtml(label)}</option>`,
      )
      .join("\n");

  const scopeBoxes = request.scopes
    .map(
      (scope) =>
        `<p><label><input type="checkbox" name="scope" value="${escapeHtml(scope)}" checked> ${escapeHtml(scope)}</label></p>`,
    )
    .join("\n");

  const hidden = {
    client_id: clientId,
    redirect_uri: redirectUri,
    state: request.state ?? "",
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
    resource: request.resource,
    requested_scope: scopeString(request.scopes),
    request_signature: request.requestSignature,
  };
  const body = page(
    "Authorize Corkboard access",
    `<p><strong>${escapeHtml(clientName)}</strong> is requesting access as a Corkboard speaker.</p>
<p>Signed in as ${escapeHtml(accountEmail)}.</p>
<form method="post" action="/oauth/consent" data-oauth-consent>
${Object.entries(hidden)
  .map(
    ([name, value]) =>
      `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`,
  )
  .join("\n")}
<p><label for="speaker_id">Speaker</label><br>
<select id="speaker_id" name="speaker_id" required>
${options(speakers, request.speakerId)}
</select></p>
<p><label for="project_id">Project</label><br>
<select id="project_id" name="project_id" required>
${options(projects, request.projectId)}
</select></p>
<fieldset>
<legend>Permissions</legend>
<p>Only these message permissions can be delegated. Project administration is never granted.</p>
${scopeBoxes}
</fieldset>
<p><button type="submit" name="decision" value="allow">Allow</button>
<button type="submit" name="decision" value="deny" formnovalidate>Deny</button></p>
</form>
<noscript><p>JavaScript is required to submit this form securely.</p></noscript>
<script src="/oauth/client.js" defer></script>`,
  );
  return htmlResponse(200, body);
}

const CLIENT_SCRIPT = `"use strict";
document.addEventListener("DOMContentLoaded", function () {
  var form = document.querySelector("form[data-oauth-consent]");
  if (!form) return;
  form.addEventListener("submit", async function (event) {
    event.preventDefault();
    var csrf = "";
    var cookies = document.cookie ? document.cookie.split("; ") : [];
    for (var i = 0; i < cookies.length; i += 1) {
      if (cookies[i].indexOf("corkboard_csrf=") === 0) {
        csrf = decodeURIComponent(cookies[i].slice("corkboard_csrf=".length));
        break;
      }
    }
    var data = new FormData(form);
    if (event.submitter && event.submitter.name) {
      data.append(event.submitter.name, event.submitter.value);
    }
    var response = await fetch("/oauth/consent", {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-csrf-token": csrf
      },
      body: new URLSearchParams(data)
    });
    if (!response.ok) {
      var alert = document.createElement("p");
      alert.setAttribute("role", "alert");
      alert.textContent = "The authorization request could not be completed.";
      form.parentNode.insertBefore(alert, form);
      return;
    }
    var result = await response.json();
    if (result && typeof result.redirect_to === "string") {
      window.location.assign(result.redirect_to);
    }
  });
});
`;

async function handleRegister(
  deps: ServiceDeps,
  request: Request,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const decision = options.registerLimiter.check("oauth:register");
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  try {
    const body = await readJsonObject(request);
    const input = validateClientRegistration(body);
    const client = await registerClient(deps, input);
    return json(201, {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
    });
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return oauthErrorResponse(400, "invalid_client_metadata");
    }
    throw error;
  }
}

async function handleAuthorize(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  const base = options.publicBaseUrl;
  if (base === undefined) return disabledResponse();

  const params = url.searchParams;
  // Bound the value re-rendered into the sign-in form's return_to field.
  if (url.search.length > 4096) {
    return htmlError(400, "Invalid authorization request");
  }
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (clientId === null || clientId === "" || redirectUri === null) {
    return htmlError(400, "Invalid authorization request");
  }
  const client = await findActiveClient(deps, clientId);
  if (client === undefined || !client.redirectUris.includes(redirectUri)) {
    // An unvalidated redirect URI is never used for an error redirect.
    return htmlError(400, "Invalid authorization request");
  }

  const rawState = params.get("state");
  const safeState = rawState !== null && isValidState(rawState) ? rawState : null;
  let parsed: ReturnType<typeof parseAuthorizationRequest>;
  try {
    parsed = parseAuthorizationRequest(base, params);
  } catch (error) {
    if (error instanceof OAuthAuthorizeError) {
      return redirectOAuthError(redirectUri, error.oauthError, safeState);
    }
    throw error;
  }

  let session: SessionPrincipal;
  try {
    session = await authenticateSession(
      deps,
      sessionTokenFromCookie(request.headers.get("cookie")),
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
      return signInPage(200, `/oauth/authorize${url.search}`).response;
    }
    throw error;
  }

  const candidates = await listConsentCandidates(deps, session.accountId, parsed.scopes);
  if (candidates.length === 0) {
    return htmlError(
      403,
      "No speaker owned by this account has an active membership that can grant the requested scopes.",
    );
  }
  // client_id and redirect_uri are hidden fields above, already validated here.
  // The signature binds every request field to the rendered consent form.
  const requestSignature = await signAuthorizationRequest(deps.pepper, {
    clientId,
    redirectUri,
    state: parsed.state,
    codeChallenge: parsed.codeChallenge,
    resource: parsed.resource,
    scopes: parsed.scopes,
  });
  return consentPage(
    clientId,
    redirectUri,
    client.clientName,
    { ...parsed, requestSignature },
    candidates,
    session.email,
  );
}

async function handleSignIn(
  deps: ServiceDeps,
  request: Request,
  loginLimiter: RateLimiter,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const base = options.publicBaseUrl;
  if (base === undefined) return disabledResponse();

  let form: URLSearchParams;
  try {
    form = await readForm(request);
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      return htmlError(400, "Invalid sign-in request");
    }
    throw error;
  }
  const returnTo = singleFormParam(form, "return_to");
  if (
    returnTo === null ||
    returnTo.length > 8192 ||
    // CR/LF and other control characters would either be stripped by URL
    // parsing or produce an invalid Location header. Reject before parsing.
    /[\u0000-\u001f\u007f]/.test(returnTo) ||
    !returnTo.startsWith("/oauth/authorize")
  ) {
    return htmlError(400, "Invalid sign-in request");
  }
  let target: URL;
  try {
    target = new URL(returnTo, base);
  } catch {
    return htmlError(400, "Invalid sign-in request");
  }
  if (target.origin !== new URL(base).origin || target.pathname !== "/oauth/authorize") {
    return htmlError(400, "Invalid sign-in request");
  }
  // Emit the parsed/normalized form, never the raw client-supplied string.
  const normalizedReturnTo = target.pathname + target.search;

  const cookieCsrf = cookieValue(request.headers.get("cookie"), LOGIN_CSRF_COOKIE);
  const formCsrf = singleFormParam(form, "login_csrf");
  if (cookieCsrf === undefined || formCsrf === null || formCsrf === "") {
    return htmlError(400, "The sign-in form expired. Try again.");
  }
  const [presented, expected] = await Promise.all([
    sha256Hex(ENCODER.encode(formCsrf)),
    sha256Hex(ENCODER.encode(cookieCsrf)),
  ]);
  if (!digestsEqual(presented, expected)) {
    return htmlError(400, "The sign-in form expired. Try again.");
  }

  let email: string;
  let password: string;
  try {
    email = normalizeEmail(form.get("email"));
    password = validateLoginPassword(form.get("password"));
  } catch {
    return signInPage(401, normalizedReturnTo, "Invalid email or password.").response;
  }
  const decision = loginLimiter.check(await sha256Hex(ENCODER.encode(email)));
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

  let login;
  try {
    login = await loginAccount(deps, { email, password });
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
      return signInPage(401, normalizedReturnTo, "Invalid email or password.").response;
    }
    throw error;
  }

  return new Response(null, {
    status: 303,
    headers: (() => {
      const headers = new Headers({
        location: normalizedReturnTo,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      for (const cookie of [
        sessionCookie(login.token),
        csrfCookie(login.csrfToken),
        clearedLoginCsrfCookie(),
      ]) {
        headers.append("set-cookie", cookie);
      }
      return headers;
    })(),
  });
}

async function handleConsent(
  deps: ServiceDeps,
  request: Request,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  const base = options.publicBaseUrl;
  if (base === undefined) return disabledResponse();

  const form = await readForm(request);
  // Validate and check CSRF before touching last_seen so a forged state-changing
  // request has no side effect (matching DELETE /api/v1/session).
  const session = await validateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  await verifySessionCsrf(
    deps,
    session,
    request.headers.get(CSRF_HEADER_NAME) ?? undefined,
  );
  await touchSession(deps, session);

  const clientId = singleFormParam(form, "client_id");
  const redirectUri = singleFormParam(form, "redirect_uri");
  const stateRaw = singleFormParam(form, "state");
  const codeChallenge = singleFormParam(form, "code_challenge");
  const codeChallengeMethod = singleFormParam(form, "code_challenge_method");
  const resource = singleFormParam(form, "resource");
  const speakerId = singleFormParam(form, "speaker_id");
  const projectId = singleFormParam(form, "project_id");
  const decision = singleFormParam(form, "decision");

  if (
    clientId === null ||
    redirectUri === null ||
    codeChallenge === null ||
    codeChallengeMethod !== "S256" ||
    !isS256Challenge(codeChallenge) ||
    resource !== base ||
    (stateRaw !== null && !isValidState(stateRaw))
  ) {
    throw new AppError("VALIDATION_ERROR", "Invalid consent request");
  }
  const client = await findActiveClient(deps, clientId);
  if (client === undefined || !client.redirectUris.includes(redirectUri)) {
    throw new AppError("VALIDATION_ERROR", "Invalid consent request");
  }
  const state = stateRaw === null || stateRaw === "" ? null : stateRaw;

  // Denial needs only an exact client/redirect and a valid request; no speaker,
  // project, or scope selection is required to decline.
  if (decision === "deny") {
    return json(200, {
      redirect_to: appendOAuthQuery(redirectUri, {
        error: "access_denied",
        ...(state === null ? {} : { state }),
      }),
    });
  }
  if (decision !== "allow") {
    throw new AppError("VALIDATION_ERROR", "Invalid consent decision");
  }
  if (
    speakerId === null ||
    projectId === null ||
    speakerId === "" ||
    projectId === ""
  ) {
    throw new AppError("VALIDATION_ERROR", "Select a speaker and project");
  }

  const selected = form.getAll("scope");
  if (
    selected.length === 0 ||
    new Set(selected).size !== selected.length ||
    !selected.every((scope) => isOAuthScope(scope))
  ) {
    throw new AppError("VALIDATION_ERROR", "Select at least one supported scope");
  }
  const requestedRaw = singleFormParam(form, "requested_scope");
  const signature = singleFormParam(form, "request_signature");
  if (requestedRaw === null || signature === null || signature === "") {
    throw new AppError("VALIDATION_ERROR", "Invalid consent request");
  }
  let requested: OAuthScope[];
  try {
    requested = parseOAuthScopeString(requestedRaw);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid consent request");
  }
  const signed: AuthorizationRequestSignatureInput = {
    clientId,
    redirectUri,
    state,
    codeChallenge,
    resource,
    scopes: requested,
  };
  if (
    !(await verifyAuthorizationRequestSignature(deps.pepper, signed, signature))
  ) {
    throw new AppError("VALIDATION_ERROR", "Invalid consent request");
  }
  const requestedSet = new Set(requested);
  if (!selected.every((scope) => requestedSet.has(scope as OAuthScope))) {
    throw new AppError("VALIDATION_ERROR", "Scope was not requested");
  }

  const issued = await issueAuthorizationCode(deps, {
    accountId: session.accountId,
    sessionId: session.sessionId,
    clientId,
    redirectUri,
    state,
    codeChallenge,
    resource,
    scopes: selected as OAuthScope[],
    speakerId,
    projectId,
  });
  return json(200, { redirect_to: issued.redirectTo });
}

async function handleToken(
  deps: ServiceDeps,
  request: Request,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  if (options.publicBaseUrl === undefined) return disabledResponse();

  const form = await readForm(request);
  const clientId = singleTokenParam(form, "client_id");
  const grantType = singleTokenParam(form, "grant_type");
  if (clientId === null || clientId === "" || clientId.length > 128) {
    throw new OAuthTokenError("invalid_request");
  }
  // client_id is unauthenticated at this point, so a per-client bucket alone
  // can be bypassed by rotating it. The global bucket bounds the endpoint.
  const perClient = options.tokenLimiter.check(clientId);
  const global = options.tokenGlobalLimiter.check("oauth:token");
  if (!perClient.allowed || !global.allowed) {
    throw new RateLimitError(
      Math.max(perClient.retryAfterSeconds, global.retryAfterSeconds),
    );
  }
  if (grantType === null) throw new OAuthTokenError("invalid_request");

  if (grantType === "authorization_code") {
    const code = singleTokenParam(form, "code");
    const redirectUri = singleTokenParam(form, "redirect_uri");
    const codeVerifier = singleTokenParam(form, "code_verifier");
    const resource = singleTokenParam(form, "resource");
    if (code === null || redirectUri === null || codeVerifier === null) {
      throw new OAuthTokenError("invalid_request");
    }
    return json(
      200,
      await exchangeAuthorizationCode(deps, {
        clientId,
        redirectUri,
        code,
        codeVerifier,
        ...(resource === null ? {} : { resource }),
      }),
    );
  }

  if (grantType === "refresh_token") {
    const refreshToken = singleTokenParam(form, "refresh_token");
    const scope = singleTokenParam(form, "scope");
    if (refreshToken === null) throw new OAuthTokenError("invalid_request");
    return json(
      200,
      await rotateRefreshToken(deps, {
        clientId,
        refreshToken,
        ...(scope === null ? {} : { scope }),
      }),
    );
  }

  throw new OAuthTokenError("unsupported_grant_type");
}

async function handleRevoke(
  deps: ServiceDeps,
  request: Request,
  options: OAuthRouteOptions,
): Promise<Response> {
  if (request.method.toUpperCase() !== "POST") return methodNotAllowed("POST");
  if (options.publicBaseUrl === undefined) return disabledResponse();

  const form = await readForm(request);
  const clientId = singleTokenParam(form, "client_id");
  const token = singleTokenParam(form, "token");
  if (
    clientId === null ||
    clientId === "" ||
    clientId.length > 128 ||
    token === null ||
    token === "" ||
    token.length > 4096
  ) {
    throw new OAuthTokenError("invalid_request");
  }
  await revokeOAuthToken(deps, { clientId, token });
  return new Response(null, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

function handleClientScript(request: Request): Response {
  if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
  return new Response(CLIENT_SCRIPT, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

export async function handleOAuthRoute(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  options: OAuthRouteOptions,
  loginLimiter: RateLimiter,
  requestId: string,
): Promise<Response> {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  if (!isOAuthPath(segments)) {
    return json(404, {
      error: { code: "NOT_FOUND", message: "Not found", request_id: requestId },
    });
  }
  if (options.publicBaseUrl === undefined) return disabledResponse();

  try {
    if (segments[0] === ".well-known") {
      if (request.method.toUpperCase() !== "GET") return methodNotAllowed("GET");
      const base = options.publicBaseUrl;
      if (segments[1] === "oauth-protected-resource") {
        return json(200, {
          resource: base,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
          scopes_supported: [...OAUTH_SCOPES],
        });
      }
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/oauth/authorize`,
        token_endpoint: `${base}/oauth/token`,
        registration_endpoint: `${base}/oauth/register`,
        revocation_endpoint: `${base}/oauth/revoke`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        scopes_supported: [...OAUTH_SCOPES],
      });
    }

    if (segments.length === 2) {
      switch (segments[1]) {
        case "register":
          return await handleRegister(deps, request, options);
        case "authorize":
          return await handleAuthorize(deps, request, url, options);
        case "signin":
          return await handleSignIn(deps, request, loginLimiter, options);
        case "consent":
          return await handleConsent(deps, request, options);
        case "token":
          return await handleToken(deps, request, options);
        case "revoke":
          return await handleRevoke(deps, request, options);
        case "client.js":
          return handleClientScript(request);
        default:
          break;
      }
    }
    return json(404, { error: { code: "NOT_FOUND", message: "Not found", request_id: requestId } });
  } catch (error) {
    if (error instanceof OAuthTokenError) {
      return oauthErrorResponse(400, error.oauthError);
    }
    if (error instanceof OAuthAuthorizeError) {
      return htmlError(400, "Invalid authorization request");
    }
    throw error;
  }
}

// Re-exported for the Node adapter's startup validation and tests.
export {
  DEFAULT_OAUTH_REGISTER_RATE_LIMIT,
  DEFAULT_OAUTH_TOKEN_GLOBAL_RATE_LIMIT,
  DEFAULT_OAUTH_TOKEN_RATE_LIMIT,
  isValidRedirectUri,
  normalizeOAuthBaseUrl,
  oauthBaseUrlFromEnv,
} from "../service/oauth.ts";
