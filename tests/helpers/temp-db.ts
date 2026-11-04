import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import type { SqlDatabase, SqlValue } from "../../src/storage/db.ts";
import {
  ConflictError,
  NotFoundError,
  finalizeMessage,
  insertIdempotency,
} from "../../src/storage/sqlite.ts";

export interface ContractStorage {
  readonly db: SqlDatabase;
  reopen(): Promise<ContractStorage>;
  close(): void;
  dispose(): void;
}

export type ContractStorageFactory = () => Promise<ContractStorage>;

/**
 * SQLite contract handle. `reopen()` opens another connection to the same
 * file; `dispose()` closes every handle and removes the temp directory.
 */
export async function createSqliteContractStorage(): Promise<ContractStorage> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-contract-"));
  const path = join(dir, "contract.sqlite");
  const handles = new Set<SqlDatabase & { close(): void }>();
  let disposed = false;

  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    for (const handle of handles) {
      handle.close();
    }
    handles.clear();
    rmSync(dir, { recursive: true, force: true });
  };

  const openHandle = async (): Promise<ContractStorage> => {
    let db: SqlDatabase & { close(): void };
    try {
      db = await openSqliteDatabase(path);
    } catch (error) {
      dispose();
      throw error;
    }
    handles.add(db);
    return {
      db,
      reopen: openHandle,
      close(): void {
        if (handles.delete(db)) {
          db.close();
        }
      },
      dispose,
    };
  };

  return openHandle();
}

function now(): string {
  return new Date().toISOString();
}

export async function insertAccount(
  db: SqlDatabase,
  id: string,
  email: string,
): Promise<void> {
  await db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?1, ?2, 'active', ?3)",
    [id, email, now()],
  );
}

export async function insertProject(
  db: SqlDatabase,
  id: string,
  ownerAccountId: string,
  status = "active",
): Promise<void> {
  await db.run(
    "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
    [id, ownerAccountId, id, status, now()],
  );
}

export async function insertSpeaker(
  db: SqlDatabase,
  id: string,
  ownerAccountId: string,
): Promise<void> {
  await db.run(
    "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?1, ?2, ?3, 'active', ?4)",
    [id, ownerAccountId, id, now()],
  );
}

/** Provisional row: seq and body_object_id may reference an uncommitted blob. */
export async function insertPendingMessage(
  db: SqlDatabase,
  id: string,
  projectId: string,
  senderSpeakerId: string,
  bodyObjectId: string | null = null,
): Promise<void> {
  await db.run(
    "INSERT INTO messages (id, project_id, sender_speaker_id, summary, type, language, received_at, body_state, body_object_id) VALUES (?1, ?2, ?3, 'summary', 'request', 'en', ?4, 'pending', ?5)",
    [id, projectId, senderSpeakerId, now(), bodyObjectId],
  );
}

/** Pre-published row used only to assert uniqueness/non-pending behavior. */
export async function insertReadyMessage(
  db: SqlDatabase,
  id: string,
  projectId: string,
  seq: number,
  senderSpeakerId: string,
  bodyObjectId: string,
): Promise<void> {
  const timestamp = now();
  await db.run(
    "INSERT INTO messages (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, committed_at, body_object_id, body_state) VALUES (?1, ?2, ?3, ?4, 'summary', 'request', 'en', ?5, ?5, ?6, 'ready')",
    [id, projectId, seq, senderSpeakerId, timestamp, bodyObjectId],
  );
}

export async function insertBodyObject(
  db: SqlDatabase,
  id: string,
  projectId: string,
  storageKey: string,
): Promise<void> {
  await db.run(
    "INSERT INTO body_objects (id, project_id, storage_key, state, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)",
    [id, projectId, storageKey, now()],
  );
}

/**
 * Test double: rejects the first `failures` finalize statements with a
 * synthetic UNIQUE error so the retry path is exercised deterministically.
 */
