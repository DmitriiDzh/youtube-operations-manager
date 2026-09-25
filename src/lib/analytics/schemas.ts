import { z, ZodError } from "zod";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
import { CUMULATIVE_COMPARISON_METRIC_NAMES } from "./comparable-age";
import { CHANNEL_BREAKDOWN_PRESETS, DomainError, type ChannelBreakdownKind } from "./contracts";

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(schema: z.ZodType<T>, payload: unknown, context: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new DomainError({
      code: "validation_failed",
      message: `Invalid ${context}`,
      details: formatZodError(parsed.error),
    });
  }

  return parsed.data;
}

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, YYYY-MM-DD");

export const collectMetricsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    // Optional -- defaults to ANALYTICS_METRIC_NAMES (services.ts) when omitted. Accepting an
    // explicit override keeps this collectible with a narrower metric set (e.g. a future manual
    // "collect now" UI that lets the operator pick a subset) without a schema change.
    metricNames: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const collectMetricsOutputSchema = z
  .object({
    channelId: z.string().min(1),
    startDate: z.string(),
    endDate: z.string(),
    videoCount: z.number().int().nonnegative(),
    upsertsIssued: z.number().int().nonnegative(),
    skippedVideoIds: z.array(z.string()),
  })
  .strict();

export type CollectMetricsInput = z.infer<typeof collectMetricsInputSchema>;
export type CollectMetricsOutput = z.infer<typeof collectMetricsOutputSchema>;

export const listMetricsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    // Optional filters, additive (2026-09-23, MCP/CLI analytics read tools) -- an unfiltered call
    // returns every collected row for the channel (3,700+ on a real, months-old channel), which is
    // fine for the Web UI's own always-local read but too large a default payload for an MCP tool
    // response. Applied in services.ts, in-memory, after the same single local store read every
    // caller already does -- no new store method, no query-shape change.
    startDate: isoDateSchema.optional(),
    endDate: isoDateSchema.optional(),
    videoId: z.string().min(1).optional(),
    metricNames: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const storedVideoMetricRowSchema = z
  .object({
    videoId: z.string().min(1),
    metricDate: z.string(),
    metricName: z.string(),
    metricValue: z.number(),
  })
  .strict();

export const listMetricsOutputSchema = z
  .object({
    channelId: z.string().min(1),
    rows: z.array(storedVideoMetricRowSchema),
  })
  .strict();

export type ListMetricsInput = z.infer<typeof listMetricsInputSchema>;
export type ListMetricsOutput = z.infer<typeof listMetricsOutputSchema>;

export const runAutoCollectionInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

export type RunAutoCollectionInput = z.infer<typeof runAutoCollectionInputSchema>;

export const runAutoCollectionOutputSchema = z.discriminatedUnion("ranCollection", [
  z.object({ ranCollection: z.literal(false) }).strict(),
  z.object({ ranCollection: z.literal(true), result: collectMetricsOutputSchema }).strict(),
]);

export type RunAutoCollectionOutput = z.infer<typeof runAutoCollectionOutputSchema>;

export const getChannelOverviewInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .strict();

const channelOverviewTotalsSchema = z
  .object({
    views: z.number(),
    estimatedMinutesWatched: z.number(),
    subscribersGained: z.number(),
    subscribersLost: z.number(),
  })
  .strict();

const channelOverviewDailyRowSchema = channelOverviewTotalsSchema.extend({
  date: z.string(),
});

export const getChannelOverviewOutputSchema = z
  .object({
    channelId: z.string().min(1),
    startDate: z.string(),
    endDate: z.string(),
    previousStartDate: z.string(),
    previousEndDate: z.string(),
    daily: z.array(channelOverviewDailyRowSchema),
    currentTotals: channelOverviewTotalsSchema,
    previousTotals: channelOverviewTotalsSchema,
  })
  .strict();

export type GetChannelOverviewInput = z.infer<typeof getChannelOverviewInputSchema>;
export type GetChannelOverviewOutput = z.infer<typeof getChannelOverviewOutputSchema>;

export const getChannelBreakdownInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    breakdown: z.enum(Object.keys(CHANNEL_BREAKDOWN_PRESETS) as [ChannelBreakdownKind, ...ChannelBreakdownKind[]]),
  })
  .strict();

export const getChannelBreakdownOutputSchema = z
  .object({
    channelId: z.string().min(1),
    breakdown: z.enum(Object.keys(CHANNEL_BREAKDOWN_PRESETS) as [ChannelBreakdownKind, ...ChannelBreakdownKind[]]),
    startDate: z.string(),
    endDate: z.string(),
    rows: z.array(
      z
        .object({
          dimensionValues: z.array(z.string()),
          metrics: z.record(z.string(), z.number()),
        })
        .strict()
    ),
  })
  .strict();

export type GetChannelBreakdownInput = z.infer<typeof getChannelBreakdownInputSchema>;
export type GetChannelBreakdownOutput = z.infer<typeof getChannelBreakdownOutputSchema>;

export const getDataQualityReportInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .strict();

const dataQualityVideoSkipSchema = z
  .object({
    videoId: z.string().min(1),
    skipCount: z.number().int().positive(),
    lastSkippedAt: z.string(),
  })
  .strict();

// Factored out so `getWeeklyReportOutputSchema` below can embed the same shape (twice, current +
// previous week) without duplicating it -- both are `computeDataQualityReport`'s own return shape.
const dataQualityReportShapeSchema = z
  .object({
    coveredDates: z.array(z.string()),
    uncoveredDates: z.array(z.string()),
    tooRecentDates: z.array(z.string()),
    videosWithSkips: z.array(dataQualityVideoSkipSchema),
  })
  .strict();

