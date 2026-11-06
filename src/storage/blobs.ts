// Private opaque blob storage port. Keys never contain separators or dots.

export interface BlobStore {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
  /**
   * Cheap readiness probe. Resolves only when the backing store is usable and
   * must not create directories, scan contents, or repair state. Absent means
   * the store needs no probe (in-memory).
   */
  checkReady?(): Promise<void>;
}

const BLOB_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

export function isValidBlobKey(key: string): boolean {
  return BLOB_KEY_RE.test(key);
}
