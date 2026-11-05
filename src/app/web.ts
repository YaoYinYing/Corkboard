// Human dashboard. Server-rendered HTML only: no inline script, no script at
// all, no message HTML. Message reads are read-only; the only writes are project
// create and title/summary edit. Authorization is derived from the account
// session through `resolveSessionViewer` and then the existing service functions
// run unchanged.
import { randomBase64url } from "../auth/credentials.ts";
import { SCOPES } from "../domain/authz.ts";
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
  MAX_QUERY_CHARS,
  type ListMessagesQuery,
  type MessageMetadata,
  type ReadReceipt,
} from "../service/messages.ts";
import {
  createProject,
  getProjectForEdit,
  listProjects,
  updateProject,
} from "../service/projects.ts";
import {
  getOwnedSpeakerForKey,
  issueProjectCredential,
  listOwnedSpeakers,
  type IssuedCredential,
  type OwnedSpeaker,
  type OwnedSpeakerForKey,
} from "../service/speakers.ts";
import {
  authenticateSession,
  loginAccount,
  recordLoginRateLimited,
  sessionTokenFromCookie,
  validateSession,
  verifySessionCsrf,
  CSRF_COOKIE_NAME,
  type SessionPrincipal,
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
// before_seq above every committed sequence returns the latest page. Sequence
// allocation starts at 1, so this bound is safe without knowing the max.
const LATEST_SEQ = Number.MAX_SAFE_INTEGER;
const FORM_MEDIA_TYPE = "application/x-www-form-urlencoded";

interface TimelineFilters {
  type?: string;
  sender?: string;
  q?: string;
  unread?: boolean;
}

const LOCALES = ["en", "zh"] as const;
type Locale = (typeof LOCALES)[number];

const EN = {
  appName: "Corkboard",
  skipToContent: "Skip to main content",
  languageSwitch: "Language",
  dashboardTitle: "Projects",
  dashboardEmpty: "No projects are available for this account.",
  newProjectTitle: "New project",
  editProjectTitle: "Edit project",
  projectTitleLabel: "Title",
  projectSummaryLabel: "Summary",
  projectSummaryHint: "Optional, up to 140 characters.",
  createProjectAction: "Create project",
  saveProjectAction: "Save changes",
  cancelAction: "Cancel",
  projectFormError: "Check the project details and try again.",
  formExpired: "The form expired. Please try again.",
  memberLabel: "Member",
  statusLabel: "Status",
  statusActive: "Active",
  summaryFallback: "No description.",
  timelineTitle: "Timeline",
  backToProjects: "Back to projects",
  timelineEmpty: "No messages yet.",
  filtersTitle: "Filters",
  filterTypeLabel: "Type",
  filterSenderLabel: "Sender speaker ID",
  filterSenderHint: "Exact project member speaker identifier.",
  filterSearchLabel: "Search summaries",
  filterSearchHint: "Matches summary text only; message bodies are never searched.",
  filterUnreadLabel: "Unread only",
  filterReadOnlyLabel: "Read only",
  filterLimitLabel: "Messages per page",
  applyFilters: "Apply filters",
  resetFilters: "Clear filters",
  activeFilters: "Active filters",
  filterNone: "No filters applied.",
  filteredEmpty: "No messages match these filters.",
  jumpToLatest: "Jump to latest",
  paginationLabel: "Timeline pages",
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
  speakersTitle: "Speakers",
  speakersEmpty: "No speakers are available for this account.",
  speakerProjectsLabel: "Project grants",
  speakerNoProjects: "No active projects.",
  speakerNoScopes: "No scopes are available.",
  issueCredentialAction: "Issue credential",
  issueCredentialTitle: "Issue credential",
  backToSpeakers: "Back to speakers",
  speakerNameLabel: "Speaker",
  projectsLegend: "Projects",
  scopesLegend: "Scopes",
  issueCredentialHint: "Select at least one project and one scope.",
  issueCredentialError: "Check the selected projects and scopes and try again.",
  credentialIssuedTitle: "Credential issued",
  credentialOnceWarning:
    "Copy this credential now. It is shown only once and cannot be recovered.",
  credentialLabel: "New credential",
  credentialProjectsLabel: "Granted projects",
  credentialScopesLabel: "Scopes",
  statusInactive: "Inactive",
} as const;

type MessageKey = keyof typeof EN;

const ZH: Readonly<Record<MessageKey, string>> = {
  appName: "Corkboard",
  skipToContent: "跳到主要内容",
  languageSwitch: "语言",
  dashboardTitle: "项目",
  dashboardEmpty: "此账户没有可查看的项目。",
  newProjectTitle: "新建项目",
  editProjectTitle: "编辑项目",
  projectTitleLabel: "标题",
  projectSummaryLabel: "说明",
  projectSummaryHint: "可选，最多 140 个字符。",
  createProjectAction: "创建项目",
  saveProjectAction: "保存更改",
  cancelAction: "取消",
  projectFormError: "请检查项目信息后重试。",
  formExpired: "表单已过期，请重试。",
  memberLabel: "成员",
  statusLabel: "状态",
  statusActive: "活跃",
  summaryFallback: "暂无说明。",
  timelineTitle: "时间线",
  backToProjects: "返回项目列表",
  timelineEmpty: "暂无消息。",
  filtersTitle: "筛选",
  filterTypeLabel: "类型",
  filterSenderLabel: "发送者 ID",
  filterSenderHint: "项目成员的精确说话者标识符。",
  filterSearchLabel: "搜索摘要",
  filterSearchHint: "仅匹配摘要文本，不搜索消息正文。",
  filterUnreadLabel: "仅未读",
  filterReadOnlyLabel: "仅已读",
  filterLimitLabel: "每页消息数",
  applyFilters: "应用筛选",
  resetFilters: "清除筛选",
  activeFilters: "当前筛选",
  filterNone: "未应用筛选。",
  filteredEmpty: "没有消息符合这些筛选条件。",
  jumpToLatest: "跳到最新",
  paginationLabel: "时间线分页",
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
  speakersTitle: "说话者",
  speakersEmpty: "此账户没有可查看的说话者。",
  speakerProjectsLabel: "项目授权",
  speakerNoProjects: "没有活跃项目。",
  speakerNoScopes: "没有可用的权限范围。",
  issueCredentialAction: "签发凭证",
  issueCredentialTitle: "签发凭证",
  backToSpeakers: "返回说话者列表",
  speakerNameLabel: "说话者",
  projectsLegend: "项目",
  scopesLegend: "权限范围",
  issueCredentialHint: "请至少选择一个项目和一个权限范围。",
  issueCredentialError: "请检查所选项目和权限范围后重试。",
  credentialIssuedTitle: "凭证已签发",
  credentialOnceWarning: "请立即复制此凭证。它只会显示一次，之后无法找回。",
  credentialLabel: "新凭证",
  credentialProjectsLabel: "已授权项目",
  credentialScopesLabel: "权限范围",
  statusInactive: "未激活",
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
// external URL. Values come from designs/corkboard-design-system/project/
// tokens.json; the light theme is the fallback and prefers-color-scheme
// overrides it. Focus indicators are always visible.
const WEB_CSS = `:root {
  color-scheme: light;
  --surface: #fbfaf7;
  --surface-raised: #ffffff;
  --surface-muted: #f2eee8;
  --ink: #1c1917;
  --ink-muted: #5b544c;
  --border: #8a837a;
  --brand: #1f4e46;
  --brand-ink: #ffffff;
  --accent: #8a4b1f;
  --danger: #a11d3c;
  --focus: #0b5cad;
  --link: #0b5cad;
  --success: #2f6b3a;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --font-sans: system-ui, -apple-system, "Segoe UI", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, monospace;
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.08);
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --surface: #141210;
    --surface-raised: #1d1a17;
    --surface-muted: #272320;
    --ink: #f4efe7;
    --ink-muted: #c9c2b7;
    --border: #7d766c;
    --brand: #8fd3c3;
    --brand-ink: #10201c;
    --accent: #e6a371;
    --danger: #f4a6b4;
    --focus: #9ccbff;
    --link: #a8d1ff;
    --success: #a9d9b0;
    --shadow-card: none;
  }
}
* { box-sizing: border-box; }
body, .body { font-family: var(--font-sans); font-size: 15px; line-height: 22px; font-weight: 400; }
body { margin: 0 auto; max-width: 60rem; padding: var(--space-4); background: var(--surface); color: var(--ink); }
a { color: var(--link); }
a:focus-visible, button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, pre:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.skip-link { position: absolute; left: -9999px; top: 0; background: var(--surface); padding: var(--space-2); }
.skip-link:focus { left: var(--space-4); z-index: 1; }
.site-header { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: baseline; justify-content: space-between; border-bottom: 1px solid var(--border); padding-bottom: var(--space-2); }
.brand { color: var(--brand); font-weight: 700; text-decoration: none; }
nav[aria-label] a[aria-current="true"] { font-weight: 700; text-decoration: underline; }
main { padding-block: var(--space-4); }
h1, .h1 { font-size: 28px; line-height: 32px; font-weight: 700; }
h2, .h2 { font-size: 20px; line-height: 26px; font-weight: 600; }
h3, .h3 { font-size: 17px; line-height: 24px; font-weight: 600; }
.project-list, .timeline { list-style: none; padding: 0; display: grid; gap: var(--space-4); }
.project-list article, .message { border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); min-width: 0; }
.project-list li, .message h3, .message dd, .project-list h2, h1 { overflow-wrap: anywhere; }
.message h3 { margin-top: var(--space-1); }
.small, .seq, .hint { font-size: 13px; line-height: 18px; font-weight: 400; }
.seq { font-variant-numeric: tabular-nums; color: var(--ink-muted); }
dl { display: grid; grid-template-columns: max-content 1fr; gap: var(--space-1) var(--space-3); margin: var(--space-2) 0; }
.label, dt, label { font-size: 14px; line-height: 20px; font-weight: 600; }
dd { margin: 0; overflow-wrap: anywhere; }
.status { color: var(--success); font-weight: 600; }
.state.expired { border-left: 4px solid var(--border); padding-left: var(--space-3); }
.empty { font-style: italic; color: var(--ink-muted); background: var(--surface-muted); padding: var(--space-4); border-radius: var(--radius-md); }
.error { border: 1px solid var(--border); border-left: 4px solid var(--danger); padding: var(--space-2) var(--space-3); color: var(--danger); }
.body-text { white-space: pre-wrap; overflow-wrap: anywhere; padding: var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--ink); }
.code, code, .body-text { font-family: var(--font-mono); font-size: 15px; line-height: 22px; font-weight: 400; }
input, select, textarea, button { font: inherit; max-width: 100%; }
input, select, textarea { background: var(--surface-raised); color: var(--ink); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.35rem; }
button { padding: var(--space-2) var(--space-3); border: 1px solid var(--brand); border-radius: var(--radius-sm); background: var(--brand); color: var(--brand-ink); font-weight: 600; }
.filters { display: grid; grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr)); gap: var(--space-3) var(--space-4); border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); margin-block: var(--space-2) var(--space-4); }
.filter-field { display: flex; flex-direction: column; gap: var(--space-1); min-width: 0; margin: 0; }
.filter-field input { width: 100%; min-width: 0; }
.filter-checkbox { flex-direction: row; align-items: center; gap: var(--space-2); }
.filter-checkbox input { width: auto; }
.filter-actions { grid-column: 1 / -1; display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; margin: 0; }
.hint { color: var(--ink-muted); }
.filter-state { border-left: 4px solid var(--border); padding-left: var(--space-3); overflow-wrap: anywhere; }
.filter-state code { overflow-wrap: anywhere; }
.pager { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-block: var(--space-4); }
.project-form { display: grid; gap: var(--space-3); max-width: 40rem; border: 1px solid var(--border); border-radius: var(--radius-md); padding: var(--space-4); margin-block: var(--space-2) var(--space-4); }
.project-form textarea { width: 100%; min-width: 0; resize: vertical; }
.project-form fieldset { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: var(--space-2) var(--space-3); margin: 0; display: grid; gap: var(--space-1); }
.project-form legend { font-weight: 600; padding: 0 var(--space-1); }
.grant-list { list-style: none; padding: 0; margin: 0; display: grid; gap: var(--space-1); }
.form-actions { display: flex; flex-wrap: wrap; gap: var(--space-4); align-items: center; margin: 0; }
@media (min-width: 48rem) { .message dl { grid-template-columns: max-content 1fr max-content 1fr; } }
@media (max-width: 40rem) { dl { grid-template-columns: 1fr; } }
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
<p class="error" role="alert">${escapeHtml(t(locale, bodyKey))}</p>`;
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

// The filter form submits every control, including empty ones. A blank or
// whitespace-only value means the control was left unset, so it is absent, not
// invalid input. Only non-blank values reach the strict validators below.
function queryText(url: URL, name: string): string | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  return raw;
}

function queryInt(
  url: URL,
  name: string,
  min: number,
  max: number,
): number | undefined {
  const raw = queryText(url, name);
  if (raw === undefined) return undefined;
  if (!/^\d+$/.test(raw)) throw new AppError("VALIDATION_ERROR");
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new AppError("VALIDATION_ERROR");
  }
  return value;
}

