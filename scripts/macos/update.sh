#!/bin/sh
# YouTube Operations Manager - macOS update (rebuild after replacing program files).
set -e
cd "$(dirname "$0")/../.."

echo "=== YouTube Operations Manager - update (rebuild after replacing program files) ==="
echo "This only rebuilds the application in this folder. Your database and settings live under"
echo "~/Library/Application Support/YouTubeOperationsManager/ and are never touched by this script."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found on PATH. Install Node.js 20 LTS or newer."
  exit 1
fi

"$(dirname "$0")/stop.sh" || true

echo "Installing dependencies for this version..."
npm install

echo "Rebuilding..."
npm run build

echo ""
echo "Update complete. Run start.sh to launch the updated application."
echo "On first launch after an update, the application checks its database schema version and"
echo "applies any needed migration automatically, after taking its own backup -- see"
echo "docs/RELEASE_LAYOUT.md and docs/TECHNICAL_DEBT.md for detail. It never silently creates a"
echo "new empty database in place of an existing one."
