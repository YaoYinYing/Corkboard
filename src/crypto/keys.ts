// Versioned AES-256-GCM key provider. Key material is never logged or exported.

import type { webcrypto } from "node:crypto";

// The runtime object is the WebCrypto global; only the type is Node-scoped.
type CryptoKey = webcrypto.CryptoKey;

export class ConfigurationError extends Error {
  readonly code = "CONFIGURATION_ERROR";

  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export interface KeyProvider {
  current(): Promise<{ version: string; key: CryptoKey }>;
  byVersion(version: string): Promise<CryptoKey | undefined>;
}

const KEY_BYTES = 32;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64Value(char: string): number {
  return BASE64.indexOf(char);
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

function decodeRootKey(raw: string): Uint8Array {
  const normalized = raw.trim().replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const bytes = decodeBase64(padded);
  if (bytes === undefined || bytes.length !== KEY_BYTES) {
    throw new ConfigurationError("CORKBOARD_ROOT_KEY must be base64-encoded 32 bytes");
  }
  return bytes;
}

async function importAesKey(keyBytes: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function inMemoryKeyProvider(
  keyBytes: Uint8Array,
  version = "v1",
): Promise<KeyProvider> {
  if (keyBytes.length !== KEY_BYTES) {
    throw new ConfigurationError("AES-256 key must be exactly 32 bytes");
  }
  const key = await importAesKey(keyBytes.slice());
  return {
    async current(): Promise<{ version: string; key: CryptoKey }> {
      return { version, key };
    },
    async byVersion(candidate: string): Promise<CryptoKey | undefined> {
      return candidate === version ? key : undefined;
    },
  };
}

export async function keyProviderFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<KeyProvider> {
  const raw = env.CORKBOARD_ROOT_KEY;
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigurationError("CORKBOARD_ROOT_KEY is not set");
  }
  const key = await importAesKey(decodeRootKey(raw));
  return {
    async current(): Promise<{ version: string; key: CryptoKey }> {
      return { version: "v1", key };
    },
    async byVersion(candidate: string): Promise<CryptoKey | undefined> {
      return candidate === "v1" ? key : undefined;
    },
  };
}
