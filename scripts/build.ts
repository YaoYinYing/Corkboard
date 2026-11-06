#!/usr/bin/env node
// Single definition of the production build: compile with the project's
// TypeScript, then place migrations next to the compiled adapter. `npm run
// build` and the reproducibility proof both call this module so the steps
// cannot drift.
import { execFileSync } from "node:child_process";
import { cpSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function compileProject(
  root: string,
  outDir: string,
  timeoutMs?: number,
): void {
  execFileSync(
    process.execPath,
    [
      join(root, "node_modules", "typescript", "lib", "tsc.js"),
      "-p",
      "tsconfig.build.json",
      "--outDir",
      outDir,
    ],
    {
      cwd: root,
      stdio: ["ignore", "inherit", "inherit"],
      ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
    },
  );
}

export function copyMigrations(root: string, outDir: string): void {
  cpSync(join(root, "migrations"), join(outDir, "migrations"), {
    recursive: true,
  });
}

export function buildProject(
  root: string,
  outDir: string,
  timeoutMs?: number,
): void {
  compileProject(root, outDir, timeoutMs);
  copyMigrations(root, outDir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    buildProject(process.cwd(), join(process.cwd(), "dist"));
  } catch (error) {
    const hasStatus =
      typeof error === "object" && error !== null && "status" in error &&
      typeof (error as { status: unknown }).status === "number";
    // A compiler failure already printed its diagnostics; any other failure
    // (e.g. the migrations copy) has no child status and must still explain
    // itself rather than fail silently.
    if (!hasStatus) console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = hasStatus ? (error as { status: number }).status : 1;
  }
}
