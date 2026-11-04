// Shared response constructors for the platform-neutral HTTP handlers.

export function randomRequestId(): string {
  const raw = crypto.getRandomValues(new Uint8Array(16));
  let binary = "";
  for (const byte of raw) binary += String.fromCharCode(byte);
  return `req_${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

export function json(
  status: number,
  body: unknown,
  extra: Record<string, string | readonly string[]> = {},
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else {
      for (const item of value) headers.append(name, item);
    }
  }
  return new Response(JSON.stringify(body), { status, headers });
}

// 204 keeps the same hardening headers and carries no body or content type.
export function noContent(extra: Record<string, string | readonly string[]> = {}): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
  });
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") {
      headers.set(name, value);
    } else {
      for (const item of value) headers.append(name, item);
    }
  }
  return new Response(null, { status: 204, headers });
}
