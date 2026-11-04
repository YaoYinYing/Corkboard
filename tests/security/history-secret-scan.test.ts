import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/history-secret-scan.ts", import.meta.url));

function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-history-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(dir: string, args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "ignore" });
}

function commit(dir: string, message: string): void {
  git(dir, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message]);
}

function run(dir: string): { status: number; stderr: string } {
  try {
    execFileSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    return { status: err.status ?? -1, stderr: err.stderr ?? "" };
  }
}

test("passes a clean history", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "README.md"), "# clean\n");
    git(dir, ["add", "."]);
    commit(dir, "init");
    assert.equal(run(dir).status, 0);
  });
});

test("rejects a forbidden archival path at any depth and casing", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs", "Original_Design.md"), "harmless\n");
    git(dir, ["add", "."]);
    commit(dir, "init");
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden-path/);
  });
});

test("rejects UTF-16 encoded secrets in history", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    writeFileSync(
      join(dir, "secret.txt"),
      Buffer.from("CORKBOARD_ROOT_KEY=" + "A".repeat(44) + "\n", "utf16le"),
    );
    git(dir, ["add", "."]);
    commit(dir, "init");
    assert.equal(run(dir).status, 1);
  });
});

test("rejects UTF-16BE encoded secrets in history", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    const le = Buffer.from("CORKBOARD_ROOT_KEY=" + "A".repeat(44) + "\n", "utf16le");
    const be = Buffer.alloc(le.length);
    for (let i = 0; i + 1 < le.length; i += 2) {
      be[i] = le[i + 1] ?? 0;
      be[i + 1] = le[i] ?? 0;
    }
    writeFileSync(join(dir, "secret.txt"), be);
    git(dir, ["add", "."]);
    commit(dir, "init");
    assert.equal(run(dir).status, 1);
  });
});

test("rejects a secret present only in a commit message", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "README.md"), "clean\n");
    git(dir, ["add", "."]);
    commit(dir, "token " + "cb_" + "m".repeat(40));
    assert.equal(run(dir).status, 1);
  });
});

test("rejects a secret introduced in an earlier commit and later removed", () => {
  withRepo((dir) => {
    git(dir, ["init", "-q"]);
    writeFileSync(join(dir, "leak.txt"), "token " + "cb_" + "q".repeat(40) + "\n");
    git(dir, ["add", "."]);
    commit(dir, "leak");
    writeFileSync(join(dir, "leak.txt"), "clean\n");
    git(dir, ["add", "."]);
    commit(dir, "cleanup");
    assert.equal(run(dir).status, 1);
  });
});
