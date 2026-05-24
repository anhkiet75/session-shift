#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(grep '"version"' "$ROOT/src/manifest.json" | sed 's/.*"version": *"\([^"]*\)".*/\1/')"
OUT="$ROOT/releases/session_shift_v${VERSION}.zip"

bash "$ROOT/scripts/build.sh"
rm -f "$OUT"
(cd "$ROOT/dist" && zip -r "$OUT" .)

echo "Created: $OUT"
