import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BlobStore } from "../../src/storage/blobs.ts";
import { isValidBlobKey } from "../../src/storage/blobs.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";
import {
  createR2BlobStore,
  R2_READINESS_SENTINEL_KEY,
  type R2BucketLike,
} from "../../src/storage/blobs/r2.ts";
import { openMemoryR2Bucket } from "../helpers/r2-double.ts";

// Shared blob contract. The R2 run uses an in-memory structural double
// (`tests/helpers/r2-double.ts`), not live Cloudflare R2. Blob keys are opaque
// and must match `isValidBlobKey`; each shipped adapter enforces that regex as
// defense in depth, but callers remain responsible for supplying generated
// keys and authorization happens before the store is reached.

export interface ContractBlobStore {
  readonly store: BlobStore;
  dispose(): void;
}

export type BlobStoreFactory = () => ContractBlobStore;

function opaqueKey(seed: string): string {
  return `key_${seed}`.padEnd(24, "x");
}

function binary(length: number, seed = 0): Uint8Array {
  return Uint8Array.from({ length }, (_, index) => (index * 37 + seed) & 0xff);
}

export function runBlobContract(
  name: string,
  openStore: BlobStoreFactory,
): void {
  const scenario = (title: string): string => `${name}: ${title}`;

  test(scenario("round-trips empty, small, and multi-KiB binary data"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);

    const cases: Array<[string, Uint8Array]> = [
      ["empty", new Uint8Array(0)],
      ["small", Uint8Array.of(0x00, 0x01, 0x7f, 0xff)],
      ["multi-kib", binary(5000, 11)],
    ];
    for (const [label, bytes] of cases) {
      const key = opaqueKey(label);
      await store.put(key, bytes);
      const loaded = await store.get(key);
      assert.ok(loaded instanceof Uint8Array, `${label}: not a Uint8Array`);
      assert.deepEqual(Array.from(loaded), Array.from(bytes), label);
    }
  });

  test(scenario("a missing key returns undefined"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);
    assert.equal(await store.get(opaqueKey("missing")), undefined);
  });

  test(scenario("delete removes the object and is idempotent"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);
    const key = opaqueKey("delete");
    const bytes = binary(64, 3);

    await store.put(key, bytes);
    assert.deepEqual(await store.get(key), bytes);
    await store.delete(key);
    assert.equal(await store.get(key), undefined);
    // Deleting a missing object is a success, like expiry cleanup expects.
    await store.delete(key);
    await store.delete(opaqueKey("never-written"));
  });

  test(scenario("overwrite replaces the previous bytes"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);
    const key = opaqueKey("overwrite");

    await store.put(key, binary(32, 1));
    const replacement = binary(4000, 2);
    await store.put(key, replacement);
    assert.deepEqual(Array.from((await store.get(key)) ?? []), Array.from(replacement));

    const shorter = Uint8Array.of(9, 8, 7);
    await store.put(key, shorter);
    assert.deepEqual(Array.from((await store.get(key)) ?? []), Array.from(shorter));
  });

  test(scenario("keys stay opaque and invalid keys are rejected"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);

    // Distinct valid keys never alias, even with identical bytes.
    const first = opaqueKey("alpha");
    const second = opaqueKey("beta");
    const shared = binary(48, 7);
    await store.put(first, shared);
    await store.put(second, shared);
    await store.put(first, binary(48, 8));
    assert.deepEqual(Array.from((await store.get(second)) ?? []), Array.from(shared));

    // Separators, dots, short/long and empty keys are outside the port.
    for (const invalid of [
      "",
      "short",
      "has.dot",
      "has/slash",
      "../escape",
      "x".repeat(129),
    ]) {
      await assert.rejects(store.put(invalid, shared), TypeError, invalid);
      await assert.rejects(store.get(invalid), TypeError, invalid);
      await assert.rejects(store.delete(invalid), TypeError, invalid);
    }
  });

  test(scenario("accepts keys at the 16- and 128-character bounds"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);

    for (const [label, key] of [
      ["minimum", "a".repeat(16)],
      ["maximum", "z".repeat(128)],
    ] as const) {
      const bytes = binary(40, key.length);
      await store.put(key, bytes);
      assert.deepEqual(
        Array.from((await store.get(key)) ?? []),
        Array.from(bytes),
        label,
      );
      await store.delete(key);
      assert.equal(await store.get(key), undefined, label);
    }
  });

  test(scenario("round-trips a subarray view with non-zero byteOffset"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);

    const backing = binary(256, 9);
    const view = backing.subarray(37, 193);
    assert.notEqual(view.byteOffset, 0);
    const key = opaqueKey("subarray");

    await store.put(key, view);
    const loaded = await store.get(key);
    assert.ok(loaded instanceof Uint8Array);
    assert.deepEqual(Array.from(loaded), Array.from(view));
  });

  test(scenario("checkReady resolves for a usable store"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);
    // Adapters with no external dependency may omit the probe entirely.
    await store.checkReady?.();
    assert.equal(await store.get(opaqueKey("after-readiness")), undefined);
  });

  test(scenario("concurrent puts and gets stay isolated"), async (t) => {
    const { store, dispose } = openStore();
    t.after(dispose);

    const entries = Array.from({ length: 16 }, (_, index) => ({
      key: opaqueKey(`concurrent-${index}`),
      bytes: binary(100 + index * 13, index),
    }));
    await Promise.all(entries.map(({ key, bytes }) => store.put(key, bytes)));
    const loaded = await Promise.all(entries.map(({ key }) => store.get(key)));
    for (const [index, { bytes }] of entries.entries()) {
      assert.deepEqual(
        Array.from(loaded[index] ?? []),
        Array.from(bytes),
        `entry ${index}`,
      );
    }
  });
}

