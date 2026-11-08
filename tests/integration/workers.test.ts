// Worker entrypoint exercised locally: structural D1/R2 doubles and standard
// Request/Response only. This is not a live Workers/workerd run, a Cloudflare
// binding, a wrangler migration, or a deployment.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { generateSpeakerToken, hashSecret } from "../../src/auth/credentials.ts";
import { SCOPES } from "../../src/domain/authz.ts";
import {
  createWorkersHandler,
  type WorkersEnv,
  type WorkersHandler,
} from "../../src/platforms/workers/main.ts";
import { createD1Database } from "../../src/storage/d1.ts";
import type { SqlDatabase } from "../../src/storage/db.ts";
import { R2_READINESS_SENTINEL_KEY } from "../../src/storage/blobs/r2.ts";
import {
  applyD1Migrations,
  openD1Double,
  type D1Double,
} from "../helpers/d1-double.ts";
import {
  MemoryR2Bucket,
  openMemoryR2Bucket,
} from "../helpers/r2-double.ts";

const WORKERS_DIR = new URL("../../src/platforms/workers/", import.meta.url);

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

interface Fixture {
  db: SqlDatabase;
  env: WorkersEnv;
  pepper: Uint8Array;
  handler: WorkersHandler;
}

async function createFixture(t: TestContext): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-workers-"));
  const double: D1Double = openD1Double(join(dir, "workers.sqlite"));
  await applyD1Migrations(double);
  t.after(() => {
    double.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const env: WorkersEnv = {
    DB: double,
    BLOB_BUCKET: openMemoryR2Bucket(),
    CORKBOARD_ROOT_KEY: base64(crypto.getRandomValues(new Uint8Array(32))),
    CORKBOARD_CREDENTIAL_PEPPER: base64(pepper),
  };
  return {
    db: createD1Database(double),
    env,
    pepper,
    handler: createWorkersHandler(),
  };
}

function call(
  handler: WorkersHandler,
  env: WorkersEnv,
  path: string,
  options: {
    method?: string;
    token?: string;
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) {
    headers.set("authorization", `Bearer ${options.token}`);
  }
  let body: string | undefined;
  if (options.body !== undefined) {
    body = JSON.stringify(options.body);
    headers.set("content-type", "application/json");
  }
  return handler.fetch(
    new Request(`https://corkboard.example${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
    env,
  );
}

interface SeededActor {
  token: string;
  credentialId: string;
  speakerId: string;
}

async function seedActor(
  fx: Fixture,
  suffix: string,
  projectStatus = "active",
): Promise<SeededActor> {
  const stamp = new Date().toISOString();
  const accountId = `acct_${suffix}`;
  const speakerId = `spk_${suffix}`;
  const projectId = `proj_${suffix}`;
  const credentialId = `cred_${suffix}`;
  await fx.db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    [accountId, `${accountId}@example.test`, stamp],
  );
  await fx.db.run(
    "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [speakerId, accountId, suffix, stamp],
  );
  await fx.db.run(
    "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, ?, ?)",
    [projectId, accountId, projectId, projectStatus, stamp],
  );
  await fx.db.run(
    "INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at) VALUES (?, ?, ?, ?)",
    [projectId, speakerId, JSON.stringify(SCOPES), stamp],
  );
  const { token } = generateSpeakerToken();
  await fx.db.run(
    `INSERT INTO credentials
       (id, speaker_id, public_prefix, secret_verifier, scope_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      credentialId,
      speakerId,
      token.slice(0, 12),
      await hashSecret(token, fx.pepper),
      JSON.stringify(SCOPES),
      stamp,
    ],
  );
  await fx.db.run(
    "INSERT INTO credential_project_grants (credential_id, project_id, granted_at) VALUES (?, ?, ?)",
    [credentialId, projectId, stamp],
  );
  return { token, credentialId, speakerId };
}

function sendBody(text: string): Record<string, unknown> {
  return {
    summary: text,
    type: "request",
    language: "en",
    text,
    body_digest: digestOf(text),
  };
}

test("worker: healthz and readyz answer from the D1/R2 doubles without writes", async (t) => {
  const fx = await createFixture(t);
  const health = await call(fx.handler, fx.env, "/healthz");
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  // Readiness probes D1 and one R2 sentinel `head`; it never writes or scans.
  const ready = await call(fx.handler, fx.env, "/readyz");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });
  assert.deepEqual((fx.env.BLOB_BUCKET as MemoryR2Bucket).calls, [
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
  ]);

  assert.deepEqual(
    await fx.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM messages"),
    [{ count: 0 }],
  );
  assert.deepEqual(
    await fx.db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM idempotency_keys",
    ),
    [{ count: 0 }],
  );
});

