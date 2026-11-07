import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { sealBody } from "../../src/crypto/envelope.ts";
import { AppError, type ErrorCode } from "../../src/domain/errors.ts";
import { generateSpeakerToken } from "../../src/auth/credentials.ts";
import { authenticateBearer, type Principal } from "../../src/service/auth.ts";
import {
  getMessage,
  getMessageBody,
  listMessages,
  markRead,
  sendMessage,
  type SendMessageInput,
} from "../../src/service/messages.ts";
import {
  ALL_SCOPES,
  createServiceFixture,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

async function digestOf(text: string): Promise<string> {
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

async function withFixture(
  t: { after(fn: () => void): void },
): Promise<ServiceFixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return fx;
}

test("send -> list -> body -> read receipt roundtrip", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const text = "hello corkboard";
  const sent = await send(fx, alice.principal, "proj_1", "key-1", text);
  assert.equal(sent.seq, 1);
  assert.equal(sent.projectId, "proj_1");
  assert.equal(sent.bodyState, "ready");
  assert.equal(sent.digest, await digestOf(text));
  assert.match(sent.committedAt, /^\d{4}-\d{2}-\d{2}T/);

  const list = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(list.messages.length, 1);
  const listed = list.messages[0];
  assert.equal(listed?.messageId, sent.messageId);
  assert.deepEqual(listed?.sender, { speakerId: "spk_alice", displayName: "spk_alice" });
  assert.equal(listed?.bodyState, "ready");
  assert.equal(list.nextCursor, 1);

  // Listing is metadata-only and never marks anything read.
  const unreadBefore = await listMessages(fx.deps, alice.principal, "proj_1", { unread: true });
  assert.equal(unreadBefore.messages.length, 1);

  const body = await getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.deepEqual(body, {
    messageId: sent.messageId,
    text,
    compression: "none",
    digest: await digestOf(text),
  });

  const receipt = await markRead(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.equal(receipt.messageId, sent.messageId);
  assert.equal(receipt.speakerId, "spk_alice");
  assert.match(receipt.readAt, /^\d{4}-\d{2}-\d{2}T/);

  // Idempotent: the original server timestamp is returned again.
  const again = await markRead(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.equal(again.readAt, receipt.readAt);

  const unreadAfter = await listMessages(fx.deps, alice.principal, "proj_1", { unread: true });
  assert.equal(unreadAfter.messages.length, 0);
});

test("client_sent_at is bounded to a valid timestamp and retained as metadata", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const valid = "2026-11-04T12:00:00.000Z";
  const sent = await send(fx, alice.principal, "proj_1", "valid", "body", {
    clientSentAt: valid,
  });
  const stored = await fx.db.first<{ client_sent_at: string | null }>(
    "SELECT client_sent_at FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.equal(stored?.client_sent_at, valid);
  const listed = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(listed.messages[0]?.clientSentAt, valid);

  // Offset timestamps are RFC 3339 too.
  const offset = await send(fx, alice.principal, "proj_1", "offset", "body", {
    clientSentAt: "2026-11-04T12:00:00+02:00",
  });
  assert.equal(
    (
      await fx.db.first<{ client_sent_at: string | null }>(
        "SELECT client_sent_at FROM messages WHERE id = ?",
        [offset.messageId],
      )
    )?.client_sent_at,
    "2026-11-04T12:00:00+02:00",
  );

  const before = (
    await fx.db.all<{ id: string }>("SELECT id FROM messages")
  ).length;
  for (const [key, bad] of [
    ["oversized", `${valid}${" ".repeat(50)}`],
    ["not-a-timestamp", "yesterday"],
    ["date-only", "2026-11-04"],
    ["impossible-date", "2026-02-30T00:00:00Z"],
    ["bad-offset", "2026-11-04T12:00:00+24:00"],
    ["non-string", 123],
  ] as const) {
    await expectCode(
      send(fx, alice.principal, "proj_1", key, "body", {
        clientSentAt: bad as unknown as string,
      }),
      "VALIDATION_ERROR",
    );
  }
  assert.equal(
    (await fx.db.all<{ id: string }>("SELECT id FROM messages")).length,
    before,
  );
});

test("cross-project and non-member access returns NOT_FOUND", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  const carol = await addActor(fx, "carol");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  await addProject(fx, "proj_2", bob, [bob, carol]);

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "private to project one");

  // Alice is not a member of project two.
  await expectCode(listMessages(fx.deps, alice.principal, "proj_2"), "NOT_FOUND");
  await expectCode(getMessage(fx.deps, alice.principal, "proj_2", sent.messageId), "NOT_FOUND");
  await expectCode(getMessageBody(fx.deps, alice.principal, "proj_2", sent.messageId), "NOT_FOUND");
  await expectCode(markRead(fx.deps, alice.principal, "proj_2", sent.messageId), "NOT_FOUND");

  // Bob is a member of both projects but the message id belongs to project one.
  await expectCode(getMessage(fx.deps, bob.principal, "proj_2", sent.messageId), "NOT_FOUND");
  await expectCode(getMessageBody(fx.deps, bob.principal, "proj_2", sent.messageId), "NOT_FOUND");
  await expectCode(markRead(fx.deps, bob.principal, "proj_2", sent.messageId), "NOT_FOUND");

  // Carol is not a member of project one at all.
  await expectCode(listMessages(fx.deps, carol.principal, "proj_1"), "NOT_FOUND");
  await expectCode(send(fx, carol.principal, "proj_1", "key-carol", "nope"), "NOT_FOUND");

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
});

