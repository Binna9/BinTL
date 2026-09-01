#!/usr/bin/env bash
set -euo pipefail
DIR="$(dirname "${BASH_SOURCE[0]}")"
"$DIR/stop.sh"
"$DIR/start.sh"
