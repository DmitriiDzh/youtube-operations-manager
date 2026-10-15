import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/libsql";
import { createLibsqlClient } from "@/lib/libsql-client";
import {
  deferAnalyticsBreakdown,
  listOwnVideosByIds,
  initializeDatabaseSchema,
  listAnalyticsBreakdownStates,
  listChannelSuggestedSourcesWeekly,
  listStoredSuggestedSourceIds,
  listSuggestedVideoTitles,
  listVideoSuggestedSources,
  recordAnalyticsBreakdownFailure,
  saveCollectedChannelSuggestedSourcesWeek,
  saveCollectedVideoSuggestedSources,
  saveSuggestedVideoTitles,
  channels,
  videos,
  type AppDb,
} from "@/lib/db";
import { purgeExpiredApiData } from "@/lib/youtube-data-policy";
import { SNAPSHOT_DEVICE_LOCAL_TABLES } from "@/lib/snapshot/contracts";
import { YOUTUBE_DATA_CLASSIFICATION } from "@/lib/youtube-data-policy/contracts";
import { DomainError } from "./contracts";
import { planDueSearchTerms } from "./search-terms";
import { createSuggestedSourceServices, gateSuggestedSourceCollection, MAX_TITLE_LOOKUPS_PER_RUN, SUGGESTED_SOURCE_SPEC } from "./suggested-sources";
import { planDueTrafficDetails } from "./traffic-source-details";
import type { BreakdownState } from "./breakdowns";
import type { MilestoneVideo } from "./milestones";

// BL-191 (docs/roadmap/plans/SUGGESTED_SOURCES_PLAN.md §3, AC-SS-01..08). The schedule is BL-169's (VIDEO_SEARCH_TERMS_PLAN.md §3),
// so the expected dates below are the ones worked out by hand there, now for the `suggested:` subjects: Pacific dates; the latest day is
// yesterday; a video's window is its first 90 days; read once it has 7 days, then every 7 days, once more on or after window end + 7; the
// last 13 complete Monday-Sunday weeks once complete and once more on or after Sunday + 7. 2026-10-10 is a Saturday.

const published = (videoId: string, publishedAt: string | null): MilestoneVideo => ({ videoId, publishedAt, privacyStatus: "public", liveBroadcastContent: "none" });
const NOW = new Date("2026-10-10T18:00:00Z");
const at = (iso: string) => new Date(iso);
const V1 = published("v1", "2026-09-01T12:00:00Z"); // window 2026-09-01 .. 2026-11-29
const readState = (subject: string, rangeStart: string, collectedThrough: string, collectedOn: string): BreakdownState => ({
  subject,
  rangeStart,
  collectedThrough,
  collectedOn,
  collectedAt: at(`${collectedOn}T18:00:00Z`),
  status: "collected",
  nextAttemptAt: null,
});
const plan = (videos: MilestoneVideo[], states: BreakdownState[], now: Date, max?: number) => planDueTrafficDetails(SUGGESTED_SOURCE_SPEC, videos, states, now, max);
const videoRanges = (items: ReturnType<typeof plan>) => items.filter((p) => p.videoId !== null).map((p) => [p.subject, p.from, p.to]);
const weekRanges = (items: ReturnType<typeof plan>) => items.filter((p) => p.videoId === null).map((p) => [p.subject, p.from, p.to]);
const WEEKS_ON_1010 = ["2026-09-28", "2026-09-21", "2026-09-14", "2026-09-07", "2026-08-31", "2026-08-24", "2026-08-17", "2026-08-10", "2026-08-03", "2026-07-27", "2026-07-20", "2026-07-13", "2026-07-06"];

