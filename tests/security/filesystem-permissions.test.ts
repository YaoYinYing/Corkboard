import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { startServer } from "../../src/platforms/node/main.ts";
import {
  requiresPrivateFilesystem,
  verifyPrivateFilesystem,
} from "../../src/storage/permissions.ts";

interface Paths {
  root: string;
  dataDir: string;
  blobDir: string;
  databasePath: string;
}

function setup(t: { after(fn: () => void): void }): Paths {
  const root = mkdtempSync(join(tmpdir(), "corkboard-fs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const blobDir = join(dataDir, "blobs");
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  chmodSync(blobDir, 0o700);
  const databasePath = join(dataDir, "corkboard.sqlite");
  writeFileSync(databasePath, "db", { mode: 0o600 });
  chmodSync(databasePath, 0o600);
  return { root, dataDir, blobDir, databasePath };
}

function check(paths: Paths, production = true): void {
  verifyPrivateFilesystem({ ...paths, production });
}

function key(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64");
}

test("the filesystem verifier accepts a correctly provisioned installation", (t) => {
  const paths = setup(t);
  const blob = join(paths.blobDir, "blob-one");
  writeFileSync(blob, "ciphertext", { mode: 0o600 });
  chmodSync(blob, 0o600);
  assert.doesNotThrow(() => check(paths));
});

test("the filesystem verifier fails closed on wrong directory and file modes", (t) => {
  const paths = setup(t);

  chmodSync(paths.dataDir, 0o755);
  assert.throws(() => check(paths), /data directory must have mode 0700/);
  chmodSync(paths.dataDir, 0o700);

  chmodSync(paths.blobDir, 0o750);
  assert.throws(() => check(paths), /blob directory must have mode 0700/);
  chmodSync(paths.blobDir, 0o700);

  chmodSync(paths.databasePath, 0o644);
  assert.throws(() => check(paths), /database file must have mode 0600/);
  chmodSync(paths.databasePath, 0o600);

  const wal = `${paths.databasePath}-wal`;
  writeFileSync(wal, "wal", { mode: 0o644 });
  chmodSync(wal, 0o644);
  assert.throws(() => check(paths), /database-wal file must have mode 0600/);
  chmodSync(wal, 0o600);

  const blob = join(paths.blobDir, "blob-one");
  writeFileSync(blob, "ciphertext", { mode: 0o644 });
  chmodSync(blob, 0o644);
  assert.throws(() => check(paths), /blob file must have mode 0600/);
});

test("the filesystem verifier rejects symlinked data and blob directories", (t) => {
  const paths = setup(t);
  const linkedData = join(paths.root, "linked-data");
  symlinkSync(paths.dataDir, linkedData, "dir");
  assert.throws(
    () =>
      check({
        ...paths,
        dataDir: linkedData,
      }),
    /data directory must not be a symbolic link/,
  );

  const target = join(paths.root, "blob-target");
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  const linkedBlobs = join(paths.root, "linked-blobs");
  symlinkSync(target, linkedBlobs, "dir");
  assert.throws(
    () =>
      check({
        ...paths,
        blobDir: linkedBlobs,
      }),
    /blob directory must not be a symbolic link/,
  );
});

test("outside production the verifier keeps the existing best-effort behavior", (t) => {
  const paths = setup(t);
  chmodSync(paths.dataDir, 0o755);
  chmodSync(paths.blobDir, 0o755);
  chmodSync(paths.databasePath, 0o644);
  assert.doesNotThrow(() => check(paths, false));
});

test("production mode is selected by NODE_ENV or the explicit opt-in", () => {
  assert.equal(requiresPrivateFilesystem({ NODE_ENV: "production" }), true);
  assert.equal(requiresPrivateFilesystem({ CORKBOARD_REQUIRE_PRIVATE_FS: "1" }), true);
  assert.equal(requiresPrivateFilesystem({ NODE_ENV: "development" }), false);
  assert.equal(requiresPrivateFilesystem({ CORKBOARD_REQUIRE_PRIVATE_FS: "0" }), false);
  assert.equal(requiresPrivateFilesystem({}), false);
});

test("production startup verifies and reports private modes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-fs-start-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const running = await startServer({
    env: {
      NODE_ENV: "production",
      CORKBOARD_DATA_DIR: dataDir,
      CORKBOARD_ROOT_KEY: key(),
      CORKBOARD_CREDENTIAL_PEPPER: key(),
      PORT: "0",
    },
  });
  try {
    assert.equal(statSync(dataDir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, "blobs")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dataDir, "corkboard.sqlite")).mode & 0o777, 0o600);
  } finally {
    await running.close();
  }
});

