#!/usr/bin/env bash
# One RunPod read (+ one S3 listing when the pair, datacenter and volume are set). Stamps verifiedAt on success.
# Usage: scripts/media/credentials-test.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,3p' "$0"; exit 0; }

data="$(media_data credentials-test)"
printf '%s\n' "$data"
ok="$(json_get 'data.runpod.ok === true && !("ok" in data.s3 && data.s3.ok === false)' <<<"$data")"
result_line "ok=$ok"
[ "$ok" = "true" ]
