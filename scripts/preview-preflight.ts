#!/usr/bin/env node
// Credential-safe HTTP preflight for a private Corkboard preview deployment.
// Prints only check names, HTTP statuses, and pass/fail. It never prints
// response bodies, credentials, cookies, or URLs; every response is capped at
// 1 MiB.
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { CSRF_COOKIE_NAME, SESSION_COOKIE_NAME } from "../src/service/sessions.ts";

const O_NOFOLLOW =
  typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
const TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 1 << 20;
const TOKEN_PATTERN = /^cb_[A-Za-z0-9_-]{20,}$/;
const PROJECT_PATTERN = /^[A-Za-z0-9_.-]{1,200}$/;
const PREFLIGHT_KEY = "corkboard-preview-preflight-fixed-key";
const PREFLIGHT_SUMMARY = "Corkboard preview preflight";
const CSRF_HEADER = "X-CSRF-Token";
const PREFLIGHT_TEXT =
  "Corkboard preview preflight synthetic message; safe to discard with the preview volume.";
const CONFLICT_TEXT = `${PREFLIGHT_TEXT} conflict probe`;

const OPTIONS = {
  "base-url": { type: "string" },
  "credential-file": { type: "string" },
  project: { type: "string" },
  "revoked-credential-file": { type: "string" },
  "nonmember-credential-file": { type: "string" },
  login: { type: "string" },
  "password-file": { type: "string" },
} as const;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreflightError";
  }
}

export interface PreflightOptions {
  baseUrl: string;
  project: string;
  credentialFile: string;
  revokedCredentialFile?: string;
  nonmemberCredentialFile?: string;
  login?: string;
  passwordFile?: string;
}

export interface PreflightDeps {
  fetchImpl?: FetchLike;
  print?: (line: string) => void;
}

export interface PreflightSummary {
  passed: number;
  failed: number;
}

interface CallResult {
  status?: number;
  response?: Response;
  reason?: string;
}

interface CheckOutcome {
  name: string;
  ok: boolean;
  detail: string;
}

interface ParsedCookie {
  name: string;
  value: string;
  attrs: Map<string, string | true>;
}

function requireOption(value: string | undefined, name: string): string {
  if (value === undefined || value === "") throw new PreflightError(`${name} is required`);
  return value;
}

function optionalOption(value: string | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (value === "") throw new PreflightError(`${name} must not be empty`);
  return value;
}

function readValues(argv: readonly string[]) {
  try {
    return parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      options: OPTIONS,
    }).values;
  } catch {
    throw new PreflightError(
      "invalid arguments; pass --base-url, --credential-file, and --project, and use --help-free options only",
    );
  }
}

function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host === "127.0.0.1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

export function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PreflightError("--base-url must be an absolute URL");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PreflightError("--base-url must not contain credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new PreflightError("--base-url must not contain a query or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new PreflightError("--base-url must be an origin only (no path)");
  }
  const isHttps = url.protocol === "https:";
  const isLoopbackHttp = url.protocol === "http:" && isLoopback(url.hostname);
  if (!isHttps && !isLoopbackHttp) {
    throw new PreflightError("--base-url must use https, or http only on a loopback host");
  }
  return url.origin;
}

function parseProject(raw: string): string {
  if (!PROJECT_PATTERN.test(raw)) throw new PreflightError("--project is not a valid project id");
  return raw;
}

function parseLogin(raw: string): string {
  if (raw === "" || /\s/.test(raw) || Buffer.byteLength(raw, "utf8") > 254) {
    throw new PreflightError("--login must be an email address of at most 254 characters");
  }
  return raw;
}

