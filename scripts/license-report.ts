#!/usr/bin/env node
// Builds a stable dependency license report from package-lock.json and the
// installed node_modules/*/package.json files. Offline: no registry access.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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

function declaredLicense(pkg: unknown): unknown {
  if (typeof pkg !== "object" || pkg === null) {
    return undefined;
  }
  const { license, licenses } = pkg as { license?: unknown; licenses?: unknown };
  if (license !== undefined) {
    return license;
  }
  if (!Array.isArray(licenses)) {
    return undefined;
  }
  return licenses
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (typeof entry === "object" && entry !== null && "type" in entry) {
        return (entry as { type?: unknown }).type;
      }
      return undefined;
    })
    .filter((entry): entry is string => typeof entry === "string");
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

export function buildLicenseReport({
  packages,
  readPackageJson,
}: BuildInput): LicenseReport {
  const dependencies: DependencyRecord[] = [];
  for (const [path, entry] of Object.entries(packages)) {
    if (!path.startsWith("node_modules/")) {
      continue;
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
    const declared = declaredLicense(pkg) ?? declaredLicense(entry);
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

  const report = buildLicenseReport({
    packages,
    readPackageJson: (path) =>
      JSON.parse(readFileSync(join(root, path, "package.json"), "utf8")),
  });
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
