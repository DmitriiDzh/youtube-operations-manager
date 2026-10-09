import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

export { parseWithSchema };

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, YYYY-MM-DD");

export const syncReachReportsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    /** The automatic trigger sets this so a frequent caller does not hammer Google; a manual sync omits it. */
    onlyIfDue: z.boolean().optional(),
    /**
     * BL-141: with `onlyIfDue`, a FAILED attempt also throttles. Set for background (non-active) channels, whose
     * failure the operator is not looking at, so a channel with broken auth is not retried on every dashboard load.
     */
    throttleFailed: z.boolean().optional(),
  })
  .strict();

/** Longest range one read may span: a year plus slack. Keeps a single call's row count bounded. */
export const MAX_REACH_RANGE_DAYS = 400;

/** The plain object shape (MCP's tool registration needs a ZodObject to relax `credentialRef`); the range rules below are applied by the service. */
export const getChannelReachInputObjectSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
    /** Only this video's rows (`daily`, `videos` and `totals` are then over that one video). */
    videoId: z.string().min(1).max(64).optional(),
    /** `video_day`: also return one row per video per day (`videoDaily`), instead of one call per day or per video. */
    groupBy: z.enum(["video_day"]).optional(),
  })
  .strict();

export const getChannelReachInputSchema = getChannelReachInputObjectSchema.superRefine((value, ctx) => {
    const start = Date.parse(`${value.startDate}T00:00:00Z`);
    const end = Date.parse(`${value.endDate}T00:00:00Z`);
    if (Number.isNaN(start) || Number.isNaN(end)) {
      ctx.addIssue({ code: "custom", message: "startDate/endDate must be real calendar dates" });
      return;
    }
    if (start > end) ctx.addIssue({ code: "custom", message: "startDate must not be after endDate" });
    if ((end - start) / 86_400_000 > MAX_REACH_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", message: `range must not exceed ${MAX_REACH_RANGE_DAYS} days` });
    }
  });

export const getReachStatusInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();

/** At most this many windows per read (BL-166: the Producer's upload milestones, two windows per upload). */
export const MAX_REACH_WINDOWS = 2000;

/** BL-166: Reach totals of several videos, each over its own window; one stored read for the span of all windows. */
export const getVideoWindowsReachInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    windows: z
      .array(z.object({ videoId: z.string().min(1).max(64), startDate: isoDateSchema, endDate: isoDateSchema }).strict())
      .max(MAX_REACH_WINDOWS),
  })
  .strict()
  .superRefine((value, ctx) => {
    const dates = value.windows.flatMap((window) => [window.startDate, window.endDate]);
    const times = dates.map((date) => Date.parse(`${date}T00:00:00Z`));
    // A real calendar day only: Date.parse rolls 2026-02-30 over into March instead of refusing it.
    if (times.some((time, index) => Number.isNaN(time) || new Date(time).toISOString().slice(0, 10) !== dates[index])) {
      ctx.addIssue({ code: "custom", message: "startDate/endDate must be real calendar dates" });
      return;
    }
    if (value.windows.some((window) => window.startDate > window.endDate)) ctx.addIssue({ code: "custom", message: "a window's startDate must not be after its endDate" });
    if (times.length > 0 && (Math.max(...times) - Math.min(...times)) / 86_400_000 > MAX_REACH_RANGE_DAYS) {
      ctx.addIssue({ code: "custom", message: `the windows must not span more than ${MAX_REACH_RANGE_DAYS} days` });
    }
  });
