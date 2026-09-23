import { z, ZodError } from "zod";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
import { DomainError } from "./contracts";

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
