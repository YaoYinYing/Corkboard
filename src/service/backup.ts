// Operator backup and verified restore for the SQLite database + local blob
// pair. Read-only on the source; never reads or writes key material. The
// database snapshot uses SQLite's portable `VACUUM INTO`, which writes a single
// self-contained file and does not require copying `-wal`/`-shm` sidecars.
import { createHash } from "node:crypto";
import { constants as fsConstants, createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  expectedMigrationVersions,
  openSqliteDatabaseReadOnly,
  type ReadOnlySqlDatabase,
} from "../storage/db.ts";

export const BACKUP_FORMAT = "corkboard-backup";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_MANIFEST_FILE = "manifest.json";
export const BACKUP_DATABASE_FILE = "corkboard.sqlite";
export const BACKUP_BLOB_DIR = "blobs";

// Bounds keep a hostile or corrupt backup from exhausting memory or producing an
// unbounded report. A normal installation has one blob per committed body.
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_BLOB_ENTRIES = 100_000;
const MAX_VERIFY_ISSUES = 100;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
// A backup blob entry must be a plain basename: no separators, NUL, or
// traversal. Dots are allowed because a crash can leave a `.tmp-*` blob.
const SAFE_ENTRY_NAME = /^[A-Za-z0-9._-]{1,255}$/;

export class BackupError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BackupError";
    this.code = code;
  }
}

// The backup cannot be inspected at all (missing/unreadable/symlinked backup
// directory). Validation findings are reported as issues instead.
export class BackupInspectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupInspectError";
  }
}

export type BackupIssueCode =
  | "BACKUP_MANIFEST_MISSING"
  | "BACKUP_MANIFEST_TOO_LARGE"
  | "BACKUP_MANIFEST_INVALID"
  | "BACKUP_FORMAT_UNSUPPORTED"
  | "BACKUP_DATABASE_MISSING"
  | "BACKUP_DATABASE_SIZE_MISMATCH"
  | "BACKUP_DATABASE_DIGEST_MISMATCH"
  | "BACKUP_DATABASE_UNREADABLE"
  | "BACKUP_DATABASE_INTEGRITY_FAILED"
  | "BACKUP_BLOB_DIR_MISSING"
  | "BACKUP_BLOB_MISSING"
  | "BACKUP_BLOB_SIZE_MISMATCH"
  | "BACKUP_BLOB_DIGEST_MISMATCH"
  | "BACKUP_BLOB_REFERENCED_MISSING"
  | "BACKUP_FILE_UNEXPECTED"
  | "BACKUP_ENTRY_INVALID"
  | "BACKUP_SCHEMA_UNSUPPORTED"
  | "BACKUP_SCHEMA_AHEAD"
  | "BACKUP_SCHEMA_MISMATCH";

export interface VerifyIssue {
  code: BackupIssueCode;
  // Relative file name inside the backup only; never an absolute path.
  file?: string;
}

export interface BackupBlobEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  format_version: typeof BACKUP_FORMAT_VERSION;
  created_at: string;
  database: { file: string; size: number; sha256: string };
  blobs: BackupBlobEntry[];
  counts: { blobs: number; blob_bytes: number };
  schema_version: number;
}

export interface VerifyReport {
  ok: boolean;
  format_version: number | null;
  database: { file: string; size: number; sha256: string } | null;
  blobs: { count: number; bytes: number } | null;
  schema_version: number | null;
  issues: VerifyIssue[];
  issues_truncated: boolean;
}

export type RestoreErrorCode =
  | "RESTORE_VERIFY_FAILED"
  | "RESTORE_TARGET_SYMLINK"
  | "RESTORE_TARGET_NOT_DIRECTORY"
  | "RESTORE_TARGET_NOT_EMPTY"
  | "RESTORE_TARGET_INSIDE_BACKUP"
  | "RESTORE_COPY_MISMATCH"
  | "RESTORE_INTEGRITY_FAILED"
  | "RESTORE_SCHEMA_UNSUPPORTED"
  | "RESTORE_TARGET_CHANGED";

