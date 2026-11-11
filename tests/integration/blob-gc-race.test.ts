// Fault injection for the local blob GC / message-send interaction. The blob
// store writes real files into a temp directory and lets the test pause a put
// longer than the GC grace period, then run `pruneOrphanBlobs` in apply mode
// before resuming the send. Synthetic temp dirs only; no preview data.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  getMessageBody,
  sendMessage,
  type SendMessageInput,
} from "../../src/service/messages.ts";
import { pruneOrphanBlobs } from "../../src/service/blob-gc.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import type { BlobStore } from "../../src/storage/blobs.ts";
import type { Principal } from "../../src/service/auth.ts";
import type { SqlDatabase } from "../../src/storage/db.ts";
import {
  createServiceFixture,
  type ServiceFixture,
} from "../helpers/service-fixture.ts";

const HOUR_MS = 60 * 60 * 1000;

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function sendText(
  fx: ServiceFixture,
  blobs: BlobStore,
  principal: Principal,
  projectId: string,
  key: string,
  text: string,
) {
  const input: SendMessageInput = {
    summary: text,
    type: "request",
    language: "en",
    text,
    bodyDigest: digestOf(text),
  };
  return sendMessage({ ...fx.deps, blobs }, principal, projectId, key, input);
}

async function addActor(fx: ServiceFixture, name: string): Promise<Principal> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return fx.authenticate(token);
}

async function addOwnedProject(
  fx: ServiceFixture,
  projectId: string,
  accountId: string,
  speakerId: string,
): Promise<void> {
  await fx.addProject(projectId, accountId);
  await fx.addMembership(projectId, speakerId);
}