test("production startup refuses a symlinked data directory", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-fs-symlink-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, "real-data");
  mkdirSync(real, { recursive: true, mode: 0o700 });
  const linked = join(root, "linked-data");
  symlinkSync(real, linked, "dir");

  await assert.rejects(
    startServer({
      env: {
        NODE_ENV: "production",
        CORKBOARD_DATA_DIR: linked,
        CORKBOARD_ROOT_KEY: key(),
        CORKBOARD_CREDENTIAL_PEPPER: key(),
        PORT: "0",
      },
    }),
    /data directory must not be a symbolic link/,
  );
  // Rejected before mkdir/open: the redirect target is untouched.
  assert.deepEqual(readdirSync(real), []);
});

test("the filesystem verifier normalizes trailing separators before checking symlinks", (t) => {
  const paths = setup(t);
  const linkedData = join(paths.root, "linked-data");
  symlinkSync(paths.dataDir, linkedData, "dir");
  for (const suffix of ["/", "/.", "/./"]) {
    assert.throws(
      () => check({ ...paths, dataDir: linkedData + suffix }),
      /data directory must not be a symbolic link/,
    );
  }

  const target = join(paths.root, "blob-target");
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  const linkedBlobs = join(paths.root, "linked-blobs");
  symlinkSync(target, linkedBlobs, "dir");
  for (const suffix of ["/", "/.", "/./"]) {
    assert.throws(
      () => check({ ...paths, blobDir: linkedBlobs + suffix }),
      /blob directory must not be a symbolic link/,
    );
  }
});

test("the filesystem verifier rejects symlinked database and sidecar files", (t) => {
  const paths = setup(t);
  const realDatabase = join(paths.root, "real.sqlite");
  writeFileSync(realDatabase, "database", { mode: 0o600 });
  chmodSync(realDatabase, 0o600);
  unlinkSync(paths.databasePath);
  symlinkSync(realDatabase, paths.databasePath);

  assert.throws(() => check(paths), /database file must not be a symbolic link/);

  unlinkSync(paths.databasePath);
  writeFileSync(paths.databasePath, "database", { mode: 0o600 });
  chmodSync(paths.databasePath, 0o600);
  const realWal = join(paths.root, "real.sqlite-wal");
  writeFileSync(realWal, "wal", { mode: 0o600 });
  chmodSync(realWal, 0o600);
  symlinkSync(realWal, `${paths.databasePath}-wal`);
  assert.throws(() => check(paths), /database-wal file must not be a symbolic link/);
});

test("a rejected production start leaves database symlink targets untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-fs-db-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const target = join(root, "target.sqlite");
  writeFileSync(target, "untouched", { mode: 0o600 });
  chmodSync(target, 0o600);
  symlinkSync(target, join(dataDir, "corkboard.sqlite"));

  await assert.rejects(
    startServer({
      env: {
        NODE_ENV: "production",
        CORKBOARD_DATA_DIR: dataDir,
        CORKBOARD_ROOT_KEY: key(),
        CORKBOARD_CREDENTIAL_PEPPER: key(),
        PORT: "0",
      },
    }),
    /database file must not be a symbolic link/,
  );
  assert.equal(statSync(target).size, "untouched".length);
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.deepEqual(
    readdirSync(dataDir).filter((name) => name.startsWith("corkboard.sqlite")),
    ["corkboard.sqlite"],
  );
});

test("a rejected production start leaves blob symlink targets untouched", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "corkboard-fs-blob-link-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  const target = join(root, "blob-target");
  mkdirSync(target, { mode: 0o700 });
  chmodSync(target, 0o700);
  symlinkSync(target, join(dataDir, "blobs"));

  await assert.rejects(
    startServer({
      env: {
        NODE_ENV: "production",
        CORKBOARD_DATA_DIR: dataDir,
        CORKBOARD_ROOT_KEY: key(),
        CORKBOARD_CREDENTIAL_PEPPER: key(),
        PORT: "0",
      },
    }),
    /blob directory must not be a symbolic link/,
  );
  assert.deepEqual(readdirSync(target), []);
  assert.equal(readdirSync(dataDir).includes("corkboard.sqlite"), false);
});