export function withTransientUniqueFailures(
  db: SqlDatabase,
  failures: number,
): SqlDatabase {
  let remaining = failures;
  return {
    exec(sql: string): Promise<void> {
      return db.exec(sql);
    },
    all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return db.all<T>(sql, params);
    },
    first<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      if (remaining > 0 && sql.startsWith("UPDATE messages")) {
        remaining -= 1;
        return Promise.reject(
          new Error("UNIQUE constraint failed: messages.project_id, messages.seq"),
        );
      }
      return db.first<T>(sql, params);
    },
    run(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ changes: number }> {
      return db.run(sql, params);
    },
  };
}

const TABLES = [
  "accounts",
  "projects",
  "project_tags",
  "speakers",
  "project_memberships",
  "credentials",
  "messages",
  "message_receipts",
  "body_objects",
  "idempotency_keys",
  "audit_events",
  "service_settings",
  "schema_migrations",
  "credential_project_grants",
];

/**
 * Adapter-agnostic storage contract. A future D1 test file calls this with a
 * D1-backed factory; the scenarios must not depend on SQLite internals beyond
 * the port and migration 001 (including its trigger).
 */
export function runStorageContract(
  name: string,
  openStorage: ContractStorageFactory,
): void {
  const scenario = (title: string): string => `${name}: ${title}`;

  test(scenario("migration 001 applies once and is idempotent"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());

    const versions = await storage.db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2],
    );

    const tables = await storage.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    );
    const tableNames = tables.map((row) => row.name);
    for (const table of TABLES) {
      assert.ok(tableNames.includes(table), `missing table ${table}`);
    }

    const triggers = await storage.db.all<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'trigger'",
    );
    assert.ok(
      triggers.some((row) => row.name === "trg_messages_publish"),
      "finalize trigger is part of the atomicity contract",
    );

    const reopened = await storage.reopen();
    try {
      const after = await reopened.db.all<{ version: number }>(
        "SELECT version FROM schema_migrations ORDER BY version",
      );
      assert.deepEqual(
        after.map((row) => row.version),
        [1, 2],
      );
    } finally {
      reopened.close();
    }
  });

  test(scenario("foreign keys are enforced"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");

    await assert.rejects(
      storage.db.run(
        "INSERT INTO messages (id, project_id, sender_speaker_id, summary, type, language, received_at, body_state) VALUES (?1, ?2, ?3, 'summary', 'request', 'en', ?4, 'pending')",
        ["msg_1", "proj_missing", "spk_1", now()],
      ),
      /FOREIGN KEY constraint failed/,
    );
  });

  test(scenario("UNIQUE(project_id, seq) is enforced"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertReadyMessage(storage.db, "msg_1", "proj_1", 1, "spk_1", "obj_1");

    await assert.rejects(
      insertReadyMessage(storage.db, "msg_2", "proj_1", 1, "spk_1", "obj_1"),
      /UNIQUE constraint failed/,
    );
  });

  test(scenario("pending rows are invisible to published queries"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");

    const published = await storage.db.all<{ id: string }>(
      "SELECT id FROM messages WHERE project_id = ?1 AND body_state IN ('ready', 'expired')",
      ["proj_1"],
    );
    assert.equal(published.length, 0);
  });

  test(scenario("finalize publishes ready state and seq across reopen"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");
    const committedAt = "2026-11-04T12:00:00.000Z";

    const seq = await finalizeMessage(storage.db, {
      projectId: "proj_1",
      messageId: "msg_1",
      bodyObjectId: "obj_1",
      committedAt,
    });
    assert.equal(seq, 1);

    const reopened = await storage.reopen();
    try {
      const message = await reopened.db.first<{
        seq: number;
        body_state: string;
        committed_at: string;
        body_object_id: string;
      }>(
        "SELECT seq, body_state, committed_at, body_object_id FROM messages WHERE id = ?1",
        ["msg_1"],
      );
      assert.deepEqual(message, {
        seq: 1,
        body_state: "ready",
        committed_at: committedAt,
        body_object_id: "obj_1",
      });
      const project = await reopened.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?1",
        ["proj_1"],
      );
      assert.equal(project?.next_seq, 1);
    } finally {
      reopened.close();
    }
  });

  test(
    scenario("100 concurrent finalizations get unique contiguous seqs and retry"),
    async (t) => {
      const storage = await openStorage();
      t.after(() => storage.dispose());
      await insertAccount(storage.db, "acct_1", "one@example.com");
      await insertSpeaker(storage.db, "spk_1", "acct_1");
      await insertProject(storage.db, "proj_1", "acct_1");

      const messageIds = Array.from(
        { length: 100 },
        (_, index) => `msg_${index}`,
      );
      for (const messageId of messageIds) {
        await insertPendingMessage(storage.db, messageId, "proj_1", "spk_1");
        await insertBodyObject(
          storage.db,
          `obj_${messageId}`,
          "proj_1",
          `blobs/${messageId}`,
        );
      }

      const flaky = withTransientUniqueFailures(storage.db, 3);
      const seqs = await Promise.all(
        messageIds.map((messageId) =>
          finalizeMessage(flaky, {
            projectId: "proj_1",
            messageId,
            bodyObjectId: `obj_${messageId}`,
            committedAt: now(),
          }),
        ),
      );

      assert.equal(seqs.length, 100);
      assert.equal(new Set(seqs).size, 100);
      assert.deepEqual(
        [...seqs].sort((a, b) => a - b),
        Array.from({ length: 100 }, (_, index) => index + 1),
      );
      const project = await storage.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?1",
        ["proj_1"],
      );
      assert.equal(project?.next_seq, 100);
    },
  );

  test(scenario("an unfinalized provisional row is reclaimable after reopen"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_crash", "proj_1", "blobs/obj_crash");
    await insertPendingMessage(
      storage.db,
      "msg_crash",
      "proj_1",
      "spk_1",
      "obj_crash",
    );

    const reopened = await storage.reopen();
    try {
      const message = await reopened.db.first<{
        seq: number | null;
        body_state: string;
        body_object_id: string;
      }>(
        "SELECT seq, body_state, body_object_id FROM messages WHERE id = ?1",
        ["msg_crash"],
      );
      assert.equal(message?.body_state, "pending");
      assert.equal(message?.seq, null);
      assert.equal(message?.body_object_id, "obj_crash");

      const object = await reopened.db.first<{ storage_key: string }>(
        "SELECT storage_key FROM body_objects WHERE id = ?1",
        ["obj_crash"],
      );
      assert.equal(object?.storage_key, "blobs/obj_crash");

      const project = await reopened.db.first<{ next_seq: number }>(
        "SELECT next_seq FROM projects WHERE id = ?1",
        ["proj_1"],
      );
      assert.equal(project?.next_seq, 0);

      const published = await reopened.db.all<{ id: string }>(
        "SELECT id FROM messages WHERE project_id = ?1 AND body_state IN ('ready', 'expired')",
        ["proj_1"],
      );
      assert.equal(published.length, 0);
    } finally {
      reopened.close();
    }
  });

  test(scenario("idempotency completes only when finalize succeeds"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");
    const timestamp = now();
    assert.equal(
      await insertIdempotency(storage.db, {
        speakerId: "spk_1",
        projectId: "proj_1",
        key: "key-1",
        payloadDigest: "sha256:abc",
        messageId: "msg_1",
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      true,
    );

    const before = await storage.db.first<{ status: string }>(
      "SELECT status FROM idempotency_keys WHERE message_id = ?1",
      ["msg_1"],
    );
    assert.equal(before?.status, "pending");

    await finalizeMessage(storage.db, {
      projectId: "proj_1",
      messageId: "msg_1",
      bodyObjectId: "obj_1",
      committedAt: now(),
    });

    const after = await storage.db.first<{
      status: string;
      updated_at: string;
    }>(
      "SELECT status, updated_at FROM idempotency_keys WHERE message_id = ?1",
      ["msg_1"],
    );
    assert.equal(after?.status, "completed");
    assert.match(
      after?.updated_at ?? "",
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  test(scenario("finalize on a non-pending row is rejected"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertReadyMessage(storage.db, "msg_1", "proj_1", 1, "spk_1", "obj_1");
    const timestamp = now();
    await insertIdempotency(storage.db, {
      speakerId: "spk_1",
      projectId: "proj_1",
      key: "key-1",
      payloadDigest: "sha256:abc",
      messageId: "msg_1",
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    });

    await assert.rejects(
      finalizeMessage(storage.db, {
        projectId: "proj_1",
        messageId: "msg_1",
        bodyObjectId: "obj_1",
        committedAt: now(),
      }),
      NotFoundError,
    );

    const message = await storage.db.first<{
      body_state: string;
      seq: number;
    }>("SELECT body_state, seq FROM messages WHERE id = ?1", ["msg_1"]);
    assert.equal(message?.body_state, "ready");
    assert.equal(message?.seq, 1);
    const idempotency = await storage.db.first<{ status: string }>(
      "SELECT status FROM idempotency_keys WHERE message_id = ?1",
      ["msg_1"],
    );
    assert.equal(idempotency?.status, "pending");
  });

  test(scenario("an inactive project rejects finalize without publishing"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_off", "acct_1", "suspended");
    await insertBodyObject(storage.db, "obj_1", "proj_off", "blobs/off");
    await insertPendingMessage(storage.db, "msg_1", "proj_off", "spk_1");

    await assert.rejects(
      finalizeMessage(storage.db, {
        projectId: "proj_off",
        messageId: "msg_1",
        bodyObjectId: "obj_1",
        committedAt: now(),
      }),
      NotFoundError,
    );

    const message = await storage.db.first<{
      seq: number | null;
      body_state: string;
    }>("SELECT seq, body_state FROM messages WHERE id = ?1", ["msg_1"]);
    assert.equal(message?.body_state, "pending");
    assert.equal(message?.seq, null);
    const project = await storage.db.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = ?1",
      ["proj_off"],
    );
    assert.equal(project?.next_seq, 0);
  });

  test(scenario("finalize stops after five conflicts without committing"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");
    const alwaysConflicts = withTransientUniqueFailures(storage.db, 5);

    await assert.rejects(
      finalizeMessage(alwaysConflicts, {
        projectId: "proj_1",
        messageId: "msg_1",
        bodyObjectId: "obj_1",
        committedAt: now(),
      }),
      ConflictError,
    );

    const message = await storage.db.first<{
      seq: number | null;
      body_state: string;
    }>("SELECT seq, body_state FROM messages WHERE id = ?1", ["msg_1"]);
    assert.equal(message?.body_state, "pending");
    assert.equal(message?.seq, null);
    const project = await storage.db.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = ?1",
      ["proj_1"],
    );
    assert.equal(project?.next_seq, 0);
  });

  test(scenario("lifecycle CHECKs reject invalid message states"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    const timestamp = now();

    await assert.rejects(
      storage.db.run(
        "INSERT INTO messages (id, project_id, sender_speaker_id, seq, summary, type, language, received_at, body_state) VALUES (?1, ?2, ?3, 1, 'summary', 'request', 'en', ?4, 'pending')",
        ["msg_pending_seq", "proj_1", "spk_1", timestamp],
      ),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      storage.db.run(
        "INSERT INTO messages (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, committed_at, body_object_id, body_state) VALUES (?1, ?2, NULL, ?3, 'summary', 'request', 'en', ?4, ?4, ?5, 'ready')",
        ["msg_ready_no_seq", "proj_1", "spk_1", timestamp, "obj_1"],
      ),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      storage.db.run(
        "INSERT INTO messages (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, committed_at, body_object_id, body_state) VALUES (?1, ?2, 1, ?3, 'summary', 'request', 'en', ?4, ?4, NULL, 'ready')",
        ["msg_ready_no_object", "proj_1", "spk_1", timestamp],
      ),
      /CHECK constraint failed/,
    );
    await assert.rejects(
      storage.db.run(
        "INSERT INTO messages (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, committed_at, body_object_id, body_state) VALUES (?1, ?2, 1, ?3, 'summary', 'request', 'en', ?4, NULL, ?5, 'ready')",
        ["msg_ready_no_commit", "proj_1", "spk_1", timestamp, "obj_1"],
      ),
      /CHECK constraint failed/,
    );
  });

  test(scenario("body_object_id foreign key rejects a missing object"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");

    await assert.rejects(
      insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1", "obj_missing"),
      /FOREIGN KEY constraint failed/,
    );
  });

  test(
    scenario("publish completes only the matching speaker/project idempotency row"),
    async (t) => {
      const storage = await openStorage();
      t.after(() => storage.dispose());
      await insertAccount(storage.db, "acct_1", "one@example.com");
      await insertSpeaker(storage.db, "spk_1", "acct_1");
      await insertSpeaker(storage.db, "spk_2", "acct_1");
      await insertProject(storage.db, "proj_1", "acct_1");
      await insertProject(storage.db, "proj_2", "acct_1");
      await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
      await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");
      const timestamp = now();
      const base = {
        payloadDigest: "sha256:abc",
        messageId: "msg_1",
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await insertIdempotency(storage.db, {
        ...base,
        speakerId: "spk_1",
        projectId: "proj_1",
        key: "match",
      });
      await insertIdempotency(storage.db, {
        ...base,
        speakerId: "spk_2",
        projectId: "proj_2",
        key: "other-speaker",
      });
      await insertIdempotency(storage.db, {
        ...base,
        speakerId: "spk_1",
        projectId: "proj_2",
        key: "other-project",
      });

      await finalizeMessage(storage.db, {
        projectId: "proj_1",
        messageId: "msg_1",
        bodyObjectId: "obj_1",
        committedAt: now(),
      });

      for (const [key, expected] of [
        ["match", "completed"],
        ["other-speaker", "pending"],
        ["other-project", "pending"],
      ] as const) {
        const row = await storage.db.first<{ status: string }>(
          "SELECT status FROM idempotency_keys WHERE key = ?1",
          [key],
        );
        assert.equal(row?.status, expected, `idempotency key ${key}`);
      }
    },
  );

  test(scenario("trigger repairs a zeroed next_seq with MAX"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());
    await insertAccount(storage.db, "acct_1", "one@example.com");
    await insertSpeaker(storage.db, "spk_1", "acct_1");
    await insertProject(storage.db, "proj_1", "acct_1");
    await insertBodyObject(storage.db, "obj_1", "proj_1", "blobs/obj_1");
    await insertPendingMessage(storage.db, "msg_1", "proj_1", "spk_1");

    // Simulate a damaged/restored counter: zero it, then publish a row that
    // already carries seq 7 through the trigger.
    await storage.db.run("UPDATE projects SET next_seq = 0 WHERE id = ?1", [
      "proj_1",
    ]);
    await storage.db.run(
      "UPDATE messages SET seq = 7, body_state = 'ready', committed_at = ?1, body_object_id = ?2 WHERE id = ?3 AND body_state = 'pending'",
      [now(), "obj_1", "msg_1"],
    );
    let project = await storage.db.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = ?1",
      ["proj_1"],
    );
    assert.equal(project?.next_seq, 7);

    await insertBodyObject(storage.db, "obj_2", "proj_1", "blobs/obj_2");
    await insertPendingMessage(storage.db, "msg_2", "proj_1", "spk_1");
    assert.equal(
      await finalizeMessage(storage.db, {
        projectId: "proj_1",
        messageId: "msg_2",
        bodyObjectId: "obj_2",
        committedAt: now(),
      }),
      8,
    );

    // MAX also prevents a stale publish from moving the counter backwards.
    await storage.db.run("UPDATE projects SET next_seq = 100 WHERE id = ?1", [
      "proj_1",
    ]);
    await insertBodyObject(storage.db, "obj_3", "proj_1", "blobs/obj_3");
    await insertPendingMessage(storage.db, "msg_3", "proj_1", "spk_1");
    await storage.db.run(
      "UPDATE messages SET seq = 3, body_state = 'ready', committed_at = ?1, body_object_id = ?2 WHERE id = ?3 AND body_state = 'pending'",
      [now(), "obj_3", "msg_3"],
    );
    project = await storage.db.first<{ next_seq: number }>(
      "SELECT next_seq FROM projects WHERE id = ?1",
      ["proj_1"],
    );
    assert.equal(project?.next_seq, 100);
  });

  test(scenario("body_objects has no plaintext_digest column"), async (t) => {
    const storage = await openStorage();
    t.after(() => storage.dispose());

    const columns = await storage.db.all<{ name: string }>(
      "PRAGMA table_info(body_objects)",
    );
    const names = columns.map((column) => column.name);
    assert.ok(names.includes("ciphertext_digest"));
    assert.equal(names.includes("plaintext_digest"), false);
  });
}
