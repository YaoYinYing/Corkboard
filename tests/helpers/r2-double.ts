import type {
  R2BucketLike,
  R2ObjectBodyLike,
} from "../../src/storage/blobs/r2.ts";

// Test-only R2 bucket double. It is an in-memory map that implements the same
// structural API as the Cloudflare binding and copies bytes on both sides so
// callers cannot observe aliasing. It throws no custom errors; real R2
// failures are simulated by wrapping it in a test-local fake. This is not
// evidence that live Cloudflare R2 executes these calls.
export class MemoryR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, Uint8Array>();

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    const bytes = this.#objects.get(key);
    if (bytes === undefined) return null;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array(bytes).buffer;
      },
    };
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#objects.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.#objects.delete(key);
  }
}

export function openMemoryR2Bucket(): MemoryR2Bucket {
  return new MemoryR2Bucket();
}
