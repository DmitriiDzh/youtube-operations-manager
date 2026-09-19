#!/bin/sh
# YouTube Operations Manager - macOS launcher.
set -e
cd "$(dirname "$0")/../.."

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
echo "$SERVER_PID" > /tmp/youtube-ops-manager.pid

sleep 3
if command -v open >/dev/null 2>&1; then
  open "http://localhost:3000"
fi

echo ""
echo "The application is running in the background (PID $SERVER_PID)."
echo "  - To stop it safely, run stop.sh."
echo "  - Your data is stored under ~/Library/Application Support/YouTubeOperationsManager/,"
echo "    not in this folder -- it is not affected by replacing these program files later."
wait "$SERVER_PID"
