# OAuth 2.1 authorization server (MCP linking)

**Status: authorization-server core implemented and locally verified for the
self-hosted Node.js 24 + SQLite deployment.** The ChatGPT Web plugin
installation/sharing experience and conversation-level ChatGPT tool invocation are
**not implemented and not verified**. No API key is ever part of an OAuth flow.

This slice provides enough OAuth 2.1 for a remote MCP client to obtain a delegated,
speaker-scoped access token for the existing REST and MCP APIs:

- RFC 8414 / RFC 9728 discovery metadata
- RFC 7591 dynamic client registration for **public** clients
- Authorization code with PKCE (`S256`) and a small server-rendered consent page
- Short-lived access tokens issued through the existing `credentials` table
- Rotating refresh tokens with reuse detection
- RFC 7009 revocation

No client secret exists. `token_endpoint_auth_methods_supported` is `none`. Implicit
flow, client credentials, device flow, JWT access tokens/signing, and user
registration are out of scope.

## Configuration

| Variable | Required | Meaning |
| --- | --- | --- |
| `CORKBOARD_PUBLIC_BASE_URL` | for OAuth | Authorization-server origin, for example `https://corkboard.example` |

- The value must be an absolute `https:` origin with no path, query, fragment,
  username, or password. A trailing `/` is normalized away.
- **Invalid value:** startup/`createApp` fails with a fixed error that never includes
  the value. In `startServer` this happens before the data directory is created,
  opened, chmodded, or migrated.
- **Unset/empty:** OAuth is disabled as a feature. Every OAuth and OAuth-discovery
  route returns HTTP `503` with
  `{"error":{"code":"UNAVAILABLE","message":"OAuth is not configured"}}`. Existing
  bearer REST/MCP behavior is unchanged.
- The configured origin is the discovery `issuer` and the protected-resource
  `resource`. It is also the value that an authorization or token request's
  `resource` parameter must equal when that parameter is supplied. It must match how
  clients reach the service; a TLS reverse proxy supplies the origin.

## Discovery

Both documents are public, contain no secrets, and carry `Cache-Control: no-store`
and `X-Content-Type-Options: nosniff`.

`GET /.well-known/oauth-protected-resource`

```json
{
  "resource": "https://corkboard.example",
  "authorization_servers": ["https://corkboard.example"],
  "bearer_methods_supported": ["header"],
  "scopes_supported": ["message.read", "message.send"]
}
```

`GET /.well-known/oauth-authorization-server`

```json
{
  "issuer": "https://corkboard.example",
  "authorization_endpoint": "https://corkboard.example/oauth/authorize",
  "token_endpoint": "https://corkboard.example/oauth/token",
  "registration_endpoint": "https://corkboard.example/oauth/register",
  "revocation_endpoint": "https://corkboard.example/oauth/revoke",
  "response_types_supported": ["code"],
  "grant_types_supported": ["authorization_code", "refresh_token"],
  "code_challenge_methods_supported": ["S256"],
  "token_endpoint_auth_methods_supported": ["none"],
  "scopes_supported": ["message.read", "message.send"]
}
```

## Dynamic client registration

`POST /oauth/register` — `Content-Type: application/json` (parameters allowed).

Request metadata:

