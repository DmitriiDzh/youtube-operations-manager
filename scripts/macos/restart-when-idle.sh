#!/bin/sh
# YouTube Operations Manager - macOS: ask the running server to restart itself once nobody works with it (BL-220,
# docs/roadmap/plans/RESTART_WHEN_IDLE_PLAN.md, ADR 0049). Unlike stop.sh it stops nothing itself: it writes
# restart-request.json into the app-data folder the server uses (the same trust as stop.sh: the OS user), and the server takes
# it up at its next check (every 15 s), waits until no media session or job, upload, live-stream start/stop/switch, export/import,
# operation, hold or recent MCP call is left, and then stops gracefully -- the system service starts the new build (rebuilding
# first if `dev` moved). Only the system service (install-service.command) can restart itself; a request that waits 24 h ends.
# Exit code 0 = request written, 1 = it could not be written.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# The same folder as src/lib/platform-paths (macOS): ~/Library/Application Support/YouTubeOperationsManager. The service runs as
# this account with HOME set to its home (install-service.sh), so the server reads the same file.
APP_DATA="$HOME/Library/Application Support/YouTubeOperationsManager"
FILE="$APP_DATA/restart-request.json"
TMP="$FILE.tmp"

if [ ! -d "$APP_DATA" ]; then
  echo "[ERROR] $APP_DATA does not exist -- has the app ever run on this account?"
  exit 1
fi

AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Written to a temporary file first and renamed, so the server never reads half a file.
if ! printf '{ "requestedBy": "developer", "at": "%s" }\n' "$AT" > "$TMP" || ! mv -f "$TMP" "$FILE"; then
  rm -f "$TMP"
  echo "[ERROR] Could not write $FILE."
  exit 1
fi

echo "Restart requested at $AT ($FILE)."
echo "The server takes it up within 15 s and restarts once nobody works with it."
echo "Follow it in the app: Settings -> About, \"Restart when nobody is working\" (what it waits for, the holds, the last restart),"
echo "or in the server log: tail -f \"$ROOT/.launcher.log\" | grep restart_when_idle"
echo "Cancel it there with \"Cancel the request\"."
