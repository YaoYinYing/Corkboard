// Project enumeration shared by REST and MCP, plus the dashboard's project
// metadata create/edit. Membership, credential grant, and scope checks are
// identical to every other project-scoped path; the only difference is the
// transport that renders the result.
import { randomBase64url } from "../auth/credentials.ts";
import { SCOPES } from "../domain/authz.ts";
import { AppError } from "../domain/errors.ts";
import { validateProjectSummary, validateProjectTitle } from "../domain/validation.ts";
import {
  authorizeProject,
  parseScopeJson,
  type Principal,
  type ServiceDeps,
} from "./auth.ts";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

export interface ProjectSummary {
  id: string;
  title: string;
  summary: string | null;
  status: string;
  created_at: string;
  /**
   * The deterministic eligible owned speaker for a human-session listing.
   * Bearer listings omit it because the principal already names one speaker.
   */
  member_display_name?: string | null;
}

export interface ProjectListResult {
  projects: ProjectSummary[];
  next_cursor: string | null;
}

interface ProjectRow extends ProjectSummary {
  updated_at: string | null;
}

interface SessionProjectRow extends ProjectRow {
  speaker_id: string;
  display_name: string | null;
  capabilities: string;
}

interface ProjectCursor {
  createdAt: string;
  id: string;
}

function encodeCursor(createdAt: string, id: string): string {
  return btoa(JSON.stringify({ created_at: createdAt, id }))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decodeCursor(value: string): ProjectCursor {
  let parsed: unknown;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    parsed = JSON.parse(atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=")));
  } catch {
    throw new AppError("VALIDATION_ERROR", "Invalid cursor");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new AppError("VALIDATION_ERROR", "Invalid cursor");
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.created_at !== "string" || typeof record.id !== "string") {
    throw new AppError("VALIDATION_ERROR", "Invalid cursor");
  }
  return { createdAt: record.created_at, id: record.id };
}

export interface ListProjectsOptions {
  cursor?: string | null;
  limit?: number;
}

function normalizeOptions(options: ListProjectsOptions): {
  limit: number;
  cursor: ProjectCursor | null;
} {
  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError("VALIDATION_ERROR", "limit must be 1-100");
  }
  const rawCursor = options.cursor ?? null;
  return {
    limit,
    cursor: rawCursor === null || rawCursor === "" ? null : decodeCursor(rawCursor),
  };
}

// A human session lists every project where at least one owned speaker has an
// active membership granting `project.read`. Capabilities are parsed with the
// same parser as `resolveSessionViewer`; a substring match would list a project
// whose timeline then 404s. One row per project; the member display name comes
// from the same deterministic speaker ordering used per project.
async function listSessionProjects(
  deps: ServiceDeps,
  accountId: string,
  options: ListProjectsOptions,
): Promise<ProjectListResult> {
  const { limit, cursor } = normalizeOptions(options);

  // Bounded by the account's own membership rows. Filtering in JS keeps the
  // SQLite/D1 SQL free of JSON functions and cannot admit an unparsable value.
  const rows = await deps.db.all<SessionProjectRow>(
    `SELECT p.id, p.title, p.summary, p.status, p.created_at, p.updated_at,
            s.id AS speaker_id, s.display_name, m.capabilities
       FROM projects p
       JOIN project_memberships m ON m.project_id = p.id
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE s.owner_account_id = ? AND m.removed_at IS NULL
        AND p.status = 'active' AND s.status = 'active' AND a.status = 'active'
      ORDER BY p.created_at ASC, p.id ASC, s.created_at ASC, s.id ASC`,
    [accountId],
  );

  const projects: ProjectRow[] = [];
  const memberNames = new Map<string, string | null>();
  for (const row of rows) {
    if (!parseScopeJson(row.capabilities).has("project.read")) continue;
    if (memberNames.has(row.id)) continue;
    projects.push({
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
    memberNames.set(row.id, row.display_name);
  }

  const afterCursor =
    cursor === null
      ? projects
      : projects.filter(
          (project) =>
            project.created_at > cursor.createdAt ||
            (project.created_at === cursor.createdAt && project.id > cursor.id),
        );
  const page = afterCursor.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    afterCursor.length > limit && last !== undefined
      ? encodeCursor(last.created_at, last.id)
      : null;

  return {
    projects: page.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      created_at: row.created_at,
      member_display_name: memberNames.get(row.id) ?? null,
    })),
    next_cursor: nextCursor,
  };
}

export interface ProjectStats {
  projectId: string;
  messages: {
    /** Committed messages whose body is readable. */
    ready: number;
    /** Provisional rows awaiting finalization (`seq IS NULL`). */
    pending: number;
    /** Retained metadata tombstones after body expiry. */
    expired: number;
  };
  /**
   * Committed (ready or expired) messages with no receipt for the calling
   * speaker, matching the list endpoint's `unread` filter.
   */
  unread: number;
}

