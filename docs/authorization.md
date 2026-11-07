# Authorization model: actors, resources, and predicates

Status: implemented and tested for the self-hosted Node.js 24 + SQLite deployment.
This document is a contract for the current code, not a design aspiration. The
authoritative implementation is `src/domain/authz.ts` (scope identifiers and the
effective-rights intersection), `src/service/auth.ts` (bearer and session
planning), `src/service/projects.ts` (ownership and membership administration),
`src/service/oauth.ts` (delegation), and the route table in `src/app/handlers.ts`.
Behavior that is not implemented below is called out as absent rather than implied.

## Authentication is not authorization

There are two authentication trust domains, and they never substitute for each
other:

- **Human session** — a server-issued `sessions` row, presented as an `HttpOnly`
  cookie on dashboard/OAuth paths. It authenticates an `accounts` row, not a
  speaker.
- **Bearer credential** — a `credentials` row presented as `Authorization: Bearer
  cb_...` on REST and MCP. It authenticates a speaker through that credential.
  OAuth access tokens (`cb_oat_`) are also `credentials` rows and use this same
  path.

Every project-scoped decision runs in the service layer; HTTP, MCP, and CLI call
the same functions. There is no transport-specific authorization branch, no
authorization cache, and audit rows are never consulted for a decision.

## Actors that exist

| Actor | What it is | How it authenticates | Notes |
| --- | --- | --- | --- |
| Human account | `accounts` row with normalized email and password verifier | `POST /api/v1/session`, then a session cookie | Must be `status = 'active'`. A session cannot act as a speaker credential. |
| Session | `sessions` row bound to an account; token/CSRF values stored only as keyed HMAC verifiers | Session cookie plus double-submit CSRF on state-changing dashboard/OAuth forms | Revocable and expiring; checked per request. Reaches dashboard pages and the OAuth authorization/consent pages; OAuth token and revocation endpoints use OAuth artifacts, not the session. |
| Speaker | `speakers` row owned by an account (`owner_account_id`) | Not authenticated directly | A persona. It acts only through a bearer credential, an OAuth access token, or a session send as an account-owned speaker. Must be `status = 'active'` to act; the dashboard directory still lists inactive owned speakers, and inventory/revocation accepts them. |
| Bearer credential | `credentials` row with public prefix + keyed HMAC verifier, scope JSON, expiry/revocation | `Authorization: Bearer cb_...` | Created only through an issuance path; scopes are a ceiling, never a grant by themselves. |
| OAuth grant | Consent selection (account + owned speaker + one named project + `message.read`/`message.send`) that issues an authorization code, then an OAuth access credential | OAuth authorization code + PKCE, then the normal bearer header | The access credential is a bearer credential with an `oauth_token_clients` association and one explicit project grant. Only `message.read`/`message.send` can be delegated. |
| Project owner | The `projects.owner_account_id` account | Human session | An account property, not a role enum. It gates membership administration only; ordinary project operations still use the capability checks below. |
| Project member | Active `project_memberships` row `(project_id, speaker_id)` with a capability set | The member speaker's bearer credential or OAuth access token, or a session viewing as an owned speaker | Membership alone grants nothing: a bearer credential also needs an explicit `credential_project_grants` row. |
| Host operator | Person with the data directory, key material, and CLI | OS/secret access, not an application principal | Runs `init`, `bootstrap-owner`, `issue-key`, `grant-key-project`, `revoke-key`, `rotate-key`, `expire-bodies`, `prune`, `doctor`, `backup`, `verify`, and `restore`. Trusted with plaintext. The `GET /metrics` token is an operator-only shared secret, not an account role. |

## Roles that do not exist

Do not infer these from the TODO's actor list or from unused scope names:

- **No platform administrator or global superuser.** There is no admin account,
  admin flag, admin role, or admin HTTP/MCP endpoint. The host operator is outside
  the application authorization model. `docs/docker.md` states the same.
- **No project role enum.** "Owner" is account ownership; "member" is a membership
  row. Capabilities are the seven scope identifiers in `SCOPES`, not a role.
- **No per-message ACL, delegated subagent identity, or impersonation grant.**
  A credential acts only as its bound speaker.
- **`member.read` and `member.manage` are not enforced anywhere.** They are accepted
  in the scope list, can be stored in membership capabilities and credential scopes,
  and can be issued/reported, but no service path requires them. Membership read and
  administration use the project-owner account predicate instead. Treating them as
  effective permissions would be a documentation claim without code evidence.
