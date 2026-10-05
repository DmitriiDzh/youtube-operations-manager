#!/usr/bin/env bash
# The safety net outside the app (owner decision D2): terminates any pod of this account that has been
# running longer than the allowed time, checking every `watchIntervalSeconds` from Settings → Media
# (or --interval). Run it from cron / launchd / Task Scheduler, or in a terminal during a session.
# Idle-based termination (no jobs) belongs to the app's own watcher (slice 2); this script knows only age.
# Usage: scripts/media/pod-watch.sh [--max-minutes <N, default: defaultMaxMinutes from Settings>] [--interval <s>] [--once]
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
[ "${1:-}" = "--help" ] && { sed -n '2,6p' "$0"; exit 0; }

max_minutes=""; interval=""; once=0
while [ $# -gt 0 ]; do
  case "$1" in
    --max-minutes) max_minutes="$2"; shift 2 ;;
    --interval) interval="$2"; shift 2 ;;
    --once) once=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
settings="$(media_data settings)"
[ -n "$max_minutes" ] || max_minutes="$(json_get 'data.defaultMaxMinutes' <<<"$settings")"
[ -n "$interval" ] || interval="$(json_get 'data.watchIntervalSeconds' <<<"$settings")"

while :; do
  now="$(date +%s)"
  pods="$(media_data pods)"
  overdue="$(node -e '
    const [now, max] = process.argv.slice(1).map(Number);
    const pods = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const p of pods) {
      if (p.status === "TERMINATED") continue;
      const started = Date.parse(p.startedAt ?? p.createdAt ?? "") / 1000;
      const minutes = Number.isFinite(started) ? (now - started) / 60 : Infinity;
      if (p.status === "EXITED" || minutes > max) console.log(`${p.id} ${p.status} ${Math.round(minutes)}`);
    }
  ' "$now" "$max_minutes" <<<"$pods")"
  terminated=0
  if [ -n "$overdue" ]; then
    while read -r id status minutes; do
      echo "$(date '+%H:%M:%S') pod $id is $status after $minutes min (limit $max_minutes) -> terminating"
      media_data pod-terminate "$id" >/dev/null && terminated=$((terminated + 1))
    done <<<"$overdue"
  fi
  alive="$(json_get 'data.filter(p => p.status !== "TERMINATED").length' <<<"$pods")"
  echo "$(date '+%H:%M:%S') alive=$alive terminated_now=$terminated"
  if [ "$once" = 1 ]; then
    result_line "alive=$alive terminated=$terminated"
    exit 0
  fi
  sleep "$interval"
done
