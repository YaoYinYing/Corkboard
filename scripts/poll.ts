#!/usr/bin/env node
// At-least-once polling client for one Corkboard project.
//
// Message summaries are untrusted data. This client never executes a message,
// never prints a body, and prints summary metadata only when --show-summary is
// passed. The bearer credential is read from the environment or a 0600 file and
// is never printed, logged, or placed in a URL.
//
// Durability rule: the durable after_seq cursor advances only after the body has
// been fetched and verified, the consumer's processing step returned, and its
// explicit mark_read was confirmed. Without --consume (and without an embedder
// callback) the pass is metadata observation only. A crash or an uncertain
// mark_read therefore reprocesses at least the last message. Dedupe is the
// consumer's responsibility.
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 100;
export const DEFAULT_MAX_PAGES = 5;
export const MAX_PAGES = 100;
export const DEFAULT_INTERVAL_MS = 5_000;
export const MARK_READ_ATTEMPTS = 3;
export const REQUEST_TIMEOUT_MS = 15_000;
// Every response body, including error bodies, is streamed through this hard
// cap. Content-Length is never trusted.
export const MAX_RESPONSE_BYTES = 1 << 20;
export const CURSOR_VERSION = 1;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;
const O_NOFOLLOW = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;

export interface PollMessage {
  messageId: string;
  projectId: string;
  seq: number;
  senderId: string;
  summary: string;
  bodyState: "ready" | "expired";
}

export interface CursorState {
  version: 1;
  project_id: string;
  speaker_id: string;
  after_seq: number;
  updated_at: string;
}

export interface PollContext {
  fetchImpl?: typeof fetch | undefined;
  now?: (() => Date) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  stdout?: ((line: string) => void) | undefined;
  stderr?: ((line: string) => void) | undefined;
  signal?: AbortSignal | undefined;
  requestTimeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
}

export type MessageHandler = (
  message: PollMessage,
  body: string,
) => void | Promise<void>;

export interface PollPassOptions extends PollContext {
  baseUrl: string;
  token: string;
  projectId: string;
  speakerId: string;
  cursorPath: string;
  afterSeq: number;
  limit?: number | undefined;
  maxPages?: number | undefined;
  showSummary?: boolean | undefined;
  consume?: boolean | undefined;
  onMessage?: MessageHandler | undefined;
}

export interface PollPassResult {
  afterSeq: number;
  processed: number;
  pages: number;
  stopped: boolean;
}

export interface RunOptions extends PollContext {
  baseUrl: string;
  token: string;
  projectId: string;
  cursorPath: string;
  limit?: number | undefined;
  maxPages?: number | undefined;
  showSummary?: boolean | undefined;
  consume?: boolean | undefined;
  onMessage?: MessageHandler | undefined;
  once?: boolean | undefined;
  intervalMs?: number | undefined;
}

export class PollError extends Error {
  readonly exitCode: number;
  readonly code: string;

  constructor(exitCode: number, code: string, message: string) {
    super(message);
    this.name = "PollError";
    this.exitCode = exitCode;
    this.code = code;
  }
}

interface RequestContext {
  fetchImpl: typeof fetch;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  maxBytes: number;
}

interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

interface ListPage {
  messages: PollMessage[];
  nextCursor: number | null;
}

export type MarkReadOutcome = "read" | "expired";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function protocolError(message: string): PollError {
  return new PollError(3, "UNSAFE_RESPONSE", message);
}

// Sleep that clears its timer and resolves promptly on abort. Used for the
// between-pass delay and mark_read retry backoff.
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const done = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

// Redact the credential from every line this client emits. This also covers a
// hostile summary that echoes the token back.
export function redact(text: string, secret: string): string {
  return secret === "" ? text : text.split(secret).join("[REDACTED]");
}

// Escape C0/C1 and bidirectional formatting characters without quoting ordinary
// text. Callers redact first so a credential containing control characters is
// matched in its original form before any escaping.
export function escapeForTerminal(value: string): string {
  return value.replace(
    /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

export function redactAndEscape(value: string, secret: string): string {
  return escapeForTerminal(redact(value, secret));
}

function requestContext(options: PollContext): RequestContext {
  return {
    fetchImpl: options.fetchImpl ?? globalThis.fetch,
    signal: options.signal,
    timeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    maxBytes: options.maxResponseBytes ?? MAX_RESPONSE_BYTES,
  };
}

// Combine the caller's stop signal with a request timeout without relying on
// AbortSignal.any, so the helper keeps working on older runtimes. The controller
// stays live until the body has been read, so aborting it also aborts a stalled
// body stream.
function timeoutSignal(
  parent: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; abort: () => void; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const forward = (): void => controller.abort();
  if (parent !== undefined) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener("abort", forward, { once: true });
  }
  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    cancel: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", forward);
    },
  };
}

