# Phase 9 slice 9D — historical intelligence (age-normalization, baselines, breakout, emerging)

Continues on the same branch (`AGENTS.md` §K.1). Scope: `docs/roadmap/plans/PHASE_9_OWNER_SPEC_2026-09-26.md`
§8-12 and `docs/roadmap/plans/PHASE_9_PLAN.md` §14's own 9D definition ("pure functions over
9A/9B's raw snapshots"), per `AGENTS.md` §L.

## 1. Scope boundary

**Pure computation only, no new I/O, no new schema, no new service action, no new API route, no
new UI.** Matches 9A's own `derived-metrics.ts` precedent exactly: that file shipped with zero
callers and this was explicitly fine (9B added the first real caller two slices later). Real UI
wiring/service-layer actions that read `market_channel_snapshots`/`market_video_snapshots` and feed
these functions belong to 9H (UI) or whichever slice first needs to actually surface this to an
operator/agent — not invented here without an assigned consumer.

**Already acknowledged by the owner as code-complete-only for now (BL-105, `docs/roadmap/BACKLOG.md`):**
these functions can only be meaningfully acceptance-tested against real accumulated history once
9B has run for multiple real days. Tests here use hand-derived synthetic fixtures (`AGENTS.md` §L),
never live data — live verification of the underlying VALUES (not just the code paths) is deferred
per BL-105.

New file `src/lib/market-intelligence/historical-intelligence.ts` (+ its own test file), styled
identically to `derived-metrics.ts`: zero I/O, `now` always an explicit argument, every "no answer"
case reports an explicit reason rather than a fabricated number (spec §9's own "expose limitations
when history is incomplete").

## 2. Age-normalized comparison (spec §9)

`computeAgeNormalizedViews(snapshots, publishedAt, dayOffsets, now)`: for each requested day offset
(e.g. 1/3/7/30), picks the video snapshot whose elapsed time since `publishedAt` is closest to that
offset, among snapshots observed at or after `publishedAt` AND within a tolerance of the target
(`max(1 day, 25% of the offset)` -- **added by advisor review, before this was caught live**: without
a tolerance, a video's only snapshot at day 30 would be silently reported as its "day 7" value if it
happened to be the closest candidate, defeating age-normalization entirely). Reports
`actualDaysSincePublish` alongside the picked value (transparency for how close the match really was)
and a `basis`:

- `not_yet_reached` — the video hasn't existed long enough yet for this offset to apply (`now -
  publishedAt < dayOffset`) -- a physically different case from merely missing a snapshot.
- `insufficient_history` — the video is old enough, but no snapshot exists close enough to that
  point (either none at all, or the closest one is outside tolerance).
- `observed` — a real, sufficiently-close snapshot was used.

## 3. Channel baselines (spec §10)

**Deliberately one simple, named methodology, not a claimed-universal formula** (spec's own "do not
assume one universal baseline formula" / "store enough raw data to change the methodology later").
**Correction (advisor review, before merge): the baseline itself must be age-normalized, not built
from lifetime view counts** -- an earlier version used each video's LATEST (lifetime) snapshot,
which would make every old video look inflated relative to a new one regardless of real relative
performance, precisely the "old vs. new by total views" comparison spec §9 forbids applied one level
up. `computeChannelVideoBaseline(ageNormalizedViewCountsAtOffset, dayOffset)`: median `viewCount`
across the caller-supplied set of videos' OWN `computeAgeNormalizedViews` points at a single, chosen
`dayOffset` (e.g. every recent video's own day-7 value) -- this function only computes the median and
reports its own sample size and the `dayOffset` it was measured at, never silently trusting a tiny
sample as representative.

## 4. Breakout detection (spec §11)

`assessBreakout(videoId, { viewCount, dayOffset }, channelBaseline)`: exposes the full comparison
(video's own count, the channel's baseline median, the ratio) rather than an opaque score (spec's own
explicit requirement). **Refuses the comparison outright (`ratio: null`, `isBreakout: false`) when the
video's own `dayOffset` does not match the baseline's own `dayOffset`** -- the same age-normalization
correction as §3 above, applied at the comparison site. `isBreakout` requires both `ratio >=
BREAKOUT_RATIO_THRESHOLD` (3x, a named, adjustable constant -- not the spec's own 9x illustrative
example, which was never stated as a mandated cutoff) AND a minimum baseline sample size (3 videos)
-- a "median of 1" is not a baseline worth comparing against.

## 5. Emerging channel detection (spec §12)

**Deliberately narrower than the spec's full signal list** (multiple recent breakouts, sustained
acceleration, increased upload success, unusual relative performance, new format adoption) --
`assessEmergingChannel` uses only the two signals this slice actually has grounded data for: recent
breakout video count (reusing §4 above) and subscriber velocity (reusing 9A's own
`computeSnapshotVelocity`). The richer signals (format adoption, topic-based acceleration) need 9E's
topic model first and are not invented here without it. `reasons: string[]` always states which
signal(s) fired (spec's own "do not label a channel 'promising' without observable supporting data
... expose why it was surfaced").

## 6. Acceptance criteria (drafted before implementation, `AGENTS.md` §L)

- A video published 2 days ago, asked for day-7 performance, reports `not_yet_reached`, never a
  fabricated/null-without-explanation value.
- A video published 30 days ago with no snapshot ever recorded reports `insufficient_history` for
  every offset.
- The snapshot closest to (not necessarily exactly at) the target day offset is picked, with its
  own real elapsed-days value reported alongside it, PROVIDED it is within tolerance
  (`max(1 day, 25% of the offset)`) -- a snapshot too far from the target reports
  `insufficient_history` instead, never a misleadingly-labeled `observed` value.
- `computeChannelVideoBaseline` returns `null`/sample size 0 for an empty input, never a fabricated
  median; it is computed from AGE-NORMALIZED (same day-offset) view counts, never raw lifetime
  counts.
- `assessBreakout` never flags a breakout when the baseline sample size is below the minimum, even
  if the raw ratio would otherwise qualify.
- `assessBreakout` refuses the comparison (`ratio: null`, `isBreakout: false`) when the video's own
  `dayOffset` does not match the baseline's `dayOffset`, never silently computing an age-mismatched
  ratio.
- `assessBreakout`/`assessEmergingChannel` never fabricate a ratio/velocity when the underlying
  input is `null` -- `isBreakout`/`isEmerging` is `false` with an explicit reason, never silently
  `false` with no explanation.
- `assessEmergingChannel`'s `reasons` array names exactly which signal(s) fired; zero signals means
  `isEmerging: false` and an empty `reasons` array, never a placeholder string.

## 7. Explicitly out of scope for 9D

- Any new service action, API route, or UI (9H's scope, once an actual consumer needs these).
- The topic model, trend candidates, and any topic/format-based emerging-channel signal (9E's own
  scope -- needs a topic model this slice doesn't have).
- Live verification of the computed VALUES against real accumulated history (BL-105, needs multiple
  real days of 9B collection first). Code paths themselves are tested against synthetic fixtures.
