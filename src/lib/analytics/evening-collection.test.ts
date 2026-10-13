import assert from "node:assert/strict";
import test from "node:test";
import { createChannelAccessService } from "@/lib/channel-access";
import { DomainError, type ResolvedCredentials } from "./contracts";
import { createAnalyticsServices } from "./services";

// BL-181 (FO-REQ-0020 §2.3; plan docs/roadmap/plans/REPORTING_BASIC_PLAN.md §2 item 7; owner msg 2687). Requirements:
// - a second daily boundary (default 22:05 local, "" = off, later than the daily boundary);
// - it runs only when there can be something new: the boundary has passed, the channel was not collected since it, and the Analytics
//   API has not yet returned yesterday -- the owner's once-a-day rule ("шлюзы не должны позволять повторный вызовы", collectMetrics)
//   allows no other repeat;
// - it asks only the 3 days ending yesterday, and runs at most once per evening whatever comes back;
// - the exception is not reachable from a tool's input: a manual collectMetrics in the evening is still refused.
// Times: Europe/Helsinki is UTC+3 on 2026-10-13, so 22:05 local = 19:05Z and 12:05 local = 09:05Z. "Yesterday" is 2026-10-12.

const TZ = "Europe/Helsinki";
const USER = { userId: "user-1" };
const INPUT = { credentialRef: USER, channelId: "UC_A" };

type Run = {
  channelId: string;
  requestedStartDate: string;
  requestedEndDate: string;
  videoCount: number;
  upsertsIssued: number;
  skippedVideoIds: string[];
  channelLevel?: boolean;
  newestVideoDate?: string | null;
  newestChannelDate?: string | null;
  ranAt: Date;
};

async function setup(opts: {
  now: string;
  evening?: string;
  morning?: string;
  /** The morning run of 2026-10-13: collected at 09:10Z, the API had videos through this date. */
  morningNewestVideoDate?: string | null;
  rows?: Array<{ date: string; metrics: Record<string, number> }>;
  videos?: string[];
  /** Runs recorded after the morning run (a history catch-up, a manual backfill). */
  laterRuns?: Run[];
  /** The newest metric date stored for the channel, the other computer's rows included. */
  storedNewestMetricDate?: string | null;
  /** When the channel was last collected, if not by the morning run of 2026-10-13. */
  lastCollectedAt?: string;
}) {
  let now = new Date(opts.now);
  const calls: Array<{ videoId: string; startDate: string; endDate: string }> = [];
  const lastCollected = new Map<string, Date>();
  const attempts = new Map<string, Date>();
  const runs: Run[] = [];
  if (opts.morningNewestVideoDate !== undefined) {
    lastCollected.set("UC_A", new Date("2026-10-13T09:10:00Z"));
    runs.push({
      channelId: "UC_A",
      requestedStartDate: "2026-10-05",
      requestedEndDate: "2026-10-12",
      videoCount: 1,
      upsertsIssued: 6,
      skippedVideoIds: [],
      channelLevel: true,
      newestVideoDate: opts.morningNewestVideoDate,
      newestChannelDate: opts.morningNewestVideoDate,
      ranAt: new Date("2026-10-13T09:10:00Z"),
    });
  }
  runs.push(...(opts.laterRuns ?? []));
  if (opts.lastCollectedAt) lastCollected.set("UC_A", new Date(opts.lastCollectedAt));
  const selections = new Map<string, string>([["user-1", "UC_A"]]);
  const channelAccess = createChannelAccessService({
    async getSelectedChannelId(userId: string) {
      return selections.get(userId) ?? null;
    },
    async setSelectedChannelId(userId: string, channelId: string) {
      selections.set(userId, channelId);
    },
  });
  const videos = (opts.videos ?? ["v1"]).map((videoId) => ({ videoId, channelId: "UC_A" }));
  const services = createAnalyticsServices({
    authResolver: {
      async resolve(): Promise<ResolvedCredentials> {
        return { credentialRef: USER, accessToken: "t", refreshToken: "r", scopeSet: new Set(["https://www.googleapis.com/auth/yt-analytics.readonly"]) };
      },
    },
    youtubeApi: {
      async queryVideoAnalyticsReport(args: { videoId: string; startDate: string; endDate: string }) {
        calls.push({ videoId: args.videoId, startDate: args.startDate, endDate: args.endDate });
        return opts.rows ?? [];
      },
      async queryChannelAnalyticsReport() {
        return [];
      },
      async queryChannelBreakdownReport() {
        return [];
      },
    } as never,
    videoStore: {
      async listVideosByChannel() {
        return videos;
      },
      async listVideoDetailsByChannel() {
        return [];
      },
    },
    metricStore: {
      async upsertMetric() {},
      async listMetricsByChannel() {
        return [];
      },
      async getNewestMetricDate() {
        return opts.storedNewestMetricDate ?? null;
      },
    } as never,
    channelStore: {
      async getAnalyticsLastAutoCollectedAt(channelId: string) {
        return lastCollected.get(channelId) ?? null;
      },
      async markAnalyticsAutoCollected(channelId: string, at: Date) {
        lastCollected.set(channelId, at);
      },
      async getChannelPublishedAt() {
        return null;
      },
    },
    settingsStore: {
      async getAnalyticsSyncSettings() {
        return { localTime: opts.morning ?? "12:05", timezone: TZ };
      },
      async getAnalyticsEveningLocalTime() {
        return opts.evening ?? "22:05";
      },
    },
    eveningAttemptStore: {
      async get(channelId: string) {
        return attempts.get(channelId) ?? null;
      },
      async record(channelId: string, at: Date) {
        attempts.set(channelId, at);
      },
    },
    collectionRunStore: {
      async record(args: Omit<Run, "ranAt">) {
        runs.push({ ...args, ranAt: now });
      },
      async listByChannel(channelId: string) {
        return runs.filter((run) => run.channelId === channelId);
      },
    },
    weeklyReportStore: {} as never,
    clock: { now: () => now },
    channelAccess,
    logger: { info() {}, error() {} },
  });
  return {
    services,
    calls,
    attempts,
    lastCollected,
    runs,
    setNow(value: string) {
      now = new Date(value);
    },
  };
}

