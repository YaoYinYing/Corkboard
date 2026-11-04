import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { openSqliteDatabase } from "../../src/storage/db.ts";

const script = fileURLToPath(new URL("../../scripts/corkboard.ts", import.meta.url));
const HOUR_MS = 60 * 60 * 1000;

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string> = {}): RunResult {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

function tempDir(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-prune-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function ago(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

function ahead(hours: number): string {
  return new Date(Date.now() + hours * HOUR_MS).toISOString();
}

// Seeds one eligible and one live row for each session/OAuth table. The
// credential is OAuth-issued (association) so it is eligible; the account email
// and token-like verifier exist so the CLI can be checked for disclosure.
async function seed(dataDir: string): Promise<void> {
  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    await db.run(
      "INSERT INTO accounts (id, email, status, created_at) VALUES ('acct_1', 'private@example.test', 'active', ?)",
      [ago(72)],
    );
    await db.run(
      "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES ('spk_1', 'acct_1', 'agent', 'active', ?)",
      [ago(72)],
    );
    await db.run(
      "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES ('proj_1', 'acct_1', 'ops', 'active', ?)",
      [ago(72)],
    );
    await db.run(
      `INSERT INTO oauth_clients
         (id, client_id, client_name, redirect_uris_json, grant_types_json,
          response_types_json, created_at, status)
       VALUES ('oac_1', 'cb_cli_1', 'client', '["https://client.example/cb"]',
               '["authorization_code","refresh_token"]', '["code"]', ?, 'active')`,
      [ago(72)],
    );
    // Eligible session (revoked three days ago) and a live one.
    await db.run(
      `INSERT INTO sessions
         (id, account_id, token_prefix, token_verifier, csrf_verifier,
          created_at, last_seen_at, expires_at, revoked_at)
       VALUES ('sess_over', 'acct_1', 'sess_over_prefix', 'verifier-over',
               'csrf-over', ?, ?, ?, ?)`,
      [ago(72), ago(72), ago(48), ago(72)],
    );
    await db.run(
      `INSERT INTO sessions
         (id, account_id, token_prefix, token_verifier, csrf_verifier,
          created_at, last_seen_at, expires_at, revoked_at)
       VALUES ('sess_live', 'acct_1', 'sess_live_prefix', 'verifier-live',
               'csrf-live', ?, ?, ?, NULL)`,
      [ago(1), ago(0), ahead(12)],
    );
    // Eligible (expired three days ago) and live authorization codes.
    for (const [id, expiresAt] of [
      ["code_over", ago(72)],
      ["code_live", ahead(1)],
    ] as const) {
      await db.run(
        `INSERT INTO oauth_authorization_codes
           (id, client_id, account_id, speaker_id, project_id, session_id, scopes_json,
            code_prefix, code_verifier_hash, redirect_uri, resource, expires_at,
            consumed_at, created_at)
         VALUES (?, 'cb_cli_1', 'acct_1', 'spk_1', 'proj_1', 'sess_live',
                 '["message.read"]', ?, 'hash', 'https://client.example/cb',
                 'https://corkboard.example', ?, NULL, ?)`,
        [id, id.padEnd(12, "x").slice(0, 12), expiresAt, ago(72)],
      );
    }
    // Eligible OAuth credential (revoked three days ago), with an association.
    await db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json,
          expires_at, revoked_at, created_at)
       VALUES ('cred_oat_over', 'spk_1', 'cb_oat_secret', 'token-verifier-secret',
               '["message.read"]', ?, ?, ?)`,
      [ahead(1), ago(72), ago(72)],
    );
    await db.run(
      "INSERT INTO oauth_token_clients (credential_id, client_id, created_at) VALUES ('cred_oat_over', 'cb_cli_1', ?)",
      [ago(72)],
    );
    // Live access credential (association retained).
    await db.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json,
          expires_at, revoked_at, created_at)
       VALUES ('cred_oat_live', 'spk_1', 'cb_oat_live_', 'live-verifier-secret',
               '["message.read"]', ?, NULL, ?)`,
      [ahead(1), ago(1)],
    );
    await db.run(
      "INSERT INTO oauth_token_clients (credential_id, client_id, created_at) VALUES ('cred_oat_live', 'cb_cli_1', ?)",
      [ago(1)],
    );
    // Eligible refresh row.
    await db.run(
      `INSERT INTO oauth_refresh_tokens
         (id, family_id, client_id, credential_id, token_prefix, token_verifier,
          created_at, expires_at, revoked_at, rotated_at)
       VALUES ('rt_over', 'fam_1', 'cb_cli_1', 'cred_oat_live', 'rt_over_pref',
               'refresh-verifier-secret', ?, ?, NULL, ?)`,
      [ago(72), ahead(24), ago(72)],
    );
  } finally {
    db.close();
  }
}

