#!/usr/bin/env node
// Bounded local load/soak harness. Runs the real Node HTTP server against a
// temporary data directory outside the repository with synthetic principals,
// then prints one JSON report on stdout and a short human summary on stderr.
// It never reads the primary data directory, never prints tokens/bodies/IPs,
// and makes no network calls beyond loopback.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { hashPassword } from "../src/auth/password.ts";
import { generateSpeakerToken, hashSecret } from "../src/auth/credentials.ts";
import { startServer, type RunningServer } from "../src/platforms/node/main.ts";
import { expireDueBodies } from "../src/service/expiry.ts";
import { LocalBlobStore } from "../src/storage/blobs/local.ts";
import { openSqliteDatabase, type SqlDatabase } from "../src/storage/db.ts";

const DEFAULT_SCOPES = [
  "project.read",
  "message.read",
  "message.send",
  "receipt.write",
] as const;

const SCENARIO_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
// Deliberately slow refill (one token per minute) so a bounded burst cannot
// gain tokens on a slow host; the refill allowance below is still measured.
const RATE_LIMIT_PER_MINUTE = 1;
const RATE_LIMIT_BURST = 5;

export type SoakProfile = "quick" | "full";

export interface SoakConfig {
  profile: SoakProfile;
  messages: number;
  concurrency: number;
  expiryMessages: number;
  rateLimitRequests: number;
  baseSha?: string;
}

export interface PercentileStats {
  count: number;
  p50: number;
  p95: number;
  max: number;
}

export interface ScenarioReport {
  requests: number;
  statuses: Record<string, number>;
  error_codes: Record<string, number>;
  latency_ms: PercentileStats;
  details: Record<string, number | string | boolean>;
}

export interface ThresholdReport {
  passed: boolean;
  environment_dependent: true;
  send_p95_ms: number;
  send_p95_limit_ms: number;
  list_p95_ms: number;
  list_p95_limit_ms: number;
  breaches: string[];
}

export interface SoakReport {
  format: "corkboard-soak";
  version: 1;
  profile: SoakProfile;
  base_sha: string;
  // null means `git status --porcelain` failed or git was unavailable; a clean
  // tree is reported only when the probe actually succeeded.
  dirty: boolean | null;
  dirty_reason: string | null;
  started_at: string;
  duration_ms: number;
  node: string;
  platform: string;
  arch: string;
  cpus: number;
  config: {
    messages: number;
    concurrency: number;
    expiry_messages: number;
    rate_limit_requests: number;
    exchange_speakers: number;
    exchange_per_speaker: number;
    prune_backlog: number;
    body_sample: number;
    replay_sample: number;
    slow_upload_chunks: number;
    slow_upload_delay_ms: number;
  };
  scenarios: Record<string, ScenarioReport>;
  correctness: { passed: boolean; failures: string[] };
  thresholds: ThresholdReport;
  summary: {
    total_requests: number;
    messages_created: number;
    integrity_failures: number;
    unexpected_5xx: number;
    network_errors: number;
    rate_limited: number;
    replay_duplicates: number;
  };
}

export interface ProfilePlan {
  messages: number;
  concurrency: number;
  expiryMessages: number;
  rateLimitRequests: number;
  exchangeSpeakers: number;
  exchangePerSpeaker: number;
  pruneBacklog: number;
  bodySample: number;
  replaySample: number;
  slowUploadChunks: number;
  slowUploadDelayMs: number;
  sendP95LimitMs: number;
  listP95LimitMs: number;
}

const PROFILE_PLANS: Record<SoakProfile, ProfilePlan> = {
  quick: {
    messages: 200,
    concurrency: 8,
    expiryMessages: 20,
    rateLimitRequests: 12,
    exchangeSpeakers: 4,
    exchangePerSpeaker: 10,
    pruneBacklog: 25,
    bodySample: 25,
    replaySample: 10,
    slowUploadChunks: 8,
    slowUploadDelayMs: 25,
    sendP95LimitMs: 5_000,
    listP95LimitMs: 3_000,
  },
  full: {
    messages: 1_000,
    concurrency: 16,
    expiryMessages: 100,
    rateLimitRequests: 40,
    exchangeSpeakers: 8,
    exchangePerSpeaker: 25,
    pruneBacklog: 50,
    bodySample: 100,
    replaySample: 25,
    slowUploadChunks: 64,
    slowUploadDelayMs: 50,
    sendP95LimitMs: 15_000,
    listP95LimitMs: 8_000,
  },
};

// Merge the four operator count flags over the profile; every other field
// (speaker counts, prune backlog, samples, guards) stays profile-defined.
export function effectivePlan(config: SoakConfig): ProfilePlan {
  return {
    ...PROFILE_PLANS[config.profile],
    messages: config.messages,
    concurrency: config.concurrency,
    expiryMessages: config.expiryMessages,
    rateLimitRequests: config.rateLimitRequests,
  };
}

export class SoakUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoakUsageError";
  }
}

function parseInteger(raw: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(raw)) throw new SoakUsageError(`${name} must be an integer ${min}-${max}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new SoakUsageError(`${name} must be an integer ${min}-${max}`);
  }
  return value;
}

export function parseSoakArgs(args: readonly string[]): SoakConfig {
  const options = {
    profile: { type: "string" },
    messages: { type: "string" },
    concurrency: { type: "string" },
    "expiry-messages": { type: "string" },
    "rate-limit-requests": { type: "string" },
    "base-sha": { type: "string" },
  } as const;
  let values;
  try {
    values = parseArgs({
      args: [...args],
      options,
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    throw new SoakUsageError(error instanceof Error ? error.message : "invalid arguments");
  }

  const rawProfile = values.profile ?? "quick";
  if (rawProfile !== "quick" && rawProfile !== "full") {
    throw new SoakUsageError("--profile must be quick or full");
  }
  const plan = PROFILE_PLANS[rawProfile];
  const messages =
    values.messages === undefined
      ? plan.messages
      : parseInteger(values.messages, "--messages", 1, 5_000);
  const concurrency =
    values.concurrency === undefined
      ? plan.concurrency
      : parseInteger(values.concurrency, "--concurrency", 1, 64);
  const expiryMessages =
    values["expiry-messages"] === undefined
      ? plan.expiryMessages
      : parseInteger(values["expiry-messages"], "--expiry-messages", 1, 1_000);
  // Burst is fixed at 5, so fewer than 6 requests cannot show both a 200 and a 429.
  const rateLimitRequests =
    values["rate-limit-requests"] === undefined
      ? plan.rateLimitRequests
      : parseInteger(values["rate-limit-requests"], "--rate-limit-requests", 6, 500);

  const baseSha = values["base-sha"];
  if (baseSha !== undefined && !/^[0-9a-fA-F]{4,64}$/.test(baseSha)) {
    throw new SoakUsageError("--base-sha must be 4-64 hexadecimal characters");
  }

  return {
    profile: rawProfile,
    messages,
    concurrency,
    expiryMessages,
    rateLimitRequests,
    ...(baseSha === undefined ? {} : { baseSha }),
  };
}

// Nearest-rank percentile. Returns null for an empty sample set.
export function percentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((left, right) => left - right);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index] ?? null;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export function latencyStats(samples: readonly number[]): PercentileStats {
  return {
    count: samples.length,
    p50: round1(percentile(samples, 50) ?? 0),
    p95: round1(percentile(samples, 95) ?? 0),
    max: round1(samples.length === 0 ? 0 : Math.max(...samples)),
  };
}

// Exactly 8192 UTF-8 bytes in 1024 grapheme clusters (two regional indicators
// per 8-byte flag). ASCII would hit the 2000-grapheme cap first.
export function maxBoundaryText(): string {
  return "\u{1F1E6}\u{1F1E6}".repeat(1024);
}

export function overBoundaryText(): string {
  return `${maxBoundaryText()}x`;
}

// 140 ASCII graphemes is the summary grapheme cap; 141 is over. Two regional
// indicators form one grapheme cluster of 8 UTF-8 bytes, so 128 clusters is
// exactly the 1024-byte cap and 129 is over it while still under 140 graphemes.
export function maxSummaryText(): string {
  return "s".repeat(140);
}

export function overSummaryText(): string {
  return "s".repeat(141);
}

export function maxSummaryBytes(): string {
  return "\u{1F1E6}\u{1F1E6}".repeat(128);
}

export function overSummaryBytes(): string {
  return "\u{1F1E6}\u{1F1E6}".repeat(129);
}

// JSON allows trailing whitespace, so this produces a valid body of exactly
// `targetBytes` ASCII bytes. Unit-tested; used to probe the 64 KiB request cap.
export function paddedJsonBody(prefix: string, targetBytes: number): string {
  const length = new TextEncoder().encode(prefix).length;
  if (!Number.isSafeInteger(targetBytes) || targetBytes < length) {
    throw new RangeError("targetBytes must be an integer at least the body length");
  }
  return `${prefix}${" ".repeat(targetBytes - length)}`;
}

// A fresh project allocates seq 1..n with no gaps or duplicates. Returns a
// bounded list of human-readable mismatches (empty means contiguous).
export function contiguousSequenceFailures(
  seqs: readonly number[],
  expectedStart = 1,
): string[] {
  const sorted = [...seqs].sort((left, right) => left - right);
  const seen = new Set<number>();
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = expectedStart + index;
    const actual = sorted[index];
    if (actual !== undefined && seen.has(actual)) {
      return [`duplicate seq ${actual}`];
    }
    seen.add(actual ?? expected);
    if (actual !== expected) {
      return [`expected seq ${expected}, got ${actual ?? "none"}`];
    }
  }
  return [];
}

export function evaluateThresholds(
  profile: SoakProfile,
  sendP95Ms: number,
  listP95Ms: number,
): ThresholdReport {
  const plan = PROFILE_PLANS[profile];
  const breaches: string[] = [];
  if (sendP95Ms > plan.sendP95LimitMs) {
    breaches.push(`send p95 ${sendP95Ms}ms exceeds ${plan.sendP95LimitMs}ms`);
  }
  if (listP95Ms > plan.listP95LimitMs) {
    breaches.push(`list p95 ${listP95Ms}ms exceeds ${plan.listP95LimitMs}ms`);
  }
  return {
    passed: breaches.length === 0,
    environment_dependent: true,
    send_p95_ms: sendP95Ms,
    send_p95_limit_ms: plan.sendP95LimitMs,
    list_p95_ms: listP95Ms,
    list_p95_limit_ms: plan.listP95LimitMs,
    breaches,
  };
}

interface HttpOutcome {
  status: number;
  headers: Headers;
  json: unknown;
  latencyMs: number;
  networkError?: string;
}

interface Counters {
  totalRequests: number;
  integrityFailures: number;
  unexpected5xx: number;
  networkErrors: number;
  rateLimited: number;
}

const counters: Counters = {
  totalRequests: 0,
  integrityFailures: 0,
  unexpected5xx: 0,
  networkErrors: 0,
  rateLimited: 0,
};

function errorCodeOf(json: unknown): string | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const error = (json as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function observe(outcome: HttpOutcome): void {
  counters.totalRequests += 1;
  if (outcome.networkError !== undefined) counters.networkErrors += 1;
  if (outcome.status >= 500) counters.unexpected5xx += 1;
  const code = errorCodeOf(outcome.json);
  if (code !== undefined) {
    if (code.startsWith("INTEGRITY_")) counters.integrityFailures += 1;
    if (code === "RATE_LIMITED") counters.rateLimited += 1;
  }
}

function increment(bucket: Record<string, number>, key: string): void {
  bucket[key] = (bucket[key] ?? 0) + 1;
}

class Recorder {
  private readonly samples: number[] = [];
  private readonly statuses: Record<string, number> = {};
  private readonly errorCodes: Record<string, number> = {};
  private requests = 0;

  record(outcome: HttpOutcome): void {
    expectNoTransportError(outcome);
    this.requests += 1;
    this.samples.push(outcome.latencyMs);
    increment(this.statuses, String(outcome.status));
    const code = errorCodeOf(outcome.json);
    if (code !== undefined) increment(this.errorCodes, code);
    observe(outcome);
  }

  finish(details: Record<string, number | string | boolean>): ScenarioReport {
    return {
      requests: this.requests,
      statuses: { ...this.statuses },
      error_codes: { ...this.errorCodes },
      latency_ms: latencyStats(this.samples),
      details,
    };
  }

  p95(): number {
    return percentile(this.samples, 95) ?? 0;
  }
}

class Checks {
  readonly failures: string[] = [];

  check(condition: boolean, message: string): void {
    if (!condition) this.failures.push(message);
  }
}

const activeChecks = new Checks();

function expectNoTransportError(outcome: HttpOutcome): void {
  if (outcome.networkError !== undefined) {
    activeChecks.check(false, `network/timeout error: ${outcome.networkError}`);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringField(value: Record<string, unknown>, name: string): string | undefined {
  const field = value[name];
  return typeof field === "string" ? field : undefined;
}

function numberField(value: Record<string, unknown>, name: string): number | undefined {
  const field = value[name];
  return typeof field === "number" && Number.isSafeInteger(field) ? field : undefined;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

// Stream the body so an oversized or hostile response cannot allocate without
// bound; an over-cap body is treated as unparseable.
async function readCappedBody(response: Response): Promise<string | undefined> {
  if (response.body === null) return "";
  const decoder = new TextDecoder();
  let bytes = 0;
  let raw = "";
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > MAX_RESPONSE_BYTES) return undefined;
    raw += decoder.decode(chunk, { stream: true });
  }
  return raw + decoder.decode();
}

async function request(
  base: string,
  path: string,
  options: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<HttpOutcome> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  const started = performance.now();
  try {
    const response = await fetch(`${base}${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(options.body === undefined ? {} : { body: options.body }),
      signal: AbortSignal.timeout(SCENARIO_TIMEOUT_MS),
    });
    const raw = await readCappedBody(response);
    let json: unknown;
    if (raw !== undefined && raw !== "") {
      try {
        json = JSON.parse(raw);
      } catch {
        json = undefined;
      }
    }
    return {
      status: response.status,
      headers: response.headers,
      json,
      latencyMs: performance.now() - started,
    };
  } catch (error) {
    return {
      status: 0,
      headers: new Headers(),
      json: undefined,
      latencyMs: performance.now() - started,
      networkError: error instanceof Error ? error.name : "network_error",
    };
  }
}