test("worker: readyz fails closed when the R2 head rejects without leaking detail", async (t) => {
  const fx = await createFixture(t);
  const bucket = fx.env.BLOB_BUCKET as MemoryR2Bucket;
  const detail = ["bucket", "readiness", "detail"].join("-");
  bucket.failOn("head", new Error(detail));

  const ready = await call(fx.handler, fx.env, "/readyz");
  assert.equal(ready.status, 503);
  const text = await ready.text();
  assert.equal(text, JSON.stringify({ status: "unavailable" }));
  assert.equal(text.includes(detail), false);
  assert.equal(text.includes(R2_READINESS_SENTINEL_KEY), false);

  // The failing probe performed no write, delete, or scan.
  assert.deepEqual(bucket.calls, [
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
  ]);

  // Clearing the injection makes readiness healthy again, so the R2 path
  // recovers as well as the D1 path.
  bucket.clearFailure("head");
  const recovered = await call(fx.handler, fx.env, "/readyz");
  assert.equal(recovered.status, 200);
  assert.deepEqual(await recovered.json(), { status: "ready" });
  assert.deepEqual(bucket.calls, [
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
    { operation: "head", key: R2_READINESS_SENTINEL_KEY },
  ]);
});

test("worker: seeded account reads /me, sends, and reads the body", async (t) => {
  const fx = await createFixture(t);
  const actor = await seedActor(fx, "alice");

  const me = await call(fx.handler, fx.env, "/api/v1/me", { token: actor.token });
  assert.equal(me.status, 200);
  const identity = (await me.json()) as {
    speaker: { id: string };
    account: { id: string };
    projects: string[];
  };
  assert.equal(identity.speaker.id, actor.speakerId);
  assert.equal(identity.account.id, "acct_alice");
  assert.deepEqual(identity.projects, ["proj_alice"]);

  const sent = await call(fx.handler, fx.env, "/api/v1/projects/proj_alice/messages", {
    method: "POST",
    token: actor.token,
    headers: { "idempotency-key": "workers-key-1" },
    body: sendBody("hello from a worker-shaped handler"),
  });
  assert.equal(sent.status, 201);
  const sentBody = (await sent.json()) as { message_id: string; seq: number };
  assert.equal(typeof sentBody.message_id, "string");
  assert.equal(sentBody.seq, 1);

  const read = await call(
    fx.handler,
    fx.env,
    `/api/v1/projects/proj_alice/messages/${encodeURIComponent(sentBody.message_id)}/body`,
    { token: actor.token },
  );
  assert.equal(read.status, 200);
  const readBody = (await read.json()) as { text: string; digest: string };
  assert.equal(readBody.text, "hello from a worker-shaped handler");
  assert.equal(readBody.digest, digestOf("hello from a worker-shaped handler"));
});

test("worker: an unknown bearer is the uniform 401 and reads nothing", async (t) => {
  const fx = await createFixture(t);
  await seedActor(fx, "bob");

  for (const authorization of [
    `Bearer cb_${"A".repeat(40)}`,
    "Bearer malformed",
    undefined,
  ]) {
    const headers: Record<string, string> = {};
    if (authorization !== undefined) headers.authorization = authorization;
    const response = await call(
      fx.handler,
      fx.env,
      "/api/v1/projects/proj_bob/messages",
      { headers },
    );
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("www-authenticate"), "Bearer");
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "UNAUTHENTICATED");
    assert.equal(body.error.message.length > 0, true);
  }

  assert.deepEqual(
    await fx.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM messages"),
    [{ count: 0 }],
  );
});

