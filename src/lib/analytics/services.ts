import { YOUTUBE_ANALYTICS_READ_SCOPE } from "@/lib/auth";
import type { ChannelAccessService } from "@/lib/channel-access";
import {
  ANALYTICS_METRIC_NAMES,
  DomainError,
  isDomainError,
  type CollectMetricsResult,
  type ListMetricsResult,
  type ResolvedCredentials,
  type StoredVideoMetricRow,
} from "./contracts";
import {
  collectMetricsInputSchema,
  collectMetricsOutputSchema,
  listMetricsInputSchema,
  listMetricsOutputSchema,
  parseWithSchema,
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
  return {
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

        const credentials = await deps.authResolver.resolve({
          credentialRef: parsedInput.credentialRef,
          requiredScopes: [YOUTUBE_ANALYTICS_READ_SCOPE],
        });

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
        const rows = records.map((record) => ({
          videoId: record.videoId,
          metricDate: record.metricDate,
          metricName: record.metricName,
          metricValue: record.metricValue,
        }));

        return parseWithSchema(
          listMetricsOutputSchema,
          { channelId: parsedInput.channelId, rows },
          "list metrics output"
        );
      } catch (error) {
        throw mapUnknownError(error, "unauthorized");
      }
    },
  };
}

export type AnalyticsServices = ReturnType<typeof createAnalyticsServices>;