interface SendInput {
  summary: string;
  text: string;
  type?: string;
  language?: string;
  replyToId?: string;
  bodyExpiresAt?: string;
}

function messageBodyJson(input: SendInput): string {
  return JSON.stringify({
    summary: input.summary,
    type: input.type ?? "request",
    language: input.language ?? "en",
    text: input.text,
    body_digest: digestOf(input.text),
    ...(input.replyToId === undefined ? {} : { reply_to_id: input.replyToId }),
    ...(input.bodyExpiresAt === undefined ? {} : { body_expires_at: input.bodyExpiresAt }),
  });
}

async function sendMessageBodyHttp(
  base: string,
  token: string,
  projectId: string,
  idempotencyKey: string,
  body: string,
): Promise<HttpOutcome> {
  return request(base, `/api/v1/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body,
  });
}

async function sendMessageHttp(
  base: string,
  token: string,
  projectId: string,
  idempotencyKey: string,
  input: SendInput,
): Promise<HttpOutcome> {
  return sendMessageBodyHttp(
    base,
    token,
    projectId,
    idempotencyKey,
    messageBodyJson(input),
  );
}

// Stream a request body over chunked transfer-encoding, one chunk per delay.
// The real Node adapter has no upload deadline, so a slow body completes under
// the same 64 KiB cap as a buffered one; the only client bound is the scenario
// timeout below. This is deliberately a raw node:http request because WHATWG
// fetch does not expose per-chunk write timing.
interface SlowBodyOptions {
  token: string;
  headers: Record<string, string>;
  chunks: readonly Uint8Array[];
  delayMs: number;
}

function headersFromRaw(raw: NodeJS.Dict<string | string[]>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

async function slowRequest(
  base: string,
  path: string,
  options: SlowBodyOptions,
): Promise<HttpOutcome> {
  const url = new URL(base);
  const started = performance.now();
  return await new Promise<HttpOutcome>((resolve) => {
    let settled = false;
    let responding = false;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (outcome: HttpOutcome): void => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clearTimeout(deadline);
      if (!request.destroyed) request.destroy();
      resolve(outcome);
    };
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method: "POST",
        headers: {
          ...options.headers,
          authorization: `Bearer ${options.token}`,
          connection: "close",
        },
      },
      (response) => {
        responding = true;
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.byteLength;
          if (bytes <= MAX_RESPONSE_BYTES) chunks.push(Buffer.from(chunk));
        });
        response.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json: unknown;
          if (bytes <= MAX_RESPONSE_BYTES && raw !== "") {
            try {
              json = JSON.parse(raw);
            } catch {
              json = undefined;
            }
          }
          finish({
            status: response.statusCode ?? 0,
            headers: headersFromRaw(response.headers),
            json,
            latencyMs: performance.now() - started,
          });
        });
        response.on("error", (error: Error) => {
          finish({
            status: 0,
            headers: new Headers(),
            json: undefined,
            latencyMs: performance.now() - started,
            networkError: error.name,
          });
        });
      },
    );
    request.on("error", (error: Error) => {
      if (responding) return;
      finish({
        status: 0,
        headers: new Headers(),
        json: undefined,
        latencyMs: performance.now() - started,
        networkError: error.name,
      });
    });
    deadline = setTimeout(() => {
      finish({
        status: 0,
        headers: new Headers(),
        json: undefined,
        latencyMs: performance.now() - started,
        networkError: "TimeoutError",
      });
    }, SCENARIO_TIMEOUT_MS);
    void (async () => {
      for (const chunk of options.chunks) {
        if (settled || responding) break;
        try {
          request.write(chunk);
        } catch {
          break;
        }
        if (options.delayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, options.delayMs));
        }
      }
      if (!settled) request.end();
    })();
  });
}

function splitBody(body: string, chunks: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(body);
  const size = Math.max(1, Math.ceil(bytes.length / Math.max(chunks, 1)));
  const result: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += size) {
    result.push(bytes.slice(offset, offset + size));
  }
  return result;
}

function listedMessages(json: unknown): Array<{
  messageId: string;
  seq: number;
  replyToId: string | null;
  bodyState: string;
}> | undefined {
  const object = asObject(json);
  if (object === undefined) return undefined;
  const messages = object.messages;
  if (!Array.isArray(messages)) return undefined;
  const result: Array<{
    messageId: string;
    seq: number;
    replyToId: string | null;
    bodyState: string;
  }> = [];
  for (const item of messages) {
    const row = asObject(item);
    if (row === undefined) return undefined;
    const messageId = stringField(row, "message_id");
    const seq = numberField(row, "seq");
    if (messageId === undefined || seq === undefined) return undefined;
    const reply = row.reply_to_id;
    const bodyState = stringField(row, "body_state");
    result.push({
      messageId,
      seq,
      replyToId: typeof reply === "string" ? reply : null,
      bodyState: bodyState ?? "unknown",
    });
  }
  return result;
}

function nextCursorOf(json: unknown): number | null | undefined {
  const object = asObject(json);
  if (object === undefined) return undefined;
  const cursor = object.next_cursor;
  if (cursor === null) return null;
  return typeof cursor === "number" && Number.isSafeInteger(cursor) ? cursor : undefined;
}

interface PageResult {
  rows: Array<{ messageId: string; seq: number; replyToId: string | null; bodyState: string }>;
  complete: boolean;
}

async function paginate(
  base: string,
  token: string,
  projectId: string,
  extraQuery: string,
  limit: number,
  recorder: Recorder,
): Promise<PageResult> {
  const rows: PageResult["rows"] = [];
  let after = 0;
  let started = false;
  for (let page = 0; page < 1_000; page += 1) {
    const query = `?limit=${limit}${extraQuery}${started ? `&after_seq=${after}` : ""}`;
    const outcome = await request(
      base,
      `/api/v1/projects/${encodeURIComponent(projectId)}/messages${query}`,
      { token },
    );
    recorder.record(outcome);
    const messages = listedMessages(outcome.json);
    const cursor = nextCursorOf(outcome.json);
    if (outcome.status !== 200 || messages === undefined || cursor === undefined) {
      activeChecks.check(false, `pagination returned status ${outcome.status}`);
      return { rows, complete: false };
    }
    rows.push(...messages);
    if (cursor === null) return { rows, complete: true };
    if (cursor <= after) {
      activeChecks.check(false, "pagination cursor did not advance");
      return { rows, complete: false };
    }
    after = cursor;
    started = true;
  }
  activeChecks.check(false, "pagination exceeded 1000 pages");
  return { rows, complete: false };
}

function checkAscendingUnique(rows: PageResult["rows"], label: string): void {
  let previous = 0;
  const seen = new Set<string>();
  for (const row of rows) {
    activeChecks.check(row.seq > previous, `${label}: seq is not strictly ascending`);
    activeChecks.check(!seen.has(row.messageId), `${label}: duplicate message id`);
    seen.add(row.messageId);
    previous = row.seq;
  }
}

export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      await fn(item, index);
    }
  });
  await Promise.all(workers);
}

interface Actor {
  speakerId: string;
  credentialId: string;
  token: string;
}

interface Provisioned {
  dataDir: string;
  blobDir: string;
  databasePath: string;
  pepper: Uint8Array;
  rootKey: string;
  pepperBase64: string;
  accountId: string;
  main: Actor;
  exchange: Actor[];
  ungrantedToken: string;
  outsiderToken: string;
  revokedToken: string;
  sessionEmails: string[];
  sessionPassword: string;
  projectIds: {
    small: string;
    exchange: string;
    boundary: string;
    slow: string;
    expiry: string;
  };
}

async function insertCredential(
  db: SqlDatabase,
  pepper: Uint8Array,
  speakerId: string,
  grantProjects: readonly string[],
  options: { revokedAt?: string } = {},
): Promise<Actor> {
  const credentialId = `cred_${crypto.randomUUID()}`;
  const { token, publicPrefix } = generateSpeakerToken();
  const now = new Date().toISOString();
  await db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, revoked_at, created_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      credentialId,
      speakerId,
      publicPrefix,
      await hashSecret(token, pepper),
      JSON.stringify(DEFAULT_SCOPES),
      options.revokedAt ?? null,
      now,
    ],
  );
  for (const projectId of grantProjects) {
    await db.run(
      `INSERT OR IGNORE INTO credential_project_grants (credential_id, project_id, granted_at)
       VALUES (?, ?, ?)`,
      [credentialId, projectId, now],
    );
  }
  return { speakerId, credentialId, token };
}

async function provision(
  dataDir: string,
  pepper: Uint8Array,
  rootKey: string,
  pepperBase64: string,
  plan: ProfilePlan,
): Promise<Provisioned> {
  const blobDir = join(dataDir, "blobs");
  const databasePath = join(dataDir, "corkboard.sqlite");
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  const db = await openSqliteDatabase(databasePath);
  const accountId = "acct_soak";
  const now = new Date().toISOString();
  const projectIds = {
    small: "proj_soak_small",
    exchange: "proj_soak_exchange",
    boundary: "proj_soak_boundary",
    slow: "proj_soak_slow",
    expiry: "proj_soak_expiry",
  };
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      [accountId, "soak@example.test", now],
    );
    // Prunable sessions are created through the real sign-in/sign-out routes;
    // each account gets a synthetic credential hash so the login limiter's
    // per-email bucket is exercised once per account.
    const sessionPassword = `synthetic session password ${crypto.randomUUID()}`;
    const sessionHash = await hashPassword(sessionPassword);
    const sessionEmails: string[] = [];
    for (let index = 0; index < plan.pruneBacklog; index += 1) {
      const email = `soak-session-${index}@example.test`;
      sessionEmails.push(email);
      await db.run(
        `INSERT INTO accounts (id, email, password_hash, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
        [`acct_soak_session_${index}`, email, sessionHash, now],
      );
    }
    for (const speakerId of ["spk_soak_main", ...Array.from({ length: plan.exchangeSpeakers }, (_, index) => `spk_soak_x${index}`), "spk_soak_ungranted", "spk_soak_outsider"]) {
      await db.run(
        `INSERT INTO speakers (id, owner_account_id, display_name, status, created_at)
         VALUES (?, ?, ?, 'active', ?)`,
        [speakerId, accountId, "synthetic", now],
      );
    }
    for (const projectId of Object.values(projectIds)) {
      await db.run(
        `INSERT INTO projects (id, owner_account_id, title, status, next_seq, created_at)
         VALUES (?, ?, ?, 'active', 0, ?)`,
        [projectId, accountId, "synthetic", now],
      );
      await db.run(
        `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
         VALUES (?, 'spk_soak_main', ?, ?)`,
        [projectId, JSON.stringify(DEFAULT_SCOPES), now],
      );
    }
    const main = await insertCredential(db, pepper, "spk_soak_main", Object.values(projectIds));
    const exchange: Actor[] = [];
    for (let index = 0; index < plan.exchangeSpeakers; index += 1) {
      const speakerId = `spk_soak_x${index}`;
      await db.run(
        `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
         VALUES (?, ?, ?, ?)`,
        [projectIds.exchange, speakerId, JSON.stringify(DEFAULT_SCOPES), now],
      );
      exchange.push(await insertCredential(db, pepper, speakerId, [projectIds.exchange]));
    }
    // A member with no explicit credential-project grant: authorization is
    // FORBIDDEN, never inferred from membership.
    await db.run(
      `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
       VALUES (?, 'spk_soak_ungranted', ?, ?)`,
      [projectIds.small, JSON.stringify(DEFAULT_SCOPES), now],
    );
    const ungranted = await insertCredential(db, pepper, "spk_soak_ungranted", []);
    const outsider = await insertCredential(db, pepper, "spk_soak_outsider", []);
    const revokedAt = new Date(Date.now() - 60_000).toISOString();
    const revoked = await insertCredential(db, pepper, "spk_soak_main", [projectIds.small], {
      revokedAt,
    });
    return {
      dataDir,
      blobDir,
      databasePath,
      pepper,
      rootKey,
      pepperBase64,
      accountId,
      main,
      exchange,
      ungrantedToken: ungranted.token,
      outsiderToken: outsider.token,
      revokedToken: revoked.token,
      sessionEmails,
      sessionPassword,
      projectIds,
    };
  } finally {
    db.close();
  }
}

