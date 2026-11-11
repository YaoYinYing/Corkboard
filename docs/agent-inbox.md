# Local agent inbox (durable spool)

**Status: implemented as a client-side bridge over the reference poller.** The
server remains a message board. This bridge adds no server route, push channel,
scheduler, WebSocket, or automatic execution. It turns one authenticated REST
poll stream into durable, per-project local event records that independent local
consumers can read, deduplicate, and acknowledge.

The transport, project/speaker validation, body fetch, SHA-256 verification,
`410 BODY_EXPIRED` handling, idempotent `mark_read`, and atomic cursor write are
**not reimplemented here**. The bridge calls [`scripts/poll.ts`](../scripts/poll.ts)
and uses the contract in [`polling.md`](./polling.md). Read that document first.

## What a receipt means

A Corkboard receipt (`POST .../read`) created by this bridge means the message
body was **fetched and digest-verified by this client and the resulting event is
durably queued in the local spool**. It never means that a consumer understood,
executed, or completed the message. `mark_read` is not a work-completion record.

The bridge never executes message content. A verified body is untrusted data. It
is handed to the local consumer spool only; it is never passed to a shell, an
agent loop, or an automatic action.

"Metadata-only" describes the **local event**, not the poll: the bridge still
fetches and verifies the body so its `mark_read` keeps the receipt meaning above.
The credential therefore needs `message.read` and `receipt.write`, exactly like
the reference consumer. The verified plaintext is simply discarded unless the
spool opted in.

## Trust boundaries

- The server response is untrusted input. The bridge accepts a row only through
  the reference poller's structural, project-scope, sender, sequence, and
  `next_cursor` checks. A body is accepted only after the poller's canonical
  `sha256:` digest check over the UTF-8 text succeeds.
- The authenticated sender attribution is the server-derived `sender.id` in the
  authenticated list response. The bridge records it as
  `"attribution": "server_authenticated"`. It does not independently re-auth the
  sender, and it never accepts a caller-supplied sender.
- The local spool is written only through atomic, `0600` files and `0700`
  directories under a path outside the repository. Symlinked or loosely
  permissioned spool paths fail closed.
- Message plaintext is written **only** when the spool was created with explicit
  plaintext opt-in (`--plaintext`). The default event is metadata-only. No event,
  status line, error, or diagnostic contains the bearer credential or a message
  body.
- A consumer's acknowledgement is a local assertion that it has read the event.
  It is not proof of useful work.

## Spool location and layout

The operator chooses one spool directory per project. It must be outside the
repository. A recommended location is:

```text
$HOME/.local/state/corkboard-inbox/<projectId>/
```

The directory and every subdirectory created by the bridge are mode `0700`; the
configuration, event, payload, acknowledgement, and cursor files are `0600`.
POSIX reads open with `O_NOFOLLOW`, `fstat` the opened descriptor, and reject a
non-regular file, a symlink, or a file with any group/world permission bit.

```text
<spool>/
  spool.json                      # versioned binding: project_id + plaintext opt-in
  cursor.json                     # reference poller's durable after_seq state
  events/                         # immutable metadata events, one file per seq
    0000000000000001.json
  payloads/                       # only when plaintext is opted in
    0000000000000001.json
  consumers/
    <consumer-id>/
      acks/
        0000000000000001.json     # one immutable acknowledgement per seq
  tmp/                            # write/fsync staging; cleared on each bridge run
```

`spool.json` binds the directory to exactly one project and one plaintext mode.
Opening the same directory for another project or flipping `--plaintext` fails
closed. `cursor.json` remains the reference poller's file and is additionally
bound to the credential's speaker.

The bridge creates and chmods only the directories it creates. A pre-existing
spool root or spool subdirectory must already be private (`0700`); it is verified
and never re-chmodded, so passing a shared directory such as `/tmp` fails closed
instead of silently changing that directory's mode.

One bridge process may write to a spool. Multiple independent local consumers
may read it concurrently. The bridge takes no lock; a second bridge writer is an
operator error. Acknowledgement files are immutable per sequence, so a stale
acknowledgement writer racing a newer one can add a lower file but can never
regress the observed watermark (readers take the maximum). Bridge startup sweeps
`consumers/<id>/acks/*.json.tmp-*` crash leftovers, so do not start the bridge
while a consumer is mid-ack: acknowledgements are single-writer per consumer.

## Event record schema (version 1)

