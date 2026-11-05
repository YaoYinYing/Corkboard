// Project enumeration shared by REST and MCP, plus the dashboard's project
// metadata create/edit. Membership, credential grant, and scope checks are
// identical to every other project-scoped path; the only difference is the
// transport that renders the result.
import { randomBase64url } from "../auth/credentials.ts";
import { SCOPES, type Scope } from "../domain/authz.ts";
import { AppError } from "../domain/errors.ts";
import { validateProjectSummary, validateProjectTitle } from "../domain/validation.ts";
import { writeAudit } from "./audit.ts";
import {
  authorizeProject,
  parseScopeJson,
  type Principal,
  type ServiceDeps,
} from "./auth.ts";
import type { SqlTransaction } from "../storage/db.ts";

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

// Dashboard membership editor. Membership administration is project-owner-only,
// not merely `project.edit`: a non-owner member holding project.edit could
// otherwise add a speaker with message.send and mint a bearer credential for it.
// The signed-in account must own the project (`projects.owner_account_id`), and
// both the project and that account must be active. A foreign, unknown,
// non-owner, or inactive project is the uniform NOT_FOUND, so the editor cannot
// distinguish a project the caller can see from one that does not exist.
// The write functions re-read this ownership inside their transaction.
const MAX_MEMBER_SPEAKER_ID_CHARS = 128;

export interface ProjectMember {
  speakerId: string;
  displayName: string | null;
  capabilities: Scope[];
  joinedAt: string | null;
}

export interface AddProjectMemberInput {
  speakerId: string;
  capabilities: readonly string[];
}

function normalizeMemberSpeakerId(value: string): string {
  if (value === "" || value.length > MAX_MEMBER_SPEAKER_ID_CHARS) {
    throw new AppError("VALIDATION_ERROR");
  }
  return value;
}

// An explicit, non-empty subset of the seven identifiers. Duplicates collapse
// to one entry in canonical order; an unknown value rejects the whole request.
// The project owner may grant any of the seven; there is no caller-rights cap.
function normalizeMemberCapabilities(values: readonly string[]): Scope[] {
  const requested = new Set<Scope>();
  for (const value of values) {
    if (typeof value !== "string" || !(SCOPES as readonly string[]).includes(value)) {
      throw new AppError("VALIDATION_ERROR");
    }
    requested.add(value as Scope);
  }
  if (requested.size === 0) throw new AppError("VALIDATION_ERROR");
  return SCOPES.filter((scope) => requested.has(scope));
}

async function assertProjectOwner(
  db: SqlTransaction,
  principal: Principal,
  projectId: string,
): Promise<void> {
  if (principal.sessionViewer !== true) throw new AppError("NOT_FOUND");
  const project = await db.first<{
    status: string;
    owner_account_id: string;
    account_status: string;
  }>(
    `SELECT p.status, p.owner_account_id, a.status AS account_status
       FROM projects p
       JOIN accounts a ON a.id = p.owner_account_id
      WHERE p.id = ?`,
    [projectId],
  );
  if (
    project === undefined ||
    project.status !== "active" ||
    project.account_status !== "active" ||
    project.owner_account_id !== principal.accountId
  ) {
    throw new AppError("NOT_FOUND");
  }
}