export class RestoreError extends Error {
  readonly code: RestoreErrorCode;
  readonly issues: VerifyIssue[];

  constructor(code: RestoreErrorCode, message: string, issues: VerifyIssue[] = []) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
    this.issues = issues;
  }
}

export interface BackupSummary {
  ok: true;
  format_version: number;
  created_at: string;
  database: { file: string; size: number; sha256: string };
  blobs: number;
  blob_bytes: number;
  schema_version: number;
}

export interface RestoreSummary {
  ok: true;
  restored: true;
  database: { file: string; size: number; sha256: string };
  blobs: number;
  blob_bytes: number;
  schema_version: number;
}

interface FileDigest {
  size: number;
  sha256: string;
}

interface DatabaseInspection {
  readable: boolean;
  integrityOk: boolean;
  schemaVersion: number | null;
  referencedKeys: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeEntryName(name: string): boolean {
  return name !== "." && name !== ".." && SAFE_ENTRY_NAME.test(name);
}

function isSize(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && SHA256_HEX.test(value);
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

async function lstatOrUndefined(
  path: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

// Open with O_NOFOLLOW so a symlink swapped in after the lstat check is never
// followed. The handle's own stat is authoritative for size and file type.
async function openRegularFile(path: string): Promise<Awaited<ReturnType<typeof open>>> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("entry is not a regular file");
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function digestFile(path: string): Promise<FileDigest> {
  const handle = await openRegularFile(path);
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      const bytes = chunk as Buffer;
      hash.update(bytes);
      size += bytes.length;
    }
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

async function copyFileWithDigest(source: string, destination: string): Promise<FileDigest> {
  const handle = await openRegularFile(source);
  try {
    const hash = createHash("sha256");
    let size = 0;
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback): void {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    });
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      meter,
      createWriteStream(destination, { flags: "wx", mode: 0o600 }),
    );
    await chmod(destination, 0o600);
    return { size, sha256: hash.digest("hex") };
  } finally {
    await handle.close();
  }
}

export function bundledSchemaVersion(): number {
  return expectedMigrationVersions().reduce(
    (highest, version) => Math.max(highest, version),
    0,
  );
}

async function inspectDatabaseFile(path: string): Promise<DatabaseInspection> {
  let db: ReadOnlySqlDatabase | undefined;
  try {
    db = await openSqliteDatabaseReadOnly(path);
    const integrityRows = await db.all<{ integrity_check: string }>(
      "PRAGMA integrity_check",
    );
    const integrityOk =
      integrityRows.length > 0 &&
      integrityRows.every((row) => row.integrity_check === "ok");

    let schemaVersion: number | null = null;
    const migrationsTable = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
    );
    if (migrationsTable !== undefined) {
      const row = await db.first<{ version: unknown }>(
        "SELECT MAX(version) AS version FROM schema_migrations",
      );
      const numeric = Number(row?.version);
      if (Number.isSafeInteger(numeric) && numeric > 0) schemaVersion = numeric;
    }

    let referencedKeys: string[] = [];
    if (integrityOk && schemaVersion !== null) {
      const rows = await db.all<{ storage_key: string }>(
        "SELECT storage_key FROM body_objects WHERE storage_key IS NOT NULL",
      );
      referencedKeys = rows.map((row) => row.storage_key);
    }
    return { readable: true, integrityOk, schemaVersion, referencedKeys };
  } catch {
    return {
      readable: false,
      integrityOk: false,
      schemaVersion: null,
      referencedKeys: [],
    };
  } finally {
    db?.close();
  }
}

function invalidManifest(): { manifest: null; issues: VerifyIssue[] } {
  return { manifest: null, issues: [{ code: "BACKUP_MANIFEST_INVALID" }] };
}

