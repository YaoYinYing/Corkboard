// Server-rendered HTML helpers for the read-only human dashboard. Every dynamic
// value must pass through escapeHtml before it reaches the document. The strict
// CSP forbids scripts entirely; styling comes only from the fixed same-origin
// stylesheet.

/** The only CSP served with dashboard pages and the fixed stylesheet. */
export const WEB_CSP =
  "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function htmlResponse(
  status: number,
  body: string,
  extra: Record<string, string | readonly string[]> = {},
): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": "text/html; charset=utf-8",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": WEB_CSP,
    "x-frame-options": "DENY",
  });
  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === "string") headers.set(name, value);
    else for (const item of value) headers.append(name, item);
  }
  return new Response(body, { status, headers });
}