```json
{
  "client_name": "Example MCP client",
  "redirect_uris": ["https://client.example/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

Rules:

- `redirect_uris`: 1–10 distinct absolute URIs, each ≤2048 characters, with no
  fragment and no userinfo. `https:` is required. Plain `http:` is accepted **only**
  for `127.0.0.1` and `localhost` loopback clients (RFC 8252 local development).
  Exact string matching is used later, so the registered value is the only accepted
  redirect.
- `client_name`: 1–100 printable characters.
- `token_endpoint_auth_method`, when present, must be `none`.
- `grant_types`, when present, must contain `authorization_code` and may contain
  `refresh_token`. A client registered without `refresh_token` receives no refresh
  token and cannot use the refresh grant.
- `response_types`, when present, must be exactly `["code"]`.
- Unknown metadata fields are ignored. Invalid metadata returns `400`
  `{"error":"invalid_client_metadata"}`.
- Body cap: 64 KiB. Process-local registration limiter: **10 requests/minute, burst
  5**, keyed globally (registration is unauthenticated). It remains a single bucket,
  so endpoint availability under sustained abuse is a reverse-proxy concern. Not
  distributed.

Success is `201` and returns only registered metadata:

```json
{
  "client_id": "cb_cli_...",
  "client_name": "Example MCP client",
  "redirect_uris": ["https://client.example/callback"],
  "token_endpoint_auth_method": "none",
  "grant_types": ["authorization_code", "refresh_token"],
  "response_types": ["code"]
}
```

`client_id` is opaque and random. **There is no client secret and no API key in any
OAuth request or response.**

## Authorization

`GET /oauth/authorize` with:

| Parameter | Required | Notes |
| --- | --- | --- |
| `response_type` | yes | exactly `code` |
| `client_id` | yes | registered public client |
| `redirect_uri` | yes | exact match with a registered URI |
| `state` | no | ≤512 characters, no control characters; returned unchanged |
| `code_challenge` | yes | base64url S256 challenge, 43 characters |
| `code_challenge_method` | yes | exactly `S256` |
| `resource` | no | must equal the configured base URL; defaults to it |
| `scope` | no | space-delimited subset of `message.read` / `message.send`; absent means both |
| `speaker_id` | no | optional preselection hint; revalidated server-side |
| `project_id` | no | optional preselection hint; revalidated server-side |

- If the client or redirect URI is invalid, the server renders an HTML `400` and
  **never redirects**.
- If the redirect is valid but another parameter is invalid, the server redirects to
  the registered URI with `error` (`unsupported_response_type`, `invalid_request`,
  `invalid_target`, or `invalid_scope`) and the supplied `state`.
- Only `message.read` and `message.send` are accepted. `project.read`,
  `receipt.write`, `project.edit`, `member.read`, and `member.manage` are rejected at
  the authorization endpoint and can never be granted through OAuth.
- `resource` is bound to the authorization code and checked again at exchange.

### Sign-in page

Authorization requires the existing human session cookie. Without one, the server
renders a minimal HTML form at the authorize URL. The form posts
`application/x-www-form-urlencoded` to `POST /oauth/signin`, a thin same-origin
handler that performs the same `loginAccount` path as `POST /api/v1/session` (the
JSON/content-type rule of `/api/v1/session` is unchanged) and issues the same
`__Host-corkboard_session` and `corkboard_csrf` cookies.

- The form carries a 256-bit double-submit value in a hidden field and in a
  `HttpOnly; Secure; SameSite=Lax; Path=/oauth` cookie. A cross-site form POST cannot
  read the value and does not send the Lax cookie, so it fails.
- `return_to` is accepted only as a relative `/oauth/authorize?...` path on the
  configured origin, at most 8192 characters, with no control characters. The
  response redirects to the parsed, normalized path and query, never the raw supplied
  string; invalid values are `400` and create no session.
- Failed sign-in is uniform (`401`) and does not reveal whether the account exists.
  The sign-in attempt uses the same per-email login limiter as the session endpoint.
- The page has no inline JavaScript and no third-party resources.

### Consent page

After sign-in, the server lists **only speakers owned by the signed-in account** with
an active membership in an active project whose capability set contains every
requested scope. Nothing from another account, project, removed membership, suspended
speaker, or inactive project is shown.

The page shows:

- the requesting `client_name` (escaped),
- selectors for the candidate speaker and project,
- checkboxes for the requested `message.read` / `message.send` scopes,
- Allow and Deny buttons.

Project titles, speaker names, client names, state, and every other value are
HTML-escaped. The page has no inline script and no third-party resources; the only
script is the constant same-origin `GET /oauth/client.js`, used to submit the form
with the required CSRF header. Without JavaScript the consent cannot be submitted
(a `<noscript>` notice says so); the sign-in form still works without JavaScript.

`POST /oauth/consent` requires:

1. the session cookie (`401` if missing/invalid), and
2. a matching `X-CSRF-Token` header (`403` if missing/wrong), and
3. `Content-Type: application/x-www-form-urlencoded`.

It re-reads the client, exact redirect URI, S256 challenge, resource, speaker
ownership, active speaker/account/project, and the active membership's capabilities
from storage. The submitted form is never trusted for authorization. The form also
carries a server-issued HMAC over the client, redirect, state, challenge, resource,
requested scope set, and issuing session id; `requested_scope` and
`request_signature` are mandatory and must verify before a code is issued. The
session binding prevents replaying a signature obtained in one session into another.
A consent submission that omits or forges either field, or selects/claims a scope
outside the signed request, is rejected with `400`.
Selecting an unowned speaker, a project without an active membership, or a scope the
membership does not hold returns `403` and issues no code.

- Allow returns `200` `{"redirect_to":"<registered redirect with code and state>"}`.
  The served script navigates there. The code is random 256-bit and single-use.
- Deny returns `200` with `redirect_to` carrying `error=access_denied` and `state`,
  and issues no code.
- Authorization codes live for **5 minutes**, are consumed by one conditional
  `UPDATE`, and are bound to the client, account, the issuing session, speaker,
  project, scopes, redirect URI, resource, and PKCE verifier. If that session is
  revoked, expired, or idle-expired before exchange, the code fails `invalid_grant`.

## Token endpoint

`POST /oauth/token` — `Content-Type: application/x-www-form-urlencoded` only; other
media types are `400 {"error":"invalid_request"}`. Body cap 64 KiB. Process-local
token-exchange limiters: **60 requests/minute, burst 20** keyed by submitted
`client_id` (bounded map), plus a global **300 requests/minute, burst 60** bucket for
the endpoint, so rotating an unauthenticated `client_id` cannot bypass limiting. Not
distributed.

### `grant_type=authorization_code`

Fields: `client_id`, `code`, `redirect_uri`, `code_verifier`, optional `resource`.

- The exact client and registered redirect must match.
- PKCE S256 is mandatory. The stored verifier is a keyed HMAC over
  `<authorization code>\n<S256(verifier)>`, compared at fixed length; the server never
  stores the raw code or verifier.
- The code must be unused and unexpired. A second exchange is `invalid_grant`.
- Speaker ownership, account/speaker/project status, membership, capabilities, and
  scopes are re-checked at exchange. If any were revoked after consent, the exchange
  fails `invalid_grant` and mints nothing.
- Success:

```json
{
  "access_token": "cb_oat_...",
  "token_type": "Bearer",
  "expires_in": 3600,
  "refresh_token": "cb_ort_...",
  "scope": "message.read message.send"
}
```

### `grant_type=refresh_token`

Fields: `client_id`, `refresh_token`, optional `scope`.

- Refresh is available only to a client registered with the `refresh_token` grant. A
  code-only client's exchange omits `refresh_token`, and presenting a refresh grant
  for such a client returns `unauthorized_client`.
- Every refresh **rotates** both the refresh token and the access token. A new row is
  inserted in the same refresh family; the previous row is marked `rotated_at`; the
  single underlying access credential's prefix, HMAC verifier, and expiry are
  replaced. The previous access token stops working immediately.
- A refresh token that is already rotated or revoked (reuse) revokes the **whole
  family and the underlying credential** and returns `invalid_grant`.
- Concurrent refresh with the same token is a race: the loser observes a rotated row
  and therefore revokes the family. Clients must serialize refresh.
- `scope` may be omitted. If supplied it must equal the originally consented set;
  this slice supports neither widening nor narrowing, so a different set returns
  `invalid_scope`.
- Membership removal, a capability downgrade, an inactive speaker/account/project, or
  a revoked credential causes `invalid_grant` and revokes the family.
- Refresh tokens live **30 days** from each rotation. Access tokens live **1 hour**.

### Errors

Token failures are uniform JSON objects with no secrets:
`{"error":"invalid_request" | "invalid_grant" | "invalid_scope" |
"unsupported_grant_type" | "unauthorized_client"}`. Unknown clients, unknown codes,
wrong redirects, wrong PKCE verifiers, replayed codes, and revoked consent all return
the same `invalid_grant`, so codes and tokens cannot be enumerated. Codes and tokens
are never logged.

## Revocation

`POST /oauth/revoke` — `application/x-www-form-urlencoded`, fields `token` and
`client_id`.

- RFC 7009 semantics: a well-formed request returns **`200` with an empty body** even
  when the token is unknown, already revoked, a speaker token, or belongs to another
  client. There is no revocation oracle.
- A refresh token revokes its family and the underlying credential.
- An access token revokes the credential and all its refresh families when it was
  issued by the matching OAuth client.
- A regular `cb_` speaker token is ignored by this endpoint. Existing bearer
  revocation/expiry behavior is unchanged.
- Missing/duplicate parameters, an unsupported content type, or a token longer than
  4096 characters return `400 {"error":"invalid_request"}`.
- Revocation is unauthenticated, so it has a process-local global bucket
  (**60 requests/minute, burst 20**). A request above the limit returns `429`; under
  the limit the RFC 7009 `200` behavior is unchanged. Not distributed.

## Access-token behavior on REST and MCP

Access tokens are ordinary rows in `credentials` with the `cb_oat_` prefix, the
consented scope set, the selected speaker, and one `credential_project_grants` row.
They authenticate through the existing `authenticateBearer`, so:

- every REST and MCP authorization rule is unchanged;
- OAuth can never widen membership, capabilities, or grants;
- `project.read` is not granted, so `/api/v1/me` returns no projects and
  `GET /api/v1/projects` returns `403`; message read/send work only for the consented
  project;
- revocation, expiry, membership removal, capability downgrade, and grant removal
  take effect on the next request (no authorization cache);
- the MCP tools exposed to the token are the same six tools, limited by the
  credential's scopes.

## Headers, intervals, and logging

- Every OAuth JSON, HTML, and script response carries `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`; HTML also carries
  `Content-Security-Policy: default-src 'none'; script-src 'self'; connect-src 'self';
  form-action 'self'; base-uri 'none'; frame-ancestors 'none'` and
  `Referrer-Policy: no-referrer`.
- Request logs retain method, path, status, duration, `requestId`, `errorCode`, and
  actor IDs only. OAuth token and revocation failures use the flat RFC
  `{"error":"..."}` body and are not counted as an `errorCode`. OAuth query strings,
  form bodies, codes, tokens, cookies, CSRF values, client IDs, and scopes are never
  logged.
- Metrics use fixed route labels (`/.well-known/oauth-*`, `/oauth/register`,
  `/oauth/authorize`, `/oauth/signin`, `/oauth/consent`, `/oauth/token`,
  `/oauth/revoke`, `/oauth/client.js`). No client IDs or scopes appear in labels.

## Storage

Migration `004_oauth.sql` adds:

- `oauth_clients(id, client_id UNIQUE, client_name, redirect_uris_json,
  grant_types_json, response_types_json, created_at, status)` — public clients; no
  client secret.
- `oauth_authorization_codes(id, client_id, account_id, speaker_id, project_id,
  session_id, scopes_json, code_prefix, code_verifier_hash, redirect_uri, resource,
  expires_at, consumed_at, created_at)` — only the prefix and a keyed HMAC verifier of
  the code (binding PKCE) are stored; `session_id` binds the code to the human session
  that approved it.
- `oauth_refresh_tokens(id, family_id, client_id, credential_id, token_prefix,
  token_verifier, created_at, expires_at, revoked_at, rotated_at)` — prefix + keyed
  HMAC verifier only; rotation and reuse detection columns.
- `oauth_token_clients(credential_id PK, client_id, created_at)` — durable client
  ownership of an access credential, so revocation does not depend on a refresh row
  (code-only clients mint none).

Migration 004 was revised in place while slice J was unreleased and never on
`origin/main`. No supported installation has a v4 database with the pre-fix shape
(missing `grant_types_json`, `response_types_json`, `session_id`, or
`oauth_token_clients`); a database created by an unreleased pre-fix build must be
recreated, not upgraded in place. Fresh and migration-003 databases are tested.

Access tokens reuse `credentials` and `credential_project_grants`; refresh replaces
that credential's prefix/verifier/expiry in place. The database stores no raw code,
refresh token, access token, cookie, CSRF value, or client secret. Expired/rotated
OAuth rows are inert but are not automatically purged; no cleanup command exists.

## Limits and explicit non-goals

- No ChatGPT Web plugin installation, account-linking UI, sharing, or
  conversation-level tool invocation is implemented or verified. Do not claim those
  from this local flow.
- No client secret, API key, JWT signing, implicit flow, client credentials, device
  flow, OIDC identity token, userinfo endpoint, or token introspection endpoint.
- No consent persistence/management screen, per-client revocation UI, or
  administrative OAuth endpoints.
- No CORS. OAuth routes are browser-facing same-origin pages plus server-to-server
  token calls.
- Rate limits and registration/token state are process-local and reset on restart.
- The Node adapter enforces the same 64 KiB body cap for OAuth POSTs.
- One consent is expected to leave exactly one `credential_project_grants` row on its
  access credential. If an operator manually adds another grant to that credential
  (the CLI `grant-key-project` does not know about OAuth), the live access token may
  work in that project until it expires, and the next refresh fails closed (`invalid_grant`)
  and revokes the family. Do not manage OAuth-issued credentials with the CLI grant
  commands.
- D1/Workers parity, real ChatGPT, and browser testing are not verified.
- OAuth consent, code issuance, token minting, rotation, and revocation are not
  written to `audit_events` in this slice; request logs still record route/status/
  duration only.
