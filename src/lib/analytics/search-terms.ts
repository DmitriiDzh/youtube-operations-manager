import { DomainError, type ResolvedCredentials } from "./contracts";
import type { BreakdownState } from "./breakdowns";
import type { MilestoneVideo } from "./milestones";
import {
  CHANNEL_TRAFFIC_DETAIL_WEEKS,
  MAX_TRAFFIC_DETAIL_ATTEMPTS,
  MAX_TRAFFIC_DETAIL_QUERIES_PER_RUN,
  MAX_TRAFFIC_DETAIL_READ_DAYS,
  TRAFFIC_DETAIL_QUERY,
  TRAFFIC_DETAIL_READ_EVERY_DAYS,
  TRAFFIC_DETAIL_RETRY_AFTER_MS,
  collectDueTrafficDetailsInputSchema,
  completeTrafficDetailWeeks,
  createTrafficDetailServices,
  listStoredTrafficDetailsInputSchema,
  planDueTrafficDetails,
  toTrafficDetailRows,
  type PlannedTrafficDetail,
  type StoredTrafficDetailStateRow,
  type TrafficDetailSpec,
  type TrafficDetailValue,
} from "./traffic-source-details";

/**
 * BL-169 (FO-REQ-0015 item 5, docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md): the YouTube search terms that brought viewers to each own
 * video, stored so an agent reads them locally. YouTube gives this report only as a total over a range (no day split) and names a term for
 * only part of the search views (checked live 2026-10-10, plan §1); the values are kept as returned (own-channel Analytics data, III.E.4.b).
 *
 * Since the per-video terms are nearly empty, the channel's own terms are stored per Monday-Sunday week too (owner, Telegram msg 2477).
 *
 * The `YT_SEARCH` configuration of the shared traffic-source details (`traffic-source-details.ts`; BL-191 moved the schedule, the loop
 * and the read there so the suggested videos follow the same rules): the same videos and 90-day window, credentials, reads switch, quota
 * reserve, failure rules (`query-failure.ts`) and state rows (`analytics_breakdown_state`, subjects `search:<video id>` and
 * `search-week:<Monday>`). This file keeps BL-169's names and shapes (`term`, `terms`).
 */

export const SEARCH_TERM_QUERY = TRAFFIC_DETAIL_QUERY;
export const SEARCH_TERM_READ_EVERY_DAYS = TRAFFIC_DETAIL_READ_EVERY_DAYS;
export const MAX_SEARCH_TERM_QUERIES_PER_RUN = MAX_TRAFFIC_DETAIL_QUERIES_PER_RUN;
export const MAX_SEARCH_TERM_ATTEMPTS = MAX_TRAFFIC_DETAIL_ATTEMPTS;
export const SEARCH_TERM_RETRY_AFTER_MS = TRAFFIC_DETAIL_RETRY_AFTER_MS;
export const CHANNEL_SEARCH_TERM_WEEKS = CHANNEL_TRAFFIC_DETAIL_WEEKS;
/** The state rows share `analytics_breakdown_state` with the breakdowns; a video id never contains a colon. */
export const VIDEO_SEARCH_SUBJECT_PREFIX = "search:";
export const WEEK_SEARCH_SUBJECT_PREFIX = "search-week:";
export const SEARCH_TERM_SPEC: TrafficDetailSpec = {
  sourceType: "YT_SEARCH",
  videoPrefix: VIDEO_SEARCH_SUBJECT_PREFIX,
  weekPrefix: WEEK_SEARCH_SUBJECT_PREFIX,
  label: "search terms",
};

export type PlannedSearchTerms = PlannedTrafficDetail;
export const completeSearchTermWeeks = completeTrafficDetailWeeks;

/** BL-169's planner: `planDueTrafficDetails` for the `search:` subjects. */
export function planDueSearchTerms(
  videos: MilestoneVideo[],
  states: BreakdownState[],
  now: Date,
  max: number = MAX_SEARCH_TERM_QUERIES_PER_RUN
): PlannedSearchTerms[] {
  return planDueTrafficDetails(SEARCH_TERM_SPEC, videos, states, now, max);
}

export type SearchTermValue = { term: string; views: number | null; estimatedMinutesWatched: number | null };

const toTerm = ({ detail, views, estimatedMinutesWatched }: TrafficDetailValue): SearchTermValue => ({ term: detail, views, estimatedMinutesWatched });

type ReportRow = { dimensionValues: string[]; metrics: Record<string, number> };

/** One row per term; a row without a term is skipped and a repeated term keeps YouTube's last row. */
export function toSearchTermRows(rows: ReportRow[]): SearchTermValue[] {
  return toTrafficDetailRows(rows).map(toTerm);
}

export type StoredSearchTermStateRow = StoredTrafficDetailStateRow;

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

export const collectDueSearchTermsInputSchema = collectDueTrafficDetailsInputSchema;
export const MAX_SEARCH_TERM_READ_DAYS = MAX_TRAFFIC_DETAIL_READ_DAYS;
/**
 * Two forms: `videoIds` (each video's terms over its stored range), or `startDate`/`endDate` (+ `groupBy`) for the channel weeks. The
 * dates belong to the channel form only, so they are refused together with `videoIds`, and required without it.
 */
export const listStoredSearchTermsInputSchema = listStoredTrafficDetailsInputSchema("terms");

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

export function createSearchTermServices(deps: SearchTermDependencies) {
  const { saveVideoTerms, listVideoTerms, saveWeekTerms, listWeekTerms, ...shared } = deps.store;
  const engine = createTrafficDetailServices(
    SEARCH_TERM_SPEC,
    {
      ...deps,
      store: {
        ...shared,
        saveVideoRows: ({ rows, ...row }) => saveVideoTerms({ ...row, terms: rows.map(toTerm) }),
        listVideoRows: async (channelId, videoIds) => (await listVideoTerms(channelId, videoIds)).map(({ term, ...row }) => ({ ...row, detail: term })),
        saveWeekRows: ({ rows, ...row }) => saveWeekTerms({ ...row, terms: rows.map(toTerm) }),
        listWeekRows: async (channelId, first, last) => (await listWeekTerms(channelId, first, last)).map(({ term, ...row }) => ({ ...row, detail: term })),
      },
    },
    listStoredSearchTermsInputSchema
  );

  return {
    /** `createTrafficDetailServices().collectDue`: the channel's due weeks and videos, one query each, BL-169's failure rules. */
    collectDueSearchTerms: (input: unknown) => engine.collectDue(input),

    /** `createTrafficDetailServices().listStored`, with the rows named `terms`. */
    async listStoredSearchTerms(input: unknown): Promise<ListStoredSearchTermsResult> {
      const result = await engine.listStored(input);
      if ("videos" in result) {
        return { channelId: result.channelId, videos: result.videos.map(({ rows, ...video }) => ({ ...video, terms: rows.map(toTerm) })) };
      }
      const { rows, weeks, ...base } = result;
      return {
        ...base,
        weeks: weeks.map(({ rows: weekRows, ...week }) => ({ ...week, ...(weekRows ? { terms: weekRows.map(toTerm) } : {}) })),
        ...(rows ? { terms: rows.map(toTerm) } : {}),
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
