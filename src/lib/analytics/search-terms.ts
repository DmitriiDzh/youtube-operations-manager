import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { z } from "zod";
import { calendarDateSchema } from "@/lib/shared-domain";
import { DomainError, type ResolvedCredentials } from "./contracts";
import { parseWithSchema } from "./schemas";
import { toPacificCalendarDate } from "./comparable-age";
import { hasFinalPublishDate, type MilestoneVideo } from "./milestones";
import { failureKind } from "./query-failure";
import { videoBreakdownWindow, type BreakdownState } from "./breakdowns";

/**
 * BL-169 (FO-REQ-0015 item 5, docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md): the YouTube search terms that brought viewers to each own
 * video, stored so an agent reads them locally. YouTube gives this report only as a total over a range (no day split) and names a term for
 * only part of the search views (checked live 2026-10-10, plan §1); the values are kept as returned (own-channel Analytics data, III.E.4.b).
 *
 * Since the per-video terms are nearly empty, the channel's own terms are stored per Monday-Sunday week too (owner, Telegram msg 2477).
 *
 * Its own service next to the breakdowns: the same videos and 90-day window, credentials, reads switch, quota reserve, failure rules
 * (`query-failure.ts`) and state rows (`analytics_breakdown_state`, subjects `search:<video id>` and `search-week:<Monday>`).
 */

/** Checked live 2026-10-10: `maxResults` and `sort` are required (400 without), 25 is the most YouTube accepts (50 gives a 500). */
export const SEARCH_TERM_QUERY = {
  dimensions: "insightTrafficSourceDetail",
  metricNames: ["views", "estimatedMinutesWatched"] as const,
  maxResults: 25,
  sort: "-views",
} as const;
/** Reads are a week apart; after its window has ended a video gets one settled read on or after window end + 7. */
export const SEARCH_TERM_READ_EVERY_DAYS = 7;
/** Queries (one per subject) per channel per run; a larger backlog finishes over the next runs, least recently read first. */
export const MAX_SEARCH_TERM_QUERIES_PER_RUN = 100;
export const MAX_SEARCH_TERM_ATTEMPTS = 3;
export const SEARCH_TERM_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;
/** The last complete Monday-Sunday weeks of the channel that are read; an older week never read is not read any more. */
export const CHANNEL_SEARCH_TERM_WEEKS = 13;
/** The state rows share `analytics_breakdown_state` with the breakdowns; a video id never contains a colon. */
export const VIDEO_SEARCH_SUBJECT_PREFIX = "search:";
export const WEEK_SEARCH_SUBJECT_PREFIX = "search-week:";

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** A video (`videoId`) or a channel week (`videoId` null, `from` its Monday, `to` its Sunday). */
export type PlannedSearchTerms = { subject: string; videoId: string | null; rangeStart: string; from: string; to: string };

/** The Monday of the week (Monday-Sunday) containing `date`. */
function mondayOf(date: string): string {
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return shiftIsoDate(date, -((dayOfWeek + 6) % 7));
}

/** The Mondays of the last CHANNEL_SEARCH_TERM_WEEKS weeks that end on or before `latest`, newest first. */
export function completeSearchTermWeeks(latest: string): string[] {
  const monday = mondayOf(latest);
  const newest = shiftIsoDate(monday, 6) === latest ? monday : shiftIsoDate(monday, -7);
  return Array.from({ length: CHANNEL_SEARCH_TERM_WEEKS }, (_, i) => shiftIsoDate(newest, -7 * i));
}

