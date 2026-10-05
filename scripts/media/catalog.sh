#!/usr/bin/env bash
# RunPod catalog for the Settings choices: GPU types with $/h and availability, datacenters, CPU flavors.
# Usage: scripts/media/catalog.sh [gpus|datacenters|cpus]   (default: all three)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

what="${1:-all}"
if [ "$what" = "all" ] || [ "$what" = "gpus" ]; then
  echo "GPU types (on-demand $/h, availability):"
  media_data gpus | json_get 'data.map(g => `  ${g.id.padEnd(34)} ${String(g.memoryInGb ?? "?").padStart(3)} GB  ${g.onDemandPricePerHr === null ? "   ?  " : ("$" + g.onDemandPricePerHr.toFixed(2)).padStart(6)}/h  ${g.estimatedAvailability ?? "?"}`).join("\n")'
fi
if [ "$what" = "all" ] || [ "$what" = "datacenters" ]; then
  echo "Datacenters:"
  media_data datacenters | json_get 'data.map(d => `  ${d.id.padEnd(10)} ${d.countryCode ?? ""} ${d.region ?? ""}`).join("\n")'
fi
if [ "$what" = "all" ] || [ "$what" = "cpus" ]; then
  echo "CPU flavors (secure $/vCPU/h):"
  media_data cpus | json_get 'data.map(c => `  ${c.id.padEnd(14)} ${c.name.padEnd(20)} vCPU ${c.vcpuMin ?? "?"}-${c.vcpuMax ?? "?"}  $${c.securePricePerVcpuHr ?? "?"}`).join("\n")'
fi
result_line "ok"
