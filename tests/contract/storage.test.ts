import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import {
  createSqliteContractStorage,
  runStorageContract,
} from "../helpers/temp-db.ts";

runStorageContract("sqlite", createSqliteContractStorage);

test(
  "d1: shared storage contract",
  {
    skip: "External gap: no D1 adapter, Cloudflare runtime, or credentials in this environment",
  },
  () => {
    // Once a D1 adapter exists, run:
    // runStorageContract("d1", createD1ContractStorage);
  },
);

test(
  "sqlite database, sidecars and directory permissions are private",
  { skip: process.platform === "win32" },
  async (t) => {
    const parent = mkdtempSync(join(tmpdir(), "corkboard-perm-"));
    t.after(() => rmSync(parent, { recursive: true, force: true }));
    const dir = join(parent, "data");
    const dbPath = join(dir, "corkboard.sqlite");

    const db = await openSqliteDatabase(dbPath);
    try {
      assert.equal(statSync(dbPath).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
      for (const suffix of ["-wal", "-shm"]) {
        const sidecar = `${dbPath}${suffix}`;
        if (existsSync(sidecar)) {
          assert.equal(statSync(sidecar).mode & 0o777, 0o600, suffix);
        }
      }
    } finally {
      db.close();
    }

    // An existing directory owned by the current user is tightened too.
    chmodSync(dir, 0o755);
    const reopened = await openSqliteDatabase(join(dir, "second.sqlite"));
    try {
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    } finally {
      reopened.close();
    }
  },
);

test("several connections can open the same file concurrently", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-multi-open-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "shared.sqlite");

  const first = await openSqliteDatabase(dbPath);
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => openSqliteDatabase(dbPath)),
  );
  try {
    for (const result of results) {
      assert.equal(result.status, "fulfilled");
      if (result.status !== "fulfilled") {
        continue;
      }
      const row = await result.value.first<{ version: number }>(
        "SELECT version FROM schema_migrations WHERE version = 1",
      );
      assert.equal(row?.version, 1);
    }
  } finally {
    for (const result of results) {
      if (result.status === "fulfilled") {
        result.value.close();
      }
    }
    first.close();
  }
});

test("built adapter opens its bundled migration from dist", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  execFileSync("npm", ["run", "build"], { cwd: repoRoot, stdio: "pipe" });
  execFileSync(
    process.execPath,
    [join(repoRoot, "scripts", "copy-migrations.ts")],
    { cwd: repoRoot, stdio: "pipe" },
  );
  assert.ok(existsSync(join(repoRoot, "dist", "migrations", "001_init.sql")));

  const dir = mkdtempSync(join(tmpdir(), "corkboard-built-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "built.sqlite");
  const moduleUrl = pathToFileURL(
    join(repoRoot, "dist", "src", "storage", "db.js"),
  ).href;

  // Run from a cwd with no migrations/ directory so only the module-relative
  // dist/migrations copy can satisfy the adapter.
  const script = `
import { openSqliteDatabase } from ${JSON.stringify(moduleUrl)};
const db = await openSqliteDatabase(${JSON.stringify(dbPath)});
const row = await db.first("SELECT version FROM schema_migrations WHERE version = 1");
if (row === undefined) throw new Error("migration not applied");
db.close();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    stdio: "pipe",
  });
  assert.ok(existsSync(dbPath));
});
