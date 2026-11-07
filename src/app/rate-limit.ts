// Per-credential token-bucket request limiting. Core Web APIs only, with an
// injected clock. Limits are process-local; they are not shared across
// processes or Workers isolates. This is additional denial only: bearer routes
// check it before authentication using the presented token's public prefix and
// never change authentication or authorization outcomes below the limit.

export const DEFAULT_RATE_LIMIT_PER_MINUTE = 120;
export const DEFAULT_RATE_LIMIT_BURST = 30;
export const MAX_RATE_LIMIT_BURST = 1000;
export const MAX_RATE_LIMIT_KEYS = 10_000;
export const RATE_LIMIT_IDLE_MS = 2 * 60 * 1000;

export interface RateLimitConfig {
  /** Sustained requests per minute. `0` disables limiting. */
  perMinute: number;
  /** Maximum burst capacity (bucket size). */
  burst: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  perMinute: DEFAULT_RATE_LIMIT_PER_MINUTE,
  burst: DEFAULT_RATE_LIMIT_BURST,
};

// Login attempts are limited per normalized email (keyed by its SHA-256, so no
// address is retained). It is intentionally tighter than the per-credential API
// limit and is process-local like every other bucket.
export const DEFAULT_LOGIN_RATE_LIMIT_PER_MINUTE = 10;
export const DEFAULT_LOGIN_RATE_LIMIT_BURST = 5;
export const DEFAULT_LOGIN_RATE_LIMIT: RateLimitConfig = {
  perMinute: DEFAULT_LOGIN_RATE_LIMIT_PER_MINUTE,
  burst: DEFAULT_LOGIN_RATE_LIMIT_BURST,
};

export interface RateLimitDecision {
  allowed: boolean;
  /** Whole seconds until a token is available; 0 when allowed. */
  retryAfterSeconds: number;
}

export interface RateLimiterOptions {
  /** Injectable monotonically-increasing clock in milliseconds. */
  now?: () => number;
  /** Maximum tracked credentials; the oldest entry is evicted when full. */
  maxKeys?: number;
  /** An entry untouched for this long is evicted. */
  idleMs?: number;
}

function parseBoundedInteger(
  name: string,
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback;
  // Only plain decimal digits: rejects signs, whitespace, floats, and exponents.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer ${min}-${max}`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer ${min}-${max}`);
  }
  return value;
}

// Invalid values fail startup rather than silently falling back to defaults.
export function rateLimitConfigFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): RateLimitConfig {
  return {
    perMinute: parseBoundedInteger(
      "CORKBOARD_RATE_LIMIT_PER_MINUTE",
      env.CORKBOARD_RATE_LIMIT_PER_MINUTE,
      DEFAULT_RATE_LIMIT_PER_MINUTE,
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    burst: parseBoundedInteger(
      "CORKBOARD_RATE_LIMIT_BURST",
      env.CORKBOARD_RATE_LIMIT_BURST,
      DEFAULT_RATE_LIMIT_BURST,
      1,
      MAX_RATE_LIMIT_BURST,
    ),
  };
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMinute: number;
  private readonly burst: number;
  private readonly now: () => number;
  private readonly maxKeys: number;
  private readonly idleMs: number;
  private lastSweepAt: number;

  constructor(config: RateLimitConfig, options: RateLimiterOptions = {}) {
    if (!Number.isSafeInteger(config.perMinute) || config.perMinute < 0) {
      throw new Error("rate limit perMinute must be a non-negative integer");
    }
    if (
      !Number.isSafeInteger(config.burst) ||
      config.burst < 1 ||
      config.burst > MAX_RATE_LIMIT_BURST
    ) {
      throw new Error(`rate limit burst must be an integer 1-${MAX_RATE_LIMIT_BURST}`);
    }
    this.perMinute = config.perMinute;
    this.burst = config.burst;
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? MAX_RATE_LIMIT_KEYS;
    this.idleMs = options.idleMs ?? RATE_LIMIT_IDLE_MS;
    if (!Number.isInteger(this.maxKeys) || this.maxKeys < 1) {
      throw new Error("rate limit maxKeys must be a positive integer");
    }
    if (!Number.isFinite(this.idleMs) || this.idleMs < 1) {
      throw new Error("rate limit idleMs must be a positive number");
    }
    this.lastSweepAt = this.now();
  }

  /** Number of tracked credentials; exposed for bounded-memory tests. */
  get size(): number {
    return this.buckets.size;
  }

  check(credentialId: string): RateLimitDecision {
    if (this.perMinute === 0) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.now();
    this.sweepIdle(now);

    let bucket = this.buckets.get(credentialId);
    if (bucket === undefined) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      bucket = { tokens: this.burst, updatedAt: now };
      this.buckets.set(credentialId, bucket);
    } else if (now > bucket.updatedAt) {
      const refilled = ((now - bucket.updatedAt) * this.perMinute) / 60_000;
      bucket.tokens = Math.min(this.burst, bucket.tokens + refilled);
      bucket.updatedAt = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }

    // perMinute > 0 here (0 returned above), so the wait is finite.
    const waitMs = ((1 - bucket.tokens) * 60_000) / this.perMinute;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
  }

  // Time-gated so the O(n) scan runs at most once per idle window.
  private sweepIdle(now: number): void {
    if (now - this.lastSweepAt < this.idleMs) return;
    this.lastSweepAt = now;
    for (const [credentialId, bucket] of this.buckets) {
      if (now - bucket.updatedAt >= this.idleMs) this.buckets.delete(credentialId);
    }
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestAt = Number.POSITIVE_INFINITY;
    for (const [credentialId, bucket] of this.buckets) {
      if (bucket.updatedAt < oldestAt) {
        oldestAt = bucket.updatedAt;
        oldestKey = credentialId;
      }
    }
    if (oldestKey !== undefined) this.buckets.delete(oldestKey);
  }
}
