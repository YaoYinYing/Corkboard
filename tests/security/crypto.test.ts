import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  EnvelopeFormatError,
  IntegrityError,
  openBody,
  sealBody,
  type EnvelopeHeader,
  type MessageIds,
} from "../../src/crypto/envelope.ts";
import {
  ConfigurationError,
  inMemoryKeyProvider,
  keyProviderFromEnv,
  type KeyProvider,
} from "../../src/crypto/keys.ts";
import { isValidBlobKey } from "../../src/storage/blobs.ts";
import { LocalBlobStore } from "../../src/storage/blobs/local.ts";
import { MemoryBlobStore } from "../../src/storage/blobs/memory.ts";

function makeIds(): MessageIds {
  const random = (): string => randomBytes(8).toString("hex");
  return {
    serviceId: `svc_${random()}`,
    projectId: `proj_${random()}`,
    messageId: `msg_${random()}`,
    objectId: `obj_${random()}`,
  };
}

function randomKey(): Uint8Array {
  return new Uint8Array(randomBytes(32));
}

async function makeProvider(version = "v1"): Promise<KeyProvider> {
  return inMemoryKeyProvider(randomKey(), version);
}

function sha256Digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function splitEnvelope(envelope: Uint8Array): {
  header: EnvelopeHeader;
  ciphertext: Uint8Array;
} {
  assert.deepEqual([...envelope.subarray(0, 4)], [0x43, 0x42, 0x30, 0x31]);
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(4, false);
  const header = JSON.parse(
    new TextDecoder().decode(envelope.subarray(8, 8 + headerLength)),
  ) as EnvelopeHeader;
  return { header, ciphertext: envelope.subarray(8 + headerLength) };
}

function joinEnvelope(header: Record<string, unknown>, ciphertext: Uint8Array): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const envelope = new Uint8Array(8 + headerBytes.length + ciphertext.length);
  envelope.set([0x43, 0x42, 0x30, 0x31], 0);
  new DataView(envelope.buffer).setUint32(4, headerBytes.length, false);
  envelope.set(headerBytes, 8);
  envelope.set(ciphertext, 8 + headerBytes.length);
  return envelope;
}

function headerText(envelope: Uint8Array): string {
  const headerLength = new DataView(
    envelope.buffer,
    envelope.byteOffset,
    envelope.byteLength,
  ).getUint32(4, false);
  return new TextDecoder().decode(envelope.subarray(8, 8 + headerLength));
}

function aadFor(ids: MessageIds, compression: "none" | "gzip"): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      compression,
      format_version: "v1",
      message_id: ids.messageId,
      object_id: ids.objectId,
      project_id: ids.projectId,
      service_id: ids.serviceId,
    }),
  );
}

function frameFor(digest: string, body: Uint8Array): Uint8Array {
  const digestBytes = new TextEncoder().encode(digest);
  const frame = new Uint8Array(6 + digestBytes.length + body.length);
  frame.set([0x43, 0x42, 0x50, 0x54, 0x31], 0);
  frame[5] = digestBytes.length;
  frame.set(digestBytes, 6);
  frame.set(body, 6 + digestBytes.length);
  return frame;
}

async function sealRawPayload(
  payload: Uint8Array,
  ids: MessageIds,
  provider: KeyProvider,
  plaintextLength: number,
): Promise<Uint8Array> {
  const { version, key } = await provider.current();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aadFor(ids, "none") },
      key,
      payload,
    ),
  );
  return joinEnvelope(
    {
      v: 1,
      key_version: version,
      nonce_b64url: Buffer.from(nonce).toString("base64url"),
      compression: "none",
      ciphertext_digest: sha256Digest(ciphertext),
      plaintext_length: plaintextLength,
    },
    ciphertext,
  );
}

function rewriteHeader(envelope: Uint8Array, patch: Record<string, unknown>): Uint8Array {
  const { header, ciphertext } = splitEnvelope(envelope);
  return joinEnvelope({ ...header, ...patch }, ciphertext);
}

async function expectIntegrityFailure(promise: Promise<unknown>): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof IntegrityError, "expected IntegrityError");
    assert.equal(error.code, "INTEGRITY_FAILURE");
    return true;
  });
}

test("roundtrips an uncompressed body", async () => {
  const plaintext = new TextEncoder().encode("hello corkboard");
  const ids = makeIds();
  const provider = await makeProvider();
  const sealed = await sealBody(plaintext, ids, provider, { compression: "none" });
  assert.equal(sealed.header.v, 1);
  assert.equal(sealed.header.compression, "none");
  assert.equal(sealed.keyVersion, "v1");
  const opened = await openBody(sealed.envelope, ids, provider);
  assert.deepEqual(opened.plaintext, plaintext);
  assert.deepEqual(opened.header, sealed.header);
});

