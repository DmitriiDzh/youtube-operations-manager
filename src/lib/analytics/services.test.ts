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
  channelAnalyticsResponses?: Record<string, FakeAnalyticsRow[] | Error>;
  syncSettings?: { localTime: string; timezone: string };
  now?: Date;
  authResolverError?: Error;
}) {
  const channelAccess = createFakeChannelAccess();
  const analyticsCalls: Array<{ channelId: string; videoId: string }> = [];
  const channelAnalyticsCalls: Array<{ channelId: string; startDate: string; endDate: string }> = [];
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
    async queryChannelAnalyticsReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      metricNames: readonly string[];
    }) {
      channelAnalyticsCalls.push({ channelId: args.channelId, startDate: args.startDate, endDate: args.endDate });
      const key = `${args.startDate}|${args.endDate}`;
      const response = (opts.channelAnalyticsResponses ?? {})[key];
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
    async listMetricsByChannel(channelId: string) {
      return upsertedRows.filter((row) => row.channelId === channelId);
    },
  };

  const authResolver = {
    async resolve(): Promise<ResolvedCredentials> {
      if (opts.authResolverError) throw opts.authResolverError;
      return {
        credentialRef: { userId: "user-1" },
        accessToken: "fake-access-token",
        refreshToken: "fake-refresh-token",
        scopeSet: new Set(["https://www.googleapis.com/auth/yt-analytics.readonly"]),
      };
    },
  };

  const logger = { info() {}, error() {} };

  const lastAutoCollectedAtByChannel = new Map<string, Date | null>();
  const channelStore = {
    async getAnalyticsLastAutoCollectedAt(channelId: string) {
      return lastAutoCollectedAtByChannel.get(channelId) ?? null;
    },
    async markAnalyticsAutoCollected(channelId: string, at: Date) {
      lastAutoCollectedAtByChannel.set(channelId, at);
    },
  };

  const settingsStore = {
    async getAnalyticsSyncSettings() {
      return opts.syncSettings ?? { localTime: "12:00", timezone: "UTC" };
    },
  };

  let currentNow = opts.now ?? new Date("2026-09-22T15:00:00Z");
  const clock = { now: () => currentNow };

  const services = createAnalyticsServices({
    authResolver,
    youtubeApi,
    videoStore,
    metricStore,
    channelStore,
    settingsStore,
    clock,
    channelAccess,
    logger,
  });

  return {
    services,
    channelAccess,
    analyticsCalls,
    channelAnalyticsCalls,
    upsertedRows,
    metricRowsByKey,
    lastAutoCollectedAtByChannel,
    setNow: (date: Date) => {
      currentNow = date;
    },
  };
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
// This test previously called collectMetrics twice back-to-back with no time advance between
// calls -- valid until the 2026-09-22 daily-freshness-gate instruction ("шлюзы не должны
// позволять повторные вызовы... сколько было попыток... за последние сутки") made that second,
// same-day call something collectMetrics must now REFUSE (analytics_data_current), not silently
// re-run. Rewritten to actually exercise both requirements: the gate refuses the same-day repeat,
// and -- the original intent, still true -- a genuine next-day re-collection over an overlapping
// date range updates the same (video, date, metric) row rather than creating a second one.
test("collectMetrics: refuses a same-day repeat, but a genuine next-day re-collection over the same range is idempotent", async () => {
  const { services, channelAccess, metricRowsByKey, setNow } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {
      v1: [{ date: "2026-09-01", metrics: { views: 100 } }],
    },
    now: new Date("2026-09-22T13:00:00Z"), // after the 12:00 UTC default boundary
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

  await assert.rejects(
    () => collect(),
    (error: unknown) => error instanceof DomainError && error.code === "analytics_data_current"
  );
  assert.equal(metricRowsByKey.size, 1, "the refused repeat must not touch the store at all");

  setNow(new Date("2026-09-23T13:00:00Z")); // next day, past that day's own boundary
  await collect();

  assert.equal(metricRowsByKey.size, 1, "the next-day re-collection must update the same (video, date, metric) key, not create a second one");
  assert.equal(metricRowsByKey.get("v1|2026-09-01|views"), 100);
});