test("prune --json reports counts, is idempotent, and prints one line", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seed(dataDir);

  const first = run(["prune", "--data-dir", dataDir, "--json"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(first.stdout.trim()), {
    graceHours: 24,
    limit: 1000,
    sessions: 1,
    authorizationCodes: 1,
    refreshTokens: 1,
    tokenClients: 1,
    oauthCredentials: 1,
  });

  const second = run(["prune", "--data-dir", dataDir, "--json"]);
  assert.equal(second.status, 0, second.stderr);
  assert.deepEqual(JSON.parse(second.stdout.trim()), {
    graceHours: 24,
    limit: 1000,
    sessions: 0,
    authorizationCodes: 0,
    refreshTokens: 0,
    tokenClients: 0,
    oauthCredentials: 0,
  });
});

test("prune accepts CORKBOARD_DATA_DIR and --limit/--grace-hours", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seed(dataDir);

  const result = run(["prune", "--json", "--limit", "2", "--grace-hours", "1"], {
    CORKBOARD_DATA_DIR: dataDir,
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout.trim()) as Record<string, number>;
  assert.equal(summary.graceHours, 1);
  assert.equal(summary.limit, 2);
});

test("prune without --json prints only short counts and leaks nothing", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seed(dataDir);

  const result = run(["prune", "--data-dir", dataDir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes("private@example.test"), false);
  assert.equal(result.stdout.includes("token-verifier-secret"), false);
  assert.equal(result.stdout.includes("refresh-verifier-secret"), false);
  assert.equal(result.stdout.includes("cb_oat_secret"), false);
  assert.match(result.stdout, /sessions deleted: 1/);
  assert.match(result.stdout, /oauth credentials deleted: 1/);
});

test("prune rejects usage and config errors with exit 2 before opening the database", (t) => {
  const root = tempDir(t);
  const fresh = join(root, "never-created");

  for (const args of [
    ["prune", "--data-dir", fresh, "--grace-hours", "-1"],
    ["prune", "--data-dir", fresh, "--grace-hours", "NaN"],
    ["prune", "--data-dir", fresh, "--grace-hours", "Infinity"],
    ["prune", "--data-dir", fresh, "--limit", "0"],
    ["prune", "--data-dir", fresh, "--limit", "10001"],
    ["prune", "--data-dir", fresh, "--limit", "1.5"],
    ["prune", "--data-dir", fresh, "--unknown-option"],
  ]) {
    const result = run(args);
    assert.equal(result.status, 2, `${args.join(" ")}: ${result.stderr}`);
    assert.equal(result.stdout, "");
  }
  assert.equal(existsSync(fresh), false, "validation must run before any mkdir/open");

  const missing = run(["prune"], {
    CORKBOARD_DATA_DIR: "",
  });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /data-dir|CORKBOARD_DATA_DIR/);
});

test("prune exits 1 and rolls back when a delete fails", async (t) => {
  const root = tempDir(t);
  const dataDir = join(root, "data");
  await seed(dataDir);

  const db = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    await db.exec(
      `CREATE TRIGGER fail_session_delete BEFORE DELETE ON sessions
       BEGIN SELECT RAISE(ABORT, 'injected cli failure'); END`,
    );
  } finally {
    db.close();
  }

  const failed = run(["prune", "--data-dir", dataDir, "--json"]);
  assert.equal(failed.status, 1, failed.stderr);
  assert.equal(failed.stdout, "");
  assert.match(failed.stderr, /injected cli failure/);

  const after = await openSqliteDatabase(join(dataDir, "corkboard.sqlite"));
  try {
    const sessions = await after.first<{ n: number }>("SELECT COUNT(*) AS n FROM sessions");
    const codes = await after.first<{ n: number }>(
      "SELECT COUNT(*) AS n FROM oauth_authorization_codes",
    );
    assert.equal(sessions?.n, 2);
    assert.equal(codes?.n, 2);
  } finally {
    after.close();
  }
});
