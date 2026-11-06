// Platform-neutral HTTP handlers over Web Request/Response. Every data route
// reuses the service authorization layer; no parallel authz path exists here.
import { SCOPES, type Scope } from "../domain/authz.ts";
import { AppError, RateLimitError, type ErrorCode } from "../domain/errors.ts";
import { sha256Hex } from "../domain/digest.ts";
import { normalizeEmail, validateLoginPassword } from "../domain/validation.ts";
import { createMcpEndpoint } from "../mcp/http.ts";
import {
  clearedCookie,
  csrfCookie,
  sessionCookie,
} from "./cookies.ts";
import { json, noContent, randomRequestId } from "./responses.ts";
import {
  DEFAULT_OAUTH_REGISTER_RATE_LIMIT,
  DEFAULT_OAUTH_REVOKE_RATE_LIMIT,
  DEFAULT_OAUTH_TOKEN_GLOBAL_RATE_LIMIT,
  DEFAULT_OAUTH_TOKEN_RATE_LIMIT,
  handleOAuthRoute,
  isOAuthPath,
  normalizeOAuthBaseUrl,
  type OAuthRouteOptions,
} from "./oauth.ts";
import {
  DEFAULT_LOGIN_RATE_LIMIT,
  DEFAULT_RATE_LIMIT,
  RateLimiter,
  type RateLimitConfig,
} from "./rate-limit.ts";
import {
  MetricsRegistry,
  metricsAuthorized,
  normalizeMetricsToken,
  routeLabelFor,
} from "./metrics.ts";
import {
  authenticateBearer,
  authorizeProject,
  type Principal,
  type ServiceDeps,
} from "../service/auth.ts";
import { getPrincipalIdentity } from "../service/identity.ts";
import {
  CSRF_COOKIE_NAME,
  CSRF_HEADER_NAME,
  SESSION_COOKIE_NAME,
  authenticateSession,
  loginAccount,
  recordLoginRateLimited,
  revokeSession,
  sessionTokenFromCookie,
} from "../service/sessions.ts";
import { getProjectStats, listProjects } from "../service/projects.ts";
import {
  getMessage,
  getMessageBody,
  listMessages,
  markRead,
  sendMessage,
  type ListMessagesQuery,
  type MessageMetadata,
} from "../service/messages.ts";
import { expireMessageBody } from "../service/expiry.ts";
import { handleWebRoute, isWebPath } from "./web.ts";

export const MAX_REQUEST_BODY_BYTES = 64 * 1024;
const MAX_LIMIT = 100;
const DECODER = new TextDecoder();
const EMAIL_ENCODER = new TextEncoder();

const FORBIDDEN_SEND_FIELDS: ReadonlySet<string> = new Set([
  "speaker_id",
  "seq",
  "received_at",
  "committed_at",
]);

export interface RequestLogEntry {
  requestId: string;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  errorCode?: string;
  speakerId?: string;
  accountId?: string;
}

export interface CreateAppOptions {
  logger?: (entry: RequestLogEntry) => void;
  /** Per-credential limits; defaults to 120/minute with burst 30. */
  rateLimit?: RateLimitConfig;
  /** Injectable clock (milliseconds) for deterministic limiter tests. */
  rateLimitNow?: () => number;
  /** Test seam for the bounded bucket map. */
  rateLimitMaxKeys?: number;
  /** Test seam for idle bucket eviction. */
  rateLimitIdleMs?: number;
  /** Process-local registry; a fresh one is created when omitted. */
  metrics?: MetricsRegistry;
  /** Enables `GET /metrics`; omitted or undefined disables it (404). */
  metricsToken?: string;
  /** Injectable clock (milliseconds) for deterministic latency tests. */
  metricsNow?: () => number;
  /**
   * Per-normalized-email login-attempt limiter. Defaults to 10/minute with
   * burst 5. Bounded and process-local like the per-credential limiter.
   */
  loginRateLimit?: RateLimitConfig;
  /** Injectable clock (milliseconds) for deterministic login-limit tests. */
  loginRateLimitNow?: () => number;
  loginRateLimitMaxKeys?: number;
  loginRateLimitIdleMs?: number;
  /**
   * OAuth authorization-server base URL (`https://host`, no path/query/hash).
   * Omitted/undefined disables every OAuth route with a fixed 503; an invalid
   * value fails construction. The Node adapter validates it at startup.
   */
  publicBaseUrl?: string;
  oauthRegisterRateLimit?: RateLimitConfig;
  oauthTokenRateLimit?: RateLimitConfig;
  /** Endpoint-wide token bucket; bounds rotating unauthenticated client_id. */
  oauthTokenGlobalRateLimit?: RateLimitConfig;
  oauthRevokeRateLimit?: RateLimitConfig;
  /** Injectable clock (milliseconds) for deterministic OAuth limit tests. */
  oauthRateLimitNow?: () => number;
  oauthRateLimitMaxKeys?: number;
  oauthRateLimitIdleMs?: number;
}

