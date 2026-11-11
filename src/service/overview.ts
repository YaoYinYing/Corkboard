// Authorized service overview for a signed-in account. Every number is derived
// from the same project set the dashboard project list already authorizes
// (`listProjects` with the session account principal), so this module adds no
// authorization rule and no cross-tenant aggregate. Traffic and error summaries
// have no per-tenant source in the current schema and are deliberately absent.
import { AppError } from "../domain/errors.ts";
import type { Principal, ServiceDeps } from "./auth.ts";
import { listProjects } from "./projects.ts";
import { credentialState, type CredentialState } from "./speakers.ts";

// The dashboard project list is bounded to the API maximum (100). The overview
// uses the same bound and reports truncation rather than widening the query.
export const OVERVIEW_PROJECT_LIMIT = 100;
export const OVERVIEW_EVENT_LIMIT = 20;
// D1 allows at most 100 bound parameters per query. Keep each audit chunk well
// below it, and keep the row cap as a SQL literal (not a bound parameter).
export const OVERVIEW_AUDIT_PROJECT_CHUNK = 49;
// One extra row distinguishes "exactly at the cap" from "more exist".
export const OVERVIEW_CREDENTIAL_LIMIT = 1000;

export interface OverviewMessageCounts {
  ready: number;
  pending: number;
  expired: number;
}

export interface OverviewProject {
  id: string;
  title: string;
  messages: OverviewMessageCounts;
  /** Stored ciphertext bytes from `body_objects` metadata, excluding deleted blobs. */
  storageBytes: number;
}

export interface OverviewAuditEvent {
  createdAt: string;
  operation: string;
  outcome: string;
  /** Only an authorized project is shown; otherwise `null`. */
  projectId: string | null;
}

export interface AccountOverview {
  projects: OverviewProject[];
  /** True when more readable projects exist beyond the first 100. */
  projectsTruncated: boolean;
  totals: OverviewMessageCounts & { storageBytes: number };
  credentials: Record<CredentialState, number>;
  /** True when the account has more than the scanned credential limit. */
  credentialsTruncated: boolean;
  auditEvents: OverviewAuditEvent[];
}

