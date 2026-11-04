// OAuth 2.1 authorization-server core (public clients, authorization code +
// PKCE S256, rotating refresh tokens, RFC 7009 revocation).
//
// Access tokens reuse the existing `credentials` table, so every bearer route
// keeps the same authentication and project authorization path. Authorization
// codes and refresh tokens are stored only as a public prefix plus a keyed
// HMAC verifier. No client secret, API key, or raw token is stored or logged.
import { hashSecret, randomBase64url, verifySecret } from "../auth/credentials.ts";
import { digestsEqual } from "../domain/digest.ts";
import { AppError } from "../domain/errors.ts";
import { parseScopeJson, type ServiceDeps } from "./auth.ts";
import { sessionIsActiveById } from "./sessions.ts";

export const OAUTH_ACCESS_PREFIX = "cb_oat_";
export const OAUTH_CODE_PREFIX = "cb_oac_";
export const OAUTH_REFRESH_PREFIX = "cb_ort_";
const PUBLIC_PREFIX_LENGTH = 12;
const TOKEN_BYTES = 32;

export const AUTHORIZATION_CODE_TTL_MS = 5 * 60 * 1000;
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const OAUTH_SCOPES = ["message.read", "message.send"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const S256_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
const UTF8_ENCODER = new TextEncoder();

export const DEFAULT_OAUTH_REGISTER_RATE_LIMIT = { perMinute: 10, burst: 5 };
export const DEFAULT_OAUTH_TOKEN_RATE_LIMIT = { perMinute: 60, burst: 20 };
// A second, global token bucket prevents rotating client_id from bypassing the
// per-client limit. Registration remains one global bucket.
export const DEFAULT_OAUTH_TOKEN_GLOBAL_RATE_LIMIT = { perMinute: 300, burst: 60 };
// Revocation is unauthenticated and scans prefixes; bound it too, while
// preserving RFC 7009's 200 response below the limit.
export const DEFAULT_OAUTH_REVOKE_RATE_LIMIT = { perMinute: 60, burst: 20 };

export class OAuthAuthorizeError extends Error {
  readonly oauthError: string;

  constructor(oauthError: string) {
    super(oauthError);
    this.name = "OAuthAuthorizeError";
    this.oauthError = oauthError;
  }
}

export class OAuthTokenError extends Error {
  readonly oauthError: string;

  constructor(oauthError: string) {
    super(oauthError);
    this.name = "OAuthTokenError";
    this.oauthError = oauthError;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function isOAuthScope(value: string): value is OAuthScope {
  return (OAUTH_SCOPES as readonly string[]).includes(value);
}

function oauthScopesFromJson(value: string): OAuthScope[] {
  const all = parseScopeJson(value);
  return OAUTH_SCOPES.filter((scope) => all.has(scope));
}

export function scopeString(scopes: readonly OAuthScope[]): string {
  return OAUTH_SCOPES.filter((scope) => scopes.includes(scope)).join(" ");
}

// Absent means both supported scopes. An empty, duplicated-unknown, or
// unsupported scope list is rejected rather than silently widened.
export function parseOAuthScopeString(raw: string | null): OAuthScope[] {
  if (raw === null) return [...OAUTH_SCOPES];
  if (raw === "") throw new OAuthAuthorizeError("invalid_scope");
  const selected = new Set<OAuthScope>();
  for (const part of raw.split(" ")) {
    if (!isOAuthScope(part)) throw new OAuthAuthorizeError("invalid_scope");
    selected.add(part);
  }
  if (selected.size === 0) throw new OAuthAuthorizeError("invalid_scope");
  return OAUTH_SCOPES.filter((scope) => selected.has(scope));
}

// Missing config disables the feature at the route layer; a configured value
// must be a plain https origin. Invalid values fail startup/construction and
// never include the value in the error.
export function normalizeOAuthBaseUrl(raw: string): string {
  if (typeof raw !== "string" || raw === "" || raw !== raw.trim()) {
    throw new Error("CORKBOARD_PUBLIC_BASE_URL must be an absolute https origin");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CORKBOARD_PUBLIC_BASE_URL must be an absolute https origin");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname === "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "CORKBOARD_PUBLIC_BASE_URL must be an https origin with no path, query, fragment, or userinfo",
    );
  }
  return url.origin;
}

export function oauthBaseUrlFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const raw = env.CORKBOARD_PUBLIC_BASE_URL;
  if (raw === undefined || raw.trim() === "") return undefined;
  return normalizeOAuthBaseUrl(raw);
}

// HTTPS only, except loopback HTTP for local public clients (RFC 8252).
export function isValidRedirectUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 2048 ||
    CONTROL_CHARS.test(value)
  ) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash !== "" || url.username !== "" || url.password !== "") return false;
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") {
    return url.hostname === "127.0.0.1" || url.hostname === "localhost";
  }
  return false;
}

