# Incident response

This is the procedure for the self-hosted Node.js + SQLite deployment. It is a
documented runbook, not a claim of a live on-call rotation, 24/7 coverage, staffed
security team, or a guaranteed response time. Each operator must name responders, a
contact channel, and any notification obligations for its jurisdiction before relying
on this procedure. The repository contains no default incident contact.

Use [`runbook.md`](./runbook.md) for exact commands, [`security-operations.md`](./security-operations.md)
for key/backup/audit behavior, and [`privacy.md`](./privacy.md) for what data exists.
Record every step (time, actor, action, revision) without copying bodies, tokens, keys,
or full IPs.

## Severity and notification

Classify honestly; do not inflate or hide. There is no automatic paging.

| Severity | Examples | Response expectation |
| --- | --- | --- |
| SEV1 | Suspected root-key, credential-pepper, or database exfiltration; active unauthorized administrative access; confirmed body disclosure at scale | Treat as a breach. Contain immediately, preserve evidence, notify the operator's designated decision-maker and affected users as required by law/policy. |
| SEV2 | Compromised speaker credential or OAuth refresh family; unauthorized project access; integrity failure or tampered ciphertext; persistent auth bypass | Contain the credential/session, assess scope from audit rows, notify affected project owners. |
| SEV3 | Sustained abuse or resource exhaustion; repeated failed logins; a single-user data issue; audit insert failures | Throttle at the proxy, rotate the affected credential, schedule a fix. |
| SEV4 | Documentation error, low-impact misconfiguration, cosmetic security issue | Track and fix in the normal campaign flow. |

