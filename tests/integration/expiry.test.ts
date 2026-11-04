import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { AppError, type ErrorCode } from "../../src/domain/errors.ts";
import type { Principal } from "../../src/service/auth.ts";
import {
  deleteExpiredBodyBlob,
  expiryAuditId,
  expireDueBodies,
  expireMessageBody,
  type ExpiryDeps,
} from "../../src/service/expiry.ts";
import {
  getMessage,
  getMessageBody,
  listMessages,
  markRead,
  sendMessage,
  type SendMessageInput,
} from "../../src/service/messages.ts";
import type { BlobStore } from "../../src/storage/blobs.ts";
import type { SqlDatabase, SqlValue } from "../../src/storage/db.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.ok(error instanceof AppError, `expected AppError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  await assert.rejects(promise, hasCode(code));
}

interface Actor {
  accountId: string;
  speakerId: string;
  token: string;
  principal: Principal;
}

async function addActor(fx: ServiceFixture, name: string): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token } = await fx.addCredential({ id: `cred_${name}`, speakerId: `spk_${name}` });
  return {
    accountId: `acct_${name}`,
    speakerId: `spk_${name}`,
    token,
    principal: await fx.authenticate(token),
  };
}

async function addProject(
  fx: ServiceFixture,
  projectId: string,
  owner: Actor,
  members: readonly Actor[],
): Promise<void> {
  await fx.addProject(projectId, owner.accountId);
  for (const member of members) {
    await fx.addMembership(projectId, member.speakerId);
  }
}

async function send(
  fx: ServiceFixture,
  principal: Principal,
  projectId: string,
  key: string,
  text: string,
  overrides: Partial<SendMessageInput> = {},
) {
  const input: SendMessageInput = {
    summary: text,
    type: "request",
    language: "en",
    text,
    bodyDigest: await digestOf(text),
    ...overrides,
  };
  return sendMessage(fx.deps, principal, projectId, key, input);
}

async function withFixture(t: {
  after(fn: () => void): void;
}): Promise<ServiceFixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return fx;
}

function expiryDeps(fx: ServiceFixture, blobs: BlobStore = fx.blobs): ExpiryDeps {
  return { db: fx.deps.db, blobs, now: fx.deps.now };
}

