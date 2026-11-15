import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import type { ThumbnailReplaceInput } from "./contracts";

export const thumbnailReplaceInputSchema = z
  .object({
    channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/, "a YouTube channel id"),
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/, "a YouTube video id"),
    path: z.string().min(1).max(1000),
    dryRun: z.boolean().optional(),
  })
  .strict();

export function parseThumbnailReplaceInput(payload: unknown): ThumbnailReplaceInput {
  return parseWithSchema(thumbnailReplaceInputSchema, payload, "thumbnail replace input");
}
