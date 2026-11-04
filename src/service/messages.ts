import {
  EnvelopeFormatError,
  IntegrityError,
  openBody,
  sealBody,
  type OpenedBody,
} from "../crypto/envelope.ts";
import { hashSecret } from "../auth/credentials.ts";
import { digestsEqual, sha256Hex } from "../domain/digest.ts";
import { AppError } from "../domain/errors.ts";
import { requireScope } from "../domain/authz.ts";
import {
  validateBodyDigest,
  validateIdempotencyKey,
  validateLanguage,
  validateSummary,
  validateText,
  validateType,
  verifySenderDigest,
} from "../domain/validation.ts";
import { NotFoundError, finalizeMessage, insertIdempotency } from "../storage/sqlite.ts";
import type { SqlValue } from "../storage/db.ts";
import { authorizeProject, type Principal, type ServiceDeps } from "./auth.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_QUERY_CHARS = 100;

export interface SendMessageInput {
  summary: string;
  type: string;
  language: string;
  text: string;
  bodyDigest: string;
  replyToId?: string | null;
  clientSentAt?: string | null;
}

export interface SendMessageResult {
  messageId: string;
  projectId: string;
  seq: number;
  committedAt: string;
  bodyState: "ready" | "expired";
  digest: string;
}

export interface ListMessagesQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  type?: string;
  sender?: string;
  unread?: boolean;
  q?: string;
}

export interface MessageMetadata {
  messageId: string;
  projectId: string;
  seq: number;
  sender: { speakerId: string; displayName: string | null };
  summary: string;
  type: string;
  language: string;
  replyToId: string | null;
  bodyState: "ready" | "expired";
  clientSentAt: string | null;
  receivedAt: string;
  committedAt: string;
}

export interface ListMessagesResult {
  messages: MessageMetadata[];
  nextCursor: number | null;
}

export interface MessageBody {
  messageId: string;
  text: string;
  compression: "none" | "gzip";
  digest: string;
}

export interface ReadReceiptResult {
  messageId: string;
  speakerId: string;
  readAt: string;
}

function randomToken(bytes = 16): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomId(prefix: string): string {
  return `${prefix}${randomToken(16)}`;
}

// Canonical, sorted-key JSON of the normalized request. Scoped by
// (speaker, project, key), so the speaker is not part of the digest, and keyed
// with the service pepper so the at-rest digest is not an unkeyed plaintext hash.
async function canonicalPayloadDigest(
  pepper: Uint8Array,
  input: {
    summary: string;
    type: string;
    language: string;
    text: string;
    bodyDigest: string;
    replyToId: string | null;
    clientSentAt: string | null;
  },
): Promise<string> {
  const canonical = JSON.stringify({
    bodyDigest: input.bodyDigest,
    clientSentAt: input.clientSentAt,
    language: input.language,
    replyToId: input.replyToId,
    summary: input.summary,
    text: input.text,
    type: input.type,
  });
  return `hmac-sha256:${await hashSecret(canonical, pepper)}`;
}

interface MessageRow {
  id: string;
  project_id: string;
  seq: number | null;
  sender_speaker_id: string;
  summary: string;
  type: string;
  language: string;
  reply_to_id: string | null;
  client_sent_at: string | null;
  received_at: string;
  committed_at: string | null;
  body_state: string;
  body_object_id: string | null;
}

interface MessageListRow {
  id: string;
  project_id: string;
  seq: number | null;
  sender_speaker_id: string;
  display_name: string | null;
  summary: string;
  type: string;
  language: string;
  reply_to_id: string | null;
  body_state: string;
  client_sent_at: string | null;
  received_at: string;
  committed_at: string | null;
}

interface BodyObjectRow {
  id: string;
  project_id: string;
  storage_key: string | null;
  ciphertext_digest: string | null;
}

