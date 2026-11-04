import { credentialIsActive } from "../auth/credentials.ts";
import { AppError } from "./errors.ts";

export const SCOPES = [
  "project.read",
  "message.read",
  "message.send",
  "receipt.write",
  "project.edit",
  "member.read",
  "member.manage",
] as const;

export type Scope = (typeof SCOPES)[number];

const KNOWN_SCOPES: ReadonlySet<string> = new Set(SCOPES);

function isScope(value: string): value is Scope {
  return KNOWN_SCOPES.has(value);
}

export interface EffectiveRightsInput {
  accountStatus: string;
  speakerStatus: string;
  projectStatus: string;
  membershipRemovedAt: Date | null;
  membershipCapabilities: readonly string[];
  credentialScopes: readonly string[];
  credentialExpiresAt: Date | null;
  credentialRevokedAt: Date | null;
  now: Date;
}

export function effectiveRights(input: EffectiveRightsInput): Set<Scope> {
  const active =
    input.accountStatus === "active" &&
    input.speakerStatus === "active" &&
    input.projectStatus === "active" &&
    input.membershipRemovedAt === null &&
    credentialIsActive(
      { expiresAt: input.credentialExpiresAt, revokedAt: input.credentialRevokedAt },
      input.now,
    );
  if (!active) return new Set<Scope>();

  const capabilities = new Set<Scope>();
  for (const capability of input.membershipCapabilities) {
    if (isScope(capability)) capabilities.add(capability);
  }

  const rights = new Set<Scope>();
  for (const scope of input.credentialScopes) {
    if (isScope(scope) && capabilities.has(scope)) rights.add(scope);
  }
  return rights;
}

export function requireScope(rights: ReadonlySet<Scope>, scope: Scope): void {
  if (!rights.has(scope)) throw new AppError("FORBIDDEN");
}

export interface ProjectAccessInput {
  isMember: boolean;
  membershipRemovedAt: Date | null;
  rights: ReadonlySet<Scope>;
  scope: Scope;
}

export function authorizeProjectAccess(input: ProjectAccessInput): void {
  // A removed membership is not visible: same answer as a non-member.
  if (!input.isMember || input.membershipRemovedAt !== null) throw new AppError("NOT_FOUND");
  requireScope(input.rights, input.scope);
}
