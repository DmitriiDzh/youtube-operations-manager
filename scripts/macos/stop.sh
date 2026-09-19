#!/bin/sh
# YouTube Operations Manager - macOS stop script.
cd "$(dirname "$0")/../.."
PIDFILE="$(pwd)/.launcher.pid"

echo "Stopping YouTube Operations Manager..."

# Build the list of PIDs actually listening on port 3000 right now -- this is the ground truth;
# a recorded pidfile PID is only trusted once corroborated against it, since PIDs get reused by
# the OS and a stale pidfile could otherwise point at an unrelated process.
PORT_PIDS=$(lsof -ti tcp:3000 2>/dev/null || true)

if [ -n "$PORT_PIDS" ]; then
  for PID in $PORT_PIDS; do
    if kill "$PID" 2>/dev/null; then
      echo "Sent stop signal to process $PID (listening on port 3000)."
    else
      echo "[WARN] Could not signal process $PID -- it may already be gone, or need sudo."
    fi
  done
else
  echo "Nothing is listening on port 3000 -- the application does not appear to be running."
fi

rm -f "$PIDFILE"

if [ -n "$PORT_PIDS" ]; then
  # Shutdown is asynchronous (SIGTERM is a request, not instant) -- wait briefly for the port to
  # actually free up before reporting success, so a start.sh run immediately after this doesn't
  # hit EADDRINUSE against a process that is still in the middle of shutting down.
  ATTEMPT=0
  while [ "$ATTEMPT" -lt 10 ]; do
    if [ -z "$(lsof -ti tcp:3000 2>/dev/null)" ]; then
      echo "Done -- port 3000 is free."
      exit 0
    fi
    ATTEMPT=$((ATTEMPT + 1))
    sleep 1
  done
  echo "[WARN] Port 3000 is still in use after waiting -- the process may need more time, or a manual kill (lsof -ti tcp:3000)."
fi
