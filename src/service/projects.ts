// Project enumeration shared by REST and MCP. Membership, credential grant, and
// scope checks are identical to every other project-scoped path; the only
// difference is the transport that renders the result.
import { AppError } from "../domain/errors.ts";
import type { Principal, ServiceDeps } from "./auth.ts";

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
// active membership granting `project.read`. One row per project; the member
// display name comes from the same deterministic speaker ordering the REST
// listing uses for its single principal.
async function listSessionProjects(
  deps: ServiceDeps,
  accountId: string,
  options: ListProjectsOptions,
): Promise<ProjectListResult> {
  const { limit, cursor } = normalizeOptions(options);

  const where = [
    "s.owner_account_id = ?",
    "m.removed_at IS NULL",
    "p.status = 'active'",
    "s.status = 'active'",
    "a.status = 'active'",
    `instr(m.capabilities, '"project.read"') > 0`,
  ];
  const params: Array<string | number> = [accountId];
  if (cursor !== null) {
    where.push("(p.created_at > ? OR (p.created_at = ? AND p.id > ?))");
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  params.push(limit + 1);

  const rows = await deps.db.all<ProjectRow>(
    `SELECT DISTINCT p.id, p.title, p.summary, p.status, p.created_at, p.updated_at
       FROM projects p
       JOIN project_memberships m ON m.project_id = p.id
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE ${where.join(" AND ")}
      ORDER BY p.created_at ASC, p.id ASC
      LIMIT ?`,
    params,
  );
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > limit && last !== undefined ? encodeCursor(last.created_at, last.id) : null;

  const memberNames = new Map<string, string | null>();
  if (page.length > 0) {
    const ids = page.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    const members = await deps.db.all<{ project_id: string; display_name: string | null }>(
      `SELECT m.project_id, s.display_name
         FROM project_memberships m
         JOIN speakers s ON s.id = m.speaker_id
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE s.owner_account_id = ? AND m.removed_at IS NULL
          AND s.status = 'active' AND a.status = 'active'
          AND instr(m.capabilities, '"project.read"') > 0
          AND m.project_id IN (${placeholders})
        ORDER BY m.project_id ASC, s.created_at ASC, s.id ASC`,
      [accountId, ...ids],
    );
    for (const member of members) {
      if (!memberNames.has(member.project_id)) {
        memberNames.set(member.project_id, member.display_name);
      }
    }
  }

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
