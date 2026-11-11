#!/usr/bin/env node
// Operator CLI for the local Corkboard inbox bridge and supervised follower.
//
// The bridge reuses scripts/poll.ts for transport, verification, receipts, and
// the durable cursor. This file only parses arguments and exposes the local
// spool: run/supervise (poll -> queue), list (metadata for one consumer), ack,
// prune, status/health, and stop.
//
// Message bodies are never printed or executed. The credential is read from
// CORKBOARD_APIKEY or a 0600 --token-file and is always redacted on output.
import { setTimeout as delay } from "node:timers/promises";
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
  DEFAULT_MAX_RETRY_DELAY_MS,
  DEFAULT_RETENTION_MS,
  DEFAULT_RETRY_DELAY_MS,
  InboxError,
  ackEvent,
  acknowledgedSeq,
  acquireSupervisorLock,
  clearStaleSupervisorLock,
  forceClearSupervisorLock,
  inspectSupervisorLock,
  listEvents,
  openSpool,
  pendingEvents,
  prepareSpool,
  pruneSpool,
  readCursorAfterSeq,
  readSupervisorStatus,
  registeredConsumers,
  runSupervisor,
  seedConsumerAck,
  spoolUsage,
  type InboxSpool,
  type SupervisorLockInspection,
  type SupervisorStatusV1,
} from "../src/inbox/index.ts";
import { runInbox } from "../src/inbox/bridge.ts";

const DEFAULT_MAX_HEARTBEAT_AGE_MS = 300_000;

