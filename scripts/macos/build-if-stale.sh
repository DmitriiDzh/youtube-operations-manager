#!/bin/sh
# YouTube Operations Manager - macOS: install dependencies and build the application when needed.
# The ONE implementation of the launcher's build-staleness rule (AGENTS.md §D), used by start.sh and by the system
# service's runner (service-run.cjs, BL-158). Works on the repository root wherever it is called from.
#   build-if-stale.sh          install/build when needed; exit 0 = a current build is in place
#   build-if-stale.sh --check  change nothing; exit 0 = the build is current, 3 = a build is needed
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.."

# Rebuild-staleness check. This script no longer touches the network, the remote, or the working
# tree in any way (start.sh previously ran `git pull --ff-only` itself before this check -- removed
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

if [ "$1" = "--check" ]; then
  if [ -n "$NEED_BUILD" ] || [ ! -d "node_modules" ]; then
    exit 3
  fi
  exit 0
fi

if [ ! -d "node_modules" ]; then
  echo "Installing dependencies (first run only, this can take a few minutes)..."
  npm install
fi

if [ -n "$NEED_BUILD" ]; then
  echo "Installing dependencies and building the application (no build found, or the checked-out commit changed since the last build)..."
  npm install
  npm run build
  if [ -n "$CURRENT_REV" ]; then
    echo "$CURRENT_REV" > "$BUILD_MARKER"
  fi
fi
