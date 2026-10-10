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
  listAnalyticsBreakdownStates,
  listChannelSearchTermsWeekly,
  listVideoSearchTerms,
  recordAnalyticsBreakdownFailure,
  saveCollectedChannelSearchTermsWeek,
  saveCollectedVideoSearchTerms,
  type AppDb,
} from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { DomainError } from "./contracts";
import {
  completeSearchTermWeeks,
  createSearchTermServices,
  gateSearchTermCollection,
  planDueSearchTerms,
  toSearchTermRows,
  type ListStoredSearchTermsResult,
} from "./search-terms";
import type { BreakdownState } from "./breakdowns";
import type { MilestoneVideo } from "./milestones";

// BL-169 (docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md §3, AC-ST-01..16). Expected dates are worked out by hand from the plan: Pacific
// dates; the latest day is yesterday (Pacific); a video's window is its first 90 days; while it runs a video is read once it has 7 days and
// then every 7 days, each read covering the window so far; after the window, one read on or after window end + 7. The channel's last 13
// complete Monday-Sunday weeks are read once complete and once more on or after Sunday + 7. Failures follow the milestone rules.
// 2026-10-10 is a Saturday, so on 2026-10-10 (yesterday 10-09, a Friday) the newest complete week is 2026-09-28 .. 2026-10-04.

const published = (videoId: string, publishedAt: string | null): MilestoneVideo => ({ videoId, publishedAt, privacyStatus: "public", liveBroadcastContent: "none" });

