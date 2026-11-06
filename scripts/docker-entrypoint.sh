#!/bin/sh
# Source the operator-mounted secrets file, then exec the requested command.
# The file is mounted read-only; its contents are never echoed or logged.
#
# The mount source must be an absolute host path outside this repository, owned
# by the operator, containing a regular corkboard.env with mode exactly 0600
# that the container UID can read. Startup fails closed otherwise.
set -eu

SECRETS_FILE=/run/secrets/corkboard.env

if [ -e "$SECRETS_FILE" ]; then
  if [ ! -f "$SECRETS_FILE" ] || [ ! -r "$SECRETS_FILE" ]; then
    echo "docker-entrypoint: secrets file must be a readable regular file; refusing to start" >&2
    exit 1
  fi
  MODE=$(stat -c '%a' "$SECRETS_FILE")
  if [ "$MODE" != "600" ]; then
    echo "docker-entrypoint: secrets file mode must be exactly 600 (found $MODE); refusing to start" >&2
    exit 1
  fi
  set -a
  . "$SECRETS_FILE"
  set +a
fi

exec "$@"
