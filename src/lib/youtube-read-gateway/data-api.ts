import { google } from "googleapis";
import type { youtube_v3 } from "googleapis";
import { createGoogleOAuthClient } from "../auth";
import {
  getDataApiReadsEnabled,
  getUserOAuthTokens,
  recordGatewayCallOutcome,
  saveUserOAuthTokens,
} from "../db";
import { DomainError } from "../video-metadata/contracts";
import { wrapYoutubeClientForQuotaClassification } from "./error-classification";

/**
 * "Data API v3 reads enabled" toggle (owner instruction, 2026-09-22, Telegram -- see
 * `src/lib/db.ts`'s `getDataApiReadsEnabled` for the full rationale and default/persistence
 * model, deliberately the opposite of Gate B's write-side toggle).
 *
 * **Deliberately couples to write paths too, unlike the write gateway's own per-caller
 * `assertLiveWritesAuthorized` pattern.** This check lives inside `createYoutubeClient` itself
 * (below) -- the one shared constructor every Data API v3 caller in the repo uses, read or
 * write -- so disabling reads also blocks Batches' write-client construction and
 * `write-context`'s pre-write identity check. This is intentional, not an oversight: a write
 * path here always depends on a read first (a mandatory fresh pre-write fetch, or resolving
 * "which channel am I" before comparing it against the expected one) -- if reads are disabled,
 * that dependency cannot be satisfied safely, and failing the write closed is this codebase's
 * existing fail-closed philosophy applied consistently, not a new behavior. Live Writes remains
 * the sole *authorization* for whether a write is allowed at all; this is an orthogonal
 * precondition, not a replacement for it.
 */
export async function assertDataApiReadsAuthorized(): Promise<void> {
  if (await getDataApiReadsEnabled()) {
    await recordGatewayCallOutcome("data_api_reads", "allowed");
    return;
  }

  await recordGatewayCallOutcome("data_api_reads", "blocked");
  throw new DomainError({
    code: "data_api_reads_disabled",
    message:
      "YouTube Data API v3 reads are disabled -- the Settings tab's \"Data API reads\" toggle is off. " +
      "This also blocks write paths, which require a read to verify channel identity and fetch fresh state first.",
  });
}

/**
 * The single choke point every Data API v3 call in the repo passes through to get a client --
 * every `adapters/youtube-api.ts`, plus `getAuthenticatedYoutube`/`getAuthenticatedYoutubeFromTokens`
 * below, call this rather than constructing a `youtube_v3.Youtube` any other way. `async`
 * specifically so `assertDataApiReadsAuthorized` lives here, checked exactly once, mechanically,
 * for every caller -- see that function's own doc comment for why this also covers write-adjacent
 * callers, unlike the write gateway's per-caller design.
 */
export async function createYoutubeClient(
  auth: youtube_v3.Options["auth"]
): Promise<youtube_v3.Youtube> {
  await assertDataApiReadsAuthorized();
  return wrapYoutubeClientForQuotaClassification(google.youtube({ version: "v3", auth }));
}

export async function getAuthenticatedYoutube(userId: string) {
  const user = await getUserOAuthTokens(userId);

  if (!user?.accessToken) throw new Error("User not authenticated");

  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });

  oauth2.on("tokens", async (tokens) => {
    await saveUserOAuthTokens(userId, {
      accessToken: tokens.access_token ?? user.accessToken,
      refreshToken: tokens.refresh_token ?? user.refreshToken,
      tokenExpiry: tokens.expiry_date
        ? Math.floor(tokens.expiry_date / 1000)
        : user.tokenExpiry,
    });
  });

  return createYoutubeClient(oauth2);
}

export async function getAuthenticatedYoutubeFromTokens(credentials: {
  accessToken: string;
  refreshToken?: string;
}) {
  const oauth2 = createGoogleOAuthClient();
  oauth2.setCredentials({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
  });
  return createYoutubeClient(oauth2);
}

export async function getMyChannelId(youtube: youtube_v3.Youtube) {
  const res = await youtube.channels.list({
    part: ["id"],
    mine: true,
  });
  return res.data.items?.[0]?.id;
}

