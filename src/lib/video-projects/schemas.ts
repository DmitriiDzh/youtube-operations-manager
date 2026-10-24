import { z } from "zod";
import { VIDEO_NUMBER_PATTERN } from "@/lib/sync-gateway";

// BL-194 stage 1: what the owner (Web UI), a script (API) and the Operator (Factory API) send. Strict: an unknown field is refused.

const channelId = z.string().trim().min(1).max(64);
/** A video number as given: `V49` (upper-case V, no leading zero). */
export const videoNumberSchema = z.string().regex(VIDEO_NUMBER_PATTERN, "a video number such as V49");

export const createVideoInputSchema = z
  .object({ channelId, workingTitle: z.string().trim().max(200).nullable().optional() })
  .strict();
export const listVideosInputSchema = z
  .object({ channelId, state: z.enum(["in_work", "packaged", "published", "cancelled"]).optional() })
  .strict();
export const videoRefInputSchema = z.object({ channelId, video: videoNumberSchema }).strict();
/** BL-221: «Привязать к видео» -- a number and a YouTube video id of the same channel. */
export const linkVideoInputSchema = z
  .object({ channelId, video: videoNumberSchema, videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "a YouTube video id") })
  .strict();

/** The link a job, storyboard or plan creation may carry (all optional; an explicit number wins over the inherited ones). */
export const jobVideoInputSchema = z
  .object({
    channelId,
    videoNumber: videoNumberSchema.nullable().optional(),
    storyboardId: z.string().min(1).max(40).nullable().optional(),
    planId: z.string().min(1).max(80).nullable().optional(),
  })
  .strict();

export type CreateVideoInput = z.infer<typeof createVideoInputSchema>;
export type JobVideoInput = z.infer<typeof jobVideoInputSchema>;