Events are canonical JSON objects. `version` gates the schema: an unknown version
fails closed rather than being interpreted.

```json
{
  "version": 1,
  "project_id": "proj_example",
  "seq": 42,
  "message_id": "msg_example",
  "sender": {
    "id": "spk_example",
    "attribution": "server_authenticated"
  },
  "body_state": "ready",
  "summary": "Review the migration plan",
  "queued_at": "2026-11-11T12:00:00.000Z",
  "payload": { "included": false }
}
```

With plaintext opt-in, `payload` is:

```json
{ "included": true, "digest": "sha256:<64 lowercase hex>", "path": "payloads/0000000000000042.json" }
```

The payload file is a `0600` JSON object containing `version`, `project_id`,
`seq`, `message_id`, `digest`, and the verified `text`. A consumer that reads it
recomputes the SHA-256 over the UTF-8 `text` and fails closed on a mismatch.

Rules:

- `project_id` must equal the spool binding and the requested project.
- `seq` is a positive safe integer, strictly increasing within a page as the
  poller enforces. It is also the event file name, zero-padded to 16 digits.
- `message_id` and `sender.id` are non-empty strings from the authenticated
  list row. They, like `summary`, are credential-redacted before persistence.
- `body_state` is `"ready"` or `"expired"`. An expired event is a consumable
  metadata tombstone: it has no payload and never had a receipt.
- `queued_at` is the bridge's local clock at durable queue time, not a server
  timestamp and not an authority for ordering.
- The event carries no read receipt, no server timestamps, and no severity or
  execution instruction.

### Dedupe key

The stable identity is **`(project_id, seq)`**. `message_id` is recorded and
checked as a secondary identity. A replay of the same `(project_id, seq)` with
the same `message_id` and sender is idempotent; the existing complete event is
returned unchanged and is never overwritten. The same `seq` with a different
`message_id` or sender, or a body whose digest differs from an already queued
payload, is a conflict and fails closed.

## Ordering rule

For every message the bridge observes:

1. obtain the page row through the authenticated list;
2. fetch the body and verify `message_id` and the canonical digest, or receive
   the server's definitive `410 BODY_EXPIRED` tombstone;
3. write the payload (when opted in), fsync it, atomically rename the event into
   `events/`, and fsync the directory;
4. only then issue `mark_read` (for a ready body); and
5. only then advance `cursor.json`.

No cursor advance and no receipt occurs before the event is durably queued.
For an expired body the server no longer permits a receipt, so the bridge
queues the tombstone and advances the cursor without one. A queue failure
before step 4 leaves the cursor unchanged and the message is retried on the next
run.

## Delivery and acknowledgement semantics

This is **at-least-once, not exactly-once**. Repeated delivery is allowed and
expected. Consumers deduplicate on `(project_id, seq)` (or the recorded
`message_id`) and persist their own outcome before acknowledging.

- Each registered consumer has a contiguous acknowledgement watermark composed
  of immutable per-sequence files under `consumers/<id>/acks/`. The current
  watermark is the greatest `acked_seq` present; files below it are best-effort
  cleaned up. A consumer becomes **registered** when its `acks/` directory
  exists. A registered consumer with no acknowledgement files counts as
  `acked_seq: 0` (conservative: it blocks pruning, and is not an error). A
  `consumers/<id>` directory without `acks/` is not registered: it is ignored by
  pruning and reported as `INBOX_NOT_FOUND` on a direct read/ack.
- `ackEvent` accepts a seq only when it is the next unacknowledged seq
  (`acked_seq + 1`) or is already at/below the watermark (idempotent no-op). An
  out-of-order acknowledgement is rejected; events themselves may be queued and
  listed out of arrival order because readers sort by `seq`.
- An event is pruned only after **every registered consumer** has acknowledged
  it (and the retention window has elapsed), or under backpressure as described
  below. Unacknowledged events are never deleted.
- A consumer registered after pruning begins at seq 0 and sees only events still
  present. Register every consumer before the first bridge run when complete
  history is required.

### Crash points