const USAGE = `Usage: node scripts/inbox.ts <command> [options]

Commands:
  run       Poll one project and durably queue events for local consumers
  supervise Supervised follower: exclusive lock, status, backoff, clean stop
  list      Print metadata events a consumer has not acknowledged
  ack       Acknowledge the next contiguous event for a consumer
  prune     Remove events every registered consumer acknowledged
  status    Print follower liveness, lag/backlog and last-success metadata
  health    Print one health line; exit 0 only when the follower is healthy
  stop      Cleanly stop the supervisor that owns this spool

Common:
  --spool-dir <path>      Spool directory outside the repository (CORKBOARD_INBOX_SPOOL)
  --help                  Show this help

run / supervise:
  --base-url <url>        Server origin (CORKBOARD_BASE_URL)
  --project <projectId>   One project (CORKBOARD_PROJECT_ID)
  --consumer <id>         Consumer to register (repeatable, at least one)
                          CORKBOARD_INBOX_CONSUMERS=a,b is the env alternative
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

supervise only:
  --retry-delay-ms <ms>   First transient-failure backoff (default ${DEFAULT_RETRY_DELAY_MS})
  --max-retry-delay-ms <ms> Backoff cap (default ${DEFAULT_MAX_RETRY_DELAY_MS})

list:
  --consumer <id>         Consumer whose unacknowledged events are listed
  --limit <n>             Maximum events (default 100)

ack:
  --consumer <id>         Consumer to advance
  --seq <n>               Next contiguous sequence to acknowledge

prune:
  --force                 Ignore the retention window for acknowledged events

status:
  --json                  Print one safe JSON object
  --max-heartbeat-age-ms <ms>  Stale-heartbeat threshold (default ${DEFAULT_MAX_HEARTBEAT_AGE_MS})

health:
  --max-heartbeat-age-ms <ms>  Stale-heartbeat threshold (default ${DEFAULT_MAX_HEARTBEAT_AGE_MS})

stop:
  --timeout-ms <ms>       Wait for a clean exit (default 20000)
  --force                 Remove a corrupt lock after confirming no supervisor runs

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
  "retry-delay-ms": { type: "string" },
  "max-retry-delay-ms": { type: "string" },
  seq: { type: "string" },
  force: { type: "boolean" },
  json: { type: "boolean" },
  "timeout-ms": { type: "string" },
  "max-heartbeat-age-ms": { type: "string" },
  help: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

interface PullOptions {
  baseUrl: string;
  projectId: string;
  token: string;
  consumerIds: string[];
  plaintext: boolean;
  once: boolean;
  intervalMs: number;
  limit: number;
  maxPages: number;
  maxEvents: number;
  maxBytes: number;
  maxEventBytes: number;
  retentionMs: number;
}

interface Observation {
  state: string;
  healthy: boolean;
  lock: "absent" | "live" | "stale";
  pid: number | null;
  project_id: string;
  updated_at: string | null;
  heartbeat_age_ms: number | null;
  stale_heartbeat: boolean;
  last_success_at: string | null;
  last_error: string | null;
  stop_reason: string | null;
  passes: number | null;
  processed_total: number | null;
  after_seq: number;
  consumers: Array<{ id: string; acked_seq: number; pending: number }>;
  backlog: { events: number; bytes: number };
  lag: { pending_events: number; oldest_pending_age_ms: number | null };
  limits: { max_events: number; max_bytes: number };
  degraded: boolean;
  degraded_reason: string | null;
}

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

function consumersOf(values: Values, env: Record<string, string | undefined>): string[] {
  if (values.consumer !== undefined && values.consumer.length > 0) return values.consumer;
  const raw = env.CORKBOARD_INBOX_CONSUMERS;
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function pullOptions(
  values: Values,
  env: Record<string, string | undefined>,
): PullOptions {
  return {
    baseUrl: parseBaseUrl(required(values["base-url"], env.CORKBOARD_BASE_URL, "base URL")),
    projectId: required(values.project, env.CORKBOARD_PROJECT_ID, "project"),
    token: resolveToken(env, values["token-file"]),
    consumerIds: consumersOf(values, env),
    plaintext: values.plaintext === true,
    once: values.once === true,
    intervalMs: integer(
      values["interval-ms"],
      "interval-ms",
      0,
      86_400_000,
      DEFAULT_INTERVAL_MS,
    ),
    limit: integer(values.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT),
    maxPages: integer(values["max-pages"], "max-pages", 1, MAX_PAGES, DEFAULT_MAX_PAGES),
    maxEvents: integer(values["max-events"], "max-events", 1, 1_000_000, DEFAULT_MAX_EVENTS),
    maxBytes: integer(values["max-bytes"], "max-bytes", 1, 1 << 30, DEFAULT_MAX_BYTES),
    maxEventBytes: integer(
      values["max-event-bytes"],
      "max-event-bytes",
      1,
      8 << 20,
      DEFAULT_MAX_EVENT_BYTES,
    ),
    retentionMs: integer(
      values["retention-ms"],
      "retention-ms",
      0,
      31 * 24 * 60 * 60 * 1000,
      DEFAULT_RETENTION_MS,
    ),
  };
}

function observedState(
  inspection: SupervisorLockInspection,
  status: SupervisorStatusV1 | null,
): string {
  if (inspection.state === "stale") return "stale";
  if (inspection.state === "absent") {
    if (
      status !== null &&
      (status.state === "starting" || status.state === "running" || status.state === "degraded")
    ) {
      return "stale";
    }
    return status?.state ?? "absent";
  }
  // A live lock is authoritative: a leftover "stopped"/"failed" record from a
  // previous run (or a `run` process that writes no status) is still running.
  if (status === null || status.state === "stopped" || status.state === "failed") {
    return "running";
  }
  return status.state;
}

function observe(spool: InboxSpool, maxHeartbeatAgeMs: number): Observation {
  const inspection = inspectSupervisorLock(spool);
  const status = readSupervisorStatus(spool);
  const events = listEvents(spool);
  const consumers = registeredConsumers(spool).map((id) => {
    const acked = acknowledgedSeq(spool, id);
    const pending = events.reduce(
      (count, event) => (event.seq > acked ? count + 1 : count),
      0,
    );
    return { id, acked_seq: acked, pending };
  });
  const pending = events.filter((event) =>
    consumers.some((consumer) => event.seq > consumer.acked_seq),
  );
  const oldest = pending[0];
  const usage = spoolUsage(spool);
  const state = observedState(inspection, status);
  const heartbeatAgeMs =
    status === null ? null : Math.max(0, Date.now() - Date.parse(status.updated_at));
  const staleHeartbeat =
    heartbeatAgeMs === null || heartbeatAgeMs > maxHeartbeatAgeMs;
  return {
    state,
    healthy:
      inspection.state === "live" &&
      status !== null &&
      status.state !== "degraded" &&
      status.state !== "failed" &&
      !staleHeartbeat,
    lock: inspection.state,
    pid: inspection.record?.pid ?? status?.pid ?? null,
    project_id: spool.projectId,
    updated_at: status?.updated_at ?? null,
    heartbeat_age_ms: heartbeatAgeMs,
    stale_heartbeat: staleHeartbeat,
    last_success_at: status?.last_success_at ?? null,
    last_error: status?.last_error ?? null,
    stop_reason: status?.stop_reason ?? null,
    passes: status?.passes ?? null,
    processed_total: status?.processed_total ?? null,
    after_seq:
      status?.after_seq ??
      readCursorAfterSeq(spool, inspection.record?.base_url) ??
      0,
    consumers,
    backlog: { events: usage.events, bytes: usage.bytes },
    lag: {
      pending_events:
        consumers.length === 0
          ? 0
          : Math.max(...consumers.map((consumer) => consumer.pending)),
      oldest_pending_age_ms:
        oldest === undefined ? null : Math.max(0, Date.now() - Date.parse(oldest.queued_at)),
    },
    limits: { max_events: spool.maxEvents, max_bytes: spool.maxBytes },
    degraded: status?.degraded ?? false,
    degraded_reason: status?.degraded_reason ?? null,
  };
}

function stamp(value: string | null): string {
  return value === null ? "-" : display(value);
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

    if (command === "run" || command === "supervise") {
      const options = pullOptions(values, env);
      token = options.token;
      const controller = new AbortController();
      const stop = (): void => controller.abort();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      try {
        if (command === "supervise") {
          const result = await runSupervisor({
            ...options,
            spoolDir,
            retryDelayMs: integer(
              values["retry-delay-ms"],
              "retry-delay-ms",
              0,
              86_400_000,
              DEFAULT_RETRY_DELAY_MS,
            ),
            maxRetryDelayMs: integer(
              values["max-retry-delay-ms"],
              "max-retry-delay-ms",
              0,
              86_400_000,
              DEFAULT_MAX_RETRY_DELAY_MS,
            ),
            signal: controller.signal,
            stdout: out,
            stderr: err,
          });
          out(
            `inbox: supervisor state=${result.state} passes=${result.passes}` +
              ` processed=${result.processed} after_seq=${result.afterSeq}`,
          );
          return result.exitCode;
        }

        // `run` keeps the #16 semantics but takes the same exclusive lock, so it
        // cannot race a supervised follower on the same cursor.
        const bootstrap = prepareSpool(spoolDir, options.projectId, {
          plaintext: options.plaintext,
          maxEvents: options.maxEvents,
          maxBytes: options.maxBytes,
          maxEventBytes: options.maxEventBytes,
          retentionMs: options.retentionMs,
          sweep: false,
        });
        const lock = acquireSupervisorLock(bootstrap, { baseUrl: options.baseUrl });
        try {
          const result = await runInbox({
            ...options,
            spoolDir,
            signal: controller.signal,
            stdout: out,
            stderr: err,
          });
          out(`inbox: processed=${result.processed} after_seq=${result.afterSeq}`);
          if (result.stopped) err("inbox: stopped");
          return 0;
        } finally {
          lock.release();
        }
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
      // A consumer registered after another consumer's events were pruned
      // starts below an absent prefix. Seed that gap only when the target
      // event exists: seeding for an absent target could hide a later event
      // that is enqueued below the new watermark. seedConsumerAck refuses to
      // skip a retained event, so in-order acknowledgement is preserved.
      if (
        seq > acknowledgedSeq(spool, consumerId) + 1 &&
        listEvents(spool).some((event) => event.seq === seq)
      ) {
        try {
          seedConsumerAck(spool, consumerId, seq - 1);
        } catch (error) {
          if (!(error instanceof InboxError) || error.code !== "INBOX_OUT_OF_ORDER") throw error;
        }
      }
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

    if (command === "status" || command === "health") {
      // Status never needs the credential; redact the environment value if an
      // operator happened to export it in this shell.
      token = env.CORKBOARD_APIKEY ?? "";
      const maxHeartbeatAgeMs = integer(
        values["max-heartbeat-age-ms"],
        "max-heartbeat-age-ms",
        0,
        86_400_000,
        DEFAULT_MAX_HEARTBEAT_AGE_MS,
      );
      const observation = observe(openSpool(spoolDir, {}, true), maxHeartbeatAgeMs);
      if (command === "health") {
        out(
          `inbox: healthy=${observation.healthy} state=${display(observation.state)}` +
            ` lock=${observation.lock} degraded=${observation.degraded}` +
            ` heartbeat_age_ms=${observation.heartbeat_age_ms ?? "-"}` +
            ` stale_heartbeat=${observation.stale_heartbeat}`,
        );
        return observation.healthy ? 0 : 1;
      }
      if (values.json === true) {
        out(JSON.stringify(observation));
        return 0;
      }
      out(
        `state=${display(observation.state)} healthy=${observation.healthy}` +
          ` lock=${observation.lock} pid=${observation.pid ?? "-"}` +
          ` project=${display(observation.project_id)}`,
      );
      out(
        `after_seq=${observation.after_seq} updated_at=${stamp(observation.updated_at)}` +
          ` heartbeat_age_ms=${observation.heartbeat_age_ms ?? "-"}` +
          ` stale_heartbeat=${observation.stale_heartbeat}` +
          ` last_success_at=${stamp(observation.last_success_at)}` +
          ` last_error=${observation.last_error ?? "-"}` +
          ` stop_reason=${observation.stop_reason ?? "-"}`,
      );
      out(
        `passes=${observation.passes ?? "-"} processed_total=${observation.processed_total ?? "-"}` +
          ` degraded=${observation.degraded}` +
          ` reason=${observation.degraded_reason ?? "-"}`,
      );
      out(
        `consumers=${observation.consumers.length} backlog_events=${observation.backlog.events}` +
          ` backlog_bytes=${observation.backlog.bytes}` +
          ` lag_events=${observation.lag.pending_events}` +
          ` oldest_lag_ms=${observation.lag.oldest_pending_age_ms ?? "-"}`,
      );
      for (const consumer of observation.consumers) {
        out(
          `consumer id=${display(consumer.id)} acked_seq=${consumer.acked_seq}` +
            ` pending=${consumer.pending}`,
        );
      }
      return 0;
    }

    if (command === "stop") {
      token = env.CORKBOARD_APIKEY ?? "";
      const spool = openSpool(spoolDir, {}, true);
      let inspection: SupervisorLockInspection;
      try {
        inspection = inspectSupervisorLock(spool);
      } catch (error) {
        if (
          values.force === true &&
          error instanceof InboxError &&
          error.code === "INBOX_LOCK_CORRUPT"
        ) {
          const removed = forceClearSupervisorLock(spool);
          out(
            `inbox: ${removed ? "removed corrupt supervisor lock" : "supervisor lock already absent"}`,
          );
          return 0;
        }
        throw error;
      }
      if (inspection.state === "absent") {
        out("inbox: supervisor not running");
        return 0;
      }
      if (inspection.state === "stale") {
        const cleared = clearStaleSupervisorLock(spool);
        if (cleared === "live") {
          err("inbox: a supervisor acquired the lock while it was being cleared");
          return 1;
        }
        out(`inbox: cleared stale supervisor lock (${inspection.reason ?? "stale"})`);
        return 0;
      }
      const record = inspection.record;
      if (record === undefined) {
        err("inbox: supervisor lock is live but has no record");
        return 1;
      }
      // Re-inspect immediately before signalling. The instance is unique per
      // acquisition and process_start rules out PID reuse. An unverifiable
      // record requires the operator's explicit --force.
      const current = inspectSupervisorLock(spool);
      if (current.state !== "live" || current.record === undefined) {
        clearStaleSupervisorLock(spool);
        out("inbox: supervisor already exited");
        return 0;
      }
      if (
        current.record.instance !== record.instance ||
        current.record.pid !== record.pid ||
        current.record.process_start !== record.process_start
      ) {
        err("inbox: supervisor lock changed before signal; refusing to stop");
        return 1;
      }
      if (current.record.process_start === null && values.force !== true) {
        err("inbox: supervisor has no process-start identity; use --force only after verifying the pid");
        return 1;
      }
      const timeoutMs = integer(values["timeout-ms"], "timeout-ms", 0, 300_000, 20_000);
      try {
        process.kill(current.record.pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") {
          out("inbox: supervisor already exited; clearing stale lock");
          clearStaleSupervisorLock(spool);
          return 0;
        }
        throw new InboxError(1, "INBOX_LOCKED", "cannot signal the supervisor process");
      }
      const deadline = Date.now() + timeoutMs;
      while (Date.now() <= deadline) {
        await delay(100);
        let current: SupervisorLockInspection;
        try {
          current = inspectSupervisorLock(spool);
        } catch {
          current = { state: "live" };
        }
        if (current.state !== "live") {
          out(`inbox: supervisor stopped pid=${record.pid}`);
          return 0;
        }
      }
      err(`inbox: supervisor pid=${record.pid} did not stop within ${timeoutMs}ms`);
      return 1;
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
