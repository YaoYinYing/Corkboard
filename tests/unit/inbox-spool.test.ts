import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  InboxError,
  ackEvent,
  acknowledgedSeq,
  enqueueEvent,
  listEvents,
  openSpool,
  pendingEvents,
  prepareSpool,
  pruneSpool,
  readPayload,
  registerConsumer,
  spoolUsage,
  type InboxMessageInput,
} from "../../src/inbox/spool.ts";

const root = mkdtempSync(join(tmpdir(), "corkboard-inbox-unit-"));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "synthetic-inbox-token";
const PROJECT = "proj_1";
const NOW = () => new Date("2026-11-11T12:00:00.000Z");

function newDir(name: string): string {
  return join(root, `${name}-${process.pid}-${Math.random().toString(16).slice(2)}`);
}

function message(seq: number, overrides: Partial<InboxMessageInput> = {}): InboxMessageInput {
  return {
    projectId: PROJECT,
    messageId: `msg_${seq}`,
    seq,
    senderId: "spk_sender",
    summary: `summary ${seq}`,
    bodyState: "ready",
    ...overrides,
  };
}

function isInbox(code: string, exitCode: number) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof InboxError);
    assert.equal(error.code, code);
    assert.equal(error.exitCode, exitCode);
    return true;
  };
}

function events(dir: string): string[] {
  return readdirSync(join(dir, "events")).sort();
}

test("prepareSpool creates a private spool outside the repository and rejects unsafe paths", () => {
  const dir = newDir("prepare");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  assert.equal(statSync(spool.root).mode & 0o777, 0o700);
  assert.equal(statSync(join(spool.root, "events")).mode & 0o777, 0o700);
  assert.equal(statSync(join(spool.root, "spool.json")).mode & 0o777, 0o600);
  assert.equal(openSpool(dir).projectId, PROJECT);

  const inside = join(process.cwd(), `.inbox-inside-${process.pid}`);
  assert.throws(
    () => prepareSpool(inside, PROJECT),
    (error: unknown) => error instanceof InboxError && error.message.includes("outside the repository"),
  );
  assert.equal(existsSync(inside), false);

  const target = newDir("link-target");
  prepareSpool(target, PROJECT, { plaintext: false, now: NOW });
  const link = newDir("link");
  symlinkSync(target, link);
  assert.throws(() => prepareSpool(link, PROJECT), isInbox("INBOX_UNSAFE", 3));

  // A pre-existing loosely permissioned directory fails closed and is not
  // chmodded; the bridge only tightens directories it creates.
  chmodSync(join(target, "events"), 0o755);
  assert.throws(() => openSpool(target), isInbox("INBOX_UNSAFE", 3));
  assert.equal(statSync(join(target, "events")).mode & 0o777, 0o755);
  chmodSync(join(target, "events"), 0o700);

  const shared = newDir("shared-root");
  mkdirSync(shared, { mode: 0o755 });
  chmodSync(shared, 0o755);
  assert.throws(
    () => prepareSpool(shared, PROJECT, { plaintext: false }),
    isInbox("INBOX_UNSAFE", 3),
  );
  assert.equal(statSync(shared).mode & 0o777, 0o755);
  assert.equal(existsSync(join(shared, "spool.json")), false);
});

test("metadata-only events are versioned, redacted, durable, and idempotent", () => {
  const dir = newDir("metadata");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  const msg = message(1, {
    messageId: `msg_${TOKEN}`,
    senderId: `spk_${TOKEN}`,
    summary: `hello ${TOKEN}`,
  });
  const event = enqueueEvent(spool, msg, "plaintext marker", { token: TOKEN, now: NOW });

  assert.equal(event.version, 1);
  assert.equal(event.project_id, PROJECT);
  assert.equal(event.seq, 1);
  assert.equal(event.payload.included, false);
  assert.equal(event.sender.attribution, "server_authenticated");
  assert.equal(event.body_state, "ready");

  const files = events(dir);
  assert.deepEqual(files, ["0000000000000001.json"]);
  const text = readFileSync(join(spool.eventsDir, files[0] ?? ""), "utf8");
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes("plaintext marker"), false);
  assert.equal(text.includes("[REDACTED]"), true);
  assert.equal(statSync(join(spool.eventsDir, files[0] ?? "")).mode & 0o777, 0o600);
  assert.equal(spoolUsage(spool).events, 1);

  const again = enqueueEvent(spool, msg, "another body", { token: TOKEN, now: NOW });
  assert.deepEqual(again, event);
  assert.equal(events(dir).length, 1);

  assert.throws(
    () => enqueueEvent(spool, message(1, { messageId: "msg_other" }), null, { token: TOKEN }),
    isInbox("INBOX_CONFLICT", 3),
  );
  assert.equal(events(dir).length, 1);
});

