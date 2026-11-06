// Process-local request and message-timing metrics. Web APIs only; no bodies,
// summaries, tokens, IDs, IPs, or raw pathnames are stored. Route labels are
// fixed templates so attacker-controlled paths cannot grow the map. Values reset
// on restart and are not shared across processes or Workers isolates.
import { digestsEqual, sha256Hex } from "../domain/digest.ts";

export const METRICS_TOKEN_MIN_LENGTH = 32;
const ENCODER = new TextEncoder();

// One normalization boundary for env parsing and direct createApp callers.
// Empty/whitespace-only means disabled; a non-empty value below the minimum
// fails without ever including the value in the error.
export function normalizeMetricsToken(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  if (raw.length < METRICS_TOKEN_MIN_LENGTH) {
    throw new Error(
      `CORKBOARD_METRICS_TOKEN must be at least ${METRICS_TOKEN_MIN_LENGTH} characters`,
    );
  }
  return raw;
}

/** Cumulative upper bounds (milliseconds). Durations above the last land in `+Inf`. */
export const LATENCY_BUCKETS_MS = [
  5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface MetricsConfig {
  token: string;
}

// Cumulative `le` buckets: a sample increments its own bucket index and every
// larger bucket, including `+Inf`.
function recordBucket(counts: number[], durationMs: number): void {
  let first = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
  if (first === -1) first = LATENCY_BUCKETS_MS.length;
  for (let index = first; index < counts.length; index += 1) {
    counts[index] = (counts[index] ?? 0) + 1;
  }
}

// An absent, empty, or whitespace-only token disables the endpoint. Any other
// token shorter than the minimum fails startup rather than weakening the
// operator boundary.
export function metricsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MetricsConfig | undefined {
  const token = normalizeMetricsToken(env.CORKBOARD_METRICS_TOKEN);
  return token === undefined ? undefined : { token };
}

export type RouteLabel =
  | "/"
  | "/login"
  | "/static/app.css"
  | "/projects/:projectId"
  | "/projects/:projectId/messages/:messageId/body"
  | "/healthz"
  | "/readyz"
  | "/mcp"
  | "/metrics"
  | "/.well-known/oauth-protected-resource"
  | "/.well-known/oauth-authorization-server"
  | "/oauth/register"
  | "/oauth/authorize"
  | "/oauth/signin"
  | "/oauth/consent"
  | "/oauth/token"
  | "/oauth/revoke"
  | "/oauth/client.js"
  | "/api/v1/me"
  | "/api/v1/session"
  | "/api/v1/projects"
  | "/api/v1/projects/:projectId"
  | "/api/v1/projects/:projectId/stats"
  | "/api/v1/projects/:projectId/messages"
  | "/api/v1/projects/:projectId/messages/:messageId"
  | "/api/v1/projects/:projectId/messages/:messageId/body"
  | "/api/v1/projects/:projectId/messages/:messageId/read"
  | "/api/v1/projects/:projectId/messages/:messageId/expire"
  | "unknown";

// Only literal route segments are examined; project/message IDs are never
// copied into a label. MCP requests (including tool calls) share `/mcp`.
export function routeLabelFor(pathname: string): RouteLabel {
  const segments = pathname.split("/").filter((segment) => segment !== "");

  if (segments.length === 0) return "/";

  if (segments.length === 1) {
    if (segments[0] === "login") return "/login";
    if (segments[0] === "healthz") return "/healthz";
    if (segments[0] === "readyz") return "/readyz";
    if (segments[0] === "mcp") return "/mcp";
    if (segments[0] === "metrics") return "/metrics";
    return "unknown";
  }

  // Public OAuth routes use fixed labels; no client IDs, scopes, or query
  // values are retained.
  if (segments.length === 2) {
    if (segments[0] === "static" && segments[1] === "app.css") return "/static/app.css";
    if (segments[0] === "projects") return "/projects/:projectId";
    if (segments[0] === ".well-known") {
      if (segments[1] === "oauth-protected-resource") {
        return "/.well-known/oauth-protected-resource";
      }
      if (segments[1] === "oauth-authorization-server") {
        return "/.well-known/oauth-authorization-server";
      }
      return "unknown";
    }
    if (segments[0] === "oauth") {
      switch (segments[1]) {
        case "register":
          return "/oauth/register";
        case "authorize":
          return "/oauth/authorize";
        case "signin":
          return "/oauth/signin";
        case "consent":
          return "/oauth/consent";
        case "token":
          return "/oauth/token";
        case "revoke":
          return "/oauth/revoke";
        case "client.js":
          return "/oauth/client.js";
        default:
          return "unknown";
      }
    }
  }

  if (
    segments.length === 5 &&
    segments[0] === "projects" &&
    segments[2] === "messages" &&
    segments[4] === "body"
  ) {
    return "/projects/:projectId/messages/:messageId/body";
  }

  if (segments[0] !== "api" || segments[1] !== "v1") return "unknown";
  if (segments.length === 3) {
    if (segments[2] === "me") return "/api/v1/me";
    if (segments[2] === "session") return "/api/v1/session";
    if (segments[2] === "projects") return "/api/v1/projects";
    return "unknown";
  }
  if (segments[2] !== "projects" || segments.length < 4) return "unknown";
  if (segments.length === 4) return "/api/v1/projects/:projectId";
  if (segments.length === 5 && segments[4] === "stats") {
    return "/api/v1/projects/:projectId/stats";
  }
  if (segments[4] !== "messages") return "unknown";
  if (segments.length === 5) return "/api/v1/projects/:projectId/messages";
  if (segments.length === 6) {
    return "/api/v1/projects/:projectId/messages/:messageId";
  }
  if (segments.length === 7) {
    if (segments[6] === "body") {
      return "/api/v1/projects/:projectId/messages/:messageId/body";
    }
    if (segments[6] === "read") {
      return "/api/v1/projects/:projectId/messages/:messageId/read";
    }
    if (segments[6] === "expire") {
      return "/api/v1/projects/:projectId/messages/:messageId/expire";
    }
  }
  return "unknown";
}

export interface MetricsSnapshot {
  requests: { total: number };
  routes: Array<{ route: RouteLabel; count: number }>;
  statuses: Array<{ status: number; count: number }>;
  errors: Array<{ code: string; count: number }>;
  latency_ms: {
    count: number;
    sum: number;
    /** Cumulative counts; `le_ms: null` is the `+Inf` bucket. */
    buckets: Array<{ le_ms: number | null; count: number }>;
  };
  /** Queue-to-commit delay for messages finalized by this process. */
  queue_to_commit_ms: {
    count: number;
    sum: number;
    /** Cumulative counts; `le_ms: null` is the `+Inf` bucket. */
    buckets: Array<{ le_ms: number | null; count: number }>;
  };
}

export class MetricsRegistry {
  private total = 0;
  private readonly routes = new Map<RouteLabel, number>();
  private readonly statuses = new Map<number, number>();
  private readonly errors = new Map<string, number>();
  private latencyCount = 0;
  private latencySumMs = 0;
  private readonly bucketCounts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);
  private queueCommitCount = 0;
  private queueCommitSumMs = 0;
  private readonly queueCommitBucketCounts = new Array<number>(
    LATENCY_BUCKETS_MS.length + 1,
  ).fill(0);

  recordRequest(
    route: RouteLabel,
    status: number,
    errorCode: string | undefined,
    durationMs: number,
  ): void {
    this.total += 1;
    this.routes.set(route, (this.routes.get(route) ?? 0) + 1);
    this.statuses.set(status, (this.statuses.get(status) ?? 0) + 1);
    if (errorCode !== undefined) {
      this.errors.set(errorCode, (this.errors.get(errorCode) ?? 0) + 1);
    }

    this.latencyCount += 1;
    this.latencySumMs += durationMs;
    // Buckets are cumulative (`le`), so a sample increments its own bucket and
    // every larger bucket, including `+Inf`.
    recordBucket(this.bucketCounts, durationMs);
  }

  /**
   * Records one finalized message's queue-to-commit delay: server time from
   * provisional creation (`received_at`, seq NULL) to finalization (`committed_at`,
   * seq assigned). Idempotent replays are not samples; the caller records only a
   * finalization this call performed. Non-finite samples are ignored.
   */
  recordQueueToCommit(durationMs: number): void {
    if (!Number.isFinite(durationMs)) return;
    const sample = Math.max(0, durationMs);
    this.queueCommitCount += 1;
    this.queueCommitSumMs += sample;
    recordBucket(this.queueCommitBucketCounts, sample);
  }

  snapshot(): MetricsSnapshot {
    return {
      requests: { total: this.total },
      routes: [...this.routes.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([route, count]) => ({ route, count })),
      statuses: [...this.statuses.entries()]
        .sort(([left], [right]) => left - right)
        .map(([status, count]) => ({ status, count })),
      errors: [...this.errors.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([code, count]) => ({ code, count })),
      latency_ms: {
        count: this.latencyCount,
        sum: this.latencySumMs,
        buckets: [
          ...LATENCY_BUCKETS_MS.map((bound, index) => ({
            le_ms: bound as number | null,
            count: this.bucketCounts[index] ?? 0,
          })),
          { le_ms: null, count: this.bucketCounts[LATENCY_BUCKETS_MS.length] ?? 0 },
        ],
      },
      queue_to_commit_ms: {
        count: this.queueCommitCount,
        sum: this.queueCommitSumMs,
        buckets: [
          ...LATENCY_BUCKETS_MS.map((bound, index) => ({
            le_ms: bound as number | null,
            count: this.queueCommitBucketCounts[index] ?? 0,
          })),
          {
            le_ms: null,
            count: this.queueCommitBucketCounts[LATENCY_BUCKETS_MS.length] ?? 0,
          },
        ],
      },
    };
  }
}

// Both inputs are digested to a fixed 64-character representation before the
// constant-time fold, so the equality comparison always has fixed length and no
// early exit. Hashing itself still costs time proportional to its input length.
async function fixedLengthEqual(presented: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    sha256Hex(ENCODER.encode(presented)),
    sha256Hex(ENCODER.encode(expected)),
  ]);
  return digestsEqual(left, right);
}

/**
 * Accepts exactly `Authorization: Bearer <token>`.
 *
 * The token comparison is fixed-length and constant-time. Timing can still
 * differ between a disabled endpoint (no hashing) and an enabled endpoint with
 * a Bearer header (two SHA-256 operations), so status/body non-disclosure does
 * not imply perfect timing indistinguishability of the enabled state.
 */
export function metricsAuthorized(header: string | null, token: string): Promise<boolean> {
  const prefix = "Bearer ";
  if (header === null || !header.startsWith(prefix)) return Promise.resolve(false);
  return fixedLengthEqual(header.slice(prefix.length), token);
}
