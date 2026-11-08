// Operator-run garbage collection for orphaned local blob files. A blob is an
// orphan when a regular file in the blob directory has a valid opaque key, its
// mtime is at least the grace period old, and no `body_objects.storage_key` row
// references it (any state, including pending/expired/failed/deleted).
//
// There is deliberately no listing API on the blob store port: this command
// scans the local directory directly and never follows symlinks, touches
// non-regular entries, deletes directories, or leaves the blob directory.
//
// Ordering rationale: `commitBody` writes the blob before inserting its
// `body_objects` row, so a just-written file can briefly have no row. The grace
// window is a timing margin, not a guarantee: files whose mtime is within the
// grace window are skipped. Normal operation inserts the row within one local
// statement, but a send stalled longer than grace between those steps (SIGSTOP,
// VM pause, DB hang) can leave a live, row-less blob that a run may collect,
// making later reads fail permanently; operators must keep grace comfortably
// above expected send stalls. A file older than grace with no row is normally
// an abandoned send or a file whose row was cleared by expiry. The reference
// set is read once per run; new sends use fresh random keys, so a concurrent
// send cannot turn an old file into a referenced one.
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
  /** Eligible orphans selected this run, bounded by `limit`. */
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

  // One read for the whole run. Referenced keys are never removed from this
  // set later in the run, so a concurrent expiry can only make collection more
  // conservative.
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
  if (!apply) return summary;

  for (const name of selected) {
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
