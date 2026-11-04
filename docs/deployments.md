# Deployments

Status: Node.js 24 + SQLite + local private blobs is **implemented** (vertical slices
A and B), and the commands below are runnable after `npm run build`. Cloudflare Workers/D1/R2 is
planned and is not implemented or tested.

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
| `CORKBOARD_BOOTSTRAP_PASSWORD` | no | owner bootstrap password, environment only |

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

Reverse proxy must preserve the `Authorization` header, strip untrusted forwarding
headers, set body-size limits, and provide TLS. The application must not be exposed
directly over plain HTTP beyond localhost.

Health: `GET /healthz`. Backups: see `security-operations.md`.

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
