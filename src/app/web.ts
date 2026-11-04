// Read-only human dashboard. Server-rendered HTML only: no inline script, no
// script at all, no message HTML. Authorization is derived from the account
// session through `resolveSessionViewer` and then the existing service
// functions run unchanged. There are no write actions on this surface.
import { randomBase64url } from "../auth/credentials.ts";
import { digestsEqual, sha256Hex } from "../domain/digest.ts";
import { AppError, RateLimitError } from "../domain/errors.ts";
import { normalizeEmail, validateLoginPassword } from "../domain/validation.ts";
import type { ServiceDeps } from "../service/auth.ts";
import {
  resolveSessionViewer,
  sessionAccountPrincipal,
} from "../service/auth.ts";
import {
  getMessageBody,
  listMessages,
  listReadReceipts,
  type ListMessagesQuery,
  type MessageMetadata,
  type ReadReceipt,
} from "../service/messages.ts";
import { listProjects } from "../service/projects.ts";
import {
  authenticateSession,
  loginAccount,
  sessionTokenFromCookie,
  validateSession,
} from "../service/sessions.ts";
import {
  clearedWebLoginCsrfCookie,
  cookieValue,
  csrfCookie,
  sessionCookie,
  WEB_LOGIN_CSRF_COOKIE,
  webLoginCsrfCookie,
} from "./cookies.ts";
import { escapeHtml, htmlResponse, WEB_CSP } from "./html.ts";
import type { RateLimiter } from "./rate-limit.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const MAX_WEB_BODY_BYTES = 64 * 1024;
const MAX_RETURN_TO_LENGTH = 2048;
const DEFAULT_TIMELINE_LIMIT = 50;
const MAX_TIMELINE_LIMIT = 100;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

const LOCALES = ["en", "zh"] as const;
type Locale = (typeof LOCALES)[number];

const EN = {
  appName: "Corkboard",
  skipToContent: "Skip to main content",
  languageSwitch: "Language",
  dashboardTitle: "Projects",
  dashboardEmpty: "No projects are available for this account.",
  memberLabel: "Member",
  statusLabel: "Status",
  statusActive: "Active",
  summaryFallback: "No description.",
  timelineTitle: "Timeline",
  backToProjects: "Back to projects",
  timelineEmpty: "No messages yet.",
  senderLabel: "Sender",
  committedLabel: "Committed",
  replyToLabel: "Reply to",
  readReceiptsLabel: "Read by",
  noneLabel: "None",
  revealBody: "Reveal body",
  tombstone: "This message body has expired. Its metadata is retained.",
  olderMessages: "Older messages",
  newerMessages: "Newer messages",
  bodyTitle: "Message body",
  backToTimeline: "Back to timeline",
  bodyExpired: "Message body expired",
  bodyExpiredBody: "This message body is no longer available.",
  loginTitle: "Sign in",
  emailLabel: "Email",
  passwordLabel: "Password",
  signIn: "Sign in",
  loginError: "Invalid email or password.",
  loginExpired: "The sign-in form expired. Please try again.",
  invalidRequest: "Invalid request",
  invalidRequestBody: "The request could not be processed.",
  notFoundTitle: "Not found",
  notFoundBody: "The requested page is not available.",
  errorTitle: "Something went wrong",
  errorBody: "The request could not be completed.",
  tooManyRequests: "Too many attempts",
  tooManyRequestsBody: "Wait a moment and try again.",
  unknownSpeaker: "Unknown speaker",
} as const;

type MessageKey = keyof typeof EN;

const ZH: Readonly<Record<MessageKey, string>> = {
  appName: "Corkboard",
  skipToContent: "跳到主要内容",
  languageSwitch: "语言",
  dashboardTitle: "项目",
  dashboardEmpty: "此账户没有可查看的项目。",
  memberLabel: "成员",
  statusLabel: "状态",
  statusActive: "活跃",
  summaryFallback: "暂无说明。",
  timelineTitle: "时间线",
  backToProjects: "返回项目列表",
  timelineEmpty: "暂无消息。",
  senderLabel: "发送者",
  committedLabel: "提交时间",
  replyToLabel: "回复",
  readReceiptsLabel: "已读",
  noneLabel: "无",
  revealBody: "显示正文",
  tombstone: "此消息正文已过期，元数据仍保留。",
  olderMessages: "更早的消息",
  newerMessages: "更新的消息",
  bodyTitle: "消息正文",
  backToTimeline: "返回时间线",
  bodyExpired: "消息正文已过期",
  bodyExpiredBody: "此消息正文已不可用。",
  loginTitle: "登录",
  emailLabel: "邮箱",
  passwordLabel: "密码",
  signIn: "登录",
  loginError: "邮箱或密码无效。",
  loginExpired: "登录表单已过期，请重试。",
  invalidRequest: "无效请求",
  invalidRequestBody: "无法处理此请求。",
  notFoundTitle: "未找到",
  notFoundBody: "请求的页面不可用。",
  errorTitle: "出现问题",
  errorBody: "无法完成请求。",
  tooManyRequests: "尝试次数过多",
  tooManyRequestsBody: "请稍后重试。",
  unknownSpeaker: "未知发送者",
};