// Stream every body through a hard byte cap; Content-Length is never trusted.
// Aborting the scoped controller cancels the response stream.
async function readCappedBody(
  response: Response,
  abort: () => void,
  parent: AbortSignal | undefined,
  timedOut: () => boolean,
  maxBytes: number,
): Promise<string> {
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        abort();
        await reader.cancel().catch(() => {});
        throw new PollError(3, "BODY_TOO_LARGE", `response body exceeded ${maxBytes} bytes`);
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof PollError) throw error;
    if (parent?.aborted) throw new PollError(0, "STOPPED", "stopped by signal");
    if (timedOut()) throw new PollError(1, "TIMEOUT", "response body read timed out");
    throw new PollError(1, "BODY_READ_FAILED", "response body read failed");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled.
    }
  }
}

async function request(
  context: RequestContext,
  url: string,
  method: "GET" | "POST",
  token: string,
): Promise<HttpResponse> {
  const scoped = timeoutSignal(context.signal, context.timeoutMs);
  try {
    const response = await context.fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      },
      signal: scoped.signal,
    });
    const text = await readCappedBody(
      response,
      scoped.abort,
      context.signal,
      () => scoped.signal.aborted && context.signal?.aborted !== true,
      context.maxBytes,
    );
    return { status: response.status, ok: response.ok, headers: response.headers, text };
  } catch (error) {
    if (error instanceof PollError) throw error;
    if (context.signal?.aborted) {
      throw new PollError(0, "STOPPED", "stopped by signal");
    }
    if (scoped.signal.aborted) {
      throw new PollError(1, "TIMEOUT", `${method} request timed out`);
    }
    throw new PollError(1, "NETWORK", `${method} request failed`);
  } finally {
    scoped.cancel();
  }
}

function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw protocolError(`${label} response is not valid JSON`);
  }
}

function parseJsonQuiet(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Read only the stable server error code. Tags, titles, and message text stay
// out of the client's output.
function serverErrorCode(response: HttpResponse): string | undefined {
  const parsed = parseJsonQuiet(response.text);
  if (!isRecord(parsed) || !isRecord(parsed.error)) return undefined;
  return typeof parsed.error.code === "string" ? parsed.error.code : undefined;
}

// Redact before escaping so a credential containing control characters cannot
// slip through as an escaped sequence.
function codeSuffix(code: string | undefined, token: string): string {
  return code === undefined ? "" : ` (${escapeForTerminal(redact(code, token))})`;
}

function retryDelay(response: HttpResponse, attempt: number): number {
  const header = response.headers.get("retry-after");
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 5_000);
  }
  return 250 * attempt;
}

export function validateListPayload(
  payload: unknown,
  projectId: string,
  afterSeq: number,
  limit: number,
): ListPage {
  if (!isRecord(payload) || !Array.isArray(payload.messages)) {
    throw protocolError("message list response is malformed");
  }
  if (!("next_cursor" in payload)) {
    throw protocolError("message list response has no next_cursor");
  }
  if (payload.messages.length > limit) {
    throw protocolError("message list exceeded the requested limit");
  }

  const messages: PollMessage[] = [];
  let previousSeq = afterSeq;
  for (const entry of payload.messages) {
    if (!isRecord(entry)) throw protocolError("message row is malformed");
    if (entry.project_id !== projectId) {
      throw protocolError("message row belongs to a different project");
    }
    const messageId = entry.message_id;
    const seq = entry.seq;
    const sender = entry.sender;
    const summary = entry.summary;
    const type = entry.type;
    const language = entry.language;
    const bodyState = entry.body_state;
    if (typeof messageId !== "string" || messageId === "") {
      throw protocolError("message row has no valid message_id");
    }
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= previousSeq) {
      throw protocolError("message row has an invalid or non-increasing seq");
    }
    if (
      !isRecord(sender) ||
      typeof sender.id !== "string" ||
      sender.id === "" ||
      typeof sender.display_name !== "string"
    ) {
      throw protocolError("message row has no valid sender");
    }
    if (
      typeof summary !== "string" ||
      typeof type !== "string" ||
      typeof language !== "string"
    ) {
      throw protocolError("message row has malformed metadata");
    }
    if (bodyState !== "ready" && bodyState !== "expired") {
      throw protocolError("message row has an invalid body_state");
    }
    if (typeof entry.received_at !== "string" || typeof entry.committed_at !== "string") {
      throw protocolError("message row has malformed timestamps");
    }
    previousSeq = seq;
    messages.push({
      messageId,
      projectId,
      seq,
      senderId: sender.id,
      summary,
      bodyState,
    });
  }

  const last = messages.at(-1);
  const expectedCursor = last === undefined ? null : last.seq;
  if (payload.next_cursor !== expectedCursor) {
    throw protocolError("message list next_cursor does not match the returned rows");
  }
  return { messages, nextCursor: expectedCursor };
}