function googleError(status: number, reason: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${reason} (test)`), { response: { status, data: { error: { errors: [{ reason }] } } } });
}

/** 2026-10-10 11:00 PDT: today is 10-10 (Pacific), the latest day 10-09. */
const NOW = new Date("2026-10-10T18:00:00Z");
const at = (iso: string) => new Date(iso);
/** V1: published 2026-09-01T12:00:00Z, window 2026-09-01 .. 2026-11-29. */
const V1 = published("v1", "2026-09-01T12:00:00Z");
const readState = (subject: string, rangeStart: string, collectedThrough: string, collectedOn: string): BreakdownState => ({
  subject,
  rangeStart,
  collectedThrough,
  collectedOn,
  collectedAt: at(`${collectedOn}T18:00:00Z`),
  status: "collected",
  nextAttemptAt: null,
});
/** The 13 weeks as read on 2026-10-10, newest first: Mondays 09-28, 09-21, .. 07-06. */
const WEEKS_ON_1010 = ["2026-09-28", "2026-09-21", "2026-09-14", "2026-09-07", "2026-08-31", "2026-08-24", "2026-08-17", "2026-08-10", "2026-08-03", "2026-07-27", "2026-07-20", "2026-07-13", "2026-07-06"];
/** Every week of WEEKS_ON_1010 read on 10-10 (the newest one, 09-28, is not settled yet: Sunday 10-04 + 7 = 10-11). */
const weeksReadOn1010 = () => WEEKS_ON_1010.map((monday) => readState(`search-week:${monday}`, monday, shiftDate(monday, 6), "2026-10-10"));
function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}
const videoRanges = (plan: ReturnType<typeof planDueSearchTerms>) => plan.filter((p) => p.videoId !== null).map((p) => [p.videoId, p.from, p.to]);
const weekRanges = (plan: ReturnType<typeof planDueSearchTerms>) => plan.filter((p) => p.videoId === null).map((p) => [p.from, p.to]);

test("AC-ST-02 (planning): after a read on 10-10, V1 is not due 10-11 .. 10-16 and is read for 09-01 .. 10-16 on 10-17", () => {
  const states = [readState("search:v1", "2026-09-01", "2026-10-09", "2026-10-10")];
  for (const day of ["2026-10-11", "2026-10-13", "2026-10-16"]) {
    assert.deepEqual(videoRanges(planDueSearchTerms([V1], states, at(`${day}T18:00:00Z`))), [], day);
  }
  assert.deepEqual(videoRanges(planDueSearchTerms([V1], states, at("2026-10-17T18:00:00Z"))), [["v1", "2026-09-01", "2026-10-16"]]);
});

test("AC-ST-03: a new video is first read once it has 7 days", () => {
  const video = [published("new", "2026-10-05T12:00:00Z")]; // window starts 10-05
  assert.deepEqual(videoRanges(planDueSearchTerms(video, [], NOW)), [], "yesterday 10-09 < 10-11");
  assert.deepEqual(videoRanges(planDueSearchTerms(video, [], at("2026-10-11T18:00:00Z"))), [], "yesterday 10-10 < 10-11");
  assert.deepEqual(videoRanges(planDueSearchTerms(video, [], at("2026-10-12T18:00:00Z"))), [["new", "2026-10-05", "2026-10-11"]]);
});

test("AC-ST-04: after the window ends, one read on or after window end + 7 for the whole window, then never again", () => {
  const before = [readState("search:v1", "2026-09-01", "2026-11-27", "2026-11-28")];
  for (const day of ["2026-11-29", "2026-11-30", "2026-12-03", "2026-12-05"]) {
    assert.deepEqual(videoRanges(planDueSearchTerms([V1], before, at(`${day}T18:00:00Z`))), [], day);
  }
  assert.deepEqual(videoRanges(planDueSearchTerms([V1], before, at("2026-12-06T18:00:00Z"))), [["v1", "2026-09-01", "2026-11-29"]]);
  const after = [readState("search:v1", "2026-09-01", "2026-11-29", "2026-12-06")];
  for (const day of ["2026-12-07", "2026-12-20"]) {
    assert.deepEqual(videoRanges(planDueSearchTerms([V1], after, at(`${day}T18:00:00Z`))), [], day);
  }
});

test("review of BL-169: a read less than 7 days before the window ends is followed by one more read in the window, then the settled read", () => {
  // Last read on 11-22 through 11-21; on 11-29 (yesterday 11-28, the window still runs) a week has passed.
  const states = [readState("search:v1", "2026-09-01", "2026-11-21", "2026-11-22")];
  assert.deepEqual(videoRanges(planDueSearchTerms([V1], states, at("2026-11-28T18:00:00Z"))), []);
  assert.deepEqual(videoRanges(planDueSearchTerms([V1], states, at("2026-11-29T18:00:00Z"))), [["v1", "2026-09-01", "2026-11-28"]]);
  const after = [readState("search:v1", "2026-09-01", "2026-11-28", "2026-11-29")];
  for (const day of ["2026-11-30", "2026-12-05"]) assert.deepEqual(videoRanges(planDueSearchTerms([V1], after, at(`${day}T18:00:00Z`))), [], day);
  assert.deepEqual(videoRanges(planDueSearchTerms([V1], after, at("2026-12-06T18:00:00Z"))), [["v1", "2026-09-01", "2026-11-29"]]);
});

test("AC-ST-05: an old video's whole window is read once, and never again", () => {
  const video = [published("old", "2026-06-01T12:00:00Z")]; // window 06-01 .. 08-29, settled from 09-05
  assert.deepEqual(videoRanges(planDueSearchTerms(video, [], NOW)), [["old", "2026-06-01", "2026-08-29"]]);
  const done = [readState("search:old", "2026-06-01", "2026-08-29", "2026-10-10")];
  assert.deepEqual(videoRanges(planDueSearchTerms(video, done, at("2026-10-17T18:00:00Z"))), []);
  assert.deepEqual(videoRanges(planDueSearchTerms(video, done, at("2027-01-01T18:00:00Z"))), []);
});

test("AC-ST-06: private, scheduled, undated videos and one published today are never planned", () => {
  const videos: MilestoneVideo[] = [
    { ...published("private", "2026-09-01T12:00:00Z"), privacyStatus: "private" },
    { ...published("premiere", "2026-09-01T12:00:00Z"), liveBroadcastContent: "upcoming" },
    published("undated", null),
    published("today", "2026-10-10T15:00:00Z"), // 08:00 PDT 10-10
  ];
  assert.deepEqual(videoRanges(planDueSearchTerms(videos, [], NOW)), []);
});

test("AC-ST-07 (planning): on 10-10 the 13 complete weeks 09-28 .. 07-06 come first, newest first, then the videos", () => {
  assert.deepEqual(completeSearchTermWeeks("2026-10-09"), WEEKS_ON_1010);
  // A Sunday as yesterday: its own week is complete.
  assert.equal(completeSearchTermWeeks("2026-10-11")[0], "2026-10-05");
  const plan = planDueSearchTerms([V1], [], NOW);
  assert.deepEqual(
    plan.map((p) => [p.videoId, p.from, p.to]),
    [...WEEKS_ON_1010.map((monday) => [null, monday, shiftDate(monday, 6)]), ["v1", "2026-09-01", "2026-10-09"]]
  );
});

test("AC-ST-08 (planning): week 09-28 is read again on 10-11; week 10-05 on 10-12; nothing on 10-13; week 10-05 again on 10-18", () => {
  const states = weeksReadOn1010();
  assert.deepEqual(weekRanges(planDueSearchTerms([], states, at("2026-10-11T18:00:00Z"))), [["2026-09-28", "2026-10-04"]]);
  states[0] = readState("search-week:2026-09-28", "2026-09-28", "2026-10-04", "2026-10-11");
  assert.deepEqual(weekRanges(planDueSearchTerms([], states, at("2026-10-12T18:00:00Z"))), [["2026-10-05", "2026-10-11"]]);
  states.push(readState("search-week:2026-10-05", "2026-10-05", "2026-10-11", "2026-10-12"));
  assert.deepEqual(weekRanges(planDueSearchTerms([], states, at("2026-10-13T18:00:00Z"))), []);
  assert.deepEqual(weekRanges(planDueSearchTerms([], states, at("2026-10-17T18:00:00Z"))), [], "not before 10-18");
  assert.deepEqual(weekRanges(planDueSearchTerms([], states, at("2026-10-18T18:00:00Z"))), [["2026-10-05", "2026-10-11"]]);
});

test("planning: a state for another window start counts as never read; failed is skipped; retry waits for its time; breakdown states are not search states", () => {
  const states: BreakdownState[] = [
    { ...readState("search:moved", "2026-08-20", "2026-10-09", "2026-10-10"), status: "failed" },
    { subject: "search:failed", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, collectedAt: null, status: "failed", nextAttemptAt: null },
    { subject: "search:waiting", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, collectedAt: null, status: "retry", nextAttemptAt: at("2026-10-11T00:00:00Z") },
    { ...readState("search:ready", "2026-09-01", "2026-10-01", "2026-10-02"), status: "retry", nextAttemptAt: at("2026-10-10T10:00:00Z") },
    // The breakdowns' state of the same video (subject = the bare id) says nothing about its search terms.
    readState("bd", "2026-09-01", "2026-10-09", "2026-10-10"),
    // A failed week is skipped; a week waiting for its retry is skipped.
    { subject: "search-week:2026-09-21", rangeStart: "2026-09-21", collectedThrough: null, collectedOn: null, collectedAt: null, status: "failed", nextAttemptAt: null },
    { subject: "search-week:2026-09-14", rangeStart: "2026-09-14", collectedThrough: null, collectedOn: null, collectedAt: null, status: "retry", nextAttemptAt: at("2026-10-11T00:00:00Z") },
  ];
  const videos = ["moved", "failed", "waiting", "ready", "bd"].map((id) => published(id, "2026-09-01T12:00:00Z"));
  const plan = planDueSearchTerms(videos, states, NOW);
  assert.deepEqual(videoRanges(plan), [
    ["bd", "2026-09-01", "2026-10-09"],
    ["moved", "2026-09-01", "2026-10-09"],
    ["ready", "2026-09-01", "2026-10-09"],
  ]);
  assert.deepEqual(
    weekRanges(plan).map(([from]) => from),
    WEEKS_ON_1010.filter((monday) => monday !== "2026-09-21" && monday !== "2026-09-14")
  );
});

test("toSearchTermRows (AC-ST-11): a row without a term is skipped and a repeated term keeps YouTube's last row", () => {
  assert.deepEqual(
    toSearchTermRows([
      { dimensionValues: ["noir jazz"], metrics: { views: 1, estimatedMinutesWatched: 0 } },
      { dimensionValues: [""], metrics: { views: 4, estimatedMinutesWatched: 9 } },
      { dimensionValues: [], metrics: { views: 4, estimatedMinutesWatched: 9 } },
      { dimensionValues: ["noir jazz"], metrics: { views: 2, estimatedMinutesWatched: 11 } },
      { dimensionValues: ["bossa nova cafe"], metrics: { views: 1 } },
    ]),
    [
      { term: "noir jazz", views: 2, estimatedMinutesWatched: 11 },
      { term: "bossa nova cafe", views: 1, estimatedMinutesWatched: null },
    ]
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The service on a real (temporary) database.

async function freshDb(): Promise<AppDb> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "search-terms-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return drizzle(client) as unknown as AppDb;
}

type Terms = Array<[term: string, views: number, minutes: number]>;
const CHANNEL = "channel";

/** `truth` is what YouTube would answer, keyed by video id, or `channel|<startDate>` for a channel week. */
function setup(db: AppDb, options: { videos?: MilestoneVideo[]; truth?: Map<string, Terms>; fail?: (subject: string) => Error | null } = {}) {
  const queries: Array<Record<string, unknown>> = [];
  const clock = { now: NOW };
  const truth = options.truth ?? new Map<string, Terms>();
  const videos = options.videos ?? [V1];
  const services = createSearchTermServices({
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
        const videoId = /^video==([^;]+);/.exec(String(args.filters))?.[1];
        const subject = videoId ?? CHANNEL;
        const failure = options.fail?.(subject);
        if (failure) throw failure;
        return (truth.get(videoId ?? `${CHANNEL}|${args.startDate}`) ?? []).map(([term, views, minutes]) => ({ dimensionValues: [term], metrics: { views, estimatedMinutesWatched: minutes } }));
      },
    },
    store: {
      listStates: (channelId) => listAnalyticsBreakdownStates(channelId, db),
      saveVideoTerms: (row) => saveCollectedVideoSearchTerms(row, db),
      defer: (row) => deferAnalyticsBreakdown(row, db),
      recordFailure: (row) => recordAnalyticsBreakdownFailure(row, db),
      listVideoTerms: (channelId, videoIds) => listVideoSearchTerms(channelId, videoIds, db),
      saveWeekTerms: (row) => saveCollectedChannelSearchTermsWeek(row, db),
      listWeekTerms: (channelId, first, last) => listChannelSearchTermsWeekly(channelId, first, last, db),
    },
  });
  const videoQueries = () => queries.filter((q) => String(q.filters).startsWith("video=="));
  const weekQueries = () => queries.filter((q) => q.filters === "insightTrafficSourceType==YT_SEARCH");
  return { services, queries, videoQueries, weekQueries, clock, truth };
}

const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_ours" };
const SEARCH_QUERY = { dimensions: "insightTrafficSourceDetail", metricNames: ["views", "estimatedMinutesWatched"], maxResults: 25, sort: "-views" };
const termsOf = async (db: AppDb, videoId: string) =>
  (await listVideoSearchTerms("UC_ours", [videoId], db)).map((r) => [r.term, r.views, r.estimatedMinutesWatched]).sort();
const videosOf = (result: ListStoredSearchTermsResult) => ("videos" in result ? result.videos : assert.fail("expected the videos form"));
const weeksOf = (result: ListStoredSearchTermsResult) => ("weeks" in result ? result : assert.fail("expected the channel form"));

test("AC-ST-01: the first read asks for V1's search terms over its window so far, top 25 by views, and records the read", async () => {
  const db = await freshDb();
  const { services, videoQueries } = setup(db, { truth: new Map([["v1", [["noir jazz", 1, 0]]]]) });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 14, collected: 14, failed: 0 }, "13 channel weeks and V1");
  assert.deepEqual(videoQueries(), [
    { channelId: "UC_ours", startDate: "2026-09-01", endDate: "2026-10-09", ...SEARCH_QUERY, filters: "video==v1;insightTrafficSourceType==YT_SEARCH" },
  ]);
  const state = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search:v1");
  assert.deepEqual([state?.rangeStart, state?.collectedThrough, state?.collectedOn, state?.status], ["2026-09-01", "2026-10-09", "2026-10-10", "collected"]);
});

test("AC-ST-02: a week later the read replaces what is stored -- a term the new answer lacks is gone", async () => {
  const db = await freshDb();
  const truth = new Map<string, Terms>([["v1", [["noir jazz", 1, 0], ["tropico 7", 1, 0]]]]);
  const { services, videoQueries, clock } = setup(db, { truth });
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-16T18:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(videoQueries().length, 1, "not on 10-16");
  truth.set("v1", [["tropico 7", 2, 0], ["bossa nova cafe", 1, 18]]);
  clock.now = at("2026-10-17T18:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.deepEqual(videoQueries().map((q) => [q.startDate, q.endDate]), [
    ["2026-09-01", "2026-10-09"],
    ["2026-09-01", "2026-10-16"],
  ]);
  assert.deepEqual(await termsOf(db, "v1"), [
    ["bossa nova cafe", 1, 18],
    ["tropico 7", 2, 0],
  ]);
});

test("AC-ST-07: the first run reads the 13 complete weeks, newest first, each with the channel's YT_SEARCH filter, and stores them", async () => {
  const db = await freshDb();
  const truth = new Map<string, Terms>([[`${CHANNEL}|2026-09-28`, [["cuban jazz", 1, 8], ["bossa nova", 1, 3]]]]);
  const { services, queries, weekQueries } = setup(db, { videos: [], truth });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 13, collected: 13, failed: 0 });
  assert.equal(queries.length, 13);
  assert.deepEqual(
    weekQueries(),
    WEEKS_ON_1010.map((monday) => ({ channelId: "UC_ours", startDate: monday, endDate: shiftDate(monday, 6), ...SEARCH_QUERY, filters: "insightTrafficSourceType==YT_SEARCH" }))
  );
  assert.deepEqual(
    (await listChannelSearchTermsWeekly("UC_ours", "2026-07-06", "2026-09-28", db)).map((r) => [r.weekStart, r.term, r.views]).sort(),
    [
      ["2026-09-28", "bossa nova", 1],
      ["2026-09-28", "cuban jazz", 1],
    ]
  );
});

test("AC-ST-08: later runs read week 09-28 again on 10-11, week 10-05 on 10-12, nothing on 10-13, week 10-05 again on 10-18; a reread replaces the week", async () => {
  const db = await freshDb();
  const truth = new Map<string, Terms>([[`${CHANNEL}|2026-09-28`, [["cuban jazz", 1, 8], ["latin jazz cafe", 1, 0]]]]);
  const { services, weekQueries, clock } = setup(db, { videos: [], truth });
  await services.collectDueSearchTerms(RUN);
  const read = async (iso: string) => {
    const before = weekQueries().length;
    clock.now = at(iso);
    await services.collectDueSearchTerms(RUN);
    return weekQueries().slice(before).map((q) => [q.startDate, q.endDate]);
  };
  truth.set(`${CHANNEL}|2026-09-28`, [["cuban jazz", 2, 9]]); // YouTube revised the week
  assert.deepEqual(await read("2026-10-11T18:00:00Z"), [["2026-09-28", "2026-10-04"]]);
  assert.deepEqual((await listChannelSearchTermsWeekly("UC_ours", "2026-09-28", "2026-09-28", db)).map((r) => [r.term, r.views, r.estimatedMinutesWatched]), [["cuban jazz", 2, 9]]);
  assert.deepEqual(await read("2026-10-12T18:00:00Z"), [["2026-10-05", "2026-10-11"]]);
  assert.deepEqual(await read("2026-10-13T18:00:00Z"), []);
  assert.deepEqual(await read("2026-10-18T18:00:00Z"), [["2026-10-05", "2026-10-11"]]);
  assert.deepEqual(await read("2026-10-18T20:00:00Z"), [], "once");
});

test("AC-ST-09: at most 100 queries per run -- the 13 weeks, then the 87 newest never-read videos; the next run the same day reads the other 33", async () => {
  const db = await freshDb();
  // 120 videos, one every 12 hours from 2026-07-20 12:00 UTC (the newest 09-17 00:00 UTC): all have 7 days, none read.
  const videos = Array.from({ length: 120 }, (_, i) => published(`v${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 6, 20, 12) + i * 12 * 3_600_000).toISOString()));
  const { services, queries, clock } = setup(db, { videos });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 100, collected: 100, failed: 0 });
  assert.deepEqual(queries.slice(0, 13).map((q) => q.startDate), WEEKS_ON_1010);
  assert.equal(queries[13].filters, "video==v119;insightTrafficSourceType==YT_SEARCH");
  assert.equal(queries[99].filters, "video==v033;insightTrafficSourceType==YT_SEARCH", "the 87th newest");
  queries.length = 0;
  clock.now = at("2026-10-10T20:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 33, collected: 33, failed: 0 });
  assert.deepEqual(
    queries.map((q) => q.filters),
    Array.from({ length: 33 }, (_, i) => `video==v${String(32 - i).padStart(3, "0")};insightTrafficSourceType==YT_SEARCH`)
  );
});

