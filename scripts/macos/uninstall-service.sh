#!/bin/sh
# YouTube Operations Manager - remove the macOS system service (BL-158). Needs root (uninstall-service.command runs
# it with sudo). Stops the server -- after any running export/import/migration has finished, like stop.sh -- and
# removes the daemon. Afterwards start.command starts the server the old way again (it then stops by itself when idle).
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/service-env.sh"
NODE="$1"

if [ "$(id -u)" != "0" ]; then
  echo "[ERROR] Run this with sudo -- or double-click uninstall-service.command."
  exit 1
fi
if ! service_installed; then
  echo "The system service is not installed -- nothing to do."
  exit 0
fi
RUN_USER="${SUDO_USER:-}"
if [ -n "$RUN_USER" ] && [ "$RUN_USER" != "root" ] && [ -n "$NODE" ] && [ -x "$NODE" ]; then
  RUN_HOME="$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory | awk '{print $2}')"
  echo "Checking that no export, import or database migration is running..."
  if ! (cd "$ROOT" && sudo -u "$RUN_USER" env PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin" HOME="$RUN_HOME" npm run --silent operation-lock -- wait-idle --timeout 120); then
    echo "[ERROR] The service was NOT removed: a running operation did not finish (or could not be checked)."
    exit 1
  fi
fi

launchctl bootout "system/$SERVICE_LABEL" 2>/dev/null || true
rm -f "$SERVICE_PLIST"
echo "The system service is removed and the server is stopped. start.command starts it again the usual way."