export function authorizeProjectOwner(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<void> {
  return assertProjectOwner(deps.db, principal, projectId);
}

export async function listProjectMembers(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
): Promise<ProjectMember[]> {
  await authorizeProjectOwner(deps, principal, projectId);
  const rows = await deps.db.all<{
    speaker_id: string;
    display_name: string | null;
    capabilities: string;
    joined_at: string | null;
  }>(
    `SELECT m.speaker_id, s.display_name, m.capabilities, m.joined_at
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
      WHERE m.project_id = ? AND m.removed_at IS NULL
      ORDER BY m.joined_at ASC, m.speaker_id ASC`,
    [projectId],
  );
  return rows.map((row) => ({
    speakerId: row.speaker_id,
    displayName: row.display_name,
    capabilities: SCOPES.filter((scope) => parseScopeJson(row.capabilities).has(scope)),
    joinedAt: row.joined_at,
  }));
}

// Only an active speaker owned by the signed-in (owner) account may be added.
// A foreign, unknown, inactive, or other-account speaker is the same
// VALIDATION_ERROR, so the add form cannot enumerate accounts or speakers.
// Adding writes only the membership: no credential, scope grant, or implicit
// capability is created. An active duplicate is CONFLICT; a previously
// removed membership is reactivated with the submitted capability set and,
// because removal deleted its grants, no old credential becomes usable again.
export async function addProjectMember(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  input: AddProjectMemberInput,
): Promise<void> {
  await authorizeProjectOwner(deps, principal, projectId);
  const speakerId = normalizeMemberSpeakerId(input.speakerId);
  const capabilities = normalizeMemberCapabilities(input.capabilities);

  const owned = await deps.db.first<{ id: string }>(
    `SELECT s.id
       FROM speakers s
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE s.id = ? AND s.owner_account_id = ?
        AND s.status = 'active' AND a.status = 'active'`,
    [speakerId, principal.accountId],
  );
  if (owned === undefined) throw new AppError("VALIDATION_ERROR");

  const now = deps.now().toISOString();
  let reactivated = false;
  await deps.db.transaction(async (tx) => {
    await assertProjectOwner(tx, principal, projectId);

    const rechecked = await tx.first<{ id: string }>(
      `SELECT s.id
         FROM speakers s
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE s.id = ? AND s.owner_account_id = ?
          AND s.status = 'active' AND a.status = 'active'`,
      [speakerId, principal.accountId],
    );
    if (rechecked === undefined) throw new AppError("VALIDATION_ERROR");

    const existing = await tx.first<{ removed_at: string | null }>(
      "SELECT removed_at FROM project_memberships WHERE project_id = ? AND speaker_id = ?",
      [projectId, speakerId],
    );
    if (existing !== undefined && existing.removed_at === null) {
      throw new AppError("CONFLICT", "membership is already active");
    }
    if (existing === undefined) {
      await tx.run(
        `INSERT INTO project_memberships (project_id, speaker_id, capabilities, joined_at)
         VALUES (?, ?, ?, ?)`,
        [projectId, speakerId, JSON.stringify(capabilities), now],
      );
    } else {
      reactivated = true;
      await tx.run(
        `UPDATE project_memberships
            SET capabilities = ?, joined_at = ?, removed_at = NULL
          WHERE project_id = ? AND speaker_id = ?`,
        [JSON.stringify(capabilities), now, projectId, speakerId],
      );
    }
  });

  await writeAudit(deps, {
    operation: "membership.grant",
    outcome: "success",
    actorAccountId: principal.accountId,
    actorSpeakerId: speakerId,
    projectId,
    detail: { capabilities, reactivated },
  });
}

export interface RemoveProjectMemberResult {
  grantsDeleted: number;
}

// Soft-deletes the membership and, mirroring `remove-member` in the CLI,
// deletes every credential grant that speaker held for this project. The exact
// last-owner rule: a manageable owner membership is a non-removed membership
// whose speaker is owned by `projects.owner_account_id`, where the speaker and
// owning account are active and the capability set includes `project.edit`.
// Removing the last manageable owner membership is refused so the owning
// account keeps a membership that actually administers the project. Inactive or
// `project.edit`-less owner memberships neither count nor are protected.
export async function removeProjectMember(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  speakerId: string,
): Promise<RemoveProjectMemberResult> {
  await authorizeProjectOwner(deps, principal, projectId);
  const targetSpeakerId = normalizeMemberSpeakerId(speakerId);

  const now = deps.now().toISOString();
  let grantsDeleted = 0;
  await deps.db.transaction(async (tx) => {
    await assertProjectOwner(tx, principal, projectId);

    const project = await tx.first<{ owner_account_id: string }>(
      "SELECT owner_account_id FROM projects WHERE id = ? AND status = 'active'",
      [projectId],
    );
    if (project === undefined) throw new AppError("NOT_FOUND");

    const membership = await tx.first<{
      speaker_owner_account_id: string | null;
      speaker_status: string;
      speaker_account_status: string | null;
      capabilities: string;
    }>(
      `SELECT s.owner_account_id AS speaker_owner_account_id,
              s.status AS speaker_status,
              a.status AS speaker_account_status,
              m.capabilities
         FROM project_memberships m
         JOIN speakers s ON s.id = m.speaker_id
         LEFT JOIN accounts a ON a.id = s.owner_account_id
        WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL`,
      [projectId, targetSpeakerId],
    );
    if (membership === undefined) throw new AppError("NOT_FOUND");

    const manageableOwner =
      membership.speaker_owner_account_id === project.owner_account_id &&
      membership.speaker_status === "active" &&
      membership.speaker_account_status === "active" &&
      parseScopeJson(membership.capabilities).has("project.edit");
    if (manageableOwner) {
      // Filter in JS: the SQLite/D1 contract avoids JSON functions.
      const owners = await tx.all<{ capabilities: string }>(
        `SELECT m.capabilities
           FROM project_memberships m
           JOIN speakers s ON s.id = m.speaker_id
           JOIN accounts a ON a.id = s.owner_account_id
          WHERE m.project_id = ? AND m.removed_at IS NULL
            AND s.owner_account_id = ?
            AND s.status = 'active' AND a.status = 'active'`,
        [projectId, project.owner_account_id],
      );
      const manageable = owners.filter((owner) =>
        parseScopeJson(owner.capabilities).has("project.edit"),
      );
      if (manageable.length <= 1) {
        throw new AppError("CONFLICT", "cannot remove the last owner membership");
      }
    }

    const removed = await tx.run(
      `UPDATE project_memberships SET removed_at = ?
        WHERE project_id = ? AND speaker_id = ? AND removed_at IS NULL`,
      [now, projectId, targetSpeakerId],
    );
    if (removed.changes === 0) throw new AppError("NOT_FOUND");

    const grants = await tx.run(
      `DELETE FROM credential_project_grants
        WHERE project_id = ?
          AND credential_id IN (SELECT id FROM credentials WHERE speaker_id = ?)`,
      [projectId, targetSpeakerId],
    );
    grantsDeleted = grants.changes;
  });

  await writeAudit(deps, {
    operation: "membership.remove",
    outcome: "success",
    actorAccountId: principal.accountId,
    actorSpeakerId: targetSpeakerId,
    projectId,
  });
  if (grantsDeleted > 0) {
    await writeAudit(deps, {
      operation: "credential.project.revoke",
      outcome: "success",
      actorAccountId: principal.accountId,
      actorSpeakerId: targetSpeakerId,
      projectId,
      detail: { projects: [projectId], source: "membership.remove" },
    });
  }
  return { grantsDeleted };
}