test("plaintext is written only on opt-in and is verified again on read", () => {
  const dir = newDir("plaintext");
  const spool = prepareSpool(dir, PROJECT, { plaintext: true, now: NOW });
  const text = "verified body";
  const event = enqueueEvent(spool, message(1), text, { token: TOKEN, now: NOW });
  assert.equal(event.payload.included, true);
  assert.equal(readPayload(spool, event), text);

  const payloadPath = join(spool.root, "payloads", "0000000000000001.json");
  assert.equal(statSync(payloadPath).mode & 0o777, 0o600);
  const parsed = JSON.parse(readFileSync(payloadPath, "utf8")) as {
    digest: string;
    text: string;
  };
  parsed.text = "tampered";
  writeFileSync(payloadPath, `${JSON.stringify(parsed)}\n`, { mode: 0o600 });
  chmodSync(payloadPath, 0o600);
  assert.throws(() => readPayload(spool, event), isInbox("INBOX_CONFLICT", 3));

  // A metadata-only spool cannot be flipped to plaintext after creation.
  const metaDir = newDir("plaintext-flip");
  prepareSpool(metaDir, PROJECT, { plaintext: false, now: NOW });
  assert.throws(
    () => prepareSpool(metaDir, PROJECT, { plaintext: true }),
    isInbox("INBOX_CONFIG", 2),
  );
});

test("an expired tombstone is consumable metadata without plaintext", () => {
  const dir = newDir("expired");
  const spool = prepareSpool(dir, PROJECT, { plaintext: true, now: NOW });
  const event = enqueueEvent(spool, message(1, { bodyState: "expired" }), null, {
    token: TOKEN,
    now: NOW,
  });
  assert.equal(event.body_state, "expired");
  assert.equal(event.payload.included, false);
  assert.equal(listEvents(spool).length, 1);
  assert.throws(
    () => enqueueEvent(spool, message(1, { bodyState: "expired" }), "body", { token: TOKEN }),
    isInbox("INBOX_UNSAFE", 3),
  );
});