test("AC-SS-02 (AC-ST-01..05): the suggested subjects follow BL-169's video schedule", () => {
  // First read on 10-10 for 09-01 .. 10-09.
  assert.deepEqual(videoRanges(plan([V1], [], NOW)), [["suggested:v1", "2026-09-01", "2026-10-09"]]);
  // Weekly: not due 10-11 .. 10-16, read for 09-01 .. 10-16 on 10-17.
  const read = [readState("suggested:v1", "2026-09-01", "2026-10-09", "2026-10-10")];
  for (const day of ["2026-10-11", "2026-10-16"]) assert.deepEqual(videoRanges(plan([V1], read, at(`${day}T18:00:00Z`))), [], day);
  assert.deepEqual(videoRanges(plan([V1], read, at("2026-10-17T18:00:00Z"))), [["suggested:v1", "2026-09-01", "2026-10-16"]]);
  // First week: a video published 10-05 is due on 10-12 for 10-05 .. 10-11, not on 10-11.
  const fresh = [published("new", "2026-10-05T12:00:00Z")];
  assert.deepEqual(videoRanges(plan(fresh, [], at("2026-10-11T18:00:00Z"))), []);
  assert.deepEqual(videoRanges(plan(fresh, [], at("2026-10-12T18:00:00Z"))), [["suggested:new", "2026-10-05", "2026-10-11"]]);
  // End of the window: after a read on 11-28 through 11-27, due on 12-06 for the whole window, never again.
  const before = [readState("suggested:v1", "2026-09-01", "2026-11-27", "2026-11-28")];
  assert.deepEqual(videoRanges(plan([V1], before, at("2026-12-05T18:00:00Z"))), []);
  assert.deepEqual(videoRanges(plan([V1], before, at("2026-12-06T18:00:00Z"))), [["suggested:v1", "2026-09-01", "2026-11-29"]]);
  const after = [readState("suggested:v1", "2026-09-01", "2026-11-29", "2026-12-06")];
  assert.deepEqual(videoRanges(plan([V1], after, at("2026-12-20T18:00:00Z"))), []);
  // An old video: its whole window once.
  assert.deepEqual(videoRanges(plan([published("old", "2026-06-01T12:00:00Z")], [], NOW)), [["suggested:old", "2026-06-01", "2026-08-29"]]);
});

test("AC-SS-02 (AC-ST-07/08): the 13 weeks, newest first, then their settled read; acceptance weeks 09-28 and 10-05 for Tropico", () => {
  assert.deepEqual(
    weekRanges(plan([], [], NOW)).map(([subject]) => subject),
    WEEKS_ON_1010.map((monday) => `suggested-week:${monday}`)
  );
  // On 2026-10-16 (FO-REQ-0026's first day) both acceptance weeks are due on a first run.
  const onRelease = weekRanges(plan([], [], at("2026-10-16T18:00:00Z")));
  assert.deepEqual(onRelease.slice(0, 2), [
    ["suggested-week:2026-10-05", "2026-10-05", "2026-10-11"],
    ["suggested-week:2026-09-28", "2026-09-28", "2026-10-04"],
  ]);
  const states = WEEKS_ON_1010.map((monday) => readState(`suggested-week:${monday}`, monday, "x", "2026-10-10"));
  assert.deepEqual(weekRanges(plan([], states, at("2026-10-11T18:00:00Z"))), [["suggested-week:2026-09-28", "2026-09-28", "2026-10-04"]]);
});

test("AC-SS-02 (independence): a search-term state never makes a suggested subject due or not due, and the reverse", () => {
  const searchRead = [readState("search:v1", "2026-09-01", "2026-10-09", "2026-10-10"), ...WEEKS_ON_1010.map((m) => readState(`search-week:${m}`, m, "x", "2026-10-10"))];
  assert.equal(plan([V1], searchRead, NOW).length, 14, "13 weeks and V1 are still due for the suggested sources");
  const suggestedRead = [readState("suggested:v1", "2026-09-01", "2026-10-09", "2026-10-10"), ...WEEKS_ON_1010.map((m) => readState(`suggested-week:${m}`, m, "x", "2026-10-10"))];
  assert.equal(planDueSearchTerms([V1], suggestedRead, NOW).length, 14, "and the reverse");
  assert.equal(plan([V1], suggestedRead, NOW).length, 0);
});