test("AC-ST-10: a 400 counts attempts (retry after 24 h, failed after 3, then never queried); the others go on", async () => {
  const db = await freshDb();
  const videos = [V1, published("v2", "2026-09-02T12:00:00Z")];
  const { services, videoQueries, clock } = setup(db, { videos, fail: (subject) => (subject === "v1" ? googleError(400, "badRequest") : null) });
  const v1Queries = () => videoQueries().filter((q) => String(q.filters).startsWith("video==v1;")).length;
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 15, collected: 14, failed: 1 });
  let v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search:v1");
  assert.deepEqual([v1?.status, v1?.attempts, v1?.nextAttemptAt?.toISOString()], ["retry", 1, "2026-10-11T18:00:00.000Z"]);
  clock.now = at("2026-10-10T19:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(v1Queries(), 1, "an hour later: not yet");
  clock.now = at("2026-10-11T19:00:00Z");
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-12T20:00:00Z");
  await services.collectDueSearchTerms(RUN);
  v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search:v1");
  assert.deepEqual([v1?.status, v1?.attempts], ["failed", 3]);
  assert.equal(v1Queries(), 3);
  clock.now = at("2026-10-30T20:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(v1Queries(), 3, "failed: never queried again");
  // v2 is read on 10-10; the runs of 10-11 and 10-12 are within its week; 10-30 is more than 7 days later.
  assert.equal(videoQueries().filter((q) => String(q.filters).startsWith("video==v2;")).length, 2, "v2 read on 10-10 and 10-30");
});

