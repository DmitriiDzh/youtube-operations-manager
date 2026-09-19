#!/bin/sh
# YouTube Operations Manager - macOS stop script.
echo "Stopping YouTube Operations Manager..."

PIDFILE=/tmp/youtube-ops-manager.pid
STOPPED=0

if [ -f "$PIDFILE" ]; then
  PID=$(cat "$PIDFILE")
  if kill -0 "$PID" >/dev/null 2>&1; then
    kill "$PID"
    STOPPED=1
    echo "Stopped process $PID (from $PIDFILE)."
  fi
  rm -f "$PIDFILE"
fi

if [ "$STOPPED" = "0" ]; then
  PORT_PID=$(lsof -ti tcp:3000 2>/dev/null || true)
  if [ -n "$PORT_PID" ]; then
    kill "$PORT_PID"
    echo "Stopped process $PORT_PID listening on port 3000."
    STOPPED=1
  fi
fi

if [ "$STOPPED" = "0" ]; then
  echo "Nothing found running on port 3000 -- the application does not appear to be running."
else
  echo "Done."
fi
