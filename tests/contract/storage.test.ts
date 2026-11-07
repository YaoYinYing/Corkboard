import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { openSqliteDatabase } from "../../src/storage/db.ts";
import { createD1ContractStorage } from "../helpers/d1-double.ts";
import {
  createSqliteContractStorage,
  runStorageContract,
} from "../helpers/temp-db.ts";

runStorageContract("sqlite", createSqliteContractStorage);
// D1-shaped double over a SQLite file. This exercises the D1 adapter and the
// same scenarios, but is not live Cloudflare D1 execution (TODO 325/362).
runStorageContract("d1", createD1ContractStorage);

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
        "SELECT version FROM schema_migrations WHERE version = 2",
      );
      assert.equal(row?.version, 2);
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

test("an existing v1 database receives the remaining migrations", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "corkboard-v1-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "legacy.sqlite");

  // Build a genuine v1 database: migration 001 recorded, and the slice-B index
  // deliberately absent (it was only added to the fresh 001 file).
  createLegacyV1(dbPath, repoRoot);

  const db = await openSqliteDatabase(dbPath);
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );

    const table = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'credential_project_grants'",
    );
    assert.equal(table?.name, "credential_project_grants");

    const index = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_messages_body_state_expires'",
    );
    assert.equal(index?.name, "idx_messages_body_state_expires");

    const columns = await db.all<{ name: string }>("PRAGMA table_info(audit_events)");
    assert.ok(columns.some((column) => column.name === "detail"));
  } finally {
    db.close();
  }
});

test("an interrupted migration rolls back and the database reopens", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "corkboard-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "legacy.sqlite");
  createLegacyV1(dbPath, repoRoot);

  // Simulate a crash between the non-idempotent ALTER and the version record:
  // execute the SQL inside an uncommitted transaction and close. SQLite rolls
  // the transaction back, so reopening must apply 002 cleanly.
  const crashing = new DatabaseSync(dbPath);
  crashing.exec("BEGIN IMMEDIATE");
  crashing.exec("ALTER TABLE audit_events ADD COLUMN detail TEXT");
  crashing.close();

  const check = new DatabaseSync(dbPath);
  try {
    const before = check.prepare("PRAGMA table_info(audit_events)").all() as Array<{
      name: string;
    }>;
    assert.equal(before.some((column) => column.name === "detail"), false);
  } finally {
    check.close();
  }

  const db = await openSqliteDatabase(dbPath);
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );
    const columns = await db.all<{ name: string }>("PRAGMA table_info(audit_events)");
    assert.equal(columns.filter((column) => column.name === "detail").length, 1);
  } finally {
    db.close();
  }
});

test("concurrent v1 upgrades serialize without duplicate-column errors", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "corkboard-concurrent-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "legacy.sqlite");
  createLegacyV1(dbPath, repoRoot);

  const moduleUrl = pathToFileURL(join(repoRoot, "src", "storage", "db.ts")).href;
  const script = `
import { openSqliteDatabase } from ${JSON.stringify(moduleUrl)};
const db = await openSqliteDatabase(${JSON.stringify(dbPath)});
db.close();
`;
  const codes = await Promise.all(
    Array.from({ length: 6 }, () =>
      new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          ["--input-type=module", "-e", script],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.on("exit", (code) => {
          if (code !== 0) process.stderr.write(stderr);
          resolve(code ?? 1);
        });
      }),
    ),
  );
  assert.deepEqual(codes, [0, 0, 0, 0, 0, 0]);

  const db = await openSqliteDatabase(dbPath);
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );
    const columns = await db.all<{ name: string }>("PRAGMA table_info(audit_events)");
    assert.equal(columns.filter((column) => column.name === "detail").length, 1);
  } finally {
    db.close();
  }
});

test("an existing v2 database receives migration 003 sessions", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "corkboard-v2-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "legacy.sqlite");

  createLegacyV2(dbPath, repoRoot);

  const db = await openSqliteDatabase(dbPath);
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );
    const table = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sessions'",
    );
    assert.equal(table?.name, "sessions");
    for (const index of ["idx_sessions_account", "idx_sessions_token_prefix"]) {
      const row = await db.first<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
        [index],
      );
      assert.equal(row?.name, index);
    }
    const columns = await db.all<{ name: string }>("PRAGMA table_info(sessions)");
    assert.deepEqual(
      columns.map((column) => column.name),
      [
        "id",
        "account_id",
        "token_prefix",
        "token_verifier",
        "csrf_verifier",
        "created_at",
        "last_seen_at",
        "expires_at",
        "revoked_at",
      ],
    );
  } finally {
    db.close();
  }
});

