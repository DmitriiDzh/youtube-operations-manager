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
  listVideoSearchTerms,
  recordAnalyticsBreakdownFailure,
  saveCollectedVideoSearchTerms,
  type AppDb,
} from "@/lib/db";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { DomainError } from "./contracts";
import { createSearchTermServices, gateSearchTermCollection, planDueSearchTerms, toSearchTermRows } from "./search-terms";
import type { BreakdownState } from "./breakdowns";
import type { MilestoneVideo } from "./milestones";

// BL-169 (docs/roadmap/plans/VIDEO_SEARCH_TERMS_PLAN.md §3, AC-ST-01..16). Expected dates are worked out by hand from the plan: Pacific
// dates; the latest day is yesterday (Pacific); a video's window is its first 90 days; while it runs a video is read once it has 7 days and
// then every 7 days, each read covering the window so far; after the window, one read on or after window end + 7; failures follow the
// milestone rules. 2026-10-10 is a Saturday.

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
const ranges = (plan: ReturnType<typeof planDueSearchTerms>) => plan.map((p) => [p.videoId, p.from, p.to]);

test("AC-ST-02 (planning): after a read on 10-10, V1 is not due 10-11 .. 10-16 and is read for 09-01 .. 10-16 on 10-17", () => {
  const states = [readState("search:v1", "2026-09-01", "2026-10-09", "2026-10-10")];
  for (const day of ["2026-10-11", "2026-10-13", "2026-10-16"]) {
    assert.deepEqual(planDueSearchTerms([V1], states, at(`${day}T18:00:00Z`)), [], day);
  }
  assert.deepEqual(ranges(planDueSearchTerms([V1], states, at("2026-10-17T18:00:00Z"))), [["v1", "2026-09-01", "2026-10-16"]]);
});

test("AC-ST-03: a new video is first read once it has 7 days", () => {
  const video = [published("new", "2026-10-05T12:00:00Z")]; // window starts 10-05
  assert.deepEqual(planDueSearchTerms(video, [], NOW), [], "yesterday 10-09 < 10-11");
  assert.deepEqual(planDueSearchTerms(video, [], at("2026-10-11T18:00:00Z")), [], "yesterday 10-10 < 10-11");
  assert.deepEqual(ranges(planDueSearchTerms(video, [], at("2026-10-12T18:00:00Z"))), [["new", "2026-10-05", "2026-10-11"]]);
});

test("AC-ST-04: after the window ends, one read on or after window end + 7 for the whole window, then never again", () => {
  const before = [readState("search:v1", "2026-09-01", "2026-11-27", "2026-11-28")];
  for (const day of ["2026-11-29", "2026-11-30", "2026-12-03", "2026-12-05"]) {
    assert.deepEqual(planDueSearchTerms([V1], before, at(`${day}T18:00:00Z`)), [], day);
  }
  assert.deepEqual(ranges(planDueSearchTerms([V1], before, at("2026-12-06T18:00:00Z"))), [["v1", "2026-09-01", "2026-11-29"]]);
  const after = [readState("search:v1", "2026-09-01", "2026-11-29", "2026-12-06")];
  for (const day of ["2026-12-07", "2026-12-20"]) {
    assert.deepEqual(planDueSearchTerms([V1], after, at(`${day}T18:00:00Z`)), [], day);
  }
});

test("AC-ST-05: an old video's whole window is read once, and never again", () => {
  const video = [published("old", "2026-06-01T12:00:00Z")]; // window 06-01 .. 08-29, settled from 09-05
  assert.deepEqual(ranges(planDueSearchTerms(video, [], NOW)), [["old", "2026-06-01", "2026-08-29"]]);
  const done = [readState("search:old", "2026-06-01", "2026-08-29", "2026-10-10")];
  assert.deepEqual(planDueSearchTerms(video, done, at("2026-10-17T18:00:00Z")), []);
  assert.deepEqual(planDueSearchTerms(video, done, at("2027-01-01T18:00:00Z")), []);
});

test("AC-ST-06: private, scheduled, undated videos and one published today are never planned", () => {
  const videos: MilestoneVideo[] = [
    { ...published("private", "2026-09-01T12:00:00Z"), privacyStatus: "private" },
    { ...published("premiere", "2026-09-01T12:00:00Z"), liveBroadcastContent: "upcoming" },
    published("undated", null),
    published("today", "2026-10-10T15:00:00Z"), // 08:00 PDT 10-10
  ];
  assert.deepEqual(planDueSearchTerms(videos, [], NOW), []);
});