// Same spelling as the REST list: only literal true/false are accepted.
function queryBoolean(url: URL, name: string): boolean | undefined {
  const raw = queryText(url, name);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new AppError("VALIDATION_ERROR");
}

function timelineFiltersFrom(url: URL): TimelineFilters {
  const filters: TimelineFilters = {};
  const type = queryText(url, "type");
  if (type !== undefined) filters.type = type;
  const sender = queryText(url, "sender");
  if (sender !== undefined) filters.sender = sender;
  const q = queryText(url, "q");
  if (q !== undefined) filters.q = q;
  const unread = queryBoolean(url, "unread");
  if (unread !== undefined) filters.unread = unread;
  return filters;
}

function hasActiveFilters(filters: TimelineFilters): boolean {
  return (
    filters.type !== undefined ||
    filters.sender !== undefined ||
    (filters.q !== undefined && filters.q !== "") ||
    filters.unread !== undefined
  );
}

// The login form validates return_to at the same bound. Dropping an over-long
// query (and, if needed, the whole path) keeps the redirect actionable instead
// of emitting a Location that the next request rejects.
function boundedReturnTo(url: URL): string {
  const full = url.pathname + url.search;
  if (full.length <= MAX_RETURN_TO_LENGTH) return full;
  return url.pathname.length <= MAX_RETURN_TO_LENGTH ? url.pathname : "/";
}

