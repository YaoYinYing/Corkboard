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

const script = fileURLToPath(new URL("../../scripts/sbom.ts", import.meta.url));

function fixture(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-sbom-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-name", version: "1.2.3" }),
  );
  // Stand-in for npm's CLI; it records that it ran and emits a minimal SBOM with
  // a deliberately wrong root name.
  writeFileSync(
    join(dir, "fake-npm.js"),
    `const fs = require("node:fs");\n` +
      `fs.writeFileSync("fake-npm-ran", "1");\n` +
      `process.stdout.write(JSON.stringify({metadata:{component:{name:"wrong-name",version:"9.9.9"}},components:[{name:"dep",version:"1.0.0"}]}));\n`,
  );
  const bin = join(dir, "node_modules", ".bin");
  mkdirSync(bin, { recursive: true });
  const shim = join(bin, "npm");
  writeFileSync(shim, `#!/bin/sh\ntouch "${join(dir, "shim-ran")}"\n`);
  chmodSync(shim, 0o755);
  return { dir, bin };
}

test("sbom uses npm_execpath, ignores a PATH npm shim, and normalizes the root", () => {
  const { dir, bin } = fixture();
  try {
    execFileSync(process.execPath, [script], {
      cwd: dir,
      env: {
        ...process.env,
        npm_execpath: join(dir, "fake-npm.js"),
        PATH: `${bin}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const bom = JSON.parse(
      readFileSync(join(dir, "reports", "sbom.cdx.json"), "utf8"),
    ) as {
      metadata: { component: { name: string; version: string } };
      components: unknown[];
    };
    assert.equal(bom.metadata.component.name, "fixture-name");
    assert.equal(bom.metadata.component.version, "1.2.3");
    assert.equal(bom.components.length, 1);
    assert.equal(existsSync(join(dir, "fake-npm-ran")), true);
    assert.equal(existsSync(join(dir, "shim-ran")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sbom fails closed without npm_execpath", () => {
  const { dir, bin } = fixture();
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };
    delete env.npm_execpath;
    assert.throws(
      () =>
        execFileSync(process.execPath, [script], {
          cwd: dir,
          env,
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (error: unknown) => {
        const { status, stderr } = error as { status?: number; stderr?: Buffer };
        assert.equal(status, 2);
        assert.match(String(stderr), /npm_execpath/);
        return true;
      },
    );
    assert.equal(existsSync(join(dir, "reports")), false);
    assert.equal(existsSync(join(dir, "shim-ran")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
