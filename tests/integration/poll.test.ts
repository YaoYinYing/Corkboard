import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { sendMessage, type SendMessageInput } from "../../src/service/messages.ts";
import {
  PollError,
  pollPass,
  run,
  type CursorState,
  type PollMessage,
} from "../../scripts/poll.ts";
import { createServiceFixture } from "../helpers/service-fixture.ts";

interface Actor {
  accountId: string;
  speakerId: string;
  token: string;
}

async function addActor(
  fx: Awaited<ReturnType<typeof createServiceFixture>>,
  name: string,
): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token } = await fx.addCredential({ id: `cred_${name}`, speakerId: `spk_${name}` });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, token };
}

function digestOf(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function writeCursor(path: string, afterSeq: number): string {
  const text = `${JSON.stringify({
    version: 1,
    project_id: "proj_1",
    speaker_id: "spk_poller",
    after_seq: afterSeq,
    updated_at: "2026-11-03T12:00:00.000Z",
  })}\n`;
  writeFileSync(path, text, { mode: 0o600 });
  chmodSync(path, 0o600);
  return text;
}

interface PollingFixture {
  fx: Awaited<ReturnType<typeof createServiceFixture>>;
  poller: Actor;
}

async function setupProject(
  t: { after(fn: () => void | Promise<void>): void },
  texts: string[],
): Promise<PollingFixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const sender = await addActor(fx, "sender");
  const poller = await addActor(fx, "poller");
  await fx.addProject("proj_1", sender.accountId);
  await fx.addMembership("proj_1", sender.speakerId);
  await fx.addMembership("proj_1", poller.speakerId);
  for (const [index, text] of texts.entries()) {
    await send(fx, sender, `send-${index}`, text);
  }
  return { fx, poller };
}

async function send(
  fx: Awaited<ReturnType<typeof createServiceFixture>>,
  actor: Actor,
  key: string,
  text: string,
): Promise<void> {
  const principal = await fx.authenticate(actor.token);
  const input: SendMessageInput = {
    summary: text,
    type: "request",
    language: "en",
    text,
    bodyDigest: digestOf(text),
  };
  await sendMessage(fx.deps, principal, "proj_1", key, input);
}

interface ObservedRequest {
  method: string;
  path: string;
}

type RequestInterceptor = (request: ObservedRequest) => Response | undefined;

// Adapt the Web handler to a real loopback socket so the poller uses its
// production fetch path rather than an injected fake. Server-observed requests
// are recorded so tests assert order rather than client intent. An interceptor
// can replace a specific response (for client-behavior failure cases) while
// every other request still goes through the real createApp handler.
async function startAppServer(
  t: { after(fn: () => void | Promise<void>): void },
  fx: Awaited<ReturnType<typeof createServiceFixture>>,
  intercept?: RequestInterceptor,
): Promise<{ baseUrl: string; requests: ObservedRequest[] }> {
  const app = createApp(fx.deps);
  const requests: ObservedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) {
          headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        }
      }
      const method = (request.method ?? "GET").toUpperCase();
      const observed = { method, path: url.pathname };
      requests.push(observed);

      const writeWebResponse = async (webResponse: Response): Promise<void> => {
        const responseHeaders: Record<string, string> = {};
        webResponse.headers.forEach((value, name) => {
          responseHeaders[name] = value;
        });
        response.writeHead(webResponse.status, responseHeaders);
        response.end(Buffer.from(await webResponse.arrayBuffer()));
      };

      const intercepted = intercept?.(observed);
      if (intercepted !== undefined) {
        await writeWebResponse(intercepted);
        return;
      }

      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
      const webResponse = await app(
        new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }),
      );
      await writeWebResponse(webResponse);
    } catch {
      response.statusCode = 500;
      response.end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback address");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

test("the polling client consumes pages and marks them read through createApp", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const sender = await addActor(fx, "sender");
  const poller = await addActor(fx, "poller");
  await fx.addProject("proj_1", sender.accountId);
  await fx.addMembership("proj_1", sender.speakerId);
  await fx.addMembership("proj_1", poller.speakerId);

  for (const [index, text] of ["first", "second", "third"].entries()) {
    await send(fx, sender, `send-${index}`, text);
  }

  const { baseUrl, requests } = await startAppServer(t, fx);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const seen: PollMessage[] = [];
  const seenBodies: string[] = [];

  const result = await pollPass({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    speakerId: poller.speakerId,
    cursorPath,
    afterSeq: 0,
    limit: 2,
    maxPages: 2,
    onMessage: (message, body) => {
      seen.push(message);
      seenBodies.push(body);
    },
  });

  assert.equal(result.processed, 3);
  assert.equal(result.pages, 2);
  assert.equal(result.afterSeq, 3);
  assert.deepEqual(
    seen.map((message) => [message.seq, message.summary]),
    [
      [1, "first"],
      [2, "second"],
      [3, "third"],
    ],
  );
  assert.deepEqual(seenBodies, ["first", "second", "third"]);
  assert.deepEqual(
    seen.map((message) => message.senderId),
    ["spk_sender", "spk_sender", "spk_sender"],
  );

  // Server-observed order: every receipt follows its message's body GET.
  assert.equal(requests.filter((entry) => entry.path.endsWith("/body")).length, 3);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, 3);
  for (const message of seen) {
    const body = requests.findIndex(
      (entry) => entry.method === "GET" && entry.path.endsWith(`/${message.messageId}/body`),
    );
    const receipt = requests.findIndex(
      (entry) => entry.method === "POST" && entry.path.endsWith(`/${message.messageId}/read`),
    );
    assert.ok(body >= 0, `missing body GET for ${message.messageId}`);
    assert.ok(receipt > body, `receipt for ${message.messageId} did not follow its body GET`);
  }

  const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as CursorState;
  assert.equal(cursor.after_seq, 3);
  assert.equal(cursor.project_id, "proj_1");
  assert.equal(cursor.speaker_id, "spk_poller");
  if (process.platform !== "win32") assert.equal(statSync(cursorPath).mode & 0o777, 0o600);

  const receipts = await fx.db.all<{ speaker_id: string }>(
    "SELECT speaker_id FROM message_receipts ORDER BY speaker_id",
  );
  assert.equal(receipts.length, 3);
  assert.deepEqual(
    receipts.map((receipt) => receipt.speaker_id),
    ["spk_poller", "spk_poller", "spk_poller"],
  );

  const requestsBeforeIdle = requests.length;
  const idle = await pollPass({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    speakerId: poller.speakerId,
    cursorPath,
    afterSeq: 3,
    limit: 2,
    maxPages: 2,
  });
  assert.equal(idle.processed, 0);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 3);
  assert.equal(requests.length - requestsBeforeIdle, 1);
});

