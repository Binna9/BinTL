#!/usr/bin/env bash
# Deploy: bintl / config.toml / bin/ / ctl.sh 를 같은 폴더에 둡니다.
#   ./ctl.sh start
#   ./ctl.sh logs -f
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT/bin/bintl.sh" "$@"
