// Account-scoped speaker directory and explicit credential issuance for the
// human dashboard. These functions never authorize a project by ID alone: the
// speaker must be owned by the session account, and every selected project must
// grant the selected scopes to that speaker through an active membership.
import { generateSpeakerToken, hashSecret, randomBase64url } from "../auth/credentials.ts";
import { SCOPES, type Scope } from "../domain/authz.ts";
import { AppError } from "../domain/errors.ts";
import { writeAudit } from "./audit.ts";
import { parseScopeJson, type Principal, type ServiceDeps } from "./auth.ts";
import { OAUTH_ACCESS_PREFIX } from "./oauth.ts";
import type { SqlDatabase, SqlTransaction } from "../storage/db.ts";

const MAX_SPEAKER_ID_CHARS = 128;
const MAX_PROJECT_ID_CHARS = 128;
const MAX_CREDENTIAL_ID_CHARS = 128;
const MAX_SELECTED_PROJECTS = 100;
// `boundAuditDetail` caps arrays at 32 elements. Keep the audit honest by
// sending at most that many IDs plus the full count rather than relying on the
// silent truncation.
const MAX_AUDIT_PROJECT_IDS = 32;

// OAuth access credentials are managed by their OAuth client. Reuse one
// predicate and message for every administrative path (rotation and dashboard
// grants) so a live access token cannot be widened or converted behind the
// consent screen.
export const OAUTH_ISSUED_CREDENTIAL_ERROR = "credential is OAuth-issued; use the OAuth flow";

export function isOAuthIssuedCredential(publicPrefix: string, oauthAssociated: number): boolean {
  return oauthAssociated !== 0 || publicPrefix.startsWith(OAUTH_ACCESS_PREFIX);
}

export interface SpeakerProject {
  id: string;
  title: string;
  capabilities: Scope[];
}

export interface OwnedSpeaker {
  id: string;
  display_name: string | null;
  status: string;
  projects: SpeakerProject[];
}

export interface OwnedSpeakerForKey {
  id: string;
  display_name: string | null;
  status: string;
  projects: SpeakerProject[];
}

export interface CredentialIssueInput {
  projectIds: readonly string[];
  scopes: readonly string[];
}

export interface IssuedCredential {
  credentialId: string;
  /** Displayed once in the POST response; never persisted or logged. */
  token: string;
  projects: string[];
  scopes: Scope[];
}

export interface CredentialGrant {
  id: string;
  title: string;
}

export type CredentialState = "active" | "expired" | "revoked" | "unknown";

/** Non-secret credential metadata only: never the token, prefix, or verifier. */
export interface OwnedCredential {
  id: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** Derived for display; revocation wins over expiry. */
  state: CredentialState;
  /** Stored scope identifiers (a ceiling, not an inferred grant). */
  scopes: Scope[];
  projects: CredentialGrant[];
  /** OAuth access credentials are managed by their client; grants are read-only. */
  oauthIssued: boolean;
}

export interface OwnedSpeakerCredentials {
  speaker: { id: string; display_name: string | null; status: string };
  credentials: OwnedCredential[];
  /**
   * Projects this speaker may be granted: an active speaker membership and the
   * session account can read the project. Already-granted projects are included;
   * adding an existing grant is an idempotent no-op.
   */
  grantableProjects: CredentialGrant[];
}

// Only a human session may read the directory or mint a credential. A bearer
// principal has its own speaker and must not manage account speakers.
function requireSessionAccount(principal: Principal): string {
  if (principal.sessionViewer !== true) throw new AppError("FORBIDDEN");
  return principal.accountId;
}

function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

interface SpeakerRow {
  id: string;
  display_name: string | null;
  status: string;
}

interface ProjectRow {
  id: string;
  title: string;
  capabilities: string;
}

async function loadSpeakerProjects(
  deps: ServiceDeps,
  accountId: string,
  speakerId: string,
): Promise<SpeakerProject[]> {
  const rows = await deps.db.all<ProjectRow>(
    `SELECT p.id, p.title, m.capabilities
       FROM project_memberships m
       JOIN projects p ON p.id = m.project_id
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE m.speaker_id = ? AND s.owner_account_id = ? AND m.removed_at IS NULL
        AND p.status = 'active' AND s.status = 'active' AND a.status = 'active'
      ORDER BY p.created_at ASC, p.id ASC`,
    [speakerId, accountId],
  );
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    capabilities: SCOPES.filter((scope) => parseScopeJson(row.capabilities).has(scope)),
  }));
}

