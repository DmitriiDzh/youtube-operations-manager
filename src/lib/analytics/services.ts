import type { ProgressReporter } from "@/lib/operation-progress";
import { rangesStraddleViewCountingChange } from "@/lib/youtube-quota";
import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import type { ChannelAccessService } from "@/lib/channel-access";
import { computeDefaultAutoCollectionRange, computeNextRefreshAt, isAnalyticsCollectionStale } from "./staleness";
import { assertValidDateRange, assertValidIsoDate, computePreviousPeriod, zeroFillDailySeries } from "./period";
import { computeComparableAgeSeries } from "./comparable-age";
import { computeDataQualityReport, extendDataQualityReport, isRangeFullyCovered } from "./data-quality";
import { nextVideoHistoryThrough, perVideoQueryRange, planChannelCatchUp, planVideoHistoryCatchUp, resolveHistoryStart } from "./catch-up";
import { computeDueReportWeek, computeWeeklyReportContent } from "./weekly-report";
import {
  ANALYTICS_METRIC_NAMES,
  AUTO_COLLECTION_RANGE_DAYS,
  CHANNEL_BREAKDOWN_PRESETS,
  CHANNEL_OVERVIEW_METRIC_NAMES,
  DomainError,
  isDomainError,
  type AutoCollectResult,
  type ChannelBreakdownKind,
  type ChannelOverviewTotals,
  type CollectMetricsResult,
  type DataQualityReportResult,
  type GetChannelBreakdownResult,
  type GetChannelOverviewResult,
  type GetComparableAgeComparisonResult,
  type GetVideoRetentionCurveResult,
  type GetWeeklyReportResult,
  type ListMetricsResult,
  type ListWeeklyReportsResult,
  type ResolvedCredentials,
  type RunWeeklyReportIfDueResult,
  type StoredVideoMetricRow,
  type WeeklyReportSummary,
} from "./contracts";
import {
  collectMetricsInputSchema,
  collectMetricsOutputSchema,
  getChannelBreakdownInputSchema,
  getChannelBreakdownOutputSchema,
  getChannelOverviewInputSchema,
  getChannelOverviewOutputSchema,
  getComparableAgeComparisonInputSchema,
  getComparableAgeComparisonOutputSchema,
  getDataQualityReportInputSchema,
  getDataQualityReportOutputSchema,
  getVideoRetentionCurveInputSchema,
  getVideoRetentionCurveOutputSchema,
  getWeeklyReportInputSchema,
  getWeeklyReportOutputSchema,
  listMetricsInputSchema,
  listMetricsOutputSchema,
  listWeeklyReportsInputSchema,
  listWeeklyReportsOutputSchema,
  parseWithSchema,
  runAutoCollectionInputSchema,
  runAutoCollectionOutputSchema,
  runWeeklyReportIfDueInputSchema,
  runWeeklyReportIfDueOutputSchema,
  weeklyReportContentSchema,
} from "./schemas";

export type StoredVideoRef = {
  videoId: string;
  channelId: string;
};

/** Most per-video history queries one catch-up call makes (one Analytics unit each); a larger channel simply finishes over several days. */
const MAX_CATCH_UP_VIDEOS_PER_RUN = 200;

function shiftIsoDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export type HistoryCatchUpPlan = {
  /** The rolling window's first day; everything this plan asks for lies before it. */
  rollingStart: string;
  videoRanges: Array<{ videoId: string; from: string; to: string }>;
  channelRange: { startDate: string; endDate: string } | null;
};

export type HistoryCatchUpResult =
  | { ranCatchUp: false }
  | {
      ranCatchUp: true;
      videosQueried: number;
      upsertsIssued: number;
      skippedVideoIds: string[];
      channelLevel: boolean;
      startDate: string;
      endDate: string;
      /** Videos still to do (a very large channel is finished over several calls). */
      remainingVideos: number;
    };

type ServiceDependencies = {
  authResolver: {
    resolve(args: {
      credentialRef: unknown;
      requiredScopes: readonly string[];
    }): Promise<ResolvedCredentials>;
  };
  youtubeApi: {
    queryVideoAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      videoId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }): Promise<Array<{ date: string; metrics: Record<string, number> }>>;
    queryChannelAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }): Promise<Array<{ date: string; metrics: Record<string, number> }>>;
    // Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §1) --
    // one shared shape for every non-`day` channel-level breakdown (traffic sources, device type,
    // age/gender, geography, subscribed status, content format), confirmed against real API
    // responses (BL-093/BL-094) before this was added, not merely documented.
    queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions: string;
      metricNames: readonly string[];
      filters?: string;
    }): Promise<Array<{ dimensionValues: string[]; metrics: Record<string, number> }>>;
  };
  videoStore: {
    listVideosByChannel(channelId: string): Promise<StoredVideoRef[]>;
    // Phase 8 follow-up, slice 3 (comparable-age comparison) -- needs each requested video's own
    // publishedAt/title, which listVideosByChannel's bare {videoId, channelId} pair doesn't carry.
    listVideoDetailsByChannel(channelId: string): Promise<Array<{ videoId: string; title: string; publishedAt: string }>>;
  };
  metricStore: {
    upsertMetric(args: {
      channelId: string;
      videoId: string;
      metricDate: string;
      metricName: string;
      metricValue: number;
    }): Promise<void>;
    listMetricsByChannel(channelId: string): Promise<StoredVideoMetricRow[]>;
  };
  /** BL-118: channel-level daily totals stored locally (optional so older wiring keeps its behavior). */
  channelMetricStore?: {
    upsert(row: { channelId: string; metricDate: string; metricName: string; metricValue: number }): Promise<void>;
    listInRange?(
      channelId: string,
      range: { startDate: string; endDate: string }
    ): Promise<Array<{ metricDate: string; metricName: string; metricValue: number }>>;
    getLatestCollectedAt?(channelId: string): Promise<Date | null>;
  };
  /** BL-118: per-video history coverage ("collected from the publish date through ..."). Optional like the above. */
  historyStore?: {
    listByChannel(channelId: string): Promise<Array<{ videoId: string; historyThrough: string }>>;
    advance(row: { videoId: string; channelId: string; historyThrough: string }): Promise<void>;
  };
  channelAccess: ChannelAccessService;
  // BL-059 -- the per-channel "when did the daily auto-collection last actually run" timestamp,
  // deliberately separate from metricStore's per-row collected_at (see channels.
  // analyticsLastAutoCollectedAt's own doc comment in db.ts for why).
  channelStore: {
    getAnalyticsLastAutoCollectedAt(channelId: string): Promise<Date | null>;
    markAnalyticsAutoCollected(channelId: string, at: Date): Promise<void>;
    /** BL-118: the channel's YouTube creation time (RFC 3339), or null when no sync recorded it yet. */
    getChannelPublishedAt(channelId: string): Promise<string | null>;
  };
  settingsStore: {
    getAnalyticsSyncSettings(): Promise<{ localTime: string; timezone: string }>;
  };
  // Phase 8 follow-up, slice 2 (data-quality diagnostics) -- append-only history of each
  // collectMetrics run, read by getDataQualityReport.
  collectionRunStore: {
    record(args: {
      channelLevel?: boolean;
      channelId: string;
      requestedStartDate: string;
      requestedEndDate: string;
      videoCount: number;
      upsertsIssued: number;
      skippedVideoIds: string[];
    }): Promise<void>;
    listByChannel(channelId: string): Promise<
      Array<{
        requestedStartDate: string;
        requestedEndDate: string;
        videoCount: number;
        upsertsIssued: number;
        skippedVideoIds: string[];
        channelLevel?: boolean;
        ranAt: Date;
      }>
    >;
  };
  // Phase 8 follow-up, slice 4 (weekly reports) -- read/write of the frozen snapshot table.
  weeklyReportStore: {
    getByWeek(channelId: string, weekStartDate: string): Promise<{
      channelId: string;
      weekStartDate: string;
      weekEndDate: string;
      status: string;
      reportJson: string;
      generatedAt: Date;
    } | null>;
    upsert(
      args: { channelId: string; weekStartDate: string; weekEndDate: string; status: string; reportJson: string },
      generatedAt: Date
    ): Promise<void>;
    listByChannel(channelId: string): Promise<
      Array<{
        channelId: string;
        weekStartDate: string;
        weekEndDate: string;
        status: string;
        reportJson: string;
        generatedAt: Date;
      }>
    >;
  };
  /** Injectable so staleness tests never depend on the real wall clock. */
  clock: {
    now(): Date;
  };
  logger: {
    info(payload: { event: string; context?: Record<string, unknown> }): void;
    error(payload: { event: string; context?: Record<string, unknown> }): void;
  };
};

