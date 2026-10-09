import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { z } from "zod";
import { DomainError, isDomainError, type ResolvedCredentials } from "./contracts";
import { parseWithSchema } from "./schemas";
import { toPacificCalendarDate } from "./comparable-age";
import { ANALYTICS_REPORTING_LAG_DAYS } from "./data-quality";

/**
 * BL-166 (FO-REQ-0015 items 1/8, docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md): each video's day-7 and day-28 milestone -- the
 * audience-retention curve (100 points) and the totals YouTube Analytics reports for the window publish date .. +6 / +27 (Pacific). Raw
 * values only: nothing like "retention at N seconds" is computed (III.E.4.h); a reader gets the curve and the video's length.
 *
 * Its own small service next to the Analytics collection (it needs the same credentials, switch and quota reserve, but none of the
 * daily-row logic), so the collection's own services and tests are untouched.
 */

export const MILESTONE_DAYS = [7, 28] as const;
export type MilestoneDays = (typeof MILESTONE_DAYS)[number];
/** Milestones collected per channel per run (2 queries each); a larger backlog finishes over the next runs. */
export const MAX_MILESTONES_PER_RUN = 25;
/** A milestone YouTube keeps refusing gives up after this many attempts, so it never holds the queue. */
export const MAX_MILESTONE_ATTEMPTS = 3;
export const MILESTONE_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** Retention data arrives 48-72 h after a day; one day more than the daily rows' lag. */
export const MILESTONE_LAG_DAYS = ANALYTICS_REPORTING_LAG_DAYS + 1;
export const RETENTION_METRICS = ["audienceWatchRatio", "relativeRetentionPerformance", "startedWatching", "stoppedWatching", "totalSegmentImpressions"] as const;
export const MILESTONE_TOTAL_METRICS = ["views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage"] as const;

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The window of milestone `days` for a video published at `publishedAt` (Pacific dates, inclusive). */
export function milestoneWindow(publishedAt: string, days: number): { windowStart: string; windowEnd: string } {
  const windowStart = toPacificCalendarDate(publishedAt);
  return { windowStart, windowEnd: shiftIsoDate(windowStart, days - 1) };
}

/** Due once today (Pacific) is MILESTONE_LAG_DAYS after the window's last day. */
export function isMilestoneDue(windowEnd: string, now: Date): boolean {
  return toPacificCalendarDate(now.toISOString()) >= shiftIsoDate(windowEnd, MILESTONE_LAG_DAYS);
}

export type MilestoneState = { videoId: string; milestoneDays: number; status: "collected" | "retry" | "failed"; nextAttemptAt: Date | null };
export type PlannedMilestone = { videoId: string; milestoneDays: MilestoneDays; windowStart: string; windowEnd: string };

/**
 * The milestones to collect now: due, not collected, not given up; never-attempted ones first (oldest window first), then retries whose
 * time has come (earliest first); at most `max`.
 */
export function planDueMilestones(
  videos: Array<{ videoId: string; publishedAt: string | null }>,
  states: MilestoneState[],
  now: Date,
  max: number = MAX_MILESTONES_PER_RUN
): PlannedMilestone[] {
  const stateOf = new Map(states.map((state) => [`${state.videoId}|${state.milestoneDays}`, state]));
  const fresh: PlannedMilestone[] = [];
  const retries: Array<PlannedMilestone & { at: number }> = [];
  for (const video of videos) {
    if (!video.publishedAt || Number.isNaN(Date.parse(video.publishedAt))) continue;
    for (const days of MILESTONE_DAYS) {
      const window = milestoneWindow(video.publishedAt, days);
      if (!isMilestoneDue(window.windowEnd, now)) continue;
      const state = stateOf.get(`${video.videoId}|${days}`);
      const planned = { videoId: video.videoId, milestoneDays: days, ...window };
      if (!state) fresh.push(planned);
      else if (state.status === "retry" && (!state.nextAttemptAt || state.nextAttemptAt.getTime() <= now.getTime())) {
        retries.push({ ...planned, at: state.nextAttemptAt?.getTime() ?? 0 });
      }
    }
  }
  fresh.sort((a, b) => a.windowEnd.localeCompare(b.windowEnd) || a.videoId.localeCompare(b.videoId) || a.milestoneDays - b.milestoneDays);
  retries.sort((a, b) => a.at - b.at || a.windowEnd.localeCompare(b.windowEnd));
  return [...fresh, ...retries.map(({ at: _at, ...rest }) => (void _at, rest))].slice(0, max);
}

