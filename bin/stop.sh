#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if ! bintl_is_running; then
  rm -f "$BINTL_PIDFILE"
  echo "not running"
  exit 0
fi

pid="$(bintl_pid)"
echo "stopping pid $pid"
kill "$pid" 2>/dev/null || true

for _ in $(seq 1 20); do
  if ! kill -0 "$pid" 2>/dev/null; then
    rm -f "$BINTL_PIDFILE"
    echo "stopped"
    exit 0
  fi
  sleep 0.5
done

echo "force kill pid $pid"
kill -9 "$pid" 2>/dev/null || true
rm -f "$BINTL_PIDFILE"
echo "stopped"
