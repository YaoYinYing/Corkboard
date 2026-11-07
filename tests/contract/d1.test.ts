import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import type { SqlDatabase, SqlTransaction } from "../../src/storage/db.ts";
import {
  createD1Database,
  type D1DatabaseLike,
  type D1PreparedStatement,
  type D1Result,
} from "../../src/storage/d1.ts";
import { openD1Double, type D1Double } from "../helpers/d1-double.ts";

// Negative/behavioral tests unique to the D1 adapter. The shared contract in
// storage.test.ts covers everything both adapters must do; these cover the
// batch-only port (no interactive transactions).

function createFixture(t: TestContext): { db: SqlDatabase; double: D1Double } {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-d1-adapter-"));
  const double = openD1Double(join(dir, "adapter.sqlite"));
  t.after(() => {
    double.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { db: createD1Database(double), double };
}

function counting(double: D1Double): {
  database: D1DatabaseLike;
  batches: () => number;
} {
  let batches = 0;
  return {
    database: {
      prepare(sql: string): D1PreparedStatement {
        return double.prepare(sql);
      },
      exec(sql: string): Promise<unknown> {
        return double.exec(sql);
      },
      batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
        batches += 1;
        return double.batch<T>(statements);
      },
    },
    batches: () => batches,
  };
}

test("d1: a read inside a write-only transaction is rejected", async (t) => {
  const { db } = createFixture(t);
  const reads: Array<(tx: SqlTransaction) => Promise<unknown>> = [
    (tx) => tx.first("SELECT 1 AS value"),
    (tx) => tx.all("SELECT 1 AS value"),
  ];
  for (const read of reads) {
    await assert.rejects(
      db.transaction(read),
      /D1 has no interactive transactions; write-only callbacks only/,
    );
  }
});

test("d1: a transaction callback must not return a value", async (t) => {
  const { db } = createFixture(t);
  await assert.rejects(
    db.transaction(async () => "unexpected"),
    /D1 transactions are write-only; the callback must not return a value/,
  );
});

test("d1: a throwing callback submits no batch and writes nothing", async (t) => {
  const { double } = createFixture(t);
  await double.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  const counted = counting(double);
  const db = createD1Database(counted.database);

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run("INSERT INTO items (id) VALUES (?1)", ["a"]);
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(counted.batches(), 0);
  assert.equal(
    await db.first("SELECT id FROM items WHERE id = ?1", ["a"]),
    undefined,
  );
});

test("d1: a batch failure surfaces and leaves no partial rows", async (t) => {
  const { db, double } = createFixture(t);
  await double.exec(`
    CREATE TABLE parents (id TEXT PRIMARY KEY);
    CREATE TABLE children (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parents (id)
    );
  `);

  await assert.rejects(
    db.transaction(async (tx) => {
      await tx.run("INSERT INTO parents (id) VALUES (?1)", ["p1"]);
      await tx.run(
        "INSERT INTO children (id, parent_id) VALUES (?1, ?2)",
        ["c1", "missing"],
      );
    }),
    /FOREIGN KEY constraint failed/,
  );

  assert.equal(
    await db.first("SELECT id FROM parents WHERE id = ?1", ["p1"]),
    undefined,
  );
});

test("d1: buffered statements commit atomically in one batch", async (t) => {
  const { double } = createFixture(t);
  await double.exec("CREATE TABLE items (id TEXT PRIMARY KEY)");
  const counted = counting(double);
  const db = createD1Database(counted.database);

  await db.transaction(async (tx) => {
    await tx.run("INSERT INTO items (id) VALUES (?1)", ["a"]);
    await tx.run("INSERT INTO items (id) VALUES (?1)", ["b"]);
  });

  assert.equal(counted.batches(), 1);
  const rows = await db.all<{ id: string }>("SELECT id FROM items ORDER BY id");
  assert.deepEqual(
    rows.map((row) => row.id),
    ["a", "b"],
  );
});

test("d1: binding, first/all rows and run changes are correct", async (t) => {
  const { db, double } = createFixture(t);
  await double.exec(
    "CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT NOT NULL)",
  );

  assert.equal(
    (
      await db.run("INSERT INTO items (id, name) VALUES (?1, ?2)", [
        "a",
        "alpha",
      ])
    ).changes,
    1,
  );
  assert.equal(
    (
      await db.run("UPDATE items SET name = ?1 WHERE id = ?2", [
        "beta",
        "missing",
      ])
    ).changes,
    0,
  );
  assert.deepEqual(
    await db.first<{ name: string }>(
      "SELECT name FROM items WHERE id = ?1",
      ["a"],
    ),
    { name: "alpha" },
  );
  assert.deepEqual(
    await db.all<{ name: string }>("SELECT name FROM items WHERE id = ?1", [
      "a",
    ]),
    [{ name: "alpha" }],
  );
  assert.equal(
    await db.first("SELECT id FROM items WHERE id = ?1", ["missing"]),
    undefined,
  );
});