function requireSessionAccount(principal: Principal): string {
  if (principal.sessionViewer !== true) throw new AppError("FORBIDDEN");
  return principal.accountId;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

export async function getAccountOverview(
  deps: ServiceDeps,
  principal: Principal,
): Promise<AccountOverview> {
  const accountId = requireSessionAccount(principal);
  const listed = await listProjects(deps, principal, { limit: OVERVIEW_PROJECT_LIMIT });
  const projects = listed.projects;
  const projectIds = projects.map((project) => project.id);
  const visibleProjectIds = new Set(projectIds);

  const countsByProject = new Map<string, OverviewMessageCounts>();
  const storageByProject = new Map<string, number>();
  if (projectIds.length > 0) {
    const list = placeholders(projectIds.length);
    // One bounded aggregate per table, scoped to the authorized project IDs.
    // Counts mirror `getProjectStats`: ready/expired require a committed `seq`;
    // pending is the provisional `seq IS NULL` row.
    const countRows = await deps.db.all<{
      project_id: string;
      ready: number | null;
      pending: number | null;
      expired: number | null;
    }>(
      `SELECT project_id,
              COALESCE(SUM(CASE WHEN seq IS NOT NULL AND body_state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
              COALESCE(SUM(CASE WHEN seq IS NULL AND body_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN seq IS NOT NULL AND body_state = 'expired' THEN 1 ELSE 0 END), 0) AS expired
         FROM messages
        WHERE project_id IN (${list})
        GROUP BY project_id`,
      projectIds,
    );
    for (const row of countRows) {
      countsByProject.set(row.project_id, {
        ready: Number(row.ready ?? 0),
        pending: Number(row.pending ?? 0),
        expired: Number(row.expired ?? 0),
      });
    }

    // `storage_key IS NULL` marks a deleted blob (expiry), so only live stored
    // ciphertext counts. The message join excludes a dangling
    // reference-before-write row (failed put or crash before the write): it has
    // metadata but no message and no stored ciphertext. Both length columns
    // come from the stored metadata.
    const storageRows = await deps.db.all<{ project_id: string; bytes: number | null }>(
      `SELECT b.project_id, COALESCE(SUM(b.cipher_length), 0) AS bytes
         FROM body_objects b
         JOIN messages m ON m.body_object_id = b.id
        WHERE b.project_id IN (${list}) AND b.storage_key IS NOT NULL
        GROUP BY b.project_id`,
      projectIds,
    );
    for (const row of storageRows) {
      storageByProject.set(row.project_id, Number(row.bytes ?? 0));
    }
  }

  const overviewProjects = projects.map((project) => ({
    id: project.id,
    title: project.title,
    messages:
      countsByProject.get(project.id) ?? { ready: 0, pending: 0, expired: 0 },
    storageBytes: storageByProject.get(project.id) ?? 0,
  }));
  const totals = overviewProjects.reduce(
    (sum, project) => ({
      ready: sum.ready + project.messages.ready,
      pending: sum.pending + project.messages.pending,
      expired: sum.expired + project.messages.expired,
      storageBytes: sum.storageBytes + project.storageBytes,
    }),
    { ready: 0, pending: 0, expired: 0, storageBytes: 0 },
  );

  // Credential state counts for speakers owned by this account, reusing the
  // exact derivation used by the credential inventory. Inactive speakers are
  // included, matching that inventory; the owning account must be active. The
  // scan is hard-bounded; when the cap is exceeded the page reports that the
  // counts are incomplete instead of presenting a silent undercount.
  const credentialRows = await deps.db.all<{
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    `SELECT c.expires_at, c.revoked_at
       FROM credentials c
       JOIN speakers s ON s.id = c.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE s.owner_account_id = ? AND a.status = 'active'
      ORDER BY c.created_at ASC, c.id ASC
      LIMIT ${OVERVIEW_CREDENTIAL_LIMIT + 1}`,
    [accountId],
  );
  const credentialsTruncated = credentialRows.length > OVERVIEW_CREDENTIAL_LIMIT;
  const nowMs = deps.now().getTime();
  const credentials: Record<CredentialState, number> = {
    active: 0,
    expired: 0,
    revoked: 0,
    unknown: 0,
  };
  for (const row of credentialRows.slice(0, OVERVIEW_CREDENTIAL_LIMIT)) {
    credentials[credentialState(row.revoked_at, row.expires_at, nowMs)] += 1;
  }

  // Event scope: the account's own audit rows plus rows for its authorized
  // projects. Only non-secret columns are selected; `detail` is never read.
  // D1 caps bound parameters per query, so the project predicate is chunked and
  // the row cap is a SQL literal. Results are merged, deduplicated by event id
  // (an account-actored project row can match both queries), and re-sorted.
  interface AuditRow {
    id: string;
    created_at: string;
    operation: string | null;
    outcome: string | null;
    project_id: string | null;
  }
  const auditRows = new Map<string, AuditRow>();
  const collectAuditRows = (rows: readonly AuditRow[]): void => {
    for (const row of rows) {
      if (!auditRows.has(row.id)) auditRows.set(row.id, row);
    }
  };
  collectAuditRows(
    await deps.db.all<AuditRow>(
      `SELECT id, created_at, operation, outcome, project_id
         FROM audit_events
        WHERE actor_account_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ${OVERVIEW_EVENT_LIMIT}`,
      [accountId],
    ),
  );
  for (let offset = 0; offset < projectIds.length; offset += OVERVIEW_AUDIT_PROJECT_CHUNK) {
    const chunk = projectIds.slice(offset, offset + OVERVIEW_AUDIT_PROJECT_CHUNK);
    collectAuditRows(
      await deps.db.all<AuditRow>(
        `SELECT id, created_at, operation, outcome, project_id
           FROM audit_events
          WHERE project_id IN (${placeholders(chunk.length)})
          ORDER BY created_at DESC, id DESC
          LIMIT ${OVERVIEW_EVENT_LIMIT}`,
        chunk,
      ),
    );
  }
  // Plain code-point comparison keeps ordering deterministic across runtimes.
  const mergedAudit = [...auditRows.values()].sort((left, right) => {
    if (left.created_at !== right.created_at) {
      return left.created_at < right.created_at ? 1 : -1;
    }
    if (left.id === right.id) return 0;
    return left.id < right.id ? 1 : -1;
  });
  const auditEvents = mergedAudit.slice(0, OVERVIEW_EVENT_LIMIT).map((row) => ({
    createdAt: row.created_at,
    operation: row.operation ?? "",
    outcome: row.outcome ?? "",
    // A row owned by the account may carry an id this page did not authorize;
    // never render it.
    projectId:
      row.project_id !== null && visibleProjectIds.has(row.project_id)
        ? row.project_id
        : null,
  }));

  return {
    projects: overviewProjects,
    projectsTruncated: listed.next_cursor !== null,
    totals,
    credentials,
    credentialsTruncated,
    auditEvents,
  };
}
