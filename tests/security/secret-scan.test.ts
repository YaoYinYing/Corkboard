import assert from "node:assert/strict";
import { test } from "node:test";
import { findSecrets } from "../../scripts/secret-scan.ts";

// Matchable values are assembled so this file does not itself trip the scanner.
test("flags URL-embedded credentials", () => {
  const sample = "proxy http://" + "user:hunter2" + "@host:8080";
  const names = findSecrets(sample).map((f) => f.name);
  assert.ok(names.includes("url-credentials"));
  assert.ok(names.includes("url-userinfo"));
  assert.equal(findSecrets("proxy http://" + "short" + "@host").length, 1);
});

test("flags real-shaped secrets but not placeholders", () => {
  assert.equal(findSecrets("token cb_" + "a".repeat(40)).length, 1);
  assert.equal(findSecrets("CORKBOARD_ROOT_KEY=" + "A".repeat(44)).length, 1);
  assert.equal(findSecrets('CORKBOARD_APIKEY="' + "A".repeat(44) + '"').length, 1);
  assert.equal(findSecrets("sk-proj-" + "A".repeat(48)).length, 1);
  assert.equal(findSecrets("sk-svcacct-" + "A".repeat(48)).length, 1);
  assert.equal(findSecrets("http://[REDACTED]@localhost:10099").length, 0);
  assert.equal(findSecrets("token cb_...").length, 0);
  assert.equal(findSecrets("CORKBOARD_DATA_DIR=/var/lib/corkboard").length, 0);
});

test("reports the line number without the value", () => {
  const findings = findSecrets("clean\nghp_" + "a".repeat(36) + "\nclean");
  assert.deepEqual(findings, [{ line: 2, name: "github-token" }]);
});
