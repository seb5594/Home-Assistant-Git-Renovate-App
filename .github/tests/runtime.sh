#!/usr/bin/env bash
set -Eeuo pipefail

# Runs inside the built image. The unit tests of the application run against the files that ship in the
# image, with the Node.js and Renovate that were installed there, so the checks below prove the real thing.
# The test folder is mounted at /tests by the pipeline.

export APP_ROOT=/opt/renovate-app
export RENOVATE_BIN=/opt/renovate/node_modules/renovate/dist/renovate.js

check() {
  local description="$1"
  shift
  if "$@"; then
    echo "PASS: ${description}"
  else
    echo "FAIL: ${description}" >&2
    exit 1
  fi
}

node_is_24() { node --version | grep -q '^v24\.'; }
renovate_reports_version() { RENOVATE_X_IGNORE_RE2=true node "$RENOVATE_BIN" --version | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# The runtime and the tools Renovate shells out to.
check 'Node.js 24 is installed' node_is_24
check 'Git is installed' git --version
check 'npm is installed' npm --version
check 'Node.js has the built-in SQLite driver' node --disable-warning=ExperimentalWarning -e 'require("node:sqlite")'

# Renovate itself starts.
check 'Renovate starts and reports its version' renovate_reports_version
check 'Renovate is the only copy: no regular expression engine to compile' test ! -e /opt/renovate/node_modules/re2

# The server keeps the privileges of the container (Home Assistant's options.json is readable for root only)
# and starts Renovate as the unprivileged user. That user must be able to write what Renovate needs.
renovate_user_can_write_its_folders() {
  local dir status=0
  dir="$(mktemp -d)"
  chmod 755 "$dir"
  /usr/lib/renovate-app/prepare-data.sh "$dir" renovate "${dir}/work"
  s6-setuidgid renovate sh -c "touch '${dir}/cache/probe' '${dir}/work/probe' '${dir}/home/probe'" || status=$?
  rm -rf -- "$dir"
  return "$status"
}

# A root-only options.json, as the Supervisor writes it, can be read by the server and parsed.
server_reads_a_root_only_options_file() {
  local dir status=0
  dir="$(mktemp -d)"
  chmod 755 "$dir"
  printf '{"schedule":{"cron":"1 2 * * *"}}' >"${dir}/options.json"
  chmod 600 "${dir}/options.json"
  DATA_DIR="$dir" node --disable-warning=ExperimentalWarning --input-type=module -e "
    import { readFileSync } from 'node:fs';
    const options = JSON.parse(readFileSync('${dir}/options.json', 'utf8'));
    if (options.schedule.cron !== '1 2 * * *') process.exit(1);
  " || status=$?
  rm -rf -- "$dir"
  return "$status"
}

# The shipped files.
check 'the unprivileged user can write the folders Renovate needs' renovate_user_can_write_its_folders
check 'the server reads an options file that only root may read' server_reads_a_root_only_options_file
check 'the app version file exists' test -s /etc/renovate-app/version
check 'the web interface is part of the image' test -s "${APP_ROOT}/ui/index.html"
check 'the unprivileged user exists' id renovate
check 'the licenses are in the image' test -s /usr/share/licenses/renovate-app/renovate-AGPL-3.0.txt

# The unit tests, with each passing test reported as a PASS line for the pipeline's counter.
if [[ -d /tests/unit ]]; then
  report="$(mktemp)"
  trap 'rm -f -- "$report"' EXIT
  if ! node --disable-warning=ExperimentalWarning --test --test-reporter=tap '/tests/unit/*.test.mjs' >"$report" 2>&1; then
    cat "$report" >&2
    echo 'FAIL: unit tests' >&2
    exit 1
  fi
  sed -n 's/^ok [0-9]* - /PASS: /p' "$report"
fi