const MESSAGE_COLUMNS = `m.id, m.project_id, m.seq, m.sender_speaker_id, m.summary, m.type,
  m.language, m.reply_to_id, m.client_sent_at, m.received_at, m.committed_at,
  m.body_state, m.body_object_id`;

async function loadMessage(
  deps: ServiceDeps,
  projectId: string,
  messageId: string,
): Promise<MessageRow | undefined> {
  return deps.db.first<MessageRow>(
    `SELECT ${MESSAGE_COLUMNS} FROM messages m WHERE m.id = ? AND m.project_id = ?`,
    [messageId, projectId],
  );
}

function sendResult(row: MessageRow, digest: string): SendMessageResult {
  if (row.seq === null || row.committed_at === null) throw new AppError("UNAVAILABLE");
  if (row.body_state !== "ready" && row.body_state !== "expired") {
    throw new AppError("UNAVAILABLE");
  }
  return {
    messageId: row.id,
    projectId: row.project_id,
    seq: row.seq,
    committedAt: row.committed_at,
    bodyState: row.body_state,
    digest,
  };
}

function listRowToMetadata(row: MessageListRow): MessageMetadata {
  if (row.seq === null || row.committed_at === null) throw new AppError("UNAVAILABLE");
  if (row.body_state !== "ready" && row.body_state !== "expired") {
    throw new AppError("NOT_FOUND");
  }
  return {
    messageId: row.id,
    projectId: row.project_id,
    seq: row.seq,
    sender: { speakerId: row.sender_speaker_id, displayName: row.display_name },
    summary: row.summary,
    type: row.type,
    language: row.language,
    replyToId: row.reply_to_id,
    bodyState: row.body_state,
    clientSentAt: row.client_sent_at,
    receivedAt: row.received_at,
    committedAt: row.committed_at,
  };
}

// The envelope header length is a fixed 4-byte big-endian prefix after the
// 4-byte magic, so the ciphertext length is derivable without re-parsing it.
function envelopeCipherLength(envelope: Uint8Array): number {
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(4, false);
  return envelope.length - 8 - headerLength;
}

// Publishes a pending message and returns the committed row. A concurrent
// finalize of the same message is treated as success and reloaded.
async function publish(
  deps: ServiceDeps,
  projectId: string,
  messageId: string,
  bodyObjectId: string,
): Promise<MessageRow> {
  try {
    await finalizeMessage(deps.db, {
      projectId,
      messageId,
      bodyObjectId,
      committedAt: deps.now().toISOString(),
    });
  } catch (error) {
    if (!(error instanceof NotFoundError)) throw error;
  }
  const row = await loadMessage(deps, projectId, messageId);
  if (row === undefined || (row.body_state !== "ready" && row.body_state !== "expired")) {
    throw new AppError("UNAVAILABLE");
  }
  return row;
}

// Writes the blob, body_objects row and provisional message, then finalizes.
// Shortcut: concurrent same-key retries can race before either sees the other's
// provisional row and leave an orphaned blob/body_objects row. Messages and seq
// stay unique; the orphan is reclaimable like any failed-send pending row.
async function commitBody(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
  input: {
    summary: string;
    type: string;
    language: string;
    text: string;
    replyToId: string | null;
    clientSentAt: string | null;
    receivedAt: string;
  },
): Promise<MessageRow> {
  const objectId = randomId("obj_");
  const sealed = await sealBody(
    ENCODER.encode(input.text),
    { serviceId: deps.serviceId, projectId, messageId, objectId },
    deps.keys,
  );
  const storageKey = randomToken(16);
  await deps.blobs.put(storageKey, sealed.envelope);

  await deps.db.run(
    `INSERT INTO body_objects
       (id, project_id, storage_key, cipher_alg, key_version, nonce, compression,
        plaintext_length, cipher_length, ciphertext_digest, state, created_at)
     VALUES (?, ?, ?, 'AES-256-GCM', ?, ?, ?, ?, ?, ?, 'ready', ?)`,
    [
      objectId,
      projectId,
      storageKey,
      sealed.keyVersion,
      sealed.header.nonce_b64url,
      sealed.header.compression,
      sealed.header.plaintext_length,
      envelopeCipherLength(sealed.envelope),
      sealed.ciphertextDigest,
      deps.now().toISOString(),
    ],
  );

  await deps.db.run(
    `INSERT OR IGNORE INTO messages
       (id, project_id, seq, sender_speaker_id, summary, type, language, reply_to_id,
        client_sent_at, received_at, committed_at, body_state, body_object_id)
     VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, 'pending', ?)`,
    [
      messageId,
      projectId,
      principal.speakerId,
      input.summary,
      input.type,
      input.language,
      input.replyToId,
      input.clientSentAt,
      input.receivedAt,
      objectId,
    ],
  );
  await deps.db.run(
    `UPDATE messages SET body_object_id = ?
      WHERE id = ? AND project_id = ? AND body_state = 'pending'`,
    [objectId, messageId, projectId],
  );

  return publish(deps, projectId, messageId, objectId);
}

