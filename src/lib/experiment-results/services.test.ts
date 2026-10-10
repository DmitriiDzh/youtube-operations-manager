import assert from "node:assert/strict";
import test from "node:test";
import { MILESTONE_DAYS, hasFinalPublishDate, isMilestoneDue, milestoneWindow } from "@/lib/analytics";
import { DomainError } from "@/lib/shared-domain";
import { createExperimentResultsServices, sumBreakdownWindow, type ExperimentResultsDependencies } from "./services";

// BL-170 (docs/roadmap/plans/EXPERIMENT_ARMS_PLAN.md §3, AC-EA-06/07). The expected windows, statuses and sums are the plan's table,
// worked out by hand: read at 2026-10-10T18:00:00Z; a milestone window is the Pacific publish date .. +6 / +27; a missing milestone is
// `due` once window end + 3 days has passed, else `not_due`; traffic is summed over each window. The window/due/published rules are the
// analytics module's own (real functions); the stored values come from fakes.

const NOW = new Date("2026-10-10T18:00:00Z");
const EXPERIMENT = {
  experimentId: "E1",
  hypothesisId: "hA",
  status: "running",
  treatment: "Rain intro + loop",
  controlBaseline: "the usual opening",
  successCriteria: "day-7 average view percentage +5 points",
  stoppingCriteria: "4 uploads per arm",
  plannedDuration: null,
};
const link = (videoId: string, linkedVia: "web_ui" | "producer_proposal" = "web_ui") => ({ videoId, linkedAt: "2026-10-01T10:00:00.000Z", linkedBy: "u-owner", linkedVia });

function deps(overrides: Partial<ExperimentResultsDependencies> = {}): ExperimentResultsDependencies {
  return {
    getExperiment: async () => EXPERIMENT,
    listArms: async () => ({ channelId: "UC_A", arms: [{ arm: "control", videos: [link("v1")] }, { arm: "A", videos: [link("v2", "producer_proposal")] }] }),
    listVideos: async () => [
      { videoId: "v1", title: "Rain one", publishedAt: "2026-09-01T12:00:00Z", privacyStatus: "public", liveBroadcastContent: "none", durationSeconds: 7200 },
      { videoId: "v2", title: "Rain two", publishedAt: "2026-10-05T12:00:00Z", privacyStatus: "public", liveBroadcastContent: "none", durationSeconds: 3600 },
    ],
    milestoneDays: MILESTONE_DAYS,
    windowOf: milestoneWindow,
    isDue: (windowEnd) => isMilestoneDue(windowEnd, NOW),
    isPublished: (video) => hasFinalPublishDate({ videoId: "", ...video }),
    listMilestones: async () => [
      {
        videoId: "v1",
        milestoneDays: 7,
        windowStart: "2026-09-01",
        windowEnd: "2026-09-07",
        status: "collected",
        collectedAt: "2026-09-11T08:00:00.000Z",
        totals: { views: 120, estimatedMinutesWatched: 300, averageViewDuration: 150, averageViewPercentage: 41.5 },
      },
    ],
    listBreakdowns: async (_channelId, videoId) =>
      videoId === "v1"
        ? {
            coverage: { from: "2026-09-01", through: "2026-10-08" },
            trafficSources: [
              { day: "2026-09-01", value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 10, estimatedMinutesWatched: 20 },
              { day: "2026-09-08", value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 5, estimatedMinutesWatched: 9 },
            ],
            devices: [],
          }
        : { coverage: null, trafficSources: [], devices: [] },
    readReach: async (_channelId, windows) => ({
      state: "ready",
      windows: windows.map((window) =>
        window.videoId === "v1"
          ? { ...window, daysWithData: 2, impressions: 1500, ctr: 0.04 }
          : { ...window, daysWithData: 0, impressions: null, ctr: null }
      ),
    }),
    ...overrides,
  };
}

const INPUT = { channelId: "UC_A", experimentId: "E1", credentialRef: { userId: "u-owner" } };
const SUBSCRIBER = (views: number, minutes: number) => [{ value: "SUBSCRIBER", label: "Home feed or subscriptions", views, estimatedMinutesWatched: minutes }];
const noReach = { daysWithData: 0, impressions: null, ctr: null };

test("AC-EA-06: each arm's videos with their own stored values per milestone window, as the plan's table says", async () => {
  const result = await createExperimentResultsServices(deps()).getExperimentResults(INPUT);
  assert.deepEqual(result, {
    channelId: "UC_A",
    experiment: EXPERIMENT,
    reachState: "ready",
    reachError: null,
    arms: [
      {
        arm: "control",
        videos: [
          {
            ...link("v1"),
            title: "Rain one",
            publishedAt: "2026-09-01T12:00:00Z",
            durationSeconds: 7200,
            published: true,
            breakdownCoverage: { from: "2026-09-01", through: "2026-10-08" },
            milestones: [
              {
                milestoneDays: 7,
                windowStart: "2026-09-01",
                windowEnd: "2026-09-07",
                status: "collected",
                collectedAt: "2026-09-11T08:00:00.000Z",
                totals: { views: 120, estimatedMinutesWatched: 300, averageViewDuration: 150, averageViewPercentage: 41.5 },
                reach: { daysWithData: 2, impressions: 1500, ctr: 0.04 },
                trafficSources: SUBSCRIBER(10, 20),
                devices: [],
              },
              {
                milestoneDays: 28,
                windowStart: "2026-09-01",
                windowEnd: "2026-09-28",
                status: "due",
                collectedAt: null,
                totals: null,
                reach: { daysWithData: 2, impressions: 1500, ctr: 0.04 },
                trafficSources: SUBSCRIBER(15, 29),
                devices: [],
              },
            ],
          },
        ],
      },
      {
        arm: "A",
        videos: [
          {
            ...link("v2", "producer_proposal"),
            title: "Rain two",
            publishedAt: "2026-10-05T12:00:00Z",
            durationSeconds: 3600,
            published: true,
            breakdownCoverage: null,
            milestones: [
              { milestoneDays: 7, windowStart: "2026-10-05", windowEnd: "2026-10-11", status: "not_due", collectedAt: null, totals: null, reach: noReach, trafficSources: [], devices: [] },
              { milestoneDays: 28, windowStart: "2026-10-05", windowEnd: "2026-11-01", status: "not_due", collectedAt: null, totals: null, reach: noReach, trafficSources: [], devices: [] },
            ],
          },
        ],
      },
    ],
  });
});

