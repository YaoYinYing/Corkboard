import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { createServiceFixture, type ServiceFixture } from "../helpers/service-fixture.ts";

type App = (request: Request) => Promise<Response>;
type JsonObject = Record<string, any>;

interface Actor {
  accountId: string;
  speakerId: string;
  token: string;
  credentialId: string;
}

interface CallOptions {
  method?: string;
  token?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  const headers = new Headers(options.headers ?? {});
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  let body: string | undefined;
  if (options.body !== undefined) body = JSON.stringify(options.body);
  if (body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers,
      ...(body === undefined ? {} : { body }),
    }),
  );
}

async function jsonBody(response: Response): Promise<JsonObject> {
  return (await response.json()) as JsonObject;
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

async function addActor(fx: ServiceFixture, name: string): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token, credentialId } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, token, credentialId };
}

async function withApp(
  t: { after(fn: () => void): void },
): Promise<{ fx: ServiceFixture; app: App }> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  return { fx, app: createApp(fx.deps) };
}

async function sendREST(
  app: App,
  actor: Actor,
  projectId: string,
  key: string,
  text: string,
): Promise<string> {
  const response = await call(app, `/api/v1/projects/${projectId}/messages`, {
    method: "POST",
    token: actor.token,
    headers: { "idempotency-key": key },
    body: {
      summary: text,
      type: "request",
      language: "en",
      text,
      body_digest: digestOf(text),
    },
  });
  assert.equal(response.status, 201);
  return (await jsonBody(response)).message_id as string;
}

async function stats(app: App, token: string, projectId: string): Promise<Response> {
  return call(app, `/api/v1/projects/${projectId}/stats`, { token });
}

test("authorized empty project returns zero counts and hardened headers", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_empty", alice.accountId);
  await fx.addMembership("proj_empty", alice.speakerId);

  const response = await stats(app, alice.token, "proj_empty");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.deepEqual(await jsonBody(response), {
    project_id: "proj_empty",
    messages: { ready: 0, pending: 0, expired: 0 },
    unread: 0,
  });
});

test("counts are project-scoped and reflect ready, pending, expired, and per-speaker unread", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await fx.addProject("proj_counts", alice.accountId);
  await fx.addMembership("proj_counts", alice.speakerId);
  await fx.addMembership("proj_counts", bob.speakerId);
  // A second project for alice proves counts never cross the project boundary.
  await fx.addProject("proj_other", alice.accountId);
  await fx.addMembership("proj_other", alice.speakerId);

  const first = await sendREST(app, alice, "proj_counts", "counts-1", "first message");
  const second = await sendREST(app, alice, "proj_counts", "counts-2", "second message");
  const third = await sendREST(app, bob, "proj_counts", "counts-3", "third message");
  await sendREST(app, alice, "proj_other", "counts-4", "other project");

  // A provisional row is invisible to list/replay but is counted as pending.
  await fx.db.run(
    `INSERT INTO messages
       (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, body_state)
     VALUES (?, ?, NULL, ?, ?, 'request', 'en', ?, 'pending')`,
    ["msg_pending", "proj_counts", alice.speakerId, "pending", new Date().toISOString()],
  );
  // One committed message becomes a retained tombstone.
  await fx.expireMessage(second);

  // Bob reads one message; unread is per calling speaker.
  const read = await call(
    app,
    `/api/v1/projects/proj_counts/messages/${first}/read`,
    { method: "POST", token: bob.token },
  );
  assert.equal(read.status, 200);

  const aliceStats = await jsonBody(await stats(app, alice.token, "proj_counts"));
  assert.deepEqual(aliceStats, {
    project_id: "proj_counts",
    messages: { ready: 2, pending: 1, expired: 1 },
    unread: 3,
  });

  const bobStats = await jsonBody(await stats(app, bob.token, "proj_counts"));
  assert.deepEqual(bobStats, {
    project_id: "proj_counts",
    messages: { ready: 2, pending: 1, expired: 1 },
    unread: 2,
  });

  // The other project sees only its own message.
  const otherStats = await jsonBody(await stats(app, alice.token, "proj_other"));
  assert.deepEqual(otherStats, {
    project_id: "proj_other",
    messages: { ready: 1, pending: 0, expired: 0 },
    unread: 1,
  });
  assert.ok([first, second, third].every((id) => typeof id === "string"));
});

test("a member without a credential grant receives FORBIDDEN like project detail", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_nogrant", alice.accountId);
  await fx.addMembership("proj_nogrant", alice.speakerId);
  // Membership alone grants nothing: remove the explicit credential grant.
  await fx.revokeProjectGrant(alice.credentialId, "proj_nogrant");

  const detail = await call(app, "/api/v1/projects/proj_nogrant", { token: alice.token });
  const response = await stats(app, alice.token, "proj_nogrant");
  assert.equal(response.status, 403);
  const body = await jsonBody(response);
  assert.equal(body.error.code, "FORBIDDEN");
  assert.deepEqual(
    { status: response.status, code: body.error.code },
    { status: detail.status, code: (await jsonBody(detail)).error.code },
  );
  assert.equal(JSON.stringify(body).includes("proj_nogrant"), false);
});