// Authorized per-project counts. Authorization is the same `project.read`
// decision as project detail: an unknown project and a project the caller is
// not a member of are the same NOT_FOUND, so the endpoint cannot enumerate
// project existence. Counting is project-scoped and parameterized; the only
// per-viewer value is `unread`, derived from the authenticated speaker.
export async function getProjectStats(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<ProjectStats> {
  await authorizeProject(deps, principal, projectId, "project.read");

  const counts = await deps.db.first<{
    ready: number | null;
    pending: number | null;
    expired: number | null;
  }>(
    `SELECT
       COALESCE(SUM(CASE WHEN seq IS NOT NULL AND body_state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
       COALESCE(SUM(CASE WHEN seq IS NULL AND body_state = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
       COALESCE(SUM(CASE WHEN seq IS NOT NULL AND body_state = 'expired' THEN 1 ELSE 0 END), 0) AS expired
       FROM messages
      WHERE project_id = ?`,
    [projectId],
  );
  const unread = await deps.db.first<{ unread: number | null }>(
    `SELECT COUNT(*) AS unread
       FROM messages m
      WHERE m.project_id = ? AND m.seq IS NOT NULL
        AND m.body_state IN ('ready', 'expired')
        AND NOT EXISTS (
          SELECT 1 FROM message_receipts r
           WHERE r.message_id = m.id AND r.speaker_id = ?)`,
    [projectId, principal.speakerId],
  );

  return {
    projectId,
    messages: {
      ready: Number(counts?.ready ?? 0),
      pending: Number(counts?.pending ?? 0),
      expired: Number(counts?.expired ?? 0),
    },
    unread: Number(unread?.unread ?? 0),
  };
}

export interface ProjectInput {
  title: string;
  summary: string | null;
}

export interface ProjectEditView {
  id: string;
  title: string;
  summary: string | null;
}

// Dashboard creation is an account operation. The account must be active and
// own an active speaker; that deterministic first speaker (the same ordering as
// `resolveSessionViewer`) receives the owner membership, because the dashboard
// lists and authorizes projects only through memberships. No speaker or
// credential is created, and no credential grant is inferred.
export async function createProject(
  deps: ServiceDeps,
  principal: Principal,
  input: ProjectInput,
): Promise<ProjectSummary> {
  if (principal.sessionViewer !== true) throw new AppError("FORBIDDEN");
  const title = validateProjectTitle(input.title);
  const summary = validateProjectSummary(input.summary);

  const account = await deps.db.first<{ status: string }>(
    "SELECT status FROM accounts WHERE id = ?",
    [principal.accountId],
  );
  if (account === undefined || account.status !== "active") {
    throw new AppError("FORBIDDEN");
  }
  const speaker = await deps.db.first<{ id: string }>(
    `SELECT id FROM speakers
      WHERE owner_account_id = ? AND status = 'active'
      ORDER BY created_at ASC, id ASC
      LIMIT 1`,
    [principal.accountId],
  );
  if (speaker === undefined) {
    throw new AppError("VALIDATION_ERROR", "an active owned speaker is required");
  }

  const id = `proj_${randomBase64url(16)}`;
  const now = deps.now().toISOString();
  // One transaction: a failure from either insert (or a crash before commit)
  // leaves neither row, so this create path never leaves an active project
  // without the owner membership that makes it reachable and editable.
  await deps.db.transaction(async (tx) => {
    await tx.run(
      `INSERT INTO projects (id, owner_account_id, title, summary, status, next_seq, created_at)
       VALUES (?, ?, ?, ?, 'active', 0, ?)`,
      [id, principal.accountId, title, summary, now],
    );
    await tx.run(
      `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
       VALUES (?, ?, ?, ?)`,
      [id, speaker.id, JSON.stringify(SCOPES), now],
    );
  });

  return { id, title, summary, status: "active", created_at: now };
}

// The edit form reads through the same `project.edit` authorization as the
// update. A member without the owner capability, a foreign project, and an
// unknown project are all NOT_FOUND.
export async function getProjectForEdit(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<ProjectEditView> {
  await authorizeProject(deps, principal, projectId, "project.edit");
  const row = await deps.db.first<ProjectEditView>(
    "SELECT id, title, summary FROM projects WHERE id = ? AND status = 'active'",
    [projectId],
  );
  if (row === undefined) throw new AppError("NOT_FOUND");
  return row;
}

export async function updateProject(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  input: ProjectInput,
): Promise<ProjectEditView> {
  // Authorization precedes validation so a denied caller cannot probe input.
  await authorizeProject(deps, principal, projectId, "project.edit");
  const title = validateProjectTitle(input.title);
  const summary = validateProjectSummary(input.summary);
  const result = await deps.db.run(
    `UPDATE projects SET title = ?, summary = ?, updated_at = ?
      WHERE id = ? AND status = 'active'`,
    [title, summary, deps.now().toISOString(), projectId],
  );
  if (result.changes === 0) throw new AppError("NOT_FOUND");
  return { id: projectId, title, summary };
}

export async function listProjects(
  deps: ServiceDeps,
  principal: Principal,
  options: ListProjectsOptions = {},
): Promise<ProjectListResult> {
  if (principal.sessionViewer === true) {
    return listSessionProjects(deps, principal.accountId, options);
  }
  if (!principal.scopes.has("project.read")) throw new AppError("FORBIDDEN");

  const { limit, cursor } = normalizeOptions(options);

  const where = [
    "m.speaker_id = ?",
    "m.removed_at IS NULL",
    "p.status = 'active'",
    `instr(m.capabilities, '"project.read"') > 0`,
    "g.credential_id = ?",
  ];
  const params: Array<string | number> = [principal.speakerId, principal.credentialId];
  if (cursor !== null) {
    where.push("(p.created_at > ? OR (p.created_at = ? AND p.id > ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = await deps.db.all<ProjectRow>(
    `SELECT p.id, p.title, p.summary, p.status, p.created_at, p.updated_at
       FROM projects p
       JOIN project_memberships m ON m.project_id = p.id
       JOIN credential_project_grants g ON g.project_id = p.id
      WHERE ${where.join(" AND ")}
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT ?`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null;
  return {
    projects: page.map((row) => ({
      id: row.id,
      title: row.title,
      summary: row.summary,
      status: row.status,
      created_at: row.created_at,
    })),
    next_cursor: nextCursor,
  };
}