function getCredentialUserId(credentialRef: unknown): string | null {
  return credentialRef !== null &&
    typeof credentialRef === "object" &&
    "userId" in credentialRef &&
    typeof (credentialRef as { userId?: unknown }).userId === "string"
    ? (credentialRef as { userId: string }).userId
    : null;
}

function mapUnknownError(error: unknown, fallbackCode: DomainError["code"]) {
  if (isDomainError(error)) return error;

  return new DomainError({
    code: fallbackCode,
    message: error instanceof Error ? error.message : "Unknown error",
  });
}

/**
 * Parses a stored row's `reportJson` through `weeklyReportContentSchema` -- a row this app itself
 * wrote should always be valid, but a malformed or corrupted one must fail loudly
 * (`validation_failed`, never a raw `JSON.parse` crash or a silently-wrong partial object) rather
 * than serve a report a caller could mistake for a real one (advisor review, 2026-09-23).
 */
function mapStoredWeeklyReport(row: {
  channelId: string;
  weekStartDate: string;
  weekEndDate: string;
  status: string;
  reportJson: string;
  generatedAt: Date;
}): WeeklyReportSummary {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(row.reportJson);
  } catch {
    throw new DomainError({
      code: "validation_failed",
      message: `Stored weekly report for ${row.channelId}/${row.weekStartDate} is not valid JSON`,
    });
  }

  const report = parseWithSchema(weeklyReportContentSchema, parsedJson, "stored weekly report content");

  return {
    channelId: row.channelId,
    weekStartDate: row.weekStartDate,
    weekEndDate: row.weekEndDate,
    status: row.status,
    generatedAt: row.generatedAt.toISOString(),
    report,
  };
}

