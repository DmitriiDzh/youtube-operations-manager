import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { z } from "zod";
import { calendarDateSchema } from "@/lib/shared-domain";
import type { ResolvedCredentials } from "./contracts";
import { parseWithSchema } from "./schemas";
import { toPacificCalendarDate } from "./comparable-age";
import { hasFinalPublishDate, type MilestoneVideo } from "./milestones";
import { failureKind } from "./query-failure";
import { videoBreakdownWindow, type BreakdownState } from "./breakdowns";

/**
 * The one owner of the stored traffic-source details (`insightTrafficSourceDetail` for one traffic source): which own videos and channel
 * weeks are due, the collection loop with its failure rules, and the shape of the stored reads. Two configurations use it:
 * - BL-169 (`search-terms.ts`, docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md): `YT_SEARCH`, the search terms;
 * - BL-191 (`suggested-sources.ts`, docs/roadmap/plans/SUGGESTED_SOURCES_PLAN.md): `RELATED_VIDEO`, the videos that suggested ours.
 *
 * YouTube gives this report only as a total over a range (no day split) and at most 25 rows per query (checked live 2026-10-10, BL-169
 * plan §1); the values are kept as returned (own-channel Analytics data, III.E.4.b). Each configuration has its own state subjects in
 * `analytics_breakdown_state`, so one never makes the other due.
 */

/** Checked live 2026-10-10: `maxResults` and `sort` are required (400 without), 25 is the most YouTube accepts (50 gives a 500). */
export const TRAFFIC_DETAIL_QUERY = {
  dimensions: "insightTrafficSourceDetail",
  metricNames: ["views", "estimatedMinutesWatched"] as const,
  maxResults: 25,
  sort: "-views",
} as const;
/** Reads are a week apart; after its window has ended a video gets one settled read on or after window end + 7. */
export const TRAFFIC_DETAIL_READ_EVERY_DAYS = 7;
/** Queries (one per subject) per channel per run; a larger backlog finishes over the next runs, least recently read first. */
export const MAX_TRAFFIC_DETAIL_QUERIES_PER_RUN = 100;
export const MAX_TRAFFIC_DETAIL_ATTEMPTS = 3;
export const TRAFFIC_DETAIL_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The last complete Monday-Sunday weeks of the channel that are read; an older week never read is not read any more. */
export const CHANNEL_TRAFFIC_DETAIL_WEEKS = 13;
export const MAX_TRAFFIC_DETAIL_READ_DAYS = 92;

/** Which traffic source is read and under which state subjects (`<videoPrefix><video id>`, `<weekPrefix><Monday>`). */
export type TrafficDetailSpec = {
  sourceType: "YT_SEARCH" | "RELATED_VIDEO";
  videoPrefix: string;
  weekPrefix: string;
  /** Names the rows in input errors ("search terms", "suggested sources"). */
  label: string;
};

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A video (`videoId`) or a channel week (`videoId` null, `from` its Monday, `to` its Sunday). */
export type PlannedTrafficDetail = { subject: string; videoId: string | null; rangeStart: string; from: string; to: string };

/** The Monday of the week (Monday-Sunday) containing `date`. */
function mondayOf(date: string): string {
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return shiftIsoDate(date, -((dayOfWeek + 6) % 7));
}

/** The Mondays of the last CHANNEL_TRAFFIC_DETAIL_WEEKS weeks that end on or before `latest`, newest first. */
export function completeTrafficDetailWeeks(latest: string): string[] {
  const monday = mondayOf(latest);
  const newest = shiftIsoDate(monday, 6) === latest ? monday : shiftIsoDate(monday, -7);
  return Array.from({ length: CHANNEL_TRAFFIC_DETAIL_WEEKS }, (_, i) => shiftIsoDate(newest, -7 * i));
}

