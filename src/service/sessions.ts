// Human account sessions. The token and CSRF value are opaque random strings
// shown only to the browser; the database stores a public token prefix and
// keyed HMAC verifiers under the existing credential pepper. A session
// authenticates an account, never a speaker, and can never satisfy a bearer
// credential route.
import { hashSecret, randomBase64url, verifySecret } from "../auth/credentials.ts";
import {
  DUMMY_PASSWORD_HASH,
  verifyPasswordHash,
  type PasswordVerifier,
} from "../auth/password.ts";
import { digestsEqual } from "../domain/digest.ts";
import { AppError } from "../domain/errors.ts";
import type { ServiceDeps } from "./auth.ts";

export const SESSION_TOKEN_PREFIX = "cb_sess_";
// Includes the fixed prefix; eight random characters plus the verifier decide
// which candidate row is real, so a collision cannot authenticate.
export const SESSION_PREFIX_LENGTH = 16;
export const SESSION_IDLE_MS = 30 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
export const SESSION_COOKIE_NAME = "__Host-corkboard_session";
export const CSRF_COOKIE_NAME = "corkboard_csrf";
export const CSRF_HEADER_NAME = "x-csrf-token";

const SESSION_TOKEN_RE = /^cb_sess_[A-Za-z0-9_-]{43}$/;
const SESSION_TOKEN_BYTES = 32;
const CSRF_TOKEN_BYTES = 32;

interface AccountRow {
  id: string;
  email: string;
  password_hash: string | null;
  status: string;
}

interface SessionRow {
  id: string;
  account_id: string;
  token_verifier: string;
  csrf_verifier: string;
  last_seen_at: string;
  expires_at: string;
  revoked_at: string | null;
  email: string;
  account_status: string;
}

export interface SessionPrincipal {
  sessionId: string;
  accountId: string;
  email: string;
  /** Keyed verifier of the CSRF value; the raw value is only in the cookie. */
  csrfVerifier: string;
}

export interface SessionLogin {
  token: string;
  csrfToken: string;
  accountId: string;
  email: string;
  expiresAt: Date;
}

export function generateSessionToken(): string {
  return SESSION_TOKEN_PREFIX + randomBase64url(SESSION_TOKEN_BYTES);
}

export function generateCsrfToken(): string {
  return randomBase64url(CSRF_TOKEN_BYTES);
}

// Cookie parsing is deliberately minimal: our values are base64url, so no
// percent-decoding is applied. A malformed/duplicate cookie simply fails the
// token shape check and yields UNAUTHENTICATED.
export function sessionTokenFromCookie(cookieHeader: string | null): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE_NAME) {
      return part.slice(separator + 1).trim();
    }
  }
  return undefined;
}

// Unknown email, wrong password, inactive account, and an account without a
// password hash all verify against a real PBKDF2 hash (the dummy when there is
// no stored one) and return the same UNAUTHENTICATED error.
export async function loginAccount(
  deps: ServiceDeps,
  input: { email: string; password: string },
): Promise<SessionLogin> {
  const account = await deps.db.first<AccountRow>(
    "SELECT id, email, password_hash, status FROM accounts WHERE email = ?",
    [input.email],
  );
  const verifier: PasswordVerifier = deps.passwordVerifier ?? verifyPasswordHash;
  const storedHash = account?.password_hash ?? DUMMY_PASSWORD_HASH;
  const matched = await verifier(input.password, storedHash);
  if (
    account === undefined ||
    account.password_hash === null ||
    account.status !== "active" ||
    !matched
  ) {
    throw new AppError("UNAUTHENTICATED");
  }

  const now = deps.now();
  const token = generateSessionToken();
  const csrfToken = generateCsrfToken();
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await deps.db.run(
    `INSERT INTO sessions
       (id, account_id, token_prefix, token_verifier, csrf_verifier,
        created_at, last_seen_at, expires_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      `sess_${randomBase64url(16)}`,
      account.id,
      token.slice(0, SESSION_PREFIX_LENGTH),
      await hashSecret(token, deps.pepper),
      await hashSecret(csrfToken, deps.pepper),
      now.toISOString(),
      now.toISOString(),
      expiresAt.toISOString(),
    ],
  );
  return { token, csrfToken, accountId: account.id, email: account.email, expiresAt };
}

// Revoked, expired (absolute), idle-expired, unknown, and inactive-account
// sessions all return the same UNAUTHENTICATED error. This read has no side
// effects so a failed CSRF check cannot touch the row.
async function loadSession(
  deps: ServiceDeps,
  token: string | undefined,
): Promise<SessionPrincipal> {
  if (token === undefined || !SESSION_TOKEN_RE.test(token)) {
    throw new AppError("UNAUTHENTICATED");
  }
  const prefix = token.slice(0, SESSION_PREFIX_LENGTH);
  const rows = await deps.db.all<SessionRow>(
    `SELECT s.id, s.account_id, s.token_verifier, s.csrf_verifier, s.last_seen_at,
            s.expires_at, s.revoked_at, a.email, a.status AS account_status
       FROM sessions s
       JOIN accounts a ON a.id = s.account_id
      WHERE s.token_prefix = ?`,
    [prefix],
  );

  let session: SessionRow | undefined;
  for (const row of rows) {
    if (await verifySecret(token, prefix, row.token_verifier, deps.pepper)) {
      session = row;
      break;
    }
  }
  if (session === undefined) throw new AppError("UNAUTHENTICATED");

  const now = deps.now();
  const nowMs = now.getTime();
  const expiresMs = new Date(session.expires_at).getTime();
  const lastSeenMs = new Date(session.last_seen_at).getTime();
  const valid =
    session.revoked_at === null &&
    session.account_status === "active" &&
    Number.isFinite(expiresMs) &&
    Number.isFinite(lastSeenMs) &&
    expiresMs > nowMs &&
    lastSeenMs + SESSION_IDLE_MS > nowMs;
  if (!valid) throw new AppError("UNAUTHENTICATED");

  return {
    sessionId: session.id,
    accountId: session.account_id,
    email: session.email,
    csrfVerifier: session.csrf_verifier,
  };
}

// Accepted requests refresh last_seen lazily; there is no authorization cache.
export async function authenticateSession(
  deps: ServiceDeps,
  token: string | undefined,
): Promise<SessionPrincipal> {
  const principal = await loadSession(deps, token);
  await deps.db.run(
    "UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL",
    [deps.now().toISOString(), principal.sessionId],
  );
  return principal;
}

// The CSRF header is compared as a keyed digest at fixed length. A missing or
// wrong header never revokes; only the presented session row is revoked.
export async function revokeSession(
  deps: ServiceDeps,
  token: string | undefined,
  csrfToken: string | undefined,
): Promise<void> {
  const principal = await loadSession(deps, token);
  if (csrfToken === undefined || csrfToken === "") throw new AppError("FORBIDDEN");
  const presented = await hashSecret(csrfToken, deps.pepper);
  if (!digestsEqual(presented, principal.csrfVerifier)) throw new AppError("FORBIDDEN");

  await deps.db.run(
    "UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    [deps.now().toISOString(), principal.sessionId],
  );
}
