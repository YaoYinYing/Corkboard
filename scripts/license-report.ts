#!/usr/bin/env node
// Builds a stable dependency license report from package-lock.json and the
// installed node_modules/*/package.json files. Offline: no registry access.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

// MIT-compatible licenses accepted without a separate notice review.
export const PERMISSIVE_LICENSES = new Set([
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "CC0-1.0",
  "ISC",
  "MIT",
  "Unlicense",
]);

// Common reciprocal/licenses that require a notice review, not automatic rejection.
const NOTICE_LICENSES = new Set([
  "AGPL-1.0-only",
  "AGPL-1.0-or-later",
  "AGPL-3.0-only",
  "AGPL-3.0-or-later",
  "CC-BY-SA-4.0",
  "CDDL-1.0",
  "CDDL-1.1",
  "EPL-1.0",
  "EPL-2.0",
  "GPL-2.0-only",
  "GPL-2.0-or-later",
  "GPL-3.0-only",
  "GPL-3.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MPL-2.0",
]);

export type LicenseStatus = "permissive" | "notice" | "missing" | "unknown";
export type DependencyScope = "runtime" | "dev";

export interface DependencyRecord {
  name: string;
  version: string;
  scope: DependencyScope;
  license: string;
  status: LicenseStatus;
  path: string;
}

export interface LicenseReport {
  total: number;
  runtime: number;
  dev: number;
  flagged: DependencyRecord[];
  dependencies: DependencyRecord[];
}

export interface LockEntry {
  version?: unknown;
  dev?: unknown;
  devOptional?: unknown;
  license?: unknown;
}

export interface BuildInput {
  packages: Record<string, LockEntry>;
  readPackageJson: (path: string) => unknown;
}

// Reduces every legacy declaration form to usable strings; an unusable value
// (empty string, empty array, {url}, {type: 123}) yields undefined so the caller
// can fall back to the lock entry.
function licenseString(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    const value = raw.trim();
    return value === "" ? undefined : value;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .map(licenseString)
      .filter((value): value is string => value !== undefined);
    return parts.length > 0 ? parts.join(" OR ") : undefined;
  }
  if (typeof raw === "object" && raw !== null && "type" in raw) {
    return licenseString((raw as { type?: unknown }).type);
  }
  return undefined;
}

function packageLicense(pkg: unknown): string | undefined {
  if (typeof pkg !== "object" || pkg === null) {
    return undefined;
  }
  const { license, licenses } = pkg as { license?: unknown; licenses?: unknown };
  return licenseString(license) ?? licenseString(licenses);
}

export function classifyLicense(declared: unknown): {
  license: string;
  status: LicenseStatus;
} {
  const raw = Array.isArray(declared)
    ? declared.filter((part): part is string => typeof part === "string").join(" OR ")
    : typeof declared === "string"
      ? declared
      : "";
  const license = raw.trim();
  if (license === "") {
    return { license: "MISSING", status: "missing" };
  }
  const tokens = license
    .replace(/[()]/g, " ")
    .split(/\s+(?:AND|OR|WITH)\s+|\s+/)
    .filter(Boolean);
  if (tokens.length > 0 && tokens.every((token) => PERMISSIVE_LICENSES.has(token))) {
    return { license, status: "permissive" };
  }
  if (tokens.some((token) => NOTICE_LICENSES.has(token))) {
    return { license, status: "notice" };
  }
  return { license, status: "unknown" };
}

function nameFromPath(path: string): string {
  const index = path.lastIndexOf("node_modules/");
  return index === -1 ? path : path.slice(index + "node_modules/".length);
}