export function parseCursorState(
  text: string,
  projectId: string,
  speakerId: string,
): CursorState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw protocolError("cursor file is not valid JSON");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== CURSOR_VERSION ||
    parsed.project_id !== projectId ||
    parsed.speaker_id !== speakerId ||
    typeof parsed.after_seq !== "number" ||
    !Number.isSafeInteger(parsed.after_seq) ||
    parsed.after_seq < 0
  ) {
    throw protocolError("cursor file does not match this project and credential speaker");
  }
  return {
    version: CURSOR_VERSION,
    project_id: projectId,
    speaker_id: speakerId,
    after_seq: parsed.after_seq,
    updated_at: typeof parsed.updated_at === "string" ? parsed.updated_at : "",
  };
}

function assertNotSymlink(path: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) {
      throw protocolError("cursor file must not be a symbolic link");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

// Atomic replace: write a 0600 temp file, fsync it, rename it, then fsync the
// directory. A reader sees either the old complete cursor or the new one.
export function writeCursorAtomic(path: string, state: CursorState): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertNotSymlink(path);
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(state)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
    const dirFd = openSync(parent, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed or never created.
    }
    throw error;
  }
}

export function loadCursorState(
  path: string,
  projectId: string,
  speakerId: string,
  now: () => Date,
): CursorState {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        version: CURSOR_VERSION,
        project_id: projectId,
        speaker_id: speakerId,
        after_seq: 0,
        updated_at: now().toISOString(),
      };
    }
    throw protocolError("cursor file is not readable or is a symbolic link");
  }
  try {
    // fstat the opened handle, not the path: the path could be replaced between
    // an existence check and the open.
    const info = fstatSync(fd);
    if (!info.isFile()) throw protocolError("cursor path must be a regular file");
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw protocolError("cursor file must be private (mode 0600)");
    }
    let text: string;
    try {
      text = readFileSync(fd, "utf8");
    } catch {
      throw protocolError("cursor file is not readable");
    }
    return parseCursorState(text, projectId, speakerId);
  } finally {
    closeSync(fd);
  }
}

async function fetchIdentity(
  options: PollContext,
  baseUrl: string,
  token: string,
): Promise<string> {
  const response = await request(
    requestContext(options),
    new URL("/api/v1/me", baseUrl).toString(),
    "GET",
    token,
  );
  if (!response.ok) {
    const code = serverErrorCode(response);
    const configError = response.status === 401 || response.status === 403 || response.status === 404;
    throw new PollError(
      configError ? 2 : 1,
      configError ? "AUTH" : "IDENTITY_UNAVAILABLE",
      `identity request rejected with status ${response.status}${codeSuffix(code, token)}`,
    );
  }
  const payload = parseJson(response.text, "identity");
  if (
    !isRecord(payload) ||
    !isRecord(payload.speaker) ||
    typeof payload.speaker.id !== "string" ||
    payload.speaker.id === "" ||
    !Array.isArray(payload.scopes) ||
    !payload.scopes.every((scope): scope is string => typeof scope === "string")
  ) {
    throw protocolError("identity response is malformed");
  }
  if (!payload.scopes.includes("message.read") || !payload.scopes.includes("receipt.write")) {
    throw new PollError(2, "SCOPE", "credential needs message.read and receipt.write");
  }
  return payload.speaker.id;
}

