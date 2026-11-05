# Human web dashboard

**Status: implemented locally for Node.js + SQLite (vertical slices L and M plus
dashboard project create/edit, speaker credential issuance, and the per-project
membership editor, with the approved design system tokens applied).**
The dashboard is server-rendered HTML for a signed-in **account**. Message reads,
filters, replay, and body reveal remain read-only. The writes are project create,
project title/summary edit, issuing one speaker credential with explicit project
grants, and adding/removing a project membership with an explicit capability set.
There is no message send, expiry, credential rotation/revocation or grant editing,
moderation, or administrative action. It is not a SPA and ships
no frontend framework, build step, or client script. Slice M adds metadata filters, a
summary-only search, bounded cursor replay, and a CSS-only responsive layout.

Cloudflare Workers/D1 parity, account registration/recovery, and the remaining
write/admin surfaces (messages, credential rotation/revocation, expiry) remain
unimplemented. See `IMPLEMENTATION_STATE.md` for the current evidence.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/login` | `GET` | Sign-in form; issues a login CSRF cookie. |
| `/login` | `POST` | Form-encoded sign-in with double-submit CSRF and normalized `return_to`. |
| `/` | `GET` | Readable project list for the account, with a link to the create form. |
| `/projects/new` | `GET` | New-project form. |
| `/projects` | `POST` | Form-encoded project create; redirects after POST. |
| `/projects/:projectId` | `GET` | Message timeline in ascending server `seq`, with filters, summary search, and cursor replay. |
| `/projects/:projectId` | `POST` | Form-encoded project edit; redirects after POST. |
| `/projects/:projectId/edit` | `GET` | Edit form for an owner. |
| `/projects/:projectId/members` | `GET` | Active membership list and add form; requires the signed-in account to own the project. |
| `/projects/:projectId/members` | `POST` | Form-encoded add of an active owned speaker with an explicit capability set; `303` to the list. |
| `/projects/:projectId/members/:speakerId/remove` | `POST` | Form-encoded removal; deletes that speaker's grants for the project; `303` to the list. |
| `/projects/:projectId/messages/:messageId/body` | `GET` | Explicit body reveal through the existing decrypt path. |
| `/speakers` | `GET` | Speakers owned by the signed-in account, with status and active project grants. |
| `/speakers/:speakerId/key` | `GET` | Credential issuance form for an active speaker owned by the account. |
| `/speakers/:speakerId/key` | `POST` | Form-encoded issuance for explicitly selected projects and scopes; one-time no-store display. |
| `/static/app.css` | `GET` | Fixed same-origin stylesheet; constant body, no user input. |

`?lang=zh` selects Simplified Chinese. Unknown values fall back to English.
`lang` is preserved by the filter form and every pager link. The timeline query
parameters are the same identifiers and bounds as the REST message list; the page
parses them and passes only present, non-blank values to `listMessages`.

| Param | Meaning |
| --- | --- |
| `type` | Exact message type identifier (`^[a-z][a-z0-9_.-]{0,31}$`). |
| `sender` | Exact **speaker ID**, not a display name; the speaker must be a project member. |
| `q` | Case-insensitive substring over **summary metadata only**, at most 100 characters. Wildcards are escaped. Case folding is the SQLite `LIKE` behavior, which is ASCII-only for this deployment. Message bodies are never searched. |
| `unread` | Literal `true` or `false`, relative to the deterministic session viewer speaker (see below). |
| `limit` | 1–100, default 50, matching the API. |
| `after_seq` / `before_seq` | Non-negative integer cursors; at most one may be present. They are mutually exclusive. |

Malformed or out-of-range non-blank values (for example `limit=0`,
`after_seq=abc`, both cursors, `unread=yes`, an invalid `type`, a summary query
longer than 100 characters, or a sender that is not a project member) return the
safe `400` page. A project the account may not read returns the uniform `404`
**before** filter parsing, so filters cannot probe project existence.

A blank or whitespace-only value for any documented filter or cursor parameter
(`type`, `sender`, `q`, `unread`, `limit`, `after_seq`, `before_seq`) is treated
as **absent**, never as invalid input. The browser submits the blank text and
number inputs, so an empty value reaches the parser and means "not set"; an
unchecked `unread` checkbox is simply omitted. Identifier and cursor values are
not trimmed: a non-blank value with surrounding whitespace still fails
validation. Search text (`q`) is preserved literally, so surrounding spaces are
part of the search. The REST message list does not share this blank-is-absent
rule (see `api.md`).

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

## Project create and edit

`GET /projects/new` renders a no-JavaScript form with a title and an optional
summary. `POST /projects` creates the project and redirects (`303`) to its
timeline. `GET /projects/:projectId/edit` renders the same form with the current
values, and `POST /projects/:projectId` updates only `title` and `summary` and
redirects (`303`) to the timeline. The dashboard (`/`) links to the create form;
the timeline links to the edit form only when the viewer holds `project.edit`.
The timeline has no create link. Forms preserve `?lang=zh`, including the
`303` redirect after a successful create or edit.

Both forms submit `application/x-www-form-urlencoded` with a hidden `csrf_token`.
The request body is bounded to 64 KiB, the same limit as the login form. The Node
adapter buffers POST bodies on every non-root web path the router recognizes:
sign-in, project create/edit, and POSTs to GET-only pages such as `/projects/new`,
`/projects/:projectId/edit`, `/projects/:projectId/messages/:messageId/body`, and
`/static/app.css`. Those GET-only POSTs still get the router's `405`, but their
body is buffered up to the cap first; the root `/` is excluded. GET, HEAD, and
DELETE requests stay unbuffered. A chunked or declared body over the cap is
rejected with `413` by the adapter before the handler runs. The
`title` field is required and must be 1–140 Unicode graphemes and at most 1024
UTF-8 bytes; a title that is empty or whitespace-only is rejected. The optional
`summary` uses the same bounds; an empty or whitespace-only summary is stored as
`NULL`. Project name and summary text are otherwise preserved as entered. Title
and summary validation lives in the service, using the domain validators in
`src/domain/validation.ts`; the route maps a service `VALIDATION_ERROR` to the
safe form error. The HTML `maxlength="140"` is only a convenience and is not the
authority.

Create requires an authenticated, active account that owns at least one active
speaker. The service creates the project with that account as
`owner_account_id` and adds an owner membership — all seven capabilities — for the
deterministic first active owned speaker (ordered by `created_at`, then `id`, the
same ordering used to resolve the read viewer). This is what makes the new
project visible and editable in the dashboard. Create does not create a speaker,
a credential, or a credential-to-project grant, and there is no member editor in
this slice. An account with no active owned speaker gets the safe invalid-request
form error and no project is written.

The project and owner membership are written in one database transaction. The
SQLite adapter runs `BEGIN IMMEDIATE` and commits only after both inserts
succeed; any error, or a crash before commit, rolls both rows back. A created
project therefore always has the owner membership that makes it reachable and
editable, and an interrupted create leaves no invisible orphan project. A D1
adapter would have to implement the same `transaction` port (D1 has no
interactive transactions, so it must submit the buffered writes as one
`batch`) and pass the shared storage contract; no D1 adapter ships or has been
exercised in this environment.

Edit and update require the owner role as the service layer defines it for
project administration: `project.edit` in the active membership, the same
capability that guards message-body expiry. A member without `project.edit`, a
foreign account, and an unknown project all receive the same uniform `404` page
as an unreadable project; the page does not reveal whether the project exists.
The handler resolves the project-edit viewer and parses the body only after that
authorization; `updateProject` re-authorizes `project.edit` at the service layer
before validating or writing.

Invalid input re-renders the form with HTTP `400`, an error summary carrying
`role="alert"`, the localized message "Check the project details and try again.",
and the entered values escaped in place. Duplicate `title` or `summary` fields
take this invalid-input path. A duplicate `csrf_token` is rejected earlier by
the CSRF check as the "form expired" page, not as an invalid field. Internal
validation messages, SQL, and exception text are never rendered. A successful
write is not a message send and creates no receipt.

## Speaker directory and credential issuance

`GET /speakers` is an account-scoped directory. It lists only speakers whose
`speakers.owner_account_id` is the signed-in account, including inactive speakers
(shown with an "Inactive" status). Each entry shows the speaker's opaque ID, display
name (or the ID when the name is empty), status, and **active project grants**: the
projects where the speaker has a non-removed membership and the speaker, account, and
project are all active. A speaker owned by another account never appears, and the
directory has no account selector or query parameter, so it cannot be used to
enumerate another account's speakers. Existing credentials, prefixes, and tokens are
not listed.

The issue form is `GET /speakers/:speakerId/key`. It is available only for an active
speaker owned by the session account. The service resolves the speaker with
`WHERE id = ? AND owner_account_id = ?` plus active speaker/account checks; a foreign,
unknown, or inactive speaker is the same uniform `404`, and the route resolves it
before parsing the request body, so a malformed body cannot change that answer. The
directory renders the issue link only for active speakers.

The form lists the speaker's active projects as checkboxes and the union of the
capabilities those memberships grant. `POST /speakers/:speakerId/key` requires at least one selected
project and at least one selected scope, and at most **100** projects. Each selected
project must be an active project where this speaker has an active membership, and
**every requested scope must already be one of that project's membership
capabilities** (the same rule as the `issue-key` CLI, applied to every selected
project). An unknown, foreign, inactive, or non-member project, an unknown scope, an
empty selection, more than 100 projects, or a scope missing from any selected project
returns HTTP `400` with the localized `role="alert"` form error and performs no write.
Duplicate form values are collapsed; selection order is not authoritative.

Issuance reuses the existing generation/verifier path: a fresh 256-bit random
`cb_` token, whose only stored forms are the 12-character public prefix and a keyed
HMAC-SHA-256 verifier under the credential pepper. Inside the write transaction the
service re-reads every selected membership with `removed_at IS NULL` and active
speaker/project/account checks, and re-checks the requested scopes, before inserting
the credential and grants. A membership removed or deactivated between the fast
pre-check and the write therefore fails the transaction and rolls the whole issuance
back; no credential or grant remains. The credential row and one
`credential_project_grants` row per selected project are committed together. Grants
are never inferred from membership: a project the speaker belongs to but the user did
not select gets no grant, so the credential cannot use it. There is no expiry field in
this UI, so `expires_at` is `NULL` (unlimited until revoked). A successful issue writes
one sanitized `credential.issue` audit event containing the speaker, account, up to 32
project IDs, `project_count` (the true selected count), and scope names only; the
token, prefix, and verifier are never audited. The 32-ID/2,048-character audit detail
bound is documented in `security-operations.md`.

### One-time credential display

The raw token is returned **only** in the `POST` response body. It is not placed in a
URL, redirect, cookie, hidden field, database column, session state, or log, so the
POST returns the display page directly (`200`) instead of a `303` redirect. That page
is the only place the value is shown: it carries the usual `Cache-Control: no-store`
and strict CSP, a `role="alert"` warning to copy the credential now, the speaker, the
granted projects, and the scopes. Reopening `/speakers`, opening the form again,
following any link, or loading any later page never renders the token again. A browser
re-submit of the POST is a new issuance and creates a **different** credential; it
does not reveal the earlier token. There is no recovery, rotation, or revocation view
in this slice; operators use the CLI commands documented in `security-operations.md`.

The credential forms use the same session CSRF defense as the project forms: the
`corkboard_csrf` cookie plus exactly one non-empty hidden `csrf_token` field, compared
as SHA-256 digests in constant time, plus the `Sec-Fetch-Site`/`Origin` checks. The
form body is bounded to 64 KiB. Session authentication has already run and may refresh
`sessions.last_seen_at`; the authorization and CSRF checks come before any credential,
grant, or audit write.

## Membership editor

`GET /projects/:projectId/members` lists the project's **active** (non-removed)
memberships, ordered by `joined_at`, then speaker ID. Each entry shows the speaker ID,
display name (or the ID when the name is empty), the membership's capability codes in
canonical order, the joined date, and a remove form. The page also carries the add form.
Access is **project-owner-only**, not merely `project.edit`. The signed-in account
must equal `projects.owner_account_id`, and the project and that account must be
active. A non-owner member who holds `project.edit` is still denied with the uniform
`404`; that matters because such a member could otherwise add a speaker carrying
`message.send` and mint a bearer credential for it. An unknown, foreign, non-owner,
inactive, or non-owner project is the same `404` page, and the route checks ownership
**before** parsing a POST body so a malformed payload cannot probe project existence.
The editor is a human-session surface only; a bearer principal is rejected.

**Add.** `POST /projects/:projectId/members` requires one `speaker_id` field and an
explicit, non-empty `scope` set. Only an **active speaker owned by the signed-in
(owner) account** (with an active owning account) may be added. A foreign, unknown,
inactive, or other-account speaker is the same HTML `400` form error and writes
nothing, so the form is not a cross-account speaker oracle. Every submitted capability
must be one of the seven identifiers (`project.read`, `message.read`, `message.send`,
`receipt.write`, `project.edit`, `member.read`, `member.manage`); duplicate values
collapse and an unknown value rejects the whole request. Because the caller is the
project owner, the owner may grant **any** of the seven, including capabilities the
owner's own membership does not carry; there is no caller-rights cap. An active
duplicate is rejected as an already-active member without changing its capabilities. A
previously removed membership is **reactivated** with the submitted capability set and
a fresh `joined_at`; its old credential grants are not restored. Adding writes only the
membership: no credential, credential grant, or implicit capability is created, and a
membership still grants no credential. The one `membership.grant` audit event records
the actor account, target speaker, project, capabilities, and whether the row was
reactivated.

**Remove.** `POST /projects/:projectId/members/:speakerId/remove` soft-deletes the
membership (`removed_at`) and, mirroring the CLI `remove-member`, deletes every
`credential_project_grants` row that any credential of that speaker held for the
project. A removed credential therefore cannot revive if the speaker is added again;
it needs a new explicit grant. Removal may target any active membership, including one
whose speaker belongs to another account. The exact last-owner rule: a **manageable
owner membership** is a non-removed membership whose speaker is owned by
`projects.owner_account_id`, where the speaker and its owning account are **active**
and the capability set includes `project.edit`. Removing the last remaining manageable
owner membership is refused with the HTML `400` "last owner membership" error, so the
owning account always keeps a membership that can actually administer the project.
Inactive owner memberships and owner memberships lacking `project.edit` neither count
toward nor are protected by that rule. The `membership.remove`
audit row is always written; `credential.project.revoke` is written only when at least
one grant row was actually deleted.

**Transactions and CSRF.** Both writes use one `SqlDatabase.transaction` and re-read
the project's owner and the active account inside it, so ownership transferred away
(or a deactivated project/account) after the request check aborts the write. Remove
re-reads the target membership and the manageable-owner count inside the same
transaction; both the membership update and grant deletion roll back together on
failure. Both routes use the session double-submit (`corkboard_csrf` cookie plus exactly
one hidden `csrf_token`), the `Sec-Fetch-Site`/`Origin` checks, and the 64 KiB body cap.
Forms preserve `?lang=zh`, including their actions and the `303` redirect; the page
renders English or Simplified Chinese.

Cross-account **addition/provisioning** of speakers owned by another account remains
CLI-only (`add-member`); the dashboard owner may add only their own active speakers.
Invitation/acceptance, bulk editing, and capability presets are **not implemented**
(no CLI command exists for them). Removal may target any active (non-removed)
membership; an already removed row returns `NOT_FOUND`. Credential
issuance is available here; credential rotation, revocation, and per-credential grant
editing remain CLI-only.

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
requested scope** as the session principal's `scopes` and the authorization
result's `rights`/`capabilities`. The branch also requires the viewer's own
declared scope set to contain the requested scope, so a viewer resolved for
`message.read` cannot reuse the branch to authorize `project.edit` merely because
its membership has that capability. The session branch permits `project.read`,
`message.read`, and `project.edit`; it never authorizes or returns
`message.send`, `receipt.write`, `member.read`, or `member.manage`, and it does
not substitute a speaker credential or its scopes. The `sessionViewer` flag is
set in code only and is never read from request input; a bearer principal never
has it.

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
- A member without `project.edit` is also `404` on the edit form and update,
  even though the read timeline remains available to that member.
- A revoked, expired, idle-expired, or malformed session redirects to
  `/login?return_to=<normalized current path>`.
- Body reveal uses `getMessageBody`, which re-authorizes `message.read` after
  decryption and before returning plaintext. An expired body is `410`; an
  integrity failure is a generic safe error page with no partial content.

The message read surface performs no project, message, credential, or read-receipt
write, and no page marks a message read. The writes are the session row inserted
by `POST /login`, the `sessions.last_seen_at` refresh on authenticated page
requests, `POST /projects` (project plus owner-membership insert),
`POST /projects/:projectId` (project title/summary update),
`POST /speakers/:speakerId/key` (one credential row plus one grant per explicitly
selected project), `POST /projects/:projectId/members` (one membership insert or
reactivation), and `POST /projects/:projectId/members/:speakerId/remove` (the
membership soft delete plus that speaker's grant deletions). Read receipt identities
are displayed only through
`listReadReceipts`, which authorizes `message.read` and re-applies the project filter.
The speaker directory is an account-level read; it is not a project-scoped route and
does not use `authorizeProject`. Membership administration does not use
`authorizeProject` either: it requires project ownership, as described above.

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
- The dashboard never logs bodies, summaries, tokens (including newly issued
  credentials), CSRF values, email addresses, or full IPs. The existing request logger
  records method, path, status, duration, and actor identifiers only; dashboard routes
  do not set an actor on the HTTP context.
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

### Project and credential form CSRF

The create, edit, and credential-issuance forms use the session CSRF value issued at
sign-in: the
non-`HttpOnly` `corkboard_csrf` cookie plus a hidden `csrf_token` field. `POST`
requires the form media type, checks the same `Sec-Fetch-Site`/`Origin` fetch
metadata as login, requires exactly one non-empty hidden value, compares the
hidden value and cookie as SHA-256 digests in constant time, and then verifies
the presented value against the keyed CSRF verifier on the session row. A
missing, duplicate, or mismatched value, a missing cookie, or a cross-site fetch
metadata assertion returns the form with HTTP `400` and the "form expired"
message and performs no project or membership write. Session authentication has
already run and may refresh `sessions.last_seen_at`; that bookkeeping is the only
write before the check. The form body is read and bounded before the CSRF check.
The CSRF check runs before project input validation and before any project
service call. The edit/update route authorizes the project-edit viewer before
parsing the body, so an unreadable project remains the uniform `404` even for a
malformed or oversized body; create has no project to authorize and reads the
bounded form before checking CSRF.

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
  labeled navigation landmark, and a skip link targets `main`. The project and
  speaker forms use explicit `<label for>`/`id` pairs or implicit label wrapping.
  Project and scope checkbox groups use `<fieldset>`/`<legend>`.
- The one-time credential page presents the token as selectable text (no script-driven
  copy control) and an assertive `role="alert"` warning; the accessible text also
  states that the value is shown once.
- Focus indicators are always visible on links, buttons, inputs, and preformatted
  body text. State is expressed with text (for example "expired", "Active",
  "Active filters"), never by color alone.

## Limits

- Dashboard writes are project create/edit, one credential issuance for a
  selected subset of an owned speaker's active projects, and project-owner
  membership add/remove. There is no message send,
  expiry, credential rotation/revocation, grant editor, expiry
  selection, speaker creation, registration, or admin action. Creating a project does
  not create a speaker or credential; an account without an active owned speaker
  cannot create one from this UI. A speaker's credential can be revoked or have its
  project grants changed only through the CLI.
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
- No attachments, file previews, or image rendering; no credential listing,
  rotation, or revocation UI, no project deletion/status change,
  no speaker creation, no registration, email verification, password reset, or
  account settings. The directory shows active project grants only, not existing
  credentials or their prefixes.
- No client-side navigation or live updates; every action is a full page load.
  Responsible JavaScript frameworks, bundlers, and frontend dependencies are not
  used.
- Server-side rendering only. Login, the project create/edit forms, and the
  credential issuance form are `POST` and use the double-submit plus fetch-metadata
  checks above; the filter
  form is `GET` only. Project forms have no JavaScript validation, autosave,
  optimistic update, or client-side routing.
- Accessibility evidence consists of committed DOM assertions, semantic markup,
  and manual browser inspection. No automated axe audit has been run and no WCAG
  conformance level is claimed. No exact-revision browser matrix or touch-device
  test is claimed; responsiveness is asserted from the stylesheet and markup.
