import { DomainError } from "./contracts";
import type { ComparableVideoCandidate, FindComparableVideosResult } from "./contracts";
import {
  findComparableVideosInputSchema,
  findComparableVideosOutputSchema,
  parseWithSchema,
  DEFAULT_COMPARABLE_VIDEOS_LIMIT,
  MAX_COMPARABLE_VIDEOS_LIMIT,
} from "./schemas";
import {
  computeComparableAgeSeries,
  diffCalendarDays,
  getCumulativeValueAtDayOffset,
  toPacificCalendarDate,
} from "@/lib/analytics/comparable-age";

const MAX_PERFORMANCE_AGE_ALIGNMENT_DAYS = 365;

// Deliberately tiny and English-only -- a "simple ranking" heuristic (owner spec §10), not an
// attempt at real NLP. Removing a handful of the most common words keeps `sharedTitleTokens` from
// being dominated by words with no real distinguishing signal, without pretending to understand
// language.
const TITLE_STOPWORDS = new Set([
  "a", "an", "the", "of", "and", "or", "to", "in", "on", "for", "with", "is", "are", "at", "by",
]);

function tokenizeTitle(title: string): Set<string> {
  // Unicode-aware split (\p{L}/\p{N}, not a-z0-9) -- this application's own localization focus
  // means non-Latin titles (Cyrillic, etc.) are a realistic case, not an edge case to ignore.
  const tokens = title
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length > 1 && !TITLE_STOPWORDS.has(token));
  return new Set(tokens);
}

function sharedTokens(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((token) => b.has(token)).sort();
}

export type VideoRecordForComparison = {
  videoId: string;
  title: string;
  publishedAt: string;
  durationSeconds: number | null;
};

export type ServiceDependencies = {
  listVideosByChannel(channelId: string): Promise<VideoRecordForComparison[]>;
  /** Forwards straight into `analyticsCore.listMetrics` unchanged (AGENTS.md §D) -- only ever
   * called when `performanceMetric` was actually requested. */
  listMetrics(input: {
    credentialRef: unknown;
    channelId: string;
    metricNames: string[];
  }): Promise<{ channelId: string; rows: Array<{ videoId: string; metricDate: string; metricName: string; metricValue: number }> }>;
  now(): Date;
};

