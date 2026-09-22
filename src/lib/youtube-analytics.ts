// Phase 8 (Intelligence Foundation), BL-052 (docs/roadmap/plans/PHASE_8_PLAN.md §6 slice 3).
// The single low-level wrapper for the YouTube Analytics API (`google.youtubeAnalytics`), the
// same role src/lib/youtube.ts plays for the YouTube Data API v3 -- kept as its own file rather
// than added to youtube.ts because these are two structurally distinct Google API products with
// their own client namespace (`youtubeAnalytics_v2.Youtubeanalytics`, not `youtube_v3.Youtube`)
// and their own OAuth scope (YOUTUBE_ANALYTICS_READ_SCOPE, never YOUTUBE_READ_SCOPE). Read-only:
// there is no mutating method on this API surface for this app to ever call, so there is nothing
// here for src/lib/youtube-write-gateway/ to own.
import { google } from "googleapis";
import type { youtubeAnalytics_v2 } from "googleapis";

export function createYoutubeAnalyticsClient(
  auth: youtubeAnalytics_v2.Options["auth"]
): youtubeAnalytics_v2.Youtubeanalytics {
  return google.youtubeAnalytics({ version: "v2", auth });
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

  const columnHeaders = res.data.columnHeaders ?? [];
  const dayColumnIndex = columnHeaders.findIndex(
    (header) => header.columnType === "DIMENSION" && header.name === "day"
  );
  const metricColumns = columnHeaders
    .map((header, index) => ({ index, name: header.name ?? null }))
    .filter((entry) => columnHeaders[entry.index]?.columnType === "METRIC" && entry.name !== null);

  const rows = res.data.rows ?? [];
  if (rows.length > 0 && dayColumnIndex < 0) {
    // A response with data rows but no `day` DIMENSION column means the request/response
    // contract is not what this function assumes -- fail loudly rather than emit rows with a
    // blank metric_date (an empty primary-key component is exactly the "blank means something"
    // failure class AGENTS.md §F treats as a real bug, never a value to silently default).
    throw new Error(
      "queryVideoAnalyticsReport: response has rows but no 'day' DIMENSION column in columnHeaders"
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