async function listPage(
  context: RequestContext,
  baseUrl: string,
  projectId: string,
  token: string,
  afterSeq: number,
  limit: number,
): Promise<ListPage> {
  const url = new URL(`/api/v1/projects/${encodeURIComponent(projectId)}/messages`, baseUrl);
  url.searchParams.set("after_seq", String(afterSeq));
  url.searchParams.set("limit", String(limit));
  const response = await request(context, url.toString(), "GET", token);
  if (!response.ok) {
    const code = serverErrorCode(response);
    const configError = response.status === 401 || response.status === 403 || response.status === 404;
    throw new PollError(
      configError ? 2 : 1,
      configError ? "LIST_REJECTED" : "LIST_UNAVAILABLE",
      `message list rejected with status ${response.status}${codeSuffix(code, token)}`,
    );
  }
  const payload = parseJson(response.text, "message list");
  return validateListPayload(payload, projectId, afterSeq, limit);
}

async function markRead(
  context: RequestContext,
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>,
  baseUrl: string,
  projectId: string,
  messageId: string,
  seq: number,
  speakerId: string,
  token: string,
): Promise<MarkReadOutcome> {
  const url = new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(messageId)}/read`,
    baseUrl,
  ).toString();

  for (let attempt = 1; attempt <= MARK_READ_ATTEMPTS; attempt += 1) {
    let response: HttpResponse;
    try {
      response = await request(context, url, "POST", token);
    } catch (error) {
      if (error instanceof PollError && error.code === "STOPPED") throw error;
      if (attempt < MARK_READ_ATTEMPTS) {
        await sleep(250 * attempt, context.signal);
        if (context.signal?.aborted) {
          throw new PollError(0, "STOPPED", "stopped by signal");
        }
        continue;
      }
      throw new PollError(
        1,
        "MARK_READ_UNCERTAIN",
        `mark_read for seq ${seq} was not confirmed after ${MARK_READ_ATTEMPTS} attempts; cursor unchanged`,
      );
    }

    if (response.ok) {
      const payload = parseJson(response.text, "mark_read");
      if (
        !isRecord(payload) ||
        payload.message_id !== messageId ||
        payload.speaker_id !== speakerId ||
        typeof payload.read_at !== "string"
      ) {
        throw protocolError(
          "mark_read response does not match the requested message and speaker",
        );
      }
      return "read";
    }

    // The same POST is safe to repeat: mark_read is idempotent. Retry only
    // statuses that can be transient.
    if (response.status === 429 || response.status >= 500) {
      if (attempt < MARK_READ_ATTEMPTS) {
        await sleep(retryDelay(response, attempt), context.signal);
        if (context.signal?.aborted) {
          throw new PollError(0, "STOPPED", "stopped by signal");
        }
        continue;
      }
      throw new PollError(
        1,
        "MARK_READ_UNCERTAIN",
        `mark_read for seq ${seq} was not confirmed after ${MARK_READ_ATTEMPTS} attempts; cursor unchanged`,
      );
    }

    const code = serverErrorCode(response);
    // An expired body can never produce a receipt. Treat the server's definitive
    // answer as a consumed metadata tombstone rather than wedge the queue.
    if (response.status === 410 && code === "BODY_EXPIRED") return "expired";

    throw new PollError(
      3,
      "MARK_READ_REJECTED",
      `mark_read for seq ${seq} rejected with status ${response.status}${codeSuffix(code, token)}; cursor unchanged`,
    );
  }
  throw new PollError(1, "MARK_READ_UNCERTAIN", "mark_read attempts exhausted");
}

// A receipt asserts that the client fetched the content. Fetch and verify the
// body before any mark_read; the plaintext is returned to the consumer only.
// Never include the text or digest in an error or status line.
async function fetchBody(
  context: RequestContext,
  baseUrl: string,
  projectId: string,
  message: PollMessage,
  token: string,
): Promise<{ expired: true } | { expired: false; text: string }> {
  const url = new URL(
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(message.messageId)}/body`,
    baseUrl,
  ).toString();
  const response = await request(context, url, "GET", token);
  if (!response.ok) {
    const code = serverErrorCode(response);
    // Definitive tombstone: no body can ever be fetched and no receipt can exist.
    if (response.status === 410 && code === "BODY_EXPIRED") return { expired: true };
    const configError = response.status === 401 || response.status === 403 || response.status === 404;
    const transient = response.status === 429 || response.status >= 500;
    throw new PollError(
      transient ? 1 : configError ? 2 : 3,
      transient ? "BODY_UNAVAILABLE" : "BODY_REJECTED",
      `body fetch for seq ${message.seq} rejected with status ${response.status}${codeSuffix(code, token)}; cursor unchanged`,
    );
  }

  const payload = parseJson(response.text, "message body");
  if (
    !isRecord(payload) ||
    payload.message_id !== message.messageId ||
    typeof payload.text !== "string" ||
    typeof payload.compression !== "string" ||
    typeof payload.digest !== "string" ||
    !SHA256_DIGEST.test(payload.digest)
  ) {
    throw protocolError(
      "message body response is malformed or does not match the requested message",
    );
  }

  const computed = `sha256:${createHash("sha256").update(payload.text, "utf8").digest("hex")}`;
  if (computed !== payload.digest) {
    throw new PollError(
      3,
      "INTEGRITY_FAILURE",
      `body for seq ${message.seq} failed digest verification; cursor unchanged`,
    );
  }
  return { expired: false, text: payload.text };
}

