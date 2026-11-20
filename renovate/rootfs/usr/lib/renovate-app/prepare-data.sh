#!/usr/bin/env bash
# Creates the folders the app writes to and gives them to the unprivileged app user.
#
#   prepare-data.sh [DATA_DIR] [USER] [WORK_DIR]
#
# The data folder itself stays with root (the Supervisor keeps options.json there), so everything the app
# writes lives in sub folders: SQLite needs a writable folder, not only a writable file, because it creates
# its journal files next to the database.
set -Eeuo pipefail

data="${1:-/data}"
user="${2:-renovate}"
work="${3:-/tmp/renovate-work}"

mkdir -p "${data}/home" "${data}/db" "${data}/runs" "${data}/cache" "${data}/keys" "$work"
# Files from a restore may belong to someone else. The options stay with the Supervisor.
find "$data" -mindepth 1 -not -name options.json ! -user "$user" -exec chown "${user}:${user}" {} +
chown "${user}:${user}" "$work"
