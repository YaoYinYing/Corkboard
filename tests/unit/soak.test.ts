import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SoakUsageError,
  evaluateThresholds,
  latencyStats,
  maxBoundaryText,
  overBoundaryText,
  parseSoakArgs,
  percentile,
} from "../../scripts/soak.ts";

test("soak profile defaults and flags", () => {
  const quick = parseSoakArgs([]);
  assert.deepEqual(quick, {
    profile: "quick",
    messages: 200,
    concurrency: 8,
    expiryMessages: 20,
    rateLimitRequests: 12,
  });

  const full = parseSoakArgs([
    "--profile",
    "full",
    "--messages",
    "50",
    "--concurrency",
    "4",
    "--expiry-messages",
    "5",
    "--rate-limit-requests",
    "7",
    "--base-sha",
    "a530693",
  ]);
  assert.deepEqual(full, {
    profile: "full",
    messages: 50,
    concurrency: 4,
    expiryMessages: 5,
    rateLimitRequests: 7,
    baseSha: "a530693",
  });
});

test("soak argument validation rejects bad values", () => {
  for (const args of [
    ["--profile", "huge"],
    ["--messages", "0"],
    ["--messages", "5001"],
    ["--messages", "1.5"],
    ["--concurrency", "65"],
    ["--expiry-messages", "0"],
    ["--rate-limit-requests", "0"],
    ["--unknown"],
    ["positional"],
  ]) {
    assert.throws(() => parseSoakArgs(args), SoakUsageError, args.join(" "));
  }
});

test("nearest-rank percentiles", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([42], 50), 42);
  assert.equal(percentile([1, 2, 3, 4, 5], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  assert.equal(percentile([5, 1, 3], 0), 1);
  assert.equal(percentile([5, 1, 3], 100), 5);
});

test("latency stats summarize p50, p95 and max", () => {
  assert.deepEqual(latencyStats([]), { count: 0, p50: 0, p95: 0, max: 0 });
  assert.deepEqual(latencyStats([10, 20, 30, 40, 50]), {
    count: 5,
    p50: 30,
    p95: 50,
    max: 50,
  });
});

test("8192-byte body boundary is valid and 8193 is over", () => {
  const accepted = maxBoundaryText();
  const rejected = overBoundaryText();
  assert.equal(new TextEncoder().encode(accepted).length, 8192);
  assert.equal(new TextEncoder().encode(rejected).length, 8193);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  assert.equal([...segmenter.segment(accepted)].length, 1024);
  assert.equal([...segmenter.segment(rejected)].length, 1025);
});

test("latency guards are coarse and report breaches without failing correctness", () => {
  const within = evaluateThresholds("quick", 100, 100);
  assert.equal(within.passed, true);
  assert.deepEqual(within.breaches, []);

  const breached = evaluateThresholds("quick", 5_001, 3_001);
  assert.equal(breached.passed, false);
  assert.equal(breached.environment_dependent, true);
  assert.equal(breached.breaches.length, 2);
});
