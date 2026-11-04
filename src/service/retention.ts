// Operator-driven, bounded retention for session and OAuth artifacts. There is
// no timer and no automatic deletion: this runs only when an operator invokes
// the `prune` command. It never touches messages, receipts, blobs, audit events,
// speaker credentials, or any token/credential that is still usable.
import type { SqlDatabase } from "../storage/db.ts";
import { SESSION_IDLE_MS } from "./sessions.ts";

export const RETENTION_DEFAULT_GRACE_HOURS = 24;
export const RETENTION_DEFAULT_LIMIT = 1000;
export const RETENTION_MAX_LIMIT = 10_000;

const HOUR_MS = 60 * 60 * 1000;
// Largest magnitude a JS Date can represent. A larger grace cannot produce a
// cutoff ISO string, so reject it before the CLI opens the database. The bound
// also reserves the session idle window, so an accepted grace cannot overflow
// the idle cutoff for a normal clock after the database is open.
const MAX_DATE_MS = 8_640_000_000_000_000;
const MAX_GRACE_MS = MAX_DATE_MS - SESSION_IDLE_MS;

export interface RetentionDeps {
  db: SqlDatabase;
  now: () => Date;
}

export interface RetentionOptions {
  /** Hours an artifact must have been unusable before it is eligible. */
  graceHours?: number;
  /** Maximum rows deleted per table in one run. */
  limit?: number;
}

export interface RetentionSummary {
  graceHours: number;
  limit: number;
  sessions: number;
  authorizationCodes: number;
  refreshTokens: number;
  tokenClients: number;
  oauthCredentials: number;
}

export function validateRetentionOptions(
  options: RetentionOptions = {},
): { graceHours: number; limit: number } {
  const graceHours = options.graceHours ?? RETENTION_DEFAULT_GRACE_HOURS;
  const graceMs = graceHours * HOUR_MS;
  if (
    typeof graceHours !== "number" ||
    !Number.isFinite(graceHours) ||
    graceHours < 0 ||
    !Number.isFinite(graceMs) ||
    graceMs > MAX_GRACE_MS
  ) {
    throw new RangeError(
      "graceHours must be a finite non-negative number of hours within the representable date range",
    );
  }
  const limit = options.limit ?? RETENTION_DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > RETENTION_MAX_LIMIT) {
    throw new RangeError(`limit must be an integer 1-${RETENTION_MAX_LIMIT}`);
  }
  return { graceHours, limit };
}