Notification is operator-defined: identify who must be told (affected account owners,
the deployment's security contact, legal/privacy owner) and how. Do not promise
notification you cannot deliver. For a personal-data breach, the operator decides
whether and how to notify users and authorities under the applicable law; the software
does not send notifications. Do not post exploit details or live credentials in a
public issue.

## Detection

Sources: the process's JSON request log (sanitized; no bodies/IPs/tokens), `GET
/readyz`, `GET /metrics` when enabled, `doctor` reports, audit counts surfaced by
`GET /overview`, reverse-proxy access/error logs (operator-owned), and filesystem
monitoring. Audit writes are fail-open and `audit_events` is unbounded, so absence of an
audit row is not proof that nothing happened.

## Containment

Choose the smallest action that stops the harm; keep the service's data directory and
backups intact.

1. **Revoke a compromised credential.** `revoke-key --credential <id>` (or the
   dashboard's per-credential revoke action) marks it revoked; revocation is checked on
   every REST and MCP request. To replace it without changing projects/scopes, use
   `rotate-key --credential <id>`, which revokes and prints the replacement once in one
   transaction. Deliver the replacement through the agent's own environment.
2. **Reduce a speaker's access.** `revoke-key-project --credential <id> --project
   <id>` removes one grant; `remove-member --project <id> --speaker <id>` removes the
   membership and the speaker's grants. Removing a project's owner or all memberships
   may make it unmanageable through the dashboard; prefer targeted revocation.
3. **Revoke OAuth access.** Use `POST /oauth/revoke` for a refresh or access token, or
   revoke the OAuth-issued credential through the credential path. Revoking any token in
   a refresh family revokes the family on reuse detection; revoking the credential stops
   both REST and MCP.
4. **Stop the service.** Send `SIGTERM` (or `SIGINT`); the adapter stops accepting
   connections, closes the server, and closes the database. In Docker, `docker compose
   stop` uses `SIGTERM` with the configured grace period. Stopping the service is the
   blunt containment for an unresolved active intrusion.
5. **There is no supported project-disable operation.** New projects are created with
   `status='active'`, but no CLI or dashboard command changes an existing project's
   status (`create-project` does not accept a status option). Do not hand-edit project
   status as a containment step. To cut off access, revoke credentials/memberships or
   stop the service.
6. **Do not rotate the root key or pepper as a reflex.** Root-key rotation with
   re-encryption and pepper dual-read migration are **not implemented**. Regenerating
   the secrets file makes existing ciphertext undecryptable and existing token verifiers
   invalid. Prefer revoke/reissue; if key compromise is confirmed, stop the service,
   preserve the old key for evidence, and treat all stored plaintext as exposed.
7. **Network containment.** If the proxy or host is compromised, block public traffic at
   the proxy/firewall, keep the application on loopback, and replace proxy credentials
   and certificates.

## Evidence preservation

Before cleanup, preserve what is needed and nothing more:

- `audit_events` (sanitized) and the operator's request/proxy logs; note their time
  range and known gaps. `audit_events` is not tamper-evident against an operator with
  database write access.
- A verified backup: `backup --data-dir <dir> --out <new-dir>` then `verify --backup
  <new-dir>`. Keep the database and blobs as a pair; keys are backed up separately.
- `doctor --data-dir <dir> --json` output (counts, integrity, key presence booleans).
- The exact commit/revision and environment configuration (without secrets).
- Relevant `expire-bodies`/`prune` summaries if they ran during the window.

Do not copy message bodies, summaries, tokens, keys, password hashes, or full IPs into
incident notes, tickets, or chat. Do not delete live data or run a destructive prune
while evidence is being collected. Expiry and backup retention are not evidence
preservation guarantees.

## Recovery

1. Fix the root cause (patch on a branch, review, checkpoint commit; no force-push).
2. Rebuild or restart from known-good artifacts. Verify `/healthz` and `/readyz`:
   readiness must show `{"status":"ready"}` before routing traffic.
3. If data is suspect, restore into a new/empty directory with `restore --backup <dir>
   --data-dir <new-dir>`, run `verify`, then `doctor`, and only then switch traffic.
   Never restore over a live installation.
4. Reissue credentials. Revoke compromised credentials (`revoke-key`) and rotate
   affected non-OAuth credentials. There is **no operator session-revocation command or
   dashboard action**, and stopping/restarting the service does **not** revoke a
   session: a stolen session cookie stays valid across a restart until the session is
   idle (30 minutes) or absolutely (12 hours) expired, the owner signs out with `DELETE
   /api/v1/session`, or an operator performs the documented direct SQL below. For
   immediate containment, with the service stopped and a verified backup taken, revoke
   the row directly:

   ```sql
   -- Prefer this; it keeps the row and its timestamps for evidence.
   UPDATE sessions SET revoked_at = '<RFC3339 UTC now>' WHERE id = '<session id>';
   ```

   Use the `UPDATE` form; deleting the row can fail while an authorization-code row
   references the session and always discards evidence. This is an emergency path, not
   a supported CLI operation: it bypasses application audit, so record who ran it and
   when outside the service. `prune` later removes revoked/expired rows after the grace
   period. Require affected humans to sign in again after containment, and record that
   this version has **no account password-change/reset or account-disable path**:
   revoking sessions cannot stop someone who knows the account password from signing in
   again, so treat that as residual risk and escalate. Do not silently widen a
   credential's projects or scopes during reissue.
5. Run `expire-bodies` and `prune` only after evidence collection and a verified backup.
6. Rehearse the recovery path before relying on it. The executable synthetic drill in
   [`disaster-rehearsal.md`](./disaster-rehearsal.md) covers backup/verify, restore into
   a new directory, known-body decrypt, audit limits, cursor resync, revoke/rotate, and
   interrupted send/finalize recovery in temporary directories. It is evidence for the
   procedure, not a substitute for a rehearsal with the operator's real backup and a
   scratch host.
7. Confirm behavior with tests and, where applicable, negative authorization tests.
8. Monitor readiness, error codes, `429` volume, and audit growth for a period chosen by
   the operator.

## Post-incident

- Update `IMPLEMENTATION_STATE.md` with the incident summary, affected revisions, and
  what was verified; update `TODO.md` if a gap needs work.
- Add a `LESSIONS.md` entry only for a real, reusable lesson (not a narrative).
- Record the timeline, root cause, impact, and follow-up owners without sensitive data.
- Revisit this procedure, the privacy notice, and the threat model if the incident
  exposed an unstated assumption.
- Tell affected users honestly: the server can read bodies, TLS protects transit only,
  expiry does not rewrite backups, and previously read plaintext cannot be un-read.