test("AC-SS-02 (AC-ST-09, cap): at most 100 queries a run", () => {
  const videos = Array.from({ length: 120 }, (_, i) => published(`v${i}`, "2026-09-01T12:00:00Z"));
  assert.equal(plan(videos, [], NOW).length, 100);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The service on a real (temporary) database.

async function freshDb(): Promise<{ db: AppDb; client: ReturnType<typeof createLibsqlClient> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "suggested-sources-"));
  const client = createLibsqlClient({ url: `file:${path.join(dir, "t.db")}` });
  await initializeDatabaseSchema(client);
  return { db: drizzle(client) as unknown as AppDb, client };
}

type Rows = Array<[videoId: string, views: number, minutes: number]>;
const RUN = { credentialRef: { userId: "u1" }, channelId: "UC_ours" };

function googleError(status: number, reason: string): Error {
  return Object.assign(new Error(`HTTP ${status} ${reason} (test)`), { response: { status, data: { error: { errors: [{ reason }] } } } });
}

function setup(
  db: AppDb,
  options: {
    videos?: MilestoneVideo[];
    truth?: Map<string, Rows>;
    dataAllowed?: boolean;
    titles?: (ids: string[]) => Array<{ videoId: string; title: string; channelId: string | null; channelTitle: string | null }>;
    titleFailure?: Error;
    now?: Date;
  } = {}
) {
  const queries: Array<Record<string, unknown>> = [];
  const titleCalls: string[][] = [];
  const reserveChecks: string[] = [];
  const clock = { now: options.now ?? NOW };
  const truth = options.truth ?? new Map<string, Rows>();
  const services = createSuggestedSourceServices({
    clock: { now: () => clock.now },
    authResolver: { resolve: async () => ({ accessToken: "a", refreshToken: "r" }) as never },
    channelAccess: {
      assertActiveChannel: async ({ channelId }) => {
        if (channelId !== "UC_ours") throw new DomainError({ code: "CHANNEL_NOT_ACTIVE", message: "not active" });
        return channelId;
      },
    },
    videoStore: { listVideos: async () => options.videos ?? [V1] },
    youtubeApi: {
      queryChannelBreakdownReport: async (args) => {
        const { credentials: _c, ...rest } = args;
        void _c;
        queries.push(rest);
        const videoId = /^video==([^;]+);/.exec(String(args.filters))?.[1];
        return (truth.get(videoId ?? `channel|${args.startDate}`) ?? []).map(([id, views, minutes]) => ({ dimensionValues: [id], metrics: { views, estimatedMinutesWatched: minutes } }));
      },
    },
    store: {
      listStates: (channelId) => listAnalyticsBreakdownStates(channelId, db),
      saveVideoRows: (row) => saveCollectedVideoSuggestedSources(row, db),
      defer: (row) => deferAnalyticsBreakdown(row, db),
      recordFailure: (row) => recordAnalyticsBreakdownFailure(row, db),
      listVideoRows: (channelId, videoIds) => listVideoSuggestedSources(channelId, videoIds, db),
      saveWeekRows: (row) => saveCollectedChannelSuggestedSourcesWeek(row, db),
      listWeekRows: (channelId, first, last) => listChannelSuggestedSourcesWeekly(channelId, first, last, db),
    },
    ownVideos: { findByIds: (ids) => listOwnVideosByIds(ids, db) },
    titles: {
      listStoredSourceIds: (channelId) => listStoredSuggestedSourceIds(channelId, db),
      listFresh: (ids, since) => listSuggestedVideoTitles(ids, since, db),
      save: (rows, when) => saveSuggestedVideoTitles(rows, when, db),
    },
    dataReserve: {
      isBackgroundReadAllowed: async (service) => {
        reserveChecks.push(service);
        return options.dataAllowed ?? true;
      },
    },
    dataApi: {
      getPublicVideoTitles: async ({ videoIds }) => {
        titleCalls.push(videoIds);
        if (options.titleFailure) throw options.titleFailure;
        return options.titles ? options.titles(videoIds) : videoIds.map((id) => ({ videoId: id, title: `T ${id}`, channelId: `UC_${id}`, channelTitle: `C ${id}` }));
      },
    },
  });
  return { services, queries, titleCalls, reserveChecks, clock };
}

