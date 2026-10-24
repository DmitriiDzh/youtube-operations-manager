import { getAgentSession } from "@/lib/agent-session";
import { assertAgentMayNotPublish } from "@/lib/channel-access";
import { getLiveStream, getStoredVideo, listOpenLiveStreamSegments } from "@/lib/db";
import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { DomainError } from "@/lib/shared-domain";
import { createVideoDetailsCore } from "@/lib/video-details";
import { createWorkerPrivacyServices } from "./services";

/**
 * BL-216: the worker privacy core of THIS request's channel-agent session. Outside an agent session it refuses: the owner changes
 * privacy in the Web UI's video details and playlist cards, not through this module.
 */
export function createWorkerPrivacyCore() {
  return {
    async setPrivacy(input: unknown) {
      const session = getAgentSession();
      if (!session) {
        throw new DomainError({ code: "AGENT_SESSION_OPERATOR_ONLY", message: "only a channel agent session sets privacy through this tool" });
      }
      const credentialRef = { userId: session.userId };
      const channelId = session.channelId;
      const videoDetails = createVideoDetailsCore();
      const playlists = createPlaylistManagementCore();
      return createWorkerPrivacyServices({
        channelId,
        assertMayNotPublish: assertAgentMayNotPublish,
        findChannelVideo: (channel, videoId) => getStoredVideo(channel, videoId),
        async currentBroadcastIds(channel) {
          const [stream, segments] = await Promise.all([getLiveStream(channel), listOpenLiveStreamSegments(channel)]);
          const ids = new Set(segments.filter((segment) => segment.endedAt === null).map((segment) => segment.broadcastId));
          if (stream?.onSince && stream.broadcastId) ids.add(stream.broadcastId);
          return ids;
        },
        async readVideo(videoId) {
          const snapshot = await videoDetails.getSnapshot({ credentialRef, expectedChannelId: channelId, videoId });
          return { privacyStatus: snapshot.privacyStatus ?? null, publishAt: snapshot.publishAt ?? null, etag: snapshot.etag };
        },
        async writeVideo({ videoId, privacyStatus, expectedEtag }) {
          const result = await videoDetails.applyFieldsUpdate({
            credentialRef,
            expectedChannelId: channelId,
            videoId,
            patch: { privacyStatus },
            ...(expectedEtag ? { expectedEtag } : {}),
          });
          return { privacyStatus: result.after.privacyStatus ?? null };
        },
        async listPlaylists() {
          return (await playlists.listPlaylists({ credentialRef })).playlists;
        },
        async writePlaylist({ playlistId, privacyStatus }) {
          return (await playlists.updatePlaylist({ credentialRef, playlistId, expectedChannelId: channelId, privacyStatus })).playlist;
        },
      }).setPrivacy(input);
    },
  };
}

export { createWorkerPrivacyServices, setPrivacyInputSchema, WORKER_PRIVACY_STATUSES } from "./services";
export type { SetPrivacyResult, WorkerPrivacyDeps, WorkerPrivacyServices, WorkerPrivacyStatus } from "./services";
