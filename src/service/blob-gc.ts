// Operator-run garbage collection for orphaned local blob files. A blob is an
// orphan when a regular file in the blob directory has a valid opaque key, its
// mtime is at least the grace period old, and no `body_objects.storage_key` row
// references it (any state, including pending/expired/failed/deleted).
//
// There is deliberately no listing API on the blob store port: this command
// scans the local directory directly and never follows symlinks, touches
// non-regular entries, deletes directories, or leaves the blob directory.
//
// Safety invariant: `commitBody` commits its `body_objects` row (the reference)
// before it writes the ciphertext. A live send therefore never owns a file with
// no row, regardless of how long it pauses between those steps. Apply mode
// additionally re-reads referenced keys immediately before unlinking and drops
// any candidate that gained a row after the scan. The reference set is not
// monotonic: expiry can clear a key after deleting its ciphertext between the
// two reads. That cannot turn a live send's file into a target, because a live
// send's row is committed before its file exists, and expiry only clears keys
// whose ciphertext is already gone. The grace window is a conservative
// candidate filter, not the concurrency proof. See docs/blob-gc-safety.md for
// the proof and crash analysis.
//
// File deletion is not transactional. The summary distinguishes per-file
// failures from successes and never implies a rollback.
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isValidBlobKey } from "../storage/blobs.ts";
import type { SqlDatabase } from "../storage/db.ts";
import { writeAudit } from "./audit.ts";

export const BLOB_GC_DEFAULT_GRACE_HOURS = 24;
export const BLOB_GC_MIN_GRACE_HOURS = 1;
export const BLOB_GC_MAX_GRACE_HOURS = 8760;
export const BLOB_GC_DEFAULT_LIMIT = 1000;
export const BLOB_GC_MAX_LIMIT = 10_000;

const HOUR_MS = 60 * 60 * 1000;

export interface BlobGcDeps {
  db: SqlDatabase;
  now: () => Date;
}

export interface BlobGcOptions {
  /** Hours a file must have been unreferenced before it is eligible. */
  graceHours?: number;
  /** Maximum files selected for deletion in one run. */
  limit?: number;
  /** False (default) lists candidates and deletes nothing. */
  apply?: boolean;
}

export interface BlobGcSummary {
  dryRun: boolean;
  graceHours: number;
  limit: number;
  /**
   * Candidates selected this run, bounded by `limit`. A dry run reports the
   * pre-fence selection; apply mode reports the post-fence targets, so a file
   * retained by the second reference read is in `skippedReferenced`, not here.
   */
  candidates: number;
  deleted: number;
  failed: number;
  skippedRecent: number;
  skippedReferenced: number;
  /** Set only when files were deleted but the audit row could not be written. */
  auditFailed?: boolean;
}

export class BlobGcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlobGcError";
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

export function validateBlobGcOptions(options: BlobGcOptions = {}): {
  graceHours: number;
  limit: number;
  apply: boolean;
} {
  const graceHours = options.graceHours ?? BLOB_GC_DEFAULT_GRACE_HOURS;
  if (
    !Number.isInteger(graceHours) ||
    graceHours < BLOB_GC_MIN_GRACE_HOURS ||
    graceHours > BLOB_GC_MAX_GRACE_HOURS
  ) {
    throw new RangeError(
      `graceHours must be an integer ${BLOB_GC_MIN_GRACE_HOURS}-${BLOB_GC_MAX_GRACE_HOURS}`,
    );
  }
  const limit = options.limit ?? BLOB_GC_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > BLOB_GC_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer 1-${BLOB_GC_MAX_LIMIT}`);
  }
  return { graceHours, limit, apply: options.apply === true };
}

export async function pruneOrphanBlobs(
  deps: BlobGcDeps,
  blobDir: string,
  options: BlobGcOptions = {},
): Promise<BlobGcSummary> {
  const { graceHours, limit, apply } = validateBlobGcOptions(options);
  const nowMs = deps.now().getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now must be a valid date");
  }
  const graceMs = graceHours * HOUR_MS;

  const summary: BlobGcSummary = {
    dryRun: !apply,
    graceHours,
    limit,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
  };

  const blobEntry = await lstat(blobDir).catch((error: unknown) => {
    if (isNotFound(error)) return undefined;
    throw new BlobGcError("cannot read the blob directory");
  });
  if (blobEntry === undefined) {
    // No blob directory means no local files to collect.
    return summary;
  }
  if (blobEntry.isSymbolicLink() || !blobEntry.isDirectory()) {
    // Never follow a symlinked or non-directory blob path.
    throw new BlobGcError("blob path is not a regular directory");
  }

  let entries;
  try {
    entries = await readdir(blobDir, { withFileTypes: true });
  } catch {
    throw new BlobGcError("cannot read the blob directory");
  }

  // First reference read (R0): the candidate filter and the dry-run report.
  // Apply mode re-reads immediately before unlinking (R1).
  const referencedRows = await deps.db.all<{ storage_key: string }>(
    "SELECT storage_key FROM body_objects WHERE storage_key IS NOT NULL",
  );
  const referenced = new Set(referencedRows.map((row) => row.storage_key));

  const eligible: string[] = [];
  for (const entry of entries.sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (!isValidBlobKey(entry.name)) continue; // not a stored opaque blob key
    let stats;
    try {
      // lstat never follows a symlink; a symlink or special file is ignored.
      stats = await lstat(join(blobDir, entry.name));
    } catch (error) {
      if (isNotFound(error)) continue; // vanished during the scan
      throw new BlobGcError("cannot read a blob directory entry");
    }
    if (!stats.isFile()) continue;
    if (referenced.has(entry.name)) {
      summary.skippedReferenced += 1;
      continue;
    }
    if (nowMs - stats.mtimeMs < graceMs) {
      summary.skippedRecent += 1;
      continue;
    }
    eligible.push(entry.name);
  }

  const selected = eligible.slice(0, limit);
  summary.candidates = selected.length;
  if (!apply || selected.length === 0) return summary;

  // Second reference read (R1), immediately before the destructive step. With
  // reference-before-write, any live send whose file was visible to the scan
  // committed its row before that file existed, hence before R1. A candidate
  // that acquired a row since R0 belongs to such a send; retain it.
  const currentRows = await deps.db.all<{ storage_key: string }>(
    "SELECT storage_key FROM body_objects WHERE storage_key IS NOT NULL",
  );
  const current = new Set(currentRows.map((row) => row.storage_key));
  const targets = selected.filter((name) => {
    if (!current.has(name)) return true;
    summary.skippedReferenced += 1;
    return false;
  });
  summary.candidates = targets.length;

  for (const name of targets) {
    try {
      // Exact path, and the key regex forbids separators, so this cannot leave
      // the blob directory. unlink removes a symlink itself, never its target.
      await unlink(join(blobDir, name));
      summary.deleted += 1;
    } catch {
      // Include a file that vanished after the scan: the operator asked to
      // delete it and it was not deleted by this run.
      summary.failed += 1;
    }
  }

  // One sanitized system-actor row per run that actually deleted a file. It is
  // written after the deletions so an audit failure cannot change them; a dry
  // run or zero-deletion run writes nothing.
  if (summary.deleted > 0) {
    const written = await writeAudit(deps, {
      operation: "blob.orphan_prune",
      outcome: "success",
      detail: {
        graceHours: summary.graceHours,
        limit: summary.limit,
        deleted: summary.deleted,
        failed: summary.failed,
      },
    });
    if (!written) summary.auditFailed = true;
  }

  return summary;
}