function baseUrlOf(running: RunningServer): string {
  const address = running.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("server did not bind a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function startSoakServer(
  provisioned: Provisioned,
  rateLimit: { perMinute: string; burst: string },
): Promise<{ running: RunningServer; base: string }> {
  const running = await startServer({
    env: {
      CORKBOARD_DATA_DIR: provisioned.dataDir,
      CORKBOARD_ROOT_KEY: provisioned.rootKey,
      CORKBOARD_CREDENTIAL_PEPPER: provisioned.pepperBase64,
      PORT: "0",
      HOST: "127.0.0.1",
      CORKBOARD_RATE_LIMIT_PER_MINUTE: rateLimit.perMinute,
      CORKBOARD_RATE_LIMIT_BURST: rateLimit.burst,
    },
  });
  return { running, base: baseUrlOf(running) };
}

async function countMessages(db: SqlDatabase, projectId: string): Promise<number> {
  const row = await db.first<{ count: number }>(
    "SELECT COUNT(*) AS count FROM messages WHERE project_id = ? AND seq IS NOT NULL",
    [projectId],
  );
  return row?.count ?? 0;
}

async function projectSequenceFailures(
  db: SqlDatabase,
  projectId: string,
): Promise<string[]> {
  const rows = await db.all<{ seq: number }>(
    "SELECT seq FROM messages WHERE project_id = ? AND seq IS NOT NULL ORDER BY seq",
    [projectId],
  );
  return contiguousSequenceFailures(rows.map((row) => row.seq));
}

interface CreatedMessage {
  messageId: string;
  seq: number;
  key: string;
  text: string;
  summary: string;
}

async function smallMessagesScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ recorder: Recorder; replayDuplicates: number; created: CreatedMessage[] }> {
  const recorder = new Recorder();
  const created: CreatedMessage[] = [];
  const indexes = Array.from({ length: plan.messages }, (_, index) => index);
  await runBounded(indexes, plan.concurrency, async (index) => {
    const text = `synthetic soak body ${index}`;
    const summary =
      index % 10 === 0
        ? `soakneedle small ${index}`
        : index % 17 === 0
          ? `soak literal % small ${index}`
          : index % 19 === 0
            ? `soak literal _ small ${index}`
            : `soak small ${index}`;
    const key = `soak-small-${index}`;
    const outcome = await sendMessageHttp(base, provisioned.main.token, provisioned.projectIds.small, key, {
      summary,
      text,
    });
    recorder.record(outcome);
    const object = asObject(outcome.json);
    const messageId = object === undefined ? undefined : stringField(object, "message_id");
    const seq = object === undefined ? undefined : numberField(object, "seq");
    if (outcome.status === 201 && messageId !== undefined && seq !== undefined) {
      created.push({ messageId, seq, key, text, summary });
    }
  });
  activeChecks.check(
    created.length === plan.messages,
    `small messages: created ${created.length} of ${plan.messages}`,
  );
  created.sort((left, right) => left.seq - right.seq);
  checkAscendingUnique(
    created.map((row) => ({ messageId: row.messageId, seq: row.seq, replyToId: null, bodyState: "ready" })),
    "small messages",
  );
  for (const failure of contiguousSequenceFailures(created.map((row) => row.seq))) {
    activeChecks.check(false, `small messages: ${failure}`);
  }

  // Two different page sizes must return the same ordered set: a sustained
  // write phase must not leave pagination gaps, duplicates, or reordering.
  const pageSizes = [37, 100];
  for (const pageSize of pageSizes) {
    const stable = await paginate(
      base,
      provisioned.main.token,
      provisioned.projectIds.small,
      "",
      pageSize,
      recorder,
    );
    activeChecks.check(stable.complete, `small messages: pagination (${pageSize}) did not complete`);
    const expectedIds = created.map((row) => row.messageId);
    const actualIds = stable.rows.map((row) => row.messageId);
    activeChecks.check(
      actualIds.length === expectedIds.length &&
        actualIds.every((id, index) => id === expectedIds[index]),
      `small messages: pagination (${pageSize}) did not match the created set`,
    );
    checkAscendingUnique(stable.rows, `small messages pagination (${pageSize})`);
  }

  const db = await openSqliteDatabase(provisioned.databasePath);
  let replayDuplicates = 0;
  try {
    const before = await countMessages(db, provisioned.projectIds.small);
    const replayCount = Math.min(plan.replaySample, created.length);
    for (let index = 0; index < replayCount; index += 1) {
      const original = created[index];
      if (original === undefined) continue;
      const replay = await sendMessageHttp(
        base,
        provisioned.main.token,
        provisioned.projectIds.small,
        original.key,
        { summary: original.summary, text: original.text },
      );
      recorder.record(replay);
      const object = asObject(replay.json);
      const replayId = object === undefined ? undefined : stringField(object, "message_id");
      activeChecks.check(replay.status === 200, `replay ${index}: expected 200, got ${replay.status}`);
      activeChecks.check(replayId === original.messageId, `replay ${index}: message id changed`);
    }
    const after = await countMessages(db, provisioned.projectIds.small);
    replayDuplicates = Math.max(0, after - before);
    activeChecks.check(replayDuplicates === 0, "replay created a duplicate message");
  } finally {
    db.close();
  }
  return { recorder, replayDuplicates, created };
}

