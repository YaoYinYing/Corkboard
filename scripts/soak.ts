#!/usr/bin/env node
// Bounded local load/soak harness. Runs the real Node HTTP server against a
// temporary data directory outside the repository with synthetic principals,
// then prints one JSON report on stdout and a short human summary on stderr.
// It never reads the primary data directory, never prints tokens/bodies/IPs,
// and makes no network calls beyond loopback.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
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
  dirty: boolean;
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

interface ProfilePlan {
  messages: number;
  concurrency: number;
  expiryMessages: number;
  rateLimitRequests: number;
  exchangeSpeakers: number;
  exchangePerSpeaker: number;
  pruneBacklog: number;
  bodySample: number;
  replaySample: number;
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
    sendP95LimitMs: 5_000,
    listP95LimitMs: 3_000,
  },
  full: {
    messages: 1_000,
    concurrency: 16,
    expiryMessages: 100,
    rateLimitRequests: 20,
    exchangeSpeakers: 8,
    exchangePerSpeaker: 25,
    pruneBacklog: 50,
    bodySample: 100,
    replaySample: 25,
    sendP95LimitMs: 15_000,
    listP95LimitMs: 8_000,
  },
};

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
  const rateLimitRequests =
    values["rate-limit-requests"] === undefined
      ? plan.rateLimitRequests
      : parseInteger(values["rate-limit-requests"], "--rate-limit-requests", 1, 500);

  return {
    profile: rawProfile,
    messages,
    concurrency,
    expiryMessages,
    rateLimitRequests,
    ...(values["base-sha"] === undefined ? {} : { baseSha: values["base-sha"] }),
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
    const raw = await response.text();
    let json: unknown;
    if (raw !== "" && raw.length <= MAX_RESPONSE_BYTES) {
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

async function sendMessageHttp(
  base: string,
  token: string,
  projectId: string,
  idempotencyKey: string,
  input: SendInput,
): Promise<HttpOutcome> {
  const body = JSON.stringify({
    summary: input.summary,
    type: input.type ?? "request",
    language: input.language ?? "en",
    text: input.text,
    body_digest: digestOf(input.text),
    ...(input.replyToId === undefined ? {} : { reply_to_id: input.replyToId }),
    ...(input.bodyExpiresAt === undefined ? {} : { body_expires_at: input.bodyExpiresAt }),
  });
  return request(base, `/api/v1/projects/${encodeURIComponent(projectId)}/messages`, {
    method: "POST",
    token,
    headers: { "content-type": "application/json", "idempotency-key": idempotencyKey },
    body,
  });
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

async function runBounded<T>(
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
  projectIds: {
    small: string;
    exchange: string;
    boundary: string;
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
    expiry: "proj_soak_expiry",
  };
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
      [accountId, "soak@example.test", now],
    );
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

async function smallMessagesScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ recorder: Recorder; replayDuplicates: number; createdCount: number }> {
  const recorder = new Recorder();
  const created: Array<{ messageId: string; seq: number; key: string; text: string; summary: string }> = [];
  const indexes = Array.from({ length: plan.messages }, (_, index) => index);
  await runBounded(indexes, plan.concurrency, async (index) => {
    const text = `synthetic soak body ${index}`;
    const summary = index % 10 === 0 ? `soakneedle small ${index}` : `soak small ${index}`;
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
  return { recorder, replayDuplicates, createdCount: created.length };
}

async function boundaryScenario(
  base: string,
  provisioned: Provisioned,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const accepted = await sendMessageHttp(
    base,
    provisioned.main.token,
    provisioned.projectIds.boundary,
    "soak-boundary-8192",
    { summary: "soak boundary accepted", text: maxBoundaryText() },
  );
  recorder.record(accepted);
  activeChecks.check(accepted.status === 201, `boundary 8192 bytes: expected 201, got ${accepted.status}`);

  const rejected = await sendMessageHttp(
    base,
    provisioned.main.token,
    provisioned.projectIds.boundary,
    "soak-boundary-8193",
    { summary: "soak boundary rejected", text: overBoundaryText() },
  );
  recorder.record(rejected);
  activeChecks.check(rejected.status === 400, `boundary 8193 bytes: expected 400, got ${rejected.status}`);
  activeChecks.check(
    errorCodeOf(rejected.json) === "VALIDATION_ERROR",
    "boundary 8193 bytes: expected VALIDATION_ERROR",
  );

  const db = await openSqliteDatabase(provisioned.databasePath);
  try {
    const stored = await countMessages(db, provisioned.projectIds.boundary);
    activeChecks.check(stored === 1, `boundary: stored ${stored} messages, expected 1`);
  } finally {
    db.close();
  }
  return recorder.finish({
    accepted_bytes: new TextEncoder().encode(maxBoundaryText()).length,
    rejected_bytes: new TextEncoder().encode(overBoundaryText()).length,
  });
}

async function exchangeScenario(
  base: string,
  provisioned: Provisioned,
  plan: ProfilePlan,
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

  return recorder.finish({
    speakers: provisioned.exchange.length,
    expected_messages: expectedTotal,
    created_messages: seedIds.length + createdIds.length,
    replies: expectedReplies.size,
  });
}

async function searchPaginationScenario(
  base: string,
  provisioned: Provisioned,
  expectedMessages: number,
): Promise<ScenarioReport> {
  const recorder = new Recorder();
  const all = await paginate(
    base,
    provisioned.main.token,
    provisioned.projectIds.small,
    "",
    100,
    recorder,
  );
  activeChecks.check(all.complete, "pagination did not complete");
  activeChecks.check(
    all.rows.length === expectedMessages,
    `pagination returned ${all.rows.length} of ${expectedMessages} messages`,
  );
  checkAscendingUnique(all.rows, "pagination");

  const expectedHits = Math.ceil(expectedMessages / 10);
  const search = await paginate(
    base,
    provisioned.main.token,
    provisioned.projectIds.small,
    "&q=soakneedle",
    25,
    recorder,
  );
  activeChecks.check(search.complete, "search pagination did not complete");
  activeChecks.check(
    search.rows.length === expectedHits,
    `summary search returned ${search.rows.length} of ${expectedHits} hits`,
  );
  checkAscendingUnique(search.rows, "summary search");
  const searchIds = new Set(search.rows.map((row) => row.messageId));
  for (const row of search.rows) {
    activeChecks.check(all.rows.some((entry) => entry.messageId === row.messageId), "search hit outside ordered set");
  }
  activeChecks.check(searchIds.size === search.rows.length, "search returned duplicate ids");
  return recorder.finish({
    ordered_messages: all.rows.length,
    pages: Math.ceil(expectedMessages / 100),
    search_hits: search.rows.length,
    search_pages: Math.ceil(expectedHits / 25),
    complete: all.complete && search.complete,
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

function runCli(args: readonly string[], dataDir: string): { code: number; stdout: string } {
  const cliPath = fileURLToPath(new URL("./corkboard.ts", import.meta.url));
  try {
    const stdout = execFileSync(process.execPath, [cliPath, ...args, "--data-dir", dataDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, CORKBOARD_DATA_DIR: dataDir },
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

async function cleanupScenario(
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ report: ScenarioReport; messagesUnchanged: boolean }> {
  const recorder = new Recorder();
  const db = await openSqliteDatabase(provisioned.databasePath);
  let beforeMessages = 0;
  let afterMessages = 0;
  try {
    beforeMessages = await countMessages(db, provisioned.projectIds.small) +
      await countMessages(db, provisioned.projectIds.exchange) +
      await countMessages(db, provisioned.projectIds.boundary) +
      await countMessages(db, provisioned.projectIds.expiry);

    const old = new Date(Date.now() - 48 * 60 * 60_000).toISOString();
    const future = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    for (let index = 0; index < plan.pruneBacklog; index += 1) {
      await db.run(
        `INSERT INTO sessions
           (id, account_id, token_prefix, token_verifier, csrf_verifier, created_at, last_seen_at, expires_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          `sess_soak_${index}`,
          provisioned.accountId,
          "cb_sess_soak",
          "synthetic-verifier",
          "synthetic-csrf",
          old,
          old,
          future,
          old,
        ],
      );
    }
  } finally {
    db.close();
  }

  // Real operator CLI on the temporary installation: expire-bodies is a no-op
  // after the injected-clock service run, and prune deletes the backdated
  // revoked session backlog. Neither may touch messages.
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

  const after = await openSqliteDatabase(provisioned.databasePath);
  try {
    afterMessages = await countMessages(after, provisioned.projectIds.small) +
      await countMessages(after, provisioned.projectIds.exchange) +
      await countMessages(after, provisioned.projectIds.boundary) +
      await countMessages(after, provisioned.projectIds.expiry);
  } finally {
    after.close();
  }
  const messagesUnchanged = afterMessages === beforeMessages;
  activeChecks.check(messagesUnchanged, "operator cleanup changed message counts");

  return {
    report: recorder.finish({
      expire_bodies_exit: expire.code,
      expire_failures: typeof expireSummary?.failures === "number" ? expireSummary.failures : -1,
      prune_exit: prune.code,
      prune_sessions_deleted: sessions,
      messages_before: beforeMessages,
      messages_after: afterMessages,
      messages_unchanged: messagesUnchanged,
    }),
    messagesUnchanged,
  };
}

async function rateLimitScenario(
  provisioned: Provisioned,
  plan: ProfilePlan,
): Promise<{ report: ScenarioReport; rateLimited: number }> {
  const recorder = new Recorder();
  const { running, base } = await startSoakServer(provisioned, { perMinute: "30", burst: "5" });
  let rateLimited = 0;
  try {
    for (let index = 0; index < plan.rateLimitRequests; index += 1) {
      const outcome = await request(base, "/api/v1/me", { token: provisioned.main.token });
      recorder.record(outcome);
      if (outcome.status === 429) {
        rateLimited += 1;
        activeChecks.check(
          errorCodeOf(outcome.json) === "RATE_LIMITED",
          "rate limit: expected RATE_LIMITED",
        );
        const retryAfter = Number(outcome.headers.get("retry-after") ?? "");
        activeChecks.check(
          Number.isInteger(retryAfter) && retryAfter >= 1,
          "rate limit: missing or invalid Retry-After",
        );
      } else {
        activeChecks.check(outcome.status === 200, `rate limit: unexpected status ${outcome.status}`);
      }
    }
  } finally {
    await running.close();
  }
  activeChecks.check(rateLimited >= 1, "rate limit burst produced no 429");
  activeChecks.check(rateLimited < plan.rateLimitRequests, "rate limit burst produced no success");
  return {
    report: recorder.finish({
      requests: plan.rateLimitRequests,
      per_minute: 30,
      burst: 5,
      rate_limited: rateLimited,
      allowed: plan.rateLimitRequests - rateLimited,
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

function metadata(config: SoakConfig): { baseSha: string; dirty: boolean } {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  return {
    baseSha: config.baseSha ?? gitValue(["rev-parse", "HEAD"], repoRoot) ?? "unknown",
    dirty: (gitValue(["status", "--porcelain"], repoRoot) ?? "") !== "",
  };
}

export async function runSoak(config: SoakConfig): Promise<SoakReport> {
  activeChecks.failures.length = 0;
  counters.totalRequests = 0;
  counters.integrityFailures = 0;
  counters.unexpected5xx = 0;
  counters.networkErrors = 0;
  counters.rateLimited = 0;
  const plan = PROFILE_PLANS[config.profile];
  const startedAt = new Date();
  const startedMs = performance.now();
  const meta = metadata(config);
  const root = mkdtempSync(join(tmpdir(), "corkboard-soak-"));
  const dataDir = join(root, "data");
  process.once("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Best effort; the directory is under the OS temp dir.
    }
  });

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
      created: small.createdCount,
      replayed: Math.min(plan.replaySample, small.createdCount),
      duplicates: small.replayDuplicates,
      concurrency: plan.concurrency,
    });
    replayDuplicates = small.replayDuplicates;
    messagesCreated += small.createdCount;

    scenarios.boundary = await boundaryScenario(base, provisioned);
    messagesCreated += 1;

    const [exchange, pagination] = await Promise.all([
      exchangeScenario(base, provisioned, plan),
      searchPaginationScenario(base, provisioned, plan.messages),
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

  activeChecks.check(counters.integrityFailures === 0, "integrity failure observed");
  activeChecks.check(counters.unexpected5xx === 0, "unexpected 5xx observed");
  activeChecks.check(counters.networkErrors === 0, "network or timeout error observed");
  activeChecks.check(
    counters.rateLimited === rate.rateLimited,
    `unexpected 429 count: ${counters.rateLimited - rate.rateLimited}`,
  );

  const thresholds = evaluateThresholds(config.profile, round1(sendP95), round1(listP95));
  const durationMs = performance.now() - startedMs;
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // The exit hook retries; the directory is under the OS temp dir.
  }
  const report: SoakReport = {
    format: "corkboard-soak",
    version: 1,
    profile: config.profile,
    base_sha: meta.baseSha,
    dirty: meta.dirty,
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
    `  elapsed: ${report.duration_ms}ms; base: ${report.base_sha}${report.dirty ? " (dirty tree)" : ""}`,
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
