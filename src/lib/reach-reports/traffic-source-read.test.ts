import assert from "node:assert/strict";
import test from "node:test";
import { DomainError } from "./contracts";
import { createReachReportsServices, type ReachReportsDependencies } from "./services";

// BL-181 (owner msg 2702, FO-MSG-0015): the Operator reads the stored `channel_traffic_source_a3` rows. Requirements:
// - a local read; `state` is the traffic-source job's, so an empty answer is never zero traffic;
// - per day and traffic source code the channel's videos are summed, the channel-level / deleted-video remainder ("") included
//   (Google: such rows keep "aggregate metric totals for the parent entity"); a metric no row carried stays null, never 0;
// - labels are Google's names for the codes (dimensions page, read 2026-10-13); an unknown code gets null;
// - each day says which Google file it comes from and how long after the Pacific day ended that file was made;
// - only the caller's active channel. Expected sums are worked out by hand.

const TRAFFIC = "channel_traffic_source_a3";
const IN = { credentialRef: { userId: "u1" }, channelId: "UC_X", startDate: "2026-10-10", endDate: "2026-10-11" };

const ROWS = [
  { date: "2026-10-10", videoId: "vidA", trafficSourceType: 5, views: 12, engagedViews: 12, watchTimeMinutes: 5.5 },
  { date: "2026-10-10", videoId: "vidB", trafficSourceType: 5, views: 3, engagedViews: null, watchTimeMinutes: 1 },
  { date: "2026-10-10", videoId: "", trafficSourceType: 0, views: 2, engagedViews: 2, watchTimeMinutes: 0.5 },
  { date: "2026-10-10", videoId: "vidA", trafficSourceType: 7, views: 4, engagedViews: 4, watchTimeMinutes: 2 },
  { date: "2026-10-10", videoId: "vidB", trafficSourceType: 99, views: 1, engagedViews: 1, watchTimeMinutes: 0.25 },
  { date: "2026-10-11", videoId: "vidA", trafficSourceType: 5, views: 6, engagedViews: 6, watchTimeMinutes: 3 },
];

function setup(opts: { job?: boolean; importedFiles?: number; activeChannelId?: string } = {}) {
  const ranges: Array<{ startDate: string; endDate: string }> = [];
  const deps = {
    authResolver: { resolve: async () => ({ credentialRef: { userId: "u1" }, accessToken: "t", scopeSet: new Set<string>() }) },
    reportingApi: {} as ReachReportsDependencies["reportingApi"],
    store: {
      async getJob(_channelId: string, reportTypeId: string) {
        assert.equal(reportTypeId, TRAFFIC);
        return opts.job === false ? null : { jobId: "job-t", jobCreatedAt: "2026-10-13T10:21:15Z", lastCheckedAt: null };
      },
      async countImportedFiles(_channelId: string, reportTypeId: string) {
        assert.equal(reportTypeId, TRAFFIC);
        return opts.importedFiles ?? 2;
      },
    } as unknown as ReachReportsDependencies["store"],
    trafficSourceStore: {
      async listDaily(_channelId: string, range: { startDate: string; endDate: string }) {
        ranges.push(range);
        return opts.importedFiles === 0 ? [] : ROWS;
      },
      async getCoverage() {
        return { firstDate: "2026-09-13", lastDate: "2026-10-11" };
      },
      async listFiles() {
        return [{ startTime: "2026-10-10T07:00:00Z", endTime: "2026-10-11T07:00:00Z", createTime: "2026-10-12T05:30:00Z" }];
      },
    },
    channelAccess: {
      async assertActiveChannel({ channelId }: { channelId: string }) {
        if (channelId !== (opts.activeChannelId ?? "UC_X")) throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
      },
    } as unknown as ReachReportsDependencies["channelAccess"],
    requiredScope: "scope",
    clock: { now: () => new Date("2026-10-13T12:00:00Z") },
  } satisfies ReachReportsDependencies;
  return { services: createReachReportsServices(deps), ranges };
}

