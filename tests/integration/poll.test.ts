import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { sendMessage, type SendMessageInput } from "../../src/service/messages.ts";
import { pollPass, type CursorState, type PollMessage } from "../../scripts/poll.ts";
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

// Adapt the Web handler to a real loopback socket so the poller uses its
// production fetch path rather than an injected fake.
async function startAppServer(
  t: { after(fn: () => void | Promise<void>): void },
  fx: Awaited<ReturnType<typeof createServiceFixture>>,
): Promise<string> {
  const app = createApp(fx.deps);
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
      const body = method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks);
      const webResponse = await app(
        new Request(url, { method, headers, ...(body === undefined ? {} : { body }) }),
      );
      const responseHeaders: Record<string, string> = {};
      webResponse.headers.forEach((value, name) => {
        responseHeaders[name] = value;
      });
      response.writeHead(webResponse.status, responseHeaders);
      response.end(Buffer.from(await webResponse.arrayBuffer()));
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
  return `http://127.0.0.1:${address.port}`;
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

  const baseUrl = await startAppServer(t, fx);
  const directory = mkdtempSync(join(tmpdir(), "corkboard-poll-integration-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cursorPath = join(directory, "cursor.json");
  const seen: PollMessage[] = [];

  const result = await pollPass({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    speakerId: poller.speakerId,
    cursorPath,
    afterSeq: 0,
    limit: 2,
    maxPages: 2,
    onMessage: (message) => {
      seen.push(message);
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
  assert.deepEqual(
    seen.map((message) => message.senderId),
    ["spk_sender", "spk_sender", "spk_sender"],
  );

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
});
