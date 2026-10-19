import { createPlaylistManagementCore } from "@/lib/playlist-management";
import { createVideoDetailsCore } from "@/lib/video-details";
import type { VideoFieldsPort } from "@/lib/live-streams";

// The app layer's composition of live-streams with the modules it must not import itself (AGENTS.md §M): used by the live-stream
// routes (Start, «Применить настройки видео») and by the server's runner (BL-205 segment switches).

/**
 * BL-186 stage 3: the broadcast's video-level writers, composed at the app layer -- live-streams imports no other feature
 * module (AGENTS.md §M). video-details writes the video's fields (identity, backup, read-back); playlist-management adds the
 * video to a playlist of the same channel. Both keep their own Live-writes check.
 */
export function createLiveStreamVideoFields(): VideoFieldsPort {
  return {
    async apply({ credentialRef, channelId, videoId, patch }) {
      // 9 read-back retries, 10 s apart: a fresh broadcast's tags read back tens of seconds late (spike C; independent review).
      const result = await createVideoDetailsCore().applyFieldsUpdate({ credentialRef, expectedChannelId: channelId, videoId, patch, readBackRetries: 9 });
      return { verified: result.verified };
    },
    async addToPlaylist({ credentialRef, channelId, playlistId, videoId }) {
      const result = await createPlaylistManagementCore().addVideosToPlaylist({ credentialRef, expectedChannelId: channelId, playlistId, videoIds: [videoId] });
      const failure = result.failures[0];
      return result.added === 1 ? { added: true } : { added: false, reason: failure ? [failure.reason, failure.message].filter(Boolean).join(": ") : undefined };
    },
  };
}
