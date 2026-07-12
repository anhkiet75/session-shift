#!/bin/sh
# docker-entrypoint-e2e.sh — Starts Xvfb directly and runs the e2e suite
# against it. Avoids `xvfb-run`'s SIGUSR1 readiness handshake, which hangs
# indefinitely in this container image (the wrapper shell blocks in `wait`
# forever because Xvfb never signals readiness back to it here).
set -e

Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp &
XVFB_PID=$!
trap 'kill $XVFB_PID 2>/dev/null' EXIT

# Give Xvfb a moment to bind the display before Chrome tries to connect.
sleep 1

export DISPLAY=:99
exec npm run test:e2e
