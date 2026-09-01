#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "root:   $BINTL_ROOT"
echo "bin:    $BINTL_BIN"
echo "config: $BINTL_CONFIG"
echo "log:    $BINTL_LOGFILE"

if bintl_is_running; then
  pid="$(bintl_pid)"
  echo "status: running (pid $pid)"
  echo "logs:   ./logs.sh -f   or   ../ctl.sh logs -f"
  if command -v curl >/dev/null 2>&1 && [[ -f "$BINTL_CONFIG" ]]; then
    bind="$(grep -E '^[[:space:]]*bind[[:space:]]*=' "$BINTL_CONFIG" | head -1 | sed -E 's/^[[:space:]]*bind[[:space:]]*=[[:space:]]*"([^"]+)".*/\1/')"
    if [[ -n "$bind" ]]; then
      url="http://${bind/0.0.0.0/127.0.0.1}/api/health"
      echo "health: $(curl -fsS "$url" 2>/dev/null || echo "(curl failed — port/firewall?)")"
    fi
  fi
else
  echo "status: stopped"
  rm -f "$BINTL_PIDFILE"
  echo "start:  ./start.sh   or   ../ctl.sh start"
fi
