// Poll -> durable local event bridge.
//
// Transport, validation, receipts, and cursor durability stay in
// scripts/poll.ts. This module only registers the consumer(s), then queues each
// verified message (or expired tombstone) before the poller is allowed to
// acknowledge and advance. A queue failure leaves the cursor unchanged.
import { run, type PollContext, type PollMessage, type PollPassResult } from "../../scripts/poll.ts";
import {
  InboxError,
  enqueueEvent,
  prepareSpool,
  pruneSpool,
  registerConsumer,
} from "./spool.ts";

export interface RunInboxOptions extends PollContext {
  baseUrl: string;
  token: string;
  projectId: string;
  spoolDir: string;
  consumerIds: readonly string[];
  plaintext?: boolean | undefined;
  limit?: number | undefined;
  maxPages?: number | undefined;
  once?: boolean | undefined;
  intervalMs?: number | undefined;
  maxEvents?: number | undefined;
  maxBytes?: number | undefined;
  maxEventBytes?: number | undefined;
  retentionMs?: number | undefined;
  repoRoot?: string | undefined;
}

export async function runInbox(options: RunInboxOptions): Promise<PollPassResult> {
  if (options.consumerIds.length === 0) {
    throw new InboxError(2, "INBOX_CONFIG", "at least one consumer is required");
  }
  const spool = prepareSpool(options.spoolDir, options.projectId, {
    plaintext: options.plaintext === true,
    maxEvents: options.maxEvents,
    maxBytes: options.maxBytes,
    maxEventBytes: options.maxEventBytes,
    retentionMs: options.retentionMs,
    repoRoot: options.repoRoot,
    now: options.now,
  });
  for (const consumerId of options.consumerIds) {
    registerConsumer(spool, consumerId);
  }
  pruneSpool(spool, { now: options.now });

  // pollPass wraps callback failures as PROCESS_FAILED. Keep the specific
  // local failure so the CLI can report backpressure, disk, or schema errors.
  let queueError: InboxError | undefined;
  const queue = (message: PollMessage, body: string | null): void => {
    try {
      enqueueEvent(spool, message, body, { token: options.token, now: options.now });
      queueError = undefined;
    } catch (error) {
      if (error instanceof InboxError) queueError = error;
      throw error;
    }
  };

  try {
    return await run({
      baseUrl: options.baseUrl,
      token: options.token,
      projectId: options.projectId,
      cursorPath: spool.cursorPath,
      limit: options.limit,
      maxPages: options.maxPages,
      once: options.once,
      intervalMs: options.intervalMs,
      fetchImpl: options.fetchImpl,
      sleep: options.sleep,
      stdout: options.stdout,
      stderr: options.stderr,
      signal: options.signal,
      requestTimeoutMs: options.requestTimeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      now: options.now,
      onMessage: (message, body) => queue(message, body),
      onExpired: (message) => queue(message, null),
    });
  } catch (error) {
    if (queueError !== undefined) throw queueError;
    throw error;
  }
}
