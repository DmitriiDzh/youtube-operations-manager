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
type FakeVideoDetail = { videoId: string; title: string; publishedAt: string };
type FakeAnalyticsRow = { date: string; metrics: Record<string, number> };

type FakeBreakdownRow = { dimensionValues: string[]; metrics: Record<string, number> };

function createServicesFixture(opts: {
  videosByChannel: Record<string, FakeVideo[]>;
  analyticsResponses: Record<string, FakeAnalyticsRow[] | Error>;
  channelAnalyticsResponses?: Record<string, FakeAnalyticsRow[] | Error>;
  channelBreakdownResponses?: Record<string, FakeBreakdownRow[] | Error>;
  videoDetailsByChannel?: Record<string, FakeVideoDetail[]>;
  syncSettings?: { localTime: string; timezone: string };
  now?: Date;
  authResolverError?: Error;
}) {
  const channelAccess = createFakeChannelAccess();
  const analyticsCalls: Array<{ channelId: string; videoId: string }> = [];
  const channelAnalyticsCalls: Array<{ channelId: string; startDate: string; endDate: string }> = [];
  const channelBreakdownCalls: Array<{ channelId: string; dimensions: string; startDate: string; endDate: string; filters?: string }> = [];
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
    async queryChannelBreakdownReport(args: {
      credentials: ResolvedCredentials;
      channelId: string;
      startDate: string;
      endDate: string;
      dimensions: string;
      metricNames: readonly string[];
      filters?: string;
    }) {
      channelBreakdownCalls.push({
        channelId: args.channelId,
        dimensions: args.dimensions,
        startDate: args.startDate,
        endDate: args.endDate,
        filters: args.filters,
      });
      const response = (opts.channelBreakdownResponses ?? {})[args.dimensions];
      if (response instanceof Error) throw response;
      return response ?? [];
    },
  };

  const videoStore = {
    async listVideosByChannel(channelId: string) {
      return opts.videosByChannel[channelId] ?? [];
    },
    async listVideoDetailsByChannel(channelId: string) {
      return opts.videoDetailsByChannel?.[channelId] ?? [];
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

  const collectionRuns: Array<{
    channelId: string;
    requestedStartDate: string;
    requestedEndDate: string;
    videoCount: number;
    upsertsIssued: number;
    skippedVideoIds: string[];
    ranAt: Date;
  }> = [];
  let currentNow = opts.now ?? new Date("2026-09-22T15:00:00Z");
  const collectionRunStore = {
    async record(args: {
      channelId: string;
      requestedStartDate: string;
      requestedEndDate: string;
      videoCount: number;
      upsertsIssued: number;
      skippedVideoIds: string[];
    }) {
      collectionRuns.push({ ...args, ranAt: currentNow });
    },
    async listByChannel(channelId: string) {
      return collectionRuns.filter((run) => run.channelId === channelId);
    },
  };

  const weeklyReports: Array<{
    channelId: string;
    weekStartDate: string;
    weekEndDate: string;
    status: string;
    reportJson: string;
    generatedAt: Date;
  }> = [];
  const weeklyReportStore = {
    async getByWeek(channelId: string, weekStartDate: string) {
      return weeklyReports.find((r) => r.channelId === channelId && r.weekStartDate === weekStartDate) ?? null;
    },
    async upsert(
      args: { channelId: string; weekStartDate: string; weekEndDate: string; status: string; reportJson: string },
      generatedAt: Date
    ) {
      const index = weeklyReports.findIndex((r) => r.channelId === args.channelId && r.weekStartDate === args.weekStartDate);
      const row = { ...args, generatedAt };
      if (index === -1) weeklyReports.push(row);
      else weeklyReports[index] = row;
    },
    async listByChannel(channelId: string) {
      return weeklyReports
        .filter((r) => r.channelId === channelId)
        .sort((a, b) => (a.weekStartDate < b.weekStartDate ? 1 : -1));
    },
  };

  const clock = { now: () => currentNow };

  const services = createAnalyticsServices({
    authResolver,
    youtubeApi,
    videoStore,
    metricStore,
    channelStore,
    settingsStore,
    collectionRunStore,
    weeklyReportStore,
    clock,
    channelAccess,
    logger,
  });

  return {
    services,
    channelAccess,
    analyticsCalls,
    channelAnalyticsCalls,
    channelBreakdownCalls,
    upsertedRows,
    metricRowsByKey,
    lastAutoCollectedAtByChannel,
    collectionRuns,
    weeklyReports,
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

  // Requests a range covering "yesterday" (2026-09-21, relative to `now` below) -- the canonical
  // date the 2026-09-25 mark-vs-run-history check verifies against, not an arbitrary unrelated
  // date -- so this test continues to exercise the gate the way a real caller (the auto-trigger,
  // or the manual "Collect now" button's own `computeDefaultPeriodRange`) actually would.
  const collect = () =>
    services.collectMetrics({
      credentialRef: { userId: "user-1" },
      channelId: "UC_A",
      startDate: "2026-09-21",
      endDate: "2026-09-21",
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

// The owner's actual live bug (2026-09-25): a real, genuinely successful run set the mark, but its
// own requested window never actually covered "yesterday" (e.g. an old run predating the
// mark-on-success fix, or one that only ever targeted an older range) -- the mark alone must not
// be trusted; the gate must notice no genuine run covers the expected date and retry for real.
test("collectMetrics: a fresh mark backed only by a run that never covered yesterday is treated as stale and retried", async () => {
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel, collectionRuns } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    now: new Date("2026-09-22T13:00:00Z"), // "yesterday" = 2026-09-21
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  lastAutoCollectedAtByChannel.set("UC_A", new Date("2026-09-22T12:30:00Z")); // today, after the boundary
  collectionRuns.push({
    channelId: "UC_A",
    requestedStartDate: "2026-08-01",
    requestedEndDate: "2026-08-07", // a genuine success, but nowhere near yesterday (2026-09-21)
    videoCount: 1,
    upsertsIssued: 1,
    skippedVideoIds: [],
    ranAt: new Date("2026-09-22T12:30:00Z"),
  });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-15",
    endDate: "2026-09-21",
  });

  assert.equal(result.videoCount, 1, "the mark was not trusted -- a real collection ran instead of being refused");
  assert.equal(analyticsCalls.length, 1);
});

// Independent test-suite audit (2026-09-26): the test above only exercises the DATE-RANGE half of
// `genuineRunCoversExpectedDate`'s condition (`run.requestedStartDate <= expectedFreshThroughDate
// && run.requestedEndDate >= expectedFreshThroughDate`) -- its recorded run's date range simply
// never touches yesterday. The OTHER half of that same `&&` -- `(run.videoCount === 0 ||
// run.upsertsIssued > 0)` -- had zero coverage: a run whose date range genuinely covers yesterday
// but was itself a TOTAL FAILURE (attempted real videos, landed zero rows) must be treated
// exactly the same as "no run at all," per the same owner principle this whole gate exists to
// enforce (2026-09-25: a run that touched no real data never "genuinely completed").
test("collectMetrics: a fresh mark backed only by a run that covers yesterday but was a total failure (zero upserts, non-zero videos) is treated as stale and retried", async () => {
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel, collectionRuns } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    now: new Date("2026-09-22T13:00:00Z"), // "yesterday" = 2026-09-21
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  lastAutoCollectedAtByChannel.set("UC_A", new Date("2026-09-22T12:30:00Z")); // today, after the boundary
  collectionRuns.push({
    channelId: "UC_A",
    requestedStartDate: "2026-09-15",
    requestedEndDate: "2026-09-21", // genuinely covers yesterday (2026-09-21) ...
    videoCount: 1, // ... but every one of its videos failed ...
    upsertsIssued: 0, // ... so zero rows actually landed: a total failure, not a genuine success.
    skippedVideoIds: ["v1"],
    ranAt: new Date("2026-09-22T12:30:00Z"),
  });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-15",
    endDate: "2026-09-21",
  });

  assert.equal(result.videoCount, 1, "the mark was not trusted -- a real collection ran instead of being refused");
  assert.equal(analyticsCalls.length, 1);
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

  // The manual call's own requested range ("2026-09-15".."2026-09-21") is deliberately different
  // from the auto-trigger's default 7-day window, but both cover "yesterday" (2026-09-21) -- the
  // gate must still refuse it purely on "a genuine run already covered yesterday for this
  // channel today," regardless of which specific range this particular caller asks for.
  await assert.rejects(
    () =>
      services.collectMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-15",
        endDate: "2026-09-21",
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

  // Independent test-suite audit (2026-09-26): this assertion previously had no predicate at
  // all -- it would pass regardless of what was thrown, or even a wrong error code. Per
  // services.ts, a credential-resolution failure is mapped via `mapUnknownError(error,
  // "unauthorized")`; check that mapping actually happened.
  await assert.rejects(
    () =>
      services.collectMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-01",
        endDate: "2026-09-01",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
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

// Phase 8 follow-up, slice 2 (data-quality diagnostics) -- collectMetrics must record its own
// run, including which videos it skipped, since video_metrics_daily alone can't later
// distinguish "never collected" from "collected, zero activity" (the Analytics API silently
// omits zero-activity days from its response, live-verified 2026-09-23).
test("collectMetrics records a collection run, including skipped videos, even when every video was skipped", async () => {
  const { services, channelAccess, collectionRuns } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: new Error("simulated failure") },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });

  assert.deepEqual(result.skippedVideoIds, ["v1"]);
  assert.equal(collectionRuns.length, 1, "a run must be recorded even when every video in it was skipped");
  assert.equal(collectionRuns[0].channelId, "UC_A");
  assert.equal(collectionRuns[0].requestedStartDate, "2026-09-01");
  assert.equal(collectionRuns[0].requestedEndDate, "2026-09-05");
  assert.deepEqual(collectionRuns[0].skippedVideoIds, ["v1"]);
});