test("worker: a disabled project fails closed before any write", async (t) => {
  const fx = await createFixture(t);
  const actor = await seedActor(fx, "carol", "disabled");

  const response = await call(
    fx.handler,
    fx.env,
    "/api/v1/projects/proj_carol/messages",
    {
      method: "POST",
      token: actor.token,
      headers: { "idempotency-key": "disabled-key-1" },
      body: sendBody("must not be written"),
    },
  );
  assert.equal(response.status, 404);
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(body.error.code, "NOT_FOUND");

  assert.deepEqual(
    await fx.db.all<{ count: number }>(
      "SELECT COUNT(*) AS count FROM idempotency_keys",
    ),
    [{ count: 0 }],
  );
  assert.deepEqual(
    await fx.db.all<{ count: number }>("SELECT COUNT(*) AS count FROM messages"),
    [{ count: 0 }],
  );
});

test("worker: missing or invalid configuration is a generic 503 and retries", async (t) => {
  const fx = await createFixture(t);
  const brokenValue = ["invalid", "config", "value"].join("-");
  const malformedPepper = ["%%%", "not", "base64"].join("");
  const shortPepper = base64(new Uint8Array(31));
  const assertGenericFailure = async (
    response: Response,
    leaked: readonly string[],
  ): Promise<void> => {
    assert.equal(response.status, 503);
    const body = await response.text();
    assert.match(body, /UNAVAILABLE/);
    assert.doesNotMatch(body, /CORKBOARD|BLOB_BUCKET|\bDB\b/);
    for (const value of leaked) {
      assert.equal(body.includes(value), false, `response leaked ${value}`);
    }
  };

  // Missing bindings fail before any parser runs.
  await assertGenericFailure(
    await fx.handler.fetch(
      new Request("https://corkboard.example/healthz"),
      {} as WorkersEnv,
    ),
    [],
  );

  // Invalid root key with a valid pepper fails at key import only.
  await assertGenericFailure(
    await fx.handler.fetch(
      new Request("https://corkboard.example/healthz"),
      { ...fx.env, CORKBOARD_ROOT_KEY: brokenValue },
    ),
    [brokenValue],
  );

  // Missing BLOB_BUCKET reaches and fails the binding check.
  await assertGenericFailure(
    await fx.handler.fetch(
      new Request("https://corkboard.example/healthz"),
      {
        DB: fx.env.DB,
        CORKBOARD_ROOT_KEY: fx.env.CORKBOARD_ROOT_KEY,
        CORKBOARD_CREDENTIAL_PEPPER: fx.env.CORKBOARD_CREDENTIAL_PEPPER,
      } as unknown as WorkersEnv,
    ),
    [],
  );

  // Valid root key, so these reach the pepper parser.
  await assertGenericFailure(
    await fx.handler.fetch(
      new Request("https://corkboard.example/healthz"),
      { ...fx.env, CORKBOARD_CREDENTIAL_PEPPER: malformedPepper },
    ),
    [malformedPepper],
  );
  await assertGenericFailure(
    await fx.handler.fetch(
      new Request("https://corkboard.example/healthz"),
      { ...fx.env, CORKBOARD_CREDENTIAL_PEPPER: shortPepper },
    ),
    [shortPepper],
  );

  // A failed build is not cached: the same isolate serves once configured.
  const recovered = await call(fx.handler, fx.env, "/healthz");
  assert.equal(recovered.status, 200);
});

test("worker: the entrypoint directory has no node: imports", () => {
  const files = readdirSync(WORKERS_DIR, { recursive: true })
    .map((name) => String(name))
    .filter((name) => name.endsWith(".ts"));
  assert.ok(files.length > 0);
  for (const name of files) {
    const source = readFileSync(new URL(name, WORKERS_DIR), "utf8");
    assert.doesNotMatch(source, /(?:from\s+|import\s*\()\s*["']node:/, name);
    assert.doesNotMatch(source, /\bimport\s*["']node:/, name);
    assert.doesNotMatch(source, /\brequire\s*\(\s*["']node:/, name);
  }
});
