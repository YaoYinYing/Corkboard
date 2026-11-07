import assert from "node:assert/strict";
import { test } from "node:test";
import {
  REQUIRED_CHECK_IDS,
  childEnv,
  parseSecretsFile,
  redactSensitive,
  secretsFileContent,
} from "../../scripts/disaster-rehearsal.ts";

test("redactSensitive removes every occurrence, longest value first", () => {
  const longer = "cb_examplelongtokenvalue";
  const shorter = "cb_examplelong";
  const text = `one ${longer} two ${shorter} three ${longer}`;
  const redacted = redactSensitive(text, [shorter, longer]);
  assert.equal(redacted.includes(longer), false);
  assert.equal(redacted.includes(shorter), false);
  assert.equal(redacted, "one [REDACTED] two [REDACTED] three [REDACTED]");
  assert.equal(redactSensitive("no secrets here", ["absent"]), "no secrets here");
});

test("parseSecretsFile reads init-style quoted assignments and ignores comments", () => {
  const parsed = parseSecretsFile(
    [
      "# generated",
      "CORKBOARD_ROOT_KEY=AAAA",
      "CORKBOARD_CREDENTIAL_PEPPER='BBBB'",
      "CORKBOARD_DATA_DIR='/tmp/it'\\''s data'",
      "",
      "IGNORED",
    ].join("\n"),
  );
  assert.deepEqual(parsed, {
    CORKBOARD_ROOT_KEY: "AAAA",
    CORKBOARD_CREDENTIAL_PEPPER: "BBBB",
    CORKBOARD_DATA_DIR: "/tmp/it's data",
  });
});

test("secretsFileContent round-trips through parseSecretsFile", () => {
  const secrets = {
    CORKBOARD_ROOT_KEY: "root-value",
    CORKBOARD_CREDENTIAL_PEPPER: "pepper-value",
  };
  const parsed = parseSecretsFile(secretsFileContent(secrets, "/tmp/rehearsal data"));
  assert.deepEqual(parsed, {
    CORKBOARD_ROOT_KEY: "root-value",
    CORKBOARD_CREDENTIAL_PEPPER: "pepper-value",
    CORKBOARD_DATA_DIR: "/tmp/rehearsal data",
  });
});

test("required rehearsal checks are unique", () => {
  assert.equal(new Set(REQUIRED_CHECK_IDS).size, REQUIRED_CHECK_IDS.length);
});

test("childEnv drops inherited secrets and every inherited CORKBOARD_* variable", () => {
  const env = childEnv(
    { CORKBOARD_DATA_DIR: "/synthetic/data" },
    {
      PATH: "/bin",
      HOME: "/home/example",
      TMPDIR: "/tmp/test",
      LANG: "C",
      CORKBOARD_BOOTSTRAP_PASSWORD: "poison-password",
      CORKBOARD_ROOT_KEY: "poison-root",
      CORKBOARD_CREDENTIAL_PEPPER: "poison-pepper",
      CORKBOARD_APIKEY: "poison-api",
      NODE_OPTIONS: "--require=evil",
    },
  );
  assert.deepEqual(env, {
    PATH: "/bin",
    HOME: "/home/example",
    TMPDIR: "/tmp/test",
    LANG: "C",
    CORKBOARD_DATA_DIR: "/synthetic/data",
  });
  const joined = JSON.stringify(env);
  assert.equal(joined.includes("poison-"), false);
  assert.equal(joined.includes("NODE_OPTIONS"), false);
});
