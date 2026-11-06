import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  PollError,
  loadCursorState,
  main,
  pollPass,
  redact,
  run,
  type CursorState,
  type PollMessage,
} from "../../scripts/poll.ts";

const root = mkdtempSync(join(tmpdir(), "corkboard-poll-test-"));
after(() => rmSync(root, { recursive: true, force: true }));

const TOKEN = "synthetic-poll-token";
const PROJECT = "proj_1";
const SPEAKER = "spk_poller";
const BASE = "http://127.0.0.1:9";

interface Call {
  method: string;
  url: URL;
  authorization: string | null;
  signal: AbortSignal | null;
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function fakeFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const auth = headers.get("author" + "ization");
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      url: new URL(String(input)),
      authorization: auth,
      signal: init?.signal ?? null,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

function row(seq: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    message_id: `msg_${seq}`,
    project_id: PROJECT,
    seq,
    sender: { id: "spk_sender", display_name: "Sender" },
    summary: `summary ${seq}`,
    type: "request",
    language: "en",
    reply_to_id: null,
    body_state: "ready",
    body_expires_at: null,
    client_sent_at: null,
    received_at: "2026-11-03T12:00:00.000Z",
    committed_at: "2026-11-03T12:00:01.000Z",
    ...overrides,
  };
}

function page(messages: Array<Record<string, unknown>>): Record<string, unknown> {
  return {
    messages,
    next_cursor: messages.length === 0 ? null : (messages.at(-1)?.seq ?? null),
  };
}

function receipt(messageId: string, speakerId = SPEAKER): Record<string, unknown> {
  return {
    message_id: messageId,
    speaker_id: speakerId,
    read_at: "2026-11-03T12:00:02.000Z",
  };
}

function identityResponse(speakerId = SPEAKER): Response {
  return jsonResponse({
    speaker: { id: speakerId, display_name: "Poller" },
    account: { id: "acct_poller" },
    scopes: ["message.read", "receipt.write"],
    projects: [PROJECT],
  });
}

function isPoll(exitCode: number, code: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof PollError);
    assert.equal(error.exitCode, exitCode);
    assert.equal(error.code, code);
    return true;
  };
}

function cursorPath(name: string): string {
  return join(root, `${name}.json`);
}

function readCursor(path: string): CursorState {
  return JSON.parse(readFileSync(path, "utf8")) as CursorState;
}

function assertNoTempFiles(directory: string): void {
  assert.deepEqual(
    readdirSync(directory).filter((name) => name.includes(".tmp-")),
    [],
  );
}

function readUrl(call: Call): boolean {
  return call.method === "GET" && call.url.pathname.endsWith("/messages");
}

function readMessageUrl(call: Call): boolean {
  return call.method === "POST" && call.url.pathname.endsWith("/read");
}

const baseOptions = {
  baseUrl: BASE,
  token: TOKEN,
  projectId: PROJECT,
  speakerId: SPEAKER,
  sleep: async () => {},
  stdout: () => {},
  stderr: () => {},
  now: () => new Date("2026-11-03T12:00:00.000Z"),
};

test("the cursor advances only after a confirmed mark_read and stays private", async () => {
  const path = cursorPath("confirmed");
  let pageRequests = 0;
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (readUrl(call)) {
      pageRequests += 1;
      if (pageRequests === 1) return jsonResponse(page([row(1), row(2)]));
      return jsonResponse(page([]));
    }
    if (readMessageUrl(call)) {
      const messageId = call.url.pathname.split("/").at(-2) ?? "";
      return jsonResponse(receipt(messageId));
    }
    throw new Error("unexpected request");
  });

  const result = await pollPass({
    ...baseOptions,
    cursorPath: path,
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    fetchImpl,
  });

  assert.equal(result.processed, 2);
  assert.equal(result.pages, 1);
  assert.equal(result.afterSeq, 2);
  assert.deepEqual(readCursor(path), {
    version: 1,
    project_id: PROJECT,
    speaker_id: SPEAKER,
    after_seq: 2,
    updated_at: "2026-11-03T12:00:00.000Z",
  });
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assertNoTempFiles(root);
  assert.equal(calls.filter(readMessageUrl).length, 2);
  for (const call of calls) {
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
    assert.equal(call.url.toString().includes(TOKEN), false);
  }
  for (const call of calls.filter(readUrl)) {
    assert.equal(call.url.searchParams.get("limit"), "10");
  }
});

