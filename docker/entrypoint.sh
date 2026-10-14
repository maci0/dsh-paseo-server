#!/bin/sh
# Start a virtual display, then run the Paseo Electron client against it.
#
# Every argument is forwarded to the client. Paseo wraps Electron with a
# Commander CLI that rejects Chromium switches, so the sandbox is disabled
# through Electron's own environment variable rather than `--no-sandbox`.
set -eu

export ELECTRON_DISABLE_SANDBOX=1
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"

XVFB_ARGS="${XVFB_ARGS:--screen 0 1280x1024x24 -nolisten tcp}"
# shellcheck disable=SC2086
Xvfb :99 $XVFB_ARGS &
XVFB_PID=$!

# Stop the display when the client exits, whatever the exit status.
cleanup() {
  kill "$XVFB_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Wait for the display socket rather than sleeping a fixed time.
for _ in $(seq 1 100); do
  [ -e /tmp/.X11-unix/X99 ] && break
  sleep 0.1
done

exec /opt/Paseo/Paseo.bin "$@"
