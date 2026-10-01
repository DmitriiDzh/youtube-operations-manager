// ---------------------------------------------------------------------------
// Phase 13 slice 13.4 (docs/roadmap/plans/PHASE_13_PLAN.md) -- YouTube Data API quota facts shared
// by every caller that budgets calls, so no feature keeps its own (stale) copy. A pure leaf (no
// googleapis), so services layers can use it without pulling in the read gateway's clients:
//
//   - The daily quota resets at midnight PACIFIC time (America/Los_Angeles, DST-aware) -- not UTC.
//   - Since 2026-06-01 `search.list` has its own bucket: 100 calls per day, 1 unit each, separate
//     from the 10,000-unit pool every other read uses
//     (https://developers.google.com/youtube/v3/determine_quota_cost, revision history 2026-06-01).
// ---------------------------------------------------------------------------

/** Google's default `search.list` bucket: calls per quota day. */
export const SEARCH_LIST_DAILY_CALL_LIMIT = 100;
/** One `search.list` call costs 1 unit of its own bucket (not of the 10k pool). */
export const SEARCH_LIST_UNIT_COST = 1;

const QUOTA_TIME_ZONE = "America/Los_Angeles";

/** Offset (ms) of Pacific time from UTC at `instant`: local wall clock minus UTC. */
function pacificOffsetMs(instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: QUOTA_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The start of the YouTube quota day containing `now`: the last midnight in Pacific time. */
export function startOfYoutubeQuotaDay(now: Date): Date {
  const offset = pacificOffsetMs(now);
  const wall = new Date(now.getTime() + offset);
  const wallMidnightAsUtc = Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), wall.getUTCDate());
  // The offset AT midnight can differ from the offset now on a DST switch day -- recompute it there.
  const firstGuess = new Date(wallMidnightAsUtc - offset);
  return new Date(wallMidnightAsUtc - pacificOffsetMs(firstGuess));
}
