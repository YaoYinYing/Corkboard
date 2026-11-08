// Cloudflare Workers entrypoint: Web-standard only, no `node:` imports.
//
// This module wires the existing `createApp` router to structural D1 and R2
// bindings. It is exercised locally with the structural doubles in
// `tests/helpers/` and standard `Request`/`Response`; it is not evidence of a
// live Workers/workerd run, real Cloudflare bindings, wrangler, or deployment.
//
// `WorkersEnv` is the binding/vars surface a Worker would be configured with:
//   bindings: DB (D1) and BLOB_BUCKET (private R2)
//   secrets:  CORKBOARD_ROOT_KEY and CORKBOARD_CREDENTIAL_PEPPER
// No wrangler configuration is added in this slice. Migrations are a
// deployment concern applied by the platform; this file never runs them.
import { createApp } from "../../app/handlers.ts";
import { verifyPasswordHash, type PasswordVerifier } from "../../auth/password.ts";
import {
  ConfigurationError,
  keyProviderFromEnv,
} from "../../crypto/keys.ts";
import type { ServiceDeps } from "../../service/auth.ts";
import { createD1Database, type D1DatabaseLike } from "../../storage/d1.ts";
import { createR2BlobStore, type R2BucketLike } from "../../storage/blobs/r2.ts";

const PEPPER_BYTES = 32;

export interface WorkersEnv {
  readonly DB: D1DatabaseLike;
  readonly BLOB_BUCKET: R2BucketLike;
  readonly CORKBOARD_ROOT_KEY: string;
  readonly CORKBOARD_CREDENTIAL_PEPPER: string;
}

export interface WorkersHandler {
  fetch(request: Request, env: WorkersEnv): Promise<Response>;
}

type App = (request: Request) => Promise<Response>;

// The Node adapter's `Buffer` parser is lenient: it also accepts base64url.
// Workers use strict `atob`, so this accepts trimmed standard base64 (padded or
// unpadded) and exactly 32 decoded bytes; base64url and other junk are rejected
// and surface only as the generic 503. This is not byte-for-byte parser parity.
function decodePepper(raw: string | undefined): Uint8Array {
  if (raw === undefined || raw.trim() === "") {
    throw new ConfigurationError("CORKBOARD_CREDENTIAL_PEPPER is not set");
  }
  let binary: string;
  try {
    binary = atob(raw.trim());
  } catch {
    throw new ConfigurationError(
      "CORKBOARD_CREDENTIAL_PEPPER must be base64-encoded 32 bytes",
    );
  }
  if (binary.length !== PEPPER_BYTES) {
    throw new ConfigurationError(
      "CORKBOARD_CREDENTIAL_PEPPER must be base64-encoded 32 bytes",
    );
  }
  const bytes = new Uint8Array(PEPPER_BYTES);
  for (let index = 0; index < PEPPER_BYTES; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

// Core PBKDF2 only. Legacy `scrypt$` hashes need node:crypto and therefore
// fail closed here; they remain verifiable only through the Node adapter.
const workersPasswordVerifier: PasswordVerifier = (
  password: string,
  storedHash: string,
): Promise<boolean> => verifyPasswordHash(password, storedHash);

function requireBinding<T>(value: T | undefined, name: string): T {
  if (value === undefined || value === null) {
    throw new ConfigurationError(`Worker binding ${name} is not configured`);
  }
  return value;
}

async function buildApp(env: WorkersEnv): Promise<App> {
  const db = requireBinding(env.DB, "DB");
  const bucket = requireBinding(env.BLOB_BUCKET, "BLOB_BUCKET");
  const deps: ServiceDeps = {
    db: createD1Database(db),
    blobs: createR2BlobStore(bucket),
    keys: await keyProviderFromEnv({ CORKBOARD_ROOT_KEY: env.CORKBOARD_ROOT_KEY }),
    pepper: decodePepper(env.CORKBOARD_CREDENTIAL_PEPPER),
    serviceId: "corkboard",
    now: () => new Date(),
    passwordVerifier: workersPasswordVerifier,
  };
  return createApp(deps);
}

// Generic failure envelope. It carries no configuration value, binding name,
// token, or driver text.
function unavailableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: { code: "UNAVAILABLE", message: "Service unavailable" },
    }),
    {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

// One app per handler instance (one per isolate for the default export). A
// failed build is not cached, so a later request can retry after a bindings or
// secrets fix without restarting the isolate.
export function createWorkersHandler(): WorkersHandler {
  let appPromise: Promise<App> | undefined;

  function getApp(env: WorkersEnv): Promise<App> {
    if (appPromise === undefined) {
      appPromise = buildApp(env).catch((error: unknown) => {
        appPromise = undefined;
        throw error;
      });
    }
    return appPromise;
  }

  return {
    async fetch(request: Request, env: WorkersEnv): Promise<Response> {
      let app: App;
      try {
        app = await getApp(env);
      } catch {
        return unavailableResponse();
      }
      // `createApp` already maps application and unexpected errors; this guard
      // only covers a failure before that mapping can run.
      try {
        return await app(request);
      } catch {
        return unavailableResponse();
      }
    },
  };
}

export default createWorkersHandler();
