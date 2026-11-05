import { AppError } from "./errors.ts";
import { digestsEqual, parseSha256Digest, sha256Hex } from "./digest.ts";

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const UTF8_ENCODER = new TextEncoder();
const TYPE_IDENTIFIER = /^[a-z][a-z0-9_.-]{0,31}$/;
const PRINTABLE_ASCII = /^[\x21-\x7e]{1,128}$/;
// Accepted subset: RFC 3339 UTC `Z` only, no offsets, seconds 00-59 (no leap
// second), and 1-3 fractional digits when present. Components are validated by
// round-trip so impossible calendar dates cannot roll over.
const RFC3339_UTC_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_BODY_EXPIRY_AHEAD_MS = 366 * 24 * 60 * 60 * 1000;
// Plaintext body cap. A stored CB01 blob adds only a frame, AES-GCM tag, and
// small JSON header; backup bounds derive from this value.
export const MAX_TEXT_BYTES = 8192;
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254;
const MAX_LOGIN_PASSWORD_BYTES = 1024;
// "Blank" means only Unicode White_Space and/or Default_Ignorable_Code_Point
// characters (NBSP, NEL, ideographic space, ZWSP, ZWJ/ZWNJ, word joiner,
// variation selectors, BOM, ...). A lone combining mark is not blank.
const BLANK_CONTENT = /^[\p{White_Space}\p{Default_Ignorable_Code_Point}]*$/u;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function parseUtcTimestamp(value: string): Date | undefined {
  const match = RFC3339_UTC_TIMESTAMP.exec(value);
  if (match === null) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const milliseconds = fraction === "" ? 0 : Number(fraction.padEnd(3, "0"));

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, milliseconds);
  // Rollover (for example Feb 30) changes a component; reject it explicitly.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    date.getUTCMilliseconds() !== milliseconds
  ) {
    return undefined;
  }
  return date;
}

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

// Project metadata reuses the message-summary bounds rather than introducing a
// second length rule. A title is required and must not be blank; a blank
// summary is stored as SQL NULL.
export function validateProjectTitle(value: unknown): string {
  const title = requireString(value, "title");
  if (title.trim() === "") {
    throw new AppError("VALIDATION_ERROR", "title must not be blank");
  }
  return validateSummary(title);
}

export function validateProjectSummary(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const summary = requireString(value, "summary");
  if (summary.trim() === "") return null;
  return validateSummary(summary);
}

export function validateText(value: unknown): string {
  const text = requireString(value, "text");
  const graphemes = graphemeCount(text);
  if (graphemes < 1 || graphemes > 2000) {
    throw new AppError("VALIDATION_ERROR", "text must be 1-2000 graphemes");
  }
  if (utf8ByteLength(text) > MAX_TEXT_BYTES) {
    throw new AppError("VALIDATION_ERROR", `text must be at most ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  return text;
}

// Message content only. Project title/summary keep the length-only
// `validateSummary` behavior documented for project metadata.
export function validateMessageSummary(value: unknown): string {
  const summary = validateSummary(value);
  if (BLANK_CONTENT.test(summary)) {
    throw new AppError("VALIDATION_ERROR", "summary must not be blank");
  }
  return summary;
}

export function validateMessageText(value: unknown): string {
  const text = validateText(value);
  if (BLANK_CONTENT.test(text)) {
    throw new AppError("VALIDATION_ERROR", "text must not be blank");
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

// Shared by CLI bootstrap and HTTP login so the stored and looked-up forms
// cannot drift. The shape check intentionally matches the pre-session CLI.
export function normalizeEmail(value: unknown, field = "email"): string {
  const email = requireString(value, field).trim().toLowerCase();
  if (email.length > MAX_EMAIL_LENGTH || !EMAIL_SHAPE.test(email)) {
    throw new AppError("VALIDATION_ERROR", `${field} is not a valid email`);
  }
  return email;
}

// Passwords are opaque bytes for PBKDF2; only the type and a DoS cap are
// validated. Wrong or empty values remain a uniform authentication failure.
export function validateLoginPassword(value: unknown): string {
  const password = requireString(value, "password");
  if (UTF8_ENCODER.encode(password).length > MAX_LOGIN_PASSWORD_BYTES) {
    throw new AppError("VALIDATION_ERROR", "password must be at most 1024 UTF-8 bytes");
  }
  return password;
}

// Shape only: callers must validate the time window before a new write. Replays
// of an already accepted request are allowed to carry a now-past expiry.
export function normalizeBodyExpiresAt(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new AppError("VALIDATION_ERROR", "body_expires_at must be an RFC 3339 UTC timestamp");
  }
  const parsed = parseUtcTimestamp(value);
  if (parsed === undefined) {
    throw new AppError(
      "VALIDATION_ERROR",
      "body_expires_at must be a valid RFC 3339 UTC timestamp with seconds 00-59",
    );
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
