import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

export { parseWithSchema };

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be an ISO date, YYYY-MM-DD");

export const syncReachReportsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

/** Longest range one read may span: a year plus slack. Keeps a single call's row count bounded. */
export const MAX_REACH_RANGE_DAYS = 400;

export const getChannelReachInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
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