const CATALOGS: Readonly<Record<Locale, Readonly<Record<MessageKey, string>>>> = {
  en: EN,
  zh: ZH,
};

const DATE_FORMATTERS: Readonly<Record<Locale, Intl.DateTimeFormat>> = {
  en: new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }),
  zh: new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }),
};

// Fixed same-origin stylesheet. It contains no user input and no @import or
// external URL. Focus indicators are always visible.
const WEB_CSS = `:root { color-scheme: light dark; font-family: system-ui, sans-serif; line-height: 1.5; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 60rem; padding: 1rem; background: Canvas; color: CanvasText; }
a { color: LinkText; }
a:focus-visible, button:focus-visible, pre:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
.skip-link { position: absolute; left: -9999px; top: 0; background: Canvas; padding: 0.5rem; }
.skip-link:focus { left: 1rem; z-index: 1; }
.site-header { display: flex; flex-wrap: wrap; gap: 1rem; align-items: baseline; justify-content: space-between; border-bottom: 1px solid GrayText; padding-bottom: 0.5rem; }
.brand { font-weight: 700; text-decoration: none; }
nav[aria-label] a[aria-current="true"] { font-weight: 700; text-decoration: underline; }
main { padding-block: 1rem; }
.project-list, .timeline { list-style: none; padding: 0; display: grid; gap: 1rem; }
.project-list article, .message { border: 1px solid GrayText; border-radius: 0.5rem; padding: 1rem; }
.message h3 { margin-top: 0.25rem; }
.seq { font-variant-numeric: tabular-nums; color: GrayText; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.25rem 0.75rem; margin: 0.5rem 0; }
dt { font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.state.expired { border-left: 4px solid GrayText; padding-left: 0.75rem; }
.empty { font-style: italic; }
.error { border: 1px solid GrayText; border-left: 4px solid Mark; padding: 0.5rem 0.75rem; }
.body-text { white-space: pre-wrap; overflow-wrap: anywhere; padding: 1rem; border: 1px solid GrayText; border-radius: 0.5rem; }
.pager { display: flex; gap: 1rem; }
@media (max-width: 40rem) { body { padding: 0.75rem; } dl { grid-template-columns: 1fr; } }
`;

function t(locale: Locale, key: MessageKey): string {
  return CATALOGS[locale][key];
}

function localeFrom(url: URL): Locale {
  const requested = url.searchParams.get("lang");
  return requested === "zh" ? "zh" : "en";
}

function localeQuery(locale: Locale): string {
  return locale === "en" ? "" : "?lang=zh";
}