// Regression test for a real bug the project owner hit live (2026-09-25): every video in a
// channel failing (a systemic issue, e.g. a token that resolves but is rejected by the Analytics
// API itself) used to still mark the channel collected-for-today (credentials had resolved, and
// the mark happened before the per-video loop ran), silently locking out the daily auto-trigger
// AND the manual "Collect now" button until tomorrow's boundary -- with zero real data fetched
// and nothing visible anywhere. The channel must stay exactly as stale as before a total-failure
// run, so an immediate retry (once whatever was actually wrong is fixed) can succeed right away.
test("collectMetrics: a run where every video fails does not mark the channel as collected -- an immediate retry is still allowed", async () => {
  const { services, channelAccess, lastAutoCollectedAtByChannel } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: new Error("simulated systemic failure") },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });

  assert.equal(result.upsertsIssued, 0);
  assert.deepEqual(result.skippedVideoIds, ["v1"]);
  assert.equal(
    lastAutoCollectedAtByChannel.get("UC_A") ?? null,
    null,
    "a total-failure run must not mark the channel as collected"
  );

  // An immediate retry (still the same instant/day) must be allowed to actually attempt real
  // work again, not refused as `analytics_data_current`.
  const retry = await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-05",
  });
  assert.deepEqual(retry.skippedVideoIds, ["v1"], "the retry must have actually attempted the real call again, not been refused");
});

