import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { MetricsRegistry } from "../../src/app/metrics.ts";
import { inMemoryKeyProvider } from "../../src/crypto/keys.ts";
import type { ServiceDeps } from "../../src/service/auth.ts";
import type { BlobStore } from "../../src/storage/blobs.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";
import { openSqliteDatabase } from "../../src/storage/db.ts";

type App = (request: Request) => Promise<Response>;

interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
}

function call(app: App, path: string, options: CallOptions = {}): Promise<Response> {
  return app(
    new Request(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers: options.headers ?? {},
    }),
  );
}

function assertHardeningHeaders(response: Response): void {
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
}

interface Harness {
  app: App;
  db: ServiceDeps["db"] & { close(): void };
  dir: string;
}

// A real SQLite database under a temporary directory; only the blob backend
// varies per test.
async function withApp(
  t: { after(fn: () => void): void },
  buildBlobs: (dir: string) => BlobStore = () => new MemoryBlobStore(),
  metrics?: MetricsRegistry,
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), "corkboard-readyz-"));
  const db = await openSqliteDatabase(join(dir, "corkboard.sqlite"));
  const deps: ServiceDeps = {
    db,
    blobs: buildBlobs(dir),
    keys: await inMemoryKeyProvider(crypto.getRandomValues(new Uint8Array(32))),
    pepper: crypto.getRandomValues(new Uint8Array(32)),
    serviceId: "svc_test",
    now: () => new Date(),
  };
  t.after(() => {
    try {
      db.close();
    } catch {
      // A test may already have closed it to exercise the unavailable path.
    }
    rmSync(dir, { recursive: true, force: true });
  });
  return { app: createApp(deps, metrics === undefined ? {} : { metrics }), db, dir };
}

test("readyz is public, minimal, uncached, and ready with an in-memory blob store", async (t) => {
  const { app } = await withApp(t);
  const response = await call(app, "/readyz");
  assert.equal(response.status, 200);
  assertHardeningHeaders(response);
  assert.equal(await response.text(), '{"status":"ready"}');
});

test("readyz reports unavailable with a minimal body when SQLite is closed", async (t) => {
  const { app, db, dir } = await withApp(t);
  db.close();

  const response = await call(app, "/readyz");
  assert.equal(response.status, 503);
  assertHardeningHeaders(response);
  const text = await response.text();
  assert.equal(text, '{"status":"unavailable"}');
  for (const forbidden of [dir, "corkboard.sqlite", "SELECT", "database is not open"]) {
    assert.equal(text.includes(forbidden), false);
  }
});

test("readyz reports unavailable when the local blob directory is missing", async (t) => {
  const { app, dir } = await withApp(t, (base) => new LocalBlobStore(join(base, "missing-blobs")));

  const response = await call(app, "/readyz");
  assert.equal(response.status, 503);
  assertHardeningHeaders(response);
  const text = await response.text();
  assert.equal(text, '{"status":"unavailable"}');
  for (const forbidden of [dir, "missing-blobs", "ENOENT", "blob"]) {
    assert.equal(text.includes(forbidden), false);
  }
  // The probe must not recreate the directory it just reported missing.
  assert.equal(existsSync(join(dir, "missing-blobs")), false);
});

test("readyz reports unavailable when the blob path is not a directory", async (t) => {
  const { app } = await withApp(t, (base) => {
    const path = join(base, "blob-file");
    writeFileSync(path, "not a directory");
    return new LocalBlobStore(path);
  });

  const response = await call(app, "/readyz");
  assert.equal(response.status, 503);
  assert.equal(await response.text(), '{"status":"unavailable"}');
});

test("readyz reports ready with an existing local blob directory", async (t) => {
  const { app } = await withApp(t, (base) => {
    const path = join(base, "blobs");
    mkdirSync(path);
    return new LocalBlobStore(path);
  });

  const response = await call(app, "/readyz");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"status":"ready"}');
});

test("readyz is unauthenticated, creates no session or audit rows, and is not an API route", async (t) => {
  const { app, db } = await withApp(t);
  const count = async (table: "sessions" | "audit_events"): Promise<number> =>
    Number((await db.first<{ total: number }>(`SELECT COUNT(*) AS total FROM ${table}`))?.total);

  const sessionsBefore = await count("sessions");
  const auditsBefore = await count("audit_events");

  const response = await call(app, "/readyz", {
    headers: { authorization: "Bearer cb_" + "A".repeat(43) },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"status":"ready"}');

  assert.equal(await count("sessions"), sessionsBefore);
  assert.equal(await count("audit_events"), auditsBefore);

  // Same method behavior as /healthz (GET only) and no API/project routing.
  assert.equal((await call(app, "/readyz/extra")).status, 404);
  const post = await call(app, "/readyz", { method: "POST" });
  const head = await call(app, "/readyz", { method: "HEAD" });
  const healthHead = await call(app, "/healthz", { method: "HEAD" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET");
  assert.equal(head.status, healthHead.status);
  assert.equal(head.headers.get("allow"), healthHead.headers.get("allow"));
});

test("metrics keep readyz as its own route label", async (t) => {
  const metrics = new MetricsRegistry();
  const { app } = await withApp(t, undefined, metrics);

  assert.equal((await call(app, "/readyz")).status, 200);
  assert.deepEqual(metrics.snapshot().routes, [{ route: "/readyz", count: 1 }]);
});
