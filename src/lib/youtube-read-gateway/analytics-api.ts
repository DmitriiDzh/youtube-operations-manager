// Phase 8 (Intelligence Foundation), BL-057 (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 3).
// The single low-level wrapper for the YouTube Analytics API (`google.youtubeAnalytics`) --
// this gateway's second read-category child (folded in 2026-09-22 from the standalone
// `src/lib/youtube-analytics.ts`, completing `docs/decisions/0007-youtube-read-gateway.md`'s
// own deferred follow-up). Kept as its own file rather than merged into `data-api.ts` because
// these are two structurally distinct Google API products with their own client namespace
// (`youtubeAnalytics_v2.Youtubeanalytics`, not `youtube_v3.Youtube`) and their own OAuth scope
// (YOUTUBE_ANALYTICS_READ_SCOPE, never YOUTUBE_READ_SCOPE). Read-only: there is no mutating
// method on this API surface for this app to ever call, so there is nothing here for
// `src/lib/youtube-write-gateway/` to own.
import { google } from "googleapis";
import type { youtubeAnalytics_v2 } from "googleapis";
import { getAnalyticsReadsEnabled, recordGatewayCallOutcome } from "../db";
import { DomainError } from "../video-metadata/contracts";
import { wrapYoutubeClientForQuotaClassification } from "./error-classification";

/**
 * "Analytics API reads enabled" toggle -- the Analytics-category counterpart to
 * `assertDataApiReadsAuthorized` (`data-api.ts`, see its own doc comment and
 * `src/lib/db.ts`'s `getAnalyticsReadsEnabled` for the full rationale).
 */
export async function assertAnalyticsReadsAuthorized(): Promise<void> {
  if (await getAnalyticsReadsEnabled()) {
    await recordGatewayCallOutcome("analytics_reads", "allowed");
    return;
  }

  await recordGatewayCallOutcome("analytics_reads", "blocked");
  throw new DomainError({
    code: "analytics_reads_disabled",
    message:
      "YouTube Analytics API reads are disabled -- the Settings tab's \"Analytics reads\" toggle is off.",
  });
}

/**
 * The single choke point every Analytics API read passes through to get a client -- see
 * `data-api.ts`'s `createYoutubeClient` for why the check lives inside the client
 * constructor itself rather than requiring each caller to remember it.
 */
export async function createYoutubeAnalyticsClient(
  auth: youtubeAnalytics_v2.Options["auth"]
): Promise<youtubeAnalytics_v2.Youtubeanalytics> {
  await assertAnalyticsReadsAuthorized();
  return wrapYoutubeClientForQuotaClassification(google.youtubeAnalytics({ version: "v2", auth }));
}

export type VideoAnalyticsMetricRow = {
  /**
   * The `day` dimension value exactly as the API returned it (`YYYY-MM-DD`). This is a
   * **Pacific-Time** reporting day, not the caller's local calendar day -- never converted here,
   * never assumed to match any particular timezone (docs/roadmap/plans/PHASE_8_PLAN.md §10 item 4).
   */
  date: string;
  /** Keyed by the exact metric name the API returned in `columnHeaders` (e.g. "views"). */
  metrics: Record<string, number>;
};

/**
 * Shared response parser for `reports.query`, used by both the per-video report above and the
 * channel-level report below -- both return the identical `day`-dimension-plus-metrics shape,
 * name-based column lookup for the same reason `queryVideoAnalyticsReport`'s own doc comment
 * explains (never trust positional column ordering, even though the API documents it).
 */