// The daily-freshness gate must apply no matter WHICH caller triggers the second attempt (owner
// instruction: "ни человеку, ни агенту, ни каким-то скриптам") -- exercised here as an
// auto-collection marking the channel fresh, then a manual "Collect now" call for the same
// channel being refused, since both paths funnel through this same collectMetrics gate.
test("collectMetrics: a manual call is refused if an auto-collection already ran today for this channel", async () => {
  const { services, channelAccess, analyticsCalls } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    now: new Date("2026-09-22T13:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(analyticsCalls.length, 1, "sanity check -- the auto-trigger actually ran once");

  await assert.rejects(
    () =>
      services.collectMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "analytics_data_current"
  );
  assert.equal(analyticsCalls.length, 1, "the manual call must never reach the real Analytics API");
});

// Regression test for a real bug the project owner hit in this session ("Credentials are missing
// required OAuth scopes"): the gate used to mark the channel collected-for-today BEFORE resolving
// credentials, so a credential failure -- zero real data fetched -- still locked the manual button
// out until tomorrow's boundary, with no UI way to undo it. The mark must only happen once
// credentials have actually resolved, so a failed attempt leaves the channel exactly as stale as
// it was and a retry is still possible immediately.
test("collectMetrics: a credential-resolution failure does not mark the channel as collected -- the next attempt is still allowed", async () => {
  const { services, channelAccess, lastAutoCollectedAtByChannel, analyticsCalls } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    now: new Date("2026-09-22T13:00:00Z"),
    authResolverError: new Error("Credentials are missing required OAuth scopes"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(() =>
    services.collectMetrics({
      credentialRef: { userId: "user-1" },
      channelId: "UC_A",
      startDate: "2026-09-01",
      endDate: "2026-09-01",
    })
  );
  assert.equal(
    lastAutoCollectedAtByChannel.get("UC_A") ?? null,
    null,
    "a credential failure must not mark the channel as collected"
  );
  assert.equal(analyticsCalls.length, 0, "no real Analytics API call was made");
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
      async queryChannelAnalyticsReport() {
        return [];
      },
    },
    videoStore: {
      async listVideosByChannel() {
        return [{ videoId: "v1", channelId: "UC_A" }];
      },
    },
    metricStore: { async upsertMetric() {}, async listMetricsByChannel() { return []; } },
    channelStore: {
      async getAnalyticsLastAutoCollectedAt() { return null; },
      async markAnalyticsAutoCollected() {},
    },
    settingsStore: {
      async getAnalyticsSyncSettings() { return { localTime: "12:00", timezone: "UTC" }; },
    },
    clock: { now: () => new Date("2026-09-22T15:00:00Z") },
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

test("listMetrics fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () => services.listMetrics({ credentialRef: { userId: "user-1" }, channelId: "UC_A" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("listMetrics returns every previously-collected row for the channel, shaped for display", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-01",
  });
  assert.equal(upsertedRows.length, 1);

  const result = await services.listMetrics({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.equal(result.channelId, "UC_A");
  assert.deepEqual(result.rows, [
    { videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 },
  ]);
});

test("runAutoCollectionIfStale fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () => services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("runAutoCollectionIfStale: never collected before -> runs collection and marks the timestamp", async () => {
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    syncSettings: { localTime: "12:00", timezone: "UTC" },
    now: new Date("2026-09-22T15:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.equal(result.ranCollection, true);
  if (result.ranCollection) {
    assert.equal(result.result.videoCount, 1);
  }
  assert.equal(analyticsCalls.length, 1);
  assert.equal(lastAutoCollectedAtByChannel.get("UC_A")?.getTime(), new Date("2026-09-22T15:00:00Z").getTime());
});

test("runAutoCollectionIfStale: already collected today after the boundary -> no-ops, never calls the Analytics API", async () => {
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    syncSettings: { localTime: "12:00", timezone: "UTC" },
    now: new Date("2026-09-22T15:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  lastAutoCollectedAtByChannel.set("UC_A", new Date("2026-09-22T12:30:00Z")); // today, after the 12:00 boundary

  const result = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.deepEqual(result, { ranCollection: false });
  assert.equal(analyticsCalls.length, 0);
});

// Advisor review: mark-then-run, not run-then-mark, so two near-simultaneous callers (e.g. two
// open browser tabs) never both run a full collection. Simulated here as two sequential calls at
// the same `now` -- the first call's mark must already be visible to the second.
test("runAutoCollectionIfStale: a second call at the same instant sees the first call's mark and no-ops", async () => {
  const { services, channelAccess, analyticsCalls } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    syncSettings: { localTime: "12:00", timezone: "UTC" },
    now: new Date("2026-09-22T15:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const first = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  const second = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.equal(first.ranCollection, true);
  assert.deepEqual(second, { ranCollection: false });
  assert.equal(analyticsCalls.length, 1, "the second call must never trigger a second collection run");
});

// Studio-Parity S6b (docs/roadmap/plans/STUDIO_PARITY_PLAN.md §4) -- getChannelOverview.
test("getChannelOverview fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () =>
      services.getChannelOverview({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getChannelOverview queries the requested period and the immediately-preceding period of the same length", async () => {
  const { services, channelAccess, channelAnalyticsCalls } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    channelAnalyticsResponses: {
      "2026-08-26|2026-09-22": [],
      "2026-07-29|2026-08-25": [],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.getChannelOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
  });

  assert.equal(result.previousStartDate, "2026-07-29");
  assert.equal(result.previousEndDate, "2026-08-25");
  assert.deepEqual(
    channelAnalyticsCalls.map((c) => `${c.startDate}|${c.endDate}`).sort(),
    ["2026-07-29|2026-08-25", "2026-08-26|2026-09-22"]
  );
});

test("getChannelOverview sums daily rows into current/previous totals, treating a day missing from the response as zero", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    channelAnalyticsResponses: {
      "2026-09-01|2026-09-02": [
        { date: "2026-09-01", metrics: { views: 100, estimatedMinutesWatched: 200, subscribersGained: 3, subscribersLost: 1 } },
        // 2026-09-02 is entirely absent from the response (e.g. not yet reported by the API).
      ],
      "2026-08-30|2026-08-31": [
        { date: "2026-08-30", metrics: { views: 10, estimatedMinutesWatched: 20, subscribersGained: 0, subscribersLost: 0 } },
        { date: "2026-08-31", metrics: { views: 15, estimatedMinutesWatched: 25, subscribersGained: 1, subscribersLost: 0 } },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.getChannelOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  });

  assert.deepEqual(result.currentTotals, {
    views: 100,
    estimatedMinutesWatched: 200,
    subscribersGained: 3,
    subscribersLost: 1,
  });
  assert.deepEqual(result.previousTotals, {
    views: 25,
    estimatedMinutesWatched: 45,
    subscribersGained: 1,
    subscribersLost: 0,
  });
  assert.deepEqual(result.daily, [
    { date: "2026-09-01", views: 100, estimatedMinutesWatched: 200, subscribersGained: 3, subscribersLost: 1 },
  ]);
});

test("getChannelOverview zero-fills an interior gap in the daily series but never pads past the last reported date", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    channelAnalyticsResponses: {
      // 2026-09-02 is missing entirely (interior gap); 2026-09-04/09-05 are also missing, but
      // those are trailing days the range asked for that the API simply hasn't reported yet --
      // the result must stop at 09-03, not fabricate zero rows for 09-04/09-05.
      "2026-09-01|2026-09-05": [
        { date: "2026-09-01", metrics: { views: 10, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 } },
        { date: "2026-09-03", metrics: { views: 30, estimatedMinutesWatched: 0, subscribersGained: 0, subscribersLost: 0 } },
      ],
      "2026-08-27|2026-08-31": [],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.getChannelOverview({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });

  assert.deepEqual(
    result.daily.map((row) => row.date),
    ["2026-09-01", "2026-09-02", "2026-09-03"]
  );
  assert.equal(result.daily[1].views, 0, "the interior gap (09-02) must be filled with a real zero row");
});
