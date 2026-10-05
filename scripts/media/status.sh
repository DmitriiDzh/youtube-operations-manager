#!/usr/bin/env bash
# One screen: credentials state, settings, readiness, pods alive with $/h, volumes with $/month.
# Usage: scripts/media/status.sh [--json]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

if [ "${1:-}" = "--help" ]; then
  sed -n '2,3p' "$0"; exit 0
fi

overview="$(media_data status)"
if [ "${1:-}" = "--json" ]; then
  printf '%s\n' "$overview"
  result_line "ok"
  exit 0
fi

json_get '`credentials: ${data.credentials.configured ? "configured (" + data.credentials.runpodKeyPrefix + ")" : "NOT configured (" + data.credentials.reason + ")"}
gateway:     ${data.gatewayEnabled ? "on" : "OFF"}
datacenter:  ${data.settings.datacenterId ?? "-"}   gpu: ${data.settings.gpuTypeId ?? "-"}   cloud: ${data.settings.cloudType}
volume:      ${data.settings.networkVolumeId ?? "-"}   template: ${data.settings.templateId ?? "-"}
limits:      $${data.settings.maxUsdPerDay}/day, ${data.settings.defaultMaxMinutes} min default, idle ${data.settings.idleMinutes} min, watch every ${data.settings.watchIntervalSeconds}s
ready:       ${data.ready ? "yes" : "no (missing: " + data.missing.join(", ") + ")"}`' <<<"$overview"

configured="$(json_get 'data.credentials.configured' <<<"$overview")"
pods_alive=0
if [ "$configured" = "true" ]; then
  pods="$(media_data pods)"
  pods_alive="$(json_get 'data.filter(p => p.status !== "TERMINATED").length' <<<"$pods")"
  json_get 'data.length === 0 ? "pods:        none" : "pods:\n" + data.map(p => `  ${p.id}  ${p.status}  ${p.gpuTypeId ?? "cpu"}  $${p.costPerHr ?? "?"}/h  started ${p.startedAt ?? "-"}`).join("\n")' <<<"$pods"
  volumes="$(media_data volumes)"
  json_get 'data.length === 0 ? "volumes:     none" : "volumes:\n" + data.map(v => `  ${v.id}  ${v.name}  ${v.dataCenterId}  ${v.sizeGb} GB  ~$${(v.sizeGb * 0.07).toFixed(2)}/month`).join("\n")' <<<"$volumes"
fi
result_line "configured=$configured pods_alive=$pods_alive"
