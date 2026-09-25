import { DomainError, isDomainError, type DomainErrorCode, type DomainErrorShape } from "@/lib/video-metadata/contracts";

export type { DomainErrorCode, DomainErrorShape };
export { DomainError, isDomainError };

/**
 * Phase 7 slice K (owner spec §10, "Comparable-content context" -- `find_comparable_videos`).
 * Anchor-based: every query is relative to one already-synced video on the requesting channel.
 * Local reads only -- never a live YouTube call (this reuses the already-synced channel/video
 * mirror and already-collected analytics, AGENTS.md §D).
 *
 * Deliberately NOT supported (owner spec §10 lists these as "possible filters," not required
 * ones; no data source exists for any of them in this application, and none is approximated):
 * "same content family," "similar target audience," "similar metadata pattern." Never silently
 * ignored -- stated explicitly in this capability's own description (`AGENT_CAPABILITIES`).
 */

export const COMPARABLE_VIDEOS_SORT_MODES = [
  "publicationProximity",
  "durationProximity",
  "performanceMetric",
  "titleTokenOverlap",
] as const;
export type ComparableVideosSortMode = (typeof COMPARABLE_VIDEOS_SORT_MODES)[number];

export const PERFORMANCE_THRESHOLD_OPERATORS = [">=", "<="] as const;
export type PerformanceThresholdOperator = (typeof PERFORMANCE_THRESHOLD_OPERATORS)[number];

export type FindComparableVideosInput = {
  channelId: string;
  anchorVideoId: string;
  /** Only required (used) when `performanceMetric` is set -- forwarded unchanged into the
   * existing `analyticsCore.listMetrics` (AGENTS.md §D), mirroring slice C's own
   * `queryVideoAnalytics`/`queryChannelAnalytics` convention of taking a caller-resolved
   * `credentialRef` directly in the input rather than resolving one itself. */
  credentialRef?: { userId: string } | { accessToken: string; refreshToken?: string; tokenExpiry?: number; scope?: string };
  /** Excludes a candidate whose `publishedAt` is more than this many days from the anchor's own
   * `publishedAt`, in either direction. Omitted: no publication-date filtering. */
  publicationWindowDays?: number;
  /** Excludes a candidate whose `durationSeconds` differs from the anchor's own by more than this
   * many seconds. Requires the anchor itself to have a known `durationSeconds` (owner spec §9:
   * never fabricate a comparison against unknown data) -- otherwise the whole request fails with
   * `INVALID_CONTEXT_REQUEST`, not a silently empty result. A candidate with no known duration is
   * excluded and counted in `excludedForMissingData.duration`, never treated as "0 duration" or
   * "infinitely close." */
  durationToleranceSeconds?: number;
  /** Must be one of `CUMULATIVE_COMPARISON_METRIC_NAMES` (`src/lib/analytics/comparable-age.ts`)
   * -- required if `sort` is `"performanceMetric"`, or if `performanceThreshold` is given. */
  performanceMetric?: string;
  /** Requires `performanceMetric` to also be set. Evaluated AGE-ALIGNED: both the anchor and
   * every candidate are compared at the SAME number of days-since-publish -- the last day of
   * CONTIGUOUS coverage the ANCHOR's own collected data reaches, counting from day 0
   * (`computeComparableAgeSeries`'s own documented behavior: a single day the Analytics API
   * silently omitted anywhere before that point collapses this to right before the gap; never the
   * anchor's current wall-clock age, since analytics collection intentionally never reaches
   * "today" and a recently-published anchor's current age would usually have no data at all yet),
   * capped at 365 days, reusing the existing Phase 8 comparable-age logic
   * (`computeComparableAgeSeries`) rather than a second, parallel age-alignment implementation
   * (AGENTS.md §D). A candidate with no analytics coverage at that exact day is excluded and
   * counted in `excludedForMissingData.performance`, never given a fabricated `0`/failing value. */
  performanceThreshold?: { operator: PerformanceThresholdOperator; value: number };
  /** Never a single hard-coded "best match" score (owner spec §10: "do not hard-code a single
   * comparison algorithm") -- an explicit, named sort mode. Every candidate's response row always
   * reports the raw comparison facts regardless of which mode was requested. */
  sort: ComparableVideosSortMode;
  /** Capped at `MAX_COMPARABLE_VIDEOS_LIMIT`; a request exceeding it is silently capped, with
   * `truncated: true` reported, never an unbounded response (owner spec §23). */
  limit?: number;
};

