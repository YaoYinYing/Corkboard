// Filesystem confidentiality checks. Production startup verifies the modes it
// depends on instead of assuming the best-effort hardening succeeded.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PrivateFilesystemPaths {
  dataDir: string;
  blobDir: string;
  databasePath: string;
}

export interface PrivateFilesystemCheck extends PrivateFilesystemPaths {
  production: boolean;
}

// Both the conventional production marker and an explicit opt-in are honored;
// see docs/security-operations.md.
export function requiresPrivateFilesystem(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env.NODE_ENV === "production" || env.CORKBOARD_REQUIRE_PRIVATE_FS === "1";
}

// Normalize away trailing separators, "." and ".." so a path such as
// "<symlink>/" cannot reach lstat in a different form than the one used later.
function normalize(path: string): string {
  return resolve(path);
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
}

// Pre-open guard: runs before any mkdir/chmod/open so a rejected redirect leaves
// the symlink target untouched. Missing paths are allowed (startup creates them).
// Only production calls this; non-production keeps the previous behavior.
export function assertNoPrivateFilesystemRedirects(paths: PrivateFilesystemPaths): void {
  const dataDir = normalize(paths.dataDir);
  const blobDir = normalize(paths.blobDir);
  const databasePath = normalize(paths.databasePath);

  for (const [path, label] of [
    [dataDir, "data directory"],
    [blobDir, "blob directory"],
  ] as const) {
    const stats = lstatOrUndefined(path);
    if (stats === undefined) continue;
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`${label} is not a directory: ${path}`);
    }
  }

  for (const [path, label] of [
    [databasePath, "database file"],
    [`${databasePath}-wal`, "database-wal file"],
    [`${databasePath}-shm`, "database-shm file"],
  ] as const) {
    const stats = lstatOrUndefined(path);
    if (stats === undefined) continue;
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not be a symbolic link: ${path}`);
    }
    if (!stats.isFile()) {
      throw new Error(`${label} is not a regular file: ${path}`);
    }
  }
}

function assertDirectory(path: string, label: string): void {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) {
    throw new Error(`${label} is missing or unreadable: ${path}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
  }
}

function assertRegularFile(path: string, label: string): void {
  const stats = lstatOrUndefined(path);
  if (stats === undefined) {
    throw new Error(`${label} is missing or unreadable: ${path}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  }
  if (!stats.isFile()) {
    throw new Error(`${label} is not a regular file: ${path}`);
  }
}

function assertMode(path: string, expected: number, label: string): void {
  let actual: number;
  try {
    actual = statSync(path).mode & 0o777;
  } catch {
    throw new Error(`${label} is missing or unreadable: ${path}`);
  }
  if (actual !== expected) {
    throw new Error(
      `${label} must have mode 0${expected.toString(8)}: ${path} (found 0${actual.toString(8)})`,
    );
  }
}

// Verifies every path the service reads or writes. Errors name the path and the
// expected mode only; no key material or content is included.
export function verifyPrivateFilesystem(check: PrivateFilesystemCheck): void {
  // Outside production the existing best-effort tightening in the SQLite and
  // blob adapters stays in effect; nothing new fails startup.
  if (!check.production) return;

  assertNoPrivateFilesystemRedirects(check);
  const dataDir = normalize(check.dataDir);
  const blobDir = normalize(check.blobDir);
  const databasePath = normalize(check.databasePath);

  assertDirectory(dataDir, "data directory");
  assertDirectory(blobDir, "blob directory");
  assertMode(dataDir, 0o700, "data directory");
  assertMode(blobDir, 0o700, "blob directory");

  assertRegularFile(databasePath, "database file");
  assertMode(databasePath, 0o600, "database file");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (lstatOrUndefined(sidecar) === undefined) continue;
    assertRegularFile(sidecar, `database${suffix} file`);
    assertMode(sidecar, 0o600, `database${suffix} file`);
  }

  for (const name of readdirSync(blobDir)) {
    const entry = join(blobDir, name);
    const stats = lstatSync(entry);
    if (stats.isSymbolicLink()) {
      throw new Error(`blob directory must not contain symbolic links: ${entry}`);
    }
    if (!stats.isFile()) {
      throw new Error(`blob directory must contain only files: ${entry}`);
    }
    assertMode(entry, 0o600, "blob file");
  }
}
