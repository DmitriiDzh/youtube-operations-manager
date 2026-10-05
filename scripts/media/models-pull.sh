#!/usr/bin/env bash
# Pulls models from Hugging Face straight onto the network volume using a cheap CPU pod (no GPU, no local
# round trip): creates the pod with the volume mounted at /workspace, runs `hf download` for every manifest
# line, waits until every file is on the volume (checked over the S3 API), then TERMINATES the pod.
# Usage: scripts/media/models-pull.sh <models.manifest> [--cpu-id cpu3c] [--vcpu 2] [--timeout-minutes 180]
# Manifest format: scripts/media/pod/models.manifest.example. Datacenter and volume come from Settings → Media.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,6p' "$0"; exit 0; }

manifest="${1:-}"; need_arg manifest "$manifest"; shift
cpu_id="cpu3c"; vcpu=2; timeout_minutes=180
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu-id) cpu_id="$2"; shift 2 ;;
    --vcpu) vcpu="$2"; shift 2 ;;
    --timeout-minutes) timeout_minutes="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

settings="$(media_data settings)"
dc="$(json_get 'data.datacenterId ?? ""' <<<"$settings")"
volume="$(json_get 'data.networkVolumeId ?? ""' <<<"$settings")"
[ -n "$dc" ] && [ -n "$volume" ] || { echo "set the datacenter and the network volume in Settings → Media first" >&2; exit 1; }

# Build the download script and the expected key list from the manifest.
expected=()
# Single-quote a value for the pod's shell exactly like src/lib/media-generation/models.ts's buildPullCommand (a `'` becomes `'\''`).
q() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# The HF CLI's download cache under models/<folder>/.cache would stay on the paid volume forever (review round 14): removed per folder after each download and on any exit.
download_cmds="set -e; trap 'find /workspace/models -maxdepth 2 -name .cache -type d -exec rm -rf {} +' EXIT; pip install -q -U 'huggingface_hub[cli]'; mkdir -p /workspace/models;"
while IFS=$'\t' read -r repo file dest || [ -n "$repo" ]; do
  case "$repo" in ''|'#'*) continue ;; esac
  [ -n "$file" ] && [ -n "$dest" ] || { echo "bad manifest line: $repo" >&2; exit 2; }
  case "$dest" in */*|*..*) echo "bad manifest dest (one models/ folder name): $dest" >&2; exit 2 ;; esac
  download_cmds+=" hf download $(q "$repo") $(q "$file") --local-dir $(q "/workspace/models/$dest"); rm -rf $(q "/workspace/models/$dest/.cache");"
  expected+=("models/$dest/$file")
done < "$manifest"
[ ${#expected[@]} -gt 0 ] || { echo "manifest has no rows" >&2; exit 2; }
download_cmds+=" echo YTM_PULL_DONE; sleep infinity"

body="$(mktemp)"; trap 'rm -f "$body"' EXIT
node -e '
  const [dc, volume, cpuId, vcpu, cmd] = process.argv.slice(1);
  process.stdout.write(JSON.stringify({
    name: "ytm-models-pull",
    image: "python:3.12-slim",
    cpu: { id: cpuId, vcpuCount: Number(vcpu) },
    cloud: "SECURE",
    dataCenterId: dc,
    mounts: { network: [{ volumeId: volume, path: "/workspace" }] },
    cmd: ["bash", "-lc", cmd],
    startSsh: false,
  }));
' "$dc" "$volume" "$cpu_id" "$vcpu" "$download_cmds" > "$body"

pod="$(media_data pod-create --file "$body")"
pod_id="$(json_get 'data.id' <<<"$pod")"
echo "pull pod $pod_id created in $dc (volume $volume); waiting for ${#expected[@]} file(s)…"

cleanup() { media_data pod-terminate "$pod_id" >/dev/null && echo "pod $pod_id terminated"; }
trap 'cleanup; rm -f "$body"' EXIT

deadline=$(( $(date +%s) + timeout_minutes * 60 ))
while :; do
  listing="$(media_data s3-ls models/ || echo '[]')"
  missing="$(node -e '
    const have = new Map(JSON.parse(require("fs").readFileSync(0, "utf8")).map(o => [o.key, o.size]));
    const expected = process.argv.slice(1);
    console.log(expected.filter(k => !(have.get(k) > 0)).join("\n"));
  ' "${expected[@]}" <<<"$listing")"
  if [ -z "$missing" ]; then
    echo "all files present on the volume"
    result_line "ok files=${#expected[@]} podId=$pod_id"
    exit 0
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timeout; still missing:" >&2; printf '  %s\n' $missing >&2
    result_line "timeout podId=$pod_id"
    exit 1
  fi
  status="$(media_data pod-get "$pod_id" | json_get 'data?.status ?? "GONE"')"
  echo "  pod $status; missing $(printf '%s\n' "$missing" | wc -l | tr -d ' ') file(s)…"
  sleep 60
done
