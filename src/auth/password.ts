// Portable password hashing. PBKDF2-HMAC-SHA-256 through WebCrypto only, so the
// core stays Workers-compatible. Stored format:
//   pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
// The iteration count is part of the stored value, so an old hash keeps
// verifying after the default is raised. Unknown formats fail closed.
import { digestsEqual } from "../domain/digest.ts";

export const PASSWORD_KDF_NAME = "pbkdf2-sha256";
export const PASSWORD_KDF_ITERATIONS = 600_000;
export const PASSWORD_SALT_BYTES = 16;
export const PASSWORD_HASH_BYTES = 32;
// Reject implausible stored iteration counts instead of spending unbounded CPU.
const MAX_ITERATIONS = 5_000_000;

const ENCODER = new TextEncoder();

export type PasswordVerifier = (password: string, storedHash: string) => Promise<boolean>;

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeBase64(value: string): Uint8Array | undefined {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function derive(
  password: string,
  salt: Uint8Array,
  iterations: number,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    ENCODER.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PASSWORD_SALT_BYTES));
  const hash = await derive(password, salt, PASSWORD_KDF_ITERATIONS, PASSWORD_HASH_BYTES);
  return `${PASSWORD_KDF_NAME}$${PASSWORD_KDF_ITERATIONS}$${base64(salt)}$${base64(hash)}`;
}

export async function verifyPasswordHash(
  password: string,
  storedHash: string,
): Promise<boolean> {
  const parts = storedHash.split("$");
  if (parts.length !== 4 || parts[0] !== PASSWORD_KDF_NAME) return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_ITERATIONS) {
    return false;
  }
  const salt = decodeBase64(parts[2] ?? "");
  const expected = decodeBase64(parts[3] ?? "");
  if (
    salt === undefined ||
    expected === undefined ||
    salt.length !== PASSWORD_SALT_BYTES ||
    expected.length !== PASSWORD_HASH_BYTES
  ) {
    return false;
  }
  const actual = await derive(password, salt, iterations, expected.length);
  // Fixed-length hex comparison; no early exit.
  return digestsEqual(toHex(actual), toHex(expected));
}

// Verified against for unknown emails and accounts without a password so those
// failures perform the same PBKDF2 work as a wrong password. It is not a usable
// credential: no password derives to the all-zero hash.
export const DUMMY_PASSWORD_HASH =
  `${PASSWORD_KDF_NAME}$${PASSWORD_KDF_ITERATIONS}$${base64(
    new Uint8Array(PASSWORD_SALT_BYTES),
  )}$${base64(new Uint8Array(PASSWORD_HASH_BYTES))}`;
