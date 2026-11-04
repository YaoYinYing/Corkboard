// Shared principal identity read used by REST /me and the MCP whoami tool.
// This is presentation data, not an authorization decision.
import { SCOPES, type Scope } from "../domain/authz.ts";
import type { Principal, ServiceDeps } from "./auth.ts";

export interface PrincipalIdentity {
  speaker: { id: string; display_name: string };
  account: { id: string };
  scopes: Scope[];
}

export async function getPrincipalIdentity(
  deps: ServiceDeps,
  principal: Principal,
): Promise<PrincipalIdentity> {
  const speaker = await deps.db.first<{ display_name: string | null }>(
    "SELECT display_name FROM speakers WHERE id = ?",
    [principal.speakerId],
  );
  return {
    speaker: {
      id: principal.speakerId,
      display_name: speaker?.display_name ?? principal.speakerId,
    },
    account: { id: principal.accountId },
    scopes: SCOPES.filter((scope) => principal.scopes.has(scope)),
  };
}