function parseManifest(raw: string): {
  manifest: BackupManifest | null;
  issues: VerifyIssue[];
} {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return invalidManifest();
  }
  if (!isRecord(value)) return invalidManifest();
  if (value.format !== BACKUP_FORMAT) return invalidManifest();
  if (value.format_version !== BACKUP_FORMAT_VERSION) {
    return { manifest: null, issues: [{ code: "BACKUP_FORMAT_UNSUPPORTED" }] };
  }
  if (
    typeof value.created_at !== "string" ||
    !ISO_UTC.test(value.created_at) ||
    Number.isNaN(Date.parse(value.created_at))
  ) {
    return invalidManifest();
  }
  const database = value.database;
  if (
    !isRecord(database) ||
    database.file !== BACKUP_DATABASE_FILE ||
    !isSize(database.size) ||
    !isSha256(database.sha256)
  ) {
    return invalidManifest();
  }
  const blobs = value.blobs;
  if (!Array.isArray(blobs) || blobs.length > MAX_BLOB_ENTRIES) {
    return invalidManifest();
  }
  const entries: BackupBlobEntry[] = [];
  const names = new Set<string>();
  let blobBytes = 0;
  for (const item of blobs) {
    if (
      !isRecord(item) ||
      typeof item.name !== "string" ||
      !isSafeEntryName(item.name) ||
      !isSize(item.size) ||
      !isSha256(item.sha256)
    ) {
      return invalidManifest();
    }
    if (names.has(item.name)) return invalidManifest();
    names.add(item.name);
    blobBytes += item.size;
    entries.push({ name: item.name, size: item.size, sha256: item.sha256 });
  }
  const counts = value.counts;
  if (
    !isRecord(counts) ||
    counts.blobs !== entries.length ||
    counts.blob_bytes !== blobBytes
  ) {
    return invalidManifest();
  }
  if (!isSize(value.schema_version) || value.schema_version < 1) {
    return invalidManifest();
  }
  return {
    manifest: {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      created_at: value.created_at,
      database: {
        file: BACKUP_DATABASE_FILE,
        size: database.size,
        sha256: database.sha256,
      },
      blobs: entries,
      counts: { blobs: entries.length, blob_bytes: blobBytes },
      schema_version: value.schema_version,
    },
    issues: [],
  };
}

async function readManifest(
  backupDir: string,
): Promise<{ manifest: BackupManifest | null; issues: VerifyIssue[] }> {
  const path = join(backupDir, BACKUP_MANIFEST_FILE);
  const entry = await lstatOrUndefined(path);
  if (entry === undefined) {
    return { manifest: null, issues: [{ code: "BACKUP_MANIFEST_MISSING" }] };
  }
  if (entry.isSymbolicLink() || !entry.isFile()) {
    return { manifest: null, issues: [{ code: "BACKUP_ENTRY_INVALID", file: BACKUP_MANIFEST_FILE }] };
  }
  if (entry.size > MAX_MANIFEST_BYTES) {
    return { manifest: null, issues: [{ code: "BACKUP_MANIFEST_TOO_LARGE" }] };
  }
  let raw: string;
  try {
    // O_NOFOLLOW plus the handle's own stat closes the lstat/read race.
    const handle = await openRegularFile(path);
    try {
      const stats = await handle.stat();
      if (stats.size > MAX_MANIFEST_BYTES) {
        return { manifest: null, issues: [{ code: "BACKUP_MANIFEST_TOO_LARGE" }] };
      }
      raw = await handle.readFile({ encoding: "utf8" });
    } finally {
      await handle.close();
    }
  } catch {
    throw new BackupInspectError("cannot read the backup manifest");
  }
  return parseManifest(raw);
}

async function assertInspectableBackupDir(backupDir: string): Promise<void> {
  const entry = await lstatOrUndefined(backupDir);
  if (entry === undefined) {
    throw new BackupInspectError("backup directory does not exist");
  }
  if (entry.isSymbolicLink()) {
    throw new BackupInspectError("backup directory is a symbolic link; refusing to follow");
  }
  if (!entry.isDirectory()) {
    throw new BackupInspectError("backup path is not a directory");
  }
}