// Mirrors `resolveSessionViewer`'s `project.read` query: the account can read a
// project when at least one of its active owned speakers holds an active
// membership carrying `project.read`. A grant is never inferred from this; it
// only bounds which projects the dashboard may offer.
async function loadAccountReadableProjectIds(
  deps: ServiceDeps,
  accountId: string,
): Promise<Set<string>> {
  const rows = await deps.db.all<{ project_id: string; capabilities: string }>(
    `SELECT m.project_id, m.capabilities
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
       JOIN projects p ON p.id = m.project_id
      WHERE s.owner_account_id = ? AND m.removed_at IS NULL
        AND s.status = 'active' AND a.status = 'active' AND p.status = 'active'`,
    [accountId],
  );
  const readable = new Set<string>();
  for (const row of rows) {
    if (parseScopeJson(row.capabilities).has("project.read")) readable.add(row.project_id);
  }
  return readable;
}

// The directory lists every speaker owned by the account, including inactive
// ones (with status shown). Projects are only active memberships, so the page
// never advertises access the existing authorization rules would deny.
export async function listOwnedSpeakers(
  deps: ServiceDeps,
  principal: Principal,
): Promise<OwnedSpeaker[]> {
  const accountId = requireSessionAccount(principal);
  const rows = await deps.db.all<SpeakerRow & { project_id: string | null; project_title: string | null; capabilities: string | null }>(
    `SELECT s.id, s.display_name, s.status,
            p.id AS project_id, p.title AS project_title, m.capabilities
       FROM speakers s
       JOIN accounts a ON a.id = s.owner_account_id
       LEFT JOIN project_memberships m
         ON m.speaker_id = s.id AND m.removed_at IS NULL AND s.status = 'active'
       LEFT JOIN projects p ON p.id = m.project_id AND p.status = 'active'
      WHERE s.owner_account_id = ? AND a.status = 'active'
      ORDER BY s.created_at ASC, s.id ASC, p.created_at ASC, p.id ASC`,
    [accountId],
  );

  const speakers = new Map<string, OwnedSpeaker>();
  for (const row of rows) {
    let speaker = speakers.get(row.id);
    if (speaker === undefined) {
      speaker = {
        id: row.id,
        display_name: row.display_name,
        status: row.status,
        projects: [],
      };
      speakers.set(row.id, speaker);
    }
    if (row.project_id === null || row.capabilities === null) continue;
    speaker.projects.push({
      id: row.project_id,
      title: row.project_title ?? row.project_id,
      capabilities: SCOPES.filter((scope) => parseScopeJson(row.capabilities ?? "").has(scope)),
    });
  }
  return [...speakers.values()];
}

// The owner check lives in the WHERE clause. A foreign, unknown, or inactive
// speaker is the same NOT_FOUND, so the key form cannot probe another account's
// speakers. The route authorizes before parsing the request body.
export async function getOwnedSpeakerForKey(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
): Promise<OwnedSpeakerForKey> {
  const accountId = requireSessionAccount(principal);
  if (speakerId === "" || speakerId.length > MAX_SPEAKER_ID_CHARS) {
    throw new AppError("NOT_FOUND");
  }
  const speaker = await deps.db.first<SpeakerRow>(
    `SELECT s.id, s.display_name, s.status
       FROM speakers s
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE s.id = ? AND s.owner_account_id = ?
        AND s.status = 'active' AND a.status = 'active'`,
    [speakerId, accountId],
  );
  if (speaker === undefined) throw new AppError("NOT_FOUND");
  return {
    ...speaker,
    projects: await loadSpeakerProjects(deps, accountId, speakerId),
  };
}

// `credential.issue` and `credential.rotate` share one audit budget: at most 32
// project IDs plus the true count, staying under the 2,048-character detail cap.
function auditProjectSelection(selected: readonly string[]): {
  projects: string[];
  project_count: number;
} {
  const projects: string[] = [];
  let auditChars = 0;
  for (const projectId of selected.slice(0, MAX_AUDIT_PROJECT_IDS)) {
    if (auditChars + projectId.length + 3 > 1600) break;
    projects.push(projectId);
    auditChars += projectId.length + 3;
  }
  return { projects, project_count: selected.length };
}

