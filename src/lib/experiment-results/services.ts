import { z } from "zod";
import { DomainError, parseWithSchema } from "@/lib/shared-domain";

/**
 * BL-170 (FO-REQ-0015 item 3, docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md §2 "Reads"): an experiment's videos by arm, each with its stored
 * day-7 / day-28 values -- the milestone totals, Reach over the same window and the traffic sources and devices summed over it. One call
 * evaluates a test. Nothing is averaged or compared across videos or arms (III.E.4.h): each video's own stored values, grouped by arm.
 *
 * Its own module (AGENTS.md §M): it composes the decision engine (the arms) with analytics, Reach and the channel sync (the values)
 * through their public cores, so the decision engine itself stays free of analytics (PHASE10-INV-03). Every read is channel-scoped by
 * the core it goes through. The milestone status words follow `producer_upload_milestones` (portfolio-overview/upload-milestones.ts).
 */

type ArmVideo = { videoId: string; linkedAt: string; linkedBy: string; linkedVia: "web_ui" | "producer_proposal" };
type Totals = { views: number | null; estimatedMinutesWatched: number | null; averageViewDuration: number | null; averageViewPercentage: number | null };
type BreakdownSum = { value: string; label: string; views: number | null; estimatedMinutesWatched: number | null };
type BreakdownDayRow = { day?: string; value: string; label: string; views: number | null; estimatedMinutesWatched: number | null };

export type ExperimentResultsDependencies = {
  /** The experiment (channel-scoped by the decision engine). */
  getExperiment(experimentId: string, ctx: { userId: string | null }): Promise<{
    experimentId: string;
    hypothesisId: string;
    status: string;
    treatment: string;
    controlBaseline: string;
    successCriteria: string;
    stoppingCriteria: string;
    plannedDuration: string | null;
  }>;
  listArms(experimentId: string, ctx: { userId: string | null }): Promise<{ channelId: string | null; arms: Array<{ arm: string; videos: ArmVideo[] }> }>;
  listVideos(channelId: string, credentialRef: { userId: string } | undefined): Promise<Array<{
    videoId: string;
    title: string;
    publishedAt: string | null;
    privacyStatus: string | null;
    liveBroadcastContent: string | null;
    durationSeconds: number | null;
  }>>;
  milestoneDays: readonly number[];
  windowOf(publishedAt: string, days: number): { windowStart: string; windowEnd: string };
  isDue(windowEnd: string): boolean;
  isPublished(video: { publishedAt: string | null; privacyStatus: string | null; liveBroadcastContent: string | null }): boolean;
  /** Stored milestones of these videos (never called with none): collected, retry or failed rows for their current windows. */
  listMilestones(channelId: string, videoIds: string[], credentialRef: { userId: string } | undefined): Promise<Array<{
    videoId: string;
    milestoneDays: number;
    windowStart: string;
    windowEnd: string;
    status: "collected" | "retry" | "failed";
    collectedAt: string | null;
    totals: Totals;
  }>>;
  /** Stored traffic sources and devices of one video, by day, for startDate..endDate, with the stored coverage. */
  listBreakdowns(channelId: string, videoId: string, startDate: string, endDate: string, credentialRef: { userId: string } | undefined): Promise<{
    coverage: { from: string; through: string } | null;
    trafficSources: BreakdownDayRow[];
    devices: BreakdownDayRow[];
  } | null>;
  readReach(channelId: string, windows: Array<{ videoId: string; startDate: string; endDate: string }>, credentialRef: { userId: string } | undefined): Promise<{
    state: string;
    windows: Array<{ videoId: string; startDate: string; endDate: string; daysWithData: number; impressions: number | null; ctr: number | null }>;
  }>;
};

export const getExperimentResultsInputSchema = z
  .object({
    channelId: z.string().min(1),
    experimentId: z.string().min(1).max(100),
    credentialRef: z.object({ userId: z.string().min(1) }).strict().optional(),
  })
  .strict();

export type ExperimentResultsMilestone = {
  milestoneDays: number;
  windowStart: string;
  windowEnd: string;
  status: "collected" | "retry" | "failed" | "due" | "not_due";
  collectedAt: string | null;
  totals: Totals | null;
  reach: { daysWithData: number; impressions: number | null; ctr: number | null };
  trafficSources: BreakdownSum[];
  devices: BreakdownSum[];
};

export type ExperimentResultsVideo = ArmVideo & {
  /** Null when the video is no longer among the channel's synced videos. */
  title: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  /** False while the video is private, unlisted or scheduled (or no longer synced): it has no milestones yet. */
  published: boolean;
  /** Which days of traffic sources and devices are stored for it (its first 90 days at most); null when none are. */
  breakdownCoverage: { from: string; through: string } | null;
  milestones: ExperimentResultsMilestone[];
};

export type ExperimentResults = {
  channelId: string;
  experiment: Awaited<ReturnType<ExperimentResultsDependencies["getExperiment"]>>;
  reachState: string;
  /** The Reach read's error code, when it failed (the other values are still returned). */
  reachError: string | null;
  arms: Array<{ arm: string; videos: ExperimentResultsVideo[] }>;
};

function addOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

/** Each value's views and minutes summed over from..to (inclusive), most views first, then by value. */
export function sumBreakdownWindow(rows: BreakdownDayRow[], from: string, to: string): BreakdownSum[] {
  const totals = new Map<string, BreakdownSum>();
  for (const row of rows) {
    if (!row.day || row.day < from || row.day > to) continue;
    const total = totals.get(row.value) ?? { value: row.value, label: row.label, views: null, estimatedMinutesWatched: null };
    total.views = addOrNull(total.views, row.views);
    total.estimatedMinutesWatched = addOrNull(total.estimatedMinutesWatched, row.estimatedMinutesWatched);
    totals.set(row.value, total);
  }
  return [...totals.values()].sort((a, b) => (b.views ?? -1) - (a.views ?? -1) || a.value.localeCompare(b.value));
}