// Escape control and bidirectional formatting characters so untrusted summary
// metadata cannot drive the terminal.
// Redact the raw field before JSON/terminal escaping: escaping first would
// hide a credential containing control characters from the redactor.
function displayText(value: string, secret: string): string {
  return escapeForTerminal(JSON.stringify(redact(value, secret)));
}

export async function pollPass(options: PollPassOptions): Promise<PollPassResult> {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const emit = (line: string): void =>
    (options.stdout ?? defaultStdout)(redactAndEscape(line, options.token));
  const context = requestContext(options);
  const state: CursorState = {
    version: CURSOR_VERSION,
    project_id: options.projectId,
    speaker_id: options.speakerId,
    after_seq: options.afterSeq,
    updated_at: now().toISOString(),
  };

  let cursor = options.afterSeq;
  let processed = 0;
  let pages = 0;
  // A receipt asserts that content was fetched. Without explicit consumption the
  // pass is metadata observation only: no body fetch, no mark_read, no cursor
  // write. A programmatic callback always implies consumption.
  const consume = options.consume === true || options.onMessage !== undefined;
  try {
    if (!consume) {
      if (options.signal?.aborted) {
        return { afterSeq: cursor, processed, pages, stopped: true };
      }
      const listed = await listPage(
        context,
        options.baseUrl,
        options.projectId,
        options.token,
        cursor,
        limit,
      );
      if (listed.messages.length > 0) pages += 1;
      for (const message of listed.messages) {
        if (options.signal?.aborted) {
          return { afterSeq: cursor, processed, pages, stopped: true };
        }
        if (options.showSummary === true) {
          emit(
            `seq=${message.seq} message_id=${displayText(message.messageId, options.token)}` +
              ` sender=${displayText(message.senderId, options.token)}` +
              ` summary=${displayText(message.summary, options.token)}`,
          );
        }
      }
      emit(
        `metadata observation only: page after_seq=${cursor} returned ${listed.messages.length}` +
          " message(s); consumed=0, no body fetched, no receipt, cursor unchanged" +
          " (pass --consume to fetch bodies and acknowledge)",
      );
      return { afterSeq: cursor, processed: 0, pages, stopped: false };
    }

    for (let page = 0; page < maxPages; page += 1) {
      if (options.signal?.aborted) {
        return { afterSeq: cursor, processed, pages, stopped: true };
      }
      const listed = await listPage(
        context,
        options.baseUrl,
        options.projectId,
        options.token,
        cursor,
        limit,
      );
      if (listed.messages.length === 0) break;
      pages += 1;

      for (const message of listed.messages) {
        if (options.signal?.aborted) {
          return { afterSeq: cursor, processed, pages, stopped: true };
        }

        // The body must be fetched and verified before any receipt is possible.
        const body = await fetchBody(
          context,
          options.baseUrl,
          options.projectId,
          message,
          options.token,
        );
        if (body.expired) {
          if (options.showSummary === true) {
            emit(
              `seq=${message.seq} message_id=${displayText(message.messageId, options.token)}` +
                ` sender=${displayText(message.senderId, options.token)}` +
                ` summary=${displayText(message.summary, options.token)}`,
            );
          }
          cursor = message.seq;
          state.after_seq = cursor;
          state.updated_at = now().toISOString();
          writeCursorAtomic(options.cursorPath, state);
          processed += 1;
          emit(
            `seq=${message.seq} message_id=${displayText(message.messageId, options.token)}` +
              " status=BODY_EXPIRED consumed-without-receipt",
          );
          continue;
        }

        if (options.onMessage !== undefined) {
          try {
            await options.onMessage(message, body.text);
          } catch {
            if (options.signal?.aborted) {
              return { afterSeq: cursor, processed, pages, stopped: true };
            }
            throw new PollError(
              1,
              "PROCESS_FAILED",
              `processing seq ${message.seq} failed; cursor unchanged`,
            );
          }
        }
        if (options.showSummary === true) {
          emit(
            `seq=${message.seq} message_id=${displayText(message.messageId, options.token)}` +
              ` sender=${displayText(message.senderId, options.token)}` +
              ` summary=${displayText(message.summary, options.token)}`,
          );
        }

        const outcome = await markRead(
          context,
          sleep,
          options.baseUrl,
          options.projectId,
          message.messageId,
          message.seq,
          options.speakerId,
          options.token,
        );

        cursor = message.seq;
        state.after_seq = cursor;
        state.updated_at = now().toISOString();
        writeCursorAtomic(options.cursorPath, state);
        processed += 1;
        if (outcome === "expired") {
          emit(
            `seq=${message.seq} message_id=${displayText(message.messageId, options.token)}` +
              " status=BODY_EXPIRED consumed-without-receipt",
          );
        }
      }

      if (listed.messages.length < limit) break;
    }
  } catch (error) {
    if (error instanceof PollError && error.code === "STOPPED") {
      return { afterSeq: cursor, processed, pages, stopped: true };
    }
    throw error;
  }
  return { afterSeq: cursor, processed, pages, stopped: false };
}

