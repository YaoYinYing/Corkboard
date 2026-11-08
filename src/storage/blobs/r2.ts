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
  head(key: string): Promise<object | null>;
}

// Reserved readiness sentinel. The adapter never writes, lists, or deletes it,
// and callers must never use it as an object key; readiness only needs to know
// the bucket answers `head`. Absent and present are both healthy.
export const R2_READINESS_SENTINEL_KEY = "_corkboard_readiness_";

export function createR2BlobStore(bucket: R2BucketLike): BlobStore {
  return {
    // One `head` of the reserved sentinel proves reachability and read
    // permission without creating, scanning, or repairing anything.
    async checkReady(): Promise<void> {
      await bucket.head(R2_READINESS_SENTINEL_KEY);
    },
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
