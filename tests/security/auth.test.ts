import assert from "node:assert/strict";
import { test } from "node:test";
import {
  credentialIsActive,
  generateSpeakerToken,
  hashSecret,
  verifySecret,
} from "../../src/auth/credentials.ts";
import {
  SCOPES,
  authorizeProjectAccess,
  effectiveRights,
  requireScope,
  type EffectiveRightsInput,
  type Scope,
} from "../../src/domain/authz.ts";
import { AppError, type ErrorCode } from "../../src/domain/errors.ts";

function hasCode(code: ErrorCode): (error: unknown) => boolean {
  return (error) => error instanceof AppError && error.code === code;
}

function randomPepper(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function decodeBase64url(value: string): Uint8Array {
  const base64 =
    value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - (value.length % 4)) % 4);
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

test("speaker tokens have the documented shape and 32 random bytes", () => {
  const { token, publicPrefix } = generateSpeakerToken();
  assert.match(token, /^cb_[A-Za-z0-9_-]{43}$/);
  assert.equal(token.length, 46);
  assert.equal(publicPrefix, token.slice(0, 12));
  assert.equal(decodeBase64url(token.slice(3)).length, 32);

  const second = generateSpeakerToken();
  assert.notEqual(second.token, token);
  assert.notEqual(second.publicPrefix, publicPrefix);
});

test("hashSecret is deterministic per pepper and verifier verification round-trips", async () => {
  const { token, publicPrefix } = generateSpeakerToken();
  const pepper = randomPepper();
  const verifier = await hashSecret(token, pepper);

  assert.match(verifier, /^[0-9a-f]{64}$/);
  assert.equal(await hashSecret(token, pepper), verifier);
  assert.equal(await verifySecret(token, publicPrefix, verifier, pepper), true);
});

test("a wrong pepper fails verification", async () => {
  const { token, publicPrefix } = generateSpeakerToken();
  const pepper = randomPepper();
  const verifier = await hashSecret(token, pepper);

  assert.notEqual(await hashSecret(token, randomPepper()), verifier);
  assert.equal(await verifySecret(token, publicPrefix, verifier, randomPepper()), false);
});

test("tampered token, prefix mismatch and tampered verifier all fail", async () => {
  const { token, publicPrefix } = generateSpeakerToken();
  const pepper = randomPepper();
  const verifier = await hashSecret(token, pepper);

  // Flip one character after the public prefix so the prefix check still passes.
  const tampered = token.slice(0, 20) + (token.slice(20, 21) === "A" ? "B" : "A") + token.slice(21);
  assert.notEqual(tampered, token);
  assert.equal(await verifySecret(tampered, publicPrefix, verifier, pepper), false);

  assert.equal(await verifySecret(token, "cb_AAAAAAAA", verifier, pepper), false);

  const flipped = verifier.slice(0, 63) + (verifier.endsWith("0") ? "1" : "0");
  assert.equal(await verifySecret(token, publicPrefix, flipped, pepper), false);
});

test("credentials are active only until they expire or are revoked", () => {
  const now = new Date("2026-11-03T12:00:00.000Z");

  assert.equal(credentialIsActive({ expiresAt: null, revokedAt: null }, now), true);
  assert.equal(
    credentialIsActive({ expiresAt: new Date(now.getTime() + 1), revokedAt: null }, now),
    true,
  );
  assert.equal(
    credentialIsActive({ expiresAt: new Date(now.getTime()), revokedAt: null }, now),
    false,
  );
  assert.equal(
    credentialIsActive({ expiresAt: new Date(now.getTime() - 1), revokedAt: null }, now),
    false,
  );
  assert.equal(
    credentialIsActive({ expiresAt: null, revokedAt: new Date(now.getTime() - 1) }, now),
    false,
  );
  assert.equal(
    credentialIsActive(
      { expiresAt: new Date(now.getTime() + 60_000), revokedAt: new Date(now.getTime()) },
      now,
    ),
    false,
  );
});

const NOW = new Date("2026-11-03T12:00:00.000Z");
const ALL_SCOPES: readonly string[] = SCOPES;

function activeInput(overrides: Partial<EffectiveRightsInput> = {}): EffectiveRightsInput {
  return {
    accountStatus: "active",
    speakerStatus: "active",
    projectStatus: "active",
    membershipRemovedAt: null,
    membershipCapabilities: ALL_SCOPES,
    credentialScopes: ALL_SCOPES,
    credentialExpiresAt: null,
    credentialRevokedAt: null,
    now: NOW,
    ...overrides,
  };
}

