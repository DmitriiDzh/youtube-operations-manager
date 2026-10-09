import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import { initializeDatabaseSchema, listVideoMilestones, recordVideoMilestoneFailure, saveCollectedVideoMilestone, type AppDb } from "@/lib/db";
import { DomainError } from "./contracts";
import { createVideoMilestoneServices, isMilestoneDue, milestoneWindow, planDueMilestones, type MilestoneState } from "./milestones";

// BL-166 (docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md §3, AC-VM-01..06). Expected values worked out by hand from the plan: windows in
// Pacific dates, due 3 days after the window's last day, 2 queries per milestone, at most 25 per run, 3 attempts.

test("AC-VM-01: windows are Pacific calendar dates; a milestone is due 3 days after its window, not a day earlier", () => {
  // 17:00 UTC on 09-01 is 10:00 PDT on 09-01; 03:00 UTC on 09-02 is still 20:00 PDT on 09-01.
  assert.deepEqual(milestoneWindow("2026-09-01T17:00:00Z", 7), { windowStart: "2026-09-01", windowEnd: "2026-09-07" });
  assert.deepEqual(milestoneWindow("2026-09-02T03:00:00Z", 7), { windowStart: "2026-09-01", windowEnd: "2026-09-07" });
  assert.deepEqual(milestoneWindow("2026-09-01T17:00:00Z", 28), { windowStart: "2026-09-01", windowEnd: "2026-09-28" });
  assert.equal(isMilestoneDue("2026-09-07", new Date("2026-09-10T08:00:00Z")), true); // 09-10 01:00 PDT
  assert.equal(isMilestoneDue("2026-09-07", new Date("2026-09-10T06:00:00Z")), false); // still 09-09 23:00 PDT
  assert.equal(isMilestoneDue("2026-09-28", new Date("2026-10-01T08:00:00Z")), true);
  assert.equal(isMilestoneDue("2026-09-28", new Date("2026-09-30T20:00:00Z")), false);
});

test("AC-VM-03: at most 25 per run -- never-attempted first, oldest window first; then retries whose time has come; collected and given-up never", () => {
  const now = new Date("2026-10-09T20:00:00Z"); // 10-09 Pacific
  // 30 videos published 2026-08-01 .. 08-30: each has both milestones due (day-28 of 08-30 ends 09-26, due 09-29).
  const videos = Array.from({ length: 30 }, (_, i) => ({ videoId: `v${String(i + 1).padStart(2, "0")}`, publishedAt: `2026-08-${String(i + 1).padStart(2, "0")}T18:00:00Z` }));
  const plan = planDueMilestones(videos, [], now);
  assert.equal(plan.length, 25);
  // Oldest window end first: v01 day-7 (08-07), v02 day-7 (08-08), ... v21 day-7 (08-27) and v01 day-28 (08-28) ...
  assert.deepEqual(plan.slice(0, 3).map((p) => `${p.videoId}/${p.milestoneDays}`), ["v01/7", "v02/7", "v03/7"]);
  assert.equal(plan.find((p) => p.milestoneDays === 28)?.videoId, "v01");

  const states: MilestoneState[] = [
    { videoId: "a", milestoneDays: 7, status: "collected", nextAttemptAt: null },
    { videoId: "a", milestoneDays: 28, status: "failed", nextAttemptAt: null },
    { videoId: "b", milestoneDays: 7, status: "retry", nextAttemptAt: new Date("2026-10-09T10:00:00Z") }, // due again
    { videoId: "b", milestoneDays: 28, status: "retry", nextAttemptAt: new Date("2026-10-10T10:00:00Z") }, // not yet
  ];
  const two = [
    { videoId: "a", publishedAt: "2026-08-01T18:00:00Z" },
    { videoId: "b", publishedAt: "2026-08-01T18:00:00Z" },
    { videoId: "c", publishedAt: "2026-09-20T18:00:00Z" }, // day-7 due (ends 09-26), day-28 not (ends 10-17)
    { videoId: "d", publishedAt: null },
  ];
  assert.deepEqual(planDueMilestones(two, states, now).map((p) => `${p.videoId}/${p.milestoneDays}`), ["c/7", "b/7"]);
});

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "milestones-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

