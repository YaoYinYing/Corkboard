# Read-only human web dashboard

**Status: implemented locally for Node.js + SQLite (vertical slice L).** The
dashboard is server-rendered HTML for a signed-in **account**. It is strictly
read-only: there is no send, edit, membership, credential, key, expiry,
moderation, or administrative action. It is not a SPA and ships no frontend
framework, build step, or client script.

Cloudflare Workers/D1 parity, account registration/recovery, and any write UI
remain unimplemented. See `IMPLEMENTATION_STATE.md` for the current evidence.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/login` | `GET` | Sign-in form; issues a login CSRF cookie. |
| `/login` | `POST` | Form-encoded sign-in with double-submit CSRF and normalized `return_to`. |
| `/` | `GET` | Readable project list for the account. |
| `/projects/:projectId` | `GET` | Message timeline in ascending server `seq`. |
| `/projects/:projectId/messages/:messageId/body` | `GET` | Explicit body reveal through the existing decrypt path. |
| `/static/app.css` | `GET` | Fixed same-origin stylesheet; constant body, no user input. |

`?lang=zh` selects Simplified Chinese. Unknown values fall back to English.
`limit` (1–100), `after_seq`, and `before_seq` use the same bounds as the REST
message list; the two sequence parameters are mutually exclusive.

## Authorization model

A session authenticates an **account**, not a speaker. For every data read the
server derives a viewer principal from the account's owned speakers:

1. Select active, non-removed memberships in the target project whose speaker is
   owned by the session account, and where the speaker, account, and project are
   all active.
2. Intersect each membership's capability set with the read required by the
   route (`project.read` for the project list, `message.read` for the timeline,
   body, and read receipts).
3. Pick the first qualifying speaker by `(speakers.created_at, speakers.id)` and
   construct the normal `Principal` shape used by bearer authentication, with
   `sessionViewer: true`. Call the existing service functions
   (`listProjects`, `listMessages`, `getMessageBody`, `listReadReceipts`); no
   parallel data path exists.

Union across owned speakers means **at least one owned speaker's active
membership grants the requested capability**. The project list spans all such
speakers; a project page uses one deterministic speaker because the service
functions take one principal.

The session viewer has no credential and no `credential_project_grants` row.
`authorizeProject` therefore takes an explicit session branch that checks the
same project, membership, speaker-ownership, and account state, requires the
requested scope in the parsed membership capabilities, and returns **only that
read scope** as the session principal's `scopes` and the authorization result's
`rights`/`capabilities`. It never returns or authorizes the membership's receipt
or write capabilities, and it does not substitute a speaker credential or its
scopes. The `sessionViewer` flag is set in code only and is
never read from request input; a bearer principal never has it.

Fail-closed behavior:

- A project with no qualifying membership is a uniform `404`, never `403`, so
  the page does not reveal whether a project exists.
- A removed membership, a non-member account, a foreign account's project, an
  inactive project/speaker/account, or no eligible speaker is `404`.
- A revoked, expired, idle-expired, or malformed session redirects to
  `/login?return_to=<normalized current path>`.
- Body reveal uses `getMessageBody`, which re-authorizes `message.read` after
  decryption and before returning plaintext. An expired body is `410`; an
  integrity failure is a generic safe error page with no partial content.

No dashboard request performs a project, message, membership, credential, or
read-receipt write, and none marks a message read. The only writes are the session
row inserted by `POST /login` and the `sessions.last_seen_at` refresh performed by
authenticated page requests. Read receipt identities are displayed only through
`listReadReceipts`, which authorizes `message.read` and re-applies the project filter.

## Rendering and security

- Every dynamic value passes through `escapeHtml` (`src/app/html.ts`). Project
  titles, summaries, speaker display names, message summaries, reply references,
  identifiers, and dates are escaped in text and attribute positions.
- Message bodies are rendered as escaped text inside `<pre>`; message content is
  never interpreted as HTML, Markdown, or script. There is no message-driven
  markup, preview, or link.
- There is no inline script or style and no third-party resource. The only
  stylesheet is `/static/app.css`, served from a constant string.
- Every HTML response carries `Cache-Control: no-store`,
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY`, and
  `Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`.
- The dashboard never logs bodies, summaries, tokens, cookies, CSRF values,
  email addresses, or full IPs. The existing request logger records method, path,
  status, duration, and actor identifiers only; dashboard routes do not set an
  actor on the HTTP context.
- SQL is parameterized. Message and project identifiers come from the path and
  are bound as parameters; they are never interpolated.

## Sign-in and CSRF

`GET /login` renders a form with hidden `return_to` and `login_csrf` fields and
sets a short-lived `corkboard_web_login` cookie (`HttpOnly`, `Secure`,
`SameSite=Lax`, `Path=/login`). `POST /login` requires
`application/x-www-form-urlencoded`, then compares the hidden value and cookie
as SHA-256 digests in constant time. A missing, duplicate, or mismatched value
returns the expired-form page and creates no session.

Browser fetch metadata is checked as defense in depth: a `Sec-Fetch-Site` value
other than `same-origin` or `none`, or a non-null browser `Origin` whose host
differs from the request host, also returns the expired-form page. An absent or
`Origin: null` value is not a usable assertion and falls back to the double-submit
value. The host comparison ignores the scheme so TLS termination at a reverse
proxy does not break the check.

`return_to` must be a same-origin path. Absolute URLs, scheme-relative values,
backslashes, control characters, and values longer than 2,048 characters are
rejected. The redirect target is re-derived from the URL parser and never echoes
the raw value. Empty/absent values go to `/`.

On success the server issues the existing session and CSRF cookies, clears the
login CSRF cookie, and returns `303` to the normalized target. Login attempts
share the existing per-email-digest rate limiter and return `429` with
`Retry-After` on the HTML error page.

## Internationalization

- Resource catalogs for English and Simplified Chinese cover every UI string.
- `?lang=zh` selects Chinese; `?lang=en` and unknown values select English.
  Selection is server-side only.
- The document carries `lang="en"` or `lang="zh-Hans"` and `dir="ltr"`.
- Dates use `Intl.DateTimeFormat` for `en-US` or `zh-CN` with `timeZone: "UTC"`
  and an explicit `UTC` suffix.
- The visible language switch is two ordinary links that preserve the current
  path and query, changing only `lang`. It is keyboard-operable and the current
  language is marked with `aria-current`.

## Accessibility

- Semantic `header`, `nav`, and `main` landmarks, one `h1` per page, and a
  descending heading hierarchy.
- A skip link targets `main`, which is focusable.
- Projects use a list of articles; messages use an ordered list of articles with
  description lists for sender, committed time, reply reference, and read
  receipts. A `<pre tabindex="0">` exposes the revealed body to the keyboard.
- Every control has a visible label; focus indicators are always visible.
- State is expressed with text (for example "expired", "Active"), never by color
  alone.

## Limits

- Read-only by design: no write, send, edit, membership, credential, key,
  expiry, or admin action.
- The project list is bounded to the API maximum (100 per request) and has no UI
  pagination; the REST API still paginates.
- No search, metadata filters, past-replay scrubber, attachments, file previews,
  or image rendering.
- No project create/edit, speaker directory, credential management, membership
  editor, registration, email verification, password reset, or account settings.
- No client-side navigation or live updates; every action is a full page load.
- Server-side rendering only; there is no CSRF protection for state-changing
  dashboard actions because there are none (login is the only form and uses the
  double-submit plus fetch-metadata checks).
- Accessibility evidence consists of committed DOM assertions, semantic markup,
  and manual browser inspection. No automated axe audit has been run and no WCAG
  conformance level is claimed.