test("SCOPES exposes exactly the seven documented identifiers", () => {
  assert.deepEqual(
    [...SCOPES],
    [
      "project.read",
      "message.read",
      "message.send",
      "receipt.write",
      "project.edit",
      "member.read",
      "member.manage",
    ],
  );
});

test("effectiveRights returns the intersection of scopes and capabilities", () => {
  assert.deepEqual([...effectiveRights(activeInput())], [...SCOPES]);

  const rights = effectiveRights(
    activeInput({
      membershipCapabilities: ["project.read", "message.send", "not.a.scope"],
      credentialScopes: ["message.send", "message.read", "also.unknown"],
    }),
  );
  assert.deepEqual([...rights], ["message.send"]);

  const none = effectiveRights(
    activeInput({ membershipCapabilities: ["message.read"], credentialScopes: ["message.send"] }),
  );
  assert.equal(none.size, 0);
});

test("unknown scope strings are ignored on both sides", () => {
  const rights = effectiveRights(
    activeInput({
      membershipCapabilities: ["unknown.capability", "message.read"],
      credentialScopes: ["unknown.scope", "message.read"],
    }),
  );
  assert.deepEqual([...rights], ["message.read"]);
});

test("every inactive principal state yields no rights", () => {
  assert.equal(effectiveRights(activeInput({ accountStatus: "suspended" })).size, 0);
  assert.equal(effectiveRights(activeInput({ speakerStatus: "disabled" })).size, 0);
  assert.equal(effectiveRights(activeInput({ projectStatus: "archived" })).size, 0);
  assert.equal(
    effectiveRights(activeInput({ credentialExpiresAt: new Date(NOW.getTime() - 1) })).size,
    0,
  );
  assert.equal(
    effectiveRights(activeInput({ credentialExpiresAt: new Date(NOW.getTime()) })).size,
    0,
  );
  assert.equal(
    effectiveRights(activeInput({ credentialRevokedAt: new Date(NOW.getTime() - 1) })).size,
    0,
  );
  assert.equal(
    effectiveRights(
      activeInput({ credentialExpiresAt: new Date(NOW.getTime() + 60_000) }),
    ).size,
    SCOPES.length,
  );
});

test("a removed membership yields no rights even when every other principal is active", () => {
  const removed = effectiveRights(
    activeInput({ membershipRemovedAt: new Date(NOW.getTime() - 1) }),
  );
  assert.equal(removed.size, 0);
});

test("requireScope throws FORBIDDEN when the scope is missing", () => {
  assert.doesNotThrow(() => requireScope(new Set<Scope>(["message.send"]), "message.send"));
  assert.throws(
    () => requireScope(new Set<Scope>(["message.read"]), "message.send"),
    hasCode("FORBIDDEN"),
  );
});

test("authorizeProjectAccess encodes NOT_FOUND before FORBIDDEN", () => {
  const noRights = new Set<Scope>();

  assert.throws(
    () =>
      authorizeProjectAccess({
        isMember: false,
        membershipRemovedAt: null,
        rights: noRights,
        scope: "message.read",
      }),
    hasCode("NOT_FOUND"),
  );
  assert.throws(
    () =>
      authorizeProjectAccess({
        isMember: false,
        membershipRemovedAt: null,
        rights: new Set<Scope>(["message.read"]),
        scope: "message.read",
      }),
    hasCode("NOT_FOUND"),
  );
  assert.throws(
    () =>
      authorizeProjectAccess({
        isMember: true,
        membershipRemovedAt: new Date(NOW.getTime() - 1),
        rights: new Set<Scope>(["message.read"]),
        scope: "message.read",
      }),
    hasCode("NOT_FOUND"),
  );
  assert.throws(
    () =>
      authorizeProjectAccess({
        isMember: true,
        membershipRemovedAt: null,
        rights: noRights,
        scope: "message.read",
      }),
    hasCode("FORBIDDEN"),
  );
  assert.doesNotThrow(() =>
    authorizeProjectAccess({
      isMember: true,
      membershipRemovedAt: null,
      rights: new Set<Scope>(["message.read"]),
      scope: "message.read",
    }),
  );
});
