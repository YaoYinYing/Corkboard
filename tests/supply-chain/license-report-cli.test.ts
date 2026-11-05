import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(
  new URL("../../scripts/license-report.ts", import.meta.url),
);

function withRepo(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-licenses-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function install(
  dir: string,
  path: string,
  name: string,
  version: string,
  license: string | undefined,
): void {
  const pkgDir = join(dir, path);
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, "package.json"),
    JSON.stringify({ name, version, ...(license === undefined ? {} : { license }) }),
  );
}

function writeLock(
  dir: string,
  packages: Record<string, { version?: string; dev?: boolean; license?: string }>,
): void {
  writeFileSync(
    join(dir, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
}

function run(dir: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const { status, stdout, stderr } = error as {
      status?: number;
      stdout?: string;
      stderr?: string;
    };
    return { status: status ?? 1, stdout: stdout ?? "", stderr: stderr ?? "" };
  }
}

test("licenses exits 0 and writes stable reports for permissive entries", () => {
  withRepo((dir) => {
    writeLock(dir, { "": {}, "node_modules/a": { version: "1.0.0" } });
    install(dir, "node_modules/a", "a", "1.0.0", "MIT");
    const result = run(dir);
    assert.equal(result.status, 0);
    const text = readFileSync(join(dir, "reports", "licenses.txt"), "utf8");
    const json = JSON.parse(
      readFileSync(join(dir, "reports", "licenses.json"), "utf8"),
    ) as { total: number; flagged: number };
    assert.match(text, /permissive\truntime\ta\t1\.0\.0\tMIT/);
    assert.equal(json.total, 1);
    assert.equal(json.flagged, 0);
  });
});

test("licenses exits 1, reports, and names a flagged dependency", () => {
  withRepo((dir) => {
    writeLock(dir, {
      "": {},
      "node_modules/gpl": { version: "2.0.0", dev: true },
    });
    install(dir, "node_modules/gpl", "gpl", "2.0.0", "GPL-3.0-only");
    const result = run(dir);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /notice: gpl@2\.0\.0 \(dev\) GPL-3\.0-only/);
    const text = readFileSync(join(dir, "reports", "licenses.txt"), "utf8");
    assert.match(text, /notice\tdev\tgpl\t2\.0\.0\tGPL-3\.0-only/);
  });
});

test("licenses exits 2 on a missing lockfile and on an unsafe lock path", () => {
  withRepo((dir) => {
    const missing = run(dir);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /cannot read package-lock\.json/);

    writeLock(dir, { "": {}, "node_modules/../escape": { version: "1.0.0" } });
    const unsafe = run(dir);
    assert.equal(unsafe.status, 2);
    assert.match(unsafe.stderr, /unsafe package path in lockfile/);

    writeLock(dir, {
      "": {},
      "/tmp/node_modules/absolute": { version: "1.0.0" },
    });
    const absolute = run(dir);
    assert.equal(absolute.status, 2);
    assert.match(absolute.stderr, /unsafe package path in lockfile/);
  });
});
