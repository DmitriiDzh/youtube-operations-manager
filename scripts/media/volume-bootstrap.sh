#!/usr/bin/env bash
# Prepares the network volume chosen in Settings → Media over the S3 API (no GPU, no pod):
# uploads the pod-side files (pod-start.sh, Caddyfile, extra_model_paths.yaml) under ytm/ and creates the
# folder markers models/<kind>/, exchange/in/. Re-runnable; never deletes anything.
# Usage: scripts/media/volume-bootstrap.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,5p' "$0"; exit 0; }

pod_dir="$MEDIA_SCRIPT_DIR/pod"
for f in pod-start.sh Caddyfile extra_model_paths.yaml; do
  media_data s3-put "$pod_dir/$f" "ytm/$f" >/dev/null
  echo "uploaded ytm/$f"
done

marker="$(mktemp)"
trap 'rm -f "$marker"' EXIT
printf 'folder marker written by scripts/media/volume-bootstrap.sh\n' > "$marker"
for key in models/checkpoints models/diffusion_models models/text_encoders models/vae models/loras models/clip_vision models/audio_encoders exchange/in; do
  media_data s3-put "$marker" "$key/.keep" >/dev/null
  echo "ensured $key/"
done
result_line "ok"
