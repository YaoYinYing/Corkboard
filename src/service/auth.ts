import { credentialIsActive, verifySecret } from "../auth/credentials.ts";
import type { PasswordVerifier } from "../auth/password.ts";
import {
  SCOPES,
  authorizeProjectAccess,
  effectiveRights,
  type Scope,
} from "../domain/authz.ts";
import { AppError } from "../domain/errors.ts";
import type { KeyProvider } from "../crypto/keys.ts";
import type { BlobStore } from "../storage/blobs.ts";
import type { SqlDatabase } from "../storage/db.ts";

export interface ServiceDeps {
  db: SqlDatabase;
  blobs: BlobStore;
  keys: KeyProvider;
  pepper: Uint8Array;
  serviceId: string;
  now: () => Date;
  /**
   * Human password verification port. Core defaults to portable PBKDF2; the
   * Node adapter additionally understands legacy scrypt hashes.
   */
  passwordVerifier?: PasswordVerifier;
}

export interface Principal {
  credentialId: string;
  speakerId: string;
  accountId: string;
  scopes: ReadonlySet<Scope>;
  /**
   * Set only by `resolveSessionViewer`/`sessionAccountPrincipal` for the human
   * dashboard. It is never derived from request input and never set by
   * `authenticateBearer`. The flag, not the synthetic credential id, selects the
   * session authorization branch.
   */
  sessionViewer?: true;
}

export interface ProjectAccess {
  /** Intersection of the credential scopes and the active membership capabilities. */
  rights: Set<Scope>;
  /**
   * The active membership's capability set, filtered to known identifiers.
   * A session viewer receives only the requested scope because its authority is
   * resolved per request.
   */
  capabilities: Set<Scope>;
}

const BEARER_RE = /^Bearer ([A-Za-z0-9_-]+)$/;
const TOKEN_PREFIX = "cb_";
const PUBLIC_PREFIX_LENGTH = 12;

function isScope(value: string): value is Scope {
  return (SCOPES as readonly string[]).includes(value);
}

// Unknown strings and malformed JSON fail closed to an empty scope set. Shared
// with the OAuth consent path so credential and membership scope parsing cannot
// drift.
export function parseScopeJson(value: string): Set<Scope> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return new Set<Scope>();
  }
  if (!Array.isArray(parsed)) return new Set<Scope>();
  const scopes = new Set<Scope>();
  for (const item of parsed) {
    if (typeof item === "string" && isScope(item)) scopes.add(item);
  }
  return scopes;
}

function parseDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

interface CredentialRow {
  id: string;
  speaker_id: string;
  secret_verifier: string;
  scope_json: string;
  expires_at: string | null;
  revoked_at: string | null;
  speaker_status: string;
  owner_account_id: string | null;
  account_status: string | null;
}

// The credential's public prefix selects candidates; the keyed HMAC verifier
// decides which one is real. Inactive credentials and principals are rejected
// with the same UNAUTHENTICATED code so callers cannot probe existence.
export async function authenticateBearer(
  deps: ServiceDeps,
  authorizationHeader: string | undefined,
): Promise<Principal> {
  const match = authorizationHeader === undefined ? null : BEARER_RE.exec(authorizationHeader);
  const token = match?.[1];
  if (token === undefined || !token.startsWith(TOKEN_PREFIX) || token.length <= PUBLIC_PREFIX_LENGTH) {
    throw new AppError("UNAUTHENTICATED");
  }

  const publicPrefix = token.slice(0, PUBLIC_PREFIX_LENGTH);
  const rows = await deps.db.all<CredentialRow>(
    `SELECT c.id, c.speaker_id, c.secret_verifier, c.scope_json, c.expires_at, c.revoked_at,
            s.status AS speaker_status, s.owner_account_id, a.status AS account_status
       FROM credentials c
       JOIN speakers s ON s.id = c.speaker_id
       LEFT JOIN accounts a ON a.id = s.owner_account_id
      WHERE c.public_prefix = ?`,
    [publicPrefix],
  );

  let credential: CredentialRow | undefined;
  for (const row of rows) {
    if (await verifySecret(token, publicPrefix, row.secret_verifier, deps.pepper)) {
      credential = row;
      break;
    }
  }
  if (credential === undefined) throw new AppError("UNAUTHENTICATED");

  const now = deps.now();
  const active = credentialIsActive(
    {
      expiresAt: parseDate(credential.expires_at),
      revokedAt: parseDate(credential.revoked_at),
    },
    now,
  );
  if (
    !active ||
    credential.speaker_status !== "active" ||
    credential.owner_account_id === null ||
    credential.account_status !== "active"
  ) {
    throw new AppError("UNAUTHENTICATED");
  }

  await deps.db.run("UPDATE credentials SET last_used_at = ? WHERE id = ?", [
    now.toISOString(),
    credential.id,
  ]);

  return {
    credentialId: credential.id,
    speakerId: credential.speaker_id,
    accountId: credential.owner_account_id,
    scopes: parseScopeJson(credential.scope_json),
  };
}