test("insufficient scope is FORBIDDEN before any write", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const dave = await addActor(fx, "dave");
  await addProject(fx, "proj_1", alice, [alice]);
  await fx.addMembership("proj_1", dave.speakerId, ["message.read"]);

  await expectCode(
    send(fx, dave.principal, "proj_1", "key-dave", "should not land"),
    "FORBIDDEN",
  );
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);

  // Membership allows sending but the credential scope does not.
  const erin = await addActor(fx, "erin");
  await fx.addMembership("proj_1", erin.speakerId);
  const { token } = await fx.addCredential({
    id: "cred_erin_readonly",
    speakerId: erin.speakerId,
    scopes: ["project.read", "message.read"],
  });
  const readOnly = await fx.authenticate(token);
  await expectCode(
    send(fx, readOnly, "proj_1", "key-erin", "still should not land"),
    "FORBIDDEN",
  );
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
});

test("client-supplied sender and server-owned fields are ignored", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const text = "trust the server";
  const malicious = {
    summary: "spoof attempt",
    type: "request",
    language: "en",
    text,
    bodyDigest: await digestOf(text),
    senderId: "spk_evil",
    sender_id: "spk_evil",
    senderSpeakerId: "spk_evil",
    seq: 999,
    receivedAt: "1999-01-01T00:00:00.000Z",
    committedAt: "1999-01-01T00:00:00.000Z",
    bodyState: "expired",
    compression: "gzip",
  } as unknown as SendMessageInput;

  const sent = await sendMessage(fx.deps, alice.principal, "proj_1", "key-spoof", malicious);
  assert.equal(sent.seq, 1);

  const row = await fx.db.first<{
    sender_speaker_id: string;
    seq: number;
    received_at: string;
    committed_at: string;
    body_state: string;
    compression: string;
  }>(
    `SELECT m.sender_speaker_id, m.seq, m.received_at, m.committed_at, m.body_state, b.compression
       FROM messages m
       JOIN body_objects b ON b.id = m.body_object_id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.equal(row?.sender_speaker_id, "spk_alice");
  assert.equal(row?.seq, 1);
  assert.equal(row?.body_state, "ready");
  assert.notEqual(row?.received_at, "1999-01-01T00:00:00.000Z");
  assert.notEqual(row?.committed_at, "1999-01-01T00:00:00.000Z");
  assert.equal(row?.compression, "none");
});

test("authorization precedes payload validation and sender-digest verification", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const carol = await addActor(fx, "carol");
  const dave = await addActor(fx, "dave");
  await addProject(fx, "proj_1", alice, [alice]);
  await fx.addMembership("proj_1", dave.speakerId, ["project.read", "message.read"]);

  const before = await fx.db.first<{ next_seq: number }>(
    "SELECT next_seq FROM projects WHERE id = ?",
    ["proj_1"],
  );
  const mismatched = {
    summary: "mismatch",
    type: "request",
    language: "en",
    text: "the real bytes",
    bodyDigest: await digestOf("different bytes"),
  };

  // Decision order: non-member -> NOT_FOUND; member without the scope ->
  // FORBIDDEN; only an authorized sender reaches payload/digest validation.
  await expectCode(
    sendMessage(fx.deps, carol.principal, "proj_1", "key-carol", mismatched),
    "NOT_FOUND",
  );
  await expectCode(
    sendMessage(fx.deps, dave.principal, "proj_1", "key-dave", mismatched),
    "FORBIDDEN",
  );
  await expectCode(
    sendMessage(fx.deps, alice.principal, "proj_1", "key-bad", mismatched),
    "INTEGRITY_MISMATCH",
  );

  // None of the three attempts wrote anything.
  const after = await fx.db.first<{ next_seq: number }>(
    "SELECT next_seq FROM projects WHERE id = ?",
    ["proj_1"],
  );
  assert.equal(after?.next_seq, before?.next_seq);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 0);
});

test("same key with the same payload returns the same message", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const first = await send(fx, alice.principal, "proj_1", "stable-key", "only once");
  // The first send was a real finalization, so it carries the internal
  // queue-to-commit sample; a replay must not report one.
  const { queueToCommitMs, ...firstResult } = first;
  assert.equal(typeof queueToCommitMs, "number");
  const second = await send(fx, alice.principal, "proj_1", "stable-key", "only once");
  assert.deepEqual(second, firstResult);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
  assert.equal((await fx.db.all("SELECT id FROM body_objects")).length, 1);
  assert.equal((await fx.db.all("SELECT key FROM idempotency_keys")).length, 1);
});

test("same key with a different payload is CONFLICT", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const first = await send(fx, alice.principal, "proj_1", "key-1", "first payload");
  await expectCode(send(fx, alice.principal, "proj_1", "key-1", "second payload"), "CONFLICT");

  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
  const messages = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(messages.messages[0]?.messageId, first.messageId);
});

test("idempotency is scoped per speaker and per project", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);
  await addProject(fx, "proj_2", alice, [alice, bob]);

  const a = await send(fx, alice.principal, "proj_1", "shared-key", "alice one");
  const b = await send(fx, bob.principal, "proj_1", "shared-key", "bob one");
  const c = await send(fx, alice.principal, "proj_2", "shared-key", "alice two");
  assert.equal(new Set([a.messageId, b.messageId, c.messageId]).size, 3);
});

test("idempotency payload digests are keyed and stable across calls", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  await send(fx, alice.principal, "proj_1", "key-a", "same payload");
  await send(fx, alice.principal, "proj_1", "key-b", "same payload");
  await send(fx, alice.principal, "proj_1", "key-c", "different payload");

  const rows = await fx.db.all<{ key: string; payload_digest: string }>(
    "SELECT key, payload_digest FROM idempotency_keys ORDER BY key",
  );
  assert.equal(rows.length, 3);
  const byKey = new Map(rows.map((row) => [row.key, row.payload_digest]));
  assert.match(byKey.get("key-a") ?? "", /^hmac-sha256:[0-9a-f]{64}$/);
  assert.equal(byKey.get("key-a"), byKey.get("key-b"));
  assert.notEqual(byKey.get("key-a"), byKey.get("key-c"));
});

test("a pending resend verifies the blob before publishing and stays reclaimable", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent = await send(fx, alice.principal, "proj_1", "resume-key", "resume body");
  const object = await fx.db.first<{
    storage_key: string | null;
    ciphertext_digest: string | null;
  }>(
    `SELECT b.storage_key, b.ciphertext_digest
       FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.ok(
    object !== undefined && object.storage_key !== null && object.ciphertext_digest !== null,
  );
  const original = await fx.blobs.get(object.storage_key);
  assert.ok(original !== undefined);

  // Rewind to the crash window after blob/row writes but before finalization.
  await fx.db.run(
    "UPDATE messages SET seq = NULL, committed_at = NULL, body_state = 'pending' WHERE id = ?",
    [sent.messageId],
  );
  await fx.db.run(
    "UPDATE idempotency_keys SET status = 'pending' WHERE message_id = ?",
    [sent.messageId],
  );
  await fx.db.run("UPDATE projects SET next_seq = 0 WHERE id = ?", ["proj_1"]);

  const tampered = original.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  await fx.blobs.put(object.storage_key, tampered);

  await expectCode(
    send(fx, alice.principal, "proj_1", "resume-key", "resume body"),
    "INTEGRITY_FAILURE",
  );

  const pendingRow = await fx.db.first<{ seq: number | null; body_state: string }>(
    "SELECT seq, body_state FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.equal(pendingRow?.seq, null);
  assert.equal(pendingRow?.body_state, "pending");
  const pendingKey = await fx.db.first<{ status: string }>(
    "SELECT status FROM idempotency_keys WHERE message_id = ?",
    [sent.messageId],
  );
  assert.equal(pendingKey?.status, "pending");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);

  // Restoring the valid blob lets a later retry publish exactly once.
  await fx.blobs.put(object.storage_key, original);
  const resumed = await send(fx, alice.principal, "proj_1", "resume-key", "resume body");
  assert.equal(resumed.messageId, sent.messageId);
  assert.equal(resumed.seq, 1);
  assert.equal(resumed.bodyState, "ready");

  const publishedRow = await fx.db.first<{ seq: number | null; body_state: string }>(
    "SELECT seq, body_state FROM messages WHERE id = ?",
    [sent.messageId],
  );
  assert.equal(publishedRow?.seq, 1);
  assert.equal(publishedRow?.body_state, "ready");
  const completedKey = await fx.db.first<{ status: string }>(
    "SELECT status FROM idempotency_keys WHERE message_id = ?",
    [sent.messageId],
  );
  assert.equal(completedKey?.status, "completed");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
});

