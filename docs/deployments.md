# Deployments

Status: Node.js self-hosted is the first target. **The server, bootstrap CLI, and
migrations do not exist yet.** The commands below are the planned interface and are not
runnable at the current tree. Cloudflare Workers is planned and not implemented or
tested.

## Self-hosted Node.js 24 LTS (planned)

Requirements: Node.js 24, a writable data directory, and HTTPS termination by a
reverse proxy (Caddy, nginx, or the hosting platform).

```sh
npm ci
npm run build
# planned paths; emitted as .js by tsc
node dist/scripts/corkboard.js init --data-dir /var/lib/corkboard
# creates /var/lib/corkboard and a 0600 secrets file; prints the path only
set -a; . /path/printed/by/init; set +a
node dist/src/platforms/node/main.js serve --data-dir /var/lib/corkboard
```

Environment:

| Variable | Required | Meaning |
| --- | --- | --- |
| `CORKBOARD_ROOT_KEY` | yes | base64 32-byte AES root key, version `v1` |
| `CORKBOARD_CREDENTIAL_PEPPER` | yes | base64 32-byte HMAC pepper |
| `CORKBOARD_DATA_DIR` | yes | database and blob directory |
| `PORT` | no | defaults to `8787` |
| `HTTPS_PROXY` / `HTTP_PROXY` | no | optional local egress proxy; never logged |

Bootstrap:

```sh
# planned commands; not implemented yet
node dist/scripts/corkboard.js bootstrap-owner --email owner@example.com
node dist/scripts/corkboard.js create-project --account <account_id> --title "Ops"
node dist/scripts/corkboard.js create-speaker --account <account_id> --name "Codex"
node dist/scripts/corkboard.js issue-key --speaker <speaker_id> --project <project_id>
# prints the token once; store it in the agent's own environment
```

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

Never commit `ORIGINAL_DESIGN.md` (it contains a credential-bearing proxy URL) or
`secrets.env`. CI runs a secret scan over staged files and full history. The public
archive copy under `docs/` is labeled and has the credential userinfo removed.