async function blobKeyFor(fx: ServiceFixture, messageId: string): Promise<string> {
  const row = await fx.db.first<{ storage_key: string | null }>(
    `SELECT b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [messageId],
  );
  assert.ok(row?.storage_key);
  return row.storage_key;
}

test("body_expires_at validation rejects past, over-366-day and malformed values before any write", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const base = fx.deps.now();

  const invalid = [
    new Date(base.getTime() - 1000).toISOString(),
    base.toISOString(),
    new Date(base.getTime() + 367 * DAY_MS).toISOString(),
    "not a timestamp",
    "2026-11-03",
    123,
    // Strict UTC subset: offsets, hour 24, leap second, 4-digit fractions,
    // missing seconds, lowercase z, and impossible calendar dates are rejected.
    "2026-11-04T12:00:00+01:00",
    "2026-11-04T12:00:00-05:00",
    "2026-11-04T24:00:00Z",
    "2026-11-04T12:00:60Z",
    "2026-11-04T12:00:00.1234Z",
    "2026-11-04T12:00Z",
    "2026-11-04t12:00:00z",
    "2026-11-31T12:00:00Z",
    "2026-12-00T12:00:00Z",
    "2026-13-01T12:00:00Z",
    "2027-02-30T12:00:00Z",
    "2027-02-29T12:00:00Z",
  ];
  for (const [index, value] of invalid.entries()) {
    await expectCode(
      send(fx, alice.principal, "proj_1", `bad-${index}`, "rejected", {
        bodyExpiresAt: value as unknown as string,
      }),
      "VALIDATION_ERROR",
    );
  }

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);

  // Exactly 366 days ahead is allowed and normalized to UTC.
  const boundary = new Date(base.getTime() + 366 * DAY_MS).toISOString();
  const accepted = await send(fx, alice.principal, "proj_1", "boundary", "accepted", {
    bodyExpiresAt: boundary,
  });
  const metadata = await getMessage(fx.deps, alice.principal, "proj_1", accepted.messageId);
  assert.equal(metadata.bodyExpiresAt, boundary);

  // 1-3 fractional digits are accepted and preserved as milliseconds.
  const withMillis = new Date(base.getTime() + HOUR_MS)
    .toISOString()
    .replace(".000Z", ".123Z");
  const precise = await send(fx, alice.principal, "proj_1", "millis", "precise", {
    bodyExpiresAt: withMillis,
  });
  const preciseMetadata = await getMessage(
    fx.deps,
    alice.principal,
    "proj_1",
    precise.messageId,
  );
  assert.equal(preciseMetadata.bodyExpiresAt, withMillis);
});

test("expired bodies keep sequence and metadata while fetch and receipt fail", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "tombstone body", {
    summary: "tombstone summary",
    bodyExpiresAt: expiry,
  });
  const before = await getMessage(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.equal(before.bodyState, "ready");
  assert.equal(before.seq, 1);
  assert.equal(before.bodyExpiresAt, expiry);

  await expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);

  const listed = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(listed.messages.length, 1);
  assert.equal(listed.messages[0]?.seq, 1);
  assert.equal(listed.messages[0]?.bodyState, "expired");
  assert.equal(listed.messages[0]?.bodyExpiresAt, expiry);
  assert.equal(listed.messages[0]?.summary, "tombstone summary");
  assert.equal(listed.messages[0]?.sender.speakerId, "spk_alice");

  const metadata = await getMessage(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.equal(metadata.seq, 1);
  assert.equal(metadata.bodyState, "expired");
  assert.equal(metadata.bodyExpiresAt, expiry);

  await expectCode(
    getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
    "BODY_EXPIRED",
  );
  await expectCode(
    markRead(fx.deps, alice.principal, "proj_1", sent.messageId),
    "BODY_EXPIRED",
  );
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("expiry retains existing receipts but blocks new ones", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "receipt body", {
    bodyExpiresAt: expiry,
  });

  const receipt = await markRead(fx.deps, bob.principal, "proj_1", sent.messageId);
  assert.equal(receipt.speakerId, "spk_bob");

  await expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);

  await expectCode(
    markRead(fx.deps, bob.principal, "proj_1", sent.messageId),
    "BODY_EXPIRED",
  );
  const receipts = await fx.db.all<{ speaker_id: string }>(
    "SELECT speaker_id FROM message_receipts WHERE message_id = ?",
    [sent.messageId],
  );
  assert.deepEqual(receipts, [{ speaker_id: "spk_bob" }]);
});

test("idempotent send replay returns the committed result after the body expires", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const base = fx.deps.now();
  const expiry = new Date(base.getTime() + HOUR_MS).toISOString();

  const first = await send(fx, alice.principal, "proj_1", "stable-key", "replayed", {
    bodyExpiresAt: expiry,
  });
  await expireMessageBody(fx.deps, alice.principal, "proj_1", first.messageId);
  fx.setNow(new Date(base.getTime() + 2 * HOUR_MS));

  // Same key and same payload still returns the original committed result.
  const replay = await send(fx, alice.principal, "proj_1", "stable-key", "replayed", {
    bodyExpiresAt: expiry,
  });
  assert.equal(replay.messageId, first.messageId);
  assert.equal(replay.seq, first.seq);
  assert.equal(replay.committedAt, first.committedAt);
  assert.equal(replay.digest, first.digest);
  assert.equal(replay.bodyState, "expired");

  // A changed expiry under the same key is still a conflict.
  await expectCode(
    send(fx, alice.principal, "proj_1", "stable-key", "replayed", {
      bodyExpiresAt: new Date(base.getTime() + 2 * HOUR_MS).toISOString(),
    }),
    "CONFLICT",
  );
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
});

test("expire endpoint orders membership, scope, state and success correctly", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  const carol = await addActor(fx, "carol");
  await addProject(fx, "proj_1", alice, [alice]);
  await fx.addMembership("proj_1", carol.speakerId, ["project.read", "message.read"]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "expire me", {
    bodyExpiresAt: expiry,
  });
  const storageKey = await blobKeyFor(fx, sent.messageId);

  // Non-member -> NOT_FOUND; member without project.edit -> FORBIDDEN.
  await expectCode(
    expireMessageBody(fx.deps, bob.principal, "proj_1", sent.messageId),
    "NOT_FOUND",
  );
  await expectCode(
    expireMessageBody(fx.deps, carol.principal, "proj_1", sent.messageId),
    "FORBIDDEN",
  );
  // Unknown and provisional messages -> NOT_FOUND.
  await expectCode(
    expireMessageBody(fx.deps, alice.principal, "proj_1", "msg_unknown"),
    "NOT_FOUND",
  );

  const pending = await send(fx, alice.principal, "proj_1", "key-2", "still pending");
  await fx.db.run(
    "UPDATE messages SET seq = NULL, committed_at = NULL, body_state = 'pending' WHERE id = ?",
    [pending.messageId],
  );
  await expectCode(
    expireMessageBody(fx.deps, alice.principal, "proj_1", pending.messageId),
    "NOT_FOUND",
  );

  const failed = await send(fx, alice.principal, "proj_1", "key-3", "failed body");
  await fx.db.run(
    "UPDATE messages SET seq = NULL, committed_at = NULL, body_state = 'failed' WHERE id = ?",
    [failed.messageId],
  );
  await expectCode(
    expireMessageBody(fx.deps, alice.principal, "proj_1", failed.messageId),
    "NOT_FOUND",
  );

  // Owner success transitions atomically and deletes the ciphertext.
  const result = await expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.deepEqual(result, { messageId: sent.messageId, bodyState: "expired" });
  assert.equal(await fx.blobs.get(storageKey), undefined);
  const object = await fx.db.first<{ state: string; storage_key: string | null }>(
    `SELECT b.state, b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.deepEqual(object, { state: "deleted", storage_key: null });

  // Repeating is idempotent and does not add a second audit row.
  const again = await expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.deepEqual(again, result);

  const audits = await fx.db.all<{
    operation: string;
    outcome: string;
    actor_speaker_id: string;
    actor_account_id: string;
    project_id: string;
  }>(
    `SELECT operation, outcome, actor_speaker_id, actor_account_id, project_id
       FROM audit_events WHERE operation = 'message.expire'`,
  );
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], {
    operation: "message.expire",
    outcome: "success",
    actor_speaker_id: "spk_alice",
    actor_account_id: "acct_alice",
    project_id: "proj_1",
  });
  const serialized = JSON.stringify(audits);
  assert.equal(serialized.includes("expire me"), false);
});