function loginRedirect(url: URL, locale: Locale): Response {
  const params = new URLSearchParams({ return_to: boundedReturnTo(url) });
  if (locale !== "en") params.set("lang", locale);
  return redirect(303, `/login?${params.toString()}`);
}

// Defense in depth on top of the double-submit CSRF value. Browser fetch
// metadata must not say cross-site/same-site, and a browser-supplied Origin
// must name this host (scheme is ignored so TLS termination at the proxy does
// not break the check). Clients without either header still need the
// double-submit value.
function sameOriginFormPost(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin" && fetchSite !== "none") {
    return false;
  }
  const origin = request.headers.get("origin");
  // `null` is the serialized opaque origin some clients/browsers send. It is
  // not a usable same-origin assertion, so fall back to the double-submit
  // value rather than rejecting a legitimate form post.
  if (origin === null || origin === "null") return true;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return parsed.host === new URL(request.url).host;
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

function projectFormValues(
  form: URLSearchParams,
): { title: string; summary: string } | null {
  const title = form.getAll("title");
  const summary = form.getAll("summary");
  if (title.length > 1 || summary.length > 1) return null;
  return { title: title[0] ?? "", summary: summary[0] ?? "" };
}

// The session CSRF value is the non-HttpOnly cookie issued at sign-in. The
// form echoes it in a hidden field; a cross-site sender can neither read the
// cookie nor have it attached to a strict-SameSite POST. The keyed verifier on
// the session row is the authority, and the cookie equality keeps this a true
// double submit rather than a bearer value in a form field.
async function verifyFormCsrf(
  deps: ServiceDeps,
  principal: SessionPrincipal,
  request: Request,
  form: URLSearchParams,
): Promise<boolean> {
  if (!sameOriginFormPost(request)) return false;
  const cookieCsrf = cookieValue(request.headers.get("cookie"), CSRF_COOKIE_NAME);
  const values = form.getAll("csrf_token");
  if (cookieCsrf === undefined || values.length !== 1) return false;
  const formCsrf = values[0] ?? "";
  if (formCsrf === "") return false;
  const [presented, cookieDigest] = await Promise.all([
    sha256Hex(ENCODER.encode(formCsrf)),
    sha256Hex(ENCODER.encode(cookieCsrf)),
  ]);
  if (!digestsEqual(presented, cookieDigest)) return false;
  try {
    await verifySessionCsrf(deps, principal, formCsrf);
  } catch {
    return false;
  }
  return true;
}

