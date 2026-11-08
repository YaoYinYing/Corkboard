# Private preview deployment package

**Status:** package only. **Nothing in this document was deployed.** No public
infrastructure, DNS record, certificate, or real credential was created. The package
is ready for a maintainer-supplied host and must not be described as a deployment,
a browser verification, or a ChatGPT interoperability result.

**Baseline:** the package commit is based on `0cd5ffc` (tree `bb8270e`), the
docs/state tail that records the TODO 409 review-remediation checkpoint `5a310d1`
(tree `d8b1bb3`) as independently audited and pushed. `da6eba9` remains the latest
audited CI-passing code checkpoint before the remediation. The preview package is
committed on its own branch, not on `main`.

**Tracking:** results, review findings, and maintainer blockers are recorded in
Issue #11, `[Preview] Restricted private-preview deployment — status and blockers`.
This document does not duplicate that Issue's content.

**Blocker:** a host, a domain with DNS, a TLS certificate, and synthetic preview
credentials do not exist yet. Those are maintainer-supplied. Until they are supplied,
only the offline checks in §2 and the merged-compose validation can run.

This package reuses the shipped Node.js 24 + SQLite + Docker Compose stack. It does
not add an adapter, a dependency, an authorization path, or a crypto change.

## 0. Scope and non-goals

In scope: one host, one container, one preview-only data volume, one preview-only
secrets file, loopback publishing, a TLS reverse proxy, a small authorized tester
list, synthetic accounts, and an automated HTTP preflight.

Out of scope and not claimed:

- account self-registration (the application has no registration endpoint);
- Cloudflare Workers and live D1/R2 (D1 and R2 adapters are contract-tested only
  against structural doubles; the Worker entrypoint is exercised against those doubles
  with standard `Request`/`Response`, but there is no live Workers/workerd run, no
  Cloudflare binding, no wrangler configuration or migration application, no deployment,
  and `/readyz` probes D1 and R2, with R2 readiness a head of a reserved sentinel key
  (connectivity/permission only, no object creation));
- attachments (text bodies only, 64 KiB request cap);
- per-IP limits inside the application (the reverse proxy owns them);
- multi-process or multi-host operation (SQLite and all in-process state are
  single-process);
- ChatGPT Web installation/linking or conversation-level tool invocation;
- a real browser pass, a TLS pass, or a disaster rehearsal on the preview host.

## 1. Variables and isolation

Use the merged files for every command. The override replaces the base port and
volume lists with `!override`, so it needs Docker Compose v2.24 or newer.

