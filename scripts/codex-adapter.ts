#!/usr/bin/env node
// Operator CLI for the opt-in Codex CLI inbox adapter.
//
//   install    Add the marked SessionStart/UserPromptSubmit block to config.toml
//   uninstall  Remove exactly that block
//   check      Detect Codex hook support and report adapter state
//   hook       Codex hook entrypoint; reads the hook payload from stdin
//
// The hook never holds a Corkboard credential, never prints a message body, and
// never executes peer content. Install never writes a hook-trust record.
import { readFileSync, writeSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { redactAndEscape } from "../scripts/poll.ts";
import {
  InboxError,
  openSpool,
} from "../src/inbox/spool.ts";
import {
  DEFAULT_CODEX_BIN,
  DEFAULT_CODEX_CONSUMER_PREFIX,
  checkCodexAdapter,
  codexConsumerId,
  codexHookCommand,
  detectCodex,
  handleCodexHook,
  installCodexHooksAt,
  uninstallCodexHooksAt,
} from "../src/inbox/codex-adapter.ts";

const USAGE = `Usage: node scripts/codex-adapter.ts <command> [options]

Commands:
  install    Install the opt-in Codex hooks (idempotent, preserves config)
  uninstall  Remove the managed hook block (idempotent)
  check      Detect Codex hook support and report adapter state
  hook       Codex hook entrypoint (reads hook JSON on stdin)

Common:
  --codex-home <path>       Codex home (default $CODEX_HOME or ~/.codex)
  --spool-dir <path>        Corkboard spool (default $CORKBOARD_INBOX_SPOOL)
  --consumer-prefix <id>    Per-session consumer prefix (default ${DEFAULT_CODEX_CONSUMER_PREFIX})
  --codex-bin <path>        Codex executable (default ${DEFAULT_CODEX_BIN})
  --json                    Machine-readable check output
  --help                    Show this help

install requires an existing, valid Corkboard spool. Hook trust is not granted
automatically: review the hooks in the Codex TUI, or use Codex's
--dangerously-bypass-hook-trust only in automation that has vetted this source.`;

const OPTIONS = {
  "codex-home": { type: "string" },
  "spool-dir": { type: "string" },
  "consumer-prefix": { type: "string" },
  "codex-bin": { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean" },
} as const;

type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS }>>["values"];

function required(value: string | undefined, envValue: string | undefined, label: string): string {
  const resolved = (value ?? envValue)?.trim();
  if (resolved === undefined || resolved === "") {
    throw new InboxError(2, "CODEX_CONFIG", `${label} is required`);
  }
  return resolved;
}

function display(value: string, token: string): string {
  return redactAndEscape(value, token);
}

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  const token = env.CORKBOARD_APIKEY ?? "";
  const out = (line: string): void => {
    process.stdout.write(`${display(line, token)}\n`);
  };
  const err = (line: string): void => {
    process.stderr.write(`${display(line, token)}\n`);
  };

  let parsed: { values: Values; positionals: string[] };
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, strict: true, allowPositionals: true });
  } catch {
    err("codex-adapter: invalid arguments (use --help)");
    return 2;
  }
  const values = parsed.values;
  if (values.help === true) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const command = parsed.positionals[0];
  if (command === undefined || parsed.positionals.length !== 1) {
    err("codex-adapter: one command is required (use --help)");
    return 2;
  }

  const bin = values["codex-bin"] ?? env.CORKBOARD_CODEX_BIN ?? DEFAULT_CODEX_BIN;
  const prefix = values["consumer-prefix"] ?? DEFAULT_CODEX_CONSUMER_PREFIX;

  try {
    if (command === "hook") {
      const spoolDir = required(values["spool-dir"], env.CORKBOARD_INBOX_SPOOL, "spool directory");
      let stdin = "";
      try {
        stdin = readFileSync(0, "utf8");
      } catch {
        return 0;
      }
      await handleCodexHook({
        stdin,
        spoolDir,
        env,
        consumerPrefix: prefix,
        stdout: (text) => writeSync(1, text),
        stderr: (text) => writeSync(2, text),
      });
      // A hook must not block a Codex turn. Runtime failures leave events
      // pending and are retried at the next resume point.
      return 0;
    }

    if (command === "install") {
      const spoolDir = required(values["spool-dir"], env.CORKBOARD_INBOX_SPOOL, "spool directory");
      // Reject an unusable prefix now; otherwise every hook fails later.
      codexConsumerId(prefix, "install");
      // The spool must already be initialized; this validates the binding,
      // permissions, and outside-repository rule and rejects typos.
      openSpool(spoolDir);
      const detection = detectCodex({ bin, env });
      if (!detection.supported) {
        throw new InboxError(
          2,
          "CODEX_UNSUPPORTED",
          detection.reason ?? "this Codex installation does not support hooks",
        );
      }
      const scriptPath = fileURLToPath(import.meta.url);
      const hookCommand = codexHookCommand({
        nodePath: process.execPath,
        scriptPath,
        spoolDir,
        consumerPrefix: prefix,
      });
      const result = installCodexHooksAt({ codexHome: values["codex-home"], command: hookCommand, env });
      out(`codex-adapter: config=${result.configPath} changed=${result.changed}`);
      out("codex-adapter: hook trust is required; review the hooks in Codex (install never writes hooks.state)");
      out("codex-adapter: vetted automation may opt in with Codex's --dangerously-bypass-hook-trust");
      return 0;
    }

    if (command === "uninstall") {
      const result = uninstallCodexHooksAt({ codexHome: values["codex-home"], env });
      out(`codex-adapter: config=${result.configPath} changed=${result.changed}`);
      return 0;
    }

    if (command === "check") {
      const check = checkCodexAdapter({
        codexHome: values["codex-home"],
        spoolDir: values["spool-dir"] ?? env.CORKBOARD_INBOX_SPOOL,
        bin,
        env,
      });
      // A missing or invalid spool is not OK: install and hook delivery both
      // require a valid Corkboard spool.
      const ok = check.detection.supported && check.installed && check.spoolValid;
      if (values.json === true) {
        out(
          JSON.stringify({
            available: check.detection.available,
            version: check.detection.version,
            hooks_feature: check.detection.hooksFeature,
            supported: check.detection.supported,
            reason: check.detection.reason,
            config_path: check.configPath,
            config_exists: check.configExists,
            installed: check.installed,
            header_created: check.headerCreated,
            spool_present: check.spoolPresent,
            spool_valid: check.spoolValid,
            trust: check.trust,
            ok,
          }),
        );
        return ok ? 0 : 1;
      }
      out(
        `codex-adapter: available=${check.detection.available}` +
          ` version=${check.detection.version ?? "-"}` +
          ` hooks_feature=${check.detection.hooksFeature ?? "-"}` +
          ` supported=${check.detection.supported}` +
          ` reason=${check.detection.reason ?? "-"}`,
      );
      out(
        `codex-adapter: config=${check.configPath} exists=${check.configExists}` +
          ` installed=${check.installed} header_created=${check.headerCreated}` +
          ` spool_present=${check.spoolPresent} spool_valid=${check.spoolValid}`,
      );
      out(`codex-adapter: trust=${check.trust} ok=${ok}`);
      return ok ? 0 : 1;
    }

    err("codex-adapter: unknown command (use --help)");
    return 2;
  } catch (error) {
    if (error instanceof InboxError) {
      err(`codex-adapter: ${error.code}: ${error.message}`);
      return error.exitCode;
    }
    err("codex-adapter: unexpected failure");
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
