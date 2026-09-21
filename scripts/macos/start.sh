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
  echo "Building the application (no build found, or the checked-out commit changed since the last build)..."
  npm run build
  if [ -n "$CURRENT_REV" ]; then
    echo "$CURRENT_REV" > "$BUILD_MARKER"
  fi
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