async function inspectBlobs(
  backupDir: string,
  manifest: BackupManifest,
  add: (code: BackupIssueCode, file?: string) => void,
): Promise<void> {
  const blobDir = join(backupDir, BACKUP_BLOB_DIR);
  const blobDirEntry = await lstatOrUndefined(blobDir);
  if (blobDirEntry === undefined) {
    add("BACKUP_BLOB_DIR_MISSING", BACKUP_BLOB_DIR);
    return;
  }
  if (blobDirEntry.isSymbolicLink() || !blobDirEntry.isDirectory()) {
    add("BACKUP_ENTRY_INVALID", BACKUP_BLOB_DIR);
    return;
  }
  let diskEntries;
  try {
    diskEntries = await readdir(blobDir, { withFileTypes: true });
  } catch {
    throw new BackupInspectError("cannot read the backup blob directory");
  }
  const listed = new Set<string>();
  const expected = new Set(manifest.blobs.map((blob) => blob.name));
  for (const entry of [...diskEntries].sort(byName)) {
    if (!expected.has(entry.name)) {
      add("BACKUP_FILE_UNEXPECTED", `${BACKUP_BLOB_DIR}/${entry.name}`);
      continue;
    }
    listed.add(entry.name);
    if (!entry.isFile()) {
      add("BACKUP_ENTRY_INVALID", `${BACKUP_BLOB_DIR}/${entry.name}`);
    }
  }

  for (const blob of manifest.blobs) {
    if (!listed.has(blob.name)) {
      add("BACKUP_BLOB_MISSING", blob.name);
      continue;
    }
    const path = join(blobDir, blob.name);
    const entry = await lstatOrUndefined(path);
    if (entry === undefined) {
      add("BACKUP_BLOB_MISSING", blob.name);
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      add("BACKUP_ENTRY_INVALID", blob.name);
      continue;
    }
    if (entry.size !== blob.size) {
      add("BACKUP_BLOB_SIZE_MISMATCH", blob.name);
      continue;
    }
    let digest: FileDigest;
    try {
      digest = await digestFile(path);
    } catch {
      add("BACKUP_ENTRY_INVALID", blob.name);
      continue;
    }
    if (digest.sha256 !== blob.sha256) {
      add("BACKUP_BLOB_DIGEST_MISMATCH", blob.name);
    }
  }
}