test("revoked and expired credentials are UNAUTHENTICATED", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");

  const revoked = await fx.addCredential({
    id: "cred_revoked",
    speakerId: alice.speakerId,
    revokedAt: new Date(fx.deps.now().getTime() - 1),
  });
  await expectCode(fx.authenticate(revoked.token), "UNAUTHENTICATED");

  const expired = await fx.addCredential({
    id: "cred_expired",
    speakerId: alice.speakerId,
    expiresAt: new Date(fx.deps.now().getTime() - 1),
  });
  await expectCode(fx.authenticate(expired.token), "UNAUTHENTICATED");

  await expectCode(fx.authenticate(`cb_${"A".repeat(43)}`), "UNAUTHENTICATED");

  await fx.addAccount("acct_off");
  await fx.addSpeaker("spk_off", "acct_off", "disabled");
  const inactiveSpeaker = await fx.addCredential({
    id: "cred_inactive_speaker",
    speakerId: "spk_off",
  });
  await expectCode(fx.authenticate(inactiveSpeaker.token), "UNAUTHENTICATED");

  assert.equal((await fx.authenticate(alice.token)).speakerId, alice.speakerId);
});

test("20 sequential sends replay in cursor order", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent: string[] = [];
  for (let i = 0; i < 20; i += 1) {
    const result = await send(fx, alice.principal, "proj_1", `key-${i}`, `message ${i}`);
    assert.equal(result.seq, i + 1);
    sent.push(result.messageId);
  }

  const seen: number[] = [];
  let after: number | null = null;
  for (;;) {
    const page = await listMessages(
      fx.deps,
      alice.principal,
      "proj_1",
      after === null ? { limit: 6 } : { afterSeq: after, limit: 6 },
    );
    if (page.messages.length === 0) {
      assert.equal(page.nextCursor, null);
      break;
    }
    for (const message of page.messages) seen.push(message.seq);
    after = page.nextCursor;
    assert.notEqual(after, null);
  }
  assert.deepEqual(seen, Array.from({ length: 20 }, (_, index) => index + 1));

  for (let i = 0; i < sent.length; i += 1) {
    const body = await getMessageBody(fx.deps, alice.principal, "proj_1", sent[i] ?? "");
    assert.equal(body.text, `message ${i}`);
  }
});

