import {
  getVideoCommentCheckedOn,
  listStoredVideoComments,
  listStoredVideosByChannel,
  listVideoCommentStates,
  markVideoCommentsChecked,
  recordVideoCommentsFailure,
  saveVideoCommentsRead,
} from "@/lib/db";

// BL-171: the comments module's own tables, and the channel's synced videos (read only).
export function createVideoCommentStoreAdapter() {
  return {
    async listVideos(channelId: string) {
      return (await listStoredVideosByChannel(channelId)).map((video) => ({ videoId: video.videoId, title: video.title, privacyStatus: video.privacyStatus ?? null }));
    },
    store: {
      checkedOn: (channelId: string) => getVideoCommentCheckedOn(channelId),
      markChecked: (channelId: string, checkedOn: string, at: Date) => markVideoCommentsChecked(channelId, checkedOn, at),
      listStates: (channelId: string) => listVideoCommentStates(channelId),
      saveRead: (row: Parameters<typeof saveVideoCommentsRead>[0]) => saveVideoCommentsRead(row),
      recordFailure: (row: Parameters<typeof recordVideoCommentsFailure>[0]) => recordVideoCommentsFailure(row),
      listComments: (channelId: string, videoIds: string[]) => listStoredVideoComments(channelId, videoIds),
    },
  };
}
