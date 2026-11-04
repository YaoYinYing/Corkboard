# Deployments

Status: Node.js 24 + SQLite + local private blobs is **implemented** (vertical slices
A–E, including the bearer-authenticated MCP slice, read-only `doctor` diagnostics, and
human account sessions), and the commands below are runnable after `npm run build`.
Cloudflare Workers/D1/R2, OAuth 2.1/PKCE, and ChatGPT Web integration
are planned and are not implemented or tested.

## Self-hosted Node.js 24 LTS

Requirements: Node.js 24, a writable data directory, and HTTPS termination by a
reverse proxy (Caddy, nginx, or the hosting platform).

```sh
npm ci
npm run build
node dist/scripts/corkboard.js init --data-dir /var/lib/corkboard
# writes secrets outside the data directory:
#   $XDG_CONFIG_HOME/corkboard/secrets.env, else ~/.config/corkboard/secrets.env
# dir 0700, file 0600; prints only the secrets-file path.
# Override with: init --data-dir ... --secrets-file /etc/corkboard/secrets.env
SECRETS="${XDG_CONFIG_HOME:-$HOME/.config}/corkboard/secrets.env"
# or the exact path printed by init / passed to --secrets-file
set -a; . "$SECRETS"; set +a
NODE_ENV=production node dist/scripts/corkboard.js serve
```

In production the server verifies filesystem confidentiality before listening: the
data and blob directories must be `0700`; the database, its `-wal`/`-shm` sidecars, and
blob files must be `0600`; and a symlinked data directory, blob directory, database, or
sidecar is rejected. A mismatch throws and the server does not start. Set
`NODE_ENV=production` or `CORKBOARD_REQUIRE_PRIVATE_FS=1` to enable this; local
development keeps the previous best-effort behavior.

`init` is non-destructive. It refuses, writing nothing, when `corkboard.sqlite` exists
in the data directory or the secrets file already exists. There is no `--force` mode.
A `--secrets-file` that resolves inside the data directory is rejected. Keep the
secrets file outside the database/blob directory and back it up separately.

The server binds `127.0.0.1` by default. Set `HOST=0.0.0.0` only behind a trusted
reverse proxy.

**HTTPS is required for human sessions.** Session and CSRF cookies are `Secure` and the
session cookie uses the `__Host-` prefix, so a conforming browser will not send them
over plaintext HTTP. Terminate TLS at the reverse proxy (Caddy, nginx, or the platform)
and do not expose the application directly beyond localhost.

Human sign-in is `POST /api/v1/session` with `Content-Type: application/json` and
`{email,password}`; other media types are rejected. The owner password set
through `CORKBOARD_BOOTSTRAP_PASSWORD` is stored as PBKDF2-HMAC-SHA-256
(600,000 iterations, random 16-byte salt) and is capped at 1024 UTF-8 bytes, matching
the login limit. The Node server also accepts legacy
`scrypt$` hashes from earlier bootstrap builds; new hashes are never scrypt. Sessions
expire after 30 idle minutes and 12 hours absolute, and sign-out revokes only the
presented session. There is no session-cleanup command: expired/revoked rows are inert
and may be deleted manually during maintenance. Login attempts are limited per hashed
email (10/minute, burst 5, process-local); per-IP limits remain the reverse proxy's job.

Environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `CORKBOARD_ROOT_KEY` | yes | base64 32-byte AES root key, version `v1` |
| `CORKBOARD_CREDENTIAL_PEPPER` | yes | base64 32-byte HMAC pepper |
| `CORKBOARD_DATA_DIR` | yes | database and blob directory |
| `NODE_ENV` | no | `production` enables fail-closed filesystem mode verification |
| `CORKBOARD_REQUIRE_PRIVATE_FS` | no | `1` enables the same verification without `NODE_ENV` |
| `PORT` | no | defaults to `8787` |
| `HOST` | no | listen host; default `127.0.0.1` |
| `CORKBOARD_RATE_LIMIT_PER_MINUTE` | no | authenticated requests/minute per credential; default `120`, `0` disables |
| `CORKBOARD_RATE_LIMIT_BURST` | no | token-bucket burst size 1–1000; default `30` |
| `CORKBOARD_METRICS_TOKEN` | no | enables operator-only `GET /metrics`; at least 32 characters, unset/empty disables |
| `CORKBOARD_BOOTSTRAP_PASSWORD` | no | owner bootstrap password, environment only |

