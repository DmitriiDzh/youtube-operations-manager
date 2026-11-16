import { z } from "zod";
import { STRICT_V_CODE_PATTERN, VIDEO_CODE_PATTERN } from "@/lib/shared-video-code";

// BL-194 stage 1: what the owner (Web UI), a script (API) and the Operator (Factory API) send. Strict: an unknown field is refused.

const channelId = z.string().trim().min(1).max(64);
/** BL-263: a video code as given -- `V49` or `S14` (upper-case letter, no leading zero; `src/lib/shared-video-code`). */
export const videoNumberSchema = z.string().regex(VIDEO_CODE_PATTERN, "a video code such as V49 or S14");
/** A V number only (renumbering gives the next V; an S has no "next"). */
export const vNumberSchema = z.string().regex(STRICT_V_CODE_PATTERN, "a video number such as V49");

/**
 * BL-263 (ADR 0071 §2): `video` -- absent: the next V; given: a strict S code (the factory's piece number), reserved as given. A
 * given V is refused (`v_numbers_are_given`, checked by the service: the V series stays YTM's own).
 */
export const createVideoInputSchema = z
  .object({ channelId, workingTitle: z.string().trim().max(200).nullable().optional(), video: videoNumberSchema.optional() })
  .strict();
export const listVideosInputSchema = z
  .object({ channelId, state: z.enum(["in_work", "packaged", "published", "cancelled", "recoded"]).optional() })
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
