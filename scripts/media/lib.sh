#!/usr/bin/env bash
# Shared helpers for scripts/media/* (Phase 14, docs/roadmap/plans/PHASE_14_PLAN.md §2.8).
#
# Every script here is a thin wrapper over the operator CLI `npm run media -- <command>`
# (src/cli/media.ts), which runs in-process against the encrypted credential store filled in
# Settings → Media. Therefore: no RunPod key, no S3 secret, no token is ever an argument or an
# environment variable of these scripts (AC-P14-20). Requirements: Node.js + the repository's
# dependencies installed (npm install), and Settings → AI Agent → "Operator CLI access" ON.
# Windows: run under Git Bash or WSL.
set -euo pipefail

MEDIA_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$MEDIA_SCRIPT_DIR/../.." && pwd)"

# Runs one CLI command; stdout is the JSON envelope {ok, data|error}. Exit code is the CLI's.
media_cli() {
  (cd "$REPO_ROOT" && npm run --silent media -- "$@")
}

# Runs a CLI command and prints only `data` (or the error message to stderr, exit 1).
media_data() {
  local out
  if ! out="$(media_cli "$@")"; then
    printf '%s\n' "$out" >&2
    return 1
  fi
  node -e '
    const env = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!env.ok) { console.error(`${env.error.code}: ${env.error.message}`); process.exit(1); }
    console.log(JSON.stringify(env.data));
  ' <<<"$out"
}

# Prints a one-line machine-readable result (the last line of every script, for agents).
result_line() {
  printf 'RESULT %s\n' "$*"
}

# `json_get '<expr>'` -- evaluates a JS expression over `data` read from stdin, e.g. json_get 'data.length'.
json_get() {
  node -e "const data = JSON.parse(require('fs').readFileSync(0, 'utf8')); const v = ($1); console.log(typeof v === 'string' ? v : JSON.stringify(v));"
}

need_arg() {
  if [ -z "${2:-}" ]; then
    echo "missing argument: $1" >&2
    exit 2
  fi
}
