#!/bin/sh
# Source the operator-mounted secrets file, then exec the requested command.
# The file is mounted read-only; its contents are never echoed or logged.
set -eu

if [ -f /run/secrets/corkboard.env ]; then
  set -a
  . /run/secrets/corkboard.env
  set +a
fi

exec "$@"
