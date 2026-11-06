// Private local blob directory: 0700 directory, 0600 files, atomic rename.
// There is deliberately no listing API.

import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "../blobs.ts";
import { isValidBlobKey } from "../blobs.ts";

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export class LocalBlobStore implements BlobStore {
  readonly #dir: string;

  constructor(dir: string) {
    this.#dir = dir;
  }

  async #ensureDir(): Promise<void> {
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await chmod(this.#dir, 0o700);
  }

  #path(key: string): string {
    if (!isValidBlobKey(key)) throw new TypeError("invalid blob key");
    return join(this.#dir, key);
  }

  // Deliberately does not use #ensureDir: a readiness probe must report a
  // missing directory, not create it and then report healthy.
  async checkReady(): Promise<void> {
    const entry = await stat(this.#dir);
    if (!entry.isDirectory()) throw new TypeError("blob path is not a directory");
    await access(this.#dir, constants.R_OK | constants.W_OK | constants.X_OK);
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.#path(key);
    await this.#ensureDir();
    const temp = join(this.#dir, `.tmp-${randomBytes(16).toString("hex")}`);
    try {
      await writeFile(temp, bytes, { mode: 0o600, flag: "wx" });
      await rename(temp, target);
    } catch (error) {
      await unlink(temp).catch(() => undefined);
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const path = this.#path(key);
    await this.#ensureDir();
    try {
      return new Uint8Array(await readFile(path));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const path = this.#path(key);
    await this.#ensureDir();
    try {
      await unlink(path);
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
}
