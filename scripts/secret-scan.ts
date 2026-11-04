#!/usr/bin/env node
// Scans staged and untracked-but-not-ignored files for high-signal secrets.
// Reads staged index blobs (not the worktree) for tracked files, and falls back
// to the worktree for intent-to-add entries. Repo-wide even when invoked from a
// subdirectory. Prints only file, line, and pattern name — never the value.
// Fails closed on unreadable or oversized inputs.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PATTERNS: ReadonlyArray<{ name: string; re: RegExp }> = [
  { name: "url-credentials", re: /\/\/[^\s\/:@]+:[^\s@]+@/ },
  { name: "url-userinfo", re: /\/\/(?!\[REDACTED\]@)[^\s\/@]+@/ },
  { name: "private-key", re: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/ },
  // Assembled so this file does not match its own pattern.
  { name: "pgp-private-key", re: new RegExp("-----BEGIN " + "PGP PRIVATE KEY BLOCK" + "-----") },
  { name: "github-token", re: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}\b/ },
  { name: "gitlab-token", re: /\b(?:glpat|glrt|gldt)-[A-Za-z0-9_-]{20,}\b/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "google-api-key", re: /\b(?:AIza[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,})\b/ },
  { name: "stripe-secret", re: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { name: "openai-key", re: /\bsk-(?:proj-|svcacct-|ant-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b|\bxapp-[A-Za-z0-9-]{10,}\b/ },
  {
    name: "corkboard-secret-env",
    re: /\bCORKBOARD_[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PEPPER|PASSWORD)[A-Z0-9_]*["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/i,
  },
  { name: "speaker-token", re: /\bcb_[A-Za-z0-9_-]{32,}\b/ },
];

export const MAX_BYTES = 32 << 20;

export function findSecrets(text: string): Array<{ line: number; name: string }> {
  const findings: Array<{ line: number; name: string }> = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) findings.push({ line: i + 1, name });
    }
  }
  return findings;
}

// Latin-1 preserves raw bytes; UTF-16LE/BE cover encoded text. Binary content is
// still scanned byte-for-byte by the Latin-1 pass.
export function decodings(bytes: Uint8Array): string[] {
  const buffer = Buffer.from(bytes);
  const texts = [buffer.toString("latin1"), buffer.toString("utf16le")];
  if (buffer.length >= 2) {
    const swapped = Buffer.from(buffer);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const first = swapped[i] ?? 0;
      swapped[i] = swapped[i + 1] ?? 0;
      swapped[i + 1] = first;
    }
    texts.push(swapped.toString("utf16le"));
  }
  return texts;
}

function git(root: string, args: string[]): Buffer {
  return execFileSync("git", ["-C", root, ...args], { maxBuffer: 128 << 20 });
}

function listFiles(root: string, args: string[]): string[] {
  return git(root, ["ls-files", "-z", ...args]).toString("utf8").split("\0").filter(Boolean);
}

function isForbiddenPath(file: string): boolean {
  return basename(file).toLowerCase() === "original_design.md";
}

function scanBytes(path: string, bytes: Uint8Array): number {
  if (bytes.length > MAX_BYTES) {
    console.error(`${path}: larger than ${MAX_BYTES} bytes; refusing to skip`);
    return 1;
  }
  const seen = new Set<string>();
  let findings = 0;
  for (const text of decodings(bytes)) {
    for (const finding of findSecrets(text)) {
      const key = `${finding.line}:${finding.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      console.error(`${path}:${finding.line}: ${finding.name}`);
      findings++;
    }
  }
  return findings;
}

function main(): void {
  let root: string;
  let cached: string[];
  let untracked: string[];
  try {
    root = git(process.cwd(), ["rev-parse", "--show-toplevel"]).toString("utf8").trim();
    if (root === "") throw new Error("no worktree root");
    cached = listFiles(root, ["--cached"]);
    untracked = listFiles(root, ["--others", "--exclude-standard"]);
  } catch {
    console.error("secret-scan: git unavailable; refusing to report success");
    process.exit(2);
  }

  let findings = 0;
  for (const file of cached) {
    if (isForbiddenPath(file)) {
      console.error(`${file}:1: forbidden-path`);
      findings++;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = git(root, ["show", `:${file}`]);
    } catch {
      console.error(`${file}: unreadable staged blob; refusing to skip`);
      findings++;
      continue;
    }
    findings += scanBytes(file, bytes);
    if (bytes.length === 0) {
      // Intent-to-add (`git add -N`) stages an empty blob; scan the worktree too.
      try {
        findings += scanBytes(file, readFileSync(join(root, file)));
      } catch {
        // No worktree content exists; there is nothing to leak.
      }
    }
  }
  for (const file of untracked) {
    if (isForbiddenPath(file)) {
      console.error(`${file}:1: forbidden-path`);
      findings++;
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = readFileSync(join(root, file));
    } catch {
      console.error(`${file}: unreadable file; refusing to skip`);
      findings++;
      continue;
    }
    findings += scanBytes(file, bytes);
  }

  if (findings > 0) {
    console.error(`secret-scan: ${findings} finding(s); remove the value and rotate if exposed`);
    process.exit(1);
  }
  console.log("secret-scan: ok");
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    // realpath comparison also handles invocation through a symlink.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv);
  } catch {
    return false;
  }
}

if (isEntryPoint()) main();