/**
 * The subjects to read now, at most `max`: the channel's due weeks first (newest first), then the videos least recently read first (never
 * read first, newest publish date first among equals); within that batch, those whose last attempt failed last -- the BL-168 queue, so
 * none is starved and one that keeps getting no answer does not head the run. A week is due once it is complete (its Sunday is yesterday
 * or earlier) and once more on or after Sunday + 7 unless its first read already was; only the last CHANNEL_SEARCH_TERM_WEEKS weeks are
 * considered. While its window runs, a video is due once it has 7 days (yesterday ≥ window start + 6) and then whenever 7 days have
 * passed since its last read; once the window has ended, once on or after window end + 7 unless the last read already was. Each read covers
 * the window so far. `failed` videos are never planned, a `retry` waits for its time, and a state for another window start (the publish
 * date moved) counts as never read.
 */
export function planDueSearchTerms(
  videos: MilestoneVideo[],
  states: BreakdownState[],
  now: Date,
  max: number = MAX_SEARCH_TERM_QUERIES_PER_RUN
): PlannedSearchTerms[] {
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

  const weeks: Array<{ planned: PlannedSearchTerms; retry: boolean }> = [];
  for (const weekStart of completeSearchTermWeeks(latest)) {
    const subject = `${WEEK_SEARCH_SUBJECT_PREFIX}${weekStart}`;
    const state = usable(subject, weekStart);
    if (state === null) continue;
    const weekEnd = shiftIsoDate(weekStart, 6);
    const settledOn = shiftIsoDate(weekEnd, SEARCH_TERM_READ_EVERY_DAYS);
    const lastReadOn = state?.collectedOn ?? null;
    if (lastReadOn !== null && !(lastReadOn < settledOn && today >= settledOn)) continue;
    weeks.push({ planned: { subject, videoId: null, rangeStart: weekStart, from: weekStart, to: weekEnd }, retry: state?.status === "retry" });
  }

  const due: Array<{ planned: PlannedSearchTerms; lastAt: number; retry: boolean; publishedAt: number }> = [];
  for (const video of videos.filter(hasFinalPublishDate)) {
    const { windowStart, windowEnd } = videoBreakdownWindow(video.publishedAt as string);
    const subject = `${VIDEO_SEARCH_SUBJECT_PREFIX}${video.videoId}`;
    const state = usable(subject, windowStart);
    if (state === null) continue;
    const lastReadOn = state?.collectedOn ?? null;
    const ended = windowEnd <= latest;
    let isDue: boolean;
    if (ended) {
      const settledOn = shiftIsoDate(windowEnd, SEARCH_TERM_READ_EVERY_DAYS);
      isDue = today >= settledOn && (lastReadOn === null || lastReadOn < settledOn);
    } else {
      isDue = latest >= shiftIsoDate(windowStart, SEARCH_TERM_READ_EVERY_DAYS - 1) && (lastReadOn === null || today >= shiftIsoDate(lastReadOn, SEARCH_TERM_READ_EVERY_DAYS));
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

export type SearchTermValue = { term: string; views: number | null; estimatedMinutesWatched: number | null };

type ReportRow = { dimensionValues: string[]; metrics: Record<string, number> };

function metricOrNull(row: ReportRow, name: string): number | null {
  const value = row.metrics[name];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One row per term; a row without a term is skipped and a repeated term keeps YouTube's last row. */
export function toSearchTermRows(rows: ReportRow[]): SearchTermValue[] {
  const byTerm = new Map<string, SearchTermValue>();
  for (const row of rows) {
    const term = row.dimensionValues[0];
    if (!term) continue;
    byTerm.set(term, { term, views: metricOrNull(row, "views"), estimatedMinutesWatched: metricOrNull(row, "estimatedMinutesWatched") });
  }
  return [...byTerm.values()];
}

/** Most views first (a missing count last), then by term. */
function byViews(a: SearchTermValue, b: SearchTermValue): number {
  return (b.views ?? -1) - (a.views ?? -1) || a.term.localeCompare(b.term);
}

export type StoredSearchTermStateRow = BreakdownState & { attempts: number; lastError: string | null };

export type SearchTermDependencies = {
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
    /** Every state row of the channel (the breakdowns' too); only `search:` subjects are used here. */
    listStates(channelId: string): Promise<StoredSearchTermStateRow[]>;
    /** Replaces the video's terms with the answer and records the range, atomically. */
    saveVideoTerms(row: {
      channelId: string;
      subject: string;
      videoId: string;
      rangeStart: string;
      to: string;
      terms: SearchTermValue[];
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
    listVideoTerms(channelId: string, videoIds: string[]): Promise<Array<SearchTermValue & { videoId: string }>>;
    /** Replaces one channel week's terms with the answer and records the week, atomically. */
    saveWeekTerms(row: { channelId: string; subject: string; weekStart: string; to: string; terms: SearchTermValue[]; collectedOn: string; at: Date }): Promise<void>;
    listWeekTerms(channelId: string, firstWeekStart: string, lastWeekStart: string): Promise<Array<SearchTermValue & { weekStart: string }>>;
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
export const collectDueSearchTermsInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
export const MAX_SEARCH_TERM_READ_DAYS = 92;
/**
 * Two forms: `videoIds` (each video's terms over its stored range), or `startDate`/`endDate` (+ `groupBy`) for the channel weeks. The
 * dates belong to the channel form only, so they are refused together with `videoIds`, and required without it.
 */
export const listStoredSearchTermsInputSchema = z
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
    message: "videoIds reads each video's terms over its stored range: leave out startDate, endDate and groupBy (they are for the channel weeks)",
  })
  .refine((input) => input.videoIds !== undefined || (input.startDate !== undefined && input.endDate !== undefined), {
    message: "without videoIds, startDate and endDate are required (the channel weeks lying inside them are read)",
  })
  .refine((input) => !input.startDate || !input.endDate || input.startDate <= input.endDate, { message: "startDate must not be after endDate" })
  .refine(
    (input) =>
      !input.startDate ||
      !input.endDate ||
      Date.parse(`${input.endDate}T00:00:00Z`) - Date.parse(`${input.startDate}T00:00:00Z`) <= (MAX_SEARCH_TERM_READ_DAYS - 1) * 86_400_000,
    { message: `at most ${MAX_SEARCH_TERM_READ_DAYS} days` }
  );

export type StoredSearchTermsVideo = {
  videoId: string;
  publishedAt: string;
  window: { start: string; end: string };
  /** The range the stored terms cover (window start .. the last read's end) and when it was read; null when never read. */
  coverage: { from: string; through: string; collectedAt: string | null } | null;
  status: "collected" | "retry" | "failed" | "not_collected";
  lastError: string | null;
  terms: SearchTermValue[];
};
export type StoredSearchTermsWeek = {
  weekStart: string;
  weekEnd: string;
  status: "collected" | "retry" | "failed" | "not_collected";
  collectedAt: string | null;
  lastError: string | null;
  /** Only with `groupBy: "week"`. */
  terms?: SearchTermValue[];
};
export type ListStoredSearchTermsResult =
  | { channelId: string; videos: StoredSearchTermsVideo[] }
  | {
      channelId: string;
      startDate: string;
      endDate: string;
      groupBy: "total" | "week";
      /** The complete weeks lying inside startDate..endDate, oldest first. */
      weeks: StoredSearchTermsWeek[];
      /** Only with `groupBy: "total"`: each term summed over the weeks that were read (a sum of weekly top-25 lists). */
      terms?: SearchTermValue[];
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

export function createSearchTermServices(deps: SearchTermDependencies) {
  const listSearchStates = async (channelId: string) =>
    (await deps.store.listStates(channelId)).filter(
      (state) => state.subject.startsWith(VIDEO_SEARCH_SUBJECT_PREFIX) || state.subject.startsWith(WEEK_SEARCH_SUBJECT_PREFIX)
    );

  const listWeeks = async (channelId: string, startDate: string, endDate: string, groupBy: "total" | "week"): Promise<ListStoredSearchTermsResult> => {
    const latest = shiftIsoDate(toPacificCalendarDate(deps.clock.now().toISOString()), -1);
    const lastDay = endDate < latest ? endDate : latest;
    const mondays: string[] = [];
    // From the first Monday on or after startDate (the Monday of the week holding startDate + 6), every week whose Sunday is on or before
    // the earlier of endDate and yesterday.
    for (let monday = mondayOf(shiftIsoDate(startDate, 6)); shiftIsoDate(monday, 6) <= lastDay; monday = shiftIsoDate(monday, 7)) mondays.push(monday);
    const base = { channelId, startDate, endDate, groupBy };
    if (mondays.length === 0) return { ...base, weeks: [], ...(groupBy === "total" ? { terms: [] } : {}) };
    const [states, rows] = await Promise.all([listSearchStates(channelId), deps.store.listWeekTerms(channelId, mondays[0], mondays[mondays.length - 1])]);
    const stateOf = new Map(states.map((state) => [state.subject, state]));
    const totals = new Map<string, SearchTermValue>();
    const weeks = mondays.map((weekStart): StoredSearchTermsWeek => {
      const state = stateOf.get(`${WEEK_SEARCH_SUBJECT_PREFIX}${weekStart}`);
      const current = state?.collectedThrough ? rows.filter((row) => row.weekStart === weekStart) : [];
      for (const row of current) {
        const total = totals.get(row.term) ?? { term: row.term, views: null, estimatedMinutesWatched: null };
        total.views = addOrNull(total.views, row.views);
        total.estimatedMinutesWatched = addOrNull(total.estimatedMinutesWatched, row.estimatedMinutesWatched);
        totals.set(row.term, total);
      }
      return {
        weekStart,
        weekEnd: shiftIsoDate(weekStart, 6),
        status: state ? state.status : "not_collected",
        collectedAt: state?.collectedAt ? state.collectedAt.toISOString() : null,
        lastError: state?.lastError ?? null,
        ...(groupBy === "week" ? { terms: current.map(({ term, views, estimatedMinutesWatched }) => ({ term, views, estimatedMinutesWatched })).sort(byViews) } : {}),
      };
    });
    return { ...base, weeks, ...(groupBy === "total" ? { terms: [...totals.values()].sort(byViews) } : {}) };
  };

  return {
    /**
     * Reads the channel's due weeks and videos (at most MAX_SEARCH_TERM_QUERIES_PER_RUN, one query each). Failures follow the milestone rules
     * (`query-failure.ts`): `stop` ends the run with nothing written, `defer` puts the subject back by a day, `attempt` counts one of its 3
     * attempts and the run goes on. A video's `defer` ends the run; a week's `defer` only ends the weeks of this run and the videos are
     * still read (review of BL-169: the 13 never-read weeks head every batch, so each week getting no answer in turn ended 13 runs in a row
     * with no video read). If the videos get no answer either, the first one ends the run.
     */
    async collectDueSearchTerms(input: unknown): Promise<{ attempted: number; collected: number; failed: number }> {
      const parsed = parseWithSchema(collectDueSearchTermsInputSchema, input, "collect due search terms input");
      await deps.channelAccess.assertActiveChannel({ userId: parsed.credentialRef.userId, channelId: parsed.channelId });
      const now = deps.clock.now();
      const [videos, states] = await Promise.all([deps.videoStore.listVideos(parsed.channelId), listSearchStates(parsed.channelId)]);
      const plan = planDueSearchTerms(videos, states, now);
      if (plan.length === 0) return { attempted: 0, collected: 0, failed: 0 };
      const credentials = await deps.authResolver.resolve({ credentialRef: parsed.credentialRef, requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE] });
      const collectedOn = toPacificCalendarDate(now.toISOString());
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
            ...SEARCH_TERM_QUERY,
            filters: item.videoId ? `video==${item.videoId};insightTrafficSourceType==YT_SEARCH` : "insightTrafficSourceType==YT_SEARCH",
          });
          const saved = { channelId: parsed.channelId, subject: item.subject, to: item.to, terms: toSearchTermRows(answer), collectedOn, at: deps.clock.now() };
          if (item.videoId) {
            await deps.store.saveVideoTerms({ ...saved, videoId: item.videoId, rangeStart: item.rangeStart });
          } else {
            await deps.store.saveWeekTerms({ ...saved, weekStart: item.from });
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
            retryAt: new Date(at.getTime() + SEARCH_TERM_RETRY_AFTER_MS),
          };
          if (kind === "defer") {
            await deps.store.defer(failure);
            if (item.videoId !== null) throw error;
            weeksStopped = true;
            continue;
          }
          failed += 1;
          await deps.store.recordFailure({ ...failure, maxAttempts: MAX_SEARCH_TERM_ATTEMPTS });
        }
      }
      return { attempted, collected, failed };
    },

    /**
     * The stored search terms of the session channel's videos (`videoIds`), or of its complete weeks inside startDate..endDate. Local only.
     * A video of another channel, without a final publish date (private, unlisted, scheduled), or never synced is not listed; terms read for another window start (the
     * publish date moved) are not returned until the video is read again. A week never read (also one older than the weeks collected) is
     * listed as `not_collected`.
     */
    async listStoredSearchTerms(input: unknown): Promise<ListStoredSearchTermsResult> {
      const parsed = parseWithSchema(listStoredSearchTermsInputSchema, input, "list stored search terms input");
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
      if (!parsed.videoIds) {
        return listWeeks(parsed.channelId, parsed.startDate as string, parsed.endDate as string, parsed.groupBy ?? "total");
      }
      const wanted = new Set(parsed.videoIds);
      const videos = (await deps.videoStore.listVideos(parsed.channelId)).filter((video) => wanted.has(video.videoId) && hasFinalPublishDate(video));
      const [states, terms] = await Promise.all([
        listSearchStates(parsed.channelId),
        deps.store.listVideoTerms(parsed.channelId, videos.map((video) => video.videoId)),
      ]);
      const stateOf = new Map(states.map((state) => [state.subject, state]));
      return {
        channelId: parsed.channelId,
        videos: videos.map((video) => {
          const { windowStart, windowEnd } = videoBreakdownWindow(video.publishedAt as string);
          const stored = stateOf.get(`${VIDEO_SEARCH_SUBJECT_PREFIX}${video.videoId}`);
          const state = stored && stored.rangeStart === windowStart ? stored : undefined;
          const current = state?.collectedThrough ? terms.filter((row) => row.videoId === video.videoId) : [];
          return {
            videoId: video.videoId,
            publishedAt: video.publishedAt as string,
            window: { start: windowStart, end: windowEnd },
            coverage: state?.collectedThrough
              ? { from: state.rangeStart, through: state.collectedThrough, collectedAt: state.collectedAt ? state.collectedAt.toISOString() : null }
              : null,
            status: state ? state.status : "not_collected",
            lastError: state?.lastError ?? null,
            terms: current.map(({ term, views, estimatedMinutesWatched }) => ({ term, views, estimatedMinutesWatched })).sort(byViews),
          };
        }),
      };
    },
  };
}

export type SearchTermServices = ReturnType<typeof createSearchTermServices>;

/** AC-ST-13: the background gate -- while less than the configured reserve of the Analytics quota is left, nothing is queried. */
export function gateSearchTermCollection(
  guard: { isBackgroundReadAllowed(service: "analytics"): Promise<boolean> },
  collect: SearchTermServices["collectDueSearchTerms"]
): SearchTermServices["collectDueSearchTerms"] {
  return async (input) => ((await guard.isBackgroundReadAllowed("analytics")) ? collect(input) : { attempted: 0, collected: 0, failed: 0 });
}
export { DomainError };