export async function run(options: RunOptions): Promise<PollPassResult> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultSleep;
  const speakerId = await fetchIdentity(options, options.baseUrl, options.token);
  const state = loadCursorState(options.cursorPath, options.projectId, speakerId, now);

  let afterSeq = state.after_seq;
  let processed = 0;
  let pages = 0;
  for (;;) {
    const result = await pollPass({
      ...options,
      speakerId,
      afterSeq,
      now,
      sleep,
    });
    afterSeq = result.afterSeq;
    processed += result.processed;
    pages += result.pages;
    if (options.once === true || result.stopped) {
      return { afterSeq, processed, pages, stopped: result.stopped };
    }
    if (options.signal?.aborted) {
      return { afterSeq, processed, pages, stopped: true };
    }
    await defaultSleep(options.intervalMs ?? DEFAULT_INTERVAL_MS, options.signal);
  }
}

// The bearer credential is sent on every request. Cleartext HTTP is allowed
// only for local loopback development; any other host must use TLS.
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function parseBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PollError(2, "CONFIG", "base URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PollError(2, "CONFIG", "base URL must use http or https");
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new PollError(2, "CONFIG", "base URL must use https outside loopback");
  }
  if (url.username !== "" || url.password !== "") {
    throw new PollError(2, "CONFIG", "base URL must not embed credentials");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new PollError(2, "CONFIG", "base URL must not contain a query or fragment");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new PollError(2, "CONFIG", "base URL must be an origin without a path");
  }
  return url.origin;
}

function required(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new PollError(2, "CONFIG", `${label} is required`);
  }
  return trimmed;
}

function parseInteger(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new PollError(2, "CONFIG", `${label} must be ${min}-${max}`);
  }
  return value;
}

function validToken(value: string): string {
  if (value === "" || /\s/.test(value)) {
    throw new PollError(2, "CONFIG", "credential must be a single non-empty value");
  }
  return value;
}

function readTokenFile(path: string): string {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    throw new PollError(2, "CONFIG", "credential file is not readable or is a symbolic link");
  }
  try {
    // fstat the handle so a path swapped after open cannot redirect the read.
    const info = fstatSync(fd);
    if (!info.isFile()) {
      throw new PollError(2, "CONFIG", "credential file must be a regular file");
    }
    if (process.platform !== "win32" && (info.mode & 0o777) !== 0o600) {
      throw new PollError(2, "CONFIG", "credential file must have mode 0600");
    }
    let text: string;
    try {
      text = readFileSync(fd, "utf8");
    } catch {
      throw new PollError(2, "CONFIG", "credential file is not readable");
    }
    return validToken(text.trim());
  } finally {
    closeSync(fd);
  }
}