export async function verifyBackup(input: { backupDir: string }): Promise<VerifyReport> {
  const backupDir = resolve(input.backupDir);
  await assertInspectableBackupDir(backupDir);

  const issues: VerifyIssue[] = [];
  let truncated = false;
  const add = (code: BackupIssueCode, file?: string): void => {
    if (issues.length < MAX_VERIFY_ISSUES) {
      issues.push(file === undefined ? { code } : { code, file });
    } else {
      truncated = true;
    }
  };
  const report: VerifyReport = {
    ok: false,
    format_version: null,
    database: null,
    blobs: null,
    schema_version: null,
    issues,
    issues_truncated: false,
  };

  const parsed = await readManifest(backupDir);
  if (parsed.manifest === null) {
    for (const issue of parsed.issues) issues.push(issue);
    report.issues_truncated = truncated;
    return report;
  }
  const manifest = parsed.manifest;
  report.format_version = manifest.format_version;
  report.database = manifest.database;
  report.blobs = {
    count: manifest.blobs.length,
    bytes: manifest.counts.blob_bytes,
  };
  report.schema_version = manifest.schema_version;

  let topEntries;
  try {
    topEntries = await readdir(backupDir, { withFileTypes: true });
  } catch {
    throw new BackupInspectError("cannot read the backup directory");
  }
  for (const entry of [...topEntries].sort(byName)) {
    if (entry.name === BACKUP_MANIFEST_FILE) {
      if (!entry.isFile()) add("BACKUP_ENTRY_INVALID", BACKUP_MANIFEST_FILE);
    } else if (entry.name === manifest.database.file) {
      if (!entry.isFile()) add("BACKUP_ENTRY_INVALID", manifest.database.file);
    } else if (entry.name === BACKUP_BLOB_DIR) {
      if (!entry.isDirectory()) add("BACKUP_ENTRY_INVALID", BACKUP_BLOB_DIR);
    } else {
      add("BACKUP_FILE_UNEXPECTED", entry.name);
    }
  }

  const databasePath = join(backupDir, manifest.database.file);
  let databaseDigestMatched = false;
  const databaseEntry = await lstatOrUndefined(databasePath);
  if (databaseEntry === undefined) {
    add("BACKUP_DATABASE_MISSING", manifest.database.file);
  } else if (databaseEntry.isSymbolicLink() || !databaseEntry.isFile()) {
    add("BACKUP_ENTRY_INVALID", manifest.database.file);
  } else if (databaseEntry.size !== manifest.database.size) {
    add("BACKUP_DATABASE_SIZE_MISMATCH", manifest.database.file);
  } else {
    try {
      const digest = await digestFile(databasePath);
      if (digest.sha256 !== manifest.database.sha256) {
        add("BACKUP_DATABASE_DIGEST_MISMATCH", manifest.database.file);
      } else {
        databaseDigestMatched = true;
      }
    } catch {
      add("BACKUP_ENTRY_INVALID", manifest.database.file);
    }
  }

  await inspectBlobs(backupDir, manifest, add);

  // Open the database only after its bytes match the manifest, so a tampered
  // file is never parsed.
  if (databaseDigestMatched) {
    const inspection = await inspectDatabaseFile(databasePath);
    if (!inspection.readable) {
      add("BACKUP_DATABASE_UNREADABLE", manifest.database.file);
    } else {
      if (!inspection.integrityOk) {
        add("BACKUP_DATABASE_INTEGRITY_FAILED", manifest.database.file);
      }
      if (inspection.schemaVersion === null) {
        add("BACKUP_SCHEMA_UNSUPPORTED", manifest.database.file);
      } else {
        if (inspection.schemaVersion > bundledSchemaVersion()) {
          add("BACKUP_SCHEMA_AHEAD", manifest.database.file);
        }
        if (inspection.schemaVersion !== manifest.schema_version) {
          add("BACKUP_SCHEMA_MISMATCH", manifest.database.file);
        }
        if (inspection.integrityOk) {
          const present = new Set(manifest.blobs.map((blob) => blob.name));
          for (const key of inspection.referencedKeys) {
            if (!present.has(key)) add("BACKUP_BLOB_REFERENCED_MISSING", key);
          }
        }
      }
    }
  }

  report.issues_truncated = truncated;
  report.ok = issues.length === 0;
  return report;
}

// VACUUM INTO is the portable SQLite snapshot: it reads under SQLite's own
// consistency rules (including a live WAL) and writes one standalone database.
function snapshotDatabase(sourcePath: string, targetPath: string): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(sourcePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(targetPath);
  } finally {
    db?.close();
  }
}

async function copyBlobs(
  sourceDir: string,
  targetDir: string,
): Promise<BackupBlobEntry[]> {
  await mkdir(targetDir, { mode: 0o700 });
  await chmod(targetDir, 0o700);
  const sourceEntry = await lstatOrUndefined(sourceDir);
  if (sourceEntry === undefined) return [];
  if (sourceEntry.isSymbolicLink() || !sourceEntry.isDirectory()) {
    throw new BackupError(
      "BACKUP_BLOB_DIR_INVALID",
      "blob path is not a directory or is a symbolic link; refusing to back up",
    );
  }
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch {
    throw new BackupError("BACKUP_BLOB_DIR_INVALID", "cannot read the blob directory");
  }
  if (entries.length > MAX_BLOB_ENTRIES) {
    throw new BackupError(
      "BACKUP_BLOB_LIMIT_EXCEEDED",
      `blob directory has more than ${MAX_BLOB_ENTRIES} entries`,
    );
  }
  const copied: BackupBlobEntry[] = [];
  for (const dirent of [...entries].sort(byName)) {
    if (!dirent.isFile()) {
      // Directories, symlinks, sockets and devices are never followed or
      // silently dropped: a faithful backup cannot represent them.
      throw new BackupError(
        "BACKUP_BLOB_ENTRY_INVALID",
        `blob entry is not a regular file: ${dirent.name}`,
      );
    }
    if (!isSafeEntryName(dirent.name)) {
      throw new BackupError(
        "BACKUP_BLOB_ENTRY_INVALID",
        "blob entry name is not a safe basename",
      );
    }
    const source = join(sourceDir, dirent.name);
    const destination = join(targetDir, dirent.name);
    let digest: FileDigest;
    try {
      digest = await copyFileWithDigest(source, destination);
    } catch {
      throw new BackupError(
        "BACKUP_BLOB_ENTRY_INVALID",
        `cannot copy blob entry: ${dirent.name}`,
      );
    }
    copied.push({ name: dirent.name, size: digest.size, sha256: digest.sha256 });
  }
  return copied;
}