test("AC-ST-10: a channel week answered with a 400 is retried a day later and given up after 3 attempts", async () => {
  const db = await freshDb();
  let failing = true;
  const { services, weekQueries, clock } = setup(db, {
    videos: [],
    fail: (subject) => (subject === CHANNEL && failing ? googleError(400, "badRequest") : null),
  });
  const week = async (monday: string) => (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === `search-week:${monday}`);
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 13, collected: 0, failed: 13 });
  assert.deepEqual([(await week("2026-09-28"))?.status, (await week("2026-09-28"))?.attempts], ["retry", 1]);
  clock.now = at("2026-10-11T19:00:00Z");
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-12T20:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.deepEqual([(await week("2026-09-28"))?.status, (await week("2026-09-28"))?.attempts], ["failed", 3]);
  const asked = weekQueries().filter((q) => q.startDate === "2026-09-28").length;
  assert.equal(asked, 3);
  failing = false;
  clock.now = at("2026-10-20T20:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(weekQueries().filter((q) => q.startDate === "2026-09-28").length, asked, "failed: never queried again");
});

// AC-ST-10 as changed by the review of BL-169: a video's defer stops the run (this test); a week's stops only the weeks (the review tests).
test("AC-ST-10: a 503, a 429 or no answer for a video stops the run and puts it back by 24 h with no attempt", async () => {
  for (const error of [googleError(503, "backendError"), googleError(429, "rateLimitExceeded"), new Error("socket hang up (test)")]) {
    const db = await freshDb();
    const videos = [published("v1", "2026-09-02T12:00:00Z"), published("v2", "2026-09-01T12:00:00Z")]; // order: weeks, v1, v2
    const { services, videoQueries } = setup(db, { videos, fail: (subject) => (subject === "v1" ? error : null) });
    await assert.rejects(() => services.collectDueSearchTerms(RUN), (thrown: unknown) => thrown === error);
    assert.deepEqual(videoQueries().map((q) => q.filters), ["video==v1;insightTrafficSourceType==YT_SEARCH"], `${error.message}: the run stopped`);
    const states = await listAnalyticsBreakdownStates("UC_ours", db);
    const v1 = states.find((s) => s.subject === "search:v1");
    assert.deepEqual([v1?.status, v1?.attempts, v1?.nextAttemptAt?.toISOString()], ["retry", 0, "2026-10-11T18:00:00.000Z"], error.message);
    assert.equal(states.filter((s) => s.subject.startsWith("search-week:") && s.status === "collected").length, 13, "the weeks before it were saved");
  }
});

