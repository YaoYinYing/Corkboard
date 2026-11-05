// Sanitized security audit events shared by the session and OAuth services.
// Audit rows are metadata, never authority. Writes are deliberately fail-open:
// an audit sink failure must not change an external response or an
// authorization decision, and the caught error is never logged because it may
// carry bound parameters.
import type { SqlDatabase } from "../storage/db.ts";

export type AuditOutcome = "success" | "failure" | "denied" | "detected";

export interface AuditEventInput {
  operation: string;
  outcome: AuditOutcome;
  actorAccountId?: string | null;
  actorSpeakerId?: string | null;
  projectId?: string | null;
  requestId?: string | null;
  /**
   * Identifiers, enumerations, and scope lists only. Values are bounded by
   * `boundAuditDetail`; callers must never pass tokens, codes, cookies, CSRF
   * values, credentials, email addresses, bodies, or raw IPs.
   */
  detail?: Record<string, unknown> | null;
}

export interface AuditDeps {
  db: SqlDatabase;
  now: () => Date;
}

// Total serialized `detail` cap. Authentication/OAuth events stay far below it;
// an unexpectedly large document is dropped rather than truncated (truncating
// would produce invalid JSON).
export const MAX_AUDIT_DETAIL_CHARS = 2048;
const MAX_AUDIT_STRING = 200;
const MAX_AUDIT_ARRAY = 32;
const MAX_OPERATION_CHARS = 64;

function randomAuditId(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `evt_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

function boundAuditValue(value: unknown): unknown {
  if (typeof value === "string") return value.slice(0, MAX_AUDIT_STRING);
  if (Array.isArray(value)) return value.slice(0, MAX_AUDIT_ARRAY).map(boundAuditValue);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === null
  ) {
    return value;
  }
  return "[omitted]";
}

// Bounded by construction: every string and array element is capped, and the
// whole document is dropped if it still exceeds the total cap.
export function boundAuditDetail(
  detail: Record<string, unknown> | null | undefined,
): string | null {
  if (detail === null || detail === undefined) return null;
  const bounded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === undefined) continue;
    bounded[key] = boundAuditValue(value);
  }
  const json = JSON.stringify(bounded);
  return json.length > MAX_AUDIT_DETAIL_CHARS ? null : json;
}

// Random event ids are intentional: every event is a distinct action and a
// retry is a new attempt recorded separately. Only deterministic, reconcilable
// transitions (message expiry) use INSERT OR IGNORE with a derived id.
export async function writeAudit(deps: AuditDeps, event: AuditEventInput): Promise<void> {
  try {
    await deps.db.run(
      `INSERT INTO audit_events
         (id, actor_account_id, actor_speaker_id, project_id, operation,
          outcome, request_id, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        randomAuditId(),
        event.actorAccountId ?? null,
        event.actorSpeakerId ?? null,
        event.projectId ?? null,
        event.operation.slice(0, MAX_OPERATION_CHARS),
        event.outcome,
        event.requestId ?? null,
        boundAuditDetail(event.detail),
        deps.now().toISOString(),
      ],
    );
  } catch {
    // Fail-open. Do not log the error or its parameters.
  }
}
