// Node-only compatibility for installations bootstrapped before the portable
// session KDF. Core code never imports node:crypto; new hashes are always
// PBKDF2. Unknown formats fail closed through the core verifier.
import { scryptSync, timingSafeEqual } from "node:crypto";
import { verifyPasswordHash, type PasswordVerifier } from "../../auth/password.ts";

const SCRYPT_PREFIX = "scrypt$";
const SCRYPT_KEY_BYTES = 64;

function verifyLegacyScrypt(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  try {
    const salt = Buffer.from(parts[1] ?? "", "base64");
    const expected = Buffer.from(parts[2] ?? "", "base64");
    if (salt.length === 0 || expected.length !== SCRYPT_KEY_BYTES) return false;
    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export const nodePasswordVerifier: PasswordVerifier = async (
  password: string,
  storedHash: string,
): Promise<boolean> => {
  if (storedHash.startsWith(SCRYPT_PREFIX)) {
    return verifyLegacyScrypt(password, storedHash);
  }
  return verifyPasswordHash(password, storedHash);
};
