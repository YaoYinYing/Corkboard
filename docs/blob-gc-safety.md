# Local blob GC safety

Status: implemented for the Node.js/SQLite deployment. Remote R2 blob deletion stays
out of scope (there is no remote GC command).

This note defines why `gc-blobs --apply` cannot delete a blob that a live message send
can still commit, and which failures remain possible.

## Scope and definitions

- `gc-blobs` scans `<data-dir>/blobs` directly. It only considers regular files whose
  names are valid opaque blob keys (never symlinks, directories, special files, or
  invalid names), whose `mtime` is at least the grace period old, and whose key appears
  in no `body_objects.storage_key` row in **any** state.
- A key is **referenced** while any `body_objects` row holds it. Rows are never deleted
  by shipped code; expiry clears `storage_key` in place after deleting the ciphertext.
  The referenced set is therefore not monotonic: expiry can remove a key between reads.
- A **live send** is a `sendMessage` call that has not yet returned or permanently
  failed.

## Safety invariant

**Reference before write.** For every local blob written by a message send, the
`body_objects` row containing that blob's random `storage_key` is durably committed to
the database before `BlobStore.put` creates the file.

`sendMessage`/`commitBody` performs, in order:

1. seal the plaintext in memory;
2. `INSERT INTO body_objects` with the fresh random storage key (this is the reference);
3. `BlobStore.put` (this creates the file);
4. insert the provisional `pending` message;
5. finalize the message to `ready` in one conditional `UPDATE`.

The previous order was put-then-insert. The reordering is the whole fix: a send can no
longer own a file that has no reference row.

### Alternatives considered

- **Write lease/marker table with a reclaim handshake.** Would add a new table, lease
  expiry and crash-recovery rules, and a reclaim protocol, plus migration and D1
  portability work. The `body_objects` row is already the durable marker and is already
  consulted by GC, so the extra protocol adds failure modes without adding safety.
- **Enforced writer fence / offline-only destructive GC.** Would require a cross-process
  exclusive lock that the server respects before accepting writes, or stopping the
  service for every GC run. This restricts operations more than the invariant requires.
- **Reference before write.** One ordering change in `commitBody`, one extra reference
  read before deletion, and the existing reference set. Chosen.

`body_objects.state` is not a read or publication gate — the publication gate is the
message's `pending` → `ready` transition. The row therefore keeps its existing
`state = 'ready'` value at insert; no new state transition is needed. A dangling row in
any state is never readable and is retained by GC.

## Proof

`gc-blobs --apply` does two reference reads: R0 once before enumerating candidates, and
R1 again immediately before the unlink loop (apply mode only). Between the reads a
reference can only be added by a reference-before-write send; expiry can clear a key
after deleting its ciphertext, so the set is not monotonic. That clearing cannot expose
a live send: its row precedes its file, and expiry only clears keys whose ciphertext is
already gone. R1 can therefore only remove candidates relative to R0, never add them.

Let file `F` with key `K` be observed by the scan (so `F` existed before the scan
finished) and selected as a target. Suppose a live send created or overwrote `F`:

- By the invariant, its `body_objects` row for `K` was committed before
  `F` was created/modified.
- `F` existed at scan time, and R1 runs after the scan, so the row was committed before
  R1 as well.
- R1 therefore contains `K`, and `F` is removed from the target set before any unlink.

The proof does not depend on the grace period or on filesystem clock agreement for live
sends. Grace remains a conservative retention bound for abandoned files and an extra
margin against code paths that predate this invariant. R0 remains the candidate filter
and the dry-run report; R1 is the deletion-time fence.

Residual assumption: storage keys are 128-bit random values from `crypto.getRandomValues`
and are never reused. Even a collision is not normally harmful because the colliding
send's row insert precedes its own write; only a collision against a file already
selected between R1 and unlink could overwrite that file before GC unlinks it. That
requires a 128-bit collision and is accepted.

## Race and crash analysis

### The former put → reference gap

Under the old order a file could exist with no row for as long as the process stalled
between `put` and `INSERT`. No grace value bounds that stall. Under the new order the
window is reversed: a row can exist without a file, which is harmless (no file means
nothing to collect; no message exists yet, so nothing can read it).

### A send paused longer than the grace period

- Paused before step 2: no row and no file. GC has nothing to select.
- Paused between steps 2 and 3 (row committed, no file yet): GC cannot delete a file
  that does not exist. When the send resumes it writes a new file, and R0/R1 see its
  reference.
- Paused between steps 3 and 4 (file written, message not inserted): the reference row
  exists, so every GC run retains the file.
- Paused between steps 4 and 5 (pending message): the message and reference exist; GC
  retains the file. A resume verifies the DB-recorded ciphertext digest before
  publishing.
- Paused after step 5: the message is `ready` and the reference exists; GC retains the
  file.

### GC scan versus a resumed write

