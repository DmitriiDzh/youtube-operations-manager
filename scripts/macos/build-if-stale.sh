#!/bin/sh
# YouTube Operations Manager - macOS: install dependencies and build the application when needed.
# The ONE implementation of the launcher's build rule (AGENTS.md §D), used by start.sh, update.sh and the system
# service's runner (service-run.mjs, BL-158). Works on the repository root wherever it is called from.
#   build-if-stale.sh          install/build when needed; exit 0 = a current build is in place
#   build-if-stale.sh --check  change nothing; exit 0 = the build is current, 3 = a build is needed
#   build-if-stale.sh --force  install and build even if the build looks current (update.sh)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

# Rebuild-staleness check. This script no longer touches the network, the remote, or the working
# tree in any way (start.sh previously ran `git pull --ff-only` itself before this check -- removed
# 2026-09-21 at the project owner's explicit request: "за актуальностью гита я буду следить сам"
# -- keeping git entirely up to the operator, not this script).
#
# A marker file records what `.next` was actually built from: in a git checkout (a `.git` folder, or a `.git` file in a
# worktree) the commit, so a build from an earlier commit (e.g. before the operator's own `git pull`) is detected and
# rebuilt -- ".next merely exists" cannot tell a stale build from a current one; in a folder without git (a standalone
# published/<version>/ release copy) the word "no-git", where `update.sh` (--force) remains the explicit rebuild step
# (docs/RELEASE_LAYOUT.md §1, AGENTS.md §K.4). A missing or different marker always means a build is needed, and the
# marker is removed before installing/building and written only after a complete build (BL-158): an interrupted
# install or build -- the service stops one on purpose when asked to stop -- never reads as current later.
BUILD_MARKER=".next-build-commit.txt"
CURRENT_REV=""
if [ -e ".git" ] && command -v git >/dev/null 2>&1; then
  CURRENT_REV="$(git rev-parse HEAD 2>/dev/null || echo "")"
fi
EXPECTED_MARKER="${CURRENT_REV:-no-git}"
BUILT_MARKER=""
if [ -f "$BUILD_MARKER" ]; then
  BUILT_MARKER="$(cat "$BUILD_MARKER" 2>/dev/null || echo "")"
fi

NEED_BUILD=""
if [ ! -d ".next" ] || [ ! -d "node_modules" ] || [ "$BUILT_MARKER" != "$EXPECTED_MARKER" ] || [ "$1" = "--force" ]; then
  NEED_BUILD=1
fi

if [ "$1" = "--check" ]; then
  if [ -n "$NEED_BUILD" ]; then
    exit 3
  fi
  exit 0
fi

if [ -n "$NEED_BUILD" ]; then
  echo "Installing dependencies and building the application (no complete build of the checked-out version found)..."
  rm -f "$BUILD_MARKER"
  npm install
  # NODE_TEST_CONTEXT=1 keeps `next build` off the real app-data database: its page-data step loads the app, and
  # without the guard that initializes -- and migrates -- the real database with whatever sources are checked out
  # (RISK-63's root cause). Every route is dynamic, so nothing is prerendered from data; the real migration happens
  # when the server starts (with its pre-migration backup).
  NODE_TEST_CONTEXT=1 npm run build
  # The marker must name what was actually built: if the checkout changed while building, record nothing.
  if [ -n "$CURRENT_REV" ] && [ "$(git rev-parse HEAD 2>/dev/null || echo "")" != "$CURRENT_REV" ]; then
    echo "[ERROR] The checked-out commit changed while building -- this build is not recorded; build again."
    exit 6
  fi
  echo "$EXPECTED_MARKER" > "$BUILD_MARKER"
fi