// Explicit issuance only. Every selected project needs an active membership for
// this speaker, and every requested scope must already be one of that
// membership's capabilities; a scope is checked against every selected project,
// matching the CLI. Grants are written only for the selected projects. The raw
// token is returned to the caller for one display and is never stored: only the
// public prefix and keyed HMAC verifier reach the database.
export async function issueProjectCredential(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
  input: CredentialIssueInput,
): Promise<IssuedCredential> {
  const accountId = requireSessionAccount(principal);
  const speaker = await getOwnedSpeakerForKey(deps, principal, speakerId);

  const requestedScopes = new Set<Scope>();
  for (const raw of input.scopes) {
    if (typeof raw !== "string" || !isScope(raw)) throw new AppError("VALIDATION_ERROR");
    requestedScopes.add(raw);
  }
  if (requestedScopes.size === 0) throw new AppError("VALIDATION_ERROR");
  const scopes = SCOPES.filter((scope) => requestedScopes.has(scope));

  const projectIds = new Set<string>();
  for (const raw of input.projectIds) {
    if (typeof raw !== "string" || raw === "" || raw.length > MAX_PROJECT_ID_CHARS) {
      throw new AppError("VALIDATION_ERROR");
    }
    projectIds.add(raw);
  }
  if (projectIds.size === 0 || projectIds.size > MAX_SELECTED_PROJECTS) {
    throw new AppError("VALIDATION_ERROR");
  }

  const allowed = new Map(speaker.projects.map((project) => [project.id, project]));
  for (const projectId of projectIds) {
    const project = allowed.get(projectId);
    if (project === undefined) throw new AppError("VALIDATION_ERROR");
    for (const scope of scopes) {
      if (!project.capabilities.includes(scope)) throw new AppError("VALIDATION_ERROR");
    }
  }

  const { token, publicPrefix } = generateSpeakerToken();
  const credentialId = `cred_${randomBase64url(16)}`;
  const selected = [...projectIds];
  const now = deps.now().toISOString();
  await deps.db.transaction(async (tx) => {
    // Re-read every selected membership inside the write transaction. The
    // pre-check above rejects invalid selections quickly, but a membership
    // removed (or a speaker/project deactivated) between that check and this
    // write must roll back the whole issuance instead of leaving a credential
    // or grant for access the authorization rules would now deny.
    for (const projectId of selected) {
      const membership = await tx.first<{ capabilities: string }>(
        `SELECT m.capabilities
           FROM project_memberships m
           JOIN projects p ON p.id = m.project_id
           JOIN speakers s ON s.id = m.speaker_id
           JOIN accounts a ON a.id = s.owner_account_id
          WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL
            AND p.status = 'active' AND s.status = 'active'
            AND s.owner_account_id = ? AND a.status = 'active'`,
        [projectId, speakerId, accountId],
      );
      if (membership === undefined) throw new AppError("VALIDATION_ERROR");
      const capabilities = parseScopeJson(membership.capabilities);
      for (const scope of scopes) {
        if (!capabilities.has(scope)) throw new AppError("VALIDATION_ERROR");
      }
    }
    await tx.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
      [
        credentialId,
        speakerId,
        publicPrefix,
        await hashSecret(token, deps.pepper),
        JSON.stringify(scopes),
        now,
      ],
    );
    for (const projectId of selected) {
      await tx.run(
        `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
         VALUES (?, ?, ?)`,
        [credentialId, projectId, now],
      );
    }
  });

  // Identifiers and scope names only; never the token, its prefix, or verifier.
  // `boundAuditDetail` caps arrays at 32 and drops a detail document over 2048
  // characters, so record the IDs that fit plus the true count instead of
  // letting the sink silently truncate a 100-project selection.
  await writeAudit(deps, {
    operation: "credential.issue",
    outcome: "success",
    actorAccountId: accountId,
    actorSpeakerId: speakerId,
    projectId: selected.length === 1 ? (selected[0] ?? null) : null,
    detail: {
      ...auditProjectSelection(selected),
      scopes,
    },
  });

  return { credentialId, token, projects: selected, scopes };
}

