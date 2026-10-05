#!/usr/bin/env bash
# Creates a network volume. RunPod bills it monthly (~$0.07/GB) from now until it is deleted in the console.
# Usage: scripts/media/volume-create.sh --name <name> --dc <EU-RO-1> --size <GB> [--yes]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

name=""; dc=""; size=""; yes=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --dc) dc="$2"; shift 2 ;;
    --size) size="$2"; shift 2 ;;
    --yes) yes=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
need_arg --name "$name"; need_arg --dc "$dc"; need_arg --size "$size"

if [ "$yes" != 1 ]; then
  printf 'Create a %s GB volume "%s" in %s (~$%.2f/month)? [y/N] ' "$size" "$name" "$dc" "$(node -e "console.log($size * 0.07)")"
  read -r answer
  [ "$answer" = "y" ] || { echo "aborted"; exit 1; }
fi

data="$(media_data volume-create --name "$name" --dc "$dc" --size "$size")"
printf '%s\n' "$data"
result_line "volumeId=$(json_get 'data.id' <<<"$data")"
