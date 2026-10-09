import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deferVideoMilestone,
  initializeDatabaseSchema,
  listVideoMilestoneStates,
  listVideoMilestones,
  recordVideoMilestoneFailure,
  saveCollectedVideoMilestone,
  SCHEMA_MIGRATIONS,
  type AppDb,
} from "@/lib/db";
import { DomainError } from "./contracts";
import {
  createVideoMilestoneServices,
  gateMilestoneCollection,
  isMilestoneDue,
  milestoneWindow,
  planDueMilestones,
  type MilestoneState,
  type MilestoneVideo,
} from "./milestones";

// BL-166 (docs/roadmap/plans/VIDEO_MILESTONES_PLAN.md §3, AC-VM-01..06). Expected values worked out by hand from the plan: windows in
// Pacific dates, due 3 days after the window's last day, 2 queries per milestone, at most 25 per run, 3 attempts.
//
// The independent review of BL-166 changed two requirements, so the tests below changed with them:
// - Only a public video that is not an upcoming premiere or stream has a real publish date (YouTube gives the owner the upload time as
//   `publishedAt` while a video is private or scheduled). Other videos are not planned, and a stored milestone whose window no longer
//   matches the publish date is collected again (attempts start again at 1) and is not returned until then.
// - Only an error about the query itself counts an attempt (HTTP 400, 404, or a 403 that is not about permissions, the project or the
//   rate). Reads off, quota, sign-in, 401 and a system 403 stop the run with nothing recorded; no HTTP answer, 429 and 5xx stop it too
//   but put that milestone back by a day without an attempt (second review: otherwise one video that keeps getting a 5xx would head the
//   queue forever). The previous AC-VM-04 test failed a video with a plain Error (no HTTP status), which is now such a deferral, so it
//   uses a Google-shaped 400.

/** A public, already published video (the only kind that has milestones). */
const published = (videoId: string, publishedAt: string | null): MilestoneVideo => ({ videoId, publishedAt, privacyStatus: "public", liveBroadcastContent: "none" });