test("review of BL-169: weeks that keep getting no answer end only the weeks of each run -- the videos are still read from the first run on", async () => {
  const db = await freshDb();
  const videos = [V1, published("v2", "2026-09-02T12:00:00Z")];
  const { services, videoQueries, weekQueries, clock } = setup(db, { videos, fail: (subject) => (subject === CHANNEL ? googleError(503, "backendError") : null) });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 3, collected: 2, failed: 0 }, "one week, then both videos");
  assert.deepEqual(videoQueries().map((q) => q.filters), ["video==v2;insightTrafficSourceType==YT_SEARCH", "video==v1;insightTrafficSourceType==YT_SEARCH"]);
  assert.deepEqual(weekQueries().map((q) => q.startDate), ["2026-09-28"]);
  const week = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search-week:2026-09-28");
  assert.deepEqual([week?.status, week?.attempts, week?.nextAttemptAt?.toISOString()], ["retry", 0, "2026-10-11T18:00:00.000Z"]);
  // The next day the next never-read week is tried first and gets no answer either; the weeks stop there again, the run does not throw.
  clock.now = at("2026-10-11T19:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 1, collected: 0, failed: 0 });
  assert.deepEqual(weekQueries().map((q) => q.startDate), ["2026-09-28", "2026-09-21"]);
});

