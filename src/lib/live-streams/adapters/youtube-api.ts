import { createChannelConnectionsCore } from "@/lib/channel-connections";
import { getStoredChannel } from "@/lib/db";
import {
  getAuthenticatedYoutube,
  getLiveBroadcasts,
  getLiveStreamStatuses,
  getLiveViewerCounts,
  getVideosMetadataContextBatch,
  readLiveStreamIngestion,
} from "@/lib/youtube-read-gateway";
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

    /** §3.7: the RTMPS address and the key, read at each encoder start; the caller hands the key on and keeps it nowhere. */
    async readIngestion(channelId: string, streamId: string) {
      const youtube = await getAuthenticatedYoutube(await channelUserId(channelId));
      return readLiveStreamIngestion(youtube, streamId);
    },

    /** §3.8: the broadcast's lifecycle status, `null` when YouTube does not return it. */
    async readLifecycle(channelId: string, broadcastId: string) {
      const youtube = await getAuthenticatedYoutube(await channelUserId(channelId));
      return (await getLiveBroadcasts(youtube, [broadcastId]))[0]?.lifeCycleStatus ?? null;
    },

    /** §3.10: the stream's status and health (part=status only: never the key). */
    async readStreamHealth(channelId: string, streamId: string) {
      const youtube = await getAuthenticatedYoutube(await channelUserId(channelId));
      const status = (await getLiveStreamStatuses(youtube, [streamId]))[0];
      return status ? { streamStatus: status.streamStatus, healthStatus: status.healthStatus, configurationIssues: status.configurationIssues } : null;
    },

    /** §3.10: concurrent viewers of a live broadcast. */
    async readViewers(channelId: string, broadcastId: string) {
      const youtube = await getAuthenticatedYoutube(await channelUserId(channelId));
      return (await getLiveViewerCounts(youtube, [broadcastId]))[broadcastId] ?? null;
    },
  };
}