test("the channel's videos are summed per day and code, the remainder included; null metrics are skipped, not counted as 0", async () => {
  const result = await setup().services.getReportingTrafficSources(IN);
  assert.equal(result.state, "ready");
  assert.deepEqual(result.daily, [
    { date: "2026-10-10", trafficSourceType: 0, label: "Direct or unknown", views: 2, engagedViews: 2, watchTimeMinutes: 0.5 },
    // vidA 12 + vidB 3 = 15 views; engaged 12 (vidB has none); 5.5 + 1 = 6.5 minutes.
    { date: "2026-10-10", trafficSourceType: 5, label: "YouTube search", views: 15, engagedViews: 12, watchTimeMinutes: 6.5 },
    { date: "2026-10-10", trafficSourceType: 7, label: "Suggested videos", views: 4, engagedViews: 4, watchTimeMinutes: 2 },
    { date: "2026-10-10", trafficSourceType: 99, label: null, views: 1, engagedViews: 1, watchTimeMinutes: 0.25 },
    { date: "2026-10-11", trafficSourceType: 5, label: "YouTube search", views: 6, engagedViews: 6, watchTimeMinutes: 3 },
  ]);
  // Over the range, most views first: code 5 = 15 + 6 = 21 views, 12 + 6 = 18 engaged, 6.5 + 3 = 9.5 minutes.
  assert.deepEqual(result.totals, [
    { trafficSourceType: 5, label: "YouTube search", views: 21, engagedViews: 18, watchTimeMinutes: 9.5 },
    { trafficSourceType: 7, label: "Suggested videos", views: 4, engagedViews: 4, watchTimeMinutes: 2 },
    { trafficSourceType: 0, label: "Direct or unknown", views: 2, engagedViews: 2, watchTimeMinutes: 0.5 },
    { trafficSourceType: 99, label: null, views: 1, engagedViews: 1, watchTimeMinutes: 0.25 },
  ]);
  // The day 10-10 ended 2026-10-11T07:00Z; Google made its file 2026-10-12T05:30Z -> 22.5 h.
  assert.deepEqual(result.files, [{ date: "2026-10-10", createTime: "2026-10-12T05:30:00Z", lagHours: 22.5 }]);
  assert.deepEqual(result.coverage, { firstDate: "2026-09-13", lastDate: "2026-10-11", importedFiles: 2 });
  assert.equal(result.videoDaily, undefined);
});

test("videoId limits the sums to that video; groupBy video_day returns its stored rows", async () => {
  const result = await setup().services.getReportingTrafficSources({ ...IN, videoId: "vidA", groupBy: "video_day" });
  assert.equal(result.videoId, "vidA");
  assert.deepEqual(result.totals.map((t) => [t.trafficSourceType, t.views, t.watchTimeMinutes]), [
    [5, 18, 8.5],
    [7, 4, 2],
  ]);
  assert.deepEqual(result.videoDaily, [
    { videoId: "vidA", date: "2026-10-10", trafficSourceType: 5, views: 12, engagedViews: 12, watchTimeMinutes: 5.5 },
    { videoId: "vidA", date: "2026-10-10", trafficSourceType: 7, views: 4, engagedViews: 4, watchTimeMinutes: 2 },
    { videoId: "vidA", date: "2026-10-11", trafficSourceType: 5, views: 6, engagedViews: 6, watchTimeMinutes: 3 },
  ]);
  assert.equal(result.videoDailyTruncated, false);
});

test("state says no job / waiting for the first file, so an empty answer is never read as zero traffic", async () => {
  assert.equal((await setup({ job: false, importedFiles: 0 }).services.getReportingTrafficSources(IN)).state, "no_job");
  const waiting = await setup({ importedFiles: 0 }).services.getReportingTrafficSources(IN);
  assert.equal(waiting.state, "waiting_for_first_report");
  assert.deepEqual(waiting.daily, []);
});

test("another channel than the active one is refused; a bad range is refused before any read", async () => {
  const other = setup({ activeChannelId: "UC_OTHER" });
  await assert.rejects(other.services.getReportingTrafficSources(IN), (error: unknown) => error instanceof DomainError);
  assert.equal(other.ranges.length, 0);
  const bad = setup();
  await assert.rejects(bad.services.getReportingTrafficSources({ ...IN, startDate: "2026-10-12", endDate: "2026-10-11" }));
  await assert.rejects(bad.services.getReportingTrafficSources({ ...IN, startDate: "2025-01-01", endDate: "2026-10-11" }));
  assert.equal(bad.ranges.length, 0);
});