/**
 * The subjects to read now, at most `max`: the channel's due weeks first (newest first), then the videos least recently read first (never
 * read first, newest publish date first among equals); within that batch, those whose last attempt failed last -- the BL-168 queue, so
 * none is starved and one that keeps getting no answer does not head the run. A week is due once it is complete (its Sunday is yesterday
 * or earlier) and once more on or after Sunday + 7 unless its first read already was; only the last CHANNEL_TRAFFIC_DETAIL_WEEKS weeks are
 * considered. While its window runs, a video is due once it has 7 days (yesterday ≥ window start + 6) and then whenever 7 days have
 * passed since its last read; once the window has ended, once on or after window end + 7 unless the last read already was. Each read covers
 * the window so far. `failed` videos are never planned, a `retry` waits for its time, and a state for another window start (the publish
 * date moved) counts as never read. Only the states under `spec`'s subjects count.
 */
export function planDueTrafficDetails(
  spec: TrafficDetailSpec,
  videos: MilestoneVideo[],
  states: BreakdownState[],
  now: Date,
  max: number = MAX_TRAFFIC_DETAIL_QUERIES_PER_RUN
): PlannedTrafficDetail[] {
  const today = toPacificCalendarDate(now.toISOString());
  const latest = shiftIsoDate(today, -1);
  const stateOf = new Map(states.map((state) => [state.subject, state]));
  /** The state of the subject for this range start, unless it is failed or waiting for its retry time (then null: skip). */
  const usable = (subject: string, rangeStart: string): BreakdownState | undefined | null => {
    const stored = stateOf.get(subject);
    const state = stored && stored.rangeStart === rangeStart ? stored : undefined;
    if (state?.status === "failed") return null;
    if (state?.status === "retry" && state.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) return null;
    return state;
  };

  const weeks: Array<{ planned: PlannedTrafficDetail; retry: boolean }> = [];
  for (const weekStart of completeTrafficDetailWeeks(latest)) {
    const subject = `${spec.weekPrefix}${weekStart}`;
    const state = usable(subject, weekStart);
    if (state === null) continue;
    const weekEnd = shiftIsoDate(weekStart, 6);
    const settledOn = shiftIsoDate(weekEnd, TRAFFIC_DETAIL_READ_EVERY_DAYS);
    const lastReadOn = state?.collectedOn ?? null;
    if (lastReadOn !== null && !(lastReadOn < settledOn && today >= settledOn)) continue;
    weeks.push({ planned: { subject, videoId: null, rangeStart: weekStart, from: weekStart, to: weekEnd }, retry: state?.status === "retry" });
  }

  const due: Array<{ planned: PlannedTrafficDetail; lastAt: number; retry: boolean; publishedAt: number }> = [];
  for (const video of videos.filter(hasFinalPublishDate)) {
    const { windowStart, windowEnd } = videoBreakdownWindow(video.publishedAt as string);
    const subject = `${spec.videoPrefix}${video.videoId}`;
    const state = usable(subject, windowStart);
    if (state === null) continue;
    const lastReadOn = state?.collectedOn ?? null;
    const ended = windowEnd <= latest;
    let isDue: boolean;
    if (ended) {
      const settledOn = shiftIsoDate(windowEnd, TRAFFIC_DETAIL_READ_EVERY_DAYS);
      isDue = today >= settledOn && (lastReadOn === null || lastReadOn < settledOn);
    } else {
      isDue = latest >= shiftIsoDate(windowStart, TRAFFIC_DETAIL_READ_EVERY_DAYS - 1) && (lastReadOn === null || today >= shiftIsoDate(lastReadOn, TRAFFIC_DETAIL_READ_EVERY_DAYS));
    }
    if (!isDue) continue;
    due.push({
      planned: { subject, videoId: video.videoId, rangeStart: windowStart, from: windowStart, to: ended ? windowEnd : latest },
      lastAt: state?.collectedAt?.getTime() ?? Number.NEGATIVE_INFINITY,
      retry: state?.status === "retry",
      publishedAt: Date.parse(video.publishedAt as string),
    });
  }
  // Never read (-Infinity) first; `-Infinity - -Infinity` is NaN, which falls through to the next key.
  due.sort((a, b) => a.lastAt - b.lastAt || b.publishedAt - a.publishedAt || a.planned.subject.localeCompare(b.planned.subject));
  const batch = [...weeks, ...due].slice(0, max);
  return [...batch.filter((item) => !item.retry), ...batch.filter((item) => item.retry)].map((item) => item.planned);
}

