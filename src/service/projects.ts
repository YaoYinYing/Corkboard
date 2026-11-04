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

export async function listProjects(
  deps: ServiceDeps,
  principal: Principal,
  options: ListProjectsOptions = {},
): Promise<ProjectListResult> {
  if (!principal.scopes.has("project.read")) throw new AppError("FORBIDDEN");

  const limit = options.limit ?? DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new AppError("VALIDATION_ERROR", "limit must be 1-100");
  }
  const rawCursor = options.cursor ?? null;
  const cursor = rawCursor === null || rawCursor === "" ? null : decodeCursor(rawCursor);

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
