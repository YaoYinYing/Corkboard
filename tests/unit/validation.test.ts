import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError, httpStatusFor, type ErrorCode } from "../../src/domain/errors.ts";
import { digestsEqual, parseSha256Digest, sha256Hex } from "../../src/domain/digest.ts";
import {
  validateBodyDigest,
  validateClientSentAt,
  validateIdempotencyKey,
  validateLanguage,
  validateMessageSummary,
  validateMessageText,
  validateProjectSummary,
  validateProjectTitle,
  validateSummary,
  validateText,
  validateType,
  verifySenderDigest,
} from "../../src/domain/validation.ts";

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}

const UTF8 = new TextEncoder();

test("sha256Hex matches a known vector and encodes UTF-8", async () => {
  assert.equal(
    await sha256Hex(UTF8.encode("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  assert.equal(await sha256Hex(UTF8.encode("é")), await sha256Hex(new Uint8Array([0xc3, 0xa9])));
});

test("digestsEqual compares equal-length values and rejects length mismatch", () => {
  const digest = "sha256:" + "a".repeat(64);
  assert.equal(digestsEqual(digest, digest), true);
  assert.equal(digestsEqual("sha256:" + "a".repeat(63), "sha256:" + "a".repeat(64)), false);
  assert.equal(digestsEqual("sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)), false);
});

test("parseSha256Digest accepts only canonical sha256 digests", () => {
  const valid = "sha256:" + "0123456789abcdef".repeat(4);
  assert.equal(parseSha256Digest(valid), valid);
  for (const bad of [
    "sha256:" + "0123456789ABCDEF".repeat(4),
    "sha256:" + "g".repeat(64),
    "sha256:" + "a".repeat(63),
    "sha256:" + "a".repeat(65),
    "SHA256:" + "a".repeat(64),
    "md5:" + "a".repeat(32),
    "",
    null,
    123,
  ]) {
    assert.throws(() => parseSha256Digest(bad), hasCode("VALIDATION_ERROR"));
  }
});

test("summary counts graphemes, not UTF-16 code units", () => {
  const combining = "é"; // 1 grapheme, 2 UTF-16 code units
  assert.equal(validateSummary(combining), combining);
  assert.equal(validateSummary(combining.repeat(140)), combining.repeat(140));
  assert.equal(validateSummary("😀"), "😀");
  assert.equal(validateSummary("👨‍👩‍👧‍👦"), "👨‍👩‍👧‍👦");
  assert.equal(validateSummary("😀".repeat(140)), "😀".repeat(140));
  assert.equal(validateSummary("𠀀".repeat(140)), "𠀀".repeat(140));
  assert.throws(() => validateSummary("😀".repeat(141)), hasCode("VALIDATION_ERROR"));
});

test("summary enforces the UTF-8 byte cap without truncating", () => {
  const cluster = "a" + "́".repeat(5); // 1 grapheme, 11 bytes
  assert.equal(validateSummary(cluster), cluster);
  const tooManyBytes = cluster.repeat(140); // 140 graphemes, 1540 bytes
  assert.throws(() => validateSummary(tooManyBytes), hasCode("VALIDATION_ERROR"));
});

test("summary rejects empty and non-string input", () => {
  for (const bad of ["", null, 1, {}, ["text"]]) {
    assert.throws(() => validateSummary(bad), hasCode("VALIDATION_ERROR"));
  }
});

test("message summary rejects blank values but preserves non-blank content", () => {
  for (const blank of [
    " ",
    "   ",
    "\t",
    "\n",
    "\r\n",
    " \t\n ",
    "\u00a0", // NBSP
    "\u3000", // ideographic space
    "\ufeff", // BOM / zero-width no-break space
    "\u0085", // NEL
    "\u200b", // zero-width space
    "\u200b\u200c\u200d\u2060\ufe0f", // all default-ignorable
  ]) {
    assert.throws(
      () => validateMessageSummary(blank),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "VALIDATION_ERROR" &&
        error.message === "summary must not be blank",
    );
  }
  // Length errors keep precedence over the blank rule.
  assert.throws(() => validateMessageSummary(" ".repeat(141)), /1-140 graphemes/);
  // A lone combining mark is outside both blank categories.
  assert.equal(validateMessageSummary("\u0301"), "\u0301");
  // Characters outside the blank categories are accepted as-is.
  assert.equal(validateMessageSummary("\u2800"), "\u2800"); // braille blank
  // Values are rejected, never trimmed: non-blank content is returned as entered.
  for (const valid of ["a b", "line1\nline2", " a ", "\ta\t"]) {
    assert.equal(validateMessageSummary(valid), valid);
  }
});

test("text counts graphemes and enforces both caps", () => {
  assert.equal(validateText("x"), "x");
  assert.equal(validateText("😀"), "😀");
  assert.equal(validateText("x".repeat(2000)), "x".repeat(2000));
  assert.equal(validateText("😀".repeat(2000)), "😀".repeat(2000)); // 8000 bytes
  assert.equal(validateText("𠀀".repeat(2000)), "𠀀".repeat(2000)); // 8000 bytes
  assert.throws(() => validateText("x".repeat(2001)), hasCode("VALIDATION_ERROR"));
  assert.throws(() => validateText("😀".repeat(2001)), hasCode("VALIDATION_ERROR"));
  assert.throws(() => validateText(""), hasCode("VALIDATION_ERROR"));

  const heavyCluster = "𠀀́"; // 1 grapheme, 6 bytes
  assert.throws(() => validateText(heavyCluster.repeat(2000)), hasCode("VALIDATION_ERROR")); // 12000 bytes
  assert.throws(() => validateText(42), hasCode("VALIDATION_ERROR"));
});

test("message text rejects blank values but preserves non-blank content", () => {
  for (const blank of [
    " ",
    "   ",
    "\t",
    "\n",
    "\r\n",
    " \t\n ",
    "\u00a0", // NBSP
    "\u3000", // ideographic space
    "\ufeff", // BOM / zero-width no-break space
    "\u0085", // NEL
    "\u200b", // zero-width space
    "\u200b\u200c\u200d\u2060\ufe0f", // all default-ignorable
  ]) {
    assert.throws(
      () => validateMessageText(blank),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === "VALIDATION_ERROR" &&
        error.message === "text must not be blank",
    );
  }
  // Length errors keep precedence over the blank rule: a selector run is one
  // grapheme but 8196 UTF-8 bytes.
  assert.throws(() => validateMessageText(" ".repeat(2001)), /1-2000 graphemes/);
  assert.throws(() => validateMessageText("\u{E0100}".repeat(2049)), /at most 8192 UTF-8 bytes/);
  // A lone combining mark is outside both blank categories.
  assert.equal(validateMessageText("\u0301"), "\u0301");
  // Values are rejected, never trimmed: non-blank content is returned as entered.
  for (const valid of ["a b", "line1\nline2", " a ", "\ta\t"]) {
    assert.equal(validateMessageText(valid), valid);
  }
});

test("project metadata keeps its base blank handling, not the message rule", () => {
  // A ZWSP-only title/summary remains non-blank under the prior length rules.
  assert.equal(validateProjectTitle("\u200b"), "\u200b");
  assert.equal(validateProjectSummary("\u200b"), "\u200b");
  assert.equal(validateSummary("\u200b"), "\u200b");
  // A trim()-blank title still reports the title field; a blank summary is NULL.
  assert.throws(() => validateProjectTitle("\u00a0"), /title must not be blank/);
  assert.equal(validateProjectSummary("\u00a0"), null);
});

test("type follows the documented identifier pattern", () => {
  for (const good of ["request", "a", "a".repeat(32), "msg.v2-beta_1", "status.update"]) {
    assert.equal(validateType(good), good);
  }
  for (const bad of ["", "Request", "9abc", "a".repeat(33), "a b", "tag!", "é", null]) {
    assert.throws(() => validateType(bad), hasCode("VALIDATION_ERROR"));
  }
});

test("language is canonicalized as a single BCP 47 tag", () => {
  assert.equal(validateLanguage("en"), "en");
  assert.equal(validateLanguage("EN-us"), "en-US");
  assert.equal(validateLanguage("zh-hant-tw"), "zh-Hant-TW");
  for (const bad of ["", "en_US", "not a locale", "e", "en-US-", ["en", "fr"], null]) {
    assert.throws(() => validateLanguage(bad), hasCode("VALIDATION_ERROR"));
  }
});

test("idempotency keys are 1-128 printable ASCII characters", () => {
  assert.equal(validateIdempotencyKey("x"), "x");
  assert.equal(validateIdempotencyKey("!".repeat(128)), "!".repeat(128));
  for (const bad of ["", " ".repeat(4), "a b", "a\tb", "é", "x".repeat(129), null]) {
    assert.throws(() => validateIdempotencyKey(bad), hasCode("VALIDATION_ERROR"));
  }
});

test("validateBodyDigest delegates to the canonical parser", () => {
  const valid = "sha256:" + "ab".repeat(32);
  assert.equal(validateBodyDigest(valid), valid);
  assert.throws(() => validateBodyDigest("sha256:short"), hasCode("VALIDATION_ERROR"));
});

test("validateClientSentAt accepts bounded RFC 3339 timestamps and retains the value", () => {
  assert.equal(validateClientSentAt(undefined), null);
  assert.equal(validateClientSentAt(null), null);
  for (const valid of [
    "2026-11-04T12:00:00Z",
    "2026-11-04T12:00:00.000Z",
    "2026-11-04T12:00:00.123456789Z",
    "2026-11-04T12:00:00+02:00",
    "2024-02-29T23:59:59-05:30",
  ]) {
    assert.equal(validateClientSentAt(valid), valid);
  }
  for (const invalid of [
    "",
    "yesterday",
    "2026-11-04",
    "2026-11-04 12:00:00Z",
    "2026-02-30T00:00:00Z",
    "2026-11-04T24:00:00Z",
    "2026-11-04T12:60:00Z",
    "2026-11-04T12:00:60Z",
    "2026-11-04T12:00:00+24:00",
    "2026-11-04T12:00:00.Z",
    "2026-11-04T12:00:00",
    `${"2026-11-04T12:00:00Z"}${"x".repeat(50)}`,
  ]) {
    assert.throws(() => validateClientSentAt(invalid), hasCode("VALIDATION_ERROR"), invalid);
  }
  assert.throws(() => validateClientSentAt(123), hasCode("VALIDATION_ERROR"));
});

test("verifySenderDigest accepts the matching UTF-8 digest and rejects mismatches", async () => {
  const text = "héllo 😀";
  const digest = `sha256:${await sha256Hex(UTF8.encode(text))}`;
  await assert.doesNotReject(verifySenderDigest(text, digest));

  const wrong = `sha256:${await sha256Hex(UTF8.encode(text + "!"))}`;
  await assert.rejects(verifySenderDigest(text, wrong), hasCode("INTEGRITY_MISMATCH"));
  await assert.rejects(verifySenderDigest(text, "not-a-digest"), hasCode("VALIDATION_ERROR"));
});

test("AppError maps every stable code to an HTTP status", () => {
  const expected: ReadonlyArray<[ErrorCode, number]> = [
    ["UNAUTHENTICATED", 401],
    ["FORBIDDEN", 403],
    ["NOT_FOUND", 404],
    ["VALIDATION_ERROR", 400],
    ["CONFLICT", 409],
    ["RATE_LIMITED", 429],
    ["BODY_EXPIRED", 410],
    ["REQUEST_TOO_LARGE", 413],
    ["UNAVAILABLE", 503],
    ["INTEGRITY_MISMATCH", 400],
    ["INTEGRITY_FAILURE", 500],
  ];
  for (const [code, status] of expected) {
    const error = new AppError(code);
    assert.equal(error.code, code);
    assert.equal(error.httpStatus, status);
    assert.equal(httpStatusFor(code), status);
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AppError");
    assert.ok(error.message.length > 0);
  }
});