/** Errors that say nothing about one video: the run stops and no attempt is counted (reads off, quota, sign-in, channel access). */
function stopsTheRun(error: unknown): boolean {
  if (!isDomainError(error)) return false;
  const code = String(error.code);
  return (
    code === "analytics_reads_disabled" ||
    code === "youtube_quota_exceeded" ||
    code === "unauthorized" ||
    code === "CHANNEL_NOT_ACTIVE" ||
    code.startsWith("AUTH_")
  );
}

type BreakdownRow = { dimensionValues: string[]; metrics: Record<string, number> };
type RetentionPoint = {
  elapsedVideoTimeRatio: number;
  audienceWatchRatio: number | null;
  relativeRetentionPerformance: number | null;
  startedWatching: number | null;
  stoppedWatching: number | null;
  totalSegmentImpressions: number | null;
};

export type VideoMilestone = {
  videoId: string;
  milestoneDays: number;
  windowStart: string;
  windowEnd: string;
  status: "collected" | "retry" | "failed";
  attempts: number;
  lastError: string | null;
  collectedAt: string | null;
  /** The video's stored length, so a reader can place a time on the curve (null when unknown). */
  durationSeconds: number | null;
  totals: { views: number | null; estimatedMinutesWatched: number | null; averageViewDuration: number | null; averageViewPercentage: number | null };
  /** As returned (up to 100 points, 0.01 .. 1.00); empty when YouTube returned none or the milestone is not collected. */
  retention: RetentionPoint[];
};

export type StoredMilestoneRow = {
  videoId: string;
  milestoneDays: number;
  channelId: string;
  windowStart: string;
  windowEnd: string;
  status: "collected" | "retry" | "failed";
  attempts: number;
  lastError: string | null;
  nextAttemptAt: Date | null;
  collectedAt: Date | null;
  views: number | null;
  estimatedMinutesWatched: number | null;
  averageViewDuration: number | null;
  averageViewPercentage: number | null;
  retentionJson: string | null;
};

