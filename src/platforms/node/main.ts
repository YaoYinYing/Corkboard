// Self-hosted Node adapter: plain HTTP in, Web Request/Response at the core.
// TLS, proxy trust and body limits in front of this process are the reverse
// proxy's job; secrets are read from the environment and never printed.
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createApp,
  MAX_REQUEST_BODY_BYTES,
  requestTooLargeResponse,
  type RequestLogEntry,
} from "../../app/handlers.ts";
import { rateLimitConfigFromEnv } from "../../app/rate-limit.ts";
import {
  MetricsRegistry,
  metricsConfigFromEnv,
  routeLabelFor,
} from "../../app/metrics.ts";
import { keyProviderFromEnv } from "../../crypto/keys.ts";
import type { ServiceDeps } from "../../service/auth.ts";
import { LocalBlobStore } from "../../storage/blobs/local.ts";
import { openSqliteDatabase } from "../../storage/db.ts";
import {
  assertNoPrivateFilesystemRedirects,
  requiresPrivateFilesystem,
  verifyPrivateFilesystem,
} from "../../storage/permissions.ts";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const REQUEST_TIMEOUT_MS = 30_000;
const HEADERS_TIMEOUT_MS = 10_000;

export class BodyTooLargeError extends Error {
  constructor() {
    super("Request body too large");
    this.name = "BodyTooLargeError";
  }
}

// Stops reading as soon as the cap is crossed; the overflow chunk is never
// retained, so memory stays bounded for chunked uploads of any size.
export async function readCappedBody(
  stream: AsyncIterable<Buffer | string | Uint8Array>,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

// Only the message-send route reads a body. Rejected methods/routes never
// consume the request stream, so an oversized POST to /healthz is not buffered.
function needsBody(method: string, pathname: string): boolean {
  if (method !== "POST") return false;
  const segments = pathname.split("/").filter((segment) => segment !== "");
  if (segments.length === 1 && segments[0] === "mcp") return true;
  return (
    segments.length === 5 &&
    segments[0] === "api" &&
    segments[1] === "v1" &&
    segments[2] === "projects" &&
    segments[4] === "messages"
  );
}

function declaredBodyLength(request: IncomingMessage): number | null {
  const raw = request.headers["content-length"];
  if (raw === undefined) return null;
  const length = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function requestPathname(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return "/";
  }
}

async function toWebRequest(request: IncomingMessage): Promise<Request> {
  const host = request.headers.host ?? "localhost";
  const url = new URL(request.url ?? "/", `http://${host}`);

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }

  const method = (request.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || !needsBody(method, url.pathname)) {
    return new Request(url, { method, headers });
  }

  const declared = declaredBodyLength(request);
  if (declared !== null && declared > MAX_REQUEST_BODY_BYTES) {
    throw new BodyTooLargeError();
  }
  const body = await readCappedBody(request, MAX_REQUEST_BODY_BYTES);
  return new Request(url, { method, headers, body });
}

export interface StartServerOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

export interface RunningServer {
  server: Server;
  close(): Promise<void>;
}

function decodePepper(raw: string | undefined): Uint8Array {
  if (raw === undefined || raw.trim() === "") {
    throw new Error("CORKBOARD_CREDENTIAL_PEPPER is not set");
  }
  const bytes = new Uint8Array(Buffer.from(raw.trim(), "base64"));
  if (bytes.length !== 32) {
    throw new Error("CORKBOARD_CREDENTIAL_PEPPER must be base64-encoded 32 bytes");
  }
  return bytes;
}

async function writeWebResponse(response: ServerResponse, body: Response): Promise<void> {
  response.statusCode = body.status;
  body.headers.forEach((value, name) => response.setHeader(name, value));
  if (response.req.method === "HEAD") {
    response.end();
    return;
  }
  response.end(Buffer.from(await body.arrayBuffer()));
}

