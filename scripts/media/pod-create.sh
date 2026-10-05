#!/usr/bin/env bash
# Creates a ComfyUI pod from Settings → Media (template, GPU, datacenter, cloud, network volume at /workspace),
# with a fresh COMFY_TOKEN for the token proxy, and waits until RunPod reports it RUNNING.
# This is the slice-0 manual path; the app's session service (slice 2) does the same through the gateway.
# Usage: scripts/media/pod-create.sh [--name ytm-media] [--gpu-count 1] [--no-wait]
# Prints the pod id, the proxy URL for ComfyUI (port 8189) and the token (stdout only, once).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,6p' "$0"; exit 0; }

name="ytm-media"; gpu_count=1; wait=1
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --gpu-count) gpu_count="$2"; shift 2 ;;
    --no-wait) wait=0; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

settings="$(media_data settings)"
for field in datacenterId gpuTypeId networkVolumeId templateId; do
  [ "$(json_get "data.$field ?? \"\"" <<<"$settings")" != "" ] || { echo "Settings → Media: $field is not set" >&2; exit 1; }
done

token="$(node -e 'console.log(require("crypto").randomBytes(24).toString("base64url"))')"
body="$(mktemp)"; trap 'rm -f "$body"' EXIT
node -e '
  const [settingsJson, name, gpuCount, token] = process.argv.slice(1);
  const s = JSON.parse(settingsJson);
  process.stdout.write(JSON.stringify({
    name,
    templateId: s.templateId,
    gpu: { id: s.gpuTypeId, count: Number(gpuCount) },
    cloud: s.cloudType,
    dataCenterId: s.datacenterId,
    mounts: { network: [{ volumeId: s.networkVolumeId, path: "/workspace" }] },
    ports: ["8189/http", "22/tcp"],
    env: { COMFY_TOKEN: token },
  }));
' "$settings" "$name" "$gpu_count" "$token" > "$body"

pod="$(media_data pod-create --file "$body")"
pod_id="$(json_get 'data.id' <<<"$pod")"
echo "pod $pod_id created ($(json_get 'data.status' <<<"$pod"), $(json_get 'data.costPerHr ?? "?"' <<<"$pod") \$/h)"

if [ "$wait" = 1 ]; then
  for _ in $(seq 1 60); do
    status="$(media_data pod-get "$pod_id" | json_get 'data?.status ?? "GONE"')"
    [ "$status" = "RUNNING" ] && break
    echo "  $status…"; sleep 10
  done
fi
echo "ComfyUI (through the token proxy): $(json_get 'data.comfyUiProxyUrl' <<<"$pod")  (Authorization: Bearer <token>)"
echo "COMFY_TOKEN=$token"
echo "Remember: scripts/media/pod-terminate.sh $pod_id when done (never stop -- a stopped pod's disk costs double)."
result_line "podId=$pod_id"
