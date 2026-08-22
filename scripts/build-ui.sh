#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT/ui"
if [[ ! -d node_modules ]]; then
  npm install
fi
npm run build
