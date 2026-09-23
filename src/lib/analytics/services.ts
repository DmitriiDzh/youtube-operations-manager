import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import type { ChannelAccessService } from "@/lib/channel-access";
import { computeDefaultAutoCollectionRange, computeNextRefreshAt, isAnalyticsCollectionStale } from "./staleness";
import { computePreviousPeriod, zeroFillDailySeries } from "./period";
import {
  ANALYTICS_METRIC_NAMES,
  AUTO_COLLECTION_RANGE_DAYS,
  CHANNEL_OVERVIEW_METRIC_NAMES,
  DomainError,
  isDomainError,
  type AutoCollectResult,
  type ChannelOverviewTotals,
  type CollectMetricsResult,
  type GetChannelOverviewResult,
  type ListMetricsResult,
  type ResolvedCredentials,
  type StoredVideoMetricRow,
} from "./contracts";
import {
  collectMetricsInputSchema,
  collectMetricsOutputSchema,
  getChannelOverviewInputSchema,
  getChannelOverviewOutputSchema,
  listMetricsInputSchema,
  listMetricsOutputSchema,
  parseWithSchema,
  runAutoCollectionInputSchema,
  runAutoCollectionOutputSchema,
} from "./schemas";

export type StoredVideoRef = {
  videoId: string;
  channelId: string;
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
  };
  videoStore: {
    listVideosByChannel(channelId: string): Promise<StoredVideoRef[]>;
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
  channelAccess: ChannelAccessService;
  // BL-059 -- the per-channel "when did the daily auto-collection last actually run" timestamp,
  // deliberately separate from metricStore's per-row collected_at (see channels.
  // analyticsLastAutoCollectedAt's own doc comment in db.ts for why).
  channelStore: {
    getAnalyticsLastAutoCollectedAt(channelId: string): Promise<Date | null>;
    markAnalyticsAutoCollected(channelId: string, at: Date): Promise<void>;
  };
  settingsStore: {
    getAnalyticsSyncSettings(): Promise<{ localTime: string; timezone: string }>;
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

export function createAnalyticsServices(deps: ServiceDependencies) {
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
     * The mark happens right after credentials resolve successfully -- deliberately NOT before
     * (an earlier version of this gate marked the channel collected before resolving credentials,
     * which meant a credential failure, e.g. the real "Credentials are missing required OAuth
     * scopes" case this owner hit earlier, left the channel marked collected-for-today with zero
     * data actually fetched, locking even the manual button until tomorrow's boundary with no UI
     * way out). Marking after a successful resolve narrows, rather than removes, the concurrency
     * window two callers (a manual click racing the auto-trigger, or two browser tabs) could both
     * pass through in -- both would then spend one real day's worth of Analytics quota instead of
     * none, which is strictly better than a 24h lockout from a single failed attempt.
     */
    async collectMetrics(input: unknown): Promise<CollectMetricsResult> {
      const parsedInput = parseWithSchema(collectMetricsInputSchema, input, "collect metrics input");
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

        if (!isAnalyticsCollectionStale({ now, lastAutoCollectedAt: lastCollectedAt, timezone, localTime })) {
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

        await deps.channelStore.markAnalyticsAutoCollected(parsedInput.channelId, now);

        const videos = await deps.videoStore.listVideosByChannel(parsedInput.channelId);

        let upsertsIssued = 0;
        const skippedVideoIds: string[] = [];

        for (const video of videos) {
          try {
            const rows = await deps.youtubeApi.queryVideoAnalyticsReport({
              credentials,
              channelId: parsedInput.channelId,
              videoId: video.videoId,
              startDate: parsedInput.startDate,
              endDate: parsedInput.endDate,
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
        }

        const output = {
          channelId: parsedInput.channelId,
          startDate: parsedInput.startDate,
          endDate: parsedInput.endDate,
          videoCount: videos.length,
          upsertsIssued,
          skippedVideoIds,
        };

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

        const output = {
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
        };

        return parseWithSchema(getChannelOverviewOutputSchema, output, "get channel overview output");
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },
  };

  return services;
}

export type AnalyticsServices = ReturnType<typeof createAnalyticsServices>;