const NOW = new Date("2026-10-09T20:00:00Z");
const CURVE = [
  { dimensionValues: ["0.02"], metrics: { audienceWatchRatio: 0.9, relativeRetentionPerformance: 0.6, startedWatching: 0.01, stoppedWatching: 0.05, totalSegmentImpressions: 10 } },
  { dimensionValues: ["0.01"], metrics: { audienceWatchRatio: 1.2, relativeRetentionPerformance: 0.7, startedWatching: 0.9, stoppedWatching: 0.1, totalSegmentImpressions: 12 } },
];
const TOTALS = [{ dimensionValues: [], metrics: { views: 340, estimatedMinutesWatched: 1500, averageViewDuration: 264, averageViewPercentage: 7.3 } }];

function setup(db: AppDb, options: { fail?: (videoId: string, dimensions: string | undefined) => Error | null; empty?: boolean } = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const videos = [
    { videoId: "v1", publishedAt: "2026-09-01T17:00:00Z", durationSeconds: 7200 },
    { videoId: "v2", publishedAt: "2026-09-02T17:00:00Z", durationSeconds: 3600 },
  ];
  const services = createVideoMilestoneServices({
    clock: { now: () => NOW },
    authResolver: { resolve: async () => ({ accessToken: "a", refreshToken: "r" }) as never },
    channelAccess: {
      assertActiveChannel: async ({ channelId }) => {
        if (channelId !== "UC_ours") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        return channelId;
      },
    },
    videoStore: { listVideos: async () => videos },
    youtubeApi: {
      queryChannelBreakdownReport: async (args) => {
        const { credentials: _c, ...rest } = args;
        void _c;
        queries.push(rest);
        const videoId = String(args.filters).replace("video==", "");
        const failure = options.fail?.(videoId, args.dimensions);
        if (failure) throw failure;
        if (options.empty) return [];
        return args.dimensions ? CURVE : TOTALS;
      },
    },
    store: {
      list: (channelId, filter) => listVideoMilestones(channelId, filter, db),
      saveCollected: (row) => saveCollectedVideoMilestone(row, db),
      recordFailure: (row) => recordVideoMilestoneFailure(row, db),
    },
  });
  return { services, queries };
}

const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_ours" };

test("AC-VM-02: a due milestone costs 2 queries -- the curve and the window totals -- stored as returned, and is never queried again", async () => {
  const db = await freshDb();
  const { services, queries } = setup(db);
  // v1 (09-01) and v2 (09-02): day-7 and day-28 all due on 10-09 -> 4 milestones, 8 queries.
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 4, collected: 4, failed: 0 });
  assert.equal(queries.length, 8);
  assert.deepEqual(queries[0], {
    channelId: "UC_ours",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    filters: "video==v1",
    dimensions: "elapsedVideoTimeRatio",
    metricNames: ["audienceWatchRatio", "relativeRetentionPerformance", "startedWatching", "stoppedWatching", "totalSegmentImpressions"],
  });
  assert.deepEqual(queries[1], {
    channelId: "UC_ours",
    startDate: "2026-09-01",
    endDate: "2026-09-07",
    filters: "video==v1",
    metricNames: ["views", "estimatedMinutesWatched", "averageViewDuration", "averageViewPercentage"],
  });
  const { milestones } = await services.listVideoMilestones({ channelId: "UC_ours", videoIds: ["v1"], milestone: 7 });
  assert.deepEqual(milestones, [
    {
      videoId: "v1",
      milestoneDays: 7,
      windowStart: "2026-09-01",
      windowEnd: "2026-09-07",
      status: "collected",
      attempts: 1,
      lastError: null,
      collectedAt: NOW.toISOString(),
      durationSeconds: 7200,
      totals: { views: 340, estimatedMinutesWatched: 1500, averageViewDuration: 264, averageViewPercentage: 7.3 },
      retention: [
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.2, relativeRetentionPerformance: 0.7, startedWatching: 0.9, stoppedWatching: 0.1, totalSegmentImpressions: 12 },
        { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.9, relativeRetentionPerformance: 0.6, startedWatching: 0.01, stoppedWatching: 0.05, totalSegmentImpressions: 10 },
      ],
    },
  ]);
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(queries.length, 8);
});

