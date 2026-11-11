import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../../src/app/handlers.ts";
import { sendMessage, type SendMessageInput } from "../../src/service/messages.ts";
import { loadCursorState } from "../../scripts/poll.ts";
import {
  InboxError,
  SUPERVISOR_LOCK_FILE,
  acquireSupervisorLock,
  ackEvent,
  acknowledgedSeq,
  inspectSupervisorLock,
  listEvents,
  openSpool,
  pendingEvents,
  prepareSpool,
  readSupervisorStatus,
  runSupervisor,
} from "../../src/inbox/index.ts";
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
  return mkdtempSync(join(tmpdir(), "corkboard-inbox-supervisor-"));
}

function receiptCount(fx: Fixture["fx"]): Promise<number> {
  return fx.db
    .all<{ message_id: string }>("SELECT message_id FROM message_receipts")
    .then((rows) => rows.length);
}

function noReceipts(fx: Fixture["fx"]): Promise<void> {
  return receiptCount(fx).then((count) => assert.equal(count, 0));
}

function cursorAt(spool: string, projectId: string, speakerId: string, baseUrl: string): number {
  return loadCursorState(join(spool, "cursor.json"), projectId, speakerId, baseUrl, () => new Date())
    .after_seq;
}

const inboxScript = fileURLToPath(new URL("../../scripts/inbox.ts", import.meta.url));

interface ChildResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

interface ChildRun {
  child: ChildProcess;
  done: Promise<ChildResult>;
}

function startInbox(args: string[], env: Record<string, string> = {}): ChildRun {
  // Never inherit a real credential or binding from the test runner's shell.
  const inherited: Record<string, string | undefined> = { ...process.env };
  delete inherited.CORKBOARD_APIKEY;
  delete inherited.CORKBOARD_BASE_URL;
  delete inherited.CORKBOARD_PROJECT_ID;
  delete inherited.CORKBOARD_INBOX_SPOOL;
  delete inherited.CORKBOARD_INBOX_CONSUMERS;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", inboxScript, ...args],
    { env: { ...inherited, ...env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<ChildResult>((resolve) => {
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
  return { child, done };
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("condition was not met before the deadline");
}

function liveSupervisor(dir: string): boolean {
  try {
    return inspectSupervisorLock(openSpool(dir)).state === "live";
  } catch {
    return false;
  }
}

function tokenFile(
  t: { after(fn: () => void): void },
  dir: string,
  token: string,
): string {
  const path = join(dir, "token");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  t.after(() => rmSync(path, { force: true }));
  return path;
}

test("supervised fan-out fetches once and status output never leaks message content", async (t) => {
  const echoToken = `cb_${"f".repeat(43)}`;
  const marker = "unique-supervisor-body-marker";
  const { fx, poller } = await setupProject(t, [marker], [`summary ${echoToken}`]);
  const { token } = await fx.addCredential({
    id: "cred_supervisor",
    speakerId: poller.speakerId,
    token: echoToken,
  });
  poller.token = token;
  const { baseUrl, requests } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const output: string[] = [];
  const result = await runSupervisor({
    baseUrl,
    token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a", "consumer-b"],
    once: true,
    sleep: async () => {},
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
  });
  assert.equal(result.state, "stopped");
  assert.equal(result.exitCode, 0);
  assert.equal(result.processed, 1);

  const spool = openSpool(dir);
  assert.deepEqual(pendingEvents(spool, "consumer-a").map((event) => event.seq), [1]);
  assert.deepEqual(pendingEvents(spool, "consumer-b").map((event) => event.seq), [1]);
  // Fan-out shares one authorized stream: one body fetch and one receipt per
  // message, no consumer-specific server request, and no new endpoint.
  assert.equal(
    requests.filter((request) => request.method === "GET" && request.path.endsWith("/body"))
      .length,
    1,
  );
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.path.endsWith("/read"))
      .length,
    1,
  );
  assert.equal(requests.some((request) => request.path.includes("consumer")), false);
  assert.equal(inspectSupervisorLock(spool).state, "absent");

  const status = readSupervisorStatus(spool);
  assert.ok(status !== null);
  assert.equal(status.state, "stopped");
  assert.equal(status.stop_reason, "once");
  assert.equal(status.processed_total, 1);
  assert.equal(status.consumers.length, 2);
  assert.equal(status.lag.pending_events, 1);
  assert.equal(status.backlog.events, 1);
  assert.equal(status.last_success_at === null, false);

  const statusText = readFileSync(join(dir, "supervisor-status.json"), "utf8");
  for (const secret of [token, marker, "spk_sender", "summary"]) {
    assert.equal(statusText.includes(secret), false);
  }
  assert.equal(output.join("\n").includes(token), false);
  assert.equal(output.join("\n").includes(marker), false);

  const statusRun = startInbox(["status", "--spool-dir", dir, "--json"], {
    CORKBOARD_APIKEY: token,
  });
  const statusResult = await statusRun.done;
  assert.equal(statusResult.status, 0);
  const rendered = statusResult.stdout + statusResult.stderr;
  for (const secret of [token, marker, "spk_sender", "summary"]) {
    assert.equal(rendered.includes(secret), false);
  }
  const observed = JSON.parse(statusResult.stdout.trim()) as {
    state: string;
    consumers: Array<{ pending: number }>;
    backlog: { events: number };
    after_seq: number;
  };
  assert.equal(observed.state, "stopped");
  assert.equal(observed.consumers.length, 2);
  assert.equal(observed.backlog.events, 1);
  assert.equal(observed.after_seq, 1);
});

test("a cursor-commit failure is degraded and replay dedupes the event", async (t) => {
  const { fx, poller } = await setupProject(t, ["cursor failure"]);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let broke = false;
  const { baseUrl } = await startAppServer(t, fx, ({ method, path }) => {
    if (!broke && method === "POST" && path.endsWith("/read")) {
      broke = true;
      // The receipt succeeds, then the cursor cannot be replaced: the event and
      // receipt are durable, the cursor is unchanged, and the next pass replays.
      rmSync(join(dir, "cursor.json"), { force: true });
      mkdirSync(join(dir, "cursor.json"), { mode: 0o700 });
    }
    return undefined;
  });

  const first = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(first.state, "degraded");
  assert.equal(first.exitCode, 1);
  assert.equal(first.status?.last_error, "SUPERVISOR_RETRY");
  assert.equal(existsSync(join(dir, "cursor.json")), true);
  assert.equal(statSync(join(dir, "cursor.json")).isDirectory(), true);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);

  rmSync(join(dir, "cursor.json"), { recursive: true, force: true });
  const replayed = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(replayed.state, "stopped");
  assert.equal(replayed.afterSeq, 1);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 1);
});

