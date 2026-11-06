# Local Docker Compose installation

**Scope:** local Docker Compose installation of the shipped self-hosted Node.js 24 +
SQLite + local-blob service. This is the local half of `TODO.md` Phase 4 item 368.

> **Base image provenance.** The image is built from the official `node:24-bookworm-slim`
> image at digest
> `sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`
> (Node 24.22.2, npm 11.19.1, Debian bookworm). Both Dockerfile stages pin that
> digest for reproducibility. The recorded build and smoke output in
> `IMPLEMENTATION_STATE.md` was produced on this real base. Registry access was
> intermittent during the work, which led to an earlier, incorrect stand-in
> attribution; the provenance was re-checked against the local image and digest.

This document does **not** provide or claim a Cloudflare Workers/D1/R2 deployment.
There is no D1/R2 adapter and no Cloudflare access or test has been performed. That
half of item 368 remains external and unimplemented; the TODO item stays unchecked.

The image is a single process. Rate limits, login limits, metrics, and MCP sessions are
process-local; SQLite serializes writers. Do not run multiple replicas against the same
SQLite/blob volume. TLS, per-IP limits, and volumetric abuse controls belong to a host
reverse proxy (see [`runbook.md`](./runbook.md#31-reverse-proxy-tls-termination)).

## 1. Prerequisites

- Docker Engine with Compose v2 (`docker compose`).
- An absolute host directory for the secrets file, outside this repository.
- Port `8787` free on host loopback, or edit the published port in `compose.yaml`.

No host Node.js or npm is required. The image builds the application and installs only
production dependencies at runtime.

The Dockerfile pins both stages to the official `node:24-bookworm-slim` image by tag and
digest (`sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`).
The digest was resolved and verified locally (Node 24.22.2, npm 11.19.1), so
rebuilds stay on the same base even if the tag moves. Docker checks are documented
commands, not CI steps.

## 2. Quick start

From the repository root:

```sh
# CORKBOARD_SECRETS_DIR must be an absolute host path outside this repository,
# with a 0600 corkboard.env readable by container UID/GID 1000 (the fixed
# non-root identity). Compose cannot enforce that the path is absolute or
# outside the repository; treat both as operator discipline.
#
# Create the directory as the container identity. If this account is not UID
# 1000, the leaf must be owned by 1000:1000 and every ancestor must be
# traversable (x) by UID 1000. The /srv path keeps the non-UID-1000 case out of
# a private home directory, where a 0700 ancestor would still block UID 1000.
if [ "$(id -u)" -eq 1000 ]; then
  export CORKBOARD_SECRETS_DIR="$HOME/.config/corkboard"
  install -d -m 0700 "$CORKBOARD_SECRETS_DIR"
else
  SECRETS_DIR=/srv/corkboard/secrets
  export CORKBOARD_SECRETS_DIR="$SECRETS_DIR"
  sudo install -d -m 0755 -o root -g root /srv/corkboard
  sudo install -d -m 0700 -o 1000 -g 1000 "$CORKBOARD_SECRETS_DIR"
fi

docker compose build
```

The one-shot `init` below runs as UID 1000, so the directory it creates the
secrets file in must be writable by that identity. Choosing a path under a
non-UID-1000 account's 0700 home and chowning only the leaf still leaves the
ancestors untraversable; use the `/srv` branch above or grant `x` on every
ancestor.

### 2.1 Initialize the data directory and secrets file

`init` is bootstrap-only: it refuses, writing nothing, when `corkboard.sqlite` or the
secrets file already exists. There is no `--force`. It creates the secrets file `0600`
with random `CORKBOARD_ROOT_KEY` and `CORKBOARD_CREDENTIAL_PEPPER` plus
`CORKBOARD_DATA_DIR=/data`.

The service mounts `$CORKBOARD_SECRETS_DIR` read-only at `/run/secrets`. Because `init`
has to create the file, the one-shot command also mounts the same host directory
read-write at `/run/secrets-rw`:

```sh
docker compose run --rm \
  -v "$CORKBOARD_SECRETS_DIR:/run/secrets-rw" \
  corkboard node dist/scripts/corkboard.js init \
    --data-dir /data \
    --secrets-file /run/secrets-rw/corkboard.env
# prints only: /run/secrets-rw/corkboard.env
```

The named volume `corkboard-data` is created on first use and mounted at `/data`. The
image creates `/data` as `1000:1000` mode `0700`, and Docker initializes the empty named
volume with that ownership, so the non-root process can write it without a host
`chown`. Keep the `0600` secrets file out of the data directory; `init` enforces this.

Re-running the `init` command is expected to fail with the existing-secrets error and
must not modify the installation. The running service is started separately:

```sh
docker compose up -d
docker compose ps                      # corkboard ... (healthy)
curl -fsS http://127.0.0.1:8787/healthz
# {"status":"ok"}
```

The entrypoint tolerates an absent `/run/secrets/corkboard.env` so `init` can
create it. When present, it must be a readable regular file, not a symlink
(including a broken symlink), with mode exactly `0600`; any other mode (for
example `0644`) fails closed. The mode error names
the file and its on-disk mode, never its contents. `serve` separately fails
closed when required keys are missing. Keep the mount source an absolute path
outside the repository, owned by the operator; Compose cannot enforce either
property, so it is operator discipline.

The entrypoint sources `/run/secrets/corkboard.env` in the server process at startup.
It is not baked into the image, is not present in `compose.yaml` (`environment` /
`env_file`), and does not appear in `docker inspect` `Config.Env`. Never paste its
contents into a command line, issue, chat, or log.

### 2.2 Bootstrap the first account

There is no separate admin-user command and no admin role. The first human account is
created by `bootstrap-owner`; project authority comes from account ownership, and
`add-member --owner` gives a speaker the owner capability set. The dashboard signs in
with that account's email and password.

Set the owner password in the **environment**, never in argv. This block uses
bash for the silent `read -rsp` prompt:

```bash
read -rsp 'Owner password: ' CORKBOARD_BOOTSTRAP_PASSWORD; echo
export CORKBOARD_BOOTSTRAP_PASSWORD

ACCOUNT=$(docker compose run --rm -T \
  -e CORKBOARD_BOOTSTRAP_PASSWORD \
  corkboard node dist/scripts/corkboard.js bootstrap-owner \
    --email owner@example.com)
echo "$ACCOUNT"                         # acct_...
```

If you omit `CORKBOARD_BOOTSTRAP_PASSWORD`, `bootstrap-owner` still creates the
owner but without a password hash. That account cannot sign in (login fails
closed), and there is no password reset, so set it on a fresh installation.

Then provision a project, speaker, and credential. The entrypoint already sourced
`CORKBOARD_DATA_DIR=/data`, so the in-database provisioning commands do not need
`--data-dir`:

```sh
PROJECT=$(docker compose run --rm -T corkboard \
  node dist/scripts/corkboard.js create-project \
    --account "$ACCOUNT" --title "Ops" --summary "Operations board")

SPEAKER=$(docker compose run --rm -T corkboard \
  node dist/scripts/corkboard.js create-speaker \
    --account "$ACCOUNT" --name "Codex" --description "Agent speaker")

# Owner membership (all seven capabilities) or the default four capabilities.
docker compose run --rm -T corkboard \
  node dist/scripts/corkboard.js add-member \
    --project "$PROJECT" --speaker "$SPEAKER" --owner

# Prints the raw token exactly once. Store it in that agent's own environment.
CORKBOARD_APIKEY=$(docker compose run --rm -T corkboard \
  node dist/scripts/corkboard.js issue-key \
    --speaker "$SPEAKER" --project "$PROJECT")
```

Membership alone grants no credential access: `issue-key` writes one explicit
`credential_project_grants` row per `--project`. See
[`runbook.md`](./runbook.md#23-provision-the-first-owner-project-speaker-and-credential)
for capability, revocation, and issuance rules. The dashboard is at
`https://<host>/login` through the TLS proxy; plain HTTP on loopback is development
only, because session and CSRF cookies are `Secure`.

## 3. Data, ownership, and persistence

- Database and blobs are one recovery unit under the Compose volume key
  `corkboard-data`; Docker prefixes the actual volume with the Compose project name
  (normally `corkboard_corkboard-data`). The container paths are
  `/data/corkboard.sqlite`, `/data/corkboard.sqlite-wal`, `/data/corkboard.sqlite-shm`,
  and `/data/blobs/`.
- The container runs as fixed non-root UID/GID `1000:1000`. Directories are `0700`,
  database/sidecar/blob files `0600`. `NODE_ENV=production` makes startup verify these
  modes and reject symlinked paths before listening. Compose also runs the container
  with a read-only root filesystem, `cap_drop: ALL`, `no-new-privileges`, and a
  bounded `/tmp` tmpfs; only `/data` and `/tmp` are writable.
- The secrets file must be readable by UID 1000, be a regular file rather than a
  symlink, and must be `0600`; the entrypoint refuses any other mode or a symlink
  when the path exists. Absence is allowed so `init` can create it, and `serve`
  then fails closed on missing keys. It is not part of
  the data volume and must be backed up separately. **Key loss means ciphertext loss.**
  Key rotation is not implemented.

Inspect the runtime identity and modes:

```sh
docker compose exec -T corkboard id
# uid=1000(node) gid=1000(node) groups=1000(node)
docker compose exec -T corkboard stat -c '%a %u:%g %n' \
  /data /data/corkboard.sqlite /data/blobs
# 700 1000:1000 /data
# 600 1000:1000 /data/corkboard.sqlite
# 700 1000:1000 /data/blobs
```

Persistence and restart proof:

```sh
# Create a row through the real CLI, then restart and read it back.
PROJECT_ID=$(docker compose run --rm -T corkboard \
  node dist/scripts/corkboard.js create-project \
    --account "$ACCOUNT" --title "Persistence check")
docker compose restart corkboard
docker compose exec -T corkboard node --input-type=module -e \
  'import {DatabaseSync} from "node:sqlite";
   const db = new DatabaseSync("/data/corkboard.sqlite", {readOnly: true});
   console.log(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = ?").get(process.argv[1]));
   db.close();' "$PROJECT_ID"
# [Object: null prototype] { n: 1 } (the project survived the restart)
```

`docker compose down` stops the container but keeps the named volume and the secrets
directory. `docker compose down -v` **deletes the named volume and all data**; use it
only for a disposable installation.

### 3.1 Backup and restore

Backups contain ciphertext and metadata, not keys. Run the existing commands in a
one-shot container with a host directory mounted for the backup output:

```sh
# The one-shot container runs as UID/GID 1000, so the host output directory must be
# writable by that identity. Choose a private host location outside the repository:
sudo install -d -m 0700 -o 1000 -g 1000 /srv/backups
docker compose run --rm \
  -v /srv/backups:/backups \
  corkboard node dist/scripts/corkboard.js backup \
    --data-dir /data \
    --out "/backups/corkboard-$(date -u +%Y%m%dT%H%M%SZ)" --json
```

Run `verify` before every restore, and copy the `0600` secrets file to a separate
protected backup. Restore into a new/empty data directory with `restore`, then point
`CORKBOARD_DATA_DIR` at it. Exact semantics, exit codes, and the disaster-recovery
sequence are in [`runbook.md`](./runbook.md#6-backup-verify-and-restore). Restoring into
the running named volume is not an overwrite operation; use a new volume or a host bind
mount for the restored directory.

## 4. Ports and TLS

`compose.yaml` publishes `127.0.0.1:8787:8787` only. Inside the container the server
listens on `0.0.0.0:8787` so Docker's port forwarding can reach it; it is not reachable
beyond the host's loopback interface. To expose the service, place a TLS-terminating
reverse proxy on the host (Caddy, nginx, or the platform) and proxy to
`http://127.0.0.1:8787`, preserving `Authorization` and cookies. The application does
not terminate TLS and does not read forwarding headers. See
[`runbook.md`](./runbook.md#31-reverse-proxy-tls-termination).

If OAuth is needed, set a non-secret `CORKBOARD_PUBLIC_BASE_URL=https://<host>` (origin
only) and other optional settings. The secrets file is sourced by the entrypoint, so
append assignments there (`0600`), for example `CORKBOARD_PUBLIC_BASE_URL` or
`CORKBOARD_METRICS_TOKEN`, and restart. Do not put them in `compose.yaml`.

## 5. Scheduled maintenance

There is no in-process timer. Run `expire-bodies`, `prune`, `doctor`, `backup`, and
`verify` explicitly (host cron/systemd, or `docker compose run --rm ...`). Each command
opens the same data directory and is safe to run while the server is up for
`expire-bodies`/`prune`/`doctor` (SQLite serializes writers). Do not run two
backups/restores concurrently.

```sh
docker compose run --rm corkboard node dist/scripts/corkboard.js \
  expire-bodies --data-dir /data --limit 500
docker compose run --rm corkboard node dist/scripts/corkboard.js \
  prune --data-dir /data --json
docker compose run --rm corkboard node dist/scripts/corkboard.js \
  doctor --data-dir /data --json
```

## 6. Upgrade and rollback

The image tag used by Compose is local (`corkboard:local`); tag released builds by
commit if you keep several. To upgrade:

1. Back up and `verify` the data; record `doctor --json` and the current commit.
2. Stop the service (`docker compose stop corkboard`, which sends `SIGTERM`).
3. Update the source and `docker compose build`.
4. `docker compose up -d`; pending migrations apply on database open.
5. Run `doctor --data-dir /data` and confirm schema/integrity/blob counts.
6. Authenticate a known credential and fetch a known body.

There are no down migrations. An older image refuses a newer schema, so rollback means
restoring the pre-upgrade backup into a new data directory (or volume) with the same,
unchanged key set, then starting the older image. Everything written after the backup
is lost. The full procedure is in [`runbook.md`](./runbook.md#9-upgrade-and-rollback).

## 7. Secret handling summary

- Image: no keys, `.env`, data, or repository secrets are copied into either stage;
  `.dockerignore` excludes them.
- Compose: no secret values, no `env_file`, no `CORKBOARD_ROOT_KEY` /
  `CORKBOARD_CREDENTIAL_PEPPER` entries. `docker inspect` `Config.Env` therefore shows
  only the non-secret defaults.
- Runtime: `/run/secrets/corkboard.env` is bind-mounted **read-only** and, when
  present, sourced by the entrypoint into the server process environment. Absence is
  allowed for `init`; `serve` fails closed without the required keys. The server must
  hold the keys in memory to decrypt; this is not end-to-end encryption.
- The `0600` file lives outside the repository and outside the data directory. Back it
  up separately; never commit, paste, or log it. `init` prints only its path.

## 8. Not provided

- **Cloudflare Workers/D1/R2:** no adapter, no deployment, no test. Not claimed.
- **ChatGPT Web installation/linking:** not implemented or verified.
- **TLS, per-IP rate limiting, and volumetric limits:** host reverse-proxy
  responsibility; the application only has process-local per-credential limits.
- **Credential rotation, grant editing, message-expiry management, registration,
  email verification, and password reset:** no UI. Grant editing and
  per-credential expiry selection are CLI-only; rotation, registration, email
  verification, and password reset are unimplemented. See
  [`runbook.md`](./runbook.md#8-known-limits).
