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
// reaches 89 days before the latest day; failures follow the milestone rules.
//
// The independent review of BL-168 changed three requirements, so the tests below changed with them:
// - The cap is 100 subjects, not 50 (every video in its window is due daily: about 70 per channel), and the queue is least recently
//   collected first (never collected first, newest publish date among equals) instead of newest first, which starved the oldest videos
//   of the window every day once more were due than the cap. AC-VB-10 now uses 120 videos; the fairness test below is new.
// - New days are read from 6 days before the first new one, so after a gap the last stored days, which were still provisional, are
//   read again (the earlier rule started at the gap). AC-VB-05 and the planning test's retry now start at 09-26.
// - The channel is never given up after 3 failed attempts (it has no end and no other way back): it is retried a day later, every time.

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

test("AC-VB-05: after a gap left while the computer was off, the read starts 6 days before the first missing day", () => {
  const states: BreakdownState[] = [{ subject: "v1", rangeStart: "2026-09-01", collectedThrough: "2026-10-01", collectedOn: "2026-10-02", status: "collected", nextAttemptAt: null, collectedAt: null }];
  assert.deepEqual(videoPlan(planDueBreakdowns([published("v1", "2026-09-01T12:00:00Z")], states, at("2026-10-11T18:00:00Z"))), [
    { subject: "v1", videoId: "v1", rangeStart: "2026-09-01", from: "2026-09-26", to: "2026-10-10", fresh: false },
  ]);
});

