#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

bintl_ensure_layout
bintl_require_bin
bintl_require_config

if bintl_is_running; then
  echo "already running (pid $(bintl_pid))"
  exit 0
fi

cd "$BINTL_ROOT"
nohup env RUST_LOG="$BINTL_RUST_LOG" "$BINTL_BIN" --config "$BINTL_CONFIG" >>"$BINTL_LOGFILE" 2>&1 &
echo $! >"$BINTL_PIDFILE"

echo "started pid $(cat "$BINTL_PIDFILE")"
echo "log: $BINTL_LOGFILE"
echo "tail: $BINTL_ROOT/bin/logs.sh"