// Narrow dependency surface for operator (CLI) credential administration. The
// caller already has operator authority; this function only needs the database,
// the verifier pepper, and a clock.
export interface CredentialRotationDeps {
  db: SqlDatabase;
  pepper: Uint8Array;
  now: () => Date;
}

export interface RotateCredentialInput {
  credentialId: string;
  /**
   * ISO-8601 expiry for the replacement. Omitted means the old credential's
   * exact `expires_at` is kept (including NULL = no expiry): rotation never
   * silently extends or shortens a credential's lifetime. Pass an explicit
   * value to move a near-expiry credential.
   */
  expiresAt?: string | undefined;
  /**
   * Dashboard callers pass the authenticated session account. When set, the
   * rotation transaction fails closed unless the speaker is still owned by that
   * account, closing the gap between an inventory read and the write. The
   * operator CLI omits it and keeps its documented any-owner behavior.
   */
  expectedOwnerAccountId?: string | undefined;
}

export interface RotatedCredential {
  credentialId: string;
  /** Displayed once by the CLI; never persisted or logged. */
  token: string;
  projects: string[];
  scopes: Scope[];
  expiresAt: string | null;
}

interface RotationSourceRow {
  speaker_id: string;
  public_prefix: string;
  scope_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  speaker_status: string;
  owner_account_id: string | null;
  account_status: string | null;
  oauth_associated: number;
}