/** A synced video of a connected channel, written straight into this test's own database. */
async function seedOwnVideo(db: AppDb, videoId: string, channelId: string) {
  await db.insert(channels).values({ id: channelId, title: `Channel ${channelId}`, thumbnailUrl: null, uploadsPlaylistId: `UU${channelId}` }).onConflictDoNothing();
  await db.insert(videos).values({
    id: videoId,
    channelId,
    title: `Title ${videoId}`,
    description: "",
    publishedAt: "2026-08-01T12:00:00Z",
    privacyStatus: "public",
    thumbnailsJson: "{}",
    localizationsJson: "{}",
  });
}

const QUERY = { dimensions: "insightTrafficSourceDetail", metricNames: ["views", "estimatedMinutesWatched"], maxResults: 25, sort: "-views" };

test("AC-SS-01: a due video and a due week are read for RELATED_VIDEO with BL-169's query shape", async () => {
  const { db } = await freshDb();
  const { services, queries } = setup(db, { truth: new Map([["v1", [["src1", 4, 6]]]]) });
  const result = await services.collectDueSuggestedSources(RUN);
  assert.deepEqual([result.attempted, result.collected, result.failed], [14, 14, 0]);
  assert.deepEqual(queries[0], { channelId: "UC_ours", startDate: "2026-09-28", endDate: "2026-10-04", ...QUERY, filters: "insightTrafficSourceType==RELATED_VIDEO" });
  assert.deepEqual(queries.at(-1), { channelId: "UC_ours", startDate: "2026-09-01", endDate: "2026-10-09", ...QUERY, filters: "video==v1;insightTrafficSourceType==RELATED_VIDEO" });
  assert.deepEqual(await listVideoSuggestedSources("UC_ours", ["v1"], db), [{ videoId: "v1", detail: "src1", views: 4, estimatedMinutesWatched: 6 }]);
  const state = (await listAnalyticsBreakdownStates("UC_ours", db)).find((s) => s.subject === "suggested:v1");
  assert.deepEqual([state?.rangeStart, state?.collectedThrough, state?.status], ["2026-09-01", "2026-10-09", "collected"]);
});

test("AC-SS-02 (AC-ST-10, failures): a 400 counts an attempt; a video's 'no answer' ends the run and no titles are looked up", async () => {
  const { db } = await freshDb();
  // Weeks only: every week answers 400.
  const failing = createSuggestedSourceServicesWithFailure(db, googleError(400, "badRequest"));
  const result = await failing.services.collectDueSuggestedSources(RUN);
  assert.deepEqual([result.attempted, result.collected, result.failed], [13, 0, 13]);
  const states = await listAnalyticsBreakdownStates("UC_ours", db);
  assert.ok(states.every((s) => s.subject.startsWith("suggested-week:") && s.status === "retry" && s.attempts === 1));
  // A stored external id is waiting for a title, but the run is stopped by the video's 503 before any lookup.
  await saveCollectedChannelSuggestedSourcesWeek(
    { channelId: "UC_ours", subject: "suggested-week:2026-09-28", weekStart: "2026-09-28", to: "2026-10-04", rows: [{ detail: "ext1", views: 1, estimatedMinutesWatched: 1 }], collectedOn: "2026-10-10", at: NOW },
    db
  );
  const unavailable = createSuggestedSourceServicesWithFailure(db, googleError(503, "backendError"), [V1], NOW);
  await assert.rejects(() => unavailable.services.collectDueSuggestedSources(RUN));
  assert.deepEqual(unavailable.titleCalls, []);
});

