import { cancelVideoReservation, getGenerationPlanVideo, insertVideoReservation, listPublishingUploadVideos, listVideoReservations } from "@/lib/db";
import type { OwnReservation, VideoProjectsDeps } from "../contracts";

/** BL-194: this computer's reservations (`video_reservations`, schema v95) and the numbers the uploads and plans tables know. */
export function createVideoProjectsStore(): VideoProjectsDeps["store"] & Pick<VideoProjectsDeps, "uploads" | "planVideo"> {
  const toOwn = (row: Awaited<ReturnType<typeof listVideoReservations>>[number]): OwnReservation => ({
    channelId: row.channelId,
    video: row.video,
    workingTitle: row.workingTitle ?? null,
    reservedAt: row.reservedAt,
    state: row.state === "cancelled" ? "cancelled" : "in_work",
    cancelledAt: row.cancelledAt ?? null,
    replacedBy: row.replacedBy ?? null,
  });
  return {
    list: async (channelId) => (await listVideoReservations(channelId ? { channelId } : {})).map(toOwn),
    insert: (row) => insertVideoReservation(row),
    cancel: (channelId, video, set) => cancelVideoReservation(channelId, video, set),
    uploads: (channelId) => listPublishingUploadVideos(channelId),
    planVideo: (planId) => getGenerationPlanVideo(planId),
  };
}
