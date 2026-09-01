#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

bintl_ensure_layout

echo "log file: $BINTL_LOGFILE"

if [[ ! -f "$BINTL_LOGFILE" ]]; then
  echo "no log yet — run: ./start.sh  or  ../ctl.sh start"
  exit 0
fi

if [[ "${1:-}" == "-f" ]]; then
  tail -f "$BINTL_LOGFILE"
else
  lines="${1:-50}"
  tail -n "$lines" "$BINTL_LOGFILE"
fi
