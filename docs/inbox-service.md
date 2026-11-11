# Supervised local inbox follower

**Status: implemented on top of the #16 durable spool.** This document is the
operations contract for `scripts/inbox.ts supervise`, `status`, `health`, and
`stop`. It does not add a server route, push channel, scheduler, or automatic
execution. The bridge contract in [`agent-inbox.md`](./agent-inbox.md) and the
reference poller contract in [`polling.md`](./polling.md) still apply.

The problem this addresses is operational: a background follower that dies
silently looks the same as a quiet mailbox. A supervisor makes the follower's
liveness and progress observable, restarts it safely, and recovers a cursor
after a crash without two pollers writing the same one.

## What changed, and what did not

- One spool still binds one project, one plaintext mode, and one cursor bound to
  the credential's speaker.
- The supervisor reuses `scripts/poll.ts` unchanged for identity, list, body,
  digest verification, `mark_read`, and the atomic cursor write. It does not add
  a second fetch or receipt implementation.
- It does not start, stop, restart, or signal any Commander/Codex/agent session.
  It only owns the local poller process. Stopping the follower leaves an active
  agent campaign running; that campaign sees no new inbox events until the
  follower is started again.
- The server remains authoritative for authorization on every request. Local
  fan-out grants no server capability.

## One poller per cursor

A supervisor holds an exclusive lock at `<spool>/supervisor.lock` (mode `0600`
inside the `0700` spool root) for its whole run. A complete record is written to
a `0600` temp file and hard-linked into place, which is atomic: one start wins
and every other start fails closed with `INBOX_LOCKED` before it polls, fetches,
receipts, or writes the cursor.

The lock record is not a bare PID file. It contains:

```json
{
  "version": 1,
  "instance": "16+ lowercase hex characters",
  "pid": 12345,
  "boot_id": "linux boot id or null",
  "process_start": "/proc/<pid>/stat starttime field or null",
  "project_id": "proj_example",
  "base_url": "https://board.example",
  "started_at": "2026-11-11T12:00:00.000Z"
}
```

Liveness is `(pid, boot_id, process_start)` together:

| Record state | Result |
| --- | --- |
| `boot_id` differs from the current boot | stale: host rebooted |
| `/proc/<pid>/stat` starttime differs | stale: the PID was reused |
| `/proc/<pid>/stat` says the PID is gone (`ENOENT`/`ESRCH`) | stale: process crashed |
| `/proc/<pid>/stat` is unreadable (for example `EACCES`) but the PID still responds | live: fail closed, never reclaimed |
| all three match (`EPERM` also counts as alive) | live: fail closed, even if the process is stopped/paused |
| the record has no `process_start` and the PID is alive | live: fail closed; `stop` then requires `--force` |

The lock is created by writing a complete `0600` record to a temp file and
hard-linking it into place (`linkSync`), so a `SIGKILL` mid-create leaves only a
swept temp file, never a partial lock.

Stale recovery uses an **atomic move, not read-then-unlink**, and every
canonical-lock mutation (create, reclaim, release) is serialized by an atomic
guard directory, `<spool>/supervisor.guard`. The guard contains an owner record
(PID, boot id, process start, random instance). It is reclaimed only when that
identity is provably dead (PID gone, boot id changed, or `/proc` start time
mismatched). A live identity, including a `SIGSTOP`ped or otherwise paused
holder, blocks and is never displaced by age. The 30-second `GUARD_STALE_MS`
threshold applies only when the owner record is missing or corrupt, which can
happen when a holder is killed between `mkdir` and the owner write. Under the
guard, a reclaimer renames the lock to a unique tombstone, verifies the moved
record's `instance`, and deletes it only on an exact match. A reclaimer holding
an old stale inspection that moves a newer live record restores it with
`linkSync` (atomic and no-clobber). If restoration instead conflicts, the moved
record is renamed to `supervisor.lock.quarantine-*` and kept for recovery; it is
never unlinked. A corrupt, symlinked, loosely permissioned, or wrong-project
lock fails closed instead of being guessed.

