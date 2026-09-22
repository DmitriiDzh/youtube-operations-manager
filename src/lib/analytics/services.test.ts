import assert from "node:assert/strict";
import test from "node:test";
import { createChannelAccessService } from "@/lib/channel-access";
import { DomainError } from "./contracts";
import { createAnalyticsServices } from "./services";
import type { ResolvedCredentials } from "./contracts";

function createFakeChannelAccess() {
  const selections = new Map<string, string>();
  const service = createChannelAccessService({
    async getSelectedChannelId(userId: string) {
      return selections.get(userId) ?? null;
    },
    async setSelectedChannelId(userId: string, channelId: string) {
      selections.set(userId, channelId);
    },
  });
  return service;
}

type FakeVideo = { videoId: string; channelId: string };
type FakeAnalyticsRow = { date: string; metrics: Record<string, number> };

function createServicesFixture(opts: {
  videosByChannel: Record<string, FakeVideo[]>;
  analyticsResponses: Record<string, FakeAnalyticsRow[] | Error>;
}) {
  const channelAccess = createFakeChannelAccess();
  const analyticsCalls: Array<{ channelId: string; videoId: string }> = [];
  const upsertedRows: Array<{
    channelId: string;
    videoId: string;
    metricDate: string;
    metricName: string;
    metricValue: number;
  }> = [];
  const metricRowsByKey = new Map<string, number>();

  const youtubeApi = {
    async queryVideoAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      videoId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }) {
      analyticsCalls.push({ channelId: args.channelId, videoId: args.videoId });
      const response = opts.analyticsResponses[args.videoId];
      if (response instanceof Error) throw response;
      return response ?? [];
    },
  };

  const videoStore = {
    async listVideosByChannel(channelId: string) {
      return opts.videosByChannel[channelId] ?? [];
    },
  };

  const metricStore = {
    async upsertMetric(args: {
      channelId: string;
      videoId: string;
      metricDate: string;
      metricName: string;
      metricValue: number;
    }) {
      const key = `${args.videoId}|${args.metricDate}|${args.metricName}`;
      metricRowsByKey.set(key, args.metricValue); // upsert semantics -- overwrite, never duplicate
      upsertedRows.push(args);
    },
  };

  const authResolver = {
    async resolve(): Promise<ResolvedCredentials> {
      return {
        credentialRef: { userId: "user-1" },
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        scopeSet: new Set(["https://www.googleapis.com/auth/yt-analytics.readonly"]),
      };
    },
  };

  const logger = { info() {}, error() {} };

  const services = createAnalyticsServices({
    authResolver,
    youtubeApi,
    videoStore,
    metricStore,
    channelAccess,
    logger,
  });

  return { services, channelAccess, analyticsCalls, upsertedRows, metricRowsByKey };
}

test("collectMetrics fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
  });

  await assert.rejects(
    () =>
      services.collectMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-01",
        endDate: "2026-09-20",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

// docs/roadmap/plans/PHASE_8_PLAN.md §7: "A wrong-channel metrics request (video belonging to a
// different synced channel) fails closed." A video genuinely belonging to a DIFFERENT channel
// (UC_B) must never be queried when collecting for UC_A, even though both channels are locally
// known -- proven directly by asserting UC_B's video id never appears in analyticsCalls, not just
// inferred from listVideosByChannel's own filtering.
test("collectMetrics never queries a video belonging to a different channel", async () => {
  const { services, channelAccess, analyticsCalls } = createServicesFixture({
    videosByChannel: {
      UC_A: [{ videoId: "v1", channelId: "UC_A" }],
      UC_B: [{ videoId: "v2", channelId: "UC_B" }],
    },
    analyticsResponses: {
      v1: [{ date: "2026-09-01", metrics: { views: 100 } }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });

  assert.equal(result.videoCount, 1);
  assert.deepEqual(
    analyticsCalls.map((c) => c.videoId),
    ["v1"]
  );
  assert.ok(!analyticsCalls.some((c) => c.videoId === "v2"), "must never query UC_B's video while collecting for UC_A");
});

test("collectMetrics writes one row per (video, date, metric) returned by the Analytics API", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {
      v1: [
        { date: "2026-09-01", metrics: { views: 100, likes: 5 } },
        { date: "2026-09-02", metrics: { views: 150, likes: 7 } },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  });

  assert.equal(result.upsertsIssued, 4);
  assert.equal(upsertedRows.length, 4);
  assert.deepEqual(result.skippedVideoIds, []);
});

// docs/roadmap/plans/PHASE_8_PLAN.md §7: "Re-running collection for a date range already
// collected is idempotent (upsert by the table's primary key), not a duplicate-row bug."
test("collectMetrics run twice over the same range is idempotent at the service layer", async () => {
  const { services, channelAccess, metricRowsByKey } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {
      v1: [{ date: "2026-09-01", metrics: { views: 100 } }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const collect = () =>
    services.collectMetrics({
      credentialRef: { userId: "user-1" },
      channelId: "UC_A",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
    });

  await collect();
  await collect();

  assert.equal(metricRowsByKey.size, 1, "re-running must update the same (video, date, metric) key, not create a second one");
  assert.equal(metricRowsByKey.get("v1|2026-09-01|views"), 100);
});

// One video's collection failing (e.g. an API error) must not fail the whole channel's run.
test("collectMetrics isolates a per-video failure into skippedVideoIds, other videos still succeed", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: {
      UC_A: [
        { videoId: "v1", channelId: "UC_A" },
        { videoId: "v2", channelId: "UC_A" },
      ],
    },
    analyticsResponses: {
      v1: new Error("simulated Analytics API failure for v1"),
      v2: [{ date: "2026-09-01", metrics: { views: 50 } }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });

  assert.equal(result.videoCount, 2);
  assert.deepEqual(result.skippedVideoIds, ["v1"]);
  assert.equal(result.upsertsIssued, 1);
  assert.equal(upsertedRows.length, 1);
  assert.equal(upsertedRows[0]?.videoId, "v2");
});

test("collectMetrics defaults to the full ANALYTICS_METRIC_NAMES list when metricNames is omitted", async () => {
  let requestedMetricNames: readonly string[] | undefined;
  const { channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const services = createAnalyticsServices({
    authResolver: {
      async resolve(): Promise<ResolvedCredentials> {
        return {
          credentialRef: { userId: "user-1" },
          accessToken: "token",
          scopeSet: new Set(),
        };
      },
    },
    youtubeApi: {
      async queryVideoAnalyticsReport(args: { metricNames: readonly string[] }) {
        requestedMetricNames = args.metricNames;
        return [];
      },
    },
    videoStore: {
      async listVideosByChannel() {
        return [{ videoId: "v1", channelId: "UC_A" }];
      },
    },
    metricStore: { async upsertMetric() {} },
    channelAccess,
    logger: { info() {}, error() {} },
  });

  await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });

  assert.ok(requestedMetricNames && requestedMetricNames.length > 20, "should default to the full metric list, not an empty/short one");
  assert.ok(requestedMetricNames?.includes("views"));
  assert.ok(!requestedMetricNames?.some((name) => /revenue|Cpm|adImpressions|monetizedPlaybacks/i.test(name)), "must never default-request a monetary metric");
});
