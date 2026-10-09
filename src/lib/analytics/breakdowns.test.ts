import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deferAnalyticsBreakdown,
  initializeDatabaseSchema,
  listAnalyticsBreakdownRows,
  listAnalyticsBreakdownStates,
  recordAnalyticsBreakdownFailure,
  saveCollectedAnalyticsBreakdown,
  type AppDb,
} from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { DomainError } from "./contracts";
import {
  CHANNEL_SUBJECT,
  createBreakdownServices,
  gateBreakdownCollection,
  planDueBreakdowns,
  videoBreakdownWindow,
  type BreakdownState,
} from "./breakdowns";
import type { MilestoneVideo } from "./milestones";

// BL-168 (docs/roadmap/plans/VIDEO_BREAKDOWNS_PLAN.md §3, AC-VB-01..17). Expected dates and sums are worked out by hand from the plan:
// Pacific dates; the latest day is yesterday (Pacific); a video's window is its first 90 days; each collection rereads the last 7 days of
// its range (and fills a gap); a video whose window has ended gets one final reread on or after window end + 7; the channel's first range
// reaches 89 days before the latest day; at most 50 subjects (2 queries each) per channel per run, the channel first, then videos newest
// first; failures follow the milestone rules.

const published = (videoId: string, publishedAt: string | null): MilestoneVideo => ({ videoId, publishedAt, privacyStatus: "public", liveBroadcastContent: "none" });