test("AC-EA-06: one stored read per video covers its longest window; a scheduled video and one no longer synced have no milestones", async () => {
  const breakdownReads: unknown[] = [];
  const reachWindows: unknown[] = [];
  const result = await createExperimentResultsServices(
    deps({
      listArms: async () => ({ channelId: "UC_A", arms: [{ arm: "A", videos: [link("v1"), link("planned"), link("gone")] }] }),
      listVideos: async () => [
        { videoId: "v1", title: "Rain one", publishedAt: "2026-09-01T12:00:00Z", privacyStatus: "public", liveBroadcastContent: "none", durationSeconds: 7200 },
        { videoId: "planned", title: "Next upload", publishedAt: "2026-10-09T08:00:00Z", privacyStatus: "private", liveBroadcastContent: "none", durationSeconds: null },
      ],
      listBreakdowns: async (...args) => {
        breakdownReads.push(args.slice(1, 4));
        return null;
      },
      readReach: async (_channelId, windows) => {
        reachWindows.push(...windows);
        return { state: "ready", windows: [] };
      },
    })
  ).getExperimentResults(INPUT);
  assert.deepEqual(breakdownReads, [["v1", "2026-09-01", "2026-09-28"]]);
  assert.deepEqual(reachWindows, [
    { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-07" },
    { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-28" },
  ]);
  const [video, planned, gone] = result.arms[0].videos;
  assert.deepEqual([video.published, video.breakdownCoverage, video.milestones[0].trafficSources], [true, null, []]);
  assert.deepEqual([planned.title, planned.published, planned.milestones], ["Next upload", false, []]);
  assert.deepEqual([gone.title, gone.publishedAt, gone.published, gone.milestones], [null, null, false, []]);
});

test("AC-EA-06: a failed Reach read is reported as reachError and the other values are still returned", async () => {
  const result = await createExperimentResultsServices(
    deps({ readReach: async () => Promise.reject(new DomainError({ code: "REACH_NOT_CONFIGURED" as never, message: "no job" })) })
  ).getExperimentResults(INPUT);
  assert.deepEqual([result.reachState, result.reachError], ["unavailable", "REACH_NOT_CONFIGURED"]);
  const day7 = result.arms[0].videos[0].milestones[0];
  assert.deepEqual([day7.status, day7.totals?.views, day7.reach, day7.trafficSources], ["collected", 120, noReach, SUBSCRIBER(10, 20)]);
});

test("AC-EA-07: an experiment of another channel, or of no channel, is EXPERIMENT_NOT_FOUND; the decision engine's own refusals pass through", async () => {
  for (const channelId of ["UC_B", null]) {
    await assert.rejects(
      () => createExperimentResultsServices(deps({ listArms: async () => ({ channelId, arms: [] }) })).getExperimentResults(INPUT),
      (error: unknown) => error instanceof DomainError && error.code === "EXPERIMENT_NOT_FOUND",
      String(channelId)
    );
  }
  await assert.rejects(
    () =>
      createExperimentResultsServices(
        deps({ getExperiment: async () => Promise.reject(new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" })) })
      ).getExperimentResults(INPUT),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
  await assert.rejects(
    () => createExperimentResultsServices(deps()).getExperimentResults({ channelId: "UC_A" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("AC-EA-06: an experiment without videos is returned with empty arms and no reads of the videos' data", async () => {
  let reads = 0;
  const result = await createExperimentResultsServices(
    deps({
      listArms: async () => ({ channelId: "UC_A", arms: [] }),
      listVideos: async () => (reads++, []),
      listMilestones: async () => (reads++, []),
    })
  ).getExperimentResults(INPUT);
  assert.deepEqual(result.arms, []);
  assert.equal(reads, 0);
});

test("sumBreakdownWindow: inside the window only, null only when every row had none, most views first then by value", () => {
  assert.deepEqual(
    sumBreakdownWindow(
      [
        { day: "2026-09-01", value: "TV", label: "TV", views: 2, estimatedMinutesWatched: null },
        { day: "2026-09-02", value: "TV", label: "TV", views: null, estimatedMinutesWatched: 5 },
        { day: "2026-09-02", value: "DESKTOP", label: "Computer", views: 2, estimatedMinutesWatched: 1 },
        { day: "2026-09-03", value: "MOBILE", label: "Phone", views: 9, estimatedMinutesWatched: 9 },
        { day: "2026-08-31", value: "MOBILE", label: "Phone", views: 100, estimatedMinutesWatched: 100 },
      ],
      "2026-09-01",
      "2026-09-02"
    ),
    [
      { value: "DESKTOP", label: "Computer", views: 2, estimatedMinutesWatched: 1 },
      { value: "TV", label: "TV", views: 2, estimatedMinutesWatched: 5 },
    ]
  );
});