function formatCommittedAt(locale: Locale, value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${DATE_FORMATTERS[locale].format(date)} UTC`;
}

function hrefWithParams(
  url: URL,
  updates: Readonly<Record<string, string | null>>,
): string {
  const params = new URLSearchParams(url.search);
  for (const [name, value] of Object.entries(updates)) {
    if (value === null) params.delete(name);
    else params.set(name, value);
  }
  const query = params.toString();
  return query === "" ? url.pathname : `${url.pathname}?${query}`;
}

function localeSwitch(locale: Locale, url: URL): string {
  const english = escapeHtml(hrefWithParams(url, { lang: "en" }));
  const chinese = escapeHtml(hrefWithParams(url, { lang: "zh" }));
  const englishCurrent = locale === "en" ? ' aria-current="true"' : "";
  const chineseCurrent = locale === "zh" ? ' aria-current="true"' : "";
  return `<a href="${english}" lang="en" hreflang="en"${englishCurrent}>English</a> <span aria-hidden="true">·</span> <a href="${chinese}" lang="zh-Hans" hreflang="zh-Hans"${chineseCurrent}>中文</a>`;
}

function renderPage(locale: Locale, url: URL, title: string, content: string): string {
  const documentLang = locale === "zh" ? "zh-Hans" : "en";
  return `<!doctype html>
<html lang="${documentLang}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ${escapeHtml(t(locale, "appName"))}</title>
<link rel="stylesheet" href="/static/app.css">
</head>
<body>
<a class="skip-link" href="#main">${escapeHtml(t(locale, "skipToContent"))}</a>
<header class="site-header">
<a class="brand" href="/${localeQuery(locale)}">${escapeHtml(t(locale, "appName"))}</a>
<nav aria-label="${escapeHtml(t(locale, "languageSwitch"))}">${localeSwitch(locale, url)}</nav>
</header>
<main id="main" tabindex="-1">
${content}
</main>
</body>
</html>
`;
}

function renderError(
  locale: Locale,
  url: URL,
  status: number,
  titleKey: MessageKey,
  bodyKey: MessageKey,
  extra: Record<string, string | readonly string[]> = {},
): Response {
  const content = `<h1>${escapeHtml(t(locale, titleKey))}</h1>
<p role="alert">${escapeHtml(t(locale, bodyKey))}</p>`;
  return htmlResponse(status, renderPage(locale, url, t(locale, titleKey), content), extra);
}

function methodNotAllowed(locale: Locale, url: URL, allow: string): Response {
  return renderError(locale, url, 405, "invalidRequest", "invalidRequestBody", { allow });
}

function redirect(
  status: number,
  location: string,
  extra: Record<string, string | readonly string[]> = {},
): Response {
  const headers = new Headers({
    location,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") headers.set(name, value);
    else for (const item of value) headers.append(name, item);
  }
  return new Response(null, { status, headers });
}

// Same-origin path only: absolute URLs, scheme-relative URLs, backslashes, and
// control characters are rejected. The emitted value is re-derived from the URL
// parser, so the raw client string never reaches a Location header.
export function normalizeReturnTo(raw: string | null | undefined): string {
  if (raw === null || raw === undefined || raw === "") return "/";
  if (raw.length > MAX_RETURN_TO_LENGTH) throw new AppError("VALIDATION_ERROR");
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new AppError("VALIDATION_ERROR");
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) {
    throw new AppError("VALIDATION_ERROR");
  }
  let target: URL;
  try {
    target = new URL(raw, "http://localhost");
  } catch {
    throw new AppError("VALIDATION_ERROR");
  }
  if (
    target.origin !== "http://localhost" ||
    !target.pathname.startsWith("/") ||
    target.pathname.startsWith("//")
  ) {
    throw new AppError("VALIDATION_ERROR");
  }
  return target.pathname + target.search;
}

function queryInt(
  url: URL,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (!/^\d+$/.test(raw)) throw new AppError("VALIDATION_ERROR");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError("VALIDATION_ERROR");
  }
  return value;
}

function loginRedirect(url: URL, locale: Locale): Response {
  const params = new URLSearchParams({ return_to: url.pathname + url.search });
  if (locale !== "en") params.set("lang", locale);
  return redirect(303, `/login?${params.toString()}`);
}

async function readForm(request: Request): Promise<URLSearchParams> {
  const raw = request.headers.get("content-type");
  const mediaType = raw === null ? "" : (raw.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType !== FORM_MEDIA_TYPE) {
    throw new AppError("VALIDATION_ERROR", "Content-Type must be form-encoded");
  }
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) {
      throw new AppError("VALIDATION_ERROR");
    }
    if (length > MAX_WEB_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_WEB_BODY_BYTES) throw new AppError("REQUEST_TOO_LARGE");
  return new URLSearchParams(DECODER.decode(bytes));
}

function singleFormParam(form: URLSearchParams, name: string): string | null {
  const values = form.getAll(name);
  if (values.length > 1) throw new AppError("VALIDATION_ERROR", `Duplicate ${name}`);
  return values[0] ?? null;
}

function renderLogin(
  locale: Locale,
  url: URL,
  returnTo: string,
  status: number,
  errorKey?: MessageKey,
): Response {
  // Double-submit: the hidden field and the HttpOnly SameSite=Lax cookie must
  // match. A cross-site form cannot read the cookie and does not send it.
  const loginCsrf = randomBase64url(32);
  const error =
    errorKey === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(t(locale, errorKey))}</p>`;
  const action = locale === "zh" ? "/login?lang=zh" : "/login";
  const content = `<h1>${escapeHtml(t(locale, "loginTitle"))}</h1>
${error}<form method="post" action="${action}">
<input type="hidden" name="return_to" value="${escapeHtml(returnTo)}">
<input type="hidden" name="login_csrf" value="${escapeHtml(loginCsrf)}">
<p><label for="email">${escapeHtml(t(locale, "emailLabel"))}</label><br>
<input id="email" name="email" type="email" autocomplete="username" required></p>
<p><label for="password">${escapeHtml(t(locale, "passwordLabel"))}</label><br>
<input id="password" name="password" type="password" autocomplete="current-password" required></p>
<p><button type="submit">${escapeHtml(t(locale, "signIn"))}</button></p>
</form>`;
  return htmlResponse(
    status,
    renderPage(locale, url, t(locale, "loginTitle"), content),
    { "set-cookie": webLoginCsrfCookie(loginCsrf) },
  );
}

