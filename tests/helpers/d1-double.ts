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

class DoubleStatement implements D1PreparedStatement {
  readonly database: DatabaseSync;
  readonly sql: string;
  readonly params: readonly D1Value[];

  constructor(
    database: DatabaseSync,
    sql: string,
    params: readonly D1Value[] = [],
  ) {
    this.database = database;
    this.sql = sql;
    this.params = params;
  }

  bind(...values: D1Value[]): D1PreparedStatement {
    return new DoubleStatement(this.database, this.sql, values);
  }

  async first<T = Record<string, unknown>>(
    columnName?: string,
  ): Promise<T | null> {
    const row = this.database
      .prepare(this.sql)
      .get(...this.params) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const copy = { ...row };
    return (columnName === undefined ? copy : copy[columnName]) as T;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const rows = this.database
      .prepare(this.sql)
      .all(...this.params) as Record<string, unknown>[];
    return {
      success: true,
      results: rows.map((row) => ({ ...row })) as T[],
      meta: { changes: 0 },
    };
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    const result = this.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      results: [] as T[],
      meta: { changes: Number(result.changes) },
    };
  }
}

class DoubleDatabase implements D1DatabaseLike {
  readonly database: DatabaseSync;

  constructor(path: string) {
    this.database = new DatabaseSync(path);
    this.database.exec("PRAGMA foreign_keys = ON");
  }

  prepare(sql: string): D1PreparedStatement {
    return new DoubleStatement(this.database, sql);
  }

  async exec(sql: string): Promise<{ count: number; duration: number }> {
    this.database.exec(sql);
    return { count: 0, duration: 0 };
  }

  // One real transaction around the whole batch: a failing statement rolls
  // every earlier one back, matching D1 batch atomicity.
  async batch<T = Record<string, unknown>>(
    statements: D1PreparedStatement[],
  ): Promise<D1Result<T>[]> {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
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

export type D1Double = D1DatabaseLike & { close(): void };

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

async function applyMigrations(d1: D1Double): Promise<void> {
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
        await applyMigrations(double);
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
