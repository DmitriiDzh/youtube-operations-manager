import { z } from "zod";
import { credentialRefSchema } from "@/lib/video-metadata/schemas";
export { parseWithSchema, formatZodError } from "./contracts";

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
    viewCount: z.number().int().nullable(),
    commentCount: z.number().int().nullable(),
    likeCount: z.number().int().nullable(),
    publishAt: z.string().nullable(),
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
