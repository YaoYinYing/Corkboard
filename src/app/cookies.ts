// Cookie formatting shared by the session and OAuth form handlers. Values are
// server-generated base64url tokens; no user-controlled text is interpolated.
import { CSRF_COOKIE_NAME, SESSION_ABSOLUTE_MS, SESSION_COOKIE_NAME } from "../service/sessions.ts";

export const SESSION_MAX_AGE_SECONDS = SESSION_ABSOLUTE_MS / 1000;
const COOKIE_EXPIRY_EPOCH = "Thu, 01 Jan 1970 00:00:00 GMT";

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE_NAME}=${token}; Path=/; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE_SECONDS}`;
}

export function clearedCookie(name: string, httpOnly: boolean): string {
  const httpOnlyFlag = httpOnly ? "HttpOnly; " : "";
  return `${name}=; Path=/; ${httpOnlyFlag}Secure; SameSite=Strict; Max-Age=0; Expires=${COOKIE_EXPIRY_EPOCH}`;
}

// Short-lived double-submit value for the HTML sign-in form. Path-scoped to the
// OAuth pages; HttpOnly keeps it out of any script while the server still
// renders it into the hidden form field.
export function loginCsrfCookie(value: string): string {
  return `corkboard_oauth_login=${value}; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`;
}

export function clearedLoginCsrfCookie(): string {
  return `corkboard_oauth_login=; Path=/oauth; HttpOnly; Secure; SameSite=Lax; Max-Age=0; Expires=${COOKIE_EXPIRY_EPOCH}`;
}
