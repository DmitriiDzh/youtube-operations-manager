#!/usr/bin/env bash
# Submits one job to the running session and waits for it: prints the output paths when done.
# Usage: scripts/media/job-run.sh --template <templateId> --channel <UC...> [--param name=value ...] [--session <sessionId>]
#        (string values as-is; numbers and true/false are converted; --session defaults to the open running session)
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,4p' "$0"; exit 0; }

template=""; channel=""; session=""; params=()
while [ $# -gt 0 ]; do
  case "$1" in
    --template) template="$2"; shift 2 ;;
    --channel) channel="$2"; shift 2 ;;
    --session) session="$2"; shift 2 ;;
    --param) params+=("$2"); shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
need_arg --template "$template"; need_arg --channel "$channel"

if [ -z "$session" ]; then
  session="$(media_data sessions | json_get 'data.limits.openSession?.status === "running" ? data.limits.openSession.sessionId : ""')"
  [ -n "$session" ] || { echo "no running session (approve one in Settings → Media → Sessions)" >&2; exit 1; }
fi

body="$(mktemp)"; trap 'rm -f "$body"' EXIT
node -e '
  const [session, channel, template, ...pairs] = process.argv.slice(1);
  const params = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    const name = pair.slice(0, i), raw = pair.slice(i + 1);
    params[name] = raw === "true" ? true : raw === "false" ? false : raw !== "" && !Number.isNaN(Number(raw)) ? Number(raw) : raw;
  }
  process.stdout.write(JSON.stringify({ sessionId: session, channelId: channel, templateId: template, params }));
' "$session" "$channel" "$template" ${params[@]+"${params[@]}"} > "$body"

job="$(media_data job-create --file "$body")"
job_id="$(json_get 'data.jobId' <<<"$job")"
echo "job $job_id submitted (prompt $(json_get 'data.promptId' <<<"$job"))"
for _ in $(seq 1 720); do
  current="$(media_data job-get "$job_id")"
  status="$(json_get 'data.status' <<<"$current")"
  case "$status" in
    done)
      json_get 'data.outputs.map(o => `  ${o.localPath ?? "(not pulled: " + o.note + ")"}`).join("\n")' <<<"$current"
      result_line "jobId=$job_id status=done outputs=$(json_get 'data.outputs.filter(o => o.localPath).length' <<<"$current")"
      exit 0 ;;
    failed|cancelled)
      echo "job $status: $(json_get 'data.error ?? ""' <<<"$current")" >&2
      result_line "jobId=$job_id status=$status"
      exit 1 ;;
  esac
  sleep 5
done
echo "still $status after an hour; check Settings → Media → Jobs" >&2
result_line "jobId=$job_id status=$status"
exit 1
