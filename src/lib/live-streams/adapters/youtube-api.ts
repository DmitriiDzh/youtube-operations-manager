import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { getStoredChannel } from "@/lib/db";
import { getAuthenticatedYoutube, getVideosMetadataContextBatch } from "@/lib/youtube-read-gateway";
import { DomainError, type VideoFacts } from "../contracts";

// BL-176 (LIVE_STREAMS_PLAN.md §3.4): fresh reads of a channel's own videos, under the Google account the channel is
// connected with on this computer (Settings → Channels) -- the same lookup the Producer's background reads use.

async function channelUserId(channelId: string): Promise<string> {
  const connected = (await createChannelConnectionsCore().listConnectedChannels()).some((channel) => channel.channelId === channelId);
  const userId = connected ? ((await getStoredChannel(channelId))?.connectedUserId ?? null) : null;
  if (!userId) throw new DomainError({ code: "unauthorized", message: "This channel is not connected on this computer (Settings → Channels)", details: { channelId } });
  return userId;
}

export function createLiveStreamsYoutubeReads() {
  return {
    async readVideoFacts(channelId: string, videoIds: readonly string[]): Promise<VideoFacts[]> {
      if (videoIds.length === 0) return [];
      const youtube = await getAuthenticatedYoutube(await channelUserId(channelId));
      const videos = await getVideosMetadataContextBatch(youtube, [...videoIds]);
      return videos.map((v) => ({ videoId: v.videoId, title: v.title, privacyStatus: v.privacyStatus, publishAt: v.publishAt, durationSeconds: v.durationSeconds }));
    },
  };
}