export async function sendMessage(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  idempotencyKey: string,
  input: SendMessageInput,
): Promise<SendMessageResult> {
  // Decision order is UNAUTHENTICATED (done by the caller) -> NOT_FOUND for a
  // non-member -> FORBIDDEN for a member lacking scope, then payload validation
  // and sender-digest verification. All of it precedes every write.
  await authorizeProject(deps, principal, projectId, "message.send");

  const key = validateIdempotencyKey(idempotencyKey);
  const summary = validateSummary(input.summary);
  const text = validateText(input.text);
  const type = validateType(input.type);
  const language = validateLanguage(input.language);
  const bodyDigest = validateBodyDigest(input.bodyDigest);
  await verifySenderDigest(text, bodyDigest);

  const replyToId = input.replyToId ?? null;
  if (replyToId !== null && (typeof replyToId !== "string" || replyToId === "")) {
    throw new AppError("VALIDATION_ERROR", "reply_to_id must be a message reference");
  }
  const clientSentAt = input.clientSentAt ?? null;
  if (clientSentAt !== null && typeof clientSentAt !== "string") {
    throw new AppError("VALIDATION_ERROR", "client_sent_at must be a string");
  }
  if (replyToId !== null) {
    // Tombstones (seq retained) are allowed; provisional rows are not visible.
    const reply = await deps.db.first<{ id: string }>(
      "SELECT id FROM messages WHERE id = ? AND project_id = ? AND seq IS NOT NULL",
      [replyToId, projectId],
    );
    if (reply === undefined) {
      throw new AppError("VALIDATION_ERROR", "reply_to_id must reference a message in this project");
    }
  }

  const payloadDigest = await canonicalPayloadDigest(deps.pepper, {
    summary,
    type,
    language,
    text,
    bodyDigest,
    replyToId,
    clientSentAt,
  });
  const receivedAt = deps.now().toISOString();
  const generatedMessageId = randomId("msg_");
  const inserted = await insertIdempotency(deps.db, {
    speakerId: principal.speakerId,
    projectId,
    key,
    payloadDigest,
    messageId: generatedMessageId,
    status: "pending",
    createdAt: receivedAt,
    updatedAt: receivedAt,
  });

  let messageId = generatedMessageId;
  let existing: MessageRow | undefined;
  if (!inserted) {
    const record = await deps.db.first<{
      payload_digest: string | null;
      message_id: string | null;
      status: string | null;
    }>(
      `SELECT payload_digest, message_id, status FROM idempotency_keys
        WHERE speaker_id = ? AND project_id = ? AND key = ?`,
      [principal.speakerId, projectId, key],
    );
    if (record === undefined || record.payload_digest === null) {
      throw new AppError("UNAVAILABLE");
    }
    if (!digestsEqual(record.payload_digest, payloadDigest)) {
      throw new AppError("CONFLICT");
    }
    if (record.message_id === null) throw new AppError("UNAVAILABLE");
    messageId = record.message_id;
    existing = await loadMessage(deps, projectId, messageId);

    if (existing !== undefined && (existing.body_state === "ready" || existing.body_state === "expired")) {
      return sendResult(existing, bodyDigest);
    }

    // Resume a prior attempt after its blob was written but before
    // finalization. Verify the stored blob against the DB-recorded digest (the
    // authority) before publishing; a missing/corrupt blob stays pending and
    // reclaimable instead of being published.
    if (existing !== undefined && existing.body_state === "pending" && existing.body_object_id !== null) {
      const object = await deps.db.first<BodyObjectRow>(
        "SELECT id, project_id, storage_key, ciphertext_digest FROM body_objects WHERE id = ? AND project_id = ?",
        [existing.body_object_id, projectId],
      );
      if (
        object === undefined ||
        object.storage_key === null ||
        typeof object.ciphertext_digest !== "string"
      ) {
        throw new AppError("NOT_FOUND");
      }
      let blob: Uint8Array | undefined;
      try {
        blob = await deps.blobs.get(object.storage_key);
      } catch {
        throw await auditIntegrityFailure(deps, principal, projectId, "message.send.resume");
      }
      if (blob === undefined) throw new AppError("NOT_FOUND");
      try {
        await openBody(
          blob,
          { serviceId: deps.serviceId, projectId, messageId, objectId: object.id },
          deps.keys,
          { expectedCiphertextDigest: object.ciphertext_digest },
        );
      } catch (error) {
        if (error instanceof IntegrityError || error instanceof EnvelopeFormatError) {
          throw await auditIntegrityFailure(deps, principal, projectId, "message.send.resume");
        }
        throw error;
      }
      const row = await publish(deps, projectId, messageId, existing.body_object_id);
      return sendResult(row, bodyDigest);
    }
  }

  const row = await commitBody(deps, principal, projectId, messageId, {
    summary,
    type,
    language,
    text,
    replyToId,
    clientSentAt,
    receivedAt,
  });
  return sendResult(row, bodyDigest);
}

