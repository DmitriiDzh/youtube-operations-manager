import assert from "node:assert/strict";
import test from "node:test";
import type { StoredUploadMilestone, UploadMilestonesDeps } from "./contracts";
import { createUploadMilestonesServices } from "./upload-milestones";

// Expected values from docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md §2 and AC-VM-07: for each connected channel, its uploads published in
// the range, each with its day-7 and day-28 totals (null where not collected yet) and the Reach of the same window (null without a
// stored Reach day); stored data only. Uploads are picked by UTC date, like producer_portfolio_overview. Every value below is by hand.
// The review of BL-166 added: only published videos are uploads (a private or scheduled video's date is its upload time), and a stored
// row of another window (the video went public later) is not used; a failed Reach read says why.

const RANGE = { startDate: "2026-09-01", endDate: "2026-09-30" };

/** A fixed rule for the test, so every window below can be written down: the publish time's first 10 characters, plus days - 1. */
function windowOf(publishedAt: string, days: number) {
  const windowStart = publishedAt.slice(0, 10);
  const windowEnd = new Date(Date.parse(`${windowStart}T00:00:00Z`) + (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return { windowStart, windowEnd };
}

const video = (videoId: string, publishedAt: string | null, durationSeconds: number | null = 7200, privacyStatus = "public") => ({
  videoId,
  title: `Title ${videoId}`,
  publishedAt,
  privacyStatus,
  liveBroadcastContent: "none",
  durationSeconds,
});

const stored = (
  videoId: string,
  milestoneDays: number,
  window: [string, string],
  status: StoredUploadMilestone["status"],
  values: Partial<StoredUploadMilestone> = {}
): StoredUploadMilestone => ({
  videoId,
  milestoneDays,
  windowStart: window[0],
  windowEnd: window[1],
  status,
  collectedAt: null,
  views: null,
  estimatedMinutesWatched: null,
  averageViewDuration: null,
  averageViewPercentage: null,
  ...values,
});

function fixture() {
  const reachCalls: Array<{ channelId: string; windows: Array<{ videoId: string; startDate: string; endDate: string }> }> = [];
  const storedCalls: Array<[string, string[]]> = [];
  const deps: UploadMilestonesDeps = {
    milestoneDays: [7, 28],
    windowOf,
    // "Today" minus the reporting lag is 2026-10-05 in this test.
    isDue: (windowEnd) => windowEnd <= "2026-10-05",
    isPublished: (candidate) => candidate.privacyStatus === "public" && candidate.liveBroadcastContent !== "upcoming",
    listChannels: async () => [
      { channelId: "UC_T", title: "Tropico Jazz" },
      { channelId: "UC_J", title: "Rural Japan Music" },
      { channelId: "UC_W", title: "Waiting Channel" },
      { channelId: "UC_E", title: "Reach Error Channel" },
    ],
    async listVideos(channelId) {
      if (channelId === "UC_T") {
        return [
          video("v3", "2026-09-30T23:59:00Z"),
          video("v1", "2026-09-01T10:00:00Z", 7260),
          video("v2", "2026-08-31T23:30:00Z"),
          video("v4", "2026-09-05T08:00:00Z", null),
          video("v5", null),
          video("v6", "not a date"),
          // Scheduled: still private, its date is the upload time.
          video("v7", "2026-09-15T08:00:00Z", 7200, "private"),
          { ...video("v8", "2026-09-16T08:00:00Z"), liveBroadcastContent: "upcoming" },
        ];
      }
      if (channelId === "UC_W") return [video("w1", "2026-08-15T00:00:00Z")];
      if (channelId === "UC_E") return [video("e1", "2026-09-10T12:00:00Z")];
      return null;
    },
    async listStoredMilestones(channelId, videoIds) {
      storedCalls.push([channelId, videoIds]);
      if (channelId === "UC_T") {
        return [
          stored("v1", 7, ["2026-09-01", "2026-09-07"], "collected", {
            collectedAt: new Date("2026-09-11T06:00:00Z"),
            views: 120,
            estimatedMinutesWatched: 300.5,
            averageViewDuration: 150,
            averageViewPercentage: 42.5,
          }),
          stored("v4", 7, ["2026-09-05", "2026-09-11"], "retry"),
          stored("v4", 28, ["2026-09-05", "2026-10-02"], "failed"),
          // Collected for a window v3 no longer has: not used.
          stored("v3", 7, ["2026-09-28", "2026-10-04"], "collected", { views: 5555 }),
          // Outside the range: never listed.
          stored("v2", 7, ["2026-08-31", "2026-09-06"], "collected", { views: 9999 }),
        ];
      }
      if (channelId === "UC_E") {
        return [stored("e1", 7, ["2026-09-10", "2026-09-16"], "collected", { collectedAt: new Date("2026-09-20T06:00:00Z"), views: 0, estimatedMinutesWatched: 0 })];
      }
      return [];
    },
    async readReach(channelId, windows) {
      reachCalls.push({ channelId, windows });
      if (channelId === "UC_E") throw Object.assign(new Error("not active (test)"), { code: "CHANNEL_NOT_ACTIVE" });
      if (channelId === "UC_W") return { state: "waiting_for_first_report", windows: [] };
      return {
        state: "ready",
        windows: [
          { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-07", daysWithData: 2, impressions: 400, ctr: 0.15625 },
          { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-28", daysWithData: 10, impressions: 900, ctr: 0.1 },
          { videoId: "v3", startDate: "2026-09-30", endDate: "2026-10-06", daysWithData: 0, impressions: 0, ctr: null },
        ],
      };
    },
  };
  return { services: createUploadMilestonesServices(deps), reachCalls, storedCalls };
}

const NO_REACH = { daysWithData: 0, impressions: null, ctr: null };

test("AC-VM-07: each channel's uploads in the range with their day-7 and day-28 milestones and the Reach of each window", async () => {
  const { services, reachCalls, storedCalls } = fixture();
  const result = await services.getUploadMilestones(RANGE);
  assert.equal(result.source, "local");
  assert.equal(result.startDate, "2026-09-01");
  assert.equal(result.endDate, "2026-09-30");
  assert.deepEqual(
    result.channels.map((channel) => channel.channelId),
    ["UC_T", "UC_J", "UC_W", "UC_E"]
  );

  const tropico = result.channels[0];
  assert.equal(tropico.reachState, "ready");
  assert.equal(tropico.reachError, null);
  // v2 (08-31 UTC), v5 (no date), v6 (unreadable), v7 (scheduled) and v8 (upcoming premiere) are out; the rest oldest first: v1 09-01,
  // v4 09-05, v3 09-30 23:59 UTC.
  assert.deepEqual(tropico.uploads, [
    {
      videoId: "v1",
      title: "Title v1",
      publishedAt: "2026-09-01T10:00:00Z",
      durationSeconds: 7260,
      milestones: [
        {
          milestoneDays: 7,
          windowStart: "2026-09-01",
          windowEnd: "2026-09-07",
          status: "collected",
          collectedAt: "2026-09-11T06:00:00.000Z",
          totals: { views: 120, estimatedMinutesWatched: 300.5, averageViewDuration: 150, averageViewPercentage: 42.5 },
          reach: { daysWithData: 2, impressions: 400, ctr: 0.15625 },
        },
        // Due (09-28 <= 10-05) but not collected yet.
        { milestoneDays: 28, windowStart: "2026-09-01", windowEnd: "2026-09-28", status: "due", collectedAt: null, totals: null, reach: { daysWithData: 10, impressions: 900, ctr: 0.1 } },
      ],
    },
    {
      videoId: "v4",
      title: "Title v4",
      publishedAt: "2026-09-05T08:00:00Z",
      durationSeconds: null,
      milestones: [
        { milestoneDays: 7, windowStart: "2026-09-05", windowEnd: "2026-09-11", status: "retry", collectedAt: null, totals: null, reach: NO_REACH },
        { milestoneDays: 28, windowStart: "2026-09-05", windowEnd: "2026-10-02", status: "failed", collectedAt: null, totals: null, reach: NO_REACH },
      ],
    },
    {
      videoId: "v3",
      title: "Title v3",
      publishedAt: "2026-09-30T23:59:00Z",
      durationSeconds: 7200,
      milestones: [
        // 10-06 and 10-27 are after 10-05: not due (the row of another window is ignored). A Reach window with 0 days is null, never 0.
        { milestoneDays: 7, windowStart: "2026-09-30", windowEnd: "2026-10-06", status: "not_due", collectedAt: null, totals: null, reach: NO_REACH },
        { milestoneDays: 28, windowStart: "2026-09-30", windowEnd: "2026-10-27", status: "not_due", collectedAt: null, totals: null, reach: NO_REACH },
      ],
    },
  ]);

  // Never synced here: no uploads to list, and no read at all.
  assert.deepEqual(result.channels[1], { channelId: "UC_J", title: "Rural Japan Music", reachState: "unavailable", reachError: null, uploads: null });
  // Synced, nothing published in the range: an empty list, and Reach's own state still reported.
  assert.deepEqual(result.channels[2], { channelId: "UC_W", title: "Waiting Channel", reachState: "waiting_for_first_report", reachError: null, uploads: [] });
  // Reach could not be read: the stored totals are still there, every Reach figure null, and the reason is given.
  assert.deepEqual(result.channels[3], {
    channelId: "UC_E",
    title: "Reach Error Channel",
    reachState: "unavailable",
    reachError: "CHANNEL_NOT_ACTIVE",
    uploads: [
      {
        videoId: "e1",
        title: "Title e1",
        publishedAt: "2026-09-10T12:00:00Z",
        durationSeconds: 7200,
        milestones: [
          // A stored 0 is YouTube's answer, kept as 0 (not turned into null).
          {
            milestoneDays: 7,
            windowStart: "2026-09-10",
            windowEnd: "2026-09-16",
            status: "collected",
            collectedAt: "2026-09-20T06:00:00.000Z",
            totals: { views: 0, estimatedMinutesWatched: 0, averageViewDuration: null, averageViewPercentage: null },
            reach: NO_REACH,
          },
          { milestoneDays: 28, windowStart: "2026-09-10", windowEnd: "2026-10-07", status: "not_due", collectedAt: null, totals: null, reach: NO_REACH },
        ],
      },
    ],
  });

  // One Reach read per synced channel, with each upload's two windows in upload order.
  assert.deepEqual(reachCalls, [
    {
      channelId: "UC_T",
      windows: [
        { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-07" },
        { videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-28" },
        { videoId: "v4", startDate: "2026-09-05", endDate: "2026-09-11" },
        { videoId: "v4", startDate: "2026-09-05", endDate: "2026-10-02" },
        { videoId: "v3", startDate: "2026-09-30", endDate: "2026-10-06" },
        { videoId: "v3", startDate: "2026-09-30", endDate: "2026-10-27" },
      ],
    },
    { channelId: "UC_W", windows: [] },
    {
      channelId: "UC_E",
      windows: [
        { videoId: "e1", startDate: "2026-09-10", endDate: "2026-09-16" },
        { videoId: "e1", startDate: "2026-09-10", endDate: "2026-10-07" },
      ],
    },
  ]);
  // Stored milestones are read only for a channel with an upload in the range, and only for those uploads.
  assert.deepEqual(
    storedCalls.sort((a, b) => a[0].localeCompare(b[0])),
    [
      ["UC_E", ["e1"]],
      ["UC_T", ["v1", "v4", "v3"]],
    ]
  );
});

test("Reach rows of a window are only used when Reach is ready", async () => {
  const deps: UploadMilestonesDeps = {
    milestoneDays: [7],
    windowOf,
    isDue: () => true,
    isPublished: () => true,
    listChannels: async () => [{ channelId: "UC_T", title: "T" }],
    listVideos: async () => [video("v1", "2026-09-01T10:00:00Z")],
    listStoredMilestones: async () => [],
    // An inconsistent answer (rows while no job exists) must not be shown as data.
    readReach: async () => ({ state: "no_job", windows: [{ videoId: "v1", startDate: "2026-09-01", endDate: "2026-09-07", daysWithData: 3, impressions: 10, ctr: 0.5 }] }),
  };
  const result = await createUploadMilestonesServices(deps).getUploadMilestones(RANGE);
  assert.equal(result.channels[0].reachState, "no_job");
  assert.deepEqual(result.channels[0].uploads?.[0].milestones[0].reach, NO_REACH);
  assert.equal(result.channels[0].uploads?.[0].milestones[0].status, "due");
});