test("auto-compresses large bodies with gzip and leaves small ones uncompressed", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const large = new TextEncoder().encode("corkboard ".repeat(500));
  const sealedGzip = await sealBody(large, ids, provider);
  assert.equal(sealedGzip.header.compression, "gzip");
  assert.deepEqual((await openBody(sealedGzip.envelope, ids, provider)).plaintext, large);

  const small = new TextEncoder().encode("small body");
  const sealedNone = await sealBody(small, ids, provider);
  assert.equal(sealedNone.header.compression, "none");
  assert.deepEqual((await openBody(sealedNone.envelope, ids, provider)).plaintext, small);
});

test("returns the sender plaintext digest and keeps it out of the outer header", async () => {
  const plaintext = new TextEncoder().encode("digest me before any compression ".repeat(40));
  const ids = makeIds();
  const provider = await makeProvider();
  const sealed = await sealBody(plaintext, ids, provider);
  const expected = sha256Digest(plaintext);
  assert.equal(sealed.plaintextDigest, expected);
  assert.equal(sealed.header.plaintext_length, plaintext.length);
  assert.equal("plaintext_digest" in sealed.header, false);
  const rawHeader = headerText(sealed.envelope);
  assert.ok(!rawHeader.includes("plaintext_digest"));
  assert.ok(!rawHeader.includes(expected));
  const { ciphertext } = splitEnvelope(sealed.envelope);
  assert.equal(sealed.ciphertextDigest, sha256Digest(ciphertext));
  assert.equal(sealed.header.ciphertext_digest, sealed.ciphertextDigest);
});

test("rejects tampered ciphertext with INTEGRITY_FAILURE", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const sealed = await sealBody(new TextEncoder().encode("tamper target"), ids, provider, {
    compression: "none",
  });
  const tampered = sealed.envelope.slice();
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01;
  await expectIntegrityFailure(openBody(tampered, ids, provider));
});

test("rejects AAD swaps of ids, compression and format", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const sealed = await sealBody(new TextEncoder().encode("bound metadata"), ids, provider, {
    compression: "none",
  });

  for (const swapped of [
    { ...ids, serviceId: `${ids.serviceId}x` },
    { ...ids, projectId: `${ids.projectId}x` },
    { ...ids, messageId: `${ids.messageId}x` },
    { ...ids, objectId: `${ids.objectId}x` },
  ]) {
    await expectIntegrityFailure(openBody(sealed.envelope, swapped, provider));
  }

  await expectIntegrityFailure(
    openBody(rewriteHeader(sealed.envelope, { compression: "gzip" }), ids, provider),
  );
  await expectIntegrityFailure(
    openBody(
      rewriteHeader(sealed.envelope, { ciphertext_digest: sha256Digest(new Uint8Array([1])) }),
      ids,
      provider,
    ),
  );

  await assert.rejects(
    openBody(rewriteHeader(sealed.envelope, { v: 2 }), ids, provider),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeFormatError);
      assert.ok(error instanceof IntegrityError);
      assert.equal(error.code, "INTEGRITY_FAILURE");
      return true;
    },
  );
});

test("rejects same-ID substitution against the authoritative DB digest", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const bodyA = new TextEncoder().encode("body A sealed first");
  const bodyB = new TextEncoder().encode("body B sealed second");
  const sealedA = await sealBody(bodyA, ids, provider, { compression: "none" });
  const sealedB = await sealBody(bodyB, ids, provider, { compression: "none" });

  await expectIntegrityFailure(
    openBody(sealedB.envelope, ids, provider, {
      expectedCiphertextDigest: sealedA.ciphertextDigest,
    }),
  );

  const opened = await openBody(sealedB.envelope, ids, provider, {
    expectedCiphertextDigest: sealedB.ciphertextDigest,
  });
  assert.deepEqual(opened.plaintext, bodyB);
});

test("uses a distinct nonce for every seal", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const plaintext = new TextEncoder().encode("nonce uniqueness");
  const nonces = new Set<string>();
  for (let i = 0; i < 32; i += 1) {
    const sealed = await sealBody(plaintext, ids, provider, { compression: "none" });
    nonces.add(sealed.header.nonce_b64url);
  }
  assert.equal(nonces.size, 32);
});