interface ProjectFormOptions {
  action: string;
  headingKey: MessageKey;
  submitKey: MessageKey;
  cancelHref: string;
  csrf: string;
  values: { title: string; summary: string };
  status: number;
  errorKey?: MessageKey;
}

function renderProjectForm(
  locale: Locale,
  url: URL,
  options: ProjectFormOptions,
): Response {
  const error =
    options.errorKey === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(t(locale, options.errorKey))}</p>`;
  const content = `<h1>${escapeHtml(t(locale, options.headingKey))}</h1>
${error}<form class="project-form" method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(options.csrf)}">
<p class="filter-field"><label for="project-title">${escapeHtml(t(locale, "projectTitleLabel"))}</label>
<input id="project-title" name="title" type="text" maxlength="140" required value="${escapeHtml(options.values.title)}"></p>
<p class="filter-field"><label for="project-summary">${escapeHtml(t(locale, "projectSummaryLabel"))}</label>
<textarea id="project-summary" name="summary" rows="4" maxlength="140" aria-describedby="project-summary-hint">${escapeHtml(options.values.summary)}</textarea>
<span class="hint" id="project-summary-hint">${escapeHtml(t(locale, "projectSummaryHint"))}</span></p>
<p class="form-actions"><button type="submit">${escapeHtml(t(locale, options.submitKey))}</button>
<a href="${escapeHtml(options.cancelHref)}">${escapeHtml(t(locale, "cancelAction"))}</a></p>
</form>`;
  return htmlResponse(
    options.status,
    renderPage(locale, url, t(locale, options.headingKey), content),
  );
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

  if (!sameOriginFormPost(request)) {
    return renderLogin(locale, url, returnTo, 400, "loginExpired");
  }

  const cookieCsrf = cookieValue(request.headers.get("cookie"), WEB_LOGIN_CSRF_COOKIE);
  // A duplicate hidden value is a malformed/expired form, not a generic
  // request error; keep it on the retry page with a fresh cookie.
  const formCsrfValues = form.getAll("login_csrf");
  if (formCsrfValues.length > 1) {
    return renderLogin(locale, url, returnTo, 400, "loginExpired");
  }
  const formCsrf = formCsrfValues[0] ?? null;
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
  if (!decision.allowed) {
    await recordLoginRateLimited(deps);
    throw new RateLimitError(decision.retryAfterSeconds);
  }

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
<dt>${escapeHtml(t(locale, "statusLabel"))}</dt><dd class="status">${escapeHtml(t(locale, "statusActive"))}</dd>
<dt>${escapeHtml(t(locale, "memberLabel"))}</dt><dd>${escapeHtml(project.member_display_name ?? t(locale, "unknownSpeaker"))}</dd>
</dl>
</article></li>`;
  })
  .join("\n")}
</ul>`;

  const content = `<h1>${escapeHtml(t(locale, "dashboardTitle"))}</h1>
