// In-memory blob store for tests and ephemeral deployments.

import type { BlobStore } from "../blobs.ts";
import { isValidBlobKey } from "../blobs.ts";

export class MemoryBlobStore implements BlobStore {
  readonly #blobs = new Map<string, Uint8Array>();

  async checkReady(): Promise<void> {
    // An in-memory map has no external dependency to probe.
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
    this.#blobs.set(key, bytes.slice());
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
    return this.#blobs.get(key)?.slice();
  }

  async delete(key: string): Promise<void> {
    if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
    this.#blobs.delete(key);
  }
}
