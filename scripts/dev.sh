#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/src"
DIST="$ROOT/dist"

rm -rf "$DIST"
mkdir -p "$DIST/options" "$DIST/popup"

cp "$SRC/manifest.json" "$DIST/"
cp -r "$SRC/icons" "$DIST/"
cp "$SRC"/options/options.html "$SRC"/options/options.css "$DIST/options/"
cp "$SRC"/popup/popup.html "$SRC"/popup/popup.css "$DIST/popup/"
cp -r "$SRC/popup/fonts" "$DIST/popup/"

echo "Watching for changes..."

node "$ROOT/scripts/dev-watch-static.mjs" &
STATIC_PID=$!

trap 'kill $STATIC_PID 2>/dev/null' EXIT INT TERM

npx esbuild \
  "$SRC"/background/*.ts "$SRC"/lib/*.ts \
  "$SRC"/content.ts "$SRC"/page-api-proxy.ts \
  "$SRC"/options/options.ts "$SRC"/popup/*.ts \
  --bundle=false --format=esm --platform=browser \
  --outbase="$SRC" --outdir="$DIST" \
  --watch
