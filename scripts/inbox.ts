#!/usr/bin/env node
// Operator CLI for the local Corkboard inbox bridge.
//
// The bridge reuses scripts/poll.ts for transport, verification, receipts, and
// the durable cursor. This file only parses arguments and exposes the local
// spool: run (poll -> queue), list (metadata for one consumer), ack, and prune.
//
// Message bodies are never printed or executed. The credential is read from
// CORKBOARD_APIKEY or a 0600 --token-file and is always redacted on output.
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
  MAX_LIMIT,
  MAX_PAGES,
  PollError,
  escapeForTerminal,
  parseBaseUrl,
  redactAndEscape,
  resolveToken,
} from "../scripts/poll.ts";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_EVENT_BYTES,
  DEFAULT_MAX_EVENTS,
  DEFAULT_RETENTION_MS,
  InboxError,
  ackEvent,
  openSpool,
  pendingEvents,
  pruneSpool,
} from "../src/inbox/index.ts";
import { runInbox } from "../src/inbox/bridge.ts";

const USAGE = `Usage: node scripts/inbox.ts <command> [options]

Commands:
  run     Poll one project and durably queue events for local consumers
  list    Print metadata events a consumer has not acknowledged
  ack     Acknowledge the next contiguous event for a consumer
  prune   Remove events every registered consumer has acknowledged

Common:
  --spool-dir <path>      Spool directory outside the repository (CORKBOARD_INBOX_SPOOL)
  --help                  Show this help

run:
  --base-url <url>        Server origin (CORKBOARD_BASE_URL)
  --project <projectId>   One project (CORKBOARD_PROJECT_ID)
  --consumer <id>         Consumer to register (repeatable, at least one)
  --token-file <path>     Alternative to CORKBOARD_APIKEY: 0600 file, one token
  --plaintext             Persist verified plaintext in the private payload spool
  --once                  Run one bounded pass, then exit
  --interval-ms <ms>      Delay between passes (default ${DEFAULT_INTERVAL_MS})
  --limit <1-100>         Page size per request (default ${DEFAULT_LIMIT})
  --max-pages <1-100>     Pages per pass (default ${DEFAULT_MAX_PAGES})
  --max-events <n>        Event-file cap (default ${DEFAULT_MAX_EVENTS})
  --max-bytes <n>         Spool byte cap (default ${DEFAULT_MAX_BYTES})
  --max-event-bytes <n>   Per-record byte cap (default ${DEFAULT_MAX_EVENT_BYTES})
  --retention-ms <ms>     Acked-event retention (default ${DEFAULT_RETENTION_MS})

list:
  --consumer <id>         Consumer whose unacknowledged events are listed
  --limit <n>             Maximum events (default 100)

ack:
  --consumer <id>         Consumer to advance
  --seq <n>               Next contiguous sequence to acknowledge

prune:
  --force                 Ignore the retention window for acknowledged events

Default mode is metadata-only. No command prints a body, digest, or credential.`;

const OPTIONS = {
  "base-url": { type: "string" },
  project: { type: "string" },
  "spool-dir": { type: "string" },
  consumer: { type: "string", multiple: true },
  "token-file": { type: "string" },
  plaintext: { type: "boolean" },
  once: { type: "boolean" },
  "interval-ms": { type: "string" },
  limit: { type: "string" },
  "max-pages": { type: "string" },
  "max-events": { type: "string" },
  "max-bytes": { type: "string" },
  "max-event-bytes": { type: "string" },
  "retention-ms": { type: "string" },
  seq: { type: "string" },
  force: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function required(value: string | undefined, envValue: string | undefined, label: string): string {
  const resolved = (value ?? envValue)?.trim();
  if (resolved === undefined || resolved === "") {
    throw new InboxError(2, "INBOX_CONFIG", `${label} is required`);
  }
  return resolved;
}

function integer(
  raw: string | undefined,
  label: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new InboxError(2, "INBOX_CONFIG", `${label} must be ${min}-${max}`);
  }
  return value;
}