test("a body GET failure over the loopback createApp path leaves no receipt and the cursor unchanged", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const before = writeCursor(cursorPath, 0);

  const { baseUrl, requests } = await startAppServer(
    t,
    fx,
    ({ method, path }) =>
      method === "GET" && path.endsWith("/body")
        ? jsonResponse({ error: { code: "UNAVAILABLE" } }, 503)
        : undefined,
  );

  await assert.rejects(
    pollPass({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      speakerId: poller.speakerId,
      cursorPath,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      consume: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.code, "BODY_UNAVAILABLE");
      return true;
    },
  );

  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, 0);
  assert.equal(readFileSync(cursorPath, "utf8"), before);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("a body digest mismatch over loopback fails closed with no receipt and the cursor unchanged", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const before = writeCursor(cursorPath, 0);

  const { baseUrl, requests } = await startAppServer(t, fx, ({ method, path }) => {
    if (method !== "GET" || !path.endsWith("/body")) return undefined;
    const messageId = path.split("/").at(-2) ?? "";
    return jsonResponse({
      message_id: messageId,
      text: "tampered",
      compression: "none",
      digest: digestOf("original"),
    });
  });

  await assert.rejects(
    pollPass({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      speakerId: poller.speakerId,
      cursorPath,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      consume: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 3);
      assert.equal(error.code, "INTEGRITY_FAILURE");
      return true;
    },
  );

  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, 0);
  assert.equal(readFileSync(cursorPath, "utf8"), before);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("a consumer callback failure over loopback leaves no receipt and the cursor unchanged", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const before = writeCursor(cursorPath, 0);

  const { baseUrl, requests } = await startAppServer(t, fx);

  await assert.rejects(
    pollPass({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      speakerId: poller.speakerId,
      cursorPath,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      onMessage: () => {
        throw new Error("consumer failed");
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.code, "PROCESS_FAILED");
      return true;
    },
  );

  assert.equal(requests.filter((entry) => entry.path.endsWith("/body")).length, 1);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, 0);
  assert.equal(readFileSync(cursorPath, "utf8"), before);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});

test("a consumed loopback run persists the cursor and a fresh run does not reprocess", async (t) => {
  const { fx, poller } = await setupProject(t, ["first"]);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");

  const { baseUrl, requests } = await startAppServer(t, fx);
  const firstSeen: string[] = [];
  const first = await pollPass({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    speakerId: poller.speakerId,
    cursorPath,
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    onMessage: (_message, body) => {
      firstSeen.push(body);
    },
  });
  assert.equal(first.processed, 1);
  assert.deepEqual(firstSeen, ["first"]);
  assert.equal(JSON.parse(readFileSync(cursorPath, "utf8")).after_seq, 1);

  const persisted = readFileSync(cursorPath, "utf8");
  const bodiesBefore = requests.filter((entry) => entry.path.endsWith("/body")).length;
  const readsBefore = requests.filter((entry) => entry.path.endsWith("/read")).length;

  // A fresh run reloads the persisted cursor file and finds nothing to consume.
  const secondSeen: string[] = [];
  const second = await run({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    cursorPath,
    once: true,
    onMessage: (_message, body) => {
      secondSeen.push(body);
    },
  });
  assert.equal(second.processed, 0);
  assert.equal(second.afterSeq, 1);
  assert.deepEqual(secondSeen, []);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/body")).length, bodiesBefore);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, readsBefore);
  assert.equal(readFileSync(cursorPath, "utf8"), persisted);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 1);
});

test("the default loopback pass does not fetch bodies, acknowledge, or write the cursor", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const before = writeCursor(cursorPath, 0);

  const { baseUrl, requests } = await startAppServer(t, fx);
  const result = await pollPass({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    speakerId: poller.speakerId,
    cursorPath,
    afterSeq: 0,
    limit: 10,
    maxPages: 5,
  });

  assert.equal(result.processed, 0);
  assert.equal(result.afterSeq, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.path.endsWith("/messages"), true);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/body")).length, 0);
  assert.equal(requests.filter((entry) => entry.path.endsWith("/read")).length, 0);
  assert.equal(readFileSync(cursorPath, "utf8"), before);
  assert.equal((await fx.db.all("SELECT message_id FROM message_receipts")).length, 0);
});
