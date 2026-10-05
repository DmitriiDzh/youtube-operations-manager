#!/usr/bin/env bash
# Lists the account's pods (status, GPU, $/h, start time, public ports).
# Usage: scripts/media/pods.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

data="$(media_data pods)"
json_get 'data.length === 0 ? "no pods" : data.map(p => `${p.id}  ${p.status.padEnd(12)} ${(p.gpuTypeId ?? "cpu").padEnd(30)} $${p.costPerHr ?? "?"}/h  started ${p.startedAt ?? "-"}  ports ${(p.ports ?? []).map(x => `${x.private}->${x.ip ?? ""}:${x.public ?? "?"}`).join(",") || "-"}`).join("\n")' <<<"$data"
result_line "count=$(json_get 'data.length' <<<"$data") alive=$(json_get 'data.filter(p => p.status !== "TERMINATED").length' <<<"$data")"
