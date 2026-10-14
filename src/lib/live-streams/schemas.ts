import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { LIVE_ORDER_MODES, LIVE_PRIVACY_STATUSES, MIN_OVERRIDE_REASON_LENGTH } from "./contracts";

export { parseWithSchema };

// BL-176 (LIVE_STREAMS_PLAN.md §3.4/§3.9): the shapes of the module's inputs. Limits follow the liveBroadcasts reference:
// a title of 1–100 characters, a description of at most 5,000.

export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const videoId = z.string().regex(YOUTUBE_VIDEO_ID_PATTERN, "a YouTube video id (11 characters)");
const relativeFile = z.string().min(1).max(500);

export const streamSettingsSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    description: z.string().max(5000),
    privacyStatus: z.enum(LIVE_PRIVACY_STATUSES),
    madeForKids: z.boolean(),
    orderMode: z.enum(LIVE_ORDER_MODES),
  })
  .strict();

export const addVideoSchema = z.object({ videoId, originalPath: relativeFile.optional() }).strict();
/** BL-187: the picker's «Добавить N видео» -- each item is added as one `addVideo` would be, in the given order. */
export const addVideosSchema = z.object({ items: z.array(z.object({ videoId, originalPath: relativeFile }).strict()).min(1).max(200) }).strict();
export const removeVideoSchema = z.object({ videoId }).strict();
export const reorderSchema = z.object({ videoIds: z.array(videoId).min(1).max(500) }).strict();
export const overrideGuardSchema = z.object({ videoId, reason: z.string().trim().min(MIN_OVERRIDE_REASON_LENGTH).max(500) }).strict();
export const sourcesSchema = z
  .object({ items: z.array(z.object({ videoId, file: relativeFile }).strict()).min(1).max(200) })
  .strict();