export type VideoMilestoneDependencies = {
  clock: { now(): Date };
  authResolver: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  channelAccess: { assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string> };
  videoStore: { listVideos(channelId: string): Promise<Array<{ videoId: string; publishedAt: string | null; durationSeconds: number | null }>> };
  youtubeApi: {
    queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions?: string;
      metricNames: readonly string[];
      filters?: string;
    }): Promise<BreakdownRow[]>;
  };
  store: {
    list(channelId: string, filter?: { videoIds?: string[]; milestoneDays?: number }): Promise<StoredMilestoneRow[]>;
    saveCollected(row: {
      videoId: string;
      milestoneDays: number;
      channelId: string;
      windowStart: string;
      windowEnd: string;
      views: number | null;
      estimatedMinutesWatched: number | null;
      averageViewDuration: number | null;
      averageViewPercentage: number | null;
      retentionJson: string;
      at: Date;
    }): Promise<void>;
    recordFailure(row: {
      videoId: string;
      milestoneDays: number;
      channelId: string;
      windowStart: string;
      windowEnd: string;
      error: string;
      at: Date;
      retryAt: Date;
      maxAttempts: number;
    }): Promise<"retry" | "failed">;
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
export const collectDueMilestonesInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
export const listVideoMilestonesInputSchema = z
  .object({
    channelId: z.string().min(1),
    credentialRef: credentialRefSchema.optional(),
    videoIds: z.array(z.string().min(1)).min(1).max(50).optional(),
    milestone: z.union([z.literal(7), z.literal(28)]).optional(),
  })
  .strict();

function metricOrNull(row: BreakdownRow | undefined, name: string): number | null {
  const value = row?.metrics[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toRetention(rows: BreakdownRow[]): RetentionPoint[] {
  return rows
    .map((row) => ({
      elapsedVideoTimeRatio: Number(row.dimensionValues[0]),
      audienceWatchRatio: metricOrNull(row, "audienceWatchRatio"),
      relativeRetentionPerformance: metricOrNull(row, "relativeRetentionPerformance"),
      startedWatching: metricOrNull(row, "startedWatching"),
      stoppedWatching: metricOrNull(row, "stoppedWatching"),
      totalSegmentImpressions: metricOrNull(row, "totalSegmentImpressions"),
    }))
    .filter((point) => Number.isFinite(point.elapsedVideoTimeRatio))
    .sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);
}

function parseRetention(json: string | null): RetentionPoint[] {
  if (!json) return [];
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? (value as RetentionPoint[]) : [];
  } catch {
    return [];
  }
}

function userIdOf(credentialRef: unknown): string | null {
  return credentialRef && typeof credentialRef === "object" && typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createVideoMilestoneServices(deps: VideoMilestoneDependencies) {
  return {
    /**
     * Collects the channel's due milestones (at most MAX_MILESTONES_PER_RUN, 2 queries each). A failure of one video's query counts an
     * attempt for that milestone and the run goes on; a failure that is not about one video (reads off, quota, sign-in) stops the run
     * without counting attempts.
     */
    async collectDueMilestones(input: unknown): Promise<{ attempted: number; collected: number; failed: number }> {
      const parsed = parseWithSchema(collectDueMilestonesInputSchema, input, "collect due milestones input");
      await deps.channelAccess.assertActiveChannel({ userId: parsed.credentialRef.userId, channelId: parsed.channelId });
      const now = deps.clock.now();
      const [videos, states] = await Promise.all([deps.videoStore.listVideos(parsed.channelId), deps.store.list(parsed.channelId)]);
      const plan = planDueMilestones(videos, states, now);
      if (plan.length === 0) return { attempted: 0, collected: 0, failed: 0 };
      const credentials = await deps.authResolver.resolve({ credentialRef: parsed.credentialRef, requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE] });
      let collected = 0;
      let failed = 0;
      for (const milestone of plan) {
        const query = { credentials, channelId: parsed.channelId, startDate: milestone.windowStart, endDate: milestone.windowEnd, filters: `video==${milestone.videoId}` };
        try {
          const curve = await deps.youtubeApi.queryChannelBreakdownReport({ ...query, dimensions: "elapsedVideoTimeRatio", metricNames: RETENTION_METRICS });
          const totals = await deps.youtubeApi.queryChannelBreakdownReport({ ...query, metricNames: MILESTONE_TOTAL_METRICS });
          const row = totals[0];
          await deps.store.saveCollected({
            videoId: milestone.videoId,
            milestoneDays: milestone.milestoneDays,
            channelId: parsed.channelId,
            windowStart: milestone.windowStart,
            windowEnd: milestone.windowEnd,
            views: metricOrNull(row, "views"),
            estimatedMinutesWatched: metricOrNull(row, "estimatedMinutesWatched"),
            averageViewDuration: metricOrNull(row, "averageViewDuration"),
            averageViewPercentage: metricOrNull(row, "averageViewPercentage"),
            retentionJson: JSON.stringify(toRetention(curve)),
            at: deps.clock.now(),
          });
          collected += 1;
        } catch (error) {
          if (stopsTheRun(error)) throw error;
          failed += 1;
          const at = deps.clock.now();
          await deps.store.recordFailure({
            videoId: milestone.videoId,
            milestoneDays: milestone.milestoneDays,
            channelId: parsed.channelId,
            windowStart: milestone.windowStart,
            windowEnd: milestone.windowEnd,
            error: error instanceof Error ? error.message : String(error),
            at,
            retryAt: new Date(at.getTime() + MILESTONE_RETRY_AFTER_MS),
            maxAttempts: MAX_MILESTONE_ATTEMPTS,
          });
        }
      }
      return { attempted: plan.length, collected, failed };
    },

    /** Stored milestones of the session channel's videos (any status), each with the video's length. Local only. */
    async listVideoMilestones(input: unknown): Promise<{ channelId: string; milestones: VideoMilestone[] }> {
      const parsed = parseWithSchema(listVideoMilestonesInputSchema, input, "list video milestones input");
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
      const videos = await deps.videoStore.listVideos(parsed.channelId);
      const durationOf = new Map(videos.map((video) => [video.videoId, video.durationSeconds]));
      const rows = await deps.store.list(parsed.channelId, { videoIds: parsed.videoIds, milestoneDays: parsed.milestone });
      return {
        channelId: parsed.channelId,
        milestones: rows
          .filter((row) => durationOf.has(row.videoId))
          .map((row) => ({
            videoId: row.videoId,
            milestoneDays: row.milestoneDays,
            windowStart: row.windowStart,
            windowEnd: row.windowEnd,
            status: row.status,
            attempts: row.attempts,
            lastError: row.lastError,
            collectedAt: row.collectedAt ? row.collectedAt.toISOString() : null,
            durationSeconds: durationOf.get(row.videoId) ?? null,
            totals: {
              views: row.views,
              estimatedMinutesWatched: row.estimatedMinutesWatched,
              averageViewDuration: row.averageViewDuration,
              averageViewPercentage: row.averageViewPercentage,
            },
            retention: parseRetention(row.retentionJson),
          })),
      };
    },
  };
}

export type VideoMilestoneServices = ReturnType<typeof createVideoMilestoneServices>;
export { DomainError };