runBlobContract("memory", () => ({
  store: new MemoryBlobStore(),
  dispose(): void {},
}));

runBlobContract("local", () => {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-blob-contract-"));
  return {
    store: new LocalBlobStore(dir),
    dispose(): void {
      rmSync(dir, { recursive: true, force: true });
    },
  };
});

runBlobContract("r2", () => ({
  store: createR2BlobStore(openMemoryR2Bucket()),
  dispose(): void {},
}));

// R2 adapter-specific negatives. The shared contract above covers behavior
// every adapter must share; these cover the structural bucket boundary.

function bucket(
  overrides: Partial<R2BucketLike> = {},
): R2BucketLike {
  return {
    get: async () => null,
    put: async () => undefined,
    delete: async () => undefined,
    head: async () => null,
    ...overrides,
  };
}

test("r2: a null bucket body maps to undefined", async () => {
  const store = createR2BlobStore(bucket({ get: async () => null }));
  assert.equal(await store.get(opaqueKey("absent")), undefined);
});

test("r2: a failing bucket operation rejects", async () => {
  const failure = { message: "r2 unavailable" };
  const key = opaqueKey("failure");

  const failing = bucket({
    get: async () => {
      throw new Error(failure.message);
    },
    put: async () => {
      throw new Error(failure.message);
    },
    delete: async () => {
      throw new Error(failure.message);
    },
  });
  const store = createR2BlobStore(failing);

  await assert.rejects(store.put(key, binary(16)), failure);
  await assert.rejects(store.get(key), failure);
  await assert.rejects(store.delete(key), failure);

  const badBody = createR2BlobStore(
    bucket({
      get: async () => ({
        arrayBuffer: async () => {
          throw new Error("truncated body");
        },
      }),
    }),
  );
  await assert.rejects(badBody.get(key), { message: "truncated body" });
});

test("r2: put passes exactly the supplied bytes", async () => {
  let capturedKey: string | undefined;
  let capturedBytes: Uint8Array | undefined;
  const store = createR2BlobStore(
    bucket({
      put: async (key, value) => {
        capturedKey = key;
        capturedBytes = value;
      },
    }),
  );
  const key = opaqueKey("exact");
  const bytes = binary(777, 5);

  await store.put(key, bytes);

  assert.equal(capturedKey, key);
  assert.ok(capturedBytes !== undefined);
  // Exact bytes; a defensive copy is acceptable, encoding drift is not.
  assert.deepEqual(Array.from(capturedBytes), Array.from(bytes));
});

test("r2: invalid keys never reach the bucket", async () => {
  const inner = openMemoryR2Bucket();
  const calls = { get: 0, put: 0, delete: 0, head: 0 };
  const counted: R2BucketLike = {
    get: async (key) => {
      calls.get += 1;
      return inner.get(key);
    },
    put: async (key, value) => {
      calls.put += 1;
      return inner.put(key, value);
    },
    delete: async (key) => {
      calls.delete += 1;
      return inner.delete(key);
    },
    head: async (key) => {
      calls.head += 1;
      return inner.head(key);
    },
  };
  const store = createR2BlobStore(counted);

  for (const invalid of ["", "short", "has.dot", "has/slash", "../escape"]) {
    await assert.rejects(store.put(invalid, Uint8Array.of(1)), TypeError);
    await assert.rejects(store.get(invalid), TypeError);
    await assert.rejects(store.delete(invalid), TypeError);
  }

  assert.deepEqual(calls, { get: 0, put: 0, delete: 0, head: 0 });
});

test("r2: checkReady heads the reserved sentinel once and never writes", async () => {
  const inner = openMemoryR2Bucket();
  const store = createR2BlobStore(inner);
  assert.equal(isValidBlobKey(R2_READINESS_SENTINEL_KEY), true);
  assert.ok(store.checkReady);

  await store.checkReady();

  assert.deepEqual(inner.calls, [
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
  ]);
});

test("r2: checkReady resolves whether the sentinel is absent or present", async () => {
  const heads: Array<() => Promise<object | null>> = [
    async () => null,
    async () => ({}),
  ];
  for (const head of heads) {
    const store = createR2BlobStore(bucket({ head }));
    assert.ok(store.checkReady);
    await assert.doesNotReject(store.checkReady());
  }
});

test("r2: checkReady rejects when the bucket head rejects", async () => {
  const inner = openMemoryR2Bucket();
  const failure = new Error("r2 bucket denied");
  inner.failOn("head", failure);
  const store = createR2BlobStore(inner);
  assert.ok(store.checkReady);

  await assert.rejects(store.checkReady(), failure);

  assert.deepEqual(inner.calls, [
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
  ]);
});
