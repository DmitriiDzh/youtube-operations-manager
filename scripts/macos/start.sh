#!/bin/sh
# YouTube Operations Manager - macOS launcher.
set -e
cd "$(dirname "$0")/../.."
PIDFILE="$(pwd)/.launcher.pid"

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

if [ -n "$(lsof -ti tcp:3000 2>/dev/null)" ]; then
  echo "[ERROR] Something is already listening on port 3000 -- the application may already be"
  echo "running. Run stop.sh first if you want to restart it."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only, this can take a few minutes)..."
  npm install
fi

if [ ! -d ".next" ]; then
  echo "No build found - building the application (first run, or after running update.sh)..."
  npm run build
fi

echo "Starting YouTube Operations Manager on http://localhost:3000 ..."
npm run start &
SERVER_PID=$!
echo "$SERVER_PID" > "$PIDFILE"

# Wait for the server to actually accept connections (up to ~20s) rather than assuming success
# after a fixed sleep -- npm run start can fail immediately (e.g. a stale build) and a blind
# sleep+open would still report success and open a browser tab that just shows a connection error.
READY=0
ATTEMPT=0
while [ "$ATTEMPT" -lt 20 ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "[ERROR] The server process exited before becoming ready -- see the output above."
    rm -f "$PIDFILE"
    exit 1
  fi
  if command -v curl >/dev/null 2>&1 && curl -s -o /dev/null "http://localhost:3000/" 2>/dev/null; then
    READY=1
    break
  fi
  ATTEMPT=$((ATTEMPT + 1))
  sleep 1
done

if [ "$READY" = "1" ]; then
  if command -v open >/dev/null 2>&1; then
    open "http://localhost:3000"
  fi
  echo ""
  echo "The application is running in the background (PID $SERVER_PID)."
  echo "  - To stop it safely, run stop.sh."
  echo "  - Your data is stored under ~/Library/Application Support/YouTubeOperationsManager/,"
  echo "    not in this folder -- it is not affected by replacing these program files later."
else
  echo "[WARN] The server process is still running (PID $SERVER_PID) but did not respond to"
  echo "http://localhost:3000/ within 20s. Check the terminal output above for errors."
fi

wait "$SERVER_PID"
