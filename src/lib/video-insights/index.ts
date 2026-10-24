import { getVideoInsightDataDates, listAppBroadcastIds, listChannelReachDaily, listStoredVideosByChannel, listVideoDailyViewsSince } from "@/lib/db";
import type { VideoInsightsResult } from "./contracts";
import { buildVideoInsights, windowStart } from "./services";

/** BL-221: the «Видео» list's extras for one channel, from this computer's database (no YouTube call). */
export async function loadVideoInsights(channelId: string): Promise<VideoInsightsResult> {
  const [videos, appBroadcastIds, dates] = await Promise.all([listStoredVideosByChannel(channelId), listAppBroadcastIds(channelId), getVideoInsightDataDates(channelId)]);
  const [dailyViews, reach] = await Promise.all([
    dates.views ? listVideoDailyViewsSince(channelId, windowStart(dates.views)) : Promise.resolve([]),
    dates.reach ? listChannelReachDaily(channelId, { startDate: windowStart(dates.reach), endDate: dates.reach }) : Promise.resolve([]),
  ]);
  return buildVideoInsights({
    channelId,
    videos: videos.map((v) => ({ videoId: v.videoId, liveBroadcastContent: v.liveBroadcastContent ?? null })),
    appBroadcastIds,
    dailyViews,
    reach,
    viewsThrough: dates.views,
    reachThrough: dates.reach,
  });
}

export { buildVideoInsights, windowStart } from "./services";
export type * from "./contracts";