test("concurrent same-key sends finalize once and report one queue sample", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const [first, second] = await Promise.all([
    send(fx, alice.principal, "proj_1", "race-key", "only one finalization"),
    send(fx, alice.principal, "proj_1", "race-key", "only one finalization"),
  ]);
  assert.equal(first.messageId, second.messageId);
  const carriers = [first, second].filter(
    (result) => result.queueToCommitMs !== undefined,
  );
  assert.equal(carriers.length, 1);
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
});

test("same-process concurrent sends yield unique contiguous sequences", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, index) =>
      send(fx, alice.principal, "proj_1", `parallel-${index}`, `parallel ${index}`),
    ),
  );
  const seqs = results.map((result) => result.seq).sort((a, b) => a - b);
  assert.deepEqual(seqs, Array.from({ length: 10 }, (_, index) => index + 1));
  assert.equal(new Set(results.map((result) => result.messageId)).size, 10);

  const list = await listMessages(fx.deps, alice.principal, "proj_1", { limit: 100 });
  assert.deepEqual(
    list.messages.map((message) => message.seq),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
});

test("an expired body stays list-visible but returns BODY_EXPIRED", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "will expire");
  await fx.expireMessage(sent.messageId);

  const list = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(list.messages.length, 1);
  assert.equal(list.messages[0]?.bodyState, "expired");

  const metadata = await getMessage(fx.deps, alice.principal, "proj_1", sent.messageId);
  assert.equal(metadata.bodyState, "expired");

  // An idempotent replay reports the committed row's real state, not "ready".
  const replay = await send(fx, alice.principal, "proj_1", "key-1", "will expire");
  assert.equal(replay.messageId, sent.messageId);
  assert.equal(replay.seq, sent.seq);
  assert.equal(replay.digest, sent.digest);
  assert.equal(replay.bodyState, "expired");

  await expectCode(getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId), "BODY_EXPIRED");
  await expectCode(markRead(fx.deps, alice.principal, "proj_1", sent.messageId), "BODY_EXPIRED");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("corrupted ciphertext gives INTEGRITY_FAILURE with no receipt and an audit event", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "tamper target");
  const object = await fx.db.first<{ storage_key: string }>(
    `SELECT b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.ok(object?.storage_key);
  const bytes = await fx.blobs.get(object.storage_key);
  assert.ok(bytes);
  const tampered = bytes.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  await fx.blobs.put(object.storage_key, tampered);

  await expectCode(
    getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
    "INTEGRITY_FAILURE",
  );
  await expectCode(markRead(fx.deps, alice.principal, "proj_1", sent.messageId), "INTEGRITY_FAILURE");

  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
  const audits = await fx.db.all<{ operation: string; outcome: string }>(
    "SELECT operation, outcome FROM audit_events",
  );
  assert.ok(audits.length >= 2);
  assert.ok(audits.every((event) => event.outcome === "failure"));
  assert.deepEqual(
    [...new Set(audits.map((event) => event.operation))].sort(),
    ["message.body.read", "message.receipt.write"],
  );
});

test("a missing ciphertext blob on a committed message fails closed with no content or receipt", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "missing blob target");
  assert.equal(sent.bodyState, "ready");
  const object = await fx.db.first<{ id: string; storage_key: string | null }>(
    `SELECT b.id, b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.ok(object !== undefined && object.storage_key !== null);
  const objectId = object.id;
  const storageKey = object.storage_key;

  // Simulated storage loss after commit: remove only the ciphertext through the
  // supported BlobStore port. The ready message and its body_objects row stay,
  // so this is a missing object, not an expiry tombstone or a dangling FK.
  await fx.blobs.delete(storageKey);

  // Metadata still reports a committed, ready message; only the read path must
  // fail closed.
  const list = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(list.messages[0]?.bodyState, "ready");
  assert.equal(
    (await fx.db.all("SELECT id FROM body_objects WHERE id = ?", [objectId])).length,
    1,
  );

  await expectCode(
    getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
    "INTEGRITY_FAILURE",
  );
  await expectCode(markRead(fx.deps, alice.principal, "proj_1", sent.messageId), "INTEGRITY_FAILURE");

  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
  const audits = await fx.db.all<{ operation: string; outcome: string }>(
    "SELECT operation, outcome FROM audit_events",
  );
  assert.ok(audits.length >= 2);
  assert.ok(audits.every((event) => event.outcome === "failure"));
  assert.deepEqual(
    [...new Set(audits.map((event) => event.operation))].sort(),
    ["message.body.read", "message.receipt.write"],
  );
});