function createSuggestedSourceServicesWithFailure(db: AppDb, error: Error, videos: MilestoneVideo[] = [], now: Date = NOW) {
  const titleCalls: string[][] = [];
  const services = createSuggestedSourceServices({
    clock: { now: () => now },
    authResolver: { resolve: async () => ({ accessToken: "a", refreshToken: "r" }) as never },
    channelAccess: { assertActiveChannel: async ({ channelId }) => channelId },
    videoStore: { listVideos: async () => videos },
    youtubeApi: {
      queryChannelBreakdownReport: async () => {
        throw error;
      },
    },
    store: {
      listStates: (channelId) => listAnalyticsBreakdownStates(channelId, db),
      saveVideoRows: (row) => saveCollectedVideoSuggestedSources(row, db),
      defer: (row) => deferAnalyticsBreakdown(row, db),
      recordFailure: (row) => recordAnalyticsBreakdownFailure(row, db),
      listVideoRows: (channelId, videoIds) => listVideoSuggestedSources(channelId, videoIds, db),
      saveWeekRows: (row) => saveCollectedChannelSuggestedSourcesWeek(row, db),
      listWeekRows: (channelId, first, last) => listChannelSuggestedSourcesWeekly(channelId, first, last, db),
    },
    ownVideos: { findByIds: (ids) => listOwnVideosByIds(ids, db) },
    titles: {
      listStoredSourceIds: (channelId) => listStoredSuggestedSourceIds(channelId, db),
      listFresh: (ids, since) => listSuggestedVideoTitles(ids, since, db),
      save: (rows, when) => saveSuggestedVideoTitles(rows, when, db),
    },
    dataReserve: { isBackgroundReadAllowed: async () => true },
    dataApi: {
      getPublicVideoTitles: async ({ videoIds }) => {
        titleCalls.push(videoIds);
        return [];
      },
    },
  });
  return { services, titleCalls };
}

test("AC-SS-04: a synced video of another connected channel is ours with its title and channel; an unknown id is external", async () => {
  const { db } = await freshDb();
  await seedOwnVideo(db, "japan1", "UC_japan");
  const { services } = setup(db, { truth: new Map([["v1", [["japan1", 9, 12], ["stranger", 3, 2]]]]), dataAllowed: false });
  await services.collectDueSuggestedSources(RUN);
  const result = await services.listStoredSuggestedSources({ channelId: "UC_ours", videoIds: ["v1"] });
  assert.ok("videos" in result);
  assert.deepEqual(result.videos[0].sources, [
    { videoId: "japan1", views: 9, estimatedMinutesWatched: 12, source: "ours", title: "Title japan1", channelId: "UC_japan", channelTitle: "Channel UC_japan" },
    { videoId: "stranger", views: 3, estimatedMinutesWatched: 2, source: "external", title: null, channelId: null, channelTitle: null },
  ]);
});

test("AC-SS-05: after a run, only the 60 external ids without a title are looked up, 50 + 10, and the titles are returned", async () => {
  const { db } = await freshDb();
  await seedOwnVideo(db, "own1", "UC_ours_other");
  await saveSuggestedVideoTitles([{ videoId: "known", title: "Known", channelId: "UC_k", channelTitle: "K" }], at("2026-10-01T00:00:00Z"), db);
  const externals: Rows = Array.from({ length: 60 }, (_, i) => [`x${String(i).padStart(2, "0")}`, 1, 1]);
  const truth = new Map<string, Rows>([
    ["v1", [["own1", 5, 5], ["known", 4, 4], ...externals.slice(0, 20)]],
    ["channel|2026-09-28", externals.slice(20)],
  ]);
  const gatewayCalls: string[][] = [];
  const { services, titleCalls, reserveChecks } = setup(db, {
    truth,
    // Mimic the gateway: 50 ids per videos.list call (getPublicVideoTitles itself is tested in data-api.test.ts).
    titles: (ids) => {
      for (let i = 0; i < ids.length; i += 50) gatewayCalls.push(ids.slice(i, i + 50));
      return ids.filter((id) => id !== "x07").map((id) => ({ videoId: id, title: `T ${id}`, channelId: `UC_${id}`, channelTitle: `C ${id}` }));
    },
  });
  const result = await services.collectDueSuggestedSources(RUN);
  assert.equal(result.titlesLookedUp, 60);
  assert.deepEqual(reserveChecks, ["data"]);
  const expected = externals.map(([id]) => id).sort();
  assert.deepEqual(titleCalls, [expected], "one lookup of exactly the external ids without a title");
  assert.deepEqual(gatewayCalls.map((ids) => ids.length), [50, 10]);
  const stored = await services.listStoredSuggestedSources({ channelId: "UC_ours", videoIds: ["v1"] });
  assert.ok("videos" in stored);
  const byId = new Map(stored.videos[0].sources.map((row) => [row.videoId, row]));
  assert.deepEqual([byId.get("own1")?.source, byId.get("own1")?.title], ["ours", "Title own1"]);
  assert.deepEqual([byId.get("known")?.source, byId.get("known")?.title], ["external", "Known"]);
  assert.deepEqual([byId.get("x00")?.title, byId.get("x00")?.channelTitle], ["T x00", "C x00"]);
  // An id videos.list did not return is recorded without a title, so the next run does not ask again.
  assert.deepEqual([byId.get("x07")?.source, byId.get("x07")?.title], ["external", null]);
  const again = await services.collectDueSuggestedSources(RUN);
  assert.equal(again.titlesLookedUp, 0);
  assert.equal(titleCalls.length, 1);
});

