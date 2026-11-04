// Filesystem confidentiality checks. Production startup verifies the modes it
// depends on instead of assuming the best-effort hardening succeeded.

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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

function assertNotSymlink(path: string, label: string): void {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    throw new Error(`${label} is missing or unreadable: ${path}`);
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`${label} must not be a symbolic link: ${path}`);
  }
  if (!stats.isDirectory()) {
    throw new Error(`${label} is not a directory: ${path}`);
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

  assertNotSymlink(check.dataDir, "data directory");
  assertNotSymlink(check.blobDir, "blob directory");
  assertMode(check.dataDir, 0o700, "data directory");
  assertMode(check.blobDir, 0o700, "blob directory");
  assertMode(check.databasePath, 0o600, "database file");
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${check.databasePath}${suffix}`;
    try {
      lstatSync(sidecar);
    } catch {
      continue;
    }
    assertMode(sidecar, 0o600, `database${suffix} file`);
  }

  for (const name of readdirSync(check.blobDir)) {
    const entry = join(check.blobDir, name);
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