function validateSeqParam(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new AppError("VALIDATION_ERROR", `${field} must be a non-negative integer`);
  }
  return value;
}

// Shortcut: SQLite LIKE is case-insensitive for ASCII only; upgrade to a
// normalized index if Unicode case-insensitive search is required.
function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

export async function listMessages(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  query: ListMessagesQuery = {},
): Promise<ListMessagesResult> {
  await authorizeProject(deps, principal, projectId, "message.read");

  if (query.afterSeq !== undefined && query.beforeSeq !== undefined) {
    throw new AppError("VALIDATION_ERROR", "after_seq and before_seq are mutually exclusive");
  }
  const afterSeq =
    query.afterSeq === undefined ? undefined : validateSeqParam(query.afterSeq, "after_seq");
  const beforeSeq =
    query.beforeSeq === undefined ? undefined : validateSeqParam(query.beforeSeq, "before_seq");

  const limit = query.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError("VALIDATION_ERROR", "limit must be 1-100");
  }

  const type = query.type === undefined ? undefined : validateType(query.type);
  const unread = query.unread;
  if (unread !== undefined && typeof unread !== "boolean") {
    throw new AppError("VALIDATION_ERROR", "unread must be a boolean");
  }

  const sender = query.sender;
  if (sender !== undefined) {
    if (typeof sender !== "string" || sender === "") {
      throw new AppError("VALIDATION_ERROR", "sender must be a speaker id");
    }
    const member = await deps.db.first<{ present: number }>(
      `SELECT 1 AS present FROM project_memberships
        WHERE project_id = ? AND speaker_id = ? AND removed_at IS NULL`,
      [projectId, sender],
    );
    if (member === undefined) {
      throw new AppError("VALIDATION_ERROR", "sender must be a project member");
    }
  }

  const q = query.q;
  if (q !== undefined) {
    if (typeof q !== "string" || Array.from(q).length > MAX_QUERY_CHARS) {
      throw new AppError("VALIDATION_ERROR", "q must be a string of at most 100 characters");
    }
  }

  const where: string[] = [
    "m.project_id = ?",
    "m.seq IS NOT NULL",
    "m.body_state IN ('ready', 'expired')",
  ];
  const params: SqlValue[] = [projectId];
  if (afterSeq !== undefined) {
    where.push("m.seq > ?");
    params.push(afterSeq);
  }
  if (beforeSeq !== undefined) {
    where.push("m.seq < ?");
    params.push(beforeSeq);
  }
  if (type !== undefined) {
    where.push("m.type = ?");
    params.push(type);
  }
  if (sender !== undefined) {
    where.push("m.sender_speaker_id = ?");
    params.push(sender);
  }
  if (unread !== undefined) {
    where.push(
      `${unread ? "NOT " : ""}EXISTS (
         SELECT 1 FROM message_receipts r
          WHERE r.message_id = m.id AND r.speaker_id = ?)`,
    );
    params.push(principal.speakerId);
  }
  if (q !== undefined && q !== "") {
    where.push("m.summary LIKE ? ESCAPE '\\'");
    params.push(`%${escapeLike(q)}%`);
  }

  // before_seq pages backwards to the rows nearest the cursor, then is reversed
  // so every response is ascending.
  const direction = beforeSeq === undefined ? "ASC" : "DESC";
  params.push(limit);
  const rows = await deps.db.all<MessageListRow>(
    `SELECT m.id, m.project_id, m.seq, m.sender_speaker_id, s.display_name,
            m.summary, m.type, m.language, m.reply_to_id, m.body_state,
            m.client_sent_at, m.received_at, m.committed_at
       FROM messages m
       LEFT JOIN speakers s ON s.id = m.sender_speaker_id
      WHERE ${where.join(" AND ")}
      ORDER BY m.seq ${direction}
      LIMIT ?`,
    params,
  );
  if (beforeSeq !== undefined) rows.reverse();

  const messages = rows.map(listRowToMetadata);
  const last = messages[messages.length - 1];
  return { messages, nextCursor: last === undefined ? null : last.seq };
}

