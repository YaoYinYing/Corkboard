#!/usr/bin/env node
// Proves the TypeScript build is deterministic for this tree and toolchain:
// run the same build definition as `npm run build` twice into sibling temporary
// output directories and compare a canonical relative-path + SHA-256 manifest.
// Offline; no dependency.
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProject } from "./build.ts";

// Bound the file count so the manifest cannot grow without limit. Each file is
// still read whole; this is not a per-file byte cap.
const MAX_FILES = 10_000;
const MAX_REPORTED_DIFFS = 20;
const BUILD_TIMEOUT_MS = 120_000;

export type BuildFn = (outDir: string, run: 1 | 2) => void;

export interface ReproOptions {
  /** Parent for the temporary output directories; defaults to the OS temp dir. */
  tmpRoot?: string;
}

export interface ReproResult {
  ok: boolean;
  files: number;
  /** Paths only, never file contents. */
  diffs: string[];
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Sorted relative-path -> SHA-256 of file bytes for one output directory. */
export function buildManifest(
  root: string,
  maxFiles = MAX_FILES,
): Map<string, string> {
  const manifest = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort(byName)) {
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        if (manifest.size >= maxFiles) {
          throw new Error(`output has more than ${maxFiles} files`);
        }
        // A same-uid process could swap the entry for a symlink between the
        // readdir and this read. The tree is a fresh 0700 temporary directory,
        // so the residual TOCTOU risk is accepted rather than opening with
        // O_NOFOLLOW, which is also unavailable on some platforms.
        const path = relative(root, absolute).split(sep).join("/");
        const digest = createHash("sha256").update(readFileSync(absolute)).digest("hex");
        manifest.set(path, digest);
      } else {
        throw new Error(`unexpected non-regular output entry: ${relative(root, absolute)}`);
      }
    }
  };
  visit(root);
  return manifest;
}

export function compareManifests(
  first: Map<string, string>,
  second: Map<string, string>,
): string[] {
  const paths = [...new Set([...first.keys(), ...second.keys()])].sort();
  const diffs: string[] = [];
  for (const path of paths) {
    const a = first.get(path);
    const b = second.get(path);
    if (a === undefined) {
      diffs.push(`only in run 2: ${path}`);
    } else if (b === undefined) {
      diffs.push(`only in run 1: ${path}`);
    } else if (a !== b) {
      diffs.push(`content differs: ${path}`);
    }
  }
  return diffs;
}

/**
 * Run the injected build twice into sibling directories and compare manifests.
 * Sibling directories keep the same depth so source-map `sources` relative
 * paths are comparable. The temporary parent is removed in `finally`, which
 * covers normal completion and thrown build/manifest failures. `execFileSync`
 * blocks the event loop and there is no signal handler, so SIGINT/SIGTERM/
 * SIGKILL or a process crash can leave the 0700 `mkdtemp` directory behind.
 */
export function runReproBuild(build: BuildFn, options: ReproOptions): ReproResult {
  const parent = mkdtempSync(join(options.tmpRoot ?? tmpdir(), "corkboard-repro-"));
  const first = join(parent, "one");
  const second = join(parent, "two");
  try {
    build(first, 1);
    build(second, 2);
    const left = buildManifest(first);
    const right = buildManifest(second);
    if (left.size === 0 || right.size === 0) {
      throw new Error("build produced no files; identical empty manifests are not a proof");
    }
    const diffs = compareManifests(left, right);
    return { ok: diffs.length === 0, files: left.size, diffs };
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function main(): void {
  const root = process.cwd();
  const result = (() => {
    try {
      return runReproBuild(
        (outDir) => buildProject(root, outDir, BUILD_TIMEOUT_MS),
        {},
      );
    } catch (error) {
      console.error(
        `build:repro: build or manifest failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exit(2);
    }
  })();

  if (!result.ok) {
    console.error(
      `build:repro: ${result.diffs.length} difference(s) between two builds (paths only):`,
    );
    for (const diff of result.diffs.slice(0, MAX_REPORTED_DIFFS)) {
      console.error(`  ${diff}`);
    }
    if (result.diffs.length > MAX_REPORTED_DIFFS) {
      console.error(`  ... and ${result.diffs.length - MAX_REPORTED_DIFFS} more`);
    }
    process.exit(1);
  }
  console.log(
    `build:repro: two builds produced identical manifests (${result.files} files, sha256)`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