test("AC-VB-06: after the window ends, one final reread on or after window end + 7, then never again", () => {
  const video = [published("v1", "2026-09-01T12:00:00Z")]; // window 09-01 .. 11-29
  const state = (collectedThrough: string, collectedOn: string): BreakdownState[] => [
    { subject: "v1", rangeStart: "2026-09-01", collectedThrough, collectedOn, status: "collected", nextAttemptAt: null, collectedAt: null },
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
  const done: BreakdownState[] = [{ subject: "old", rangeStart: "2026-06-01", collectedThrough: "2026-08-29", collectedOn: "2026-10-10", status: "collected", nextAttemptAt: null, collectedAt: null }];
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
  const state: BreakdownState[] = [{ subject: CHANNEL_SUBJECT, rangeStart: "2026-07-12", collectedThrough: "2026-10-09", collectedOn: "2026-10-10", status: "collected", nextAttemptAt: null, collectedAt: null }];
  assert.deepEqual(planDueBreakdowns([], state, at("2026-10-10T23:00:00Z")), []);
  assert.deepEqual(planDueBreakdowns([], state, at("2026-10-11T18:00:00Z")), [
    { subject: CHANNEL_SUBJECT, videoId: null, rangeStart: "2026-07-12", from: "2026-10-04", to: "2026-10-10", fresh: false },
  ]);
  const later: BreakdownState[] = [{ subject: CHANNEL_SUBJECT, rangeStart: "2026-07-12", collectedThrough: "2027-02-27", collectedOn: "2027-02-28", status: "collected", nextAttemptAt: null, collectedAt: null }];
  assert.deepEqual(planDueBreakdowns([], later, at("2027-03-01T20:00:00Z")), [
    { subject: CHANNEL_SUBJECT, videoId: null, rangeStart: "2026-07-12", from: "2027-02-22", to: "2027-02-28", fresh: false },
  ]);
});

test("planning: a stored range for another window start counts as never collected; failed is skipped; retry waits for its time", () => {
  const states: BreakdownState[] = [
    // moved: collected while scheduled for 08-20 .. ; it went public on 09-01.
    { subject: "moved", rangeStart: "2026-08-20", collectedThrough: "2026-10-09", collectedOn: "2026-10-10", status: "failed", nextAttemptAt: null, collectedAt: null },
    { subject: "failed", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, status: "failed", nextAttemptAt: null, collectedAt: null },
    { subject: "waiting", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, status: "retry", nextAttemptAt: at("2026-10-11T00:00:00Z"), collectedAt: null },
    { subject: "ready", rangeStart: "2026-09-01", collectedThrough: "2026-10-01", collectedOn: "2026-10-02", status: "retry", nextAttemptAt: at("2026-10-10T10:00:00Z"), collectedAt: null },
  ];
  const videos = ["moved", "failed", "waiting", "ready"].map((id) => published(id, "2026-09-01T12:00:00Z"));
  assert.deepEqual(
    videoPlan(planDueBreakdowns(videos, states, NOW)).map((p) => [p.subject, p.from, p.to, p.fresh]),
    [
      ["moved", "2026-09-01", "2026-10-09", true],
      ["ready", "2026-09-26", "2026-10-09", false],
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
  truth.set(`${CHANNEL_SUBJECT}|${DEVICE}`, [
    ["2026-10-03", "TV", 9, 900],
    ["2026-10-05", "MOBILE", 2, 20],
  ]);
  const { services, queries, clock } = setup(db, { truth });
  await services.collectDueBreakdowns(RUN);
  // YouTube revised 10-05: the search view is gone, subscribers went up; the channel's mobile view is gone too.
  truth.set(`${CHANNEL_SUBJECT}|${DEVICE}`, [["2026-10-03", "TV", 9, 900]]);
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
  // The channel the same way: read 10-04 .. 10-10, its 10-03 row stays and the 10-05 one is gone.
  assert.deepEqual(
    queries.filter((q) => q.filters === undefined).map((q) => [q.startDate, q.endDate]),
    [
      ["2026-10-04", "2026-10-10"],
      ["2026-10-04", "2026-10-10"],
    ]
  );
  assert.deepEqual(
    (await listAnalyticsBreakdownRows("UC_ours", [CHANNEL_SUBJECT], "2026-07-01", "2026-10-10", db)).map((r) => [r.day, r.value, r.views]),
    [["2026-10-03", "TV", 9]]
  );
});

test("storage: a fresh read after the publish date moved replaces the old window's rows; a failure for a new range start resets the stored range", async () => {
  const db = await freshDb();
  const save = (rangeStart: string, day: string) =>
    saveCollectedAnalyticsBreakdown(
      {
        channelId: "UC_ours",
        subject: "v1",
        videoId: "v1",
        rangeStart,
        from: rangeStart,
        to: "2026-10-09",
        fresh: true,
        rows: { traffic_source: [{ day, value: "SUBSCRIBER", views: 1, estimatedMinutesWatched: 2 }], device_type: [] },
        collectedOn: "2026-10-10",
        at: NOW,
      },
      db
    );
  await save("2026-08-20", "2026-08-25");
  await save("2026-09-01", "2026-09-02");
  assert.deepEqual((await listAnalyticsBreakdownRows("UC_ours", ["v1"], "2026-01-01", "2026-12-31", db)).map((r) => r.day), ["2026-09-02"]);

  const failure = { channelId: "UC_ours", subject: "v1", error: "HTTP 400", at: NOW, retryAt: NOW };
  assert.equal(await recordAnalyticsBreakdownFailure({ ...failure, rangeStart: "2026-09-01", maxAttempts: 3 }, db), "retry");
  let [state] = await listAnalyticsBreakdownStates("UC_ours", db);
  assert.deepEqual([state.rangeStart, state.collectedThrough, state.attempts], ["2026-09-01", "2026-10-09", 1], "same range: kept");
  await recordAnalyticsBreakdownFailure({ ...failure, rangeStart: "2026-09-10", maxAttempts: 3 }, db);
  [state] = await listAnalyticsBreakdownStates("UC_ours", db);
  assert.deepEqual([state.rangeStart, state.collectedThrough, state.collectedOn, state.attempts], ["2026-09-10", null, null, 1], "new range: reset");
  await deferAnalyticsBreakdown({ ...failure, rangeStart: "2026-09-12" }, db);
  [state] = await listAnalyticsBreakdownStates("UC_ours", db);
  assert.deepEqual([state.rangeStart, state.collectedThrough, state.status, state.attempts], ["2026-09-12", null, "retry", 0]);
});

test("AC-VB-10: at most 100 subjects per run -- the channel and the 99 newest videos first; the next run takes the other 21", async () => {
  const db = await freshDb();
  // 120 videos, one every 12 hours from 2026-07-20 12:00 UTC (the newest 09-17 00:00 UTC): all inside their window, none collected.
  const videos = Array.from({ length: 120 }, (_, i) => published(`v${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 6, 20, 12) + i * 12 * 3_600_000).toISOString()));
  const { services, queries } = setup(db, { videos });
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 100, collected: 100, failed: 0 });
  assert.equal(queries.length, 200);
  assert.equal(queries[0].filters, undefined, "the channel first");
  assert.equal(queries[2].filters, "video==v119", "then the newest video");
  assert.equal(queries[199].filters, "video==v021", "the 99th newest");
  queries.length = 0;
  assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 21, collected: 21, failed: 0 });
  assert.deepEqual(
    queries.filter((_, i) => i % 2 === 0).map((q) => q.filters),
    Array.from({ length: 21 }, (_, i) => `video==v${String(20 - i).padStart(3, "0")}`)
  );
});

test("review of BL-168: with more due than the cap every day, no video is starved -- each is read within 3 days and the final pass happens", () => {
  // 12 videos, 1 run a day, at most 5 subjects (the channel and 4 videos): a fair queue reads each video at least every ceil(12/4) = 3 days.
  // v00 (published 07-13) has the window 07-13 .. 10-10, so its final pass is due from 10-17.
  const videos = [published("v00", "2026-07-13T12:00:00Z"), ...Array.from({ length: 11 }, (_, i) => published(`v${String(i + 1).padStart(2, "0")}`, `2026-09-${String(10 + i).padStart(2, "0")}T12:00:00Z`))];
  const states = new Map<string, BreakdownState>();
  const reads = new Map<string, string[]>(); // subject -> Pacific dates it was read on
  for (let day = 0; day < 16; day++) {
    const now = new Date(Date.UTC(2026, 9, 10 + day, 18)); // 11:00 PDT, 10-10 .. 10-25
    const today = new Date(Date.UTC(2026, 9, 10 + day)).toISOString().slice(0, 10);
    const plan = planDueBreakdowns(videos, [...states.values()], now, 5);
    for (const item of plan) {
      const before = states.get(item.subject);
      // No day is lost, and the last stored (provisional) days are read again: a read starts at or before the last stored day.
      if (before?.collectedThrough && !item.fresh) assert.ok(item.from <= before.collectedThrough, `${item.subject} on ${today}`);
      states.set(item.subject, { subject: item.subject, rangeStart: item.rangeStart, collectedThrough: item.to, collectedOn: today, collectedAt: now, status: "collected", nextAttemptAt: null });
      reads.set(item.subject, [...(reads.get(item.subject) ?? []), today]);
    }
  }
  const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / 86_400_000;
  for (const video of videos.slice(1)) {
    const days = (reads.get(video.videoId) ?? []).map(dayNumber);
    assert.ok(days.length >= 5, `${video.videoId} read ${days.length} times`);
    assert.ok(days[0] - dayNumber("2026-10-10") < 3, `${video.videoId} first read`);
    for (let i = 1; i < days.length; i++) assert.ok(days[i] - days[i - 1] <= 3, `${video.videoId} waited ${days[i] - days[i - 1]} days`);
  }
  const v00 = states.get("v00");
  assert.equal(v00?.collectedThrough, "2026-10-10");
  assert.ok((v00?.collectedOn ?? "") >= "2026-10-17", `v00's final pass (last read ${v00?.collectedOn})`);
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

test("AC-VB-11: a 404 or a video's own 403 counts an attempt too; the channel is never given up, only retried a day later", async () => {
  for (const error of [googleError(404, "notFound"), googleError(403, "forbidden")]) {
    const db = await freshDb();
    const { services } = setup(db, { fail: (subject) => (subject === "v1" ? error : null) });
    assert.deepEqual(await services.collectDueBreakdowns(RUN), { attempted: 2, collected: 1, failed: 1 }, error.message);
    const v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "v1");
    assert.deepEqual([v1?.status, v1?.attempts], ["retry", 1], error.message);
  }
  const db = await freshDb();
  const { services, queries, clock } = setup(db, { fail: (subject) => (subject === CHANNEL_SUBJECT ? googleError(400, "badRequest") : null) });
  for (let day = 0; day < 5; day++) {
    clock.now = new Date(NOW.getTime() + day * 25 * 3_600_000);
    await services.collectDueBreakdowns(RUN);
  }
  const channel = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === CHANNEL_SUBJECT);
  assert.deepEqual([channel?.status, channel?.attempts], ["retry", 5]);
  assert.equal(queries.filter((q) => q.filters === undefined).length, 5, "the channel was tried on each of the 5 days");
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
  // Exactly 92 days (07-03 .. 10-02) is accepted; 93 (07-02 .. 10-02) is not; a date that does not exist is refused as such.
  await services.listStoredBreakdowns({ channelId: "UC_ours", startDate: "2026-07-03", endDate: "2026-10-02" });
  await assert.rejects(
    () => services.listStoredBreakdowns({ channelId: "UC_ours", startDate: "2026-07-02", endDate: "2026-10-02" }),
    (error: unknown) => error instanceof DomainError && JSON.stringify(error.details).includes("at most 92 days")
  );
  await assert.rejects(
    () => services.listStoredBreakdowns({ channelId: "UC_ours", startDate: "2026-02-30", endDate: "2026-03-02" }),
    (error: unknown) => error instanceof DomainError && JSON.stringify(error.details).includes("not a calendar date")
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