function parseDayDimensionReport(data: {
  columnHeaders?: Array<{ name?: string | null; columnType?: string | null }> | null;
  rows?: unknown[][] | null;
}): VideoAnalyticsMetricRow[] {
  const columnHeaders = data.columnHeaders ?? [];
  const dayColumnIndex = columnHeaders.findIndex(
    (header) => header.columnType === "DIMENSION" && header.name === "day"
  );
  const metricColumns = columnHeaders
    .map((header, index) => ({ index, name: header.name ?? null }))
    .filter((entry) => columnHeaders[entry.index]?.columnType === "METRIC" && entry.name !== null);

  const rows = data.rows ?? [];
  if (rows.length > 0 && dayColumnIndex < 0) {
    throw new Error(
      "parseDayDimensionReport: response has rows but no 'day' DIMENSION column in columnHeaders"
    );
  }

  return rows.map((row) => {
    const date = String(row[dayColumnIndex]);
    const metrics: Record<string, number> = {};

    for (const column of metricColumns) {
      const raw = row[column.index];
      const value = typeof raw === "number" ? raw : Number(raw);
      if (column.name && Number.isFinite(value)) {
        metrics[column.name] = value;
      }
    }

    return { date, metrics };
  });
}

/**
 * Fetches daily metrics for a single video over a date range, in one `reports.query` call
 * covering every requested metric name in one response (docs/roadmap/plans/PHASE_8_PLAN.md §10
 * item 5 -- one query per video per collection run, not per video per day per metric). **This
 * per-video shape is confirmed required, not merely provisional (2026-09-22, live-verified):** a
 * real `dimensions=video,day` query with no `filters=video==...` (the hypothesized bulk
 * alternative) was tried against the live API and rejected outright -- "The query is not
 * supported." One query per video is the only shape the API accepts for this report; this is not
 * a missed optimization.
 *
 * Response parsing is deliberately **name-based, not positional**: `columnHeaders` is grouped by
 * `columnType` ("DIMENSION" for `day`, "METRIC" for every requested metric) rather than assuming
 * column 0 is always `day` -- the official API type definitions (`youtubeAnalytics_v2.Schema
 * $ResultTableColumnHeader`, part of `googleapis`'s own shipped types, not assumed) document the
 * response ordering as "dimensions ... followed by ... metrics, matching the request order," but
 * name-based lookup costs nothing and is strictly safer than trusting that ordering blindly.
 *
 * A metric name the API rejects (e.g. a typo, or one requiring a scope this app was never granted)
 * fails the **entire** call with a thrown error from `reports.query` itself -- the API does not
 * partially succeed a request with a mix of valid/invalid metric names. Splitting a requested
 * metric list to isolate a bad name, or maintaining a known-good subset, is a services-layer
 * concern (this function's caller), not this wrapper's.
 */
export async function queryVideoAnalyticsReport(
  youtubeAnalytics: youtubeAnalytics_v2.Youtubeanalytics,
  args: {
    channelId: string;
    videoId: string;
    startDate: string;
    endDate: string;
    metricNames: readonly string[];
  }
): Promise<VideoAnalyticsMetricRow[]> {
  const res = await youtubeAnalytics.reports.query({
    ids: `channel==${args.channelId}`,
    startDate: args.startDate,
    endDate: args.endDate,
    metrics: args.metricNames.join(","),
    dimensions: "day",
    filters: `video==${args.videoId}`,
  });

  return parseDayDimensionReport(res.data);
}

export type ChannelBreakdownRow = {
  /** One value per requested dimension, in request order (e.g. `["age35-44", "female"]` for
   * `dimensions: "ageGroup,gender"`). */
  dimensionValues: string[];
  /** Keyed by the exact metric name the API returned in `columnHeaders`. */
  metrics: Record<string, number>;
};

