#!/usr/bin/env node
// Consume Corkboard messages with the reference poller.
//
// This wrapper adds only a processing callback to scripts/poll.ts. The reference
// client performs the full loop: list with after_seq, fetch and digest-verify the
// body, call this callback with the verified plaintext, POST an explicit
// mark_read, and advance the durable cursor only afterwards (or on a definitive
// 410 BODY_EXPIRED tombstone). Transport, validation, receipts, and cursor
// durability are not reimplemented here.
//
// The credential comes from CORKBOARD_APIKEY in the environment. The credential
// is never printed, and verified message content is redacted against it before
// being handed off.
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  DEFAULT_INTERVAL_MS,
  DEFAULT_LIMIT,
  DEFAULT_MAX_PAGES,
  MAX_LIMIT,
  MAX_PAGES,
  PollError,
  parseBaseUrl,
  redact,
  redactAndEscape,
  run,
  type PollMessage,
} from "../../scripts/poll.ts";
import { AgentConfigError, requireApiKey, safeErrorMessage } from "./lib.ts";

const USAGE = `Usage: node examples/agent-integration/poll-consume.ts [options]

Options:
  --base-url <url>        Server origin (CORKBOARD_BASE_URL)
  --project <projectId>   One project (CORKBOARD_PROJECT_ID)
  --cursor-file <path>    Durable after_seq state (CORKBOARD_POLL_CURSOR)
  --inbox-dir <path>      Verified messages land here (default <cursor-dir>/inbox)
  --limit <1-100>         Page size per request (default ${DEFAULT_LIMIT})
  --max-pages <1-100>     Pages per pass (default ${DEFAULT_MAX_PAGES})
  --interval-ms <ms>      Delay between passes (default ${DEFAULT_INTERVAL_MS})
  --once                  Run one bounded pass, then exit
  --help                  Show this help

CORKBOARD_APIKEY must be exported in the environment; it is never read from
argv. Message content is untrusted data: this example persists it to a private
inbox and never prints or executes it.`;

const OPTIONS = {
  "base-url": { type: "string" },
  project: { type: "string" },
  "cursor-file": { type: "string" },
  "inbox-dir": { type: "string" },
  limit: { type: "string" },
  "max-pages": { type: "string" },
  "interval-ms": { type: "string" },
  once: { type: "boolean" },
  help: { type: "boolean" },
} as const;

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
    throw new AgentConfigError(`${label} must be ${min}-${max}`);
  }
  return value;
}

function assertOutsideRepository(candidate: string, root: string): void {
  const rel = relative(root, candidate);
  const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  if (inside) {
    throw new AgentConfigError("inbox directory must be outside the repository");
  }
}