async function handleLoginPage(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
): Promise<Response> {
  const returnTo = normalizeReturnTo(url.searchParams.get("return_to"));
  try {
    await validateSession(deps, sessionTokenFromCookie(request.headers.get("cookie")));
    return redirect(303, returnTo);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "UNAUTHENTICATED") throw error;
  }
  return renderLogin(locale, url, returnTo, 200);
}

async function handleLoginSubmit(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
  loginLimiter: RateLimiter,
): Promise<Response> {
  const form = await readForm(request);
  const returnTo = normalizeReturnTo(singleFormParam(form, "return_to"));

  const cookieCsrf = cookieValue(request.headers.get("cookie"), WEB_LOGIN_CSRF_COOKIE);
  const formCsrf = singleFormParam(form, "login_csrf");
  if (cookieCsrf === undefined || formCsrf === null || formCsrf === "") {
    return renderLogin(locale, url, returnTo, 400, "loginExpired");
  }
  const [presented, expected] = await Promise.all([
    sha256Hex(ENCODER.encode(formCsrf)),
    sha256Hex(ENCODER.encode(cookieCsrf)),
  ]);
  if (!digestsEqual(presented, expected)) {
    return renderLogin(locale, url, returnTo, 400, "loginExpired");
  }

  let email: string;
  let password: string;
  try {
    email = normalizeEmail(form.get("email"));
    password = validateLoginPassword(form.get("password"));
  } catch {
    return renderLogin(locale, url, returnTo, 401, "loginError");
  }
  // Keyed by an email digest, never the address. Checked before account lookup.
  const decision = loginLimiter.check(await sha256Hex(ENCODER.encode(email)));
  if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);

  let login: { token: string; csrfToken: string };
  try {
    login = await loginAccount(deps, { email, password });
  } catch (error) {
    if (error instanceof AppError && error.code === "UNAUTHENTICATED") {
      return renderLogin(locale, url, returnTo, 401, "loginError");
    }
    throw error;
  }

  return redirect(303, returnTo, {
    "set-cookie": [
      sessionCookie(login.token),
      csrfCookie(login.csrfToken),
      clearedWebLoginCsrfCookie(),
    ],
  });
}

async function handleDashboard(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const result = await listProjects(
    deps,
    sessionAccountPrincipal(session),
    { limit: MAX_TIMELINE_LIMIT },
  );

  const projects =
    result.projects.length === 0
      ? `<p class="empty">${escapeHtml(t(locale, "dashboardEmpty"))}</p>`
      : `<ul class="project-list">
${result.projects
  .map((project) => {
    const titleId = `project-${escapeHtml(project.id)}-title`;
    const summary =
      project.summary === null || project.summary === ""
        ? t(locale, "summaryFallback")
        : project.summary;
    return `<li><article aria-labelledby="${titleId}">
<h2 id="${titleId}"><a href="/projects/${escapeHtml(project.id)}${localeQuery(locale)}">${escapeHtml(project.title)}</a></h2>
<p>${escapeHtml(summary)}</p>
<dl>
<dt>${escapeHtml(t(locale, "statusLabel"))}</dt><dd>${escapeHtml(t(locale, "statusActive"))}</dd>
<dt>${escapeHtml(t(locale, "memberLabel"))}</dt><dd>${escapeHtml(project.member_display_name ?? t(locale, "unknownSpeaker"))}</dd>
</dl>
</article></li>`;
  })
  .join("\n")}
</ul>`;

  const content = `<h1>${escapeHtml(t(locale, "dashboardTitle"))}</h1>
${projects}`;
  return htmlResponse(200, renderPage(locale, url, t(locale, "dashboardTitle"), content));
}

