import { AppError } from "./errors.ts";

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toHex(new Uint8Array(digest));
}

export function parseSha256Digest(value: unknown): string {
  if (typeof value !== "string" || !SHA256_DIGEST.test(value)) {
    throw new AppError("VALIDATION_ERROR", "body_digest must be sha256:<64 lowercase hex>");
  }
  return value;
}

// Length is public; compare equal-length values without early exit.
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) {
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return difference === 0;
}