// A session viewer is an account viewing as one of its owned speakers. Its
// authority is exactly the requested scope, never the membership's other
// capabilities. It has no credential, grant, or credential-scope intersection:
// the human authenticated an account, not a speaker credential. Any membership
// that cannot grant the requested scope is NOT_FOUND so a project the account
// cannot read or edit is indistinguishable from a missing project.
async function authorizeSessionProject(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  scope: Scope,
): Promise<ProjectAccess> {
  // The session surface permits project metadata edits but never message
  // writes, receipts, or member administration.
  if (scope !== "project.read" && scope !== "message.read" && scope !== "project.edit") {
    throw new AppError("NOT_FOUND");
  }
  // The viewer carries only the authority it was resolved for. A read viewer
  // cannot re-use this branch to authorize project.edit merely because the
  // underlying membership has the capability.
  if (!principal.scopes.has(scope)) throw new AppError("NOT_FOUND");
  const project = await deps.db.first<{ status: string }>(
    "SELECT status FROM projects WHERE id = ?",
    [projectId],
  );
  if (project === undefined || project.status !== "active") {
    throw new AppError("NOT_FOUND");
  }

  const membership = await deps.db.first<{ capabilities: string }>(
    `SELECT m.capabilities
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
      WHERE m.project_id = ? AND m.speaker_id = ? AND m.removed_at IS NULL
        AND s.owner_account_id = ? AND s.status = 'active' AND a.status = 'active'`,
    [projectId, principal.speakerId, principal.accountId],
  );
  if (membership === undefined) throw new AppError("NOT_FOUND");

  const capabilities = parseScopeJson(membership.capabilities);
  if (!capabilities.has(scope)) throw new AppError("NOT_FOUND");
  // Do not return the membership's other capabilities as rights. A caller such
  // as markRead checks access.rights for receipt.write, so returning the full
  // set would turn the narrow session viewer into a receipt writer.
  const sessionAuthority = new Set<Scope>([scope]);
  authorizeProjectAccess({
    isMember: true,
    membershipRemovedAt: null,
    rights: sessionAuthority,
    scope,
  });
  return { rights: sessionAuthority, capabilities: new Set<Scope>([scope]) };
}

