#!/usr/bin/env bash
set -euo pipefail
# Foreground run (Ctrl+C to stop). Logs go to terminal.
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

bintl_ensure_layout
bintl_require_bin
bintl_require_config

if bintl_is_running; then
  echo "already running in background (pid $(bintl_pid)). stop first: bin/stop.sh" >&2
  exit 1
fi

cd "$BINTL_ROOT"
echo "foreground — RUST_LOG=$BINTL_RUST_LOG"
echo "config: $BINTL_CONFIG"
exec env RUST_LOG="$BINTL_RUST_LOG" "$BINTL_BIN" --config "$BINTL_CONFIG"