test("an existing v3 database receives migration 004 OAuth tables", async (t) => {
  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "corkboard-v3-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "legacy.sqlite");

  createLegacyV3(dbPath, repoRoot);

  const db = await openSqliteDatabase(dbPath);
  try {
    const versions = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    assert.deepEqual(
      versions.map((row) => row.version),
      [1, 2, 3, 4],
    );
    for (const table of [
      "oauth_clients",
      "oauth_authorization_codes",
      "oauth_refresh_tokens",
      "oauth_token_clients",
    ]) {
      const row = await db.first<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        [table],
      );
      assert.equal(row?.name, table);
    }
    const codeColumns = (await db.all<{ name: string }>(
      "PRAGMA table_info(oauth_authorization_codes)",
    )).map((column) => column.name);
    for (const column of [
      "client_id",
      "account_id",
      "speaker_id",
      "project_id",
      "session_id",
      "scopes_json",
      "code_prefix",
      "code_verifier_hash",
      "redirect_uri",
      "resource",
      "expires_at",
      "consumed_at",
    ]) {
      assert.ok(codeColumns.includes(column), `missing column ${column}`);
    }
    const clientColumns = (await db.all<{ name: string }>(
      "PRAGMA table_info(oauth_clients)",
    )).map((column) => column.name);
    for (const column of [
      "client_id",
      "redirect_uris_json",
      "grant_types_json",
      "response_types_json",
    ]) {
      assert.ok(clientColumns.includes(column), `missing column ${column}`);
    }
    const sessionIndex = await db.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
      ["idx_oauth_authorization_codes_session"],
    );
    assert.equal(sessionIndex?.name, "idx_oauth_authorization_codes_session");
  } finally {
    db.close();
  }
});

function createLegacyV3(dbPath: string, repoRoot: string): void {
  const legacy = new DatabaseSync(dbPath);
  for (const file of [
    "001_init.sql",
    "002_credential_project_grants.sql",
    "003_sessions.sql",
  ]) {
    legacy.exec(readFileSync(join(repoRoot, "migrations", file), "utf8"));
  }
  const insert = legacy.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  for (const version of [1, 2, 3]) insert.run(version, new Date().toISOString());
  legacy.close();
}

function createLegacyV2(dbPath: string, repoRoot: string): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(readFileSync(join(repoRoot, "migrations", "001_init.sql"), "utf8"));
  legacy.exec(
    readFileSync(join(repoRoot, "migrations", "002_credential_project_grants.sql"), "utf8"),
  );
  const insert = legacy.prepare(
    "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
  );
  insert.run(1, new Date().toISOString());
  insert.run(2, new Date().toISOString());
  legacy.close();
}

function createLegacyV1(dbPath: string, repoRoot: string): void {
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(readFileSync(join(repoRoot, "migrations", "001_init.sql"), "utf8"));
  legacy.exec("DROP INDEX IF EXISTS idx_messages_body_state_expires");
  legacy
    .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (1, ?)")
    .run(new Date().toISOString());
  legacy.close();
}

test("built adapter opens its bundled migration from dist", async (t) => {  const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
  const npmExecPath = process.env.npm_execpath;
  assert.ok(npmExecPath, "npm_execpath is required to build in tests");
  execFileSync(process.execPath, [npmExecPath, "run", "build"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  assert.ok(existsSync(join(repoRoot, "dist", "migrations", "001_init.sql")));
  assert.ok(existsSync(join(repoRoot, "dist", "migrations", "002_credential_project_grants.sql")));
  assert.ok(existsSync(join(repoRoot, "dist", "migrations", "003_sessions.sql")));
  assert.ok(existsSync(join(repoRoot, "dist", "migrations", "004_oauth.sql")));

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
const version = await db.first("SELECT version FROM schema_migrations WHERE version = 4");
if (version === undefined) throw new Error("migration 004 not applied");
const codeColumns = (await db.all("PRAGMA table_info(oauth_authorization_codes)")).map((c) => c.name);
const clientColumns = (await db.all("PRAGMA table_info(oauth_clients)")).map((c) => c.name);
for (const name of ["session_id"]) {
  if (!codeColumns.includes(name)) throw new Error("missing code column " + name);
}
for (const name of ["grant_types_json", "response_types_json"]) {
  if (!clientColumns.includes(name)) throw new Error("missing client column " + name);
}
const index = await db.first("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_oauth_authorization_codes_session'");
if (index === undefined) throw new Error("missing session index");
const ownership = await db.first("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'oauth_token_clients'");
if (ownership === undefined) throw new Error("missing oauth_token_clients");
db.close();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: dir,
    stdio: "pipe",
  });
  assert.ok(existsSync(dbPath));
});