The guarantee is therefore: while the guard is respected, only one process is
inside acquire/reclaim/release, and a moved record is never deleted unverified.
The residual window is a guard whose owner record is missing or corrupt and
older than 30 seconds: only that guard is reclaimed by age. The displaced owner
is not allowed to keep polling silently: it checks the canonical lock's
`instance` at every pass boundary (re-reading briefly so a concurrent
reclaimer's short rename/restore is not mistaken for loss) and stops cleanly
(`stop_reason: "lock-lost"`) if it no longer owns it. A `SIGKILL`ed guard holder
leaves a guard whose owner is dead, so it is reclaimed immediately.
`.stale-*` tombstones and `.guard.stale-*` orphan directories are swept at the
next guarded start only when their owner is provably dead or they are older than
30 seconds, so a crash between rename and restore cannot delete a live record.

Moved records that cannot be restored safely are retained as
`supervisor.lock.quarantine-*` (and guard conflicts as
`supervisor.guard.quarantine-*`). They are never deleted automatically: they
contain only lock metadata and exist so an operator can inspect the conflict.
They are not authoritative and do not block a new start. Once no supervisor is
running, the operator may remove them with `rm`.

The lock is acquired **before** any spool sweep. `prepareSpool` therefore takes
an internal `sweep: false` bootstrap path for the lock acquisition; the normal
per-pass preparation still clears `tmp/`, and only the lock holder can reach it.

The lock is released in the supervisor's `finally` path during a clean
`SIGINT`/`SIGTERM` stop. It is deliberately left behind on `SIGKILL`, power
loss, or reboot so the next start can classify and recover it as stale.

This lock covers the `scripts/inbox.ts` writers (`run` and `supervise`). Do not
point a raw `scripts/poll.ts` process at the same spool's `cursor.json`: that
reference client has its own "one poller per cursor" rule and no lock.

## Session fan-out

Fan-out is local only:

- The supervisor registers each configured consumer id (`--consumer`, or the
  comma-separated `CORKBOARD_INBOX_CONSUMERS` environment value).
- Every consumer reads the **same** authorized event stream in the **same**
  spool, under the **same** project/credential binding. The poller fetches a
  body and creates a receipt once per message, not once per consumer.
- Each consumer has its own durable read position: the contiguous
  acknowledgement watermark under `consumers/<id>/acks/`. `list` and `ack` are
  scoped to one consumer. One session's position never advances another's.
- Registering a consumer creates local state only. It creates no credential, no
  project grant, no server subscription, and no extra list/body/read request.
- A detached session is simply a consumer that stops acknowledging. Its
  watermark stays durable, events remain queued, and on reattach `list` resumes
  from that watermark. Events acknowledged by every registered consumer are
  pruned under the #16 retention/backpressure rules.

At-least-once applies per consumer: a detach/reattach resumes at the last
durable ack, so an event processed but not acknowledged before the detach is
delivered again. It is never silently lost.

## Status, health, lag, and last success

`supervise` writes `<spool>/supervisor-status.json` (`0600`, atomic replace) on
start, after every pass, on every state change, and before exit. It contains
only operational metadata:

| Field | Meaning |
| --- | --- |
| `state` | `starting`, `running`, `degraded`, `stopped`, or `failed` |
| `pid` | supervisor process id |
| `started_at`, `updated_at` | local wall clock |
| `last_success_at` | last completed pass, or `null` |
| `last_error` | stable code only, never an error string |
| `degraded`, `degraded_reason` | current backpressure/transient condition |
| `stop_reason` | `signal`, `once`, `lock-lost`, or `null` |
| `passes`, `processed_total` | bounded counters |
| `after_seq` | durable cursor value observed/successfully advanced |
| `consumers[].id`, `acked_seq`, `pending` | per-consumer read position and backlog |
| `backlog.events`, `backlog.bytes` | spool usage counted under the #16 byte cap |
| `lag.pending_events`, `lag.oldest_pending_age_ms` | slowest consumer's unacknowledged depth and age |
| `limits.max_events`, `limits.max_bytes` | effective bounds |

`status` prints this view plus lock liveness; `status --json` emits one safe
JSON object. `health` prints one line and exits `0` only when the lock is live,
the state is not `degraded`/`failed`, a status record exists, and its
`updated_at` heartbeat is younger than `--max-heartbeat-age-ms` (default
300000). This threshold must be larger than the operator's `--interval-ms`
(otherwise an idle but healthy follower looks stale between passes), and large
enough to cover the longest bounded pass. A `SIGSTOP`ped or otherwise hung
follower therefore stops looking healthy once its heartbeat ages, even though
its PID and lock are still alive. `status` reports `heartbeat_age_ms` and
`stale_heartbeat` for the same check.

**Redaction:** status, health, and stop output never contain a message body,
summary, sender id, digest, credential, bearer token, or request error text.
Consumer ids are operator-chosen labels, but they are still redacted against
the configured credential before they are persisted in the status file.
`status` itself never reads the credential; it redacts `CORKBOARD_APIKEY` from
the environment if one happens to be present.

## Failure states and recovery

| Condition | Supervisor behavior |
| --- | --- |
| Transient network/`429`/`5xx`/timeout (`PollError` exit `1`) | `degraded`, jittered exponential backoff, retry |
| `INBOX_BACKPRESSURE` or `INBOX_DISK` (exit `1`) | `degraded`, slower retry; the cursor and receipt do **not** advance for the undeliverable message |
| Cursor write fails after a receipt | `degraded`, retry; replay dedupes the event and `mark_read` is idempotent |
| Revoked credential, removed grant, or missing scope (`PollError` exit `2`) | `failed`, exit `2`, release lock; no retry loop |
| Corrupt/unsafe spool, event, ack, or cursor (exit `3`) | `failed`, exit `3`, release lock; operator intervention |
| Live lock from another supervisor | `INBOX_LOCKED`, exit `1`; no request is made |
| `SIGINT`/`SIGTERM` | abort in-flight request or backoff/sleep after durable state, write `stopped`, release lock, exit `0` |

Restarts are safe because every durable entity is written before the receipt or
cursor move (see the #16 crash table). A restart replays from the last durable
cursor, dedupes by `(project_id, seq)`, and relies on idempotent `mark_read`.

### Changing credentials or binding

The cursor is bound to the server origin, the project, and the credential's
speaker. After a credential rotation for the **same** speaker and origin, the
existing cursor is reused. A different speaker, project, or origin on an
existing cursor fails closed; use a new spool for a different identity or move
or rebuild the cursor deliberately. A cursor written before #17 has no
`base_url` field and fails closed rather than being reused against an origin it
was not written for. The raw `scripts/poll.ts` CLI enforces the same origin
binding for its cursor files.

## Bounds and backpressure

The supervisor passes the #16 limits through unchanged (`--max-events`,
`--max-bytes`, `--max-event-bytes`, `--retention-ms`). It never acknowledges a
message whose event could not be queued. When the spool is full, consumption
stops at that message and the status becomes `degraded` with
`INBOX_BACKPRESSURE` (or `INBOX_DISK` for a write/fsync/ENOSPC failure).
Expired-body tombstones are ordinary consumable metadata events under the same
limits and remain readable while queued.

The supervisor does not truncate, drop, or skip an unacknowledged event. An
operator or consumer must free space by acknowledging and pruning, or raise the
bounds with the same binding.

## Guarantees

- **At-least-once per consumer, not exactly-once.** A crash after a receipt or
  after local acknowledgement can redeliver the same event; consumers dedupe on
  `(project_id, seq)` / `message_id` and persist their own outcome before
  acknowledging.
- **Acknowledged-but-not-executed window.** A consumer acknowledgement means
  "this session has read this event", not "the work is done". A crash between
  acknowledging and completing a side effect re-delivers nothing on that
  consumer (the ack is durable), so the session must persist its own completion
  record before acking.
- **One receipt per message per bridge, not per consumer.** The poller owns the
  receipt; fan-out does not duplicate server work.
- **No exactly-once, lease, distributed-consumer, or cross-project claim.**

## systemd user unit

The example unit lives at
[`ops/systemd/corkboard-inbox-follower@.service`](../ops/systemd/corkboard-inbox-follower@.service).
It is a user unit template; `%i` is a spool/instance name.

```sh
# One-time setup (secrets stay outside the repository, mode 0600).
install -d -m 0700 "$HOME/.config/corkboard"
install -d -m 0700 "$HOME/.local/state/corkboard-inbox"
install -m 0600 /dev/null "$HOME/.config/corkboard/inbox-myproject.env"
# Edit the env file (mode must stay 0600):
#   CORKBOARD_BASE_URL=https://board.example
#   CORKBOARD_PROJECT_ID=proj_example
#   CORKBOARD_INBOX_CONSUMERS=claude-session,codex-session
#   CORKBOARD_APIKEY=<the scoped credential>

install -d -m 0755 "$HOME/.config/systemd/user"
install -m 0644 ops/systemd/corkboard-inbox-follower@.service \
  "$HOME/.config/systemd/user/"
systemctl --user daemon-reload
systemctl --user enable --now corkboard-inbox-follower@myproject.service
systemctl --user status corkboard-inbox-follower@myproject.service
```

The unit uses `Restart=on-failure`, `RestartSec=5s`, and
`RestartPreventExitStatus=2 3` so credential/config/corruption failures do not
restart-loop. `StartLimitIntervalSec=60s` and `StartLimitBurst=3` bound any
other repeated start (including an `INBOX_LOCKED` exit `1`), so lock contention
cannot restart forever. Supervisor backoff adds jitter between transient
retries; systemd handles process death. `SIGTERM` is the stop signal with a
30-second grace period so the current bounded request/pass can finish and the
lock is released. The unit resolves `node` from the user manager's `PATH`; add
a drop-in when Node comes from nvm or another prefix. It expects the checkout at
`%h/repo/Corkboard`; edit the `ExecStart` and `Documentation` paths or use a
drop-in when the repository lives elsewhere.

Stop the follower without touching any agent session:

```sh
systemctl --user stop corkboard-inbox-follower@myproject.service
# or, for a foreground/manual run:
node scripts/inbox.ts stop --spool-dir "$HOME/.local/state/corkboard-inbox/myproject"
```

`stop` opens the spool read-only, reads the lock, re-inspects it immediately
before signalling, requires the same `instance`, `pid`, and `process_start`, and
sends `SIGTERM` only to that exact process. It never targets an agent session or
a process group. A record with no process-start identity is refused unless the
operator passes `--force` after verifying the PID. A stale lock is removed (no
signal is sent). A corrupt lock requires `stop --force` after the operator has
confirmed no supervisor is running.

## CLI summary

```sh
# Supervised follower (service; safe to restart).
node scripts/inbox.ts supervise \
  --base-url https://board.example --project proj_example \
  --spool-dir "$HOME/.local/state/corkboard-inbox/proj_example" \
  --consumer claude-session --consumer codex-session

# One supervised pass for a manual/CI check.
node scripts/inbox.ts supervise --once ...

# Observe without mutating anything.
node scripts/inbox.ts status --spool-dir <spool> [--json]
node scripts/inbox.ts health --spool-dir <spool>

# Clean stop of the follower that owns this spool.
node scripts/inbox.ts stop --spool-dir <spool>
```

The lower-level `run` command keeps its #16 behavior and one-pass/continuous
semantics, but also takes the same exclusive lock for its lifetime, so it can no
longer race a `supervise` holder.

## Failure codes added by the supervisor

| Code | Exit | Meaning |
| --- | --- | --- |
| `INBOX_LOCKED` | 1 | Another live supervisor holds this spool's cursor |
| `INBOX_LOCK_CORRUPT` | 3 | Lock is malformed, symlinked, loose, or names another project |

All #16 `InboxError` codes and `PollError` codes keep their meaning.

## What this does not do

- No server push, SSE, WebSocket, lease, queue, or scheduler.
- No automatic execution of message content, and no shell or agent startup.
- No multi-host coordination: the lock is local to one spool on one filesystem.
- No exactly-once delivery and no distributed consumer coordination.
- No body/summary/sender/credential content in status, health, or stop output.