function renderTimeline(
  locale: Locale,
  projectId: string,
  url: URL,
  messages: readonly MessageMetadata[],
  receipts: ReadonlyMap<string, ReadReceipt[]>,
): string {
  if (messages.length === 0) {
    return `<p class="empty">${escapeHtml(t(locale, "timelineEmpty"))}</p>`;
  }
  const seqById = new Map(messages.map((message) => [message.messageId, message.seq]));
  const items = messages
    .map((message) => {
      const messageId = escapeHtml(message.messageId);
      const titleId = `msg-${messageId}-summary`;
      const reply = message.replyToId;
      let replyHtml = escapeHtml(t(locale, "noneLabel"));
      if (reply !== null) {
        const replySeq = seqById.get(reply);
        replyHtml =
          replySeq === undefined
            ? escapeHtml(reply)
            : `<a href="#msg-${escapeHtml(reply)}">#${replySeq}</a>`;
      }
      const receiptList = receipts.get(message.messageId) ?? [];
      const receiptHtml =
        receiptList.length === 0
          ? escapeHtml(t(locale, "noneLabel"))
          : `${receiptList.length} — ${receiptList
              .map((receipt) =>
                escapeHtml(receipt.displayName ?? t(locale, "unknownSpeaker")),
              )
              .join(", ")}`;
      const state =
        message.bodyState === "expired"
          ? `<p class="state expired">${escapeHtml(t(locale, "tombstone"))}</p>`
          : `<p><a href="/projects/${escapeHtml(projectId)}/messages/${messageId}/body${localeQuery(locale)}">${escapeHtml(t(locale, "revealBody"))}</a></p>`;
      return `<li><article id="msg-${messageId}" class="message" aria-labelledby="${titleId}">
<span class="seq">#${message.seq}</span>
<h3 id="${titleId}">${escapeHtml(message.summary)}</h3>
<dl>
<dt>${escapeHtml(t(locale, "senderLabel"))}</dt><dd>${escapeHtml(message.sender.displayName ?? t(locale, "unknownSpeaker"))}</dd>
<dt>${escapeHtml(t(locale, "committedLabel"))}</dt><dd><time datetime="${escapeHtml(message.committedAt)}">${escapeHtml(formatCommittedAt(locale, message.committedAt))}</time></dd>
<dt>${escapeHtml(t(locale, "replyToLabel"))}</dt><dd>${replyHtml}</dd>
<dt>${escapeHtml(t(locale, "readReceiptsLabel"))}</dt><dd>${receiptHtml}</dd>
</dl>
${state}
</article></li>`;
    })
    .join("\n");

  const first = messages[0];
  const last = messages[messages.length - 1];
  const pager: string[] = [];
  if (last !== undefined) {
    pager.push(
      `<a href="${escapeHtml(hrefWithParams(url, { before_seq: String(first?.seq ?? last.seq), after_seq: null }))}">${escapeHtml(t(locale, "olderMessages"))}</a>`,
    );
    if (url.searchParams.has("before_seq") || url.searchParams.has("after_seq")) {
      pager.push(
        `<a href="${escapeHtml(hrefWithParams(url, { after_seq: String(last.seq), before_seq: null }))}">${escapeHtml(t(locale, "newerMessages"))}</a>`,
      );
    }
  }
  return `<ol class="timeline">
${items}
</ol>
<nav class="pager" aria-label="${escapeHtml(t(locale, "timelineTitle"))}">${pager.join(" ")}</nav>`;
}

async function handleTimeline(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
  projectId: string,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const viewer = await resolveSessionViewer(deps, session, projectId, "message.read");
  const project = await deps.db.first<{ title: string }>(
    "SELECT title FROM projects WHERE id = ?",
    [projectId],
  );
  if (project === undefined) throw new AppError("NOT_FOUND");

  const limit = queryInt(url, "limit", 1, MAX_TIMELINE_LIMIT);
  const afterSeq = queryInt(url, "after_seq", 0, Number.MAX_SAFE_INTEGER);
  const beforeSeq = queryInt(url, "before_seq", 0, Number.MAX_SAFE_INTEGER);
  const query: ListMessagesQuery = {};
  if (limit !== undefined) query.limit = limit;
  else query.limit = DEFAULT_TIMELINE_LIMIT;
  if (afterSeq !== undefined) query.afterSeq = afterSeq;
  if (beforeSeq !== undefined) query.beforeSeq = beforeSeq;

  const result = await listMessages(deps, viewer, projectId, query);
  const receipts = await listReadReceipts(
    deps,
    viewer,
    projectId,
    result.messages.map((message) => message.messageId),
  );

  const content = `<p><a href="/${localeQuery(locale)}">${escapeHtml(t(locale, "backToProjects"))}</a></p>
<h1>${escapeHtml(project.title)}</h1>
<h2>${escapeHtml(t(locale, "timelineTitle"))}</h2>
${renderTimeline(locale, projectId, url, result.messages, receipts)}`;
  return htmlResponse(200, renderPage(locale, url, project.title, content));
}

