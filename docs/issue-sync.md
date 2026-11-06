# Durable GitHub Issue sync

One bounded, idempotent read pass over GitHub Issues and their comments, driven by
an enabled **systemd user timer**. It keeps a durable cursor and an append-only
digest so issue coordination is designed to survive Commander process/session
restarts; the recorded restart evidence is a systemd user-manager reexec, not a
literal Commander restart, so Issue #9 remains open.

## What it does and does not do

- Reads up to 50 issue records, most recently updated first, with the REST call
  `gh api "repos/<owner>/<repo>/issues?state=all&sort=updated&direction=desc&per_page=50"`.
  That 50-record window includes pull-request entries returned by the issues endpoint;
  those records are filtered out after the window is applied, so a pass may read fewer
  than 50 issues. Discovery reads a **numeric** comment count and never comment bodies;
  the REST response may include issue bodies, which the script does not read or store.
  Each issue's comments are then read via
  `gh api repos/<owner>/<repo>/issues/<n>/comments` (bounded paging).
- Appends each **new or edited** comment exactly once to
  `digest.jsonl`, keyed by `(comment databaseId, updatedAt)`.
- **Does not post, reply, or acknowledge anything.** There is no write path to
  GitHub in the sync script. The interactive Commander posts replies under its own
  audit protocol; this scheduler only makes sure comments are durably queued first.
- Treats every issue/comment body as untrusted data: bodies are stored verbatim,
  never executed, never logged, and never used to choose a command.
- Uses no network beyond `gh`, and never prints tokens, raw authorization headers,
  or the environment.

## Scheduler

There is exactly one durable OS-level scheduler for this repository:

| Field | Value |
| --- | --- |
| Kind | systemd user timer |
| Repo templates | `ops/systemd/corkboard-issue-sync.service`, `ops/systemd/corkboard-issue-sync.timer` |
| Installed units | `~/.config/systemd/user/corkboard-issue-sync.service`, `~/.config/systemd/user/corkboard-issue-sync.timer` |
| Cadence | hourly at local minute `:38` (`OnCalendar=*-*-* *:38:00`) |
| Catch-up | `Persistent=true` (a missed elapse runs once when the timer is next started) |
| Accuracy | `AccuracySec=1min` |
| Time bound | `TimeoutStartSec=15min` on the one-shot service; each `gh` invocation has a 60 s timeout |
| Enabled | `enabled` and `active`; `WantedBy=timers.target` |
| Session independence | user manager with `Linger=yes`; no interactive login or session is required |

The repository's unit templates contain absolute paths for the host that created
them (Node binary, checkout, and `HOME`); they are **not portable**. Install or copy
them only after replacing those paths for the target host.

The previous session-scoped CronCreate job (`8ef0de4e`) is **not durable** and was
cancelled by the Commander at approximately `2026-11-06T11:41Z`. This timer is the
only durable coordination scheduler. Running both would only duplicate reads, which
are harmless because ingestion is idempotent, but there must be only one durable
scheduler.

## Identity and trust boundaries

- Before any state write (including creating the state directory), the script runs
  `gh api user --jq .login` and requires the configured maintainer account
  (`CORKBOARD_ISSUE_SYNC_ACCOUNT`, default set in the unit). A mismatch exits `2`
  with no cursor/digest change.
- `gh` is invoked by absolute path (`CORKBOARD_GH_BIN`, default `/usr/bin/gh`), not
  through `PATH`.
- The cursor records the verified account and repository; a cursor from another
  account/repository, an unknown version, or malformed JSON fails closed (`4`).
- A malformed digest line fails closed (`4`) rather than skipping data.
- The state directory and the cursor, digest, log, and lock paths are `lstat`ed;
  a symbolic link anywhere in that set is rejected (`4`) before a read or write can
  follow it. The script never writes outside the state directory through a link.
- A per-state-directory lock file prevents overlapping timer/manual runs from
  double-ingesting (`5` while a live holder exists). A stale holder (dead PID) is
  reclaimed by atomically renaming the inspected lock aside and proceeding only when
  the renamed file still carries the token that was inspected; a lock that changed
  in between is restored to the lock path when that path is still free and the pass
  fails closed. In the rare three-process corner where another process has already
  created a new lock, the inspected lock stays under its `.stale-*` name instead.
  A live lock is never deleted.

## State, cursor, digest, logs

Default base: `${XDG_STATE_HOME:-$HOME/.local/state}/corkboard-issue-sync/`.
Directory mode `0700`; all files mode `0600`.

| Path | Purpose |
| --- | --- |
| `cursor.json` | version/account/repo, `lastRunAt`, per-issue `issueUpdatedAt`, `lastCommentUpdatedAt`, ingested count, `totalIngested` |
| `digest.jsonl` | append-only ingestion digest; one JSON object per line with `issue`, `commentId`, `author`, `createdAt`, `updatedAt`, `body` |
| `lock` | single-instance lock (`pid`, `startedAt`, random token) |
| `issue-sync.log` | operational log; rotates at 1 MiB to `issue-sync.log.1` (two files maximum) |

