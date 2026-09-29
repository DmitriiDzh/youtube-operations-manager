// ---------------------------------------------------------------------------
// Phase 9 slice 9A (docs/roadmap/plans/PHASE_9_SLICE_9A_PLAN.md §4) -- pure, no-I/O derived
// metrics computed at READ time over raw market_channel_snapshots rows, never stored as a second,
// redundant representation (spec §8: "prefer retaining raw observations so formulas can evolve
// later"). Style mirrors `src/lib/analytics/staleness.ts` -- every time-sensitive function takes
// `now` as a plain argument, never reads a clock internally, so tests can pin arbitrary instants.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type SnapshotNumericFields = {
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
};

export type SnapshotWithTime = SnapshotNumericFields & { observedAt: Date };

export type SnapshotDelta = {
  subscriberCount: number | null;
  viewCount: number | null;
  videoCount: number | null;
};

/**
 * Change in each numeric field between two channel snapshots (spec §8: "views gained since
 * previous observation"). A field is `null` in the result whenever EITHER input snapshot has
 * `null` for it -- never fabricated as `0`. Can be negative (a real count genuinely decreased,
 * e.g. a channel losing subscribers) -- never clamped to non-negative, since that would silently
 * hide a real fact.
 */
export function computeSnapshotDelta(earlier: SnapshotNumericFields, later: SnapshotNumericFields): SnapshotDelta {
  const delta = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : b - a);
  return {
    subscriberCount: delta(earlier.subscriberCount, later.subscriberCount),
    viewCount: delta(earlier.viewCount, later.viewCount),
    videoCount: delta(earlier.videoCount, later.videoCount),
  };
}

/**
 * Why a velocity value is (or isn't) reported, per spec §27's "expose limitations when history is
 * incomplete" principle -- never silently equivalent to "0" or "unknown reason":
 * - `insufficient_history` — fewer than 2 genuinely distinct-in-time snapshots exist; no rate can
 *   be computed.
 * - `stale_latest` — the newest snapshot we have is itself older than the requested window's own
 *   start, so there is no current data to speak of at all; the returned rate (computed over
 *   whatever real span exists) is a best-effort figure over a MUCH longer span than `windowDays`,
 *   never a genuine "last `windowDays` days" rate -- callers must not present it as one.
 * - `partial_window` — the latest snapshot is current enough, but the earliest available snapshot
 *   is more recent than the requested window's start; the rate below is computed over the
 *   actually-available span, never extrapolated to pretend the full window was observed.
 * - `full_window` — the latest snapshot is current, and a real snapshot exists at or before the
 *   requested window's start.
 */
export type VelocityBasis = "insufficient_history" | "stale_latest" | "partial_window" | "full_window";

export type FieldVelocity = {
  /** Per-day rate of change, or `null` when either endpoint snapshot lacks this field. */
  value: number | null;
  basis: VelocityBasis;
};

export type SnapshotVelocity = {
  subscriberCount: FieldVelocity;
  viewCount: FieldVelocity;
  videoCount: FieldVelocity;
};

function insufficientHistoryVelocity(): SnapshotVelocity {
  const field: FieldVelocity = { value: null, basis: "insufficient_history" };
  return { subscriberCount: field, viewCount: field, videoCount: field };
}

/**
 * Rate of change per day for each numeric field, over a trailing window ending at `now`. Compares
 * the LATEST snapshot against an earlier one, chosen from every snapshot STRICTLY BEFORE it in
 * time (never `latest` compared against itself, and never against a snapshot that merely ties its
 * own stored timestamp -- see the round-2 fix note below): the one closest to (but at or before)
 * the window's start, if any qualifies (`full_window` coverage, provided `latest` is itself
 * current -- see `stale_latest` below); otherwise the oldest earlier snapshot actually available
 * (`partial_window`), rather than fabricating a value over an unobserved span (spec §9: "expose
 * limitations when history is incomplete"). `basis` is the same for every field in one call (it
 * describes which pair of snapshots was compared, a single time-based choice); `value` is
 * independently `null` per field when either endpoint snapshot lacks that specific field.
 *
 * Found by independent review, 2026-09-26 (round 1): an earlier version picked the "earlier"
 * endpoint from the FULL sorted list (including the latest snapshot itself). When every real
 * snapshot -- the latest one included -- was already older than the requested window, that
 * version's "closest snapshot at or before the cutoff" resolved to the latest snapshot itself,
 * comparing it against itself (a zero span) and incorrectly reporting `insufficient_history`
 * despite real, usable snapshots existing.
 *
 * Found by independent review, 2026-09-26 (round 2), against round 1's own fix:
 * 1. Restricting the pool to "before `latest`" is not enough on its own -- `observedAt` is stored
 *    with whole-SECOND precision (the DB column truncates), so two snapshots captured within the
 *    same wall-clock second store an IDENTICAL timestamp. If the chosen "earlier" candidate
 *    happens to tie `latest`'s own truncated second, `spanMs` is still 0, incorrectly discarding a
 *    perfectly good, genuinely earlier snapshot further back in the list. Fixed by filtering to
 *    snapshots STRICTLY EARLIER than `latest` (`<`, not `<=`) before choosing among them, so a tied
 *    timestamp is skipped rather than short-circuiting the whole computation.
 * 2. `full_window` was reported purely from whether an early-enough snapshot existed, without ever
 *    checking that `latest` itself is actually recent -- a channel with real observations only from
 *    60 and 90 days ago, asked for a 7-day rate, reported "full_window" over the true ~30-day span
 *    between them, falsely implying a reliable last-7-days figure. Fixed by checking `latest`'s own
 *    recency first: when `latest` itself predates the window's start, the result is `stale_latest`
 *    regardless of how far back other data reaches -- there is no current data to answer "the last
 *    `windowDays` days" with, only a best-effort figure over a longer span.
 */
export function computeSnapshotVelocity(snapshots: SnapshotWithTime[], windowDays: number, now: Date): SnapshotVelocity {
  if (snapshots.length < 2) return insufficientHistoryVelocity();

  const sorted = [...snapshots].sort((a, b) => a.observedAt.getTime() - b.observedAt.getTime());
  const latest = sorted[sorted.length - 1];
  const strictlyEarlier = sorted.filter((s) => s.observedAt.getTime() < latest.observedAt.getTime());
  if (strictlyEarlier.length === 0) return insufficientHistoryVelocity();

  const windowStartCutoff = now.getTime() - windowDays * MS_PER_DAY;
  const latestIsStale = latest.observedAt.getTime() < windowStartCutoff;

  const closestAtOrBeforeCutoff = strictlyEarlier.findLast((s) => s.observedAt.getTime() <= windowStartCutoff);
  const earliest = closestAtOrBeforeCutoff ?? strictlyEarlier[0];
  const basis: VelocityBasis = latestIsStale ? "stale_latest" : closestAtOrBeforeCutoff ? "full_window" : "partial_window";

  const spanMs = latest.observedAt.getTime() - earliest.observedAt.getTime();
  // Defensive only -- `strictlyEarlier`'s own filter above already guarantees a positive span.
  if (spanMs <= 0) return insufficientHistoryVelocity();
  const spanDays = spanMs / MS_PER_DAY;

  const rate = (a: number | null, b: number | null): number | null => (a === null || b === null ? null : (b - a) / spanDays);

  return {
    subscriberCount: { value: rate(earliest.subscriberCount, latest.subscriberCount), basis },
    viewCount: { value: rate(earliest.viewCount, latest.viewCount), basis },
    videoCount: { value: rate(earliest.videoCount, latest.videoCount), basis },
  };
}
