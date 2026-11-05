import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
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
  new URL("../../scripts/npm-audit.ts", import.meta.url),
);
const packageJsonPath = fileURLToPath(
  new URL("../../package.json", import.meta.url),
);

function fixture(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-audit-"));
  writeFileSync(
    join(dir, "fake-npm.js"),
    `const fs = require("node:fs");\n` +
      `fs.writeFileSync("fake-npm-ran", JSON.stringify(process.argv.slice(2)));\n` +
      `process.exit(Number(process.env.FAKE_EXIT || "0"));\n`,
  );
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "npm");
  writeFileSync(shim, `#!/bin/sh\ntouch "${join(dir, "shim-ran")}"\n`);
  chmodSync(shim, 0o755);
  return { dir, bin };
}

function run(
  dir: string,
  bin: string,
  extra: NodeJS.ProcessEnv,
): { status: number; stderr: string } {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
  };
  delete env.npm_execpath;
  Object.assign(env, extra);
  try {
    execFileSync(process.execPath, [script], {
      cwd: dir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stderr: "" };
  } catch (error) {
    const { status, stderr } = error as { status?: number; stderr?: Buffer };
    return { status: status ?? 1, stderr: String(stderr ?? "") };
  }
}

test("audit runs npm_execpath, ignores a PATH npm shim, and propagates status", () => {
  const { dir, bin } = fixture();
  try {
    const ok = run(dir, bin, {
      npm_execpath: join(dir, "fake-npm.js"),
      FAKE_EXIT: "0",
    });
    assert.equal(ok.status, 0);
    assert.deepEqual(
      JSON.parse(readFileSync(join(dir, "fake-npm-ran"), "utf8")),
      ["audit", "--audit-level=high"],
    );
    assert.equal(existsSync(join(dir, "shim-ran")), false);

    const failing = run(dir, bin, {
      npm_execpath: join(dir, "fake-npm.js"),
      FAKE_EXIT: "7",
    });
    assert.equal(failing.status, 7);
    assert.equal(existsSync(join(dir, "shim-ran")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("audit fails closed without npm_execpath", () => {
  const { dir, bin } = fixture();
  try {
    const result = run(dir, bin, {});
    assert.equal(result.status, 2);
    assert.match(result.stderr, /npm_execpath/);
    assert.equal(existsSync(join(dir, "shim-ran")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("check and audit scripts never invoke bare npm", () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
    scripts: Record<string, string>;
  };
  for (const name of ["check", "audit"]) {
    const command = pkg.scripts[name] ?? "";
    assert.doesNotMatch(command, /(^|[\s;&|])npm\s/, `${name} must not call npm`);
  }
  assert.match(pkg.scripts.check ?? "", /scripts\/secret-scan\.ts/);
  assert.match(pkg.scripts.check ?? "", /scripts\/history-secret-scan\.ts/);
  assert.match(pkg.scripts.check ?? "", /scripts\/license-report\.ts/);
  assert.match(pkg.scripts.check ?? "", /tsc --noEmit/);
  assert.match(pkg.scripts.check ?? "", /node --test/);
  assert.match(pkg.scripts.audit ?? "", /scripts\/npm-audit\.ts/);
});