| Crash / failure point | Durable result | Recovery |
| --- | --- | --- |
| Before any spool write | no event, no receipt, cursor unchanged | next run re-fetches and queues |
| During a payload or event temp write | temp file only, no complete event, no receipt | next run clears `tmp/`, re-queues |
| After payload rename, before event rename | orphan payload, no event, no receipt | next run verifies the matching orphan and completes the event |
| After event rename, before `mark_read` | durable event, no receipt, cursor unchanged | next run re-fetches, dedupes the event, then retries `mark_read` |
| After `mark_read`, before cursor write | durable event, receipt may exist, cursor unchanged | next run replays; `mark_read` is idempotent and the event dedupes |
| After cursor write | durable event and advanced cursor | no replay for that seq |
| Corrupt or unknown-version event | fail closed | operator quarantines the file; no silent skip |
| Corrupt cursor or wrong project/speaker | fail closed | operator restores/rebuilds the cursor; no silent loss |

`polling.md` documents the reference client's own receipt/cursor crash window.
The bridge does not widen it: the event is durable before the receipt.

### Expired bodies

`410 BODY_EXPIRED` from a body fetch is definitive: no receipt can ever exist.
The bridge queues a metadata tombstone (`body_state: "expired"`, no payload),
fsyncs it, and only then advances the cursor past it. A `mark_read` that returns
`410 BODY_EXPIRED` after a body was already fetched and verified leaves the
verified event in place; that body was valid when fetched. No receipt is created.

## Bounded disk usage and backpressure

Defaults (overridable per run for tests and operators):

| Limit | Default |
| --- | --- |
| `maxEvents` | 10,000 event files |
| `maxBytes` | 64 MiB across events, payloads, `tmp/`, and unswept ack temp files |
| `maxEventBytes` | 256 KiB per event/payload JSON file |
| `retentionMs` | 24 hours after all consumers acknowledge |

Before a new event is written, the bridge measures usage. If a limit would be
exceeded it first prunes events every consumer has acknowledged; if room is
still insufficient it fails closed with `INBOX_BACKPRESSURE`. It never drops or
truncates an unacknowledged event. The failure propagates out of the poll
callback, so no `mark_read` and no cursor advance occurs; the same message is
retried after the operator or consumers make room. A disk-full or quota write
failure is `INBOX_DISK` and behaves the same way (no complete event, no receipt,
cursor unchanged).

Cleanup is deterministic: the event is unlinked first, then its payload, with the
directory fsynced. A crash between the two leaves a harmless orphan payload,
which is reused if the sequence is replayed and swept when it is safely behind
the watermark. `tmp/` and stale `acks/*.json.tmp-*` files are cleared at the
start of every bridge run; until then, ack temp bytes count against `maxBytes`.
At-least-once replay is unaffected because a message is re-read from the server
when its cursor has not advanced.

## Consumer surface

Library (`src/inbox/`):

```ts
prepareSpool(dir, projectId, { plaintext })   // create or validate the binding
openSpool(dir)                                // validate an existing binding
enqueueEvent(spool, message, body, { token }) // bridge-side durable queue
listEvents(spool)                             // sorted metadata events
readPayload(spool, event)                     // verified plaintext, opt-in only
registerConsumer(spool, consumerId)
pendingEvents(spool, consumerId, limit)       // seq > consumer watermark
ackEvent(spool, consumerId, seq)              // contiguous, idempotent
pruneSpool(spool, { force })                  // acked-only cleanup
runInbox(options)                             // poll -> queue bridge
```

CLI (`scripts/inbox.ts`):

```sh
# Bridge: one project, one credential, one or more consumers.
node scripts/inbox.ts run \
  --base-url https://board.example \
  --project proj_example \
  --spool-dir "$HOME/.local/state/corkboard-inbox/proj_example" \
  --consumer claude-session \
  --plaintext --once

# Metadata list for a consumer (never prints bodies).
node scripts/inbox.ts list --spool-dir <spool> --consumer claude-session

# Acknowledge the next contiguous event.
node scripts/inbox.ts ack --spool-dir <spool> --consumer claude-session --seq 42

# Remove events acknowledged by every registered consumer.
node scripts/inbox.ts prune --spool-dir <spool>
```

The credential is read from `CORKBOARD_APIKEY` or a `0600` `--token-file`,
never from a positional argument. `run` reuses the poller's base-URL, credential,
deadline, 1 MiB response cap, and scope checks. `list` prints only seq,
message_id, sender, body_state, and whether a payload is present. No command
prints a body, a digest, or the credential.

