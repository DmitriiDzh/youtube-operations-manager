import { z } from "zod";
import { DomainError, isDomainError } from "@/lib/shared-domain";

export { DomainError, isDomainError };

// ---------------------------------------------------------------------------
// BL-222 (docs/roadmap/plans/LIVE_ANALYTICS_PLAN.md §6): the per-device report of this computer's live-stream summaries -- the
// four ranges the «Эфиры» card offers, per channel, exactly as this computer answers them locally. Its own family, not a field of
// `ytm-live-streams` (strict, version 1: a computer not updated yet would refuse that whole report). Strict and narrow: ids, ISO
// dates, fixed codes and numbers only -- no field can hold free text. Defined here: sync-gateway imports nothing from live-analytics.
// ---------------------------------------------------------------------------

export const GLOBAL_DOCUMENT_KEY = "global";
export const LIVE_ANALYTICS_REPORT_FORMAT = "ytm-live-analytics";
export const LIVE_ANALYTICS_REPORT_VERSION = 1;
/** The ranges the card offers, in days: the only ones shared. */
export const SHARED_LIVE_ANALYTICS_RANGES = [1, 7, 30, 90] as const;

const count = z.number().int().min(0).max(1_000_000_000);
const amount = z.number().min(0).max(1e12);
const viewers = z.number().min(0).max(100_000_000).nullable();
const msTime = z.number().int().min(0).max(8.64e15);
const broadcastId = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
const utcDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const utcHour = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/);

const figures = {
  samples: count,
  onAirMs: amount,
  notLiveMs: amount,
  dataGaps: count,
  viewerHours: amount,
  averageViewers: viewers,
  peakViewers: viewers,
  interruptions: count,
};
const figuresSchema = z.object(figures).strict();
const watchTotals = z.object({ views: amount.nullable(), minutesWatched: amount.nullable() }).strict().nullable();

export const sharedLiveSummarySchema = z
  .object({
    totals: figuresSchema,
    days: z.array(z.object({ date: utcDate, ...figures }).strict()).max(92),
    hours: z.array(z.object({ hour: utcHour, averageViewers: viewers, peakViewers: viewers }).strict()).max(92 * 24),
    broadcasts: z.array(z.object({ broadcastId, firstSampleAt: msTime, lastSampleAt: msTime, ...figures }).strict()).max(5_000),
    analytics: z
      .array(
        z
          .object({
            broadcastId,
            status: z.enum(["collected", "failed", "unavailable"]),
            final: z.boolean(),
            collectedAt: z.string().datetime().nullable(),
            concurrent: z.object({ average: viewers, peak: viewers }).strict().nullable(),
            live: watchTotals,
            onDemand: watchTotals,
          })
          .strict()
      )
      .max(5_000)
      .nullable(),
  })
  .strict();

export const sharedLiveAnalyticsChannelSchema = z
  .object({
    channelId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    ranges: z
      .array(
        z
          .object({
            days: z.union([z.literal(1), z.literal(7), z.literal(30), z.literal(90)]),
            from: z.string().datetime(),
            to: z.string().datetime(),
            summary: sharedLiveSummarySchema,
          })
          .strict()
      )
      .max(SHARED_LIVE_ANALYTICS_RANGES.length),
  })
  .strict();

export const liveAnalyticsReportSchema = z
  .object({
    format: z.literal(LIVE_ANALYTICS_REPORT_FORMAT),
    version: z.literal(LIVE_ANALYTICS_REPORT_VERSION),
    deviceId: z.string().min(1).max(128),
    /** The computer's own name, shown as "by <host>"; plain letters, digits, spaces, '.', '-', '_'. */
    hostName: z.string().regex(/^[\p{L}\p{N} ._'-]{1,64}$/u).nullable(),
    updatedAt: z.string().datetime(),
    channels: z.array(sharedLiveAnalyticsChannelSchema).max(50),
  })
  .strict();

export type SharedLiveSummary = z.infer<typeof sharedLiveSummarySchema>;
export type SharedLiveAnalyticsChannel = z.infer<typeof sharedLiveAnalyticsChannelSchema>;
export type LiveAnalyticsReport = z.infer<typeof liveAnalyticsReportSchema>;
