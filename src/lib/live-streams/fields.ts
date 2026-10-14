import type { VideoLicense } from "@/lib/youtube-video-fields";

// BL-186 (docs/roadmap/plans/LIVE_STREAMS_FIELDS_PLAN.md §2.1/§3.2): the stream's own video and broadcast settings -- the shapes,
// value lists and defaults. Pure, no imports with runtime code: the Web UI imports this file directly (the module's barrel and
// `contracts.ts` pull in server code). The rules that check the values are in `schemas.ts`.

/** liveBroadcasts `contentDetails.latencyPreference`. */
export const LIVE_LATENCIES = ["normal", "low", "ultraLow"] as const;
export type LiveLatency = (typeof LIVE_LATENCIES)[number];
/**
 * liveBroadcasts `contentDetails.closedCaptionsType`: "off" only (owner's "ок" to plan Q2, msg 2788) -- the stream has no caption
 * source, so HTTP POST or embedded captions would show nothing.
 */
export const LIVE_CLOSED_CAPTIONS = ["closedCaptionsDisabled"] as const;
export type LiveClosedCaptions = (typeof LIVE_CLOSED_CAPTIONS)[number];
/** A stream's playlists: at most this many (each is one `playlistItems.insert`, 50 units, at Start). */
export const MAX_STREAM_PLAYLISTS = 10;

/**
 * Settings YouTube offers only in Studio (no API sets them; LIVE_STREAMS_FIELDS_PLAN.md §2.1) -- shown in the stream's settings
 * as a labelled, read-only list, so the owner knows to set them there.
 */
export const LIVE_STUDIO_ONLY_FIELDS = ["ageRestriction", "adBreaks", "autoChapters", "featuredPlaces", "concepts", "comments", "chat"] as const;
export type LiveStudioOnlyField = (typeof LIVE_STUDIO_ONLY_FIELDS)[number];

/** The stream's thumbnail, chosen in its settings and kept on this computer (`liveStreamsThumbnailsDir`). */
export type LiveThumbnail = { kind: "jpeg" | "png"; bytes: number; sha256: string; savedAt: string };

/**
 * BL-186 (LIVE_STREAMS_FIELDS_PLAN.md §2.1/§3.2): the stream's own video and broadcast settings -- every field the API can set
 * (owner msgs 2782/2785). Saved locally (schema v92); saving writes nothing to YouTube. An empty text/list field is not sent;
 * nothing here ever means "delete" (AGENTS.md §F). Made for kids, privacy, title and description stay in `StreamSettingsInput`.
 * The broadcast's title/description translations are NOT here: they go through the normal translation screens (plan §2.3).
 */
export type LiveVideoSettings = {
  v: 1;
  tags: string[];
  categoryId: string | null;
  /** snippet.defaultLanguage: the language of the title and description. */
  defaultLanguage: string | null;
  /** snippet.defaultAudioLanguage ("zxx" = not applicable). */
  defaultAudioLanguage: string | null;
  license: VideoLicense;
  publicStatsViewable: boolean;
  /** status.containsSyntheticMedia -- Studio's "altered or synthetic content". */
  containsSyntheticMedia: boolean;
  /** paidProductPlacementDetails.hasPaidProductPlacement -- Studio's «Прямая реклама» (owner's "ок" to plan Q1, msg 2788). */
  paidProductPlacement: boolean;
  /** recordingDetails.recordingDate: a calendar date, ISO at UTC midnight. */
  recordingDate: string | null;
  playlists: Array<{ id: string; title: string }>;
  thumbnail: LiveThumbnail | null;
  broadcast: { latencyPreference: LiveLatency; enableDvr: boolean; enableEmbed: boolean; closedCaptionsType: LiveClosedCaptions };
};

/** What the form shows before the first save: YouTube's own defaults for a new broadcast and video. */
export const DEFAULT_LIVE_VIDEO_SETTINGS: LiveVideoSettings = Object.freeze({
  v: 1,
  tags: [],
  categoryId: null,
  defaultLanguage: null,
  defaultAudioLanguage: null,
  license: "youtube",
  publicStatsViewable: true,
  containsSyntheticMedia: false,
  paidProductPlacement: false,
  recordingDate: null,
  playlists: [],
  thumbnail: null,
  broadcast: { latencyPreference: "normal", enableDvr: true, enableEmbed: true, closedCaptionsType: "closedCaptionsDisabled" },
}) as LiveVideoSettings;

