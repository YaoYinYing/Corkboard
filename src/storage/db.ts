import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | null;

export interface SqlDatabase {
  exec(sql: string): Promise<void>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
}

const MIGRATION_FILE = /^(\d+)_.*\.sql$/;
// Built output lives at dist/src/storage/db.js, so the module-relative path
// needs dist/migrations. Fall back to the repo root for source/test runs.
const MODULE_MIGRATIONS_DIR = fileURLToPath(
  new URL("../../migrations/", import.meta.url),
);
const CWD_MIGRATIONS_DIR = join(process.cwd(), "migrations");

function migrationsDirectory(): string {
  return existsSync(MODULE_MIGRATIONS_DIR)
    ? MODULE_MIGRATIONS_DIR
    : CWD_MIGRATIONS_DIR;
}

interface Migration {
  version: number;
  path: string;
}

// Ordered by the leading number; the filename is informational. Duplicate
// versions are a deployment error rather than a silent skip.
function listMigrations(dir: string): Migration[] {
  const migrations: Migration[] = [];
  const versions = new Set<number>();
  for (const name of readdirSync(dir)) {
    const match = MIGRATION_FILE.exec(name);
    if (match === null) continue;
    const version = Number(match[1]);
    if (!Number.isSafeInteger(version) || version <= 0 || versions.has(version)) {
      throw new Error(`invalid or duplicate migration version: ${name}`);
    }
    versions.add(version);
    migrations.push({ version, path: join(dir, name) });
  }
  return migrations.sort((a, b) => a.version - b.version);
}

function applyMigrations(db: DatabaseSync): void {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const isApplied = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = ?1",
  );
  const record = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
  );
  for (const migration of listMigrations(migrationsDirectory())) {
    if (isApplied.get(migration.version) !== undefined) continue;
    // Each migration and its version row commit atomically. BEGIN IMMEDIATE
    // serializes concurrent upgraders; the in-transaction re-check makes a
    // loser skip cleanly instead of hitting a non-idempotent ALTER. A crash
    // rolls the migration SQL back, so the database stays reopenable. This
    // transaction is the local SQLite runner's job; migration SQL stays
    // D1-compatible.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (isApplied.get(migration.version) !== undefined) {
        db.exec("COMMIT");
        continue;
      }
      db.exec(readFileSync(migration.path, "utf8"));
      record.run(migration.version, new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // A failed statement may already have ended the transaction.
      }
      // Another connection may have committed this version while we waited.
      if (isApplied.get(migration.version) !== undefined) continue;
      throw error;
    }
  }
}

// The database directory is a private data directory: create it 0700 so the
// sidecars inherit protection. Creation failures propagate via the open.
function ensurePrivateDirectory(path: string): string | undefined {
  if (process.platform === "win32" || path === ":memory:") {
    return undefined;
  }
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

// Best-effort defense in depth: 0600 database and WAL sidecars. Only tighten a
// directory owned by the current user.
function securePermissions(path: string, dir: string | undefined): void {
  if (dir === undefined) {
    return;
  }
  try {
    const stats = statSync(dir);
    const uid = process.getuid?.();
    if (
      uid !== undefined &&
      stats.uid === uid &&
      (stats.mode & 0o777) !== 0o700
    ) {
      chmodSync(dir, 0o700);
    }
  } catch {
    // Best-effort; a failure here does not make the database unusable.
  }
  try {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) {
      if (existsSync(file)) {
        chmodSync(file, 0o600);
      }
    }
  } catch {
    // Best-effort; a failure here does not make the database unusable.
  }
}

function enableWriteAheadLogging(db: DatabaseSync): void {
  try {
    db.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/database is locked|database is busy/i.test(error.message)
    ) {
      throw error;
    }
    // busy_timeout is already set, so one retry absorbs a concurrent open.
    db.exec("PRAGMA journal_mode = WAL");
  }
}

export async function openSqliteDatabase(
  path: string,
): Promise<SqlDatabase & { close(): void }> {
  const dir = ensurePrivateDirectory(path);
  const db = new DatabaseSync(path);
  try {
    // Set busy_timeout before switching journal mode: concurrent opens of a
    // fresh file otherwise race the WAL transition and report "locked".
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    enableWriteAheadLogging(db);
    securePermissions(path, dir);
    applyMigrations(db);
    // WAL sidecars may appear after the migration writes.
    securePermissions(path, dir);
  } catch (error) {
    db.close();
    throw error;
  }

  return {
    async exec(sql: string): Promise<void> {
      db.exec(sql);
    },
    async all<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T[]> {
      const rows = db.prepare(sql).all(...(params ?? []));
      return rows.map((row) => ({ ...row })) as unknown as T[];
    },
    async first<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      const row = db.prepare(sql).get(...(params ?? []));
      return row === undefined ? undefined : ({ ...row } as unknown as T);
    },
    async run(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ changes: number }> {
      const result = db.prepare(sql).run(...(params ?? []));
      return { changes: Number(result.changes) };
    },
    close(): void {
      db.close();
    },
  };
}
