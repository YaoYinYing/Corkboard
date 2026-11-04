// Process-local request metrics. Web APIs only; no bodies, summaries, tokens,
// IDs, IPs, or raw pathnames are stored. Route labels are fixed templates so
// attacker-controlled paths cannot grow the map. Values reset on restart and
// are not shared across processes or Workers isolates.

export const METRICS_TOKEN_MIN_LENGTH = 32;

/** Cumulative upper bounds (milliseconds). Durations above the last land in `+Inf`. */
export const LATENCY_BUCKETS_MS = [
  5, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;

export interface MetricsConfig {
  token: string;
}

// An absent or empty token disables the endpoint. Any configured token shorter
// than the minimum fails startup rather than weakening the operator boundary.
export function metricsConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): MetricsConfig | undefined {
  const raw = env.CORKBOARD_METRICS_TOKEN;
  if (raw === undefined || raw === "") return undefined;
  if (raw.length < METRICS_TOKEN_MIN_LENGTH) {
    throw new Error(
      `CORKBOARD_METRICS_TOKEN must be at least ${METRICS_TOKEN_MIN_LENGTH} characters`,
    );
  }
  return { token: raw };
}

export type RouteLabel =
  | "/healthz"
  | "/mcp"
  | "/metrics"
  | "/api/v1/me"
  | "/api/v1/projects"
  | "/api/v1/projects/:projectId"
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

  if (segments.length === 1) {
    if (segments[0] === "healthz") return "/healthz";
    if (segments[0] === "mcp") return "/mcp";
    if (segments[0] === "metrics") return "/metrics";
    return "unknown";
  }

  if (segments[0] !== "api" || segments[1] !== "v1") return "unknown";
  if (segments.length === 3) {
    if (segments[2] === "me") return "/api/v1/me";
    if (segments[2] === "projects") return "/api/v1/projects";
    return "unknown";
  }
  if (segments[2] !== "projects" || segments.length < 4) return "unknown";
  if (segments.length === 4) return "/api/v1/projects/:projectId";
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
}

export class MetricsRegistry {
  private total = 0;
  private readonly routes = new Map<RouteLabel, number>();
  private readonly statuses = new Map<number, number>();
  private readonly errors = new Map<string, number>();
  private latencyCount = 0;
  private latencySumMs = 0;
  private readonly bucketCounts = new Array<number>(LATENCY_BUCKETS_MS.length + 1).fill(0);

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
    let first = LATENCY_BUCKETS_MS.findIndex((bound) => durationMs <= bound);
    if (first === -1) first = LATENCY_BUCKETS_MS.length;
    for (let index = first; index < this.bucketCounts.length; index += 1) {
      this.bucketCounts[index] = (this.bucketCounts[index] ?? 0) + 1;
    }
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
    };
  }
}

// Constant-time for equal-length secrets: the loop always runs to the longer
// input and folds the length difference into the result.
function constantTimeEqual(presented: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const left = encoder.encode(presented);
  const right = encoder.encode(expected);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return difference === 0;
}

/** Accepts exactly `Authorization: Bearer <token>`. */
export function metricsAuthorized(header: string | null, token: string): boolean {
  const prefix = "Bearer ";
  if (header === null || !header.startsWith(prefix)) return false;
  return constantTimeEqual(header.slice(prefix.length), token);
}
