#!/usr/bin/env bash
# Terminates a pod (DELETE; never stop) and verifies through the API that it is gone.
# Usage: scripts/media/pod-terminate.sh <podId> | --all
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

target="${1:-}"; need_arg podId "$target"
if [ "$target" = "--all" ]; then
  ids="$(media_data pods | json_get 'data.filter(p => p.status !== "TERMINATED").map(p => p.id).join(" ")')"
else
  ids="$target"
fi

failed=0
for id in $ids; do
  media_data pod-terminate "$id" >/dev/null
  status="$(media_data pod-get "$id" | json_get 'data === null ? "GONE" : data.status')"
  if [ "$status" = "GONE" ] || [ "$status" = "TERMINATED" ]; then
    echo "pod $id: terminated"
  else
    echo "pod $id: still $status after terminate -- check the RunPod console" >&2
    failed=1
  fi
done
result_line "terminated=$(echo $ids | wc -w | tr -d ' ') failed=$failed"
[ "$failed" = 0 ]