test("an orphan payload from a crash between renames is completed, not lost", () => {
  const dir = newDir("orphan-payload");
  const spool = prepareSpool(dir, PROJECT, { plaintext: true, now: NOW });
  const text = "verified after crash";
  const digest = `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
  const payload = {
    version: 1,
    project_id: PROJECT,
    seq: 1,
    message_id: "msg_1",
    digest,
    text,
  };
  writeFileSync(
    join(spool.payloadsDir, "0000000000000001.json"),
    `${JSON.stringify(payload)}\n`,
    { mode: 0o600 },
  );
  chmodSync(join(spool.payloadsDir, "0000000000000001.json"), 0o600);

  const event = enqueueEvent(spool, message(1), text, { token: TOKEN, now: NOW });
  assert.equal(event.payload.included, true);
  assert.equal(readPayload(spool, event), text);
  assert.deepEqual(events(dir), ["0000000000000001.json"]);
});

test("duplicate and out-of-order records sort, dedupe, and require contiguous acks", () => {
  const dir = newDir("ordering");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "consumer-a");
  enqueueEvent(spool, message(3), null, { token: TOKEN, now: NOW });
  enqueueEvent(spool, message(1), null, { token: TOKEN, now: NOW });
  enqueueEvent(spool, message(2), null, { token: TOKEN, now: NOW });
  enqueueEvent(spool, message(2), null, { token: TOKEN, now: NOW });

  assert.deepEqual(
    listEvents(spool).map((event) => event.seq),
    [1, 2, 3],
  );
  assert.deepEqual(
    pendingEvents(spool, "consumer-a").map((event) => event.seq),
    [1, 2, 3],
  );
  assert.throws(
    () => ackEvent(spool, "consumer-a", 2),
    isInbox("INBOX_OUT_OF_ORDER", 3),
  );
  assert.equal(ackEvent(spool, "consumer-a", 1).acked_seq, 1);
  assert.equal(ackEvent(spool, "consumer-a", 1).acked_seq, 1);
  assert.equal(acknowledgedSeq(spool, "consumer-a"), 1);
  assert.deepEqual(
    pendingEvents(spool, "consumer-a").map((event) => event.seq),
    [2, 3],
  );
  assert.equal(ackEvent(spool, "consumer-a", 2).acked_seq, 2);
  assert.equal(ackEvent(spool, "consumer-a", 3).acked_seq, 3);
});

test("prune removes only events every registered consumer acknowledged", () => {
  const dir = newDir("prune");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "a");
  registerConsumer(spool, "b");
  enqueueEvent(spool, message(1), null, { token: TOKEN, now: NOW });
  enqueueEvent(spool, message(2), null, { token: TOKEN, now: NOW });

  ackEvent(spool, "a", 1);
  assert.equal(acknowledgedSeq(spool, "b"), 0);
  assert.equal(pruneSpool(spool, { force: true, now: NOW }), 0);
  assert.equal(events(dir).length, 2);

  ackEvent(spool, "b", 1);
  // Retention has not elapsed and force is off.
  assert.equal(pruneSpool(spool, { now: NOW }), 0);
  assert.equal(events(dir).length, 2);
  assert.equal(pruneSpool(spool, { force: true, now: NOW }), 1);
  assert.deepEqual(events(dir), ["0000000000000002.json"]);
});

test("unacknowledged events cause explicit backpressure, never a silent drop", () => {
  const dir = newDir("backpressure");
  const spool = prepareSpool(dir, PROJECT, {
    plaintext: false,
    maxEvents: 1,
    now: NOW,
  });
  registerConsumer(spool, "consumer-a");
  enqueueEvent(spool, message(1), null, { token: TOKEN, now: NOW });
  assert.throws(
    () => enqueueEvent(spool, message(2), null, { token: TOKEN, now: NOW }),
    isInbox("INBOX_BACKPRESSURE", 1),
  );
  assert.deepEqual(events(dir), ["0000000000000001.json"]);

  ackEvent(spool, "consumer-a", 1);
  enqueueEvent(spool, message(2), null, { token: TOKEN, now: NOW });
  assert.deepEqual(events(dir), ["0000000000000002.json"]);

  const bytesDir = newDir("backpressure-bytes");
  const tiny = prepareSpool(bytesDir, PROJECT, { plaintext: false, maxBytes: 8, now: NOW });
  assert.throws(
    () => enqueueEvent(tiny, message(1), null, { token: TOKEN, now: NOW }),
    isInbox("INBOX_BACKPRESSURE", 1),
  );
  assert.deepEqual(events(bytesDir), []);
});

test("oversized records and unknown versions fail closed without being written", () => {
  const dir = newDir("oversize");
  const spool = prepareSpool(dir, PROJECT, {
    plaintext: false,
    maxEventBytes: 64,
    now: NOW,
  });
  assert.throws(
    () =>
      enqueueEvent(spool, message(1, { summary: "x".repeat(500) }), null, {
        token: TOKEN,
        now: NOW,
      }),
    isInbox("INBOX_TOO_LARGE", 3),
  );
  assert.deepEqual(events(dir), []);

  const versionDir = newDir("version");
  const versionSpool = prepareSpool(versionDir, PROJECT, { plaintext: false, now: NOW });
  const target = join(versionSpool.eventsDir, "0000000000000001.json");
  writeFileSync(target, '{"version":2}\n', { mode: 0o600 });
  chmodSync(target, 0o600);
  assert.throws(() => listEvents(versionSpool), isInbox("INBOX_VERSION", 3));

  const corruptDir = newDir("corrupt");
  const corruptSpool = prepareSpool(corruptDir, PROJECT, { plaintext: false, now: NOW });
  const corrupt = join(corruptSpool.eventsDir, "0000000000000001.json");
  writeFileSync(corrupt, "{not json", { mode: 0o600 });
  chmodSync(corrupt, 0o600);
  assert.throws(() => listEvents(corruptSpool), isInbox("INBOX_CORRUPT", 3));
});

test("wrong project, unsafe ids, and symlinked files fail closed", () => {
  const dir = newDir("wrong-project");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  assert.throws(
    () =>
      enqueueEvent(spool, message(1, { projectId: "proj_other" }), null, { token: TOKEN }),
    isInbox("INBOX_CROSS_PROJECT", 3),
  );
  assert.throws(
    () => enqueueEvent(spool, message(0), null, { token: TOKEN }),
    isInbox("INBOX_UNSAFE", 3),
  );
  assert.throws(
    () => enqueueEvent(spool, message(1, { senderId: "" }), null, { token: TOKEN }),
    isInbox("INBOX_UNSAFE", 3),
  );
  assert.throws(
    () => prepareSpool(dir, "proj_other", { plaintext: false }),
    isInbox("INBOX_CROSS_PROJECT", 3),
  );

  const real = join(spool.eventsDir, "0000000000000001.json");
  const fake = join(root, "outside-event.json");
  writeFileSync(fake, `${JSON.stringify(listEvents(spool))}\n`, { mode: 0o600 });
  symlinkSync(fake, real);
  assert.throws(() => listEvents(spool), isInbox("INBOX_UNSAFE", 3));
});

test("the acknowledgement watermark never regresses under a stale lower write", () => {
  const dir = newDir("ack-monotonic");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "c");
  for (let seq = 1; seq <= 3; seq += 1) {
    enqueueEvent(spool, message(seq), null, { token: TOKEN, now: NOW });
  }
  ackEvent(spool, "c", 1);
  ackEvent(spool, "c", 2);
  ackEvent(spool, "c", 3);
  assert.equal(acknowledgedSeq(spool, "c"), 3);

  // Simulate a stale concurrent writer recreating the seq-2 file after seq 3.
  const stale = {
    version: 1,
    consumer_id: "c",
    project_id: PROJECT,
    acked_seq: 2,
    updated_at: NOW().toISOString(),
  };
  const stalePath = join(spool.consumersDir, "c", "acks", "0000000000000002.json");
  writeFileSync(stalePath, `${JSON.stringify(stale)}\n`, { mode: 0o600 });
  chmodSync(stalePath, 0o600);

  assert.equal(acknowledgedSeq(spool, "c"), 3);
  assert.equal(ackEvent(spool, "c", 3).acked_seq, 3);
  assert.deepEqual(pendingEvents(spool, "c"), []);
});

test("a stale ack temp is counted, never read as an ack, and swept on restart", () => {
  const dir = newDir("ack-temp");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "c");
  const acks = join(spool.consumersDir, "c", "acks");
  const temp = join(acks, "0000000000000001.json.tmp-999-deadbeef");
  writeFileSync(temp, "partial-ack", { mode: 0o600 });
  chmodSync(temp, 0o600);

  // Before the next bridge start the leftover counts against maxBytes but is
  // never parsed as an acknowledgement.
  const opened = openSpool(dir);
  assert.equal(acknowledgedSeq(opened, "c"), 0);
  assert.ok(spoolUsage(opened).bytes >= Buffer.byteLength("partial-ack"));

  const restarted = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  assert.equal(existsSync(temp), false);
  assert.deepEqual(readdirSync(acks), []);
  assert.equal(acknowledgedSeq(restarted, "c"), 0);
});

test("loose consumer and acknowledgement directories fail closed", () => {
  const dir = newDir("ack-modes");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "c");
  const consumer = join(spool.consumersDir, "c");
  const acks = join(consumer, "acks");

  chmodSync(consumer, 0o755);
  assert.throws(() => acknowledgedSeq(spool, "c"), isInbox("INBOX_UNSAFE", 3));
  chmodSync(consumer, 0o700);

  chmodSync(acks, 0o755);
  assert.throws(() => acknowledgedSeq(spool, "c"), isInbox("INBOX_UNSAFE", 3));
  chmodSync(acks, 0o700);

  assert.equal(acknowledgedSeq(spool, "c"), 0);
});

test("a consumer directory without acks is unregistered and cannot wedge prune", () => {
  const dir = newDir("bare-consumer");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  enqueueEvent(spool, message(1), null, { token: TOKEN, now: NOW });
  const bare = join(spool.consumersDir, "ghost");
  mkdirSync(bare, { mode: 0o700 });
  chmodSync(bare, 0o700);

  assert.throws(
    () => acknowledgedSeq(spool, "ghost"),
    isInbox("INBOX_NOT_FOUND", 3),
  );
  assert.equal(pruneSpool(spool, { force: true, now: NOW }), 0);
  assert.equal(events(dir).length, 1);
});

test("a spool keeps separate consumers and rejects unknown ones", () => {
  const dir = newDir("consumers");
  const spool = prepareSpool(dir, PROJECT, { plaintext: false, now: NOW });
  registerConsumer(spool, "a");
  registerConsumer(spool, "b");
  enqueueEvent(spool, message(1), null, { token: TOKEN, now: NOW });
  ackEvent(spool, "a", 1);
  assert.equal(acknowledgedSeq(spool, "a"), 1);
  assert.equal(acknowledgedSeq(spool, "b"), 0);
  assert.deepEqual(pendingEvents(spool, "b").map((event) => event.seq), [1]);
  assert.throws(
    () => acknowledgedSeq(spool, "../escape"),
    isInbox("INBOX_CONFIG", 2),
  );
  assert.throws(
    () => ackEvent(spool, "missing", 1),
    isInbox("INBOX_NOT_FOUND", 3),
  );
});
