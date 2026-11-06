import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  buildManifest,
  compareManifests,
  runReproBuild,
  type BuildFn,
} from "../../scripts/reproducible-build.ts";

const script = fileURLToPath(
  new URL("../../scripts/reproducible-build.ts", import.meta.url),
);

function withTempParent(fn: (parent: string) => void): void {
  const parent = mkdtempSync(join(tmpdir(), "corkboard-repro-test-"));
  try {
    fn(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function write(outDir: string, path: string, content: string): void {
  const absolute = join(outDir, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

test("identical builds produce identical manifests and clean up", () => {
  withTempParent((parent) => {
    const build: BuildFn = (outDir) => {
      write(outDir, "src/a.js", "alpha");
      write(outDir, "migrations/001.sql", "create table t (id integer);");
    };
    const result = runReproBuild(build, { tmpRoot: parent });
    assert.equal(result.ok, true);
    assert.equal(result.files, 2);
    assert.deepEqual(result.diffs, []);
    assert.deepEqual(readdirSync(parent), []);
  });
});

test("one changed byte is reported by path only", () => {
  withTempParent((parent) => {
    const build: BuildFn = (outDir, run) => {
      write(outDir, "src/a.js", run === 1 ? "alpha" : "alphb");
    };
    const result = runReproBuild(build, { tmpRoot: parent });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diffs, ["content differs: src/a.js"]);
    assert.deepEqual(readdirSync(parent), []);
  });
});

test("extra and missing files are reported by path only", () => {
  withTempParent((parent) => {
    const build: BuildFn = (outDir, run) => {
      write(outDir, "common.js", "same");
      if (run === 1) {
        write(outDir, "only-in-first.js", "first");
      } else {
        write(outDir, "only-in-second.js", "second");
      }
    };
    const result = runReproBuild(build, { tmpRoot: parent });
    assert.equal(result.ok, false);
    assert.deepEqual(result.diffs, [
      "only in run 1: only-in-first.js",
      "only in run 2: only-in-second.js",
    ]);
    assert.deepEqual(readdirSync(parent), []);
  });
});

test("file creation order does not change the manifest", () => {
  withTempParent((parent) => {
    const files = ["c.js", "a.js", "b.js"];
    const build: BuildFn = (outDir, run) => {
      for (const name of run === 1 ? files : [...files].reverse()) {
        write(outDir, name, name);
      }
    };
    const result = runReproBuild(build, { tmpRoot: parent });
    assert.equal(result.ok, true);
    assert.equal(result.files, 3);
    assert.deepEqual(result.diffs, []);
  });
});

test("manifest paths are relative, sorted, and digest byte content", () => {
  withTempParent((parent) => {
    // Creation order is reverse-sorted so a missing sort would be visible.
    write(parent, "z.js", "z");
    write(parent, "m/nested.js", "n");
    write(parent, "a.js", "a");
    const manifest = buildManifest(parent);
    assert.deepEqual([...manifest.keys()], ["a.js", "m/nested.js", "z.js"]);
    // SHA-256("a")
    assert.equal(
      manifest.get("a.js"),
      "ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
    );
  });
});

test("compareManifests sorts paths and reports every difference once", () => {
  // Map insertion order is deliberately not sorted.
  const first = new Map([
    ["z.js", "1"],
    ["m.js", "1"],
  ]);
  const second = new Map([
    ["a.js", "2"],
    ["m.js", "2"],
  ]);
  assert.deepEqual(compareManifests(first, second), [
    "only in run 2: a.js",
    "content differs: m.js",
    "only in run 1: z.js",
  ]);
});

test("an empty output cannot pass as an identical proof", () => {
  withTempParent((parent) => {
    const build: BuildFn = (outDir) => {
      mkdirSync(outDir, { recursive: true });
    };
    assert.throws(
      () => runReproBuild(build, { tmpRoot: parent }),
      /build produced no files/,
    );
    assert.deepEqual(readdirSync(parent), []);
  });
});

test("a non-regular output entry fails closed", (t) => {
  withTempParent((parent) => {
    write(parent, "a.js", "a");
    try {
      symlinkSync("a.js", join(parent, "link.js"));
    } catch {
      t.skip("symlinks are unavailable in this environment");
      return;
    }
    assert.throws(
      () => buildManifest(parent),
      /unexpected non-regular output entry: link\.js/,
    );
  });
});

test("the manifest file cap fails closed", () => {
  withTempParent((parent) => {
    write(parent, "a.js", "a");
    write(parent, "b.js", "b");
    write(parent, "c.js", "c");
    assert.throws(() => buildManifest(parent, 2), /output has more than 2 files/);
  });
});

test("a failing build still removes the temporary output directories", () => {
  withTempParent((parent) => {
    const build: BuildFn = (outDir, run) => {
      write(outDir, "a.js", "a");
      if (run === 2) {
        throw new Error("injected build failure");
      }
    };
    assert.throws(
      () => runReproBuild(build, { tmpRoot: parent }),
      /injected build failure/,
    );
    assert.deepEqual(readdirSync(parent), []);
  });
});

function runCli(mode: string): {
  status: number;
  stdout: string;
  stderr: string;
  tmpEntries: string[];
} {
  const root = mkdtempSync(join(tmpdir(), "corkboard-repro-cli-"));
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  mkdirSync(join(root, "node_modules", "typescript", "lib"), { recursive: true });
  mkdirSync(join(root, "migrations"), { recursive: true });
  writeFileSync(
    join(root, "node_modules", "typescript", "lib", "tsc.js"),
    `const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const out = args[args.indexOf("--outDir") + 1];
fs.mkdirSync(out, { recursive: true });
const mode = process.env.FAKE_TSC_MODE;
if (mode === "fail") {
  process.stderr.write("fake tsc failure\\n");
  process.exit(7);
}
if (mode === "empty") process.exit(0);
fs.writeFileSync(path.join(out, "index.js"), mode === "differ" ? "CONTENT-" + path.basename(out) : "same");
`,
  );
  try {
    let status = 0;
    let stdout = "";
    let stderr = "";
    try {
      stdout = execFileSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, FAKE_TSC_MODE: mode, TMPDIR: tmp },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      const result = error as { status?: number; stdout?: string; stderr?: string };
      status = result.status ?? -1;
      stdout = result.stdout ?? "";
      stderr = result.stderr ?? "";
    }
    return { status, stdout, stderr, tmpEntries: readdirSync(tmp) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("CLI exits 0 for identical builds and cleans up", () => {
  const result = runCli("same");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /identical manifests \(1 file/);
  assert.deepEqual(result.tmpEntries, []);
});

test("CLI exits 1 with paths only for a differing build and cleans up", () => {
  const result = runCli("differ");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /content differs: index\.js/);
  assert.doesNotMatch(result.stderr, /CONTENT-/);
  assert.deepEqual(result.tmpEntries, []);
});

test("CLI exits 2 when the compiler fails and cleans up", () => {
  const result = runCli("fail");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /build or manifest failed/);
  assert.deepEqual(result.tmpEntries, []);
});

test("CLI exits 2 for an empty build and cleans up", () => {
  const result = runCli("empty");
  assert.equal(result.status, 2);
  assert.match(result.stderr, /build produced no files/);
  assert.deepEqual(result.tmpEntries, []);
});
