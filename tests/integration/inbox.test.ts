import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { PollError, loadCursorState } from "../../scripts/poll.ts";
import {
  InboxError,
  ackEvent,
  acknowledgedSeq,
  listEvents,
  openSpool,
  pendingEvents,
  prepareSpool,
  pruneSpool,
  readPayload,
} from "../../src/inbox/spool.ts";
import { runInbox } from "../../src/inbox/bridge.ts";
import { createServiceFixture } from "../helpers/service-fixture.ts";

interface Actor {
  accountId: string;
  speakerId: string;
  credentialId: string;
  token: string;
}

async function addActor(
  fx: Awaited<ReturnType<typeof createServiceFixture>>,
  name: string,
): Promise<Actor> {
  await fx.addAccount(`acct_${name}`);
  await fx.addSpeaker(`spk_${name}`, `acct_${name}`);
  const { token, credentialId } = await fx.addCredential({
    id: `cred_${name}`,
    speakerId: `spk_${name}`,
  });
  return { accountId: `acct_${name}`, speakerId: `spk_${name}`, credentialId, token };
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

interface Fixture {
  fx: Awaited<ReturnType<typeof createServiceFixture>>;
  sender: Actor;
  poller: Actor;
  messageIds: string[];
}

async function setupProject(
  t: { after(fn: () => void | Promise<void>): void },
  texts: string[],
  summaries?: string[],
): Promise<Fixture> {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  const sender = await addActor(fx, "sender");
  const poller = await addActor(fx, "poller");
  await fx.addProject("proj_1", sender.accountId);
  await fx.addMembership("proj_1", sender.speakerId);
  await fx.addMembership("proj_1", poller.speakerId);
  const principal = await fx.authenticate(sender.token);
  for (const [index, text] of texts.entries()) {
    const input: SendMessageInput = {
      summary: summaries?.[index] ?? text,
      type: "request",
      language: "en",
      text,
      bodyDigest: digestOf(text),
    };
    await sendMessage(fx.deps, principal, "proj_1", `send-${index}`, input);
  }
  const rows = await fx.db.all<{ id: string }>("SELECT id FROM messages ORDER BY seq");
  return { fx, sender, poller, messageIds: rows.map((row) => row.id) };
}

interface ObservedRequest {
  method: string;
  path: string;
}

type RequestInterceptor = (request: ObservedRequest) => Response | undefined;

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

function spoolDir(): string {
  return mkdtempSync(join(tmpdir(), "corkboard-inbox-integration-"));
}

function receiptCount(fx: Fixture["fx"]): Promise<number> {
  return fx.db
    .all<{ message_id: string }>("SELECT message_id FROM message_receipts")
    .then((rows) => rows.length);
}

function noReceipts(fx: Fixture["fx"]): Promise<void> {
  return receiptCount(fx).then((count) => assert.equal(count, 0));
}

function cursorAt(spool: string, projectId: string, speakerId: string): number {
  return loadCursorState(join(spool, "cursor.json"), projectId, speakerId, () => new Date())
    .after_seq;
}

test("send -> queue -> list/ack -> restart is durable and idempotent", async (t) => {
  const { fx, poller } = await setupProject(t, ["first", "second"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(first.processed, 2);
  assert.equal(first.afterSeq, 2);

  const spool = openSpool(dir);
  const queued = listEvents(spool);
  assert.deepEqual(
    queued.map((event) => [event.seq, event.body_state, event.payload.included]),
    [
      [1, "ready", false],
      [2, "ready", false],
    ],
  );
  for (const event of queued) {
    assert.equal(event.sender.attribution, "server_authenticated");
  }
  for (const name of readdirSync(spool.eventsDir)) {
    assert.equal(statSync(join(spool.eventsDir, name)).mode & 0o777, 0o600);
  }
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 2);
  assert.equal(await receiptCount(fx), 2);

  assert.deepEqual(
    pendingEvents(spool, "consumer-a").map((event) => event.seq),
    [1, 2],
  );
  ackEvent(spool, "consumer-a", 1);
  ackEvent(spool, "consumer-a", 2);
  assert.equal(acknowledgedSeq(spool, "consumer-a"), 2);
  assert.equal(pruneSpool(spool, { force: true }), 2);
  assert.deepEqual(listEvents(spool), []);

  const second = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(second.processed, 0);
  assert.equal(await receiptCount(fx), 2);
});

test("plaintext is persisted only on opt-in and reads back verified", async (t) => {
  const marker = "unique-plaintext-marker";
  const { fx, poller } = await setupProject(t, [marker], ["plain summary"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    plaintext: true,
    once: true,
    sleep: async () => {},
  });

  const spool = openSpool(dir);
  const [event] = listEvents(spool);
  assert.ok(event !== undefined);
  assert.equal(event.payload.included, true);
  assert.equal(readPayload(spool, event), marker);
  const eventText = readFileSync(join(spool.eventsDir, "0000000000000001.json"), "utf8");
  assert.equal(eventText.includes(marker), false);
  const payloadPath = join(spool.payloadsDir, "0000000000000001.json");
  assert.equal(statSync(payloadPath).mode & 0o777, 0o600);
  assert.equal(readFileSync(payloadPath, "utf8").includes(marker), true);
});

test("an uncertain receipt replays the queued event without duplication", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const { baseUrl } = await startAppServer(
    t,
    fx,
    ({ method, path }) =>
      method === "POST" && path.endsWith("/read")
        ? jsonResponse({ error: { code: "UNAVAILABLE" } }, 503)
        : undefined,
  );

  await assert.rejects(
    runInbox({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      spoolDir: dir,
      consumerIds: ["consumer-a"],
      once: true,
      sleep: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.code, "MARK_READ_UNCERTAIN");
      return true;
    },
  );

  const spool = openSpool(dir);
  assert.equal(listEvents(spool).length, 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 0);
  await noReceipts(fx);

  const restarted = await runInbox({
    baseUrl: (await startAppServer(t, fx)).baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(restarted.processed, 1);
  assert.equal(listEvents(spool).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
  assert.deepEqual(pendingEvents(spool, "consumer-a").map((event) => event.seq), [1]);
});

test("a spool failure before durability leaves no event, receipt, or cursor advance", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await assert.rejects(
    runInbox({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      spoolDir: dir,
      consumerIds: ["consumer-a"],
      maxBytes: 1,
      once: true,
      sleep: async () => {},
    }),
    (error: unknown) => {
      assert.ok(error instanceof InboxError);
      assert.equal(error.code, "INBOX_BACKPRESSURE");
      return true;
    },
  );
  assert.deepEqual(listEvents(openSpool(dir)), []);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 0);
  await noReceipts(fx);

  const retried = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(retried.processed, 1);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
});

test("a stale temp file from a crashed write is cleared and the message queues on restart", async (t) => {
  const text = "after temp crash";
  const { fx, poller } = await setupProject(t, [text]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  // Simulate a crash after the temp file was opened and partially written but
  // before the atomic rename. The partial file must never be read as an event.
  const spool = prepareSpool(dir, "proj_1", { plaintext: true });
  const stale = join(spool.tmpDir, "0000000000000001.json.tmp-crashed");
  writeFileSync(stale, '{"version":1,"partial":', { mode: 0o600 });
  chmodSync(stale, 0o600);

  const result = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    plaintext: true,
    once: true,
    sleep: async () => {},
  });
  assert.equal(result.processed, 1);

  const reopened = openSpool(dir);
  assert.deepEqual(readdirSync(reopened.tmpDir), []);
  const [event] = listEvents(reopened);
  assert.ok(event !== undefined);
  assert.equal(event.payload.included, true);
  assert.equal(readPayload(reopened, event), text);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
});

test("a lost cursor after the receipt replays without a second event or receipt", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(await receiptCount(fx), 1);

  const cursorPath = join(dir, "cursor.json");
  writeFileSync(
    cursorPath,
    `${JSON.stringify({
      version: 1,
      project_id: "proj_1",
      speaker_id: "spk_poller",
      after_seq: 0,
      updated_at: "2026-11-11T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(cursorPath, 0o600);

  const replayed = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(replayed.processed, 1);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
});

test("a ready row whose body is now expired queues an expired tombstone in a plaintext spool", async (t) => {
  const { fx, poller } = await setupProject(t, ["expiry race"]);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // The real list still reports body_state "ready"; only the body GET knows the
  // definitive 410. A plaintext spool must still get an expired event, not a
  // false ready event or INBOX_UNSAFE.
  const { baseUrl } = await startAppServer(
    t,
    fx,
    ({ method, path }) =>
      method === "GET" && path.endsWith("/body")
        ? jsonResponse({ error: { code: "BODY_EXPIRED" } }, 410)
        : undefined,
  );

  const result = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    plaintext: true,
    once: true,
    sleep: async () => {},
  });
  assert.equal(result.processed, 1);

  const spool = openSpool(dir);
  const [event] = listEvents(spool);
  assert.ok(event !== undefined);
  assert.equal(event.body_state, "expired");
  assert.equal(event.payload.included, false);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
  await noReceipts(fx);
});

test("an expired body is queued as a consumable tombstone without a receipt", async (t) => {
  const { fx, poller, messageIds } = await setupProject(t, ["expired body"]);
  const messageId = messageIds[0];
  assert.ok(messageId !== undefined);
  await fx.expireMessage(messageId);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const output: string[] = [];
  const result = await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
    stdout: (line) => output.push(line),
  });
  assert.equal(result.processed, 1);

  const spool = openSpool(dir);
  const [event] = listEvents(spool);
  assert.ok(event !== undefined);
  assert.equal(event.body_state, "expired");
  assert.equal(event.payload.included, false);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller"), 1);
  await noReceipts(fx);
  assert.deepEqual(pendingEvents(spool, "consumer-a").map((entry) => entry.seq), [1]);
  assert.equal(output.join("\n").includes("expired body"), false);
});

test("a foreign-project row, tampered body, oversized event, and revoked credential all fail closed", async (t) => {
  // Foreign project row.
  {
    const { fx, poller } = await setupProject(t, ["only"]);
    const dir = spoolDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { baseUrl } = await startAppServer(t, fx, ({ method, path }) => {
      if (method !== "GET" || !path.endsWith("/messages")) return undefined;
      return jsonResponse({
        messages: [
          {
            message_id: "msg_forged",
            project_id: "proj_other",
            seq: 1,
            sender: { id: "spk_sender", display_name: "Sender" },
            summary: "forged",
            type: "request",
            language: "en",
            reply_to_id: null,
            body_state: "ready",
            body_expires_at: null,
            client_sent_at: null,
            received_at: "2026-11-03T12:00:00.000Z",
            committed_at: "2026-11-03T12:00:01.000Z",
          },
        ],
        next_cursor: 1,
      });
    });
    await assert.rejects(
      runInbox({
        baseUrl,
        token: poller.token,
        projectId: "proj_1",
        spoolDir: dir,
        consumerIds: ["consumer-a"],
        once: true,
        sleep: async () => {},
      }),
      (error: unknown) => error instanceof PollError && error.code === "UNSAFE_RESPONSE",
    );
    assert.deepEqual(listEvents(openSpool(dir)), []);
    await noReceipts(fx);
  }

  // Tampered body digest.
  {
    const { fx, poller } = await setupProject(t, ["original"]);
    const dir = spoolDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { baseUrl } = await startAppServer(t, fx, ({ method, path }) => {
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
      runInbox({
        baseUrl,
        token: poller.token,
        projectId: "proj_1",
        spoolDir: dir,
        consumerIds: ["consumer-a"],
        once: true,
        sleep: async () => {},
      }),
      (error: unknown) => error instanceof PollError && error.code === "INTEGRITY_FAILURE",
    );
    assert.deepEqual(listEvents(openSpool(dir)), []);
    await noReceipts(fx);
  }

  // Event larger than the local record bound.
  {
    const { fx, poller } = await setupProject(t, ["small"]);
    const dir = spoolDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const { baseUrl } = await startAppServer(t, fx);
    await assert.rejects(
      runInbox({
        baseUrl,
        token: poller.token,
        projectId: "proj_1",
        spoolDir: dir,
        consumerIds: ["consumer-a"],
        maxEventBytes: 64,
        once: true,
        sleep: async () => {},
      }),
      (error: unknown) => error instanceof InboxError && error.code === "INBOX_TOO_LARGE",
    );
    assert.deepEqual(listEvents(openSpool(dir)), []);
    await noReceipts(fx);
  }

  // Revoked credential.
  {
    const { fx, poller } = await setupProject(t, ["only"]);
    const dir = spoolDir();
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    await fx.db.run("UPDATE credentials SET revoked_at = ? WHERE id = ?", [
      "2026-11-11T12:00:00.000Z",
      poller.credentialId,
    ]);
    const { baseUrl } = await startAppServer(t, fx);
    await assert.rejects(
      runInbox({
        baseUrl,
        token: poller.token,
        projectId: "proj_1",
        spoolDir: dir,
        consumerIds: ["consumer-a"],
        once: true,
        sleep: async () => {},
      }),
      (error: unknown) => {
        assert.ok(error instanceof PollError);
        assert.equal(error.exitCode, 2);
        return true;
      },
    );
    assert.deepEqual(listEvents(openSpool(dir)), []);
    await noReceipts(fx);
  }
});

test("a wrong-speaker cursor and corrupt event fail closed", async (t) => {
  const { fx, poller } = await setupProject(t, ["only"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  prepareSpool(dir, "proj_1", { plaintext: false });
  const cursorPath = join(dir, "cursor.json");
  writeFileSync(
    cursorPath,
    `${JSON.stringify({
      version: 1,
      project_id: "proj_1",
      speaker_id: "spk_other",
      after_seq: 0,
      updated_at: "2026-11-11T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(cursorPath, 0o600);

  await assert.rejects(
    runInbox({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      spoolDir: dir,
      consumerIds: ["consumer-a"],
      once: true,
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof PollError && error.code === "UNSAFE_RESPONSE",
  );
  assert.deepEqual(listEvents(openSpool(dir)), []);

  // A syntactically corrupt cursor is rejected, never silently reset.
  writeFileSync(cursorPath, "{not json", { mode: 0o600 });
  chmodSync(cursorPath, 0o600);
  await assert.rejects(
    runInbox({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      spoolDir: dir,
      consumerIds: ["consumer-a"],
      once: true,
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof PollError && error.code === "UNSAFE_RESPONSE",
  );

  // A corrupt event is never skipped or overwritten.
  rmSync(cursorPath);
  const spool = openSpool(dir);
  const target = join(spool.eventsDir, "0000000000000001.json");
  writeFileSync(target, "{not json", { mode: 0o600 });
  chmodSync(target, 0o600);
  await assert.rejects(
    runInbox({
      baseUrl,
      token: poller.token,
      projectId: "proj_1",
      spoolDir: dir,
      consumerIds: ["consumer-a"],
      once: true,
      sleep: async () => {},
    }),
    (error: unknown) => error instanceof InboxError && error.code === "INBOX_CORRUPT",
  );
  assert.equal(existsSync(target), true);
});

test("diagnostics and metadata events never contain the credential or plaintext", async (t) => {
  const echoToken = `cb_${"e".repeat(43)}`;
  const marker = "unique-diagnostic-marker";
  const { fx, poller } = await setupProject(t, [marker], [`summary ${echoToken}`]);
  const { token } = await fx.addCredential({
    id: "cred_synthetic",
    speakerId: poller.speakerId,
    token: echoToken,
  });
  poller.token = token;
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const output: string[] = [];
  const errors: string[] = [];
  await runInbox({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
    stdout: (line) => output.push(line),
    stderr: (line) => errors.push(line),
  });

  const printed = [...output, ...errors].join("\n");
  assert.equal(printed.includes(token), false);
  assert.equal(printed.includes(marker), false);
  for (const name of readdirSync(join(dir, "events"))) {
    const text = readFileSync(join(dir, "events", name), "utf8");
    assert.equal(text.includes(marker), false);
    assert.equal(text.includes(token), false);
  }
});