test("concurrent duplicate expiry transitions once and both calls succeed", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "race", {
    bodyExpiresAt: expiry,
  });

  const results = await Promise.all([
    expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
    expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
  ]);
  assert.deepEqual(results, [
    { messageId: sent.messageId, bodyState: "expired" },
    { messageId: sent.messageId, bodyState: "expired" },
  ]);

  const row = await fx.db.first<{ body_state: string; seq: number }>(
    "SELECT body_state, seq FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.deepEqual(row, { body_state: "expired", seq: 1 });
  const audits = await fx.db.all(
    "SELECT id FROM audit_events WHERE operation = 'message.expire'",
  );
  assert.equal(audits.length, 1);
});

test("cleanup worker expires due rows, deletes blobs and leaves future or unexpiring rows ready", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const base = fx.deps.now();

  const dueOne = await send(fx, alice.principal, "proj_1", "due-1", "due one", {
    bodyExpiresAt: new Date(base.getTime() + HOUR_MS).toISOString(),
  });
  const dueTwo = await send(fx, alice.principal, "proj_1", "due-2", "due two", {
    bodyExpiresAt: new Date(base.getTime() + 2 * HOUR_MS).toISOString(),
  });
  const future = await send(fx, alice.principal, "proj_1", "future", "future body", {
    bodyExpiresAt: new Date(base.getTime() + 48 * HOUR_MS).toISOString(),
  });
  const noExpiry = await send(fx, alice.principal, "proj_1", "no-expiry", "no expiry");
  const dueKeys = [
    await blobKeyFor(fx, dueOne.messageId),
    await blobKeyFor(fx, dueTwo.messageId),
  ];
  const futureKey = await blobKeyFor(fx, future.messageId);
  const noExpiryKey = await blobKeyFor(fx, noExpiry.messageId);

  // A non-expired message is never touched by the blob helper.
  assert.equal(
    await deleteExpiredBodyBlob(fx.deps, "proj_1", future.messageId),
    false,
  );
  assert.notEqual(await fx.blobs.get(futureKey), undefined);

  fx.setNow(new Date(base.getTime() + 3 * HOUR_MS));
  const summary = await expireDueBodies(expiryDeps(fx), { limit: 500 });
  // examined counts distinct messages: the two phase-1 rows are also the two
  // phase-2 orphans and must not be double-counted.
  assert.deepEqual(summary, {
    examined: 2,
    expired: 2,
    blobsDeleted: 2,
    failures: 0,
  });

  const audits = await fx.db.all<{
    id: string;
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    operation: string;
  }>(
    `SELECT id, actor_account_id, actor_speaker_id, operation
       FROM audit_events WHERE operation = 'message.expire' ORDER BY id`,
  );
  assert.equal(audits.length, 2);
  for (const audit of audits) {
    assert.equal(audit.actor_account_id, null);
    assert.equal(audit.actor_speaker_id, null);
  }
  assert.deepEqual(
    audits.map((audit) => audit.id).sort(),
    [
      `evt_expire_${dueOne.messageId}`,
      `evt_expire_${dueTwo.messageId}`,
    ].sort(),
  );

  for (const message of [dueOne, dueTwo]) {
    const row = await fx.db.first<{ body_state: string; seq: number }>(
      "SELECT body_state, seq FROM messages WHERE id = ?",
      [message.messageId],
    );
    assert.equal(row?.body_state, "expired");
    assert.ok(row?.seq !== null);
  }
  for (const message of [future, noExpiry]) {
    const row = await fx.db.first<{ body_state: string }>(
      "SELECT body_state FROM messages WHERE id = ?",
      [message.messageId],
    );
    assert.equal(row?.body_state, "ready");
  }
  for (const key of dueKeys) assert.equal(await fx.blobs.get(key), undefined);
  assert.notEqual(await fx.blobs.get(futureKey), undefined);
  assert.notEqual(await fx.blobs.get(noExpiryKey), undefined);

  // Safe to repeat: nothing remains to do.
  const second = await expireDueBodies(expiryDeps(fx), { limit: 500 });
  assert.deepEqual(second, {
    examined: 0,
    expired: 0,
    blobsDeleted: 0,
    failures: 0,
  });
});

