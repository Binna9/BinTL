#!/usr/bin/env bash
set -euo pipefail

TARGET="${1:?usage: build-target.sh <target>}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG="bintl"
BIN="bintl"
if [[ "$TARGET" == *windows* ]]; then
  BIN="bintl.exe"
fi

cd "$ROOT"
bash scripts/build-ui.sh

if command -v cross >/dev/null 2>&1; then
  cross build --release --target "$TARGET" -p "$PKG"
else
  rustup target add "$TARGET"
  cargo build --release --target "$TARGET" -p "$PKG"
fi

mkdir -p "$ROOT/dist/$TARGET"
cp "$ROOT/target/$TARGET/release/$BIN" "$ROOT/dist/$TARGET/$BIN"
echo "wrote dist/$TARGET/$BIN"