test("AC-SS-05: a failed lookup keeps the run's result and stores no titles; the next run asks again", async () => {
  const { db } = await freshDb();
  const truth = new Map<string, Rows>([["v1", [["ext1", 2, 2]]]]);
  const failing = setup(db, { truth, titleFailure: googleError(403, "quotaExceeded") });
  const result = await failing.services.collectDueSuggestedSources(RUN);
  assert.deepEqual(result, { attempted: 14, collected: 14, failed: 0, titlesLookedUp: 0 });
  assert.deepEqual(await listSuggestedVideoTitles(["ext1"], at("2000-01-01T00:00:00Z"), db), []);
  const next = setup(db, { truth });
  assert.equal((await next.services.collectDueSuggestedSources(RUN)).titlesLookedUp, 1);
});

test(`AC-SS-05: at most ${MAX_TITLE_LOOKUPS_PER_RUN} ids are looked up in one run`, async () => {
  const { db } = await freshDb();
  const rows = Array.from({ length: 520 }, (_, i) => ({ detail: `x${String(i).padStart(3, "0")}`, views: 1, estimatedMinutesWatched: 1 }));
  await saveCollectedVideoSuggestedSources({ channelId: "UC_ours", subject: "suggested:v1", videoId: "v1", rangeStart: "2026-09-01", to: "2026-10-09", rows, collectedOn: "2026-10-10", at: NOW }, db);
  const { services, titleCalls } = setup(db, { videos: [] });
  assert.equal((await services.collectDueSuggestedSources(RUN)).titlesLookedUp, 500);
  assert.equal(titleCalls[0].length, 500);
});

test("AC-SS-06: a title fetched 31 days ago is not returned and the purge deletes it; one fetched 29 days ago is returned and kept", async () => {
  const { db, client } = await freshDb();
  const day = 86_400_000;
  await saveSuggestedVideoTitles([{ videoId: "old", title: "Old", channelId: "UC_o", channelTitle: "O" }], new Date(NOW.getTime() - 31 * day), db);
  await saveSuggestedVideoTitles([{ videoId: "recent", title: "Recent", channelId: "UC_r", channelTitle: "R" }], new Date(NOW.getTime() - 29 * day), db);
  await saveCollectedVideoSuggestedSources(
    {
      channelId: "UC_ours",
      subject: "suggested:v1",
      videoId: "v1",
      rangeStart: "2026-09-01",
      to: "2026-10-09",
      rows: [
        { detail: "old", views: 2, estimatedMinutesWatched: 1 },
        { detail: "recent", views: 1, estimatedMinutesWatched: 1 },
      ],
      collectedOn: "2026-10-10",
      at: NOW,
    },
    db
  );
  const { services } = setup(db, { videos: [V1] });
  const stored = await services.listStoredSuggestedSources({ channelId: "UC_ours", videoIds: ["v1"] });
  assert.ok("videos" in stored);
  assert.deepEqual(
    stored.videos[0].sources.map((row) => [row.videoId, row.source, row.title, row.channelId, row.channelTitle]),
    [
      ["old", "external", null, null, null],
      ["recent", "external", "Recent", "UC_r", "R"],
    ]
  );
  const purged = await purgeExpiredApiData(client, NOW);
  assert.deepEqual(purged.find((r) => r.table === "suggested_video_titles"), { table: "suggested_video_titles", deleted: 1, blanked: 0 });
  assert.deepEqual((await listSuggestedVideoTitles(["old", "recent"], at("2000-01-01T00:00:00Z"), db)).map((r) => r.videoId), ["recent"]);
  // The suggesting ids themselves are our own Analytics data and stay.
  assert.equal((await listVideoSuggestedSources("UC_ours", ["v1"], db)).length, 2);
});