function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && code.length > 0 ? code : "internal_error";
}

export function createExperimentResultsServices(deps: ExperimentResultsDependencies) {
  return {
    /**
     * The experiment of `channelId` with each arm's videos and their stored values. An experiment of another channel (or of no channel)
     * is EXPERIMENT_NOT_FOUND, as the decision engine reports one it cannot see. A video without stored data is listed with null values
     * and `due` / `not_due` milestones, never an error.
     */
    async getExperimentResults(input: unknown): Promise<ExperimentResults> {
      const parsed = parseWithSchema(getExperimentResultsInputSchema, input, "get experiment results input");
      const ctx = { userId: parsed.credentialRef?.userId ?? null };
      const [experiment, armsView] = await Promise.all([deps.getExperiment(parsed.experimentId, ctx), deps.listArms(parsed.experimentId, ctx)]);
      if (armsView.channelId !== parsed.channelId) {
        throw new DomainError({ code: "EXPERIMENT_NOT_FOUND", message: "Experiment not found", details: { experimentId: parsed.experimentId } });
      }
      const channelId = parsed.channelId;
      const linked = armsView.arms.flatMap((arm) => arm.videos);
      const synced = linked.length > 0 ? await deps.listVideos(channelId, parsed.credentialRef) : [];
      const videoOf = new Map(synced.map((video) => [video.videoId, video]));
      // Each linked, published video's milestone windows.
      const planned = linked.flatMap((link) => {
        const video = videoOf.get(link.videoId);
        if (!video || !deps.isPublished(video)) return [];
        return [{ videoId: link.videoId, windows: deps.milestoneDays.map((days) => ({ days, ...deps.windowOf(video.publishedAt as string, days) })) }];
      });
      const plannedOf = new Map(planned.map((entry) => [entry.videoId, entry.windows]));
      let reachError: string | null = null;
      const [milestones, reach, breakdowns] = await Promise.all([
        planned.length > 0 ? deps.listMilestones(channelId, planned.map((entry) => entry.videoId), parsed.credentialRef) : Promise.resolve([]),
        deps
          .readReach(channelId, planned.flatMap((entry) => entry.windows.map((window) => ({ videoId: entry.videoId, startDate: window.windowStart, endDate: window.windowEnd }))), parsed.credentialRef)
          .catch((error: unknown) => {
            reachError = errorCode(error);
            return null;
          }),
        // One read per video over its longest window (it holds the shorter ones).
        Promise.all(
          planned.map(async (entry) => {
            const from = entry.windows[0].windowStart;
            const to = entry.windows.reduce((latest, window) => (window.windowEnd > latest ? window.windowEnd : latest), from);
            return [entry.videoId, await deps.listBreakdowns(channelId, entry.videoId, from, to, parsed.credentialRef)] as const;
          })
        ),
      ]);
      const milestoneOf = new Map(milestones.map((row) => [`${row.videoId}\u0000${row.milestoneDays}\u0000${row.windowStart}\u0000${row.windowEnd}`, row]));
      const reachOf = new Map((reach?.windows ?? []).map((window) => [`${window.videoId}\u0000${window.startDate}\u0000${window.endDate}`, window]));
      const breakdownOf = new Map(breakdowns);

      const toVideo = (link: ArmVideo): ExperimentResultsVideo => {
        const video = videoOf.get(link.videoId);
        const windows = plannedOf.get(link.videoId) ?? [];
        const stored = breakdownOf.get(link.videoId) ?? null;
        return {
          ...link,
          title: video?.title ?? null,
          publishedAt: video?.publishedAt ?? null,
          durationSeconds: video?.durationSeconds ?? null,
          published: windows.length > 0,
          breakdownCoverage: stored?.coverage ?? null,
          milestones: windows.map((window) => {
            const row = milestoneOf.get(`${link.videoId}\u0000${window.days}\u0000${window.windowStart}\u0000${window.windowEnd}`);
            const windowReach = reachOf.get(`${link.videoId}\u0000${window.windowStart}\u0000${window.windowEnd}`);
            const reachDays = reach?.state === "ready" && windowReach ? windowReach.daysWithData : 0;
            return {
              milestoneDays: window.days,
              windowStart: window.windowStart,
              windowEnd: window.windowEnd,
              status: row ? row.status : deps.isDue(window.windowEnd) ? "due" : "not_due",
              collectedAt: row?.collectedAt ?? null,
              totals: row?.status === "collected" ? row.totals : null,
              reach: { daysWithData: reachDays, impressions: reachDays > 0 ? windowReach!.impressions : null, ctr: reachDays > 0 ? windowReach!.ctr : null },
              trafficSources: stored ? sumBreakdownWindow(stored.trafficSources, window.windowStart, window.windowEnd) : [],
              devices: stored ? sumBreakdownWindow(stored.devices, window.windowStart, window.windowEnd) : [],
            };
          }),
        };
      };

      return {
        channelId,
        experiment,
        reachState: reach ? reach.state : "unavailable",
        reachError,
        arms: armsView.arms.map((arm) => ({ arm: arm.arm, videos: arm.videos.map(toVideo) })),
      };
    },
  };
}

export type ExperimentResultsServices = ReturnType<typeof createExperimentResultsServices>;
