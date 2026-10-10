import assert from "node:assert/strict";
import test from "node:test";
import { MILESTONE_DAYS, hasFinalPublishDate, isMilestoneDue, milestoneWindow } from "@/lib/analytics";
import { listAgentCapabilityDescriptors } from "@/lib/agent-operations/services";
import { DomainError } from "@/lib/shared-domain";
import { createExperimentResultsServices, groupReachWindows, sumBreakdownWindow, type ExperimentResultsDependencies } from "./services";

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
    // Reach as reach-reports computes it per window (its own tests cover the weighting): v1's rows are 09-01 (1000 impressions, CTR 0.05)
    // and 09-02 (500, 0.02), plus -- only inside the 28-day window -- 09-20 (500, 0.08): day 7 = 1500 / 0.04, day 28 = 2000 / 0.05.
    readReach: async (_channelId, windows) => ({
      state: "ready",
      windows: windows.map((window) =>
        window.videoId !== "v1"
          ? { ...window, daysWithData: 0, impressions: null, ctr: null }
          : window.endDate === "2026-09-07"
            ? { ...window, daysWithData: 2, impressions: 1500, ctr: 0.04 }
            : { ...window, daysWithData: 3, impressions: 2000, ctr: 0.05 }
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
                reach: { daysWithData: 3, impressions: 2000, ctr: 0.05 },
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

test("review of BL-170: windows more than 400 days apart are read in separate Reach reads, and a failed read blanks only its own windows", async () => {
  const reads: Array<Array<{ videoId: string; startDate: string; endDate: string }>> = [];
  const result = await createExperimentResultsServices(
    deps({
      listArms: async () => ({ channelId: "UC_A", arms: [{ arm: "control", videos: [link("old")] }, { arm: "A", videos: [link("v1")] }] }),
      listVideos: async () => [
        { videoId: "old", title: "Old", publishedAt: "2025-01-10T12:00:00Z", privacyStatus: "public", liveBroadcastContent: "none", durationSeconds: null },
        { videoId: "v1", title: "Rain one", publishedAt: "2026-09-01T12:00:00Z", privacyStatus: "public", liveBroadcastContent: "none", durationSeconds: 7200 },
      ],
      readReach: async (_channelId, windows) => {
        reads.push(windows);
        if (windows.some((window) => window.videoId === "old")) throw new DomainError({ code: "REACH_NOT_READY" as never, message: "no rows that old" });
        return { state: "ready", windows: windows.map((window) => ({ ...window, daysWithData: 1, impressions: 10, ctr: 0.1 })) };
      },
    })
  ).getExperimentResults(INPUT);
  // 2025-01-10 .. 2026-09-28 is 627 days: two reads, each a single video's windows.
  assert.deepEqual(reads.map((group) => [...new Set(group.map((window) => window.videoId))]), [["old"], ["v1"]]);
  assert.deepEqual([result.reachState, result.reachError], ["ready", "REACH_NOT_READY"]);
  const [oldVideo] = result.arms[0].videos;
  const [newVideo] = result.arms[1].videos;
  assert.deepEqual(oldVideo.milestones.map((m) => m.reach), [noReach, noReach]);
  assert.deepEqual(newVideo.milestones.map((m) => m.reach), [
    { daysWithData: 1, impressions: 10, ctr: 0.1 },
    { daysWithData: 1, impressions: 10, ctr: 0.1 },
  ]);
});

test("groupReachWindows: a group spans at most 400 days from its first start to its last end", () => {
  const w = (videoId: string, startDate: string, endDate: string) => ({ videoId, startDate, endDate });
  // 2026-01-01 .. 2027-02-04 is 400 days inclusive (2026 has 365); 2027-02-05 makes 401.
  assert.deepEqual(groupReachWindows([w("b", "2026-12-01", "2027-02-04"), w("a", "2026-01-01", "2026-01-28")]).map((g) => g.map((x) => x.videoId)), [["a", "b"]]);
  assert.deepEqual(groupReachWindows([w("b", "2026-12-01", "2027-02-05"), w("a", "2026-01-01", "2026-01-28")]).map((g) => g.map((x) => x.videoId)), [["a"], ["b"]]);
  assert.deepEqual(groupReachWindows([]), []);
});

test("review of BL-170: an experiment whose hypothesis has no channel reads like an unknown id, without its hypothesis id", async () => {
  await assert.rejects(
    () =>
      createExperimentResultsServices(
        deps({ listArms: async () => Promise.reject(new DomainError({ code: "HYPOTHESIS_NOT_FOUND", message: "Hypothesis not found", details: { hypothesisId: "h0" } })) })
      ).getExperimentResults(INPUT),
    (error: unknown) => error instanceof DomainError && error.code === "EXPERIMENT_NOT_FOUND" && !JSON.stringify(error.details).includes("h0")
  );
});

test("AC-EA-09: agent_list_asset_performance no longer says experiments are not linked to videos; it points to the results tool", () => {
  const description = listAgentCapabilityDescriptors().find((capability) => capability.id === "asset_performance.list_asset_performance")?.description ?? "";
  assert.ok(description.includes("agent_get_experiment_results"), description);
  assert.ok(!description.includes("not linked to videos"), description);
});