/** One stored row: the detail YouTube named (a search term, a suggesting video id) and its two metrics. */
export type TrafficDetailValue = { detail: string; views: number | null; estimatedMinutesWatched: number | null };

type ReportRow = { dimensionValues: string[]; metrics: Record<string, number> };

function metricOrNull(row: ReportRow, name: string): number | null {
  const value = row.metrics[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One row per detail; a row without a detail is skipped and a repeated detail keeps YouTube's last row. */
export function toTrafficDetailRows(rows: ReportRow[]): TrafficDetailValue[] {
  const byDetail = new Map<string, TrafficDetailValue>();
  for (const row of rows) {
    const detail = row.dimensionValues[0];
    if (!detail) continue;
    byDetail.set(detail, { detail, views: metricOrNull(row, "views"), estimatedMinutesWatched: metricOrNull(row, "estimatedMinutesWatched") });
  }
  return [...byDetail.values()];
}

/** Most views first (a missing count last), then by detail. */
function byViews(a: TrafficDetailValue, b: TrafficDetailValue): number {
  return (b.views ?? -1) - (a.views ?? -1) || a.detail.localeCompare(b.detail);
}

export type StoredTrafficDetailStateRow = BreakdownState & { attempts: number; lastError: string | null };

export type TrafficDetailDependencies = {
  clock: { now(): Date };
  authResolver: { resolve(args: { credentialRef: unknown; requiredScopes: readonly string[] }): Promise<ResolvedCredentials> };
  channelAccess: { assertActiveChannel(args: { userId: string | null | undefined; channelId: string }): Promise<string> };
  videoStore: { listVideos(channelId: string): Promise<MilestoneVideo[]> };
  youtubeApi: {
    queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions?: string;
      metricNames: readonly string[];
      filters?: string;
      maxResults?: number;
      sort?: string;
    }): Promise<ReportRow[]>;
  };
  store: {
    /** Every state row of the channel (the breakdowns' and the other details' too); only this spec's subjects are used. */
    listStates(channelId: string): Promise<StoredTrafficDetailStateRow[]>;
    /** Replaces the video's rows with the answer and records the range, atomically. */
    saveVideoRows(row: {
      channelId: string;
      subject: string;
      videoId: string;
      rangeStart: string;
      to: string;
      rows: TrafficDetailValue[];
      collectedOn: string;
      at: Date;
    }): Promise<void>;
    /** Puts a subject back until `retryAt` without counting an attempt. */
    defer(row: { channelId: string; subject: string; rangeStart: string; error: string; at: Date; retryAt: Date }): Promise<void>;
    recordFailure(row: {
      channelId: string;
      subject: string;
      rangeStart: string;
      error: string;
      at: Date;
      retryAt: Date;
      maxAttempts: number;
    }): Promise<"retry" | "failed">;
    listVideoRows(channelId: string, videoIds: string[]): Promise<Array<TrafficDetailValue & { videoId: string }>>;
    /** Replaces one channel week's rows with the answer and records the week, atomically. */
    saveWeekRows(row: { channelId: string; subject: string; weekStart: string; to: string; rows: TrafficDetailValue[]; collectedOn: string; at: Date }): Promise<void>;
    listWeekRows(channelId: string, firstWeekStart: string, lastWeekStart: string): Promise<Array<TrafficDetailValue & { weekStart: string }>>;
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
export const collectDueTrafficDetailsInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();

/**
 * Two forms: `videoIds` (each video's rows over its stored range), or `startDate`/`endDate` (+ `groupBy`) for the channel weeks. The
 * dates belong to the channel form only, so they are refused together with `videoIds`, and required without it. `noun` names the rows
 * in the messages ("terms", "suggesting videos").
 */
export function listStoredTrafficDetailsInputSchema(noun: string) {
  return z
    .object({
      channelId: z.string().min(1),
      credentialRef: credentialRefSchema.optional(),
      videoIds: z.array(z.string().min(1)).min(1).max(20).optional(),
      startDate: calendarDateSchema.optional(),
      endDate: calendarDateSchema.optional(),
      groupBy: z.enum(["total", "week"]).optional(),
    })
    .strict()
    .refine((input) => !input.videoIds || (input.startDate === undefined && input.endDate === undefined && input.groupBy === undefined), {
      message: `videoIds reads each video's ${noun} over its stored range: leave out startDate, endDate and groupBy (they are for the channel weeks)`,
    })
    .refine((input) => input.videoIds !== undefined || (input.startDate !== undefined && input.endDate !== undefined), {
      message: "without videoIds, startDate and endDate are required (the channel weeks lying inside them are read)",
    })
    .refine((input) => !input.startDate || !input.endDate || input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
    .refine(
      (input) =>
        !input.startDate ||
        !input.endDate ||
        Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) <= (MAX_TRAFFIC_DETAIL_READ_DAYS - 1) * 86_400_000,
      { message: `at most ${MAX_TRAFFIC_DETAIL_READ_DAYS} days` }
    );
}
export type ListStoredTrafficDetailsInput = z.infer<ReturnType<typeof listStoredTrafficDetailsInputSchema>>;

export type StoredTrafficDetailsVideo = {
  videoId: string;
  publishedAt: string;
  window: { start: string; end: string };
  /** The range the stored rows cover (window start .. the last read's end) and when it was read; null when never read. */
  coverage: { from: string; through: string; collectedAt: string | null } | null;
  status: "collected" | "retry" | "failed" | "not_collected";
  lastError: string | null;
  rows: TrafficDetailValue[];
};
export type StoredTrafficDetailsWeek = {
  weekStart: string;
  weekEnd: string;
  status: "collected" | "retry" | "failed" | "not_collected";
  collectedAt: string | null;
  lastError: string | null;
  /** Only with `groupBy: "week"`. */
  rows?: TrafficDetailValue[];
};
export type ListStoredTrafficDetailsResult =
  | { channelId: string; videos: StoredTrafficDetailsVideo[] }
  | {
      channelId: string;
      startDate: string;
      endDate: string;
      groupBy: "total" | "week";
      /** The complete weeks lying inside startDate..endDate, oldest first. */
      weeks: StoredTrafficDetailsWeek[];
      /** Only with `groupBy: "total"`: each detail summed over the weeks that were read (a sum of weekly top-25 lists). */
      rows?: TrafficDetailValue[];
    };

function addOrNull(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return a + b;
}

function userIdOf(credentialRef: unknown): string | null {
  return credentialRef && typeof credentialRef === "object" && typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createTrafficDetailServices(spec: TrafficDetailSpec, deps: TrafficDetailDependencies, inputSchema = listStoredTrafficDetailsInputSchema("rows")) {
  const listSpecStates = async (channelId: string) =>
    (await deps.store.listStates(channelId)).filter((state) => state.subject.startsWith(spec.videoPrefix) || state.subject.startsWith(spec.weekPrefix));

  const listWeeks = async (channelId: string, startDate: string, endDate: string, groupBy: "total" | "week"): Promise<ListStoredTrafficDetailsResult> => {
    const latest = shiftIsoDate(toPacificCalendarDate(deps.clock.now().toISOString()), -1);
    const lastDay = endDate < latest ? endDate : latest;
    const mondays: string[] = [];
    // From the first Monday on or after startDate (the Monday of the week holding startDate + 6), every week whose Sunday is on or before
    // the earlier of endDate and yesterday.
    for (let monday = mondayOf(shiftIsoDate(startDate, 6)); shiftIsoDate(monday, 6) <= lastDay; monday = shiftIsoDate(monday, 7)) mondays.push(monday);
    const base = { channelId, startDate, endDate, groupBy };
    if (mondays.length === 0) return { ...base, weeks: [], ...(groupBy === "total" ? { rows: [] } : {}) };
    const [states, rows] = await Promise.all([listSpecStates(channelId), deps.store.listWeekRows(channelId, mondays[0], mondays[mondays.length - 1])]);
    const stateOf = new Map(states.map((state) => [state.subject, state]));
    const totals = new Map<string, TrafficDetailValue>();
    const weeks = mondays.map((weekStart): StoredTrafficDetailsWeek => {
      const state = stateOf.get(`${spec.weekPrefix}${weekStart}`);
      const current = state?.collectedThrough ? rows.filter((row) => row.weekStart === weekStart) : [];
      for (const row of current) {
        const total = totals.get(row.detail) ?? { detail: row.detail, views: null, estimatedMinutesWatched: null };
        total.views = addOrNull(total.views, row.views);
        total.estimatedMinutesWatched = addOrNull(total.estimatedMinutesWatched, row.estimatedMinutesWatched);
        totals.set(row.detail, total);
      }
      return {
        weekStart,
        weekEnd: shiftIsoDate(weekStart, 6),
        status: state ? state.status : "not_collected",
        collectedAt: state?.collectedAt ? state.collectedAt.toISOString() : null,
        lastError: state?.lastError ?? null,
        ...(groupBy === "week" ? { rows: current.map(({ detail, views, estimatedMinutesWatched }) => ({ detail, views, estimatedMinutesWatched })).sort(byViews) } : {}),
      };
    });
    return { ...base, weeks, ...(groupBy === "total" ? { rows: [...totals.values()].sort(byViews) } : {}) };
  };

  return {
    /**
     * Reads the channel's due weeks and videos (at most MAX_TRAFFIC_DETAIL_QUERIES_PER_RUN, one query each). Failures follow the milestone
     * rules (`query-failure.ts`): `stop` ends the run with nothing written, `defer` puts the subject back by a day, `attempt` counts one of
     * its 3 attempts and the run goes on. A video's `defer` ends the run; a week's `defer` only ends the weeks of this run and the videos
     * are still read (review of BL-169: the 13 never-read weeks head every batch, so each week getting no answer in turn ended 13 runs in a
     * row with no video read). If the videos get no answer either, the first one ends the run.
     */
    async collectDue(input: unknown): Promise<{ attempted: number; collected: number; failed: number }> {
      const parsed = parseWithSchema(collectDueTrafficDetailsInputSchema, input, `collect due ${spec.label} input`);
      await deps.channelAccess.assertActiveChannel({ userId: parsed.credentialRef.userId, channelId: parsed.channelId });
      const now = deps.clock.now();
      const [videos, states] = await Promise.all([deps.videoStore.listVideos(parsed.channelId), listSpecStates(parsed.channelId)]);
      const plan = planDueTrafficDetails(spec, videos, states, now);
      if (plan.length === 0) return { attempted: 0, collected: 0, failed: 0 };
      const credentials = await deps.authResolver.resolve({ credentialRef: parsed.credentialRef, requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE] });
      const collectedOn = toPacificCalendarDate(now.toISOString());
      const sourceFilter = `insightTrafficSourceType==${spec.sourceType}`;
      let attempted = 0;
      let collected = 0;
      let failed = 0;
      let weeksStopped = false;
      for (const item of plan) {
        if (item.videoId === null && weeksStopped) continue;
        attempted += 1;
        try {
          const answer = await deps.youtubeApi.queryChannelBreakdownReport({
            credentials,
            channelId: parsed.channelId,
            startDate: item.from,
            endDate: item.to,
            ...TRAFFIC_DETAIL_QUERY,
            filters: item.videoId ? `video==${item.videoId};${sourceFilter}` : sourceFilter,
          });
          const saved = { channelId: parsed.channelId, subject: item.subject, to: item.to, rows: toTrafficDetailRows(answer), collectedOn, at: deps.clock.now() };
          if (item.videoId) {
            await deps.store.saveVideoRows({ ...saved, videoId: item.videoId, rangeStart: item.rangeStart });
          } else {
            await deps.store.saveWeekRows({ ...saved, weekStart: item.from });
          }
          collected += 1;
        } catch (error) {
          const kind = failureKind(error);
          if (kind === "stop") throw error;
          const at = deps.clock.now();
          const failure = {
            channelId: parsed.channelId,
            subject: item.subject,
            rangeStart: item.rangeStart,
            error: error instanceof Error ? error.message : String(error),
            at,
            retryAt: new Date(at.getTime() + TRAFFIC_DETAIL_RETRY_AFTER_MS),
          };
          if (kind === "defer") {
            await deps.store.defer(failure);
            if (item.videoId !== null) throw error;
            weeksStopped = true;
            continue;
          }
          failed += 1;
          await deps.store.recordFailure({ ...failure, maxAttempts: MAX_TRAFFIC_DETAIL_ATTEMPTS });
        }
      }
      return { attempted, collected, failed };
    },

    /**
     * The stored rows of the session channel's videos (`videoIds`), or of its complete weeks inside startDate..endDate. Local only.
     * A video of another channel, without a final publish date (private, unlisted, scheduled), or never synced is not listed; rows read for
     * another window start (the publish date moved) are not returned until the video is read again. A week never read (also one older than
     * the weeks collected) is listed as `not_collected`.
     */
    async listStored(input: unknown): Promise<ListStoredTrafficDetailsResult> {
      const parsed = parseWithSchema(inputSchema, input, `list stored ${spec.label} input`);
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
      if (!parsed.videoIds) {
        return listWeeks(parsed.channelId, parsed.startDate as string, parsed.endDate as string, parsed.groupBy ?? "total");
      }
      const wanted = new Set(parsed.videoIds);
      const videos = (await deps.videoStore.listVideos(parsed.channelId)).filter((video) => wanted.has(video.videoId) && hasFinalPublishDate(video));
      const [states, rows] = await Promise.all([
        listSpecStates(parsed.channelId),
        deps.store.listVideoRows(parsed.channelId, videos.map((video) => video.videoId)),
      ]);
      const stateOf = new Map(states.map((state) => [state.subject, state]));
      return {
        channelId: parsed.channelId,
        videos: videos.map((video) => {
          const { windowStart, windowEnd } = videoBreakdownWindow(video.publishedAt as string);
          const stored = stateOf.get(`${spec.videoPrefix}${video.videoId}`);
          const state = stored && stored.rangeStart === windowStart ? stored : undefined;
          const current = state?.collectedThrough ? rows.filter((row) => row.videoId === video.videoId) : [];
          return {
            videoId: video.videoId,
            publishedAt: video.publishedAt as string,
            window: { start: windowStart, end: windowEnd },
            coverage: state?.collectedThrough
              ? { from: state.rangeStart, through: state.collectedThrough, collectedAt: state.collectedAt ? state.collectedAt.toISOString() : null }
              : null,
            status: state ? state.status : "not_collected",
            lastError: state?.lastError ?? null,
            rows: current.map(({ detail, views, estimatedMinutesWatched }) => ({ detail, views, estimatedMinutesWatched })).sort(byViews),
          };
        }),
      };
    },
  };
}

export type TrafficDetailServices = ReturnType<typeof createTrafficDetailServices>;
