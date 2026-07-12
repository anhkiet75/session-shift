#!/usr/bin/env bash
# docker-test-e2e.sh — Build and run the e2e suite in the Linux/Xvfb container
# (Dockerfile.e2e). Use on machines without xvfb-run (e.g. macOS) to get the
# same headed-Chrome-with-extension behavior CI gets on ubuntu-latest.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="sessionshift-e2e"

docker build -f "$ROOT/Dockerfile.e2e" -t "$IMAGE" "$ROOT"
mkdir -p "$ROOT/test-results"
docker run --rm \
  -v "$ROOT/test-results:/app/test-results" \
  "$IMAGE" "$@"