test("failed message rows are excluded from the message counts", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_failed", alice.accountId);
  await fx.addMembership("proj_failed", alice.speakerId);

  // A failed row is neither committed nor pending; direct parameterized SQL is
  // the only way to construct this state in a test.
  await fx.db.run(
    `INSERT INTO messages
       (id, project_id, seq, sender_speaker_id, summary, type, language, received_at, body_state)
     VALUES (?, ?, NULL, ?, ?, 'request', 'en', ?, 'failed')`,
    ["msg_failed", "proj_failed", alice.speakerId, "failed", new Date().toISOString()],
  );
  await sendREST(app, alice, "proj_failed", "failed-1", "ready message");

  const counts = await jsonBody(await stats(app, alice.token, "proj_failed"));
  assert.deepEqual(counts, {
    project_id: "proj_failed",
    messages: { ready: 1, pending: 0, expired: 0 },
    unread: 1,
  });
});

test("foreign, unknown, and unauthenticated callers cannot learn project existence or counts", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  const bob = await addActor(fx, "bob");
  await fx.addProject("proj_alice", alice.accountId);
  await fx.addMembership("proj_alice", alice.speakerId);
  await fx.addProject("proj_bob", bob.accountId);
  await fx.addMembership("proj_bob", bob.speakerId);
  await sendREST(app, bob, "proj_bob", "foreign-1", "bob secret");

  const foreign = await stats(app, alice.token, "proj_bob");
  const unknown = await stats(app, alice.token, "proj_does_not_exist");
  assert.equal(foreign.status, 404);
  assert.equal(unknown.status, 404);

  const foreignBody = await jsonBody(foreign);
  const unknownBody = await jsonBody(unknown);
  assert.deepEqual(Object.keys(foreignBody.error).sort(), ["code", "message", "request_id"]);
  assert.equal(foreignBody.error.code, "NOT_FOUND");
  assert.deepEqual(
    { code: foreignBody.error.code, message: foreignBody.error.message },
    { code: unknownBody.error.code, message: unknownBody.error.message },
  );
  const serialized = JSON.stringify(foreignBody);
  assert.equal(serialized.includes("proj_bob"), false);
  assert.equal(serialized.includes("bob secret"), false);
  assert.equal(serialized.includes("messages"), false);
  assert.equal(serialized.includes("unread"), false);

  // Authentication precedes project resolution, so an unauthenticated caller
  // gets 401 for both an existing and a missing project rather than a 404.
  for (const projectId of ["proj_bob", "proj_does_not_exist"]) {
    const response = await stats(app, "", projectId);
    assert.equal(response.status, 401);
    assert.equal((await jsonBody(response)).error.code, "UNAUTHENTICATED");
  }
});

test("stats is read-only and its response never contains message content", async (t) => {
  const { fx, app } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_content", alice.accountId);
  await fx.addMembership("proj_content", alice.speakerId);

  const summary = "private summary marker";
  const text = "private body marker";
  await sendREST(app, alice, "proj_content", "content-1", text);

  const response = await stats(app, alice.token, "proj_content");
  assert.equal(response.status, 200);
  const serialized = JSON.stringify(await jsonBody(response));
  for (const forbidden of [summary, text, alice.token, alice.speakerId]) {
    assert.equal(serialized.includes(forbidden), false, `stats leaked ${forbidden}`);
  }

  const post = await call(app, "/api/v1/projects/proj_content/stats", {
    method: "POST",
    token: alice.token,
  });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
});

test("stats failures are counted under a fixed route label with no project ID", async (t) => {
  const { fx } = await withApp(t);
  const alice = await addActor(fx, "alice");
  await fx.addProject("proj_metrics_label", alice.accountId);
  await fx.addMembership("proj_metrics_label", alice.speakerId);
  const app = createApp(fx.deps, { metricsToken: "m".repeat(32) });

  assert.equal((await stats(app, alice.token, "proj_metrics_label")).status, 200);
  assert.equal(
    (await stats(app, alice.token, "proj_metrics_missing")).status,
    404,
  );

  const snapshot = await jsonBody(
    await call(app, "/metrics", { token: "m".repeat(32) }),
  );
  const routes = new Map<string, number>(
    (snapshot.routes as JsonObject[]).map((row) => [row.route as string, row.count as number]),
  );
  assert.equal(routes.get("/api/v1/projects/:projectId/stats"), 2);
  const serialized = JSON.stringify(snapshot);
  assert.equal(serialized.includes("proj_metrics_label"), false);
  assert.equal(serialized.includes("proj_metrics_missing"), false);
});