async function assertBackupSource(dataDir: string): Promise<{
  dataDir: string;
  databasePath: string;
  blobDir: string;
}> {
  const resolved = resolve(dataDir);
  const dirEntry = await lstatOrUndefined(resolved);
  if (dirEntry === undefined) {
    throw new BackupError("BACKUP_SOURCE_MISSING", "data directory does not exist");
  }
  if (dirEntry.isSymbolicLink()) {
    throw new BackupError(
      "BACKUP_SOURCE_SYMLINK",
      "data directory is a symbolic link; refusing to follow",
    );
  }
  if (!dirEntry.isDirectory()) {
    throw new BackupError("BACKUP_SOURCE_INVALID", "data directory is not a directory");
  }
  const databasePath = join(resolved, BACKUP_DATABASE_FILE);
  const dbEntry = await lstatOrUndefined(databasePath);
  if (dbEntry === undefined) {
    throw new BackupError("BACKUP_SOURCE_MISSING", "database file does not exist");
  }
  if (dbEntry.isSymbolicLink() || !dbEntry.isFile()) {
    throw new BackupError(
      "BACKUP_SOURCE_INVALID",
      "database path is not a regular file (including a symlink)",
    );
  }
  return { dataDir: resolved, databasePath, blobDir: join(resolved, BACKUP_BLOB_DIR) };
}