export async function getMessage(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
): Promise<MessageMetadata> {
  await authorizeProject(deps, principal, projectId, "message.read");
  const row = await deps.db.first<MessageListRow>(
    `SELECT m.id, m.project_id, m.seq, m.sender_speaker_id, s.display_name,
            m.summary, m.type, m.language, m.reply_to_id, m.body_state,
            m.client_sent_at, m.received_at, m.committed_at
       FROM messages m
       LEFT JOIN speakers s ON s.id = m.sender_speaker_id
      WHERE m.id = ? AND m.project_id = ?`,
    [messageId, projectId],
  );
  if (row === undefined || row.seq === null) throw new AppError("NOT_FOUND");
  return listRowToMetadata(row);
}

// Audit entries are sanitized: identifiers and outcome only, never content.
async function auditIntegrityFailure(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  operation: string,
): Promise<AppError> {
  try {
    await deps.db.run(
      `INSERT INTO audit_events
         (id, actor_account_id, actor_speaker_id, project_id, operation, outcome, request_id, created_at)
       VALUES (?, ?, ?, ?, ?, 'failure', NULL, ?)`,
      [
        randomId("evt_"),
        principal.accountId,
        principal.speakerId,
        projectId,
        operation,
        deps.now().toISOString(),
      ],
    );
  } catch {
    // Fail closed on the integrity error even if the audit sink is unavailable.
  }
  return new AppError("INTEGRITY_FAILURE");
}

