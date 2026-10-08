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
as_user() { sudo -u "$RUN_USER" env PATH="$JOB_PATH" HOME="$RUN_HOME" "$@"; }
listening() { [ -n "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; }
loaded() { launchctl print "system/$SERVICE_LABEL" >/dev/null 2>&1; }

echo "=== YouTube Operations Manager - install the system service ==="
echo "  account:     $RUN_USER"
echo "  program:     $ROOT"
echo "  node:        $NODE_REAL"
echo "  service log: $SERVICE_LOG"

# Another account's service is never replaced silently (its data lives in that account).
if service_installed; then
  OLD_USER="$(/usr/libexec/PlistBuddy -c 'Print :UserName' "$SERVICE_PLIST" 2>/dev/null || true)"
  if [ -n "$OLD_USER" ] && [ "$OLD_USER" != "$RUN_USER" ]; then
    echo "[ERROR] The service is installed for the account '$OLD_USER'. Run uninstall-service.command first."
    exit 1
  fi
fi

# The service builds and runs only an accepted branch: refuse now, before anything running is stopped.
BRANCH_RC=0
BRANCH="$(as_user "$SCRIPT_DIR/accepted-branch.sh")" || BRANCH_RC=$?
if [ "$BRANCH_RC" -eq 4 ]; then
  echo "[ERROR] The repository folder is on $BRANCH, not on dev or main -- nothing was changed. Switch back first."
  exit 1
elif [ "$BRANCH_RC" -ne 0 ]; then
  echo "[ERROR] Cannot tell the repository folder's branch ($BRANCH) -- nothing was changed."
  exit 1
fi

# Nothing running may be cut short -- checked before anything is torn down (the same check stop.sh makes). Always, not
# only when the port is busy: the service may be building, and the check reads the database, not the server. Without
# dependencies installed nothing from this folder can be running an operation (and the check itself needs them).
if [ -d "$ROOT/node_modules/tsx" ]; then
  echo "Checking that no export, import or database migration is running..."
  if ! (cd "$ROOT" && as_user npm run --silent operation-lock -- wait-idle --timeout 120); then
    echo "[ERROR] Nothing was changed: a running operation did not finish (or could not be checked)."
    exit 1
  fi
else
  echo "Dependencies are not installed yet, so nothing from this folder is running -- the service installs them."
fi

# Stop what runs now: the previously installed service, or a server started by start.sh.
if loaded; then
  echo "Stopping the previously installed service..."
  launchctl bootout "system/$SERVICE_LABEL" 2>/dev/null || true
  ATTEMPT=0
  while loaded && [ "$ATTEMPT" -lt 330 ]; do
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  if loaded; then
    echo "[ERROR] The previous service did not stop within 5 minutes; nothing was changed. Try again later."
    exit 1
  fi
elif listening; then
  echo "Stopping the server that is running now..."
  if ! as_user "$SCRIPT_DIR/stop.sh"; then
    echo "[ERROR] The running server could not be stopped safely -- nothing was installed."
    exit 1
  fi
fi

as_user mkdir -p "$LOG_DIR"

# ExitTimeOut: launchd waits this long after SIGTERM before SIGKILL (default 20 s), so a stop drains like stop.sh's.
# WorkingDirectory is the home folder, not the repository: launchd enters it before node runs, so it must not depend
# on node's Full Disk Access (the runner uses absolute paths).
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
rm -f "$SERVICE_PLIST"
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
  <key>WorkingDirectory</key><string>$(xml "$RUN_HOME")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$JOB_PATH")</string>
    <key>HOME</key><string>$(xml "$RUN_HOME")</string>
    <key>PORT</key><string>$(xml "$PORT")</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ExitTimeOut</key><integer>300</integer>
  <key>StandardOutPath</key><string>$(xml "$SERVICE_LOG")</string>
  <key>StandardErrorPath</key><string>$(xml "$SERVICE_LOG")</string>
</dict>
</plist>
EOF
chown root:wheel "$SERVICE_PLIST"
chmod 644 "$SERVICE_PLIST"
plutil -lint "$SERVICE_PLIST" >/dev/null

if ! launchctl bootstrap system "$SERVICE_PLIST" 2>/dev/null; then
  sleep 3 # launchd may still be letting the previous instance go
  launchctl bootstrap system "$SERVICE_PLIST"
fi
echo "Service installed. Waiting for the server (the first start can rebuild the application: a few minutes)..."

ATTEMPT=0
while [ "$ATTEMPT" -lt 900 ]; do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    echo ""
    echo "Done. The server runs as a system service and starts when the Mac is switched on."
    echo "  - Any account on this Mac opens it at http://localhost:$PORT"
    echo "  - It is never stopped by idleness; 10 minutes without an open window only switch Live writes off."
    echo "  - It builds and runs only the dev or main branch of $ROOT."
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
echo "If they say \"EPERM: operation not permitted, open .../service-run.mjs\": give Full Disk Access to $NODE_REAL"
echo "(System Settings > Privacy & Security > Full Disk Access). The service retries by itself."
exit 1