// Lock paths are untrusted input. Reject absolute paths, traversal, and empty
// segments so a tampered lock cannot make the scan read outside node_modules.
export function isSafePackagePath(path: string): boolean {
  if (!path.startsWith("node_modules/")) {
    return false;
  }
  return path
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function buildLicenseReport({
  packages,
  readPackageJson,
}: BuildInput): LicenseReport {
  const dependencies: DependencyRecord[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (path === "") {
      continue;
    }
    const absoluteOrTraversal =
      path.startsWith("/") ||
      path.startsWith("\\") ||
      /^[A-Za-z]:[\\/]/.test(path) ||
      path.split(/[\\/]/).includes("..");
    if (absoluteOrTraversal) {
      throw new Error(`unsafe package path in lockfile: ${path}`);
    }
    if (!path.startsWith("node_modules/")) {
      continue;
    }
    if (!isSafePackagePath(path)) {
      throw new Error(`unsafe package path in lockfile: ${path}`);
    }
    let pkg: unknown;
    try {
      pkg = readPackageJson(path);
    } catch {
      pkg = undefined;
    }
    const record =
      typeof pkg === "object" && pkg !== null
        ? (pkg as { name?: unknown; version?: unknown })
        : {};
    const declared = packageLicense(pkg) ?? packageLicense(entry);
    const { license, status } = classifyLicense(declared);
    dependencies.push({
      name: typeof record.name === "string" ? record.name : nameFromPath(path),
      version:
        typeof record.version === "string"
          ? record.version
          : typeof entry.version === "string"
            ? entry.version
            : "unknown",
      scope: entry.dev === true || entry.devOptional === true ? "dev" : "runtime",
      license,
      status,
      path,
    });
  }
  dependencies.sort(
    (a, b) =>
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      (a.version < b.version ? -1 : a.version > b.version ? 1 : 0) ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
  );
  return {
    total: dependencies.length,
    runtime: dependencies.filter((entry) => entry.scope === "runtime").length,
    dev: dependencies.filter((entry) => entry.scope === "dev").length,
    flagged: dependencies.filter((entry) => entry.status !== "permissive"),
    dependencies,
  };
}

function textReport(report: LicenseReport): string {
  const lines = [
    "# Corkboard dependency license report",
    "# Policy: permissive-only (MIT-compatible); notice/unknown/missing needs review.",
    "# Source: package-lock.json + node_modules/*/package.json, no network.",
    `# Total: ${report.total} (runtime ${report.runtime}, dev ${report.dev}); flagged ${report.flagged.length}`,
    "status\tscope\tname\tversion\tlicense",
    ...report.dependencies.map(
      (entry) =>
        `${entry.status}\t${entry.scope}\t${entry.name}\t${entry.version}\t${entry.license}`,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const root = process.cwd();
  let packages: Record<string, LockEntry>;
  try {
    const lock = JSON.parse(
      readFileSync(join(root, "package-lock.json"), "utf8"),
    ) as { packages?: unknown };
    if (typeof lock.packages !== "object" || lock.packages === null) {
      throw new Error("package-lock.json has no packages map");
    }
    packages = lock.packages as Record<string, LockEntry>;
  } catch (error) {
    console.error(`licenses: cannot read package-lock.json: ${String(error)}`);
    process.exit(2);
  }

  const nodeModules = resolve(root, "node_modules");
  let report: LicenseReport;
  try {
    report = buildLicenseReport({
      packages,
      readPackageJson: (path) => {
        const file = resolve(root, path, "package.json");
        if (!file.startsWith(`${nodeModules}${sep}`)) {
          throw new Error(`refusing to read outside node_modules: ${path}`);
        }
        return JSON.parse(readFileSync(file, "utf8"));
      },
    });
  } catch (error) {
    console.error(`licenses: invalid lockfile entry: ${String(error)}`);
    process.exit(2);
  }
  const outDir = join(root, "reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "licenses.txt"), textReport(report));
  writeFileSync(
    join(outDir, "licenses.json"),
    `${JSON.stringify(
      {
        policy: "permissive-only (MIT-compatible)",
        total: report.total,
        runtime: report.runtime,
        dev: report.dev,
        flagged: report.flagged.length,
        dependencies: report.dependencies,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    `licenses: ${report.total} dependencies (runtime ${report.runtime}, dev ${report.dev}); ` +
      `flagged ${report.flagged.length}; wrote reports/licenses.txt and reports/licenses.json`,
  );
  if (report.flagged.length > 0) {
    for (const entry of report.flagged) {
      console.error(
        `licenses: ${entry.status}: ${entry.name}@${entry.version} (${entry.scope}) ${entry.license}`,
      );
    }
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
