import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SoakUsageError,
  contiguousSequenceFailures,
  effectivePlan,
  evaluateThresholds,
  latencyStats,
  maxBoundaryText,
  maxSummaryBytes,
  maxSummaryText,
  overBoundaryText,
  overSummaryBytes,
  overSummaryText,
  paddedJsonBody,
  parseSoakArgs,
  percentile,
  runBounded,
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

test("effective plan applies count overrides and keeps profile-only fields", () => {
  const config = parseSoakArgs([
    "--profile",
    "quick",
    "--messages",
    "3",
    "--concurrency",
    "1",
    "--expiry-messages",
    "1",
    "--rate-limit-requests",
    "6",
  ]);
  assert.deepEqual(effectivePlan(config), {
    messages: 3,
    concurrency: 1,
    expiryMessages: 1,
    rateLimitRequests: 6,
    exchangeSpeakers: 4,
    exchangePerSpeaker: 10,
    pruneBacklog: 25,
    bodySample: 25,
    replaySample: 10,
    slowUploadChunks: 8,
    slowUploadDelayMs: 25,
    sendP95LimitMs: 5_000,
    listP95LimitMs: 3_000,
  });
});

test("full profile raises the sustained rate-limit and slow-upload bounds", () => {
  const full = effectivePlan(parseSoakArgs(["--profile", "full"]));
  assert.equal(full.rateLimitRequests, 40);
  assert.equal(full.slowUploadChunks, 64);
  assert.equal(full.slowUploadDelayMs, 50);
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
    ["--rate-limit-requests", "5"],
    ["--base-sha", "not-hex"],
    ["--base-sha", "abc\u0007def"],
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

test("summary boundaries distinguish the grapheme and byte caps", () => {
  const encoder = new TextEncoder();
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  assert.equal([...segmenter.segment(maxSummaryText())].length, 140);
  assert.equal(encoder.encode(maxSummaryText()).length, 140);
  assert.equal([...segmenter.segment(overSummaryText())].length, 141);
  assert.equal([...segmenter.segment(maxSummaryBytes())].length, 128);
  assert.equal(encoder.encode(maxSummaryBytes()).length, 1024);
  assert.equal([...segmenter.segment(overSummaryBytes())].length, 129);
  assert.equal(encoder.encode(overSummaryBytes()).length, 1032);
});

test("padded JSON reaches an exact byte count and still parses", () => {
  const prefix = JSON.stringify({ summary: "boundary", text: "x" });
  const atCap = paddedJsonBody(prefix, 64 * 1024);
  assert.equal(new TextEncoder().encode(atCap).length, 64 * 1024);
  assert.deepEqual(JSON.parse(atCap), JSON.parse(prefix));
  assert.throws(() => paddedJsonBody(prefix, 1), RangeError);
});

test("contiguous sequence checks report gaps, duplicates, and an offset start", () => {
  assert.deepEqual(contiguousSequenceFailures([1, 2, 3]), []);
  assert.deepEqual(contiguousSequenceFailures([1, 2, 4]), ["expected seq 3, got 4"]);
  assert.deepEqual(contiguousSequenceFailures([1, 1, 2]), ["duplicate seq 1"]);
  assert.deepEqual(contiguousSequenceFailures([10, 11], 10), []);
});

test("runBounded caps in-flight work and awaits every item", async () => {
  let active = 0;
  let maximum = 0;
  const seen: number[] = [];
  await runBounded(Array.from({ length: 20 }, (_, index) => index), 4, async (index) => {
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    seen.push(index);
    active -= 1;
  });
  assert.equal(seen.length, 20);
  assert.equal(new Set(seen).size, 20);
  assert.ok(maximum > 1 && maximum <= 4, `observed ${maximum} in-flight items`);
});

test("runBounded propagates a worker failure instead of hanging", async () => {
  await assert.rejects(
    runBounded([1, 2, 3], 1, async (index) => {
      if (index === 2) throw new Error("bounded failure");
    }),
    /bounded failure/,
  );
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
