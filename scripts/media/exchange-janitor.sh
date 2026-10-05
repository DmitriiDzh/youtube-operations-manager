#!/usr/bin/env bash
# Lists leftovers under exchange/ on the network volume and (with --delete) removes those of finished jobs,
# by this app's ledger only. Never touches models/, exchange/in/ or another device's jobs. Dry run by default.
# Usage: scripts/media/exchange-janitor.sh [--delete]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,4p' "$0"; exit 0; }

if [ "${1:-}" = "--delete" ]; then
  data="$(media_data janitor --delete)"
  verb="deleted"
else
  data="$(media_data janitor)"
  verb="would delete"
fi
json_get "\`scanned \${data.scanned}; $verb \${(data.dryRun ? data.wouldDelete : data.deleted).length}:\n\` + (data.dryRun ? data.wouldDelete : data.deleted).map(k => \`  - \${k}\`).join(\"\n\") + \`\nkept \${data.kept.length}:\n\` + data.kept.map(k => \`  ~ \${k.key} (\${k.reason})\`).join(\"\n\")" <<<"$data"
result_line "scanned=$(json_get 'data.scanned' <<<"$data") $verb=$(json_get '(data.dryRun ? data.wouldDelete : data.deleted).length' <<<"$data") kept=$(json_get 'data.kept.length' <<<"$data")"
