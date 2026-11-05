import type { SqlDatabase, SqlTransaction } from "./db.ts";

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
  /** Authenticated principal's speaker; the row must belong to it. */
  speakerId: string;
}

const MAX_FINALIZE_ATTEMPTS = 5;
const RETRY_BACKOFF_MS = 5;

// One statement publishes seq, ready state and the blob reference. The trigger
// in migration 001 advances projects.next_seq and completes the idempotency key.
// The sender predicate binds the authenticated principal, so a pending row that
// belongs to another speaker (for example after an out-of-band idempotency
// tamper) can never be published through this caller.
const FINALIZE_SQL = `UPDATE messages
   SET seq = (SELECT p.next_seq + 1 FROM projects p WHERE p.id = messages.project_id AND p.status = 'active'),
       body_state = 'ready', committed_at = ?1, body_object_id = ?2
 WHERE id = ?3 AND project_id = ?4 AND sender_speaker_id = ?5 AND body_state = 'pending'
 RETURNING seq`;

// Session sends carry the whole authorization predicate in the publication
// statement, so the transaction callback that runs it is write-only and
// result-independent: it issues one UPDATE and reads nothing, and no affected
// row count is observed (a buffered D1 adapter cannot return it before the batch
// is submitted). Zero rows means either the row was not pending (a
// concurrent/replayed finalize already published it) or the session predicate
// no longer holds; the caller reloads after commit and infers the outcome from
// row state.
//
// `instr` is the same quoted stored-JSON capability test used by the bearer
// project listing. It is equivalent to the strict parser for every JSON scope
// array this application writes, and the quotes prevent matching a longer scope
// name; the strict entry check remains the gate for malformed or non-array JSON.
const FINALIZE_SESSION_SQL = `UPDATE messages
   SET seq = (SELECT p.next_seq + 1 FROM projects p WHERE p.id = messages.project_id AND p.status = 'active'),
       body_state = 'ready', committed_at = ?1, body_object_id = ?2
 WHERE id = ?3 AND project_id = ?4 AND sender_speaker_id = ?5 AND body_state = 'pending'
   AND EXISTS (
     SELECT 1
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
       JOIN projects p ON p.id = m.project_id
      WHERE m.project_id = messages.project_id
        AND m.speaker_id = ?5
        AND m.removed_at IS NULL
        AND s.owner_account_id = ?6
        AND s.status = 'active'
        AND a.status = 'active'
        AND p.status = 'active'
        AND instr(m.capabilities, '"message.send"') > 0)`;

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

export interface FinalizeSessionMessageInput extends FinalizeMessageInput {
  accountId: string;
}

// Publishes only while the selected speaker still passes the session-send
// predicate. The result is deliberately not observed: the caller reloads row
// state after the transaction commits. Zero rows is not retried; retryable
// unique/lock errors are. Debt: the backoff sleeps while the caller's
// transaction is open, which would hold a write lock across retries on a
// multi-connection adapter.
export async function finalizeSessionMessage(
  db: SqlTransaction,
  input: FinalizeSessionMessageInput,
): Promise<void> {
  for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      await db.run(FINALIZE_SESSION_SQL, [
        input.committedAt,
        input.bodyObjectId,
        input.messageId,
        input.projectId,
        input.speakerId,
        input.accountId,
      ]);
      return;
    } catch (error) {
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

export async function finalizeMessage(
  db: SqlTransaction,
  input: FinalizeMessageInput,
): Promise<number> {
  for (let attempt = 1; attempt <= MAX_FINALIZE_ATTEMPTS; attempt += 1) {
    try {
      const row = await db.first<{ seq: number | null }>(FINALIZE_SQL, [
        input.committedAt,
        input.bodyObjectId,
        input.messageId,
        input.projectId,
        input.speakerId,
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