export function isValidState(value: string): boolean {
  return value.length <= 512 && !CONTROL_CHARS.test(value);
}

export function isS256Challenge(value: unknown): value is string {
  return typeof value === "string" && S256_CHALLENGE.test(value);
}

export async function s256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", UTF8_ENCODER.encode(verifier));
  return base64url(new Uint8Array(digest));
}

// The single stored hash binds the authorization code to the S256 verifier
// output, so both must be presented together. Comparison is fixed-length.
export async function pkceHash(
  code: string,
  challenge: string,
  pepper: Uint8Array,
): Promise<string> {
  return hashSecret(`${code}\n${challenge}`, pepper);
}

function newOAuthToken(prefix: string): string {
  return prefix + randomBase64url(TOKEN_BYTES);
}

function tokenPrefix(token: string): string {
  return token.slice(0, PUBLIC_PREFIX_LENGTH);
}

export interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: "none";
  grantTypes: string[];
  responseTypes: string[];
  createdAt: string;
}

export interface OAuthClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  status: string;
}

export interface ClientRegistrationInput {
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
}

function stringArray(value: unknown, field: string, maxItems: number): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxItems) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a non-empty array`);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new AppError("VALIDATION_ERROR", `${field} must contain strings`);
    }
    items.push(item);
  }
  return items;
}

// RFC 7591 metadata for a public client. Unknown metadata is ignored; the
// security-relevant fields must be consistent with this server's only mode.
export function validateClientRegistration(
  body: Record<string, unknown>,
): ClientRegistrationInput {
  if (
    body.token_endpoint_auth_method !== undefined &&
    body.token_endpoint_auth_method !== "none"
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "token_endpoint_auth_method must be none",
    );
  }

  const redirectUris = stringArray(body.redirect_uris, "redirect_uris", 10);
  const seen = new Set<string>();
  for (const redirectUri of redirectUris) {
    if (!isValidRedirectUri(redirectUri)) {
      throw new AppError("VALIDATION_ERROR", "redirect_uris must be absolute HTTPS URLs without fragments");
    }
    if (seen.has(redirectUri)) {
      throw new AppError("VALIDATION_ERROR", "redirect_uris must not contain duplicates");
    }
    seen.add(redirectUri);
  }

  const clientName = body.client_name;
  if (
    typeof clientName !== "string" ||
    clientName.length < 1 ||
    clientName.length > 100 ||
    CONTROL_CHARS.test(clientName)
  ) {
    throw new AppError("VALIDATION_ERROR", "client_name must be 1-100 printable characters");
  }

  let grantTypes = ["authorization_code", "refresh_token"];
  if (body.grant_types !== undefined) {
    const raw = stringArray(body.grant_types, "grant_types", 2);
    if (!raw.includes("authorization_code")) {
      throw new AppError("VALIDATION_ERROR", "grant_types must include authorization_code");
    }
    for (const grant of raw) {
      if (grant !== "authorization_code" && grant !== "refresh_token") {
        throw new AppError("VALIDATION_ERROR", "unsupported grant_types");
      }
    }
    grantTypes = raw;
  }

  let responseTypes = ["code"];
  if (body.response_types !== undefined) {
    const raw = stringArray(body.response_types, "response_types", 1);
    if (raw.length !== 1 || raw[0] !== "code") {
      throw new AppError("VALIDATION_ERROR", "response_types must be [\"code\"]");
    }
    responseTypes = raw;
  }

  return { clientName, redirectUris, grantTypes, responseTypes };
}

export async function registerClient(
  deps: ServiceDeps,
  input: ClientRegistrationInput,
): Promise<RegisteredClient> {
  const now = deps.now();
  const clientId = `cb_cli_${randomBase64url(24)}`;
  await deps.db.run(
    `INSERT INTO oauth_clients
       (id, client_id, client_name, redirect_uris_json, grant_types_json,
        response_types_json, created_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`,
    [
      `oac_${randomBase64url(16)}`,
      clientId,
      input.clientName,
      JSON.stringify(input.redirectUris),
      JSON.stringify(input.grantTypes),
      JSON.stringify(input.responseTypes),
      now.toISOString(),
    ],
  );
  return {
    clientId,
    clientName: input.clientName,
    redirectUris: input.redirectUris,
    tokenEndpointAuthMethod: "none",
    grantTypes: input.grantTypes,
    responseTypes: input.responseTypes,
    createdAt: now.toISOString(),
  };
}

interface ClientRow {
  client_id: string;
  client_name: string;
  redirect_uris_json: string;
  grant_types_json: string;
  response_types_json: string;
  status: string;
}

function parseStringArray(value: string): string[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === "string")) {
    return undefined;
  }
  return parsed as string[];
}

export async function findActiveClient(
  deps: ServiceDeps,
  clientId: string,
): Promise<OAuthClient | undefined> {
  if (
    typeof clientId !== "string" ||
    clientId.length < 1 ||
    clientId.length > 128 ||
    CONTROL_CHARS.test(clientId)
  ) {
    return undefined;
  }
  const row = await deps.db.first<ClientRow>(
    `SELECT client_id, client_name, redirect_uris_json, grant_types_json,
            response_types_json, status
       FROM oauth_clients WHERE client_id = ? AND status = 'active'`,
    [clientId],
  );
  if (row === undefined) return undefined;
  const redirectUris = parseStringArray(row.redirect_uris_json);
  const grantTypes = parseStringArray(row.grant_types_json);
  const responseTypes = parseStringArray(row.response_types_json);
  if (redirectUris === undefined || grantTypes === undefined || responseTypes === undefined) {
    return undefined;
  }
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    redirectUris,
    grantTypes,
    responseTypes,
    status: row.status,
  };
}

export interface AuthorizationRequest {
  codeChallenge: string;
  resource: string;
  scopes: OAuthScope[];
  state: string | null;
  speakerId: string | null;
  projectId: string | null;
}

function optionalOpaqueId(value: string | null): string | null {
  if (value === null || value === "") return null;
  if (value.length > 128 || CONTROL_CHARS.test(value)) {
    throw new OAuthAuthorizeError("invalid_request");
  }
  return value;
}

// Called only after the client_id and exact redirect_uri have been validated.
export function parseAuthorizationRequest(
  baseUrl: string,
  params: URLSearchParams,
): AuthorizationRequest {
  if (params.get("response_type") !== "code") {
    throw new OAuthAuthorizeError("unsupported_response_type");
  }
  const codeChallenge = params.get("code_challenge");
  if (codeChallenge === null || !isS256Challenge(codeChallenge)) {
    throw new OAuthAuthorizeError("invalid_request");
  }
  if (params.get("code_challenge_method") !== "S256") {
    throw new OAuthAuthorizeError("invalid_request");
  }
  const resource = params.get("resource");
  if (resource !== null && resource !== baseUrl) {
    throw new OAuthAuthorizeError("invalid_target");
  }
  const state = params.get("state");
  if (state !== null && !isValidState(state)) {
    throw new OAuthAuthorizeError("invalid_request");
  }
  return {
    codeChallenge,
    resource: baseUrl,
    scopes: parseOAuthScopeString(params.get("scope")),
    state: state === null || state === "" ? null : state,
    speakerId: optionalOpaqueId(params.get("speaker_id")),
    projectId: optionalOpaqueId(params.get("project_id")),
  };
}

export function appendOAuthQuery(
  redirectUri: string,
  values: Readonly<Record<string, string>>,
): string {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

export interface AuthorizationRequestSignatureInput {
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  scopes: readonly OAuthScope[];
  sessionId: string;
}

// The consent form is stateless. This HMAC binds every authorization-request
// field rendered into it (including the requested scope set), so a consent POST
// cannot silently add a scope or change the client/redirect/challenge between
// the rendered request and the decision.
function authorizationRequestMaterial(input: AuthorizationRequestSignatureInput): string {
  return (
    "corkboard-oauth-request/v1\n" +
    JSON.stringify([
      input.clientId,
      input.redirectUri,
      input.state ?? "",
      input.codeChallenge,
      input.resource,
      scopeString(input.scopes),
      input.sessionId,
    ])
  );
}

export async function signAuthorizationRequest(
  pepper: Uint8Array,
  input: AuthorizationRequestSignatureInput,
): Promise<string> {
  return hashSecret(authorizationRequestMaterial(input), pepper);
}

export async function verifyAuthorizationRequestSignature(
  pepper: Uint8Array,
  input: AuthorizationRequestSignatureInput,
  signature: string,
): Promise<boolean> {
  return digestsEqual(await signAuthorizationRequest(pepper, input), signature);
}

export interface ConsentCandidate {
  speakerId: string;
  speakerName: string;
  projectId: string;
  projectTitle: string;
}

// Only speakers owned by the signed-in account with an active membership whose
// capability set contains every requested scope. No other account's speaker or
// project can appear.
export async function listConsentCandidates(
  deps: ServiceDeps,
  accountId: string,
  scopes: readonly OAuthScope[],
): Promise<ConsentCandidate[]> {
  const rows = await deps.db.all<{
    speaker_id: string;
    display_name: string | null;
    project_id: string;
    title: string;
    capabilities: string;
  }>(
    `SELECT s.id AS speaker_id, s.display_name,
            p.id AS project_id, p.title, m.capabilities
       FROM speakers s
       JOIN project_memberships m
         ON m.speaker_id = s.id AND m.removed_at IS NULL
       JOIN projects p ON p.id = m.project_id AND p.status = 'active'
      WHERE s.owner_account_id = ? AND s.status = 'active'
      ORDER BY p.title ASC, p.id ASC, s.display_name ASC, s.id ASC`,
    [accountId],
  );
  const candidates: ConsentCandidate[] = [];
  for (const row of rows) {
    const capabilities = parseScopeJson(row.capabilities);
    if (!scopes.every((scope) => capabilities.has(scope))) continue;
    candidates.push({
      speakerId: row.speaker_id,
      speakerName: row.display_name ?? row.speaker_id,
      projectId: row.project_id,
      projectTitle: row.title,
    });
  }
  return candidates;
}

export interface ConsentSelection {
  sessionId: string;
  accountId: string;
  clientId: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  scopes: OAuthScope[];
  speakerId: string;
  projectId: string;
}

interface MembershipRow {
  capabilities: string;
  speaker_owner: string | null;
  speaker_status: string;
  project_status: string;
  account_status: string;
}

// Re-reads ownership, membership, project, account, and capabilities from
// storage. The submitted form is never trusted for authorization.
async function loadMembership(
  deps: ServiceDeps,
  projectId: string,
  speakerId: string,
): Promise<MembershipRow | undefined> {
  return deps.db.first<MembershipRow>(
    `SELECT m.capabilities,
            s.owner_account_id AS speaker_owner,
            s.status AS speaker_status,
            p.status AS project_status,
            a.status AS account_status
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN projects p ON p.id = m.project_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL`,
    [projectId, speakerId],
  );
}

function membershipAllows(
  row: MembershipRow | undefined,
  accountId: string,
  scopes: readonly OAuthScope[],
): boolean {
  if (row === undefined) return false;
  if (
    row.speaker_owner !== accountId ||
    row.speaker_status !== "active" ||
    row.project_status !== "active" ||
    row.account_status !== "active"
  ) {
    return false;
  }
  const capabilities = parseScopeJson(row.capabilities);
  return scopes.every((scope) => capabilities.has(scope));
}

export interface IssuedAuthorizationCode {
  code: string;
  redirectTo: string;
}

export async function issueAuthorizationCode(
  deps: ServiceDeps,
  selection: ConsentSelection,
): Promise<IssuedAuthorizationCode> {
  const client = await findActiveClient(deps, selection.clientId);
  if (client === undefined || !client.redirectUris.includes(selection.redirectUri)) {
    throw new AppError("VALIDATION_ERROR", "Unknown client or redirect URI");
  }
  if (selection.scopes.length === 0 || !selection.scopes.every(isOAuthScope)) {
    throw new AppError("VALIDATION_ERROR", "A supported scope is required");
  }
  const membership = await loadMembership(deps, selection.projectId, selection.speakerId);
  if (!membershipAllows(membership, selection.accountId, selection.scopes)) {
    throw new AppError("FORBIDDEN");
  }

  const now = deps.now();
  const code = newOAuthToken(OAUTH_CODE_PREFIX);
  const prefix = tokenPrefix(code);
  await deps.db.run(
    `INSERT INTO oauth_authorization_codes
       (id, client_id, account_id, speaker_id, project_id, session_id, scopes_json,
        code_prefix, code_verifier_hash, redirect_uri, resource, expires_at,
        consumed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    [
      `oac_${randomBase64url(16)}`,
      selection.clientId,
      selection.accountId,
      selection.speakerId,
      selection.projectId,
      selection.sessionId,
      JSON.stringify(selection.scopes),
      prefix,
      await pkceHash(code, selection.codeChallenge, deps.pepper),
      selection.redirectUri,
      selection.resource,
      new Date(now.getTime() + AUTHORIZATION_CODE_TTL_MS).toISOString(),
      now.toISOString(),
    ],
  );
  return {
    code,
    redirectTo: appendOAuthQuery(selection.redirectUri, {
      code,
      ...(selection.state === null ? {} : { state: selection.state }),
    }),
  };
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  /** Absent when the registered client did not request the refresh_token grant. */
  refresh_token?: string;
  scope: string;
}

