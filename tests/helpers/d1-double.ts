import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  D1DatabaseLike,
  D1PreparedStatement,
  D1Result,
  D1Value,
} from "../../src/storage/d1.ts";
import type { SqlDatabase } from "../../src/storage/db.ts";
import { createD1Database } from "../../src/storage/d1.ts";
import type {
  ContractStorage,
  ContractStorageFactory,
} from "./temp-db.ts";

// Test-only D1 driver. It implements the D1-like surface over a real SQLite
// file so the adapter and the shared storage contract exercise the same SQL and
// error text as production SQLite. It is not evidence that live Cloudflare D1
// executes this SQL; see TODO 325/362.
//
// `failOn(operation, error)` injects a rejection at the next and every later
// call of "query" (any prepared statement `first`/`all`/`run`, or `exec`) or
// "batch" until `clearFailure` is called. The error is thrown, never returned,
// so callers see the same failure shape as a rejected binding call.
// `failOnBatchStatement(index, error)` instead fails inside the batch's SQLite
// transaction at buffered statement `index`, after the earlier statements have
// executed; the whole batch still rolls back atomically. It stays active until
// `clearBatchStatementFailure`.

export type D1Operation = "query" | "batch";

export interface D1Call {
  operation: D1Operation;
  sql?: string;
}

class DoubleStatement implements D1PreparedStatement {
  readonly owner: DoubleDatabase;
  readonly sql: string;
  readonly params: readonly D1Value[];

  constructor(
    owner: DoubleDatabase,
    sql: string,
    params: readonly D1Value[] = [],
  ) {
    this.owner = owner;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: D1Value[]): D1PreparedStatement {
    return new DoubleStatement(this.owner, this.sql, values);
  }

  async first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null> {
    this.owner.recordQuery(this.sql);
    const row = this.owner.database
      .prepare(this.sql)
      .get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const copy = { ...row };
    return (columnName === undefined ? copy : copy[columnName]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.owner.recordQuery(this.sql);
    const rows = this.owner.database
      .prepare(this.sql)
      .all(...this.params) as Record<string, unknown>[];
    return {
      success: true,
      results: rows.map((row) => ({ ...row })) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    this.owner.recordQuery(this.sql);
    const result = this.owner.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes) },
    };
  }
}

class DoubleDatabase implements D1DatabaseLike {
  readonly database: DatabaseSync;
  readonly calls: D1Call[] = [];
  readonly #failures = new Map<D1Operation, Error>();
  #batchStatementFailure: { index: number; error: Error } | undefined;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  failOn(
    operation: D1Operation,
    error = new Error("d1 unavailable"),
  ): void {
    this.#failures.set(operation, error);
  }

  clearFailure(operation: D1Operation): void {
    this.#failures.delete(operation);
  }

  failOnBatchStatement(
    index: number,
    error = new Error("d1 statement failed"),
  ): void {
    if (!Number.isSafeInteger(index) || index < 0) {
      throw new RangeError("batch statement index must be a non-negative integer");
    }
    this.#batchStatementFailure = { index, error };
  }

  clearBatchStatementFailure(): void {
    this.#batchStatementFailure = undefined;
  }

  recordQuery(sql: string): void {
    this.record("query", sql);
  }

  record(operation: D1Operation, sql?: string): void {
    this.calls.push(sql === undefined ? { operation } : { operation, sql });
    const failure = this.#failures.get(operation);
    if (failure !== undefined) throw failure;
  }

  prepare(sql: string): D1PreparedStatement {
    return new DoubleStatement(this, sql);
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.recordQuery(sql);
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }

  // One real transaction around the whole batch: a failing statement rolls
  // every earlier one back, matching D1 batch atomicity. Transaction control
  // uses the raw handle so failure injection cannot disturb it.
  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.record("batch");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const [index, statement] of statements.entries()) {
        const injected = this.#batchStatementFailure;
        if (injected !== undefined && injected.index === index) {
          throw injected.error;
        }
        results.push(await statement.run<T>());
      }
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // A failed statement may already have ended the transaction.
      }
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }
}

export type D1Double = DoubleDatabase;

export function openD1Double(path: string): D1Double {
  return new DoubleDatabase(path);
}

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);
const MIGRATION_FILE = /^(\d+)_.*\.sql$/;

interface Migration {
  version: number;
  path: URL;
}

// Mirror db.ts: order by the leading number so a future migration is never
// silently skipped by the D1 contract run.
function listMigrations(): Migration[] {
  const migrations: Migration[] = [];
  const versions = new Set<number>();
  for (const name of readdirSync(MIGRATIONS_DIR)) {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    if (
      !Number.isSafeInteger(version) ||
      version <= 0 ||
      versions.has(version)
    ) {
      throw new Error(`invalid or duplicate migration version: ${name}`);
    }
    versions.add(version);
    migrations.push({ version, path: new URL(name, MIGRATIONS_DIR) });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

function now(): string {
  return new Date().toISOString();
}

export async function applyD1Migrations(d1: D1Double): Promise<void> {
  await d1.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  for (const migration of listMigrations()) {
    const applied = await d1
      .prepare("SELECT version FROM schema_migrations WHERE version = ?1")
      .bind(migration.version)
      .first();
    if (applied !== null) continue;
    await d1.exec(readFileSync(migration.path, "utf8"));
    await d1
      .prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
      )
      .bind(migration.version, now())
      .run();
  }
}

/**
 * D1-shaped contract handle: the adapter under test, backed by a SQLite-file
 * double. `reopen()` opens another double on the same file; `dispose()` closes
 * every handle and removes the temp directory.
 */
export const createD1ContractStorage: ContractStorageFactory =
  async (): Promise<ContractStorage> => {
    const dir = mkdtempSync(join(tmpdir(), "corkboard-d1-contract-"));
    const path = join(dir, "contract.sqlite");
    const handles = new Set<D1Double>();
    let disposed = false;

    const dispose = (): void => {
      if (disposed) return;
      disposed = true;
      for (const handle of handles) handle.close();
      handles.clear();
      rmSync(dir, { recursive: true, force: true });
    };

    const openHandle = async (): Promise<ContractStorage> => {
      let double: D1Double;
      try {
        double = openD1Double(path);
        await applyD1Migrations(double);
      } catch (error) {
        dispose();
        throw error;
      }
      handles.add(double);
      const db: SqlDatabase = createD1Database(double);
      return {
        db,
        reopen: openHandle,
        close(): void {
          if (handles.delete(double)) double.close();
        },
        dispose,
      };
    };

    return openHandle();
  };
