import assert from "node:assert/strict";
import { test } from "node:test";
import { escapeHtml } from "../../src/app/html.ts";
import { normalizeReturnTo } from "../../src/app/web.ts";
import { AppError } from "../../src/domain/errors.ts";

test("escapeHtml escapes every HTML metacharacter exactly once", () => {
  assert.equal(
    escapeHtml(`<script>"x" & 'y'</script>`),
    "&lt;script&gt;&quot;x&quot; &amp; &#39;y&#39;&lt;/script&gt;",
  );
  assert.equal(escapeHtml("plain text"), "plain text");
  // An entity is escaped again, so it cannot become markup by double decoding.
  assert.equal(escapeHtml("&lt;img&gt;"), "&amp;lt;img&amp;gt;");
});

test("normalizeReturnTo accepts only same-origin paths", () => {
  assert.equal(normalizeReturnTo(null), "/");
  assert.equal(normalizeReturnTo(undefined), "/");
  assert.equal(normalizeReturnTo(""), "/");
  assert.equal(normalizeReturnTo("/"), "/");
  assert.equal(normalizeReturnTo("/projects/p?x=1#frag"), "/projects/p?x=1");
  assert.equal(
    normalizeReturnTo("/login?return_to=%2Fprojects%2Fp"),
    "/login?return_to=%2Fprojects%2Fp",
  );
});

test("normalizeReturnTo rejects absolute, scheme-relative, and header-breaking values", () => {
  for (const value of [
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "/\r\nLocation: https://evil.example",
    `/${"a".repeat(2049)}`,
  ]) {
    assert.throws(() => normalizeReturnTo(value), AppError, value);
  }
});
