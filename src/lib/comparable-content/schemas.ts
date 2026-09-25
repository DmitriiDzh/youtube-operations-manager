import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { COMPARABLE_VIDEOS_SORT_MODES, PERFORMANCE_THRESHOLD_OPERATORS } from "./contracts";
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

export const MAX_COMPARABLE_VIDEOS_LIMIT = 50;
const DEFAULT_COMPARABLE_VIDEOS_LIMIT = 20;

const sortModeSchema = z.enum(COMPARABLE_VIDEOS_SORT_MODES);
const performanceMetricSchema = z.enum(CUMULATIVE_COMPARISON_METRIC_NAMES);
const performanceThresholdOperatorSchema = z.enum(PERFORMANCE_THRESHOLD_OPERATORS);

/**
 * The plain object schema, before the cross-field refinements below -- exported separately so an
 * SDK-facing tool registration (MCP's `server.registerTool`, which validates a call against
 * whatever `inputSchema` it was given BEFORE any handler code runs) can accept a call that will
 * legitimately need `credentialRef` auto-resolved server-side (e.g. `performanceMetric` requested,
 * no explicit `credentialRef`) without the SDK itself rejecting it first. The full refined
 * `findComparableVideosInputSchema` below remains the actual source of truth -- both the MCP
 * handler (after resolving/injecting `credentialRef`) and this domain service still validate
 * against it in full, so no business rule is weakened, only deferred past server-side resolution.
 */
export const findComparableVideosBaseObjectSchema = z
  .object({
    channelId: z.string().min(1),
    anchorVideoId: z.string().min(1),
    credentialRef: credentialRefSchema.optional(),
    publicationWindowDays: z.number().int().positive().max(3650).optional(),
    durationToleranceSeconds: z.number().int().nonnegative().optional(),
    performanceMetric: performanceMetricSchema.optional(),
    performanceThreshold: z
      .object({
        operator: performanceThresholdOperatorSchema,
        value: z.number(),
      })
      .strict()
      .optional(),
    sort: sortModeSchema,
    // Deliberately no `.max()` here (found by independent review, round 3): a caller-supplied
    // `limit` above MAX_COMPARABLE_VIDEOS_LIMIT is silently capped by the service, per this
    // capability's own contract (`FindComparableVideosInput.limit`'s doc comment, AC-CMP-07) --
    // rejecting it at the schema layer would contradict "never an unbounded response, always
    // truncated" by making an oversized limit a validation_failed error instead.
    limit: z.number().int().positive().optional(),
  })
  .strict();

export const findComparableVideosInputSchema = findComparableVideosBaseObjectSchema
  .refine((data) => !data.performanceThreshold || data.performanceMetric !== undefined, {
    message: "performanceThreshold requires performanceMetric to also be set",
    path: ["performanceThreshold"],
  })
  .refine((data) => data.sort !== "performanceMetric" || data.performanceMetric !== undefined, {
    message: "sort \"performanceMetric\" requires performanceMetric to also be set",
    path: ["sort"],
  })
  .refine((data) => data.performanceMetric === undefined || data.credentialRef !== undefined, {
    message: "performanceMetric requires credentialRef to also be set",
    path: ["credentialRef"],
  });

const comparableVideoCandidateSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    publishedAt: z.string(),
    publicationDistanceDays: z.number().int().nonnegative(),
    durationSeconds: z.number().int().nullable(),
    durationDistanceSeconds: z.number().int().nullable(),
    performanceMetricValue: z.number().nullable(),
    sharedTitleTokens: z.array(z.string()),
  })
  .strict();

const findComparableVideosAnchorSchema = z
  .object({
    videoId: z.string().min(1),
    title: z.string(),
    publishedAt: z.string(),
    durationSeconds: z.number().int().nullable(),
    performanceMetricValue: z.number().nullable(),
  })
  .strict();

export const findComparableVideosOutputSchema = z
  .object({
    anchorVideoId: z.string().min(1),
    anchor: findComparableVideosAnchorSchema,
    performanceAlignment: z
      .object({
        metricName: z.string().min(1),
        dayOffset: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
    candidates: z.array(comparableVideoCandidateSchema),
    excludedForMissingData: z
      .object({
        duration: z.number().int().nonnegative(),
        performance: z.number().int().nonnegative(),
      })
      .strict(),
    truncated: z.boolean(),
  })
  .strict();

export type FindComparableVideosInputParsed = z.infer<typeof findComparableVideosInputSchema>;

export { DEFAULT_COMPARABLE_VIDEOS_LIMIT };