/**
 * Fetches a channel-level breakdown report for one or more non-`day` dimensions over a date range
 * (e.g. `insightTrafficSourceType`, `deviceType`, `ageGroup,gender`, `country`, `subscribedStatus`,
 * `creatorContentType`) -- Studio-Parity deep-parity plan
 * (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §1's own cross-cutting note: one new
 * function per new dimension shape needed, reused by every slice that needs it, never one bespoke
 * function per dimension). All six of the dimensions above share this identical request/response
 * shape (a single date range, no `day` granularity, one row per distinct dimension-value
 * combination) -- confirmed against real responses for every one of them (BL-093/BL-094 live
 * probe, 2026-09-25) before this function was written, not assumed from documentation alone.
 *
 * Deliberately a separate function from `queryChannelAnalyticsReport` above rather than a
 * `dimensions` parameter added to it: that function's `parseDayDimensionReport` return shape
 * (`{ date, metrics }`) is specific to a `day` dimension and used by callers (`collectMetrics`)
 * that genuinely need date-keyed rows; this one's callers need dimension-value-keyed rows instead,
 * and the two response shapes should not be forced into one type.
 */
export async function queryChannelBreakdownReport(
  youtubeAnalytics: youtubeAnalytics_v2.Youtubeanalytics,
  args: {
    channelId: string;
    startDate: string;
    endDate: string;
    dimensions: string;
    metricNames: readonly string[];
  }
): Promise<ChannelBreakdownRow[]> {
  const res = await youtubeAnalytics.reports.query({
    ids: `channel==${args.channelId}`,
    startDate: args.startDate,
    endDate: args.endDate,
    metrics: args.metricNames.join(","),
    dimensions: args.dimensions,
  });

  const columnHeaders = res.data.columnHeaders ?? [];
  const dimensionColumns = columnHeaders
    .map((header, index) => ({ index, name: header.name ?? null }))
    .filter((entry) => columnHeaders[entry.index]?.columnType === "DIMENSION");
  const metricColumns = columnHeaders
    .map((header, index) => ({ index, name: header.name ?? null }))
    .filter((entry) => columnHeaders[entry.index]?.columnType === "METRIC" && entry.name !== null);

  const rows = res.data.rows ?? [];
  return rows.map((row) => {
    const dimensionValues = dimensionColumns.map((column) => String(row[column.index]));
    const metrics: Record<string, number> = {};
    for (const column of metricColumns) {
      const raw = row[column.index];
      const value = typeof raw === "number" ? raw : Number(raw);
      if (column.name && Number.isFinite(value)) {
        metrics[column.name] = value;
      }
    }
    return { dimensionValues, metrics };
  });
}

/**
 * Fetches daily metrics for the whole channel over a date range -- no `filters=video==...`.
 * Studio-Parity S6b (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4, Analytics "Overview" tab):
 * needed so channel-level totals (views/watch-time/subscribers) don't have to be approximated by
 * summing `queryVideoAnalyticsReport` over every synced video, which would silently miss any
 * subscriber/view activity not attributable to a currently-synced video (e.g. a deleted video, or
 * subscribers gained from the channel page itself).
 *
 * **Live-verified 2026-09-23** against a real channel via a throwaway diagnostic route (never
 * committed), the same technique BL-057 used to settle the per-video-vs-bulk question: a
 * `dimensions=day` query with `ids=channel==<id>` and no `filters` is accepted by the real API and
 * returns real per-day channel totals -- confirmed against the "Tropico Jazz" channel's own real
 * response. This is the channel-level counterpart BL-057 did not test (that round only tried
 * dropping the video filter from a *multi-video* `dimensions=video,day` query, which the API
 * rejected; a true channel-level `dimensions=day` report is a different, valid report shape).
 */
export async function queryChannelAnalyticsReport(
  youtubeAnalytics: youtubeAnalytics_v2.Youtubeanalytics,
  args: {
    channelId: string;
    startDate: string;
    endDate: string;
    metricNames: readonly string[];
  }
): Promise<VideoAnalyticsMetricRow[]> {
  const res = await youtubeAnalytics.reports.query({
    ids: `channel==${args.channelId}`,
    startDate: args.startDate,
    endDate: args.endDate,
    metrics: args.metricNames.join(","),
    dimensions: "day",
  });

  return parseDayDimensionReport(res.data);
}
