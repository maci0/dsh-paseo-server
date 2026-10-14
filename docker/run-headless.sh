#!/bin/sh
# Run the Paseo desktop client headless against a daemon on this machine.
#
# The client's three shells share one codebase. The mobile build is ARM64-only
# and refuses to run when it was not installed through Play, so a headless
# desktop client is the reliable way to drive a real client against this
# daemon on a development machine.
#
# Requirements:
#   - docker
#   - the official Linux release tarball, from
#     https://github.com/getpaseo/paseo/releases  (Paseo-<version>-x64.tar.gz)
#     Point PASEO_TARBALL at it.
#
# usage: ./run-headless.sh [extra client arguments...]
set -eu

TARBALL="${PASEO_TARBALL:?set PASEO_TARBALL to Paseo-<version>-x64.tar.gz}"
VERSION="${PASEO_VERSION:-0.11.2}"
CDP_PORT="${CDP_PORT:-9222}"
DAEMON_PORT="${PASEO_LOCAL_DAEMON_PORT:-6790}"
IMAGE="paseo-client:${VERSION}"

# Project root: the directory holding docker/ and .scratch/.
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
SCRATCH="$ROOT/.scratch"
APP_DIR="$SCRATCH/paseo-app"
HOME_DIR="$SCRATCH/paseo-docker-home"

if [ ! -d "$APP_DIR" ]; then
  mkdir -p "$APP_DIR"
  tar -xzf "$TARBALL" -C "$APP_DIR" --strip-components=1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  docker build -t "$IMAGE" "$ROOT/docker"
fi

# The client insists on starting its own bundled daemon. Give it a port that is
# free on this machine, because host networking shares the host's 6767 with the
# daemon the user already runs.
mkdir -p "$HOME_DIR/.paseo"
if [ ! -f "$HOME_DIR/.paseo/config.json" ]; then
  cat > "$HOME_DIR/.paseo/config.json" <<JSON
{
  "version": 1,
  "daemon": { "listen": "127.0.0.1:${DAEMON_PORT}", "relay": { "enabled": false } },
  "app": { "baseUrl": "https://app.paseo.sh" }
}
JSON
fi

# Speech models are several hundred megabytes; reuse the host's copies so the
# container never downloads them.
MODELS_MOUNT=""
if [ -d "$HOME/.paseo/models" ]; then
  MODELS_MOUNT="-v $HOME/.paseo/models:/home/paseo/.paseo/models:ro"
fi

# host networking lets the client reach a daemon bound to 127.0.0.1 on this
# machine, and exposes the DevTools port for scripted driving.
# The container runs as the invoking user, so the client's own state stays
# owned by that user instead of root.
# shellcheck disable=SC2086
exec docker run --rm --name paseo-headless \
  --network host \
  --user "$(id -u):$(id -g)" \
  -e HOME=/home/paseo \
  -v "$APP_DIR:/opt/Paseo:ro" \
  -v "$HOME_DIR:/home/paseo" \
  $MODELS_MOUNT \
  "$IMAGE" \
  --remote-debugging-port="$CDP_PORT" \
  "$@"