// Atomic operator rotation. Unlike dashboard issuance, there is no session and
// no Principal: CLI operator trust authorizes the call, but existence and
// state checks still run here. The old credential must be active, so an
// unknown, revoked, expired, or inactive-principal credential is rejected with
// no writes. The replacement copies the old credential's known scopes and its
// current project grants exactly and revokes the old row in the same
// BEGIN IMMEDIATE transaction; any failure rolls back all three writes, so the
// old credential stays active and no orphan credential remains. The old row's
// grants are retained (soft revocation), matching `revoke-key`.
export async function rotateSpeakerCredential(
  deps: CredentialRotationDeps,
  input: RotateCredentialInput,
): Promise<RotatedCredential> {
  if (input.credentialId === "" || input.credentialId.length > MAX_CREDENTIAL_ID_CHARS) {
    throw new Error(`credential not found: ${input.credentialId}`);
  }
  const now = deps.now();
  const nowMs = now.getTime();
  let requestedExpiry: string | undefined;
  if (input.expiresAt !== undefined) {
    const parsed = new Date(input.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("--expires-at must be an ISO timestamp");
    }
    if (parsed.getTime() <= nowMs) {
      throw new Error("--expires-at must be in the future");
    }
    requestedExpiry = parsed.toISOString();
  }

  const { token, publicPrefix } = generateSpeakerToken();
  const credentialId = `cred_${randomBase64url(16)}`;
  const createdAt = now.toISOString();

  const rotated = await deps.db.transaction(async (tx) => {
    const source = await tx.first<RotationSourceRow>(
      `SELECT c.speaker_id, c.public_prefix, c.scope_json, c.expires_at,
              c.revoked_at, s.status AS speaker_status, s.owner_account_id,
              a.status AS account_status,
              EXISTS (SELECT 1 FROM oauth_token_clients t
                       WHERE t.credential_id = c.id) AS oauth_associated
         FROM credentials c
         JOIN speakers s ON s.id = c.speaker_id
         LEFT JOIN accounts a ON a.id = s.owner_account_id
        WHERE c.id = ?`,
      [input.credentialId],
    );
    if (source === undefined) {
      throw new Error(`credential not found: ${input.credentialId}`);
    }
    // OAuth access credentials are managed by their OAuth client (refresh
    // rotation and RFC 7009 revocation). Minting an operator credential for the
    // same speaker would drop the oauth_token_clients association and bypass
    // that flow, so reject both markers without writing.
    if (isOAuthIssuedCredential(source.public_prefix, source.oauth_associated)) {
      throw new Error(`${OAUTH_ISSUED_CREDENTIAL_ERROR}: ${input.credentialId}`);
    }
    if (source.revoked_at !== null) {
      throw new Error(`credential is revoked: ${input.credentialId}`);
    }
    if (source.expires_at !== null) {
      const sourceMs = Date.parse(source.expires_at);
      // Fail closed on a stored value authorization would treat as unusable.
      if (Number.isNaN(sourceMs)) {
        throw new Error(`credential expiry is invalid: ${input.credentialId}`);
      }
      if (sourceMs <= nowMs) {
        throw new Error(`credential is expired: ${input.credentialId}`);
      }
    }
    if (source.speaker_status !== "active") {
      throw new Error(`speaker is not active: ${source.speaker_id}`);
    }
    if (source.owner_account_id === null || source.account_status !== "active") {
      throw new Error(`owner account is not active: ${source.speaker_id}`);
    }
    // Re-check ownership inside the write transaction: a dashboard request that
    // resolved its inventory before the body read must not rotate a credential
    // after the speaker changed hands.
    if (
      input.expectedOwnerAccountId !== undefined &&
      source.owner_account_id !== input.expectedOwnerAccountId
    ) {
      throw new AppError("NOT_FOUND");
    }

    // Keep the old expiry policy unless the operator explicitly overrides it.
    const expiresAt = requestedExpiry === undefined ? source.expires_at : requestedExpiry;
    const sourceScopes = parseScopeJson(source.scope_json);
    const scopes = SCOPES.filter((scope) => sourceScopes.has(scope));
    const grantRows = await tx.all<{ project_id: string }>(
      `SELECT project_id FROM credential_project_grants
        WHERE credential_id = ? ORDER BY project_id ASC`,
      [input.credentialId],
    );
    const projects = grantRows.map((row) => row.project_id);

    await tx.run(
      `INSERT INTO credentials
         (id, speaker_id, public_prefix, secret_verifier, scope_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        credentialId,
        source.speaker_id,
        publicPrefix,
        await hashSecret(token, deps.pepper),
        JSON.stringify(scopes),
        expiresAt,
        createdAt,
      ],
    );
    for (const projectId of projects) {
      await tx.run(
        `INSERT INTO credential_project_grants (credential_id, project_id, granted_at)
         VALUES (?, ?, ?)`,
        [credentialId, projectId, createdAt],
      );
    }
    const revoked = await tx.run(
      `UPDATE credentials SET revoked_at = ?
        WHERE id = ? AND speaker_id = ? AND revoked_at IS NULL`,
      [createdAt, input.credentialId, source.speaker_id],
    );
    if (revoked.changes !== 1) {
      // Serialized by BEGIN IMMEDIATE, but keep the fail-closed predicate.
      throw new Error(`credential is revoked: ${input.credentialId}`);
    }
    return {
      credentialId,
      token,
      projects,
      scopes,
      expiresAt,
      speakerId: source.speaker_id,
      accountId: source.owner_account_id,
    };
  });

  // Metadata only: never the token, its prefix, or verifier. The audit write is
  // fail-open and follows the committed transaction, matching other credential
  // audits; it never changes whether the rotation took effect.
  await writeAudit(deps, {
    operation: "credential.rotate",
    outcome: "success",
    actorAccountId: rotated.accountId,
    actorSpeakerId: rotated.speakerId,
    projectId: rotated.projects.length === 1 ? (rotated.projects[0] ?? null) : null,
    detail: {
      credential_id: input.credentialId,
      new_credential_id: rotated.credentialId,
      ...auditProjectSelection(rotated.projects),
      scopes: rotated.scopes,
      expires_at: rotated.expiresAt,
    },
  });

  return {
    credentialId: rotated.credentialId,
    token: rotated.token,
    projects: rotated.projects,
    scopes: rotated.scopes,
    expiresAt: rotated.expiresAt,
  };
}

function requireOwnedSpeakerId(speakerId: string): void {
  if (speakerId === "" || speakerId.length > MAX_SPEAKER_ID_CHARS) {
    throw new AppError("NOT_FOUND");
  }
}

function requireCredentialId(credentialId: string): void {
  if (credentialId === "" || credentialId.length > MAX_CREDENTIAL_ID_CHARS) {
    throw new AppError("NOT_FOUND");
  }
}

function requireProjectId(projectId: string): void {
  if (projectId === "" || projectId.length > MAX_PROJECT_ID_CHARS) {
    throw new AppError("NOT_FOUND");
  }
}

// The account-readable check repeated inside the write transaction, mirroring
// `loadAccountReadableProjectIds`/`resolveSessionViewer`. A project the account
// cannot read is the same NOT_FOUND as a missing one.
async function accountCanReadProject(
  db: Pick<SqlTransaction, "all">,
  accountId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db.all<{ capabilities: string }>(
    `SELECT m.capabilities
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
       JOIN projects p ON p.id = m.project_id
      WHERE m.project_id = ? AND s.owner_account_id = ?
        AND m.removed_at IS NULL AND s.status = 'active'
        AND a.status = 'active' AND p.status = 'active'`,
    [projectId, accountId],
  );
  return rows.some((row) => parseScopeJson(row.capabilities).has("project.read"));
}

// Account ownership is the authority for credential administration. The owning
// account must be active; the speaker status is deliberately not required so an
// operator can still revoke a credential of an inactive speaker. A foreign or
// unknown speaker is the same NOT_FOUND, which keeps the page non-enumerable.
//
// The inventory selects only non-secret columns. The raw token was displayed
// once at issuance and cannot be recovered here; the public prefix is not shown
// either, so the page cannot be used to correlate or probe a credential. Scope
// identifiers are non-secret capability names and are returned for the policy
// matrix; the inventory page does not render them. The speaker, credential, and
// grant reads are three independent SELECTs; each repeats the owner/active-
// account predicate. This is a read path, so it does not use the write
// transaction (`SqlDatabase.transaction` is BEGIN IMMEDIATE and buffers writes
// for D1's batch emulation). There is no snapshot claim: an ownership transfer
// between reads can only make a later read return empty, never add a foreign
// speaker's rows.
export function credentialState(
  revokedAt: string | null,
  expiresAt: string | null,
  nowMs: number,
): CredentialState {
  if (revokedAt !== null) return "revoked";
  if (expiresAt === null) return "active";
  const expiresMs = Date.parse(expiresAt);
  // Authorization treats an unparseable expiry as unusable; never show it as
  // active here. The stored values are normally ISO-8601.
  if (Number.isNaN(expiresMs)) return "unknown";
  return expiresMs <= nowMs ? "expired" : "active";
}

export async function listOwnedSpeakerCredentials(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
): Promise<OwnedSpeakerCredentials> {
  const accountId = requireSessionAccount(principal);
  requireOwnedSpeakerId(speakerId);
  const nowMs = deps.now().getTime();
  const speaker = await deps.db.first<SpeakerRow>(
    `SELECT s.id, s.display_name, s.status
       FROM speakers s
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE s.id = ? AND s.owner_account_id = ? AND a.status = 'active'`,
    [speakerId, accountId],
  );
  if (speaker === undefined) throw new AppError("NOT_FOUND");
  const rows = await deps.db.all<{
    id: string;
    created_at: string;
    expires_at: string | null;
    revoked_at: string | null;
    scope_json: string;
    public_prefix: string;
    oauth_associated: number;
  }>(
    `SELECT c.id, c.created_at, c.expires_at, c.revoked_at, c.scope_json,
            c.public_prefix,
            EXISTS (SELECT 1 FROM oauth_token_clients t
                     WHERE t.credential_id = c.id) AS oauth_associated
       FROM credentials c
       JOIN speakers s ON s.id = c.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE c.speaker_id = ? AND s.owner_account_id = ? AND a.status = 'active'
      ORDER BY c.created_at ASC, c.id ASC`,
    [speakerId, accountId],
  );
  const grantRows = await deps.db.all<{
    credential_id: string;
    project_id: string;
    title: string;
  }>(
    `SELECT g.credential_id, p.id AS project_id, p.title
       FROM credential_project_grants g
       JOIN credentials c ON c.id = g.credential_id
       JOIN speakers s ON s.id = c.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
       JOIN projects p ON p.id = g.project_id
      WHERE c.speaker_id = ? AND s.owner_account_id = ? AND a.status = 'active'
      ORDER BY p.created_at ASC, p.id ASC`,
    [speakerId, accountId],
  );
  const grants = new Map<string, CredentialGrant[]>();
  for (const row of grantRows) {
    const list = grants.get(row.credential_id);
    const grant = { id: row.project_id, title: row.title };
    if (list === undefined) grants.set(row.credential_id, [grant]);
    else list.push(grant);
  }
  const [speakerProjects, readableProjectIds] = await Promise.all([
    loadSpeakerProjects(deps, accountId, speakerId),
    loadAccountReadableProjectIds(deps, accountId),
  ]);
  return {
    speaker,
    credentials: rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      state: credentialState(row.revoked_at, row.expires_at, nowMs),
      scopes: SCOPES.filter((scope) => parseScopeJson(row.scope_json).has(scope)),
      projects: grants.get(row.id) ?? [],
      oauthIssued: isOAuthIssuedCredential(row.public_prefix, row.oauth_associated),
    })),
    grantableProjects: speakerProjects
      .filter((project) => readableProjectIds.has(project.id))
      .map((project) => ({ id: project.id, title: project.title })),
  };
}


// Soft revocation with the CLI `revoke-key` semantics: one `revoked_at`
// assignment, no grant deletion, and repeat calls are a no-op. The ownership
// re-check runs inside the transaction so an ownership transfer cannot land
// between the route's check and the write. The credential must belong to the
// named speaker, so a credential ID from another speaker (owned or foreign) is
// the same NOT_FOUND and no other credential can be revoked through this route.
// Returns true only when this call performed the transition; a repeated call
// writes no duplicate audit row.
export async function revokeOwnedSpeakerCredential(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
  credentialId: string,
): Promise<boolean> {
  const accountId = requireSessionAccount(principal);
  requireOwnedSpeakerId(speakerId);
  requireCredentialId(credentialId);
  const now = deps.now().toISOString();
  let changed = false;
  await deps.db.transaction(async (tx) => {
    const speaker = await tx.first<{ id: string }>(
      `SELECT s.id
         FROM speakers s
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE s.id = ? AND s.owner_account_id = ? AND a.status = 'active'`,
      [speakerId, accountId],
    );
    if (speaker === undefined) throw new AppError("NOT_FOUND");
    const credential = await tx.first<{ revoked_at: string | null }>(
      "SELECT revoked_at FROM credentials WHERE id = ? AND speaker_id = ?",
      [credentialId, speakerId],
    );
    if (credential === undefined) throw new AppError("NOT_FOUND");
    if (credential.revoked_at !== null) return;
    const result = await tx.run(
      `UPDATE credentials SET revoked_at = ?
        WHERE id = ? AND speaker_id = ? AND revoked_at IS NULL`,
      [now, credentialId, speakerId],
    );
    changed = result.changes > 0;
  });
  if (changed) {
    await writeAudit(deps, {
      operation: "credential.revoke",
      outcome: "success",
      actorAccountId: accountId,
      actorSpeakerId: speakerId,
      projectId: null,
      detail: { credential_id: credentialId, source: "dashboard" },
    });
  }
  return changed;
}

// Adds one explicit project grant to an owned speaker's active credential. The
// speaker must be owned by the session account, the credential must belong to
// that speaker and be active, and the project needs the same active membership
// the CLI requires plus account read access. A project that fails any of these
// is NOT_FOUND, never a distinguishable error, and no write occurs. Adding an
// existing grant is an idempotent no-op (`false`) and writes no duplicate audit.
// Ownership, credential state, membership, and readability are re-read inside
// the transaction so a change between the route's check and this write aborts.
export async function grantOwnedSpeakerCredentialProject(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
  credentialId: string,
  projectId: string,
): Promise<boolean> {
  const accountId = requireSessionAccount(principal);
  requireOwnedSpeakerId(speakerId);
  requireCredentialId(credentialId);
  requireProjectId(projectId);
  const now = deps.now();
  const nowMs = now.getTime();
  let changed = false;
  await deps.db.transaction(async (tx) => {
    const speaker = await tx.first<{ id: string }>(
      `SELECT s.id
         FROM speakers s
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE s.id = ? AND s.owner_account_id = ?
          AND s.status = 'active' AND a.status = 'active'`,
      [speakerId, accountId],
    );
    if (speaker === undefined) throw new AppError("NOT_FOUND");
    const credential = await tx.first<{
      revoked_at: string | null;
      expires_at: string | null;
      public_prefix: string;
      oauth_associated: number;
    }>(
      `SELECT c.revoked_at, c.expires_at, c.public_prefix,
              EXISTS (SELECT 1 FROM oauth_token_clients t
                       WHERE t.credential_id = c.id) AS oauth_associated
         FROM credentials c
        WHERE c.id = ? AND c.speaker_id = ?`,
      [credentialId, speakerId],
    );
    if (credential === undefined) throw new AppError("NOT_FOUND");
    // An OAuth access credential is bound to the project granted at consent.
    // Adding a grant here would widen a live token past that consent, so reject
    // it with the same predicate and message as `rotateSpeakerCredential`.
    if (isOAuthIssuedCredential(credential.public_prefix, credential.oauth_associated)) {
      throw new AppError("FORBIDDEN", OAUTH_ISSUED_CREDENTIAL_ERROR);
    }
    // Grant editing is an active-credential operation; revoked, expired, and
    // unparseable-expiry credentials are read-only.
    if (credentialState(credential.revoked_at, credential.expires_at, nowMs) !== "active") {
      throw new AppError("NOT_FOUND");
    }
    // Same active-membership predicate as the CLI `grant-key-project`.
    const membership = await tx.first<{ present: number }>(
      `SELECT 1 AS present
         FROM project_memberships m
         JOIN projects p ON p.id = m.project_id
         JOIN speakers s ON s.id = m.speaker_id
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL
          AND p.status = 'active' AND s.status = 'active' AND a.status = 'active'`,
      [projectId, speakerId],
    );
    if (membership === undefined) throw new AppError("NOT_FOUND");
    if (!(await accountCanReadProject(tx, accountId, projectId))) {
      throw new AppError("NOT_FOUND");
    }
    const result = await tx.run(
      `INSERT OR IGNORE INTO credential_project_grants
         (credential_id, project_id, granted_at)
       VALUES (?, ?, ?)`,
      [credentialId, projectId, now.toISOString()],
    );
    changed = result.changes > 0;
  });
  if (changed) {
    await writeAudit(deps, {
      operation: "credential.project.grant",
      outcome: "success",
      actorAccountId: accountId,
      actorSpeakerId: speakerId,
      projectId,
      detail: {
        credential_id: credentialId,
        projects: [projectId],
        source: "dashboard",
      },
    });
  }
  return changed;
}

// Removes one explicit project grant from an owned speaker's active credential
// with the CLI `revoke-key-project` SQL. It is speaker-scoped, so a credential
// from another speaker is NOT_FOUND. Unlike granting, removal does not require
// a current membership or account read access: a stale grant must remain
// removable by the speaker's owner even after the membership or project access
// is gone. A missing grant is a no-op (`false`) with the same response and no
// audit row, so the route does not reveal whether the row existed.
export async function revokeOwnedSpeakerCredentialProject(
  deps: ServiceDeps,
  principal: Principal,
  speakerId: string,
  credentialId: string,
  projectId: string,
): Promise<boolean> {
  const accountId = requireSessionAccount(principal);
  requireOwnedSpeakerId(speakerId);
  requireCredentialId(credentialId);
  requireProjectId(projectId);
  const nowMs = deps.now().getTime();
  let changed = false;
  await deps.db.transaction(async (tx) => {
    const speaker = await tx.first<{ id: string }>(
      `SELECT s.id
         FROM speakers s
         JOIN accounts a ON a.id = s.owner_account_id
        WHERE s.id = ? AND s.owner_account_id = ?
          AND s.status = 'active' AND a.status = 'active'`,
      [speakerId, accountId],
    );
    if (speaker === undefined) throw new AppError("NOT_FOUND");
    const credential = await tx.first<{ revoked_at: string | null; expires_at: string | null }>(
      "SELECT revoked_at, expires_at FROM credentials WHERE id = ? AND speaker_id = ?",
      [credentialId, speakerId],
    );
    if (credential === undefined) throw new AppError("NOT_FOUND");
    if (credentialState(credential.revoked_at, credential.expires_at, nowMs) !== "active") {
      throw new AppError("NOT_FOUND");
    }
    const result = await tx.run(
      `DELETE FROM credential_project_grants
        WHERE credential_id = ? AND project_id = ?`,
      [credentialId, projectId],
    );
    changed = result.changes > 0;
  });
  if (changed) {
    await writeAudit(deps, {
      operation: "credential.project.revoke",
      outcome: "success",
      actorAccountId: accountId,
      actorSpeakerId: speakerId,
      projectId,
      detail: {
        credential_id: credentialId,
        projects: [projectId],
        source: "dashboard",
      },
    });
  }
  return changed;
}
