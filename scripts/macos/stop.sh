#!/bin/sh
# YouTube Operations Manager - macOS stop script.
#
# Stops the running server -- but never in the middle of an export/import/schema migration: an
# interrupted one is exactly what leaves a stuck operation lock. Same principles as
# scripts/windows/stop.bat (keep the two in step): (1) find the listener on port $PORT, (2) wait for
# any RUNNING operation to finish (`operation-lock wait-idle`; refuse to stop if it does not within
# 2 minutes), (3) stop the process, (4) confirm the port is actually free. Exit code 0 = nothing
# left running, 1 = not stopped (start.sh/update.sh must not go on).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."
PIDFILE="$(pwd)/.launcher.pid"
PORT="${PORT:-3000}"

echo "Stopping YouTube Operations Manager..."

# Build the list of PIDs actually listening on port $PORT right now -- this is the ground truth;
# a recorded pidfile PID is only trusted once corroborated against it, since PIDs get reused by
# the OS and a stale pidfile could otherwise point at an unrelated process.
# Only the process LISTENING on the port: without -sTCP:LISTEN lsof also names every client with an open connection to it
# (a browser tab's helper process), and this script then sent the stop signal to the browser too (seen 2026-10-08).
PORT_PIDS=$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$PORT_PIDS" ]; then
  echo "Checking that no export, import or database migration is running..."
  if ! npm run --silent operation-lock -- wait-idle --timeout 120; then
    echo "[ERROR] The application was NOT stopped: a running operation did not finish (or could not be checked)."
    echo "        Stopping it now could leave a stuck lock. Wait and try again, or see the /recovery page."
    exit 1
  fi
  for PID in $PORT_PIDS; do
    if kill "$PID" 2>/dev/null; then
      echo "Sent stop signal to process $PID (listening on port $PORT)."
    else
      echo "[WARN] Could not signal process $PID -- it may already be gone, or need sudo."
    fi
  done
else
  echo "Nothing is listening on port $PORT -- the application does not appear to be running."
fi

rm -f "$PIDFILE"

# BL-158: under the system service launchd starts the server again at once (rebuilding first if the checked-out commit
# changed), so the port does not stay free -- here "stopped" means the old process has exited, and stopping is how the
# service is restarted. Removing the service for good is uninstall-service.command.
. "$SCRIPT_DIR/service-env.sh"
if [ -n "$PORT_PIDS" ] && service_installed; then
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 30 ]; do
    ALIVE=""
    for PID in $PORT_PIDS; do
      if kill -0 "$PID" 2>/dev/null; then ALIVE=1; fi
    done
    if [ -z "$ALIVE" ]; then
      echo "Done -- the server process has exited. The system service starts it again by itself"
      echo "(uninstall-service.command removes the service for good)."
      exit 0
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  echo "[WARN] The server process is still running after 30 s -- it may need more time."
  exit 1
fi

if [ -n "$PORT_PIDS" ]; then
  # Shutdown is asynchronous (SIGTERM is a request, not instant) -- wait briefly for the port to
  # actually free up before reporting success, so a start.sh run immediately after this doesn't
  # hit EADDRINUSE against a process that is still in the middle of shutting down.
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 10 ]; do
    if [ -z "$(lsof -ti tcp:$PORT -sTCP:LISTEN 2>/dev/null)" ]; then
      echo "Done -- port $PORT is free."
      exit 0
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  echo "[WARN] Port $PORT is still in use after waiting -- the process may need more time, or a manual kill (lsof -ti tcp:$PORT -sTCP:LISTEN)."
  exit 1
fi
