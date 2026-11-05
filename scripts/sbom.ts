#!/usr/bin/env node
// Generates a CycloneDX SBOM with npm's built-in generator and writes it to
// reports/sbom.cdx.json. npm sbom reads the installed tree and lockfile, so it
// works offline after `npm ci`. The serial number and timestamp vary per run.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Bom {
  metadata?: { component?: { name?: string; version?: string } };
  components?: unknown[];
}

function main(): void {
  const root = process.cwd();
  let packageName: string | undefined;
  let packageVersion: string | undefined;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    packageName = typeof pkg.name === "string" ? pkg.name : undefined;
    packageVersion = typeof pkg.version === "string" ? pkg.version : undefined;
  } catch (error) {
    console.error(`sbom: cannot read package.json: ${String(error)}`);
    process.exit(2);
  }

  // Resolve the installed npm CLI explicitly. Never let PATH pick an `npm`:
  // `npm run` prepends node_modules/.bin, so a dependency could shadow it.
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath) {
    console.error(
      "sbom: npm_execpath is not set; run `npm run sbom` (or invoke npm's CLI explicitly)",
    );
    process.exit(2);
  }

  let output: string;
  try {
    output = execFileSync(
      process.execPath,
      [npmExecPath, "sbom", "--sbom-format", "cyclonedx", "--sbom-type", "application"],
      { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    const detail =
      typeof error === "object" && error !== null && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "")
        : "";
    console.error(
      `sbom: npm sbom failed (requires npm >= 9.6 and an installed tree): ${String(error)}`,
    );
    if (detail !== "") {
      console.error(detail.trim());
    }
    process.exit(2);
  }

  let bom: Bom;
  try {
    bom = JSON.parse(output) as Bom;
  } catch (error) {
    console.error(`sbom: npm sbom returned invalid JSON: ${String(error)}`);
    process.exit(2);
  }

  // npm derives the root component's display name from the working directory,
  // which is not stable; keep the package.json identity instead.
  const component = bom.metadata?.component;
  if (component && packageName !== undefined) {
    component.name = packageName;
  }
  if (component && packageVersion !== undefined) {
    component.version = packageVersion;
  }

  const outDir = join(root, "reports");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "sbom.cdx.json"), `${JSON.stringify(bom, null, 2)}\n`);
  console.log(
    `sbom: wrote reports/sbom.cdx.json (${bom.components?.length ?? 0} components)`,
  );
}

main();
