import type { AnalyticsCore } from "@/lib/analytics";
import { isDomainError, type EvidenceReference, type EvidenceReferenceResolver } from "@/lib/decision-engine/contracts";
import type { MarketIntelligenceCore } from "@/lib/market-intelligence";

// Phase 10 slice 3 (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §4/§7) -- the ONE place in this
// codebase allowed to import BOTH `@/lib/decision-engine` and `@/lib/analytics`/
// `@/lib/market-intelligence`. `decision-engine/**` itself must never import either (AGENTS.md
// §M; PHASE_9_PLAN.md §5's own precedent for market-intelligence, applied here in the reverse
// dependency direction) -- verified mechanically by PHASE10-INV-03
// (`decision-engine-inventory.test.ts`). Deliberately OUTSIDE `decision-engine/`'s own directory
// (that test's `MODULE_ROOT`) so it can freely import both without tripping that scan, and kept
// outside the `[hypothesisId]/evidence/` route folder itself so it has its own `.test.ts` file
// (a route file's own logic in this codebase's established convention is thin HTTP glue only;
// this resolver is real decision logic, not glue, and advisor review flagged that the "sibling
// decision-engine routes have no route.test.ts" precedent does not excuse leaving THIS untested).
//
// Cores are constructor arguments, never module-level singletons -- this is what makes the
// module's own real existence-checking logic testable against fake cores, independent of the
// real route file (which supplies the real `createAnalyticsCore()`/`createMarketIntelligenceCore()`
// once, at module load, the same pattern already used by every other route in this app).
export function createRealEvidenceReferenceResolver(deps: {
  analyticsCore: Pick<AnalyticsCore, "listMetrics">;
  marketIntelligenceCore: Pick<MarketIntelligenceCore, "listChannelSnapshots" | "listVideoSnapshots" | "listTrendCandidates">;
}): EvidenceReferenceResolver {
  return {
    async resolve(reference: EvidenceReference, ctx: { userId: string | null | undefined }): Promise<boolean> {
      if (!ctx.userId) return false;
      switch (reference.sourceType) {
        case "phase8_metric": {
          // `listMetrics` already enforces `channelAccess.assertActiveChannel` internally (its own
          // full function body was read before relying on this, not just its schema -- see the
          // plan doc's mandatory-reading paragraph). A genuine access failure (`CHANNEL_NOT_ACTIVE`)
          // is a real error, not "the metric doesn't exist" -- it is allowed to propagate up to the
          // route's own DomainError handling, never swallowed into a misleading `false`.
          const result = await deps.analyticsCore.listMetrics({
            credentialRef: { userId: ctx.userId },
            channelId: reference.channelId,
            videoId: reference.videoId,
            metricNames: [reference.metricName],
            startDate: reference.metricDate,
            endDate: reference.metricDate,
          });
          return result.rows.some((row) => row.metricDate === reference.metricDate && row.metricName === reference.metricName);
        }
        case "phase9_channel_snapshot": {
          return resolveMarketIntelligenceReference(() =>
            deps.marketIntelligenceCore
              .listChannelSnapshots({ researchChannelId: reference.researchChannelId })
              .then((result) => result.snapshots.some((snapshot) => snapshot.snapshotId === reference.snapshotId))
          );
        }
        case "phase9_video_snapshot": {
          return resolveMarketIntelligenceReference(() =>
            deps.marketIntelligenceCore
              .listVideoSnapshots({ researchChannelId: reference.researchChannelId })
              .then((result) => result.snapshots.some((snapshot) => snapshot.snapshotId === reference.snapshotId))
          );
        }
        case "phase9_trend_candidate": {
          const result = await deps.marketIntelligenceCore.listTrendCandidates();
          return result.trendCandidates.some((candidate) => candidate.trendCandidateId === reference.trendCandidateId);
        }
      }
    },

    // Phase 10 slice 4 -- caller must have already called `resolve` and gotten `true`; this does
    // its own fetch (mirroring `resolve`'s own per-reference-type shape) rather than threading a
    // fetched row through, keeping both methods independently simple and testable.
    async describe(reference: EvidenceReference, ctx: { userId: string | null | undefined }): Promise<string> {
      switch (reference.sourceType) {
        case "phase8_metric": {
          if (!ctx.userId) return `Video ${reference.videoId}: ${reference.metricName} on ${reference.metricDate} (unavailable)`;
          const result = await deps.analyticsCore.listMetrics({
            credentialRef: { userId: ctx.userId },
            channelId: reference.channelId,
            videoId: reference.videoId,
            metricNames: [reference.metricName],
            startDate: reference.metricDate,
            endDate: reference.metricDate,
          });
          const row = result.rows.find((r) => r.metricDate === reference.metricDate && r.metricName === reference.metricName);
          return row
            ? `Video ${reference.videoId}: ${reference.metricName} = ${row.metricValue} on ${reference.metricDate}`
            : `Video ${reference.videoId}: ${reference.metricName} on ${reference.metricDate} (no longer available)`;
        }
        case "phase9_channel_snapshot": {
          const result = await deps.marketIntelligenceCore.listChannelSnapshots({ researchChannelId: reference.researchChannelId });
          const snapshot = result.snapshots.find((s) => s.snapshotId === reference.snapshotId);
          return snapshot
            ? `Channel ${reference.researchChannelId} snapshot (${snapshot.observedAt}): ${snapshot.subscriberCount ?? "?"} subscribers, ${snapshot.viewCount ?? "?"} views, ${snapshot.videoCount ?? "?"} videos`
            : `Channel ${reference.researchChannelId} snapshot (no longer available)`;
        }
        case "phase9_video_snapshot": {
          const result = await deps.marketIntelligenceCore.listVideoSnapshots({ researchChannelId: reference.researchChannelId });
          const snapshot = result.snapshots.find((s) => s.snapshotId === reference.snapshotId);
          return snapshot
            ? `Video "${snapshot.title ?? snapshot.videoId}" snapshot (${snapshot.observedAt}): ${snapshot.viewCount ?? "?"} views, ${snapshot.likeCount ?? "?"} likes`
            : `Video snapshot (no longer available)`;
        }
        case "phase9_trend_candidate": {
          const result = await deps.marketIntelligenceCore.listTrendCandidates();
          const candidate = result.trendCandidates.find((c) => c.trendCandidateId === reference.trendCandidateId);
          return candidate
            ? `Trend candidate "${candidate.title}" (status: ${candidate.status}, first observed ${candidate.firstObservedAt})`
            : `Trend candidate (no longer available)`;
        }
      }
    },
  };
}

/**
 * `listChannelSnapshots`/`listVideoSnapshots` throw `RESEARCH_CHANNEL_NOT_AVAILABLE` (a
 * market-intelligence-specific code) when `researchChannelId` isn't actually on the watchlist --
 * that is exactly "this reference doesn't point at anything real," the same conceptual outcome as
 * a snapshot id that isn't in the list, not a distinct error condition the caller needs to see.
 * Caught here and folded into the same `false` (docs/roadmap/plans/PHASE_10_SLICE_3_PLAN.md §3's
 * own "a reference that fails validation is rejected -- never stored half-valid" contract, which
 * this resolver keeps to a single boolean outcome) -- any OTHER error (a real bug, a genuine
 * infrastructure failure) still propagates, never silently swallowed.
 */
async function resolveMarketIntelligenceReference(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch (error) {
    if (isDomainError(error) && error.code === "RESEARCH_CHANNEL_NOT_AVAILABLE") return false;
    throw error;
  }
}