function googleError(status: number, reason: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${reason} (test)`), { response: { status, data: { error: { errors: [{ reason }] } } } });
}

/** 2026-10-10 11:00 PDT: today is 10-10 (Pacific), the latest day 10-09. */
const NOW = new Date("2026-10-10T18:00:00Z");
const at = (iso: string) => new Date(iso);
const videoPlan = (plan: ReturnType<typeof planDueBreakdowns>) => plan.filter((p) => p.videoId !== null);

test("AC-VB-01: a video's window is its Pacific publish date .. +89", () => {
  assert.deepEqual(videoBreakdownWindow("2026-09-01T12:00:00Z"), { windowStart: "2026-09-01", windowEnd: "2026-11-29" });
  // 03:00 UTC on 09-01 is 20:00 PDT on 08-31.
  assert.deepEqual(videoBreakdownWindow("2026-09-01T03:00:00Z"), { windowStart: "2026-08-31", windowEnd: "2026-11-28" });
});

test("AC-VB-05: a gap left while the computer was off is read from the day after the stored end", () => {
  const states: BreakdownState[] = [{ subject: "v1", rangeStart: "2026-09-01", collectedThrough: "2026-10-01", collectedOn: "2026-10-02", status: "collected", nextAttemptAt: null }];
  assert.deepEqual(videoPlan(planDueBreakdowns([published("v1", "2026-09-01T12:00:00Z")], states, at("2026-10-11T18:00:00Z"))), [
    { subject: "v1", videoId: "v1", rangeStart: "2026-09-01", from: "2026-10-02", to: "2026-10-10", fresh: false },
  ]);
});

test("AC-VB-06: after the window ends, one final reread on or after window end + 7, then never again", () => {
  const video = [published("v1", "2026-09-01T12:00:00Z")]; // window 09-01 .. 11-29
  const state = (collectedThrough: string, collectedOn: string): BreakdownState[] => [
    { subject: "v1", rangeStart: "2026-09-01", collectedThrough, collectedOn, status: "collected", nextAttemptAt: null },
  ];
  // 11-30: the window's last day (11-29) is the latest day; the last 7 days are read.
  assert.deepEqual(videoPlan(planDueBreakdowns(video, state("2026-11-28", "2026-11-29"), at("2026-11-30T18:00:00Z"))), [
    { subject: "v1", videoId: "v1", rangeStart: "2026-09-01", from: "2026-11-23", to: "2026-11-29", fresh: false },
  ]);
  for (const day of ["2026-12-01", "2026-12-03", "2026-12-05"]) {
    assert.deepEqual(videoPlan(planDueBreakdowns(video, state("2026-11-29", "2026-11-30"), at(`${day}T18:00:00Z`))), [], day);
  }
  assert.deepEqual(videoPlan(planDueBreakdowns(video, state("2026-11-29", "2026-11-30"), at("2026-12-06T18:00:00Z"))), [
    { subject: "v1", videoId: "v1", rangeStart: "2026-09-01", from: "2026-11-23", to: "2026-11-29", fresh: false },
  ]);
  for (const day of ["2026-12-07", "2026-12-20"]) {
    assert.deepEqual(videoPlan(planDueBreakdowns(video, state("2026-11-29", "2026-12-06"), at(`${day}T18:00:00Z`))), [], day);
  }
});

test("AC-VB-07: an old video's whole window is read once, and never again", () => {
  const video = [published("old", "2026-06-01T12:00:00Z")]; // window 06-01 .. 08-29
  assert.deepEqual(videoPlan(planDueBreakdowns(video, [], NOW)), [
    { subject: "old", videoId: "old", rangeStart: "2026-06-01", from: "2026-06-01", to: "2026-08-29", fresh: true },
  ]);
  const done: BreakdownState[] = [{ subject: "old", rangeStart: "2026-06-01", collectedThrough: "2026-08-29", collectedOn: "2026-10-10", status: "collected", nextAttemptAt: null }];
  assert.deepEqual(videoPlan(planDueBreakdowns(video, done, at("2026-10-11T18:00:00Z"))), []);
  assert.deepEqual(videoPlan(planDueBreakdowns(video, done, at("2026-12-01T18:00:00Z"))), []);
});

test("AC-VB-08: private, scheduled and undated videos are never planned; one published today (Pacific) is not due yet", () => {
  const videos: MilestoneVideo[] = [
    { ...published("private", "2026-09-01T12:00:00Z"), privacyStatus: "private" },
    { ...published("premiere", "2026-09-01T12:00:00Z"), liveBroadcastContent: "upcoming" },
    published("undated", null),
    published("today", "2026-10-10T15:00:00Z"), // 08:00 PDT 10-10
    published("yesterday", "2026-10-09T15:00:00Z"), // 08:00 PDT 10-09: its first day is the latest day
  ];
  assert.deepEqual(videoPlan(planDueBreakdowns(videos, [], NOW)), [
    { subject: "yesterday", videoId: "yesterday", rangeStart: "2026-10-09", from: "2026-10-09", to: "2026-10-09", fresh: true },
  ]);
});

test("AC-VB-09: the channel goes first; its first range reaches 89 days back, later runs reread 7 days, and it is never finalized", () => {
  assert.deepEqual(planDueBreakdowns([], [], NOW), [
    { subject: CHANNEL_SUBJECT, videoId: null, rangeStart: "2026-07-12", from: "2026-07-12", to: "2026-10-09", fresh: true },
  ]);
  const state: BreakdownState[] = [{ subject: CHANNEL_SUBJECT, rangeStart: "2026-07-12", collectedThrough: "2026-10-09", collectedOn: "2026-10-10", status: "collected", nextAttemptAt: null }];
  assert.deepEqual(planDueBreakdowns([], state, at("2026-10-10T23:00:00Z")), []);
  assert.deepEqual(planDueBreakdowns([], state, at("2026-10-11T18:00:00Z")), [
    { subject: CHANNEL_SUBJECT, videoId: null, rangeStart: "2026-07-12", from: "2026-10-04", to: "2026-10-10", fresh: false },
  ]);
  const later: BreakdownState[] = [{ subject: CHANNEL_SUBJECT, rangeStart: "2026-07-12", collectedThrough: "2027-02-27", collectedOn: "2027-02-28", status: "collected", nextAttemptAt: null }];
  assert.deepEqual(planDueBreakdowns([], later, at("2027-03-01T20:00:00Z")), [
    { subject: CHANNEL_SUBJECT, videoId: null, rangeStart: "2026-07-12", from: "2027-02-22", to: "2027-02-28", fresh: false },
  ]);
});

test("planning: a stored range for another window start counts as never collected; failed is skipped; retry waits for its time", () => {
  const states: BreakdownState[] = [
    // moved: collected while scheduled for 08-20 .. ; it went public on 09-01.
    { subject: "moved", rangeStart: "2026-08-20", collectedThrough: "2026-10-09", collectedOn: "2026-10-10", status: "failed", nextAttemptAt: null },
    { subject: "failed", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, status: "failed", nextAttemptAt: null },
    { subject: "waiting", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, status: "retry", nextAttemptAt: at("2026-10-11T00:00:00Z") },
    { subject: "ready", rangeStart: "2026-09-01", collectedThrough: "2026-10-01", collectedOn: "2026-10-02", status: "retry", nextAttemptAt: at("2026-10-10T10:00:00Z") },
  ];
  const videos = ["moved", "failed", "waiting", "ready"].map((id) => published(id, "2026-09-01T12:00:00Z"));
  assert.deepEqual(
    videoPlan(planDueBreakdowns(videos, states, NOW)).map((p) => [p.subject, p.from, p.to, p.fresh]),
    [
      ["moved", "2026-09-01", "2026-10-09", true],
      ["ready", "2026-10-02", "2026-10-09", false],
    ]
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The service on a real (temporary) database.

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "breakdowns-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

type Truth = Map<string, Array<[day: string, value: string, views: number, minutes: number]>>;

/** `truth` is what YouTube would answer, keyed `<video id or "channel">|<dimensions>`; the fake returns the rows inside the range asked. */
function setup(db: AppDb, options: { videos?: MilestoneVideo[]; truth?: Truth; fail?: (subject: string, dimensions: string) => Error | null } = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const clock = { now: NOW };
  const truth: Truth = options.truth ?? new Map();
  const videos = options.videos ?? [published("v1", "2026-09-01T12:00:00Z")];
  const services = createBreakdownServices({
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
        const subject = args.filters ? String(args.filters).replace("video==", "") : CHANNEL_SUBJECT;
        const failure = options.fail?.(subject, String(args.dimensions));
        if (failure) throw failure;
        return (truth.get(`${subject}|${args.dimensions}`) ?? [])
          .filter(([day]) => day >= args.startDate && day <= args.endDate)
          .map(([day, value, views, minutes]) => ({ dimensionValues: [day, value], metrics: { views, estimatedMinutesWatched: minutes } }));
      },
    },
    store: {
      listStates: (channelId) => listAnalyticsBreakdownStates(channelId, db),
      saveCollected: (row) => saveCollectedAnalyticsBreakdown(row, db),
      defer: (row) => deferAnalyticsBreakdown(row, db),
      recordFailure: (row) => recordAnalyticsBreakdownFailure(row, db),
      listRows: (channelId, subjects, startDate, endDate) => listAnalyticsBreakdownRows(channelId, subjects, startDate, endDate, db),
    },
  });
  return { services, queries, clock, truth };
}

const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_ours" };
const TRAFFIC = "day,insightTrafficSourceType";
const DEVICE = "day,deviceType";

test("AC-VB-02/03: the first run reads the channel and the video's range so far, 2 queries each; the same Pacific day reads nothing again", async () => {
  const db = await freshDb();
  const { services, queries, clock } = setup(db);
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 2, collected: 2, failed: 0 });
  assert.deepEqual(queries, [
    { channelId: "UC_ours", startDate: "2026-07-12", endDate: "2026-10-09", dimensions: TRAFFIC, metricNames: ["views", "estimatedMinutesWatched"] },
    { channelId: "UC_ours", startDate: "2026-07-12", endDate: "2026-10-09", dimensions: DEVICE, metricNames: ["views", "estimatedMinutesWatched"] },
    { channelId: "UC_ours", startDate: "2026-09-01", endDate: "2026-10-09", dimensions: TRAFFIC, metricNames: ["views", "estimatedMinutesWatched"], filters: "video==v1" },
    { channelId: "UC_ours", startDate: "2026-09-01", endDate: "2026-10-09", dimensions: DEVICE, metricNames: ["views", "estimatedMinutesWatched"], filters: "video==v1" },
  ]);
  const v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "v1");
  assert.equal(v1?.collectedThrough, "2026-10-09");
  assert.equal(v1?.collectedOn, "2026-10-10");
  assert.equal(v1?.status, "collected");

  clock.now = at("2026-10-10T23:00:00Z"); // 16:00 PDT, still 10-10
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(queries.length, 4);
});

test("AC-VB-04: the next day rereads 10-04..10-10, replacing what is stored there; 10-03 stays", async () => {
  const db = await freshDb();
  const truth: Truth = new Map([
    [
      `v1|${TRAFFIC}`,
      [
        ["2026-10-03", "SUBSCRIBER", 5, 50],
        ["2026-10-05", "YT_SEARCH", 3, 30],
        ["2026-10-05", "SUBSCRIBER", 4, 40],
      ],
    ],
  ]);
  const { services, queries, clock } = setup(db, { truth });
  await services.collectDueBreakdowns(RUN);
  // YouTube revised 10-05: the search view is gone, subscribers went up.
  truth.set(`v1|${TRAFFIC}`, [
    ["2026-10-03", "SUBSCRIBER", 5, 50],
    ["2026-10-05", "SUBSCRIBER", 6, 60],
  ]);
  clock.now = at("2026-10-11T18:00:00Z");
  queries.length = 0;
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 2, collected: 2, failed: 0 });
  assert.deepEqual(
    queries.filter((q) => q.filters === "video==v1").map((q) => [q.startDate, q.endDate]),
    [
      ["2026-10-04", "2026-10-10"],
      ["2026-10-04", "2026-10-10"],
    ]
  );
  const rows = await listAnalyticsBreakdownRows("UC_ours", ["v1"], "2026-09-01", "2026-10-10", db);
  assert.deepEqual(
    rows.map((r) => [r.day, r.value, r.views, r.estimatedMinutesWatched]).sort(),
    [
      ["2026-10-03", "SUBSCRIBER", 5, 50],
      ["2026-10-05", "SUBSCRIBER", 6, 60],
    ]
  );
});

test("AC-VB-10: at most 50 subjects per run -- the channel and the 49 newest videos; the next run takes the other 11", async () => {
  const db = await freshDb();
  // 60 videos published 08-01 .. 09-29 (one a day, 12:00 UTC = 05:00 PDT the same day).
  const videos = Array.from({ length: 60 }, (_, i) => {
    const day = new Date(Date.UTC(2026, 7, 1 + i, 12)).toISOString();
    return published(`v${String(i).padStart(2, "0")}`, day);
  });
  const { services, queries } = setup(db, { videos });
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 50, collected: 50, failed: 0 });
  assert.equal(queries.length, 100);
  assert.equal(queries[0].filters, undefined, "the channel first");
  assert.equal(queries[2].filters, "video==v59", "then the newest video (09-29)");
  assert.equal(queries[99].filters, "video==v11", "the 49th newest is v11 (08-12)");
  queries.length = 0;
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 11, collected: 11, failed: 0 });
  assert.deepEqual(
    queries.filter((_, i) => i % 2 === 0).map((q) => q.filters),
    ["v10", "v09", "v08", "v07", "v06", "v05", "v04", "v03", "v02", "v01", "v00"].map((id) => `video==${id}`)
  );
});

test("AC-VB-11: a 400 counts attempts (retry after 24 h, failed after 3, then never queried); the channel goes on", async () => {
  const db = await freshDb();
  const { services, queries, clock } = setup(db, { fail: (subject) => (subject === "v1" ? googleError(400, "badRequest") : null) });
  const v1Queries = () => queries.filter((q) => q.filters === "video==v1").length;
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 2, collected: 1, failed: 1 });
  let v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "v1");
  assert.equal(v1?.status, "retry");
  assert.equal(v1?.attempts, 1);
  assert.equal(v1?.nextAttemptAt?.toISOString(), "2026-10-11T18:00:00.000Z");

  clock.now = at("2026-10-10T19:00:00Z"); // an hour later: not yet
  await services.collectDueBreakdowns(RUN);
  assert.equal(v1Queries(), 1);

  clock.now = at("2026-10-11T19:00:00Z");
  await services.collectDueBreakdowns(RUN);
  clock.now = at("2026-10-12T20:00:00Z");
  await services.collectDueBreakdowns(RUN);
  v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "v1");
  assert.equal(v1?.status, "failed");
  assert.equal(v1?.attempts, 3);
  assert.equal(v1Queries(), 3);

  clock.now = at("2026-10-20T20:00:00Z");
  const channelBefore = queries.filter((q) => q.filters === undefined).length;
  await services.collectDueBreakdowns(RUN);
  assert.equal(v1Queries(), 3, "failed: never queried again");
  assert.equal(queries.filter((q) => q.filters === undefined).length, channelBefore + 2, "the channel is still collected");
});

test("AC-VB-11: a 503, a 429 or no answer stops the run and puts the subject back by 24 h with no attempt", async () => {
  for (const error of [googleError(503, "backendError"), googleError(429, "rateLimitExceeded"), new Error("socket hang up (test)")]) {
    const db = await freshDb();
    const videos = [published("v1", "2026-09-02T12:00:00Z"), published("v2", "2026-09-01T12:00:00Z")]; // order: channel, v1, v2
    const { services, queries } = setup(db, { videos, fail: (subject) => (subject === "v1" ? error : null) });
    await assert.rejects(() => services.collectDueBreakdowns(RUN), (thrown: unknown) => thrown === error);
    assert.equal(queries.filter((q) => q.filters === "video==v2").length, 0, `${error.message}: the run stopped`);
    const states = await listAnalyticsBreakdownStates("UC_ours", db);
    const v1 = states.find((s) => s.subject === "v1");
    assert.equal(v1?.status, "retry", error.message);
    assert.equal(v1?.attempts, 0, error.message);
    assert.equal(v1?.nextAttemptAt?.toISOString(), "2026-10-11T18:00:00.000Z", error.message);
    assert.equal(states.find((s) => s.subject === CHANNEL_SUBJECT)?.status, "collected", "the channel before it was saved");
  }
});

test("AC-VB-11: reads off, quota, sign-in, 401 and a 403 quotaExceeded stop the run with nothing written", async () => {
  const stops = [
    new DomainError({ code: "analytics_reads_disabled", message: "off" }),
    new DomainError({ code: "youtube_quota_exceeded", message: "quota" }),
    new DomainError({ code: "AUTH_REFRESH_TOKEN_MISSING" as never, message: "sign in" }),
    googleError(401, "authError"),
    googleError(403, "quotaExceeded"),
  ];
  for (const error of stops) {
    const db = await freshDb();
    const { services } = setup(db, { fail: () => error });
    await assert.rejects(() => services.collectDueBreakdowns(RUN));
    assert.deepEqual(await listAnalyticsBreakdownStates("UC_ours", db), [], error.message);
    assert.deepEqual(await listAnalyticsBreakdownRows("UC_ours", [CHANNEL_SUBJECT, "v1"], "2000-01-01", "2100-01-01", db), [], error.message);
  }
});

test("AC-VB-12: an empty answer records the range as collected with no rows, and is not queried again that day", async () => {
  const db = await freshDb();
  const { services, queries, clock } = setup(db);
  await services.collectDueBreakdowns(RUN);
  clock.now = at("2026-10-10T22:00:00Z");
  await services.collectDueBreakdowns(RUN);
  assert.equal(queries.length, 4);
  const result = await services.listStoredBreakdowns({ channelId: "UC_ours", videoIds: ["v1"], startDate: "2026-09-01", endDate: "2026-10-09" });
  assert.deepEqual(result.videos?.[0]?.coverage, { from: "2026-09-01", through: "2026-10-09", collectedAt: NOW.toISOString() });
  assert.deepEqual([result.videos?.[0]?.trafficSources, result.videos?.[0]?.devices], [[], []]);
});

test("AC-VB-13: reads sum each value over the days asked for (or list them by day), only for the session channel's own videos", async () => {
  const db = await freshDb();
  const save = (channelId: string, subject: string, videoId: string | null, traffic: Array<[string, string, number, number]>, devices: Array<[string, string, number, number]>) =>
    saveCollectedAnalyticsBreakdown(
      {
        channelId,
        subject,
        videoId,
        rangeStart: "2026-09-01",
        from: "2026-09-01",
        to: "2026-10-09",
        fresh: true,
        rows: {
          traffic_source: traffic.map(([day, value, views, minutes]) => ({ day, value, views, estimatedMinutesWatched: minutes })),
          device_type: devices.map(([day, value, views, minutes]) => ({ day, value, views, estimatedMinutesWatched: minutes })),
        },
        collectedOn: "2026-10-10",
        at: NOW,
      },
      db
    );
  await save(
    "UC_ours",
    "v1",
    "v1",
    [
      ["2026-10-01", "SUBSCRIBER", 18, 451],
      ["2026-10-02", "SUBSCRIBER", 2, 30],
      ["2026-10-02", "YT_SEARCH", 1, 5],
    ],
    [["2026-10-01", "TV", 3, 100]]
  );
  await save("UC_other", "vOther", "vOther", [["2026-10-01", "SUBSCRIBER", 99, 999]], []);
  await save("UC_ours", CHANNEL_SUBJECT, null, [["2026-10-01", "SUBSCRIBER", 40, 900]], [["2026-10-01", "DESKTOP", 25, 700]]);
  const { services } = setup(db, { videos: [published("v1", "2026-09-01T12:00:00Z")] });

  const total = await services.listStoredBreakdowns({ channelId: "UC_ours", videoIds: ["v1", "vOther"], startDate: "2026-10-01", endDate: "2026-10-02" });
  assert.deepEqual(total, {
    channelId: "UC_ours",
    startDate: "2026-10-01",
    endDate: "2026-10-02",
    groupBy: "total",
    videos: [
      {
        videoId: "v1",
        publishedAt: "2026-09-01T12:00:00Z",
        window: { start: "2026-09-01", end: "2026-11-29" },
        coverage: { from: "2026-09-01", through: "2026-10-09", collectedAt: NOW.toISOString() },
        status: "collected",
        lastError: null,
        trafficSources: [
          { value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 20, estimatedMinutesWatched: 481 },
          { value: "YT_SEARCH", label: "YouTube search", views: 1, estimatedMinutesWatched: 5 },
        ],
        devices: [{ value: "TV", label: "TV", views: 3, estimatedMinutesWatched: 100 }],
      },
    ],
  });

  const oneDay = await services.listStoredBreakdowns({ channelId: "UC_ours", videoIds: ["v1"], startDate: "2026-10-01", endDate: "2026-10-01" });
  assert.deepEqual(oneDay.videos?.[0]?.trafficSources, [{ value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 18, estimatedMinutesWatched: 451 }]);

  const byDay = await services.listStoredBreakdowns({ channelId: "UC_ours", videoIds: ["v1"], startDate: "2026-10-01", endDate: "2026-10-02", groupBy: "day" });
  assert.deepEqual(byDay.videos?.[0]?.trafficSources, [
    { day: "2026-10-01", value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 18, estimatedMinutesWatched: 451 },
    { day: "2026-10-02", value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 2, estimatedMinutesWatched: 30 },
    { day: "2026-10-02", value: "YT_SEARCH", label: "YouTube search", views: 1, estimatedMinutesWatched: 5 },
  ]);

  const channel = await services.listStoredBreakdowns({ channelId: "UC_ours", startDate: "2026-10-01", endDate: "2026-10-02" });
  assert.equal(channel.videos, undefined);
  assert.deepEqual(channel.channel?.trafficSources, [{ value: "SUBSCRIBER", label: "Home feed or subscriptions", views: 40, estimatedMinutesWatched: 900 }]);
  assert.deepEqual(channel.channel?.devices, [{ value: "DESKTOP", label: "Computer", views: 25, estimatedMinutesWatched: 700 }]);

  await assert.rejects(
    () => services.listStoredBreakdowns({ channelId: "UC_other", startDate: "2026-10-01", endDate: "2026-10-02" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
  // 07-01 .. 10-02 is 94 days: refused as invalid input, naming the limit.
  await assert.rejects(
    () => services.listStoredBreakdowns({ channelId: "UC_ours", startDate: "2026-07-01", endDate: "2026-10-02" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed" && JSON.stringify(error.details).includes("at most 92 days")
  );
});

test("AC-VB-14: while the background reserve is not allowed, a run makes zero queries", async () => {
  let called = 0;
  const gated = gateBreakdownCollection({ isBackgroundReadAllowed: async () => false }, async () => {
    called += 1;
    return { attempted: 1, collected: 1, failed: 0 };
  });
  assert.deepEqual(await gated(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(called, 0);
});

test("AC-VB-17: the three tables are own-channel Analytics data (authorized) and stay on this device", () => {
  for (const table of ["video_breakdown_daily", "channel_breakdown_daily", "analytics_breakdown_state"]) {
    assert.equal(YOUTUBE_DATA_CLASSIFICATION[table]?.kind, "authorized", table);
    assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES[table], table);
  }
});
