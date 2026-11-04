// Read-only operator diagnostics. No repair mode, no migrations, no writes to
// the data or blob directory, and no message content or key material in output.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isValidBlobKey } from "../storage/blobs.ts";
import {
  expectedMigrationVersions,
  expectedSchemaTables,
  openSqliteDatabaseReadOnly,
  type ReadOnlySqlDatabase,
} from "../storage/db.ts";

export type DoctorIssueCode =
  | "SCHEMA_INCOMPLETE"
  | "DATABASE_INTEGRITY_FAILED"
  | "BLOB_MISSING"
  | "BLOB_ORPHANED"
  | "EXPIRED_BLOB_PENDING"
  | "STUCK_PENDING"
  | "KEY_MISSING";

export interface DoctorIssue {
  code: DoctorIssueCode;
  count: number;
}

export interface DoctorReport {
  schema_versions: {
    applied: number[];
    expected: number[];
    missing: number[];
    complete: boolean;
  };
  key_presence: {
    root_key: boolean;
    credential_pepper: boolean;
    root_key_valid: boolean;
    credential_pepper_valid: boolean;
    key_version: "v1";
  };
  database: {
    integrity: string;
    counts: {
      messages: number;
      ready: number;
      pending: number;
      expired: number;
      failed: number;
      receipts: number;
      credentials: number;
      grants: number;
    } | null;
  } | null;
  blobs: {
    files: number;
    referenced: number | null;
    orphaned: number | null;
    missing: number | null;
    expired_pending_deletion: number | null;
    blob_dir_non_files: number;
  };
  provisional: {
    stuck_minutes: number;
    count: number | null;
    samples: Array<{ id: string; age_seconds: number }> | null;
  };
  issues: DoctorIssue[];
}

export interface DoctorOptions {
  dataDir: string;
  stuckMinutes: number;
  now?: () => Date;
  env?: Readonly<Record<string, string | undefined>>;
}

export class DoctorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DoctorError";
  }
}

const KEY_BYTES = 32;
const SAMPLE_LIMIT = 10;

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw new DoctorError("cannot read the data directory");
  }
}

// Mirrors the root-key loader's accepted base64 shape (trim, base64url
// alphabet, optional padding) and checks the decoded length only.
function isBase64Key(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  if (normalized === "") return false;
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) return false;
  return Buffer.from(padded, "base64").length === KEY_BYTES;
}

function keyPresence(
  env: Readonly<Record<string, string | undefined>>,
): DoctorReport["key_presence"] {
  const root = env.CORKBOARD_ROOT_KEY;
  const pepper = env.CORKBOARD_CREDENTIAL_PEPPER;
  return {
    root_key: root !== undefined && root.trim() !== "",
    credential_pepper: pepper !== undefined && pepper.trim() !== "",
    root_key_valid: isBase64Key(root),
    credential_pepper_valid: isBase64Key(pepper),
    key_version: "v1",
  };
}

function mapDatabaseError(error: unknown): DoctorError {
  const message = error instanceof Error ? error.message : "";
  if (/locked|busy/i.test(message)) {
    return new DoctorError("database is busy or locked");
  }
  if (/inconsistent write-ahead log sidecars/.test(message)) {
    return new DoctorError("database has inconsistent write-ahead log sidecars");
  }
  if (/sidecar is not a regular file/.test(message)) {
    return new DoctorError("database sidecar is not a regular file");
  }
  return new DoctorError("cannot read the database read-only");
}