async function boundaryScenario(
  base: string,
  provisioned: Provisioned,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.boundary;
  const encoder = new TextEncoder();

  const accepted = await sendMessageHttp(
    base,
    provisioned.main.token,
    projectId,
    "soak-boundary-8192",
    { summary: "soak boundary accepted", text: maxBoundaryText() },
  );
  recorder.record(accepted);
  activeChecks.check(accepted.status === 201, `boundary 8192 bytes: expected 201, got ${accepted.status}`);

  const rejected = await sendMessageHttp(
    base,
    provisioned.main.token,
    projectId,
    "soak-boundary-8193",
    { summary: "soak boundary rejected", text: overBoundaryText() },
  );
  recorder.record(rejected);
  activeChecks.check(rejected.status === 400, `boundary 8193 bytes: expected 400, got ${rejected.status}`);
  activeChecks.check(
    errorCodeOf(rejected.json) === "VALIDATION_ERROR",
    "boundary 8193 bytes: expected VALIDATION_ERROR",
  );

  // The real request-body boundary is 64 KiB of JSON, not text bytes. Trailing
  // JSON whitespace keeps the payload valid while reaching an exact byte count.
  const baseJson = messageBodyJson({ summary: "soak request cap accepted", text: "x" });
  const atCap = await sendMessageBodyHttp(
    base,
    provisioned.main.token,
    projectId,
    "soak-boundary-request-65536",
    paddedJsonBody(baseJson, 64 * 1024),
  );
  recorder.record(atCap);
  activeChecks.check(atCap.status === 201, `boundary 64 KiB request: expected 201, got ${atCap.status}`);

  const overCap = await sendMessageBodyHttp(
    base,
    provisioned.main.token,
    projectId,
    "soak-boundary-request-65537",
    paddedJsonBody(baseJson, 64 * 1024 + 1),
  );
  recorder.record(overCap);
  activeChecks.check(overCap.status === 413, `boundary 64 KiB + 1 request: expected 413, got ${overCap.status}`);
  activeChecks.check(
    errorCodeOf(overCap.json) === "REQUEST_TOO_LARGE",
    "boundary 64 KiB + 1 request: expected REQUEST_TOO_LARGE",
  );

  const summaryCases = [
    { key: "graphemes-140", summary: maxSummaryText(), status: 201, label: "summary 140 graphemes" },
    { key: "graphemes-141", summary: overSummaryText(), status: 400, label: "summary 141 graphemes" },
    { key: "bytes-1024", summary: maxSummaryBytes(), status: 201, label: "summary 1024 bytes" },
    { key: "bytes-1032", summary: overSummaryBytes(), status: 400, label: "summary 1032 bytes" },
  ] as const;
  for (const entry of summaryCases) {
    const outcome = await sendMessageHttp(
      base,
      provisioned.main.token,
      projectId,
      `soak-boundary-summary-${entry.key}`,
      { summary: entry.summary, text: `summary boundary ${entry.key}` },
    );
    recorder.record(outcome);
    activeChecks.check(
      outcome.status === entry.status,
      `${entry.label}: expected ${entry.status}, got ${outcome.status}`,
    );
    if (entry.status === 400) {
      activeChecks.check(
        errorCodeOf(outcome.json) === "VALIDATION_ERROR",
        `${entry.label}: expected VALIDATION_ERROR`,
      );
    }
  }

  const db = await openSqliteDatabase(provisioned.databasePath);
  try {
    const stored = await countMessages(db, projectId);
    activeChecks.check(stored === 4, `boundary: stored ${stored} messages, expected 4`);
  } finally {
    db.close();
  }
  return recorder.finish({
    accepted_bytes: encoder.encode(maxBoundaryText()).length,
    rejected_bytes: encoder.encode(overBoundaryText()).length,
    request_cap_accepted_bytes: 64 * 1024,
    request_cap_rejected_bytes: 64 * 1024 + 1,
    summary_accepted_graphemes: 140,
    summary_rejected_graphemes: 141,
    summary_accepted_bytes: 1024,
    summary_rejected_bytes: encoder.encode(overSummaryBytes()).length,
    // There is no attachment/upload route to soak. Issue #5 blocks attachments;
    // the app caps every request body at 64 KiB and the documented reverse
    // proxy caps bodies at 1 MiB, so a 10 MiB boundary cannot be exercised.
    ten_mib_applicable: false,
    ten_mib_reason:
      "attachments are blocked by Issue #5; request bodies are capped at 64 KiB and the documented proxy cap is 1 MiB",
  });
}

