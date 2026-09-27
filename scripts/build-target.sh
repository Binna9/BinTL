#!/usr/bin/env bash
set -euo pipefail

# gnu 바이너리는 libodbc.so.2를 NEEDED로 가진다. 서버에 unixodbc를 깔지 않게
# 최상위 vendor/odbc/에 두고, DT_RPATH($ORIGIN/vendor/odbc)로 실행 파일 옆 vendor를 본다.
# DT_RUNPATH는 전이 의존(libltdl)과 dlopen(libodbcinst)에 안 먹어서 --force-rpath.
bundle_unixodbc() {
  local root="$1" target="$2" bin="$3"
  [[ "$target" == *linux-gnu* ]] || return 0
  [[ -f "$bin" ]] || return 0
  if ! objdump -p "$bin" | grep -q 'NEEDED[[:space:]]*libodbc.so.2'; then
    return 0
  fi

  local dest="$root/vendor/odbc"
  mkdir -p "$dest"
  local platform=linux/amd64
  case "$target" in
    aarch64-*) platform=linux/arm64 ;;
  esac

  local image=""
  if command -v docker >/dev/null 2>&1; then
    image="$(docker images --format '{{.CreatedAt}}	{{.Repository}}:{{.Tag}}' \
      | grep "cross-custom-.*${target}" | sort -r | head -1 | awk -F'	' '{print $2}')"
  fi

  if [[ -n "$image" ]]; then
    docker run --rm -i --platform "$platform" --entrypoint bash \
      -v "$dest:/out" -v "$root/dist/$target:/work" "$image" -s <<EOF
set -euo pipefail
if ! command -v patchelf >/dev/null 2>&1; then
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends patchelf
fi
find /usr/lib /lib -maxdepth 4 \( \
  -name 'libodbc.so.2' -o -name 'libodbc.so.2.*' \
  -o -name 'libodbcinst.so.2' -o -name 'libodbcinst.so.2.*' \
  -o -name 'libltdl.so.7' -o -name 'libltdl.so.7.*' \
\) -print | sort -u | while read -r f; do
  cp -a "\$f" /out/
done
for so in /out/*; do
  [ -L "\$so" ] && continue
  [ -f "\$so" ] || continue
  patchelf --set-rpath '\$ORIGIN' --force-rpath "\$so"
done
patchelf --set-rpath '\$ORIGIN/vendor/odbc' --force-rpath /work/$(basename "$bin")
EOF
  else
    local -a files=()
    shopt -s nullglob
    files=(
      /usr/lib/*/libodbc.so.2 /usr/lib/*/libodbc.so.2.*
      /usr/lib/*/libodbcinst.so.2 /usr/lib/*/libodbcinst.so.2.*
      /lib/*/libltdl.so.7 /lib/*/libltdl.so.7.*
    )
    shopt -u nullglob
    if [[ ${#files[@]} -eq 0 ]]; then
      echo "unixodbc bundle failed: no cross image and no host libodbc" >&2
      exit 1
    fi
    cp -a "${files[@]}" "$dest/"
    if ! command -v patchelf >/dev/null 2>&1; then
      echo "unixodbc bundle failed: patchelf not found" >&2
      exit 1
    fi
    local so
    for so in "$dest"/*; do
      [[ -L "$so" ]] && continue
      [[ -f "$so" ]] || continue
      patchelf --set-rpath '$ORIGIN' --force-rpath "$so"
    done
    patchelf --set-rpath '$ORIGIN/vendor/odbc' --force-rpath "$bin"
  fi

  if ! objdump -p "$bin" | grep -q 'RPATH.*\$ORIGIN/vendor/odbc'; then
    echo "unixodbc bundle failed: RPATH not set on $bin" >&2
    exit 1
  fi
  echo "bundled unixodbc -> vendor/odbc"
}

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
bundle_unixodbc "$ROOT" "$TARGET" "$ROOT/dist/$TARGET/$BIN"
if [[ -d "$ROOT/vendor" ]]; then
  mkdir -p "$ROOT/dist/$TARGET/vendor"
  cp -R "$ROOT/vendor/." "$ROOT/dist/$TARGET/vendor/"
fi
echo "wrote dist/$TARGET/$BIN"