// Decision order: unknown/inactive project, missing membership, or an inactive
// principal is NOT_FOUND (no existence leak); an active member whose credential
// has no explicit grant for this project, or lacks the scope, is FORBIDDEN.
// Credential state and the grant are reloaded so revocation is checked per
// request. A grant never adds rights: it is only a precondition.
export async function authorizeProject(
  deps: ServiceDeps,
  principal: Principal,
  projectId: string,
  scope: Scope,
): Promise<ProjectAccess> {
  if (principal.sessionViewer === true) {
    return authorizeSessionProject(deps, principal, projectId, scope);
  }

  const project = await deps.db.first<{ status: string }>(
    "SELECT status FROM projects WHERE id = ?",
    [projectId],
  );
  if (project === undefined || project.status !== "active") {
    throw new AppError("NOT_FOUND");
  }

  const membership = await deps.db.first<{ capabilities: string }>(
    `SELECT capabilities FROM project_memberships
      WHERE project_id = ? AND speaker_id = ? AND removed_at IS NULL`,
    [projectId, principal.speakerId],
  );
  if (membership === undefined) {
    throw new AppError("NOT_FOUND");
  }

  const speaker = await deps.db.first<{ status: string }>(
    "SELECT status FROM speakers WHERE id = ?",
    [principal.speakerId],
  );
  const account = await deps.db.first<{ status: string }>(
    "SELECT status FROM accounts WHERE id = ?",
    [principal.accountId],
  );
  if (
    speaker === undefined ||
    account === undefined ||
    speaker.status !== "active" ||
    account.status !== "active"
  ) {
    throw new AppError("NOT_FOUND");
  }

  const credential = await deps.db.first<{
    scope_json: string;
    expires_at: string | null;
    revoked_at: string | null;
  }>(
    "SELECT scope_json, expires_at, revoked_at FROM credentials WHERE id = ? AND speaker_id = ?",
    [principal.credentialId, principal.speakerId],
  );

  // Deny by default: the credential must carry an explicit grant for this
  // project. Membership alone (including a newly joined project) grants nothing.
  const grant = await deps.db.first<{ present: number }>(
    `SELECT 1 AS present FROM credential_project_grants
      WHERE credential_id = ? AND project_id = ?`,
    [principal.credentialId, projectId],
  );
  if (grant === undefined) throw new AppError("FORBIDDEN");

  const capabilities = parseScopeJson(membership.capabilities);
  const credentialScopes =
    credential === undefined ? new Set<Scope>() : parseScopeJson(credential.scope_json);
  const now = deps.now();
  const rights = effectiveRights({
    accountStatus: account.status,
    speakerStatus: speaker.status,
    projectStatus: project.status,
    membershipRemovedAt: null,
    membershipCapabilities: [...capabilities],
    credentialScopes: [...credentialScopes],
    // A vanished credential row is treated as revoked.
    credentialExpiresAt: credential === undefined ? null : parseDate(credential.expires_at),
    credentialRevokedAt: credential === undefined ? now : parseDate(credential.revoked_at),
    now,
  });

  authorizeProjectAccess({ isMember: true, membershipRemovedAt: null, rights, scope });
  return { rights, capabilities };
}

// Builds the listing principal for a session. It has no speakerId because the
// dashboard spans every owned speaker; project enumeration ignores it.
export function sessionAccountPrincipal(session: {
  sessionId: string;
  accountId: string;
}): Principal {
  return {
    credentialId: `session:${session.sessionId}`,
    speakerId: "",
    accountId: session.accountId,
    scopes: new Set<Scope>(["project.read"]),
    sessionViewer: true,
  };
}

// Derives the deterministic viewer for one project: the first active,
// non-removed membership (ordered by speaker creation) among speakers owned by
// the account whose capability set includes the requested scope. The union
// across owned speakers is "at least one owned speaker grants it"; a project
// with no such membership is NOT_FOUND, never FORBIDDEN.
export async function resolveSessionViewer(
  deps: ServiceDeps,
  session: { sessionId: string; accountId: string },
  projectId: string,
  scope: Scope,
): Promise<Principal> {
  if (scope !== "project.read" && scope !== "message.read" && scope !== "project.edit") {
    throw new AppError("NOT_FOUND");
  }
  const rows = await deps.db.all<{ speaker_id: string; capabilities: string }>(
    `SELECT m.speaker_id, m.capabilities
       FROM project_memberships m
       JOIN speakers s ON s.id = m.speaker_id
       JOIN accounts a ON a.id = s.owner_account_id
       JOIN projects p ON p.id = m.project_id
      WHERE m.project_id = ? AND s.owner_account_id = ?
        AND m.removed_at IS NULL AND s.status = 'active'
        AND a.status = 'active' AND p.status = 'active'
      ORDER BY s.created_at ASC, s.id ASC`,
    [projectId, session.accountId],
  );
  for (const row of rows) {
    const capabilities = parseScopeJson(row.capabilities);
    if (capabilities.has(scope)) {
      return {
        credentialId: `session:${session.sessionId}`,
        speakerId: row.speaker_id,
        accountId: session.accountId,
        // The session principal carries only the requested read authority.
        scopes: new Set<Scope>([scope]),
        sessionViewer: true,
      };
    }
  }
  throw new AppError("NOT_FOUND");
}
