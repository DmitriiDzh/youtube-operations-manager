#!/bin/sh
# Double-click entry point for Finder -- see start.command's own comment for why this exists.
# Delegates entirely to stop.sh (AGENTS.md §D -- one launcher implementation, not a second copy).
cd "$(dirname "$0")"
exec ./stop.sh