/** An error shaped like the ones the Google client throws (`response.status`, `response.data.error.errors[].reason`). */
function googleError(status: number, reason: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${reason} (test)`), { response: { status, data: { error: { errors: [{ reason }] } } } });
}

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
  const videos = Array.from({ length: 30 }, (_, i) => published(`v${String(i + 1).padStart(2, "0")}`, `2026-08-${String(i + 1).padStart(2, "0")}T18:00:00Z`));
  const plan = planDueMilestones(videos, [], now);
  assert.equal(plan.length, 25);
  // Oldest window end first: v01 day-7 (08-07), v02 day-7 (08-08), ... v21 day-7 (08-27) and v01 day-28 (08-28) ...
  assert.deepEqual(plan.slice(0, 3).map((p) => `${p.videoId}/${p.milestoneDays}`), ["v01/7", "v02/7", "v03/7"]);
  assert.equal(plan.find((p) => p.milestoneDays === 28)?.videoId, "v01");

  // Windows of a video published 08-01 (Pacific): day 7 = 08-01..08-07, day 28 = 08-01..08-28.
  const w7 = { windowStart: "2026-08-01", windowEnd: "2026-08-07" };
  const w28 = { windowStart: "2026-08-01", windowEnd: "2026-08-28" };
  const states: MilestoneState[] = [
    { videoId: "a", milestoneDays: 7, ...w7, status: "collected", nextAttemptAt: null },
    { videoId: "a", milestoneDays: 28, ...w28, status: "failed", nextAttemptAt: null },
    { videoId: "b", milestoneDays: 7, ...w7, status: "retry", nextAttemptAt: new Date("2026-10-09T10:00:00Z") }, // due again
    { videoId: "b", milestoneDays: 28, ...w28, status: "retry", nextAttemptAt: new Date("2026-10-10T10:00:00Z") }, // not yet
    // g was collected for 09-01..09-07 while scheduled; it went public on 09-20, so that row is another window.
    { videoId: "g", milestoneDays: 7, windowStart: "2026-09-01", windowEnd: "2026-09-07", status: "collected", nextAttemptAt: null },
  ];
  const mixed: MilestoneVideo[] = [
    published("a", "2026-08-01T18:00:00Z"),
    published("b", "2026-08-01T18:00:00Z"),
    published("c", "2026-09-20T18:00:00Z"), // day-7 due (ends 09-26), day-28 not (ends 10-17)
    published("d", null),
    { ...published("e", "2026-08-01T18:00:00Z"), privacyStatus: "private" }, // scheduled: its date is the upload time
    { ...published("f", "2026-08-01T18:00:00Z"), privacyStatus: "unlisted" },
    { ...published("h", "2026-08-01T18:00:00Z"), liveBroadcastContent: "upcoming" }, // a premiere not started yet
    { ...published("i", "2026-08-01T18:00:00Z"), privacyStatus: null }, // never synced with a privacy status
    published("g", "2026-09-20T18:00:00Z"),
  ];
  // Fresh by window end (c and g both end 09-26, then by id), then the retry whose time has come.
  assert.deepEqual(planDueMilestones(mixed, states, now).map((p) => `${p.videoId}/${p.milestoneDays}`), ["c/7", "g/7", "b/7"]);
});

let lastClient: ReturnType<typeof createLibsqlClient> | null = null;

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "milestones-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  lastClient = client;
  return drizzle(client) as unknown as AppDb;
}

const NOW = new Date("2026-10-09T20:00:00Z");
const CURVE = [
  { dimensionValues: ["0.02"], metrics: { audienceWatchRatio: 0.9, relativeRetentionPerformance: 0.6 } },
  { dimensionValues: ["0.01"], metrics: { audienceWatchRatio: 1.2, relativeRetentionPerformance: 0.7 } },
];
const TOTALS = [{ dimensionValues: [], metrics: { views: 340, estimatedMinutesWatched: 1500, averageViewDuration: 264, averageViewPercentage: 7.3 } }];

function setup(
  db: AppDb,
  options: { fail?: (videoId: string, dimensions: string | undefined) => Error | null; empty?: boolean; totals?: typeof TOTALS } = {}
) {
  const queries: Array<Record<string, unknown>> = [];
  const clock = { now: NOW };
  const videos: Array<MilestoneVideo & { durationSeconds: number | null }> = [
    { ...published("v1", "2026-09-01T17:00:00Z"), durationSeconds: 7200 },
    { ...published("v2", "2026-09-02T17:00:00Z"), durationSeconds: 3600 },
  ];
  const services = createVideoMilestoneServices({
    clock: { now: () => clock.now },
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
        return args.dimensions ? CURVE : (options.totals ?? TOTALS);
      },
    },
    store: {
      list: (channelId, filter) => listVideoMilestones(channelId, filter, db),
      listStates: (channelId) => listVideoMilestoneStates(channelId, db),
      saveCollected: (row) => saveCollectedVideoMilestone(row, db),
      recordFailure: (row) => recordVideoMilestoneFailure(row, db),
      defer: (row) => deferVideoMilestone(row, db),
    },
  });
  return { services, queries, clock, videos };
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
    // BL-166 fix (2026-10-10, checked live): the five-metric query gets no rows from YouTube; the curve is these two metrics.
    metricNames: ["audienceWatchRatio", "relativeRetentionPerformance"],
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
        { elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1.2, relativeRetentionPerformance: 0.7 },
        { elapsedVideoTimeRatio: 0.02, audienceWatchRatio: 0.9, relativeRetentionPerformance: 0.6 },
      ],
    },
  ]);
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(queries.length, 8);
});

test("AC-VM-04: one video's failure counts an attempt and the others go on; it is retried a day later and given up after 3 attempts", async () => {
  const db = await freshDb();
  const day = 24 * 60 * 60 * 1000;
  const { services, clock, queries } = setup(db, { fail: (videoId) => (videoId === "v1" ? googleError(400, "badRequest") : null) });
  const v1State = async () =>
    (await listVideoMilestones("UC_ours", { videoIds: ["v1"] }, db)).map((r) => [r.milestoneDays, r.status, r.attempts, r.nextAttemptAt?.toISOString() ?? null]);
  // Run 1 (10-09): v1's two milestones fail, v2's two are collected.
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 4, collected: 2, failed: 2 });
  assert.deepEqual(await v1State(), [
    [7, "retry", 1, new Date(NOW.getTime() + day).toISOString()],
    [28, "retry", 1, new Date(NOW.getTime() + day).toISOString()],
  ]);
  // Before its retry time: nothing to do.
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 0, collected: 0, failed: 0 });
  // Run 2, a day later: attempt 2, retried again a day after that.
  clock.now = new Date(NOW.getTime() + day);
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 2, collected: 0, failed: 2 });
  assert.deepEqual(await v1State(), [
    [7, "retry", 2, new Date(NOW.getTime() + 2 * day).toISOString()],
    [28, "retry", 2, new Date(NOW.getTime() + 2 * day).toISOString()],
  ]);
  // Run 3: attempt 3 gives up; after that it is never queried again.
  clock.now = new Date(NOW.getTime() + 2 * day);
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 2, collected: 0, failed: 2 });
  assert.deepEqual(await v1State(), [
    [7, "failed", 3, null],
    [28, "failed", 3, null],
  ]);
  const queriesBefore = queries.length;
  clock.now = new Date(NOW.getTime() + 30 * day);
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(queries.length, queriesBefore);
});

test("AC-VM-04: a 404 or a video's own 403 counts an attempt; reads off, quota, 401 and a system 403 stop the run, recording nothing", async () => {
  for (const error of [googleError(404, "notFound"), googleError(403, "forbidden")]) {
    const db = await freshDb();
    const { services } = setup(db, { fail: () => error });
    assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 4, collected: 0, failed: 4 }, error.message);
  }
  const stops: Error[] = [
    new DomainError({ code: "analytics_reads_disabled", message: "reads off (test)" }),
    new DomainError({ code: "youtube_quota_exceeded", message: "quota (test)" }),
    googleError(401, "authError"),
    googleError(403, "insufficientPermissions"),
  ];
  for (const error of stops) {
    const db = await freshDb();
    const { services, queries } = setup(db, { fail: () => error });
    await assert.rejects(services.collectDueMilestones(RUN), (thrown: unknown) => thrown === error, error.message);
    // The first query failed and the run stopped there: no other video was tried, and nothing is stored.
    assert.equal(queries.length, 1, error.message);
    assert.deepEqual(await listVideoMilestones("UC_ours", {}, db), [], error.message);
  }
});

test("AC-VM-04: no HTTP answer, 429 or 5xx stop the run and put that milestone back a day, counting no attempt", async () => {
  const day = 24 * 60 * 60 * 1000;
  const deferrals: Error[] = [
    Object.assign(new Error("getaddrinfo ENOTFOUND youtubeanalytics.googleapis.com (test)"), { code: "ENOTFOUND" }),
    googleError(429, "rateLimitExceeded"),
    googleError(503, "backendError"),
  ];
  for (const error of deferrals) {
    const db = await freshDb();
    const { services, queries } = setup(db, { fail: () => error });
    await assert.rejects(services.collectDueMilestones(RUN), (thrown: unknown) => thrown === error, error.message);
    assert.equal(queries.length, 1, error.message);
    // The first planned milestone (v1 day 7, window end 09-07) is put back until NOW + 1 day; nothing else is touched.
    assert.deepEqual(
      (await listVideoMilestones("UC_ours", {}, db)).map((r) => [r.videoId, r.milestoneDays, r.status, r.attempts, r.nextAttemptAt?.toISOString(), r.lastError]),
      [["v1", 7, "retry", 0, new Date(NOW.getTime() + day).toISOString(), error.message]],
      error.message
    );
  }
});

test("second review of BL-166: a video that keeps getting a 500 does not hold the channel's queue", async () => {
  const db = await freshDb();
  const { services } = setup(db, { fail: (videoId) => (videoId === "v1" ? googleError(500, "internalError") : null) });
  // Plan on 10-09, oldest window end first: v1/7 (09-07), v2/7 (09-08), v1/28 (09-28), v2/28 (09-29).
  // Run 1: v1/7 gets a 500 -> put back, run stops.
  await assert.rejects(services.collectDueMilestones(RUN));
  // Run 2: v2/7 collected, then v1/28 gets a 500 -> put back, run stops.
  await assert.rejects(services.collectDueMilestones(RUN));
  // Run 3: only v2/28 is left before the put-back ones are due again.
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 1, collected: 1, failed: 0 });
  assert.deepEqual(
    (await listVideoMilestones("UC_ours", {}, db)).map((r) => [r.videoId, r.milestoneDays, r.status, r.attempts]),
    [
      ["v1", 7, "retry", 0],
      ["v1", 28, "retry", 0],
      ["v2", 7, "collected", 1],
      ["v2", 28, "collected", 1],
    ]
  );
});

test("AC-VM-04: while the quota reserve holds background reads back, nothing is queried", async () => {
  const db = await freshDb();
  const { services, queries } = setup(db);
  const held = gateMilestoneCollection({ isBackgroundReadAllowed: async () => false }, services.collectDueMilestones);
  assert.deepEqual(await held(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(queries.length, 0);
  const allowed = gateMilestoneCollection({ isBackgroundReadAllowed: async () => true }, services.collectDueMilestones);
  assert.deepEqual(await allowed(RUN), { attempted: 4, collected: 4, failed: 0 });
});

test("review of BL-166: a video only gets milestones once public; a moved publish date is collected again and the old row is not returned", async () => {
  const db = await freshDb();
  const { services, videos, queries } = setup(db);
  // v1 is still scheduled (private, publishedAt = its upload time): only v2's two milestones are collected.
  videos[0] = { ...videos[0], privacyStatus: "private" };
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 2, collected: 2, failed: 0 });
  assert.deepEqual(queries.map((q) => q.filters), ["video==v2", "video==v2", "video==v2", "video==v2"]);
  // It went public on 09-01: both its milestones are due on 10-09.
  videos[0] = { ...videos[0], privacyStatus: "public" };
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 2, collected: 2, failed: 0 });
  // Its publish date then moves to 09-20 (made private and public again): day 7 is now 09-20..09-26 (due 09-29), day 28 09-20..10-17.
  videos[0] = { ...videos[0], publishedAt: "2026-09-20T17:00:00Z" };
  const stale = await services.listVideoMilestones({ channelId: "UC_ours", videoIds: ["v1"] });
  assert.deepEqual(stale.milestones, [], "rows of the old windows are not this video's milestones any more");
  assert.deepEqual(await services.collectDueMilestones(RUN), { attempted: 1, collected: 1, failed: 0 });
  assert.deepEqual(queries.slice(-2).map((q) => [q.filters, q.startDate, q.endDate]), [
    ["video==v1", "2026-09-20", "2026-09-26"],
    ["video==v1", "2026-09-20", "2026-09-26"],
  ]);
  const fresh = await services.listVideoMilestones({ channelId: "UC_ours", videoIds: ["v1"] });
  // The new window starts its attempts again at 1; day 28's old row stays hidden until its new window is collected.
  assert.deepEqual(fresh.milestones.map((m) => [m.milestoneDays, m.windowStart, m.windowEnd, m.status, m.attempts]), [[7, "2026-09-20", "2026-09-26", "collected", 1]]);
});

test("AC-VM-02: a 0 from YouTube is stored as 0, not as missing", async () => {
  const db = await freshDb();
  const { services } = setup(db, { totals: [{ dimensionValues: [], metrics: { views: 0, estimatedMinutesWatched: 0, averageViewDuration: 0, averageViewPercentage: 0 } }] });
  await services.collectDueMilestones(RUN);
  const [row] = (await services.listVideoMilestones({ channelId: "UC_ours", videoIds: ["v1"], milestone: 7 })).milestones;
  assert.deepEqual(row.totals, { views: 0, estimatedMinutesWatched: 0, averageViewDuration: 0, averageViewPercentage: 0 });
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

test("v76 (BL-166 fix): collected milestones without a curve are removed, so they are collected again; the rest stay", async () => {
  const db = await freshDb();
  const row = (videoId: string, retentionJson: string) => ({
    videoId,
    milestoneDays: 7,
    channelId: "UC_ours",
    windowStart: "2026-09-01",
    windowEnd: "2026-09-07",
    views: 30,
    estimatedMinutesWatched: 60,
    averageViewDuration: 120,
    averageViewPercentage: 25,
    retentionJson,
    at: NOW,
  });
  await saveCollectedVideoMilestone(row("empty", "[]"), db);
  await saveCollectedVideoMilestone(row("curve", JSON.stringify([{ elapsedVideoTimeRatio: 0.01, audienceWatchRatio: 1, relativeRetentionPerformance: 0.5 }])), db);
  await recordVideoMilestoneFailure(
    { videoId: "retrying", milestoneDays: 7, channelId: "UC_ours", windowStart: "2026-09-01", windowEnd: "2026-09-07", error: "HTTP 400", at: NOW, retryAt: NOW, maxAttempts: 3 },
    db
  );
  const v76 = SCHEMA_MIGRATIONS.find((migration) => migration.version === 76);
  assert.ok(v76);
  await v76.apply(lastClient!);
  assert.deepEqual((await listVideoMilestones("UC_ours", {}, db)).map((r) => [r.videoId, r.status]), [
    ["curve", "collected"],
    ["retrying", "retry"],
  ]);
  // Collected again: the removed milestone is planned as never attempted, the one with a curve is not.
  const states = await listVideoMilestoneStates("UC_ours", db);
  const plan = planDueMilestones([published("empty", "2026-09-01T17:00:00Z"), published("curve", "2026-09-01T17:00:00Z")], states, NOW);
  assert.deepEqual(plan.filter((p) => p.milestoneDays === 7).map((p) => p.videoId), ["empty"]);
});