- **No JWT/OIDC, client-credentials, implicit, or device flows.** OAuth is
  authorization-code + PKCE for public clients only.
- **No body/attachment sub-authorization.** A `message.read` caller reads the whole
  body metadata and ciphertext path for that project; there is no field-level ACL.

## Scope identifiers

`SCOPES` in `src/domain/authz.ts` is the complete set; unknown strings are dropped
from parsed capability/scope JSON, so they grant nothing:

| Scope | Used by |
| --- | --- |
| `project.read` | Project list/detail, `/me` project enumeration, stats |
| `message.read` | Message list, metadata, body fetch, read-receipt listing |
| `message.send` | Message send |
| `receipt.write` | Explicit `mark_read` (in addition to `message.read`) |
| `project.edit` | Project edit/update and explicit body expiry |
| `member.read` | Declared only; not enforced |
| `member.manage` | Declared only; not enforced |

## Exact predicates

### Bearer project authorization (`authorizeProject`)

For a requested `scope`, all of the following must hold:

1. The project row exists and `projects.status = 'active'`; otherwise `NOT_FOUND`.
2. A `project_memberships` row exists for `(project_id, principal.speakerId)` with
   `removed_at IS NULL`; otherwise `NOT_FOUND`. A removed membership is
   indistinguishable from no membership.
3. The speaker is `status = 'active'` and its owning account is
   `status = 'active'`; otherwise `NOT_FOUND`.
4. The credential row identified by `principal.credentialId` still exists for the
   same `speaker_id`, is not revoked, and is not expired. A vanished row is treated
   as revoked.
5. An explicit `credential_project_grants` row exists for
   `(credential_id, project_id)`; otherwise `FORBIDDEN`. A membership never implies
   a grant, and a grant never adds rights.
6. `rights = membership capabilities ∩ credential scopes` (known identifiers only),
   and `rights` contains the requested scope; otherwise `FORBIDDEN`.

The effective predicate is therefore:

```text
project.active
AND membership(project, speaker).removed_at IS NULL
AND speaker.active AND owner_account.active
AND credential.active AND credential.speaker_id = speaker
AND grant(credential, project)
AND scope ∈ membership.capabilities ∩ credential.scopes
```

Decision order is significant: unauthenticated → `UNAUTHENTICATED` (including a
credential already revoked, or a speaker/account already inactive, before
authentication); unknown or inactive project,
non-member, removed membership, or an inactive speaker/owning account →
`NOT_FOUND`; an authenticated active member whose credential was revoked or expired
after authentication (a vanished row is treated as revoked), or whose credential
lacks the grant or the requested scope → `FORBIDDEN`. A denial never reveals whether
a forbidden object exists.

`listProjects` for a bearer principal does not call `authorizeProject`; it uses a
direct query with the same effective conditions: active project, non-removed
membership, `project.read` present in the membership capabilities, an explicit grant
for this credential, and `project.read` present in the principal's credential
scopes. Bearer authentication already checked the speaker and owning account are
active for this request.

### Session project authorization (`authorizeSessionProject`)

A session is resolved per project with exactly one authority. All of:

1. The requested scope is one of `project.read`, `message.read`, `project.edit`;
   otherwise `NOT_FOUND`. Sessions are never authorized for `message.send`,
   `receipt.write`, `member.read`, or `member.manage` through this branch.
2. The session principal carries exactly that requested scope.
3. `projects.status = 'active'`; otherwise `NOT_FOUND`.
4. An active membership exists for `(project_id, speaker_id)` where the speaker is
   `owner_account_id = session.accountId`, the speaker is active, the account is
   active, and `removed_at IS NULL`; otherwise `NOT_FOUND`.
5. The membership capability set contains the requested scope; otherwise
   `NOT_FOUND`.

No credential and no `credential_project_grants` row are involved. `rights` is
exactly `{requested scope}`, never the membership's other capabilities.

### Session send authority (`authorizeSessionSend`)

A session may send only as a speaker it owns. All of:

1. The principal is a session viewer resolved for `message.send`.
2. The speaker is owned by the session account and active; the account is active;
   the project is active; and a non-removed membership exists for
   `(project_id, speaker_id)` with `message.send`; otherwise the uniform
   `NOT_FOUND`.
