#!/usr/bin/env bash
# Files on the network volume over RunPod's S3 API (works while no pod exists).
# Usage: scripts/media/s3.sh ls [prefix]
#        scripts/media/s3.sh get <key> <local path>
#        scripts/media/s3.sh put <local file> <key>
#        scripts/media/s3.sh rm <key>
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] || [ -z "${1:-}" ] && { sed -n '2,6p' "$0"; exit 0; }

cmd="$1"; shift
case "$cmd" in
  ls)
    data="$(media_data s3-ls "${1:-}")"
    json_get 'data.length === 0 ? "(empty)" : data.map(o => `${String(o.size).padStart(12)}  ${o.lastModified ?? ""}  ${o.key}`).join("\n")' <<<"$data"
    result_line "count=$(json_get 'data.length' <<<"$data")"
    ;;
  get)
    need_arg key "${1:-}"; need_arg dest "${2:-}"
    data="$(media_data s3-get "$1" "$2")"
    result_line "bytes=$(json_get 'data.bytes' <<<"$data") path=$2"
    ;;
  put)
    need_arg file "${1:-}"; need_arg key "${2:-}"
    data="$(media_data s3-put "$1" "$2")"
    result_line "uploaded=$2 bytes=$(json_get 'data.bytes' <<<"$data")"
    ;;
  rm)
    need_arg key "${1:-}"
    media_data s3-rm "$1" >/dev/null
    result_line "deleted=$1"
    ;;
  *) echo "unknown subcommand: $cmd" >&2; exit 2 ;;
esac
