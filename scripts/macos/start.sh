#!/bin/sh
# YouTube Operations Manager - macOS launcher.
set -e
cd "$(dirname "$0")/../.."
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

# Already running? Stop the old instance first (same principle as scripts/windows/start.bat): a second
# instance cannot bind the port, and the browser would otherwise open the OLD server -- possibly on
# a stale build. stop.sh waits for any running export/import/migration before stopping, and refuses
# (exit code 1) if one does not finish; then nothing is started or rebuilt over it.
# Note: whatever listens on port 3000 is stopped, exactly as stop.sh has always done.
if [ -n "$(lsof -ti tcp:$PORT 2>/dev/null)" ]; then
  echo "Port $PORT is already in use - stopping the running instance first..."
  if ! "$(dirname "$0")/stop.sh"; then
    echo "[ERROR] The running instance could not be stopped safely - not starting a second one."
    exit 1
  fi
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only, this can take a few minutes)..."
  npm install
fi

# Rebuild-staleness check. This script no longer touches the network, the remote, or the working
# tree in any way (it previously ran `git pull --ff-only` itself before this check -- removed
# 2026-09-21 at the project owner's explicit request: "за актуальностью гита я буду следить сам"
# -- keeping git entirely up to the operator, not this script).
#
# In an actual git checkout of the repository, compare the currently checked-out commit against
# a marker file recording which commit `.next` was actually built from, so a build the operator
# did on an earlier commit (e.g. before their own `git pull`) is detected and rebuilt
# automatically -- rather than relying on ".next merely exists" as the only signal, which cannot
# tell a stale build apart from a current one. A standalone published/<version>/ release copy has
# no `.git` and no commit to compare against -- `update.sh` remains its one, explicit,
# human-triggered rebuild step (docs/RELEASE_LAYOUT.md §1, AGENTS.md §K.4).
BUILD_MARKER=".next-build-commit.txt"
CURRENT_REV=""
if [ -d ".git" ] && command -v git >/dev/null 2>&1; then
  CURRENT_REV="$(git rev-parse HEAD 2>/dev/null || echo "")"
fi

NEED_BUILD=""
if [ ! -d ".next" ]; then
  NEED_BUILD=1
fi
if [ -n "$CURRENT_REV" ]; then
  BUILT_REV=""
  if [ -f "$BUILD_MARKER" ]; then
    BUILT_REV="$(cat "$BUILD_MARKER" 2>/dev/null || echo "")"
  fi
  if [ "$CURRENT_REV" != "$BUILT_REV" ]; then
    NEED_BUILD=1
  fi
fi

if [ -n "$NEED_BUILD" ]; then
  echo "Installing dependencies and building the application (no build found, or the checked-out commit changed since the last build)..."
  npm install
  npm run build
  if [ -n "$CURRENT_REV" ]; then
    echo "$CURRENT_REV" > "$BUILD_MARKER"
  fi
fi

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