Cursor and digest writes use a temporary file, `fsync`, and an atomic `rename`. The
temporary file is removed on any failure, including a failed `write`/`fsync`, so a
failed pass cannot leave a temp file behind. The digest is the source of truth for
already-ingested keys: if the process dies after appending but before writing the
cursor, the next pass recomputes "seen" from the digest and does not duplicate the
record.

The journal also receives one line per pass (`SyslogIdentifier=corkboard-issue-sync`).
Cursor/digest state failures (unreadable or malformed state, a rejected symlink, and
write failures) are written to both `issue-sync.log` (as `status=state-error`) and
stderr; a pre-check rejection of the state directory itself is reported to stderr and
the journal only.

## Bounds and limitations

- At most 50 issues per pass, selected by GitHub's `updated_at` descending. An older
  issue outside that window is not read until GitHub changes its `updated_at`.
- At most 5 pages x 100 comments per issue. If more comments changed than that
  between passes, the pass logs `status=warning comment history truncated` and those
  older changes can be missed. Increase `MAX_COMMENT_PAGES` if that limit is ever
  approached.
- Comment edits are captured when GitHub updates `updated_at`; a silent body rewrite
  without an updated timestamp cannot be detected.
- `updated_at` has one-second resolution. Two edits of the same comment within the
  same second share the `(commentId, updatedAt)` key, so the second edit is treated
  as a duplicate and can be missed. This is a known limitation of the key.
- The digest is append-only and is not pruned. Growth is proportional to comment
  ingestion and is small at this campaign's scale.
- The scheduler ingests and queues; it does not prove the Commander read or replied.

## Failure and recovery

The service is a pure `Type=oneshot` with no auto-restart: a nonzero exit is visible
in `systemctl --user status` and the journal, and the next hourly timer elapse (or a
`Persistent=true` catch-up after downtime) retries. A success exits `0`. Exit codes
are `1` (unexpected error), `2` (auth/`gh`), `3` (payload parse), `4` (state/digest/
symlinked state path), and `5` (lock).

Manual run and inspection:

```sh
systemctl --user start corkboard-issue-sync.service
systemctl --user status corkboard-issue-sync.service
journalctl --user -u corkboard-issue-sync.service -n 20 --no-pager
tail -n 20 "$HOME/.local/state/corkboard-issue-sync/issue-sync.log"
systemctl --user list-timers --all corkboard-issue-sync.timer
```

Recovery:

- **Lock left by a dead process:** a stale holder PID is reclaimed automatically. If
  the lock is malformed, confirm no `issue-sync.ts` process is running, then
  `rm "$HOME/.local/state/corkboard-issue-sync/lock"`.
- **Corrupt/unreadable cursor:** delete `cursor.json`. The digest still determines
  what was ingested, so the next pass rebuilds the cursor without duplicates.
- **Corrupt digest:** the script fails closed by design. Restoring from backup is
  preferred; deleting the digest re-ingests all comments once (the live GitHub
  history is the source), which is safe but loses the prior dedupe history.
- **Symlinked state path:** replace the link with a real directory/file inside the
  state directory. The pass refuses to follow it.
- **Start-rate limit after many manual starts:** `systemctl --user reset-failed
  corkboard-issue-sync.service`, then start again.

## Verification performed (2026-11-06)

- `systemd-analyze --user verify` passes on both units; the installed units are
  byte-identical to `ops/systemd/` after reinstall.
- `list-timers` shows the timer `active`/`enabled`, `Persistent=yes`, and next
  elapse `2026-11-06 04:38:00 PST`.
- **Manual probe runs:** during setup the service was started manually, not by the
  timer. A synthetic comment (`commentId 6683115223`,
  `updatedAt 2026-11-06T10:50:46Z`) was posted on Issue #9; the first manual start
  ingested `1` new record and a later manual start ingested `0` with `19`
  duplicates. `digest.jsonl` contains the probe exactly once.
- **Autonomous timer run:** the timer fired at `LastTrigger=2026-11-06 03:38:00 PST`
  and the one-shot service completed at `03:38:54 PST` with `Result=success` and
  `ExecMainStatus=0`. The pass logged `ingested=0 duplicates=19 total=19` (the probe
  was already ingested by the manual runs), and `digest.jsonl` still contains the
  probe exactly once. The next elapse was `04:38:00 PST`.
- **`daemon-reexec` meaning:** `systemctl --user daemon-reexec` re-executes the
  **systemd user manager** only. It is not a Commander restart and does not test
  Commander process/session recovery. After the reexec the timer remained
  `active`/`enabled` with `Persistent=yes`, and one additional manual service run
  again ingested `0` with the probe still appearing exactly once.
- The scheduler only reads and queues comments; it never posts replies.
