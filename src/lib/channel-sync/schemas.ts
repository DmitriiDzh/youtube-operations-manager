import { z, ZodError } from "zod";
import { DomainError } from "./contracts";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";

const thumbnailInfoSchema = z
  .object({
    url: z.string().min(1),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
  })
  .strict();

const localeMetadataSchema = z
  .object({
    title: z.string(),
    description: z.string(),
  })
  .strict();

const syncedChannelSchema = z
  .object({
    channelId: z.string().min(1),
    title: z.string(),
    thumbnailUrl: z.string().nullable(),
    uploadsPlaylistId: z.string().min(1),
    connectedUserId: z.string().nullable(),
    connectedAt: z.string(),
    lastSyncedAt: z.string().nullable(),
  })
  .strict();

const syncedVideoSchema = z
  .object({
    videoId: z.string().min(1),
    channelId: z.string().min(1),
    title: z.string(),
    description: z.string(),
    publishedAt: z.string(),
    privacyStatus: z.string(),
    defaultLanguage: z.string().nullable(),
    defaultAudioLanguage: z.string().nullable(),
    thumbnails: z.record(z.string(), thumbnailInfoSchema),
    existingLocalizations: z.record(z.string(), localeMetadataSchema),
    existingLocalizationLanguages: z.array(z.string()),
    lastSyncedAt: z.string(),
    etag: z.string().nullable(),
  })
  .strict();

export const syncChannelInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1).optional(),
  })
  .strict();

export const syncChannelOutputSchema = z
  .object({
    channel: syncedChannelSchema,
    videoCount: z.number().int().nonnegative(),
    syncedAt: z.string(),
  })
  .strict();

export const listChannelsInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
  })
  .strict();

export const listChannelsOutputSchema = z
  .object({
    channels: z.array(syncedChannelSchema),
  })
  .strict();

export const listSyncedVideosInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
  })
  .strict();

export const listSyncedVideosOutputSchema = z
  .object({
    channelId: z.string().min(1),
    videos: z.array(syncedVideoSchema),
  })
  .strict();

export type SyncChannelInput = z.infer<typeof syncChannelInputSchema>;
export type SyncChannelOutput = z.infer<typeof syncChannelOutputSchema>;
export type ListChannelsInput = z.infer<typeof listChannelsInputSchema>;
export type ListChannelsOutput = z.infer<typeof listChannelsOutputSchema>;
export type ListSyncedVideosInput = z.infer<typeof listSyncedVideosInputSchema>;
export type ListSyncedVideosOutput = z.infer<typeof listSyncedVideosOutputSchema>;

export function formatZodError(error: ZodError) {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
    code: issue.code,
  }));
}

export function parseWithSchema<T>(
  schema: z.ZodType<T>,
  payload: unknown,
  context: string
): T {
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
