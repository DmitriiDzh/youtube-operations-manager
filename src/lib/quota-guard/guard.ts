import {
  QUOTA_SAFETY_MARGIN_UNITS,
  UNITS_PER_WRITTEN_VIDEO,
  type GuardVerdict,
  type QuotaSnapshot,
} from "./contracts";

/** Units left that a write run may spend: limit - used - not-yet-reflected local calls - the safety margin; never negative. */
export function remainingWriteUnits(snapshot: Extract<QuotaSnapshot, { known: true }>): number {
  return Math.max(0, snapshot.limit - snapshot.used - snapshot.recentLocalUnits - QUOTA_SAFETY_MARGIN_UNITS);
}

/** How many whole videos fit into `remainingUnits`. */
export function videosThatFit(remainingUnits: number): number {
  return Math.floor(Math.max(0, remainingUnits) / UNITS_PER_WRITTEN_VIDEO);
}

/**
 * The pre-flight verdict for a write run of `videos` videos (BL-117 slice 2). Allowed when the estimate is within what is
 * left -- equal counts as allowed, one unit over is not. When the quota cannot be read (Cloud not connected or the lookup
 * failed) the verdict is `unknown`, which the caller must surface (never silently allow or silently block).
 */
export function evaluateWriteRun(videos: number, snapshot: QuotaSnapshot): GuardVerdict {
  const estimatedUnits = Math.max(0, videos) * UNITS_PER_WRITTEN_VIDEO;
  if (!snapshot.known) return { decision: "unknown", estimatedUnits, cloudConnected: snapshot.cloudConnected };

  const remainingUnits = remainingWriteUnits(snapshot);
  const fitVideos = videosThatFit(remainingUnits);
  if (estimatedUnits <= remainingUnits) return { decision: "allow", estimatedUnits, remainingUnits, fitVideos };
  return { decision: "insufficient", estimatedUnits, remainingUnits, fitVideos, resetsAt: snapshot.resetsAt };
}

/**
 * Background reads (automatic Analytics collection, Research collection) leave a reserve so writes keep headroom:
 * they are refused while the share of the limit still left (`limit - used`) is below `reservePercent`. An unknown
 * quota never blocks a background read (it cannot be judged, and it must not stop work because Cloud is not connected).
 */
export function backgroundReadAllowed(snapshot: QuotaSnapshot, reservePercent: number): boolean {
  if (!snapshot.known) return true;
  const left = Math.max(0, snapshot.limit - snapshot.used - snapshot.recentLocalUnits);
  return left * 100 >= snapshot.limit * reservePercent;
}