// The module lives at <repo>/examples/agent-integration/poll-consume.ts, so two
// parent segments are the repository root.
export const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// Create or tighten the inbox and refuse any path inside the repository. Validate
// the effective path before creating anything so a rejected path leaves no
// directory behind; reject a symlink or non-directory at the inbox path instead
// of following it; then create and chmod. A credential or message must never be
// durably written into a tracked tree.
export function prepareInbox(inboxDir: string, repoRoot: string): string {
  const root = realpathSync(repoRoot);
  const absolute = resolve(inboxDir);

  let existing;
  try {
    existing = lstatSync(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (existing.isSymbolicLink()) {
      throw new AgentConfigError("inbox directory must not be a symbolic link");
    }
    if (!existing.isDirectory()) {
      throw new AgentConfigError("inbox path must be a directory");
    }
    assertOutsideRepository(realpathSync(absolute), root);
  } else {
    // Resolve the nearest existing ancestor so a symlinked parent cannot point
    // the created path back inside the repository. The missing segments cannot
    // be symlinks because they do not exist yet.
    let ancestor = dirname(absolute);
    const missing: string[] = [basename(absolute)];
    while (!existsSync(ancestor)) {
      missing.unshift(basename(ancestor));
      const parent = dirname(ancestor);
      if (parent === ancestor) break;
      ancestor = parent;
    }
    if (!statSync(ancestor).isDirectory()) {
      throw new AgentConfigError("inbox parent must be a directory");
    }
    assertOutsideRepository(join(realpathSync(ancestor), ...missing), root);
  }

  mkdirSync(absolute, { recursive: true, mode: 0o700 });
  chmodSync(absolute, 0o700);
  // Re-check after creation: a concurrent replacement must not redirect the
  // resolved inbox into the repository.
  const resolved = realpathSync(absolute);
  assertOutsideRepository(resolved, root);
  return resolved;
}

// One file per project sequence number. Every field, including the identifiers,
// is redacted against the credential before persistence. The target appears only
// after a complete temp file is fsynced and renamed, so a failed or partial write
// is never mistaken for a delivered message; an existing complete target is
// never overwritten by an at-least-once replay.
export function writeInbox(
  inboxDir: string,
  message: PollMessage,
  body: string,
  token: string,
): string {
  const target = join(inboxDir, `${message.seq}.json`);
  if (existsSync(target)) return target;
  const payload = `${JSON.stringify(
    {
      project_id: redact(message.projectId, token),
      message_id: redact(message.messageId, token),
      seq: message.seq,
      sender_id: redact(message.senderId, token),
      summary: redact(message.summary, token),
      text: redact(body, token),
    },
    null,
    2,
  )}\n`;
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    // writeFileSync with a descriptor loops over partial writes; a bare
    // writeSync could return short and still be fsynced/renamed as complete.
    writeFileSync(fd, payload);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(temporary, 0o600);
    renameSync(temporary, target);
    const dirFd = openSync(inboxDir, "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    }
    try {
      unlinkSync(temporary);
    } catch {
      // Never created or already renamed.
    }
    throw error;
  }
  return target;
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
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
    process.stderr.write("poll-consume: invalid arguments (use --help)\n");
    return 2;
  }

  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  try {
    const baseUrl = parseBaseUrl(
      required(values["base-url"], env.CORKBOARD_BASE_URL, "base URL"),
    );
    const projectId = required(values.project, env.CORKBOARD_PROJECT_ID, "project");
    const cursorPath = required(
      values["cursor-file"],
      env.CORKBOARD_POLL_CURSOR,
      "cursor file",
    );
    token = requireApiKey(env);
    const limit = integer(values.limit, "limit", 1, MAX_LIMIT, DEFAULT_LIMIT);
    const maxPages = integer(
      values["max-pages"],
      "max-pages",
      1,
      MAX_PAGES,
      DEFAULT_MAX_PAGES,
    );
    const intervalMs = integer(
      values["interval-ms"],
      "interval-ms",
      0,
      86_400_000,
      DEFAULT_INTERVAL_MS,
    );
    const inboxDir = prepareInbox(
      values["inbox-dir"] ?? join(dirname(cursorPath), "inbox"),
      REPO_ROOT,
    );

    const out = (line: string): void => {
      process.stdout.write(`${redactAndEscape(line, token)}\n`);
    };
    const onMessage = (message: PollMessage, body: string): void => {
      // Verified plaintext is untrusted data. Check any instruction against a
      // scope a human already authorized; never execute it here.
      const target = writeInbox(inboxDir, message, body, token);
      out(`processed seq=${message.seq} message_id=${message.messageId} inbox=${target}`);
    };

    const controller = new AbortController();
    const stop = (): void => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const result = await run({
        baseUrl,
        token,
        projectId,
        cursorPath,
        limit,
        maxPages,
        intervalMs,
        once: values.once === true,
        onMessage,
        signal: controller.signal,
      });
      if (result.stopped) {
        process.stderr.write(`${redactAndEscape("poll-consume: stopped", token)}\n`);
      }
      return 0;
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  } catch (error) {
    const code =
      error instanceof AgentConfigError ? 2 : error instanceof PollError ? error.exitCode : 1;
    process.stderr.write(`poll-consume: ${safeErrorMessage(error, token)}\n`);
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