export function parseCliArgs(argv: readonly string[]): PreflightOptions {
  const values = readValues(argv);
  const login = optionalOption(values.login, "--login");
  const passwordFile = optionalOption(values["password-file"], "--password-file");
  const revokedCredentialFile = optionalOption(
    values["revoked-credential-file"],
    "--revoked-credential-file",
  );
  const nonmemberCredentialFile = optionalOption(
    values["nonmember-credential-file"],
    "--nonmember-credential-file",
  );
  if ((login === undefined) !== (passwordFile === undefined)) {
    throw new PreflightError("--login and --password-file must be supplied together");
  }
  return {
    baseUrl: parseBaseUrl(requireOption(values["base-url"], "--base-url")),
    project: parseProject(requireOption(values.project, "--project")),
    credentialFile: requireOption(values["credential-file"], "--credential-file"),
    ...(revokedCredentialFile === undefined ? {} : { revokedCredentialFile }),
    ...(nonmemberCredentialFile === undefined ? {} : { nonmemberCredentialFile }),
    ...(login === undefined ? {} : { login: parseLogin(login) }),
    ...(passwordFile === undefined ? {} : { passwordFile }),
  };
}

// Read a private operator file through an O_NOFOLLOW handle and check the
// opened descriptor, so a path swapped after open cannot redirect the read.
function readPrivateText(path: string, label: string): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    throw new PreflightError(`${label} is not readable or is a symbolic link`);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new PreflightError(`${label} must be a regular file`);
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw new PreflightError(`${label} must have mode 0600`);
    }
    try {
      return readFileSync(fd, "utf8");
    } catch {
      throw new PreflightError(`${label} is not readable`);
    }
  } finally {
    closeSync(fd);
  }
}

export function readCredentialFile(path: string, label = "--credential-file"): string {
  const token = readPrivateText(path, label).trim();
  if (!TOKEN_PATTERN.test(token)) {
    throw new PreflightError(`${label} must contain one cb_ credential`);
  }
  return token;
}