test("a re-sealed body with matching ids but a different digest is INTEGRITY_FAILURE", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  const sent = await send(fx, alice.principal, "proj_1", "key-1", "original body");
  const object = await fx.db.first<{
    id: string;
    storage_key: string | null;
    ciphertext_digest: string | null;
  }>(
    `SELECT b.id, b.storage_key, b.ciphertext_digest
       FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  assert.ok(
    object !== undefined && object.storage_key !== null && object.ciphertext_digest !== null,
  );

  // A valid envelope under the same service/project/message/object AAD: only
  // the DB-recorded ciphertext digest distinguishes it from the stored body.
  const replacement = await sealBody(
    new TextEncoder().encode("attacker replacement body"),
    {
      serviceId: fx.deps.serviceId,
      projectId: "proj_1",
      messageId: sent.messageId,
      objectId: object.id,
    },
    fx.deps.keys,
    { compression: "none" },
  );
  assert.notEqual(replacement.ciphertextDigest, object.ciphertext_digest);
  await fx.blobs.put(object.storage_key, replacement.envelope);

  await expectCode(
    getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId),
    "INTEGRITY_FAILURE",
  );
  await expectCode(markRead(fx.deps, alice.principal, "proj_1", sent.messageId), "INTEGRITY_FAILURE");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);

  const audits = await fx.db.all<{ operation: string }>("SELECT operation FROM audit_events");
  assert.deepEqual(
    [...new Set(audits.map((event) => event.operation))].sort(),
    ["message.body.read", "message.receipt.write"],
  );
});

test("unread filter is per caller and q searches summaries only", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice, bob]);

  const m1 = await send(fx, alice.principal, "proj_1", "k1", "body one", { summary: "Alpha plan" });
  await send(fx, alice.principal, "proj_1", "k2", "alpha in body only", {
    summary: "beta report",
  });
  const m3 = await send(fx, alice.principal, "proj_1", "k3", "three", { summary: "gamma alpha" });
  await send(fx, alice.principal, "proj_1", "k4", "four", { summary: "100% done" });
  await send(fx, alice.principal, "proj_1", "k5", "five", { summary: "percent free" });

  const alpha = await listMessages(fx.deps, bob.principal, "proj_1", { q: "alpha" });
  assert.deepEqual(alpha.messages.map((message) => message.messageId), [m1.messageId, m3.messageId]);

  const wildcard = await listMessages(fx.deps, bob.principal, "proj_1", { q: "%" });
  assert.deepEqual(wildcard.messages.map((message) => message.summary), ["100% done"]);

  const underscore = await listMessages(fx.deps, bob.principal, "proj_1", { q: "_" });
  assert.equal(underscore.messages.length, 0);

  const bodyOnly = await listMessages(fx.deps, bob.principal, "proj_1", { q: "body one" });
  assert.equal(bodyOnly.messages.length, 0);

  await expectCode(
    listMessages(fx.deps, bob.principal, "proj_1", { q: "x".repeat(101) }),
    "VALIDATION_ERROR",
  );

  assert.equal((await listMessages(fx.deps, bob.principal, "proj_1", { unread: true })).messages.length, 5);
  await markRead(fx.deps, bob.principal, "proj_1", m1.messageId);
  assert.equal((await listMessages(fx.deps, bob.principal, "proj_1", { unread: true })).messages.length, 4);
  const readByBob = await listMessages(fx.deps, bob.principal, "proj_1", { unread: false });
  assert.deepEqual(readByBob.messages.map((message) => message.messageId), [m1.messageId]);
  // Alice's unread state is independent of Bob's receipt.
  assert.equal((await listMessages(fx.deps, alice.principal, "proj_1", { unread: true })).messages.length, 5);

  const typed = await listMessages(fx.deps, bob.principal, "proj_1", { sender: "spk_alice", type: "request" });
  assert.equal(typed.messages.length, 5);
  await expectCode(
    listMessages(fx.deps, bob.principal, "proj_1", { sender: "spk_unknown" }),
    "VALIDATION_ERROR",
  );
});

test("pagination limits and cursors are bounded and ordered", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  for (let i = 0; i < 55; i += 1) {
    await send(fx, alice.principal, "proj_1", `key-${i}`, `page ${i}`);
  }

  const defaults = await listMessages(fx.deps, alice.principal, "proj_1");
  assert.equal(defaults.messages.length, 50);
  assert.equal(defaults.nextCursor, 50);

  await expectCode(listMessages(fx.deps, alice.principal, "proj_1", { limit: 0 }), "VALIDATION_ERROR");
  await expectCode(listMessages(fx.deps, alice.principal, "proj_1", { limit: 101 }), "VALIDATION_ERROR");
  await expectCode(listMessages(fx.deps, alice.principal, "proj_1", { limit: 1.5 }), "VALIDATION_ERROR");
  await expectCode(
    listMessages(fx.deps, alice.principal, "proj_1", { afterSeq: 1, beforeSeq: 10 }),
    "VALIDATION_ERROR",
  );
  await expectCode(listMessages(fx.deps, alice.principal, "proj_1", { afterSeq: -1 }), "VALIDATION_ERROR");

  const after = await listMessages(fx.deps, alice.principal, "proj_1", {
    afterSeq: 50,
    limit: 100,
  });
  assert.deepEqual(after.messages.map((message) => message.seq), [51, 52, 53, 54, 55]);
  assert.equal(after.nextCursor, 55);
  assert.equal(after.hasMore, false);

  // Exactly `limit` remaining rows must not report another page.
  const exact = await listMessages(fx.deps, alice.principal, "proj_1", {
    afterSeq: 50,
    limit: 5,
  });
  assert.deepEqual(exact.messages.map((message) => message.seq), [51, 52, 53, 54, 55]);
  assert.equal(exact.hasMore, false);

  const before = await listMessages(fx.deps, alice.principal, "proj_1", {
    beforeSeq: 6,
    limit: 3,
  });
  assert.deepEqual(before.messages.map((message) => message.seq), [3, 4, 5]);
  assert.equal(before.nextCursor, 5);
  assert.equal(before.hasMore, true);

  const empty = await listMessages(fx.deps, alice.principal, "proj_1", { afterSeq: 55 });
  assert.deepEqual(empty, { messages: [], nextCursor: null, hasMore: false });
});

test("reply_to_id must exist in the same project", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  await addProject(fx, "proj_2", alice, [alice]);

  const parent = await send(fx, alice.principal, "proj_1", "key-1", "parent");
  const other = await send(fx, alice.principal, "proj_2", "key-2", "other project");

  const reply = await send(fx, alice.principal, "proj_1", "key-3", "reply", {
    replyToId: parent.messageId,
  });
  assert.equal(reply.seq, 2);
  const metadata = await getMessage(fx.deps, alice.principal, "proj_1", reply.messageId);
  assert.equal(metadata.replyToId, parent.messageId);

  await expectCode(
    send(fx, alice.principal, "proj_1", "key-4", "bad reply", { replyToId: other.messageId }),
    "VALIDATION_ERROR",
  );
  await expectCode(
    send(fx, alice.principal, "proj_1", "key-5", "bad reply", { replyToId: "msg_missing" }),
    "VALIDATION_ERROR",
  );
});

test("mark_read requires both message.read and receipt.write", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "read me");

  // Membership grants only message.read, so receipt.write is missing.
  await fx.addMembership("proj_1", bob.speakerId, ["project.read", "message.read"]);
  await expectCode(markRead(fx.deps, bob.principal, "proj_1", sent.messageId), "FORBIDDEN");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);

  // The capability exists but the credential does not carry receipt.write.
  const carol = await addActor(fx, "carol");
  await fx.addMembership("proj_1", carol.speakerId, ALL_SCOPES);
  const { token } = await fx.addCredential({
    id: "cred_carol_noreceipt",
    speakerId: carol.speakerId,
    scopes: ["project.read", "message.read"],
  });
  const limited = await fx.authenticate(token);
  await expectCode(markRead(fx.deps, limited, "proj_1", sent.messageId), "FORBIDDEN");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("a membership removed after authentication is NOT_FOUND with no rights", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "before removal");

  // The credential and speaker stay active; only membership is revoked.
  const principal = await fx.authenticate(alice.token);
  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    [fx.deps.now().toISOString(), "proj_1", alice.speakerId],
  );

  await expectCode(listMessages(fx.deps, principal, "proj_1"), "NOT_FOUND");
  await expectCode(getMessage(fx.deps, principal, "proj_1", sent.messageId), "NOT_FOUND");
  await expectCode(getMessageBody(fx.deps, principal, "proj_1", sent.messageId), "NOT_FOUND");
  await expectCode(markRead(fx.deps, principal, "proj_1", sent.messageId), "NOT_FOUND");
  await expectCode(send(fx, principal, "proj_1", "key-2", "after removal"), "NOT_FOUND");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 1);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("removing one membership leaves unrelated active memberships working", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  await addProject(fx, "proj_2", alice, [alice]);

  await fx.db.run(
    "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
    [fx.deps.now().toISOString(), "proj_1", alice.speakerId],
  );

  const sent = await send(fx, alice.principal, "proj_2", "key-2", "still a member here");
  assert.equal(sent.seq, 1);
  const list = await listMessages(fx.deps, alice.principal, "proj_2");
  assert.equal(list.messages[0]?.messageId, sent.messageId);
  await expectCode(listMessages(fx.deps, alice.principal, "proj_1"), "NOT_FOUND");
});

test("a send that loses its grant before finalization does not commit and can resume", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);

  // Interleaving: the grant disappears after the body blob is written but
  // before the finalization UPDATE, i.e. between the request-start check and
  // the durable commit.
  const base = fx.blobs;
  let revoked = false;
  fx.deps.blobs = {
    async put(key: string, bytes: Uint8Array): Promise<void> {
      await base.put(key, bytes);
      if (!revoked) {
        revoked = true;
        await fx.db.run(
          "DELETE FROM credential_project_grants WHERE credential_id = ? AND project_id = ?",
          [alice.principal.credentialId, "proj_1"],
        );
      }
    },
    get: (key: string) => base.get(key),
    delete: (key: string) => base.delete(key),
  };

  await expectCode(
    send(fx, alice.principal, "proj_1", "interleave-key", "held back"),
    "FORBIDDEN",
  );

  // No sequence was allocated and no message became visible. The provisional
  // row/blob is reclaimable, as documented.
  const committed = await fx.db.all<{ id: string }>(
    "SELECT id FROM messages WHERE project_id = ? AND seq IS NOT NULL",
    ["proj_1"],
  );
  assert.equal(committed.length, 0);
  const project = await fx.db.first<{ next_seq: number }>(
    "SELECT next_seq FROM projects WHERE id = ?",
    ["proj_1"],
  );
  assert.equal(project?.next_seq, 0);
  const pending = await fx.db.all<{ body_state: string }>(
    "SELECT body_state FROM messages WHERE project_id = ?",
    ["proj_1"],
  );
  assert.deepEqual(pending, [{ body_state: "pending" }]);

  // After an explicit re-grant the same idempotency key resumes and publishes
  // exactly once.
  await fx.grantProject(alice.principal.credentialId, "proj_1");
  const resumed = await send(fx, alice.principal, "proj_1", "interleave-key", "held back");
  assert.equal(resumed.seq, 1);
  assert.equal(resumed.bodyState, "ready");
  assert.equal((await fx.db.all("SELECT id FROM messages WHERE seq IS NOT NULL")).length, 1);
});

test("a receipt write that loses access after the body read creates no receipt", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "read me");

  // Interleaving: the credential is revoked while the body is being read, after
  // the request-start authorization and the integrity check.
  const base = fx.blobs;
  let revoked = false;
  fx.deps.blobs = {
    put: (key: string, bytes: Uint8Array) => base.put(key, bytes),
    async get(key: string): Promise<Uint8Array | undefined> {
      const bytes = await base.get(key);
      if (!revoked) {
        revoked = true;
        await fx.db.run("UPDATE credentials SET revoked_at = ? WHERE id = ?", [
          fx.deps.now().toISOString(),
          alice.principal.credentialId,
        ]);
      }
      return bytes;
    },
    delete: (key: string) => base.delete(key),
  };

  await expectCode(markRead(fx.deps, alice.principal, "proj_1", sent.messageId), "FORBIDDEN");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("a body fetch that loses membership after decryption returns no plaintext", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  await addProject(fx, "proj_1", alice, [alice]);
  const sent = await send(fx, alice.principal, "proj_1", "key-1", "secret body");

  // Interleaving: the membership is removed after decryption but before the
  // plaintext response is assembled.
  const base = fx.blobs;
  let removed = false;
  fx.deps.blobs = {
    put: (key: string, bytes: Uint8Array) => base.put(key, bytes),
    async get(key: string): Promise<Uint8Array | undefined> {
      const bytes = await base.get(key);
      if (!removed) {
        removed = true;
        await fx.db.run(
          "UPDATE project_memberships SET removed_at = ? WHERE project_id = ? AND speaker_id = ?",
          [fx.deps.now().toISOString(), "proj_1", alice.speakerId],
        );
      }
      return bytes;
    },
    delete: (key: string) => base.delete(key),
  };

  await expectCode(getMessageBody(fx.deps, alice.principal, "proj_1", sent.messageId), "NOT_FOUND");
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
  assert.equal((await fx.db.all("SELECT id FROM audit_events")).length, 0);
});

test("unknown and malformed bearer headers are UNAUTHENTICATED", async (t) => {
  const fx = await withFixture(t);
  const unknownToken = `cb_${"A".repeat(43)}`;
  const headers: Array<string | undefined> = [
    undefined,
    "",
    "Bearer ",
    "Bearer cb_short",
    "Basic abc",
    "bearer " + unknownToken,
    `Token ${unknownToken}`,
    unknownToken,
    `Bearer ${unknownToken}`,
    `Bearer ${"cb_" + "A".repeat(42)}`,
  ];
  for (const header of headers) {
    await expectCode(authenticateBearer(fx.deps, header), "UNAUTHENTICATED");
  }
});

test("prefix collisions verify each candidate and never authenticate the wrong credential", async (t) => {
  const fx = await withFixture(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");

  const base = generateSpeakerToken().token;
  const tokenA = base;
  const tokenB = base.slice(0, 20) + (base[20] === "A" ? "B" : "A") + base.slice(21);
  const tokenC = base.slice(0, 30) + (base[30] === "A" ? "B" : "A") + base.slice(31);
  const prefix = base.slice(0, 12);
  assert.equal(tokenA.slice(0, 12), prefix);
  assert.equal(tokenB.slice(0, 12), prefix);
  assert.equal(tokenC.slice(0, 12), prefix);
  assert.notEqual(tokenA, tokenB);
  assert.notEqual(tokenA, tokenC);

  // Two distinct credentials deliberately share a public prefix.
  await fx.addCredential({ id: "cred_collision_a", speakerId: alice.speakerId, token: tokenA });
  await fx.addCredential({ id: "cred_collision_b", speakerId: bob.speakerId, token: tokenB });

  const principalA = await fx.authenticate(tokenA);
  assert.equal(principalA.credentialId, "cred_collision_a");
  assert.equal(principalA.speakerId, alice.speakerId);
  const principalB = await fx.authenticate(tokenB);
  assert.equal(principalB.credentialId, "cred_collision_b");
  assert.equal(principalB.speakerId, bob.speakerId);

  // Same prefix, no matching verifier: rejected, not resolved to credential A.
  await expectCode(fx.authenticate(tokenC), "UNAUTHENTICATED");
});
