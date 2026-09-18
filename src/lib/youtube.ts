import { google } from "googleapis";
import type { youtube_v3 } from "googleapis";
import { createGoogleOAuthClient } from "./auth";
import { getUserOAuthTokens, saveUserOAuthTokens } from "./db";

export function createYoutubeClient(
  auth: youtube_v3.Options["auth"]
): youtube_v3.Youtube {
  return google.youtube({ version: "v3", auth });
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
};

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
      part: ["snippet", "status", "localizations"],
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

/**
 * RISK-11 (closed 2026-09-18 for src/lib/batches/, extended here to every write path):
 * the exhaustive, documentation-verified list of `snippet` sub-properties the YouTube
 * Data API v3 actually treats as mutable/writable via `videos.update`
 * (developers.google.com/youtube/v3/docs/videos, checked field-by-field 2026-09-18).
 * Everything NOT in this list is read-only (`publishedAt`, `channelId`, `channelTitle`,
 * `thumbnails`, `liveBroadcastContent`) or a separate read-only echo of the
 * `localizations` object (`localized`). This is the single canonical source for every
 * write path in this repository -- `src/lib/batches/merge.ts` re-exports it rather than
 * keeping its own copy, and `src/lib/video-metadata/services.ts` imports it directly --
 * so a future addition to YouTube's writable-field set is a one-line change here, never
 * three independently-drifting copies.
 */
export const WRITABLE_SNIPPET_FIELDS = [
  "title",
  "description",
  "tags",
  "categoryId",
  "defaultLanguage",
  "defaultAudioLanguage",
] as const;

export function pickWritableSnippetFields(snippet: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of WRITABLE_SNIPPET_FIELDS) {
    if (field in snippet) result[field] = snippet[field];
  }
  return result;
}

function removeReadOnlySnippetFields(snippet: youtube_v3.Schema$VideoSnippet) {
  return pickWritableSnippetFields(snippet as Record<string, unknown>) as youtube_v3.Schema$VideoSnippet;
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

export async function updateVideoMetadataSafe(args: {
  youtube: youtube_v3.Youtube;
  videoId: string;
  targetLanguage: string;
  title: string;
  description: string;
}) {
  const currentContext = await getVideoMetadataContext(args.youtube, args.videoId);
  if (!currentContext) {
    throw new Error(`Metadata context not found for video ${args.videoId}`);
  }

  const currentSnippet = currentContext.snippet;
  const currentLocalizations = currentContext.localizations;

  const mergedSnippet = removeReadOnlySnippetFields({
    ...currentSnippet,
    title: args.title,
    description: args.description,
    defaultLanguage: args.targetLanguage,
  });

  const mergedLocalizations = {
    ...currentLocalizations,
    [args.targetLanguage]: {
      ...currentLocalizations[args.targetLanguage],
      title: args.title,
      description: args.description,
    },
  };

  await args.youtube.videos.update({
    part: ["snippet", "localizations"],
    requestBody: {
      id: args.videoId,
      snippet: mergedSnippet,
      localizations: mergedLocalizations,
    },
  });

  return {
    before: currentSnippet,
    proposed: mergedSnippet,
    localizationsBefore: currentLocalizations,
    localizationsProposed: mergedLocalizations,
  };
}

export async function applyVideoMetadataUpdate(args: {
  youtube: youtube_v3.Youtube;
  update: {
    videoId: string;
    snippet: Record<string, unknown>;
    localizations: Record<string, LocaleMetadata>;
  };
}) {
  await args.youtube.videos.update({
    part: ["snippet", "localizations"],
    requestBody: {
      id: args.update.videoId,
      snippet: args.update.snippet as youtube_v3.Schema$VideoSnippet,
      localizations: args.update.localizations,
    },
  });
}

type PlaylistPrivacyStatus = "private" | "public" | "unlisted";

type PlaylistMetadata = {
  id: string;
  title: string;
  description: string;
  privacyStatus: PlaylistPrivacyStatus;
};

type PlaylistMetadataWithChannel = PlaylistMetadata & {
  channelId: string;
};

function normalizePlaylistPrivacyStatus(value: string | null | undefined): PlaylistPrivacyStatus {
  if (value === "public" || value === "unlisted") {
    return value;
  }

  return "private";
}

function mapPlaylistMetadata(
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

export async function createPlaylistForAuthenticated(
  youtube: youtube_v3.Youtube,
  title: string,
  privacyStatus: PlaylistPrivacyStatus = "private",
  description = ""
) {
  const res = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title, description },
      status: { privacyStatus },
    },
  });

  if (!res.data.id) {
    throw new Error("YouTube create playlist response did not include playlist id");
  }

  return mapPlaylistMetadata(res.data, { title, description, privacyStatus })!;
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

export async function updatePlaylistForAuthenticated(args: {
  youtube: youtube_v3.Youtube;
  playlistId: string;
  title: string;
  description: string;
  privacyStatus: PlaylistPrivacyStatus;
}) {
  const response = await args.youtube.playlists.update({
    part: ["snippet", "status"],
    requestBody: {
      id: args.playlistId,
      snippet: {
        title: args.title,
        description: args.description,
      },
      status: {
        privacyStatus: args.privacyStatus,
      },
    },
  });

  return mapPlaylistMetadata(response.data, {
    title: args.title,
    description: args.description,
    privacyStatus: args.privacyStatus,
  })!;
}

export async function addVideoToPlaylistForAuthenticated(
  youtube: youtube_v3.Youtube,
  videoId: string,
  playlistId: string
) {
  await youtube.playlistItems.insert({
    part: ["snippet"],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: {
          kind: "youtube#video",
          videoId,
        },
      },
    },
  });
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

export async function deletePlaylistItemById(
  youtube: youtube_v3.Youtube,
  playlistItemId: string
) {
  await youtube.playlistItems.delete({ id: playlistItemId });
}

export async function getUserPlaylists(userId: string) {
  const youtube = await getAuthenticatedYoutube(userId);
  return listPlaylistsForAuthenticated(youtube);
}

export async function getRecentVideos(userId: string) {
  const youtube = await getAuthenticatedYoutube(userId);
  const channelId = await getMyChannelId(youtube);
  if (!channelId) return [];

  return listVideosByChannel({ youtube, channelId });
}

export async function createPlaylist(
  userId: string,
  title: string,
  privacyStatus: "private" | "public" | "unlisted" = "private"
) {
  const youtube = await getAuthenticatedYoutube(userId);
  return createPlaylistForAuthenticated(youtube, title, privacyStatus);
}

export async function addVideoToPlaylist(
  userId: string,
  videoId: string,
  playlistId: string
) {
  const youtube = await getAuthenticatedYoutube(userId);
  await addVideoToPlaylistForAuthenticated(youtube, videoId, playlistId);
}

export async function removeVideosFromPlaylist(
  userId: string,
  videoIds: string[],
  playlistId: string
) {
  const youtube = await getAuthenticatedYoutube(userId);
  const idsByVideo = await listPlaylistItemIdsByVideo(youtube, playlistId);
  const toDelete: string[] = [];

  for (const videoId of videoIds) {
    const ids = idsByVideo.get(videoId);
    const candidate = ids?.shift();
    if (candidate) {
      toDelete.push(candidate);
    }
  }

  let removed = 0;
  for (const id of toDelete) {
    try {
      await deletePlaylistItemById(youtube, id);
      removed++;
    } catch {
      // Skip failures
    }
  }

  return removed;
}