```bash
export CORKBOARD_PREVIEW_PROJECT=corkboard-preview
export CORKBOARD_PREVIEW_PORT=18787
export CORKBOARD_PREVIEW_IMAGE=corkboard:preview
export CORKBOARD_PREVIEW_DATA_VOLUME=corkboard-preview-data
export PREVIEW_ROOT=/srv/corkboard-preview
export CORKBOARD_PREVIEW_SECRETS_DIR="$PREVIEW_ROOT/secrets"

# Compose interpolates the base file before applying !override. Point the base
# variable at the preview path so a production value is never interpolated; the
# override discards this mount.
export CORKBOARD_SECRETS_DIR="$CORKBOARD_PREVIEW_SECRETS_DIR"

COMPOSE=(docker compose -f compose.yaml -f compose.preview.yaml \
  --project-name "$CORKBOARD_PREVIEW_PROJECT")
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `CORKBOARD_PREVIEW_PROJECT` | `corkboard-preview` | Compose project; scopes the network and names |
| `CORKBOARD_PREVIEW_PORT` | required (no default) | Host loopback port published as `127.0.0.1:<port>:8787` |
| `CORKBOARD_PREVIEW_IMAGE` | `corkboard:preview` | Image tag or digest reference to run |
| `CORKBOARD_PREVIEW_DATA_VOLUME` | `corkboard-preview-data` | Exact Docker volume name for preview data |
| `CORKBOARD_PREVIEW_SECRETS_DIR` | required (no default) | Host directory bind-mounted read-only at `/run/secrets` |
| `CORKBOARD_SECRETS_DIR` | same as preview | Base-file interpolation only; never used by the merged service |

The preview network is `${CORKBOARD_PREVIEW_PROJECT}_default`; the production
network and volume are different objects. The preview volume has an explicit name,
so it can be inspected and removed exactly.

`CORKBOARD_PREVIEW_DATA_VOLUME` and `CORKBOARD_PREVIEW_SECRETS_DIR` must never equal
a production volume name or secrets path. Compare them with the production Compose
project output before proceeding. The secrets directory must be an **absolute**
path: Compose resolves a relative bind source against the directory of the first
compose file, not the operator's current working directory, so a relative value
silently selects the wrong host path.

```bash
case "$CORKBOARD_PREVIEW_SECRETS_DIR" in
  /*) ;;
  *) echo "CORKBOARD_PREVIEW_SECRETS_DIR must be absolute" >&2; exit 1 ;;
esac
# Stop if either value matches a production object you know about.
docker compose ls
docker volume ls --format '{{.Name}}'
```

Validate the merge before doing anything else. The config command requires the
preview environment; without `CORKBOARD_PREVIEW_PORT`,
`CORKBOARD_PREVIEW_SECRETS_DIR`, and `CORKBOARD_SECRETS_DIR`, Compose exits `1`.

```bash
CORKBOARD_PREVIEW_PORT="$CORKBOARD_PREVIEW_PORT" \
CORKBOARD_PREVIEW_SECRETS_DIR="$CORKBOARD_PREVIEW_SECRETS_DIR" \
CORKBOARD_SECRETS_DIR="$CORKBOARD_SECRETS_DIR" \
docker compose -f compose.yaml -f compose.preview.yaml config >/dev/null \
  && echo "preview compose config: ok"

docker volume ls --format '{{.Name}}' | grep -x "$CORKBOARD_PREVIEW_DATA_VOLUME" || true
```

The second command must not show a production volume. The preview volume may not
exist yet.

## 2. Build and record the pinned image

Run the repository checks before building, and record the exact source revision and
image ID. The Dockerfile pins both stages to
`node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9`.

```bash
node -v                       # must be >= 24
npm ci --ignore-scripts
npm run check
npm run build
git rev-parse HEAD
git rev-parse 'HEAD^{tree}'

"${COMPOSE[@]}" build
docker image inspect --format '{{.Id}}' "$CORKBOARD_PREVIEW_IMAGE"
```

Record the commit, tree, image ID, and the pinned base digest in the preview
handover notes. Do not rebuild between acceptance and handover without repeating
the preflight. The local image ID (`sha256:...`) is the digest for a locally built
image; if the image is later published to a registry, pin the published
`repo@sha256:...` instead.

## 3. Fresh preview-only secrets

Never copy, move, or reuse a production secrets file, root key, or pepper. If any
preview value was ever used outside this preview, stop and regenerate the preview
installation.

Create a host directory outside the repository and outside the data volume. The
container runs as fixed UID/GID `1000:1000`, and the leaf must be owned by that
identity. If the operator account is not UID 1000, keep the path under `/srv` and
grant traversal on the ancestors.

```bash
sudo install -d -m 0755 -o root -g root /srv/corkboard-preview
sudo install -d -m 0700 -o 1000 -g 1000 "$CORKBOARD_PREVIEW_SECRETS_DIR"
sudo install -d -m 0700 -o 1000 -g 1000 /srv/corkboard-preview/credentials
```

The credentials directory is `0700` and owned by UID 1000. Choose one workable
model and use it for §4 and §7:

- **Recommended: run §4–§7 as UID 1000.** The writes below then create
  `1000:1000` files that both the host-run preflight and a UID-1000 one-shot
  container can read.
- **Consistent sudo:** if the login is not UID 1000, write through UID 1000, for
  example `printf '%s\n' "$TOKEN" | sudo -u '#1000' tee <file> >/dev/null`
  followed by `sudo chmod 0600 <file>`, and run the preflight as
  `sudo -u '#1000' node dist/scripts/preview-preflight.js ...`. The repository
  and `dist/` path must be readable by UID 1000.
- **Shared directory:** if multiple identities must create entries, use a
  group-writable directory owned `1000:<group>` with mode `2770` and add the
  operators to `<group>`. Setgid only makes new entries inherit the group; files
  must stay `0600` and are readable by their owner, so this does not make a
  `0600` file readable by the container. Run the preflight as the file owner or
  as UID 1000.

Do not loosen the `0600` file mode, and do not run the preflight against a file
owned by another identity without switching identity first.

Initialize a new installation. `init` is non-destructive and refuses an existing
database or secrets file; there is no `--force`. It creates the data directory
inside the preview volume and writes `CORKBOARD_ROOT_KEY`,
`CORKBOARD_CREDENTIAL_PEPPER`, and `CORKBOARD_DATA_DIR=/data` to the secrets file.

```bash
"${COMPOSE[@]}" run --rm -T \
  -v "$CORKBOARD_PREVIEW_SECRETS_DIR:/run/secrets-rw" \
  corkboard node dist/scripts/corkboard.js init \
    --data-dir /data \
    --secrets-file /run/secrets-rw/corkboard.env
# prints only the secrets-file path
```

Verify the resulting owner and modes:

```bash
stat -c '%a %u:%g %n' "$CORKBOARD_PREVIEW_SECRETS_DIR" \
  "$CORKBOARD_PREVIEW_SECRETS_DIR/corkboard.env"
test ! -L "$CORKBOARD_PREVIEW_SECRETS_DIR/corkboard.env" && echo "regular file: ok"
```

Expected: directory `700`, file `600`, both `1000:1000`. The entrypoint rejects a
symlink, a non-regular file, or any mode other than `600`.

Keep the secrets file out of the repository and out of every backup of the data
volume. Back it up separately: key loss means ciphertext loss. Root-key and pepper
rotation are not implemented.

## 4. Synthetic accounts, speakers, projects, and credentials

All accounts and messages are synthetic. Use the `owner@preview.invalid` domain so
it is obvious no mail can be delivered. The owner password is read from the
terminal, passed only in the environment, and stored in a private file for the
preflight login check.

```bash
read -rsp 'Preview owner password: ' CORKBOARD_BOOTSTRAP_PASSWORD; echo
umask 077
printf '%s\n' "$CORKBOARD_BOOTSTRAP_PASSWORD" \
  > /srv/corkboard-preview/credentials/owner.password
chmod 0600 /srv/corkboard-preview/credentials/owner.password
export CORKBOARD_BOOTSTRAP_PASSWORD

ACCOUNT=$("${COMPOSE[@]}" run --rm -T -e CORKBOARD_BOOTSTRAP_PASSWORD \
  corkboard node dist/scripts/corkboard.js bootstrap-owner \
    --email owner@preview.invalid)
unset CORKBOARD_BOOTSTRAP_PASSWORD
echo "$ACCOUNT"   # acct_...
```

Create the project and two speakers: one member and one outsider. The outsider is a
member of a second project only, so its credential is valid but not a member of the
preview project.

```bash
PROJECT=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js create-project \
    --account "$ACCOUNT" --title "Preview board" --summary "Synthetic preview data")

SPEAKER=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js create-speaker \
    --account "$ACCOUNT" --name "Preview Member" --description "Synthetic member")

OUTSIDER=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js create-speaker \
    --account "$ACCOUNT" --name "Preview Outsider" --description "Synthetic non-member")

"${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js add-member \
    --project "$PROJECT" --speaker "$SPEAKER"
```

Issue the member credential and write it to a `0600` file without echoing it. The
CLI prints the raw token exactly once; it is captured in a shell variable, written
to the private file, and then unset.

```bash
umask 077
TOKEN=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js issue-key \
    --speaker "$SPEAKER" --project "$PROJECT")
printf '%s\n' "$TOKEN" > /srv/corkboard-preview/credentials/member.cb
unset TOKEN
chmod 0600 /srv/corkboard-preview/credentials/member.cb
```

### 4.1 A credential that is issued and then revoked

Issue a second credential for the same member speaker, save it, and read the newest
active credential ID with a read-only query. Do **not** revoke it yet: §5.1 first
confirms on loopback that it is accepted, then revokes it. The saved token is then
rejected with `401`; pass it to the preflight as `--revoked-credential-file`.

```bash
umask 077
TOKEN=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js issue-key \
    --speaker "$SPEAKER" --project "$PROJECT")
printf '%s\n' "$TOKEN" > /srv/corkboard-preview/credentials/revoked.cb
unset TOKEN
chmod 0600 /srv/corkboard-preview/credentials/revoked.cb

CREDENTIAL_ID=$("${COMPOSE[@]}" run --rm -T corkboard \
  node --input-type=module -e \
  'import {DatabaseSync} from "node:sqlite";
   const db = new DatabaseSync("/data/corkboard.sqlite", {readOnly: true});
   const row = db.prepare("SELECT id FROM credentials WHERE speaker_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1").get(process.argv[1]);
   db.close();
   if (!row) process.exit(1);
   console.log(row.id);' "$SPEAKER")
```

The query reads only `credentials.id`; it does not print a token, prefix, or
verifier. Keep `CREDENTIAL_ID` for §5.1; the ID is not secret, but do not paste the
revoked token into a shell history, issue, or transcript.

### 4.2 A valid credential for a non-member

Create the second project, add the outsider there, and issue its credential. This
credential is valid; it is simply not a member of `$PROJECT`, so a project read
must return the uniform `404 NOT_FOUND`.

```bash
PROJECT_B=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js create-project \
    --account "$ACCOUNT" --title "Preview non-member probe" \
    --summary "Synthetic non-member data")

"${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js add-member \
    --project "$PROJECT_B" --speaker "$OUTSIDER"

umask 077
TOKEN=$("${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js issue-key \
    --speaker "$OUTSIDER" --project "$PROJECT_B")
printf '%s\n' "$TOKEN" > /srv/corkboard-preview/credentials/nonmember.cb
unset TOKEN
chmod 0600 /srv/corkboard-preview/credentials/nonmember.cb
```

### 4.3 Synthetic messages

The operator CLI has **no `send` command**. Messages are sent through the REST API.
The preflight sends one deterministic synthetic message (and exercises list, body
read, receipt, replay, and idempotency conflict). An explicit REST send through
loopback is optional and uses the member credential:

```bash
TEXT='Preview synthetic message'
DIGEST="sha256:$(printf %s "$TEXT" | sha256sum | cut -d' ' -f1)"
AUTH_HEADER=/srv/corkboard-preview/credentials/member.auth
{ printf 'Authorization: Bearer '; cat /srv/corkboard-preview/credentials/member.cb; } \
  > "$AUTH_HEADER"
chmod 0600 "$AUTH_HEADER"
curl -fsS -X POST \
  "http://127.0.0.1:$CORKBOARD_PREVIEW_PORT/api/v1/projects/$PROJECT/messages" \
  --header @"$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: preview-synthetic-1" \
  --data "$(printf '{"summary":"Preview synthetic message","type":"request","language":"en","text":"%s","body_digest":"%s"}' "$TEXT" "$DIGEST")"
rm -f "$AUTH_HEADER"
```

Do not put the token in `-H "Authorization: Bearer ..."` on the command line: it is
visible in process argv. `--header @file` (curl 7.55+) reads the header from the
private file; delete the file afterward. If your curl is older, use the preflight
instead of a manual send.

Bearer credentials are not cookies, so this loopback send works over plain HTTP.
The dashboard requires HTTPS because its session and CSRF cookies are `Secure`.

## 5. Start on loopback and verify isolation

```bash
"${COMPOSE[@]}" up -d --wait
"${COMPOSE[@]}" ps
curl -fsS "http://127.0.0.1:$CORKBOARD_PREVIEW_PORT/healthz"
curl -fsS "http://127.0.0.1:$CORKBOARD_PREVIEW_PORT/readyz"
```

Expected: `{"status":"ok"}` and `{"status":"ready"}`. `/readyz` is a real SQLite
`SELECT 1` plus a non-mutating blob-directory check; it does not verify schema,
keys, or blob contents.

Verify the published address and the hardening:

```bash
ss -ltnp | grep ":$CORKBOARD_PREVIEW_PORT"
# must show 127.0.0.1:<port>, never 0.0.0.0 or [::]

docker inspect "$("${COMPOSE[@]}" ps -q corkboard)" --format \
  'user={{.Config.User}} ro={{.HostConfig.ReadonlyRootfs}} cap={{.HostConfig.CapDrop}} sec={{.HostConfig.SecurityOpt}}'
# user=1000:1000 ro=true cap=[ALL] sec=[no-new-privileges:true]

docker inspect "$("${COMPOSE[@]}" ps -q corkboard)" --format \
  '{{range .Mounts}}{{.Source}} -> {{.Destination}} rw={{.RW}}{{println}}{{end}}'
# the secrets bind is rw=false; the data mount is the preview volume
```

The container listens on `0.0.0.0:8787` **inside** its network namespace; Docker
publishes only `127.0.0.1:<port>` on the host. Do not set `HOST=0.0.0.0` as a host
listener, do not add a second port mapping, and do not run the application
directly on a public interface.

Firewall expectation: allow `443/tcp` only from the authorized tester addresses
and leave `<port>` closed externally. Verify from a second host that
`https://preview.example` behaves as intended and that
`http://<host>:<port>` is unreachable. Docker publishes ports through its own
iptables rules; a loopback publish is not externally reachable, but verify rather
than assuming a host firewall blocks it.

### 5.1 Revoke the prepared credential and verify visibility

The service is up on loopback now, so this bearer probe does not depend on §6's
TLS terminator. The later preflight still receives `revoked.cb` as
`--revoked-credential-file`.

```bash
# Confirm the credential is accepted before revocation. A header file keeps the
# token out of process argv; curl 7.55+ supports -H @file.
AUTH_HEADER=/srv/corkboard-preview/credentials/revoked.auth
{ printf 'Authorization: Bearer '; cat /srv/corkboard-preview/credentials/revoked.cb; } \
  > "$AUTH_HEADER"
chmod 0600 "$AUTH_HEADER"
curl -fsS -o /dev/null -w '%{http_code}\n' -H @"$AUTH_HEADER" \
  "http://127.0.0.1:$CORKBOARD_PREVIEW_PORT/api/v1/me"
# expected 200 before revocation

"${COMPOSE[@]}" run --rm -T corkboard \
  node dist/scripts/corkboard.js revoke-key --credential "$CREDENTIAL_ID"

curl -sS -o /dev/null -w '%{http_code}\n' -H @"$AUTH_HEADER" \
  "http://127.0.0.1:$CORKBOARD_PREVIEW_PORT/api/v1/me"
# expected 401 after revocation
rm -f "$AUTH_HEADER"
```

The first probe must be `200` and the second `401`; `curl` without `-f` reports the
status instead of failing on the expected `401`. `revoke-key` writes to the same
SQLite database while the service is running; SQLite serializes the write.

## 6. HTTPS reverse proxy and tester allowlist

The application has no TLS listener, does not read forwarding headers, and stores
no client IP. Terminate TLS at nginx (or an equivalent) and keep the origin on
loopback. Cookies are `Secure`, and the session cookie is `__Host-` prefixed, so a
conforming browser will not send them over plaintext.

Two explicit options are below. They are alternatives, not layers to add blindly.

### Option A — nginx TLS plus a source-IP allowlist (recommended)

This does not interfere with machine clients: bearer REST and `/mcp` clients send
their own `Authorization` header and never see a proxy login. It requires the
testers to have stable egress addresses.

Save this as `/etc/nginx/snippets/corkboard-preview-proxy.conf`. Every location
includes it, including the optional Basic-auth locations below; nginx locations do
not inherit `proxy_set_header` from each other.

```nginx
proxy_pass http://127.0.0.1:18787;   # CORKBOARD_PREVIEW_PORT
proxy_http_version 1.1;
proxy_set_header Connection "";
# The app compares Host for same-origin checks; never forward a client-supplied
# value, and reject other names with server_name.
proxy_set_header Host preview.example;
proxy_set_header Authorization $http_authorization;
proxy_set_header X-Forwarded-Proto $scheme;
# The application ignores forwarding headers; drop client values.
proxy_set_header Forwarded "";
proxy_set_header X-Forwarded-For "";
proxy_set_header X-Real-IP "";
proxy_read_timeout 60s;
proxy_send_timeout 60s;
proxy_buffering off;                  # /mcp Streamable HTTP framing
```

```nginx
# Replace preview.example, the certificate paths, and the tester addresses.
# The two zone declarations belong in the http context. `http2 on;` requires
# nginx >= 1.25.1; use `listen 443 ssl http2;` on older versions.
limit_req_zone  $binary_remote_addr zone=corkboard_preview_ip:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=corkboard_preview_conn:10m;

# Unknown Host on :80: close instead of redirecting.
server {
    listen 80 default_server;
    server_name _;
    return 444;
}
server {
    listen 80;
    server_name preview.example;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 301 https://preview.example$request_uri; }
}

# Unknown SNI/Host on :443: close.
server {
    listen 443 ssl default_server;
    server_name _;
    ssl_certificate     /etc/letsencrypt/live/preview.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.example/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    return 444;
}

server {
    listen 443 ssl;
    http2 on;
    server_name preview.example;

    ssl_certificate     /etc/letsencrypt/live/preview.example/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/preview.example/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_prefer_server_ciphers off;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
    ssl_session_cache shared:corkboard_preview_tls:10m;
    ssl_session_timeout 1d;

    # Keep this short until the preview is over. No includeSubDomains and no
    # preload submission for a temporary hostname.
    add_header Strict-Transport-Security "max-age=86400" always;
    server_tokens off;

    client_max_body_size 1m;              # above the application's 64 KiB cap
    limit_req zone=corkboard_preview_ip burst=30 nodelay;
    limit_conn corkboard_preview_conn 20;

    # Authorized tester allowlist. Replace with real egress addresses.
    allow 203.0.113.10;
    allow 2001:db8::/32;
    deny all;

    location / {
        include /etc/nginx/snippets/corkboard-preview-proxy.conf;
    }
}
```

Trade-offs: stable tester IPs are required; roaming/mobile testers fail; there is
no per-person login or audit at the proxy. In exchange, every machine client works
unchanged and no bearer route is intercepted.

If an extra browser password is required, scope HTTP Basic auth to **browser paths
only** and leave `/api/v1/`, `/mcp`, `/oauth/`, and `/.well-known/` outside it:

```nginx
# Example only; keep every bearer/OAuth/discovery prefix OUT of these blocks.
# Each location includes the shared proxy snippet so Host/Authorization/framing
# stay identical to the main location.
location = / {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location ^~ /login {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location ^~ /projects {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location ^~ /speakers {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location ^~ /overview {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location ^~ /static {
    auth_basic "Corkboard preview";
    auth_basic_user_file /etc/nginx/preview.htpasswd;
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
location / {
    # Bearer REST, /mcp, /oauth/*, and /.well-known/* must stay outside Basic auth.
    include /etc/nginx/snippets/corkboard-preview-proxy.conf;
}
```

This split is easy to get wrong: `/projects/.../messages/new` also needs a bearer
session cookie, so it is inside `/projects`; `/api/v1/...` must never be inside a
Basic-auth block. If that maintenance risk is not acceptable, use Option A's IP
allowlist only.

Do not add permissive CORS, do not rewrite or strip `Set-Cookie`, and do not cache
authenticated responses.

**Behind Cloudflare**, `$binary_remote_addr` is a Cloudflare edge address, not the
tester's. Do not use the allowlist above as-is. Either configure nginx `real_ip`
with Cloudflare's published ranges and `real_ip_header CF-Connecting-IP` (trust
only those ranges) or use Option B with a correctly scoped Access policy.

### Option B — Cloudflare Access, scoped, never a blanket front

Cloudflare Access is a browser identity proxy. **It is not automatically compatible
with machine-to-machine OAuth/MCP.** Standard OAuth and MCP clients do not carry an
Access session; Access intercepts the request and returns a browser login or a
403, and it can break the authorization-code redirect and token exchange. Do not
put a blanket Access application in front of this service and do not claim that
Access protects machine clients.

If Access is used, scope it and bypass it explicitly:

- Protect browser paths only: `/`, `/login`, `/projects/*`, `/speakers/*`,
  `/overview`, and `/static/*`.
- Bypass Access for `/mcp`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`,
  `/.well-known/oauth-protected-resource`, and
  `/.well-known/oauth-authorization-server`.
- Bypass bearer REST `/api/v1/*`, or require an Access service token **only** for
  clients that can send `CF-Access-Client-Id` and `CF-Access-Client-Secret`.
  Standard OAuth/MCP clients cannot send those headers, so a service-token
  requirement is another form of incompatibility.
- Keep the origin on loopback and keep the host firewall closed. Access does not
  replace TLS termination at the origin tunnel/proxy.

Trade-offs: an identity-provider login and per-user access logs without stable
tester IPs; in exchange, a larger bypass surface, a Cloudflare dependency, and
careful path scoping. Enabling OAuth also exposes the application's public dynamic
client registration endpoint (`/oauth/register`, rate-limited); that is not
account registration, but it is a public surface. This package creates no DNS
record or Cloudflare configuration.

## 7. Automated HTTP preflight

`scripts/preview-preflight.ts` performs the checks that do not need a browser. It
uses the Node standard library plus the app's exported `SESSION_COOKIE_NAME` and
`CSRF_COOKIE_NAME` constants (no new dependency), follows no redirects, validates
TLS normally, and prints only check names, statuses, and pass/fail. It never prints
a token, a cookie, a response body, or a URL.

Run it after `npm run build`, either directly or through the npm script:

```bash
node dist/scripts/preview-preflight.js \
  --base-url https://preview.example \
  --credential-file /srv/corkboard-preview/credentials/member.cb \
  --project "$PROJECT" \
  --revoked-credential-file /srv/corkboard-preview/credentials/revoked.cb \
  --nonmember-credential-file /srv/corkboard-preview/credentials/nonmember.cb \
  --login owner@preview.invalid \
  --password-file /srv/corkboard-preview/credentials/owner.password

# equivalent, via npm (Node 24 type stripping):
npm run preview-preflight -- \
  --base-url https://preview.example \
  --credential-file /srv/corkboard-preview/credentials/member.cb \
  --project "$PROJECT"
```

`--base-url` must be `https`, or `http` only on `127.0.0.1`/`localhost`/`::1`; it
must be an origin with no userinfo, path, query, or fragment. Credential, revoked,
nonmember, and password files must be regular files (not symlinks) with mode
exactly `0600`. The credential file contains the raw token only. The password
reader ignores one trailing newline and preserves spaces; it rejects an empty value
or one over the server's 1024-byte limit. The script rejects an invalid base URL,
project ID, mode, or token before the first request.

The preflight uses Node's normal TLS verification and the system trust store. For a
private CA, set `NODE_EXTRA_CA_CERTS` to the CA file; do not disable certificate
verification. Every response is read with a 1 MiB cap: an oversized declared
`Content-Length` or streamed body fails the check, and no body content is printed.

`http://localhost` is accepted only as a loopback convenience. It is resolved by
name, so a hosts-file entry can point it at another address; use
`http://127.0.0.1:<port>` when the loopback target must be unambiguous. Plain HTTP
is never accepted for a non-loopback host.

Checks, in order:

1. `/healthz` is `200 {"status":"ok"}`.
2. `/readyz` is `200 {"status":"ready"}`.
3. An unauthenticated `/api/v1/me` is `401`.
4. `/me` binds the credential to a speaker and account, includes
   `message.read` and `message.send`, and lists `--project`.
5. The message list is `200` with a `messages` array.
6. A deterministic synthetic send returns `201` (or `200` on a rerun) with the
   expected project, digest, message ID, and sequence.
7. The body fetch returns the exact synthetic text and digest.
8. `mark_read` returns the same message and the authenticated speaker.
9. Replaying the same key and payload returns `200` with the same message ID and
   sequence.
10. The same key with a different payload returns `409 CONFLICT`.
11. Optional: the revoked credential returns `401` (not `200`).
12. Optional: the non-member credential gets `404 NOT_FOUND` for the project.
13. Optional: login returns `200` and the session cookie is the app's exact
    `SESSION_COOKIE_NAME` (`__Host-...`), `Secure`, `HttpOnly`, `SameSite=Strict`,
    `Path=/`, with no `Domain`; the CSRF cookie is `Secure`, `SameSite=Strict`,
    `Path=/`, and not `HttpOnly`. Any other `__Host-` cookie name fails the check.
14. Optional: `DELETE /api/v1/session` without `X-CSRF-Token` is `403`; with the
    matching token it is `204`.

Exit codes: `0` all checks pass, `1` at least one check failed, `2` usage or
private-file configuration error. A failed check stops the core chain (fail
closed). The fixed idempotency key creates at most one synthetic message per
credential/project; replay and conflict checks create none. Run the preflight
again after a restart: the replay should return `200` with the same message.

The preflight does not check TLS certificate contents, proxy rate limits, external
firewall behavior, a browser session, or backup/restore. Those are in §8.

## 8. Preflight acceptance checklist

Record the command output with the exact commit, tree, image ID, host, and date. A
row is not accepted on "it should work".

| Item | How | Pass criterion |
| --- | --- | --- |
| Pinned image recorded | `docker image inspect --format '{{.Id}}' "$CORKBOARD_PREVIEW_IMAGE"` | One `sha256:` ID recorded with the commit/tree; base image digest matches the Dockerfile |
| Secret file private | `stat -c '%a %u:%g %n'` on the directory and file; `test ! -L` | Directory `700`, file `600`, `1000:1000`, regular file; no production path or value involved |
| Container hardening | §5 `docker inspect` commands | `user=1000:1000`, `ReadonlyRootfs=true`, `CapDrop=[ALL]`, `no-new-privileges:true`, secrets bind `rw=false` |
| Loopback only | `ss -ltnp`; probe from a second host | Host listens on `127.0.0.1:<port>` only; `<port>` unreachable externally |
| TLS | `curl -fsS https://preview.example/healthz`; `openssl s_client -connect preview.example:443 -servername preview.example </dev/null` | Valid chain for the name, TLS 1.2+, HTTP `301` from `:80`, no plaintext service |
| Proxy limits | Confirm `limit_req`, `limit_conn`, `client_max_body_size 1m` are loaded; send an oversized body | 1 MiB+ request is rejected at the proxy; a >64 KiB JSON request gets the application `413` |
| `/healthz` | Preflight or `curl` | `200 {"status":"ok"}` |
| `/readyz` | Preflight or `curl` | `200 {"status":"ready"}` |
| Login/session cookies | Preflight `--login` + `--password-file`; manual browser sign-in | The app's exact `SESSION_COOKIE_NAME` (`__Host-...`), not any `__Host-` cookie: `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, no `Domain`; CSRF cookie: `Secure`, `SameSite=Strict`, not `HttpOnly` |
| CSRF | Preflight login checks; manual browser sign-out | Session `DELETE` without `X-CSRF-Token` is `403`; with it is `204`; a failed check does not revoke |
| Project authorization (non-member) | Preflight `--nonmember-credential-file` | `404 NOT_FOUND`, not `403` and not `200` |
| Credential issuance/revocation | §4.1 CLI `issue-key` and credential ID; §5.1 loopback `/me` before and after `revoke-key`; preflight `--revoked-credential-file` | Pre-revocation `/me` is `200`; the post-revocation probe and the preflight are `401` |
| Message send/list/body/read/replay/idempotency | Preflight | `201`/`200`, exact body and digest, `200` receipt, `200` replay with the same ID/sequence, `409` conflict |
| Restart persistence | `"${COMPOSE[@]}" run --rm -T corkboard node dist/scripts/corkboard.js doctor --data-dir /data --json` before; `"${COMPOSE[@]}" stop corkboard`; `"${COMPOSE[@]}" up -d --wait`; the same `doctor --data-dir /data --json` after; rerun preflight | Counts unchanged, `/readyz` ready, preflight replay returns the same message; no data in the container layer |
| Backup/verify/restore | §8.1 commands | `backup` and `verify` exit `0`; `restore` into a new host directory succeeds; `doctor` on the restored copy exits `0` with 0 issues |
| Browser smoke (manual, not executed here) | Sign in over HTTPS, open the project timeline, reveal the preflight body, send a message, switch en/zh, sign out | No console error, no XSS, expected pages and cookies; record that this was a manual browser pass at the exact revision |
| ChatGPT/MCP client (external, not executed here) | Only if a real client is available | Not claimed. Record the exact client/account/result or leave it untested |

### 8.1 Backup, verify, and restore into a new directory

Backups contain ciphertext and metadata, not keys. Keep the `0600` secrets file in
its separate backup.

```bash
BACKUP_ROOT=/srv/corkboard-preview/backups
sudo install -d -m 0700 -o 1000 -g 1000 "$BACKUP_ROOT"
BACKUP_NAME="corkboard-$(date -u +%Y%m%dT%H%M%SZ)"

"${COMPOSE[@]}" run --rm -T \
  -v "$BACKUP_ROOT:/backups" \
  corkboard node dist/scripts/corkboard.js backup \
    --data-dir /data \
    --out "/backups/$BACKUP_NAME" --json

# backup --json prints no output path; reuse the exact --out value.
"${COMPOSE[@]}" run --rm -T \
  -v "$BACKUP_ROOT:/backups:ro" \
  corkboard node dist/scripts/corkboard.js verify \
    --backup "/backups/$BACKUP_NAME" --json

RESTORE_ROOT=/srv/corkboard-preview/restore-check
# The mount point must be writable: restore stages in a sibling directory of the
# target, and the container root filesystem is read-only.
sudo install -d -m 0700 -o 1000 -g 1000 "$RESTORE_ROOT"
"${COMPOSE[@]}" run --rm -T \
  -v "$RESTORE_ROOT:/restore-check" \
  -v "$BACKUP_ROOT:/backups:ro" \
  corkboard node dist/scripts/corkboard.js restore \
    --backup "/backups/$BACKUP_NAME" --data-dir /restore-check/data --json

"${COMPOSE[@]}" run --rm -T \
  -v "$RESTORE_ROOT:/restore-check" \
  corkboard node dist/scripts/corkboard.js doctor \
    --data-dir /restore-check/data --json
```

`restore` refuses a non-empty target, stages in a sibling directory, re-hashes,
and renames atomically. `/restore-check` is a writable bind mount and
`/restore-check/data` is created by `restore`; do not pre-create the target. The
restored copy is a scratch proof; remove only `"$RESTORE_ROOT"` after recording
the `doctor` result. Do not restore over the live preview volume.

## 9. Rollback and decommission

The preview is a separate Compose project with a separate named volume and secrets
directory. Rollback must never touch the production stack.

1. Stop the preview without deleting data:

   ```bash
   "${COMPOSE[@]}" down
   ```

2. If the preview volume itself must be removed, first confirm the exact name and
   the preview labels, then remove only it:

   ```bash
   docker volume ls --format '{{.Name}}' | grep -x "$CORKBOARD_PREVIEW_DATA_VOLUME"
   LABELS=$(docker volume inspect "$CORKBOARD_PREVIEW_DATA_VOLUME" --format \
     '{{index .Labels "com.docker.compose.project"}}:{{index .Labels "corkboard.preview"}}')
   # Expected: $CORKBOARD_PREVIEW_PROJECT:true; stop on anything else.
   [ "$LABELS" = "$CORKBOARD_PREVIEW_PROJECT:true" ] \
     || { echo "refusing to remove: preview labels missing or different" >&2; exit 1; }
   "${COMPOSE[@]}" down -v
   ```

   `down -v` removes the preview project's named volume. It does **not** authorize
   removing any other volume. Never run `docker system prune`, `docker volume
   prune`, or a bare `docker compose down -v` from the repository without the two
   preview files and `--project-name`. Confirm
   `CORKBOARD_PREVIEW_SECRETS_DIR` is not a production path before removing or
   reusing anything.

3. Restore a previous data set without overwriting the current one: keep the
   current volume aside, restore the verified backup into a new host directory
   (§8.1), then start a second isolated container that bind-mounts the restored
   directory at `/data` (same image, same preview secrets, a different loopback
   port). Verify it, then switch testers to it. The shipped `restore` never
   overwrites an existing installation.

4. Invalidate preview credentials. List the preview credential IDs (never tokens)
   with the same one-shot `--data-dir` pattern:

   ```bash
   "${COMPOSE[@]}" run --rm -T corkboard node --input-type=module -e \
     'import {DatabaseSync} from "node:sqlite";
      const db = new DatabaseSync("/data/corkboard.sqlite", {readOnly: true});
      for (const row of db.prepare("SELECT id, speaker_id, revoked_at FROM credentials ORDER BY created_at").all()) {
        console.log(row.id, row.speaker_id, row.revoked_at ?? "active");
      }
      db.close();'
   ```

   Revoke each active credential and remove each preview speaker with the merged
   Compose invocation (repeat `remove-member` for every preview project the
   speaker belongs to, including `$PROJECT_B`):

   ```bash
   "${COMPOSE[@]}" run --rm -T corkboard \
     node dist/scripts/corkboard.js revoke-key --credential "<credential-id>"
   "${COMPOSE[@]}" run --rm -T corkboard \
     node dist/scripts/corkboard.js remove-member \
       --project "$PROJECT" --speaker "<speaker-id>"
   ```

   If the volume is deleted, the credentials no longer authenticate anywhere, but
   any token that was shared with a tester must still be treated as exposed.
   Rotate or revoke it if the same value could be reused. On decommission, remove
   the preview secrets file only after deciding whether the data backup is
   retained. If it is retained, keep the secrets file `0600` and separate; without
   the key set the ciphertext is unrecoverable.

5. Leave production untouched. The production Compose project, network, volume,
   secrets file, and certificates are not referenced by `compose.preview.yaml`.
   Confirm with `docker volume ls`, `docker compose ls`, and the exact project
   name before any removal.

## 10. Known limitations

- **ChatGPT interoperability is unclaimed.** No ChatGPT account, plugin, OAuth
  consent, or conversation-level tool invocation was tested. Local MCP/OAuth is not
  evidence of ChatGPT support.
- **No browser pass is claimed.** The dashboard, CSP, cookie behavior, and UI are
  covered by application tests and the earlier acceptance report, but this package
  did not run a browser against the preview host.
- **Single host, single process.** SQLite serializes writers; rate limits, metrics,
  login buckets, and MCP sessions are process-local; do not run replicas against
  the same volume.
- **No per-IP limits in the application.** Per-IP request/connection and volumetric
  limits must be configured and verified at the proxy. This package does not
  execute or verify them.
- **No account registration, email verification, or password reset.** Accounts are
  created only by the operator CLI. OAuth dynamic client registration is not
  account registration and is disabled while `CORKBOARD_PUBLIC_BASE_URL` is unset.
- **OAuth/MCP are opt-in.** Setting `CORKBOARD_PUBLIC_BASE_URL=https://preview.example`
  in the preview secrets file enables the OAuth routes; leave it unset unless the
  tester specifically needs OAuth/MCP linking. Cloudflare Access must be scoped or
  bypassed for those routes.
- **TLS and reverse-proxy configuration are not executed here.** No certificate was
  issued and no nginx/Cloudflare configuration was applied. The snippets are
  operator input.
- **Loopback plaintext is trusted by name.** The preflight accepts
  `http://localhost` and `http://127.0.0.1`/`::1`. `localhost` is resolved through
  the hosts file or DNS, so a local hosts-file change can point it at another
  address; use the numeric loopback address when that must be unambiguous.
  Plaintext is never accepted for a non-loopback host.
- **The application server can read bodies.** This is not end-to-end encryption.
- **No scheduler.** `expire-bodies`, `prune`, `backup`, `verify`, and `doctor` are
  operator-run. There is no automatic message deletion.
- **Attachments are not implemented.** Text is limited to 2000 graphemes / 8192
  UTF-8 bytes; requests are capped at 64 KiB.
- **Key rotation is not implemented.** One root-key version and one pepper. Key
  loss means ciphertext loss; previously read plaintext cannot be un-read.
- **Backup/restore was not rehearsed on the preview host.** The scripts are tested
  locally; the §8.1 run is the proof for this installation.
- **The preflight creates one synthetic message** per credential/project with a
  fixed idempotency key. It is safe to rerun; it is not a load or soak test.

## 11. What remains blocked on maintainer-supplied infrastructure

The package stops here. The following cannot be produced from the repository:

- a host (or VM/container host) with Docker Engine and Compose v2.24+;
- a domain name and DNS control, plus an HTTPS certificate for it;
- a TLS reverse proxy (nginx or equivalent) and the decision between Option A and
  Option B;
- the authorized tester list (stable egress IPs for Option A, or a Cloudflare
  account/identity provider and a scoped Access policy for Option B);
- the preview owner password and the private `0600` credential files;
- a real MCP/OAuth client and a ChatGPT account/workspace, if interoperability is to
  be tested.

Once those exist, run §2–§8 in order and record the exact revision, image ID, host,
and command output. Until then, this remains a ready-to-run package, not a
deployment.