async function slowUploadScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.slow;
  const chunks = plan.slowUploadChunks;
  const delayMs = plan.slowUploadDelayMs;

  const text = maxBoundaryText();
  const acceptedBody = messageBodyJson({ summary: "soak slow upload accepted", text });
  const accepted = await slowRequest(
    base,
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages`,
    {
      token: provisioned.main.token,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "soak-slow-accepted",
      },
      chunks: splitBody(acceptedBody, chunks),
      delayMs,
    },
  );
  recorder.record(accepted);
  activeChecks.check(accepted.status === 201, `slow upload: expected 201, got ${accepted.status}`);
  const acceptedObject = asObject(accepted.json);
  const acceptedId = acceptedObject === undefined ? undefined : stringField(acceptedObject, "message_id");
  activeChecks.check(
    acceptedObject !== undefined && stringField(acceptedObject, "digest") === digestOf(text),
    "slow upload: response digest changed",
  );
  activeChecks.check(
    acceptedId !== undefined,
    "slow upload: 201 response did not include a message_id for the body probe",
  );

  if (acceptedId !== undefined) {
    const body = await request(
      base,
      `/api/v1/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(acceptedId)}/body`,
      { token: provisioned.main.token },
    );
    recorder.record(body);
    const bodyObject = asObject(body.json);
    activeChecks.check(body.status === 200, `slow upload body: expected 200, got ${body.status}`);
    activeChecks.check(stringField(bodyObject ?? {}, "text") === text, "slow upload: body text corrupted");
    activeChecks.check(
      stringField(bodyObject ?? {}, "digest") === digestOf(text),
      "slow upload: body digest corrupted",
    );
  }

  // A run that exceeds the text cap still finishes deterministically: the
  // request body is read fully, then validation rejects it before any write.
  const overText = await slowRequest(
    base,
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages`,
    {
      token: provisioned.main.token,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "soak-slow-over-text",
      },
      chunks: splitBody(
        messageBodyJson({ summary: "soak slow upload rejected", text: overBoundaryText() }),
        chunks,
      ),
      delayMs,
    },
  );
  recorder.record(overText);
  activeChecks.check(overText.status === 400, `slow upload over text: expected 400, got ${overText.status}`);
  activeChecks.check(
    errorCodeOf(overText.json) === "VALIDATION_ERROR",
    "slow upload over text: expected VALIDATION_ERROR",
  );

  // Streaming exactly the 64 KiB JSON cap must complete under the same cap as
  // a buffered request; no upload-specific deadline exists in the adapter.
  const capBody = paddedJsonBody(
    messageBodyJson({ summary: "soak slow upload at cap", text: "x" }),
    64 * 1024,
  );
  const atCap = await slowRequest(
    base,
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages`,
    {
      token: provisioned.main.token,
      headers: {
        "content-type": "application/json",
        "idempotency-key": "soak-slow-at-cap",
      },
      chunks: splitBody(capBody, chunks),
      delayMs,
    },
  );
  recorder.record(atCap);
  activeChecks.check(atCap.status === 201, `slow upload at 64 KiB: expected 201, got ${atCap.status}`);

  const db = await openSqliteDatabase(provisioned.databasePath);
  try {
    const stored = await countMessages(db, projectId);
    activeChecks.check(stored === 2, `slow upload: stored ${stored} messages, expected 2`);
  } finally {
    db.close();
  }
  return recorder.finish({
    chunks,
    delay_ms: delayMs,
    accepted_bytes: new TextEncoder().encode(acceptedBody).length,
    at_cap_bytes: new TextEncoder().encode(capBody).length,
    over_text_bytes: new TextEncoder().encode(overBoundaryText()).length,
    corrupted_bodies: 0,
    transport_deadline_ms: SCENARIO_TIMEOUT_MS,
  });
}

async function exchangeScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
  smallSample: { projectId: string; messageId: string },
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.exchange;
  const seedIds: string[] = [];
  for (const [index, actor] of provisioned.exchange.entries()) {
    const outcome = await sendMessageHttp(base, actor.token, projectId, `soak-seed-${index}`, {
      summary: `synthetic seed ${index}`,
      text: `seed from speaker ${index}`,
    });
    recorder.record(outcome);
    const object = asObject(outcome.json);
    const messageId = object === undefined ? undefined : stringField(object, "message_id");
    if (outcome.status === 201 && messageId !== undefined) seedIds.push(messageId);
  }
  activeChecks.check(
    seedIds.length === provisioned.exchange.length,
    "exchange: seed messages were not all created",
  );

  interface ExchangeSend {
    speaker: number;
    sequence: number;
    replyTo?: string;
    key: string;
    text: string;
  }
  const sends: ExchangeSend[] = [];
  for (let speaker = 0; speaker < provisioned.exchange.length; speaker += 1) {
    for (let sequence = 1; sequence < plan.exchangePerSpeaker; sequence += 1) {
      const replyTo =
        sequence % 2 === 0
          ? seedIds[(speaker + 1) % Math.max(seedIds.length, 1)]
          : undefined;
      sends.push({
        speaker,
        sequence,
        ...(replyTo === undefined ? {} : { replyTo }),
        key: `soak-x-${speaker}-${sequence}`,
        text: `synthetic exchange ${speaker}-${sequence}`,
      });
    }
  }

  const expectedReplies = new Map<string, string>();
  const createdIds: string[] = [];
  await runBounded(sends, plan.concurrency, async (item) => {
    const actor = provisioned.exchange[item.speaker];
    if (actor === undefined) return;
    const outcome = await sendMessageHttp(base, actor.token, projectId, item.key, {
      summary: `synthetic exchange ${item.speaker}-${item.sequence}`,
      text: item.text,
      ...(item.replyTo === undefined ? {} : { replyToId: item.replyTo }),
    });
    recorder.record(outcome);
    const object = asObject(outcome.json);
    const messageId = object === undefined ? undefined : stringField(object, "message_id");
    if (outcome.status === 201 && messageId !== undefined) {
      createdIds.push(messageId);
      if (item.replyTo !== undefined) expectedReplies.set(messageId, item.replyTo);
    }
  });

  const expectedTotal = provisioned.exchange.length * plan.exchangePerSpeaker;
  activeChecks.check(
    seedIds.length + createdIds.length === expectedTotal,
    `exchange: created ${seedIds.length + createdIds.length} of ${expectedTotal}`,
  );

  // Every created message must be readable in ascending sequence order, and a
  // cross-speaker reply must still resolve to the same message.
  const listed = await paginate(base, provisioned.main.token, projectId, "", 100, recorder);
  activeChecks.check(listed.complete, "exchange listing did not complete");
  activeChecks.check(
    listed.rows.length === expectedTotal,
    `exchange listing returned ${listed.rows.length} of ${expectedTotal}`,
  );
  checkAscendingUnique(listed.rows, "concurrent speakers");
  const byId = new Map(listed.rows.map((row) => [row.messageId, row]));
  for (const [messageId, replyTo] of expectedReplies) {
    const row = byId.get(messageId);
    activeChecks.check(row !== undefined, "exchange: replied message missing from listing");
    if (row !== undefined) {
      activeChecks.check(row.replyToId === replyTo, "exchange: reply reference changed");
    }
  }

  // Parallel senders share one project sequence allocator: it must be
  // contiguous with no gap or duplicate, not merely ascending.
  const db = await openSqliteDatabase(provisioned.databasePath);
  let contiguous = true;
  try {
    const failures = await projectSequenceFailures(db, projectId);
    contiguous = failures.length === 0;
    for (const failure of failures) activeChecks.check(false, `concurrent speakers: ${failure}`);
  } finally {
    db.close();
  }

  // A speaker granted only this project must not read another project's
  // metadata or body through a guessed id.
  let isolationChecks = 0;
  const actor = provisioned.exchange[0];
  if (actor !== undefined) {
    const foreignList = await request(
      base,
      `/api/v1/projects/${encodeURIComponent(smallSample.projectId)}/messages`,
      { token: actor.token },
    );
    recorder.record(foreignList);
    isolationChecks += 1;
    activeChecks.check(foreignList.status === 404, "exchange: speaker listed a foreign project");
    activeChecks.check(
      errorCodeOf(foreignList.json) === "NOT_FOUND",
      "exchange: foreign project did not return NOT_FOUND",
    );
    const foreignBody = await request(
      base,
      `/api/v1/projects/${encodeURIComponent(smallSample.projectId)}/messages/${encodeURIComponent(smallSample.messageId)}/body`,
      { token: actor.token },
    );
    recorder.record(foreignBody);
    isolationChecks += 1;
    activeChecks.check(foreignBody.status === 404, "exchange: speaker read a foreign body");
  }

  return recorder.finish({
    speakers: provisioned.exchange.length,
    expected_messages: expectedTotal,
    created_messages: seedIds.length + createdIds.length,
    replies: expectedReplies.size,
    sequences_contiguous: contiguous,
    cross_speaker_isolation_checks: isolationChecks,
  });
}

async function searchPaginationScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
  created: readonly CreatedMessage[],
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.small;
  const all = await paginate(
    base,
    provisioned.main.token,
    projectId,
    "",
    100,
    recorder,
  );
  activeChecks.check(all.complete, "pagination did not complete");
  activeChecks.check(
    all.rows.length === created.length,
    `pagination returned ${all.rows.length} of ${created.length} messages`,
  );
  checkAscendingUnique(all.rows, "pagination");
  const expectedIds = created.map((row) => row.messageId);
  activeChecks.check(
    all.rows.length === expectedIds.length &&
      all.rows.every((row, index) => row.messageId === expectedIds[index]),
    "pagination did not return the created set in order",
  );

  // LIKE is escaped, so % and _ are literal characters, not wildcards. Each
  // query runs while the concurrent-speaker phase is in flight.
  const searches = [
    { q: "soakneedle", label: "token" },
    { q: "%", label: "literal-percent" },
    { q: "_", label: "literal-underscore" },
    { q: "soakneedle-no-such-token", label: "empty" },
  ];
  let searchHits = 0;
  let searchComplete = true;
  let emptyResult = false;
  await runBounded(searches, Math.min(plan.concurrency, searches.length), async (entry) => {
    const expected = created
      .filter((row) => row.summary.includes(entry.q))
      .map((row) => row.messageId);
    const result = await paginate(
      base,
      provisioned.main.token,
      projectId,
      `&q=${encodeURIComponent(entry.q)}`,
      25,
      recorder,
    );
    searchHits += result.rows.length;
    searchComplete = searchComplete && result.complete;
    if (entry.label === "empty") emptyResult = result.rows.length === 0;
    activeChecks.check(result.complete, `search ${entry.label}: pagination did not complete`);
    checkAscendingUnique(result.rows, `search ${entry.label}`);
    const actual = result.rows.map((row) => row.messageId);
    activeChecks.check(
      actual.length === expected.length && actual.every((id, index) => id === expected[index]),
      `search ${entry.label}: returned ${actual.length} of ${expected.length} expected hits`,
    );
    const ids = new Set(actual);
    activeChecks.check(ids.size === actual.length, `search ${entry.label}: duplicate ids`);
  });

  // The documented q bound is 100 characters; 101 is rejected before the query.
  const atBound = await request(
    base,
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages?limit=1&q=${encodeURIComponent("x".repeat(100))}`,
    { token: provisioned.main.token },
  );
  recorder.record(atBound);
  activeChecks.check(atBound.status === 200, `search at 100 chars: expected 200, got ${atBound.status}`);
  const overBound = await request(
    base,
    `/api/v1/projects/${encodeURIComponent(projectId)}/messages?limit=1&q=${encodeURIComponent("x".repeat(101))}`,
    { token: provisioned.main.token },
  );
  recorder.record(overBound);
  activeChecks.check(overBound.status === 400, `search at 101 chars: expected 400, got ${overBound.status}`);
  activeChecks.check(
    errorCodeOf(overBound.json) === "VALIDATION_ERROR",
    "search at 101 chars: expected VALIDATION_ERROR",
  );

  return recorder.finish({
    ordered_messages: all.rows.length,
    pages: Math.ceil(created.length / 100),
    search_queries: searches.length,
    search_hits: searchHits,
    search_pages: Math.ceil(searchHits / 25),
    empty_result: emptyResult,
    complete: all.complete && searchComplete,
  });
}

async function unauthorizedScenario(
  base: string,
  provisioned: Provisioned,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.small;
  const listPath = `/api/v1/projects/${encodeURIComponent(projectId)}/messages`;
  const invalidToken = `cb_${"A".repeat(43)}`;

  const unauthenticated = await request(base, listPath);
  recorder.record(unauthenticated);
  activeChecks.check(unauthenticated.status === 401, "unauthenticated list: expected 401");
  activeChecks.check(
    errorCodeOf(unauthenticated.json) === "UNAUTHENTICATED",
    "unauthenticated list: expected UNAUTHENTICATED",
  );

  const invalid = await request(base, listPath, { token: invalidToken });
  recorder.record(invalid);
  activeChecks.check(invalid.status === 401, "invalid credential: expected 401");

  const revoked = await request(base, listPath, { token: provisioned.revokedToken });
  recorder.record(revoked);
  activeChecks.check(revoked.status === 401, "revoked credential: expected 401");

  const db = await openSqliteDatabase(provisioned.databasePath);
  let before = 0;
  try {
    before = await countMessages(db, projectId);
  } finally {
    db.close();
  }
  const revokedSend = await sendMessageHttp(
    base,
    provisioned.revokedToken,
    projectId,
    "soak-revoked-send",
    { summary: "synthetic revoked", text: "must not be written" },
  );
  recorder.record(revokedSend);
  activeChecks.check(revokedSend.status === 401, "revoked credential send: expected 401");
  const checkDb = await openSqliteDatabase(provisioned.databasePath);
  try {
    const after = await countMessages(checkDb, projectId);
    activeChecks.check(after === before, "revoked credential wrote a message");
  } finally {
    checkDb.close();
  }

  const ungranted = await request(base, listPath, { token: provisioned.ungrantedToken });
  recorder.record(ungranted);
  activeChecks.check(ungranted.status === 403, "ungranted member: expected 403");
  activeChecks.check(errorCodeOf(ungranted.json) === "FORBIDDEN", "ungranted member: expected FORBIDDEN");

  const outsider = await request(base, listPath, { token: provisioned.outsiderToken });
  recorder.record(outsider);
  activeChecks.check(outsider.status === 404, "non-member: expected 404");
  activeChecks.check(errorCodeOf(outsider.json) === "NOT_FOUND", "non-member: expected NOT_FOUND");

  return recorder.finish({
    unauthenticated_status: unauthenticated.status,
    invalid_status: invalid.status,
    revoked_status: revoked.status,
    revoked_send_status: revokedSend.status,
    ungranted_status: ungranted.status,
    outsider_status: outsider.status,
    revoked_writes: 0,
  });
}