test("planning: a state for another window start counts as never read; failed is skipped; retry waits for its time; breakdown states are not search states", () => {
  const states: BreakdownState[] = [
    { ...readState("search:moved", "2026-08-20", "2026-10-09", "2026-10-10"), status: "failed" },
    { subject: "search:failed", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, collectedAt: null, status: "failed", nextAttemptAt: null },
    { subject: "search:waiting", rangeStart: "2026-09-01", collectedThrough: null, collectedOn: null, collectedAt: null, status: "retry", nextAttemptAt: at("2026-10-11T00:00:00Z") },
    { ...readState("search:ready", "2026-09-01", "2026-10-01", "2026-10-02"), status: "retry", nextAttemptAt: at("2026-10-10T10:00:00Z") },
    // The breakdowns' state of the same video (subject = the bare id) says nothing about its search terms.
    readState("bd", "2026-09-01", "2026-10-09", "2026-10-10"),
  ];
  const videos = ["moved", "failed", "waiting", "ready", "bd"].map((id) => published(id, "2026-09-01T12:00:00Z"));
  assert.deepEqual(
    ranges(planDueSearchTerms(videos, states, NOW)),
    [
      ["bd", "2026-09-01", "2026-10-09"],
      ["moved", "2026-09-01", "2026-10-09"],
      ["ready", "2026-09-01", "2026-10-09"],
    ]
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

/** `truth` is what YouTube would answer, keyed by video id. */
function setup(db: AppDb, options: { videos?: MilestoneVideo[]; truth?: Map<string, Terms>; fail?: (videoId: string) => Error | null } = {}) {
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
        const videoId = /^video==([^;]+);/.exec(String(args.filters))?.[1] ?? "";
        const failure = options.fail?.(videoId);
        if (failure) throw failure;
        return (truth.get(videoId) ?? []).map(([term, views, minutes]) => ({ dimensionValues: [term], metrics: { views, estimatedMinutesWatched: minutes } }));
      },
    },
    store: {
      listStates: (channelId) => listAnalyticsBreakdownStates(channelId, db),
      saveVideoTerms: (row) => saveCollectedVideoSearchTerms(row, db),
      defer: (row) => deferAnalyticsBreakdown(row, db),
      recordFailure: (row) => recordAnalyticsBreakdownFailure(row, db),
      listVideoTerms: (channelId, videoIds) => listVideoSearchTerms(channelId, videoIds, db),
    },
  });
  return { services, queries, clock, truth };
}

const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_ours" };
const termsOf = async (db: AppDb, videoId: string) =>
  (await listVideoSearchTerms("UC_ours", [videoId], db)).map((r) => [r.term, r.views, r.estimatedMinutesWatched]).sort();

test("AC-ST-01: the first read asks for V1's search terms over its window so far, top 25 by views, and records the read", async () => {
  const db = await freshDb();
  const { services, queries } = setup(db, { truth: new Map([["v1", [["noir jazz", 1, 0]]]]) });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 1, collected: 1, failed: 0 });
  assert.deepEqual(queries, [
    {
      channelId: "UC_ours",
      startDate: "2026-09-01",
      endDate: "2026-10-09",
      dimensions: "insightTrafficSourceDetail",
      metricNames: ["views", "estimatedMinutesWatched"],
      maxResults: 25,
      sort: "-views",
      filters: "video==v1;insightTrafficSourceType==YT_SEARCH",
    },
  ]);
  const state = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search:v1");
  assert.deepEqual([state?.rangeStart, state?.collectedThrough, state?.collectedOn, state?.status], ["2026-09-01", "2026-10-09", "2026-10-10", "collected"]);
});

test("AC-ST-02: a week later the read replaces what is stored -- a term the new answer lacks is gone", async () => {
  const db = await freshDb();
  const truth = new Map<string, Terms>([["v1", [["noir jazz", 1, 0], ["tropico 7", 1, 0]]]]);
  const { services, queries, clock } = setup(db, { truth });
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-16T18:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 0, collected: 0, failed: 0 });
  truth.set("v1", [["tropico 7", 2, 0], ["bossa nova cafe", 1, 18]]);
  clock.now = at("2026-10-17T18:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 1, collected: 1, failed: 0 });
  assert.deepEqual([queries[1].startDate, queries[1].endDate], ["2026-09-01", "2026-10-16"]);
  assert.deepEqual(await termsOf(db, "v1"), [
    ["bossa nova cafe", 1, 18],
    ["tropico 7", 2, 0],
  ]);
});