test("rejects a mismatched embedded plaintext digest", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const body = new TextEncoder().encode("embedded digest target");
  const wrongDigest = sha256Digest(new TextEncoder().encode("different bytes"));
  const envelope = await sealRawPayload(frameFor(wrongDigest, body), ids, provider, body.length);
  await expectIntegrityFailure(openBody(envelope, ids, provider));
});

test("rejects a payload without the CBPT1 frame", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const body = new TextEncoder().encode("unframed payload");
  const envelope = await sealRawPayload(body, ids, provider, body.length);
  await expectIntegrityFailure(openBody(envelope, ids, provider));
});

test("rejects a wrong key version and a wrong key", async () => {
  const ids = makeIds();
  const provider = await makeProvider("v1");
  const sealed = await sealBody(new TextEncoder().encode("key bound"), ids, provider, {
    compression: "none",
  });

  await expectIntegrityFailure(openBody(sealed.envelope, ids, await makeProvider("v2")));
  await expectIntegrityFailure(openBody(sealed.envelope, ids, await makeProvider("v1")));
});

test("rejects truncated envelopes", async () => {
  const provider = await makeProvider();
  const ids = makeIds();
  const sealed = await sealBody(new TextEncoder().encode("truncate me"), ids, provider, {
    compression: "none",
  });

  await expectIntegrityFailure(
    openBody(sealed.envelope.slice(0, sealed.envelope.length - 1), ids, provider),
  );
  await assert.rejects(
    openBody(sealed.envelope.slice(0, 9), ids, provider),
    (error: unknown) => {
      assert.ok(error instanceof EnvelopeFormatError);
      assert.equal(error.code, "INTEGRITY_FAILURE");
      return true;
    },
  );
});

test("builds an env key provider and rejects missing or malformed keys", async () => {
  const encoded = randomBytes(32).toString("base64");
  const provider = await keyProviderFromEnv({ CORKBOARD_ROOT_KEY: encoded });
  const current = await provider.current();
  assert.equal(current.version, "v1");
  assert.equal(current.key.algorithm.name, "AES-GCM");
  assert.equal(current.key.extractable, false);
  assert.ok((await provider.byVersion("v1")) !== undefined);
  assert.equal(await provider.byVersion("v2"), undefined);

  const shortKey = randomBytes(16).toString("base64");
  for (const value of [undefined, "", "not base64!!", shortKey]) {
    await assert.rejects(
      keyProviderFromEnv({ CORKBOARD_ROOT_KEY: value }),
      (error: unknown) => {
        assert.ok(error instanceof ConfigurationError);
        assert.equal(error.code, "CONFIGURATION_ERROR");
        assert.ok(!error.message.includes("not base64!!"));
        assert.ok(!error.message.includes(shortKey));
        return true;
      },
    );
  }
});

test("memory blob store roundtrips and misses return undefined", async () => {
  const store = new MemoryBlobStore();
  const key = randomBytes(16).toString("hex");
  const bytes = new Uint8Array(randomBytes(64));
  assert.equal(await store.get(key), undefined);
  await store.put(key, bytes);
  assert.deepEqual(await store.get(key), bytes);
  await store.delete(key);
  assert.equal(await store.get(key), undefined);
});

test("local blob store roundtrips with private permissions", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "corkboard-blobs-"));
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const store = new LocalBlobStore(dir);
  const key = randomBytes(16).toString("hex");
  const bytes = new Uint8Array(randomBytes(128));

  assert.equal(await store.get(key), undefined);
  await store.put(key, bytes);
  assert.deepEqual(await store.get(key), bytes);
  assert.equal(await store.get("f".repeat(32)), undefined);

  if (process.platform !== "win32") {
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(join(dir, key))).mode & 0o777, 0o600);
  }

  await assert.rejects(store.put("../escape", bytes), TypeError);
  await store.delete(key);
  assert.equal(await store.get(key), undefined);
});

test("rejects invalid and traversal blob keys", async () => {
  const memory = new MemoryBlobStore();
  for (const key of ["", "short", "a".repeat(129), "../escape", "a/b", "a.b", "..", "a\\b"]) {
    assert.equal(isValidBlobKey(key), false);
    await assert.rejects(memory.put(key, new Uint8Array([1])), TypeError);
    await assert.rejects(memory.get(key), TypeError);
    await assert.rejects(memory.delete(key), TypeError);
  }
  assert.equal(isValidBlobKey("a".repeat(16)), true);
  assert.equal(isValidBlobKey("a".repeat(128)), true);
});