async function handleBody(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
  projectId: string,
  messageId: string,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const viewer = await resolveSessionViewer(deps, session, projectId, "message.read");
  // The existing integrity-verified decrypt path. Any failure below is mapped
  // to a safe page by webError; plaintext is never partially returned.
  const body = await getMessageBody(deps, viewer, projectId, messageId);

  const content = `<p><a href="/projects/${escapeHtml(projectId)}${localeQuery(locale)}">${escapeHtml(t(locale, "backToTimeline"))}</a></p>
<h1>${escapeHtml(t(locale, "bodyTitle"))}</h1>
<pre class="body-text" tabindex="0">${escapeHtml(body.text)}</pre>`;
  return htmlResponse(200, renderPage(locale, url, t(locale, "bodyTitle"), content));
}

function stylesheetResponse(): Response {
  return new Response(WEB_CSS, {
    status: 200,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/css; charset=utf-8",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": WEB_CSP,
    },
  });
}

function webError(locale: Locale, url: URL, error: unknown): Response {
  if (error instanceof RateLimitError) {
    return renderError(locale, url, 429, "tooManyRequests", "tooManyRequestsBody", {
      "retry-after": String(error.retryAfterSeconds),
    });
  }
  if (error instanceof AppError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
        return loginRedirect(url, locale);
      case "NOT_FOUND":
      case "FORBIDDEN":
        // A project or message the account may not read is indistinguishable
        // from one that does not exist.
        return renderError(locale, url, 404, "notFoundTitle", "notFoundBody");
      case "BODY_EXPIRED":
        return renderError(locale, url, 410, "bodyExpired", "bodyExpiredBody");
      case "VALIDATION_ERROR":
        return renderError(locale, url, 400, "invalidRequest", "invalidRequestBody");
      case "REQUEST_TOO_LARGE":
        return renderError(locale, url, 413, "invalidRequest", "invalidRequestBody");
      case "UNAVAILABLE":
        return renderError(locale, url, 503, "errorTitle", "errorBody");
      default:
        return renderError(locale, url, 500, "errorTitle", "errorBody");
    }
  }
  // Unexpected failures never echo internals or content.
  return renderError(locale, url, 500, "errorTitle", "errorBody");
}

export function isWebPath(segments: readonly string[]): boolean {
  if (segments.length === 0) return true;
  if (segments.length === 1 && segments[0] === "login") return true;
  if (segments.length === 2 && segments[0] === "static" && segments[1] === "app.css") {
    return true;
  }
  if (segments.length === 2 && segments[0] === "projects") return true;
  return (
    segments.length === 5 &&
    segments[0] === "projects" &&
    segments[2] === "messages" &&
    segments[4] === "body"
  );
}

export async function handleWebRoute(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  loginLimiter: RateLimiter,
): Promise<Response> {
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const method = request.method.toUpperCase();
  const locale = localeFrom(url);
  try {
    if (segments.length === 0) {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return await handleDashboard(deps, request, url, locale);
    }
    if (segments.length === 1 && segments[0] === "login") {
      if (method === "GET") return await handleLoginPage(deps, request, url, locale);
      if (method === "POST") {
        return await handleLoginSubmit(deps, request, url, locale, loginLimiter);
      }
      return methodNotAllowed(locale, url, "GET, POST");
    }
    if (segments.length === 2 && segments[0] === "static" && segments[1] === "app.css") {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return stylesheetResponse();
    }
    if (segments.length === 2 && segments[0] === "projects") {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return await handleTimeline(deps, request, url, locale, segments[1] ?? "");
    }
    if (
      segments.length === 5 &&
      segments[0] === "projects" &&
      segments[2] === "messages" &&
      segments[4] === "body"
    ) {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return await handleBody(
        deps,
        request,
        url,
        locale,
        segments[1] ?? "",
        segments[3] ?? "",
      );
    }
    return renderError(locale, url, 404, "notFoundTitle", "notFoundBody");
  } catch (error) {
    return webError(locale, url, error);
  }
}