test("backpressure stops before the receipt and resumes after acknowledgement", async (t) => {
  const { fx, poller } = await setupProject(t, ["first", "second"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    maxEvents: 1,
    once: true,
    sleep: async () => {},
  });
  assert.equal(first.state, "degraded");
  assert.equal(first.exitCode, 1);
  assert.equal(first.status?.degraded_reason, "INBOX_BACKPRESSURE");
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 1);

  ackEvent(openSpool(dir), "consumer-a", 1);
  const second = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    maxEvents: 1,
    once: true,
    sleep: async () => {},
  });
  assert.equal(second.state, "stopped");
  assert.equal(second.afterSeq, 2);
  assert.equal(await receiptCount(fx), 2);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 2);
});

test("a temporary network failure is observable as degraded and retried", async (t) => {
  const { poller } = await setupProject(t, ["unreachable"]);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const result = await runSupervisor({
    // Nothing listens on port 1, so identity fails before any list or receipt.
    baseUrl: "http://127.0.0.1:1",
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    requestTimeoutMs: 1_000,
    sleep: async () => {},
  });
  assert.equal(result.state, "degraded");
  assert.equal(result.exitCode, 1);
  assert.equal(result.status?.degraded, true);
  assert.ok(result.status?.degraded_reason !== null);
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});

