#!/bin/sh
# YouTube Operations Manager - macOS update (rebuild after replacing program files).
set -e
# Absolute script folder, taken before the cd (see start.sh: from update.command "$(dirname "$0")" is ".").
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

echo "=== YouTube Operations Manager - update (rebuild after replacing program files) ==="
echo "This only rebuilds the application in this folder. Your database and settings live under"
echo "~/Library/Application Support/YouTubeOperationsManager/ and are never touched by this script."
echo ""

if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js was not found on PATH. Install Node.js 20 LTS or newer."
  exit 1
fi

# BL-158: under the system service a stopped server is started again at once, so building here would race it.
. "$SCRIPT_DIR/service-env.sh"
if service_installed; then
  echo "[ERROR] The application runs as a system service on this Mac. In a git checkout it rebuilds by itself when"
  echo "        the checked-out commit changes -- run stop.sh to restart it now. For a release folder without git:"
  echo "        uninstall-service.command, then this script, then install-service.command again."
  exit 1
fi

"$SCRIPT_DIR/stop.sh" || exit 1

echo "Installing dependencies and rebuilding this version..."
# The one build rule, forced: off the real database while building (RISK-63), the marker written only after a complete
# build, so an interrupted update is rebuilt by the next start instead of being served.
"$SCRIPT_DIR/build-if-stale.sh" --force

echo ""
echo "Update complete. Run start.sh to launch the updated application."
echo "On first launch after an update, the application checks its database schema version and"
echo "applies any needed migration automatically, after taking its own backup -- see"
echo "docs/RELEASE_LAYOUT.md and docs/TECHNICAL_DEBT.md for detail. It never silently creates a"
echo "new empty database in place of an existing one."
