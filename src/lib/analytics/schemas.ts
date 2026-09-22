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
