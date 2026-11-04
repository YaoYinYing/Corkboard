// Body expiry and tombstone transition shared by HTTP and the operator CLI.
// Ordering invariant: a message is durably `expired` before its blob is deleted.
import { AppError } from "../domain/errors.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { SqlDatabase } from "../storage/db.ts";
import { authorizeProject, type Principal, type ServiceDeps } from "./auth.ts";

export interface ExpiryDeps {
  db: SqlDatabase;
  blobs: BlobStore;
  now: () => Date;
}

export interface ExpireMessageResult {
  messageId: string;
  bodyState: "expired";
}

export interface ExpireBodiesSummary {
  examined: number;
  expired: number;
  blobsDeleted: number;
  failures: number;
}

export interface ExpireBodiesOptions {
  limit?: number;
}

const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 5000;

function randomId(prefix: string): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `${prefix}${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

// Sanitized: identifiers and outcome only, never content.
async function auditExpiry(
  deps: ExpiryDeps,
  projectId: string,
  speakerId: string | null,
  accountId: string | null,
): Promise<void> {
  await deps.db.run(
    `INSERT INTO audit_events
       (id, actor_account_id, actor_speaker_id, project_id, operation, outcome, request_id, created_at)
     VALUES (?, ?, ?, ?, 'message.expire', 'success', NULL, ?)`,
    [randomId("evt_"), accountId, speakerId, projectId, deps.now().toISOString()],
  );
}

// Deletes the stored ciphertext only when the referencing message is already
// `expired`. A missing blob counts as success; the row is then marked deleted so
// repeat runs do no further work.
export async function deleteExpiredBodyBlob(
  deps: ExpiryDeps,
  projectId: string,
  messageId: string,
): Promise<boolean> {
  const message = await deps.db.first<{
    body_state: string;
    body_object_id: string | null;
  }>(
    "SELECT body_state, body_object_id FROM messages WHERE id = ? AND project_id = ?",
    [messageId, projectId],
  );
  if (
    message === undefined ||
    message.body_state !== "expired" ||
    message.body_object_id === null
  ) {
    return false;
  }

  const object = await deps.db.first<{
    id: string;
    storage_key: string | null;
    state: string | null;
  }>(
    "SELECT id, storage_key, state FROM body_objects WHERE id = ? AND project_id = ?",
    [message.body_object_id, projectId],
  );
  if (object === undefined) return false;
  if (object.state === "deleted") return false;

  // The local and memory stores treat a missing key as a successful delete.
  if (object.storage_key !== null) {
    await deps.blobs.delete(object.storage_key);
  }
  await deps.db.run(
    "UPDATE body_objects SET state = 'deleted', storage_key = NULL WHERE id = ? AND project_id = ?",
    [object.id, projectId],
  );
  return true;
}

// Decision order matches the other body routes: membership before scope before
// message state. Only `ready` transitions; an already expired body is an
// idempotent success.
export async function expireMessageBody(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
): Promise<ExpireMessageResult> {
  await authorizeProject(deps, principal, projectId, "project.edit");

  const message = await deps.db.first<{
    seq: number | null;
    body_state: string;
  }>(
    "SELECT seq, body_state FROM messages WHERE id = ? AND project_id = ?",
    [messageId, projectId],
  );
  if (
    message === undefined ||
    message.seq === null ||
    message.body_state === "pending" ||
    message.body_state === "failed"
  ) {
    throw new AppError("NOT_FOUND");
  }

  if (message.body_state === "expired") {
    // Retry a crash-interrupted cleanup, but never fail the idempotent call.
    try {
      await deleteExpiredBodyBlob(deps, projectId, messageId);
    } catch {
      // The cleanup worker retries.
    }
    return { messageId, bodyState: "expired" };
  }
  if (message.body_state !== "ready") throw new AppError("NOT_FOUND");

  let changes: number;
  try {
    const result = await deps.db.run(
      `UPDATE messages SET body_state = 'expired'
        WHERE id = ? AND project_id = ? AND body_state = 'ready'`,
      [messageId, projectId],
    );
    changes = result.changes;
  } catch {
    throw new AppError("UNAVAILABLE");
  }

  if (changes === 0) {
    // A concurrent expiry won; report the same idempotent success.
    const current = await deps.db.first<{ body_state: string }>(
      "SELECT body_state FROM messages WHERE id = ? AND project_id = ?",
      [messageId, projectId],
    );
    if (current?.body_state !== "expired") throw new AppError("NOT_FOUND");
  } else {
    try {
      await auditExpiry(deps, projectId, principal.speakerId, principal.accountId);
    } catch {
      throw new AppError("UNAVAILABLE");
    }
  }

  try {
    await deleteExpiredBodyBlob(deps, projectId, messageId);
  } catch {
    // Best-effort: the operator-run worker retries the orphan.
  }
  return { messageId, bodyState: "expired" };
}

function validateLimit(limit: number | undefined): number {
  const value = limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new AppError("VALIDATION_ERROR", `limit must be 1-${MAX_LIMIT}`);
  }
  return value;
}

// Two phases, safe to run repeatedly and after a crash:
//  1. mark due `ready` rows expired (audited), then
//  2. delete ciphertext for every `expired` row whose object is not deleted.
// Per-row failures are counted and never stop the run.
export async function expireDueBodies(
  deps: ExpiryDeps,
  options: ExpireBodiesOptions = {},
): Promise<ExpireBodiesSummary> {
  const limit = validateLimit(options.limit);
  const nowIso = deps.now().toISOString();
  const summary: ExpireBodiesSummary = {
    examined: 0,
    expired: 0,
    blobsDeleted: 0,
    failures: 0,
  };

  const due = await deps.db.all<{
    id: string;
    project_id: string;
    sender_speaker_id: string;
  }>(
    `SELECT id, project_id, sender_speaker_id
       FROM messages
      WHERE body_state = 'ready'
        AND body_expires_at IS NOT NULL
        AND body_expires_at <= ?
      ORDER BY project_id ASC, seq ASC
      LIMIT ?`,
    [nowIso, limit],
  );
  summary.examined += due.length;

  for (const row of due) {
    try {
      const result = await deps.db.run(
        `UPDATE messages SET body_state = 'expired'
          WHERE id = ? AND project_id = ? AND body_state = 'ready'
            AND body_expires_at IS NOT NULL AND body_expires_at <= ?`,
        [row.id, row.project_id, nowIso],
      );
      if (result.changes === 0) continue; // a concurrent run already took it
      summary.expired += 1;
    } catch {
      summary.failures += 1;
      continue;
    }
    try {
      await auditExpiry(deps, row.project_id, row.sender_speaker_id, null);
    } catch {
      summary.failures += 1;
    }
  }

  const orphans = await deps.db.all<{ id: string; project_id: string }>(
    `SELECT m.id, m.project_id
       FROM messages m
       JOIN body_objects b ON b.id = m.body_object_id
      WHERE m.body_state = 'expired'
        AND m.body_object_id IS NOT NULL
        AND (b.state IS NULL OR b.state <> 'deleted')
      ORDER BY m.project_id ASC, m.seq ASC
      LIMIT ?`,
    [limit],
  );
  summary.examined += orphans.length;

  for (const row of orphans) {
    try {
      if (await deleteExpiredBodyBlob(deps, row.project_id, row.id)) {
        summary.blobsDeleted += 1;
      }
    } catch {
      summary.failures += 1;
    }
  }

  return summary;
}