interface RequestContext {
  principal?: Principal;
  /** Cookie routes do not issue a Bearer challenge on 401. */
  suppressBearerChallenge?: boolean;
}

interface ProjectRow {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
}

function errorBody(code: ErrorCode, message: string, requestId: string): unknown {
  return { error: { code, message, request_id: requestId } };
}

function errorResponse(
  error: AppError,
  requestId: string,
  bearerChallenge = true,
): Response {
  const extra: Record<string, string> = {};
  if (error.code === "UNAUTHENTICATED" && bearerChallenge) {
    extra["www-authenticate"] = "Bearer";
  }
  if (error instanceof RateLimitError) {
    extra["retry-after"] = String(error.retryAfterSeconds);
  }
  return json(error.httpStatus, errorBody(error.code, error.message, requestId), extra);
}

// Adapters that reject an oversized stream before building a Request use the
// same envelope and headers as in-app validation.
export function requestTooLargeResponse(): Response {
  return errorResponse(new AppError("REQUEST_TOO_LARGE"), randomRequestId());
}

function notFound(requestId: string): Response {  return json(404, errorBody("NOT_FOUND", "Not found", requestId));
}

function methodNotAllowed(allow: string, requestId: string): Response {
  return json(405, errorBody("NOT_FOUND", "Method not allowed", requestId), { allow });
}

// Readiness probes the real dependencies on every request: one cheap SQLite
// statement and the configured blob store's non-mutating check. Failures are
// swallowed here so the response can never carry a driver message or path.
async function dependenciesReady(deps: ServiceDeps): Promise<boolean> {
  try {
    await deps.db.first("SELECT 1 AS ready");
    await deps.blobs.checkReady?.();
    return true;
  } catch {
    return false;
  }
}

// Records the authenticated principal for sanitized request logging.
async function authenticate(
  deps: ServiceDeps,
  request: Request,
  context: RequestContext,
  limiter: RateLimiter,
): Promise<Principal> {
  const principal = await authenticateBearer(
    deps,
    request.headers.get("authorization") ?? undefined,
  );
  context.principal = principal;
  // Limit only authenticated principals, after auth and before any handler or
  // body parsing. Unauthenticated requests are never keyed; bearer tokens are
  // 256-bit, so per-IP limiting is left to the reverse proxy.
  const decision = limiter.check(principal.credentialId);
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  return principal;
}