3. The server-issued session row `principal.sessionId` is still active: not revoked,
   not past its absolute expiry, and inside the idle window, with an active account.
   This predicate is part of the same conditional publication `UPDATE` as the
   ownership and membership checks. Stored session timestamps are canonical
   `toISOString()` values written by the application, and no API accepts a
   client-supplied session timestamp. The predicate compares them with SQLite
   `julianday()`, so an unparseable stored value yields `NULL` and the comparison is
   not true, failing closed; SQLite may still parse other non-canonical forms.
   `src/service/sessions.ts` parses the same columns with `new Date(...).getTime()`
   and rejects non-finite results via `Number.isFinite` before comparing.

This is deliberately separate from `authorizeProject`'s read-only session branch.
The predicate is folded into the finalize `UPDATE` for a session send, so a logout or
session revocation that lands after request authentication but before publication
prevents the message atomically. `tests/security/adversarial-probes.test.ts` revokes
the session between the blob write and finalization and asserts no committed message.

### Project-owner administration

`authorizeProjectOwner` (dashboard membership editor, member list/add/remove, and the
read-only policy matrix) is session-only and requires:

```text
project.active
AND project.owner_account_id = session.accountId
AND owning account.active
```

Failure is the uniform `NOT_FOUND`. This is stricter than `project.edit`: a
non-owner member holding `project.edit` cannot administer members, because that
would let it add a speaker with `message.send` and mint a credential. It also cannot
read the policy matrix. Membership mutation re-reads this predicate inside its
transaction and deletes the speaker's project grants on removal. The policy matrix is
read-only: `listProjectMembers` re-reads the owner predicate, and credential rows are
read only through the account-owned speaker inventory, which repeats ownership and
the active-account check; no bearer principal can reach either surface.

### Human account, speaker, and credential administration

- Session-only (`requireSessionAccount`); a bearer principal is `FORBIDDEN`.
- The speaker directory lists every speaker owned by the session account, including
  inactive speakers (their status is shown), provided the owning account is active.
  It has no speaker-status filter.
- Credential inventory and soft revocation require the speaker's
  `owner_account_id` to equal the session account and the account to be active.
  They do **not** require the speaker to be active, so an owner can still inventory
  and revoke an inactive speaker's credentials. A foreign or unknown speaker is the
  uniform `NOT_FOUND`.
- Key issuance (`getOwnedSpeakerForKey`) and grant add/remove require the speaker's
  `owner_account_id` to equal the session account, the account to be active, **and**
  the speaker to be active. A foreign, unknown, **or inactive** speaker is the
  uniform `NOT_FOUND`. Both grant operations also require the credential to be
  active; grant removal does not require a current membership or account read.
- Project creation requires an active account with at least one active owned
  speaker; it creates the project plus an owner membership carrying all seven
  identifiers in one transaction. It creates no credential and no grant.
- Credential issuance requires selected projects to be active memberships of that
  owned active speaker and every selected scope to be in each membership's
  capabilities. It performs **no** account-readable-project check. The credential
  plus one grant per selected project are written in one transaction.
- Grant addition (`grantOwnedSpeakerCredentialProject`), unlike issuance, requires
  `accountCanReadProject`: at least one active speaker owned by the session account
  holds an active membership on the active project carrying `project.read`. The
  membership rule and this read check are re-read inside the write transaction.
- OAuth-issued credentials (`cb_oat_` token prefix or an `oauth_token_clients`
  association) are excluded from grant addition by every supported path: the CLI
  `grant-key-project`, the dashboard, and `grantOwnedSpeakerCredentialProject` all
  reject the write with the same predicate and message as `rotate-key`, and the
  dashboard hides the add-grant form. Only a fresh OAuth consent can widen such a
  token; grant removal and whole-credential revocation remain available.
- The CLI operator paths (`issue-key`, `grant-key-project`, `revoke-key`,
  `rotate-key`) act as the host operator, not as a bearer principal.

### OAuth delegation

- Authorization/consent selects exactly one owned speaker and exactly one named
  active project with an active membership containing every requested scope. It
  requires a human session, an active account, an active owned speaker, and scopes
  drawn only from `message.read` and `message.send`. Other scopes are
  `invalid_scope`.