<p><a href="/projects/new${localeQuery(locale)}">${escapeHtml(t(locale, "newProjectTitle"))}</a> <span aria-hidden="true">·</span> <a href="/speakers${localeQuery(locale)}">${escapeHtml(t(locale, "speakersTitle"))}</a></p>
${projects}`;
  return htmlResponse(200, renderPage(locale, url, t(locale, "dashboardTitle"), content));
}

function projectFormResponse(
  locale: Locale,
  url: URL,
  request: Request,
  options: {
    action: string;
    headingKey: MessageKey;
    submitKey: MessageKey;
    cancelHref: string;
    values: { title: string; summary: string };
    status: number;
    errorKey?: MessageKey;
  },
): Response {
  return renderProjectForm(locale, url, {
    ...options,
    csrf: cookieValue(request.headers.get("cookie"), CSRF_COOKIE_NAME) ?? "",
  });
}

async function handleNewProject(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
): Promise<Response> {
  await authenticateSession(deps, sessionTokenFromCookie(request.headers.get("cookie")));
  return projectFormResponse(locale, url, request, {
    action: `/projects${localeQuery(locale)}`,
    headingKey: "newProjectTitle",
    submitKey: "createProjectAction",
    cancelHref: `/${localeQuery(locale)}`,
    values: { title: "", summary: "" },
    status: 200,
  });
}

async function handleProjectCreate(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const form = await readForm(request);
  const parsed = projectFormValues(form);
  const values = parsed ?? { title: "", summary: "" };
  const formOptions = {
    action: `/projects${localeQuery(locale)}`,
    headingKey: "newProjectTitle" as const,
    submitKey: "createProjectAction" as const,
    cancelHref: `/${localeQuery(locale)}`,
    values,
  };
  if (!(await verifyFormCsrf(deps, session, request, form))) {
    return projectFormResponse(locale, url, request, {
      ...formOptions,
      status: 400,
      errorKey: "formExpired",
    });
  }
  if (parsed === null) {
    return projectFormResponse(locale, url, request, {
      ...formOptions,
      status: 400,
      errorKey: "projectFormError",
    });
  }
  try {
    const project = await createProject(deps, sessionAccountPrincipal(session), parsed);
    return redirect(
      303,
      `/projects/${encodeURIComponent(project.id)}${localeQuery(locale)}`,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return projectFormResponse(locale, url, request, {
        ...formOptions,
        status: 400,
        errorKey: "projectFormError",
      });
    }
    throw error;
  }
}

async function handleEditProject(
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
  const viewer = await resolveSessionViewer(deps, session, projectId, "project.edit");
  const project = await getProjectForEdit(deps, viewer, projectId);
  return projectFormResponse(locale, url, request, {
    action: `/projects/${encodeURIComponent(projectId)}${localeQuery(locale)}`,
    headingKey: "editProjectTitle",
    submitKey: "saveProjectAction",
    cancelHref: `/projects/${encodeURIComponent(projectId)}${localeQuery(locale)}`,
    values: { title: project.title, summary: project.summary ?? "" },
    status: 200,
  });
}

async function handleProjectUpdate(
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
  // Authorize and select the viewer before parsing the body, so an unreadable
  // project is the uniform 404 regardless of payload shape.
  const viewer = await resolveSessionViewer(deps, session, projectId, "project.edit");
  const form = await readForm(request);
  const parsed = projectFormValues(form);
  const values = parsed ?? { title: "", summary: "" };
  const formOptions = {
    action: `/projects/${encodeURIComponent(projectId)}${localeQuery(locale)}`,
    headingKey: "editProjectTitle" as const,
    submitKey: "saveProjectAction" as const,
    cancelHref: `/projects/${encodeURIComponent(projectId)}${localeQuery(locale)}`,
    values,
  };
  if (!(await verifyFormCsrf(deps, session, request, form))) {
    return projectFormResponse(locale, url, request, {
      ...formOptions,
      status: 400,
      errorKey: "formExpired",
    });
  }
  if (parsed === null) {
    return projectFormResponse(locale, url, request, {
      ...formOptions,
      status: 400,
      errorKey: "projectFormError",
    });
  }
  try {
    await updateProject(deps, viewer, projectId, parsed);
    return redirect(
      303,
      `/projects/${encodeURIComponent(projectId)}${localeQuery(locale)}`,
    );
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return projectFormResponse(locale, url, request, {
        ...formOptions,
        status: 400,
        errorKey: "projectFormError",
      });
    }
    throw error;
  }
}

function displaySpeakerName(speaker: {
  id: string;
  display_name: string | null;
}): string {
  return speaker.display_name === null || speaker.display_name === ""
    ? speaker.id
    : speaker.display_name;
}

function renderSpeakerDirectory(
  locale: Locale,
  speakers: readonly OwnedSpeaker[],
): string {
  const heading = `<h1>${escapeHtml(t(locale, "speakersTitle"))}</h1>`;
  if (speakers.length === 0) {
    return `${heading}
<p class="empty">${escapeHtml(t(locale, "speakersEmpty"))}</p>`;
  }
  const items = speakers
    .map((speaker, index) => {
      const nameId = `speaker-${index}-name`;
      const grants =
        speaker.projects.length === 0
          ? escapeHtml(t(locale, "speakerNoProjects"))
          : `<ul class="grant-list">${speaker.projects
              .map(
                (project) =>
                  `<li>${escapeHtml(project.title)} <code>${escapeHtml(project.id)}</code></li>`,
              )
              .join("")}</ul>`;
      const active = speaker.status === "active";
      const issue = active
        ? `<p><a href="/speakers/${encodeURIComponent(speaker.id)}/key${localeQuery(locale)}">${escapeHtml(t(locale, "issueCredentialAction"))}</a></p>`
        : "";
      return `<li><article aria-labelledby="${nameId}">
<h2 id="${nameId}">${escapeHtml(displaySpeakerName(speaker))}</h2>
<dl>
<dt>${escapeHtml(t(locale, "speakerNameLabel"))}</dt><dd><code>${escapeHtml(speaker.id)}</code></dd>
<dt>${escapeHtml(t(locale, "statusLabel"))}</dt><dd${active ? ' class="status"' : ""}>${escapeHtml(t(locale, active ? "statusActive" : "statusInactive"))}</dd>
<dt>${escapeHtml(t(locale, "speakerProjectsLabel"))}</dt><dd>${grants}</dd>
</dl>
${issue}
</article></li>`;
    })
    .join("\n");
  return `${heading}
<ul class="project-list">
${items}
</ul>`;
}

interface SpeakerKeyFormOptions {
  speaker: OwnedSpeakerForKey;
  action: string;
  csrf: string;
  selectedProjects: ReadonlySet<string>;
  selectedScopes: ReadonlySet<string>;
  status: number;
  errorKey?: MessageKey;
}

function renderSpeakerKeyForm(
  locale: Locale,
  url: URL,
  options: SpeakerKeyFormOptions,
): Response {
  const error =
    options.errorKey === undefined
      ? ""
      : `<p class="error" role="alert">${escapeHtml(t(locale, options.errorKey))}</p>`;
  const offeredScopes = new Set<string>();
  for (const project of options.speaker.projects) {
    for (const scope of project.capabilities) offeredScopes.add(scope);
  }
  const projects =
    options.speaker.projects.length === 0
      ? `<p class="empty">${escapeHtml(t(locale, "speakerNoProjects"))}</p>`
      : options.speaker.projects
          .map(
            (project) =>
              `<label><input type="checkbox" name="project" value="${escapeHtml(project.id)}"${options.selectedProjects.has(project.id) ? " checked" : ""}> ${escapeHtml(project.title)} <code>${escapeHtml(project.id)}</code></label>`,
          )
          .join("\n");
  const scopes = SCOPES.filter((scope) => offeredScopes.has(scope));
  const scopeBoxes =
    scopes.length === 0
      ? `<p class="empty">${escapeHtml(t(locale, "speakerNoScopes"))}</p>`
      : scopes
          .map(
            (scope) =>
              `<label><input type="checkbox" name="scope" value="${escapeHtml(scope)}"${options.selectedScopes.has(scope) ? " checked" : ""}> <code>${escapeHtml(scope)}</code></label>`,
          )
          .join("\n");
  const content = `<h1>${escapeHtml(t(locale, "issueCredentialTitle"))}</h1>