test("AC-ST-09 (videos): at most 100 queries per run, the newest never-read videos first; the next run the same day reads the rest", async () => {
  const db = await freshDb();
  // 120 videos, one every 12 hours from 2026-07-20 12:00 UTC (the newest 09-17 00:00 UTC): all have 7 days, none read.
  const videos = Array.from({ length: 120 }, (_, i) => published(`v${String(i).padStart(3, "0")}`, new Date(Date.UTC(2026, 6, 20, 12) + i * 12 * 3_600_000).toISOString()));
  const { services, queries, clock } = setup(db, { videos });
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 100, collected: 100, failed: 0 });
  assert.equal(queries[0].filters, "video==v119;insightTrafficSourceType==YT_SEARCH");
  assert.equal(queries[99].filters, "video==v020;insightTrafficSourceType==YT_SEARCH");
  queries.length = 0;
  clock.now = at("2026-10-10T20:00:00Z");
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 20, collected: 20, failed: 0 });
  assert.deepEqual(
    queries.map((q) => q.filters),
    Array.from({ length: 20 }, (_, i) => `video==v${String(19 - i).padStart(3, "0")};insightTrafficSourceType==YT_SEARCH`)
  );
});

test("AC-ST-10: a 400 counts attempts (retry after 24 h, failed after 3, then never queried); the other videos go on", async () => {
  const db = await freshDb();
  const videos = [V1, published("v2", "2026-09-02T12:00:00Z")];
  const { services, queries, clock } = setup(db, { videos, fail: (videoId) => (videoId === "v1" ? googleError(400, "badRequest") : null) });
  const v1Queries = () => queries.filter((q) => String(q.filters).startsWith("video==v1;")).length;
  assert.deepEqual(await services.collectDueSearchTerms(RUN), { attempted: 2, collected: 1, failed: 1 });
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
  assert.equal(queries.filter((q) => String(q.filters).startsWith("video==v2;")).length, 2, "v2 read on 10-10 and 10-30");
});

test("AC-ST-10: a 503, a 429 or no answer stops the run and puts the video back by 24 h with no attempt", async () => {
  for (const error of [googleError(503, "backendError"), googleError(429, "rateLimitExceeded"), new Error("socket hang up (test)")]) {
    const db = await freshDb();
    const videos = [published("v1", "2026-09-02T12:00:00Z"), published("v2", "2026-09-01T12:00:00Z")]; // order: v1, v2
    const { services, queries } = setup(db, { videos, fail: (videoId) => (videoId === "v1" ? error : null) });
    await assert.rejects(() => services.collectDueSearchTerms(RUN), (thrown: unknown) => thrown === error);
    assert.equal(queries.length, 1, `${error.message}: the run stopped`);
    const v1 = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "search:v1");
    assert.deepEqual([v1?.status, v1?.attempts, v1?.nextAttemptAt?.toISOString()], ["retry", 0, "2026-10-11T18:00:00.000Z"], error.message);
  }
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
  }
});

test("AC-ST-11: an empty answer records the read with no terms, and it is not read again that week", async () => {
  const db = await freshDb();
  const { services, queries, clock } = setup(db);
  await services.collectDueSearchTerms(RUN);
  clock.now = at("2026-10-12T18:00:00Z");
  await services.collectDueSearchTerms(RUN);
  assert.equal(queries.length, 1);
  const result = await services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: ["v1"] });
  assert.deepEqual(result.videos[0]?.coverage, { from: "2026-09-01", through: "2026-10-09", collectedAt: NOW.toISOString() });
  assert.deepEqual([result.videos[0]?.status, result.videos[0]?.terms], ["collected", []]);
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
  const videos = [V1, published("v2", "2026-09-05T12:00:00Z"), published("vOther", "2026-09-01T12:00:00Z")];
  const { services } = setup(db, { videos: videos.slice(0, 2) });

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
  await assert.rejects(
    () => services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: [] }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
});

test("storage: terms read for another window start (the publish date moved) are not returned until the video is read again", async () => {
  const db = await freshDb();
  await saveCollectedVideoSearchTerms(
    { channelId: "UC_ours", subject: "search:v1", videoId: "v1", rangeStart: "2026-08-20", to: "2026-10-09", terms: [{ term: "old", views: 1, estimatedMinutesWatched: 0 }], collectedOn: "2026-10-10", at: NOW },
    db
  );
  const { services } = setup(db);
  const [video] = (await services.listStoredSearchTerms({ channelId: "UC_ours", videoIds: ["v1"] })).videos;
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

test("AC-ST-16: the search-term table is own-channel Analytics data (authorized) and stays on this device", () => {
  for (const table of ["video_search_terms"]) {
    assert.equal(YOUTUBE_DATA_CLASSIFICATION[table]?.kind, "authorized", table);
    assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES[table], table);
  }
});
