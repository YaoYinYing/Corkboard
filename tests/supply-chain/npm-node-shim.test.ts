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

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const packageJson = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf8"),
) as { scripts: Record<string, string> };
const licensesCommand = packageJson.scripts.licenses ?? "";

function childEnv(npmNodeExecPath: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.npm_node_execpath;
  if (npmNodeExecPath !== undefined) {
    env.npm_node_execpath = npmNodeExecPath;
  }
  return env;
}

test("$npm_node_execpath runs licenses without executing node/tsc shims", () => {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-node-shim-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "license-report.ts"),
      readFileSync(join(repoRoot, "scripts", "license-report.ts")),
    );
    writeFileSync(
      join(dir, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "": {}, "node_modules/a": { version: "1.0.0" } },
      }),
    );
    mkdirSync(join(dir, "node_modules", "a"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "a", "package.json"),
      JSON.stringify({ name: "a", version: "1.0.0", license: "MIT" }),
    );
    const bin = join(dir, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    for (const name of ["node", "tsc"]) {
      const shim = join(bin, name);
      writeFileSync(shim, `#!/bin/sh\ntouch "${join(dir, `${name}-shim-ran`)}"\n`);
      chmodSync(shim, 0o755);
    }

    execFileSync("/bin/sh", ["-c", licensesCommand], {
      cwd: dir,
      env: {
        ...childEnv(process.execPath),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    assert.match(
      readFileSync(join(dir, "reports", "licenses.txt"), "utf8"),
      /permissive\truntime\ta\t1\.0\.0\tMIT/,
    );
    assert.equal(existsSync(join(dir, "node-shim-ran")), false);
    assert.equal(existsSync(join(dir, "tsc-shim-ran")), false);

    assert.throws(
      () =>
        execFileSync("/bin/sh", ["-c", licensesCommand], {
          cwd: dir,
          env: {
            ...childEnv(undefined),
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          },
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (error: unknown) => {
        const { status, stderr } = error as { status?: number; stderr?: Buffer };
        assert.notEqual(status, 0);
        assert.match(String(stderr), /npm_node_execpath is not set/);
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "node-shim-ran")), false);
    assert.equal(existsSync(join(dir, "tsc-shim-ran")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
