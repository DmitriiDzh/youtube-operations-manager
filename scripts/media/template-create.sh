#!/usr/bin/env bash
# Creates the RunPod pod template this app starts sessions from (body: scripts/media/pod/template.json,
# or your own --file). Prints the template id to put into Settings → Media → Compute.
# Usage: scripts/media/template-create.sh [--file <template.json>] [--image <docker image>] [--name <name>]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,4p' "$0"; exit 0; }

file="$MEDIA_SCRIPT_DIR/pod/template.json"; image=""; name=""
while [ $# -gt 0 ]; do
  case "$1" in
    --file) file="$2"; shift 2 ;;
    --image) image="$2"; shift 2 ;;
    --name) name="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
node -e '
  const [file, image, name] = process.argv.slice(1);
  const body = JSON.parse(require("fs").readFileSync(file, "utf8"));
  if (image) body.image = image;
  if (name) body.name = name;
  process.stdout.write(JSON.stringify(body));
' "$file" "$image" "$name" > "$tmp"

data="$(media_data template-create --file "$tmp")"
printf '%s\n' "$data"
result_line "templateId=$(json_get 'data.id' <<<"$data")"