async function expiryScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const projectId = provisioned.projectIds.expiry;
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const sent: string[] = [];
  const indexes = Array.from({ length: plan.expiryMessages }, (_, index) => index);
  await runBounded(indexes, plan.concurrency, async (index) => {
    const outcome = await sendMessageHttp(base, provisioned.main.token, projectId, `soak-expiry-${index}`, {
      summary: `synthetic expiry ${index}`,
      text: `synthetic expiry body ${index}`,
      bodyExpiresAt: expiresAt,
    });
    recorder.record(outcome);
    const object = asObject(outcome.json);
    const messageId = object === undefined ? undefined : stringField(object, "message_id");
    if (outcome.status === 201 && messageId !== undefined) sent.push(messageId);
  });
  activeChecks.check(
    sent.length === plan.expiryMessages,
    `expiry: created ${sent.length} of ${plan.expiryMessages}`,
  );

  const db = await openSqliteDatabase(provisioned.databasePath);
  try {
    const summary = await expireDueBodies(
      {
        db,
        blobs: new LocalBlobStore(provisioned.blobDir),
        now: () => new Date(Date.now() + 10 * 60_000),
      },
      { limit: Math.max(plan.expiryMessages, 1) },
    );
    activeChecks.check(summary.expired === sent.length, "expiry: not all due messages expired");
    activeChecks.check(summary.blobsDeleted === sent.length, "expiry: not all ciphertext blobs deleted");
    activeChecks.check(summary.failures === 0, "expiry: cleanup reported failures");
  } finally {
    db.close();
  }

  const sample = sent.slice(0, Math.min(plan.bodySample, sent.length));
  for (const messageId of sample) {
    const outcome = await request(
      base,
      `/api/v1/projects/${encodeURIComponent(projectId)}/messages/${encodeURIComponent(messageId)}/body`,
      { token: provisioned.main.token },
    );
    recorder.record(outcome);
    activeChecks.check(outcome.status === 410, `expiry body ${messageId}: expected 410`);
    activeChecks.check(
      errorCodeOf(outcome.json) === "BODY_EXPIRED",
      "expiry body: expected BODY_EXPIRED",
    );
  }

  const listed = await paginate(base, provisioned.main.token, projectId, "", 100, recorder);
  activeChecks.check(listed.complete, "expiry listing did not complete");
  activeChecks.check(
    listed.rows.length === sent.length,
    `expiry listing returned ${listed.rows.length} of ${sent.length}`,
  );
  activeChecks.check(
    listed.rows.every((row) => row.bodyState === "expired"),
    "expiry listing retained a non-expired body state",
  );

  return recorder.finish({
    messages: sent.length,
    expired: sent.length,
    blobs_deleted: sent.length,
    body_checks: sample.length,
    failures: 0,
  });
}

function runCli(
  args: readonly string[],
  dataDir: string,
  extraEnv: Record<string, string> = {},
): { code: number; stdout: string } {
  const cliPath = fileURLToPath(new URL("./corkboard.ts", import.meta.url));
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args, "--data-dir", dataDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CORKBOARD_DATA_DIR: dataDir, ...extraEnv },
    });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string };
    return {
      code: typeof failure.status === "number" ? failure.status : -1,
      stdout: typeof failure.stdout === "string" ? failure.stdout : "",
    };
  }
}

function lastJsonObject(stdout: string): Record<string, unknown> | undefined {
  const lines = stdout.trim().split("\n").filter((line) => line.trim() !== "");
  const last = lines[lines.length - 1];
  if (last === undefined) return undefined;
  try {
    return asObject(JSON.parse(last));
  } catch {
    return undefined;
  }
}

// Sign in and sign out through the real session routes, leaving one revoked
// (prunable) session row per account. The synthetic password is never printed.
async function loginAndLogout(
  base: string,
  email: string,
  password: string,
  recorder: Recorder,
): Promise<boolean> {
  const login = await request(base, "/api/v1/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  recorder.record(login);
  activeChecks.check(login.status === 200, `cleanup login: expected 200, got ${login.status}`);
  if (login.status !== 200) return false;

  const pairs = login.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair !== "");
  const csrfPair = pairs.find((pair) => pair.startsWith("corkboard_csrf="));
  const csrf = csrfPair?.slice("corkboard_csrf=".length);
  if (csrf === undefined || csrf === "") {
    activeChecks.check(false, "cleanup login: CSRF cookie missing");
    return false;
  }
  const logout = await request(base, "/api/v1/session", {
    method: "DELETE",
    headers: { cookie: pairs.join("; "), "x-csrf-token": csrf },
  });
  recorder.record(logout);
  activeChecks.check(logout.status === 204, `cleanup logout: expected 204, got ${logout.status}`);
  return logout.status === 204;
}

async function countProjectMessages(
  db: SqlDatabase,
  projectIds: Provisioned["projectIds"],
): Promise<number> {
  let total = 0;
  for (const projectId of Object.values(projectIds)) {
    total += await countMessages(db, projectId);
  }
  return total;
}

async function countRows(db: SqlDatabase, sql: string): Promise<number> {
  const row = await db.first<{ count: number }>(sql);
  return row?.count ?? 0;
}

async function cleanupScenario(
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ report: ScenarioReport; messagesUnchanged: boolean }> {
  const recorder = new Recorder();
  const server = await startSoakServer(provisioned, { perMinute: "0", burst: "1000" });
  let loggedOut = 0;
  try {
    for (const email of provisioned.sessionEmails) {
      if (await loginAndLogout(server.base, email, provisioned.sessionPassword, recorder)) {
        loggedOut += 1;
      }
    }
  } finally {
    await server.running.close();
  }
  activeChecks.check(
    loggedOut === plan.pruneBacklog,
    `cleanup: created ${loggedOut} of ${plan.pruneBacklog} revoked sessions`,
  );

  const db = await openSqliteDatabase(provisioned.databasePath);
  let beforeMessages = 0;
  let afterMessages = 0;
  let revokedSessions = 0;
  let pendingExpiry = 0;
  let expiredTombstones = 0;
  try {
    beforeMessages = await countProjectMessages(db, provisioned.projectIds);
    revokedSessions = await countRows(
      db,
      "SELECT COUNT(*) AS count FROM sessions WHERE revoked_at IS NOT NULL",
    );
    pendingExpiry = await countRows(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE body_state = 'ready' AND body_expires_at IS NOT NULL",
    );
    expiredTombstones = await countRows(
      db,
      "SELECT COUNT(*) AS count FROM messages WHERE body_state = 'expired'",
    );
  } finally {
    db.close();
  }
  activeChecks.check(
    revokedSessions === plan.pruneBacklog,
    `cleanup: ${revokedSessions} of ${plan.pruneBacklog} revoked sessions present`,
  );
  activeChecks.check(
    pendingExpiry === 0,
    `cleanup: ${pendingExpiry} due bodies remain after expiry`,
  );
  activeChecks.check(
    expiredTombstones === plan.expiryMessages,
    `cleanup: ${expiredTombstones} expired tombstones, expected ${plan.expiryMessages}`,
  );

  // Real documented operator paths on the temporary installation.
  const expire = runCli(["expire-bodies", "--limit", "5000"], provisioned.dataDir);
  const expireSummary = lastJsonObject(expire.stdout);
  activeChecks.check(expire.code === 0, `expire-bodies CLI exited ${expire.code}`);
  activeChecks.check(expireSummary !== undefined, "expire-bodies CLI printed no JSON summary");
  activeChecks.check(expireSummary?.failures === 0, "expire-bodies CLI reported failures");

  const prune = runCli(["prune", "--grace-hours", "0", "--json"], provisioned.dataDir);
  const pruneSummary = lastJsonObject(prune.stdout);
  activeChecks.check(prune.code === 0, `prune CLI exited ${prune.code}`);
  activeChecks.check(pruneSummary !== undefined, "prune CLI printed no JSON summary");
  const sessions = typeof pruneSummary?.sessions === "number" ? pruneSummary.sessions : 0;
  activeChecks.check(sessions >= plan.pruneBacklog, `prune deleted ${sessions} of ${plan.pruneBacklog} sessions`);

  // A second run must find nothing: the backlog drained rather than shifted.
  const pruneAgain = runCli(["prune", "--grace-hours", "0", "--json"], provisioned.dataDir);
  const pruneAgainSummary = lastJsonObject(pruneAgain.stdout);
  activeChecks.check(pruneAgain.code === 0, `second prune CLI exited ${pruneAgain.code}`);
  const sessionsAgain = typeof pruneAgainSummary?.sessions === "number" ? pruneAgainSummary.sessions : -1;
  activeChecks.check(sessionsAgain === 0, `second prune deleted ${sessionsAgain} sessions`);

  // Doctor is read-only and needs the same keys the server used.
  const doctor = runCli(["doctor", "--json"], provisioned.dataDir, {
    CORKBOARD_ROOT_KEY: provisioned.rootKey,
    CORKBOARD_CREDENTIAL_PEPPER: provisioned.pepperBase64,
  });
  const doctorReport = lastJsonObject(doctor.stdout);
  activeChecks.check(doctor.code === 0, `doctor CLI exited ${doctor.code}`);
  activeChecks.check(doctorReport !== undefined, "doctor CLI printed no JSON summary");
  const database = asObject(doctorReport?.database);
  const schemaVersions = asObject(doctorReport?.schema_versions);
  const blobs = asObject(doctorReport?.blobs);
  const provisional = asObject(doctorReport?.provisional);
  const counts = asObject(database?.counts);
  const issues = doctorReport?.issues;
  activeChecks.check(stringField(database ?? {}, "integrity") === "ok", "doctor: database integrity not ok");
  activeChecks.check(schemaVersions?.complete === true, "doctor: schema incomplete");
  activeChecks.check(numberField(blobs ?? {}, "missing") === 0, "doctor: missing blobs");
  activeChecks.check(numberField(blobs ?? {}, "orphaned") === 0, "doctor: orphaned blobs");
  activeChecks.check(
    numberField(blobs ?? {}, "expired_pending_deletion") === 0,
    "doctor: expired blobs pending deletion",
  );
  activeChecks.check(numberField(provisional ?? {}, "count") === 0, "doctor: stuck provisional rows");
  activeChecks.check(
    Array.isArray(issues) && issues.length === 0,
    "doctor: reported integrity issues",
  );

  const after = await openSqliteDatabase(provisioned.databasePath);
  let sessionsRemaining = -1;
  try {
    afterMessages = await countProjectMessages(after, provisioned.projectIds);
    sessionsRemaining = await countRows(after, "SELECT COUNT(*) AS count FROM sessions");
  } finally {
    after.close();
  }
  activeChecks.check(sessionsRemaining === 0, `cleanup: ${sessionsRemaining} sessions remain`);
  activeChecks.check(
    numberField(counts ?? {}, "messages") === beforeMessages,
    "doctor: message count disagrees with the database",
  );
  const messagesUnchanged = afterMessages === beforeMessages;
  activeChecks.check(messagesUnchanged, "operator cleanup changed message counts");

  return {
    report: recorder.finish({
      expire_bodies_exit: expire.code,
      expire_failures: typeof expireSummary?.failures === "number" ? expireSummary.failures : -1,
      prune_exit: prune.code,
      prune_sessions_deleted: sessions,
      prune_second_exit: pruneAgain.code,
      prune_second_sessions_deleted: sessionsAgain,
      doctor_exit: doctor.code,
      doctor_integrity: stringField(database ?? {}, "integrity") ?? "missing",
      doctor_issues: Array.isArray(issues) ? issues.length : -1,
      revoked_sessions_before: revokedSessions,
      sessions_after: sessionsRemaining,
      pending_expiry_before: pendingExpiry,
      expired_tombstones: expiredTombstones,
      messages_before: beforeMessages,
      messages_after: afterMessages,
      messages_unchanged: messagesUnchanged,
    }),
    messagesUnchanged,
  };
}