<p><a href="/speakers${localeQuery(locale)}">${escapeHtml(t(locale, "backToSpeakers"))}</a></p>
<p>${escapeHtml(t(locale, "speakerNameLabel"))}: ${escapeHtml(displaySpeakerName(options.speaker))} <code>${escapeHtml(options.speaker.id)}</code></p>
${error}<form class="project-form" method="post" action="${escapeHtml(options.action)}">
<input type="hidden" name="csrf_token" value="${escapeHtml(options.csrf)}">
<fieldset><legend>${escapeHtml(t(locale, "projectsLegend"))}</legend>
${projects}</fieldset>
<fieldset><legend>${escapeHtml(t(locale, "scopesLegend"))}</legend>
${scopeBoxes}</fieldset>
<p class="hint">${escapeHtml(t(locale, "issueCredentialHint"))}</p>
<p class="form-actions"><button type="submit">${escapeHtml(t(locale, "issueCredentialAction"))}</button>
<a href="/speakers${localeQuery(locale)}">${escapeHtml(t(locale, "cancelAction"))}</a></p>
</form>`;
  return htmlResponse(
    options.status,
    renderPage(locale, url, t(locale, "issueCredentialTitle"), content),
  );
}

function speakerKeyFormResponse(
  locale: Locale,
  url: URL,
  request: Request,
  options: Omit<SpeakerKeyFormOptions, "csrf">,
): Response {
  return renderSpeakerKeyForm(locale, url, {
    ...options,
    csrf: cookieValue(request.headers.get("cookie"), CSRF_COOKIE_NAME) ?? "",
  });
}

function renderIssuedCredential(
  locale: Locale,
  url: URL,
  speaker: OwnedSpeakerForKey,
  issued: IssuedCredential,
): Response {
  const titles = new Map(speaker.projects.map((project) => [project.id, project.title]));
  const projectList = issued.projects
    .map(
      (projectId) =>
        `<li>${escapeHtml(titles.get(projectId) ?? projectId)} <code>${escapeHtml(projectId)}</code></li>`,
    )
    .join("");
  const content = `<h1>${escapeHtml(t(locale, "credentialIssuedTitle"))}</h1>
<p class="filter-state" role="alert">${escapeHtml(t(locale, "credentialOnceWarning"))}</p>
<p>${escapeHtml(t(locale, "speakerNameLabel"))}: ${escapeHtml(displaySpeakerName(speaker))} <code>${escapeHtml(speaker.id)}</code></p>
<p>${escapeHtml(t(locale, "credentialLabel"))}: <code class="code">${escapeHtml(issued.token)}</code></p>
<dl>
<dt>${escapeHtml(t(locale, "credentialProjectsLabel"))}</dt><dd><ul class="grant-list">${projectList}</ul></dd>
<dt>${escapeHtml(t(locale, "credentialScopesLabel"))}</dt><dd>${issued.scopes.map((scope) => `<code>${escapeHtml(scope)}</code>`).join(" ")}</dd>
</dl>
<p><a href="/speakers${localeQuery(locale)}">${escapeHtml(t(locale, "backToSpeakers"))}</a></p>`;
  return htmlResponse(
    200,
    renderPage(locale, url, t(locale, "credentialIssuedTitle"), content),
  );
}

async function handleSpeakers(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const speakers = await listOwnedSpeakers(deps, sessionAccountPrincipal(session));
  return htmlResponse(
    200,
    renderPage(
      locale,
      url,
      t(locale, "speakersTitle"),
      renderSpeakerDirectory(locale, speakers),
    ),
  );
}

async function handleSpeakerKeyForm(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
  speakerId: string,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const speaker = await getOwnedSpeakerForKey(
    deps,
    sessionAccountPrincipal(session),
    speakerId,
  );
  return speakerKeyFormResponse(locale, url, request, {
    speaker,
    action: `/speakers/${encodeURIComponent(speakerId)}/key${localeQuery(locale)}`,
    selectedProjects: new Set(),
    selectedScopes: new Set(),
    status: 200,
  });
}

async function handleSpeakerKeyCreate(
  deps: ServiceDeps,
  request: Request,
  url: URL,
  locale: Locale,
  speakerId: string,
): Promise<Response> {
  const session = await authenticateSession(
    deps,
    sessionTokenFromCookie(request.headers.get("cookie")),
  );
  const principal = sessionAccountPrincipal(session);
  // Authorize the owned speaker before parsing the body, so a foreign or
  // unknown speaker is the uniform 404 regardless of payload shape.
  const speaker = await getOwnedSpeakerForKey(deps, principal, speakerId);
  const form = await readForm(request);
  const selectedProjects = new Set(form.getAll("project"));
  const selectedScopes = new Set(form.getAll("scope"));
  const formOptions = {
    speaker,
    action: `/speakers/${encodeURIComponent(speakerId)}/key${localeQuery(locale)}`,
    selectedProjects,
    selectedScopes,
  };
  if (!(await verifyFormCsrf(deps, session, request, form))) {
    return speakerKeyFormResponse(locale, url, request, {
      ...formOptions,
      status: 400,
      errorKey: "formExpired",
    });
  }
  try {
    const issued = await issueProjectCredential(deps, principal, speakerId, {
      projectIds: [...selectedProjects],
      scopes: [...selectedScopes],
    });
    // The only display of the raw token: this response is no-store and the
    // value is never put in redirect state, the database, a URL, or a log.
    return renderIssuedCredential(locale, url, speaker, issued);
  } catch (error) {
    if (error instanceof AppError && error.code === "VALIDATION_ERROR") {
      return speakerKeyFormResponse(locale, url, request, {
        ...formOptions,
        status: 400,
        errorKey: "issueCredentialError",
      });
    }
    throw error;
  }
}

function renderFilterForm(
  locale: Locale,
  projectId: string,
  url: URL,
  filters: TimelineFilters,
  limit: number,
): string {
  const langField = locale === "zh" ? `\n<input type="hidden" name="lang" value="zh">` : "";
  const unreadChecked = filters.unread === true ? " checked" : "";
  const resetHref = escapeHtml(
    hrefWithParams(url, {
      type: null,
      sender: null,
      q: null,
      unread: null,
      after_seq: null,
      before_seq: null,
    }),
  );
  const reset = hasActiveFilters(filters)
    ? ` <a href="${resetHref}">${escapeHtml(t(locale, "resetFilters"))}</a>`
    : "";
  return `<h2 id="filters-heading">${escapeHtml(t(locale, "filtersTitle"))}</h2>