test("review of BL-169: when the videos get no answer either, the first video ends the run", async () => {
  const db = await freshDb();
  const videos = [V1, published("v2", "2026-09-02T12:00:00Z")];
  const error = googleError(503, "backendError");
  const { services, videoQueries, weekQueries } = setup(db, { videos, fail: () => error });
  await assert.rejects(() => services.collectDueSearchTerms(RUN), (thrown: unknown) => thrown === error);
  assert.equal(weekQueries().length, 1);
  assert.deepEqual(videoQueries().map((q) => q.filters), ["video==v2;insightTrafficSourceType==YT_SEARCH"]);
});

test("review of BL-169: a week whose settled reread is refused is retried and keeps returning the terms of its first read", async () => {
  const db = await freshDb();
  let refuse = false;
  const truth = new Map<string, Terms>([[`${CHANNEL}|2026-09-28`, [["cuban jazz", 1, 8]]]]);
  const { services, clock } = setup(db, { videos: [], truth, fail: (subject) => (subject === CHANNEL && refuse ? googleError(400, "badRequest") : null) });
  await services.collectDueSearchTerms(RUN);
  refuse = true;
  clock.now = at("2026-10-11T18:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 1, collected: 0, failed: 1 });
  const [stored] = weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-28", endDate: "2026-10-04", groupBy: "week" })).weeks;
  assert.deepEqual([stored.status, stored.lastError, stored.terms], ["retry", "HTTP 400 badRequest (test)", [{ term: "cuban jazz", views: 1, estimatedMinutesWatched: 8 }]]);
  refuse = false;
  truth.set(`${CHANNEL}|2026-09-28`, [["cuban jazz", 2, 9]]);
  clock.now = at("2026-10-12T19:00:00Z");
  await services.collectDueSearchTerms(RUN);
  const [reread] = weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-28", endDate: "2026-10-04", groupBy: "week" })).weeks;
  assert.deepEqual([reread.status, reread.terms], ["collected", [{ term: "cuban jazz", views: 2, estimatedMinutesWatched: 9 }]]);
});

test("AC-ST-10: reads off, quota, sign-in, 401 and a 403 quotaExceeded stop the run with nothing written", async () => {
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
    await assert.rejects(() => services.collectDueSearchTerms(RUN));
    assert.deepEqual(await listAnalyticsBreakdownStates("UC_ours", db), [], error.message);
    assert.deepEqual(await listVideoSearchTerms("UC_ours", ["v1"], db), [], error.message);
    assert.deepEqual(await listChannelSearchTermsWeekly("UC_ours", "2000-01-03", "2100-01-04", db), [], error.message);
  }
});