export const getDataQualityReportOutputSchema = dataQualityReportShapeSchema
  .extend({
    channelId: z.string().min(1),
    startDate: z.string(),
    endDate: z.string(),
  })
  .strict();

export type GetDataQualityReportInput = z.infer<typeof getDataQualityReportInputSchema>;
export type GetDataQualityReportOutput = z.infer<typeof getDataQualityReportOutputSchema>;

// Phase 8 follow-up, slice 3 (docs/roadmap/FUTURE_PHASES.md §4, "comparing videos at comparable
// ages"). videoIds capped at 10 -- a per-video Analytics-day arithmetic pass plus a chart with
// this many overlaid series is already a lot for a caller (human or agent) to make sense of; a
// genuinely larger comparison is a different, aggregate-style report, not this one. maxDays capped
// at 365 -- a bound on response size, not a claim that a full year of data actually exists.
export const getComparableAgeComparisonInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    videoIds: z.array(z.string().min(1)).min(2).max(10),
    metricName: z.enum(CUMULATIVE_COMPARISON_METRIC_NAMES).default("views"),
    maxDays: z.number().int().positive().max(365).default(30),
  })
  .strict();

const comparableAgeDailyPointSchema = z
  .object({
    dayOffset: z.number().int().nonnegative(),
    value: z.number(),
  })
  .strict();

const comparableAgeCumulativePointSchema = z
  .object({
    dayOffset: z.number().int().nonnegative(),
    cumulativeValue: z.number(),
  })
  .strict();

const comparableAgeVideoSeriesSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    publishedAt: z.string(),
    publishDatePacific: z.string(),
    points: z.array(comparableAgeDailyPointSchema),
    cumulativePoints: z.array(comparableAgeCumulativePointSchema),
  })
  .strict();

export const getComparableAgeComparisonOutputSchema = z
  .object({
    channelId: z.string().min(1),
    metricName: z.string(),
    maxDays: z.number().int().positive(),
    videos: z.array(comparableAgeVideoSeriesSchema),
  })
  .strict();

export type GetComparableAgeComparisonInput = z.infer<typeof getComparableAgeComparisonInputSchema>;
export type GetComparableAgeComparisonOutput = z.infer<typeof getComparableAgeComparisonOutputSchema>;

// Phase 8 follow-up, slice 4 (docs/roadmap/FUTURE_PHASES.md §4, "analytical reports and weekly
// channel reviews"). `weeklyReportContentSchema` mirrors `WeeklyReportContent`
// (`weekly-report.ts`) field-for-field -- parsed on every READ of a stored `reportJson`, not just
// on write, so a malformed/corrupted row fails loudly (`validation_failed`) instead of silently
// serving a partial or garbled report (advisor review, 2026-09-23).
const weeklyReportMetricTotalsSchema = z
  .object({
    views: z.number(),
    estimatedMinutesWatched: z.number(),
    subscribersGained: z.number(),
    subscribersLost: z.number(),
  })
  .strict();

const weeklyReportPercentChangeSchema = z
  .object({
    views: z.number().nullable(),
    estimatedMinutesWatched: z.number().nullable(),
    subscribersGained: z.number().nullable(),
    subscribersLost: z.number().nullable(),
  })
  .strict();

const weeklyReportTopContentEntrySchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    views: z.number(),
  })
  .strict();

export const weeklyReportContentSchema = z
  .object({
    reportFormatVersion: z.number().int().positive(),
    channelId: z.string().min(1),
    weekStartDate: z.string(),
    weekEndDate: z.string(),
    generatedAt: z.string(),
    status: z.enum(["final", "provisional"]),
    source: z.string(),
    metricDefinitions: z.record(z.string(), z.string()),
    syncedVideoTotals: weeklyReportMetricTotalsSchema,
    previousWeekTotals: weeklyReportMetricTotalsSchema,
    percentChange: weeklyReportPercentChangeSchema.nullable(),
    currentWeekDataQuality: dataQualityReportShapeSchema,
    previousWeekDataQuality: dataQualityReportShapeSchema,
    topContent: z.array(weeklyReportTopContentEntrySchema),
  })
  .strict();

const weeklyReportSummarySchema = z
  .object({
    channelId: z.string().min(1),
    weekStartDate: z.string(),
    weekEndDate: z.string(),
    status: z.string(),
    generatedAt: z.string(),
    report: weeklyReportContentSchema,
  })
  .strict();

export const listWeeklyReportsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

export const listWeeklyReportsOutputSchema = z
  .object({
    channelId: z.string().min(1),
    reports: z.array(weeklyReportSummarySchema),
  })
  .strict();

export const getWeeklyReportInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    weekStartDate: isoDateSchema,
  })
  .strict();

export const getWeeklyReportOutputSchema = z
  .object({
    channelId: z.string().min(1),
    report: weeklyReportSummarySchema.nullable(),
  })
  .strict();

export const runWeeklyReportIfDueInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

export const runWeeklyReportIfDueOutputSchema = z.discriminatedUnion("generated", [
  z.object({ generated: z.literal(false) }).strict(),
  z.object({ generated: z.literal(true), report: weeklyReportSummarySchema }).strict(),
]);

export type ListWeeklyReportsInput = z.infer<typeof listWeeklyReportsInputSchema>;
export type GetWeeklyReportInput = z.infer<typeof getWeeklyReportInputSchema>;
export type RunWeeklyReportIfDueInput = z.infer<typeof runWeeklyReportIfDueInputSchema>;