test("cleanup worker retries an expired orphan after a blob delete failure", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "orphan body", {
    bodyExpiresAt: expiry,
  });
  const storageKey = await blobKeyFor(fx, sent.messageId);
  fx.setNow(new Date(fx.deps.now().getTime() + 2 * HOUR_MS));

  let failuresLeft = 1;
  const flaky: BlobStore = {
    put: (key, bytes) => fx.blobs.put(key, bytes),
    get: (key) => fx.blobs.get(key),
    delete: async (key) => {
      if (failuresLeft > 0) {
        failuresLeft -= 1;
        throw new Error("injected blob delete failure");
      }
      await fx.blobs.delete(key);
    },
  };

  // The transition is durable before the failed delete; the message is expired
  // while the blob row still records the ciphertext.
  const first = await expireDueBodies(expiryDeps(fx, flaky), {});
  assert.equal(first.examined, 1);
  assert.equal(first.expired, 1);
  assert.equal(first.blobsDeleted, 0);
  assert.equal(first.failures, 1);
  const afterFailure = await fx.db.first<{ body_state: string; state: string; storage_key: string }>(
    `SELECT m.body_state, b.state, b.storage_key FROM messages m
       JOIN body_objects b ON b.id = m.body_object_id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.equal(afterFailure?.body_state, "expired");
  assert.notEqual(afterFailure?.state, "deleted");
  assert.equal(afterFailure?.storage_key, storageKey);
  assert.notEqual(await fx.blobs.get(storageKey), undefined);

  const second = await expireDueBodies(expiryDeps(fx, flaky), {});
  assert.equal(second.examined, 1);
  assert.equal(second.expired, 0);
  assert.equal(second.blobsDeleted, 1);
  assert.equal(second.failures, 0);
  assert.equal(await fx.blobs.get(storageKey), undefined);
  const afterRetry = await fx.db.first<{ state: string; storage_key: string | null }>(
    `SELECT b.state, b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.deepEqual(afterRetry, { state: "deleted", storage_key: null });
});