<form class="filters" method="get" action="/projects/${escapeHtml(projectId)}" aria-labelledby="filters-heading">${langField}
<p class="filter-field"><label for="filter-type">${escapeHtml(t(locale, "filterTypeLabel"))}</label>
<input id="filter-type" name="type" type="text" maxlength="32" value="${escapeHtml(filters.type ?? "")}"></p>
<p class="filter-field"><label for="filter-sender">${escapeHtml(t(locale, "filterSenderLabel"))}</label>
<input id="filter-sender" name="sender" type="text" maxlength="128" value="${escapeHtml(filters.sender ?? "")}" aria-describedby="filter-sender-hint">
<span class="hint" id="filter-sender-hint">${escapeHtml(t(locale, "filterSenderHint"))}</span></p>
<p class="filter-field"><label for="filter-q">${escapeHtml(t(locale, "filterSearchLabel"))}</label>
<input id="filter-q" name="q" type="search" maxlength="${MAX_QUERY_CHARS}" value="${escapeHtml(filters.q ?? "")}" aria-describedby="filter-q-hint">
<span class="hint" id="filter-q-hint">${escapeHtml(t(locale, "filterSearchHint"))}</span></p>
<p class="filter-field filter-checkbox"><input id="filter-unread" name="unread" type="checkbox" value="true"${unreadChecked}>
<label for="filter-unread">${escapeHtml(t(locale, "filterUnreadLabel"))}</label></p>
<p class="filter-field"><label for="filter-limit">${escapeHtml(t(locale, "filterLimitLabel"))}</label>
<input id="filter-limit" name="limit" type="number" min="1" max="${MAX_TIMELINE_LIMIT}" step="1" inputmode="numeric" value="${limit}"></p>
<p class="filter-actions"><button type="submit">${escapeHtml(t(locale, "applyFilters"))}</button>${reset}</p>
</form>`;
}

function renderFilterState(locale: Locale, filters: TimelineFilters): string {
  const parts: string[] = [];
  if (filters.type !== undefined) {
    parts.push(
      `${escapeHtml(t(locale, "filterTypeLabel"))}: <code>${escapeHtml(filters.type)}</code>`,
    );
  }
  if (filters.sender !== undefined) {
    parts.push(
      `${escapeHtml(t(locale, "filterSenderLabel"))}: <code>${escapeHtml(filters.sender)}</code>`,
    );
  }
  if (filters.q !== undefined && filters.q !== "") {
    parts.push(
      `${escapeHtml(t(locale, "filterSearchLabel"))}: <code>${escapeHtml(filters.q)}</code>`,
    );
  }
  if (filters.unread === true) parts.push(escapeHtml(t(locale, "filterUnreadLabel")));
  if (filters.unread === false) parts.push(escapeHtml(t(locale, "filterReadOnlyLabel")));
  const body =
    parts.length === 0
      ? escapeHtml(t(locale, "filterNone"))
      : parts.join(' <span aria-hidden="true">·</span> ');
  return `<p class="filter-state"><strong>${escapeHtml(t(locale, "activeFilters"))}:</strong> ${body}</p>`;
}

function renderTimeline(
  locale: Locale,
  projectId: string,
  url: URL,
  messages: readonly MessageMetadata[],
  receipts: ReadonlyMap<string, ReadReceipt[]>,
  hasMore: boolean,
  filters: TimelineFilters,
): string {
  const afterRaw = queryText(url, "after_seq");
  const beforeRaw = queryText(url, "before_seq");
  const afterSeq = afterRaw === undefined ? undefined : Number(afterRaw);
  const beforeSeq = beforeRaw === undefined ? undefined : Number(beforeRaw);
  const pagerLabel = escapeHtml(t(locale, "paginationLabel"));
  const jump = `<a href="${escapeHtml(hrefWithParams(url, { before_seq: String(LATEST_SEQ), after_seq: null }))}">${escapeHtml(t(locale, "jumpToLatest"))}</a>`;

  if (messages.length === 0) {
    const empty = `<p class="empty">${escapeHtml(t(locale, hasActiveFilters(filters) ? "filteredEmpty" : "timelineEmpty"))}</p>`;
    const awayFromStart =
      afterSeq !== undefined || (beforeSeq !== undefined && beforeSeq !== LATEST_SEQ);
    return awayFromStart
      ? `${empty}\n<nav class="pager" aria-label="${pagerLabel}">${jump}</nav>`
      : empty;
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
  const links: string[] = [];
  if (first !== undefined && last !== undefined) {
    // Without a cursor the page starts at the oldest sequence, so there is no
    // older page. A before_seq page has older rows only when the service
    // reported another row; an after_seq page may still have earlier rows.
    const hasOlder =
      afterSeq !== undefined
        ? afterSeq > 0
        : beforeSeq !== undefined
          ? hasMore
          : false;
    // A short page consumed every remaining matching row, so it is the newest.
    const hasNewer =
      beforeSeq !== undefined ? beforeSeq !== LATEST_SEQ : hasMore;
    if (hasOlder) {
      links.push(
        `<a rel="prev" href="${escapeHtml(hrefWithParams(url, { before_seq: String(first.seq), after_seq: null }))}">${escapeHtml(t(locale, "olderMessages"))}</a>`,
      );
    }
    if (hasNewer) {
      links.push(
        `<a rel="next" href="${escapeHtml(hrefWithParams(url, { after_seq: String(last.seq), before_seq: null }))}">${escapeHtml(t(locale, "newerMessages"))}</a>`,
      );
      if (beforeSeq !== LATEST_SEQ) links.push(jump);
    }
  }
  const pager =
    links.length === 0
      ? ""
      : `\n<nav class="pager" aria-label="${pagerLabel}">${links.join(" ")}</nav>`;
  return `<ol class="timeline">