test("a revoked credential fails closed without polling or receipting", async (t) => {
  const { fx, poller } = await setupProject(t, ["never delivered"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  await fx.db.run("UPDATE credentials SET revoked_at = ? WHERE id = ?", [
    "2026-11-11T12:00:00.000Z",
    poller.credentialId,
  ]);

  const result = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(result.state, "failed");
  assert.equal(result.exitCode, 2);
  assert.equal(result.status?.state, "failed");
  assert.equal(result.status?.last_error, "AUTH");
  assert.deepEqual(listEvents(openSpool(dir)), []);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 0);
  await noReceipts(fx);
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});

test("consumer detach/reattach and a lost-cursor replay neither lose nor duplicate events", async (t) => {
  const { fx, poller } = await setupProject(t, ["shared"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a", "consumer-b"],
    once: true as const,
    sleep: async () => {},
  };

  const first = await runSupervisor(options);
  assert.equal(first.processed, 1);
  ackEvent(openSpool(dir), "consumer-a", 1);

  // consumer-b is detached: its watermark stays at 0 while a restarts cleanly.
  const restarted = await runSupervisor(options);
  assert.equal(restarted.processed, 0);
  assert.deepEqual(pendingEvents(openSpool(dir), "consumer-a"), []);
  assert.deepEqual(
    pendingEvents(openSpool(dir), "consumer-b").map((event) => event.seq),
    [1],
  );

  ackEvent(openSpool(dir), "consumer-b", 1);

  // Replaying from a lost cursor is at-least-once: the event and receipt are
  // idempotent, and neither consumer is advanced past anything it did not ack.
  const cursorPath = join(dir, "cursor.json");
  writeFileSync(
    cursorPath,
    `${JSON.stringify({
      version: 1,
      project_id: "proj_1",
      speaker_id: "spk_poller",
      base_url: baseUrl,
      after_seq: 0,
      updated_at: "2026-11-11T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(cursorPath, 0o600);
  const replay = await runSupervisor(options);
  assert.equal(replay.state, "stopped");
  assert.equal(replay.processed, 1);
  assert.equal(replay.afterSeq, 1);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(acknowledgedSeq(openSpool(dir), "consumer-a"), 1);
  assert.equal(acknowledgedSeq(openSpool(dir), "consumer-b"), 1);
});

test("a SIGKILL leaves a recoverable stale lock and the next run continues", async (t) => {
  const { fx, poller } = await setupProject(t, ["after crash"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  const secrets = spoolDir();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secrets, { recursive: true, force: true });
  });
  const tokenPath = tokenFile(t, secrets, poller.token);
  const child = startInbox(
    [
      "supervise",
      "--base-url",
      baseUrl,
      "--project",
      "proj_1",
      "--spool-dir",
      dir,
      "--token-file",
      tokenPath,
      "--interval-ms",
      "60000",
    ],
    { CORKBOARD_INBOX_CONSUMERS: "consumer-a" },
  );
  await waitFor(() => liveSupervisor(dir));
  const pid = child.child.pid;
  assert.ok(pid !== undefined);
  process.kill(pid, "SIGKILL");
  const exited = await child.done;
  assert.equal(exited.signal, "SIGKILL");

  const stale = inspectSupervisorLock(openSpool(dir));
  assert.equal(stale.state, "stale");
  assert.equal(stale.reason, "process-gone");

  const restarted = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(restarted.state, "stopped");
  assert.equal(restarted.afterSeq, 1);
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 1);
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});

test("stop terminates only the follower, after durable state, and redacts output", async (t) => {
  const { fx, poller } = await setupProject(t, ["stop me"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  const secrets = spoolDir();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secrets, { recursive: true, force: true });
  });
  const tokenPath = tokenFile(t, secrets, poller.token);
  const child = startInbox([
    "supervise",
    "--base-url",
    baseUrl,
    "--project",
    "proj_1",
    "--spool-dir",
    dir,
    "--consumer",
    "consumer-a",
    "--token-file",
    tokenPath,
    "--interval-ms",
    "60000",
  ]);
  await waitFor(() => liveSupervisor(dir));
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!liveSupervisor(dir)) {
    const early = await child.done;
    throw new Error(
      `follower exited early: status=${early.status} signal=${early.signal}` +
        ` stdout=${early.stdout} stderr=${early.stderr}`,
    );
  }
  await waitFor(() => {
    try {
      return readSupervisorStatus(openSpool(dir)) !== null;
    } catch {
      return false;
    }
  });
  const health = await startInbox(["health", "--spool-dir", dir]).done;
  assert.equal(health.status, 0);
  assert.equal(health.stdout.includes("healthy=true"), true);

  // A paused follower keeps its live lock but stops refreshing the heartbeat.
  child.child.kill("SIGSTOP");
  await new Promise((resolve) => setTimeout(resolve, 250));
  const stale = await startInbox([
    "health",
    "--spool-dir",
    dir,
    "--max-heartbeat-age-ms",
    "100",
  ]).done;
  assert.equal(stale.status, 1);
  assert.equal(stale.stdout.includes("healthy=false"), true);
  assert.equal(stale.stdout.includes("stale_heartbeat=true"), true);
  child.child.kill("SIGCONT");
  await new Promise((resolve) => setTimeout(resolve, 50));

  const stopped = startInbox(["stop", "--spool-dir", dir, "--timeout-ms", "15000"], {
    CORKBOARD_APIKEY: poller.token,
  });
  const stoppedResult = await stopped.done;
  assert.equal(stoppedResult.status, 0);
  assert.equal(
    stoppedResult.stdout.includes("stopped"),
    true,
    `stop stdout=${stoppedResult.stdout} stderr=${stoppedResult.stderr}`,
  );
  assert.equal((stoppedResult.stdout + stoppedResult.stderr).includes(poller.token), false);

  const exited = await child.done;
  assert.equal(exited.status, 0);
  assert.equal((exited.stdout + exited.stderr).includes(poller.token), false);
  const spool = openSpool(dir);
  assert.equal(inspectSupervisorLock(spool).state, "absent");
  const status = readSupervisorStatus(spool);
  assert.ok(status !== null);
  assert.equal(status.state, "stopped");
  assert.equal(status.stop_reason, "signal");
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 1);
});

test("SIGTERM during the identity fetch stops cleanly instead of failing", async (t) => {
  const { poller } = await setupProject(t, []);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sockets = new Set<Socket>();
  let markRequest: () => void = () => {};
  const requestSeen = new Promise<void>((resolve) => {
    markRequest = resolve;
  });
  const server = createServer(() => {
    // Never respond: identity stays in flight until the supervisor is aborted.
    markRequest();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(
    () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback address");

  const controller = new AbortController();
  const pending = runSupervisor({
    baseUrl: `http://127.0.0.1:${address.port}`,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    signal: controller.signal,
    sleep: async () => {},
  });
  await requestSeen;
  controller.abort();
  const result = await pending;
  assert.equal(result.state, "stopped");
  assert.equal(result.exitCode, 0);
  assert.equal(result.status?.state, "stopped");
  assert.equal(result.status?.stop_reason, "signal");
  assert.equal(inspectSupervisorLock(openSpool(dir)).state, "absent");
});

test("a local disk write failure degrades without a receipt and recovers", async (t) => {
  const { fx, poller } = await setupProject(t, ["disk failure"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spool = prepareSpool(dir, "proj_1");
  t.after(() => {
    try {
      chmodSync(spool.eventsDir, 0o700);
    } catch {
      // Already restored or removed.
    }
  });
  chmodSync(spool.eventsDir, 0o500);

  const failed = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(failed.state, "degraded");
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.status?.degraded_reason, "INBOX_DISK");
  assert.deepEqual(listEvents(spool), []);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 0);
  await noReceipts(fx);

  chmodSync(spool.eventsDir, 0o700);
  const recovered = await runSupervisor({
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true,
    sleep: async () => {},
  });
  assert.equal(recovered.state, "stopped");
  assert.equal(await receiptCount(fx), 1);
  assert.equal(cursorAt(dir, "proj_1", "spk_poller", baseUrl), 1);
});

test("a losing concurrent start does not sweep the live holder's temp files", async (t) => {
  const { fx, poller } = await setupProject(t, ["held"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spool = prepareSpool(dir, "proj_1");
  const sentinel = join(spool.tmpDir, "0000000000000001.json.tmp-live-holder");
  writeFileSync(sentinel, "in-flight", { mode: 0o600 });
  chmodSync(sentinel, 0o600);
  const lock = acquireSupervisorLock(spool, { baseUrl });
  try {
    await assert.rejects(
      runSupervisor({
        baseUrl,
        token: poller.token,
        projectId: "proj_1",
        spoolDir: dir,
        consumerIds: ["consumer-a"],
        once: true,
        sleep: async () => {},
      }),
      (error: unknown) => error instanceof InboxError && error.code === "INBOX_LOCKED",
    );
  } finally {
    lock.release();
  }
  assert.equal(existsSync(sentinel), true);
});

test("a cursor bound to another server origin fails closed", async (t) => {
  const { fx, poller } = await setupProject(t, ["origin"]);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const options = {
    baseUrl,
    token: poller.token,
    projectId: "proj_1",
    spoolDir: dir,
    consumerIds: ["consumer-a"],
    once: true as const,
    sleep: async () => {},
  };
  const first = await runSupervisor(options);
  assert.equal(first.processed, 1);

  const cursorPath = join(dir, "cursor.json");
  const cursor = JSON.parse(readFileSync(cursorPath, "utf8")) as Record<string, unknown>;
  cursor.base_url = "http://other.example";
  writeFileSync(cursorPath, `${JSON.stringify(cursor)}\n`, { mode: 0o600 });
  chmodSync(cursorPath, 0o600);

  const rejected = await runSupervisor(options);
  assert.equal(rejected.state, "failed");
  assert.equal(rejected.exitCode, 3);
  assert.equal(rejected.status?.last_error, "UNSAFE_RESPONSE");
  assert.equal(listEvents(openSpool(dir)).length, 1);
  assert.equal(await receiptCount(fx), 1);
  const unchanged = JSON.parse(readFileSync(cursorPath, "utf8")) as { after_seq: number };
  assert.equal(unchanged.after_seq, 1);
});

test("stop refuses a live lock with no process-start identity without --force", async (t) => {
  const dir = spoolDir();
  const spool = prepareSpool(dir, "proj_1");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => {
    if (sleeper.pid !== undefined) {
      try {
        process.kill(sleeper.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  await waitFor(() => sleeper.pid !== undefined && existsSync(`/proc/${sleeper.pid}/stat`));
  const pid = sleeper.pid;
  assert.ok(pid !== undefined);

  const path = join(dir, SUPERVISOR_LOCK_FILE);
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      instance: "dddddddddddddddddddddddddddddddd",
      pid,
      boot_id: null,
      process_start: null,
      project_id: "proj_1",
      base_url: "http://127.0.0.1:9",
      started_at: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
  chmodSync(path, 0o600);

  const stopped = await startInbox(["stop", "--spool-dir", dir]).done;
  assert.equal(stopped.status, 1);
  assert.equal(stopped.stderr.includes("process-start identity"), true);
  assert.doesNotThrow(() => process.kill(pid, 0));
  assert.equal(inspectSupervisorLock(spool).state, "live");
  process.kill(pid, "SIGKILL");
});

test("the owner stops cleanly when its canonical lock is replaced", async (t) => {
  const { fx, poller } = await setupProject(t, []);
  const { baseUrl } = await startAppServer(t, fx);
  const dir = spoolDir();
  const secrets = spoolDir();
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(secrets, { recursive: true, force: true });
  });
  const tokenPath = tokenFile(t, secrets, poller.token);
  const child = startInbox([
    "supervise",
    "--base-url",
    baseUrl,
    "--project",
    "proj_1",
    "--spool-dir",
    dir,
    "--consumer",
    "consumer-a",
    "--token-file",
    tokenPath,
    "--interval-ms",
    "100",
  ]);
  await waitFor(() => {
    try {
      return readSupervisorStatus(openSpool(dir))?.state === "running";
    } catch {
      return false;
    }
  });

  const foreign = {
    version: 1,
    instance: "ffffffffffffffffffffffffffffffff",
    pid: process.pid,
    boot_id: null,
    process_start: null,
    project_id: "proj_1",
    base_url: baseUrl,
    started_at: new Date().toISOString(),
  };
  const lockPath = join(dir, SUPERVISOR_LOCK_FILE);
  writeFileSync(lockPath, `${JSON.stringify(foreign)}\n`, { mode: 0o600 });
  chmodSync(lockPath, 0o600);

  const exited = await child.done;
  assert.equal(exited.status, 0, exited.stderr);
  const status = readSupervisorStatus(openSpool(dir));
  assert.ok(status !== null);
  assert.equal(status.state, "stopped");
  assert.equal(status.stop_reason, "lock-lost");
  const current = inspectSupervisorLock(openSpool(dir));
  assert.equal(current.state, "live");
  assert.equal(current.record?.instance, foreign.instance);
});
