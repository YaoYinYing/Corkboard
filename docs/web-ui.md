# Read-only human web dashboard

**Status: implemented locally for Node.js + SQLite (vertical slices L and M, with
the approved design system tokens applied).**
The dashboard is server-rendered HTML for a signed-in **account**. It is strictly
read-only: there is no send, edit, membership, credential, key, expiry,
moderation, or administrative action. It is not a SPA and ships no frontend
framework, build step, or client script. Slice M adds metadata filters, a
summary-only search, bounded cursor replay, and a CSS-only responsive layout.

Cloudflare Workers/D1 parity, account registration/recovery, and any write UI
remain unimplemented. See `IMPLEMENTATION_STATE.md` for the current evidence.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/login` | `GET` | Sign-in form; issues a login CSRF cookie. |
| `/login` | `POST` | Form-encoded sign-in with double-submit CSRF and normalized `return_to`. |
| `/` | `GET` | Readable project list for the account. |
| `/projects/:projectId` | `GET` | Message timeline in ascending server `seq`, with filters, summary search, and cursor replay. |
| `/projects/:projectId/messages/:messageId/body` | `GET` | Explicit body reveal through the existing decrypt path. |
| `/static/app.css` | `GET` | Fixed same-origin stylesheet; constant body, no user input. |

`?lang=zh` selects Simplified Chinese. Unknown values fall back to English.
`lang` is preserved by the filter form and every pager link. The timeline query
parameters are the same identifiers and bounds as the REST message list; they are
parsed by the page and passed unchanged to `listMessages`.

| Param | Meaning |
| --- | --- |
| `type` | Exact message type identifier (`^[a-z][a-z0-9_.-]{0,31}$`). |
| `sender` | Exact **speaker ID**, not a display name; the speaker must be a project member. |
| `q` | Case-insensitive substring over **summary metadata only**, at most 100 characters. Wildcards are escaped. Case folding is the SQLite `LIKE` behavior, which is ASCII-only for this deployment. Message bodies are never searched. |
| `unread` | Literal `true` or `false`, relative to the deterministic session viewer speaker (see below). |
| `limit` | 1–100, default 50, matching the API. |
| `after_seq` / `before_seq` | Non-negative integer cursors; at most one may be present. They are mutually exclusive. |

Malformed or out-of-range values (for example `limit=0`, `after_seq=abc`, both
cursors, `unread=yes`, an invalid `type`, a summary query longer than 100
characters, or a sender that is not a project member) return the safe `400`
page. A project the account may not read returns the uniform `404` **before**
filter parsing, so filters cannot probe project existence. An empty `q` is
ignored, as in the API.

The `unread` filter uses the same receipt-based meaning as
`GET /api/v1/projects/:projectId/messages`: `true` selects messages without a
`message_receipts` row for the calling viewer speaker and `false` selects those
that have one. The dashboard's viewer speaker is the deterministic first
qualifying owned speaker from `resolveSessionViewer`; it is displayed nowhere as
a selectable identity. The filter only reads receipts and never marks a message
read.

### Pager semantics

The service always returns ascending `seq`. Without a cursor the page starts at
the oldest sequence. "Older messages" sets `before_seq` to the first returned
sequence; "Newer messages" sets `after_seq` to the last returned sequence; each
link preserves `lang`, `limit`, and every active filter and clears the other
cursor. "Jump to latest" sets `before_seq` to `Number.MAX_SAFE_INTEGER`, which
the service interprets as the latest page.

`listMessages` internally fetches one row beyond `limit` and reports an internal
`hasMore` boolean. The page uses it to omit a link when no older/newer matching
row exists; `hasMore` is never serialized by REST or MCP, whose responses are
unchanged. On a **non-empty** page, a page reached with `before_seq` always offers
"newer" unless it is already the jump-to-latest page, and an `after_seq` page
offers "older" when the cursor is above zero. The latter is an inference, not a
probe: with an active metadata filter that matched no earlier row, that "older"
link can lead to one empty page. It is bounded to a single page and keeps the
filter state. An **empty** result renders only the empty-state message, plus a
"Jump to latest" link when a cursor is present and the page is not already the
jump-to-latest page; it renders no older or newer link. All navigation is bounded
by the validated `limit`; there is no unbounded loop, recursive fetch, or client
polling.

### Active filter state

The page renders the active `type`, `sender`, `q`, and `unread` values in an
escaped "Active filters" line and pre-fills the labeled filter controls.
`unread=true` is shown as "Unread only" and `unread=false` as "Read only"; both
are active filters, so an empty result uses the filtered empty state and the
clear link appears. The unread checkbox reflects only the "unread only" state;
submitting the form without it replaces a `Read only` selection, and the clear
link removes it. "Clear filters" removes the filters and both cursors while
preserving `lang` and `limit`. Filter state values are always escaped in text and
attribute positions. The filter form submits with `GET` and resets the cursors,
so applying a filter starts at the oldest matching page.

### Responsive layout

The layout is CSS-only; there is no inline style or script. Narrow screens use a
single-column stacked card per message (the description list collapses to one
column). Wide screens (`min-width: 48rem`) use a table-like two-pair-per-row
metadata grid. The filter form uses an auto-fitting grid and all controls have
bounded width. The page keeps a 1rem (16px) side gutter at phone width and
wraps long summaries, identifiers, and dates, so it does not require horizontal
page scrolling. Focus indicators are visible on links, buttons, inputs, and
preformatted body text.

### Design tokens and theming

The stylesheet is compiled from `designs/corkboard-design-system/project/tokens.json`.
Semantic colour tokens are CSS custom properties on `:root` (`--surface`,
`--surface-raised`, `--surface-muted`, `--ink`, `--ink-muted`, `--border`,
`--brand`, `--brand-ink`, `--accent`, `--danger`, `--focus`, `--link`,
`--success`). Spacing (`--space-1` 4px through `--space-8` 32px), radii
(`--radius-sm` 4px, `--radius-md` 8px, `--radius-lg` 12px), and the
`--font-sans`/`--font-mono` system stacks are defined beside them. Rules use the
custom properties; the literal hex values exist only in the token definitions.
`--accent` is part of the approved palette and is reserved for secondary
emphasis; it is currently unused. Links continue to use `--link`, matching the
component previews.

The light palette is the default (`color-scheme: light`). A
`@media (prefers-color-scheme: dark)` block overrides the colour tokens and sets
`color-scheme: dark`. There is no script and no server-rendered `data-theme`.
Fonts are the token system stacks, so no font request occurs.

The page keeps one 60rem measure with a `--space-4` gutter. Keyboard focus uses
`outline: 3px solid var(--focus); outline-offset: 2px` on links, buttons, inputs,
selects, and the focusable `<pre>`. Primary buttons ("Apply filters", "Sign in")
use a `--brand` fill with `--brand-ink` text. State pairs its text with a 4px
rail: `.error` uses `--danger`, while the tombstone `.state.expired` and the
active-filter `.filter-state` use `--border`. Project status uses `--success`
only together with the word "Active", never colour alone.

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

Timeline filters, search, and cursors add no authorization decision. The viewer
is resolved and the project is authorized before any query parameter is parsed;
`listMessages` then authorizes `message.read` again and applies the filters in
parameterized SQL under the same project scope. The sender filter's membership
check runs only after that authorization, so it cannot reveal membership of an
unreadable project. There is no second data path and no new SQL access to
message bodies.

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
  identifiers, dates, and every reflected filter value (in input `value`
  attributes and the active-filter line) are escaped in text and attribute
  positions.
- Message bodies are rendered as escaped text inside `<pre>`; message content is
  never interpreted as HTML, Markdown, or script. There is no message-driven
  markup, preview, or link.
- Search is summary metadata only. The `q` value is passed to the existing
  `listMessages` summary `LIKE` clause with escaped wildcards; encrypted bodies
  are never queried, decrypted, indexed, or searched.
- There is no inline script, `<style>` block, `style=` attribute, or third-party
  resource. The only stylesheet is `/static/app.css`, served same-origin from a
  constant string under `style-src 'self'`. The token colour values are the only
  literal hex values, and the fonts are the token system stacks, so the
  stylesheet contains no `@import` or `url()` fetch and needs no CSP relaxation.
  The filter form is a plain `GET` form, so filtering, replay, and pagination
  work without JavaScript.
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
- Every control has a visible label: the filter form has labeled `type`,
  `sender`, `q`, `unread`, and `limit` controls with `for`/`id` pairs and hints
  for the sender and search fields. Pager links are ordinary anchors inside a
  labeled navigation landmark, and a skip link targets `main`.
- Focus indicators are always visible on links, buttons, inputs, and preformatted
  body text. State is expressed with text (for example "expired", "Active",
  "Active filters"), never by color alone.

## Limits

- Read-only by design: no write, send, edit, membership, credential, key,
  expiry, or admin action.
- The project list is bounded to the API maximum (100 per request) and has no UI
  pagination; the REST API still paginates.
- Search covers message **summaries only**. There is no body search, full-text
  index, ranking, highlighting, saved search, or search across projects.
- `type` and `sender` are exact-match filters using the API identifiers. The
  sender is a speaker ID and must be a project member; display names are not
  accepted and the UI does not expose a member picker.
- The `unread` filter reflects the deterministic session viewer speaker, not an
  arbitrary chosen speaker. It never writes a receipt.
- Replay offers bounded previous/next pages plus "jump to latest"; there is no
  time scrubber, date filter, infinite scroll, or client-side history.
- No attachments, file previews, or image rendering; no project create/edit,
  speaker directory, credential management, membership editor, registration,
  email verification, password reset, or account settings.
- No client-side navigation or live updates; every action is a full page load.
  Responsible JavaScript frameworks, bundlers, and frontend dependencies are not
  used.
- Server-side rendering only; there is no CSRF protection for state-changing
  dashboard actions because there are none (login is the only form and uses the
  double-submit plus fetch-metadata checks). The filter form is `GET` only.
- Accessibility evidence consists of committed DOM assertions, semantic markup,
  and manual browser inspection. No automated axe audit has been run and no WCAG
  conformance level is claimed. No exact-revision browser matrix or touch-device
  test is claimed; responsiveness is asserted from the stylesheet and markup.
