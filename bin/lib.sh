#!/usr/bin/env bash
# Shared paths — cwd 와 무관하게 bin/ 기준으로 exe_binTL 루트를 찾습니다.
# Layout: <root>/bintl, config.toml, data/, bin/*.sh

_BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BINTL_ROOT="$(cd "$_BIN_DIR/.." && pwd)"
BINTL_BIN="${BINTL_BIN:-$BINTL_ROOT/bintl}"
BINTL_CONFIG="${BINTL_CONFIG:-$BINTL_ROOT/config.toml}"
BINTL_PIDFILE="${BINTL_PIDFILE:-$BINTL_ROOT/data/bintl.pid}"
BINTL_LOGFILE="${BINTL_LOGFILE:-$BINTL_ROOT/data/logs/bintl.log}"
BINTL_RUST_LOG="${RUST_LOG:-info}"

bintl_ensure_layout() {
  mkdir -p "$BINTL_ROOT/data/logs"
}

bintl_is_running() {
  [[ -f "$BINTL_PIDFILE" ]] || return 1
  local pid
  pid="$(cat "$BINTL_PIDFILE" 2>/dev/null)" || return 1
  [[ -n "$pid" ]] || return 1
  kill -0 "$pid" 2>/dev/null
}

bintl_pid() {
  if bintl_is_running; then
    cat "$BINTL_PIDFILE"
  fi
}

bintl_require_bin() {
  if [[ ! -x "$BINTL_BIN" ]]; then
    echo "executable not found: $BINTL_BIN" >&2
    exit 1
  fi
}

bintl_require_config() {
  if [[ ! -f "$BINTL_CONFIG" ]]; then
    echo "config not found: $BINTL_CONFIG" >&2
    exit 1
  fi
}