test("getDataQualityReport fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () =>
      services.getDataQualityReport({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-01",
        endDate: "2026-09-05",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getDataQualityReport rejects an inverted date range as validation_failed", async () => {
  const { services, channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getDataQualityReport({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-05",
        endDate: "2026-09-01",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getDataQualityReport reflects real collectMetrics runs: covered/uncovered dates and skipped videos", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {
      UC_A: [
        { videoId: "v1", channelId: "UC_A" },
        { videoId: "v2", channelId: "UC_A" },
      ],
    },
    analyticsResponses: {
      v1: [{ date: "2026-09-01", metrics: { views: 10 } }],
      v2: new Error("simulated failure"),
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  });

  const report = await services.getDataQualityReport({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-08-30",
    endDate: "2026-09-02",
  });

  assert.deepEqual(report.coveredDates, ["2026-09-01", "2026-09-02"]);
  assert.deepEqual(report.uncoveredDates, ["2026-08-30", "2026-08-31"]);
  assert.deepEqual(report.videosWithSkips.map((s) => s.videoId), ["v2"]);
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
      async queryChannelBreakdownReport() {
        return [];
      },
    },
    videoStore: {
      async listVideosByChannel() {
        return [{ videoId: "v1", channelId: "UC_A" }];
      },
      async listVideoDetailsByChannel() {
        return [{ videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" }];
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
    collectionRunStore: { async record() {}, async listByChannel() { return []; } },
    weeklyReportStore: { async getByWeek() { return null; }, async upsert() {}, async listByChannel() { return []; } },
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

// MCP/CLI analytics read tools (2026-09-23): optional filters keep a real channel's response
// payload bounded instead of always returning every collected row.
test("listMetrics applies optional startDate/endDate/videoId/metricNames filters", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }, { videoId: "v2", channelId: "UC_A" }] },
    analyticsResponses: {
      v1: [
        { date: "2026-09-01", metrics: { views: 100, likes: 5 } },
        { date: "2026-09-02", metrics: { views: 150, likes: 7 } },
      ],
      v2: [{ date: "2026-09-01", metrics: { views: 20 } }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  await services.collectMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-01",
    endDate: "2026-09-02",
  });

  const byDate = await services.listMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-09-02",
  });
  assert.deepEqual(
    byDate.rows.map((r) => r.metricDate),
    ["2026-09-02", "2026-09-02"]
  );

  const byVideo = await services.listMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    videoId: "v2",
  });
  assert.ok(byVideo.rows.every((r) => r.videoId === "v2"));
  assert.equal(byVideo.rows.length, 1);

  const byMetric = await services.listMetrics({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    metricNames: ["likes"],
  });
  assert.ok(byMetric.rows.every((r) => r.metricName === "likes"));
  assert.equal(byMetric.rows.length, 2);
});

