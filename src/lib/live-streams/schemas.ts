import { z } from "zod";
import { parseWithSchema } from "@/lib/shared-domain";
import { SUPPORTED_YOUTUBE_LANGUAGES } from "@/lib/youtube-supported-languages";
import { TAG_MAX_CHARACTERS, TAGS_MAX_CHARACTERS, tagsLength, VIDEO_CATEGORY_IDS, VIDEO_LICENSES } from "@/lib/youtube-video-fields";
import { LIVE_BITRATE_MAX_KBPS, LIVE_BITRATE_MIN_KBPS, LIVE_CLOSED_CAPTIONS, LIVE_LATENCIES, LIVE_ORDER_MODES, LIVE_PRIVACY_STATUSES, MAX_STREAM_PLAYLISTS, MIN_OVERRIDE_REASON_LENGTH } from "./contracts";

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
    // BL-233: the stream's own bitrate; null = this computer's; absent = unchanged.
    bitrateKbps: z.number().int().min(LIVE_BITRATE_MIN_KBPS).max(LIVE_BITRATE_MAX_KBPS).nullable().optional(),
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

// BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §3.2/§4.1): the stream's video and broadcast settings. Every value is checked here, before it
// is saved -- and again when Start reads it back -- against YouTube's own limits (videos resource) and the app's lists: tags within
// 500 characters as YouTube counts them, an assignable category, a language from the app's YouTube list.
const LANGUAGE_CODES = new Set(SUPPORTED_YOUTUBE_LANGUAGES.map((l) => l.code));
const tag = z
  .string()
  .min(1)
  .max(TAG_MAX_CHARACTERS)
  .refine((value) => value.trim() === value && !/[<>,]/.test(value), "a tag has no leading or trailing spaces, <, > or a comma");
/** A YouTube playlist id (e.g. `PL` + 32 characters); the playlist's channel is checked when it is applied, never trusted from here. */
const playlistId = z.string().regex(/^[A-Za-z0-9_-]{2,64}$/, "a YouTube playlist id");
/** A calendar date as video-details sends it: midnight UTC. */
const recordingDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/, "a date at midnight UTC (YYYY-MM-DDT00:00:00.000Z)")
  .refine((value) => new Date(value).toISOString() === value, "not a real calendar date");

const videoSettingsFields = {
  tags: z
    .array(tag)
    .max(100)
    .refine((tags) => new Set(tags.map((t) => t.toLowerCase())).size === tags.length, "a tag is listed twice")
    .refine((tags) => tagsLength(tags) <= TAGS_MAX_CHARACTERS, `the tags are over YouTube's ${TAGS_MAX_CHARACTERS} characters (commas and quotes count)`),
  categoryId: z.enum(VIDEO_CATEGORY_IDS).nullable(),
  defaultLanguage: z.string().refine((code) => LANGUAGE_CODES.has(code), "a language from the app's YouTube list").nullable(),
  defaultAudioLanguage: z.string().refine((code) => code === "zxx" || LANGUAGE_CODES.has(code), "a language from the app's YouTube list, or zxx").nullable(),
  license: z.enum(VIDEO_LICENSES),
  publicStatsViewable: z.boolean(),
  containsSyntheticMedia: z.boolean(),
  paidProductPlacement: z.boolean(),
  recordingDate: recordingDate.nullable(),
  playlists: z
    .array(z.object({ id: playlistId, title: z.string().max(150) }).strict())
    .max(MAX_STREAM_PLAYLISTS)
    .refine((list) => new Set(list.map((p) => p.id)).size === list.length, "a playlist is listed twice"),
  broadcast: z
    .object({
      latencyPreference: z.enum(LIVE_LATENCIES),
      enableDvr: z.boolean(),
      enableEmbed: z.boolean(),
      closedCaptionsType: z.enum(LIVE_CLOSED_CAPTIONS),
    })
    .strict(),
};

/** What the settings form sends: everything but the thumbnail, which has its own upload. */
export const videoSettingsInputSchema = z.object(videoSettingsFields).strict();

/** What is stored (schema v92) and read back by Start: the input plus the version and the thumbnail's facts. */
export const storedVideoSettingsSchema = z
  .object({
    v: z.literal(1),
    ...videoSettingsFields,
    thumbnail: z
      .object({ kind: z.enum(["jpeg", "png"]), bytes: z.number().int().positive(), sha256: z.string().regex(/^[0-9a-f]{64}$/), savedAt: z.string().min(1) })
      .strict()
      .nullable(),
  })
  .strict();