test("AC-VM-04: one video's failure counts an attempt and the others go on; after 3 attempts it is given up; a quota error counts nothing", async () => {
  const db = await freshDb();
  const day = 24 * 60 * 60 * 1000;
  const { services } = setup(db, { fail: (videoId) => (videoId === "v1" ? new Error("HTTP 400 (test)") : null) });
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 4, collected: 2, failed: 2 });
  let v1 = (await listVideoMilestones("UC_ours", { videoIds: ["v1"] }, db)).map((r) => [r.milestoneDays, r.status, r.attempts, r.nextAttemptAt?.toISOString()]);
  assert.deepEqual(v1, [
    [7, "retry", 1, new Date(NOW.getTime() + day).toISOString()],
    [28, "retry", 1, new Date(NOW.getTime() + day).toISOString()],
  ]);
  // Not due again before its retry time (the clock of this fixture is fixed at NOW): nothing to do.
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 0, collected: 0, failed: 0 });

  // Two more failed attempts give up (driven through the store, as later days would).
  for (let attempt = 2; attempt <= 3; attempt++) {
    for (const milestoneDays of [7, 28]) {
      await recordVideoMilestoneFailure(
        { videoId: "v1", milestoneDays, channelId: "UC_ours", windowStart: "2026-09-01", windowEnd: "x", error: "HTTP 400", at: NOW, retryAt: NOW, maxAttempts: 3 },
        db
      );
    }
  }
  v1 = (await listVideoMilestones("UC_ours", { videoIds: ["v1"] }, db)).map((r) => [r.milestoneDays, r.status, r.attempts, r.nextAttemptAt?.toISOString()]);
  assert.deepEqual(v1, [
    [7, "failed", 3, undefined],
    [28, "failed", 3, undefined],
  ]);

  // An exhausted quota stops the run and records no attempt.
  const quotaDb = await freshDb();
  const quota = setup(quotaDb, { fail: () => new DomainError({ code: "youtube_quota_exceeded", message: "quota (test)" }) });
  await assert.rejects(quota.services.collectDueMilestones(RUN), (error: { code?: string }) => error.code === "youtube_quota_exceeded");
  assert.deepEqual(await listVideoMilestones("UC_ours", {}, quotaDb), []);
});

test("AC-VM-05: an empty answer is collected with no curve and null totals, and not queried again", async () => {
  const db = await freshDb();
  const { services, queries } = setup(db, { empty: true });
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 4, collected: 4, failed: 0 });
  const [row] = (await services.listVideoMilestones({ channelId: "UC_ours", videoIds: ["v2"], milestone: 28 })).milestones;
  assert.deepEqual([row.status, row.retention, row.totals], ["collected", [], { views: null, estimatedMinutesWatched: null, averageViewDuration: null, averageViewPercentage: null }]);
  await services.collectDueMilestones(RUN);
  assert.equal(queries.length, 8);
});

test("AC-VM-06: reads are the session channel's own stored milestones; another channel is refused like an inactive one", async () => {
  const db = await freshDb();
  const { services, queries } = setup(db);
  await services.collectDueMilestones(RUN);
  // A row of a video that is not this channel's (stored under its channel id by a bug or a sync) is never returned.
  await saveCollectedVideoMilestone(
    { videoId: "x9", milestoneDays: 7, channelId: "UC_ours", windowStart: "2026-09-01", windowEnd: "2026-09-07", views: 1, estimatedMinutesWatched: 1, averageViewDuration: 1, averageViewPercentage: 1, retentionJson: "[]", at: NOW },
    db
  );
  const listed = await services.listVideoMilestones({ channelId: "UC_ours" });
  assert.deepEqual([...new Set(listed.milestones.map((m) => m.videoId))].sort(), ["v1", "v2"]);
  const queriesBefore = queries.length;
  await assert.rejects(services.listVideoMilestones({ channelId: "UC_other" }), (error: { code?: string }) => error.code === "CHANNEL_NOT_ACTIVE");
  assert.equal(queries.length, queriesBefore, "a read never queries YouTube");
});
