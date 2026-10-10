import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import { z } from "zod";
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
 * Its own service next to the breakdowns: the same videos and 90-day window, credentials, reads switch, quota reserve, failure rules
 * (`query-failure.ts`) and state rows (`analytics_breakdown_state`, subject `search:<video id>`).
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
/** The state rows share `analytics_breakdown_state` with the breakdowns; a video id never contains a colon. */
export const VIDEO_SEARCH_SUBJECT_PREFIX = "search:";

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type PlannedSearchTerms = { subject: string; videoId: string; rangeStart: string; from: string; to: string };

/**
 * The videos to read now, at most `max`, least recently read first (never read first, newest publish date first among equals) and, within
 * that batch, those whose last attempt failed last -- the BL-168 queue, so none is starved and one that keeps getting no answer does not
 * head the run. While its window runs, a video is due once it has 7 days (yesterday ≥ window start + 6) and then whenever 7 days have
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

  const due: Array<{ planned: PlannedSearchTerms; lastAt: number; retry: boolean; publishedAt: number }> = [];
  for (const video of videos.filter(hasFinalPublishDate)) {
    const { windowStart, windowEnd } = videoBreakdownWindow(video.publishedAt as string);
    const subject = `${VIDEO_SEARCH_SUBJECT_PREFIX}${video.videoId}`;
    const stored = stateOf.get(subject);
    const state = stored && stored.rangeStart === windowStart ? stored : undefined;
    if (state?.status === "failed") continue;
    if (state?.status === "retry" && state.nextAttemptAt && state.nextAttemptAt.getTime() > now.getTime()) continue;
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
  const batch = due.slice(0, max);
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
  };
};

const credentialRefSchema = z.object({ userId: z.string().min(1) }).strict();
export const collectDueSearchTermsInputSchema = z.object({ credentialRef: credentialRefSchema, channelId: z.string().min(1) }).strict();
export const listStoredSearchTermsInputSchema = z
  .object({
    channelId: z.string().min(1),
    credentialRef: credentialRefSchema.optional(),
    videoIds: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

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
export type ListStoredSearchTermsResult = { channelId: string; videos: StoredSearchTermsVideo[] };

function userIdOf(credentialRef: unknown): string | null {
  return credentialRef && typeof credentialRef === "object" && typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

export function createSearchTermServices(deps: SearchTermDependencies) {
  const listSearchStates = async (channelId: string) =>
    (await deps.store.listStates(channelId)).filter((state) => state.subject.startsWith(VIDEO_SEARCH_SUBJECT_PREFIX));

  return {
    /**
     * Reads the channel's due videos (at most MAX_SEARCH_TERM_QUERIES_PER_RUN, one query each). Failures follow the milestone rules
     * (`query-failure.ts`): `stop` ends the run with nothing written, `defer` puts the video back by a day and ends the run, `attempt`
     * counts one of its 3 attempts and the run goes on.
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
      let collected = 0;
      let failed = 0;
      for (const item of plan) {
        try {
          const answer = await deps.youtubeApi.queryChannelBreakdownReport({
            credentials,
            channelId: parsed.channelId,
            startDate: item.from,
            endDate: item.to,
            ...SEARCH_TERM_QUERY,
            filters: `video==${item.videoId};insightTrafficSourceType==YT_SEARCH`,
          });
          await deps.store.saveVideoTerms({
            channelId: parsed.channelId,
            subject: item.subject,
            videoId: item.videoId,
            rangeStart: item.rangeStart,
            to: item.to,
            terms: toSearchTermRows(answer),
            collectedOn,
            at: deps.clock.now(),
          });
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
            throw error;
          }
          failed += 1;
          await deps.store.recordFailure({ ...failure, maxAttempts: MAX_SEARCH_TERM_ATTEMPTS });
        }
      }
      return { attempted: plan.length, collected, failed };
    },

    /**
     * The stored search terms of the session channel's videos, most views first. Local only. A video of another channel, without a final
     * publish date, or never synced is not listed; terms read for another window start (the publish date moved) are not returned until the
     * video is read again.
     */
    async listStoredSearchTerms(input: unknown): Promise<ListStoredSearchTermsResult> {
      const parsed = parseWithSchema(listStoredSearchTermsInputSchema, input, "list stored search terms input");
      await deps.channelAccess.assertActiveChannel({ userId: userIdOf(parsed.credentialRef), channelId: parsed.channelId });
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
