#!/bin/sh
# YouTube Operations Manager - install the macOS system service (BL-158). Needs root: install-service.command runs it
# with sudo and passes the path of node found in the owner's own shell.
#   sudo install-service.sh /opt/homebrew/bin/node
# The service runs the server as the account that ran sudo, starts it when the Mac is switched on and restarts it
# whenever it stops. Running this again reinstalls it (e.g. after the repository moved). uninstall-service.sh removes it.
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
. "$SCRIPT_DIR/service-env.sh"
PORT="${PORT:-3000}"
NODE="$1"

if [ "$(id -u)" != "0" ]; then
  echo "[ERROR] Run this with sudo -- or double-click install-service.command."
  exit 1
fi
RUN_USER="${SUDO_USER:-}"
if [ -z "$RUN_USER" ] || [ "$RUN_USER" = "root" ]; then
  echo "[ERROR] Run it with sudo from the account the server should run as, not as root."
  exit 1
fi
if [ -z "$NODE" ] || [ ! -x "$NODE" ]; then
  echo "[ERROR] Pass the path of node (install-service.command does): sudo $0 \"\$(command -v node)\""
  exit 1
fi
RUN_HOME="$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory | awk '{print $2}')"
NODE_REAL="$("$NODE" -p 'require("fs").realpathSync(process.execPath)')"
JOB_PATH="$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin"
LOG_DIR="$RUN_HOME/Library/Logs/YouTubeOperationsManager"
SERVICE_LOG="$LOG_DIR/service.log"

echo "=== YouTube Operations Manager - install the system service ==="
echo "  account:    $RUN_USER"
echo "  program:    $ROOT"
echo "  node:       $NODE_REAL"
echo "  service log: $SERVICE_LOG"

# Reinstall: stop the old service first.
if launchctl print "system/$SERVICE_LABEL" >/dev/null 2>&1; then
  echo "Removing the previously installed service..."
  launchctl bootout "system/$SERVICE_LABEL" 2>/dev/null || true
fi
rm -f "$SERVICE_PLIST"

# A server started by start.sh is stopped the safe way (it waits for a running export/import/migration).
if [ -n "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "Stopping the server that is running now..."
  if ! sudo -u "$RUN_USER" env PATH="$JOB_PATH" HOME="$RUN_HOME" "$SCRIPT_DIR/stop.sh"; then
    echo "[ERROR] The running server could not be stopped safely -- nothing was installed."
    exit 1
  fi
fi

sudo -u "$RUN_USER" mkdir -p "$LOG_DIR"

xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
cat > "$SERVICE_PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$SERVICE_LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$SCRIPT_DIR/service-run.mjs")</string>
  </array>
  <key>UserName</key><string>$(xml "$RUN_USER")</string>
  <key>GroupName</key><string>staff</string>
  <key>WorkingDirectory</key><string>$(xml "$ROOT")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$JOB_PATH")</string>
    <key>HOME</key><string>$(xml "$RUN_HOME")</string>
    <key>PORT</key><string>$(xml "$PORT")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$(xml "$SERVICE_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$SERVICE_LOG")</string>
</dict>
</plist>
EOF
chown root:wheel "$SERVICE_PLIST"
chmod 644 "$SERVICE_PLIST"
plutil -lint "$SERVICE_PLIST" >/dev/null

launchctl bootstrap system "$SERVICE_PLIST"
echo "Service installed. Waiting for the server (the first start can rebuild the application: a few minutes)..."

ATTEMPT=0
while [ "$ATTEMPT" -lt 900 ]; do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo ""
    echo "Done. The server runs as a system service and starts when the Mac is switched on."
    echo "  - Any account on this Mac opens it at http://localhost:$PORT"
    echo "  - It is never stopped by idleness; 10 minutes without an open window only switch Live writes off."
    echo "  - To restart it (e.g. to load a new commit): stop.sh. To remove the service: uninstall-service.command."
    exit 0
  fi
  ATTEMPT=$((ATTEMPT + 1))
  if [ $((ATTEMPT % 60)) -eq 0 ]; then
    echo "  still waiting ($((ATTEMPT / 60)) min) -- last lines of the service log:"
    tail -n 3 "$SERVICE_LOG" 2>/dev/null | sed 's/^/    /'
  fi
  sleep 1
done
echo "[WARN] The service is installed but the server did not answer within 15 minutes. Last lines of $SERVICE_LOG:"
tail -n 20 "$SERVICE_LOG" 2>/dev/null | sed 's/^/    /'
echo "If they say 'Operation not permitted' (EPERM): give Full Disk Access to $NODE_REAL"
echo "(System Settings > Privacy & Security > Full Disk Access), then run install-service.command again."
exit 1