A file created after the scan cannot be in the target list. A file created before R1 has
its reference committed before it was created, hence before R1, so R1 catches it. A file
created after R1 is not unlinked. The unlink loop acts only on names selected from the
scan.

### Process crash at each boundary

- Before step 2: no database or filesystem residue. A same-key retry commits normally.
- After step 2, before step 3: a `body_objects` row with no file and no message. It is
  never readable and never published, and GC has no file to select. A retry creates a
  new object. `doctor` and `backup`/`verify`/`restore` ignore this unreachable row for
  fatal missing-body checks; it is a crash artifact, not a published message with lost
  ciphertext.
- After step 3, before step 4: ciphertext and reference, no message. No reader can reach
  it; GC retains it conservatively because a stale row still counts as a reference. A
  retry creates a second object; the first is retained metadata.
- After step 4, before step 5: `pending` message plus reference plus file. It is not
  visible in message listings. GC retains the file. A same-key retry verifies the blob
  against the DB digest and either publishes or fails closed; a missing or corrupt blob
  leaves it pending and reclaimable, never `ready`.
- After step 5: `ready` message plus reference plus file. GC retains the file.
- Expiry: the message becomes `expired` first, then `deleteExpiredBodyBlob` deletes the
  ciphertext, then clears `storage_key`. A crash after the delete but before the clear
  leaves a row pointing at a missing file (GC deletes nothing); the cleanup worker
  retries and clears the key. A crash after the clear leaves no reference and no file.
  Neither state is a live send.

### Failed write or interrupted scan

- A failed `BlobStore.put` leaves the reference row but no file and no message. It never
  leaves a `ready` message with missing ciphertext. The dangling row is retained by GC
  (it references a key); conservative retention, not data loss.
- GC performs no deletion until directory enumeration, both reference reads, and target
  selection have completed. If the directory is unreadable, an entry cannot be
  `lstat`ed, or either reference read fails, the command throws before the unlink loop
  and deletes nothing. A failure inside the unlink loop is counted per file; successful
  unlinks are not rolled back.

### Expiry versus GC

Expiry clears the key only after the blob delete. GC can therefore only miss a key that
expiry is concurrently retiring, i.e. an `expired` message whose ciphertext is being
removed. A live send's key is never cleared.

Backup/verify use the same reachability rule: they require only non-null
`body_objects.storage_key` values reachable through `messages.body_object_id`. Expiry
does **not** clear `messages.body_object_id`; it clears `storage_key`, so an expired
tombstone is excluded because it has no key, not because its link disappeared. A crash
between the blob delete and the key clear leaves a key that is still required but whose
file is gone; backup then fails closed rather than claiming a recoverable pair. An
out-of-band link clear with a surviving key makes the key unreachable metadata: its file
is still copied as an unreferenced blob, but it is not required for restoring a readable
message.

## What is and is not guaranteed

Guaranteed for the local store on this build:

- No GC run deletes a blob belonging to a live send, including a send paused longer
  than the grace period (subject to the 128-bit key-reuse assumption above).
- A crash cannot produce a `ready` message whose ciphertext GC deleted.
- A failed `put` cannot publish a message.
- Interrupted or failed scans delete nothing before selection; path/symlink protections
  and the per-file failure accounting are unchanged.

Not guaranteed:

- Against ciphertext loss outside GC: manual deletion, a mismatched backup/restore,
  filesystem corruption, a blob write the filesystem did not durably persist across a
  power loss (`LocalBlobStore` does not `fsync`), or a remote/R2 store. This is a
  pre-existing storage-durability limit, not the GC race.
- That abandoned files are deleted immediately; grace and `--limit` are conservative.
- Transactional deletion: a run that fails partway leaves earlier unlinks in place and
  reports them.
- Cleanup of dangling `body_objects` rows (row-without-file); there is no row GC. Such
  a row is retained by GC and excluded from fatal missing-body checks: `backup`,
  `verify`, `restore`, and `doctor` require only keys reachable through
  `messages.body_object_id`. It still contributes to the full `referenced` count and is
  never restorable content.
- Protection from an operator running an older binary that still writes before
  referencing. The old prohibition applies to such binaries.

## Operator guidance

`gc-blobs` stays dry-run by default and `--apply` stays explicit. Run `--apply`
concurrently with writes only after confirming the running server was built with
reference-before-write and its `gc-blobs` command includes the pre-delete re-read. On such a build the in-flight-send deletion race is
eliminated by reference-before-write plus the re-read, not by the grace value. Keep
scheduling it after backups, and prefer a quiet period because deletion is not
transactional and per-run counts are easier to reason about. Do not run `gc-blobs
--apply` against a data directory that `restore` is concurrently replacing.

The **deployed preview runs the older image `18e4eb0`**, which predates this fix and
still writes before referencing. Keep the preview offline-only for destructive GC
(never `--apply` while it accepts writes) until the rebuilt image is deployed. Any image
rollback reinstates the old rule.