async function openVerifiedBody(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
  objectId: string,
  operation: string,
): Promise<OpenedBody> {
  const object = await deps.db.first<BodyObjectRow>(
    "SELECT id, project_id, storage_key, ciphertext_digest FROM body_objects WHERE id = ? AND project_id = ?",
    [objectId, projectId],
  );
  if (
    object === undefined ||
    object.storage_key === null ||
    typeof object.ciphertext_digest !== "string"
  ) {
    throw await auditIntegrityFailure(deps, principal, projectId, operation);
  }
  const envelope = await deps.blobs.get(object.storage_key);
  if (envelope === undefined) {
    throw await auditIntegrityFailure(deps, principal, projectId, operation);
  }
  try {
    return await openBody(
      envelope,
      { serviceId: deps.serviceId, projectId, messageId, objectId },
      deps.keys,
      { expectedCiphertextDigest: object.ciphertext_digest },
    );
  } catch (error) {
    if (error instanceof IntegrityError || error instanceof EnvelopeFormatError) {
      throw await auditIntegrityFailure(deps, principal, projectId, operation);
    }
    throw error;
  }
}

export async function getMessageBody(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
): Promise<MessageBody> {
  await authorizeProject(deps, principal, projectId, "message.read");
  const message = await deps.db.first<{ body_state: string; body_object_id: string | null }>(
    "SELECT body_state, body_object_id FROM messages WHERE id = ? AND project_id = ?",
    [messageId, projectId],
  );
  if (
    message === undefined ||
    message.body_state === "pending" ||
    message.body_state === "failed"
  ) {
    throw new AppError("NOT_FOUND");
  }
  if (message.body_state === "expired") throw new AppError("BODY_EXPIRED");
  if (message.body_state !== "ready" || message.body_object_id === null) {
    throw new AppError("NOT_FOUND");
  }

  const opened = await openVerifiedBody(
    deps,
    principal,
    projectId,
    messageId,
    message.body_object_id,
    "message.body.read",
  );
  return {
    messageId,
    text: DECODER.decode(opened.plaintext),
    compression: opened.header.compression,
    digest: `sha256:${await sha256Hex(opened.plaintext)}`,
  };
}

export async function markRead(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  messageId: string,
): Promise<ReadReceiptResult> {
  const access = await authorizeProject(deps, principal, projectId, "message.read");
  requireScope(access.rights, "receipt.write");

  const message = await deps.db.first<{ body_state: string; body_object_id: string | null }>(
    "SELECT body_state, body_object_id FROM messages WHERE id = ? AND project_id = ?",
    [messageId, projectId],
  );
  if (
    message === undefined ||
    message.body_state === "pending" ||
    message.body_state === "failed"
  ) {
    throw new AppError("NOT_FOUND");
  }
  if (message.body_state === "expired") throw new AppError("BODY_EXPIRED");
  if (message.body_state !== "ready" || message.body_object_id === null) {
    throw new AppError("NOT_FOUND");
  }

  // No receipt is written unless the body verifies.
  await openVerifiedBody(
    deps,
    principal,
    projectId,
    messageId,
    message.body_object_id,
    "message.receipt.write",
  );

  await deps.db.run(
    `INSERT OR IGNORE INTO message_receipts (message_id, speaker_id, read_at)
     SELECT ?1, ?2, ?3
      WHERE EXISTS (SELECT 1 FROM messages WHERE id = ?1 AND project_id = ?4)`,
    [messageId, principal.speakerId, deps.now().toISOString(), projectId],
  );
  const receipt = await deps.db.first<{ read_at: string }>(
    `SELECT r.read_at FROM message_receipts r
       JOIN messages m ON m.id = r.message_id
      WHERE r.message_id = ? AND r.speaker_id = ? AND m.project_id = ?`,
    [messageId, principal.speakerId, projectId],
  );
  if (receipt === undefined) throw new AppError("UNAVAILABLE");
  return { messageId, speakerId: principal.speakerId, readAt: receipt.read_at };
}