const ROWS = [
  { date: "2026-10-10", metrics: { views: 5 } },
  { date: "2026-10-11", metrics: { views: 7 } },
];

test("before the evening boundary nothing runs (22:00 local < 22:05)", async () => {
  const { services, calls } = await setup({ now: "2026-10-13T19:00:00Z", morningNewestVideoDate: "2026-10-10" });
  assert.deepEqual(await services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "not_yet" });
  assert.equal(calls.length, 0);
});

test("after the boundary, with yesterday not yet returned, it asks the 3 days ending yesterday despite the morning run", async () => {
  const { services, calls, attempts, lastCollected } = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", rows: ROWS });
  const result = await services.runEveningCollectionIfDue(INPUT);
  assert.equal(result.ranCollection, true);
  assert.deepEqual(calls, [{ videoId: "v1", startDate: "2026-10-10", endDate: "2026-10-12" }]);
  assert.equal(attempts.get("UC_A")?.toISOString(), "2026-10-13T19:10:00.000Z");
  assert.equal(lastCollected.get("UC_A")?.toISOString(), "2026-10-13T19:10:00.000Z");
  if (result.ranCollection) assert.equal(result.result.newestVideoDate, "2026-10-11");
});

test("it runs once per evening: the next check that evening does nothing, even when the run got no rows back", async () => {
  const withRows = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", rows: ROWS });
  await withRows.services.runEveningCollectionIfDue(INPUT);
  withRows.setNow("2026-10-13T19:15:00Z");
  assert.deepEqual(await withRows.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "already_ran" });
  assert.equal(withRows.calls.length, 1);

  // Nothing came back: the channel is not marked collected, but the recorded attempt still stops a repeat every 5 minutes.
  const empty = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", rows: [] });
  await empty.services.runEveningCollectionIfDue(INPUT);
  assert.equal(empty.lastCollected.get("UC_A")?.toISOString(), "2026-10-13T09:10:00.000Z");
  empty.setNow("2026-10-13T19:15:00Z");
  assert.deepEqual(await empty.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "already_ran" });
  assert.equal(empty.calls.length, 1);
});

test("the next evening it is due again", async () => {
  const { services, calls, setNow, lastCollected, runs } = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", rows: ROWS });
  await services.runEveningCollectionIfDue(INPUT);
  // The daily run of 2026-10-14 (12:10 local): the API had videos through 10-11. (Without it the evening would be that day's daily
  // run -- see the test at the end; review finding 3.)
  lastCollected.set("UC_A", new Date("2026-10-14T09:10:00Z"));
  runs.push({ channelId: "UC_A", requestedStartDate: "2026-10-06", requestedEndDate: "2026-10-13", videoCount: 1, upsertsIssued: 6, skippedVideoIds: [], newestVideoDate: "2026-10-11", newestChannelDate: "2026-10-11", ranAt: new Date("2026-10-14T09:10:00Z") });
  setNow("2026-10-14T19:10:00Z");
  const result = await services.runEveningCollectionIfDue(INPUT);
  assert.equal(result.ranCollection, true);
  assert.deepEqual(calls[1], { videoId: "v1", startDate: "2026-10-11", endDate: "2026-10-13" });
});

