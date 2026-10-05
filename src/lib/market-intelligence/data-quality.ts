import { MARKET_INTELLIGENCE_STALE_WINDOW_MS, type DataQualityFlag } from "./contracts";

// Phase 9 slice 9I (docs/roadmap/plans/PHASE_9_SLICE_9I_PLAN.md) -- pure derivation of the shared
// `DataQualityFlag` vocabulary from facts 9A-9E's own tables already record. Zero I/O, `now` always
// an explicit argument -- styled identically to `derived-metrics.ts`/`historical-intelligence.ts`.
// Ships with no real caller in this slice (9H is where these get their first caller, matching 9D's
// own precedent).

/**
 * `"stale_observation"` when the most recent observation is older than `staleAfterMs`, `null` when
 * fresh. A `null` `lastObservedAt` is reported as `null` here too (not a flag) -- that is
 * `"missing_snapshot"`'s own, physically different fact ("never observed" vs. "observed a while
 * ago"), which this function deliberately leaves to `assessSnapshotCompleteness` below.
 */
export function assessObservationFreshness(
  lastObservedAt: Date | null,
  now: Date,
  staleAfterMs: number = MARKET_INTELLIGENCE_STALE_WINDOW_MS
): DataQualityFlag | null {
  if (lastObservedAt === null) return null;
  const ageMs = now.getTime() - lastObservedAt.getTime();
  return ageMs >= staleAfterMs ? "stale_observation" : null;
}

/**
 * `"missing_snapshot"` when a collection attempt enumerated more videos than it actually captured
 * a snapshot for (some of a channel's videos yielded no snapshot at all this run). `null` when
 * either count is `null` -- that means the channel was never actually collected at all, a case the
 * caller's own absence-of-any-run check already covers, not something this function re-reports.
 */
export function assessSnapshotCompleteness(
  videosRequested: number | null,
  videosReturned: number | null
): DataQualityFlag | null {
  if (videosRequested === null || videosReturned === null) return null;
  return videosReturned < videosRequested ? "missing_snapshot" : null;
}

/**
 * `"partial_discovery"` when a discovery run failed but still made real progress before failing
 * (`candidatesFound` positive) -- the exact fact 9C's own `756f1c4` fix made recoverable at all by
 * tracking partial counts outside its own try block. `null` for a clean failure (zero progress) or
 * any success.
 */
export function assessDiscoveryRunQuality(run: {
  status: "success" | "failed";
  candidatesFound: number | null;
}): DataQualityFlag | null {
  if (run.status !== "failed") return null;
  return run.candidatesFound !== null && run.candidatesFound > 0 ? "partial_discovery" : null;
}

/** Trivial wrapper folding 9A's own `hiddenSubscriberCount` boolean into the shared vocabulary. */
export function toHiddenSubscriberCountFlag(hiddenSubscriberCount: boolean): DataQualityFlag | null {
  return hiddenSubscriberCount ? "hidden_subscriber_count" : null;
}

/**
 * Trivial wrapper mapping 9D's own `computeAgeNormalizedViews`/`computeChannelVideoBaseline`
 * `basis` value onto the shared vocabulary. `not_yet_reached` is also, from a consumer's
 * perspective, "not enough history yet" -- the spec's own vocabulary has no separate item for "too
 * early", and this module does not invent one un-asked-for.
 */
export function toAgeNormalizedBasisFlag(
  basis: "not_yet_reached" | "insufficient_history" | "observed"
): DataQualityFlag | null {
  return basis === "observed" ? null : "insufficient_history";
}

/**
 * A pure set-difference: which of `previousVideoIds` are no longer present in `currentVideoIds`.
 * Labeled `"video_no_longer_public"` by the (not-yet-existing) caller -- never split into
 * deleted/private, since whether the real YouTube Data API v3 even CAN make that distinction is
 * itself undocumented and unverified (corrected 2026-09-27; see `PHASE_9_SLICE_9I_PLAN.md` §2's own
 * correction note), and this codebase's own real call doesn't currently request the API part that
 * might carry a signal either way. No real caller in this slice.
 *
 * IMPORTANT for 9H's future caller (corrected 2026-09-27, advisor review): never feed this two
 * successive raw first-page enumerations from `listUploadsPlaylistFirstPage` (9B's own
 * uploads-playlist read, capped to the ≤50 newest videos by design) -- that would falsely flag a
 * channel's own Nth-newest video as "disappeared" every time a newer upload pushes it off the page
 * boundary, when nothing actually happened to it. The real caller must either (a) re-check each
 * previously-known id directly via a real `videos.list` call, or (b) restrict the comparison to ids
 * still at or newer than the oldest id on the current first page. See
 * `PHASE_9_SLICE_9I_PLAN.md` §3 for the full explanation.
 */
export function detectDisappearedVideoIds(
  previousVideoIds: readonly string[],
  currentVideoIds: readonly string[]
): string[] {
  const currentSet = new Set(currentVideoIds);
  return previousVideoIds.filter((id) => !currentSet.has(id));
}