// FK-safe order inside one BEGIN IMMEDIATE transaction. The write lock makes
// the eligible-credential read stable, and every delete re-checks its own
// predicate, so a concurrent run cannot make a row eligible between checks.
// A second run therefore finds nothing left to delete.
export async function pruneRetention(
  deps: RetentionDeps,
  options: RetentionOptions = {},
): Promise<RetentionSummary> {
  const { graceHours, limit } = validateRetentionOptions(options);
  const nowMs = deps.now().getTime();
  if (!Number.isFinite(nowMs)) {
    throw new RangeError("now must be a valid date");
  }
  const graceMs = graceHours * HOUR_MS;
  const idleCutoffMs = nowMs - graceMs - SESSION_IDLE_MS;
  if (!Number.isFinite(idleCutoffMs) || Math.abs(idleCutoffMs) > MAX_DATE_MS) {
    throw new RangeError("graceHours is too large");
  }
  const cutoff = new Date(nowMs - graceMs).toISOString();
  // A session is idle-expired when last_seen_at + SESSION_IDLE_MS <= now; it is
  // past the grace period when that instant is <= now - grace.
  const idleCutoff = new Date(idleCutoffMs).toISOString();

  const summary: RetentionSummary = {
    graceHours,
    limit,
    sessions: 0,
    authorizationCodes: 0,
    refreshTokens: 0,
    tokenClients: 0,
    oauthCredentials: 0,
  };

  await deps.db.exec("BEGIN IMMEDIATE");
  try {
    // Codes reference sessions, so they go first. Consumed or expired codes are
    // single-use/inert; nothing unconsumed and unexpired is eligible.
    summary.authorizationCodes = (
      await deps.db.run(
        `DELETE FROM oauth_authorization_codes
          WHERE id IN (
            SELECT id FROM oauth_authorization_codes
             WHERE (consumed_at IS NOT NULL AND consumed_at <= ?)
                OR (expires_at <= ?)
             ORDER BY id
             LIMIT ?
          )`,
        [cutoff, cutoff, limit],
      )
    ).changes;

    // Expired, revoked, and rotated refresh rows are all unusable. Deleting
    // them first also releases credentials that no longer have a live family.
    summary.refreshTokens = (
      await deps.db.run(
        `DELETE FROM oauth_refresh_tokens
          WHERE id IN (
            SELECT id FROM oauth_refresh_tokens
             WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
                OR (rotated_at IS NOT NULL AND rotated_at <= ?)
                OR (expires_at <= ?)
             ORDER BY id
             LIMIT ?
          )`,
        [cutoff, cutoff, cutoff, limit],
      )
    ).changes;

    // Only credentials with an oauth_token_clients association are OAuth access
    // tokens; a `cb_` speaker credential never has one. A credential is deleted
    // only when no refresh row still references it (FK safety).
    const oauthCredentials = await deps.db.all<{ id: string }>(
      `SELECT c.id
         FROM credentials c
         JOIN oauth_token_clients t ON t.credential_id = c.id
        WHERE ((c.revoked_at IS NOT NULL AND c.revoked_at <= ?)
            OR (c.expires_at IS NOT NULL AND c.expires_at <= ?))
          AND NOT EXISTS (
            SELECT 1 FROM oauth_refresh_tokens r WHERE r.credential_id = c.id
          )
        ORDER BY c.id
        LIMIT ?`,
      [cutoff, cutoff, limit],
    );

    for (const row of oauthCredentials) {
      await deps.db.run(
        "DELETE FROM credential_project_grants WHERE credential_id = ?",
        [row.id],
      );
      summary.tokenClients += (
        await deps.db.run("DELETE FROM oauth_token_clients WHERE credential_id = ?", [
          row.id,
        ])
      ).changes;
      summary.oauthCredentials += (
        await deps.db.run(
          `DELETE FROM credentials
            WHERE id = ?
              AND ((revoked_at IS NOT NULL AND revoked_at <= ?)
                OR (expires_at IS NOT NULL AND expires_at <= ?))
              AND NOT EXISTS (
                SELECT 1 FROM oauth_refresh_tokens r WHERE r.credential_id = credentials.id
              )`,
          [row.id, cutoff, cutoff],
        )
      ).changes;
    }

    // True orphan associations only. An association for a credential row that
    // still exists is the durable ownership proof used by RFC 7009 revocation
    // and the marker that lets a later run delete that credential. Removing it
    // while a live refresh row exists would let refresh rewrite the credential
    // in place, make access-token revocation a silent no-op, and leave the
    // credential permanently unprunable. Associations for revoked/expired
    // credentials without a refresh row were already removed with the
    // credential above. The remaining-limit bound keeps this table within
    // `limit` overall.
    const remaining = limit - summary.tokenClients;
    if (remaining > 0) {
      summary.tokenClients += (
        await deps.db.run(
          `DELETE FROM oauth_token_clients
            WHERE credential_id IN (
              SELECT t.credential_id
                FROM oauth_token_clients t
               WHERE NOT EXISTS (
                 SELECT 1 FROM credentials c WHERE c.id = t.credential_id
               )
               ORDER BY t.credential_id
               LIMIT ?
            )`,
          [remaining],
        )
      ).changes;
    }

    // Sessions last (codes that reference them are already gone). The NOT EXISTS
    // guard keeps an unexpected surviving code from aborting the transaction;
    // such a session is retained for a later run.
    summary.sessions = (
      await deps.db.run(
        `DELETE FROM sessions
          WHERE id IN (
            SELECT s.id FROM sessions s
             WHERE ((s.revoked_at IS NOT NULL AND s.revoked_at <= ?)
                 OR (s.expires_at <= ?)
                 OR (s.last_seen_at <= ?))
               AND NOT EXISTS (
                 SELECT 1 FROM oauth_authorization_codes c WHERE c.session_id = s.id
               )
             ORDER BY s.id
             LIMIT ?
          )`,
        [cutoff, cutoff, idleCutoff, limit],
      )
    ).changes;

    await deps.db.exec("COMMIT");
  } catch (error) {
    try {
      await deps.db.exec("ROLLBACK");
    } catch {
      // A failed statement may already have ended the transaction.
    }
    throw error;
  }

  return summary;
}
