// Controlled D1/R2 failure injection through the Worker-shaped handler and the
// service write path: structural D1/R2 doubles, standard Request/Response only.
// This proves fail-closed mapping and recovery on those doubles. It is not a
// live Workers/workerd run, live Cloudflare D1/R2, a real network or OS fault,
// or two isolated deployment environments (TODO 368 stays unchecked).
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
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
import {
  SESSION_PREFIX_LENGTH,
  generateCsrfToken,
  generateSessionToken,
  CSRF_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from "../../src/service/sessions.ts";
import { createD1Database } from "../../src/storage/d1.ts";
import type { SqlDatabase } from "../../src/storage/db.ts";
import {
  applyD1Migrations,
  openD1Double,
  type D1Double,
} from "../helpers/d1-double.ts";
import {
  MemoryR2Bucket,
  openMemoryR2Bucket,
} from "../helpers/r2-double.ts";

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

interface Fixture {
  double: D1Double;
  bucket: MemoryR2Bucket;
  db: SqlDatabase;
  env: WorkersEnv;
  pepper: Uint8Array;
  handler: WorkersHandler;
}

async function createFixture(t: TestContext): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-failures-"));
  const double: D1Double = openD1Double(join(dir, "failures.sqlite"));
  await applyD1Migrations(double);
  t.after(() => {
    double.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const pepper = crypto.getRandomValues(new Uint8Array(32));
  const bucket = openMemoryR2Bucket();
  const env: WorkersEnv = {
    DB: double,
    BLOB_BUCKET: bucket,
    CORKBOARD_ROOT_KEY: base64(crypto.getRandomValues(new Uint8Array(32))),
    CORKBOARD_CREDENTIAL_PEPPER: base64(pepper),
  };
  return {
    double,
    bucket,
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

function formCall(
  fx: Fixture,
  path: string,
  cookie: string,
  body: string,
): Promise<Response> {
  return fx.handler.fetch(
    new Request(`https://corkboard.example${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie,
        origin: "https://corkboard.example",
      },
      body,
    }),
    fx.env,
  );
}

interface SeededActor {
  token: string;
  speakerId: string;
  projectId: string;
}

async function seedActor(fx: Fixture, suffix: string): Promise<SeededActor> {
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
    "INSERT INTO projects (id, owner_account_id, title, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [projectId, accountId, projectId, stamp],
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
  return { token, speakerId, projectId };
}

// A real account/session pair so the dashboard write path can be exercised
// without a login round-trip. The raw token and CSRF value are test-generated.
async function seedSession(fx: Fixture, suffix: string): Promise<{
  cookie: string;
  token: string;
  csrf: string;
  accountId: string;
  speakerId: string;
}> {
  const stamp = new Date().toISOString();
  const accountId = `acct_${suffix}`;
  const speakerId = `spk_${suffix}`;
  const token = generateSessionToken();
  const csrf = generateCsrfToken();
  await fx.db.run(
    "INSERT INTO accounts (id, email, status, created_at) VALUES (?, ?, 'active', ?)",
    [accountId, `${accountId}@example.test`, stamp],
  );
  await fx.db.run(
    "INSERT INTO speakers (id, owner_account_id, display_name, status, created_at) VALUES (?, ?, ?, 'active', ?)",
    [speakerId, accountId, suffix, stamp],
  );
  await fx.db.run(
    `INSERT INTO sessions
       (id, account_id, token_prefix, token_verifier, csrf_verifier,
        created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      `sess_${suffix}`,
      accountId,
      token.slice(0, SESSION_PREFIX_LENGTH),
      await hashSecret(token, fx.pepper),
      await hashSecret(csrf, fx.pepper),
      stamp,
      stamp,
      new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    ],
  );
  const cookie = [SESSION_COOKIE_NAME + "=" + token, CSRF_COOKIE_NAME + "=" + csrf].join("; ");
  return {
    cookie,
    token,
    csrf,
    accountId,
    speakerId,
  };
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

// Every injected failure must reach the client as the fixed envelope, with no
// injected driver text, binding name, token, or plaintext.
async function assertSanitizedUnavailable(
  response: Response,
  leaked: readonly string[],
): Promise<string> {
  assert.equal(response.status, 503);
  const text = await response.text();
  const parsed = JSON.parse(text) as {
    error?: { code?: string; message?: string };
  };
  assert.equal(parsed.error?.code, "UNAVAILABLE");
  assert.equal(parsed.error?.message, "Service unavailable");
  assert.doesNotMatch(
    text,
    /BLOB_BUCKET|SQLITE|CORKBOARD_ROOT_KEY|CORKBOARD_CREDENTIAL_PEPPER/,
  );
  for (const value of leaked) {
    assert.equal(text.includes(value), false, `response leaked ${value}`);
  }
  return text;
}

// Dashboard HTML routes map an unexpected failure to their fixed error page.
async function assertSanitizedWebError(
  response: Response,
  leaked: readonly string[],
): Promise<void> {
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.doesNotMatch(
    text,
    /BLOB_BUCKET|SQLITE|CORKBOARD_ROOT_KEY|CORKBOARD_CREDENTIAL_PEPPER/,
  );
  for (const value of leaked) {
    assert.equal(text.includes(value), false, `response leaked ${value}`);
  }
}

test("failure injection: an R2 put failure during send fails closed, then the same key resumes once", async (t) => {
  const fx = await createFixture(t);
  const actor = await seedActor(fx, "put");
  const detail = ["r2", "put", "detail"].join("-");
  const text = "plaintext that must never leak";
  const idempotencyKey = "r2-put-failure";
  fx.bucket.failOn("put", new Error(detail));

  const failed = await call(
    fx.handler,
    fx.env,
    `/api/v1/projects/${actor.projectId}/messages`,
    {
      method: "POST",
      token: actor.token,
      headers: { "idempotency-key": idempotencyKey },
      body: sendBody(text),
    },
  );
  await assertSanitizedUnavailable(failed, [detail, text, actor.token]);

  // The failure happened before the body record and message: nothing is
  // published. Only the pending idempotency reservation remains, by design.
  assert.deepEqual(await fx.db.all("SELECT id FROM messages"), []);
  assert.deepEqual(await fx.db.all("SELECT id FROM body_objects"), []);
  assert.deepEqual(await fx.db.all("SELECT message_id FROM message_receipts"), []);
  assert.deepEqual(
    await fx.db.all<{ status: string }>("SELECT status FROM idempotency_keys"),
    [{ status: "pending" }],
  );
  assert.deepEqual(
    fx.bucket.calls.map((entry) => entry.operation),
    ["put"],
  );

  // Clearing the injection lets the same idempotency key resume and publish
  // exactly one message (the pending reservation makes the handler report a
  // replay-shaped 200).
  fx.bucket.clearFailure("put");
  const retried = await call(
    fx.handler,
    fx.env,
    `/api/v1/projects/${actor.projectId}/messages`,
    {
      method: "POST",
      token: actor.token,
      headers: { "idempotency-key": idempotencyKey },
      body: sendBody(text),
    },
  );
  assert.equal(retried.status, 200);
  const sent = (await retried.json()) as { message_id: string; seq: number };
  assert.equal(typeof sent.message_id, "string");
  assert.equal(sent.seq, 1);

  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM messages"),
    [{ count: 1 }],
  );
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM body_objects"),
    [{ count: 1 }],
  );
  assert.deepEqual(
    await fx.db.all<{ status: string }>("SELECT status FROM idempotency_keys"),
    [{ status: "completed" }],
  );
  assert.equal(
    fx.bucket.calls.filter((entry) => entry.operation === "put").length,
    2,
  );
});

test("failure injection: an R2 get failure during a body read is a sanitized 503, never empty content", async (t) => {
  const fx = await createFixture(t);
  const actor = await seedActor(fx, "get");
  const text = "body that must stay hidden";
  const sentResponse = await call(
    fx.handler,
    fx.env,
    `/api/v1/projects/${actor.projectId}/messages`,
    {
      method: "POST",
      token: actor.token,
      headers: { "idempotency-key": "r2-get-failure" },
      body: sendBody(text),
    },
  );
  assert.equal(sentResponse.status, 201);
  const sent = (await sentResponse.json()) as { message_id: string };
  const bodyPath = `/api/v1/projects/${actor.projectId}/messages/${encodeURIComponent(sent.message_id)}/body`;

  const detail = ["r2", "get", "detail"].join("-");
  fx.bucket.failOn("get", new Error(detail));
  const failed = await call(fx.handler, fx.env, bodyPath, {
    token: actor.token,
  });
  const failedText = await assertSanitizedUnavailable(failed, [
    detail,
    text,
    actor.token,
  ]);
  const failedBody = JSON.parse(failedText) as Record<string, unknown>;
  // No partial or empty body is dressed up as message content.
  assert.equal("text" in failedBody, false);
  assert.equal("digest" in failedBody, false);
  assert.equal(
    fx.bucket.calls.filter((entry) => entry.operation === "get").length,
    1,
  );

  fx.bucket.clearFailure("get");
  const recovered = await call(fx.handler, fx.env, bodyPath, {
    token: actor.token,
  });
  assert.equal(recovered.status, 200);
  const body = (await recovered.json()) as { text: string; digest: string };
  assert.equal(body.text, text);
  assert.equal(body.digest, digestOf(text));
  assert.equal(
    fx.bucket.calls.filter((entry) => entry.operation === "get").length,
    2,
  );
});

test("failure injection: a D1 batch failure during a multi-row write leaves no partial rows and recovers", async (t) => {
  const fx = await createFixture(t);
  const session = await seedSession(fx, "batch");
  const detail = ["d1", "batch", "detail"].join("-");
  fx.double.failOn("batch", new Error(detail));

  const title = "Failure-injection project";
  const summary = "must not be half-created";
  const form = new URLSearchParams({
    title,
    summary,
    csrf_token: session.csrf,
  }).toString();
  const failed = await formCall(fx, "/projects", session.cookie, form);
  await assertSanitizedWebError(failed, [
    detail,
    session.csrf,
    session.token,
    title,
    summary,
  ]);

  // The project and its owner membership are inserted in one batch; the
  // rejection leaves neither row.
  assert.deepEqual(
    await fx.db.all("SELECT id FROM projects"),
    [],
  );
  assert.deepEqual(
    await fx.db.all("SELECT project_id FROM project_memberships"),
    [],
  );
  assert.ok(
    fx.double.calls.some((entry) => entry.operation === "batch"),
    "the write path must reach the D1 batch",
  );

  fx.double.clearFailure("batch");
  const recovered = await formCall(fx, "/projects", session.cookie, form);
  assert.equal(recovered.status, 303);
  assert.match(
    recovered.headers.get("location") ?? "",
    /^\/projects\/proj_[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM projects"),
    [{ count: 1 }],
  );
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM project_memberships"),
    [{ count: 1 }],
  );
});

test("failure injection: a mid-batch D1 failure after the first insert rolls the project create back atomically", async (t) => {
  const fx = await createFixture(t);
  const session = await seedSession(fx, "midbatch");
  const detail = ["d1", "mid", "batch", "detail"].join("-");
  // Fail the second buffered statement (the owner membership insert) inside the
  // same SQLite transaction, after the project insert has executed.
  fx.double.failOnBatchStatement(1, new Error(detail));

  const title = "Mid-batch rollback project";
  const summary = "the first insert must not survive";
  const form = new URLSearchParams({
    title,
    summary,
    csrf_token: session.csrf,
  }).toString();
  const failed = await formCall(fx, "/projects", session.cookie, form);
  await assertSanitizedWebError(failed, [
    detail,
    session.csrf,
    session.token,
    title,
    summary,
  ]);

  // The first INSERT ran inside the transaction before the injected failure, so
  // the empty tables are true rollback evidence, not a batch-entry rejection.
  assert.ok(
    fx.double.calls.some(
      (entry) =>
        entry.operation === "query" &&
        /INSERT INTO projects/.test(entry.sql ?? ""),
    ),
    "the project insert must execute before the second statement fails",
  );
  assert.equal(
    fx.double.calls.some(
      (entry) =>
        entry.operation === "query" &&
        /INSERT INTO project_memberships/.test(entry.sql ?? ""),
    ),
    false,
    "the failing statement must not execute",
  );
  assert.deepEqual(await fx.db.all("SELECT id FROM projects"), []);
  assert.deepEqual(
    await fx.db.all("SELECT project_id FROM project_memberships"),
    [],
  );

  fx.double.clearBatchStatementFailure();
  const recovered = await formCall(fx, "/projects", session.cookie, form);
  assert.equal(recovered.status, 303);
  assert.match(
    recovered.headers.get("location") ?? "",
    /^\/projects\/proj_[A-Za-z0-9_-]+$/,
  );
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM projects"),
    [{ count: 1 }],
  );
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM project_memberships"),
    [{ count: 1 }],
  );
});

test("failure injection: a D1 query failure on a read path is sanitized, returns no partial data, and readiness recovers", async (t) => {
  const fx = await createFixture(t);
  const actor = await seedActor(fx, "query");
  const text = "existing message";
  const sentResponse = await call(
    fx.handler,
    fx.env,
    `/api/v1/projects/${actor.projectId}/messages`,
    {
      method: "POST",
      token: actor.token,
      headers: { "idempotency-key": "d1-query-failure" },
      body: sendBody(text),
    },
  );
  assert.equal(sentResponse.status, 201);

  const detail = ["d1", "query", "detail"].join("-");
  fx.double.failOn("query", new Error(detail));
  const listPath = `/api/v1/projects/${actor.projectId}/messages`;
  const failed = await call(fx.handler, fx.env, listPath, {
    token: actor.token,
  });
  const failedText = await assertSanitizedUnavailable(failed, [
    detail,
    text,
    actor.token,
  ]);
  // No partial page: the envelope carries no message data at all.
  const failedBody = JSON.parse(failedText) as Record<string, unknown>;
  assert.equal("messages" in failedBody, false);

  const notReady = await call(fx.handler, fx.env, "/readyz");
  assert.equal(notReady.status, 503);
  assert.deepEqual(await notReady.json(), { status: "unavailable" });

  fx.double.clearFailure("query");
  const recovered = await call(fx.handler, fx.env, listPath, {
    token: actor.token,
  });
  assert.equal(recovered.status, 200);
  const list = (await recovered.json()) as {
    messages: Array<{ message_id: string; seq: number }>;
  };
  assert.equal(list.messages.length, 1);
  assert.equal(list.messages[0]?.seq, 1);

  const ready = await call(fx.handler, fx.env, "/readyz");
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  // The failed read never removed or duplicated the committed row.
  assert.deepEqual(
    await fx.db.all("SELECT COUNT(*) AS count FROM messages"),
    [{ count: 1 }],
  );
});
