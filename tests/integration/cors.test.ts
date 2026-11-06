// The service has no CORS policy by design: browser scripts on other origins
// must not be able to read responses. Keep this negative test next to the
// hardening documentation so a permissive header cannot be added silently.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp } from "../../src/app/handlers.ts";
import { createServiceFixture } from "../helpers/service-fixture.ts";

const CORS_HEADERS = [
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-allow-credentials",
  "access-control-expose-headers",
  "access-control-max-age",
  "access-control-allow-private-network",
] as const;

function assertNoCorsHeaders(response: Response, label: string): void {
  for (const name of CORS_HEADERS) {
    assert.equal(response.headers.get(name), null, `${label} must not emit ${name}`);
  }
}

// Exercises the core `createApp` handler; the Node adapter only converts
// HTTP to a `Request` (adapter coverage is the same as the other handler tests).
test("representative routes emit no CORS headers, including preflight", async (t) => {
  const fx = await createServiceFixture();
  t.after(() => fx.close());
  await fx.addAccount("acct_cors");
  await fx.addSpeaker("spk_cors", "acct_cors");
  const { token } = await fx.addCredential({ speakerId: "spk_cors" });
  const app = createApp(fx.deps, { publicBaseUrl: "https://corkboard.example" });

  const crossOrigin = {
    origin: "https://evil.example",
    "access-control-request-method": "GET",
    "access-control-request-headers": "authorization",
  };

  const cases: readonly [string, Request, number][] = [
    ["public JSON", new Request("http://localhost/healthz", { headers: crossOrigin }), 200],
    ["unknown route", new Request("http://localhost/not-a-route", { headers: crossOrigin }), 404],
    [
      "authenticated JSON",
      new Request("http://localhost/api/v1/me", {
        headers: { ...crossOrigin, authorization: `Bearer ${token}` },
      }),
      200,
    ],
    [
      "preflight",
      new Request("http://localhost/api/v1/me", { method: "OPTIONS", headers: crossOrigin }),
      405,
    ],
    ["dashboard HTML", new Request("http://localhost/login", { headers: crossOrigin }), 200],
    [
      "login POST",
      new Request("http://localhost/api/v1/session", {
        method: "POST",
        headers: { ...crossOrigin, "content-type": "application/json" },
        body: JSON.stringify({ email: "nobody@example.test", password: "wrong" }),
      }),
      401,
    ],
    ["MCP preflight", new Request("http://localhost/mcp", { method: "OPTIONS", headers: crossOrigin }), 405],
    [
      "OAuth discovery JSON",
      new Request("http://localhost/.well-known/oauth-authorization-server", {
        headers: crossOrigin,
      }),
      200,
    ],
    [
      "OAuth authorize HTML",
      new Request("http://localhost/oauth/authorize", { headers: crossOrigin }),
      400,
    ],
    [
      "OAuth client JS",
      new Request("http://localhost/oauth/client.js", { headers: crossOrigin }),
      200,
    ],
  ];

  for (const [label, request, expectedStatus] of cases) {
    const response = await app(request);
    assert.equal(response.status, expectedStatus, `${label} status`);
    assertNoCorsHeaders(response, label);
  }
});
