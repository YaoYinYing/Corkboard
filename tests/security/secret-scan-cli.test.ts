import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../../scripts/secret-scan.ts", import.meta.url));

function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-scan-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(dir: string): { status: number; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: stdout };
  } catch (error) {
    const err = error as { status?: number; stderr?: string };
    return { status: err.status ?? -1, stderr: err.stderr ?? "" };
  }
}

test("passes a clean repository", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "README.md"), "# clean\n");
    execFileSync("git", ["add", "README.md"], { cwd: dir });
    assert.equal(run(dir).status, 0);
  });
});

test("fails closed outside a git repository", () => {
  withRepo((dir) => {
    assert.equal(run(dir).status, 2);
  });
});

test("catches a secret in the staged blob even when removed from the worktree", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "leak.txt"), "token " + "cb_" + "a".repeat(40) + "\n");
    execFileSync("git", ["add", "leak.txt"], { cwd: dir });
    writeFileSync(join(dir, "leak.txt"), "clean now\n");
    assert.equal(run(dir).status, 1);
  });
});

test("scans the repository when invoked from a subdirectory", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "leak.txt"), "token " + "cb_" + "s".repeat(40) + "\n");
    execFileSync("git", ["add", "leak.txt"], { cwd: dir });
    mkdirSync(join(dir, "sub"));
    assert.equal(run(join(dir, "sub")).status, 1);
  });
});

test("catches intent-to-add content that is not yet in the index blob", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, "leak.txt"), "token " + "cb_" + "t".repeat(40) + "\n");
    execFileSync("git", ["add", "-N", "leak.txt"], { cwd: dir });
    assert.equal(run(dir).status, 1);
  });
});

test("rejects the forbidden archive path with different casing or depth", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "Original_Design.md"), "harmless\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /forbidden-path/);
  });
});

test("catches quoted secret assignments and binary content", () => {
  withRepo((dir) => {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "env.txt"), 'CORKBOARD_ROOT_KEY="' + "A".repeat(44) + '"\n');
    writeFileSync(join(dir, "bin", "blob.dat"), Buffer.from([0, 1, 2, ...Buffer.from("cb_" + "z".repeat(40))]));
    execFileSync("git", ["add", "."], { cwd: dir });
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /corkboard-secret-env/);
    assert.match(result.stderr, /speaker-token/);
  });
});