export function createAnalyticsServices(deps: ServiceDependencies) {
  // BL-118: items whose catch-up query failed are not retried for a while (a removed/private video would otherwise be re-queried on every
  // dashboard open). In-process only: a restart simply tries again.
  const catchUpFailedAt = new Map<string, number>();
  const CATCH_UP_RETRY_COOLDOWN_MS = 6 * 3_600_000;
  const coolingDown = (key: string) => {
    const at = catchUpFailedAt.get(key);
    return at !== undefined && deps.clock.now().getTime() - at < CATCH_UP_RETRY_COOLDOWN_MS;
  };

  /**
   * BL-118 -- fetches and stores the channel-level daily totals for a window (one Analytics query). Returns whether it succeeded; never
   * throws (a failed channel query must not fail or hide the per-video collection that already happened).
   */
  async function collectChannelLevel(args: {
    credentials: ResolvedCredentials;
    channelId: string;
    startDate: string;
    endDate: string;
  }): Promise<boolean> {
    if (!deps.channelMetricStore) return false;
    try {
      const rows = await deps.youtubeApi.queryChannelAnalyticsReport({
        credentials: args.credentials,
        channelId: args.channelId,
        startDate: args.startDate,
        endDate: args.endDate,
        metricNames: CHANNEL_OVERVIEW_METRIC_NAMES,
      });
      for (const row of rows) {
        for (const [metricName, metricValue] of Object.entries(row.metrics)) {
          await deps.channelMetricStore.upsert({ channelId: args.channelId, metricDate: row.date, metricName, metricValue });
        }
      }
      return true;
    } catch (error) {
      deps.logger.error({
        event: "analytics.collect_metrics.channel_level_failed",
        context: { channelId: args.channelId, message: error instanceof Error ? error.message : "Unknown error" },
      });
      return false;
    }
  }

  async function computeHistoryCatchUpPlan(channelId: string): Promise<HistoryCatchUpPlan> {
    const now = deps.clock.now();
    const { timezone } = await deps.settingsStore.getAnalyticsSyncSettings();
    const rollingStart = computeDefaultAutoCollectionRange({ now, timezone, rangeDays: AUTO_COLLECTION_RANGE_DAYS }).startDate;
    const [videoDetails, history, runs, publishedAt] = await Promise.all([
      deps.videoStore.listVideoDetailsByChannel(channelId),
      deps.historyStore ? deps.historyStore.listByChannel(channelId) : Promise.resolve([]),
      deps.collectionRunStore.listByChannel(channelId),
      deps.channelStore.getChannelPublishedAt(channelId),
    ]);
    const videoRanges = planVideoHistoryCatchUp({
      videos: videoDetails,
      historyThrough: new Map(history.map((h) => [h.videoId, h.historyThrough])),
      rollingStart,
    });
    const channelRange = deps.channelMetricStore
      ? planChannelCatchUp({
          historyStart: resolveHistoryStart({ channelStartDate: publishedAt ? publishedAt.slice(0, 10) : null, videos: videoDetails }),
          rollingStart,
          runs: runs.map((r) => ({ requestedStartDate: r.requestedStartDate, requestedEndDate: r.requestedEndDate, channelLevel: r.channelLevel === true })),
        })
      : null;
    return {
      rollingStart,
      videoRanges: videoRanges.filter((range) => !coolingDown(`${channelId}|video|${range.videoId}`)),
      channelRange: channelRange && !coolingDown(`${channelId}|channel`) ? channelRange : null,
    };
  }

  const services = {
    /**
     * Collects daily metrics for every locally-synced video under `channelId`, over
     * `[startDate, endDate]`, and upserts each (video, date, metric) row via `metricStore`.
     *
     * Channel-context validation (`docs/DEVELOPMENT_PLAYBOOK.md` §6.6/§6.4 point 5): this is a
     * read path with respect to YouTube (no `write-context.assertWriteChannel` guardrail needed),
     * but `channelId` must still be the caller's *active* channel
     * (`docs/decisions/0004-active-channel-read-scoping.md`) -- checked once here, mirroring
     * `channel-sync/services.ts`'s own `listSyncedVideos`, since this service (like that one)
     * already receives a `credentialRef` to derive `userId` from. A video is never queried under
     * the wrong channel by construction: `videoStore.listVideosByChannel(channelId)` only ever
     * returns rows whose own `channelId` column matches, so a video actually belonging to a
     * different channel can never be reached through this `channelId` (see
     * `services.test.ts`'s explicit cross-channel test proving this, per
     * `docs/roadmap/plans/PHASE_8_PLAN.md` §7's own acceptance criterion).
     *
     * One Analytics API call per video (`docs/roadmap/plans/PHASE_8_PLAN.md` §10 item 5 --
     * explicitly a provisional shape, not a confirmed-optimal one). A single video's call
     * throwing is isolated (recorded in `skippedVideoIds`, logged) rather than failing the whole
     * run -- the same "one bad item never blocks the rest" discipline this codebase already uses
     * for e.g. `change-drafts-sync`'s per-peer isolation.
     *
     * A metric present in the request but absent/non-finite in a given row of the API's response
     * is silently omitted from that row's upserts, never defaulted to `0` -- matching this
     * codebase's existing convention for `videos.viewCount`/`commentCount` (`docs/SYSTEM_MAP.md`
     * §2.7: nullable, "никогда не подменяется на 0"). This means "the API didn't return this
     * metric for this day" and "the API returned it as zero" are handled the same way a caller
     * would want (never a fabricated fact), but they are NOT distinguishable from each other in
     * the stored data -- a future slice needing that distinction would need its own design.
     *
     * `credentialRef` shapes with no `userId` (e.g. a CLI caller passing raw tokens directly,
     * rather than `{ userId }`) can never pass `assertActiveChannel` -- `getCredentialUserId`
     * returns `null`, and `channelAccess.assertActiveChannel` fails closed on a null/unresolved
     * user exactly as it does for a genuinely wrong channel (`CHANNEL_NOT_ACTIVE`). This is
     * correct fail-closed behavior, not a bug, but it does mean this service is only reachable via
     * a caller that resolves to a real `userId` (the Web UI/API path) until/unless a future
     * CLI/MCP surface is added with its own `userId`-resolving credentialRef.
     *
     * **Daily freshness gate (owner instruction, 2026-09-22, Telegram): "Данные на самом деле
     * обновляются раз в сутки... шлюзы не должны позволять повторный вызовы. Ни человеку, ни
     * агенту, ни каким-то скриптам."** The real YouTube Analytics API itself only refreshes data
     * roughly once a day (unlike the YouTube Data API v3, which this rule deliberately does NOT
     * apply to -- Content's own manual "Sync now" stays uncapped, per the owner's own explicit
     * "для даты будем отслеживать поток данных и наши лимиты" instead). This function is the one
     * choke point every caller -- the manual "Collect now" button, `runAutoCollectionIfStale`
     * below, and any future MCP/CLI surface -- ultimately calls to fetch real data, so the gate
     * lives here, not duplicated in each caller. If this channel was already collected on/after
     * today's configured local boundary, the call is refused outright (`analytics_data_current`,
     * no real API call made) rather than silently re-fetching data YouTube itself has not
     * refreshed yet.
     *
     * The mark happens AFTER the per-video collection loop, and only when the run actually
     * accomplished something (`videos.length === 0` -- nothing to fetch -- or `upsertsIssued > 0`
     * -- at least one real row landed). Two real, separately-found bugs shaped this:
     *
     * 1. An earlier version marked the channel collected before resolving credentials at all,
     *    which meant a credential failure (e.g. the real "Credentials are missing required OAuth
     *    scopes" case this owner hit once) left the channel marked collected-for-today with zero
     *    data actually fetched, locking even the manual button until tomorrow's boundary with no
     *    UI way out.
     * 2. The next version fixed (1) but still marked right after credential resolve, before the
     *    per-video loop ran at all -- so if EVERY video's own query then failed (a systemic issue,
     *    e.g. a token that resolves but is rejected by the Analytics API itself), the channel was
     *    still marked collected despite zero real data landing, silently locking out further
     *    attempts (auto and manual alike) until tomorrow with no visible error anywhere (found
     *    live, owner-reported, 2026-09-25 -- stale data for days with no error surfaced).
     *
     * Marking only after a real measure of success (rather than merely "credentials resolved")
     * widens, rather than narrows, the concurrency window two callers (a manual click racing the
     * auto-trigger, or two browser tabs) could both pass through in -- both would then spend one
     * real day's worth of Analytics quota instead of none. This is the same tradeoff direction
     * fix 1 above already accepted, extended one step further: a rare double-collection is still
     * strictly better than a full-day lockout from a single failed attempt.
     *
     * 3. Fix 2 stops a NEW bad mark from being set, but cannot retroactively correct one a run
     *    from BEFORE that fix already left behind -- the gate would otherwise keep trusting that
     *    stale, incorrect mark and block every real attempt until tomorrow's boundary, even though
     *    the actual displayed data was, in the owner's own real case, three days old (owner's own
     *    proposed principle, 2026-09-25, Telegram: "если сейчас время уже после этой даты, а у нас
     *    все еще нету данных за прошлый день -- значит синхронизация... не была успешно
     *    завершена"). So the mark is never trusted blindly: if it says "already fresh," this
     *    function additionally checks `collectionRunStore`'s own run history for a genuine
     *    (non-total-failure) run whose requested window covers yesterday (local to `timezone` --
     *    the same canonical date `computeDefaultAutoCollectionRange` itself targets, not
     *    whatever range this specific call happens to request) before honoring the mark -- if no
     *    such run is on record, the mark is treated as wrong and the collection proceeds anyway
     *    (logged as `mark_disagrees_with_run_history`, a real, reportable inconsistency, not a
     *    silent override).
     */
    async collectMetrics(input: unknown, options: { progress?: ProgressReporter } = {}): Promise<CollectMetricsResult> {
      const parsedInput = parseWithSchema(collectMetricsInputSchema, input, "collect metrics input");
      const progress = options.progress;
      const metricNames = parsedInput.metricNames ?? ANALYTICS_METRIC_NAMES;

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const now = deps.clock.now();
        const [lastCollectedAt, { localTime, timezone }] = await Promise.all([
          deps.channelStore.getAnalyticsLastAutoCollectedAt(parsedInput.channelId),
          deps.settingsStore.getAnalyticsSyncSettings(),
        ]);

        const markedFresh = !isAnalyticsCollectionStale({ now, lastAutoCollectedAt: lastCollectedAt, timezone, localTime });
        // Owner's own proposed principle (2026-09-25): don't just trust the "already collected"
        // mark -- verify a genuine run backs it up. Found necessary live: the mark-on-success fix
        // above stops the bug going forward, but cannot retroactively correct a mark a PRIOR
        // (pre-fix) run already set incorrectly, which would otherwise keep this gate blocking
        // real attempts, with stale data on screen, until tomorrow's boundary purely on the
        // strength of an internal flag that no longer matches reality.
        //
        // Checked against the *canonical* expected-fresh-through date (yesterday, local to
        // `timezone` -- the same "yesterday" `computeDefaultAutoCollectionRange` itself picks for
        // the unattended auto-trigger, i.e. exactly the day the owner's boundary setting promises
        // will be ready), never against `parsedInput.endDate` as such -- a manual call is free to
        // request any date range (a custom period selector, an MCP backfill, ...) and must still
        // be refused once today's real collection genuinely happened, regardless of what range
        // that specific call itself asked for (see the "manual call is refused if an
        // auto-collection already ran today" test, a pre-existing, deliberate invariant this
        // must not break).
        //
        // A run "covers" that date when the date falls inside its own requested window
        // (`requestedStartDate`..`requestedEndDate`) and the run was not a total failure --
        // deliberately NOT whether a raw metric row exists for that date, since a genuinely
        // successful run can still leave zero rows for a specific day if activity was truly zero
        // that day (the Analytics API silently omits zero-activity days from its own response,
        // per `getDataQualityReport`'s own doc comment), which would otherwise misclassify a
        // perfectly good "nothing happened that day" result as "the mark is lying."
        const { endDate: expectedFreshThroughDate } = computeDefaultAutoCollectionRange({ now, timezone, rangeDays: 0 });
        const runs = markedFresh ? await deps.collectionRunStore.listByChannel(parsedInput.channelId) : [];
        const genuineRunCoversExpectedDate = markedFresh
          ? runs.some(
              (run) =>
                run.requestedStartDate <= expectedFreshThroughDate &&
                run.requestedEndDate >= expectedFreshThroughDate &&
                (run.videoCount === 0 || run.upsertsIssued > 0)
            )
          : false;

        if (markedFresh && !genuineRunCoversExpectedDate) {
          deps.logger.error({
            event: "analytics.collect_metrics.mark_disagrees_with_run_history",
            context: {
              channelId: parsedInput.channelId,
              expectedFreshThroughDate,
              lastCollectedAt: lastCollectedAt?.toISOString() ?? null,
            },
          });
        }

        // BL-118 (owner decision 2026-10-03, replacing "a manual call is refused once today's collection has run, whatever range it
        // asks"): the refusal only protects against re-fetching data that is already collected. A request that contains at least one date
        // no collection run has covered (an older range being backfilled) brings NEW data and is allowed. Dates still inside the
        // reporting lag can never hold more data than the last run already got, so they count as covered for this decision.
        // A run that attempted no videos still counts as coverage for a channel that has none (the old behaviour); for a channel WITH videos
        // such a run is a channel-totals-only catch-up run, which says nothing about per-video data.
        const channelHasVideos =
          markedFresh && genuineRunCoversExpectedDate ? (await deps.videoStore.listVideosByChannel(parsedInput.channelId)).length > 0 : false;
        if (
          markedFresh &&
          genuineRunCoversExpectedDate &&
          isRangeFullyCovered({
            startDate: parsedInput.startDate,
            endDate: parsedInput.endDate,
            runs: channelHasVideos ? runs.filter((run) => !(run.videoCount === 0 && run.channelLevel === true)) : runs,
            requireVideos: false,
            now,
          })
        ) {
          const nextRefreshAt = computeNextRefreshAt({ now, timezone, localTime });
          throw new DomainError({
            code: "analytics_data_current",
            message: `Analytics data is already up to date for today. YouTube itself only refreshes this data about once a day -- the next refresh is available at ${nextRefreshAt.toISOString()}.`,
            details: { lastCollectedAt: lastCollectedAt?.toISOString() ?? null, nextRefreshAt: nextRefreshAt.toISOString(), timezone },
          });
        }

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });

        const [allVideos, videoDetails, existingHistory] = await Promise.all([
          deps.videoStore.listVideosByChannel(parsedInput.channelId),
          deps.videoStore.listVideoDetailsByChannel(parsedInput.channelId),
          deps.historyStore ? deps.historyStore.listByChannel(parsedInput.channelId) : Promise.resolve([]),
        ]);
        const publishedAtById = new Map(videoDetails.map((d) => [d.videoId, d.publishedAt]));
        const historyById = new Map(existingHistory.map((h) => [h.videoId, h.historyThrough]));

        // BL-118: each video is asked from one day before its OWN publish date, never before (a day late would lose day 0); a video
        // that did not exist yet by the window's end has nothing to ask for and is not counted as attempted or skipped.
        const videos = allVideos.filter((video) => {
          const publishedAt = publishedAtById.get(video.videoId);
          return !publishedAt || perVideoQueryRange({ publishedAt }, { startDate: parsedInput.startDate, endDate: parsedInput.endDate }) !== null;
        });

        let upsertsIssued = 0;
        const skippedVideoIds: string[] = [];

        progress?.stage("Querying the YouTube Analytics API (one query per video)");
        let finished = 0;
        for (const video of videos) {
          progress?.counts(finished, videos.length);
          const publishedAt = publishedAtById.get(video.videoId) ?? "";
          const query = publishedAt
            ? perVideoQueryRange({ publishedAt }, { startDate: parsedInput.startDate, endDate: parsedInput.endDate })!
            : { from: parsedInput.startDate, to: parsedInput.endDate };
          try {
            const rows = await deps.youtubeApi.queryVideoAnalyticsReport({
              credentials,
              channelId: parsedInput.channelId,
              videoId: video.videoId,
              startDate: query.from,
              endDate: query.to,
              metricNames,
            });

            for (const row of rows) {
              for (const [metricName, metricValue] of Object.entries(row.metrics)) {
                await deps.metricStore.upsertMetric({
                  channelId: parsedInput.channelId,
                  videoId: video.videoId,
                  metricDate: row.date,
                  metricName,
                  metricValue,
                });
                upsertsIssued += 1;
              }
            }

            // BL-118: remember how far back this video's history now reaches (only a query that reaches its publish date, or extends an
            // existing contiguous history, can claim anything).
            if (deps.historyStore && publishedAt) {
              const through = nextVideoHistoryThrough({ prior: historyById.get(video.videoId) ?? null, publishedAt, query });
              if (through) {
                await deps.historyStore.advance({ videoId: video.videoId, channelId: parsedInput.channelId, historyThrough: through });
                historyById.set(video.videoId, through);
              }
            }
          } catch (error) {
            skippedVideoIds.push(video.videoId);
            deps.logger.error({
              event: "analytics.collect_metrics.video_skipped",
              context: {
                channelId: parsedInput.channelId,
                videoId: video.videoId,
                message: error instanceof Error ? error.message : "Unknown error",
              },
            });
          }
          finished += 1;
        }
        progress?.counts(finished, videos.length);

        // BL-118: the CHANNEL-level daily totals for the same window (one extra query), so the agent's channel analytics can be read
        // locally. A failure here never fails the run: the run is simply recorded as not having collected channel totals.
        const channelLevel = await collectChannelLevel({ credentials, channelId: parsedInput.channelId, startDate: parsedInput.startDate, endDate: parsedInput.endDate });

        const output = {
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          videoCount: videos.length,
          upsertsIssued,
          skippedVideoIds,
        };

        // Mark AFTER the loop, and only on a run that actually accomplished something -- not
        // merely because credentials resolved. Found live (owner-reported, 2026-09-25): every
        // video failing (a systemic issue -- e.g. a token that resolves but is rejected by the
        // Analytics API itself) used to still count as "collected today" (the old mark-before-the-
        // loop placement), silently locking out both the daily auto-trigger and the manual
        // "Collect now" button until tomorrow's boundary, with zero real data fetched and no
        // visible error anywhere. A channel with no videos at all (`videos.length === 0`) still
        // counts as fully, successfully processed -- there was nothing to fetch.
        // BL-118: a window that ends before EVERY video existed (a backfill from before the channel) attempted nothing: it neither marks the
        // channel collected today nor records a run.
        const nothingAttempted = videos.length === 0 && allVideos.length > 0;
        if (nothingAttempted) {
          deps.logger.info({ event: "analytics.collect_metrics.nothing_attempted", context: { channelId: parsedInput.channelId } });
        } else if (videos.length === 0 || upsertsIssued > 0) {
          await deps.channelStore.markAnalyticsAutoCollected(parsedInput.channelId, now);
        } else {
          deps.logger.error({
            event: "analytics.collect_metrics.total_failure_not_marked",
            context: { channelId: output.channelId, videoCount: output.videoCount },
          });
        }

        // Phase 8 follow-up, slice 2 (data-quality diagnostics) -- the ground truth
        // `getDataQualityReport` reads. Recorded even when every video was skipped (an all-skip
        // run is itself a real, reportable fact, not something to hide by omitting the row).
        if (!nothingAttempted) {
          await deps.collectionRunStore.record({
            channelId: output.channelId,
            requestedStartDate: output.startDate,
            requestedEndDate: output.endDate,
            videoCount: output.videoCount,
            upsertsIssued: output.upsertsIssued,
            skippedVideoIds: output.skippedVideoIds,
            channelLevel,
          });
        } else if (channelLevel) {
          // Only the channel totals were collected (no video existed yet): record exactly that, no per-video claim.
          await deps.collectionRunStore.record({
            channelId: output.channelId,
            requestedStartDate: output.startDate,
            requestedEndDate: output.endDate,
            videoCount: 0,
            upsertsIssued: 0,
            skippedVideoIds: [],
            channelLevel: true,
          });
        }

        deps.logger.info({
          event: "analytics.collect_metrics.success",
          context: { channelId: output.channelId, videoCount: output.videoCount, upsertsIssued: output.upsertsIssued },
        });

        return parseWithSchema(collectMetricsOutputSchema, output, "collect metrics output");
      } catch (error) {
        const mapped = mapUnknownError(error, "unauthorized");
        deps.logger.error({ event: "analytics.collect_metrics.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /**
     * Read-only display of every metric row already collected for `channelId`
     * (`docs/roadmap/plans/PHASE_8_PLAN.md` §6 slice 4's "read-only Web UI display"). Pure local
     * read -- no `authResolver`/YouTube scope needed, since it never calls the Analytics API
     * itself. Same active-channel check as `collectMetrics`, for the same reason
     * (`docs/decisions/0004-active-channel-read-scoping.md`).
     */
    async listMetrics(input: unknown): Promise<ListMetricsResult> {
      const parsedInput = parseWithSchema(listMetricsInputSchema, input, "list metrics input");

      // Found by independent review (2026-09-23): `isoDateSchema` only checks digit shape, so an
      // inverted or calendar-invalid startDate/endDate filter used to silently filter every row
      // out (an empty, misleadingly "successful" result) instead of failing loudly -- the same bug
      // class `getChannelOverview`'s own `computePreviousPeriod` call already guards against.
      try {
        if (parsedInput.startDate && parsedInput.endDate) {
          assertValidDateRange(parsedInput.startDate, parsedInput.endDate);
        } else if (parsedInput.startDate) {
          assertValidIsoDate(parsedInput.startDate);
        } else if (parsedInput.endDate) {
          assertValidIsoDate(parsedInput.endDate);
        }
      } catch (error) {
        throw new DomainError({
          code: "validation_failed",
          message: error instanceof Error ? error.message : "Invalid date range",
        });
      }

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const records = await deps.metricStore.listMetricsByChannel(parsedInput.channelId);
        const rows = records
          .map((record) => ({
            videoId: record.videoId,
            metricDate: record.metricDate,
            metricName: record.metricName,
            metricValue: record.metricValue,
          }))
          .filter((row) => !parsedInput.startDate || row.metricDate >= parsedInput.startDate)
          .filter((row) => !parsedInput.endDate || row.metricDate <= parsedInput.endDate)
          .filter((row) => !parsedInput.videoId || row.videoId === parsedInput.videoId)
          .filter((row) => !parsedInput.metricNames || parsedInput.metricNames.includes(row.metricName));

        return parseWithSchema(
          listMetricsOutputSchema,
          { channelId: parsedInput.channelId, rows },
          "list metrics output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * BL-059 (docs/roadmap/plans/PHASE_8_PLAN.md §10 items 3-5) -- "on dashboard entry, check
     * when the daily collection last ran; if it's stale, run it." Meant to be called once per
     * dashboard mount (`src/app/dashboard/page.tsx`), not on a repeating interval -- this is a
     * once-a-day check, not a continuous poll.
     *
     * **The staleness check and mark-then-run now live entirely inside `collectMetrics` itself**
     * (2026-09-22 daily-freshness-gate instruction, see that function's own doc comment) --
     * this function no longer duplicates that logic; it only computes the auto-collection's own
     * default date range and calls `collectMetrics`, treating that gate's `analytics_data_current`
     * refusal as the expected "nothing to do today" outcome, not an error. Two callers racing
     * (a manual click and this auto-trigger, or two browser tabs) are still safe for the same
     * reason as before -- `collectMetrics`'s own mark-then-run is the single point that decides
     * who actually gets to run the real collection.
     */
    async runAutoCollectionIfStale(input: unknown): Promise<AutoCollectResult> {
      const parsedInput = parseWithSchema(runAutoCollectionInputSchema, input, "run auto collection input");

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const now = deps.clock.now();
        const { timezone } = await deps.settingsStore.getAnalyticsSyncSettings();
        const { startDate, endDate } = computeDefaultAutoCollectionRange({
          now,
          timezone,
          rangeDays: AUTO_COLLECTION_RANGE_DAYS,
        });

        let result: CollectMetricsResult;
        try {
          result = await services.collectMetrics({
            credentialRef: parsedInput.credentialRef,
            channelId: parsedInput.channelId,
            startDate,
            endDate,
          });
        } catch (error) {
          if (isDomainError(error) && error.code === "analytics_data_current") {
            return parseWithSchema(runAutoCollectionOutputSchema, { ranCollection: false }, "run auto collection output");
          }
          throw error;
        }

        return parseWithSchema(
          runAutoCollectionOutputSchema,
          { ranCollection: true, result },
          "run auto collection output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * BL-118 -- what automatic history catch-up still has to do for a channel (local reads only): per-video ranges before the rolling window
     * that are not collected yet, and the span of channel-level dates no channel-level run covers. Empty plan = nothing to do. Videos are
     * asked from one day before their own publish date; a video with recorded history is asked only from the day after it ends.
     */
    /** The channel's creation date (`YYYY-MM-DD`) for the Web UI's coverage display, `null` until a sync recorded it. Active-channel checked. */
    async getChannelStartDate(input: unknown): Promise<string | null> {
      const parsedInput = parseWithSchema(runAutoCollectionInputSchema, input, "channel start date input");
      try {
        await deps.channelAccess.assertActiveChannel({ userId: getCredentialUserId(parsedInput.credentialRef), channelId: parsedInput.channelId });
        const publishedAt = await deps.channelStore.getChannelPublishedAt(parsedInput.channelId);
        return publishedAt ? publishedAt.slice(0, 10) : null;
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    async getHistoryCatchUpPlan(input: unknown): Promise<HistoryCatchUpPlan> {
      const parsedInput = parseWithSchema(runAutoCollectionInputSchema, input, "history catch-up plan input");
      try {
        await deps.channelAccess.assertActiveChannel({ userId: getCredentialUserId(parsedInput.credentialRef), channelId: parsedInput.channelId });
        return await computeHistoryCatchUpPlan(parsedInput.channelId);
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * BL-118 (owner decisions 2026-10-03: automatic, closes gaps itself, no extra button) -- executes `getHistoryCatchUpPlan`: queries each
     * missing per-video range and the missing channel-level span, records ONE collection run for it, and advances each video's history only
     * for queries that succeeded (a failed video is simply planned again next time). Bounded per call (`MAX_CATCH_UP_VIDEOS_PER_RUN`) so a very
     * large channel finishes over several days instead of one long job. Not subject to the daily freshness gate: it only ever asks for
     * data no run has collected.
     */
    async runHistoryCatchUp(input: unknown, options: { progress?: ProgressReporter } = {}): Promise<HistoryCatchUpResult> {
      const parsedInput = parseWithSchema(runAutoCollectionInputSchema, input, "history catch-up input");
      const progress = options.progress;
      try {
        await deps.channelAccess.assertActiveChannel({ userId: getCredentialUserId(parsedInput.credentialRef), channelId: parsedInput.channelId });
        const plan = await computeHistoryCatchUpPlan(parsedInput.channelId);
        if (plan.videoRanges.length === 0 && !plan.channelRange) return { ranCatchUp: false };

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });
        const [videoDetails, existingHistory] = await Promise.all([
          deps.videoStore.listVideoDetailsByChannel(parsedInput.channelId),
          deps.historyStore ? deps.historyStore.listByChannel(parsedInput.channelId) : Promise.resolve([]),
        ]);
        const publishedAtById = new Map(videoDetails.map((d) => [d.videoId, d.publishedAt]));
        const historyById = new Map(existingHistory.map((h) => [h.videoId, h.historyThrough]));

        const batch = plan.videoRanges.slice(0, MAX_CATCH_UP_VIDEOS_PER_RUN);
        progress?.stage("Collecting earlier history (one query per video)");
        let upsertsIssued = 0;
        const skippedVideoIds: string[] = [];
        let done = 0;
        for (const range of batch) {
          progress?.counts(done, batch.length);
          try {
            const rows = await deps.youtubeApi.queryVideoAnalyticsReport({
              credentials,
              channelId: parsedInput.channelId,
              videoId: range.videoId,
              startDate: range.from,
              endDate: range.to,
              metricNames: ANALYTICS_METRIC_NAMES,
            });
            for (const row of rows) {
              for (const [metricName, metricValue] of Object.entries(row.metrics)) {
                await deps.metricStore.upsertMetric({ channelId: parsedInput.channelId, videoId: range.videoId, metricDate: row.date, metricName, metricValue });
                upsertsIssued += 1;
              }
            }
            const publishedAt = publishedAtById.get(range.videoId);
            if (deps.historyStore && publishedAt) {
              const through = nextVideoHistoryThrough({ prior: historyById.get(range.videoId) ?? null, publishedAt, query: { from: range.from, to: range.to } });
              if (through) await deps.historyStore.advance({ videoId: range.videoId, channelId: parsedInput.channelId, historyThrough: through });
            }
          } catch (error) {
            skippedVideoIds.push(range.videoId);
            catchUpFailedAt.set(`${parsedInput.channelId}|video|${range.videoId}`, deps.clock.now().getTime());
            deps.logger.error({
              event: "analytics.history_catch_up.video_skipped",
              context: { channelId: parsedInput.channelId, videoId: range.videoId, message: error instanceof Error ? error.message : "Unknown error" },
            });
          }
          done += 1;
        }
        progress?.counts(done, batch.length);

        let channelLevel = false;
        if (plan.channelRange) {
          progress?.stage("Collecting earlier channel totals");
          channelLevel = await collectChannelLevel({ credentials, channelId: parsedInput.channelId, ...plan.channelRange });
          if (!channelLevel) catchUpFailedAt.set(`${parsedInput.channelId}|channel`, deps.clock.now().getTime());
        }

        // What is recorded must claim only what was actually collected (a run's window counts as covered for EVERY video):
        //  - the channel totals, as their own channel-only run (no per-video claim), only if that query succeeded;
        //  - the per-video span as one run, only if EVERY planned video was queried successfully (otherwise the per-video progress lives in
        //    `analytics_video_history` and nothing over-claims; a failed attempt records nothing, so repeated attempts cannot grow the table).
        const remainingVideos = plan.videoRanges.length - batch.length;
        if (plan.channelRange && channelLevel) {
          await deps.collectionRunStore.record({
            channelId: parsedInput.channelId,
            requestedStartDate: plan.channelRange.startDate,
            requestedEndDate: plan.channelRange.endDate,
            videoCount: 0,
            upsertsIssued: 0,
            skippedVideoIds: [],
            channelLevel: true,
          });
        }
        const startDate = [...batch.map((r) => r.from), ...(plan.channelRange ? [plan.channelRange.startDate] : [])].sort()[0];
        const endDate = plan.rollingStart ? shiftIsoDate(plan.rollingStart, -1) : startDate;
        if (batch.length > 0 && skippedVideoIds.length === 0 && remainingVideos === 0) {
          await deps.collectionRunStore.record({
            channelId: parsedInput.channelId,
            requestedStartDate: batch.map((r) => r.from).sort()[0],
            requestedEndDate: endDate,
            videoCount: batch.length,
            upsertsIssued,
            skippedVideoIds: [],
            channelLevel: false,
          });
        }

        deps.logger.info({
          event: "analytics.history_catch_up.success",
          context: { channelId: parsedInput.channelId, videos: batch.length, upsertsIssued, channelLevel, remainingVideos },
        });
        return {
          ranCatchUp: true,
          videosQueried: batch.length,
          upsertsIssued,
          skippedVideoIds,
          channelLevel,
          startDate,
          endDate,
          remainingVideos,
        };
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Studio-Parity S6b (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4) -- the Analytics
     * "Overview" tab's channel-level cards/chart. A live Analytics API read (two
     * `queryChannelAnalyticsReport` calls: the requested period, and the immediately-preceding
     * period of the same length for the "+N% vs previous period" deltas Studio itself shows) --
     * deliberately NOT persisted to `video_metrics_daily` or any new table (unlike
     * `collectMetrics`): this is a small, on-demand read gated by the existing per-category
     * "Analytics reads enabled" toggle/traffic counters (`youtube-read-gateway`), not a bulk
     * per-video collection run, so `collectMetrics`'s own once-a-day freshness gate does not apply
     * here -- see this function's own doc comment for why a second gate would be the wrong layer.
     *
     * Totals are computed by summing the daily rows this function itself fetches, not read back
     * from a separate no-dimension query -- one report shape, two date ranges, rather than two
     * report shapes per range. A day missing from the API's response contributes `0` to every
     * metric's sum, which is a true fact about the sum (no days reported no activity), not the
     * same "silently defaulted a missing per-day-per-metric value to 0" case `collectMetrics`'s
     * own doc comment warns against for the raw per-row display.
     */
    async getChannelOverview(input: unknown): Promise<GetChannelOverviewResult> {
      const parsedInput = parseWithSchema(getChannelOverviewInputSchema, input, "get channel overview input");

      // `isoDateSchema` only checks digit shape (`\d{4}-\d{2}-\d{2}`), not that `startDate` is
      // actually on/before `endDate` or that either is a real calendar date -- `computePreviousPeriod`
      // is where that's actually checked, and it throws a plain `Error`, not a `DomainError`. Doing
      // this BEFORE the try block below (and before touching channel access/credentials at all)
      // matters: without it, this plain `Error` would fall into that block's generic
      // `mapUnknownError(error, "unauthorized")` fallback and come back as a misleading 401
      // "Unauthorized" for what is actually a 400 input-validation problem (found by independent
      // review, 2026-09-23, before this was ever exposed to a real caller).
      let previousStartDate: string;
      let previousEndDate: string;
      try {
        ({ previousStartDate, previousEndDate } = computePreviousPeriod(
          parsedInput.startDate,
          parsedInput.endDate
        ));
      } catch (error) {
        throw new DomainError({
          code: "validation_failed",
          message: error instanceof Error ? error.message : "Invalid date range",
        });
      }

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const sumTotals = (rows: Array<{ metrics: Record<string, number> }>): ChannelOverviewTotals =>
          rows.reduce(
            (totals, row) => ({
              views: totals.views + (row.metrics.views ?? 0),
              estimatedMinutesWatched: totals.estimatedMinutesWatched + (row.metrics.estimatedMinutesWatched ?? 0),
              subscribersGained: totals.subscribersGained + (row.metrics.subscribersGained ?? 0),
              subscribersLost: totals.subscribersLost + (row.metrics.subscribersLost ?? 0),
            }),
            { views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 }
          );
        const buildOutput = (
          currentRows: Array<{ date: string; metrics: Record<string, number> }>,
          previousRows: Array<{ date: string; metrics: Record<string, number> }>,
          extra: { source: "live" | "local"; collectedAt?: string | null }
        ) => ({
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          previousStartDate,
          previousEndDate,
          daily: zeroFillDailySeries(
            currentRows.map((row) => ({
              date: row.date,
              views: row.metrics.views ?? 0,
              estimatedMinutesWatched: row.metrics.estimatedMinutesWatched ?? 0,
              subscribersGained: row.metrics.subscribersGained ?? 0,
              subscribersLost: row.metrics.subscribersLost ?? 0,
            })),
            parsedInput.startDate,
            (date) => ({ date, views: 0, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 })
          ),
          currentTotals: sumTotals(currentRows),
          previousTotals: sumTotals(previousRows),
          viewCountingChangeInComparison: rangesStraddleViewCountingChange(
            { startDate: parsedInput.startDate, endDate: parsedInput.endDate },
            { startDate: previousStartDate, endDate: previousEndDate }
          ),
          ...extra,
        });

        // BL-118 (owner's observation, 2026-10-03): the channel-level daily totals are collected and stored with every run, so when every date
        // of both periods is covered by a run that stored them, answer from the database -- no live call, no quota. Anything else (or
        // `preferLocal` off, the Web UI Overview's default) is the live read below, exactly as before.
        if (parsedInput.preferLocal && deps.channelMetricStore?.listInRange) {
          const [runs, publishedAt] = await Promise.all([
            deps.collectionRunStore.listByChannel(parsedInput.channelId),
            deps.channelStore.getChannelPublishedAt(parsedInput.channelId),
          ]);
          const covered = isRangeFullyCovered({
            startDate: previousStartDate,
            endDate: parsedInput.endDate,
            runs: runs.filter((run) => run.channelLevel === true),
            requireVideos: false,
            // Days before the channel existed cannot have data: a comparison period that reaches back past the channel's start is still
            // answerable from the stored totals once everything since the start is covered.
            channelStartDate: publishedAt ? publishedAt.slice(0, 10) : null,
            now: deps.clock.now(),
          });
          if (covered) {
            const stored = await deps.channelMetricStore.listInRange(parsedInput.channelId, { startDate: previousStartDate, endDate: parsedInput.endDate });
            const byDate = new Map<string, Record<string, number>>();
            for (const row of stored) {
              const metrics = byDate.get(row.metricDate) ?? {};
              metrics[row.metricName] = row.metricValue;
              byDate.set(row.metricDate, metrics);
            }
            const rowsIn = (from: string, to: string) =>
              [...byDate.entries()]
                .filter(([date]) => date >= from && date <= to)
                .sort(([a], [b]) => (a < b ? -1 : 1))
                .map(([date, metrics]) => ({ date, metrics }));
            const collectedAt = deps.channelMetricStore.getLatestCollectedAt ? await deps.channelMetricStore.getLatestCollectedAt(parsedInput.channelId) : null;
            return parseWithSchema(
              getChannelOverviewOutputSchema,
              buildOutput(rowsIn(parsedInput.startDate, parsedInput.endDate), rowsIn(previousStartDate, previousEndDate), {
                source: "local",
                collectedAt: collectedAt ? collectedAt.toISOString() : null,
              }),
              "get channel overview output"
            );
          }
        }

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });

        const [currentRows, previousRows] = await Promise.all([
          deps.youtubeApi.queryChannelAnalyticsReport({
            credentials,
            channelId: parsedInput.channelId,
            startDate: parsedInput.startDate,
            endDate: parsedInput.endDate,
            metricNames: CHANNEL_OVERVIEW_METRIC_NAMES,
          }),
          deps.youtubeApi.queryChannelAnalyticsReport({
            credentials,
            channelId: parsedInput.channelId,
            startDate: previousStartDate,
            endDate: previousEndDate,
            metricNames: CHANNEL_OVERVIEW_METRIC_NAMES,
          }),
        ]);

        const output = buildOutput(currentRows, previousRows, { source: "live" });

        return parseWithSchema(getChannelOverviewOutputSchema, output, "get channel overview output");
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §1's
     * cross-cutting note, slices C2/A2/A3/A4/A6) -- one shared method for every channel-level,
     * non-`day` breakdown card (traffic sources, device type, age/gender, geography, subscribed
     * status, content format), parameterized by `breakdown` (`CHANNEL_BREAKDOWN_PRESETS`). A live
     * read for the selected period only, never persisted -- same precedent as `getChannelOverview`
     * above, not `collectMetrics`'s daily-collection-and-store model (see the plan's own §1 note on
     * why these two persistence models are deliberately different).
     */
    async getChannelBreakdown(input: unknown): Promise<GetChannelBreakdownResult> {
      const parsedInput = parseWithSchema(getChannelBreakdownInputSchema, input, "get channel breakdown input");

      try {
        assertValidDateRange(parsedInput.startDate, parsedInput.endDate);
      } catch (error) {
        throw new DomainError({
          code: "validation_failed",
          message: error instanceof Error ? error.message : "Invalid date range",
        });
      }

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });

        const preset = CHANNEL_BREAKDOWN_PRESETS[parsedInput.breakdown as ChannelBreakdownKind];
        const rows = await deps.youtubeApi.queryChannelBreakdownReport({
          credentials,
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          dimensions: preset.dimensions,
          metricNames: preset.metricNames,
        });

        const output = {
          channelId: parsedInput.channelId,
          breakdown: parsedInput.breakdown,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          rows,
        };

        return parseWithSchema(getChannelBreakdownOutputSchema, output, "get channel breakdown output");
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4,
     * Slice C4, "Intro" mode) -- one video's own audience-retention curve
     * (`elapsedVideoTimeRatio` dimension, confirmed against a real response, BL-093). A live read,
     * same persistence model as `getChannelOverview`/`getChannelBreakdown` (never stored).
     *
     * `videoId` must belong to `channelId` (`docs/DEVELOPMENT_PLAYBOOK.md` §6.6) -- checked against
     * `videoStore.listVideosByChannel`, the same discipline `getComparableAgeComparison` already
     * uses, never assumed from the caller's own input.
     */
    async getVideoRetentionCurve(input: unknown): Promise<GetVideoRetentionCurveResult> {
      const parsedInput = parseWithSchema(getVideoRetentionCurveInputSchema, input, "get video retention curve input");

      try {
        assertValidDateRange(parsedInput.startDate, parsedInput.endDate);
      } catch (error) {
        throw new DomainError({
          code: "validation_failed",
          message: error instanceof Error ? error.message : "Invalid date range",
        });
      }

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const videos = await deps.videoStore.listVideosByChannel(parsedInput.channelId);
        if (!videos.some((video) => video.videoId === parsedInput.videoId)) {
          throw new DomainError({
            code: "validation_failed",
            message: `videoId ${parsedInput.videoId} does not belong to channel ${parsedInput.channelId}`,
            details: { videoId: parsedInput.videoId },
          });
        }

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });

        const rows = await deps.youtubeApi.queryChannelBreakdownReport({
          credentials,
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          dimensions: "elapsedVideoTimeRatio",
          metricNames: ["audienceWatchRatio", "relativeRetentionPerformance"],
          filters: `video==${parsedInput.videoId}`,
        });

        // `?? 0` on a row missing one of these two metrics is a real, pre-existing pattern this
        // file's own `getChannelOverview` already uses for its own daily rows (independent review
        // round 3, 2026-09-26, flagged the same tension that function's own doc comment already
        // has) -- not introduced fresh here. Low-risk in practice: every real response this
        // session's live probe observed included both metrics on every row; `audienceWatchRatio`
        // is the only one the UI currently renders, `relativeRetentionPerformance` is fetched but
        // unused (Content-analytics-panel's "Intro" mode never displays a "typical retention"
        // comparison, per this plan's own scoping).
        const points = rows
          .map((row) => ({
            elapsedVideoTimeRatio: Number(row.dimensionValues[0]),
            audienceWatchRatio: row.metrics.audienceWatchRatio ?? 0,
            relativeRetentionPerformance: row.metrics.relativeRetentionPerformance ?? 0,
          }))
          .sort((a, b) => a.elapsedVideoTimeRatio - b.elapsedVideoTimeRatio);

        const output = {
          channelId: parsedInput.channelId,
          videoId: parsedInput.videoId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          points,
        };

        return parseWithSchema(getVideoRetentionCurveOutputSchema, output, "get video retention curve output");
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Phase 8 follow-up, slice 2 (docs/roadmap/FUTURE_PHASES.md §4, "data-quality/missing-data
     * diagnostics"). A pure local read -- no YouTube call, no `authResolver` needed, same as
     * `listMetrics` -- over `collectionRunStore`'s history for the channel. See
     * `data-quality.ts`'s `computeDataQualityReport` for the actual computation and why
     * `video_metrics_daily` alone can't answer this.
     */
    async getDataQualityReport(input: unknown): Promise<DataQualityReportResult> {
      const parsedInput = parseWithSchema(getDataQualityReportInputSchema, input, "get data quality report input");

      try {
        assertValidDateRange(parsedInput.startDate, parsedInput.endDate);
      } catch (error) {
        throw new DomainError({
          code: "validation_failed",
          message: error instanceof Error ? error.message : "Invalid date range",
        });
      }

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const [runs, metricRecords] = await Promise.all([
          deps.collectionRunStore.listByChannel(parsedInput.channelId),
          deps.metricStore.listMetricsByChannel(parsedInput.channelId),
        ]);
        const datesWithAnyMetricRow = new Set(metricRecords.map((record) => record.metricDate));
        const now = deps.clock.now();
        const baseReport = computeDataQualityReport({
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          runs,
          datesWithAnyMetricRow,
          now,
        });
        // BL-118: dates before the channel existed are "not applicable", not "uncovered"; plus ranges and what "covered" means.
        const publishedAt = await deps.channelStore.getChannelPublishedAt(parsedInput.channelId);
        const { report, extras } = extendDataQualityReport({
          report: baseReport,
          startDate: parsedInput.startDate,
          channelStartDate: publishedAt ? publishedAt.slice(0, 10) : null,
          datesWithAnyMetricRow,
          now,
        });

        return parseWithSchema(
          getDataQualityReportOutputSchema,
          {
            channelId: parsedInput.channelId,
            startDate: parsedInput.startDate,
            endDate: parsedInput.endDate,
            ...report,
            ...extras,
          },
          "get data quality report output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Phase 8 follow-up, slice 3 (docs/roadmap/FUTURE_PHASES.md §4, "comparing videos at
     * comparable ages"). A pure local read -- no YouTube call, no `authResolver` -- over already
     * collected `video_metrics_daily` rows, aligned by each video's own days-since-publish (see
     * `comparable-age.ts` for the Pacific-Time day math and the "never fabricate a gap" rule).
     *
     * Every requested `videoId` must belong to `channelId` (`docs/DEVELOPMENT_PLAYBOOK.md` §6.6) --
     * checked against `videoStore.listVideoDetailsByChannel`, never assumed from the caller's own
     * input. An id that doesn't resolve is reported back explicitly (`validation_failed`, with the
     * offending ids in `details`), never silently dropped from the comparison.
     *
     * Deliberately produces no ranking, no "outperforming"/"underperforming" language, and no
     * headline verdict -- `docs/roadmap/FUTURE_PHASES.md` §4's own constraint ("distinguish
     * observed facts from interpretations... avoid unsupported conclusions from small samples").
     * The caller (human or agent) sees the same raw per-video series and draws its own conclusion.
     */
    async getComparableAgeComparison(input: unknown): Promise<GetComparableAgeComparisonResult> {
      const parsedInput = parseWithSchema(
        getComparableAgeComparisonInputSchema,
        input,
        "get comparable age comparison input"
      );

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const [videoDetails, metricRecords] = await Promise.all([
          deps.videoStore.listVideoDetailsByChannel(parsedInput.channelId),
          deps.metricStore.listMetricsByChannel(parsedInput.channelId),
        ]);

        const videoDetailsById = new Map(videoDetails.map((video) => [video.videoId, video]));
        const unknownVideoIds = parsedInput.videoIds.filter((videoId) => !videoDetailsById.has(videoId));
        if (unknownVideoIds.length > 0) {
          throw new DomainError({
            code: "validation_failed",
            message: `The following videoIds do not belong to channel ${parsedInput.channelId}: ${unknownVideoIds.join(", ")}`,
            details: { unknownVideoIds },
          });
        }

        const rowsByVideoId = new Map<string, Array<{ metricDate: string; metricValue: number }>>();
        for (const record of metricRecords) {
          if (record.metricName !== parsedInput.metricName) continue;
          const list = rowsByVideoId.get(record.videoId);
          const row = { metricDate: record.metricDate, metricValue: record.metricValue };
          if (list) {
            list.push(row);
          } else {
            rowsByVideoId.set(record.videoId, [row]);
          }
        }

        // `computeComparableAgeSeries` throws a plain `Error` (never a `DomainError`) on an
        // unparseable `publishedAt` -- extremely unlikely in practice (`videos.published_at` is a
        // `NOT NULL` column populated from a real Data API v3 response), but caught and remapped
        // to `validation_failed` here rather than falling into the generic
        // `mapUnknownError(error, "unauthorized")` below, which would otherwise surface this as a
        // misleading 401 for what is actually a data-shape problem -- the same bug class
        // `getChannelOverview`'s own doc comment already documents fixing once (found by
        // independent review, 2026-09-23).
        let videos: GetComparableAgeComparisonResult["videos"];
        try {
          videos = parsedInput.videoIds.map((videoId) => {
            const details = videoDetailsById.get(videoId)!;
            const series = computeComparableAgeSeries({
              publishedAt: details.publishedAt,
              metricRows: rowsByVideoId.get(videoId) ?? [],
              maxDays: parsedInput.maxDays,
            });

            return {
              videoId,
              title: details.title,
              publishedAt: details.publishedAt,
              publishDatePacific: series.publishDatePacific,
              points: series.points,
              cumulativePoints: series.cumulativePoints,
            };
          });
        } catch (error) {
          throw new DomainError({
            code: "validation_failed",
            message: error instanceof Error ? error.message : "Invalid video publish date",
          });
        }

        const output = {
          channelId: parsedInput.channelId,
          metricName: parsedInput.metricName,
          maxDays: parsedInput.maxDays,
          videos,
        };

        return parseWithSchema(
          getComparableAgeComparisonOutputSchema,
          output,
          "get comparable age comparison output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /**
     * Phase 8 follow-up, slice 4 (docs/roadmap/FUTURE_PHASES.md §4, "analytical reports and
     * weekly channel reviews"). A pure local read/compute -- no YouTube call, no `authResolver` --
     * meant to be called once per dashboard mount (`src/app/dashboard/page.tsx`), the same
     * "on entering the dashboard" trigger point BL-059's daily auto-collection already uses,
     * chained AFTER that trigger resolves so a Monday load sees Monday's own freshly-collected
     * data (see `weekly-report.ts`'s own doc comment for the full trigger design and its
     * documented local-trigger-time-vs-Pacific-Time-data skew).
     *
     * Reuses the SAME `localTime`/`timezone` Settings pair the daily auto-collection boundary
     * already reads (`settingsStore.getAnalyticsSyncSettings`) -- no separate weekly-report
     * setting, per the owner's own explicit instruction.
     *
     * A `status: "final"` row is never overwritten -- only regenerated when the currently-stored
     * row for the due week is missing or still `"provisional"`. This own read-then-write check is
     * a cheap early-exit (skip the read/compute work entirely when nothing needs to happen), but
     * it is NOT itself atomic across two concurrent callers (e.g. two open dashboard tabs) -- the
     * actual guarantee that a final row is never overwritten is enforced at the DB layer, inside
     * `db.ts`'s `upsertWeeklyReport` itself (a conditional `ON CONFLICT ... WHERE`), which is
     * immune to this function's own race (found by independent review, 2026-09-23).
     */
    async runWeeklyReportIfDue(input: unknown): Promise<RunWeeklyReportIfDueResult> {
      const parsedInput = parseWithSchema(runWeeklyReportIfDueInputSchema, input, "run weekly report if due input");

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const now = deps.clock.now();
        const { localTime, timezone } = await deps.settingsStore.getAnalyticsSyncSettings();
        const dueWeek = computeDueReportWeek({ now, timezone, localTime });

        const existing = await deps.weeklyReportStore.getByWeek(parsedInput.channelId, dueWeek.weekStartDate);
        if (existing && existing.status === "final") {
          return parseWithSchema(runWeeklyReportIfDueOutputSchema, { generated: false }, "run weekly report if due output");
        }

        const [videoDetails, metricRecords, runs] = await Promise.all([
          deps.videoStore.listVideoDetailsByChannel(parsedInput.channelId),
          deps.metricStore.listMetricsByChannel(parsedInput.channelId),
          deps.collectionRunStore.listByChannel(parsedInput.channelId),
        ]);

        const content = computeWeeklyReportContent({
          channelId: parsedInput.channelId,
          weekStartDate: dueWeek.weekStartDate,
          weekEndDate: dueWeek.weekEndDate,
          now,
          runs,
          datesWithAnyMetricRow: new Set(metricRecords.map((record) => record.metricDate)),
          metricRecords,
          videoTitlesById: new Map(videoDetails.map((video) => [video.videoId, video.title])),
        });

        // Accepted, low-impact gap (independent review round 2, 2026-09-23): this response is
        // always built from the locally-computed `content`, never re-read from the store, so under
        // the exact concurrent-caller race db.ts's `upsertWeeklyReport` guards against, the LOSING
        // caller here would report "generated: true" with content that doesn't match what actually
        // ended up persisted (the DB integrity guarantee still holds -- only this response/log
        // would be describing a write that was silently dropped). Not fixed: the only caller
        // (src/app/dashboard/page.tsx) fires this via `fetch(...).catch(() => {})` and never reads
        // the response body, and no MCP/CLI surface exposes this generate path at all.
        const reportJson = JSON.stringify(content);
        await deps.weeklyReportStore.upsert(
          {
            channelId: parsedInput.channelId,
            weekStartDate: dueWeek.weekStartDate,
            weekEndDate: dueWeek.weekEndDate,
            status: content.status,
            reportJson,
          },
          now
        );

        deps.logger.info({
          event: "analytics.weekly_report.generated",
          context: { channelId: parsedInput.channelId, weekStartDate: dueWeek.weekStartDate, status: content.status },
        });

        const report: WeeklyReportSummary = {
          channelId: parsedInput.channelId,
          weekStartDate: dueWeek.weekStartDate,
          weekEndDate: dueWeek.weekEndDate,
          status: content.status,
          generatedAt: now.toISOString(),
          report: content,
        };

        return parseWithSchema(
          runWeeklyReportIfDueOutputSchema,
          { generated: true, report },
          "run weekly report if due output"
        );
      } catch (error) {
        const mapped = mapUnknownError(error, "unauthorized");
        deps.logger.error({ event: "analytics.weekly_report.error", context: { code: mapped.code } });
        throw mapped;
      }
    },

    /** Read-only list of every stored weekly report snapshot for the channel, newest week first. */
    async listWeeklyReports(input: unknown): Promise<ListWeeklyReportsResult> {
      const parsedInput = parseWithSchema(listWeeklyReportsInputSchema, input, "list weekly reports input");

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const rows = await deps.weeklyReportStore.listByChannel(parsedInput.channelId);
        const reports = rows.map(mapStoredWeeklyReport);

        return parseWithSchema(
          listWeeklyReportsOutputSchema,
          { channelId: parsedInput.channelId, reports },
          "list weekly reports output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },

    /** Read-only fetch of one stored weekly report snapshot by its week's start date. */
    async getWeeklyReport(input: unknown): Promise<GetWeeklyReportResult> {
      const parsedInput = parseWithSchema(getWeeklyReportInputSchema, input, "get weekly report input");

      try {
        const userId = getCredentialUserId(parsedInput.credentialRef);
        await deps.channelAccess.assertActiveChannel({
          userId,
          channelId: parsedInput.channelId,
        });

        const row = await deps.weeklyReportStore.getByWeek(parsedInput.channelId, parsedInput.weekStartDate);
        const report = row ? mapStoredWeeklyReport(row) : null;

        return parseWithSchema(
          getWeeklyReportOutputSchema,
          { channelId: parsedInput.channelId, report },
          "get weekly report output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },
  };

  return services;
}

export type AnalyticsServices = ReturnType<typeof createAnalyticsServices>;