export function readPasswordFile(path: string): string {
  const password = readPrivateText(path, "--password-file").replace(/\r?\n$/, "");
  if (password === "" || Buffer.byteLength(password, "utf8") > 1024) {
    throw new PreflightError(
      "--password-file must contain a non-empty password of at most 1024 UTF-8 bytes",
    );
  }
  return password;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

// Responses are capped at 1 MiB. A hostile endpoint cannot make the preflight
// buffer an unbounded body, and body content is never printed.
async function readJson(response: Response): Promise<Record<string, unknown> | undefined> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim())) {
    if (Number(declared) > MAX_RESPONSE_BYTES) {
      try {
        await response.body?.cancel();
      } catch {
        // The oversized response is rejected regardless.
      }
      return undefined;
    }
  }
  const stream = response.body;
  if (stream === null) return undefined;
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The oversized response is rejected regardless.
        }
        return undefined;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    try {
      await reader.cancel();
    } catch {
      // The unreadable response is rejected regardless.
    }
    return undefined;
  }
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function digestFor(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function setCookieLines(headers: Headers): string[] {
  const withCookies = headers as Headers & { getSetCookie?: () => string[] };
  return withCookies.getSetCookie?.() ?? [];
}

function parseSetCookie(line: string): ParsedCookie | undefined {
  const parts = line.split(";");
  const pair = (parts[0] ?? "").trim();
  const equals = pair.indexOf("=");
  if (equals <= 0) return undefined;
  const name = pair.slice(0, equals).trim();
  const value = pair.slice(equals + 1).trim();
  if (name === "") return undefined;
  const attrs = new Map<string, string | true>();
  for (const part of parts.slice(1)) {
    const attribute = part.trim();
    if (attribute === "") continue;
    const separator = attribute.indexOf("=");
    if (separator < 0) {
      attrs.set(attribute.toLowerCase(), true);
    } else {
      attrs.set(
        attribute.slice(0, separator).trim().toLowerCase(),
        attribute.slice(separator + 1).trim(),
      );
    }
  }
  return { name, value, attrs };
}

function cookieProblem(session: ParsedCookie | undefined, csrf: ParsedCookie | undefined): string | undefined {
  if (session === undefined) return "missing session cookie";
  if (session.name !== SESSION_COOKIE_NAME) return "session cookie name mismatch";
  if (session.value === "") return "empty session cookie";
  if (session.attrs.get("secure") !== true) return "session cookie missing Secure";
  if (session.attrs.get("httponly") !== true) return "session cookie missing HttpOnly";
  if (stringValue(session.attrs.get("samesite"))?.toLowerCase() !== "strict") {
    return "session cookie missing SameSite=Strict";
  }
  if (session.attrs.get("path") !== "/") return "session cookie missing Path=/";
  if (session.attrs.has("domain")) return "session cookie must not set Domain";
  if (csrf === undefined) return "missing CSRF cookie";
  if (csrf.value === "") return "empty CSRF cookie";
  if (csrf.attrs.get("secure") !== true) return "CSRF cookie missing Secure";
  if (stringValue(csrf.attrs.get("samesite"))?.toLowerCase() !== "strict") {
    return "CSRF cookie missing SameSite=Strict";
  }
  if (csrf.attrs.get("path") !== "/") return "CSRF cookie missing Path=/";
  if (csrf.attrs.get("httponly") === true) return "CSRF cookie must not be HttpOnly";
  return undefined;
}

async function call(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<CallResult> {
  try {
    const response = await fetchImpl(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, response };
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    return { reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network error" };
  }
}

function failureDetail(result: CallResult): string {
  if (result.reason !== undefined) return result.reason;
  return result.status === undefined ? "no response" : `status ${result.status}`;
}

export async function runPreflight(
  options: PreflightOptions,
  deps: PreflightDeps = {},
): Promise<PreflightSummary> {
  const fetchImpl: FetchLike = deps.fetchImpl ?? ((input, init) => fetch(input, init));
  const print = deps.print ?? ((line: string) => console.log(line));
  const outcomes: CheckOutcome[] = [];

  // Validate every supplied private file before the first request. A broken
  // file is a usage error, not a check failure.
  const credential = readCredentialFile(options.credentialFile, "--credential-file");
  const revoked =
    options.revokedCredentialFile === undefined
      ? undefined
      : readCredentialFile(options.revokedCredentialFile, "--revoked-credential-file");
  const nonmember =
    options.nonmemberCredentialFile === undefined
      ? undefined
      : readCredentialFile(options.nonmemberCredentialFile, "--nonmember-credential-file");
  const password =
    options.passwordFile === undefined ? undefined : readPasswordFile(options.passwordFile);

  const pass = (name: string, detail: string): true => {
    outcomes.push({ name, ok: true, detail });
    print(`PASS ${name} (${detail})`);
    return true;
  };
  const fail = (name: string, detail: string): false => {
    outcomes.push({ name, ok: false, detail });
    print(`FAIL ${name} (${detail})`);
    return false;
  };
  const finish = (): PreflightSummary => {
    const passed = outcomes.filter((outcome) => outcome.ok).length;
    const failed = outcomes.length - passed;
    print(`preflight: ${passed} passed, ${failed} failed`);
    return { passed, failed };
  };
  const auth = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
  });
  const base = options.baseUrl;
  const projectPath = (suffix = ""): string =>
    `/api/v1/projects/${encodeURIComponent(options.project)}${suffix}`;
  const messagePath = projectPath("/messages");
  const payloadFor = (text: string): Record<string, unknown> => ({
    summary: PREFLIGHT_SUMMARY,
    type: "preflight",
    language: "en",
    text,
    body_digest: digestFor(text),
  });
  const postMessage = (text: string): Promise<CallResult> =>
    call(fetchImpl, `${base}${messagePath}`, {
      method: "POST",
      headers: {
        ...auth(credential),
        "Content-Type": "application/json",
        "Idempotency-Key": PREFLIGHT_KEY,
      },
      body: JSON.stringify(payloadFor(text)),
    });

  // Liveness. An unreachable or unhealthy service stops the run.
  const health = await call(fetchImpl, `${base}/healthz`, { method: "GET" });
  if (health.status !== 200 || health.response === undefined) {
    fail("healthz", failureDetail(health));
    return finish();
  }
  if ((await readJson(health.response))?.status !== "ok") {
    fail("healthz", "unexpected JSON");
    return finish();
  }
  pass("healthz", "200");

  const ready = await call(fetchImpl, `${base}/readyz`, { method: "GET" });
  if (ready.status !== 200 || ready.response === undefined) {
    fail("readyz", failureDetail(ready));
    return finish();
  }
  if ((await readJson(ready.response))?.status !== "ready") {
    fail("readyz", "unexpected JSON");
    return finish();
  }
  pass("readyz", "200");

  const anonymous = await call(fetchImpl, `${base}/api/v1/me`, { method: "GET" });
  if (anonymous.status !== 401) {
    fail("unauthenticated_401", failureDetail(anonymous));
    return finish();
  }
  pass("unauthenticated_401", "401");

  const meResult = await call(fetchImpl, `${base}/api/v1/me`, {
    method: "GET",
    headers: auth(credential),
  });
  if (meResult.status !== 200 || meResult.response === undefined) {
    fail("me_binding", failureDetail(meResult));
    return finish();
  }
  const me = await readJson(meResult.response);
  const speakerId = stringValue(record(me?.speaker)?.id);
  const accountId = stringValue(record(me?.account)?.id);
  const scopes = stringArray(me?.scopes);
  const projects = stringArray(me?.projects);
  if (speakerId === undefined || accountId === undefined) {
    fail("me_binding", "unexpected JSON");
    return finish();
  }
  if (!scopes.includes("message.read") || !scopes.includes("message.send")) {
    fail("me_binding", "credential lacks message scopes");
    return finish();
  }
  if (!projects.includes(options.project)) {
    fail("me_binding", "project is not granted to this credential");
    return finish();
  }
  pass("me_binding", "200");

  const list = await call(fetchImpl, `${base}${messagePath}?limit=1`, {
    method: "GET",
    headers: auth(credential),
  });
  if (list.status !== 200 || list.response === undefined) {
    fail("list_messages", failureDetail(list));
    return finish();
  }
  if (!Array.isArray((await readJson(list.response))?.messages)) {
    fail("list_messages", "unexpected JSON");
    return finish();
  }
  pass("list_messages", "200");

  const expectedDigest = digestFor(PREFLIGHT_TEXT);
  const first = await postMessage(PREFLIGHT_TEXT);
  if ((first.status !== 201 && first.status !== 200) || first.response === undefined) {
    fail("send_message", failureDetail(first));
    return finish();
  }
  const firstBody = await readJson(first.response);
  const messageId = stringValue(firstBody?.message_id);
  const seq = typeof firstBody?.seq === "number" ? firstBody.seq : undefined;
  if (
    messageId === undefined ||
    seq === undefined ||
    firstBody?.project_id !== options.project ||
    firstBody?.digest !== expectedDigest
  ) {
    fail("send_message", "unexpected JSON");
    return finish();
  }
  pass("send_message", `${first.status ?? "unknown"}`);

  const bodyResult = await call(
    fetchImpl,
    `${base}${projectPath(`/messages/${encodeURIComponent(messageId)}/body`)}`,
    { method: "GET", headers: auth(credential) },
  );
  if (bodyResult.status !== 200 || bodyResult.response === undefined) {
    fail("body_read", failureDetail(bodyResult));
    return finish();
  }
  const body = await readJson(bodyResult.response);
  if (
    body?.message_id !== messageId ||
    body?.text !== PREFLIGHT_TEXT ||
    body?.digest !== expectedDigest
  ) {
    fail("body_read", "unexpected JSON");
    return finish();
  }
  pass("body_read", "200");

  const readResult = await call(
    fetchImpl,
    `${base}${projectPath(`/messages/${encodeURIComponent(messageId)}/read`)}`,
    { method: "POST", headers: auth(credential) },
  );
  if (readResult.status !== 200 || readResult.response === undefined) {
    fail("mark_read", failureDetail(readResult));
    return finish();
  }
  const receipt = await readJson(readResult.response);
  if (
    receipt?.message_id !== messageId ||
    receipt?.speaker_id !== speakerId ||
    stringValue(receipt?.read_at) === undefined
  ) {
    fail("mark_read", "unexpected JSON");
    return finish();
  }
  pass("mark_read", "200");

  const replay = await postMessage(PREFLIGHT_TEXT);
  if (replay.status !== 200 || replay.response === undefined) {
    fail("replay", failureDetail(replay));
    return finish();
  }
  const replayBody = await readJson(replay.response);
  if (replayBody?.message_id !== messageId || replayBody?.seq !== seq) {
    fail("replay", "unexpected JSON");
    return finish();
  }
  pass("replay", "200");

  const conflict = await postMessage(CONFLICT_TEXT);
  if (conflict.status !== 409 || conflict.response === undefined) {
    fail("idempotency_conflict", failureDetail(conflict));
    return finish();
  }
  if (record((await readJson(conflict.response))?.error)?.code !== "CONFLICT") {
    fail("idempotency_conflict", "unexpected JSON");
    return finish();
  }
  pass("idempotency_conflict", "409");

  // Optional independent checks.
  if (revoked !== undefined) {
    const result = await call(fetchImpl, `${base}/api/v1/me`, {
      method: "GET",
      headers: auth(revoked),
    });
    if (result.status === 401) {
      pass("revoked_credential_401", "401");
    } else if (result.status === 200) {
      fail("revoked_credential_401", "credential still accepted");
    } else {
      fail("revoked_credential_401", failureDetail(result));
    }
  }

  if (nonmember !== undefined) {
    const result = await call(fetchImpl, `${base}${projectPath()}`, {
      method: "GET",
      headers: auth(nonmember),
    });
    if (result.status === 404 && result.response !== undefined) {
      const error = record((await readJson(result.response))?.error);
      if (error?.code === "NOT_FOUND") {
        pass("nonmember_404", "404");
      } else {
        fail("nonmember_404", "unexpected JSON");
      }
    } else {
      fail("nonmember_404", failureDetail(result));
    }
  }

  if (options.login !== undefined && password !== undefined) {
    const loginResult = await call(fetchImpl, `${base}/api/v1/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: options.login, password }),
    });
    if (loginResult.status !== 200 || loginResult.response === undefined) {
      fail("login_cookie_flags", failureDetail(loginResult));
    } else {
      const parsedCookies = setCookieLines(loginResult.response.headers)
        .map(parseSetCookie)
        .filter((cookie): cookie is ParsedCookie => cookie !== undefined);
      const sessionCookie = parsedCookies.find((cookie) => cookie.name === SESSION_COOKIE_NAME);
      const csrfCookie = parsedCookies.find((cookie) => cookie.name === CSRF_COOKIE_NAME);
      const problem = cookieProblem(sessionCookie, csrfCookie);
      if (problem === undefined) {
        pass("login_cookie_flags", "200");
      } else {
        fail("login_cookie_flags", problem);
      }
      if (sessionCookie !== undefined && csrfCookie !== undefined) {
        const cookieHeader = `${sessionCookie.name}=${sessionCookie.value}; ${csrfCookie.name}=${csrfCookie.value}`;
        const withoutCsrf = await call(fetchImpl, `${base}/api/v1/session`, {
          method: "DELETE",
          headers: { Cookie: cookieHeader },
        });
        if (withoutCsrf.status === 403) {
          pass("csrf_rejection", "403");
          const withCsrf = await call(fetchImpl, `${base}/api/v1/session`, {
            method: "DELETE",
            headers: { Cookie: cookieHeader, [CSRF_HEADER]: csrfCookie.value },
          });
          if (withCsrf.status === 204) {
            pass("csrf_signout", "204");
          } else {
            fail("csrf_signout", failureDetail(withCsrf));
          }
        } else {
          fail("csrf_rejection", failureDetail(withoutCsrf));
          fail("csrf_signout", "not attempted");
        }
      } else {
        fail("csrf_rejection", "login cookies missing");
        fail("csrf_signout", "login cookies missing");
      }
    }
  }

  return finish();
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  let options: PreflightOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(
      `preflight: ${error instanceof PreflightError ? error.message : "invalid arguments"}`,
    );
    return 2;
  }
  try {
    const summary = await runPreflight(options);
    return summary.failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(
      `preflight: ${error instanceof PreflightError ? error.message : "preflight failed"}`,
    );
    return error instanceof PreflightError ? 2 : 1;
  }
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
