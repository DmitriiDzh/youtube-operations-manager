#!/bin/sh
# YouTube Operations Manager - macOS launcher.
set -e
# Absolute script folder, taken BEFORE the cd below: start.command runs this as ./start.sh, so "$(dirname "$0")"
# is "." and would point at the repository root once we cd there (stop.sh was then "not found").
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
PIDFILE="$(pwd)/.launcher.pid"
# BL-116: the server runs DETACHED (its own session, output in .launcher.log), so this terminal can close and the
# server keeps running. It stops by itself 10 minutes after the last open window, or via stop.sh.
# PORT is overridable (default 3000) and YTOM_NO_BROWSER=1 skips opening the browser, so the launcher can be
# verified without touching a running instance.
PORT="${PORT:-3000}"
LOG="$(pwd)/.launcher.log"

echo "=== YouTube Operations Manager - macOS launcher ==="

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found on PATH."
  echo "Install Node.js 20 LTS or newer (e.g. https://nodejs.org, or 'brew install node') and re-run this script."
  exit 1
fi

if [ ! -f ".env.local" ]; then
  echo "[ERROR] .env.local not found in $(pwd)."
  echo "Copy .env.example to .env.local and fill in your Google OAuth values first -- see docs/getting-started.md."
  exit 1
fi

# BL-158: with the system service installed, launchd owns the server -- it runs from power-on and is started again
# whenever it stops. Then this script never starts a second instance and never builds under a running server: it
# waits for the server, restarts the service once if the checked-out commit changed (the service rebuilds before
# starting), and opens the browser.
. "$SCRIPT_DIR/service-env.sh"
if service_installed; then
  echo "The application runs as a system service on this Mac."
  if ! launchctl print "system/$SERVICE_LABEL" >/dev/null 2>&1; then
    echo "[ERROR] The service is installed but not loaded. Run install-service.command again,"
    echo "        or uninstall-service.command to go back to starting the server with this launcher."
    exit 1
  fi
  SERVICE_LOG="$HOME/Library/Logs/YouTubeOperationsManager/service.log"
  LOG_START=0
  if [ -f "$SERVICE_LOG" ]; then LOG_START=$(wc -c < "$SERVICE_LOG"); fi
  RESTARTED=""
  OLD_PIDS="" # after a restart, only a new process counts as ready
  echo "Waiting for http://localhost:$PORT ..."
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 900 ]; do
    LISTEN_PIDS="$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null || true)"
    if [ -n "$LISTEN_PIDS" ] && [ "$LISTEN_PIDS" != "$OLD_PIDS" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
      # Checked once the server answers (also after a build that was running when this started): restart at most once,
      # and only onto an accepted branch -- otherwise the service would refuse it and both accounts would lose the app.
      if [ -z "$RESTARTED" ] && ! "$SCRIPT_DIR/build-if-stale.sh" --check; then
        RESTARTED=1
        if BRANCH="$("$SCRIPT_DIR/accepted-branch.sh")"; then
          echo "The checked-out commit changed since the last build - restarting the service (it rebuilds first, a few minutes)..."
          OLD_PIDS="$LISTEN_PIDS"
          if ! "$SCRIPT_DIR/stop.sh"; then
            echo "The server is still finishing its work; the service starts the new build once it has stopped."
          fi
          continue
        fi
        echo "[WARN] The repository folder is on $BRANCH, not on dev or main: the service keeps running its last build."
        echo "       Switch back (git switch dev) and run this again to load the new commit."
      fi
      if [ -z "$YTOM_NO_BROWSER" ] && command -v open >/dev/null 2>&1; then
        open "http://localhost:$PORT"
      fi
      echo "The application is running -- you can close this window."
      exit 0
    fi
    # The runner logs why it cannot start (wrong branch, failed build, no disk access): show that instead of waiting.
    if tail -c +$((LOG_START + 1)) "$SERVICE_LOG" 2>/dev/null | grep -qE "\[ERROR\]|EPERM"; then
      echo "[ERROR] The service cannot start the server ($SERVICE_LOG):"
      tail -c +$((LOG_START + 1)) "$SERVICE_LOG" | grep -E "\[ERROR\]|EPERM" | tail -n 3 | sed 's/^/        /'
      exit 1
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  echo "[ERROR] The server did not answer within 15 minutes. See $SERVICE_LOG"
  echo "        and $LOG."
  exit 1
fi

# Already running? Stop the old instance first (same principle as scripts/windows/start.bat): a second
# instance cannot bind the port, and the browser would otherwise open the OLD server -- possibly on
# a stale build. stop.sh waits for any running export/import/migration before stopping, and refuses
# (exit code 1) if one does not finish; then nothing is started or rebuilt over it.
# Note: whatever listens on port 3000 is stopped, exactly as stop.sh has always done.
if [ -n "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; then
  echo "Port $PORT is already in use - stopping the running instance first..."
  if ! "$SCRIPT_DIR/stop.sh"; then
    echo "[ERROR] The running instance could not be stopped safely - not starting a second one."
    exit 1
  fi
fi

# Install/build when needed -- the one shared rule (build-if-stale.sh; the system service uses it too).
"$SCRIPT_DIR/build-if-stale.sh"

echo "Starting YouTube Operations Manager on http://localhost:$PORT ..."
: > "$LOG"
# A new session (perl's setsid) detaches the server from this terminal for real: closing the window neither
# signals it nor makes the terminal ask "terminate running processes?". Without perl, nohup still survives SIGHUP.
if command -v perl >/dev/null 2>&1; then
  PORT="$PORT" perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' npm run start >> "$LOG" 2>&1 < /dev/null &
else
  PORT="$PORT" nohup npm run start >> "$LOG" 2>&1 < /dev/null &
fi
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# Show the server's own start-up output here until it is ready (this window is only for progress).
tail -n +1 -f "$LOG" 2>/dev/null &
TAIL_PID=$!

# Wait for the server to actually accept connections (up to ~60s) rather than assuming success after a fixed sleep.
# 127.0.0.1 because that is exactly what the server binds to.
READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 60 ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    { kill "$TAIL_PID"; wait "$TAIL_PID"; } 2>/dev/null || true
    echo "[ERROR] The server process exited before becoming ready -- see the output above (also saved in $LOG)."
    rm -f "$PIDFILE"
    exit 1
  fi
  if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
    READY=1
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done
{ kill "$TAIL_PID"; wait "$TAIL_PID"; } 2>/dev/null || true

if [ "$READY" = "1" ]; then
  if [ -z "$YTOM_NO_BROWSER" ] && command -v open >/dev/null 2>&1; then
    open "http://localhost:$PORT"
  fi
  echo ""
  echo "The application is running in the background (PID $SERVER_PID) -- you can close this window."
  echo "  - It stops by itself about 10 minutes after the last open browser window; stop.sh stops it right away."
  echo "  - Log: $LOG"
  echo "  - Your data is stored under ~/Library/Application Support/YouTubeOperationsManager/,"
  echo "    not in this folder -- it is not affected by replacing these program files later."
  exit 0
fi

echo "[WARN] The server process is still running (PID $SERVER_PID) but did not respond on"
echo "http://127.0.0.1:$PORT/ within 60s. See $LOG for errors."
exit 1
