import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { ASSET_PERFORMANCE_SORT_MODES } from "./contracts";
import { ASSET_REFERENCE_KINDS, ASSET_TYPES } from "@/lib/asset-catalog";
import { CUMULATIVE_COMPARISON_METRIC_NAMES } from "@/lib/analytics/comparable-age";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

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

export const MAX_ASSET_PERFORMANCE_LIMIT = 50;
const DEFAULT_ASSET_PERFORMANCE_LIMIT = 20;

const assetTypeSchema = z.enum(ASSET_TYPES);
const assetReferenceKindSchema = z.enum(ASSET_REFERENCE_KINDS);
const sortModeSchema = z.enum(ASSET_PERFORMANCE_SORT_MODES);
const performanceMetricSchema = z.enum(CUMULATIVE_COMPARISON_METRIC_NAMES);

/**
 * The plain object schema, before the cross-field refinements below -- exported separately so an
 * SDK-facing tool registration (MCP's `server.registerTool`, which validates a call against
 * whatever `inputSchema` it was given BEFORE any handler code runs) can accept a call that will
 * legitimately need `credentialRef` auto-resolved server-side, mirroring slice K's own
 * `findComparableVideosBaseObjectSchema` precedent exactly.
 */
export const listAssetPerformanceBaseObjectSchema = z
  .object({
    channelId: z.string().min(1),
    assetType: assetTypeSchema.optional(),
    credentialRef: credentialRefSchema.optional(),
    performanceMetric: performanceMetricSchema.optional(),
    performanceDayOffset: z.number().int().nonnegative().optional(),
    sort: sortModeSchema.optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const listAssetPerformanceInputSchema = listAssetPerformanceBaseObjectSchema
  .refine((data) => (data.performanceMetric === undefined) === (data.performanceDayOffset === undefined), {
    message: "performanceMetric and performanceDayOffset must be given together",
    path: ["performanceDayOffset"],
  })
  .refine((data) => data.sort !== "performanceMetric" || data.performanceMetric !== undefined, {
    message: "sort \"performanceMetric\" requires performanceMetric/performanceDayOffset to also be set",
    path: ["sort"],
  })
  .refine((data) => data.performanceMetric === undefined || data.credentialRef !== undefined, {
    message: "performanceMetric requires credentialRef to also be set",
    path: ["credentialRef"],
  });

const linkedVideoSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    publishedAt: z.string(),
    lifetimeViewCount: z.number().int().nullable(),
    lifetimeLikeCount: z.number().int().nullable(),
    lifetimeCommentCount: z.number().int().nullable(),
    durationSeconds: z.number().int().nullable(),
    lifetimeCountersAsOf: z.string(),
    ageAlignedPerformanceValue: z.number().nullable(),
  })
  .strict();

const assetPerformanceEntrySchema = z
  .object({
    assetId: z.string().min(1),
    assetType: assetTypeSchema,
    title: z.string().nullable(),
    referenceKind: assetReferenceKindSchema,
    referenceValue: z.string(),
    linkedVideo: linkedVideoSchema,
  })
  .strict();

export const listAssetPerformanceOutputSchema = z
  .object({
    assets: z.array(assetPerformanceEntrySchema),
    performanceAlignment: z
      .object({
        metricName: z.string().min(1),
        dayOffset: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    excludedForMissingLink: z
      .object({
        unlinked: z.number().int().nonnegative(),
        linkedVideoNotOnChannel: z.number().int().nonnegative(),
      })
      .strict(),
    truncated: z.boolean(),
  })
  .strict();

export type ListAssetPerformanceInputParsed = z.infer<typeof listAssetPerformanceInputSchema>;

export { DEFAULT_ASSET_PERFORMANCE_LIMIT };
