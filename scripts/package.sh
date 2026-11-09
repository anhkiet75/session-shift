#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(npx --no-install tsx "$ROOT/scripts/release-version.ts")"
OUT="$ROOT/releases/session_shift_v${VERSION}.zip"

if [[ "${CRX_REQUIRE_KEY:-0}" == "1" ]]; then
  npx --no-install tsx "$ROOT/scripts/validate-release.ts" "${GITHUB_REF_NAME:-v$VERSION}" >/dev/null
fi
bash "$ROOT/scripts/build.sh"
npx --no-install tsx "$ROOT/scripts/validate-localization-artifacts.ts" dist
mkdir -p "$ROOT/releases"
rm -f "$OUT"
(cd "$ROOT/dist" && zip -r -D "$OUT" .)
npx --no-install tsx "$ROOT/scripts/validate-localization-artifacts.ts" zip

echo "Created: $OUT"