export type ComparableVideoCandidate = {
  videoId: string;
  title: string;
  publishedAt: string;
  /** FACT: whole calendar days between the candidate's and the anchor's own `publishedAt`
   * (Pacific-Time calendar dates, same convention `comparable-age.ts` already uses), always
   * non-negative (a distance, not a signed offset). */
  publicationDistanceDays: number;
  /** FACT, `null` if never synced (owner spec §9: never a fabricated `0`). */
  durationSeconds: number | null;
  /** DERIVED: `|anchor.durationSeconds - durationSeconds|`. `null` if either side is `null`. */
  durationDistanceSeconds: number | null;
  /** DERIVED, from already-collected local analytics, age-aligned against the last day of
   * CONTIGUOUS coverage the anchor's own data reaches (see `performanceThreshold`'s own doc
   * comment above -- never the anchor's current wall-clock age). `null` if `performanceMetric` was
   * not requested, or if this candidate has no analytics coverage at the comparison day (never a
   * fabricated `0`). Note: `performanceThreshold` is an ABSOLUTE `{operator, value}` comparison,
   * never a comparison against the anchor's own value -- so a candidate can pass or fail the
   * threshold independently of whatever the anchor's own `performanceMetricValue` turns out to
   * be. */
  performanceMetricValue: number | null;
  /** DERIVED: title words (case-insensitive, punctuation-stripped, common English stopwords
   * removed) shared with the anchor's own title -- an explicit, inspectable signal, never framed
   * as semantic "topic similarity" (owner spec §10 forbids embeddings/vector search for a first
   * implementation; this is neither). */
  sharedTitleTokens: string[];
};

export type FindComparableVideosAnchor = {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number | null;
  /** The anchor's own cumulative metric value at `performanceAlignment.dayOffset` -- informational
   * context for interpreting each candidate's own value, NOT something candidates are filtered or
   * scored against (`performanceThreshold` is an absolute `{operator, value}` comparison, never
   * relative to this field). `null` if `performanceMetric` was not requested, or if the anchor has
   * no CONTIGUOUS coverage reaching `performanceAlignment.dayOffset` -- which includes both "no
   * data at all yet" (a brand-new anchor) AND "has real data at later days, but day 0 itself was
   * never collected" (a common, non-error case for a video published before regular collection
   * began for its channel, `analytics_comparable_age`'s own tool description documents the same
   * situation) -- never a fabricated `0` either way. */
  performanceMetricValue: number | null;
};

export type FindComparableVideosResult = {
  anchorVideoId: string;
  /** The anchor's own facts, so a caller never has to make a second call to interpret candidates'
   * DERIVED distance/comparison fields (owner spec §9's "every result must include metric
   * definitions" and AC-CMP-06's "report the raw comparison facts" both require the reference
   * point itself to be visible, not just each candidate's distance from it). */
  anchor: FindComparableVideosAnchor;
  /** `null` unless `performanceMetric` was requested. `dayOffset` is the last day of CONTIGUOUS
   * coverage the ANCHOR's own collected data reaches, counting from day 0 (see
   * `FindComparableVideosInput.performanceThreshold`'s own doc comment for why "contiguous," and
   * why never the anchor's current wall-clock age), capped at 365 and at the anchor's real elapsed
   * age. The single day every candidate's `performanceMetricValue` (and the anchor's own, above)
   * was evaluated at. */
  performanceAlignment: { metricName: string; dayOffset: number } | null;
  candidates: ComparableVideoCandidate[];
  /** Never a silently shrunk result set -- every filter-driven exclusion due to a candidate
   * lacking the data a requested filter needs is counted here, separate from ordinary filter
   * non-matches. */
  excludedForMissingData: { duration: number; performance: number };
  truncated: boolean;
};
