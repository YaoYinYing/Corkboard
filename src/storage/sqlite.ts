import type { SqlDatabase } from "./db.ts";

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

export interface FinalizeMessageInput {
  projectId: string;
  messageId: string;
  bodyObjectId: string;
  committedAt: string;
}

const MAX_FINALIZE_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 5;

// One statement publishes seq, ready state and the blob reference. The trigger
// in migration 001 advances projects.next_seq and completes the idempotency key.
const FINALIZE_SQL = `UPDATE messages
   SET seq = (SELECT p.next_seq + 1 FROM projects p WHERE p.id = messages.project_id AND p.status = 'active'),
       body_state = 'ready', committed_at = ?1, body_object_id = ?2
 WHERE id = ?3 AND project_id = ?4 AND body_state = 'pending'
 RETURNING seq`;

function isRetryable(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return /UNIQUE constraint failed|database is locked|database is busy/i.test(
    error.message,
  );
}

function isMissingActiveProject(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  // An inactive/missing project makes the seq subquery NULL, which aborts the
  // ready CHECK (or the trigger's next_seq NOT NULL) before any row publishes.
  return (
    /NOT NULL constraint failed: projects\.next_seq/.test(error.message) ||
    /CHECK constraint failed: body_state/.test(error.message)
  );
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

export async function finalizeMessage(
  db: SqlDatabase,
  input: FinalizeMessageInput,
): Promise<number> {
  for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      const row = await db.first<{ seq: number | null }>(FINALIZE_SQL, [
        input.committedAt,
        input.bodyObjectId,
        input.messageId,
        input.projectId,
      ]);
      if (row === undefined || row.seq === null) {
        throw new NotFoundError("Pending message not found");
      }
      return row.seq;
    } catch (error) {
      if (error instanceof NotFoundError) {
        throw error;
      }
      if (isMissingActiveProject(error)) {
        throw new NotFoundError("Active project not found");
      }
      if (!isRetryable(error)) {
        throw error;
      }
      if (attempt === MAX_FINALIZE_ATTEMPTS) {
        throw new ConflictError("Could not allocate a unique message sequence");
      }
      // A concurrent finalize may have taken the same seq; retry reads the
      // now-advanced next_seq. Keep this portable for the future D1 adapter.
      await delay(RETRY_BACKOFF_MS * attempt);
    }
  }
  throw new ConflictError("Could not allocate a unique message sequence");
}

export interface IdempotencyInsert {
  speakerId: string;
  projectId: string;
  key: string;
  payloadDigest: string;
  messageId: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export async function insertIdempotency(
  db: SqlDatabase,
  input: IdempotencyInsert,
): Promise<boolean> {
  const result = await db.run(
    `INSERT INTO idempotency_keys
       (speaker_id, project_id, key, payload_digest, message_id, status, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
     ON CONFLICT(speaker_id, project_id, key) DO NOTHING`,
    [
      input.speakerId,
      input.projectId,
      input.key,
      input.payloadDigest,
      input.messageId,
      input.status,
      input.createdAt,
      input.updatedAt,
    ],
  );
  return result.changes === 1;
}