// Found by independent review, 2026-09-23: an inverted or calendar-invalid startDate/endDate
// filter used to silently filter every row out (an empty, misleadingly "successful" result)
// instead of failing with validation_failed, unlike getChannelOverview's identical guard.
test("listMetrics rejects an inverted date-range filter as validation_failed, not an empty success", async () => {
  const { services, channelAccess } = createServicesFixture({
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

  await assert.rejects(
    () =>
      services.listMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-20",
        endDate: "2026-09-01",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("listMetrics rejects a calendar-invalid single date filter (e.g. 2026-02-30)", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.listMetrics({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-02-30",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
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
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel, collectionRuns } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    syncSettings: { localTime: "12:00", timezone: "UTC" },
    now: new Date("2026-09-22T15:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  lastAutoCollectedAtByChannel.set("UC_A", new Date("2026-09-22T12:30:00Z")); // today, after the 12:00 boundary
  // The mark alone is no longer trusted (2026-09-25 fix) -- it must be backed by a genuine run
  // whose window actually covers yesterday ("2026-09-21", the canonical date the boundary
  // promises is ready). Without this, the mark is treated as a stale leftover and the collection
  // would run for real instead of no-oping, per the dedicated "mark disagrees with run history"
  // test below.
  collectionRuns.push({
    channelId: "UC_A",
    requestedStartDate: "2026-09-14",
    requestedEndDate: "2026-09-21",
    videoCount: 1,
    upsertsIssued: 1,
    skippedVideoIds: [],
    ranAt: new Date("2026-09-22T12:30:00Z"),
  });

  const result = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.deepEqual(result, { ranCollection: false });
  assert.equal(analyticsCalls.length, 0);
});

// 2026-09-25 fix: a mark alone is not enough -- if `collectionRunStore` has no genuine run
// covering yesterday (the canonical date the boundary promises is ready), the mark is treated as
// a stale leftover (e.g. from a run predating the mark-on-success fix) rather than trusted
// blindly, and the collection is retried instead of silently staying stuck until tomorrow.
test("runAutoCollectionIfStale: a mark with no backing run history is treated as stale and retried", async () => {
  const { services, channelAccess, analyticsCalls, lastAutoCollectedAtByChannel } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: { v1: [{ date: "2026-09-01", metrics: { views: 100 } }] },
    syncSettings: { localTime: "12:00", timezone: "UTC" },
    now: new Date("2026-09-22T15:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  lastAutoCollectedAtByChannel.set("UC_A", new Date("2026-09-22T12:30:00Z")); // today, after the 12:00 boundary

  const result = await services.runAutoCollectionIfStale({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.equal(result.ranCollection, true);
  assert.equal(analyticsCalls.length, 1);
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

// Found by independent review, 2026-09-23: `isoDateSchema` only checks digit shape, so an
// inverted range (endDate before startDate) reaches `computePreviousPeriod`, which throws a plain
// `Error`, not a `DomainError` -- without this check, `getChannelOverview`'s own catch block would
// map it to a misleading `unauthorized` (401) via its generic fallback, even for a caller whose
// channel access and credentials are perfectly fine. Must be `validation_failed`, and must never
// even reach `assertActiveChannel`/`authResolver.resolve`.
test("getChannelOverview rejects an inverted date range as validation_failed, not unauthorized", async () => {
  const { services, channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getChannelOverview({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-22",
        endDate: "2026-08-26",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// Found by independent review, 2026-09-23: this specific failure path (credential resolution
// rejecting, e.g. a missing/insufficient OAuth scope) was already tested for `collectMetrics` but
// had no equivalent test for the new `getChannelOverview`, despite sharing the same
// `authResolver.resolve` call and the same `mapUnknownError(error, "unauthorized")` fallback.
test("getChannelOverview propagates a credential-resolution failure (e.g. missing OAuth scope) as a DomainError", async () => {
  const { services, channelAccess, channelAnalyticsCalls } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    authResolverError: new Error("Credentials are missing required OAuth scopes"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  // Independent test-suite audit (2026-09-26): checking only `error instanceof DomainError`
  // would not catch a bug that mapped this failure to the wrong error code -- services.ts's own
  // comment above (and the code) say this specific case maps via `mapUnknownError(error,
  // "unauthorized")`, so assert that code explicitly.
  await assert.rejects(
    () =>
      services.getChannelOverview({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
  assert.equal(channelAnalyticsCalls.length, 0, "no real Analytics API call was made once credentials failed to resolve");
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

// Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4/§4.4,
// slices C2/A2/A3/A4/A6) -- getChannelBreakdown. Same guard structure as getChannelOverview above
// (fail-closed channel check, validation_failed on an invalid range, credential-failure
// propagation), plus its own dimension/metric dispatch by `breakdown`.
test("getChannelBreakdown fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () =>
      services.getChannelBreakdown({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
        breakdown: "trafficSources",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getChannelBreakdown rejects an inverted date range as validation_failed, not unauthorized", async () => {
  const { services, channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getChannelBreakdown({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-09-22",
        endDate: "2026-08-26",
        breakdown: "trafficSources",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getChannelBreakdown rejects an unknown breakdown kind as validation_failed", async () => {
  const { services, channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getChannelBreakdown({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
        breakdown: "notARealBreakdown",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getChannelBreakdown propagates a credential-resolution failure (e.g. missing OAuth scope) as a DomainError", async () => {
  const { services, channelAccess, channelBreakdownCalls } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    authResolverError: new Error("Credentials are missing required OAuth scopes"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  // Independent test-suite audit (2026-09-26): checking only `error instanceof DomainError`
  // would not catch a bug that mapped this failure to the wrong error code -- services.ts maps
  // this specific case via `mapUnknownError(error, "unauthorized")`.
  await assert.rejects(
    () =>
      services.getChannelBreakdown({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
        breakdown: "trafficSources",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
  assert.equal(channelBreakdownCalls.length, 0, "no real Analytics API call was made once credentials failed to resolve");
});

test("getChannelBreakdown dispatches the correct dimensions/metrics per breakdown kind and returns real rows", async () => {
  const { services, channelAccess, channelBreakdownCalls } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    channelBreakdownResponses: {
      insightTrafficSourceType: [
        { dimensionValues: ["RELATED_VIDEO"], metrics: { views: 3462 } },
        { dimensionValues: ["YT_SEARCH"], metrics: { views: 90 } },
      ],
      deviceType: [{ dimensionValues: ["DESKTOP"], metrics: { estimatedMinutesWatched: 68501 } }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const traffic = await services.getChannelBreakdown({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
    breakdown: "trafficSources",
  });
  assert.equal(traffic.breakdown, "trafficSources");
  assert.deepEqual(traffic.rows, [
    { dimensionValues: ["RELATED_VIDEO"], metrics: { views: 3462 } },
    { dimensionValues: ["YT_SEARCH"], metrics: { views: 90 } },
  ]);
  assert.equal(channelBreakdownCalls[0]?.dimensions, "insightTrafficSourceType");

  const device = await services.getChannelBreakdown({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
    breakdown: "deviceType",
  });
  assert.equal(device.rows[0]?.metrics.estimatedMinutesWatched, 68501);
  assert.equal(channelBreakdownCalls[1]?.dimensions, "deviceType");
});

// Studio-Parity deep-parity plan (docs/roadmap/plans/ANALYTICS_TAB_DEEP_PARITY_PLAN.md §3.4, Slice
// C4, "Intro" mode) -- getVideoRetentionCurve.
test("getVideoRetentionCurve fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () =>
      services.getVideoRetentionCurve({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoId: "v1",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getVideoRetentionCurve rejects an inverted date range as validation_failed, not unauthorized", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getVideoRetentionCurve({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoId: "v1",
        startDate: "2026-09-22",
        endDate: "2026-08-26",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getVideoRetentionCurve rejects a videoId that does not belong to the channel, without silently returning an empty curve", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getVideoRetentionCurve({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoId: "v-not-on-channel",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getVideoRetentionCurve propagates a credential-resolution failure (e.g. missing OAuth scope) as a DomainError", async () => {
  const { services, channelAccess, channelBreakdownCalls } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
    authResolverError: new Error("Credentials are missing required OAuth scopes"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  // Independent test-suite audit (2026-09-26): checking only `error instanceof DomainError`
  // would not catch a bug that mapped this failure to the wrong error code -- services.ts maps
  // this specific case via `mapUnknownError(error, "unauthorized")`.
  await assert.rejects(
    () =>
      services.getVideoRetentionCurve({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoId: "v1",
        startDate: "2026-08-26",
        endDate: "2026-09-22",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "unauthorized"
  );
  assert.equal(channelBreakdownCalls.length, 0, "no real Analytics API call was made once credentials failed to resolve");
});

// Independent review round 2 (2026-09-26): the original version of this test asserted only
// `dimensions`, never the actual `filters` value passed to the gateway -- a regression that
// dropped or malformed the per-video filter (e.g. silently returning a channel-wide curve) would
// not have been caught despite the test's own name claiming to verify exactly this.
test("getVideoRetentionCurve queries with a video filter and returns points sorted by elapsed ratio", async () => {
  const { services, channelAccess, channelBreakdownCalls } = createServicesFixture({
    videosByChannel: { UC_A: [{ videoId: "v1", channelId: "UC_A" }] },
    analyticsResponses: {},
    channelBreakdownResponses: {
      elapsedVideoTimeRatio: [
        { dimensionValues: ["0.02"], metrics: { audienceWatchRatio: 0.58, relativeRetentionPerformance: 0.42 } },
        { dimensionValues: ["0.01"], metrics: { audienceWatchRatio: 0.97, relativeRetentionPerformance: 0.37 } },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.getVideoRetentionCurve({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    videoId: "v1",
    startDate: "2026-08-26",
    endDate: "2026-09-22",
  });

  assert.deepEqual(
    result.points.map((p) => p.elapsedVideoTimeRatio),
    [0.01, 0.02],
    "points must be sorted ascending by elapsed ratio, regardless of API response order"
  );
  assert.equal(result.points[0].audienceWatchRatio, 0.97);
  assert.equal(channelBreakdownCalls[0]?.dimensions, "elapsedVideoTimeRatio");
  assert.equal(channelBreakdownCalls[0]?.filters, "video==v1", "must scope the query to exactly the requested video, never a channel-wide curve");
});

test("getComparableAgeComparison fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: ["v1", "v2"],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("getComparableAgeComparison rejects a videoId that does not belong to the channel, without dropping it silently", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [
        { videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" },
        { videoId: "v2", title: "Video 2", publishedAt: "2026-09-05T00:00:00Z" },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: ["v1", "v-not-on-channel"],
      }),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "validation_failed" &&
      (error.details as { unknownVideoIds?: string[] })?.unknownVideoIds?.includes("v-not-on-channel") === true
  );
});

test("getComparableAgeComparison aligns each video's own metric rows by days-since-publish and computes an honest cumulative series", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [
        { videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T17:00:00Z" },
        { videoId: "v2", title: "Video 2", publishedAt: "2026-09-10T17:00:00Z" },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  // v1: contiguous days 0-2. v2: day 0 present, day 1 missing (gap), day 2 present -- and an
  // unrelated metric name that must never be folded into the "views" comparison.
  upsertedRows.push(
    { channelId: "UC_A", videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 100 },
    { channelId: "UC_A", videoId: "v1", metricDate: "2026-09-02", metricName: "views", metricValue: 50 },
    { channelId: "UC_A", videoId: "v1", metricDate: "2026-09-03", metricName: "views", metricValue: 20 },
    { channelId: "UC_A", videoId: "v2", metricDate: "2026-09-10", metricName: "views", metricValue: 40 },
    { channelId: "UC_A", videoId: "v2", metricDate: "2026-09-12", metricName: "views", metricValue: 15 },
    { channelId: "UC_A", videoId: "v2", metricDate: "2026-09-10", metricName: "likes", metricValue: 999 }
  );

  const result = await services.getComparableAgeComparison({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    videoIds: ["v1", "v2"],
    metricName: "views",
    maxDays: 30,
  });

  assert.equal(result.metricName, "views");
  assert.equal(result.maxDays, 30);

  const v1 = result.videos.find((v) => v.videoId === "v1")!;
  assert.equal(v1.publishDatePacific, "2026-09-01");
  assert.deepEqual(v1.points, [
    { dayOffset: 0, value: 100 },
    { dayOffset: 1, value: 50 },
    { dayOffset: 2, value: 20 },
  ]);
  assert.deepEqual(v1.cumulativePoints, [
    { dayOffset: 0, cumulativeValue: 100 },
    { dayOffset: 1, cumulativeValue: 150 },
    { dayOffset: 2, cumulativeValue: 170 },
  ]);

  const v2 = result.videos.find((v) => v.videoId === "v2")!;
  assert.deepEqual(v2.points, [
    { dayOffset: 0, value: 40 },
    { dayOffset: 2, value: 15 },
  ]);
  // Day 1 is genuinely unknown (no row, and this slice never infers a zero) -- cumulative stops
  // at day 0, it never skips the gap and keeps summing day 2's real value into it.
  assert.deepEqual(v2.cumulativePoints, [{ dayOffset: 0, cumulativeValue: 40 }]);
});

test("getComparableAgeComparison defaults to metricName 'views' and maxDays 30 when omitted", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [
        { videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" },
        { videoId: "v2", title: "Video 2", publishedAt: "2026-09-05T00:00:00Z" },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  upsertedRows.push({ channelId: "UC_A", videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 5 });

  const result = await services.getComparableAgeComparison({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    videoIds: ["v1", "v2"],
  });

  assert.equal(result.metricName, "views");
  assert.equal(result.maxDays, 30);
});

test("getComparableAgeComparison rejects a non-additive metric name (e.g. averageViewDuration) as validation_failed", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [
        { videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" },
        { videoId: "v2", title: "Video 2", publishedAt: "2026-09-05T00:00:00Z" },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: ["v1", "v2"],
        metricName: "averageViewDuration",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getComparableAgeComparison rejects more than 10 videoIds as validation_failed", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: Array.from({ length: 11 }, (_, i) => ({
        videoId: `v${i}`,
        title: `Video ${i}`,
        publishedAt: "2026-09-01T00:00:00Z",
      })),
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: Array.from({ length: 11 }, (_, i) => `v${i}`),
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("getComparableAgeComparison maps an unparseable publishedAt to validation_failed, not a misleading unauthorized", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [
        { videoId: "v1", title: "Video 1", publishedAt: "not-a-real-timestamp" },
        { videoId: "v2", title: "Video 2", publishedAt: "2026-09-05T00:00:00Z" },
      ],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: ["v1", "v2"],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

// Documents current, accepted behavior (independent review, 2026-09-23): a duplicate videoId is
// not rejected -- it satisfies the >=2 minimum and simply produces two identical series in the
// response. Harmless (never crashes, never double-counts anything since each entry is computed
// independently from the same source rows), just not specially detected -- not worth a dedicated
// validation for this slice.
test("getComparableAgeComparison allows a duplicate videoId, producing two identical series", async () => {
  const { services, channelAccess, upsertedRows } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: {
      UC_A: [{ videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" }],
    },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  upsertedRows.push({ channelId: "UC_A", videoId: "v1", metricDate: "2026-09-01", metricName: "views", metricValue: 5 });

  const result = await services.getComparableAgeComparison({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    videoIds: ["v1", "v1"],
  });

  assert.equal(result.videos.length, 2);
  assert.deepEqual(result.videos[0].points, result.videos[1].points);
});

test("getComparableAgeComparison rejects fewer than 2 videoIds as validation_failed", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: { UC_A: [{ videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" }] },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await assert.rejects(
    () =>
      services.getComparableAgeComparison({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        videoIds: ["v1"],
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("runWeeklyReportIfDue fails closed when the requested channel is not the caller's active channel", async () => {
  const { services } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });

  await assert.rejects(
    () => services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("runWeeklyReportIfDue generates and stores a report for the currently due week", async () => {
  const { services, channelAccess, upsertedRows, weeklyReports } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: { UC_A: [{ videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" }] },
    now: new Date("2026-09-21T13:00:00Z"), // Monday, past the default 12:00 UTC boundary
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  upsertedRows.push({ channelId: "UC_A", videoId: "v1", metricDate: "2026-09-14", metricName: "views", metricValue: 42 });

  const result = await services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });

  assert.equal(result.generated, true);
  if (result.generated) {
    assert.equal(result.report.weekStartDate, "2026-09-14");
    assert.equal(result.report.weekEndDate, "2026-09-20");
    assert.equal(result.report.report.syncedVideoTotals.views, 42);
  }
  assert.equal(weeklyReports.length, 1);
});

test("runWeeklyReportIfDue does not regenerate an already-final report for the same due week", async () => {
  const { services, channelAccess, weeklyReports } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: { UC_A: [] },
    now: new Date("2026-09-21T13:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const first = await services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(first.generated, true);
  // The fixture has no collection runs at all for this week, so the freshly-generated report is
  // "provisional" (uncovered) -- force it to "final" directly, as if it had later been
  // regenerated once data cleared, to isolate this test's own claim (a FINAL report is untouched).
  weeklyReports[0].status = "final";

  const second = await services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(second.generated, false);
  assert.equal(weeklyReports.length, 1);
  assert.equal(weeklyReports[0].status, "final");
});

test("runWeeklyReportIfDue DOES regenerate (replace) an existing provisional report for the same due week", async () => {
  const { services, channelAccess, weeklyReports, upsertedRows } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: { UC_A: [{ videoId: "v1", title: "Video 1", publishedAt: "2026-09-01T00:00:00Z" }] },
    now: new Date("2026-09-21T13:00:00Z"),
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const first = await services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(first.generated, true);
  assert.equal(weeklyReports[0].status, "provisional"); // no collection runs recorded -> uncovered

  upsertedRows.push({ channelId: "UC_A", videoId: "v1", metricDate: "2026-09-14", metricName: "views", metricValue: 99 });
  const second = await services.runWeeklyReportIfDue({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(second.generated, true);
  assert.equal(weeklyReports.length, 1, "must replace the row, never create a second one for the same week");
  if (second.generated) {
    assert.equal(second.report.report.syncedVideoTotals.views, 99);
  }
});

test("listWeeklyReports returns stored reports parsed back from JSON, newest week first", async () => {
  const { services, channelAccess } = createServicesFixture({
    videosByChannel: {},
    analyticsResponses: {},
    videoDetailsByChannel: { UC_A: [] },
  });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  await services.runWeeklyReportIfDue({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
  });

  const result = await services.listWeeklyReports({ credentialRef: { userId: "user-1" }, channelId: "UC_A" });
  assert.equal(result.channelId, "UC_A");
  assert.equal(result.reports.length, 1);
  assert.equal(result.reports[0].report.reportFormatVersion, 1);
});

test("getWeeklyReport returns null when no report exists for that week, without throwing", async () => {
  const { services, channelAccess } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });

  const result = await services.getWeeklyReport({
    credentialRef: { userId: "user-1" },
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
  });
  assert.equal(result.report, null);
});

test("getWeeklyReport rejects a corrupted stored reportJson as validation_failed rather than crashing or serving garbage", async () => {
  const { services, channelAccess, weeklyReports } = createServicesFixture({ videosByChannel: {}, analyticsResponses: {} });
  await channelAccess.activateChannel({ userId: "user-1", channelId: "UC_A" });
  weeklyReports.push({
    channelId: "UC_A",
    weekStartDate: "2026-09-14",
    weekEndDate: "2026-09-20",
    status: "final",
    reportJson: "{not valid json",
    generatedAt: new Date("2026-09-21T12:00:00Z"),
  });

  await assert.rejects(
    () =>
      services.getWeeklyReport({
        credentialRef: { userId: "user-1" },
        channelId: "UC_A",
        weekStartDate: "2026-09-14",
      }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});
