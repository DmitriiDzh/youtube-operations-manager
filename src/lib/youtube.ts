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

function removeReadOnlySnippetFields(snippet: youtube_v3.Schema$VideoSnippet) {
  const sanitized = { ...snippet } as youtube_v3.Schema$VideoSnippet & {
    localized?: youtube_v3.Schema$VideoLocalization;
  };
  delete sanitized.localized;
  return sanitized;
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
