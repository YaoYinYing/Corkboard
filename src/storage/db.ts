import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | null;

// Refuse to open an installation migrated by a newer build: the older server
// does not know the newer schema and must not write against it.
export class SchemaTooNewError extends Error {
  readonly code = "SCHEMA_TOO_NEW";

  constructor(message: string) {
    super(message);
    this.name = "SchemaTooNewError";
  }
}

// Statement surface available to a transaction callback. It deliberately has no
// `exec` or nested `transaction`, so a callback cannot issue transaction control
// or start a nested transaction by accident.
export interface SqlTransaction {
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
}

export interface SqlDatabase extends SqlTransaction {
  exec(sql: string): Promise<void>;
  /**
   * Runs `fn` inside one transaction and commits only when it resolves; any
   * throw rolls back. The callback must use only the supplied handle. D1 has
   * no interactive transactions, so a future adapter must buffer a write-only
   * callback and submit it with `batch()`, with no callback-visible results.
   * Only project creation (two inserts) and session message-send publication
   * (one conditional UPDATE carrying its authorization predicate) are
   * write-only, result-independent callers today. Credential issuance,
   * credential revocation, and membership add/remove are read-then-write
   * callbacks; a D1 adapter cannot emulate them without a documented
   * read-snapshot strategy, which remains pre-existing debt. No batch-emulated
   * result may depend on an in-transaction read or affected-row count.
   */
  transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T>;
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
  const migrations = listMigrations(migrationsDirectory());
  const highestBundled = migrations.reduce(
    (highest, migration) => Math.max(highest, migration.version),
    0,
  );
  // Fail before applying anything when the database was migrated by a newer
  // server. An older binary does not understand the newer schema.
  const appliedVersions = db
    .prepare("SELECT version FROM schema_migrations")
    .all() as Array<{ version: unknown }>;
  for (const row of appliedVersions) {
    const version = Number(row.version);
    if (Number.isSafeInteger(version) && version > highestBundled) {
      throw new SchemaTooNewError(
        `database schema version ${version} is newer than this server supports (highest bundled version ${highestBundled}); refusing to open`,
      );
    }
  }
  const isApplied = db.prepare(
    "SELECT version FROM schema_migrations WHERE version = ?1",
  );
  const record = db.prepare(
    "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?1, ?2)",
  );
  for (const migration of migrations) {
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

// The migration set shipped with this build. Diagnostics compare it with the
// versions recorded in an installation without applying anything.
export function expectedMigrationVersions(): number[] {
  return listMigrations(migrationsDirectory()).map((migration) => migration.version);
}

// Every table the bundled migrations create. Diagnostics use this instead of a
// hand-maintained subset so a database missing any core table is incomplete.
export function expectedSchemaTables(): string[] {
  const tables = new Set<string>();
  const createTable =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const migration of listMigrations(migrationsDirectory())) {
    const sql = readFileSync(migration.path, "utf8");
    for (const match of sql.matchAll(createTable)) {
      const name = match[1];
      if (name !== undefined) tables.add(name);
    }
  }
  return [...tables].sort();
}

// Minimal read-only surface: no exec/run, so diagnostics cannot write.
export interface ReadOnlySqlDatabase {
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
  close(): void;
}

function regularFileEntry(path: string): { isFile: boolean } | undefined {
  try {
    return { isFile: lstatSync(path).isFile() };
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

function isWalModeDatabase(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(20);
    const read = readSync(fd, header, 0, header.length, 0);
    // Bytes 18-19 are the write/read version; 2 means WAL.
    return read === 20 && header[18] === 2 && header[19] === 2;
  } finally {
    closeSync(fd);
  }
}

// Read-only open target. With no WAL sidecars the main file is a
// self-contained snapshot, so `immutable=1` avoids creating `-shm`/`-wal`; with
// both sidecars present a read-only connection reads the live WAL without
// creating files. A lone or non-regular sidecar is a crash-recovery/redirect
// state that cannot be inspected without writing.
export function sqliteReadOnlyOpenTarget(path: string): string {
  if (!isWalModeDatabase(path)) return path;
  const wal = regularFileEntry(`${path}-wal`);
  const shm = regularFileEntry(`${path}-shm`);
  // Match production startup: a symlinked (or otherwise non-regular) sidecar
  // is a redirect and is never followed.
  if ((wal !== undefined && !wal.isFile) || (shm !== undefined && !shm.isFile)) {
    throw new Error("database sidecar is not a regular file");
  }
  const hasWal = wal !== undefined;
  const hasShm = shm !== undefined;
  if (!hasWal && !hasShm) {
    return `${pathToFileURL(path).href}?immutable=1`;
  }
  if (!hasWal || !hasShm) {
    throw new Error("database has inconsistent write-ahead log sidecars");
  }
  return path;
}

// Read-only open for operator diagnostics. It deliberately does not create the
// directory, change permissions, switch journal mode, or apply migrations.
export async function openSqliteDatabaseReadOnly(
  path: string,
): Promise<ReadOnlySqlDatabase> {
  const db = new DatabaseSync(sqliteReadOnlyOpenTarget(path), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA query_only = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return {
    async all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
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
    close(): void {
      db.close();
    },
  };
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

  // One connection serializes its work through a queue. Root statements and a
  // transaction therefore never overlap: a statement issued by another request
  // while a transaction is open waits for it to commit or roll back instead of
  // silently joining it. Operations inside the callback use `tx` directly.
  const raw = {
    exec(sql: string): void {
      db.exec(sql);
    },
    all<T>(sql: string, params?: readonly SqlValue[]): T[] {
      return db.prepare(sql).all(...(params ?? [])).map((row) => ({
        ...row,
      })) as unknown as T[];
    },
    first<T>(sql: string, params?: readonly SqlValue[]): T | undefined {
      const row = db.prepare(sql).get(...(params ?? []));
      return row === undefined ? undefined : ({ ...row } as unknown as T);
    },
    run(sql: string, params?: readonly SqlValue[]): { changes: number } {
      const result = db.prepare(sql).run(...(params ?? []));
      return { changes: Number(result.changes) };
    },
  };

  const tx: SqlTransaction = {
    async all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return raw.all<T>(sql, params);
    },
    async first<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      return raw.first<T>(sql, params);
    },
    async run(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ changes: number }> {
      return raw.run(sql, params);
    },
  };

  let tail: Promise<void> = Promise.resolve();
  function enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  return {
    exec(sql: string): Promise<void> {
      return enqueue(() => raw.exec(sql));
    },
    all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]> {
      return enqueue(() => raw.all<T>(sql, params));
    },
    first<T>(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<T | undefined> {
      return enqueue(() => raw.first<T>(sql, params));
    },
    run(
      sql: string,
      params?: readonly SqlValue[],
    ): Promise<{ changes: number }> {
      return enqueue(() => raw.run(sql, params));
    },
    transaction<T>(fn: (tx: SqlTransaction) => Promise<T>): Promise<T> {
      return enqueue(async () => {
        raw.exec("BEGIN IMMEDIATE");
        try {
          const result = await fn(tx);
          raw.exec("COMMIT");
          return result;
        } catch (error) {
          try {
            raw.exec("ROLLBACK");
          } catch {
            // A failed statement may already have ended the transaction.
          }
          throw error;
        }
      });
    },
    close(): void {
      db.close();
    },
  };
}
