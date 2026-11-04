# Security operations

Status: baseline for the self-hosted Node.js deployment. **The server, bootstrap CLI,
and migrations are not implemented yet**; runnable instructions are planned.
Cloudflare-specific steps are planned.

## Secrets and keys

The server needs two independent secrets plus one configuration path:

| Name | Kind | Purpose | Format |
| --- | --- | --- | --- |
| `CORKBOARD_ROOT_KEY` | secret | AES-256-GCM root key version `v1` | 32 random bytes, base64 |
| `CORKBOARD_CREDENTIAL_PEPPER` | secret | HMAC-SHA256 verifier for speaker tokens | 32 random bytes, base64 |
| `CORKBOARD_DATA_DIR` | config | SQLite and blob directory location (key material stays separate) | filesystem path |

`CORKBOARD_DATA_DIR` is configuration, not key material; do not place it in a secret
manager or treat it as a backup secret. Rules:

- Never write these values to the repository, SQLite settings, logs, CI output, or
  agent transcripts.
- The planned bootstrap command (`dist/scripts/corkboard.js init` after build; source
  `scripts/corkboard.ts`, **not implemented yet**) will create a `secrets.env` file
  with mode `0600` outside the repository (default `~/.config/corkboard/`) and print
  only the path.
- The process loads secrets from environment variables (or the file via the service
  manager). It never serves or echoes them.
- The root key is a **service key version**, not a per-message DEK, in the first slice.
  This is documented as a simplification; rotation requires re-encryption. Upgrade to
  wrapped per-object DEKs before a public release if warranted.
- Key loss means ciphertext loss. Back up keys separately from the database and test
  restore.

## Token handling

- Speaker token format: `cb_` followed by the base64url encoding of 32 random bytes
  (43 characters; 46 total). The stored public prefix is the first 12 characters.
  `scripts/secret-scan.ts` treats any `cb_`-prefixed value of 32+ token characters as a
  secret, so issuance must keep this format.
- Speaker tokens are random 256-bit values displayed once at issuance. Only the public
  prefix and an HMAC verifier are stored.
- Tokens are bound to a speaker and carry explicit scopes. Revocation and expiry are
  checked on every request; no authorization cache exists in the first slice.
- Agents must receive their own token. Do not share one token between a parent and its
  subagents if attribution matters; sharing makes them indistinguishable.

## Database and blobs

- SQLite: WAL, `foreign_keys=ON`, `busy_timeout` set. Database file and blob directory
  are readable only by the service user (`0700` directories, `0600` files).
- Blobs are stored under random opaque keys, never served statically.
- Ciphertext is AES-256-GCM with a fresh 96-bit nonce per encryption. AAD binds service
  ID, project ID, message ID, object ID, format version, compression, and the
  sender-verified plaintext SHA-256.
- Only the ciphertext SHA-256 is stored. The plaintext digest is sealed inside the
  authenticated envelope and bound into the AAD. Reads verify the ciphertext digest,
  decrypt, then verify the plaintext digest before returning any content; a mismatch
  creates no receipt. No cross-tenant deduplication.

## Logging and audit

- Log request ID, route, status, duration, actor IDs, and stable error codes.
- Never log message bodies, summaries, tokens, keys, full IPs, or password material.
- `audit_events` records credential issuance/revocation, membership changes, expiry,
  and administrative actions. Bounded retention; no body content.

## Environment separation

Staging and production use separate root keys, credential peppers, data directories,
domains, and credentials. Never copy production key material or speaker tokens into a
staging environment, CI, or a test fixture. CI holds no deployment secrets. A staging
deployment that uses production-derived keys is not an acceptable rehearsal.

## Backup and restore

1. Stop writes or use SQLite online backup with WAL checkpoint.
2. Back up the database and the blob directory together; they are a pair.
3. Store key material in a separate secret manager/backup with access control.
4. Quarterly: restore into a scratch directory, start the server, fetch a known body,
   and verify a tampered blob fails.

## Incident response

1. Revoke the affected credential(s) and disable the speaker membership if needed.
2. Rotate the credential pepper only with a plan: existing verifiers become invalid
   unless dual-read migration is implemented. Prefer revoke/reissue.
3. Rotate the root key by re-encrypting bodies; do not delete the old key until the
   migration is verified.
4. Preserve audit records and request logs without copying bodies or secrets.
5. Notify affected users honestly, including that server-readable encryption does not
   protect previously read plaintext.

## Known limits

- The operator can read all message bodies.
- Hard deletion of metadata/backups is not implemented; expiry is a tombstone, not
  comprehensive erasure.
- Rate limiting and abuse controls are not implemented in the first slice.
- No web session layer yet; bootstrap and credential issuance are planned to be
  CLI-only in the first slice.