test("AC-SS-07: without the Data API background reserve no videos.list call is made; the Analytics part still runs", async () => {
  const { db } = await freshDb();
  const { services, titleCalls, queries } = setup(db, { truth: new Map([["v1", [["ext1", 2, 2]]]]), dataAllowed: false });
  const result = await services.collectDueSuggestedSources(RUN);
  assert.deepEqual(result, { attempted: 14, collected: 14, failed: 0, titlesLookedUp: 0 });
  assert.equal(queries.length, 14);
  assert.deepEqual(titleCalls, []);
});

test("background gate: without the Analytics reserve a run makes zero queries and looks nothing up", async () => {
  let called = 0;
  const gated = gateSuggestedSourceCollection({ isBackgroundReadAllowed: async () => false }, async () => {
    called += 1;
    return { attempted: 1, collected: 1, failed: 0, titlesLookedUp: 1 };
  });
  assert.deepEqual(await gated(RUN), { attempted: 0, collected: 0, failed: 0, titlesLookedUp: 0 });
  assert.equal(called, 0);
});

test("AC-SS-08 (channel form): groupBy total sums each suggesting video over the read weeks, most views first", async () => {
  const { db } = await freshDb();
  const truth = new Map<string, Rows>([
    ["channel|2026-09-28", [["a", 3, 1], ["b", 1, 1]]],
    ["channel|2026-09-21", [["a", 2, 2]]],
  ]);
  const { services } = setup(db, { videos: [], truth, dataAllowed: false });
  await services.collectDueSuggestedSources(RUN);
  const total = await services.listStoredSuggestedSources({ channelId: "UC_ours", startDate: "2026-09-21", endDate: "2026-10-04" });
  assert.ok("weeks" in total);
  assert.deepEqual(total.weeks.map((w) => [w.weekStart, w.status]), [["2026-09-21", "collected"], ["2026-09-28", "collected"]]);
  assert.deepEqual(total.sources, [
    { videoId: "a", views: 5, estimatedMinutesWatched: 3, source: "external", title: null, channelId: null, channelTitle: null },
    { videoId: "b", views: 1, estimatedMinutesWatched: 1, source: "external", title: null, channelId: null, channelTitle: null },
  ]);
  await assert.rejects(
    () => services.listStoredSuggestedSources({ channelId: "UC_ours", videoIds: ["v1"], groupBy: "week" }),
    (error: unknown) => error instanceof DomainError && error.code === "validation_failed"
  );
  await assert.rejects(() => services.listStoredSuggestedSources({ channelId: "UC_other", videoIds: ["v1"] }), (error: unknown) => error instanceof DomainError && error.code === "CHANNEL_NOT_ACTIVE");
});

test("policy: the suggesting ids are own-channel Analytics data, the external titles Non-Authorized with a 30-day clock; all stay on this device", () => {
  for (const table of ["video_suggested_sources", "channel_suggested_sources_weekly"]) {
    assert.equal(YOUTUBE_DATA_CLASSIFICATION[table]?.kind, "authorized", table);
    assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES[table], table);
  }
  const titles = YOUTUBE_DATA_CLASSIFICATION.suggested_video_titles;
  assert.equal(titles?.kind, "non_authorized");
  assert.equal(titles?.kind === "non_authorized" ? titles.clockColumn : null, "fetched_at");
  assert.ok(SNAPSHOT_DEVICE_LOCAL_TABLES.suggested_video_titles);
});
