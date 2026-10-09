import type {
  PortfolioRange,
  StoredUploadMilestone,
  UploadMilestoneView,
  UploadMilestones,
  UploadMilestonesChannel,
  UploadMilestonesDeps,
} from "./contracts";

/** The UTC calendar date of a publish time, or null when it is not a time (same rule as the portfolio overview's upload count). */
function utcDate(publishedAt: string): string | null {
  const time = Date.parse(publishedAt);
  return Number.isNaN(time) ? null : new Date(time).toISOString().slice(0, 10);
}

function statusOf(stored: StoredUploadMilestone | undefined, due: boolean): UploadMilestoneView["status"] {
  if (stored) return stored.status;
  return due ? "due" : "not_due";
}

/** One channel's uploads in the range with their milestones (BL-166). */
async function loadChannel(deps: UploadMilestonesDeps, channel: { channelId: string; title: string }, range: PortfolioRange): Promise<UploadMilestonesChannel> {
  const videos = await deps.listVideos(channel.channelId);
  if (videos === null) return { channelId: channel.channelId, title: channel.title, reachState: "unavailable", reachError: null, uploads: null };
  const inRange = videos
    .flatMap((video) => {
      // A private or scheduled video's `publishedAt` is its upload time, not a publish date: not an upload yet.
      if (!deps.isPublished(video)) return [];
      const day = video.publishedAt === null ? null : utcDate(video.publishedAt);
      return day !== null && day >= range.startDate && day <= range.endDate ? [{ ...video, publishedAt: video.publishedAt as string }] : [];
    })
    .sort((a, b) => Date.parse(a.publishedAt) - Date.parse(b.publishedAt) || a.videoId.localeCompare(b.videoId));
  const planned = inRange.map((video) => ({
    video,
    windows: deps.milestoneDays.map((days) => ({ days, ...deps.windowOf(video.publishedAt, days) })),
  }));
  let reachError: string | null = null;
  const [stored, reach] = await Promise.all([
    inRange.length > 0 ? deps.listStoredMilestones(channel.channelId, inRange.map((video) => video.videoId)) : Promise.resolve([]),
    // Also with no upload in the range, so `reachState` still says whether Reach is set up.
    deps
      .readReach(
        channel.channelId,
        planned.flatMap(({ video, windows }) => windows.map((window) => ({ videoId: video.videoId, startDate: window.windowStart, endDate: window.windowEnd })))
      )
      .catch((error: unknown) => {
        const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
        reachError = typeof code === "string" && code.length > 0 ? code : "internal_error";
        return null;
      }),
  ]);
  // A row collected for another window (the video went public after it) is not this upload's milestone.
  const storedByKey = new Map(stored.map((row) => [`${row.videoId}\u0000${row.milestoneDays}\u0000${row.windowStart}\u0000${row.windowEnd}`, row]));
  const reachByKey = new Map((reach?.windows ?? []).map((window) => [`${window.videoId}\u0000${window.startDate}\u0000${window.endDate}`, window]));
  return {
    channelId: channel.channelId,
    title: channel.title,
    reachState: reach ? reach.state : "unavailable",
    reachError,
    uploads: planned.map(({ video, windows }) => ({
      videoId: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt,
      durationSeconds: video.durationSeconds,
      milestones: windows.map((window) => {
        const row = storedByKey.get(`${video.videoId}\u0000${window.days}\u0000${window.windowStart}\u0000${window.windowEnd}`);
        const windowReach = reachByKey.get(`${video.videoId}\u0000${window.windowStart}\u0000${window.windowEnd}`);
        const reachDays = reach?.state === "ready" && windowReach ? windowReach.daysWithData : 0;
        const collected = row?.status === "collected";
        return {
          milestoneDays: window.days,
          windowStart: window.windowStart,
          windowEnd: window.windowEnd,
          status: statusOf(row, deps.isDue(window.windowEnd)),
          collectedAt: row?.collectedAt ? row.collectedAt.toISOString() : null,
          totals: collected
            ? { views: row.views, estimatedMinutesWatched: row.estimatedMinutesWatched, averageViewDuration: row.averageViewDuration, averageViewPercentage: row.averageViewPercentage }
            : null,
          reach: {
            daysWithData: reachDays,
            impressions: reachDays > 0 ? windowReach!.impressions : null,
            ctr: reachDays > 0 ? windowReach!.ctr : null,
          },
        };
      }),
    })),
  };
}

export function createUploadMilestonesServices(deps: UploadMilestonesDeps) {
  return {
    /** Every connected channel's uploads in the range with their milestones, in the order the channels are listed. */
    async getUploadMilestones(range: PortfolioRange): Promise<UploadMilestones> {
      const channels = await deps.listChannels();
      return { ...range, source: "local", channels: await Promise.all(channels.map((channel) => loadChannel(deps, channel, range))) };
    },
  };
}

export type UploadMilestonesServices = ReturnType<typeof createUploadMilestonesServices>;
