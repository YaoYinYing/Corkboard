// CB01 authenticated envelope: AES-256-GCM with a fresh 96-bit nonce per encryption.
// The plaintext SHA-256 is sealed inside the encrypted CBPT1 frame; the AAD binds
// only pre-decryption metadata and the ciphertext SHA-256 is verified before
// decryption. Any mismatch fails closed.

import type { KeyProvider } from "./keys.ts";

export class IntegrityError extends Error {
  readonly code = "INTEGRITY_FAILURE";

  constructor(message = "integrity failure") {
    super(message);
    this.name = "IntegrityError";
  }
}

export class EnvelopeFormatError extends IntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "EnvelopeFormatError";
  }
}

export type Compression = "none" | "gzip";
export type CompressionOption = Compression | "auto";

export interface MessageIds {
  serviceId: string;
  projectId: string;
  messageId: string;
  objectId: string;
}

export interface EnvelopeHeader {
  v: 1;
  key_version: string;
  nonce_b64url: string;
  compression: Compression;
  ciphertext_digest: string;
  plaintext_length: number;
}

export interface SealOptions {
  compression?: CompressionOption;
}

export interface SealedBody {
  envelope: Uint8Array;
  header: EnvelopeHeader;
  ciphertextDigest: string;
  plaintextDigest: string;
  keyVersion: string;
}

export interface OpenedBody {
  plaintext: Uint8Array;
  header: EnvelopeHeader;
}

export interface OpenOptions {
  expectedCiphertextDigest?: string;
}

const MAGIC: readonly number[] = [0x43, 0x42, 0x30, 0x31]; // "CB01"
const FRAME_MAGIC: readonly number[] = [0x43, 0x42, 0x50, 0x54, 0x31]; // "CBPT1"
const FORMAT_VERSION = "v1";
const NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const FRAME_PREFIX_BYTES = 6; // magic + digest length byte
const FRAME_DIGEST_BYTES = 71; // "sha256:" + 64 hex
const FRAME_MAX_BYTES = FRAME_PREFIX_BYTES + FRAME_DIGEST_BYTES;
const AUTO_GZIP_MIN_BYTES = 256;
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

function base64Value(char: string): number {
  return BASE64.indexOf(char);
}

function encodeBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64[b0 >> 2] ?? "";
    out += BASE64[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)] ?? "";
    out += b1 === undefined ? "=" : (BASE64[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)] ?? "");
    out += b2 === undefined ? "=" : (BASE64[b2 & 63] ?? "");
  }
  return out;
}

function decodeBase64(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) return undefined;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const body = value.slice(0, value.length - padding);
  if (body.length % 4 === 1) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < body.length; i += 4) {
    const c0 = base64Value(body[i] ?? "");
    const c1 = base64Value(body[i + 1] ?? "A");
    const c2 = base64Value(body[i + 2] ?? "A");
    const c3 = base64Value(body[i + 3] ?? "A");
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) return undefined;
    bytes.push((c0 << 2) | (c1 >> 4));
    if (i + 2 < body.length) bytes.push(((c1 & 15) << 4) | (c2 >> 2));
    if (i + 3 < body.length) bytes.push(((c2 & 3) << 6) | c3);
  }
  return Uint8Array.from(bytes);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  return decodeBase64(padded);
}

function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