- Token exchange re-checks the session, client, redirect URI, PKCE verifier, the
  resource when the request presents one (RFC 8707 makes it optional), speaker
  ownership, account/speaker/project status, membership, and capabilities. A code is single-use and short-lived.
- The issued access credential is a normal bearer credential plus one explicit
  project grant. It has no `project.read`, `receipt.write`, `project.edit`, or
  `member.*` scope, so it cannot read project metadata or administer the project.
- Refresh rotation preserves the consented scope set; reuse detection revokes the
  token family and the underlying credential.

## Resource/action matrix

"Bearer" means the bearer predicate above; "Session" means the session predicate;
"Owner" means the project-owner predicate. A dash means the actor cannot perform
the action. Auth is required for every row unless stated.

| Resource/action | Human session | Bearer credential / OAuth grant | Predicate |
| --- | --- | --- | --- |
| Sign in; read/sign out own session | Yes | — | Active account + password; session token verifier; CSRF on sign-out |
| Create project | Yes | — | Session account active and one active owned speaker; writes project + owner membership |
| List projects; read project metadata | Yes | Yes | Session `project.read`; bearer `project.read` |
| Edit project title/summary | Dashboard session | No HTTP route | `project.edit` through `authorizeProject` (the web route resolves a session viewer) |
| List messages; read message metadata | Yes | Yes | Session/bearer `message.read` |
| Fetch message body | Yes | Yes | `message.read`; message `ready`; ciphertext and plaintext digests verify; re-authorized before return |
| Send message | Yes, as an owned speaker | Yes | Session send authority or bearer `message.send`; mandatory `Idempotency-Key`; sender is server-derived |
| Mark message read (receipt) | — | Yes | `message.read` **and** `receipt.write`; body must verify; no receipt on pending/expired/corrupt/inaccessible |
| Explicitly expire a body | Dashboard has no UI | Yes | `project.edit`; `ready → expired` only |
| List project members | Yes | — | Owner |
| Read project policy matrix | Yes | — | Owner; read-only (active members and capabilities plus the session account's owned-speaker credential grants on the project) |
| Add/remove project member | Yes | — | Owner; `member.manage` is not consulted |
| List owned speakers | Yes | — | Active account; lists all owned speakers, including inactive |
| Issue credential; add/remove credential grant | Yes | — | Owned active speaker + active account; issuance/grant predicates above (add also needs account read) |
| List/revoke credentials | Yes | — | Owned speaker (any status) + active account; credential must belong to the path speaker |
| Rotate credential | — | — | Host operator CLI only; non-OAuth credentials only |
| OAuth register/authorize/consent/token | Yes, for authorize/consent | Token/revoke use OAuth artifacts | Public registration; session for consent; re-checked at exchange |
| REST/MCP message and project APIs | — | Yes | Bearer predicate; MCP exposes six tools over the same service |
| `/metrics` | — | — | Operator shared token `CORKBOARD_METRICS_TOKEN`; otherwise indistinguishable `404` |
| `/healthz` | Public | Public | No authentication; minimal body |
| `/readyz` | Public | Public | No authentication; probes SQLite and the configured blob store; minimal status body |

## Non-goals and limits

- Authorization is deny-by-default at the grant boundary: a new membership or
  project does not widen any existing credential.
- Bearer re-checks narrow but do not eliminate TOCTOU. A revocation committing
  after the final re-check and before the atomic SQL statement or plaintext write
  is not prevented. See `docs/architecture.md` and
  `docs/security-operations.md`. Session sends are stronger: the active session row
  is part of the same conditional `UPDATE` that publishes, so session revocation,
  idle/absolute expiry, membership removal, and a lost grant fail closed atomically.
  The session timestamps are canonical `toISOString()` values compared with
  `julianday()`; an unparseable stored value yields `NULL` and fails closed. D1 is
  SQLite-backed and `julianday()` is a core SQLite date function, so this is portable
  by the SQLite contract; D1 itself is not executed in this repository.
- An idempotency replay re-checks that the recorded message still belongs to the
  authenticated speaker. A row repointed out of band at another speaker's message is
  `NOT_FOUND`; that state requires database write access, not an API call.
- Metadata-only reads (`list`, `get`, `/me`, project enumeration) are authorized
  once at request start.
- There is no cross-project read, no cross-project message reference, and no
  project-independent object lookup: every message/body/receipt query filters on
  `project_id`, and object access alone is never sufficient.