test("a rejected mark_read leaves the cursor at the previous confirmed message", async () => {
  const path = cursorPath("rejected");
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1), row(2)]));
    if (readMessageUrl(call)) {
      const messageId = call.url.pathname.split("/").at(-2) ?? "";
      if (messageId === "msg_2") {
        return jsonResponse({ error: { code: "FORBIDDEN", message: "Not allowed" } }, 403);
      }
      return jsonResponse(receipt(messageId));
    }
    throw new Error("unexpected request");
  });

  await assert.rejects(
    pollPass({ ...baseOptions, cursorPath: path, afterSeq: 0, limit: 10, maxPages: 1, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 3);
      assert.equal(error.code, "MARK_READ_REJECTED");
      return true;
    },
  );

  assert.equal(readCursor(path).after_seq, 1);
  assert.equal(calls.filter(readMessageUrl).length, 2);
  assert.equal(
    calls.filter((call) => call.url.pathname.endsWith("/msg_2/read")).length,
    1,
  );
});

test("an uncertain mark_read is retried with the same request and reprocesses on restart", async () => {
  const path = cursorPath("at-least-once");
  const seen: PollMessage[] = [];
  let markReadCalls = 0;
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1)]));
    if (readMessageUrl(call)) {
      markReadCalls += 1;
      throw new Error("connection reset");
    }
    throw new Error("unexpected request");
  });

  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: path,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl,
      onMessage: (message) => {
        seen.push(message);
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 1);
      assert.equal(error.code, "MARK_READ_UNCERTAIN");
      return true;
    },
  );

  // Three identical attempts on the same message, no cursor write before any
  // confirmation.
  assert.equal(markReadCalls, 3);
  const retried = calls.filter(readMessageUrl);
  assert.equal(retried.length, 3);
  assert.equal(new Set(retried.map((call) => call.url.toString())).size, 1);
  assert.equal(retried[0]?.url.pathname.endsWith("/msg_1/read"), true);
  assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
  assert.deepEqual(seen.map((message) => message.seq), [1]);

  // A later process starts at the last durable cursor and processes seq 1 again.
  const retry = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1)]));
    if (readMessageUrl(call)) return jsonResponse(receipt("msg_1"));
    throw new Error("unexpected request");
  });
  const result = await pollPass({
    ...baseOptions,
    cursorPath: path,
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    fetchImpl: retry.fetchImpl,
    onMessage: (message) => {
      seen.push(message);
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(readCursor(path).after_seq, 1);
  assert.deepEqual(seen.map((message) => message.seq), [1, 1]);
});

test("a foreign-project row fails closed before mark_read", async () => {
  const path = cursorPath("foreign");
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1, { project_id: "proj_other" })]));
    throw new Error("unexpected request");
  });

  await assert.rejects(
    pollPass({ ...baseOptions, cursorPath: path, afterSeq: 0, limit: 10, maxPages: 1, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 3);
      assert.equal(error.code, "UNSAFE_RESPONSE");
      return true;
    },
  );
  assert.equal(calls.filter(readMessageUrl).length, 0);
  assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
});

test("a malformed or inconsistent page fails closed", async () => {
  const path = cursorPath("malformed");
  const { fetchImpl } = fakeFetch((call) => {
    if (readUrl(call)) {
      return jsonResponse({ messages: [row(1)], next_cursor: 99 });
    }
    throw new Error("unexpected request");
  });

  await assert.rejects(
    pollPass({ ...baseOptions, cursorPath: path, afterSeq: 0, limit: 10, maxPages: 1, fetchImpl }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 3);
      assert.equal(error.code, "UNSAFE_RESPONSE");
      return true;
    },
  );
});

