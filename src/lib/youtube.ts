import { google } from "googleapis";
import { db, users } from "./db";
import { eq } from "drizzle-orm";

function getOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET
  );
}

export async function getAuthenticatedYoutube(userId: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, userId));

  if (!user?.accessToken) throw new Error("User not authenticated");

  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
  });

  oauth2.on("tokens", async (tokens) => {
    await db
      .update(users)
      .set({
        accessToken: tokens.access_token ?? user.accessToken,
        refreshToken: tokens.refresh_token ?? user.refreshToken,
        tokenExpiry: tokens.expiry_date
          ? Math.floor(tokens.expiry_date / 1000)
          : user.tokenExpiry,
      })
      .where(eq(users.id, userId));
  });

  return google.youtube({ version: "v3", auth: oauth2 });
}

async function getChannelId(youtube: Awaited<ReturnType<typeof getAuthenticatedYoutube>>) {
  const res = await youtube.channels.list({
    part: ["id"],
    mine: true,
  });
  return res.data.items?.[0]?.id;
}

export async function getUserPlaylists(userId: string) {
  const youtube = await getAuthenticatedYoutube(userId);
  const channelId = await getChannelId(youtube);
  if (!channelId) return [];

  const playlists: { id: string; title: string }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlists.list({
      part: ["snippet"],
      channelId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      playlists.push({
        id: item.id!,
        title: item.snippet?.title ?? "Untitled",
      });
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return playlists;
}

export async function getRecentVideos(userId: string) {
  const youtube = await getAuthenticatedYoutube(userId);

  const channelRes = await youtube.channels.list({
    part: ["contentDetails"],
    mine: true,
  });

  const uploadsPlaylistId =
    channelRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const seen = new Set<string>();
  const videos: {
    videoId: string;
    title: string;
    description: string;
    publishedAt: string;
  }[] = [];
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlistItems.list({
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
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  return videos;
}

export async function createPlaylist(
  userId: string,
  title: string,
  privacyStatus: "private" | "public" | "unlisted" = "private"
) {
  const youtube = await getAuthenticatedYoutube(userId);
  const res = await youtube.playlists.insert({
    part: ["snippet", "status"],
    requestBody: {
      snippet: { title },
      status: { privacyStatus },
    },
  });
  return {
    id: res.data.id!,
    title: res.data.snippet?.title ?? title,
  };
}

export async function addVideoToPlaylist(
  userId: string,
  videoId: string,
  playlistId: string
) {
  const youtube = await getAuthenticatedYoutube(userId);
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

export async function removeVideosFromPlaylist(
  userId: string,
  videoIds: string[],
  playlistId: string
) {
  const youtube = await getAuthenticatedYoutube(userId);
  const targetSet = new Set(videoIds);

  // Collect playlistItem IDs for matching videos by paginating the playlist
  const toDelete: string[] = [];
  let pageToken: string | undefined;

  do {
    const res = await youtube.playlistItems.list({
      part: ["snippet"],
      playlistId,
      maxResults: 50,
      pageToken,
    });

    for (const item of res.data.items ?? []) {
      const vid = item.snippet?.resourceId?.videoId;
      if (vid && targetSet.has(vid) && item.id) {
        toDelete.push(item.id);
      }
    }

    pageToken = res.data.nextPageToken ?? undefined;
  } while (pageToken);

  let removed = 0;
  for (const id of toDelete) {
    try {
      await youtube.playlistItems.delete({ id });
      removed++;
    } catch {
      // Skip failures
    }
  }

  return removed;
}
