// R2 blob store. Web-standard only: the structural bucket shape below keeps
// this module free of `node:` and Cloudflare imports, so the core stays
// portable. No production selection happens here (the Node server still uses
// LocalBlobStore).

import type { BlobStore } from "../blobs.ts";
import { isValidBlobKey } from "../blobs.ts";

// Minimal structural subset of Cloudflare's `R2Bucket`. The real binding is
// assignable; a test double is in `tests/helpers/r2-double.ts`.
export interface R2ObjectBodyLike {
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectBodyLike | null>;
  put(key: string, value: Uint8Array): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

// No `checkReady`: R2 can only be probed with `head(key)`/`list()`, which need
// a known sentinel object or scan the bucket. There is no side-effect-free
// store-level probe, so the port's optional probe is omitted. A future Workers
// readiness route must add a sentinel-object head probe before this adapter is
// selected for production; skipping it would report ready without touching R2.
export function createR2BlobStore(bucket: R2BucketLike): BlobStore {
  return {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      // Defense in depth: every shipped adapter enforces the port's opaque-key
      // regex. Callers must still supply only generated keys.
      if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
      await bucket.put(key, bytes);
    },
    async get(key: string): Promise<Uint8Array | undefined> {
      if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
      const object = await bucket.get(key);
      if (object === null) return undefined;
      return new Uint8Array(await object.arrayBuffer());
    },
    async delete(key: string): Promise<void> {
      if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
      await bucket.delete(key);
    },
  };
}