function display(value: string): string {
  return escapeForTerminal(JSON.stringify(value));
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  let token = "";
  const out = (line: string): void => {
    process.stdout.write(`${redactAndEscape(line, token)}\n`);
  };
  const err = (line: string): void => {
    process.stderr.write(`${redactAndEscape(line, token)}\n`);
  };

  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({
      args: [...argv],
      options: OPTIONS,
      strict: true,
      allowPositionals: true,
    });
  } catch {
    err("inbox: invalid arguments (use --help)");
    return 2;
  }
  const values: Values = parsed.values;
  if (values.help === true) {
    // Help text is a fixed constant with newlines; it must not be terminal-escaped.
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const command = parsed.positionals[0];
  if (command === undefined || parsed.positionals.length !== 1) {
    err("inbox: one command is required (use --help)");
    return 2;
  }

  try {
    const spoolDir = required(values["spool-dir"], env.CORKBOARD_INBOX_SPOOL, "spool directory");

    if (command === "run") {
      const baseUrl = parseBaseUrl(
        required(values["base-url"], env.CORKBOARD_BASE_URL, "base URL"),
      );
      const projectId = required(values.project, env.CORKBOARD_PROJECT_ID, "project");
      token = resolveToken(env, values["token-file"]);
      const consumerIds = values.consumer ?? [];
      const limit = integer(values.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
      const maxPages = integer(values["max-pages"], "max-pages", 1, MAX_PAGES, DEFAULT_MAX_PAGES);
      const intervalMs = integer(
        values["interval-ms"],
        "interval-ms",
        0,
        86_400_000,
        DEFAULT_INTERVAL_MS,
      );
      const maxEvents = integer(values["max-events"], "max-events", 1, 1_000_000, DEFAULT_MAX_EVENTS);
      const maxBytes = integer(
        values["max-bytes"],
        "max-bytes",
        1,
        1 << 30,
        DEFAULT_MAX_BYTES,
      );
      const maxEventBytes = integer(
        values["max-event-bytes"],
        "max-event-bytes",
        1,
        8 << 20,
        DEFAULT_MAX_EVENT_BYTES,
      );
      const retentionMs = integer(
        values["retention-ms"],
        "retention-ms",
        0,
        31 * 24 * 60 * 60 * 1000,
        DEFAULT_RETENTION_MS,
      );

      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        const result = await runInbox({
          baseUrl,
          token,
          projectId,
          spoolDir,
          consumerIds,
          plaintext: values.plaintext === true,
          limit,
          maxPages,
          intervalMs,
          once: values.once === true,
          maxEvents,
          maxBytes,
          maxEventBytes,
          retentionMs,
          signal: controller.signal,
          stdout: out,
          stderr: err,
        });
        out(`inbox: processed=${result.processed} after_seq=${result.afterSeq}`);
        if (result.stopped) err("inbox: stopped");
        return 0;
      } finally {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
      }
    }

    if (command === "list") {
      const consumerId = required(values.consumer?.[0], undefined, "consumer");
      const limit = integer(values.limit, "limit", 1, 1_000, 100);
      const spool = openSpool(spoolDir);
      for (const event of pendingEvents(spool, consumerId, limit)) {
        out(
          `seq=${event.seq} message_id=${display(event.message_id)}` +
            ` sender=${display(event.sender.id)} body_state=${event.body_state}` +
            ` payload=${event.payload.included ? "yes" : "no"}`,
        );
      }
      return 0;
    }

    if (command === "ack") {
      const consumerId = required(values.consumer?.[0], undefined, "consumer");
      if (values.seq === undefined) {
        throw new InboxError(2, "INBOX_CONFIG", "seq is required");
      }
      const seq = integer(values.seq, "seq", 1, Number.MAX_SAFE_INTEGER, 0);
      const spool = openSpool(spoolDir);
      const ack = ackEvent(spool, consumerId, seq);
      out(`acknowledged consumer=${display(ack.consumer_id)} acked_seq=${ack.acked_seq}`);
      return 0;
    }

    if (command === "prune") {
      const spool = openSpool(spoolDir);
      const removed = pruneSpool(spool, { force: values.force === true });
      out(`pruned=${removed}`);
      return 0;
    }

    err("inbox: unknown command (use --help)");
    return 2;
  } catch (error) {
    if (error instanceof InboxError || error instanceof PollError) {
      err(`inbox: ${error.message}`);
      return error.exitCode;
    }
    err("inbox: unexpected failure");
    return 1;
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
