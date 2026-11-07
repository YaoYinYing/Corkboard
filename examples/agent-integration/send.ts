#!/usr/bin/env node
// Send one message to a Corkboard project with a caller-generated
// Idempotency-Key.
//
// The bearer credential comes from CORKBOARD_APIKEY in the environment. It is
// never accepted in argv and never printed. Message text is untrusted content;
// this example computes its digest and posts it without interpreting it.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  MAX_RESPONSE_BYTES,
  PollError,
  REQUEST_TIMEOUT_MS,
  parseBaseUrl,
  readCappedBody,
  redactAndEscape,
  timeoutSignal,
} from "../../scripts/poll.ts";
import { AgentConfigError, requireApiKey, safeErrorMessage } from "./lib.ts";

const USAGE = `Usage: node examples/agent-integration/send.ts --summary <text> (--text <text> | --text-file <path>) --idempotency-key <key> [options]

Options:
  --base-url <url>            Server origin (CORKBOARD_BASE_URL)
  --project <projectId>       Target project (CORKBOARD_PROJECT_ID)
  --summary <text>            Required message summary
  --text <text>               Message text (or --text-file, not both)
  --text-file <path>          Read the message text from a UTF-8 file
  --idempotency-key <key>     Caller-generated; 1-128 printable ASCII (0x21-0x7E)
  --type <type>               Message type (default request)
  --language <tag>            BCP 47 language (default en)
  --help                      Show this help

The credential is read from CORKBOARD_APIKEY only. Do not pass it in argv or
place it in a message. Reuse one Idempotency-Key for retries of the same payload;
a different payload under the same key is a 409 conflict.`;

const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,128}$/;

// Test seams only. Production callers use the defaults, which mirror
// scripts/poll.ts: a 15-second deadline and a 1 MiB streamed response cap.
export interface SendContext {
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
  requestTimeoutMs?: number | undefined;
  maxResponseBytes?: number | undefined;
  stdout?: ((line: string) => void) | undefined;
  stderr?: ((line: string) => void) | undefined;
}

function defaultStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function defaultStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

const OPTIONS = {
  "base-url": { type: "string" },
  project: { type: "string" },
  summary: { type: "string" },
  text: { type: "string" },
  "text-file": { type: "string" },
  "idempotency-key": { type: "string" },
  type: { type: "string" },
  language: { type: "string" },
  help: { type: "boolean" },
} as const;

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

function required(
  value: string | undefined,
  envValue: string | undefined,
  label: string,
): string {
  const resolved = (value ?? envValue)?.trim();
  if (resolved === undefined || resolved === "") {
    throw new AgentConfigError(`${label} is required`);
  }
  return resolved;
}

function resolveText(values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"]): string {
  if (values.text !== undefined && values["text-file"] !== undefined) {
    throw new AgentConfigError("use --text or --text-file, not both");
  }
  if (values["text-file"] !== undefined) {
    try {
      return readFileSync(values["text-file"], "utf8");
    } catch {
      throw new AgentConfigError("--text-file is not readable");
    }
  }
  if (values.text !== undefined) return values.text;
  throw new AgentConfigError("--text or --text-file is required");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serverErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload) || !isRecord(payload.error)) return undefined;
  return typeof payload.error.code === "string" ? payload.error.code : undefined;
}

function parseResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new PollError(3, "UNSAFE_RESPONSE", "send response is not valid JSON");
  }
}

function finishSend(
  response: Response,
  responseText: string,
  projectId: string,
  token: string,
  stdout: (line: string) => void,
): number {
  const payload = parseResponse(responseText);

  if (response.status !== 201 && response.status !== 200) {
    const code = serverErrorCode(payload);
    throw new PollError(
      1,
      "SEND_FAILED",
      `send rejected with status ${response.status}${code === undefined ? "" : ` (${code})`}`,
    );
  }
  if (
    !isRecord(payload) ||
    typeof payload.message_id !== "string" ||
    payload.message_id === "" ||
    payload.project_id !== projectId ||
    typeof payload.seq !== "number" ||
    !Number.isSafeInteger(payload.seq) ||
    payload.seq <= 0
  ) {
    throw new PollError(
      3,
      "UNSAFE_RESPONSE",
      "send response does not match the requested project",
    );
  }

  // Server-generated identifiers are still untrusted input: redact and escape.
  stdout(
    redactAndEscape(
      `status=${response.status} message_id=${payload.message_id} seq=${payload.seq}`,
      token,
    ),
  );
  return 0;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
  deps: SendContext = {},
): Promise<number> {
  const stdout = deps.stdout ?? defaultStdout;
  const stderr = deps.stderr ?? defaultStderr;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  // Seed redaction with the raw environment value so a failure before
  // requireApiKey still cannot print it.
  let token = env.CORKBOARD_APIKEY ?? "";

  let values: ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];
  try {
    values = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: false,
    }).values;
  } catch {
    stderr("send: invalid arguments (use --help)");
    return 2;
  }

  if (values.help === true) {
    stdout(USAGE);
    return 0;
  }

  try {
    token = requireApiKey(env);
    const baseUrl = parseBaseUrl(
      required(values["base-url"], env.CORKBOARD_BASE_URL, "base URL"),
    );
    const projectId = required(values.project, env.CORKBOARD_PROJECT_ID, "project");
    const summary = required(values.summary, undefined, "summary");
    const idempotencyKey = required(values["idempotency-key"], undefined, "idempotency key");
    if (!IDEMPOTENCY_KEY.test(idempotencyKey)) {
      throw new AgentConfigError(
        "idempotency key must be 1-128 non-space printable ASCII characters",
      );
    }
    const text = resolveText(values);
    const type = values.type ?? "request";
    const language = values.language ?? "en";

    const url = new URL(
      `/api/v1/projects/${encodeURIComponent(projectId)}/messages`,
      baseUrl,
    );
    // Mirror scripts/poll.ts: one deadline covers the request and the streamed
    // response, and the body is read under a hard cap without trusting
    // Content-Length.
    const scoped = timeoutSignal(
      deps.signal,
      deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
    );
    try {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify({
          summary,
          type,
          language,
          text,
          body_digest: digest(text),
        }),
        signal: scoped.signal,
      });
      const responseText = await readCappedBody(
        response,
        scoped.abort,
        deps.signal,
        () => scoped.signal.aborted && deps.signal?.aborted !== true,
        deps.maxResponseBytes ?? MAX_RESPONSE_BYTES,
      );
      return finishSend(response, responseText, projectId, token, stdout);
    } catch (error) {
      if (error instanceof PollError) throw error;
      if (deps.signal?.aborted) {
        throw new PollError(0, "STOPPED", "stopped by signal");
      }
      if (scoped.signal.aborted) {
        throw new PollError(1, "TIMEOUT", "send request timed out");
      }
      throw new PollError(1, "NETWORK", "send request failed");
    } finally {
      scoped.cancel();
    }
  } catch (error) {
    const code =
      error instanceof AgentConfigError ? 2 : error instanceof PollError ? error.exitCode : 1;
    stderr(`send: ${safeErrorMessage(error, token)}`);
    return code;
  }
}

function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
