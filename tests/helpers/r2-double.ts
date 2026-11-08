import type {
  R2BucketLike,
  R2ObjectBodyLike,
} from "../../src/storage/blobs/r2.ts";

export type R2Operation = "get" | "put" | "delete" | "head";

export interface R2Call {
  operation: R2Operation;
  key: string;
}

// Test-only R2 bucket double. It is an in-memory map that implements the same
// structural API as the Cloudflare binding and copies bytes on both sides so
// callers cannot observe aliasing. `calls` records every operation in order and
// `failOn` injects a rejection for one operation until `clearFailure` removes
// it. This is not evidence that live Cloudflare R2 executes these calls.
export class MemoryR2Bucket implements R2BucketLike {
  readonly #objects = new Map<string, Uint8Array>();
  readonly #failures = new Map<R2Operation, Error>();
  readonly calls: R2Call[] = [];

  failOn(operation: R2Operation, error = new Error("r2 unavailable")): void {
    this.#failures.set(operation, error);
  }

  clearFailure(operation: R2Operation): void {
    this.#failures.delete(operation);
  }

  #record(operation: R2Operation, key: string): void {
    this.calls.push({ operation, key });
    const failure = this.#failures.get(operation);
    if (failure !== undefined) throw failure;
  }

  async get(key: string): Promise<R2ObjectBodyLike | null> {
    this.#record("get", key);
    const bytes = this.#objects.get(key);
    if (bytes === undefined) return null;
    return {
      async arrayBuffer(): Promise<ArrayBuffer> {
        return new Uint8Array(bytes).buffer;
      },
    };
  }

  async head(key: string): Promise<object | null> {
    this.#record("head", key);
    return this.#objects.has(key) ? {} : null;
  }

  async put(key: string, value: Uint8Array): Promise<void> {
    this.#record("put", key);
    this.#objects.set(key, value.slice());
  }

  async delete(key: string): Promise<void> {
    this.#record("delete", key);
    this.#objects.delete(key);
  }
}

export function openMemoryR2Bucket(): MemoryR2Bucket {
  return new MemoryR2Bucket();
}