async function digestOf(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${toHex(digest)}`;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Sorted-key canonical JSON, UTF-8 encoded, over pre-decryption metadata only.
function buildAad(ids: MessageIds, compression: Compression): Uint8Array {
  return TEXT_ENCODER.encode(
    JSON.stringify({
      compression,
      format_version: FORMAT_VERSION,
      message_id: ids.messageId,
      object_id: ids.objectId,
      project_id: ids.projectId,
      service_id: ids.serviceId,
    }),
  );
}

// CBPT1 frame: magic + digest length + "sha256:<hex>" + original body bytes.
function framePlaintext(plaintextDigest: string, body: Uint8Array): Uint8Array {
  const digestBytes = TEXT_ENCODER.encode(plaintextDigest);
  const frame = new Uint8Array(FRAME_PREFIX_BYTES + digestBytes.length + body.length);
  frame.set(FRAME_MAGIC, 0);
  frame[FRAME_MAGIC.length] = digestBytes.length;
  frame.set(digestBytes, FRAME_PREFIX_BYTES);
  frame.set(body, FRAME_PREFIX_BYTES + digestBytes.length);
  return frame;
}

function parseFrame(
  frame: Uint8Array,
  expectedLength: number,
): { digest: string; body: Uint8Array } {
  if (frame.length < FRAME_PREFIX_BYTES) throw new IntegrityError("missing plaintext frame");
  for (let i = 0; i < FRAME_MAGIC.length; i += 1) {
    if (frame[i] !== FRAME_MAGIC[i]) throw new IntegrityError("invalid plaintext frame");
  }
  const digestLength = frame[FRAME_MAGIC.length] ?? 0;
  if (digestLength !== FRAME_DIGEST_BYTES || frame.length < FRAME_PREFIX_BYTES + digestLength) {
    throw new IntegrityError("invalid plaintext frame");
  }
  const digest = TEXT_DECODER.decode(
    frame.subarray(FRAME_PREFIX_BYTES, FRAME_PREFIX_BYTES + digestLength),
  );
  if (!DIGEST_RE.test(digest)) throw new IntegrityError("invalid embedded plaintext digest");
  const body = frame.subarray(FRAME_PREFIX_BYTES + digestLength);
  if (body.length !== expectedLength) throw new IntegrityError("plaintext length mismatch");
  return { digest, body };
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function runTransform(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream,
  maxLength: number,
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer.write(bytes).then(
    () => writer.close(),
    () => undefined,
  );
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxLength) {
        await reader.cancel();
        throw new IntegrityError("decompressed size exceeds declared length");
      }
      chunks.push(value);
    }
  } finally {
    await writing;
  }
  return concatChunks(chunks, total);
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return runTransform(bytes, new CompressionStream("gzip"), Number.POSITIVE_INFINITY);
}

async function gunzipBounded(bytes: Uint8Array, limit: number): Promise<Uint8Array> {
  try {
    return await runTransform(bytes, new DecompressionStream("gzip"), limit);
  } catch (error) {
    throw error instanceof IntegrityError ? error : new IntegrityError("decompression failed");
  }
}

async function compressForSeal(
  input: Uint8Array,
  mode: CompressionOption,
): Promise<{ compression: Compression; bytes: Uint8Array }> {
  if (mode === "none" || (mode === "auto" && input.length < AUTO_GZIP_MIN_BYTES)) {
    return { compression: "none", bytes: input };
  }
  const compressed = await gzip(input);
  if (mode === "auto" && compressed.length >= input.length) {
    return { compression: "none", bytes: input };
  }
  return { compression: "gzip", bytes: compressed };
}

function pack(header: EnvelopeHeader, ciphertext: Uint8Array): Uint8Array {
  const headerBytes = TEXT_ENCODER.encode(JSON.stringify(header));
  const out = new Uint8Array(MAGIC.length + 4 + headerBytes.length + ciphertext.length);
  out.set(MAGIC, 0);
  out[4] = (headerBytes.length >>> 24) & 0xff;
  out[5] = (headerBytes.length >>> 16) & 0xff;
  out[6] = (headerBytes.length >>> 8) & 0xff;
  out[7] = headerBytes.length & 0xff;
  out.set(headerBytes, MAGIC.length + 4);
  out.set(ciphertext, MAGIC.length + 4 + headerBytes.length);
  return out;
}

function parseHeader(raw: unknown): EnvelopeHeader {
  if (typeof raw !== "object" || raw === null) {
    throw new EnvelopeFormatError("envelope header must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (record.v !== 1) throw new EnvelopeFormatError("unsupported envelope version");
  if (typeof record.key_version !== "string" || record.key_version === "") {
    throw new EnvelopeFormatError("invalid key version");
  }
  if (typeof record.nonce_b64url !== "string") {
    throw new EnvelopeFormatError("invalid nonce");
  }
  if (record.compression !== "none" && record.compression !== "gzip") {
    throw new EnvelopeFormatError("invalid compression");
  }
  if (
    typeof record.ciphertext_digest !== "string" ||
    !DIGEST_RE.test(record.ciphertext_digest)
  ) {
    throw new EnvelopeFormatError("invalid ciphertext digest");
  }
  if (
    typeof record.plaintext_length !== "number" ||
    !Number.isSafeInteger(record.plaintext_length) ||
    record.plaintext_length < 0
  ) {
    throw new EnvelopeFormatError("invalid plaintext length");
  }
  return {
    v: 1,
    key_version: record.key_version,
    nonce_b64url: record.nonce_b64url,
    compression: record.compression,
    ciphertext_digest: record.ciphertext_digest,
    plaintext_length: record.plaintext_length,
  };
}

function parseEnvelope(envelope: Uint8Array): {
  header: EnvelopeHeader;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
} {
  if (envelope.length < MAGIC.length + 4) {
    throw new EnvelopeFormatError("envelope too short");
  }
  for (let i = 0; i < MAGIC.length; i += 1) {
    if (envelope[i] !== MAGIC[i]) throw new EnvelopeFormatError("invalid envelope magic");
  }
  const headerLength =
    (envelope[4] ?? 0) * 0x1000000 +
    ((envelope[5] ?? 0) << 16) +
    ((envelope[6] ?? 0) << 8) +
    (envelope[7] ?? 0);
  const headerStart = MAGIC.length + 4;
  if (headerLength === 0 || headerLength > envelope.length - headerStart) {
    throw new EnvelopeFormatError("invalid envelope header length");
  }
  const headerEnd = headerStart + headerLength;
  const ciphertext = envelope.subarray(headerEnd);
  if (ciphertext.length < GCM_TAG_BYTES) {
    throw new EnvelopeFormatError("envelope ciphertext truncated");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(TEXT_DECODER.decode(envelope.subarray(headerStart, headerEnd)));
  } catch {
    throw new EnvelopeFormatError("envelope header is not valid JSON");
  }
  const header = parseHeader(raw);
  const nonce = decodeBase64Url(header.nonce_b64url);
  if (nonce === undefined || nonce.length !== NONCE_BYTES) {
    throw new EnvelopeFormatError("invalid nonce");
  }
  return { header, nonce, ciphertext };
}

export async function sealBody(
  plaintext: Uint8Array,
  ids: MessageIds,
  keyProvider: KeyProvider,
  opts: SealOptions = {},
): Promise<SealedBody> {
  const plaintextDigest = await digestOf(plaintext);
  const framed = framePlaintext(plaintextDigest, plaintext);
  const { compression, bytes } = await compressForSeal(framed, opts.compression ?? "auto");
  const { version, key } = await keyProvider.current();
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const aad = buildAad(ids, compression);
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad },
    key,
    bytes,
  );
  const ciphertext = new Uint8Array(encrypted);
  const ciphertextDigest = await digestOf(ciphertext);
  const header: EnvelopeHeader = {
    v: 1,
    key_version: version,
    nonce_b64url: encodeBase64Url(nonce),
    compression,
    ciphertext_digest: ciphertextDigest,
    plaintext_length: plaintext.length,
  };
  return {
    envelope: pack(header, ciphertext),
    header,
    ciphertextDigest,
    plaintextDigest,
    keyVersion: version,
  };
}

export async function openBody(
  envelope: Uint8Array,
  ids: MessageIds,
  keyProvider: KeyProvider,
  opts: OpenOptions = {},
): Promise<OpenedBody> {
  const { header, nonce, ciphertext } = parseEnvelope(envelope);
  const ciphertextDigest = await digestOf(ciphertext);
  if (!constantTimeEqual(ciphertextDigest, header.ciphertext_digest)) {
    throw new IntegrityError("ciphertext digest mismatch");
  }
  // The DB's body_objects.ciphertext_digest is authoritative for same-ID substitution.
  if (
    opts.expectedCiphertextDigest !== undefined &&
    !constantTimeEqual(ciphertextDigest, opts.expectedCiphertextDigest)
  ) {
    throw new IntegrityError("ciphertext digest mismatch");
  }
  const key = await keyProvider.byVersion(header.key_version);
  if (key === undefined) throw new IntegrityError("unknown key version");
  const aad = buildAad(ids, header.compression);
  let decrypted: Uint8Array;
  try {
    decrypted = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: aad },
        key,
        ciphertext,
      ),
    );
  } catch {
    throw new IntegrityError("authentication failed");
  }
  const framed =
    header.compression === "gzip"
      ? await gunzipBounded(decrypted, header.plaintext_length + FRAME_MAX_BYTES)
      : decrypted;
  const { digest, body } = parseFrame(framed, header.plaintext_length);
  const plaintextDigest = await digestOf(body);
  if (!constantTimeEqual(plaintextDigest, digest)) {
    throw new IntegrityError("plaintext digest mismatch");
  }
  return { plaintext: body, header };
}