`run --once` performs one bounded pass and exits. Omitting `--once` runs
continuously, sleeping `--interval-ms` between passes; `SIGINT`/`SIGTERM` abort
an in-flight request or the sleep and exit cleanly. Every event is already
durable before its cursor advance, so a stop loses no confirmed progress. `list`
is the per-consumer status view: it shows that consumer's unacknowledged
metadata events in sequence order and never prints plaintext.

`--plaintext` is a property of the spool binding, not a per-command query. It
must be passed on **every** `run` against a plaintext-bound spool; omitting it
(or adding it to a metadata-only spool) fails closed with `INBOX_CONFIG`. The
mode is never inferred from existing payload files or from a previous process.

## Failure codes

`InboxError` carries an exit code and a stable code. Messages never include a
body, digest, credential, or response text.

| Code | Exit | Meaning |
| --- | --- | --- |
| `INBOX_CONFIG` | 2 | Invalid arguments, spool binding mismatch, plaintext-mode change, unsafe/unusable configuration |
| `INBOX_UNSAFE` | 3 | Symlink, non-regular file, loose permissions, malformed identifier/state, or unknown field shape |
| `INBOX_CORRUPT` | 3 | Unparseable or internally inconsistent spool file, cursor, or acknowledgement |
| `INBOX_VERSION` | 3 | Unknown event/config/acknowledgement schema version |
| `INBOX_CROSS_PROJECT` | 3 | Event or row belongs to a different project than the spool binding |
| `INBOX_CONFLICT` | 3 | Same `(project_id, seq)`/`message_id` with different immutable content, or a digest conflict |
| `INBOX_TOO_LARGE` | 3 | Record exceeds `maxEventBytes` or the poll response cap |
| `INBOX_BACKPRESSURE` | 1 | Bounded spool is full of unacknowledged events; no event written |
| `INBOX_DISK` | 1 | Local write, fsync, rename, or disk-full failure; no complete event |
| `INBOX_OUT_OF_ORDER` | 3 | Consumer acknowledgement would skip an unacknowledged seq |
| `INBOX_NOT_FOUND` | 3 | Requested consumer/event does not exist |

Poller failures (`PollError`) keep their documented exit codes. When the queue
callback fails, the bridge surfaces the specific `InboxError` instead of the
poller's generic `PROCESS_FAILED`.

## Fail-closed validation

The bridge rejects the pass (no queue, no receipt, no cursor advance) when:

- a list row's `project_id` is not the requested project, or the sender, `seq`,
  `message_id`, `body_state`, or page cursor is malformed (reference poller);
- the body response names another message, carries a non-canonical digest, or
  the recomputed SHA-256 does not match (reference poller);
- a response exceeds the poller's streamed 1 MiB cap (reference poller);
- the body is expired and the server does not return the exact
  `410 BODY_EXPIRED` code (reference poller);
- the cursor names a different project or speaker, or is corrupt (reference
  poller);
- the spool path, a spool subdirectory, or a spool file is a symlink, is not a
  regular file/directory, or is group/world accessible;
- `spool.json` names another project or a different plaintext mode;
- an event/payload/acknowledgement has an unknown version or is malformed;
- an immutable field of an existing `(project_id, seq)` event differs on replay;
- a body digest differs from an already queued payload;
- the event or payload exceeds its size bound;
- the spool would exceed its event/byte cap with unacknowledged data.

Unknown event versions and corrupt records are never skipped, guessed, or
overwritten.

## Recovery

- A stale `tmp/` file is never treated as an event; the bridge clears `tmp/`.
- A corrupt event or acknowledgement fails closed so nothing is silently lost.
  Quarantine the file (move it out of the spool) and replay from the durable
  cursor; events that were not yet acknowledged are re-fetched from the server.
- A corrupt cursor fails closed. Restore a known cursor, or set `after_seq` to a
  value you trust; replay is safe because `mark_read` is idempotent and event
  enqueue deduplicates by `(project_id, seq)`. Do not delete the cursor to
  "reset" blindly: replay is safe but may re-fetch messages whose bodies have
  since expired, which then arrive as tombstones.
- A wrong-project or wrong-speaker cursor/spool is rejected rather than reused.

## What this does not do

- No server push, wake-up, SSE, WebSocket, lease, job queue, or scheduler.
- No automatic execution, shell, run-agent, or instruction interpretation.
- No exactly-once delivery and no distributed consumer coordination.
- No cross-project aggregation: one spool is bound to one project.
- No upload of spool content and no plaintext unless explicitly opted in.
