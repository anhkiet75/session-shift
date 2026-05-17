#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/extension.zip"

bash "$ROOT/scripts/build.sh"
rm -f "$OUT"
(cd "$ROOT/dist" && zip -r "$OUT" .)

echo "Created: $OUT"