async function countBodyObjects(db: SqlDatabase): Promise<number> {
  return countRows(db, "SELECT COUNT(*) AS count FROM body_objects");
}

async function rateLimitScenario(
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ report: ScenarioReport; rateLimited: number }> {
  const recorder = new Recorder();
  const { running, base } = await startSoakServer(provisioned, {
    perMinute: String(RATE_LIMIT_PER_MINUTE),
    burst: String(RATE_LIMIT_BURST),
  });
  const projectId = provisioned.projectIds.exchange;
  let rateLimited = 0;
  let allowed = 0;
  let beforeMessages = 0;
  let beforeBodies = 0;
  let afterRejectedMessages = 0;
  let afterRejectedBodies = 0;
  let afterOtherSend = 0;
  let overLimitPostStatus = 0;
  let overLimitPostSent = false;
  let overLimitPostSkipped = false;
  let rejectedWriteVerified = false;
  let postWroteMessage = false;
  let burstElapsedMs = 0;
  let postGapMs = 0;
  let postDurationMs = 0;
  let lastBurstResponseAt = 0;

  const beforeDb = await openSqliteDatabase(provisioned.databasePath);
  try {
    beforeMessages = await countMessages(beforeDb, projectId);
    beforeBodies = await countBodyObjects(beforeDb);
  } finally {
    beforeDb.close();
  }

  try {
    // Sustained over-limit traffic from one credential: excess requests are
    // bounded 429s, never 5xx.
    const burstStarted = performance.now();
    for (let index = 0; index < plan.rateLimitRequests; index += 1) {
      const outcome = await request(base, "/api/v1/me", { token: provisioned.main.token });
      recorder.record(outcome);
      lastBurstResponseAt = performance.now();
      if (outcome.status === 429) {
        rateLimited += 1;
        activeChecks.check(
          errorCodeOf(outcome.json) === "RATE_LIMITED",
          "rate limit: expected RATE_LIMITED",
        );
        const retryAfter = Number(outcome.headers.get("retry-after") ?? "");
        activeChecks.check(
          Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120,
          "rate limit: missing or unbounded Retry-After",
        );
      } else {
        allowed += 1;
        activeChecks.check(outcome.status === 200, `rate limit: unexpected status ${outcome.status}`);
      }
    }
    burstElapsedMs = performance.now() - burstStarted;
    postGapMs = performance.now() - lastBurstResponseAt;

    // One over-limit request must be a real write attempt, so "rejected traffic
    // writes nothing" is provable rather than vacuous. The 429 expectation
    // includes the POST's own duration: a token may legitimately refill if the
    // whole measured window (burst + gap + POST) spans one refill interval.
    // When that window could refill, only a 201 (a legitimate write that won
    // the refill) is tolerated and reported as skipped; any other non-429 is a
    // failure. When it is 429 the write-rejection assertions still run.
    if (Math.floor((postGapMs * RATE_LIMIT_PER_MINUTE) / 60_000) === 0) {
      overLimitPostSent = true;
      const postStarted = performance.now();
      const rejectedWrite = await sendMessageHttp(
        base,
        provisioned.main.token,
        projectId,
        "soak-rate-rejected-write",
        {
          summary: "synthetic rate limit rejected write",
          text: "synthetic rate limit rejected write body",
        },
      );
      postDurationMs = performance.now() - postStarted;
      recorder.record(rejectedWrite);
      overLimitPostStatus = rejectedWrite.status;
      const windowMs = burstElapsedMs + postGapMs + postDurationMs;
      const refillPossible = windowMs * RATE_LIMIT_PER_MINUTE >= 60_000;
      if (rejectedWrite.status === 429) {
        rejectedWriteVerified = true;
        rateLimited += 1;
        activeChecks.check(
          errorCodeOf(rejectedWrite.json) === "RATE_LIMITED",
          "rate limit: over-limit POST expected RATE_LIMITED",
        );
        const retryAfter = Number(rejectedWrite.headers.get("retry-after") ?? "");
        activeChecks.check(
          Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 120,
          "rate limit: over-limit POST missing or unbounded Retry-After",
        );
      } else if (refillPossible && rejectedWrite.status === 201) {
        // A legitimate write that won the refill; anything else non-429 is a
        // real failure, not a tolerated refill outcome.
        overLimitPostSkipped = true;
      } else {
        activeChecks.check(
          false,
          `rate limit: over-limit POST expected 429 (or a tolerated 201 after a refill window), got ${rejectedWrite.status}`,
        );
      }
    } else {
      overLimitPostStatus = -1;
      overLimitPostSkipped = true;
    }

    const midDb = await openSqliteDatabase(provisioned.databasePath);
    try {
      afterRejectedMessages = await countMessages(midDb, projectId);
      afterRejectedBodies = await countBodyObjects(midDb);
    } finally {
      midDb.close();
    }

    // A tolerated refill on the probe is a legitimate write, so the survivor's
    // sequence accounts for it; a verified 429 must not have written.
    postWroteMessage = overLimitPostSent && overLimitPostStatus === 201;
    // A different credential has its own bucket: it is neither blocked by the
    // exhausted one nor corrupted by the rejected traffic.
    const other = provisioned.exchange[0];
    if (other !== undefined) {
      const me = await request(base, "/api/v1/me", { token: other.token });
      recorder.record(me);
      activeChecks.check(me.status === 200, `rate limit: other credential got ${me.status}`);
      const send = await sendMessageHttp(base, other.token, projectId, "soak-rate-other", {
        summary: "synthetic rate limit survivor",
        text: "synthetic rate limit survivor body",
      });
      recorder.record(send);
      activeChecks.check(send.status === 201, `rate limit: other credential send got ${send.status}`);
      const object = asObject(send.json);
      const otherSendSeq = object === undefined ? undefined : numberField(object, "seq");
      const expectedSeq = beforeMessages + (postWroteMessage ? 1 : 0) + 1;
      activeChecks.check(
        otherSendSeq === expectedSeq,
        `rate limit: other credential seq ${otherSendSeq ?? "none"}, expected ${expectedSeq}`,
      );
    } else {
      activeChecks.check(false, "rate limit: no second credential available");
    }

    const afterDb = await openSqliteDatabase(provisioned.databasePath);
    try {
      afterOtherSend = await countMessages(afterDb, projectId);
    } finally {
      afterDb.close();
    }
  } finally {
    await running.close();
  }

  // Refill is grounded in the measured window, not an assumed request speed:
  // the bucket starts full and each request costs one token, so at most
  // floor(windowMs * perMinute / 60000) extra tokens can be spent. When the
  // POST was skipped pre-send, its gap/duration happened after the loop and
  // cannot have produced any of the loop's limited responses, so only the
  // burst window counts; including them would overstate the allowance.
  const measuredWindowMs = overLimitPostSent
    ? burstElapsedMs + postGapMs + postDurationMs
    : burstElapsedMs;
  const refillAllowance = Math.floor(
    (measuredWindowMs * RATE_LIMIT_PER_MINUTE) / 60_000,
  );
  const maximumAllowed = RATE_LIMIT_BURST + refillAllowance;
  const overLimitRequests = plan.rateLimitRequests + (overLimitPostSent ? 1 : 0);
  activeChecks.check(allowed >= 1, "rate limit burst produced no success");
  activeChecks.check(rateLimited >= 1, "rate limit burst produced no 429");
  activeChecks.check(
    rateLimited >= overLimitRequests - maximumAllowed,
    `rate limit: only ${rateLimited} of ${overLimitRequests} requests were limited`,
  );
  if (rejectedWriteVerified) {
    activeChecks.check(
      afterRejectedMessages === beforeMessages,
      "rate limit: rejected traffic wrote a message",
    );
    activeChecks.check(
      afterRejectedBodies === beforeBodies,
      "rate limit: rejected traffic wrote a body row",
    );
  }
  activeChecks.check(
    afterOtherSend === beforeMessages + (postWroteMessage ? 1 : 0) + 1,
    "rate limit: other credential write count did not advance exactly once",
  );
  return {
    report: recorder.finish({
      requests: overLimitRequests,
      per_minute: RATE_LIMIT_PER_MINUTE,
      burst: RATE_LIMIT_BURST,
      rate_limited: rateLimited,
      allowed,
      burst_elapsed_ms: round1(burstElapsedMs),
      post_gap_ms: round1(postGapMs),
      post_duration_ms: round1(postDurationMs),
      refill_allowance: refillAllowance,
      over_limit_post_status: overLimitPostStatus,
      over_limit_post_skipped: overLimitPostSkipped,
      messages_before: beforeMessages,
      body_objects_before: beforeBodies,
      messages_after_rejected: afterRejectedMessages,
      body_objects_after_rejected: afterRejectedBodies,
      messages_after_other_send: afterOtherSend,
    }),
    rateLimited,
  };
}

