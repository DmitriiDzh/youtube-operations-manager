import assert from "node:assert/strict";
import test from "node:test";
import {
  importReachReport,
  markChannelSynced,
  saveCollectedVideoMilestone,
  upsertChannel,
  upsertReportingJob,
  upsertUserOAuthOnSignIn,
  upsertVideos,
} from "@/lib/db";
import { REACH_BASIC_REPORT_TYPE_ID } from "@/lib/reach-reports";
import { createProducerSessionDeps } from "./session-deps";

// BL-166 (docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md AC-VM-07), the real wiring of `producer_upload_milestones` on this test process's
// isolated database: the stored milestone of an upload, its day-7 / day-28 windows (Pacific publish date) and the imported Reach
// over each window, for every connected channel. Lesson of BL-163: a service tested only through fakes can be wired to nothing.
// Every expected value below is computed by hand.

const USER = "user-sd";
const SYNCED = "UC_SD_SYNCED";
const NEVER_SYNCED = "UC_SD_NEVER";

const video = (videoId: string, channelId: string, publishedAt: string) => ({
  videoId,
  channelId,
  title: `Title ${videoId}`,
  description: "",
  publishedAt,
  privacyStatus: "public",
  defaultLanguage: null,
  defaultAudioLanguage: null,
  thumbnails: {},
  existingLocalizations: {},
  etag: null,
  durationSeconds: 7200,
});

test("AC-VM-07 (real wiring): stored milestones, their windows and the Reach of each window, per connected channel", async () => {
  await upsertUserOAuthOnSignIn({ userId: USER, name: "Owner", email: "owner@example.com", image: null, accessToken: null, refreshToken: null, tokenExpiry: null, scope: null });
  for (const channelId of [SYNCED, NEVER_SYNCED]) {
    await upsertChannel({ channelId, title: `Channel ${channelId}`, thumbnailUrl: null, uploadsPlaylistId: `UU${channelId}`, connectedUserId: USER });
  }
  await upsertVideos(
    [
      // 18:00 UTC = 10:00 Pacific on 2026-01-10: windows 01-10..01-16 and 01-10..02-06.
      video("sd-in", SYNCED, "2026-01-10T18:00:00Z"),
      // 2025-12-31 (UTC): before the range.
      video("sd-out", SYNCED, "2025-12-31T23:00:00Z"),
    ],
    new Date("2026-02-20T00:00:00Z")
  );
  await markChannelSynced(SYNCED, new Date("2026-02-20T00:00:00Z"));
  await saveCollectedVideoMilestone({
    videoId: "sd-in",
    milestoneDays: 7,
    channelId: SYNCED,
    windowStart: "2026-01-10",
    windowEnd: "2026-01-16",
    views: 50,
    estimatedMinutesWatched: 120.5,
    averageViewDuration: 144,
    averageViewPercentage: 2,
    retentionJson: "[]",
    at: new Date("2026-01-20T06:00:00Z"),
  });
  await upsertReportingJob({ channelId: SYNCED, reportTypeId: REACH_BASIC_REPORT_TYPE_ID, jobId: "job-sd", jobName: "reach", jobCreatedAt: "2026-01-01T00:00:00Z" });
  await importReachReport({
    channelId: SYNCED,
    reportTypeId: REACH_BASIC_REPORT_TYPE_ID,
    jobId: "job-sd",
    reportId: "rep-sd",
    startTime: "2026-01-10T08:00:00Z",
    endTime: "2026-01-21T08:00:00Z",
    createTime: "2026-01-22T00:00:00Z",
    rows: [
      { date: "2026-01-10", videoId: "sd-in", impressions: 100, ctr: 0.25 },
      { date: "2026-01-12", videoId: "sd-in", impressions: 300, ctr: 0.125 },
      { date: "2026-01-20", videoId: "sd-in", impressions: 1000, ctr: 0.5 },
      // Another video's day: never counted for sd-in.
      { date: "2026-01-11", videoId: "sd-out", impressions: 999, ctr: 0.9 },
    ],
  });

  const deps = createProducerSessionDeps({ tokenId: "producer-token", reverify: async () => {}, noteRecorded: () => {} });
  const result = (await deps.uploadMilestones({ startDate: "2026-01-01", endDate: "2026-01-31" })) as {
    source: string;
    channels: Array<{ channelId: string; reachState: string; uploads: Array<Record<string, unknown> & { milestones: Array<Record<string, unknown>> }> | null }>;
  };
  assert.equal(result.source, "local");
  const synced = result.channels.find((channel) => channel.channelId === SYNCED);
  const never = result.channels.find((channel) => channel.channelId === NEVER_SYNCED);
  assert.ok(synced && never, "both connected channels are listed");
  assert.deepEqual(never, { channelId: NEVER_SYNCED, title: `Channel ${NEVER_SYNCED}`, reachState: "unavailable", uploads: null });
  assert.equal(synced.reachState, "ready");
  assert.equal(synced.uploads?.length, 1);
  const [upload] = synced.uploads!;
  assert.equal(upload.videoId, "sd-in");
  assert.equal(upload.durationSeconds, 7200);
  assert.deepEqual(upload.milestones[0], {
    milestoneDays: 7,
    windowStart: "2026-01-10",
    windowEnd: "2026-01-16",
    status: "collected",
    collectedAt: "2026-01-20T06:00:00.000Z",
    totals: { views: 50, estimatedMinutesWatched: 120.5, averageViewDuration: 144, averageViewPercentage: 2 },
    // 01-10 and 01-12: 400 impressions; clicks 25 + 37.5 = 62.5 -> 62.5 / 400.
    reach: { daysWithData: 2, impressions: 400, ctr: 0.15625 },
  });
  const day28 = upload.milestones[1] as { reach: { daysWithData: number; impressions: number; ctr: number } } & Record<string, unknown>;
  // Long past its due date (02-09) and not collected: due. Its Reach adds 01-20: 1400 impressions, clicks 562.5.
  assert.equal(day28.milestoneDays, 28);
  assert.equal(day28.windowStart, "2026-01-10");
  assert.equal(day28.windowEnd, "2026-02-06");
  assert.equal(day28.status, "due");
  assert.equal(day28.totals, null);
  assert.equal(day28.reach.daysWithData, 3);
  assert.equal(day28.reach.impressions, 1400);
  assert.ok(Math.abs(day28.reach.ctr - 562.5 / 1400) < 1e-12);
});
