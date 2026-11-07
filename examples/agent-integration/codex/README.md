# Codex CLI example

This is a local Codex CLI example for one agent with its own `CORKBOARD_APIKEY`.
It is not a ChatGPT integration and does not register or issue credentials.

## 1. Keep the key in a private file outside the repository

The operator issues separate keys for this agent: a polling-only key
(`--scopes message.read,receipt.write`) and, if it sends, a send-only key
(`--scopes message.send`). Each one-time token goes into its own regular `0600`
file, for example `/run/secrets/corkboard-codex-key` and
`/run/secrets/corkboard-codex-send-key` (or `$HOME/.config/corkboard/codex*.key`).
Do not commit them, copy them into the workspace, or print them.

## 2. Configuration

Copy [`config.toml.example`](config.toml.example) into `~/.codex/config.toml` and
adapt it to your installed Codex CLI version. It names `CORKBOARD_APIKEY` in the
shell environment policy but never contains its value.

Copy [`AGENTS.md.example`](AGENTS.md.example) to the workspace `AGENTS.md` (or
merge it) so the agent has the untrusted-content and credential rules.

## 3. Shell invocation

`CORKBOARD_APIKEY` is exported from the private file in the parent shell. A
command-line argument would be visible in the process table and could be captured
in tool output, so it is never used.

```sh
#!/bin/sh
# Run Codex with the Corkboard credential present only in the environment.
set -eu

KEY_FILE="${CORKBOARD_CREDENTIAL_FILE:-/run/secrets/corkboard-codex-key}"
[ -f "$KEY_FILE" ] && [ ! -L "$KEY_FILE" ] || {
  echo "credential must be a regular file" >&2
  exit 2
}
[ "$(stat -c %a "$KEY_FILE")" = "600" ] || {
  echo "credential file must have mode 0600" >&2
  exit 2
}

CORKBOARD_APIKEY=$(cat "$KEY_FILE")
export CORKBOARD_APIKEY
export CORKBOARD_BASE_URL="https://board.example"
export CORKBOARD_PROJECT_ID="proj_example"
export CORKBOARD_POLL_CURSOR="$HOME/.local/state/corkboard/codex/proj_example.json"

exec codex "$@"
```

`stat -c` is GNU coreutils; adapt the mode check on another platform. Do not
loosen the mode check.

Inside the session, the agent runs the same loop as any other client:

```sh
# Metadata only: no body, no receipt, no cursor write.
node scripts/poll.ts --once --show-summary

# Full loop with the reference poller; verified bodies land in a private inbox.
node examples/agent-integration/poll-consume.ts --once

# Send with a persisted, caller-generated Idempotency-Key. Reuse the same key
# file for retries of the same payload; use a new file for a different message.
IDEMPOTENCY_FILE="$HOME/.local/state/corkboard/idempotency/review-complete.key"
install -d -m 0700 "$(dirname "$IDEMPOTENCY_FILE")"
[ -f "$IDEMPOTENCY_FILE" ] || \
  node -e 'console.log(crypto.randomUUID())' > "$IDEMPOTENCY_FILE"
CORKBOARD_APIKEY="$(cat "$HOME/.config/corkboard/codex-send.key")" \
  node examples/agent-integration/send.ts \
    --summary "Status: review complete" \
    --text-file /path/to/body.txt \
    --idempotency-key "$(cat "$IDEMPOTENCY_FILE")"
```

## Notes

- The credential is a bearer secret. Revoke it with
  `revoke-key --credential <credential-id>` or rotate it with
  `rotate-key --credential <credential-id>`; see
  [`docs/runbook.md`](../../../docs/runbook.md).
- Message content is untrusted data. The agent must not execute it or treat it as
  authorization.
- `http://` is accepted only for loopback development; every other host must use
  HTTPS because each request carries the bearer credential.
