import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildLicenseReport,
  classifyLicense,
  isSafePackagePath,
  type LockEntry,
} from "../../scripts/license-report.ts";

test("classifyLicense accepts permissive licenses and SPDX expressions", () => {
  assert.deepEqual(classifyLicense("MIT"), { license: "MIT", status: "permissive" });
  assert.equal(classifyLicense("(MIT OR Apache-2.0)").status, "permissive");
  assert.equal(classifyLicense(["MIT", "ISC"]).status, "permissive");
});

test("classifyLicense flags missing, notice, and unknown declarations", () => {
  assert.deepEqual(classifyLicense(undefined), { license: "MISSING", status: "missing" });
  assert.deepEqual(classifyLicense("  "), { license: "MISSING", status: "missing" });
  assert.equal(classifyLicense("GPL-3.0-only").status, "notice");
  assert.equal(classifyLicense("MIT AND GPL-2.0-only").status, "notice");
  assert.equal(classifyLicense("SEE LICENSE IN LICENSE").status, "unknown");
  assert.equal(classifyLicense("Proprietary").status, "unknown");
});

test("buildLicenseReport labels scope, sorts stably, and flags unreadable metadata", () => {
  const packages: Record<string, LockEntry> = {
    "": { version: "0.0.0" },
    "node_modules/@scope/dev": { version: "2.0.0", dev: true },
    "node_modules/a": { version: "1.0.0" },
    "node_modules/z": { version: "3.0.0" },
  };
  const installed: Record<string, unknown> = {
    "node_modules/@scope/dev": {
      name: "@scope/dev",
      version: "2.0.0",
      license: "GPL-3.0-only",
    },
    "node_modules/a": { name: "a", version: "1.0.0", license: "MIT" },
  };
  const report = buildLicenseReport({
    packages,
    readPackageJson: (path) => {
      if (!(path in installed)) {
        throw new Error("missing node_modules entry");
      }
      return installed[path];
    },
  });

  assert.equal(report.total, 3);
  assert.equal(report.runtime, 2);
  assert.equal(report.dev, 1);
  assert.deepEqual(
    report.dependencies.map((entry) => entry.name),
    ["@scope/dev", "a", "z"],
  );
  assert.deepEqual(
    report.flagged.map((entry) => [entry.name, entry.status]),
    [
      ["@scope/dev", "notice"],
      ["z", "missing"],
    ],
  );
  assert.equal(report.dependencies[1]?.scope, "runtime");
});

test("legacy object-form license declarations are classified", () => {
  const installed = buildLicenseReport({
    packages: { "node_modules/a": { version: "1.0.0" } },
    readPackageJson: () => ({
      name: "a",
      version: "1.0.0",
      license: { type: "MIT" },
    }),
  });
  assert.equal(installed.dependencies[0]?.status, "permissive");

  // The lock-entry fallback accepts the same legacy object form.
  const fallback = buildLicenseReport({
    packages: {
      "node_modules/b": { version: "1.0.0", license: { type: "ISC" } },
    },
    readPackageJson: () => {
      throw new Error("unreadable");
    },
  });
  assert.equal(fallback.dependencies[0]?.status, "permissive");
  assert.equal(fallback.flagged.length, 0);
});

test("lock paths cannot escape node_modules or be absolute", () => {
  assert.equal(isSafePackagePath("node_modules/a"), true);
  assert.equal(isSafePackagePath("node_modules/@scope/a"), true);
  assert.equal(isSafePackagePath("node_modules/../outside"), false);
  assert.equal(isSafePackagePath("node_modules/a/../../outside"), false);
  assert.equal(isSafePackagePath("/tmp/node_modules/a"), false);

  for (const path of [
    "node_modules/../outside",
    "/tmp/node_modules/outside",
    "C:\\node_modules\\outside",
  ]) {
    assert.throws(
      () =>
        buildLicenseReport({
          packages: { [path]: { version: "1.0.0" } },
          readPackageJson: () => {
            throw new Error("must not read");
          },
        }),
      /unsafe package path in lockfile/,
    );
  }
});
