#!/bin/sh
# YouTube Operations Manager - macOS: is the repository folder on a branch the system service may build and run?
# The ONE implementation of that rule (BL-158), used by the service's runner (service-run.mjs) and, before they stop a
# running server, by start.sh and install-service.sh. Nobody watches the service's builds, and a new build migrates the
# real database at its first start, so only accepted branches qualify.
# Prints the branch (or the reason). Exit 0 = dev or main, or not a git checkout (a release folder);
# 4 = another branch or a detached HEAD; 5 = git itself could not run (e.g. after a macOS update: xcode-select --install).
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../.." || exit 5
[ -e ".git" ] || exit 0
if ! command -v git >/dev/null 2>&1; then
  echo "git was not found"
  exit 5
fi
if ! OUT="$(git rev-parse --git-dir 2>&1)"; then
  echo "git could not run: $OUT"
  exit 5
fi
if ! BRANCH="$(git symbolic-ref --quiet --short HEAD 2>/dev/null)"; then
  echo "a detached HEAD"
  exit 4
fi
echo "$BRANCH"
case "$BRANCH" in
  dev|main) exit 0 ;;
  *) exit 4 ;;
esac