export async function listVideosByChannel(args: {
  youtube: youtube_v3.Youtube;
  channelId: string;
  maxResults?: number;
}) {
  const uploadsPlaylistRes = await args.youtube.channels.list({
    part: ["contentDetails"],
    id: [args.channelId],
  });

  const uploadsPlaylistId =
    uploadsPlaylistRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;

  if (!uploadsPlaylistId) {
    return [] as {
      videoId: string;
      title: string;
      description: string;
      publishedAt: string;
    }[];
  }

  const seen = new Set<string>();
  const videos: {
    videoId: string;
    title: string;
    description: string;
    publishedAt: string;
  }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await args.youtube.playlistItems.list({
      part: ["snippet"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId || seen.has(videoId)) continue;

      seen.add(videoId);
      videos.push({
        videoId,
        title: item.snippet?.title ?? "",
        description: item.snippet?.description ?? "",
        publishedAt: item.snippet?.publishedAt ?? "",
      });

      if (args.maxResults && videos.length >= args.maxResults) {
        return videos;
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return videos;
}

export type ChannelForSync = {
  channelId: string;
  title: string;
  thumbnailUrl: string | null;
  uploadsPlaylistId: string;
};

export async function getChannelForSync(
  youtube: youtube_v3.Youtube,
  channelId?: string
): Promise<ChannelForSync | null> {
  const res = await youtube.channels.list(
    channelId
      ? { part: ["snippet", "contentDetails"], id: [channelId] }
      : { part: ["snippet", "contentDetails"], mine: true }
  );

  const channel = res.data.items?.[0];
  const uploadsPlaylistId = channel?.contentDetails?.relatedPlaylists?.uploads;
  if (!channel?.id || !uploadsPlaylistId) return null;

  return {
    channelId: channel.id,
    title: channel.snippet?.title ?? "",
    thumbnailUrl:
      channel.snippet?.thumbnails?.medium?.url ??
      channel.snippet?.thumbnails?.default?.url ??
      null,
    uploadsPlaylistId,
  };
}

export async function listUploadsPlaylistVideoIds(
  youtube: youtube_v3.Youtube,
  uploadsPlaylistId: string
): Promise<string[]> {
  const seen = new Set<string>();
  const videoIds: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlistItems.list({
      part: ["contentDetails"],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      const videoId = item.contentDetails?.videoId;
      if (!videoId || seen.has(videoId)) continue;
      seen.add(videoId);
      videoIds.push(videoId);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return videoIds;
}

const YOUTUBE_VIDEOS_LIST_BATCH_SIZE = 50;

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export type ThumbnailInfo = {
  url: string;
  width: number | null;
  height: number | null;
};

export type VideoSyncMetadata = {
  videoId: string;
  title: string;
  description: string;
  publishedAt: string;
  privacyStatus: string;
  defaultLanguage: string | null;
  defaultAudioLanguage: string | null;
  thumbnails: Record<string, ThumbnailInfo>;
  existingLocalizations: Record<string, LocaleMetadata>;
  etag: string | null;
  viewCount: number | null;
  commentCount: number | null;
  likeCount: number | null;
  durationSeconds: number | null;
};

function parseStatCount(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

// Phase 7 slice K (owner spec §10 -- "similar duration" comparable-content filter). YouTube's
// `contentDetails.duration` is an ISO-8601 duration string (e.g. "PT10M30S", "P1DT2H"). Years/
// months are approximated as 365/30 days respectively -- YouTube videos never plausibly report
// those units at meaningful scale, so the approximation error is immaterial in practice, but it
// IS an approximation, not exact calendar arithmetic (documented here so a future reader doesn't
// assume otherwise).
const ISO8601_DURATION_RE = /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/**
 * Never fabricates a fact (owner spec §9): an unparseable or absent duration is `null`. A
 * genuinely all-zero duration (`"P0D"`, `"PT0S"`) is ALSO `null`, not a literal `0` -- YouTube
 * uses this as a placeholder for an in-progress live broadcast/premiere whose final length isn't
 * known yet, never as a real fact about a processed video's actual length.
 */
export function parseIso8601DurationToSeconds(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = ISO8601_DURATION_RE.exec(value);
  if (!match) return null;

  const [, years, months, days, hours, minutes, seconds] = match;
  if (!years && !months && !days && !hours && !minutes && !seconds) {
    return null; // e.g. a bare "P" or "PT" with no actual components -- not a real duration
  }

  const totalSeconds =
    Number(years ?? 0) * 365 * 24 * 3600 +
    Number(months ?? 0) * 30 * 24 * 3600 +
    Number(days ?? 0) * 24 * 3600 +
    Number(hours ?? 0) * 3600 +
    Number(minutes ?? 0) * 60 +
    Number(seconds ?? 0);

  return totalSeconds > 0 ? Math.round(totalSeconds) : null;
}

function toThumbnailMap(
  thumbnails: youtube_v3.Schema$ThumbnailDetails | null | undefined
): Record<string, ThumbnailInfo> {
  const map: Record<string, ThumbnailInfo> = {};
  for (const [size, value] of Object.entries(thumbnails ?? {})) {
    if (!value?.url) continue;
    map[size] = {
      url: value.url,
      width: value.width ?? null,
      height: value.height ?? null,
    };
  }
  return map;
}

export async function getVideosMetadataContextBatch(
  youtube: youtube_v3.Youtube,
  videoIds: string[]
): Promise<VideoSyncMetadata[]> {
  const results: VideoSyncMetadata[] = [];

  for (const batch of chunk(videoIds, YOUTUBE_VIDEOS_LIST_BATCH_SIZE)) {
    if (batch.length === 0) continue;

    const res = await youtube.videos.list({
      part: ["snippet", "status", "localizations", "statistics", "contentDetails"],
      id: batch,
      maxResults: YOUTUBE_VIDEOS_LIST_BATCH_SIZE,
    });

    for (const item of res.data.items ?? []) {
      if (!item.id || !item.snippet) continue;

      results.push({
        videoId: item.id,
        title: item.snippet.title ?? "",
        description: item.snippet.description ?? "",
        publishedAt: item.snippet.publishedAt ?? "",
        privacyStatus: item.status?.privacyStatus ?? "private",
        defaultLanguage: item.snippet.defaultLanguage ?? null,
        defaultAudioLanguage: item.snippet.defaultAudioLanguage ?? null,
        thumbnails: toThumbnailMap(item.snippet.thumbnails),
        existingLocalizations: toLocaleMetadataMap(item.localizations),
        etag: item.etag ?? null,
        // The API returns these as decimal strings and omits a field entirely when it isn't
        // available (e.g. comments/likes disabled/hidden) -- never defaulted to 0, which would
        // assert a false "zero views" fact (docs/roadmap/plans/STUDIO_PARITY_PLAN.md Slice S1).
        viewCount: parseStatCount(item.statistics?.viewCount),
        commentCount: parseStatCount(item.statistics?.commentCount),
        likeCount: parseStatCount(item.statistics?.likeCount),
        // Phase 7 slice K (owner spec §10). Same "never fabricate" discipline as the stats above.
        durationSeconds: parseIso8601DurationToSeconds(item.contentDetails?.duration),
      });
    }
  }

  return results;
}

export async function getVideoById(
  youtube: youtube_v3.Youtube,
  videoId: string
) {
  const res = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });

  const video = res.data.items?.[0];
  if (!video?.id || !video.snippet) return null;

  return {
    videoId: video.id,
    title: video.snippet.title ?? "",
    description: video.snippet.description ?? "",
    publishedAt: video.snippet.publishedAt ?? "",
  };
}

export async function getVideoSnippet(
  youtube: youtube_v3.Youtube,
  videoId: string
) {
  const res = await youtube.videos.list({
    part: ["snippet"],
    id: [videoId],
  });

  const snippet = res.data.items?.[0]?.snippet;
  if (!snippet) return null;

  return snippet;
}

type LocaleMetadata = {
  title: string;
  description: string;
};

function toLocaleMetadataMap(
  localizations: youtube_v3.Schema$VideoLocalization[] | Record<string, youtube_v3.Schema$VideoLocalization> | null | undefined
) {
  const input = localizations ?? {};
  const entries = Array.isArray(input) ? [] : Object.entries(input);

  const normalized: Record<string, LocaleMetadata> = {};
  for (const [locale, value] of entries) {
    normalized[locale] = {
      title: value?.title ?? "",
      description: value?.description ?? "",
    };
  }

  return normalized;
}

export async function getVideoMetadataContext(
  youtube: youtube_v3.Youtube,
  videoId: string
) {
  const res = await youtube.videos.list({
    part: ["snippet", "localizations"],
    id: [videoId],
  });

  const item = res.data.items?.[0];
  const snippet = item?.snippet;
  if (!snippet) return null;

  return {
    snippet,
    localizations: toLocaleMetadataMap(item.localizations),
  };
}

export type VideoDetailsContext = {
  etag: string | null;
  snippet: youtube_v3.Schema$VideoSnippet;
  status: youtube_v3.Schema$VideoStatus;
  recordingDate: string | null;
};

/** Fetches exactly the three parts `src/lib/video-details/` can write -- never `localizations`,
 * so this module structurally cannot read (or, via a merge bug, write) a locale it has no
 * business touching (AGENTS.md §F). */
export async function getVideoDetailsContext(
  youtube: youtube_v3.Youtube,
  videoId: string
): Promise<VideoDetailsContext | null> {
  const res = await youtube.videos.list({
    part: ["snippet", "status", "recordingDetails"],
    id: [videoId],
  });

  const item = res.data.items?.[0];
  if (!item?.snippet || !item.status) return null;

  return {
    etag: item.etag ?? null,
    snippet: item.snippet,
    status: item.status,
    recordingDate: item.recordingDetails?.recordingDate ?? null,
  };
}

export type PlaylistPrivacyStatus = "private" | "public" | "unlisted";

export type PlaylistMetadata = {
  id: string;
  title: string;
  description: string;
  privacyStatus: PlaylistPrivacyStatus;
};

type PlaylistMetadataWithChannel = PlaylistMetadata & {
  channelId: string;
};

/** Reused by `src/lib/youtube-write-gateway/` so the read side (this file) and the write
 * side (the gateway) never carry two independently-drifting copies of the same mapping. */
export function normalizePlaylistPrivacyStatus(value: string | null | undefined): PlaylistPrivacyStatus {
  if (value === "public" || value === "unlisted") {
    return value;
  }

  return "private";
}

export function mapPlaylistMetadata(
  playlist: youtube_v3.Schema$Playlist,
  fallback?: {
    title?: string;
    description?: string;
    privacyStatus?: PlaylistPrivacyStatus;
  }
): PlaylistMetadata | null {
  if (!playlist.id) return null;

  return {
    id: playlist.id,
    title: playlist.snippet?.title ?? fallback?.title ?? "Untitled",
    description: playlist.snippet?.description ?? fallback?.description ?? "",
    privacyStatus: normalizePlaylistPrivacyStatus(
      playlist.status?.privacyStatus ?? fallback?.privacyStatus
    ),
  };
}

export async function listPlaylistsForAuthenticated(youtube: youtube_v3.Youtube) {
  const channelId = await getMyChannelId(youtube);
  if (!channelId) return [] as PlaylistMetadata[];

  const playlists: PlaylistMetadata[] = [];
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlists.list({
      part: ["snippet", "status"],
      channelId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      const mapped = mapPlaylistMetadata(item);
      if (!mapped) continue;
      playlists.push(mapped);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return playlists;
}

export async function getPlaylistForUpdate(
  youtube: youtube_v3.Youtube,
  playlistId: string
): Promise<PlaylistMetadataWithChannel | null> {
  const response = await youtube.playlists.list({
    part: ["id", "snippet", "status"],
    id: [playlistId],
    maxResults: 1,
  });

  const playlist = response.data.items?.[0];
  const mapped = playlist ? mapPlaylistMetadata(playlist) : null;
  const channelId = playlist?.snippet?.channelId;

  if (!mapped || !channelId) {
    return null;
  }

  return {
    ...mapped,
    channelId,
  };
}

export async function listPlaylistItemIdsByVideo(
  youtube: youtube_v3.Youtube,
  playlistId: string
) {
  const idsByVideo = new Map<string, string[]>();
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlistItems.list({
      part: ["snippet"],
      playlistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      const videoId = item.snippet?.resourceId?.videoId;
      if (!videoId || !item.id) continue;

      const current = idsByVideo.get(videoId) ?? [];
      current.push(item.id);
      idsByVideo.set(videoId, current);
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return idsByVideo;
}

export type SupportedLanguage = { code: string; name: string };

/**
 * The real, official set of `hl` values YouTube's `i18nLanguages.list` endpoint returns,
 * mapped to their English display names -- used to suggest which language codes an operator
 * can add as a Languages-tab column (docs/roadmap/plans/LANGUAGES_UX_REDESIGN_PLAN.md §7.2,
 * follow-up assignment 2026-09-21). This is a suggestion source, not a hard allowlist: it is
 * YouTube's own supported *interface* language list, which is a documented, narrower set than
 * every `localizations` key `videos.update` will actually accept (e.g. regional variants like
 * "en-US" seen on real synced data are not guaranteed to appear here) -- callers must still
 * accept any code `isValidLanguageCode` (src/lib/changesets/diff.ts) allows, not only these.
 */
export async function listSupportedLanguages(youtube: youtube_v3.Youtube): Promise<SupportedLanguage[]> {
  const res = await youtube.i18nLanguages.list({ part: ["snippet"], hl: "en" });

  return (res.data.items ?? [])
    .map((item) => ({
      code: item.id ?? "",
      name: item.snippet?.name ?? item.id ?? "",
    }))
    .filter((lang) => lang.code.length > 0)
    .sort((a, b) => a.code.localeCompare(b.code));
}