export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const configuredDataDir = env.CORKBOARD_DATA_DIR;
  if (configuredDataDir === undefined || configuredDataDir === "") {
    throw new Error("CORKBOARD_DATA_DIR is not set");
  }
  // Normalize once so every later lstat/mkdir/open uses the same path.
  const dataDir = resolve(configuredDataDir);
  const port = Number(env.PORT ?? String(DEFAULT_PORT));
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("PORT must be an integer 0-65535");
  }
  // Plain HTTP stays on loopback unless the operator opts into another HOST.
  const host = env.HOST === undefined || env.HOST === "" ? DEFAULT_HOST : env.HOST;
  // Invalid limiter configuration fails startup before the data directory is
  // created, opened, or chmodded.
  const rateLimit = rateLimitConfigFromEnv(env);
  // Parsed with the limiter, before anything is created or opened. A too-short
  // token fails startup rather than silently disabling or weakening the endpoint.
  const metricsConfig = metricsConfigFromEnv(env);

  const blobDir = join(dataDir, "blobs");
  const databasePath = join(dataDir, "corkboard.sqlite");
  const productionFilesystem = requiresPrivateFilesystem(env);
  // Reject redirects before creating, chmodding, or opening anything, so a
  // rejected symlink target is left untouched.
  if (productionFilesystem) {
    assertNoPrivateFilesystemRedirects({ dataDir, blobDir, databasePath });
  }
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  mkdirSync(blobDir, { recursive: true, mode: 0o700 });
  // Establish the mode first; verification below fails closed if it did not take.
  if (productionFilesystem) chmodSync(blobDir, 0o700);
  const db = await openSqliteDatabase(databasePath);

  let close: () => Promise<void>;
  let shutdown: () => void;
  try {
    verifyPrivateFilesystem({
      dataDir,
      blobDir,
      databasePath,
      production: productionFilesystem,
    });
    const deps: ServiceDeps = {
      db,
      blobs: new LocalBlobStore(blobDir),
      keys: await keyProviderFromEnv(env),
      pepper: decodePepper(env.CORKBOARD_CREDENTIAL_PEPPER),
      serviceId: "corkboard",
      now: () => new Date(),
    };
    const metrics = new MetricsRegistry();
    const app = createApp(deps, {
      rateLimit,
      metrics,
      ...(metricsConfig === undefined ? {} : { metricsToken: metricsConfig.token }),
      // JSON lines for the service log; no headers, tokens, bodies or IPs.
      logger: (entry: RequestLogEntry): void => {
        process.stdout.write(`${JSON.stringify(entry)}\n`);
      },
    });

    const server = createServer((request, response) => {
      // The core records every request it sees; adapter-level rejections never
      // reach it, so they are recorded here with the same fixed route labels.
      const started = performance.now();
      void toWebRequest(request)
        .then(app)
        .then((webResponse) => writeWebResponse(response, webResponse))
        .catch((error: unknown) => {
          if (error instanceof BodyTooLargeError) {
            const webResponse = requestTooLargeResponse();
            metrics.recordRequest(
              routeLabelFor(requestPathname(request)),
              webResponse.status,
              "REQUEST_TOO_LARGE",
              performance.now() - started,
            );
            void writeWebResponse(response, webResponse);
            return;
          }
          metrics.recordRequest(
            routeLabelFor(requestPathname(request)),
            503,
            "UNAVAILABLE",
            performance.now() - started,
          );
          if (!response.headersSent) response.statusCode = 503;
          response.end();
        });
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = HEADERS_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });

    let closed = false;
    close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      process.removeListener("SIGINT", shutdown);
      process.removeListener("SIGTERM", shutdown);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      db.close();
    };
    shutdown = (): void => {
      void close().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);

    return { server, close };
  } catch (error) {
    db.close();
    throw error;
  }
}

function isEntryPoint(): boolean {
  const argv = process.argv[1];
  if (argv === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(argv);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  startServer().catch(() => {
    console.error("corkboard: failed to start");
    process.exit(1);
  });
}