test("nothing runs when the API already returned yesterday, when the channel was collected after the boundary, or without videos", async () => {
  const current = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-12" });
  assert.deepEqual(await current.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "data_current" });

  const lateDaily = await setup({ now: "2026-10-13T19:40:00Z", morningNewestVideoDate: "2026-10-10" });
  lateDaily.lastCollected.set("UC_A", new Date("2026-10-13T19:30:00Z")); // the dashboard opened at 22:30: the daily run just ran
  assert.deepEqual(await lateDaily.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "already_ran" });

  const noVideos = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: null, videos: [] });
  assert.deepEqual(await noVideos.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "no_videos" });

  for (const fixture of [current, lateDaily, noVideos]) assert.equal(fixture.calls.length, 0);
});

test("off ('') or an evening time not later than the daily boundary never runs", async () => {
  const off = await setup({ now: "2026-10-13T20:00:00Z", evening: "", morningNewestVideoDate: "2026-10-10" });
  assert.deepEqual(await off.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "off" });
  assert.deepEqual(await off.services.getEveningWindow(), { open: false, localDate: null });

  const early = await setup({ now: "2026-10-13T20:00:00Z", evening: "11:00", morning: "12:05", morningNewestVideoDate: "2026-10-10" });
  assert.deepEqual(await early.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "off" });
  assert.equal(off.calls.length + early.calls.length, 0);
});

test("getEveningWindow: open from the boundary on, with today's local date", async () => {
  const before = await setup({ now: "2026-10-13T19:04:00Z" });
  assert.deepEqual(await before.services.getEveningWindow(), { open: false, localDate: "2026-10-13" });
  before.setNow("2026-10-13T19:05:00Z");
  assert.deepEqual(await before.services.getEveningWindow(), { open: true, localDate: "2026-10-13" });
});

test("the exception is not reachable from a tool's input: a manual collection in the evening is still refused, no API call", async () => {
  const { services, calls } = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", rows: ROWS });
  const range = { credentialRef: USER, channelId: "UC_A", startDate: "2026-10-10", endDate: "2026-10-12" };
  await assert.rejects(services.collectMetrics({ ...range, eveningRun: true }), (error: unknown) => error instanceof DomainError);
  await assert.rejects(services.collectMetrics(range), (error: unknown) => error instanceof DomainError && error.code === "analytics_data_current");
  assert.equal(calls.length, 0);
});

test("another channel than the caller's active one is refused before anything else", async () => {
  const { services, calls } = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10" });
  await assert.rejects(services.runEveningCollectionIfDue({ credentialRef: USER, channelId: "UC_OTHER" }), (error: unknown) => error instanceof DomainError);
  assert.equal(calls.length, 0);
});

// Review findings 1, 3 and 4 of the BL-181 independent review.
test("a history catch-up or a manual backfill run after the daily run does not reopen the gate once yesterday came back", async () => {
  const catchUp = { channelId: "UC_A", requestedStartDate: "2020-01-01", requestedEndDate: "2020-12-31", videoCount: 0, upsertsIssued: 12, skippedVideoIds: [], channelLevel: true, newestVideoDate: null, newestChannelDate: "2020-12-31", ranAt: new Date("2026-10-13T09:30:00Z") };
  const backfill = { channelId: "UC_A", requestedStartDate: "2026-08-01", requestedEndDate: "2026-08-31", videoCount: 1, upsertsIssued: 30, skippedVideoIds: [], newestVideoDate: "2026-08-31", newestChannelDate: null, ranAt: new Date("2026-10-13T15:00:00Z") };
  const fixture = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-12", laterRuns: [catchUp, backfill] });
  assert.deepEqual(await fixture.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "data_current" });
  assert.equal(fixture.calls.length, 0);
});

test("yesterday stored from the other computer's collection counts: no evening call here", async () => {
  const fixture = await setup({ now: "2026-10-13T19:10:00Z", morningNewestVideoDate: "2026-10-10", storedNewestMetricDate: "2026-10-12" });
  assert.deepEqual(await fixture.services.runEveningCollectionIfDue(INPUT), { ranCollection: false, reason: "data_current" });
  assert.equal(fixture.calls.length, 0);
});

test("a dashboard open since before the daily boundary: the evening run is today's daily run, with the daily 8-day range", async () => {
  // Last collected yesterday evening; today's 12:05 run never happened (the daily run starts on a page load).
  const fixture = await setup({ now: "2026-10-13T19:10:00Z", lastCollectedAt: "2026-10-12T19:10:00Z", rows: ROWS });
  const result = await fixture.services.runEveningCollectionIfDue(INPUT);
  assert.equal(result.ranCollection, true);
  assert.deepEqual(fixture.calls, [{ videoId: "v1", startDate: "2026-10-05", endDate: "2026-10-12" }]);
  assert.equal(fixture.lastCollected.get("UC_A")?.toISOString(), "2026-10-13T19:10:00.000Z");
});
