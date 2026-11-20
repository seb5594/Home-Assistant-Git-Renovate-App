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

# The app starts as its unprivileged user in a data folder that belongs to root, like /data in Home Assistant.
app_user_can_create_its_database() {
  local dir status=0
  dir="$(mktemp -d)"
  chmod 755 "$dir"
  /usr/lib/renovate-app/prepare-data.sh "$dir" renovate "${dir}/work"
  s6-setuidgid renovate env DATA_DIR="$dir" node --disable-warning=ExperimentalWarning --input-type=module -e "
    import { paths } from '${APP_ROOT}/server/paths.mjs';
    import { openDatabase } from '${APP_ROOT}/server/db/database.mjs';
    import { loadOrCreateKey } from '${APP_ROOT}/server/security/crypto.mjs';
    loadOrCreateKey(paths.keyFile);
    openDatabase(paths.database, paths.migrations).close();
  " || status=$?
  rm -rf -- "$dir"
  return "$status"
}

# The shipped files.
check 'the unprivileged user can create the database in a root-owned data folder' app_user_can_create_its_database
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
