import {
  DomainError,
  isDomainError,
  parseWithSchema,
  formatZodError,
  type DomainErrorCode,
  type DomainErrorShape,
} from "@/lib/video-metadata/contracts";
import type { AssetReferenceKind, AssetType } from "@/lib/asset-catalog";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError, parseWithSchema, formatZodError };

/**
 * Phase 7 slice L (owner spec §16, "Performance ↔ asset linkage"). Joins the existing asset
 * catalog (`creative_assets.linkedVideoId` -- "this asset was used on this video," an
 * operator/agent-asserted association this application never verifies against YouTube) against
 * each linked video's own already-collected performance data. Local reads only -- never a live
 * YouTube call (reuses `asset-catalog`'s and the channel/video sync mirror's own already-tested
 * reads, AGENTS.md §D).
 *
 * Deliberately NOT supported (see `docs/acceptance/PHASE_7_ACCEPTANCE.md` §5 for the full
 * reasoning against owner spec §16's own text):
 * - Thumbnail-CTR/impressions-based questions ("which thumbnails were used by high-CTR videos")
 *   -- this application's own analytics collection never fetches YouTube's `impressions`/
 *   `impressionClickThroughRate` metrics at all; no such data exists anywhere in this application
 *   to expose, and it is never approximated via `cardClickRate`/`annotationClickThroughRate`
 *   (an entirely different signal).
 * - `metadata/version` linkage -- `linkedVideoId` has no time range and is never independently
 *   verified (a thumbnail may have been swapped since the association was recorded).
 * - `experiment/outcome` linkage -- belongs to Phase 10 (the Experiment Engine), which doesn't
 *   exist yet.
 * - Content Proposal reference associations (`content_proposal_artifacts`, a proposal's own
 *   `referenceAssetIds`/`referenceVideoIds`) -- a structurally DIFFERENT relationship (draft,
 *   unactioned reference/inspiration material a proposal cites, never "this asset was actually
 *   used on this video"). This capability reads only `creative_assets.linkedVideoId`, never
 *   `content_proposal_artifacts` or any proposal field.
 */

export const ASSET_PERFORMANCE_SORT_MODES = ["linkedVideoPublicationDate", "lifetimeViewCount", "performanceMetric"] as const;
export type AssetPerformanceSortMode = (typeof ASSET_PERFORMANCE_SORT_MODES)[number];

export type ListAssetPerformanceInput = {
  channelId: string;
  assetType?: AssetType;
  /** Only required (used) when `performanceMetric` is set -- forwarded unchanged into the
   * existing `analyticsCore.listMetrics` (AGENTS.md §D). */
  credentialRef?: { userId: string } | { accessToken: string; refreshToken?: string; tokenExpiry?: number; scope?: string };
  /** Must be one of `CUMULATIVE_COMPARISON_METRIC_NAMES` (`src/lib/analytics/comparable-age.ts`)
   * -- required together with `performanceDayOffset` (both or neither), never alone. */
  performanceMetric?: string;
  /** The exact day-since-publish every linked video's `ageAlignedPerformanceValue` is computed
   * at -- ALWAYS caller-supplied, NEVER derived from wall-clock "now" (the exact mistake
   * independent review found and fixed in slice K, round 1: deriving a comparison day from `now()`
   * makes it null for most videos on any real, established channel, since day-0 collection
   * coverage gaps are the common case this correction addresses generally). Bounded at schema
   * level (see `schemas.ts`) purely for input-sanity symmetry with slice K's own numeric day-count
   * fields (`publicationWindowDays`) -- not a functional necessity, since `getCumulativeValueAtDayOffset`
   * is already naturally bounded by a video's own actual collected date range regardless of how
   * large this value is. */
  performanceDayOffset?: number;
  /** Never a single hard-coded "best match" ranking -- an explicit, named sort mode. */
  sort?: AssetPerformanceSortMode;
  /** Capped at `MAX_ASSET_PERFORMANCE_LIMIT`; a request exceeding it is silently capped, with
   * `truncated: true` reported -- NEVER rejected as invalid (the exact mistake independent review
   * found and fixed in slice K, round 3). */
  limit?: number;
};

export type AssetPerformanceLinkedVideo = {
  videoId: string;
  title: string;
  publishedAt: string;
  /** Lifetime totals, already synced for every video (schema v4/v19) -- FACT, `null` if never
   * synced (owner spec §9: never a fabricated `0`). Explicitly NOT age-fair: an older video has
   * simply had more time to accumulate views than a newer one -- sorting by this field alone
   * structurally favors older videos, never a "which performed better" signal by itself. */
  lifetimeViewCount: number | null;
  lifetimeLikeCount: number | null;
  lifetimeCommentCount: number | null;
  durationSeconds: number | null;
  /** When these lifetime counters were last refreshed by a channel sync (`videos.lastSyncedAt`).
   * NOT the same thing as the agent-operations wrapper's own `freshness.asOf` (the timestamp of
   * this API call itself, only present when `performanceMetric` is requested) -- neither field
   * reports actual per-date analytics collection coverage; that is only available via the
   * separate `analytics_data_quality` tool. Lets a caller judge how current the lifetime totals
   * are, independent of whether a performance metric was requested at all. */
  lifetimeCountersAsOf: string;
  /** DERIVED, age-aligned at `performanceAlignment.dayOffset` (reusing
   * `getCumulativeValueAtDayOffset`, AGENTS.md §D) -- `null` if `performanceMetric` was not
   * requested, or if this video has no contiguous coverage reaching that exact day (never a
   * fabricated `0`). This is a JOIN field, not a filter -- a `null` value never excludes the row. */
  ageAlignedPerformanceValue: number | null;
};

export type AssetPerformanceEntry = {
  assetId: string;
  assetType: AssetType;
  title: string | null;
  referenceKind: AssetReferenceKind;
  referenceValue: string;
  linkedVideo: AssetPerformanceLinkedVideo;
};

export type ListAssetPerformanceResult = {
  assets: AssetPerformanceEntry[];
  /** `null` unless `performanceMetric`/`performanceDayOffset` were both requested. */
  performanceAlignment: { metricName: string; dayOffset: number } | null;
  /**
   * Never a silently shrunk result set -- every asset excluded because its OWN link is invalid
   * (not because of any performance data) is counted here. Only two reasons, not three: this
   * capability's own video read is already channel-scoped (`listVideosByChannel(channelId)`), so
   * it cannot structurally distinguish "linkedVideoId was never synced at all" from "linkedVideoId
   * belongs to a different channel" -- both look identical (absent from this channel's own video
   * list) from inside a channel-scoped read, and asset registration (`asset-catalog`'s own
   * `registerAsset`) already validates `linkedVideoId` against the SAME channel at write time, so
   * a genuine cross-channel link should not normally occur in the first place. Distinguishing them
   * would require a second, cross-channel read this capability deliberately does not perform.
   */
  excludedForMissingLink: { unlinked: number; linkedVideoNotOnChannel: number };
  truncated: boolean;
};
