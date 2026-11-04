import { AppError } from "./errors.ts";
import { digestsEqual, parseSha256Digest, sha256Hex } from "./digest.ts";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const UTF8_ENCODER = new TextEncoder();
const TYPE_IDENTIFIER = /^[a-z][a-z0-9_.-]{0,31}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]{1,128}$/;
// RFC 3339 timestamp with an explicit offset; stored normalized to UTC.
const RFC3339_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_BODY_EXPIRY_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", `${field} must be a string`);
  }
  return value;
}

function graphemeCount(value: string): number {
  return [...GRAPHEME_SEGMENTER.segment(value)].length;
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

export function validateSummary(value: unknown): string {
  const summary = requireString(value, "summary");
  const graphemes = graphemeCount(summary);
  if (graphemes < 1 || graphemes > 140) {
    throw new AppError("VALIDATION_ERROR", "summary must be 1-140 graphemes");
  }
  if (utf8ByteLength(summary) > 1024) {
    throw new AppError("VALIDATION_ERROR", "summary must be at most 1024 UTF-8 bytes");
  }
  return summary;
}

export function validateText(value: unknown): string {
  const text = requireString(value, "text");
  const graphemes = graphemeCount(text);
  if (graphemes < 1 || graphemes > 2000) {
    throw new AppError("VALIDATION_ERROR", "text must be 1-2000 graphemes");
  }
  if (utf8ByteLength(text) > 8192) {
    throw new AppError("VALIDATION_ERROR", "text must be at most 8192 UTF-8 bytes");
  }
  return text;
}

export function validateType(value: unknown): string {
  const type = requireString(value, "type");
  if (!TYPE_IDENTIFIER.test(type)) {
    throw new AppError("VALIDATION_ERROR", "type must match ^[a-z][a-z0-9_.-]{0,31}$");
  }
  return type;
}

export function validateLanguage(value: unknown): string {
  const tag = requireString(value, "language");
  let canonical: string[];
  try {
    canonical = Intl.getCanonicalLocales(tag);
  } catch {
    throw new AppError("VALIDATION_ERROR", "language must be a valid BCP 47 tag");
  }
  const single = canonical[0];
  if (canonical.length !== 1 || single === undefined) {
    throw new AppError("VALIDATION_ERROR", "language must be a single BCP 47 tag");
  }
  return single;
}

export function validateIdempotencyKey(value: unknown): string {
  const key = requireString(value, "Idempotency-Key");
  if (!PRINTABLE_ASCII.test(key)) {
    throw new AppError("VALIDATION_ERROR", "Idempotency-Key must be 1-128 printable ASCII characters");
  }
  return key;
}

export function validateBodyDigest(value: unknown): string {
  return parseSha256Digest(value);
}

// Shape only: callers must validate the time window before a new write. Replays
// of an already accepted request are allowed to carry a now-past expiry.
export function normalizeBodyExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !RFC3339_TIMESTAMP.test(value)) {
    throw new AppError("VALIDATION_ERROR", "body_expires_at must be an RFC 3339 UTC timestamp");
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("VALIDATION_ERROR", "body_expires_at must be a valid timestamp");
  }
  return parsed.toISOString();
}

export function validateBodyExpiresAtWindow(
  bodyExpiresAt: string | null,
  receivedAt: Date,
): void {
  if (bodyExpiresAt === null) return;
  const aheadMs = new Date(bodyExpiresAt).getTime() - receivedAt.getTime();
  if (aheadMs <= 0) {
    throw new AppError("VALIDATION_ERROR", "body_expires_at must be after received_at");
  }
  if (aheadMs > MAX_BODY_EXPIRY_AHEAD_MS) {
    throw new AppError("VALIDATION_ERROR", "body_expires_at must be at most 366 days ahead");
  }
}

export async function verifySenderDigest(text: string, claimed: string): Promise<void> {
  const digest = parseSha256Digest(claimed);
  const actual = `sha256:${await sha256Hex(UTF8_ENCODER.encode(text))}`;
  if (!digestsEqual(actual, digest)) {
    throw new AppError("INTEGRITY_MISMATCH");
  }
}