async function count(db: ReadOnlySqlDatabase, table: string): Promise<number> {
  const row = await db.first<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`);
  return Number(row?.n ?? 0);
}

async function inspectDatabase(
  db: ReadOnlySqlDatabase,
  expected: number[],
  expectedTables: readonly string[],
): Promise<{
  schema: DoctorReport["schema_versions"];
  schemaIssueCount: number;
  database: NonNullable<DoctorReport["database"]>;
  blobCrossCheck: {
    referenced: string[];
    expiredPendingDeletion: number;
  } | null;
}> {
  const tables = await db.all<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type = 'table'",
  );
  const present = new Set(tables.map((row) => row.name));
  const missingTables = expectedTables.filter((table) => !present.has(table));

  const applied: number[] = [];
  if (present.has("schema_migrations")) {
    const rows = await db.all<{ version: number }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    applied.push(...rows.map((row) => Number(row.version)));
  }
  const appliedSet = new Set(applied);
  const missing = expected.filter((version) => !appliedSet.has(version));
  const complete = missing.length === 0 && missingTables.length === 0;

  const integrityRows = await db.all<{ integrity_check: string }>(
    "PRAGMA integrity_check",
  );
  const integrity =
    integrityRows.length === 0
      ? "unknown"
      : integrityRows.every((row) => row.integrity_check === "ok")
        ? "ok"
        : integrityRows
            .map((row) => row.integrity_check.replace(/\s*\n\s*/g, "; "))
            .join("; ");

  let counts: NonNullable<DoctorReport["database"]>["counts"] = null;
  let blobCrossCheck: { referenced: string[]; expiredPendingDeletion: number } | null =
    null;

  if (complete) {
    const messageCounts = await db.first<{
      messages: number;
      ready: number;
      pending: number;
      expired: number;
      failed: number;
    }>(
      `SELECT COUNT(*) AS messages,
              COALESCE(SUM(CASE WHEN body_state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
              COALESCE(SUM(CASE WHEN body_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN body_state = 'expired' THEN 1 ELSE 0 END), 0) AS expired,
              COALESCE(SUM(CASE WHEN body_state = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM messages`,
    );
    counts = {
      messages: Number(messageCounts?.messages ?? 0),
      ready: Number(messageCounts?.ready ?? 0),
      pending: Number(messageCounts?.pending ?? 0),
      expired: Number(messageCounts?.expired ?? 0),
      failed: Number(messageCounts?.failed ?? 0),
      receipts: await count(db, "message_receipts"),
      credentials: await count(db, "credentials"),
      grants: await count(db, "credential_project_grants"),
    };

    // Internal only: the full key set is needed for exact missing/orphan counts,
    // but keys are never printed. Output remains counts plus bounded samples.
    const referencedRows = await db.all<{ storage_key: string }>(
      "SELECT storage_key FROM body_objects WHERE storage_key IS NOT NULL",
    );
    const pendingDeletion = await db.first<{ n: number }>(
      `SELECT COUNT(*) AS n
         FROM messages m
         JOIN body_objects b ON b.id = m.body_object_id
        WHERE m.body_state = 'expired'
          AND (b.state IS NULL OR b.state <> 'deleted')`,
    );
    blobCrossCheck = {
      referenced: referencedRows.map((row) => row.storage_key),
      expiredPendingDeletion: Number(pendingDeletion?.n ?? 0),
    };
  }

  return {
    schema: { applied, expected, missing, complete },
    schemaIssueCount: missing.length + missingTables.length,
    database: { integrity, counts },
    blobCrossCheck,
  };
}

function inspectBlobs(
  dataDir: string,
  referenced: string[] | null,
  expiredPendingDeletion: number | null,
): {
  blobs: DoctorReport["blobs"];
  orphaned: number | null;
  missing: number | null;
} {
  const blobDir = join(dataDir, "blobs");
  const blobEntry = lstatOrUndefined(blobDir);
  let files = 0;
  let nonFiles = 0;
  const diskKeys = new Set<string>();
  const referencedCount = referenced === null ? null : referenced.length;

  if (blobEntry === undefined) {
    // No blob directory yet: nothing on disk to reconcile.
  } else if (blobEntry.isDirectory()) {
    let entries;
    try {
      entries = readdirSync(blobDir, { withFileTypes: true });
    } catch {
      throw new DoctorError("cannot read the data directory");
    }
    for (const entry of entries) {
      if (!entry.isFile()) {
        // Directories, symlinks, and special files are never followed.
        nonFiles += 1;
      } else if (isValidBlobKey(entry.name)) {
        files += 1;
        diskKeys.add(entry.name);
      }
      // A regular file with an invalid name is ignored: it is not a stored
      // opaque blob key.
    }
  } else {
    // A symlinked or non-directory `blobs` path is not traversed.
    nonFiles = 1;
  }

  let orphaned: number | null = null;
  let missing: number | null = null;
  if (referenced !== null) {
    const referencedSet = new Set(referenced);
    orphaned = 0;
    for (const key of diskKeys) {
      if (!referencedSet.has(key)) orphaned += 1;
    }
    missing = 0;
    for (const key of referencedSet) {
      if (!diskKeys.has(key)) missing += 1;
    }
  }

  return {
    blobs: {
      files,
      referenced: referencedCount,
      orphaned,
      missing,
      expired_pending_deletion: expiredPendingDeletion,
      blob_dir_non_files: nonFiles,
    },
    orphaned,
    missing,
  };
}

async function inspectProvisional(
  db: ReadOnlySqlDatabase,
  stuckMinutes: number,
  now: Date,
): Promise<DoctorReport["provisional"]> {
  const threshold = new Date(now.getTime() - stuckMinutes * 60_000).toISOString();
  const row = await db.first<{ n: number }>(
    `SELECT COUNT(*) AS n
       FROM messages
      WHERE body_state = 'pending' AND received_at < ?`,
    [threshold],
  );
  const samples = await db.all<{ id: string; received_at: string }>(
    `SELECT id, received_at
       FROM messages
      WHERE body_state = 'pending' AND received_at < ?
      ORDER BY received_at ASC
      LIMIT ${SAMPLE_LIMIT}`,
    [threshold],
  );
  return {
    stuck_minutes: stuckMinutes,
    count: Number(row?.n ?? 0),
    samples: samples.map((sample) => {
      const parsed = Date.parse(sample.received_at);
      return {
        id: sample.id,
        age_seconds: Number.isFinite(parsed)
          ? Math.max(0, Math.floor((now.getTime() - parsed) / 1000))
          : 0,
      };
    }),
  };
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const now = options.now?.() ?? new Date();
  const expected = expectedMigrationVersions();
  const expectedTables = expectedSchemaTables();
  const key = keyPresence(env);

  let db: ReadOnlySqlDatabase | undefined;
  let schema: DoctorReport["schema_versions"] = {
    applied: [],
    expected,
    missing: [...expected],
    complete: false,
  };
  let database: DoctorReport["database"] = null;
  let blobCrossCheck: { referenced: string[]; expiredPendingDeletion: number } | null =
    null;
  let provisional: DoctorReport["provisional"] = {
    stuck_minutes: options.stuckMinutes,
    count: null,
    samples: null,
  };
  let schemaIssueCount = expected.length;

  const dataDirEntry = lstatOrUndefined(options.dataDir);
  if (dataDirEntry !== undefined && !dataDirEntry.isDirectory()) {
    throw new DoctorError("data directory is not a directory");
  }
  const databasePath = join(options.dataDir, "corkboard.sqlite");
  const databaseEntry = lstatOrUndefined(databasePath);

  if (databaseEntry !== undefined) {
    if (!databaseEntry.isFile()) {
      throw new DoctorError("database file is not a regular file");
    }
    try {
      db = await openSqliteDatabaseReadOnly(databasePath);
    } catch (error) {
      throw mapDatabaseError(error);
    }
    try {
      const inspected = await inspectDatabase(db, expected, expectedTables);
      schema = inspected.schema;
      schemaIssueCount = inspected.schemaIssueCount;
      database = inspected.database;
      blobCrossCheck = inspected.blobCrossCheck;
      if (inspected.schema.complete) {
        provisional = await inspectProvisional(db, options.stuckMinutes, now);
      } else {
        provisional = { stuck_minutes: options.stuckMinutes, count: null, samples: null };
      }
    } catch (error) {
      throw mapDatabaseError(error);
    } finally {
      db.close();
    }
  }

  const blobInspection = inspectBlobs(
    options.dataDir,
    blobCrossCheck?.referenced ?? null,
    blobCrossCheck?.expiredPendingDeletion ?? null,
  );

  const integrityFailed =
    database !== null && database.integrity !== "ok" ? 1 : 0;
  const keyMissing =
    (key.root_key && key.root_key_valid ? 0 : 1) +
    (key.credential_pepper && key.credential_pepper_valid ? 0 : 1);

  const issues: DoctorIssue[] = [];
  if (!schema.complete) issues.push({ code: "SCHEMA_INCOMPLETE", count: Math.max(1, schemaIssueCount) });
  if (integrityFailed > 0) {
    issues.push({ code: "DATABASE_INTEGRITY_FAILED", count: integrityFailed });
  }
  if ((blobInspection.missing ?? 0) > 0) {
    issues.push({ code: "BLOB_MISSING", count: blobInspection.missing ?? 0 });
  }
  if ((blobInspection.orphaned ?? 0) > 0) {
    issues.push({ code: "BLOB_ORPHANED", count: blobInspection.orphaned ?? 0 });
  }
  if ((blobInspection.blobs.expired_pending_deletion ?? 0) > 0) {
    issues.push({
      code: "EXPIRED_BLOB_PENDING",
      count: blobInspection.blobs.expired_pending_deletion ?? 0,
    });
  }
  if (provisional.count !== null && provisional.count > 0) {
    issues.push({ code: "STUCK_PENDING", count: provisional.count });
  }
  if (keyMissing > 0) issues.push({ code: "KEY_MISSING", count: keyMissing });

  return {
    schema_versions: schema,
    key_presence: key,
    database,
    blobs: blobInspection.blobs,
    provisional,
    issues,
  };
}

export function formatDoctorReport(report: DoctorReport): string[] {
  const lines: string[] = [];
  const applied = report.schema_versions.applied.join(",") || "none";
  const expected = report.schema_versions.expected.join(",") || "none";
  const missing = report.schema_versions.missing.join(",") || "none";
  lines.push(
    `schema: applied ${applied}; expected ${expected}; missing ${missing}; ${report.schema_versions.complete ? "complete" : "incomplete"}`,
  );

  const key = report.key_presence;
  lines.push(
    `keys: root_key ${key.root_key ? "set" : "missing"} (${key.root_key_valid ? "valid" : "invalid"}), ` +
      `credential_pepper ${key.credential_pepper ? "set" : "missing"} (${key.credential_pepper_valid ? "valid" : "invalid"}), ` +
      `key_version ${key.key_version}`,
  );

  if (report.database === null) {
    lines.push("database: absent (not initialized)");
  } else {
    lines.push(`database: integrity ${report.database.integrity}`);
    if (report.database.counts === null) {
      lines.push("counts: unavailable (schema incomplete)");
    } else {
      const c = report.database.counts;
      lines.push(
        `counts: messages ${c.messages} (ready ${c.ready}, pending ${c.pending}, expired ${c.expired}, failed ${c.failed}); ` +
          `receipts ${c.receipts}; credentials ${c.credentials}; grants ${c.grants}`,
      );
    }
  }

  const b = report.blobs;
  lines.push(
    `blobs: files ${b.files}; referenced ${b.referenced ?? "n/a"}; ` +
      `orphaned ${b.orphaned ?? "n/a"}; missing ${b.missing ?? "n/a"}; ` +
      `expired_pending_deletion ${b.expired_pending_deletion ?? "n/a"}; blob_dir_non_files ${b.blob_dir_non_files}`,
  );
  const samples = report.provisional.samples;
  lines.push(
    `provisional: ${report.provisional.count ?? "n/a"} pending older than ${report.provisional.stuck_minutes} minutes` +
      (samples === null || samples.length === 0
        ? ""
        : `; sample ${samples
            .map((sample) => `${sample.id} (${sample.age_seconds}s)`)
            .join(", ")}`),
  );
  lines.push(
    report.issues.length === 0
      ? "issues: none"
      : `issues: ${report.issues.map((issue) => `${issue.code}(${issue.count})`).join(", ")}`,
  );
  return lines;
}