test("AC-ST-11: an empty answer records the read with no terms, and it is not read again that week", async () => {
  const db = await freshDb();
  const { services, videoQueries, clock } = setup(db);
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-12T18:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(videoQueries().length, 1);
  const [video] = videosOf(await services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: ["v1"] }));
  assert.deepEqual(video.coverage, { from: "2026-09-01", through: "2026-10-09", collectedAt: NOW.toISOString() });
  assert.deepEqual([video.status, video.terms], ["collected", []]);
});

test("AC-ST-12 (videos): terms are returned most views first, then by term, only for the session channel's own videos", async () => {
  const db = await freshDb();
  const save = (channelId: string, videoId: string, terms: Terms) =>
    saveCollectedVideoSearchTerms(
      {
        channelId,
        subject: `search:${videoId}`,
        videoId,
        rangeStart: "2026-09-01",
        to: "2026-10-09",
        terms: terms.map(([term, views, minutes]) => ({ term, views, estimatedMinutesWatched: minutes })),
        collectedOn: "2026-10-10",
        at: NOW,
      },
      db
    );
  await save("UC_ours", "v1", [["bossa nova cafe", 1, 18], ["tropico 7", 2, 0], ["noir jazz", 1, 0]]);
  await save("UC_other", "vOther", [["somebody else", 9, 9]]);
  const { services } = setup(db, { videos: [V1, published("v2", "2026-09-05T12:00:00Z")] });

  const result = await services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: ["v1", "v2", "vOther"] });
  assert.deepEqual(result, {
    channelId: "UC_ours",
    videos: [
      {
        videoId: "v1",
        publishedAt: "2026-09-01T12:00:00Z",
        window: { start: "2026-09-01", end: "2026-11-29" },
        coverage: { from: "2026-09-01", through: "2026-10-09", collectedAt: NOW.toISOString() },
        status: "collected",
        lastError: null,
        terms: [
          { term: "tropico 7", views: 2, estimatedMinutesWatched: 0 },
          { term: "bossa nova cafe", views: 1, estimatedMinutesWatched: 18 },
          { term: "noir jazz", views: 1, estimatedMinutesWatched: 0 },
        ],
      },
      {
        videoId: "v2",
        publishedAt: "2026-09-05T12:00:00Z",
        window: { start: "2026-09-05", end: "2026-12-03" },
        coverage: null,
        status: "not_collected",
        lastError: null,
        terms: [],
      },
    ],
  });
  await assert.rejects(
    () => services.listStoredSearchTerms({ channelId: "UC_other", videoIds: ["vOther"] }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("AC-ST-12 (channel weeks): total sums each term over the weeks, week lists each week; only complete weeks fully inside the range", async () => {
  const db = await freshDb();
  const saveWeek = (channelId: string, monday: string, terms: Terms) =>
    saveCollectedChannelSearchTermsWeek(
      {
        channelId,
        subject: `search-week:${monday}`,
        weekStart: monday,
        to: shiftDate(monday, 6),
        terms: terms.map(([term, views, minutes]) => ({ term, views, estimatedMinutesWatched: minutes })),
        collectedOn: "2026-10-10",
        at: NOW,
      },
      db
    );
  await saveWeek("UC_ours", "2026-09-21", [["latin jazz cafe", 2, 0], ["bossa nova", 1, 5]]);
  await saveWeek("UC_ours", "2026-09-28", [["bossa nova", 1, 3], ["cuban jazz", 1, 8]]);
  await saveWeek("UC_other", "2026-09-28", [["somebody else", 9, 9]]);
  const { services } = setup(db);
  const collected = (monday: string) => ({ weekStart: monday, weekEnd: shiftDate(monday, 6), status: "collected", collectedAt: NOW.toISOString(), lastError: null });

  assert.deepEqual(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-21", endDate: "2026-10-04" }), {
    channelId: "UC_ours",
    startDate: "2026-09-21",
    endDate: "2026-10-04",
    groupBy: "total",
    weeks: [collected("2026-09-21"), collected("2026-09-28")],
    terms: [
      { term: "bossa nova", views: 2, estimatedMinutesWatched: 8 },
      { term: "latin jazz cafe", views: 2, estimatedMinutesWatched: 0 },
      { term: "cuban jazz", views: 1, estimatedMinutesWatched: 8 },
    ],
  });
  const byWeek = weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-21", endDate: "2026-10-04", groupBy: "week" }));
  assert.equal(byWeek.terms, undefined);
  assert.deepEqual(byWeek.weeks, [
    { ...collected("2026-09-21"), terms: [{ term: "latin jazz cafe", views: 2, estimatedMinutesWatched: 0 }, { term: "bossa nova", views: 1, estimatedMinutesWatched: 5 }] },
    { ...collected("2026-09-28"), terms: [{ term: "bossa nova", views: 1, estimatedMinutesWatched: 3 }, { term: "cuban jazz", views: 1, estimatedMinutesWatched: 8 }] },
  ]);
  // 09-22 .. 10-04: week 09-21 is not fully inside.
  assert.deepEqual(weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-22", endDate: "2026-10-04" })).weeks.map((w) => w.weekStart), ["2026-09-28"]);
  // A week never read is listed as not collected, with no terms; week 10-05 .. 10-11 is not complete on 10-10 and is not listed.
  const wider = weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-14", endDate: "2026-10-11", groupBy: "week" }));
  assert.deepEqual(wider.weeks.map((w) => [w.weekStart, w.status, w.terms?.length]), [
    ["2026-09-14", "not_collected", 0],
    ["2026-09-21", "collected", 2],
    ["2026-09-28", "collected", 2],
  ]);
});

test("AC-ST-12 (channel weeks): a total is null only when every week had none, otherwise the sum of the known values", async () => {
  const db = await freshDb();
  const saveWeek = (monday: string, terms: Array<[string, number | null, number | null]>) =>
    saveCollectedChannelSearchTermsWeek(
      {
        channelId: "UC_ours",
        subject: `search-week:${monday}`,
        weekStart: monday,
        to: shiftDate(monday, 6),
        terms: terms.map(([term, views, minutes]) => ({ term, views, estimatedMinutesWatched: minutes })),
        collectedOn: "2026-10-10",
        at: NOW,
      },
      db
    );
  await saveWeek("2026-09-21", [["rural japan", null, 4], ["japan bgm", null, null]]);
  await saveWeek("2026-09-28", [["rural japan", 3, null], ["japan bgm", null, null]]);
  const { services } = setup(db);
  const total = weeksOf(await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-09-21", endDate: "2026-10-04" }));
  assert.deepEqual(total.terms, [
    { term: "rural japan", views: 3, estimatedMinutesWatched: 4 },
    { term: "japan bgm", views: null, estimatedMinutesWatched: null },
  ]);
});

test("AC-ST-12 (input): 92 days accepted; 93 days, a non-date, dates with videoIds and the channel form without dates are refused", async () => {
  const db = await freshDb();
  const { services } = setup(db);
  const refused = (input: Record<string, unknown>, text: string) =>
    assert.rejects(
      () => services.listStoredSearchTerms({ channelId: "UC_ours", ...input }),
      (error: unknown) => error instanceof DomainError && error.code === "validation_failed" && JSON.stringify(error.details).includes(text),
      JSON.stringify(input)
    );
  await services.listStoredSearchTerms({ channelId: "UC_ours", startDate: "2026-07-03", endDate: "2026-10-02" });
  await refused({ startDate: "2026-07-02", endDate: "2026-10-02" }, "at most 92 days");
  await refused({ startDate: "2026-02-30", endDate: "2026-03-02" }, "not a calendar date");
  await refused({ startDate: "2026-10-02", endDate: "2026-10-01" }, "startDate must not be after endDate");
  await refused({ videoIds: ["v1"], startDate: "2026-09-01", endDate: "2026-09-30" }, "leave out startDate, endDate and groupBy");
  await refused({ videoIds: ["v1"], groupBy: "week" }, "leave out startDate, endDate and groupBy");
  await refused({}, "startDate and endDate are required");
  await refused({ startDate: "2026-09-01" }, "startDate and endDate are required");
  await refused({ videoIds: [] }, "");
  await assert.rejects(
    () => services.listStoredSearchTerms({ channelId: "UC_other", startDate: "2026-09-01", endDate: "2026-09-30" }),
    (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE"
  );
});

test("storage: terms read for another window start (the publish date moved) are not returned until the video is read again", async () => {
  const db = await freshDb();
  await saveCollectedVideoSearchTerms(
    { channelId: "UC_ours", subject: "search:v1", videoId: "v1", rangeStart: "2026-08-20", to: "2026-10-09", terms: [{ term: "old", views: 1, estimatedMinutesWatched: 0 }], collectedOn: "2026-10-10", at: NOW },
    db
  );
  const { services } = setup(db);
  const [video] = videosOf(await services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: ["v1"] }));
  assert.deepEqual([video.status, video.coverage, video.terms], ["not_collected", null, []]);
});

test("AC-ST-13: while the background reserve is not allowed, a run makes zero queries", async () => {
  let called = 0;
  const gated = gateSearchTermCollection({ isBackgroundReadAllowed: async () => false }, async () => {
    called += 1;
    return { attempted: 1, collected: 1, failed: 0 };
  });
  assert.deepEqual(await gated(RUN), { attempted: 0, collected: 0, failed: 0 });
  assert.equal(called, 0);
});

test("AC-ST-16: the search-term tables are own-channel Analytics data (authorized) and stay on this device", () => {
  for (const table of ["video_search_terms", "channel_search_terms_weekly"]) {
    assert.equal(YOUTUBE_DATA_CLASSIFICATION[table]?.kind, "authorized", table);
    assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES[table], table);
  }
});
