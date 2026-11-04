#!/usr/bin/env node
// Scans every reachable git revision and path for secrets and the forbidden
// unredacted archival file. Prints only commit, path, line, and pattern name.
import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { decodings, findSecrets, MAX_BYTES } from "./secret-scan.ts";

function git(args: string[]): Buffer {
  return execFileSync("git", args, { maxBuffer: 128 << 20 });
}

function main(): void {
  let commits: string[];
  try {
    const shallow = git(["rev-parse", "--is-shallow-repository"]).toString("utf8").trim();
    if (shallow === "true") {
      console.error("history-secret-scan: shallow repository; fetch full history first");
      process.exit(2);
    }
    commits = git(["rev-list", "--all"]).toString("utf8").split("\n").filter(Boolean);
  } catch {
    console.error("history-secret-scan: git unavailable; refusing to report success");
    process.exit(2);
  }

  let findings = 0;
  const metadata = [
    { label: "commit-message", text: git(["log", "--all", "--format=%B"]).toString("utf8") },
    {
      label: "tag-message",
      text: git(["for-each-ref", "--format=%(contents)", "refs/tags"]).toString("utf8"),
    },
  ];
  for (const { label, text } of metadata) {
    for (const finding of findSecrets(text)) {
      console.error(`${label}:${finding.line}: ${finding.name}`);
      findings++;
    }
  }
  for (const commit of commits) {
    let files: string[];
    try {
      files = git(["ls-tree", "-r", "-z", "--name-only", commit])
        .toString("utf8")
        .split("\0")
        .filter(Boolean);
    } catch {
      console.error(`${commit.slice(0, 12)}: unreadable tree; refusing to skip`);
      findings++;
      continue;
    }
    for (const file of files) {
      if (basename(file).toLowerCase() === "original_design.md") {
        console.error(`${commit.slice(0, 12)}:${file}: forbidden-path`);
        findings++;
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = git(["show", `${commit}:${file}`]);
      } catch {
        console.error(`${commit.slice(0, 12)}:${file}: unreadable blob; refusing to skip`);
        findings++;
        continue;
      }
      if (bytes.length > MAX_BYTES) {
        console.error(`${commit.slice(0, 12)}:${file}: larger than ${MAX_BYTES} bytes; refusing to skip`);
        findings++;
        continue;
      }
      const seen = new Set<string>();
      for (const text of decodings(bytes)) {
        for (const finding of findSecrets(text)) {
          const key = `${finding.line}:${finding.name}`;
          if (seen.has(key)) continue;
          seen.add(key);
          console.error(`${commit.slice(0, 12)}:${file}:${finding.line}: ${finding.name}`);
          findings++;
        }
      }
    }
  }

  if (findings > 0) {
    console.error(`history-secret-scan: ${findings} finding(s)`);
    process.exit(1);
  }
  console.log(`history-secret-scan: ok (${commits.length} commits)`);
}

main();