function blobDirFor(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-gc-race-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Wraps a real LocalBlobStore so one put can be held open. The wrapper writes
// the file, backdates its mtime far past the grace period to simulate a stall
// longer than grace, signals `entered`, and waits for `release`.
class PausingBlobStore implements BlobStore {
  readonly #inner: LocalBlobStore;
  readonly #dir: string;
  #release: (() => void) | undefined;
  #entered: (() => void) | undefined;
  readonly entered: Promise<void>;
  readonly gate: Promise<void>;
  pauseNextPut = false;
  pauseBeforePut = false;
  failNextPut = false;

  constructor(dir: string) {
    this.#dir = dir;
    this.#inner = new LocalBlobStore(dir);
    this.entered = new Promise((resolve) => {
      this.#entered = resolve;
    });
    this.gate = new Promise((resolve) => {
      this.#release = resolve;
    });
  }

  async put(key: string, bytes: Uint8Array): Promise<void> {
    if (this.failNextPut) {
      // Fail before writing, like a put that cannot reach the store.
      this.failNextPut = false;
      throw new Error("injected put failure");
    }
    if (this.pauseBeforePut) {
      // The reference row is already committed; the file does not exist yet.
      this.pauseBeforePut = false;
      this.#entered?.();
      await this.gate;
    }
    if (!this.pauseNextPut) {
      await this.#inner.put(key, bytes);
      return;
    }
    this.pauseNextPut = false;
    await this.#inner.put(key, bytes);
    const old = new Date(Date.now() - 48 * HOUR_MS);
    utimesSync(join(this.#dir, key), old, old);
    this.#entered?.();
    await this.gate;
  }

  release(): void {
    this.#release?.();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return this.#inner.get(key);
  }

  delete(key: string): Promise<void> {
    return this.#inner.delete(key);
  }
}

test("a send paused past grace inside put survives an apply GC run", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const principal = await addActor(fx, "race");
  await addOwnedProject(fx, "proj_1", "acct_race", "spk_race");

  const blobDir = blobDirFor(t);
  const blobs = new PausingBlobStore(blobDir);
  blobs.pauseNextPut = true;

  const text = "in-flight body that GC must not collect";
  const pending = sendText(fx, blobs, principal, "proj_1", "race-key", text);
  await blobs.entered;

  // Reference-before-write: the row is committed while the put is still open,
  // and the message row does not exist yet.
  const objects = await fx.db.all<{
    id: string;
    storage_key: string | null;
  }>("SELECT id, storage_key FROM body_objects");
  assert.equal(objects.length, 1);
  const storageKey = objects[0]?.storage_key;
  assert.equal(typeof storageKey, "string");
  assert.equal(
    (await fx.db.all("SELECT id FROM messages")).length,
    0,
    "the provisional message is inserted only after the put returns",
  );
  assert.equal(existsSync(join(blobDir, storageKey as string)), true);

  // The file looks abandoned: unreferenced-looking mtime far beyond grace.
  // Apply GC during the pause. The committed reference must retain it.
  const summary = await pruneOrphanBlobs(
    { db: fx.db, now: () => new Date() },
    blobDir,
    { graceHours: 1, apply: true },
  );
  assert.deepEqual(summary, {
    dryRun: false,
    graceHours: 1,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 1,
  });
  assert.equal(
    existsSync(join(blobDir, storageKey as string)),
    true,
    "the in-flight ciphertext must survive",
  );

  blobs.release();
  const result = await pending;
  assert.equal(result.bodyState, "ready");
  const body = await getMessageBody(
    { ...fx.deps, blobs },
    principal,
    "proj_1",
    result.messageId,
  );
  assert.equal(body.text, text);
  assert.equal(existsSync(join(blobDir, storageKey as string)), true);
});

test("a send paused between the reference insert and the write survives GC", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const principal = await addActor(fx, "prewrite");
  await addOwnedProject(fx, "proj_1", "acct_prewrite", "spk_prewrite");

  const blobDir = blobDirFor(t);
  const blobs = new PausingBlobStore(blobDir);
  blobs.pauseBeforePut = true;

  const text = "body paused before its ciphertext write";
  const pending = sendText(fx, blobs, principal, "proj_1", "prewrite-key", text);
  await blobs.entered;

  // The reference row exists, the provisional message and the file do not.
  const objects = await fx.db.all<{ storage_key: string | null }>(
    "SELECT storage_key FROM body_objects",
  );
  assert.equal(objects.length, 1);
  const storageKey = objects[0]?.storage_key;
  assert.equal(typeof storageKey, "string");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal(existsSync(join(blobDir, storageKey as string)), false);

  const summary = await pruneOrphanBlobs(
    { db: fx.db, now: () => new Date() },
    blobDir,
    { graceHours: 1, apply: true },
  );
  assert.deepEqual(summary, {
    dryRun: false,
    graceHours: 1,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 0,
  });

  blobs.release();
  const result = await pending;
  assert.equal(result.bodyState, "ready");
  const body = await getMessageBody(
    { ...fx.deps, blobs },
    principal,
    "proj_1",
    result.messageId,
  );
  assert.equal(body.text, text);
  assert.equal(existsSync(join(blobDir, storageKey as string)), true);
});

test("a failed put leaves no ready message; a retry is readable and retained", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const principal = await addActor(fx, "failed");
  await addOwnedProject(fx, "proj_1", "acct_failed", "spk_failed");

  const blobDir = blobDirFor(t);
  const blobs = new PausingBlobStore(blobDir);
  blobs.failNextPut = true;

  const text = "body whose first write fails";
  await assert.rejects(
    sendText(fx, blobs, principal, "proj_1", "retry-key", text),
    /injected put failure/,
  );

  // The reference row is committed before the put; the failed put leaves it
  // dangling with no message. Nothing is published and no ciphertext exists.
  const dangling = await fx.db.all<{ id: string; storage_key: string | null }>(
    "SELECT id, storage_key FROM body_objects",
  );
  assert.equal(dangling.length, 1);
  assert.equal(typeof dangling[0]?.storage_key, "string");
  assert.equal((await fx.db.all("SELECT id FROM messages")).length, 0);
  assert.equal(
    (await fx.db.all("SELECT id FROM messages WHERE body_state = 'ready'")).length,
    0,
  );
  assert.equal(
    existsSync(join(blobDir, dangling[0]?.storage_key as string)),
    false,
  );

  const sent = await sendText(fx, blobs, principal, "proj_1", "retry-key", text);
  assert.equal(sent.bodyState, "ready");
  const body = await getMessageBody(
    { ...fx.deps, blobs },
    principal,
    "proj_1",
    sent.messageId,
  );
  assert.equal(body.text, text);

  const live = await fx.db.first<{ storage_key: string | null }>(
    `SELECT b.storage_key FROM body_objects b
       JOIN messages m ON m.body_object_id = b.id
      WHERE m.id = ?`,
    [sent.messageId],
  );
  const liveKey = live?.storage_key;
  assert.equal(typeof liveKey, "string");
  assert.notEqual(liveKey, dangling[0]?.storage_key);

  // Backdate the live file past grace: only the reference row keeps it.
  const old = new Date(Date.now() - 48 * HOUR_MS);
  utimesSync(join(blobDir, liveKey as string), old, old);
  const summary = await pruneOrphanBlobs(
    { db: fx.db, now: () => new Date() },
    blobDir,
    { graceHours: 1, apply: true },
  );
  assert.equal(summary.deleted, 0);
  // Only the live file exists on disk; the dangling reference has no file.
  assert.equal(summary.skippedReferenced, 1);
  assert.equal(existsSync(join(blobDir, liveKey as string)), true);
});