test("cleanup worker bounds its limit", async (t) => {
  const fx = await withFixture(t);
  for (const limit of [0, 5001, 1.5]) {
    await expectCode(
      expireDueBodies(expiryDeps(fx), { limit }),
      "VALIDATION_ERROR",
    );
  }
});

function withAuditFailure(
  db: SqlDatabase,
  state: { fail: boolean },
): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]) => db.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]) => db.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]) => {
      if (state.fail && sql.includes("INSERT OR IGNORE INTO audit_events")) {
        return Promise.reject(new Error("injected audit insert failure"));
      }
      return db.run(sql, params);
    },
  };
}

// Fails the first `remaining.count` audit inserts, then succeeds.
function withAuditFailureCount(
  db: SqlDatabase,
  remaining: { count: number },
): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]) => db.all<T>(sql, params),
    first: <T>(sql: string, params?: readonly SqlValue[]) => db.first<T>(sql, params),
    run: (sql: string, params?: readonly SqlValue[]) => {
      if (remaining.count > 0 && sql.includes("INSERT OR IGNORE INTO audit_events")) {
        remaining.count -= 1;
        return Promise.reject(new Error("injected audit insert failure"));
      }
      return db.run(sql, params);
    },
  };
}

function withBodyObjectRace(
  db: SqlDatabase,
  onObjectLookup: () => Promise<void>,
  state: { fired: boolean },
): SqlDatabase {
  return {
    exec: (sql) => db.exec(sql),
    all: <T>(sql: string, params?: readonly SqlValue[]) => db.all<T>(sql, params),
    first: async <T>(sql: string, params?: readonly SqlValue[]) => {
      if (!state.fired && sql.includes("FROM body_objects")) {
        state.fired = true;
        await onObjectLookup();
      }
      return db.first<T>(sql, params);
    },
    run: (sql: string, params?: readonly SqlValue[]) => db.run(sql, params),
  };
}

test("a removed membership cannot expire messages", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "removed caller");

  // The principal is authenticated while the membership is active, then the
  // membership is revoked before the request is authorized.
  const principal = await fx.authenticate(alice.token);
  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    [fx.deps.now().toISOString(), "proj_1", alice.speakerId],
  );

  await expectCode(
    expireMessageBody(fx.deps, principal, "proj_1", sent.messageId),
    "NOT_FOUND",
  );
  const row = await fx.db.first<{ body_state: string }>(
    "SELECT body_state FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.equal(row?.body_state, "ready");
});