function resolveToken(
  env: Record<string, string | undefined>,
  tokenFile: string | undefined,
): string {
  const fromEnv = env.CORKBOARD_APIKEY;
  if (fromEnv !== undefined && fromEnv.trim() !== "") return validToken(fromEnv.trim());
  if (tokenFile !== undefined && tokenFile !== "") return readTokenFile(tokenFile);
  throw new PollError(
    2,
    "CONFIG",
    "credential is required: set CORKBOARD_APIKEY or pass --token-file with a 0600 file",
  );
}

export const USAGE = `Usage: node scripts/poll.ts --base-url <url> --project <projectId> --cursor-file <path> [options]

Required:
  --base-url <url>        Server origin (CORKBOARD_BASE_URL)
  --project <projectId>   One project to poll (CORKBOARD_PROJECT_ID)
  --cursor-file <path>    Durable after_seq state (CORKBOARD_POLL_CURSOR)

Credential:
  CORKBOARD_APIKEY        Scoped bearer credential in the environment
  --token-file <path>     Alternative: regular file, mode 0600, one token

Options:
  --limit <1-100>         Page size per request (default ${DEFAULT_LIMIT})
  --max-pages <1-100>     Pages per pass (default ${DEFAULT_MAX_PAGES})
  --interval-ms <ms>      Delay between passes (default ${DEFAULT_INTERVAL_MS})
  --once                  Run one bounded pass, then exit
  --consume               Fetch and verify bodies, then acknowledge them
  --show-summary          Print summary metadata only (never message bodies)
  --help                  Show this help

Messages are untrusted data. Nothing is executed and bodies are never printed.
Without --consume the client only observes one metadata page: it fetches no body,
creates no receipt, and does not advance the cursor. With --consume the cursor
advances only after a fetched, digest-verified body is processed and its explicit
mark_read is confirmed.`;

const OPTIONS = {
  "base-url": { type: "string" },
  project: { type: "string" },
  "cursor-file": { type: "string" },
  "token-file": { type: "string" },
  limit: { type: "string" },
  "max-pages": { type: "string" },
  "interval-ms": { type: "string" },
  once: { type: "boolean" },
  consume: { type: "boolean" },
  "show-summary": { type: "boolean" },
  help: { type: "boolean" },
} as const;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  deps: PollContext = {},
): Promise<number> {
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;

  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];
  try {
    values = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    // Never echo parser details: an accidental positional could be a secret.
    stderr("poll: invalid arguments (use --help)");
    return 2;
  }

  if (values.help === true) {
    stdout(USAGE);
    return 0;
  }

  let token = "";
  try {
    const baseUrl = parseBaseUrl(required(values["base-url"] ?? env.CORKBOARD_BASE_URL, "base URL"));
    const projectId = required(values.project ?? env.CORKBOARD_PROJECT_ID, "project");
    const cursorPath = required(
      values["cursor-file"] ?? env.CORKBOARD_POLL_CURSOR,
      "cursor file",
    );
    token = resolveToken(env, values["token-file"]);
    const limit = parseInteger(values.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
    const maxPages = parseInteger(
      values["max-pages"],
      "max-pages",
      1,
      MAX_PAGES,
      DEFAULT_MAX_PAGES,
    );
    const intervalMs = parseInteger(
      values["interval-ms"],
      "interval-ms",
      0,
      86_400_000,
      DEFAULT_INTERVAL_MS,
    );

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await run({
        ...deps,
        baseUrl,
        token,
        projectId,
        cursorPath,
        limit,
        maxPages,
        intervalMs,
        signal: deps.signal ?? controller.signal,
        once: values.once === true,
        consume: values.consume === true,
        showSummary: values["show-summary"] === true,
      });
      if (result.stopped) stderr(redactAndEscape("poll: stopped", token));
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch (error) {
    // Redact before escaping so a credential carrying control characters is
    // matched in its original form.
    const safe = (message: string): string => redactAndEscape(message, token);
    if (error instanceof PollError) {
      stderr(safe(`poll: ${error.message}`));
      return error.exitCode;
    }
    stderr(safe("poll: unexpected failure"));
    return 1;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