export function createComparableContentServices(deps: ServiceDependencies) {
  return {
    /**
     * Owner spec §10's `find_comparable_videos(...)`. Local reads only -- never a live YouTube
     * call. Not itself channel-scope-checked (mirrors slice B's convention: the MCP/CLI caller
     * checks `channelAccessCore.assertActiveChannel` before this is ever invoked).
     */
    async findComparableVideos(input: unknown): Promise<FindComparableVideosResult> {
      const parsedInput = parseWithSchema(findComparableVideosInputSchema, input, "find comparable videos input");

      const allVideos = await deps.listVideosByChannel(parsedInput.channelId);
      const anchor = allVideos.find((v) => v.videoId === parsedInput.anchorVideoId);
      if (!anchor) {
        throw new DomainError({
          code: "DATA_NOT_SYNCED",
          message: "anchorVideoId does not belong to the requested channel",
          details: { channelId: parsedInput.channelId, anchorVideoId: parsedInput.anchorVideoId },
        });
      }

      // Requiring `anchor.durationSeconds` isn't only about `durationToleranceSeconds` -- sorting
      // by `durationProximity` with an unknown anchor duration would compare every candidate's
      // `durationDistanceSeconds` as `null` (Infinity - Infinity = NaN in the comparator below;
      // Array.prototype.sort treats a NaN result as 0, i.e. "leave these two in their current
      // relative order" -- not a shuffle, but still a comparator that never actually compares by
      // duration while claiming to).
      if (
        (parsedInput.durationToleranceSeconds !== undefined || parsedInput.sort === "durationProximity") &&
        anchor.durationSeconds === null
      ) {
        throw new DomainError({
          code: "INVALID_CONTEXT_REQUEST",
          message: "durationToleranceSeconds/sort=durationProximity was requested, but the anchor video has no known durationSeconds",
          details: { anchorVideoId: parsedInput.anchorVideoId },
        });
      }

      // The anchor's own `publishedAt` is load-bearing for the whole request (every distance is
      // computed relative to it) -- a malformed value (found by independent review, round 3, as a
      // theoretical robustness gap: `videos.published_at` is NOT NULL but not empty-string-
      // constrained, and `youtube-read-gateway` persists `snippet.publishedAt ?? ""` if YouTube
      // ever omitted it) fails the whole request with a clear, typed error, never a generic
      // unhandled exception.
      let anchorPublishedPacific: string;
      try {
        anchorPublishedPacific = toPacificCalendarDate(anchor.publishedAt);
      } catch {
        throw new DomainError({
          code: "INVALID_CONTEXT_REQUEST",
          message: "anchor video has a malformed publishedAt timestamp and cannot be used for comparison",
          details: { anchorVideoId: parsedInput.anchorVideoId },
        });
      }

      // Only fetched when actually needed -- avoids a local-analytics read (and the credentialRef
      // this whole capability otherwise doesn't need) for the common title/date/duration-only case.
      let metricRowsByVideoId: Map<string, Array<{ metricDate: string; metricValue: number }>> | null = null;
      let ageAlignmentDays = 0;
      if (parsedInput.performanceMetric) {
        const metricsResult = await deps.listMetrics({
          credentialRef: parsedInput.credentialRef,
          channelId: parsedInput.channelId,
          metricNames: [parsedInput.performanceMetric],
        });
        metricRowsByVideoId = new Map();
        for (const row of metricsResult.rows) {
          if (row.metricName !== parsedInput.performanceMetric) continue;
          const existing = metricRowsByVideoId.get(row.videoId) ?? [];
          existing.push({ metricDate: row.metricDate, metricValue: row.metricValue });
          metricRowsByVideoId.set(row.videoId, existing);
        }

        // The alignment day is derived from how far the ANCHOR's own collected data actually
        // reaches -- never from wall-clock "now." Analytics collection intentionally never
        // reaches "today" (`staleness.ts`'s own default collection range ends at yesterday), and
        // `computeComparableAgeSeries` stops a cumulative series dead at the first missing day --
        // picking "the anchor's current age" as the alignment day would, for any recently
        // published anchor (the most natural real query), land on a day with no collected data
        // yet, making `anchor.performanceMetricValue` null and excluding most/all candidates for
        // exactly the scenario this filter exists for. Capped by the anchor's own real elapsed
        // age (so a data anomaly can never claim a day beyond "now") and by
        // MAX_PERFORMANCE_AGE_ALIGNMENT_DAYS, same as before.
        const nowPacific = toPacificCalendarDate(deps.now().toISOString());
        const maxPossibleAlignmentDays = Math.min(
          Math.max(diffCalendarDays(anchorPublishedPacific, nowPacific), 0),
          MAX_PERFORMANCE_AGE_ALIGNMENT_DAYS
        );
        const anchorRows = metricRowsByVideoId.get(anchor.videoId) ?? [];
        const anchorSeries = computeComparableAgeSeries({
          publishedAt: anchor.publishedAt,
          metricRows: anchorRows,
          maxDays: maxPossibleAlignmentDays,
        });
        const lastAnchorPoint = anchorSeries.cumulativePoints.at(-1);
        // No contiguous anchor coverage at all (not even day 0) -- degrade to comparing everyone
        // at day 0 rather than an arbitrary later day nobody has data for either.
        ageAlignmentDays = lastAnchorPoint ? lastAnchorPoint.dayOffset : 0;
      }

      function computePerformanceValue(videoId: string, publishedAt: string): number | null {
        if (!metricRowsByVideoId) return null;
        const rows = metricRowsByVideoId.get(videoId) ?? [];
        return getCumulativeValueAtDayOffset({ publishedAt, metricRows: rows, dayOffset: ageAlignmentDays });
      }

      const anchorTokens = tokenizeTitle(anchor.title);
      let excludedForMissingDataDuration = 0;
      let excludedForMissingDataPerformance = 0;

      const candidates: ComparableVideoCandidate[] = [];
      for (const video of allVideos) {
        if (video.videoId === anchor.videoId) continue;

        // A single video with a malformed `publishedAt` (see the anchor's own guard above for why
        // this can theoretically happen) is excluded from the comparison entirely, never allowed
        // to fail the whole request over one bad row -- unlike the anchor itself, a candidate is
        // not load-bearing for anyone else's comparison.
        let candidatePublishedPacific: string;
        try {
          candidatePublishedPacific = toPacificCalendarDate(video.publishedAt);
        } catch {
          continue;
        }

        const publicationDistanceDays = Math.abs(diffCalendarDays(anchorPublishedPacific, candidatePublishedPacific));
        if (parsedInput.publicationWindowDays !== undefined && publicationDistanceDays > parsedInput.publicationWindowDays) {
          continue;
        }

        let durationDistanceSeconds: number | null = null;
        if (video.durationSeconds !== null && anchor.durationSeconds !== null) {
          durationDistanceSeconds = Math.abs(anchor.durationSeconds - video.durationSeconds);
        }
        if (parsedInput.durationToleranceSeconds !== undefined) {
          if (video.durationSeconds === null) {
            excludedForMissingDataDuration += 1;
            continue;
          }
          if ((durationDistanceSeconds ?? Infinity) > parsedInput.durationToleranceSeconds) {
            continue;
          }
        }

        let performanceMetricValue: number | null = null;
        if (parsedInput.performanceMetric) {
          performanceMetricValue = computePerformanceValue(video.videoId, video.publishedAt);
          if (parsedInput.performanceThreshold) {
            if (performanceMetricValue === null) {
              excludedForMissingDataPerformance += 1;
              continue;
            }
            const { operator, value } = parsedInput.performanceThreshold;
            const passes = operator === ">=" ? performanceMetricValue >= value : performanceMetricValue <= value;
            if (!passes) continue;
          }
        }

        candidates.push({
          videoId: video.videoId,
          title: video.title,
          publishedAt: video.publishedAt,
          publicationDistanceDays,
          durationSeconds: video.durationSeconds,
          durationDistanceSeconds,
          performanceMetricValue,
          sharedTitleTokens: sharedTokens(anchorTokens, tokenizeTitle(video.title)),
        });
      }

      candidates.sort((a, b) => {
        switch (parsedInput.sort) {
          case "publicationProximity":
            return a.publicationDistanceDays - b.publicationDistanceDays;
          case "durationProximity": {
            const aVal = a.durationDistanceSeconds ?? Infinity;
            const bVal = b.durationDistanceSeconds ?? Infinity;
            return aVal - bVal;
          }
          case "performanceMetric": {
            const aVal = a.performanceMetricValue ?? -Infinity;
            const bVal = b.performanceMetricValue ?? -Infinity;
            return bVal - aVal;
          }
          case "titleTokenOverlap":
            return b.sharedTitleTokens.length - a.sharedTitleTokens.length;
          default:
            return 0;
        }
      });

      // Clamped, never rejected -- a caller-supplied `limit` above MAX_COMPARABLE_VIDEOS_LIMIT is
      // silently capped here (found by independent review, round 3: the schema used to reject it
      // outright as validation_failed, contradicting this capability's own documented "never an
      // unbounded response, always truncated" contract, AC-CMP-07).
      const requestedLimit = parsedInput.limit ?? DEFAULT_COMPARABLE_VIDEOS_LIMIT;
      const limit = Math.min(requestedLimit, MAX_COMPARABLE_VIDEOS_LIMIT);
      const truncated = candidates.length > limit;
      const limited = candidates.slice(0, limit);

      const anchorPerformanceMetricValue = parsedInput.performanceMetric
        ? computePerformanceValue(anchor.videoId, anchor.publishedAt)
        : null;

      return parseWithSchema(
        findComparableVideosOutputSchema,
        {
          anchorVideoId: anchor.videoId,
          anchor: {
            videoId: anchor.videoId,
            title: anchor.title,
            publishedAt: anchor.publishedAt,
            durationSeconds: anchor.durationSeconds,
            performanceMetricValue: anchorPerformanceMetricValue,
          },
          performanceAlignment: parsedInput.performanceMetric
            ? { metricName: parsedInput.performanceMetric, dayOffset: ageAlignmentDays }
            : null,
          candidates: limited,
          excludedForMissingData: { duration: excludedForMissingDataDuration, performance: excludedForMissingDataPerformance },
          truncated,
        },
        "find comparable videos output"
      );
    },
  };
}

export type ComparableContentServices = ReturnType<typeof createComparableContentServices>;
