#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST/options" "$DIST/popup"

cp "$SRC/manifest.json" "$DIST/"
cp -r "$SRC/icons" "$DIST/"
cp -r "$SRC/_locales" "$DIST/"
cp "$SRC"/options/options.html "$SRC"/options/options.css "$DIST/options/"
cp "$SRC"/popup/popup.html "$SRC"/popup/popup.css "$DIST/popup/"
cp -r "$SRC/popup/fonts" "$DIST/popup/"

echo "Watching for changes..."

npx --no-install tsx "$ROOT/scripts/dev-watch-static.ts" &
STATIC_PID=$!

trap 'kill $STATIC_PID 2>/dev/null' EXIT INT TERM

npx --no-install tsx "$ROOT/scripts/dev-esbuild.ts"