${items}
</ol>${pager}`;
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

  const limit = queryInt(url, "limit", 1, MAX_TIMELINE_LIMIT) ?? DEFAULT_TIMELINE_LIMIT;
  const afterSeq = queryInt(url, "after_seq", 0, Number.MAX_SAFE_INTEGER);
  const beforeSeq = queryInt(url, "before_seq", 0, Number.MAX_SAFE_INTEGER);
  const filters = timelineFiltersFrom(url);
  const query: ListMessagesQuery = { limit };
  if (afterSeq !== undefined) query.afterSeq = afterSeq;
  if (beforeSeq !== undefined) query.beforeSeq = beforeSeq;
  if (filters.type !== undefined) query.type = filters.type;
  if (filters.sender !== undefined) query.sender = filters.sender;
  if (filters.q !== undefined) query.q = filters.q;
  if (filters.unread !== undefined) query.unread = filters.unread;

  const result = await listMessages(deps, viewer, projectId, query);
  const receipts = await listReadReceipts(
    deps,
    viewer,
    projectId,
    result.messages.map((message) => message.messageId),
  );
  // Owners see the edit link; a non-owner's NOT_FOUND simply omits it. This
  // does not change the read authorization already performed above.
  let editLink = "";
  try {
    await resolveSessionViewer(deps, session, projectId, "project.edit");
    editLink = ` <span aria-hidden="true">·</span> <a href="/projects/${escapeHtml(projectId)}/edit${localeQuery(locale)}">${escapeHtml(t(locale, "editProjectTitle"))}</a>`;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "NOT_FOUND") throw error;
  }

  const content = `<p><a href="/${localeQuery(locale)}">${escapeHtml(t(locale, "backToProjects"))}</a>${editLink}</p>
<h1>${escapeHtml(project.title)}</h1>
${renderFilterForm(locale, projectId, url, filters, limit)}
<h2>${escapeHtml(t(locale, "timelineTitle"))}</h2>
${renderFilterState(locale, filters)}
${renderTimeline(locale, projectId, url, result.messages, receipts, result.hasMore, filters)}`;
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
  if (segments.length === 1 && segments[0] === "projects") return true;
  if (segments.length === 1 && segments[0] === "speakers") return true;
  if (segments.length === 2 && segments[0] === "static" && segments[1] === "app.css") {
    return true;
  }
  if (
    segments.length === 3 &&
    segments[0] === "speakers" &&
    segments[2] === "key"
  ) {
    return true;
  }
  if (segments.length === 2 && segments[0] === "projects") return true;
  if (
    segments.length === 3 &&
    segments[0] === "projects" &&
    segments[2] === "edit"
  ) {
    return true;
  }
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
    if (segments.length === 1 && segments[0] === "speakers") {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return await handleSpeakers(deps, request, url, locale);
    }
    if (
      segments.length === 3 &&
      segments[0] === "speakers" &&
      segments[2] === "key"
    ) {
      if (method === "GET") {
        return await handleSpeakerKeyForm(deps, request, url, locale, segments[1] ?? "");
      }
      if (method === "POST") {
        return await handleSpeakerKeyCreate(deps, request, url, locale, segments[1] ?? "");
      }
      return methodNotAllowed(locale, url, "GET, POST");
    }
    if (segments.length === 1 && segments[0] === "projects") {
      if (method !== "POST") return methodNotAllowed(locale, url, "POST");
      return await handleProjectCreate(deps, request, url, locale);
    }
    if (segments.length === 2 && segments[0] === "projects") {
      if (segments[1] === "new") {
        if (method !== "GET") return methodNotAllowed(locale, url, "GET");
        return await handleNewProject(deps, request, url, locale);
      }
      if (method === "GET") {
        return await handleTimeline(deps, request, url, locale, segments[1] ?? "");
      }
      if (method === "POST") {
        return await handleProjectUpdate(deps, request, url, locale, segments[1] ?? "");
      }
      return methodNotAllowed(locale, url, "GET, POST");
    }
    if (
      segments.length === 3 &&
      segments[0] === "projects" &&
      segments[2] === "edit"
    ) {
      if (method !== "GET") return methodNotAllowed(locale, url, "GET");
      return await handleEditProject(deps, request, url, locale, segments[1] ?? "");
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