Rate limiting is per credential and **process-local**. Invalid limiter values stop
startup. Because unauthenticated requests are not keyed, set per-IP request/connection
limits, body-size limits, and volumetric abuse controls at the reverse proxy; the
application does not read forwarding headers.

```sh
CORKBOARD_RATE_LIMIT_PER_MINUTE=120 CORKBOARD_RATE_LIMIT_BURST=30 \
  NODE_ENV=production node dist/scripts/corkboard.js serve
```

Metrics are optional and operator-only. Set `CORKBOARD_METRICS_TOKEN` to a random value
of **at least 32 characters** to enable `GET /metrics`. Unset, empty, and
whitespace-only values disable the route with `404`. Any non-empty token shorter than 32
characters stops startup before the data directory is created; the error never includes
the value. Requests must send `Authorization: Bearer <token>`; missing, wrong, and
non-operator speaker tokens also receive `404`, so the endpoint is not discoverable
without the token. Token comparison uses SHA-256 digests at fixed length, so equality
and token length are not inferable from the comparison. One timing caveat remains:
disabled requests return without hashing while enabled requests with a `Bearer` header
perform hashing, so timing may reveal whether the endpoint is enabled even though the
status and body are identical.

The snapshot is process-local, resets on restart, and is not aggregated across processes
or Workers; scrape it per process. The endpoint is not keyed by the per-credential rate
limiter. Treat the token as a secret and rotate it by restarting with a new value.

The token must be exported into the environment of **both** the server and the scraper.
Put it in the same `0600` secrets file used for the other secrets (the `set -a` source
below exports every assignment), or export it once in the shell before starting the
service:

```sh
# after sourcing the secrets file:
export CORKBOARD_METRICS_TOKEN="<at-least-32-character-random-token>"
NODE_ENV=production node dist/scripts/corkboard.js serve
curl -sS -H "Authorization: Bearer $CORKBOARD_METRICS_TOKEN" http://127.0.0.1:8787/metrics
```