function gitValue(args: readonly string[], cwd: string): string | undefined {
  try {
    return execFileSync("git", [...args], { cwd, encoding: "utf8", timeout: 5_000 }).trim();
  } catch {
    return undefined;
  }
}

function metadata(config: SoakConfig): {
  baseSha: string;
  dirty: boolean | null;
  dirtyReason: string | null;
} {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const status = gitValue(["status", "--porcelain"], repoRoot);
  return {
    baseSha: config.baseSha ?? gitValue(["rev-parse", "HEAD"], repoRoot) ?? "unknown",
    dirty: status === undefined ? null : status !== "",
    dirtyReason: status === undefined ? "git status unavailable" : null,
  };
}

export async function runSoak(config: SoakConfig): Promise<SoakReport> {
  activeChecks.failures.length = 0;
  counters.totalRequests = 0;
  counters.integrityFailures = 0;
  counters.unexpected5xx = 0;
  counters.networkErrors = 0;
  counters.rateLimited = 0;
  const plan = effectivePlan(config);
  const startedAt = new Date();
  const startedMs = performance.now();
  const meta = metadata(config);
  const root = mkdtempSync(join(tmpdir(), "corkboard-soak-"));
  const dataDir = join(root, "data");
  const removeTempRoot = (): void => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort; the directory is under the OS temp dir.
    }
  };
  process.once("exit", removeTempRoot);
  // startServer installs process-wide handlers that exit 0; harness-owned
  // handlers registered first must win so a signal cannot mask a failure or
  // leave the temporary installation behind. Convention: 128 + signal number.
  const onSigint = (): void => {
    removeTempRoot();
    process.exit(130);
  };
  const onSigterm = (): void => {
    removeTempRoot();
    process.exit(143);
  };
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const rootKey = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
  const pepperBase64 = Buffer.from(pepper).toString("base64");
  const provisioned = await provision(dataDir, pepper, rootKey, pepperBase64, plan);

  const scenarios: Record<string, ScenarioReport> = {};
  let replayDuplicates = 0;
  let messagesCreated = 0;
  let sendP95 = 0;
  let listP95 = 0;

  // The server writes one JSON log line per request to process.stdout. The
  // caller silences stdout during the run so those logs cannot corrupt the
  // machine-readable report.
  let mainServer: RunningServer | undefined;
  try {
    const main = await startSoakServer(provisioned, { perMinute: "0", burst: "30" });
    mainServer = main.running;
    const base = main.base;

    const small = await smallMessagesScenario(base, provisioned, plan);
    scenarios.small_messages = small.recorder.finish({
      expected: plan.messages,
      created: small.created.length,
      replayed: Math.min(plan.replaySample, small.created.length),
      duplicates: small.replayDuplicates,
      concurrency: plan.concurrency,
      page_sizes_checked: 2,
    });
    replayDuplicates = small.replayDuplicates;
    messagesCreated += small.created.length;

    scenarios.boundary = await boundaryScenario(base, provisioned);
    messagesCreated += 4;

    scenarios.slow_upload = await slowUploadScenario(base, provisioned, plan);
    messagesCreated += 2;

    const smallSample = small.created[0];
    if (smallSample === undefined) {
      activeChecks.check(false, "no small message available for isolation checks");
    }
    const [exchange, pagination] = await Promise.all([
      exchangeScenario(base, provisioned, plan, {
        projectId: provisioned.projectIds.small,
        messageId: smallSample?.messageId ?? "msg_missing",
      }),
      searchPaginationScenario(base, provisioned, plan, small.created),
    ]);
    scenarios.concurrent_speakers = exchange;
    scenarios.metadata_search_pagination = pagination;
    messagesCreated += provisioned.exchange.length * plan.exchangePerSpeaker;

    scenarios.unauthorized_revoked = await unauthorizedScenario(base, provisioned);

    scenarios.body_expiry = await expiryScenario(base, provisioned, plan);
    messagesCreated += plan.expiryMessages;

    sendP95 = Math.max(small.recorder.p95(), exchange.latency_ms.p95);
    listP95 = pagination.latency_ms.p95;
  } finally {
    if (mainServer !== undefined) await mainServer.close();
  }

  const cleanup = await cleanupScenario(provisioned, plan);
  scenarios.operator_cleanup = cleanup.report;
  activeChecks.check(cleanup.messagesUnchanged, "cleanup destroyed messages");

  const rate = await rateLimitScenario(provisioned, plan);
  scenarios.rate_limit_burst = rate.report;
  // The rate-limit survivor added exactly one message to the exchange project.
  messagesCreated += 1;

  const sequenceDb = await openSqliteDatabase(provisioned.databasePath);
  let sequencesContiguous = true;
  try {
    for (const [name, projectId] of Object.entries(provisioned.projectIds)) {
      const failures = await projectSequenceFailures(sequenceDb, projectId);
      if (failures.length > 0) {
        sequencesContiguous = false;
        for (const failure of failures) {
          activeChecks.check(false, `${name} project sequence: ${failure}`);
        }
      }
    }
  } finally {
    sequenceDb.close();
  }
  scenarios.sequence_integrity = new Recorder().finish({
    projects_checked: Object.keys(provisioned.projectIds).length,
    contiguous: sequencesContiguous,
  });

  activeChecks.check(counters.integrityFailures === 0, "integrity failure observed");
  activeChecks.check(counters.unexpected5xx === 0, "unexpected 5xx observed");
  activeChecks.check(counters.networkErrors === 0, "network or timeout error observed");
  activeChecks.check(
    counters.rateLimited === rate.rateLimited,
    `unexpected 429 count: ${counters.rateLimited - rate.rateLimited}`,
  );

  const thresholds = evaluateThresholds(config.profile, round1(sendP95), round1(listP95));
  const durationMs = performance.now() - startedMs;
  removeTempRoot();
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  const report: SoakReport = {
    format: "corkboard-soak",
    version: 1,
    profile: config.profile,
    base_sha: meta.baseSha,
    dirty: meta.dirty,
    dirty_reason: meta.dirtyReason,
    started_at: startedAt.toISOString(),
    duration_ms: round1(durationMs),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: cpus().length,
    config: {
      messages: plan.messages,
      concurrency: plan.concurrency,
      expiry_messages: plan.expiryMessages,
      rate_limit_requests: plan.rateLimitRequests,
      exchange_speakers: plan.exchangeSpeakers,
      exchange_per_speaker: plan.exchangePerSpeaker,
      prune_backlog: plan.pruneBacklog,
      body_sample: plan.bodySample,
      replay_sample: plan.replaySample,
      slow_upload_chunks: plan.slowUploadChunks,
      slow_upload_delay_ms: plan.slowUploadDelayMs,
    },
    scenarios,
    correctness: {
      passed: activeChecks.failures.length === 0,
      failures: [...activeChecks.failures],
    },
    thresholds,
    summary: {
      total_requests: counters.totalRequests,
      messages_created: messagesCreated,
      integrity_failures: counters.integrityFailures,
      unexpected_5xx: counters.unexpected5xx,
      network_errors: counters.networkErrors,
      rate_limited: counters.rateLimited,
      replay_duplicates: replayDuplicates,
    },
  };
  return report;
}

function printHumanSummary(report: SoakReport): void {
  const lines = [
    `soak ${report.profile}: ${report.correctness.passed ? "PASS" : "FAIL"}`,
    `  messages created: ${report.summary.messages_created}; replay duplicates: ${report.summary.replay_duplicates}`,
    `  requests: ${report.summary.total_requests}; integrity failures: ${report.summary.integrity_failures}; unexpected 5xx: ${report.summary.unexpected_5xx}`,
    `  rate limited: ${report.summary.rate_limited}; network errors: ${report.summary.network_errors}`,
    `  send p95: ${report.thresholds.send_p95_ms}ms (guard ${report.thresholds.send_p95_limit_ms}ms); list p95: ${report.thresholds.list_p95_ms}ms (guard ${report.thresholds.list_p95_limit_ms}ms)`,
    `  thresholds (environment-dependent, non-fatal): ${report.thresholds.passed ? "within guards" : report.thresholds.breaches.join("; ")}`,
    `  elapsed: ${report.duration_ms}ms; base: ${report.base_sha}${
      report.dirty === null ? " (tree state unknown)" : report.dirty ? " (dirty tree)" : ""
    }`,
  ];
  if (!report.correctness.passed) {
    for (const failure of report.correctness.failures) lines.push(`  failure: ${failure}`);
  }
  process.stderr.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  let config: SoakConfig;
  try {
    config = parseSoakArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`soak: ${error instanceof Error ? error.message : "invalid arguments"}\n`);
    process.exitCode = 2;
    return;
  }

  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  let report: SoakReport;
  try {
    report = await runSoak(config);
  } finally {
    process.stdout.write = originalWrite as typeof process.stdout.write;
  }
  printHumanSummary(report);
  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exitCode = report.correctness.passed ? 0 : 1;
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
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "soak failed";
    process.stderr.write(`soak: ${message.replace(/[\r\n]+/g, " ")}\n`);
    process.exit(1);
  });
}
