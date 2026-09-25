#!/bin/sh
# Double-click entry point for Finder (macOS runs a `.command` file in Terminal.app automatically
# when double-clicked -- a plain `.sh` file has no such association and needs an explicit
# terminal invocation, unlike Windows' `.bat`, which is already double-clickable as-is; the owner
# asked for parity with that). Delegates entirely to start.sh (AGENTS.md §D -- one launcher
# implementation, not a second copy of its checks/build-staleness logic).
cd "$(dirname "$0")"
exec ./start.sh