function tokenResponse(
  accessToken: string,
  refreshToken: string | undefined,
  scopes: readonly OAuthScope[],
): TokenResponse {
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_SECONDS,
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    scope: scopeString(scopes),
  };
}

interface CodeRow {
  id: string;
  client_id: string;
  account_id: string;
  speaker_id: string;
  project_id: string;
  session_id: string;
  scopes_json: string;
  code_verifier_hash: string;
  redirect_uri: string;
  resource: string;
  expires_at: string;
  consumed_at: string | null;
}

async function deleteMintedCredential(deps: ServiceDeps, credentialId: string): Promise<void> {
  await deps.db.run("DELETE FROM oauth_refresh_tokens WHERE credential_id = ?", [credentialId]);
  await deps.db.run("DELETE FROM oauth_token_clients WHERE credential_id = ?", [credentialId]);
  await deps.db.run("DELETE FROM credential_project_grants WHERE credential_id = ?", [
    credentialId,
  ]);
  await deps.db.run("DELETE FROM credentials WHERE id = ?", [credentialId]);
}

async function mintTokens(
  deps: ServiceDeps,
  input: {
    clientId: string;
    speakerId: string;
    projectId: string;
    scopes: readonly OAuthScope[];
    issueRefresh: boolean;
  },
): Promise<TokenResponse> {
  const now = deps.now();
  const accessToken = newOAuthToken(OAUTH_ACCESS_PREFIX);
  const credentialId = `cred_oat_${randomBase64url(16)}`;
  const prefix = tokenPrefix(accessToken);
  await deps.db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json,
        expires_at, revoked_at, last_used_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    [
      credentialId,
      input.speakerId,
      prefix,
      await hashSecret(accessToken, deps.pepper),
      JSON.stringify(input.scopes),
      new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      now.toISOString(),
    ],
  );

  const refreshToken = input.issueRefresh ? newOAuthToken(OAUTH_REFRESH_PREFIX) : undefined;
  // Durability of client ownership must not depend on a refresh row existing.
  try {
    await deps.db.run(
      `INSERT INTO oauth_token_clients (credential_id, client_id, created_at)
       VALUES (?, ?, ?)`,
      [credentialId, input.clientId, now.toISOString()],
    );
    await deps.db.run(
      `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
       VALUES (?, ?, ?)`,
      [credentialId, input.projectId, now.toISOString()],
    );
    if (refreshToken !== undefined) {
      await deps.db.run(
        `INSERT INTO oauth_refresh_tokens
           (id, family_id, client_id, credential_id, token_prefix, token_verifier,
            created_at, expires_at, revoked_at, rotated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
        [
          `ort_${randomBase64url(16)}`,
          `ortf_${randomBase64url(16)}`,
          input.clientId,
          credentialId,
          tokenPrefix(refreshToken),
          await hashSecret(refreshToken, deps.pepper),
          now.toISOString(),
          new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
        ],
      );
    }
  } catch (error) {
    await deleteMintedCredential(deps, credentialId);
    throw error;
  }
  return tokenResponse(accessToken, refreshToken, input.scopes);
}

export async function exchangeAuthorizationCode(
  deps: ServiceDeps,
  input: {
    clientId: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
    resource?: string;
  },
): Promise<TokenResponse> {
  const invalidGrant = (): OAuthTokenError => new OAuthTokenError("invalid_grant");
  if (
    !input.code.startsWith(OAUTH_CODE_PREFIX) ||
    input.code.length <= PUBLIC_PREFIX_LENGTH ||
    !PKCE_VERIFIER.test(input.codeVerifier)
  ) {
    throw invalidGrant();
  }
  const prefix = tokenPrefix(input.code);
  const rows = await deps.db.all<CodeRow>(
    `SELECT id, client_id, account_id, speaker_id, project_id, session_id,
            scopes_json, code_verifier_hash, redirect_uri, resource, expires_at,
            consumed_at
       FROM oauth_authorization_codes WHERE code_prefix = ?`,
    [prefix],
  );
  const challenge = await s256Challenge(input.codeVerifier);
  const presentedHash = await pkceHash(input.code, challenge, deps.pepper);
  let code: CodeRow | undefined;
  for (const row of rows) {
    if (digestsEqual(presentedHash, row.code_verifier_hash)) {
      code = row;
      break;
    }
  }
  if (code === undefined) throw invalidGrant();

  const client = await findActiveClient(deps, input.clientId);
  if (client === undefined || client.clientId !== code.client_id) throw invalidGrant();
  if (code.redirect_uri !== input.redirectUri) throw invalidGrant();
  if (input.resource !== undefined && input.resource !== code.resource) throw invalidGrant();

  const now = deps.now();
  if (code.consumed_at !== null) throw invalidGrant();
  const expiresMs = new Date(code.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) throw invalidGrant();

  const scopes = oauthScopesFromJson(code.scopes_json);
  if (scopes.length === 0) throw invalidGrant();

  // A code is bound to the browser session that consented. Sign-out, session
  // expiry, idle expiry, or account suspension before exchange fails closed.
  if (!(await sessionIsActiveById(deps, code.session_id, code.account_id))) throw invalidGrant();

  // Single use: only the winner of this conditional update may mint tokens.
  const consumed = await deps.db.run(
    `UPDATE oauth_authorization_codes SET consumed_at = ?
      WHERE id = ? AND consumed_at IS NULL`,
    [now.toISOString(), code.id],
  );
  if (consumed.changes !== 1) throw invalidGrant();

  // Revocation, membership removal, or a capability downgrade between consent
  // and exchange fails closed. The code is already burnt.
  const membership = await loadMembership(deps, code.project_id, code.speaker_id);
  if (!membershipAllows(membership, code.account_id, scopes)) throw invalidGrant();

  return mintTokens(deps, {
    clientId: code.client_id,
    speakerId: code.speaker_id,
    projectId: code.project_id,
    scopes,
    // Only a client registered for the refresh grant receives a refresh token.
    issueRefresh: client.grantTypes.includes("refresh_token"),
  });
}

interface RefreshRow {
  id: string;
  family_id: string;
  client_id: string;
  credential_id: string;
  token_verifier: string;
  expires_at: string;
  revoked_at: string | null;
  rotated_at: string | null;
}

interface ConsentState {
  accountId: string;
  speakerId: string;
  projectId: string;
  scopes: OAuthScope[];
}

// One consent creates exactly one credential and one grant. More than one grant
// is an unexpected state for an OAuth access token, so refresh fails closed
// rather than guessing which project the token should keep.
async function loadCredentialConsent(
  deps: ServiceDeps,
  credentialId: string,
): Promise<ConsentState | undefined> {
  const rows = await deps.db.all<{
    speaker_id: string;
    scope_json: string;
    revoked_at: string | null;
    speaker_owner: string | null;
    speaker_status: string;
    account_id: string | null;
    account_status: string | null;
    project_id: string;
    project_status: string;
    capabilities: string | null;
    removed_at: string | null;
  }>(
    `SELECT c.speaker_id, c.scope_json, c.revoked_at,
            s.owner_account_id AS speaker_owner, s.status AS speaker_status,
            a.id AS account_id, a.status AS account_status,
            p.id AS project_id, p.status AS project_status,
            m.capabilities, m.removed_at
       FROM credentials c
       JOIN speakers s ON s.id = c.speaker_id
       LEFT JOIN accounts a ON a.id = s.owner_account_id
       JOIN credential_project_grants g ON g.credential_id = c.id
       JOIN projects p ON p.id = g.project_id
       LEFT JOIN project_memberships m
         ON m.project_id = p.id AND m.speaker_id = c.speaker_id
      WHERE c.id = ?`,
    [credentialId],
  );
  if (rows.length !== 1) return undefined;
  const row = rows[0];
  if (row === undefined) return undefined;
  if (
    row.revoked_at !== null ||
    row.speaker_owner === null ||
    row.account_id === null ||
    row.speaker_status !== "active" ||
    row.account_status !== "active" ||
    row.project_status !== "active" ||
    row.removed_at !== null ||
    row.capabilities === null
  ) {
    return undefined;
  }
  const scopes = oauthScopesFromJson(row.scope_json);
  if (scopes.length === 0) return undefined;
  const capabilities = parseScopeJson(row.capabilities);
  if (!scopes.every((scope) => capabilities.has(scope))) return undefined;
  return {
    accountId: row.account_id,
    speakerId: row.speaker_id,
    projectId: row.project_id,
    scopes,
  };
}

async function revokeFamiliesForCredential(
  deps: ServiceDeps,
  credentialId: string,
): Promise<void> {
  const now = deps.now().toISOString();
  await deps.db.run(
    "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE credential_id = ? AND revoked_at IS NULL",
    [now, credentialId],
  );
  await deps.db.run(
    "UPDATE credentials SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    [now, credentialId],
  );
}

export async function rotateRefreshToken(
  deps: ServiceDeps,
  input: { clientId: string; refreshToken: string; scope?: string },
): Promise<TokenResponse> {
  const invalidGrant = (): OAuthTokenError => new OAuthTokenError("invalid_grant");
  if (
    !input.refreshToken.startsWith(OAUTH_REFRESH_PREFIX) ||
    input.refreshToken.length <= PUBLIC_PREFIX_LENGTH
  ) {
    throw invalidGrant();
  }

  // The client must still be active and registered for the refresh grant before
  // any token row is consulted. A client registered only for authorization_code
  // cannot use refresh_token.
  const client = await findActiveClient(deps, input.clientId);
  if (client === undefined) throw invalidGrant();
  if (!client.grantTypes.includes("refresh_token")) {
    throw new OAuthTokenError("unauthorized_client");
  }

  const prefix = tokenPrefix(input.refreshToken);
  const rows = await deps.db.all<RefreshRow>(
    `SELECT id, family_id, client_id, credential_id, token_verifier,
            expires_at, revoked_at, rotated_at
       FROM oauth_refresh_tokens WHERE token_prefix = ?`,
    [prefix],
  );
  let token: RefreshRow | undefined;
  for (const row of rows) {
    if (await verifySecret(input.refreshToken, prefix, row.token_verifier, deps.pepper)) {
      token = row;
      break;
    }
  }
  if (token === undefined) throw invalidGrant();
  // A wrong client never revokes someone else's family.
  if (client.clientId !== token.client_id) throw invalidGrant();

  const now = deps.now();
  if (token.revoked_at !== null || token.rotated_at !== null) {
    // Reuse of an already rotated/revoked value revokes the whole family.
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw invalidGrant();
  }
  const expiresMs = new Date(token.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= now.getTime()) {
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw invalidGrant();
  }

  const consent = await loadCredentialConsent(deps, token.credential_id);
  if (consent === undefined) {
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw invalidGrant();
  }

  // Never issue a token with scope broader than the original consent. This
  // slice does not downscope; an unequal requested set is rejected.
  if (input.scope !== undefined) {
    let requested: OAuthScope[];
    try {
      requested = parseOAuthScopeString(input.scope);
    } catch {
      throw new OAuthTokenError("invalid_scope");
    }
    if (scopeString(requested) !== scopeString(consent.scopes)) {
      throw new OAuthTokenError("invalid_scope");
    }
  }

  const nowIso = now.toISOString();
  const rotated = await deps.db.run(
    `UPDATE oauth_refresh_tokens SET rotated_at = ?
      WHERE id = ? AND rotated_at IS NULL AND revoked_at IS NULL`,
    [nowIso, token.id],
  );
  if (rotated.changes !== 1) {
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw invalidGrant();
  }

  const accessToken = newOAuthToken(OAUTH_ACCESS_PREFIX);
  const accessPrefix = tokenPrefix(accessToken);
  const updated = await deps.db.run(
    `UPDATE credentials
        SET public_prefix = ?, secret_verifier = ?, expires_at = ?
      WHERE id = ? AND revoked_at IS NULL`,
    [
      accessPrefix,
      await hashSecret(accessToken, deps.pepper),
      new Date(now.getTime() + ACCESS_TOKEN_TTL_SECONDS * 1000).toISOString(),
      token.credential_id,
    ],
  );
  if (updated.changes !== 1) {
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw invalidGrant();
  }

  const refreshToken = newOAuthToken(OAUTH_REFRESH_PREFIX);
  const refreshPrefix = tokenPrefix(refreshToken);
  try {
    await deps.db.run(
      `INSERT INTO oauth_refresh_tokens
         (id, family_id, client_id, credential_id, token_prefix, token_verifier,
          created_at, expires_at, revoked_at, rotated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
      [
        `ort_${randomBase64url(16)}`,
        token.family_id,
        token.client_id,
        token.credential_id,
        refreshPrefix,
        await hashSecret(refreshToken, deps.pepper),
        nowIso,
        new Date(now.getTime() + REFRESH_TOKEN_TTL_MS).toISOString(),
      ],
    );
  } catch (error) {
    await revokeFamiliesForCredential(deps, token.credential_id);
    throw error;
  }
  return tokenResponse(accessToken, refreshToken, consent.scopes);
}

// RFC 7009: a well-formed request is always a 200. Unknown tokens, mismatched
// clients, and speaker tokens are silent no-ops, so this is not an oracle.
export async function revokeOAuthToken(
  deps: ServiceDeps,
  input: { clientId: string; token: string },
): Promise<void> {
  if (input.token.startsWith(OAUTH_REFRESH_PREFIX) && input.token.length > PUBLIC_PREFIX_LENGTH) {
    const prefix = tokenPrefix(input.token);
    const rows = await deps.db.all<RefreshRow>(
      `SELECT id, family_id, client_id, credential_id, token_verifier,
              expires_at, revoked_at, rotated_at
         FROM oauth_refresh_tokens WHERE token_prefix = ?`,
      [prefix],
    );
    for (const row of rows) {
      if (!(await verifySecret(input.token, prefix, row.token_verifier, deps.pepper))) continue;
      if (row.client_id !== input.clientId) return;
      await revokeFamiliesForCredential(deps, row.credential_id);
      return;
    }
    return;
  }

  if (input.token.startsWith(OAUTH_ACCESS_PREFIX) && input.token.length > PUBLIC_PREFIX_LENGTH) {
    const prefix = tokenPrefix(input.token);
    const rows = await deps.db.all<{ id: string; secret_verifier: string }>(
      "SELECT id, secret_verifier FROM credentials WHERE public_prefix = ?",
      [prefix],
    );
    for (const row of rows) {
      if (!(await verifySecret(input.token, prefix, row.secret_verifier, deps.pepper))) continue;
      // Only an OAuth-issued credential belonging to this client is revocable
      // through this endpoint; a regular speaker token is ignored above.
      const owned = await deps.db.first<{ present: number }>(
        `SELECT 1 AS present FROM oauth_token_clients
          WHERE credential_id = ? AND client_id = ? LIMIT 1`,
        [row.id, input.clientId],
      );
      if (owned === undefined) return;
      await revokeFamiliesForCredential(deps, row.id);
      return;
    }
  }
}

// Used by /oauth/consent to validate the resource against the configured
// authorization server without exposing the base URL to the service layer.
export function resourceMatches(resource: string, baseUrl: string): boolean {
  return resource === baseUrl;
}

// Not exported as a general-purpose scope helper: only the two OAuth scopes
// exist here regardless of the broader membership scope vocabulary.
export function isSupportedScopeSet(scopes: readonly string[]): scopes is OAuthScope[] {
  return scopes.length > 0 && scopes.every((scope) => isOAuthScope(scope));
}
