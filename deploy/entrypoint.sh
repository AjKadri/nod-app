#!/bin/sh
# A freshly mounted volume belongs to root. Hand it to the unprivileged user, then drop privileges.
set -e
state_dir="$(dirname "${RELAY_STATE_FILE:-/data/relay-state.json}")"
mkdir -p "$state_dir"
chown -R node:node "$state_dir"
exec su-exec node "$@"
