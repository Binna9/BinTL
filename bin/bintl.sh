#!/usr/bin/env bash
set -euo pipefail
#   cd bin && ./bintl.sh start
#   cd exe_binTL && ./ctl.sh logs -f

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -eq 0 ]]; then
  exec "$DIR/status.sh"
fi

cmd="$1"
case "$cmd" in
  start)   exec "$DIR/start.sh" ;;
  stop)    exec "$DIR/stop.sh" ;;
  restart) exec "$DIR/restart.sh" ;;
  status)  exec "$DIR/status.sh" ;;
  logs)
    shift
    exec "$DIR/logs.sh" "$@"
    ;;
  run)     exec "$DIR/run.sh" ;;
  help|-h|--help)
    cat <<EOF
Usage:
  bintl.sh [command]

  start     백그라운드 + data/logs/bintl.log
  stop
  restart
  status    (인자 없을 때 기본)
  logs      마지막 50줄
  logs -f   실시간
  run       포그라운드

  cd bin && ./start.sh     ← 개별 스크립트도 동일
  cd ..   && ./ctl.sh start

  RUST_LOG=debug bintl.sh start
EOF
    ;;
  *)
    echo "unknown command: $cmd (try: bintl.sh help)" >&2
    exit 1
    ;;
esac
