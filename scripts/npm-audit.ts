#!/usr/bin/env node
// Runs npm's vulnerability audit through the installed CLI. Never resolve `npm`
// through PATH: `npm run` prepends node_modules/.bin, so a dependency shim could
// otherwise make the audit pass without querying the registry.
import { execFileSync } from "node:child_process";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  console.error(
    "audit: npm_execpath is not set; run `npm run audit` (or invoke npm's CLI explicitly)",
  );
  process.exit(2);
}

try {
  execFileSync(
    process.execPath,
    [npmExecPath, "audit", "--audit-level=high"],
    { stdio: "inherit" },
  );
} catch (error) {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status
      : undefined;
  process.exit(typeof status === "number" ? status : 2);
}
