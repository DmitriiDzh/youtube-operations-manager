#!/usr/bin/env bash
# Pulls models from Hugging Face straight onto the network volume using a cheap CPU pod (no GPU, no local
# round trip), ONE manifest line at a time through the app's own `model-pull` (so every pull is recorded,
# visible and cancellable in Settings → Media → Models, and takes the volume lock like a session would).
# Each pull is advanced with `models-poll` until it is done/failed/timeout, then the next line starts.
# Usage: scripts/media/models-pull.sh <models.manifest> [--cpu-id cpu3c] [--vcpu 2] [--poll-seconds 30]
# Manifest format: scripts/media/pod/models.manifest.example (repo<TAB>file<TAB>folder). Datacenter and
# volume come from Settings → Media. Requires "Operator CLI access" to be on (model-pull/models-poll are gated).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,8p' "$0"; exit 0; }

manifest="${1:-}"; need_arg manifest "$manifest"; shift
cpu_id="cpu3c"; vcpu=2; poll_seconds=30
while [ $# -gt 0 ]; do
  case "$1" in
    --cpu-id) cpu_id="$2"; shift 2 ;;
    --vcpu) vcpu="$2"; shift 2 ;;
    --poll-seconds) poll_seconds="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# Advance the pulls until the given pull id is terminal; prints its final status.
wait_for_pull() {
  local pull_id="$1" status
  while :; do
    status="$(media_data models-poll | node -e '
      const id = process.argv[1];
      const pulls = JSON.parse(require("fs").readFileSync(0, "utf8")).pulls ?? [];
      const pull = pulls.find((p) => p.pullId === id);
      console.log(pull ? `${pull.status}\t${pull.bytes ?? ""}\t${pull.error ?? ""}` : "missing\t\t");
    ' "$pull_id")"
    case "${status%%	*}" in
      running) sleep "$poll_seconds" ;;
      *) printf '%s\n' "$status"; return 0 ;;
    esac
  done
}

ok=0; failed=0
while IFS=$'\t' read -r repo file dest || [ -n "$repo" ]; do
  case "$repo" in ''|'#'*) continue ;; esac
  [ -n "$file" ] && [ -n "$dest" ] || { echo "bad manifest line: $repo" >&2; exit 2; }
  echo "pulling $repo :: $file → models/$dest/ …"
  pull="$(media_data model-pull --repo "$repo" --file "$file" --folder "$dest" --cpu "$cpu_id" --vcpu "$vcpu")" || { echo "  refused (see the error above)"; failed=$((failed + 1)); continue; }
  pull_id="$(json_get 'data.pullId' <<<"$pull")"
  echo "  pull $pull_id started (pod $(json_get 'data.podId ?? "pending"' <<<"$pull"))"
  final="$(wait_for_pull "$pull_id")"
  status="${final%%	*}"; rest="${final#*	}"; bytes="${rest%%	*}"; error="${rest#*	}"
  case "$status" in
    done) echo "  done ($bytes bytes)"; ok=$((ok + 1)) ;;
    *) echo "  $status${error:+: $error}" >&2; failed=$((failed + 1)) ;;
  esac
done < "$manifest"

result_line "ok=$ok failed=$failed"
[ "$failed" -eq 0 ]