export async function createBackup(input: {
  dataDir: string;
  outDir: string;
  now?: () => Date;
}): Promise<BackupSummary> {
  const source = await assertBackupSource(input.dataDir);
  const outDir = resolve(input.outDir);
  const parent = dirname(outDir);
  const parentEntry = await lstatOrUndefined(parent);
  if (parentEntry === undefined || parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new BackupError(
      "BACKUP_OUT_PARENT_INVALID",
      "the backup output parent directory must already exist and be a real directory",
    );
  }
  const outEntry = await lstatOrUndefined(outDir);
  if (outEntry !== undefined) {
    throw new BackupError(
      "BACKUP_OUT_EXISTS",
      "backup output already exists; refusing to overwrite",
    );
  }

  // A backup inside the source data directory would include itself and blur
  // source/target separation.
  const canonicalSource = await realpath(source.dataDir);
  const canonicalOut = join(await realpath(parent), basename(outDir));
  if (
    canonicalOut === canonicalSource ||
    canonicalOut.startsWith(`${canonicalSource}${sep}`)
  ) {
    throw new BackupError(
      "BACKUP_OUT_INSIDE_SOURCE",
      "backup output must be outside the data directory",
    );
  }

  let created = false;
  try {
    await mkdir(outDir, { mode: 0o700 });
    created = true;
    await chmod(outDir, 0o700);

    const snapshotPath = join(outDir, BACKUP_DATABASE_FILE);
    try {
      snapshotDatabase(source.databasePath, snapshotPath);
    } catch {
      throw new BackupError("BACKUP_SNAPSHOT_FAILED", "could not create a database snapshot");
    }
    await chmod(snapshotPath, 0o600);

    const inspection = await inspectDatabaseFile(snapshotPath);
    if (!inspection.readable || !inspection.integrityOk) {
      throw new BackupError(
        "BACKUP_SOURCE_INTEGRITY_FAILED",
        "database snapshot failed the integrity check",
      );
    }
    if (inspection.schemaVersion === null) {
      throw new BackupError(
        "BACKUP_SCHEMA_UNSUPPORTED",
        "database has no bundled schema migration record",
      );
    }

    const copied = await copyBlobs(source.blobDir, join(outDir, BACKUP_BLOB_DIR));
    const created_at = (input.now?.() ?? new Date()).toISOString();
    if (!ISO_UTC.test(created_at) || Number.isNaN(Date.parse(created_at))) {
      throw new BackupError("BACKUP_CLOCK_INVALID", "system clock is not a valid UTC time");
    }
    const databaseDigest = await digestFile(snapshotPath);
    const blobs = [...copied].sort(byName);
    const blobBytes = blobs.reduce((total, blob) => total + blob.size, 0);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      format_version: BACKUP_FORMAT_VERSION,
      created_at,
      database: {
        file: BACKUP_DATABASE_FILE,
        size: databaseDigest.size,
        sha256: databaseDigest.sha256,
      },
      blobs,
      counts: { blobs: blobs.length, blob_bytes: blobBytes },
      schema_version: inspection.schemaVersion,
    };
    const manifestPath = join(outDir, BACKUP_MANIFEST_FILE);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(manifestPath, 0o600);
    await chmod(outDir, 0o700);

    return {
      ok: true,
      format_version: manifest.format_version,
      created_at: manifest.created_at,
      database: manifest.database,
      blobs: manifest.counts.blobs,
      blob_bytes: manifest.counts.blob_bytes,
      schema_version: manifest.schema_version,
    };
  } catch (error) {
    // Leave the source untouched and no half-written backup behind. Only the
    // directory this run created is removed.
    if (created) {
      await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}

async function readValidatedManifest(backupDir: string): Promise<BackupManifest> {
  const parsed = await readManifest(backupDir);
  if (parsed.manifest === null) {
    throw new RestoreError(
      "RESTORE_VERIFY_FAILED",
      "backup manifest is invalid; refusing to restore",
      parsed.issues,
    );
  }
  return parsed.manifest;
}

export async function restoreBackup(input: {
  backupDir: string;
  dataDir: string;
}): Promise<RestoreSummary> {
  const backupDir = resolve(input.backupDir);
  const report = await verifyBackup({ backupDir });
  if (
    !report.ok ||
    report.database === null ||
    report.blobs === null ||
    report.schema_version === null
  ) {
    throw new RestoreError(
      "RESTORE_VERIFY_FAILED",
      "backup verification failed; refusing to restore",
      report.issues,
    );
  }

  const dataDir = resolve(input.dataDir);
  const targetEntry = await lstatOrUndefined(dataDir);
  if (targetEntry !== undefined) {
    if (targetEntry.isSymbolicLink()) {
      throw new RestoreError(
        "RESTORE_TARGET_SYMLINK",
        "restore target is a symbolic link; refusing to follow",
      );
    }
    if (!targetEntry.isDirectory()) {
      throw new RestoreError(
        "RESTORE_TARGET_NOT_DIRECTORY",
        "restore target exists and is not a directory",
      );
    }
    let contents;
    try {
      contents = await readdir(dataDir);
    } catch {
      throw new RestoreError("RESTORE_TARGET_NOT_DIRECTORY", "cannot read restore target");
    }
    if (contents.length > 0) {
      throw new RestoreError(
        "RESTORE_TARGET_NOT_EMPTY",
        "restore target is not empty; refusing to overwrite",
      );
    }
  }

  const parent = dirname(dataDir);
  const parentEntry = await lstatOrUndefined(parent);
  if (parentEntry === undefined || parentEntry.isSymbolicLink() || !parentEntry.isDirectory()) {
    throw new RestoreError(
      "RESTORE_TARGET_NOT_DIRECTORY",
      "restore target parent must already exist and be a real directory",
    );
  }
  const canonicalParent = await realpath(parent);
  const canonicalTarget = join(canonicalParent, basename(dataDir));
  const canonicalBackup = await realpath(backupDir);
  if (
    canonicalTarget === canonicalBackup ||
    canonicalTarget.startsWith(`${canonicalBackup}${sep}`)
  ) {
    throw new RestoreError(
      "RESTORE_TARGET_INSIDE_BACKUP",
      "restore target must be outside the backup directory",
    );
  }

  const manifest = await readValidatedManifest(backupDir);
  const stagingDir = await mkdtemp(join(canonicalParent, `.${basename(dataDir)}.restore-`));
  let installed = false;
  try {
    await chmod(stagingDir, 0o700);

    const stagingDatabase = join(stagingDir, BACKUP_DATABASE_FILE);
    let databaseDigest: FileDigest;
    try {
      databaseDigest = await copyFileWithDigest(
        join(backupDir, manifest.database.file),
        stagingDatabase,
      );
    } catch {
      throw new RestoreError("RESTORE_COPY_MISMATCH", "could not copy the backup database");
    }
    if (
      databaseDigest.size !== manifest.database.size ||
      databaseDigest.sha256 !== manifest.database.sha256
    ) {
      throw new RestoreError(
        "RESTORE_COPY_MISMATCH",
        "backup database changed during restore",
      );
    }

    const stagingBlobs = join(stagingDir, BACKUP_BLOB_DIR);
    await mkdir(stagingBlobs, { mode: 0o700 });
    await chmod(stagingBlobs, 0o700);
    for (const blob of manifest.blobs) {
      let digest: FileDigest;
      try {
        digest = await copyFileWithDigest(
          join(backupDir, BACKUP_BLOB_DIR, blob.name),
          join(stagingBlobs, blob.name),
        );
      } catch {
        throw new RestoreError(
          "RESTORE_COPY_MISMATCH",
          `could not copy backup blob: ${blob.name}`,
        );
      }
      if (digest.size !== blob.size || digest.sha256 !== blob.sha256) {
        throw new RestoreError(
          "RESTORE_COPY_MISMATCH",
          `backup blob changed during restore: ${blob.name}`,
        );
      }
    }

    const inspection = await inspectDatabaseFile(stagingDatabase);
    if (!inspection.readable || !inspection.integrityOk) {
      throw new RestoreError(
        "RESTORE_INTEGRITY_FAILED",
        "restored database failed the integrity check",
      );
    }
    if (
      inspection.schemaVersion === null ||
      inspection.schemaVersion > bundledSchemaVersion()
    ) {
      throw new RestoreError(
        "RESTORE_SCHEMA_UNSUPPORTED",
        "restored database schema is missing or newer than this build",
      );
    }
    if (inspection.schemaVersion !== manifest.schema_version) {
      throw new RestoreError(
        "RESTORE_INTEGRITY_FAILED",
        "restored database schema does not match the manifest",
      );
    }

    // rename(2) is atomic within the same parent directory and refuses to
    // replace a non-empty target. A target created empty after the check is
    // replaced; a populated one makes this fail closed.
    try {
      await rename(stagingDir, dataDir);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOTEMPTY" || code === "EEXIST") {
        throw new RestoreError(
          "RESTORE_TARGET_CHANGED",
          "restore target changed while restoring; refusing to overwrite",
        );
      }
      throw new RestoreError("RESTORE_INTEGRITY_FAILED", "could not install the restored directory");
    }
    installed = true;

    return {
      ok: true,
      restored: true,
      database: manifest.database,
      blobs: manifest.counts.blobs,
      blob_bytes: manifest.counts.blob_bytes,
      schema_version: manifest.schema_version,
    };
  } catch (error) {
    if (!installed) {
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
    throw error;
  }
}
