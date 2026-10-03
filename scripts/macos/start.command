#!/bin/sh
# Double-click entry point for Finder (macOS runs a `.command` file in Terminal.app automatically
# when double-clicked -- a plain `.sh` file has no such association and needs an explicit
# terminal invocation, unlike Windows' `.bat`, which is already double-clickable as-is; the owner
# asked for parity with that). Delegates entirely to start.sh (AGENTS.md §D -- one launcher
# implementation, not a second copy of its checks/build-staleness logic).
#
# BL-116: start.sh leaves the server running detached, so once it succeeds this Terminal window has nothing left to
# do and closes itself. The close is requested from a process in its own session (no controlling terminal), so
# Terminal does not see a running process in the window and does not ask "terminate?". If scripting Terminal is not
# allowed, the window simply stays open -- harmless.
cd "$(dirname "$0")"
./start.sh
RC=$?
if [ "$RC" -eq 0 ] && [ -z "$YTOM_KEEP_TERMINAL" ] && command -v perl >/dev/null 2>&1; then
  TTY_NAME="$(tty 2>/dev/null)"
  if [ -n "$TTY_NAME" ] && [ "$TTY_NAME" != "not a tty" ]; then
    perl -MPOSIX -e 'POSIX::setsid(); exec @ARGV' sh -c "sleep 1; osascript -e 'tell application \"Terminal\" to close (every window whose tty of selected tab is \"$TTY_NAME\")'" >/dev/null 2>&1 < /dev/null &
  fi
fi
exit "$RC"