test("a cursor from another speaker is rejected before polling", async () => {
  const path = cursorPath("foreign-speaker");
  writeFileSync(
    path,
    `${JSON.stringify({
      version: 1,
      project_id: PROJECT,
      speaker_id: "spk_other",
      after_seq: 4,
      updated_at: "2026-11-03T12:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );

  const { fetchImpl, calls } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") {
      return jsonResponse({
        speaker: { id: SPEAKER, display_name: "Poller" },
        account: { id: "acct_poller" },
        scopes: ["message.read", "receipt.write"],
        projects: [PROJECT],
      });
    }
    throw new Error("polling must not start with a mismatched cursor");
  });

  await assert.rejects(
    run({ ...baseOptions, cursorPath: path, fetchImpl, once: true }),
    (error: unknown) => {
      assert.ok(error instanceof PollError);
      assert.equal(error.exitCode, 3);
      return true;
    },
  );
  assert.equal(calls.some(readUrl), false);
});

test("the credential is never printed, logged, or placed in a URL", async () => {
  const path = cursorPath("redaction");
  const output: string[] = [];
  const errors: string[] = [];
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") {
      return jsonResponse({
        speaker: { id: SPEAKER, display_name: "Poller" },
        account: { id: "acct_poller" },
        scopes: ["message.read", "receipt.write"],
        projects: [PROJECT],
      });
    }
    if (readUrl(call)) {
      return jsonResponse(page([row(1, { summary: `hostile ${TOKEN} summary` })]));
    }
    if (readMessageUrl(call)) return jsonResponse(receipt("msg_1"));
    throw new Error("unexpected request");
  });

  const code = await main(
    [
      "--base-url",
      BASE,
      "--project",
      PROJECT,
      "--cursor-file",
      path,
      "--once",
      "--show-summary",
    ],
    { CORKBOARD_APIKEY: TOKEN },
    {
      fetchImpl,
      stdout: (line) => output.push(line),
      stderr: (line) => errors.push(line),
    },
  );

  assert.equal(code, 0);
  const printed = [...output, ...errors].join("\n");
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(output.join("\n").includes("[REDACTED]"), true);
  assert.deepEqual(errors, []);
  for (const call of calls) {
    assert.equal(call.url.toString().includes(TOKEN), false);
    assert.equal(call.authorization, `Bearer ${TOKEN}`);
  }
});

test("a 0600 credential file is accepted and a looser mode is rejected without echoing it", async () => {
  const path = cursorPath("token-file");
  const tokenFile = join(root, "agent-key");
  writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(tokenFile, 0o600);

  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") {
      return jsonResponse({
        speaker: { id: SPEAKER, display_name: "Poller" },
        account: { id: "acct_poller" },
        scopes: ["message.read", "receipt.write"],
        projects: [PROJECT],
      });
    }
    if (readUrl(call)) return jsonResponse(page([]));
    throw new Error("unexpected request");
  });

  const ok = await main(
    ["--base-url", BASE, "--project", PROJECT, "--cursor-file", path, "--token-file", tokenFile, "--once"],
    {},
    { fetchImpl, stdout: () => {}, stderr: () => {} },
  );
  assert.equal(ok, 0);

  chmodSync(tokenFile, 0o644);
  const errors: string[] = [];
  const rejected = await main(
    ["--base-url", BASE, "--project", PROJECT, "--cursor-file", cursorPath("token-file-2"), "--token-file", tokenFile, "--once"],
    {},
    { fetchImpl, stdout: () => {}, stderr: (line) => errors.push(line) },
  );
  assert.equal(rejected, 2);
  assert.equal(errors.join("\n").includes(TOKEN), false);
  assert.match(errors.join("\n"), /mode 0600/);
});

test("redact replaces every occurrence and leaves other text alone", () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), "a [REDACTED] b [REDACTED]");
  assert.equal(redact("plain", TOKEN), "plain");
});


test("a stalled response body is aborted at the request deadline", async () => {
  const path = cursorPath("stalled-body");
  const { fetchImpl } = fakeFetch((call) => {
    if (!readUrl(call)) throw new Error("unexpected request");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        call.signal?.addEventListener("abort", () => controller.error(new Error("aborted")), {
          once: true,
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });

  const started = Date.now();
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: path,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl,
      requestTimeoutMs: 30,
    }),
    isPoll(1, "TIMEOUT"),
  );
  assert.ok(Date.now() - started < 2_000);
  assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
});

test("a signal during a body read stops the client without advancing", async () => {
  const controller = new AbortController();
  let bodyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    bodyStarted = resolve;
  });
  const { fetchImpl } = fakeFetch((call) => {
    if (!readUrl(call)) throw new Error("unexpected request");
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{"messages":['));
        bodyStarted();
        call.signal?.addEventListener(
          "abort",
          () => streamController.error(new Error("aborted")),
          { once: true },
        );
      },
    });
    return new Response(stream, { status: 200 });
  });

  const pending = pollPass({
    ...baseOptions,
    cursorPath: cursorPath("signal-body"),
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    fetchImpl,
    signal: controller.signal,
    requestTimeoutMs: 10_000,
  });
  await started;
  controller.abort();
  const result = await pending;
  assert.equal(result.stopped, true);
  assert.equal(result.afterSeq, 0);
});

test("an oversized body fails closed, including an error body", async () => {
  const cap = 32;
  const oversizedSuccess = jsonResponse(page([row(1, { summary: "x".repeat(200) })]));
  const success = fakeFetch((call) => {
    if (readUrl(call)) return oversizedSuccess;
    throw new Error("unexpected request");
  });
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: cursorPath("cap-success"),
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl: success.fetchImpl,
      maxResponseBytes: cap,
    }),
    isPoll(3, "BODY_TOO_LARGE"),
  );

  const oversizedError = jsonResponse(
    { error: { code: "FORBIDDEN", padding: "x".repeat(200) } },
    403,
  );
  const failure = fakeFetch((call) => {
    if (readUrl(call)) return oversizedError;
    throw new Error("unexpected request");
  });
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: cursorPath("cap-error"),
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl: failure.fetchImpl,
      maxResponseBytes: cap,
    }),
    isPoll(3, "BODY_TOO_LARGE"),
  );
});

test("BODY_EXPIRED advances while other definitive and transient failures do not", async () => {
  const expiredPath = cursorPath("expired");
  const statusLines: string[] = [];
  const expired = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1)]));
    if (readMessageUrl(call)) return jsonResponse({ error: { code: "BODY_EXPIRED" } }, 410);
    throw new Error("unexpected request");
  });
  const result = await pollPass({
    ...baseOptions,
    cursorPath: expiredPath,
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    fetchImpl: expired.fetchImpl,
    stdout: (line) => statusLines.push(line),
  });
  assert.equal(result.processed, 1);
  assert.equal(result.afterSeq, 1);
  assert.equal(readCursor(expiredPath).after_seq, 1);
  assert.match(statusLines.join("\n"), /status=BODY_EXPIRED/);

  for (const variant of [
    { status: 401, code: "FORBIDDEN", exitCode: 3 },
    { status: 403, code: "FORBIDDEN", exitCode: 3 },
    { status: 404, code: "NOT_FOUND", exitCode: 3 },
    // A 410 is only consumable with the exact BODY_EXPIRED code.
    { status: 410, code: "INTEGRITY_FAILURE", exitCode: 3 },
    { status: 500, code: "UNAVAILABLE", exitCode: 1 },
  ] as const) {
    const path = cursorPath(`reject-${variant.status}-${variant.code}`);
    const failure = fakeFetch((call) => {
      if (readUrl(call)) return jsonResponse(page([row(1)]));
      if (readMessageUrl(call)) {
        return jsonResponse({ error: { code: variant.code } }, variant.status);
      }
      throw new Error("unexpected request");
    });
    await assert.rejects(
      pollPass({
        ...baseOptions,
        cursorPath: path,
        afterSeq: 0,
        limit: 10,
        maxPages: 1,
        fetchImpl: failure.fetchImpl,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PollError);
        assert.equal(error.exitCode, variant.exitCode);
        return true;
      },
    );
    assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
    assert.equal(
      failure.calls.filter(readMessageUrl).length,
      variant.exitCode === 1 ? 3 : 1,
    );
  }
});

test("mark_read success must name the requested message and speaker", async () => {
  for (const [name, overrides] of [
    ["wrong message", { message_id: "msg_other" }],
    ["wrong speaker", { speaker_id: "spk_other" }],
  ] as const) {
    const path = cursorPath(`mismatch-${name.replaceAll(" ", "-")}`);
    const { fetchImpl } = fakeFetch((call) => {
      if (readUrl(call)) return jsonResponse(page([row(1)]));
      if (readMessageUrl(call)) {
        return jsonResponse({ ...receipt("msg_1"), ...overrides });
      }
      throw new Error("unexpected request");
    });
    await assert.rejects(
      pollPass({
        ...baseOptions,
        cursorPath: path,
        afterSeq: 0,
        limit: 10,
        maxPages: 1,
        fetchImpl,
      }),
      isPoll(3, "UNSAFE_RESPONSE"),
    );
    assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
  }
});

test("non-increasing sequences and oversized pages fail closed", async () => {
  const nonIncreasing = fakeFetch((call) => {
    if (readUrl(call)) {
      return jsonResponse({
        messages: [row(1), row(1, { message_id: "msg_1b" })],
        next_cursor: 1,
      });
    }
    throw new Error("unexpected request");
  });
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: cursorPath("non-increasing"),
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl: nonIncreasing.fetchImpl,
    }),
    isPoll(3, "UNSAFE_RESPONSE"),
  );

  const oversized = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1), row(2)]));
    throw new Error("unexpected request");
  });
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: cursorPath("oversized-page"),
      afterSeq: 0,
      limit: 1,
      maxPages: 1,
      fetchImpl: oversized.fetchImpl,
    }),
    isPoll(3, "UNSAFE_RESPONSE"),
  );
});

test("transient mark_read retries honor a numeric Retry-After on 429 and 5xx", async () => {
  for (const status of [429, 503] as const) {
    const sleeps: number[] = [];
    let attempts = 0;
    const { fetchImpl, calls } = fakeFetch((call) => {
      if (readUrl(call)) return jsonResponse(page([row(1)]));
      if (readMessageUrl(call)) {
        attempts += 1;
        if (attempts === 1) {
          return jsonResponse(
            { error: { code: status === 429 ? "RATE_LIMITED" : "UNAVAILABLE" } },
            status,
            { "retry-after": "2" },
          );
        }
        return jsonResponse(receipt("msg_1"));
      }
      throw new Error("unexpected request");
    });
    const result = await pollPass({
      ...baseOptions,
      cursorPath: cursorPath(`retry-after-${status}`),
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    assert.equal(result.processed, 1);
    assert.deepEqual(sleeps, [2000]);
    const retried = calls.filter(readMessageUrl);
    assert.equal(retried.length, 2);
    assert.equal(new Set(retried.map((call) => call.url.toString())).size, 1);
  }
});

test("an identity 5xx is transient, not a credential configuration error", async () => {
  const errors: string[] = [];
  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") {
      return jsonResponse({ error: { code: "UNAVAILABLE" } }, 503);
    }
    throw new Error("unexpected request");
  });
  const code = await main(
    ["--base-url", BASE, "--project", PROJECT, "--cursor-file", cursorPath("identity-503"), "--once"],
    { CORKBOARD_APIKEY: TOKEN },
    {
      fetchImpl,
      stdout: () => {},
      stderr: (line) => errors.push(line),
    },
  );
  assert.equal(code, 1);
  assert.match(errors.join("\n"), /status 503/);
});

test("server error codes are redacted and terminal-escaped", async () => {
  const hostCode = "\u001b[31mleak-" + TOKEN;
  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") return identityResponse();
    if (readUrl(call)) return jsonResponse({ error: { code: hostCode } }, 403);
    throw new Error("unexpected request");
  });
  const errors: string[] = [];
  const code = await main(
    ["--base-url", BASE, "--project", PROJECT, "--cursor-file", cursorPath("escaped-error"), "--once"],
    { CORKBOARD_APIKEY: TOKEN },
    {
      fetchImpl,
      stdout: () => {},
      stderr: (line) => errors.push(line),
    },
  );
  assert.equal(code, 2);
  const printed = errors.join("\n");
  assert.equal(printed.includes(TOKEN), false);
  assert.equal(printed.includes("\u001b"), false);
  assert.equal(printed.includes("\\u001b"), true);
  assert.equal(printed.includes("[REDACTED]"), true);
});

test("cursor reads refuse loose, symlinked, malformed, and wrong-project state", () => {
  const state = {
    version: 1,
    project_id: PROJECT,
    speaker_id: SPEAKER,
    after_seq: 3,
    updated_at: "2026-11-03T12:00:00.000Z",
  };
  const loose = cursorPath("cursor-loose");
  writeFileSync(loose, `${JSON.stringify(state)}\n`, { mode: 0o644 });
  chmodSync(loose, 0o644);
  assert.throws(
    () => loadCursorState(loose, PROJECT, SPEAKER, () => new Date()),
    isPoll(3, "UNSAFE_RESPONSE"),
  );

  const malformed = cursorPath("cursor-malformed");
  writeFileSync(malformed, "{not json", { mode: 0o600 });
  chmodSync(malformed, 0o600);
  assert.throws(
    () => loadCursorState(malformed, PROJECT, SPEAKER, () => new Date()),
    isPoll(3, "UNSAFE_RESPONSE"),
  );

  const wrongProject = cursorPath("cursor-wrong-project");
  writeFileSync(wrongProject, `${JSON.stringify({ ...state, project_id: "proj_other" })}\n`, {
    mode: 0o600,
  });
  chmodSync(wrongProject, 0o600);
  assert.throws(
    () => loadCursorState(wrongProject, PROJECT, SPEAKER, () => new Date()),
    isPoll(3, "UNSAFE_RESPONSE"),
  );

  if (process.platform !== "win32") {
    const real = cursorPath("cursor-real");
    writeFileSync(real, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    chmodSync(real, 0o600);
    const link = cursorPath("cursor-link");
    symlinkSync(real, link);
    assert.throws(
      () => loadCursorState(link, PROJECT, SPEAKER, () => new Date()),
      isPoll(3, "UNSAFE_RESPONSE"),
    );
  }
});

test("a symlinked credential file is rejected without echoing the token", async () => {
  if (process.platform === "win32") return;
  const real = join(root, "agent-key-real");
  writeFileSync(real, `${TOKEN}\n`, { mode: 0o600 });
  chmodSync(real, 0o600);
  const link = join(root, "agent-key-link");
  symlinkSync(real, link);

  const errors: string[] = [];
  const code = await main(
    ["--base-url", BASE, "--project", PROJECT, "--cursor-file", cursorPath("symlink-token"), "--token-file", link, "--once"],
    {},
    {
      stdout: () => {},
      stderr: (line) => errors.push(line),
    },
  );
  assert.equal(code, 2);
  assert.equal(errors.join("\n").includes(TOKEN), false);
});

test("an abort stops the between-pass sleep promptly", async () => {
  const controller = new AbortController();
  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") return identityResponse();
    if (readUrl(call)) return jsonResponse(page([]));
    throw new Error("unexpected request");
  });
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  const result = await run({
    ...baseOptions,
    cursorPath: cursorPath("abortable-sleep"),
    fetchImpl,
    signal: controller.signal,
    intervalMs: 5_000,
  });
  assert.equal(result.stopped, true);
  assert.ok(Date.now() - started < 1_000);
});

test("a consumer processing failure leaves no acknowledgement and no cursor advance", async () => {
  const path = cursorPath("process-failed");
  const { fetchImpl, calls } = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1)]));
    throw new Error("unexpected request");
  });
  await assert.rejects(
    pollPass({
      ...baseOptions,
      cursorPath: path,
      afterSeq: 0,
      limit: 10,
      maxPages: 1,
      fetchImpl,
      onMessage: () => {
        throw new Error("consumer failed");
      },
    }),
    isPoll(1, "PROCESS_FAILED"),
  );
  assert.equal(calls.filter(readMessageUrl).length, 0);
  assert.equal(loadCursorState(path, PROJECT, SPEAKER, () => new Date()).after_seq, 0);
});

test("control and bidirectional summary characters are escaped in output", async () => {
  const output: string[] = [];
  const summary = "ok\u001b[31m\u202eevil";
  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") return identityResponse();
    if (readUrl(call)) return jsonResponse(page([row(1, { summary })]));
    if (readMessageUrl(call)) return jsonResponse(receipt("msg_1"));
    throw new Error("unexpected request");
  });
  const code = await main(
    [
      "--base-url",
      BASE,
      "--project",
      PROJECT,
      "--cursor-file",
      cursorPath("summary-escape"),
      "--once",
      "--show-summary",
    ],
    { CORKBOARD_APIKEY: TOKEN },
    {
      fetchImpl,
      stdout: (line) => output.push(line),
      stderr: () => {},
    },
  );
  assert.equal(code, 0);
  const printed = output.join("\n");
  assert.equal(printed.includes("\u001b"), false);
  assert.equal(printed.includes("\u202e"), false);
  assert.equal(printed.includes("\\u001b"), true);
  assert.equal(printed.includes("\\u202e"), true);
});

test("an abort during mark_read retry backoff stops promptly", async () => {
  const controller = new AbortController();
  let markReadCalls = 0;
  const { fetchImpl } = fakeFetch((call) => {
    if (readUrl(call)) return jsonResponse(page([row(1)]));
    if (readMessageUrl(call)) {
      markReadCalls += 1;
      return jsonResponse({ error: { code: "RATE_LIMITED" } }, 429, { "retry-after": "5" });
    }
    throw new Error("unexpected request");
  });
  const started = Date.now();
  setTimeout(() => controller.abort(), 20);
  const result = await pollPass({
    ...baseOptions,
    sleep: undefined,
    cursorPath: cursorPath("abort-retry-backoff"),
    afterSeq: 0,
    limit: 10,
    maxPages: 1,
    fetchImpl,
    signal: controller.signal,
  });
  assert.equal(result.stopped, true);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(markReadCalls, 1);
  assert.equal(
    loadCursorState(cursorPath("abort-retry-backoff"), PROJECT, SPEAKER, () => new Date())
      .after_seq,
    0,
  );
});

test("a control-character credential echoed in a summary is redacted", async () => {
  const controlToken = "synthetic-control-token" + String.fromCharCode(1);
  const output: string[] = [];
  const { fetchImpl } = fakeFetch((call) => {
    if (call.url.pathname === "/api/v1/me") return identityResponse();
    if (readUrl(call)) {
      return jsonResponse(page([row(1, { summary: `echo ${controlToken} end` })]));
    }
    if (readMessageUrl(call)) return jsonResponse(receipt("msg_1"));
    throw new Error("unexpected request");
  });
  const code = await main(
    [
      "--base-url",
      BASE,
      "--project",
      PROJECT,
      "--cursor-file",
      cursorPath("control-token-summary"),
      "--once",
      "--show-summary",
    ],
    { CORKBOARD_APIKEY: controlToken },
    {
      fetchImpl,
      stdout: (line) => output.push(line),
      stderr: () => {},
    },
  );
  assert.equal(code, 0);
  const printed = output.join("\n");
  assert.equal(printed.includes("synthetic-control-token"), false);
  assert.equal(printed.includes(String.fromCharCode(1)), false);
  assert.equal(printed.includes("[REDACTED]"), true);
});
