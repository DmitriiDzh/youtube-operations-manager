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
    durationSeconds: z.number().int().nullable().optional(),
    liveBroadcastContent: z.string().nullable().optional(),
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

/** Fields a caller may ask `channel_video_list` for (video fields; `videoId` is always included). */
export const SYNCED_VIDEO_FIELDS = [
  "videoId",
  "channelId",
  "title",
  "description",
  "publishedAt",
  "privacyStatus",
  "defaultLanguage",
  "defaultAudioLanguage",
  "thumbnails",
  "existingLocalizations",
  "existingLocalizationLanguages",
  "lastSyncedAt",
  "etag",
  "viewCount",
  "commentCount",
  "likeCount",
  "publishAt",
  "durationSeconds",
  "liveBroadcastContent",
] as const;

export const listSyncedVideosInputSchema = z
  .object({
    credentialRef: credentialRefSchema,
    channelId: z.string().min(1),
    /** Only these fields per video (plus `videoId`). Omitted = every field, as before. */
    fields: z.array(z.enum(SYNCED_VIDEO_FIELDS)).min(1).optional(),
    /** Page size; with `offset` selects a page. Omitted (with no `offset`) = every video, as before. */
    limit: z.number().int().min(1).max(500).optional(),
    offset: z.number().int().min(0).optional(),
  })
  .strict();

export const listSyncedVideosOutputSchema = z
  .object({
    channelId: z.string().min(1),
    videos: z.array(syncedVideoSchema),
  })
  .strict();

/** Result when `fields`, `limit` or `offset` was given: projected videos plus paging info. */
export const listSyncedVideosPagedOutputSchema = z
  .object({
    channelId: z.string().min(1),
    videos: z.array(z.record(z.string(), z.unknown())),
    total: z.number().int().nonnegative(),
    offset: z.number().int().nonnegative(),
    /** `offset` of the next page, or `null` on the last page. */
    nextOffset: z.number().int().nonnegative().nullable(),
  })
  .strict();

export type SyncChannelInput = z.infer<typeof syncChannelInputSchema>;
export type SyncChannelOutput = z.infer<typeof syncChannelOutputSchema>;
export type ListChannelsInput = z.infer<typeof listChannelsInputSchema>;
export type ListChannelsOutput = z.infer<typeof listChannelsOutputSchema>;
export type ListSyncedVideosInput = z.infer<typeof listSyncedVideosInputSchema>;
export type ListSyncedVideosOutput = z.infer<typeof listSyncedVideosOutputSchema>;