test("the pre-delete fence retains a reference committed after the scan", async (t) => {
  const blobDir = blobDirFor(t);
  const key = "fencecommittedafter126852243";
  writeFileSync(join(blobDir, key), "ciphertext", { mode: 0o600 });
  const old = new Date(Date.now() - 48 * HOUR_MS);
  utimesSync(join(blobDir, key), old, old);

  // R0 (candidate filter) sees no row; R1 (pre-delete fence) sees the row a
  // resumed send committed after the scan.
  let calls = 0;
  const racing = {
    all: async () => {
      calls += 1;
      return calls === 1 ? [] : [{ storage_key: key }];
    },
  } as unknown as SqlDatabase;

  const summary = await pruneOrphanBlobs(
    { db: racing, now: () => new Date() },
    blobDir,
    { graceHours: 1, apply: true },
  );
  assert.equal(calls, 2);
  assert.deepEqual(summary, {
    dryRun: false,
    graceHours: 1,
    limit: 1000,
    candidates: 0,
    deleted: 0,
    failed: 0,
    skippedRecent: 0,
    skippedReferenced: 1,
  });
  assert.equal(existsSync(join(blobDir, key)), true);
});

test("an interrupted scan deletes nothing before the reference fence", async (t) => {
  const blobDir = blobDirFor(t);
  const key = "orphanoldkey000000000000";
  writeFileSync(join(blobDir, key), "ciphertext", { mode: 0o600 });
  const old = new Date(Date.now() - 48 * HOUR_MS);
  utimesSync(join(blobDir, key), old, old);

  // R0 fails: the run aborts before selection or deletion.
  let reads = 0;
  const failingInitial = {
    all: async () => {
      reads += 1;
      throw new Error("injected reference read failure");
    },
  } as unknown as SqlDatabase;
  await assert.rejects(
    pruneOrphanBlobs({ db: failingInitial, now: () => new Date() }, blobDir, {
      graceHours: 1,
      apply: true,
    }),
    /injected reference read failure/,
  );
  assert.equal(reads, 1);
  assert.equal(existsSync(join(blobDir, key)), true);

  // R1 (pre-delete fence) fails after selection: still no unlink.
  let calls = 0;
  const failingFence = {
    all: async () => {
      calls += 1;
      if (calls === 1) return [];
      throw new Error("injected fence failure");
    },
  } as unknown as SqlDatabase;
  await assert.rejects(
    pruneOrphanBlobs({ db: failingFence, now: () => new Date() }, blobDir, {
      graceHours: 1,
      apply: true,
    }),
    /injected fence failure/,
  );
  assert.equal(calls, 2);
  assert.equal(existsSync(join(blobDir, key)), true);
});