test("a blob-delete failure still returns endpoint success", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "delete failure", {
    bodyExpiresAt: expiry,
  });
  const storageKey = await blobKeyFor(fx, sent.messageId);

  const failing: BlobStore = {
    put: (key, bytes) => fx.blobs.put(key, bytes),
    get: (key) => fx.blobs.get(key),
    delete: () => Promise.reject(new Error("injected blob delete failure")),
  };

  const result = await expireMessageBody(
    { ...fx.deps, blobs: failing },
    alice.principal,
    "proj_1",
    sent.messageId,
  );
  assert.deepEqual(result, { messageId: sent.messageId, bodyState: "expired" });
  const object = await fx.db.first<{ state: string; storage_key: string | null }>(
    `SELECT b.state, b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.notEqual(object?.state, "deleted");
  assert.equal(object?.storage_key, storageKey);
  assert.notEqual(await fx.blobs.get(storageKey), undefined);
});

test("endpoint audit failure returns success and the worker repairs the audit row", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "audit repair");

  const state = { fail: true };
  const failingDb = withAuditFailure(fx.deps.db, state);
  const result = await expireMessageBody(
    { ...fx.deps, db: failingDb },
    alice.principal,
    "proj_1",
    sent.messageId,
  );
  assert.deepEqual(result, { messageId: sent.messageId, bodyState: "expired" });

  const missing = await fx.db.first<{ id: string }>(
    "SELECT id FROM audit_events WHERE id = ?",
    [expiryAuditId(sent.messageId)],
  );
  assert.equal(missing, undefined);

  state.fail = false;
  const summary = await expireDueBodies(expiryDeps(fx), {});
  assert.equal(summary.failures, 0);
  const audit = await fx.db.first<{
    id: string;
    actor_account_id: string | null;
    actor_speaker_id: string | null;
    operation: string;
    outcome: string;
    project_id: string;
  }>(
    `SELECT id, actor_account_id, actor_speaker_id, operation, outcome, project_id
       FROM audit_events WHERE id = ?`,
    [expiryAuditId(sent.messageId)],
  );
  assert.deepEqual(audit, {
    id: expiryAuditId(sent.messageId),
    actor_account_id: null,
    actor_speaker_id: null,
    operation: "message.expire",
    outcome: "success",
    project_id: "proj_1",
  });
});

test("a phase-1 audit failure repaired in phase 3 is not double-counted", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "double count", {
    bodyExpiresAt: expiry,
  });
  fx.setNow(new Date(fx.deps.now().getTime() + 2 * HOUR_MS));

  // Phase 1 transitions the row then the audit insert fails; phase 3 repairs
  // the same deterministic row in the same run.
  const remaining = { count: 1 };
  const summary = await expireDueBodies(
    { ...expiryDeps(fx), db: withAuditFailureCount(fx.deps.db, remaining) },
    {},
  );
  assert.equal(summary.expired, 1);
  assert.equal(summary.failures, 0);
  const audit = await fx.db.first<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
  }>(
    "SELECT actor_account_id, actor_speaker_id FROM audit_events WHERE id = ?",
    [expiryAuditId(sent.messageId)],
  );
  assert.deepEqual(audit, { actor_account_id: null, actor_speaker_id: null });
});

test("the already-expired endpoint path retries a missing audit row", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "audit retry");

  const state = { fail: true };
  await expireMessageBody(
    { ...fx.deps, db: withAuditFailure(fx.deps.db, state) },
    alice.principal,
    "proj_1",
    sent.messageId,
  );
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE id = ?", [expiryAuditId(sent.messageId)]))
      .length,
    0,
  );

  const again = await expireMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.deepEqual(again, { messageId: sent.messageId, bodyState: "expired" });
  // The retry did not perform the transition, so it records a system actor.
  const audit = await fx.db.first<{
    actor_account_id: string | null;
    actor_speaker_id: string | null;
  }>(
    "SELECT actor_account_id, actor_speaker_id FROM audit_events WHERE id = ?",
    [expiryAuditId(sent.messageId)],
  );
  assert.deepEqual(audit, {
    actor_account_id: null,
    actor_speaker_id: null,
  });
});

test("mark_read racing a concurrent expiry returns BODY_EXPIRED with no receipt", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "receipt race");

  const state = { fired: false };
  const racing: BlobStore = {
    put: (key, bytes) => fx.blobs.put(key, bytes),
    get: async (key) => {
      if (!state.fired) {
        state.fired = true;
        // Simulate expiry after markRead's initial state check but before its
        // receipt INSERT.
        await fx.db.run("UPDATE messages SET body_state = 'expired' WHERE id = ?", [
          sent.messageId,
        ]);
      }
      return fx.blobs.get(key);
    },
    delete: (key) => fx.blobs.delete(key),
  };

  await expectCode(
    markRead({ ...fx.deps, blobs: racing }, alice.principal, "proj_1", sent.messageId),
    "BODY_EXPIRED",
  );
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation LIKE 'message.receipt%'")).length,
    0,
  );
});

test("body fetch racing expiry cleanup returns BODY_EXPIRED without an integrity audit", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "fetch race");
  const object = await fx.db.first<{ id: string }>(
    "SELECT body_object_id AS id FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.ok(object !== undefined);

  const state = { fired: false };
  const racingDb = withBodyObjectRace(
    fx.deps.db,
    async () => {
      await fx.db.run("UPDATE messages SET body_state = 'expired' WHERE id = ?", [
        sent.messageId,
      ]);
      await fx.db.run(
        "UPDATE body_objects SET state = 'deleted', storage_key = NULL WHERE id = ?",
        [object.id],
      );
    },
    state,
  );

  await expectCode(
    getMessageBody(
      { ...fx.deps, db: racingDb },
      alice.principal,
      "proj_1",
      sent.messageId,
    ),
    "BODY_EXPIRED",
  );
  assert.equal(
    (await fx.db.all("SELECT id FROM audit_events WHERE operation = 'message.body.read'")).length,
    0,
  );
});

test("due-expiry query uses the body_state/expires index", async (t) => {
  const fx = await withFixture(t);
  const plan = await fx.db.all<{ detail: string }>(
    `EXPLAIN QUERY PLAN
     SELECT id FROM messages
      WHERE body_state = 'ready'
        AND body_expires_at IS NOT NULL
        AND body_expires_at <= ?
      ORDER BY project_id ASC, seq ASC
      LIMIT ?`,
    ["2026-11-04T12:00:00.000Z", 500],
  );
  assert.ok(
    plan.some((row) => row.detail.includes("idx_messages_body_state_expires")),
    JSON.stringify(plan),
  );
});

test("expire HTTP route exposes the endpoint and authorization ordering", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const app = createApp(fx.deps);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  const carol = await addActor(fx, "carol");
  await addProject(fx, "proj_1", alice, [alice]);
  await fx.addMembership("proj_1", carol.speakerId, ["project.read", "message.read"]);

  const call = (
    path: string,
    options: {
      method?: string;
      token?: string;
      headers?: Record<string, string>;
      body?: unknown;
    } = {},
  ): Promise<Response> => {
    const headers = new Headers(options.headers ?? {});
    if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
    let body: string | undefined;
    if (options.body !== undefined) {
      body = JSON.stringify(options.body);
      headers.set("content-type", "application/json");
    }
    return app(
      new Request(`http://localhost${path}`, {
        method: options.method ?? "GET",
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );
  };

  const expiry = new Date(fx.deps.now().getTime() + HOUR_MS).toISOString();
  const text = "http expiry";
  const sent = await call("/api/v1/projects/proj_1/messages", {
    method: "POST",
    token: alice.token,
    headers: { "idempotency-key": "http-expire" },
    body: {
      summary: text,
      type: "request",
      language: "en",
      text,
      body_digest: digestOf(text),
      body_expires_at: expiry,
    },
  });
  assert.equal(sent.status, 201);
  const sentBody = (await sent.json()) as { message_id: string };
  const path = `/api/v1/projects/proj_1/messages/${sentBody.message_id}/expire`;

  const unauthenticated = await call(path, { method: "POST" });
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.headers.get("www-authenticate"), "Bearer");
  assert.equal(
    ((await unauthenticated.json()) as { error: { code: string } }).error.code,
    "UNAUTHENTICATED",
  );

  const nonMember = await call(path, { method: "POST", token: bob.token });
  assert.equal(nonMember.status, 404);
  assert.equal(((await nonMember.json()) as { error: { code: string } }).error.code, "NOT_FOUND");

  const noScope = await call(path, { method: "POST", token: carol.token });
  assert.equal(noScope.status, 403);
  assert.equal(((await noScope.json()) as { error: { code: string } }).error.code, "FORBIDDEN");

  const wrongMethod = await call(path, { token: alice.token });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.get("allow"), "POST");

  const expired = await call(path, { method: "POST", token: alice.token });
  assert.equal(expired.status, 200);
  assert.deepEqual(await expired.json(), {
    message_id: sentBody.message_id,
    body_state: "expired",
  });

  const body = await call(`/api/v1/projects/proj_1/messages/${sentBody.message_id}/body`, {
    token: alice.token,
  });
  assert.equal(body.status, 410);
  assert.equal(((await body.json()) as { error: { code: string } }).error.code, "BODY_EXPIRED");

  const metadata = await call(`/api/v1/projects/proj_1/messages/${sentBody.message_id}`, {
    token: alice.token,
  });
  const metadataBody = (await metadata.json()) as {
    seq: number;
    body_state: string;
    body_expires_at: string;
  };
  assert.equal(metadataBody.seq, 1);
  assert.equal(metadataBody.body_state, "expired");
  assert.equal(metadataBody.body_expires_at, expiry);
});
