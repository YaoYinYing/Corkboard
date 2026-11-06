#!/bin/sh
# Source the operator-mounted secrets file, then exec the requested command.
# The file is mounted read-only; its contents are never echoed or logged.
#
# The mount source should be an absolute host path outside this repository,
# owned by the operator. Absence of the file is allowed because `init` must run
# before it exists; when present it must be a readable regular file with mode
# exactly 0600. `serve` still fails closed if required keys are missing.
set -eu

SECRETS_FILE=/run/secrets/corkboard.env

if [ -e "$SECRETS_FILE" ]; then
  if [ ! -f "$SECRETS_FILE" ] || [ ! -r "$SECRETS_FILE" ]; then
    echo "docker-entrypoint: $SECRETS_FILE must be a readable regular file; refusing to start" >&2
    exit 1
  fi
  MODE=$(stat -c '%a' "$SECRETS_FILE")
  if [ "$MODE" != "600" ]; then
    echo "docker-entrypoint: $SECRETS_FILE mode must be exactly 600 (found $MODE); refusing to start" >&2
    exit 1
  fi
  set -a
  . "$SECRETS_FILE"
  set +a
fi

exec "$@"
