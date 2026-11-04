import { digestsEqual } from "../domain/digest.ts";

const TOKEN_PREFIX = "cb_";
const SECRET_BYTES = 32;
const PUBLIC_PREFIX_LENGTH = 12;

const UTF8_ENCODER = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

/** Opaque random value for session/CSRF tokens; never reused for bearer keys. */
export function randomBase64url(byteLength: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

export function generateSpeakerToken(): { token: string; publicPrefix: string } {
  const token = TOKEN_PREFIX + randomBase64url(SECRET_BYTES);
  return { token, publicPrefix: token.slice(0, PUBLIC_PREFIX_LENGTH) };
}

export async function hashSecret(secret: string, pepper: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    pepper,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, UTF8_ENCODER.encode(secret));
  return toHex(new Uint8Array(signature));
}

export async function verifySecret(
  secret: string,
  publicPrefix: string,
  verifier: string,
  pepper: Uint8Array,
): Promise<boolean> {
  if (!secret.startsWith(publicPrefix)) return false;
  return digestsEqual(await hashSecret(secret, pepper), verifier);
}

export interface CredentialState {
  expiresAt: Date | null;
  revokedAt: Date | null;
}

export function credentialIsActive(credential: CredentialState, now: Date): boolean {
  if (credential.revokedAt !== null) return false;
  return credential.expiresAt === null || credential.expiresAt.getTime() > now.getTime();
}