// Login is the only unauthenticated state-changing route. Requiring a JSON
// media type blocks simple cross-site form/text posts; without CORS a browser
// cannot send application/json cross-origin without a preflight.
function requireJsonContentType(request: Request): void {
  const raw = request.headers.get("content-type");
  const mediaType = raw === null ? "" : (raw.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new AppError("VALIDATION_ERROR", "Content-Type must be application/json");
  }
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppError("VALIDATION_ERROR", "Invalid Content-Length");
    }
    if (length > MAX_REQUEST_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_REQUEST_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");

  let parsed: unknown;
  try {
    parsed = JSON.parse(DECODER.decode(bytes));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Malformed JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new AppError("VALIDATION_ERROR", "Body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

function optionalInt(
  value: string | null,
  name: string,
  min: number,
  max: number,
): number | undefined {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new AppError("VALIDATION_ERROR", `${name} must be an integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AppError("VALIDATION_ERROR", `${name} must be ${min}-${max}`);
  }
  return parsed;
}

function optionalBoolean(value: string | null, name: string): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new AppError("VALIDATION_ERROR", `${name} must be true or false`);
}

function scopeList(scopes: ReadonlySet<Scope>): Scope[] {
  return SCOPES.filter((scope) => scopes.has(scope));
}

function projectJson(row: ProjectRow, includeUpdatedAt: boolean): Record<string, unknown> {
  const project: Record<string, unknown> = {
    id: row.id,
    title: row.title,
    summary: row.summary,
    status: row.status,
    created_at: row.created_at,
  };
  if (includeUpdatedAt) project.updated_at = row.updated_at;
  return project;
}

function messageJson(message: MessageMetadata): Record<string, unknown> {
  return {
    message_id: message.messageId,
    project_id: message.projectId,
    seq: message.seq,
    sender: {
      id: message.sender.speakerId,
      display_name: message.sender.displayName,
    },
    summary: message.summary,
    type: message.type,
    language: message.language,
    reply_to_id: message.replyToId,
    body_state: message.bodyState,
    body_expires_at: message.bodyExpiresAt,
    client_sent_at: message.clientSentAt,
    received_at: message.receivedAt,
    committed_at: message.committedAt,
  };
}

function isCompressionField(name: string): boolean {
  return name === "compression" || name.startsWith("compression_");
}

async function handleMe(deps: ServiceDeps, principal: Principal): Promise<Response> {
  const identity = await getPrincipalIdentity(deps, principal);
  const projects = principal.scopes.has("project.read")
    ? await deps.db.all<{ id: string }>(
        `SELECT p.id
           FROM projects p
           JOIN project_memberships m ON m.project_id = p.id
           JOIN credential_project_grants g
             ON g.project_id = p.id AND g.credential_id = ?
          WHERE m.speaker_id = ? AND m.removed_at IS NULL AND p.status = 'active'
            AND instr(m.capabilities, '"project.read"') > 0
          ORDER BY p.created_at ASC, p.id ASC`,
        [principal.credentialId, principal.speakerId],
      )
    : [];
  return json(200, {
    ...identity,
    projects: projects.map((project) => project.id),
  });
}

async function handleSessionLogin(
  deps: ServiceDeps,
  request: Request,
  limiter: RateLimiter,
): Promise<Response> {
  requireJsonContentType(request);
  const body = await readJsonObject(request);
  const email = normalizeEmail(body.email);
  const password = validateLoginPassword(body.password);
  // Keying by the email digest keeps the bucket map free of addresses. This is
  // process-local and runs before account lookup or password verification.
  const decision = limiter.check(await sha256Hex(EMAIL_ENCODER.encode(email)));
  if (!decision.allowed) {
    await recordLoginRateLimited(deps);
    throw new RateLimitError(decision.retryAfterSeconds);
  }

  const login = await loginAccount(deps, { email, password });
  return json(
    200,
    { account: { id: login.accountId, email: login.email } },
    { "set-cookie": [sessionCookie(login.token), csrfCookie(login.csrfToken)] },
  );
}

async function handleSessionGet(deps: ServiceDeps, request: Request): Promise<Response> {
  const principal = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  return json(200, { account: { id: principal.accountId, email: principal.email } });
}

async function handleSessionDelete(deps: ServiceDeps, request: Request): Promise<Response> {
  await revokeSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
    request.headers.get(CSRF_HEADER_NAME) ?? undefined,
  );
  return noContent({
    "set-cookie": [
      clearedCookie(SESSION_COOKIE_NAME, true),
      clearedCookie(CSRF_COOKIE_NAME, false),
    ],
  });
}

async function handleProjectList(
  deps: ServiceDeps,
  principal: Principal,
  url: URL,
): Promise<Response> {
  const limit = optionalInt(url.searchParams.get("limit"), "limit", 1, MAX_LIMIT);
  return json(
    200,
    await listProjects(deps, principal, {
      cursor: url.searchParams.get("cursor"),
      ...(limit === undefined ? {} : { limit }),
    }),
  );
}

async function handleProjectDetail(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<Response> {
  const access = await authorizeProject(deps, principal, projectId, "project.read");
  const row = await deps.db.first<ProjectRow>(
    `SELECT id, title, summary, status, created_at, updated_at
       FROM projects WHERE id = ?`,
    [projectId],
  );
  if (row === undefined) throw new AppError("NOT_FOUND");
  return json(200, {
    project: projectJson(row, true),
    capabilities: scopeList(access.rights),
  });
}

async function handleProjectStats(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<Response> {
  const stats = await getProjectStats(deps, principal, projectId);
  return json(200, {
    project_id: stats.projectId,
    messages: stats.messages,
    unread: stats.unread,
  });
}

async function handleSendMessage(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  request: Request,
  metrics: MetricsRegistry,
): Promise<Response> {
  // Authorization precedes body parsing so denied callers learn nothing about
  // payload validity. sendMessage repeats this check after its own validation.
  await authorizeProject(deps, principal, projectId, "message.send");

  const body = await readJsonObject(request);
  for (const name of Object.keys(body)) {
    if (FORBIDDEN_SEND_FIELDS.has(name) || isCompressionField(name)) {
      throw new AppError("VALIDATION_ERROR", `${name} is assigned by the server`);
    }
  }

  const replyTo = body.reply_to_id === undefined || body.reply_to_id === null
    ? null
    : (body.reply_to_id as string);
  const clientSentAt = body.client_sent_at === undefined || body.client_sent_at === null
    ? null
    : (body.client_sent_at as string);
  const bodyExpiresAt = body.body_expires_at === undefined || body.body_expires_at === null
    ? null
    : (body.body_expires_at as string);

  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  // A prior row means this is a replay of an already accepted request.
  const replay =
    idempotencyKey !== "" &&
    (await deps.db.first(
      `SELECT 1 AS present FROM idempotency_keys
        WHERE speaker_id = ? AND project_id = ? AND key = ?`,
      [principal.speakerId, projectId, idempotencyKey],
    )) !== undefined;

  const result = await sendMessage(deps, principal, projectId, idempotencyKey, {
    summary: body.summary as string,
    type: body.type as string,
    language: body.language as string,
    text: body.text as string,
    bodyDigest: body.body_digest as string,
    replyToId: replyTo,
    clientSentAt,
    bodyExpiresAt,
  });
  // Only a finalization this request performed is a queue-to-commit sample; a
  // replay of an older commit must not look like a long queue delay.
  if (result.queueToCommitMs !== undefined) {
    try {
      metrics.recordQueueToCommit(result.queueToCommitMs);
    } catch {
      // Recording is best effort and must not change the response.
    }
  }
  return json(replay ? 200 : 201, {
    message_id: result.messageId,
    project_id: result.projectId,
    seq: result.seq,
    committed_at: result.committedAt,
    body_state: result.bodyState,
    digest: result.digest,
  });
}

function listQueryFrom(url: URL): ListMessagesQuery {
  const query: ListMessagesQuery = {};
  const afterSeq = optionalInt(url.searchParams.get("after_seq"), "after_seq", 0, Number.MAX_SAFE_INTEGER);
  if (afterSeq !== undefined) query.afterSeq = afterSeq;
  const beforeSeq = optionalInt(url.searchParams.get("before_seq"), "before_seq", 0, Number.MAX_SAFE_INTEGER);
  if (beforeSeq !== undefined) query.beforeSeq = beforeSeq;
  const limit = optionalInt(url.searchParams.get("limit"), "limit", 1, MAX_LIMIT);
  if (limit !== undefined) query.limit = limit;
  const unread = optionalBoolean(url.searchParams.get("unread"), "unread");
  if (unread !== undefined) query.unread = unread;

  const type = url.searchParams.get("type");
  if (type !== null) query.type = type;
  const sender = url.searchParams.get("sender");
  if (sender !== null) query.sender = sender;
  const q = url.searchParams.get("q");
  if (q !== null) query.q = q;
  return query;
}

async function route(
  deps: ServiceDeps,
  request: Request,
  requestId: string,
  context: RequestContext,
  mcp: ReturnType<typeof createMcpEndpoint>,
  limiter: RateLimiter,
  loginLimiter: RateLimiter,
  metrics: MetricsRegistry,
  metricsToken: string | undefined,
  oauth: OAuthRouteOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const method = request.method.toUpperCase();

  if (segments.length === 1 && segments[0] === "mcp") {
    // Authentication precedes every MCP protocol action, including session
    // creation. Missing/invalid credentials never reach the SDK transport.
    if (method !== "POST" && method !== "GET" && method !== "DELETE") {
      return methodNotAllowed("POST, GET, DELETE", requestId);
    }
    const principal = await authenticate(deps, request, context, limiter);
    return mcp.handle(request, principal);
  }

  if (segments.length === 1 && segments[0] === "healthz") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    return json(200, { status: "ok" });
  }

  if (segments.length === 1 && segments[0] === "readyz") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    return (await dependenciesReady(deps))
      ? json(200, { status: "ready" })
      : json(503, { status: "unavailable" });
  }

  if (segments.length === 1 && segments[0] === "metrics") {
    // Disabled and unauthorized requests are indistinguishable from an unknown
    // route, so the endpoint's existence is not disclosed. It is operator-only
    // and never touches the per-credential rate limiter.
    if (metricsToken === undefined) return notFound(requestId);
    if (!(await metricsAuthorized(request.headers.get("authorization"), metricsToken))) {
      return notFound(requestId);
    }
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    return json(200, metrics.snapshot());
  }

  // Public OAuth discovery, registration, authorization, and token routes use
  // the account session (not a bearer credential) and their own limiters.
  if (isOAuthPath(segments)) {
    return handleOAuthRoute(deps, request, url, oauth, loginLimiter, requestId);
  }

  // Human dashboard pages render HTML and use the account session, never a
  // bearer credential. They share the login attempt limiter.
  if (isWebPath(segments)) {
    return handleWebRoute(deps, request, url, loginLimiter);
  }

  const isApi = segments[0] === "api" && segments[1] === "v1";
  if (!isApi) return notFound(requestId);

  // Human session routes consult the session cookie only. They never fall back
  // to a bearer credential, and bearer routes never accept a session cookie.
  if (segments.length === 3 && segments[2] === "session") {
    context.suppressBearerChallenge = true;
    if (method === "POST") return handleSessionLogin(deps, request, loginLimiter);
    if (method === "GET") return handleSessionGet(deps, request);
    if (method === "DELETE") return handleSessionDelete(deps, request);
    return methodNotAllowed("POST, GET, DELETE", requestId);
  }

  if (segments.length === 3 && segments[2] === "me") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    return handleMe(deps, principal);
  }

  if (segments.length === 3 && segments[2] === "projects") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    return handleProjectList(deps, principal, url);
  }

  if (segments[2] !== "projects" || segments.length < 4) return notFound(requestId);
  const projectId = segments[3] ?? "";

  if (segments.length === 4) {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    return handleProjectDetail(deps, principal, projectId);
  }

  if (segments.length === 5 && segments[4] === "stats") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    return handleProjectStats(deps, principal, projectId);
  }

  if (segments[4] !== "messages") return notFound(requestId);

  if (segments.length === 5) {
    if (method !== "GET" && method !== "POST") {
      return methodNotAllowed("GET, POST", requestId);
    }
    const principal = await authenticate(deps, request, context, limiter);
    if (method === "POST") {
      return handleSendMessage(deps, principal, projectId, request, metrics);
    }
    const result = await listMessages(deps, principal, projectId, listQueryFrom(url));
    return json(200, {
      messages: result.messages.map(messageJson),
      next_cursor: result.nextCursor,
    });
  }

  const messageId = segments[5] ?? "";
  if (segments.length === 6) {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    const message = await getMessage(deps, principal, projectId, messageId);
    const receipts = await deps.db.all<{ speaker_id: string; read_at: string }>(
      `SELECT r.speaker_id, r.read_at
         FROM message_receipts r
         JOIN messages m ON m.id = r.message_id
        WHERE r.message_id = ? AND m.project_id = ?
        ORDER BY r.read_at ASC, r.speaker_id ASC`,
      [messageId, projectId],
    );
    return json(200, {
      ...messageJson(message),
      read_by: receipts.map((receipt) => ({
        speaker_id: receipt.speaker_id,
        read_at: receipt.read_at,
      })),
    });
  }

  if (segments.length === 7 && segments[6] === "body") {
    if (method !== "GET") return methodNotAllowed("GET", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    const body = await getMessageBody(deps, principal, projectId, messageId);
    return json(200, {
      message_id: body.messageId,
      text: body.text,
      compression: body.compression,
      digest: body.digest,
    });
  }

  if (segments.length === 7 && segments[6] === "read") {
    if (method !== "POST") return methodNotAllowed("POST", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    const receipt = await markRead(deps, principal, projectId, messageId);
    return json(200, {
      message_id: receipt.messageId,
      speaker_id: receipt.speakerId,
      read_at: receipt.readAt,
    });
  }

  if (segments.length === 7 && segments[6] === "expire") {
    if (method !== "POST") return methodNotAllowed("POST", requestId);
    const principal = await authenticate(deps, request, context, limiter);
    const result = await expireMessageBody(deps, principal, projectId, messageId);
    return json(200, {
      message_id: result.messageId,
      body_state: result.bodyState,
    });
  }

  return notFound(requestId);
}

// Reads only the stable error code from a JSON error envelope. Message text and
// all other body content stay out of the log.
async function errorCodeFrom(response: Response): Promise<string | undefined> {
  try {
    const parsed: unknown = await response.clone().json();
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const error = (parsed as { error?: unknown }).error;
    if (typeof error !== "object" || error === null) return undefined;
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

export function createApp(
  deps: ServiceDeps,
  options: CreateAppOptions = {},
): (request: Request) => Promise<Response> {
  // Validate at the construction boundary too, so a direct caller cannot
  // enable an empty/whitespace or sub-minimum token by bypassing env parsing.
  const metricsToken = normalizeMetricsToken(options.metricsToken);
  const metrics = options.metrics ?? new MetricsRegistry();
  const mcp = createMcpEndpoint(deps, {
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    metrics,
  });
  const limiter = new RateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT, {
    ...(options.rateLimitNow === undefined ? {} : { now: options.rateLimitNow }),
    ...(options.rateLimitMaxKeys === undefined ? {} : { maxKeys: options.rateLimitMaxKeys }),
    ...(options.rateLimitIdleMs === undefined ? {} : { idleMs: options.rateLimitIdleMs }),
  });
  const loginLimiter = new RateLimiter(options.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT, {
    ...(options.loginRateLimitNow === undefined ? {} : { now: options.loginRateLimitNow }),
    ...(options.loginRateLimitMaxKeys === undefined
      ? {}
      : { maxKeys: options.loginRateLimitMaxKeys }),
    ...(options.loginRateLimitIdleMs === undefined
      ? {}
      : { idleMs: options.loginRateLimitIdleMs }),
  });
  // OAuth is optional: no base URL means its routes answer with a fixed 503.
  // An invalid configured URL throws here, before any route can serve.
  const oauthOptions: OAuthRouteOptions = {
    publicBaseUrl:
      options.publicBaseUrl === undefined
        ? undefined
        : normalizeOAuthBaseUrl(options.publicBaseUrl),
    registerLimiter: new RateLimiter(
      options.oauthRegisterRateLimit ?? DEFAULT_OAUTH_REGISTER_RATE_LIMIT,
      {
        ...(options.oauthRateLimitNow === undefined ? {} : { now: options.oauthRateLimitNow }),
        ...(options.oauthRateLimitMaxKeys === undefined
          ? {}
          : { maxKeys: options.oauthRateLimitMaxKeys }),
        ...(options.oauthRateLimitIdleMs === undefined
          ? {}
          : { idleMs: options.oauthRateLimitIdleMs }),
      },
    ),
    tokenLimiter: new RateLimiter(
      options.oauthTokenRateLimit ?? DEFAULT_OAUTH_TOKEN_RATE_LIMIT,
      {
        ...(options.oauthRateLimitNow === undefined ? {} : { now: options.oauthRateLimitNow }),
        ...(options.oauthRateLimitMaxKeys === undefined
          ? {}
          : { maxKeys: options.oauthRateLimitMaxKeys }),
        ...(options.oauthRateLimitIdleMs === undefined
          ? {}
          : { idleMs: options.oauthRateLimitIdleMs }),
      },
    ),
    tokenGlobalLimiter: new RateLimiter(
      options.oauthTokenGlobalRateLimit ?? DEFAULT_OAUTH_TOKEN_GLOBAL_RATE_LIMIT,
      {
        ...(options.oauthRateLimitNow === undefined ? {} : { now: options.oauthRateLimitNow }),
        ...(options.oauthRateLimitMaxKeys === undefined
          ? {}
          : { maxKeys: options.oauthRateLimitMaxKeys }),
        ...(options.oauthRateLimitIdleMs === undefined
          ? {}
          : { idleMs: options.oauthRateLimitIdleMs }),
      },
    ),
    revokeLimiter: new RateLimiter(
      options.oauthRevokeRateLimit ?? DEFAULT_OAUTH_REVOKE_RATE_LIMIT,
      {
        ...(options.oauthRateLimitNow === undefined ? {} : { now: options.oauthRateLimitNow }),
        ...(options.oauthRateLimitMaxKeys === undefined
          ? {}
          : { maxKeys: options.oauthRateLimitMaxKeys }),
        ...(options.oauthRateLimitIdleMs === undefined
          ? {}
          : { idleMs: options.oauthRateLimitIdleMs }),
      },
    ),
  };
  const clock = options.metricsNow ?? ((): number => performance.now());
  return async (request: Request): Promise<Response> => {
    const started = clock();
    const requestId = randomRequestId();
    const context: RequestContext = {};
    let response: Response;
    try {
      response = await route(
        deps,
        request,
        requestId,
        context,
        mcp,
        limiter,
        loginLimiter,
        metrics,
        metricsToken,
        oauthOptions,
      );
    } catch (error) {
      if (error instanceof AppError) {
        response = errorResponse(
          error,
          requestId,
          context.suppressBearerChallenge !== true,
        );
      } else {
        // Unexpected failures never echo internals or content.
        response = errorResponse(new AppError("UNAVAILABLE"), requestId);
      }
    }

    // Path only: query values such as search text are never logged. The same
    // pathname is reduced to a fixed route label for metrics.
    const pathname = new URL(request.url).pathname;
    const durationMs = clock() - started;
    const entry: RequestLogEntry = {
      requestId,
      method: request.method.toUpperCase(),
      path: pathname,
      status: response.status,
      durationMs: Math.round(durationMs),
    };
    let errorCode: string | undefined;
    if (response.status >= 400) {
      errorCode = await errorCodeFrom(response);
      if (errorCode !== undefined) entry.errorCode = errorCode;
    }
    // Metrics include successes, application errors, and 429s. A registry
    // failure must not change the response.
    try {
      metrics.recordRequest(routeLabelFor(pathname), response.status, errorCode, durationMs);
    } catch {
      // Recording is best effort.
    }
    if (context.principal !== undefined) {
      entry.speakerId = context.principal.speakerId;
      entry.accountId = context.principal.accountId;
    }
    try {
      options.logger?.(entry);
    } catch {
      // A failing logger must not change the response.
    }
    return response;
  };
}
