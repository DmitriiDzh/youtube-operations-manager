#!/bin/sh
# YouTube Operations Manager - remove the macOS system service (BL-158). Needs root (uninstall-service.command runs
# it with sudo and passes node). Waits for a running export/import/migration like stop.sh, stops the server and
# removes the daemon. Afterwards start.command starts the server the old way again (it then stops by itself when idle).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/service-env.sh"
PORT="${PORT:-3000}"
NODE="$1"

if [ "$(id -u)" != "0" ]; then
  echo "[ERROR] Run this with sudo -- or double-click uninstall-service.command."
  exit 1
fi
if ! service_installed; then
  echo "The system service is not installed -- nothing to do."
  exit 0
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "[ERROR] node was not found, so running operations cannot be checked -- the service was NOT removed."
  exit 1
fi
SERVICE_USER="$(/usr/libexec/PlistBuddy -c 'Print :UserName' "$SERVICE_PLIST")"
SERVICE_HOME="$(dscl . -read "/Users/$SERVICE_USER" NFSHomeDirectory | awk '{print $2}')"

if [ -n "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "Checking that no export, import or database migration is running..."
  if ! (cd "$ROOT" && sudo -u "$SERVICE_USER" env PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$SERVICE_HOME" npm run --silent operation-lock -- wait-idle --timeout 120); then
    echo "[ERROR] The service was NOT removed: a running operation did not finish (or could not be checked)."
    exit 1
  fi
fi

echo "Stopping the server..."
launchctl bootout "system/$SERVICE_LABEL" 2>/dev/null || true
ATTEMPT=0
while launchctl print "system/$SERVICE_LABEL" >/dev/null 2>&1 && [ "$ATTEMPT" -lt 330 ]; do
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
rm -f "$SERVICE_PLIST"
if [ -n "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "[WARN] The service is removed, but something still listens on port $PORT (see lsof -ti tcp:$PORT -sTCP:LISTEN)."
  exit 1
fi
echo "The system service is removed and the server is stopped. start.command starts it again the usual way."