Do not paste a real token into shell history or documentation. The placeholder above is
not a value to use. See [`api.md`](./api.md#get-metrics-operator-only) for the exact JSON
shape and limitations.

The slice-A server makes no outbound requests, so `HTTP_PROXY`/`HTTPS_PROXY` are not
read. If a proxy is configured in the developer environment, never log its value.

Bootstrap:

```sh
node dist/scripts/corkboard.js bootstrap-owner --email owner@example.com
node dist/scripts/corkboard.js create-project --account <account_id> --title "Ops"
node dist/scripts/corkboard.js create-speaker --account <account_id> --name "Codex"
node dist/scripts/corkboard.js add-member --project <project_id> --speaker <speaker_id>
# issue a key for one project (repeat --project to grant several at once):
node dist/scripts/corkboard.js issue-key --speaker <speaker_id> --project <project_id>
node dist/scripts/corkboard.js issue-key --speaker <speaker_id> \
  --project <project_a> --project <project_b>
# optional: issue a narrower key. `project.edit` is an owner-membership capability,
# so grant an owner membership first (`add-member --owner`), then:
node dist/scripts/corkboard.js issue-key --speaker <speaker_id> --project <project_id> \
  --scopes project.edit
# prints the token once; store it in the agent's own environment
# manage grants after issuance (an active membership is required to grant):
node dist/scripts/corkboard.js grant-key-project --credential <credential_id> --project <project_id>
node dist/scripts/corkboard.js revoke-key-project --credential <credential_id> --project <project_id>
node dist/scripts/corkboard.js revoke-key --credential <credential_id>
node dist/scripts/corkboard.js remove-member --project <project_id> --speaker <speaker_id>
```

`issue-key` requires at least one `--project`; the credential receives one grant per
project. `add-member` grants credentials nothing: a key is usable only in projects it
was explicitly granted, even when the speaker is a member of other projects.
`remove-member` deletes that speaker's grants for the project, so re-adding the
membership does not revive an old credential; `add-member` reactivates a removed
membership but never restores grants, so grant it again explicitly. If granting a
key fails mid-issuance, the new credential and its grants are removed rather than left
partially provisioned. Existing pre-release credentials have no grants and lose access
until granted explicitly.

**Key rotation is not implemented.** Bootstrap (`init`) and rotation are separate:
`init` refuses to touch an existing installation and no command rotates keys. To move
an existing secrets file, stop the service, move the unchanged `0600` file, point the
service manager at it, then start and verify token authentication plus body decryption.
See `security-operations.md`.

Body expiry cleanup:

```sh
node dist/scripts/corkboard.js expire-bodies --data-dir /var/lib/corkboard [--limit 500]
```

`--limit` defaults to 500 and must be 1–5000. The command accepts `--data-dir` or
`CORKBOARD_DATA_DIR`, marks due (`body_expires_at <= now`) messages expired, then
deletes their ciphertext; a missing blob counts as success. It also reconciles expired
messages whose deterministic audit row is missing, recording those with a system actor
(null account/speaker). It prints one JSON summary line (`examined`, `expired`,
`blobsDeleted`, `failures`); `examined` is the number of **distinct** messages examined
in that run, so a message that is both newly expired and an orphan is counted once. It
exits non-zero when `failures > 0`, so it is safe to retry. **There is no timer in the server process**:
schedule this command externally (cron, systemd timer, or the platform scheduler), for
example every 15 minutes. Running it concurrently is safe; transitions are conditional
and repeated work is idempotent.

Read-only diagnostics:

```sh
node dist/scripts/corkboard.js doctor --data-dir /var/lib/corkboard [--stuck-minutes 60] [--json]
```

`doctor` accepts `--data-dir` or `CORKBOARD_DATA_DIR`. It never creates the data
directory, applies migrations, or writes database/blob content. Opening an absent
database reports `database: null` and `SCHEMA_INCOMPLETE`; it does not initialize an
installation. A clean database with no WAL sidecars is read `immutable` so no files are
created; while the service is running, the existing WAL sidecars are used for a live
read. SQLite may rewrite the existing `-shm` coordination file; database and blob content
are not modified, and authoritative orphan/missing reconciliation should be run against a
quiesced instance or retried. Sidecar detection is not a lock: a concurrent checkpoint can
recreate `-wal`/`-shm` between the consistency check and the open, so the first read may
need a retry. `--json` prints exactly one object; without it the same fields are printed
as short lines.

`doctor` reads `CORKBOARD_ROOT_KEY` and `CORKBOARD_CREDENTIAL_PEPPER` from the process
environment only (it does not read `secrets.env`). Source the same secrets file used for
`serve` so key-presence diagnostics reflect the service configuration.

It reports applied, expected, missing, and unexpected migration versions, whether
`CORKBOARD_ROOT_KEY` and `CORKBOARD_CREDENTIAL_PEPPER` are present and 32-byte base64
(booleans only, never the values) with key version `v1`, `PRAGMA integrity_check`,
message/receipt/credential/grant counts, blob reconciliation, and pending rows older than
`--stuck-minutes` (default 60, with at most ten sample IDs and ages). Output is bounded;
blob reconciliation reads all referenced storage keys internally and `integrity_check`
scans the database. Values that cannot be measured (for example when the schema is
incomplete) are `null`, not zero. The applied/unexpected version lists are proportional
to `schema_migrations` rows, so a tampered database with a very large migration table can
enlarge the report; normal installations have one row per shipped migration.

A version in `schema_migrations` that is newer than the highest bundled migration is
reported as `SCHEMA_AHEAD` (and `complete: false`, exit `1`). Opening the database through
the server or another CLI command refuses such an installation with a clear error before
applying any migration (normal startup may switch journal mode and tighten permissions
first); an older binary must not write against a newer schema.

Blob meanings: `orphaned` is a file in `<data-dir>/blobs` whose valid opaque name is not
referenced by any non-null `body_objects.storage_key`; `missing` is a referenced key with
no regular file on disk; `expired_pending_deletion` is an expired message whose body
object is not yet `state = 'deleted'` (including `NULL`). Non-file and symlink entries are
counted as `blob_dir_non_files` and never followed; regular files with invalid names are
ignored.

Exit codes: `0` clean, `1` at least one issue was reported (`SCHEMA_INCOMPLETE`,
`SCHEMA_AHEAD`, `DATABASE_INTEGRITY_FAILED`, `BLOB_MISSING`, `BLOB_ORPHANED`,
`EXPIRED_BLOB_PENDING`, `STUCK_PENDING`, `KEY_MISSING`), `2` the inspection could not
run. Exit 2 covers invalid arguments, a data directory that is a symbolic link or exists
but is not a readable directory, a database path that is not a regular file (including a
symlink), a busy/locked database, inconsistent WAL sidecars, and a sidecar that is not a
regular file. A **missing** data directory or database is not an error: it reports
`database: null` and `SCHEMA_INCOMPLETE` and exits `1`. A report is never mixed with an
exit-2 error. Run it on a schedule (for example hourly or daily) and alert on non-zero;
`doctor` is read-only, so concurrent runs and runs against a live service are safe. There
is **no repair/fix mode**: resolve
`BLOB_ORPHANED`/`BLOB_MISSING`, `SCHEMA_INCOMPLETE`, or stuck rows through the documented
backup/expiry/provisioning procedures, not by deleting files in place. Backup-integrity
verification is not part of this command yet.

Reverse proxy must preserve the `Authorization` header, strip untrusted forwarding
headers, set body-size limits, and provide TLS. The application must not be exposed
directly over plain HTTP beyond localhost.

Health: `GET /healthz`. Backups: see `security-operations.md`.

### MCP endpoint

`POST /mcp` exposes the six bearer-authenticated MCP tools over Streamable HTTP;
`DELETE /mcp` terminates a session and `GET /mcp` returns `405` (no server-initiated
SSE). It requires the same scoped speaker token as REST. Configure each local MCP
client with its own credential in the client's environment or MCP configuration, never
in a prompt or chat message. `POST /mcp` shares the 64 KiB request cap; a reverse proxy
body limit is still recommended.

OAuth 2.1/PKCE, ChatGPT Web plugin installation/linking, and conversation-level ChatGPT
tool invocation are **not implemented or verified** in this slice. Do not document or
claim them. See [`mcp.md`](./mcp.md).

Sessions are in-memory, capped at **1024 concurrent sessions** (least-recently-used is
evicted first), and a session idle for **30 minutes** is evicted on the next
authenticated `/mcp` request (lazy sweep, no timer). Eviction closes the transport/server.
Sessions are lost on restart and are not shared across processes; clients must
initialize again. There is no cross-process session persistence.

`/mcp` shares the per-credential rate-limit bucket with REST. An over-limit request
returns HTTP `429 RATE_LIMITED` with `Retry-After` before any MCP session is created.

## Cloudflare Workers (planned)

Target: Worker + D1 + private R2. Requires D1-compatible SQL, R2 bindings, Worker
secrets for the root key and pepper, and a real staging test. Local mocks are not
evidence. Do not describe Workers support as complete until a live staging deployment
passes the same contract tests and a live two-client exchange.

## Repository safety

Never commit `ORIGINAL_DESIGN.md` (it contains a credential-bearing proxy URL) or a
secrets file. Secrets default outside the data directory; if you override the location,
keep it out of the repository. CI runs a secret scan over staged files and full history.
The public archive copy under `docs/` is labeled and has the credential userinfo
removed.
