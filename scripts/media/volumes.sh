#!/usr/bin/env bash
# Lists the account's network volumes with their monthly cost.
# Usage: scripts/media/volumes.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

data="$(media_data volumes)"
json_get 'data.length === 0 ? "no network volumes" : data.map(v => `${v.id}  ${v.name}  ${v.dataCenterId}  ${v.sizeGb} GB (${v.usedSizeGb ?? "?"} used)  ~$${(v.sizeGb * 0.07).toFixed(2)}/month`).join("\n")' <<<"$data"
result_line "count=$(json_get 'data.length' <<<"$data")"
